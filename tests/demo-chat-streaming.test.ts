import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import type http from "node:http";
import { closeDb } from "../src/db";
import { createServer } from "../src/server";

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const envNames = ["RUNPHANTOM_DB_PATH", "RUNPHANTOM_SECRET_STORE_PATH", "OPENAI_API_KEY", "RUNPHANTOM_OPENAI_API_KEY"];
const originalEnv = new Map<string, string | undefined>();
const encoder = new TextEncoder();
let directory: string, base: string, server: http.Server;
let upstream: (init: RequestInit) => Response | Promise<Response>;
let requestBody: Record<string, unknown>;
let upstreamSignal: AbortSignal | null | undefined;

beforeAll(async () => {
  for (const key of envNames) { originalEnv.set(key, process.env[key]); delete process.env[key]; }
  directory = mkdtempSync(path.join(realpathSync(tmpdir()), "runphantom-demo-stream-"));
  closeDb();
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, "traces.db");
  process.env.RUNPHANTOM_SECRET_STORE_PATH = path.join(directory, "secrets.json");
  process.env.OPENAI_API_KEY = "synthetic-demo-stream-key";
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) !== "https://api.openai.com/v1/responses") throw new Error("Unexpected outbound request in demo fixture");
    requestBody = JSON.parse(String(init?.body));
    upstreamSignal = init?.signal;
    return upstream(init ?? {});
  }, { preconnect: realFetch.preconnect }) as typeof fetch;
  ({ server } = await createServer(0));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => { globalThis.setTimeout = realSetTimeout; });
afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  globalThis.fetch = realFetch;
  closeDb();
  for (const [key, value] of originalEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(directory, { recursive: true, force: true });
});

function frame(payload: unknown, newline = "\n"): string {
  return `data: ${JSON.stringify(payload)}${newline}${newline}`;
}
function delta(text: string): string { return frame({ type: "response.output_text.delta", delta: text }); }
function completed(): string { return frame({ type: "response.completed", response: { status: "completed" } }); }
function stream(chunks: Array<string | Uint8Array>): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}
function request(signal?: AbortSignal): Promise<Response> {
  return realFetch(`${base}/api/demo-chat`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "What is a trace?" }] }), signal });
}
async function events(): Promise<Array<{ type: string; delta?: string; error?: string }>> {
  const response = await request();
  const body = await response.text();
  if (!response.ok) return [{ type: "error", error: (JSON.parse(body) as { error: string }).error }];
  // The legacy text transport treated every clean EOF as a completed reply.
  if (response.headers.get("content-type")?.startsWith("text/plain")) return [{ type: "delta", delta: body }, { type: "complete" }];
  expect(response.headers.get("content-type")).toContain("application/x-ndjson");
  return body.trim().split("\n").map((line) => JSON.parse(line));
}

describe.serial("demo chat streaming contract", () => {
  test("streams only visible deltas and confirms provider completion without duplicated final text", async () => {
    upstream = () => stream([
      delta("Hello "),
      frame({ type: "response.reasoning_text.delta", delta: "private reasoning" }),
      delta("world"),
      frame({ type: "response.output_text.done", text: "Hello world" }),
      completed(),
    ]);
    expect(await events()).toEqual([{ type: "delta", delta: "Hello " }, { type: "delta", delta: "world" }, { type: "complete" }]);
    expect(requestBody.max_output_tokens).toBeGreaterThan(0);
    expect(requestBody.max_output_tokens).toBeLessThanOrEqual(4096);
    expect(upstreamSignal).toBeInstanceOf(AbortSignal);
  });

  test.each(["response.failed", "response.incomplete", "error", "response.cancelled"])("%s preserves partial text and ends in an error", async (type) => {
    upstream = () => stream([delta("Partial reply"), frame({ type, response: { status: type.split(".")[1] } })]);
    const result = await events();
    expect(result[0]).toEqual({ type: "delta", delta: "Partial reply" });
    expect(result.at(-1)?.type).toBe("error");
    expect(result.some((event) => event.type === "complete")).toBe(false);
  });

  test.each(["", "data: [DONE]\n\n", frame({ type: "response.output_text.done", text: "Partial reply" })])("EOF without authoritative completion is an error (%s)", async (ending) => {
    upstream = () => stream([delta("Partial reply"), ending]);
    const result = await events();
    expect(result[0]).toEqual({ type: "delta", delta: "Partial reply" });
    expect(result.at(-1)?.type).toBe("error");
    expect(result.some((event) => event.type === "complete")).toBe(false);
  });

  test.each([
    "data: {broken JSON}\n\n",
    frame({ type: "response.completed", response: { status: "incomplete" } }),
    frame({ type: "response.output_text.delta", delta: { text: "invalid" } }),
    `data: ${"x".repeat(128 * 1024 + 1)}`,
  ])("malformed or oversized frames cannot complete a reply", async (ending) => {
    upstream = () => stream([delta("Partial reply"), ending, completed()]);
    const result = await events();
    expect(result.at(-1)?.type).toBe("error");
    expect(result.some((event) => event.type === "complete")).toBe(false);
  });

  test("invalid initial UTF-8 or JSON returns a JSON HTTP error before any delta", async () => {
    for (const initial of [new Uint8Array([0xff]), "data: {broken JSON}\n\n"]) {
      upstream = () => stream([initial, completed()]);
      const response = await request();
      expect(response.status).toBe(502);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await response.json()).toEqual({ error: expect.any(String) });
    }
  });

  test("handles split UTF-8, split CRLF boundaries, and multiline SSE data", async () => {
    const text = frame({ type: "response.output_text.delta", delta: "Trace 界" }, "\r\n")
      + 'data: {"type":"response.completed",\r\ndata: "response":{"status":"completed"}}\r\n\r\n';
    const bytes = encoder.encode(text);
    upstream = () => stream(Array.from(bytes, (byte) => new Uint8Array([byte])));
    expect(await events()).toEqual([{ type: "delta", delta: "Trace 界" }, { type: "complete" }]);
  });

  test("rejects output and total stream limits", async () => {
    for (const chunks of [
      Array.from({ length: 70 }, () => delta("x".repeat(1024))),
      Array.from({ length: 1100 }, () => `: ${"x".repeat(1024)}\n\n`),
    ]) {
      upstream = () => stream([...chunks, completed()]);
      const result = await events();
      expect(result.at(-1)?.type).toBe("error");
      expect(result.some((event) => event.type === "complete")).toBe(false);
    }
  });

  test("cancels an upstream reader and fetch when the browser disconnects", async () => {
    let cancelled = false;
    upstream = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(delta("Partial reply"))); },
      cancel() { cancelled = true; },
    }));
    const controller = new AbortController();
    const response = await request(controller.signal);
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    for (let attempt = 0; attempt < 100 && !cancelled; attempt++) await new Promise((resolve) => realSetTimeout(resolve, 5));
    expect(upstreamSignal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
    await reader.cancel().catch(() => undefined);
  });

  test("deadline cancels a stalled upstream and reports failure", async () => {
    let cancelled = false;
    spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
      realSetTimeout(callback, delay === 60_000 ? 25 : delay, ...args)) as typeof setTimeout);
    upstream = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(delta("Partial reply"))); },
      cancel() { cancelled = true; },
    }));
    const result = await events();
    expect(result.at(-1)).toMatchObject({ type: "error", error: expect.stringMatching(/timed out/i) });
    expect(upstreamSignal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  test("reader failure after the first delta emits one error without writing after end", async () => {
    let pulls = 0;
    upstream = () => new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (pulls++ === 0) controller.enqueue(encoder.encode(delta("Partial reply")));
        else { await new Promise((resolve) => realSetTimeout(resolve, 10)); controller.error(new Error("Synthetic upstream disconnect")); }
      },
    }));
    expect(await events()).toEqual([{ type: "delta", delta: "Partial reply" }, { type: "error", error: expect.any(String) }]);
  });
});
