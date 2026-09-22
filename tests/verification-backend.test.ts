import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import express from "express";
import { WebSocket } from "ws";
import { createVerificationService } from "../src/verification/service";
import { createVerificationRouter } from "../src/verification/router";
import { closeDb, clearAll, getDrizzleDb, upsertRun, deleteRun } from "../src/db";
import { listReports, listFlows, saveReport } from "../src/verification/store";
import { VERIFICATION_LIMITS as L, type AppCommand } from "../src/verification/protocol";
import { boundReportContext } from "../src/verification/report-context";

const coverage = { network: true, console: true, dom: true, state: true, signal: true, route: true };
const pause = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const origin = "http://localhost:4312";
let directory: string;
let oldDb: string | undefined;
beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "rp-verification-"));
  oldDb = process.env.RUNPHANTOM_DB_PATH;
  closeDb();
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, "verification.db");
  getDrizzleDb();
});
afterAll(() => {
  closeDb();
  if (oldDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = oldDb;
  rmSync(directory, { recursive: true, force: true });
});

async function fixture() {
  const service = createVerificationService({ broadcast() {}, checkTimeoutMs: 800, commandTimeoutMs: 500 });
  const app = express();
  app.use(express.json());
  app.use("/api/verification", createVerificationRouter(service));
  const server = http.createServer(app);
  server.on("upgrade", (req, socket, head) => service.bridge.handleUpgrade(req, socket, head));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const sockets = new Set<WebSocket>();
  async function api(route: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(`${url}/api/verification${route}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  }
  async function pair(runId?: string) {
    const { body: created, status } = await api("/sessions", { origin, ...(runId ? { runId } : {}) });
    expect(status).toBe(201);
    const ws = new WebSocket(`${url.replace("http:", "ws:")}/verification/ws?sessionId=${created.id}`, { headers: { Origin: origin } });
    sockets.add(ws);
    await once(ws, "open");
    const ready = once(ws, "message");
    ws.send(JSON.stringify({ type: "hello", version: 1, token: created.token, coverage }));
    const [message] = await ready;
    expect(JSON.parse(message.toString())).toEqual({ type: "ready" });
    return { ws, created };
  }
  return { service, api, pair, url, sockets, async close() {
    for (const ws of sockets) ws.terminate();
    service.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

function respond(ws: WebSocket, result: (command: AppCommand, id: string) => unknown = () => ({})) {
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "command") return;
    if (message.command.type === "click" || message.command.type === "fill") {
      ws.send(JSON.stringify({ type: "event", event: { type: "action.boundary", data: {}, actionId: message.id } }));
    }
    ws.send(JSON.stringify({ type: "result", id: message.id, ok: true, result: result(message.command, message.id) }));
  });
}
function event(ws: WebSocket, type: string, data: unknown, actionId?: string) {
  ws.send(JSON.stringify({ type: "event", event: { type, data, ...(actionId ? { actionId } : {}) } }));
}
function network(ws: WebSocket, type: "network.start" | "network", requestId: string, actionId?: string) {
  event(ws, type, { requestId, url: "http://localhost:4312/cart", method: "POST", initiator: "fetch",
    ...(type === "network" ? { status: 200, ok: true, durationMs: 3 } : {}) }, actionId);
}

describe("application verification daemon", () => {
  test("fresh state and selector checks settle and persist reports linked to an existing run", async () => {
    const f = await fixture();
    try {
      upsertRun({ id: "verification-run", name: "run", started_at: 1, last_updated_at: 1 });
      const { ws, created } = await f.pair("verification-run");
      respond(ws, (command) => command.type === "state" ? { store: command.store, value: { count: 1 } } : { selector: "#cart", count: 1 });
      const assertion = await f.api(`/sessions/${created.id}/assert`, { predicate: { kind: "allOf", predicates: [
        { kind: "state", store: "cart", path: "count", equals: 1 }, { kind: "element", selector: "#cart", state: "present" },
      ] } });
      expect(assertion.status).toBe(200);
      expect(assertion.body.status).toBe("pass");
      expect(assertion.body.runId).toBe("verification-run");
      expect(assertion.body.evidence.some((entry: any) => entry.type === "state")).toBe(true);
      expect(listReports("verification-run")).toHaveLength(1);
      deleteRun("verification-run");
      expect(listReports().find((entry) => entry.id === assertion.body.id)).toBeUndefined();
    } finally { await f.close(); }
  });

  test("state changes during the quiet interval cannot retain an earlier passing snapshot", async () => {
    const f = await fixture();
    try {
      const { ws, created } = await f.pair();
      let count = 1;
      respond(ws, () => ({ store: "cart", value: { count } }));
      const pending = f.api(`/sessions/${created.id}/assert`, { predicate: { kind: "state", store: "cart", path: "count", equals: 1 } });
      await pause(100);
      count = 0;
      const report = await pending;
      expect(report.body.status).toBe("fail");
    } finally { await f.close(); }
  });

  test("a later incomplete successful read replaces earlier passing state evidence", async () => {
    const f = await fixture();
    try {
      const { ws, created } = await f.pair();
      let reads = 0;
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "command") return;
        ws.send(JSON.stringify({ type: "result", id: message.id, ok: true,
          result: ++reads === 1 ? { store: "cart", value: { count: 1 } } : { store: "cart" },
          ...(reads > 1 ? { truncated: true } : {}) }));
      });
      const report = await f.api(`/sessions/${created.id}/assert`, { predicate: { kind: "state", store: "cart", path: "count", equals: 1 } });
      expect(report.body.status).toBe("inconclusive");
      expect(report.body.evidence.at(-1).truncated).toBe(true);
    } finally { await f.close(); }
  });

  test("composites preserve decisive outcomes when another branch cannot be freshly read", async () => {
    const f = await fixture();
    try {
      const { ws, created } = await f.pair();
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "command") ws.send(JSON.stringify({ type: "result", id: message.id, ok: false, error: "Store unavailable" }));
      });
      event(ws, "signal", { name: "done" });
      event(ws, "console", { level: "error", message: "Observed failure" });
      await pause();
      const unavailable = { kind: "state", store: "missing", path: "count", equals: 1 };
      const alternative = await f.api(`/sessions/${created.id}/assert`, { predicate: { kind: "anyOf", predicates: [unavailable, { kind: "signal", name: "done" }] } });
      expect(alternative.body.status).toBe("pass");
      const all = await f.api(`/sessions/${created.id}/assert`, { predicate: { kind: "allOf", predicates: [unavailable, { kind: "console", level: "error", absent: true }] } });
      expect(all.body.status).toBe("fail");
    } finally { await f.close(); }
  });

  test("expected values and observation facts survive failed flow replay, deletion and restart", async () => {
    const f = await fixture();
    try {
      const { ws, created } = await f.pair();
      respond(ws, () => ({ store: "cart", value: { count: 0 } }));
      const predicate = { kind: "state", store: "cart", path: "count", equals: 1 };
      const flow = await f.api("/flows", { name: "Expected cart count", origin, steps: [{ predicate }] });
      const result = await f.api(`/flows/${flow.body.id}/run`, { sessionId: created.id });
      expect(result.body.status).toBe("fail");
      expect(result.body.evidence[0].data.value.count).toBe(0);
      expect(result.body.context).toMatchObject({ origin, quietMs: 300, redacted: false, truncated: false,
        checks: [{ step: 1, predicate, status: "fail", complete: true, settled: true, dropped: 0, coverage }] });
      expect(result.body.context.checks[0].through).toBeGreaterThan(result.body.context.checks[0].since);
      expect(result.body.context.checks[0].generation).toBeGreaterThan(0);
      const context = result.body.context;
      await f.api(`/flows/${flow.body.id}`, undefined, "DELETE");
      await f.api(`/sessions/${created.id}`, undefined, "DELETE");
      closeDb();
      expect(listReports().find((entry) => entry.id === result.body.id)?.context).toEqual(context);
    } finally { await f.close(); }
  });

  test("durable live-check context withholds credential expectations, escaped selectors and entered text", async () => {
    const f = await fixture();
    try {
      const { ws, created } = await f.pair();
      const secret = "unrecognized-private-expectation";
      const escapedSecret = "unrecognized-private-selector";
      const fill = "unrecognized-private-fill";
      respond(ws, (command) => command.type === "state" ? { store: command.store, value: { password: secret, count: 0 } } : { count: 0 });
      const credential = await f.api(`/sessions/${created.id}/assert`, { predicate: { kind: "state", store: "auth", path: "password", equals: secret } });
      expect(credential.body.context.redacted).toBe(true);
      expect(credential.body.context.checks[0].predicate).toBe("[REDACTED]");
      const selector = await f.api(`/sessions/${created.id}/assert`, { predicate: { kind: "element", selector: `[pass\\77 ord='${escapedSecret}']`, state: "present" } });
      expect(selector.body.context.redacted).toBe(true);
      expect(JSON.stringify(selector.body)).not.toContain(escapedSecret);
      await f.api(`/sessions/${created.id}/command`, { type: "fill", selector: "#input", value: fill });
      const entered = await f.api(`/sessions/${created.id}/assert`, { predicate: { kind: "state", store: "cart", path: "count", equals: fill } });
      expect(entered.body.context.redacted).toBe(true);
      expect(JSON.stringify(entered.body.context)).not.toContain(fill);
      const rows = getDrizzleDb().$client.query("SELECT context, evidence, reason FROM verification_reports").all();
      expect(JSON.stringify(rows)).not.toContain(secret);
      expect(JSON.stringify(rows)).not.toContain(escapedSecret);
      expect(JSON.stringify(rows)).not.toContain(fill);
      expect(JSON.stringify(rows)).not.toContain(created.token);
      expect(JSON.stringify(rows)).not.toContain('"command":');
    } finally { await f.close(); }
  });

  test("context bounds retain executed outcomes and explicitly flag withheld expectations", () => {
    const context = boundReportContext({ origin, quietMs: 300, redacted: false, truncated: false,
      checks: Array.from({ length: 25 }, (_, index) => ({ step: index + 1,
        predicate: { kind: "state", store: "cart", path: "data", equals: "x".repeat(4096) },
        status: "fail" as const, reason: "Expected different state", since: 1, through: 2, generation: 1,
        coverage, complete: true, dropped: 0, settled: true })) });
    expect(context.checks).toHaveLength(20);
    expect(context.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(L.MAX_CONTEXT_BYTES);
    expect(context.checks.every((check) => check.status === "fail" && check.since === 1 && check.through === 2)).toBe(true);
  });

  test("only request-start action identity can satisfy a later network assertion", async () => {
    const f = await fixture();
    try {
      const { ws, created } = await f.pair();
      let actionId: string | undefined;
      respond(ws, (command, id) => { if (command.type === "click" || command.type === "fill") actionId = id; return {}; });
      network(ws, "network.start", "old-request");
      await pause();
      const action = await f.api(`/sessions/${created.id}/command`, { type: "click", selector: "#submit" });
      network(ws, "network", "old-request", actionId);
      await pause();
      const result = await f.api(`/sessions/${created.id}/assert`, { since: action.body.cursor, predicate: { kind: "network", urlContains: "/cart", status: 200 } });
      expect(result.body.status).toBe("fail");
      network(ws, "network.start", "new-request", actionId);
      network(ws, "network", "new-request", actionId);
      await pause();
      expect((await f.api(`/sessions/${created.id}/assert`, { since: action.body.cursor, predicate: { kind: "network", urlContains: "/cart", status: 200 } })).body.status).toBe("pass");
    } finally { await f.close(); }
  });

  test("pending requests and missing observer coverage make negative assertions inconclusive", async () => {
    const f = await fixture();
    try {
      const { ws, created } = await f.pair();
      respond(ws);
      network(ws, "network.start", "unfinished");
      await pause();
      expect((await f.api(`/sessions/${created.id}/assert`, { predicate: { kind: "console", level: "error", absent: true } })).body.status).toBe("inconclusive");
      event(ws, "observer.error", { observer: "console", message: "observer unavailable" });
      network(ws, "network", "unfinished");
      await pause();
      expect((await f.api(`/sessions/${created.id}/assert`, { predicate: { kind: "console", level: "error", absent: true } })).body.status).toBe("inconclusive");
    } finally { await f.close(); }
  });

  test("commands lock a session and disconnect invalidates in-flight work", async () => {
    const f = await fixture();
    try {
      const { ws, created } = await f.pair();
      const pending = f.api(`/sessions/${created.id}/command`, { type: "snapshot" });
      await once(ws, "message");
      expect((await f.api(`/sessions/${created.id}/command`, { type: "click", selector: "#submit" })).status).toBe(409);
      ws.terminate();
      expect((await pending).body.ok).toBe(false);
      expect((await f.api(`/sessions/${created.id}/assert`, { predicate: { kind: "signal", name: "done" } })).body.status).toBe("inconclusive");
    } finally { await f.close(); }
  });

  test("session credentials stay private and fill values never enter events or SQLite", async () => {
    const f = await fixture();
    try {
      const { ws, created } = await f.pair();
      const secret = "arbitrary-fill-credential-for-test";
      respond(ws, () => ({ value: secret }));
      await f.api(`/sessions/${created.id}/command`, { type: "fill", selector: "#input", value: secret });
      event(ws, "console", { level: "error", message: `Echo ${secret} and ${created.token}` });
      await pause();
      const observation = await f.api(`/sessions/${created.id}/events`);
      expect(JSON.stringify(observation.body)).not.toContain(secret);
      expect(JSON.stringify(observation.body)).not.toContain(created.token);
      expect((await f.api("/sessions")).body[0].token).toBeUndefined();
      await f.api(`/sessions/${created.id}/assert`, { predicate: { kind: "console", level: "error", absent: false } });
      const rows = getDrizzleDb().$client.query("SELECT evidence, reason, name FROM verification_reports").all();
      expect(JSON.stringify(rows)).not.toContain(secret);
      expect(JSON.stringify(rows)).not.toContain(created.token);
      expect((await f.api("/flows", { name: "credential", origin, steps: [{ command: { type: "fill", selector: "#input", value: secret }, predicate: { kind: "signal", name: "done" } }] })).status).toBe(400);
    } finally { await f.close(); }
  });

  test("ordinary short fill values preserve protocol fields, numeric snapshots and report status", async () => {
    const f = await fixture();
    try {
      const { ws, created } = await f.pair();
      respond(ws, (command) => command.type === "snapshot" ? { selector: "#cart", count: 1, enabled: true } : {});
      for (const value of ["1", "e", "true", "pass", "console", "error", "level", "count"]) {
        const result = await f.api(`/sessions/${created.id}/command`, { type: "fill", selector: "#input", value });
        expect(result.body.ok).toBe(true);
      }
      const snapshot = await f.api(`/sessions/${created.id}/command`, { type: "snapshot", selector: "#cart" });
      expect(snapshot.body.result.count).toBe(1);
      expect(snapshot.body.result.enabled).toBe(true);
      const check = await f.api(`/sessions/${created.id}/assert`, { predicate: { kind: "element", selector: "#cart", state: "present" } });
      expect(check.body.status).toBe("pass");
      expect(listReports().find((report) => report.id === check.body.id)?.status).toBe("pass");
      event(ws, "console", { level: "error", message: "Observed failure" });
      await pause();
      const absence = await f.api(`/sessions/${created.id}/assert`, { predicate: { kind: "console", level: "error", absent: true } });
      expect(absence.body.status).toBe("fail");
      expect(absence.body.evidence[0].type).toBe("console");
      expect(absence.body.evidence[0].data.level).toBe("error");
    } finally { await f.close(); }
  });

  test("hello without a responsive document cannot establish console absence", async () => {
    const f = await fixture();
    try {
      const { created } = await f.pair();
      const check = await f.api(`/sessions/${created.id}/assert`, { predicate: { kind: "console", level: "error", absent: true } });
      expect(check.body.status).toBe("inconclusive");
      expect(check.body.reason).toContain("timed out");
    } finally { await f.close(); }
  });

  test("authentication rejects invalid credentials and reconnect clears old evidence and invalidates assertions", async () => {
    const f = await fixture();
    try {
      const { ws, created } = await f.pair();
      event(ws, "signal", { name: "old-document" });
      await pause();
      const assertion = f.api(`/sessions/${created.id}/assert`, { predicate: { kind: "console", level: "error", absent: true } });
      await pause(60);
      const closed = once(ws, "close");
      ws.terminate();
      await closed;
      expect((await assertion).body.status).toBe("inconclusive");
      const url = `${f.url.replace("http:", "ws:")}/verification/ws?sessionId=${created.id}`;
      const wrong = new WebSocket(url, { headers: { Origin: origin } });
      wrong.on("error", () => {});
      f.sockets.add(wrong);
      await once(wrong, "open");
      const rejected = once(wrong, "close");
      wrong.send(JSON.stringify({ type: "hello", version: 1, token: "invalid", coverage }));
      expect((await rejected)[0]).toBe(1008);
      const fresh = new WebSocket(url, { headers: { Origin: origin } });
      fresh.on("error", () => {});
      f.sockets.add(fresh);
      await once(fresh, "open");
      const ready = once(fresh, "message");
      fresh.send(JSON.stringify({ type: "hello", version: 1, token: created.token, coverage }));
      await ready;
      const observed = await f.api(`/sessions/${created.id}/events`);
      expect(observed.body.events).toEqual([]);
      expect(observed.body.complete).toBe(true);
      fresh.send(JSON.stringify({ type: "result", id: "stale-command", ok: true }));
      expect((await once(fresh, "close"))[0]).toBe(1008);
    } finally { await f.close(); }
  });

  test("saved flows enforce origin, return failed and passing replay, and survive DB reopen", async () => {
    const f = await fixture();
    try {
      const { ws, created } = await f.pair();
      let count = 0;
      respond(ws, () => ({ selector: "#cart", count }));
      const flow = await f.api("/flows", { name: "Cart", origin, steps: [{ command: { type: "click", selector: "#add" }, predicate: { kind: "element", selector: "#cart", state: "present" } }] });
      expect(flow.status).toBe(201);
      expect((await f.api(`/flows/${flow.body.id}/run`, { sessionId: created.id })).body.status).toBe("fail");
      count = 1;
      expect((await f.api(`/flows/${flow.body.id}/run`, { sessionId: created.id })).body.status).toBe("pass");
      const wrong = await f.api("/sessions", { origin: "http://localhost:4999" });
      expect((await f.api(`/flows/${flow.body.id}/run`, { sessionId: wrong.body.id })).status).toBe(409);
      closeDb();
      expect(listFlows().some((entry) => entry.id === flow.body.id)).toBe(true);
      expect(listReports().some((entry) => entry.flowId === flow.body.id && entry.status === "pass")).toBe(true);
      const collectionFirst = await f.api("/flows", { name: "Structured state", origin, steps: [{ predicate: { kind: "state", store: "cart", path: "summary", equals: { items: [], total: 0 } } }] });
      expect(collectionFirst.status).toBe(201);
      closeDb();
      expect(listFlows().find((entry) => entry.id === collectionFirst.body.id)?.steps[0].predicate).toEqual({ kind: "state", store: "cart", path: "summary", equals: { items: [], total: 0 } });
    } finally { await f.close(); }
  });

  test("bounded event history rejects incomplete assertions and exclusive cursors exclude equality", async () => {
    const f = await fixture();
    try {
      const { ws: _ws, created } = await f.pair();
      const session = f.service.bridge.get(created.id);
      const start = session.cursor;
      for (let i = 0; i < L.MAX_EVENTS + 10; i++) f.service.bridge.append(session, { type: "signal", data: { name: "done" } });
      const observation = f.service.bridge.observe(session, start);
      expect(observation.events).toHaveLength(L.MAX_EVENTS);
      expect(observation.complete).toBe(false);
      expect(observation.session.dropped).toBe(10);
      const atLast = f.service.bridge.observe(session, session.cursor);
      expect(atLast.events).toEqual([]);
      expect((await f.api(`/sessions/${created.id}/events?since=1.5`)).status).toBe(400);
      // Lost request accounting cannot be repaired by advancing the caller's cursor.
      event(_ws, "capture.loss", { reason: "capture queue overflow" });
      await pause();
      expect(f.service.bridge.observe(session, session.cursor).complete).toBe(false);
    } finally { await f.close(); }
  });

  test("report retention is bounded and reset clears reports and saved flows", () => {
    const db = getDrizzleDb().$client;
    const firstCreatedAt = Date.now();
    const report = (i: number) => ({ id: `bounded-report-${i}`, sessionId: "test-session", runId: null, flowId: null, name: "Bounded", status: "inconclusive" as const, reason: "test", evidence: [], createdAt: firstCreatedAt + i });
    // Batch fixture setup, not the boundary write: a thousand independent fsyncs
    // measures the runner's disk rather than the retention contract.
    db.transaction(() => {
      for (let i = 0; i < L.MAX_REPORTS; i++) saveReport(report(i));
    })();
    saveReport(report(L.MAX_REPORTS));
    const row = db.query("SELECT COUNT(*) AS n FROM verification_reports").get() as { n: number };
    expect(row.n).toBe(L.MAX_REPORTS);
    expect(db.query("SELECT id FROM verification_reports WHERE id = ?").get("bounded-report-0")).toBeNull();
    expect(db.query("SELECT id FROM verification_reports WHERE id = ?").get(`bounded-report-${L.MAX_REPORTS}`)).not.toBeNull();
    clearAll();
    expect(listReports()).toEqual([]);
    expect(listFlows()).toEqual([]);
  });

  test("real daemon preserves UI websocket and control guards while allowing scoped SDK imports", async () => {
    const { createServer } = await import("../src/server");
    const { server } = await createServer(0);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const sockets: WebSocket[] = [];
    try {
      const ui = new WebSocket(`${url.replace("http:", "ws:")}/ws`, { headers: { Origin: "http://localhost:5948" } });
      ui.on("error", () => {});
      sockets.push(ui);
      await once(ui, "open").catch((error) => { throw new Error(`UI handshake failed: ${String(error?.message ?? error)}`); });
      const create = await fetch(`${url}/api/verification/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin }) });
      const paired = await create.json() as any;
      expect(create.status).toBe(201);
      const browser = new WebSocket(`${url.replace("http:", "ws:")}/verification/ws?sessionId=${paired.id}`, { headers: { Origin: origin } });
      browser.on("error", () => {});
      sockets.push(browser);
      await once(browser, "open").catch((error) => { throw new Error(`App handshake failed: ${String(error?.message ?? error)}`); });
      const ready = once(browser, "message");
      browser.send(JSON.stringify({ type: "hello", version: 1, token: paired.token, coverage }));
      expect(JSON.parse((await ready)[0].toString()).type).toBe("ready");
      expect(ui.readyState).toBe(WebSocket.OPEN);
      const sdk = await fetch(`${url}/verification/sdk.js`, { headers: { Origin: origin } });
      expect(sdk.status).toBe(200);
      expect(sdk.headers.get("access-control-allow-origin")).toBe(origin);
      expect(sdk.headers.get("content-type")).toContain("javascript");
      expect((await sdk.text()).length).toBeGreaterThan(1000);
      expect((await fetch(`${url}/verification/sdk.js`, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
      expect((await fetch(`${url}/api/verification/sessions`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ origin }) })).status).toBe(403);
      expect((await fetch(`${url}/api/verification/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin: "x".repeat(L.MAX_FRAME_BYTES) }) })).status).toBe(413);
      const wrong = new WebSocket(`${url.replace("http:", "ws:")}/verification/ws?sessionId=${paired.id}`, { headers: { Origin: "http://localhost:4999" } });
      wrong.on("error", () => {});
      sockets.push(wrong);
      expect((await once(wrong, "error"))[0]).toBeDefined();
      wrong.terminate();
    } finally {
      for (const ws of sockets) { ws.on("error", () => {}); ws.terminate(); }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
