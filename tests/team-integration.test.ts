import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { startTeamFixture, type TeamFixture } from "./helpers/team-server";
import type { Check, Project, SessionResponse } from "../src/team/protocol";

type Session = Extract<SessionResponse, { authenticated: true }> & { cookie: string };
let fixture: TeamFixture;
let owner: Session, viewer: Session, editor: Session;
let projectA: Project, projectB: Project;
let keyA: { key: { id: string }; token: string }, keyB: typeof keyA;
const password = "A precise test password 42!";
const trace = "0123456789abcdef0123456789abcdef";
const candidate = "1123456789abcdef0123456789abcdef";
const span = "0123456789abcdef";

async function request(route: string, options: { session?: Session; method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const method = options.method ?? "GET";
  return fetch(`${fixture.url}${route}`, {
    method,
    headers: {
      ...(options.session ? { Cookie: options.session.cookie } : {}),
      ...(method !== "GET" ? { Origin: fixture.url, "Content-Type": "application/json",
        ...(options.session ? { "X-RunPhantom-CSRF": options.session.csrfToken } : {}) } : {}),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  expect({ status: response.status, error: body.error }).toEqual({ status, error: undefined });
  return body as T;
}

async function sessionFrom(response: Response, nested = false): Promise<Session> {
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  expect(cookie).toBeTruthy();
  const body = await response.json();
  const session = nested ? body.session : body;
  expect(session.authenticated).toBe(true);
  return { ...session, cookie };
}

function projectPath(project: Project, suffix = "") { return `/api/team/projects/${project.id}${suffix}`; }

async function invite(project: Project, email: string, role: "viewer" | "editor" | "admin") {
  const created = await json<{ token: string }>(await request(projectPath(project, "/invites"), {
    method: "POST", session: owner, body: { email, role },
  }), 201);
  return sessionFrom(await request("/api/team/invites/accept", {
    method: "POST", body: { token: created.token, email, password },
  }), true);
}

function telemetry(id: string, answer: string, extra: Record<string, string> = {}) {
  const now = Date.now() - 2000;
  return { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "team-fixture" } }] }, scopeSpans: [{ spans: [{
    traceId: id, spanId: span, name: "Shared checkout", kind: 1,
    startTimeUnixNano: String(BigInt(now) * 1_000_000n), endTimeUnixNano: String(BigInt(now + 100) * 1_000_000n),
    status: { code: 1 }, attributes: Object.entries({
      "openinference.span.kind": "AGENT", "input.value": "Inspect checkout", "output.value": answer, ...extra,
    }).map(([key, value]) => ({ key, value: { stringValue: value } })),
  }] }] }] };
}

async function ingest(token: string, payload: unknown, compressed = false) {
  const body = Buffer.from(JSON.stringify(payload));
  return fetch(`${fixture.url}/api/team/ingest/v1/traces`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      ...(compressed ? { "Content-Encoding": "gzip" } : {}) },
    body: compressed ? gzipSync(body) : body,
  });
}

beforeAll(async () => {
  fixture = await startTeamFixture("integration", process.env.RUNPHANTOM_TEAM_TEST_BINARY);
  owner = await sessionFrom(await request("/api/team/setup", {
    method: "POST", body: { setupCode: fixture.setupCode, email: "owner@example.test", password },
  }));
  projectA = await json<Project>(await request("/api/team/projects", { method: "POST", session: owner, body: { name: "Project A" } }), 201);
  projectB = await json<Project>(await request("/api/team/projects", { method: "POST", session: owner, body: { name: "Project B" } }), 201);
  viewer = await invite(projectA, "viewer@example.test", "viewer");
  editor = await invite(projectA, "editor@example.test", "editor");
  keyA = await json(await request(projectPath(projectA, "/keys"), { method: "POST", session: owner, body: { label: "A exporter" } }), 201);
  keyB = await json(await request(projectPath(projectB, "/keys"), { method: "POST", session: owner, body: { label: "B exporter" } }), 201);
  expect((await ingest(keyA.token, telemetry(trace, "A unique answer 100%_literal"))).status).toBe(200);
  expect((await ingest(keyA.token, telemetry(candidate, "A unique answer 100%_literal"), true)).status).toBe(200);
  expect((await ingest(keyB.token, telemetry(trace, "B private answer"))).status).toBe(200);
}, 30_000);

afterAll(async () => { await fixture?.close(); });

describe("isolated team service through the actual CLI and HTTP", () => {
  test("does not initialize local machine state and exposes only team routes", async () => {
    expect(existsSync(path.join(fixture.profile, ".runphantom", "runphantom.db"))).toBe(false);
    expect(existsSync(path.join(fixture.profile, ".runphantom", "runphantom.pid"))).toBe(false);
    for (const route of ["/api/runs", "/api/clear", "/api/replay", "/api/settings", "/api/agents", "/api/workspace", "/api/secrets", "/ws"]) {
      const response = await request(route, { session: owner });
      expect({ route, status: response.status }).toEqual({ route, status: 404 });
      expect(response.headers.get("content-type")).toContain("application/json");
    }
    const session = await request("/api/team/session");
    expect(await session.json()).toMatchObject({ authenticated: false, setupRequired: false, csrfToken: null });
    expect(session.headers.get("cache-control")).toBe("no-store");
  });

  test("same trace and span identities remain isolated in every read path", async () => {
    const ownSpan = await json<{ outputPayload: string }>(await request(projectPath(projectA, `/runs/${trace}/spans/${span}`), { session: viewer }));
    expect(ownSpan.outputPayload).toContain("A unique answer");
    expect(JSON.stringify(ownSpan)).not.toContain("B private answer");
    for (const suffix of ["", "/runs", `/runs/${trace}`, `/runs/${trace}/spans/${span}`, `/runs/${trace}/notes`, "/metrics", "/checks", "/audit", "/keys", "/members"]) {
      const response = await request(projectPath(projectB, suffix), { session: viewer });
      expect({ suffix, status: response.status }).toEqual({ suffix, status: 404 });
      expect(await response.text()).not.toContain("B private answer");
    }
    const projects = await json<{ items: Project[] }>(await request("/api/team/projects", { session: viewer }));
    expect(projects.items.map(p => p.id)).toEqual([projectA.id]);
    const detail = await json<{ spans: { items: object[] } }>(await request(projectPath(projectA, `/runs/${trace}`), { session: viewer }));
    expect(JSON.stringify(detail.spans.items)).not.toContain("outputPayload");
  });

  test("search is literal, paginated and bound to project and filters", async () => {
    const response = await request(projectPath(projectA, "/runs?q=100%25_literal&limit=1"), { session: viewer });
    const found = await json<{ items: { id: string }[]; nextCursor: string; hasMore: boolean }>(response);
    expect(found.items).toHaveLength(1);
    expect(found.hasMore).toBe(true);
    const next = await json<{ items: { id: string }[] }>(await request(projectPath(projectA,
      `/runs?q=100%25_literal&limit=1&cursor=${encodeURIComponent(found.nextCursor)}`), { session: viewer }));
    expect(next.items).toHaveLength(1);
    expect(next.items[0].id).not.toBe(found.items[0].id);
    expect((await request(projectPath(projectA, `/runs?q=different&cursor=${encodeURIComponent(found.nextCursor)}`), { session: viewer })).status).toBe(400);
    expect((await request(projectPath(projectB, `/runs?q=100%25_literal&cursor=${encodeURIComponent(found.nextCursor)}`), { session: owner })).status).toBe(400);
    expect((await request(projectPath(projectA, "/runs?q=a&q=b"), { session: viewer })).status).toBe(400);
    const privateSearch = await json<{ items: unknown[] }>(await request(projectPath(projectA, "/runs?q=B%20private"), { session: viewer }));
    expect(privateSearch.items).toEqual([]);
  });

  test("session cookies and ingest keys cannot substitute for each other's authority", async () => {
    expect((await request("/api/team/projects", { headers: { Authorization: `Bearer ${keyA.token}` } })).status).toBe(401);
    expect((await request("/api/team/ingest/v1/traces", { method: "POST", session: owner, body: telemetry(trace, "spoof") })).status).toBe(401);
    expect((await request(projectPath(projectB, "/runs"), { headers: { Authorization: `Bearer ${keyA.token}` } })).status).toBe(401);
    expect((await request(projectPath(projectA, "/keys"), { method: "POST", session: viewer, body: { label: "forbidden" } })).status).toBe(403);
    for (const suffix of ["/members", "/keys", "/invites", "/audit"]) {
      expect((await request(projectPath(projectA, suffix), { session: viewer })).status).toBe(403);
    }
    const keys = await json<{ items: unknown[] }>(await request(projectPath(projectA, "/keys"), { session: owner }));
    expect(JSON.stringify(keys)).not.toContain(keyA.token);
  });

  test("notes are shared with server-authored identity and enforce ownership", async () => {
    const note = await json<{ id: string; text: string; author: { id: string } }>(await request(projectPath(projectA, `/runs/${trace}/notes`), {
      method: "POST", session: editor, body: { text: "<script>captured text stays inert</script>", kind: "issue", spanId: span },
    }), 201);
    expect(note.author.id).toBe(editor.user.id);
    const notes = await json<{ items: { id: string }[] }>(await request(projectPath(projectA, `/runs/${trace}/notes`), { session: viewer }));
    expect(notes.items.map(item => item.id)).toContain(note.id);
    expect((await request(projectPath(projectA, `/runs/${trace}/notes`), {
      method: "POST", session: viewer, body: { text: "blocked", kind: "note" },
    })).status).toBe(403);
    expect((await request(projectPath(projectA, `/runs/${trace}/notes/${note.id}`), { method: "DELETE", session: owner })).status).toBe(403);
    expect((await request(projectPath(projectA, `/runs/${trace}/notes`), {
      method: "POST", session: editor, body: { text: "spoof", kind: "note", author: { id: owner.user.id } },
    })).status).toBe(400);
    expect((await request(projectPath(projectA, `/runs/${trace}/notes/${note.id}`), { method: "DELETE", session: editor })).status).toBe(204);
  });

  test("metrics retain actual denominators and known duration population", async () => {
    const metrics = await json<{ traces: { total: number; completed: number; failed: number; running: number; terminal: number }; duration: { knownCount: number; unavailableCount: number; p50Ms: number; p95Ms: number } }>(
      await request(projectPath(projectA, "/metrics?window=1h"), { session: viewer }));
    expect(metrics.traces).toEqual({ total: 2, completed: 2, failed: 0, running: 0, terminal: 2 });
    expect(metrics.duration.knownCount + metrics.duration.unavailableCount).toBe(metrics.traces.completed);
    expect(metrics.duration.p50Ms).toBe(100);
    expect(metrics.duration.p95Ms).toBe(100);
  });

  test("credential canaries never reach stored evidence or inspection responses", async () => {
    const canary = "sk-proj-" + "CanaryCredential".repeat(4);
    const safeTrace = "2123456789abcdef0123456789abcdef";
    expect((await ingest(keyA.token, telemetry(safeTrace, `Result ${canary}`, {
      "http.request.header.authorization": `Bearer ${canary}`,
      "request.url": `https://example.test/path?api_key=${canary}`,
      "nested.data": JSON.stringify({ wrapper: { password: canary }, token: keyA.token }),
    }))).status).toBe(200);
    const evidence = await request(projectPath(projectA, `/runs/${safeTrace}/spans/${span}`), { session: viewer });
    const evidenceText = await evidence.text();
    expect(evidence.status).toBe(200);
    expect(evidenceText).not.toContain(canary);
    expect(evidenceText).not.toContain(keyA.token);
    expect(evidenceText).toMatch(/REDACTED|unavailable/);
    for (const file of readdirSync(fixture.dataDir).filter(name => /\.sqlite(?:-wal)?$/.test(name))) {
      const raw = readFileSync(path.join(fixture.dataDir, file)).toString("utf8");
      expect(raw).not.toContain(canary);
      expect(raw).not.toContain(keyA.token);
      expect(raw).not.toContain(fixture.setupCode);
    }
    expect(fixture.logs()).not.toContain(canary);
    expect(fixture.logs()).not.toContain(keyA.token);
  });

  test("saved checks preserve frozen evidence after live source mutation and deletion", async () => {
    const unsafeDefinition = JSON.stringify({ name: "Numeric fidelity", referenceRunId: trace, candidateRunIds: [candidate],
      rules: [{ kind: "jsonPath", path: "n", equals: "unsafe-number-placeholder" }] }).replace('"unsafe-number-placeholder"', "9007199254740993");
    const unsafe = await fetch(`${fixture.url}${projectPath(projectA, "/checks")}`, {
      method: "POST", headers: { Cookie: editor.cookie, Origin: fixture.url, "Content-Type": "application/json", "X-RunPhantom-CSRF": editor.csrfToken },
      body: unsafeDefinition,
    });
    expect(unsafe.status).toBe(400);
    const body = { name: "Checkout output", referenceRunId: trace, candidateRunIds: [candidate], rules: [{ kind: "output", operation: "contains", value: "A unique answer" }] };
    expect((await request(projectPath(projectA, "/checks"), { method: "POST", session: viewer, body })).status).toBe(403);
    const check = await json<Check>(await request(projectPath(projectA, "/checks"), { method: "POST", session: editor, body }), 201);
    expect(check.status).toBe("pass");
    expect(check.counts).toEqual({ total: 1, pass: 1, fail: 0, inconclusive: 0 });
    expect(check.author.id).toBe(editor.user.id);
    expect(check.calculationDurationMs).toBeGreaterThanOrEqual(0);
    expect((await ingest(keyA.token, telemetry(candidate, "Changed source answer"))).status).toBe(200);
    expect((await request(projectPath(projectA, `/runs/${candidate}`), { method: "DELETE", session: editor })).status).toBe(403);
    expect((await request(projectPath(projectA, `/runs/${candidate}`), { method: "DELETE", session: owner })).status).toBe(204);
    const saved = await json<Check>(await request(projectPath(projectA, `/checks/${check.id}`), { session: viewer }));
    expect(saved).toEqual(check);
    const reportResponse = await request(projectPath(projectA, `/checks/${check.id}/report`), { session: viewer });
    expect(reportResponse.headers.get("content-disposition")).toContain("attachment");
    const report = await json<Record<string, unknown>>(reportResponse);
    expect(report.format).toBe("runphantom-team-check/v1");
    expect(JSON.stringify(report)).not.toContain("A unique answer");
    expect(JSON.stringify(report)).not.toContain("referenceSnapshot");
    expect((await request(projectPath(projectB, `/checks/${check.id}/report`), { session: owner })).status).toBe(404);
    const audit = await json<{ items: { action: string }[] }>(await request(projectPath(projectA, "/audit"), { session: owner }));
    expect(audit.items.map(item => item.action)).toContain("check.created");
    expect(audit.items.map(item => item.action)).toContain("run.deleted");
    expect(JSON.stringify(audit)).not.toContain(keyA.token);
  });

  test("last-admin protection and revocation remove access on the next request", async () => {
    expect((await request(projectPath(projectA, `/members/${owner.user.id}`), { method: "PATCH", session: owner, body: { role: "viewer" } })).status).toBe(409);
    expect((await request(projectPath(projectA, `/members/${viewer.user.id}`), { method: "DELETE", session: owner })).status).toBe(204);
    expect((await request(projectPath(projectA, `/runs/${trace}/spans/${span}`), { session: viewer })).status).toBe(404);
    expect((await request(projectPath(projectA, `/keys/${keyA.key.id}`), { method: "DELETE", session: owner })).status).toBe(204);
    expect((await ingest(keyA.token, telemetry(trace, "revoked"))).status).toBe(401);
    expect((await request(projectPath(projectA, `/keys/${keyA.key.id}`), { method: "DELETE", session: owner })).status).toBe(404);
    const ownSession = await json<SessionResponse>(await request("/api/team/session", { session: owner }));
    expect(ownSession.authenticated).toBe(true);
  });
});
