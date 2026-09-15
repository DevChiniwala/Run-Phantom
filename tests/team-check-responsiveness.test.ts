import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { startTeamFixture } from "./helpers/team-server";
import { TEAM_LIMITS as L, type Check, type Project, type SessionResponse } from "../src/team/protocol";

const trace = (n: number) => n.toString(16).padStart(32, "0");
const span = (n: number) => n.toString(16).padStart(16, "0");
function telemetry(padding: number, runs = [1, 2], spanCount = 100) {
  return { resourceSpans: [{ scopeSpans: [{ spans: runs.flatMap(run => Array.from({ length: spanCount }, (_, index) => ({
    traceId: trace(run), spanId: span(index + 1), ...(index ? { parentSpanId: span(index) } : {}), name: index ? "charge" : "agent", kind: 1,
    startTimeUnixNano: String(1_800_000_000_000_000_000n + BigInt(index) * 1_000_000n),
    endTimeUnixNano: String(1_800_000_001_000_000_000n - BigInt(index) * 1_000_000n), status: { code: 1 },
    attributes: Object.entries({ "openinference.span.kind": index ? "TOOL" : "AGENT", "input.value": index ? JSON.stringify({ customer: "correct", padding: "x".repeat(padding) }) : "Question", "output.value": index ? "Done" : "Answer" }).map(([key, value]) => ({ key, value: { stringValue: value } })),
  }))) }] }] };
}

test("maximum check acquisition keeps actual HTTP session health and ingestion responsive", async () => {
  const fixture = await startTeamFixture("check-responsiveness");
  let db: Database | undefined;
  try {
    const setup = await fetch(`${fixture.url}/api/team/setup`, { method: "POST", headers: { Origin: fixture.url, "Content-Type": "application/json" }, body: JSON.stringify({ setupCode: fixture.setupCode, email: "checks@example.test", password: "Deterministic check fixture 42!" }) });
    expect(setup.status).toBe(201);
    const session = await setup.json() as Extract<SessionResponse, { authenticated: true }>;
    const cookie = setup.headers.get("set-cookie")!.split(";")[0];
    const headers = { Cookie: cookie, Origin: fixture.url, "Content-Type": "application/json", "X-RunPhantom-CSRF": session.csrfToken };
    async function post(suffix: string, body: unknown) { return fetch(`${fixture.url}${suffix}`, { method: "POST", headers, body: JSON.stringify(body) }); }
    const projectResponse = await post("/api/team/projects", { name: "Check budget" }); expect(projectResponse.status).toBe(201);
    const project = await projectResponse.json() as Project, root = `/api/team/projects/${project.id}`;
    const keyResponse = await post(`${root}/keys`, { label: "Budget fixture" }); expect(keyResponse.status).toBe(201);
    const key = await keyResponse.json() as { token: string };
    async function ingest(body: unknown) { return fetch(`${fixture.url}/api/team/ingest/v1/traces`, { method: "POST", headers: { Authorization: `Bearer ${key.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
    const definition = { name: "Maximum bounded evidence", referenceRunId: trace(1), candidateRunIds: [trace(2)], rules: Array.from({ length: 8 }, () => ({ kind: "toolArgument", name: "charge", path: "customer", equals: "correct", match: "any" })) };
    const definitionBytes = Buffer.byteLength(JSON.stringify(definition));
    expect((await ingest(telemetry(0))).status).toBe(200);
    db = new Database(path.join(fixture.dataDir, "team.sqlite"), { readonly: true });
    const acquisition = () => ((db!.query("SELECT (SELECT COALESCE(SUM(byte_size),0) FROM runs WHERE project_id=?) + (SELECT COALESCE(SUM(byte_size),0) FROM spans WHERE project_id=?) AS size").get(project.id, project.id) as { size: number }).size + definitionBytes);
    const base = acquisition();
    expect((await ingest(telemetry(1))).status).toBe(200); const increment = acquisition() - base;
    expect(increment).toBeGreaterThan(0);
    const padding = Math.floor((L.CHECK_ACQUISITION_BYTES - base) / increment);
    expect(padding).toBeGreaterThanOrEqual(1);
    expect((await ingest(telemetry(padding))).status).toBe(200);
    const acquiredBytes = acquisition();
    expect(acquiredBytes).toBeLessThanOrEqual(L.CHECK_ACQUISITION_BYTES); expect(acquiredBytes).toBeGreaterThan(L.CHECK_ACQUISITION_BYTES - 2048);
    expect((db.query("SELECT COUNT(*) AS count FROM spans WHERE project_id=?").get(project.id) as { count: number }).count).toBe(200);
    async function timed(work: () => Promise<Response>) { const start = performance.now(); const response = await work(); await response.clone().arrayBuffer(); return { response, elapsedMs: performance.now() - start }; }
    const first = timed(() => post(`${root}/checks`, definition));
    const second = timed(() => post(`${root}/checks`, { ...definition, name: "Second maximum bounded evidence" }));
    const health = timed(() => fetch(`${fixture.url}/api/team/session`));
    const concurrentIngest = timed(() => ingest(telemetry(0, [3], 1)));
    const [left, right, pulse, ingestResult] = await Promise.all([first, second, health, concurrentIngest]);
    expect(left.response.status).toBe(201); expect(right.response.status).toBe(201); expect(pulse.response.status).toBe(200); expect(ingestResult.response.status).toBe(200);
    expect(pulse.elapsedMs).toBeLessThan(1000); expect(ingestResult.elapsedMs).toBeLessThan(1000);
    const results = await Promise.all([left.response.json(), right.response.json()]) as Check[];
    expect(results.map(item => item.status), JSON.stringify(results.map(item => ({ inputMatch: item.results[0].inputMatch, referenceComplete: item.referenceSnapshot.complete,
      referenceWarnings: item.referenceSnapshot.warnings, warnings: item.results[0].snapshot.warnings, reason: item.results[0].ruleResults[0].reason })))).toEqual(["pass", "pass"]);
    expect(results.every(item => Number.isFinite(item.calculationDurationMs) && item.calculationDurationMs < 1000)).toBe(true);
    expect((await ingest(telemetry(padding + 10))).status).toBe(200);
    const excess = await post(`${root}/checks`, definition); expect(excess.status).toBe(413);
    expect((db.query("SELECT COUNT(*) AS count FROM checks WHERE project_id=?").get(project.id) as { count: number }).count).toBe(2);
    console.info(JSON.stringify({ fixture: "team-check-responsiveness", acquiredBytes, spans: 200, checks: 2, rulesPerCheck: 8, healthMs: pulse.elapsedMs, ingestMs: ingestResult.elapsedMs, calculationMs: results.map(item => item.calculationDurationMs) }));
  } finally { db?.close(); await fixture.close(); }
}, 30_000);
