import { randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { test as base, expect } from "./fixtures";

export const SOURCE_RUN_ID = "b1000000000000000000000000000001";
export const SOURCE_TOOL_ID = "b100000000000002";
export const SOURCE_MESSAGE = "Check order local-42";
export const SOURCE_OUTPUT = "Checkout failed: fixture payment declined";
export const REPLAY_OUTPUT = "Checkout verified using the local fixture";
export const EVENT_NAME = "browser-local-checkout";
const SYSTEM_PROMPT = "Use the local checkout fixture only.";

export type ReplayRequest = {
  sourceRunId: string;
  replayRunId: string;
  messages: Array<{ role: string; content: string }>;
  systemPrompt: string;
  model?: string;
  userMessage?: string;
  context: Record<string, unknown>;
};

export function replayTelemetry(traceId: string, message = SOURCE_MESSAGE, replayRunId?: string) {
  const at = Date.now() - 5000;
  const stamp = (offset: number) => String(BigInt(at + offset) * 1_000_000n);
  const attributes = (values: Record<string, string>) => Object.entries(values).map(([key, value]) => ({ key, value: { stringValue: value } }));
  const common = {
    "runphantom.event.name": replayRunId ? `replay:${EVENT_NAME}` : EVENT_NAME,
    ...(replayRunId ? { "runphantom.replay.run_id": replayRunId } : {}),
  };
  return { resourceSpans: [{ resource: { attributes: attributes({ "service.name": "local-replay-browser-fixture" }) }, scopeSpans: [{
    scope: { name: "local-replay-browser-fixture" }, spans: [
      { traceId, spanId: "b100000000000001", name: "Checkout source", startTimeUnixNano: stamp(0), endTimeUnixNano: stamp(100),
        status: { code: 1 }, attributes: attributes({ ...common, "runphantom.span.kind": "agent" }) },
      { traceId, spanId: SOURCE_TOOL_ID, parentSpanId: "b100000000000001", name: "fixture_payment", startTimeUnixNano: stamp(10), endTimeUnixNano: stamp(20),
        status: { code: replayRunId ? 1 : 2, ...(replayRunId ? {} : { message: "fixture payment declined" }) },
        attributes: attributes({ ...common, "ai.operationId": "ai.toolCall", "ai.toolCall.name": "fixture_payment",
          "ai.toolCall.args": '{"orderId":"local-42","dryRun":true}',
          "ai.toolCall.result": replayRunId ? '{"ok":true,"dryRun":true}' : '{"error":"fixture payment declined"}' }) },
      { traceId, spanId: "b100000000000003", parentSpanId: "b100000000000001", name: "model answer", startTimeUnixNano: stamp(30), endTimeUnixNano: stamp(90),
        status: { code: 1 }, attributes: attributes({ ...common, "ai.operationId": "ai.generateText.doGenerate", "ai.model.id": "local-fixture-model",
          "ai.model.provider": "local-fixture", "ai.prompt.messages": JSON.stringify([{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: message }]),
          "ai.response.text": replayRunId ? REPLAY_OUTPUT : SOURCE_OUTPUT }) },
    ],
  }] }] };
}

type LocalReplayAgent = {
  requests: ReplayRequest[];
  traceIds: string[];
  errors: string[];
  disconnectedRequests: string[];
  mode: "success" | "failure" | "hold";
  completeHeld: (replayRunId: string) => Promise<string>;
};

// An actual loopback replay endpoint emits OTLP evidence back to the isolated
// daemon. It never executes tools or calls a model provider.
export const test = base.extend<{ localReplayAgent: LocalReplayAgent }>({
  localReplayAgent: async ({ runPhantom, request }, use) => {
    const held = new Map<string, { body: ReplayRequest; response: ServerResponse }>();
    const complete = async (body: ReplayRequest, response: ServerResponse) => {
      const traceId = randomBytes(16).toString("hex");
      const ingested = await fetch(`${runPhantom.url}/v1/traces`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(replayTelemetry(traceId, body.messages.at(-1)?.content, body.replayRunId)) });
      if (!ingested.ok) throw new Error(`Replay OTLP ingest returned ${ingested.status}: ${await ingested.text()}`);
      agent.traceIds.push(traceId);
      if (!response.headersSent) response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok", replayId: body.replayRunId }));
      return traceId;
    };
    const agent: LocalReplayAgent = { requests: [], traceIds: [], errors: [], disconnectedRequests: [], mode: "success",
      completeHeld: async id => { const entry = held.get(id); if (!entry) throw new Error("Held replay does not exist"); held.delete(id); return complete(entry.body, entry.response); } };
    const server = createServer((incoming, response) => {
      if (incoming.method === "GET" && incoming.url === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, eventName: EVENT_NAME, cwd: path.dirname(runPhantom.dbPath), command: "bun --version", models: ["local-fixture-model"] }));
        return;
      }
      if (incoming.method !== "POST" || incoming.url !== "/replay") { response.writeHead(404); response.end(); return; }
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ReplayRequest;
        agent.requests.push(body);
        if (agent.mode === "hold") {
          held.set(body.replayRunId, { body, response });
          response.once("close", () => { held.delete(body.replayRunId); agent.disconnectedRequests.push(body.replayRunId); });
          response.writeHead(200, { "Content-Type": "application/json" });
          response.flushHeaders();
          return;
        }
        if (agent.mode === "failure") {
          response.writeHead(503, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "Fixture blocked unsafe checkout" }));
          return;
        }
        await complete(body, response);
      })().catch(error => {
        agent.errors.push(String(error));
        if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Local replay fixture failed" }));
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local replay fixture has no TCP address");
    try {
      const registered = await request.put(`${runPhantom.url}/api/agents`, { data: { [EVENT_NAME]: { url: `http://127.0.0.1:${address.port}/replay` } } });
      expect(registered.ok()).toBe(true);
      expect((await request.post(`${runPhantom.url}/v1/traces`, { data: replayTelemetry(SOURCE_RUN_ID) })).ok()).toBe(true);
      await use(agent);
      expect(agent.errors).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  },
});

export { expect };
