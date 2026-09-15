import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createSocket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { TRACE_FORMAT, TRACE_LIMITS } from "../src/trace-export";

const directory = mkdtempSync(path.join(tmpdir(), "rp-portable-"));
const processes: ChildProcess[] = [];
let source: string, destination: string;

async function startStore(name: string): Promise<string> {
  const socket = createSocket();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("RUNPHANTOM_") && key !== "OPENAI_API_KEY" && key !== "ANTHROPIC_API_KEY"));
  const profile = mkdtempSync(path.join(directory, `${name}-profile-`));
  const proc = spawn(process.execPath, ["src/index.ts", "serve"], {
    cwd: path.resolve(import.meta.dir, ".."), stdio: "ignore",
    env: { ...env, HOME: profile, USERPROFILE: profile, RUNPHANTOM_DB_PATH: path.join(directory, `${name}.db`), RUNPHANTOM_PORT: String(port),
      RUNPHANTOM_BIND_HOST: "127.0.0.1", RUNPHANTOM_SECRET_STORE_PATH: path.join(directory, `${name}-secrets.json`), RUNPHANTOM_CLAUDE_CLI_CHAT: "0" },
  });
  processes.push(proc);
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 400; attempt++) {
    if (proc.exitCode !== null) throw new Error(`Fixture daemon exited: ${proc.exitCode}`);
    try { if ((await fetch(`${url}/health`)).ok) return url; } catch { /* process starting */ }
    await Bun.sleep(25);
  }
  throw new Error("Fixture daemon failed to start");
}

beforeAll(async () => { [source, destination] = await Promise.all([startStore("source"), startStore("destination")]); }, 30_000);
beforeEach(async () => { await Promise.all([source, destination].map(url => fetch(`${url}/api/clear`, { method: "POST" }))); });
afterAll(async () => {
  await Promise.all(processes.map(proc => new Promise<void>(resolve => {
    if (proc.exitCode !== null) { resolve(); return; }
    const timer = setTimeout(() => proc.kill("SIGKILL"), 2000);
    proc.once("exit", () => { clearTimeout(timer); resolve(); });
    proc.kill("SIGTERM");
  })));
  rmSync(directory, { recursive: true, force: true });
});

function fixture(runId = "portable-run") {
  return {
    format: TRACE_FORMAT,
    run: { id: runId, event_id: "event-42", name: "captured-agent", event_name: "checkout", display_name: "Checkout failure",
      user_id: "synthetic-user", convo_id: "conversation-42", metadata: '{"replay":{"sourceRunId":"original"}}', started_at: 100, last_updated_at: 200 },
    spans: [{ id: "tool-1", run_id: runId, name: "checkout", parent_span_id: null, span_type: "TOOL_CALL", status: "ERROR",
      input_payload: '{"cart":42}', output_payload: '{"error":"payment rejected"}', model: null, provider: null,
      attributes: '{"error.type":"payment"}', start_time_ms: 100, end_time_ms: 200, duration_ms: 100, input_tokens: null, output_tokens: null }],
    liveEvents: [{ span_id: "tool-1", type: "tool-result", content: "payment rejected", timestamp: 200, metadata: '{"complete":true}' }],
    annotations: [{ id: "portable-annotation", run_id: runId, span_id: "tool-1", kind: "issue", source: "user", note: "Inspect payment input", created_at: 201 }],
  };
}
async function importTo(url: string, data: unknown) {
  return fetch(`${url}/api/import-run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
}
async function exported(url = destination, runId = "portable-run") {
  const response = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}/export`);
  expect(response.status).toBe(200);
  return response.json() as Promise<any>;
}

describe("portable trace import and export", () => {
  test("two independent stores preserve raw evidence, metadata and annotation identity across repeated imports", async () => {
    const data = fixture();
    data.spans[0].input_payload = JSON.stringify({ input: "Unicode 🧪".repeat(2500) });
    expect((await importTo(source, data)).status).toBe(200);
    const download = await fetch(`${source}/api/runs/portable-run/export`);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    const evidence = await download.json();
    expect(evidence).toEqual(data);
    expect((await fetch(`${destination}/api/runs/portable-run/export`)).status).toBe(404);
    expect((await importTo(destination, evidence)).status).toBe(200);
    const eventIdsBefore = await (await fetch(`${destination}/api/runs/portable-run/events`)).json();
    expect((await importTo(destination, evidence)).status).toBe(200);
    expect(await (await fetch(`${destination}/api/runs/portable-run/events`)).json()).toEqual(eventIdsBefore);
    expect(await exported()).toEqual(evidence);
    expect(await exported(source)).toEqual(evidence);
    expect((await exported()).liveEvents).toHaveLength(1);
  });

  test("legacy missing display and event identifiers preserve local values; explicit null restores null", async () => {
    expect((await importTo(destination, fixture())).status).toBe(200);
    const legacy: any = fixture();
    delete legacy.format; delete legacy.annotations; delete legacy.run.display_name; delete legacy.run.event_id;
    legacy.run.started_at = 150; legacy.run.last_updated_at = 175;
    expect((await importTo(destination, legacy)).status).toBe(200);
    expect((await exported()).run).toMatchObject({ display_name: "Checkout failure", event_id: "event-42", started_at: 150, last_updated_at: 175 });
    legacy.run.display_name = null; legacy.run.event_id = null;
    expect((await importTo(destination, legacy)).status).toBe(200);
    expect((await exported()).run).toMatchObject({ display_name: null, event_id: null });
    expect((await exported()).annotations).toHaveLength(1);
  });

  test("local annotations survive, and canonical identical annotation content is a no-op", async () => {
    expect((await importTo(destination, fixture())).status).toBe(200);
    const local = await fetch(`${destination}/api/annotations`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: "portable-run", kind: "note", note: "Local review", source: "user" }) });
    expect(local.status).toBe(201);
    const incoming = fixture(); incoming.annotations[0].note = "  Inspect payment input  ";
    expect((await importTo(destination, incoming)).status).toBe(200);
    const result = await exported();
    expect(result.annotations).toHaveLength(2);
    expect(result.annotations.some((annotation: any) => annotation.note === "Local review")).toBe(true);
  });

  test("different content with a reused annotation ID rolls back all incoming annotations and trace changes", async () => {
    await importTo(destination, fixture());
    const before = await exported();
    const incoming = fixture(); incoming.run.name = "must not replace";
    incoming.annotations.unshift({ ...incoming.annotations[0], id: "new-before-conflict" });
    incoming.annotations[1].note = "conflicting edited note";
    expect((await importTo(destination, incoming)).status).toBe(400);
    expect(await exported()).toEqual(before);
  });

  test("cross-run annotation ID collision leaves both existing runs untouched", async () => {
    await importTo(destination, fixture());
    const other = fixture("other-run"); other.annotations[0].id = "other-annotation";
    await importTo(destination, other);
    const before = await exported(); const otherBefore = await exported(destination, "other-run");
    const incoming = fixture(); incoming.annotations[0].id = "other-annotation";
    expect((await importTo(destination, incoming)).status).toBe(400);
    expect(await exported()).toEqual(before);
    expect(await exported(destination, "other-run")).toEqual(otherBefore);
  });

  test("replacement rejects retained span annotations whose target disappears", async () => {
    await importTo(destination, fixture()); const before = await exported();
    const incoming = fixture(); incoming.spans = []; incoming.annotations = []; incoming.liveEvents = [];
    const response = await importTo(destination, incoming);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("orphan");
    expect(await exported()).toEqual(before);
  });

  test.each([
    ["unsupported version", (x: any) => { x.format = "runphantom-trace/v2"; }],
    ["malformed annotations", (x: any) => { x.annotations = {}; }],
    ["missing v1 annotations", (x: any) => { delete x.annotations; }],
    ["duplicate annotation IDs", (x: any) => { x.annotations.push({ ...x.annotations[0] }); }],
    ["duplicate span IDs", (x: any) => { x.spans.push({ ...x.spans[0] }); }],
    ["cross-run span", (x: any) => { x.spans[0].run_id = "elsewhere"; }],
    ["foreign annotation", (x: any) => { x.annotations[0].run_id = "elsewhere"; }],
    ["unknown annotation span", (x: any) => { x.annotations[0].span_id = "missing"; }],
    ["invalid annotation kind", (x: any) => { x.annotations[0].kind = "unknown"; }],
    ["invalid annotation source", (x: any) => { x.annotations[0].source = "other"; }],
    ["invalid annotation time", (x: any) => { x.annotations[0].created_at = -1; }],
    ["oversized note", (x: any) => { x.annotations[0].note = "a".repeat(10_001); }],
    ["invalid live events", (x: any) => { x.liveEvents = {}; }],
    ["duplicate legacy event IDs", (x: any) => { x.liveEvents[0].id = 1; x.liveEvents.push({ ...x.liveEvents[0] }); }],
    ["invalid time", (x: any) => { x.spans[0].start_time_ms = "yesterday"; }],
    ["too many spans", (x: any) => { x.spans = Array.from({ length: TRACE_LIMITS.spans + 1 }, (_, i) => ({ ...x.spans[0], id: `s-${i}` })); }],
    ["too many live events", (x: any) => { x.liveEvents = Array.from({ length: TRACE_LIMITS.liveEvents + 1 }, () => ({ ...x.liveEvents[0] })); }],
    ["too many annotations", (x: any) => { x.annotations = Array.from({ length: TRACE_LIMITS.annotations + 1 }, (_, i) => ({ ...x.annotations[0], id: `a-${i}` })); }],
  ] as const)("rejects %s without any partial write", async (_label, mutate) => {
    await importTo(destination, fixture()); const before = await exported();
    const incoming = fixture(); mutate(incoming);
    expect((await importTo(destination, incoming)).status).toBe(400);
    expect(await exported()).toEqual(before);
  });

  test("UTF-8 portable byte cap rejects payloads below the character cap", async () => {
    const incoming = fixture(); incoming.spans[0].input_payload = "🧪".repeat(TRACE_LIMITS.bytes / 4);
    expect((await importTo(destination, incoming)).status).toBe(400);
    expect((await fetch(`${destination}/api/runs/portable-run/export`)).status).toBe(404);
  });

  test("export rejects a captured trace over the portable limit without truncating or deleting evidence", async () => {
    const traceId = "ab000000000000000000000000000001";
    const ingest = await fetch(`${source}/v1/traces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      resourceSpans: [{ scopeSpans: [{ spans: [{ traceId, spanId: "ab00000000000001", name: "large captured evidence",
        startTimeUnixNano: "1000000", endTimeUnixNano: "2000000", attributes: [
          { key: "ai.toolCall.name", value: { stringValue: "large_tool" } },
          { key: "ai.toolCall.args", value: { stringValue: "x".repeat(TRACE_LIMITS.bytes) } },
        ] }] }] }],
    }) });
    expect(ingest.status).toBe(200);
    const download = await fetch(`${source}/api/runs/${traceId}/export`);
    expect(download.status).toBe(413);
    expect(await download.text()).toContain("portable");
    const outline = await fetch(`${source}/api/runs/${traceId}/outline?payload_preview_chars=0`);
    expect(outline.status).toBe(200);
    expect((await outline.json() as { run: { id: string } }).run.id).toBe(traceId);
  });

  test("legacy minimal files remain valid and malformed roots reject cleanly", async () => {
    expect((await importTo(destination, { run: { id: "minimal" }, spans: [] })).status).toBe(200);
    expect((await exported(destination, "minimal")).annotations).toEqual([]);
    for (const malformed of [[], {}, { run: null, spans: [] }]) expect((await importTo(destination, malformed)).status).toBe(400);
  });

  test("versioned exports preserve unavailable timing values in incomplete spans", async () => {
    const incoming: any = fixture();
    incoming.spans[0].end_time_ms = null; incoming.spans[0].duration_ms = null;
    expect((await importTo(destination, incoming)).status).toBe(200);
    const evidence = await exported();
    expect(evidence.spans[0]).toMatchObject({ end_time_ms: null, duration_ms: null });
    expect((await importTo(source, evidence)).status).toBe(200);
    expect(await exported(source)).toEqual(evidence);
  });

  test.each([false, true])("saved cache exports available evidence when an empty persisted placeholder exists: %s", async (placeholder) => {
    const runId = `cached-${placeholder ? "placeholder" : "only"}`;
    const data: any = fixture(runId); delete data.format; delete data.annotations;
    expect((await fetch(`${source}/api/saved-runs/cache/${runId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })).status).toBe(200);
    if (placeholder) expect((await importTo(source, { run: data.run, spans: [] })).status).toBe(200);
    const download = await exported(source, runId);
    expect(download).toMatchObject({ run: data.run, spans: data.spans, liveEvents: data.liveEvents, annotations: [], exportSource: "saved-cache" });
    expect(download.format).toBeUndefined();
    expect(download.exportNotice).toContain("may be compacted");
    expect((await importTo(source, download)).status).toBe(200);
    expect((await exported(source, runId)).format).toBe(TRACE_FORMAT);
    expect((await exported(source, runId)).spans).toHaveLength(1);
    expect((await importTo(destination, download)).status).toBe(200);
    expect((await exported(destination, runId)).spans).toEqual(data.spans);
  });

  test("saved cache cannot export another run's identity", async () => {
    expect((await fetch(`${source}/api/saved-runs/cache/cached-mismatch`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fixture("another-run")) })).status).toBe(200);
    expect((await fetch(`${source}/api/runs/cached-mismatch/export`)).status).toBe(500);
  });

  test("saved incomplete evidence preserves unknown span timing and status through export and import", async () => {
    const data: any = fixture("cached-incomplete");
    data.spans[0].end_time_ms = null; data.spans[0].duration_ms = null; data.spans[0].status = null;
    delete data.format; delete data.annotations;
    expect((await fetch(`${source}/api/saved-runs/cache/cached-incomplete`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "local", ...data }) })).status).toBe(200);
    const evidence = await exported(source, "cached-incomplete");
    expect(evidence.spans[0]).toMatchObject({ end_time_ms: null, duration_ms: null, status: null });
    expect((await importTo(destination, evidence)).status).toBe(200);
    expect((await exported(destination, "cached-incomplete")).spans).toEqual(data.spans);
  });

  test.each(["long", "whitespace"])("actual ingress, export and import preserve %s free-text names and event types", async (variant) => {
    const traceId = variant === "long" ? "ac000000000000000000000000000001" : "ac000000000000000000000000000002";
    const spanId = "ac00000000000001";
    const value = variant === "long" ? "captured label ".repeat(150) : " ";
    const ingested = await fetch(`${source}/v1/traces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      resourceSpans: [{ scopeSpans: [{ spans: [{ traceId, spanId, name: value, startTimeUnixNano: "1000000", endTimeUnixNano: "2000000" }] }] }],
    }) });
    expect(ingested.status).toBe(200);
    expect((await fetch(`${source}/v1/live`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ traceId, spanId, type: value, timestamp: 3 }) })).status).toBe(200);
    const evidence = await exported(source, traceId);
    expect(evidence.spans[0].name).toBe(value);
    expect(evidence.liveEvents[0].type).toBe(value);
    expect((await importTo(destination, evidence)).status).toBe(200);
    expect(await exported(destination, traceId)).toEqual(evidence);
  });

  test("identities outside portable bounds are rejected at export rather than producing an unimportable file", async () => {
    const runId = "x".repeat(1025);
    expect((await fetch(`${source}/v1/live`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ traceId: runId, type: "captured", timestamp: 3 }) })).status).toBe(200);
    const response = await fetch(`${source}/api/runs/${runId}/export`);
    expect(response.status).toBe(413);
    expect(await response.text()).toContain("run.id");
  });

  test("export preflights all text fields and the aggregate budget before loading raw rows", () => {
    // A smaller budget in an isolated process exercises the same SQL preflight
    // using byte-sized fixtures instead of allocating huge event/identity values.
    const profile = mkdtempSync(path.join(directory, "preflight-profile-"));
    const script = `
      import { getDrizzleDb } from './src/db';
      import { exportTrace, TRACE_LIMITS } from './src/trace-export';
      Object.assign(TRACE_LIMITS, { bytes: 256 });
      const db = getDrizzleDb().$client;
      const cases = [
        () => db.prepare('UPDATE runs SET metadata = ? WHERE id = ?').run('x'.repeat(300), 'r'),
        () => db.prepare('INSERT INTO live_events (trace_id, type, timestamp) VALUES (?, ?, ?)').run('r', 'x'.repeat(300), 1),
        () => db.prepare('INSERT INTO live_events (trace_id, type, span_id, timestamp) VALUES (?, ?, ?, ?)').run('r', 't', 'x'.repeat(300), 1),
        () => db.prepare('INSERT INTO spans (id, run_id, name) VALUES (?, ?, ?)').run('x'.repeat(300), 'r', 's'),
        () => db.prepare('INSERT INTO annotations (id, run_id, kind, source, created_at) VALUES (?, ?, ?, ?, ?)').run('x'.repeat(300), 'r', 'issue', 'user', 1),
        () => { db.prepare('UPDATE runs SET metadata = ? WHERE id = ?').run('x'.repeat(150), 'r'); db.prepare('INSERT INTO live_events (trace_id, type, timestamp) VALUES (?, ?, ?)').run('r', 'x'.repeat(150), 1); },
        () => db.prepare('INSERT INTO saved_run_cache (id, data) VALUES (?, ?)').run('r', 'x'.repeat(300)),
      ];
      const messages = [];
      for (const seed of cases) {
        for (const table of ['spans', 'live_events', 'annotations', 'runs', 'saved_run_cache']) db.exec('DELETE FROM ' + table);
        db.prepare('INSERT INTO runs (id, started_at, last_updated_at) VALUES (?, ?, ?)').run('r', 1, 1);
        seed();
        try { exportTrace('r'); messages.push('unexpected success'); } catch (error) { messages.push(error.message); }
      }
      console.log(JSON.stringify(messages));
    `;
    const result = spawnSync(process.execPath, ["-e", script], { cwd: path.resolve(import.meta.dir, ".."), encoding: "utf8",
      env: { ...process.env, HOME: profile, USERPROFILE: profile, RUNPHANTOM_DB_PATH: path.join(profile, "preflight.db") } });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual([
      ...Array(6).fill("trace exceeds portable export limits"), "saved trace exceeds the 10 MiB portable file limit",
    ]);
  });
});
