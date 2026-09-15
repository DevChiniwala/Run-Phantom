import { describe, expect, test } from "bun:test";
import { createCheckReport, parseCheckCreate, TeamCheckService } from "../src/team/checks";
import { TeamError } from "../src/team/errors";
import { TEAM_LIMITS as L, type Check, type CheckCreate, type CheckReport } from "../src/team/protocol";
import type { ProjectContext } from "../src/team/store";
import type { SnapshotRun, SnapshotSpan } from "../src/evaluations/protocol";

const id = (n: number) => n.toString(16).padStart(32, "0");
const scope = { tokenHash: "session-hash", projectId: "project-a", role: "editor", user: { id: "user-a", email: "editor@example.test", isOwner: false, createdAt: 1 }, session: { id: "session", current: true, createdAt: 1, lastActiveAt: 1, expiresAt: Date.now() + 60_000, idleExpiresAt: Date.now() + 60_000 }, requestId: "request" } as ProjectContext;
function capture(n: number, input = "Question", output = "Answer") {
  const run: SnapshotRun = { id: id(n), name: `Run ${n}`, started_at: 1, last_updated_at: 10 };
  const spans: SnapshotSpan[] = [{ id: id(n + 100).slice(16), run_id: run.id, name: "agent", span_type: "AGENT_ROOT", status: "OK", input_payload: input, output_payload: output, attributes: "{}", start_time_ms: 1, end_time_ms: 10 }];
  return { run, spans };
}
const draft = (candidateRunIds = [id(2)]): CheckCreate => ({ name: "Check", referenceRunId: id(1), candidateRunIds, rules: [{ kind: "output", operation: "equals", value: "Answer" }] });
async function rejection(work: Promise<unknown>): Promise<unknown> {
  try { await work; } catch (error) { return error; }
  throw new Error("Expected check creation to reject");
}
function fixture() {
  let authorized = true;
  const captures = [capture(1), capture(2), capture(3, "Question", "Wrong"), capture(4, "Different", "Answer")];
  const saved: Check[] = [], reports: CheckReport[] = [];
  let acquireCount = 0, authorizeCount = 0;
  let afterAcquire = () => {};
  const store = {
    projectScope(current: ProjectContext, projectId: string) { authorizeCount++; if (!authorized || projectId !== scope.projectId) throw new TeamError("not_found", "Project not found"); return current; },
    acquireCheckEvidence(current: ProjectContext, runIds: string[], definitionBytes: number) {
      store.projectScope(current, current.projectId); acquireCount++;
      const selected = runIds.map(runId => captures.find(item => item.run.id === runId));
      if (selected.some(item => !item)) throw new TeamError("not_found", "Run not found");
      const rows = selected.filter((item): item is ReturnType<typeof capture> => !!item);
      const bytes = rows.reduce((sum, item) => sum + Object.values(item.run).reduce<number>((n, value) => n + (typeof value === "string" ? Buffer.byteLength(value) : 0), 0) + item.spans.reduce((total, span) => total + Object.values(span).reduce<number>((n, value) => n + (typeof value === "string" ? Buffer.byteLength(value) : 0), 0), 0), definitionBytes);
      if (bytes > L.CHECK_ACQUISITION_BYTES || rows.reduce((sum, row) => sum + row.spans.length, 0) > L.CHECK_ACQUISITION_SPANS) throw new TeamError("too_large", "Check acquisition exceeds limits");
      const evidence = { author: { id: current.user.id, email: current.user.email }, acquiredAt: Date.now(), runs: structuredClone(rows) };
      afterAcquire(); return evidence;
    },
    persistCheck(current: ProjectContext, check: Check, report: CheckReport) { store.projectScope(current, current.projectId); saved.push(structuredClone(check)); reports.push(structuredClone(report)); return structuredClone(check); },
    listChecks() { return { items: reports.map(report => report.check), hasMore: false, nextCursor: null }; },
    getCheck(_current: ProjectContext, checkId: string) { return saved.find(item => item.id === checkId)!; },
    getCheckReport(_current: ProjectContext, checkId: string) { return reports.find(item => item.check.id === checkId)!; },
  };
  return { captures, saved, reports, service: new TeamCheckService(store), revoke: () => { authorized = false; }, acquired: () => acquireCount, authorized: () => authorizeCount, afterAcquire: (work: () => void) => { afterAcquire = work; } };
}

describe("shared deterministic check orchestration", () => {
  test("freezes every candidate with explicit input gating and a distinct allowlisted report", async () => {
    const f = fixture(); const result = await f.service.create(scope, draft([id(2), id(3), id(4)]));
    expect(result.counts).toEqual({ total: 3, pass: 1, fail: 1, inconclusive: 1 }); expect(result.status).toBe("fail");
    expect(result.results.map(item => item.inputMatch)).toEqual(["match", "match", "mismatch"]);
    expect(result.results[2].ruleResults[0].status).toBe("inconclusive");
    expect(result.author).toEqual({ id: "user-a", email: "editor@example.test" }); expect(result.calculationDurationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.calculationDurationMs)).toBe(true); expect(result.definitionDigest).toMatch(/^[a-f0-9]{64}$/);
    const before = JSON.stringify(result); f.captures[1].spans[0].output_payload = "Changed"; f.captures.length = 0;
    expect(JSON.stringify(f.service.get(scope, result.id))).toBe(before);
    const report = f.service.report(scope, result.id); expect(report.format).toBe("runphantom-team-check/v1");
    const encoded = JSON.stringify(report); expect(encoded).not.toContain("Question"); expect(encoded).not.toContain("Answer"); expect(encoded).not.toContain("referenceSnapshot"); expect(encoded).not.toContain('"expected"'); expect(encoded).not.toContain('"actual"');
    expect(f.authorized()).toBeGreaterThanOrEqual(5);
  });
  test("CRLF equivalence, missing reference and unknown tool arguments keep existing semantics", async () => {
    const f = fixture(); f.captures[0].spans[0].input_payload = "Question\r\n"; f.captures[1].spans[0].input_payload = "Question\n";
    expect((await f.service.create(scope, draft())).status).toBe("pass");
    f.captures[0].spans[0].input_payload = null;
    expect((await f.service.create(scope, draft())).results[0].inputMatch).toBe("unavailable");
    f.captures[0].spans[0].input_payload = "Question\n";
    f.captures[1].spans.push({ ...f.captures[1].spans[0], id: "1111111111111111", parent_span_id: f.captures[1].spans[0].id, name: "charge", span_type: "TOOL_CALL", input_payload: null });
    const check = await f.service.create(scope, { ...draft(), rules: [{ kind: "toolArgument", name: "charge", path: "customer", equals: "correct", match: "all" }] });
    expect(check.results[0].ruleResults[0]).toMatchObject({ status: "inconclusive", source: "code", evaluatorVersion: "toolargs:1" });
  });
  test("rejects rubrics, spoofed fields, unsafe definitions and absent references before any save", async () => {
    for (const value of [{ ...draft(), projectId: "project-b" }, { ...draft(), candidateRunIds: [id(2), id(2)] }, { ...draft(), rules: [{ kind: "rubric", provider: "openai", model: "test", rubric: "judge", threshold: .5 }] }, { ...draft(), name: "rp_team_ingest_abcdefghijklmnopqrstuvwxyz123456" }, { ...draft(), rules: [{ kind: "jsonPath", path: "n", equals: Infinity }] }]) expect(() => parseCheckCreate(value)).toThrow();
    const f = fixture(); expect(await rejection(f.service.create(scope, draft([id(9)])))).toMatchObject({ code: "not_found" }); expect(f.saved).toHaveLength(0);
  });
  test("cancellation and authorization changes at either yield never persist a partial result", async () => {
    for (const boundary of ["initial", "beforeAcquire", "beforePersist", "revocation", "close"]) {
      const f = fixture(), controller = new AbortController();
      if (boundary === "initial") controller.abort();
      if (boundary === "beforePersist") f.afterAcquire(() => queueMicrotask(() => controller.abort()));
      if (boundary === "revocation") f.afterAcquire(() => queueMicrotask(f.revoke));
      const pending = f.service.create(scope, draft(), controller.signal);
      if (boundary === "beforeAcquire") controller.abort(); if (boundary === "close") f.service.close();
      expect(await rejection(pending)).toBeInstanceOf(TeamError); expect(f.saved).toHaveLength(0);
      if (["initial", "beforeAcquire", "close"].includes(boundary)) expect(f.acquired()).toBe(0);
    }
  });
  test("two slots reject immediately and recover, with bounded per-user and global creation rates", async () => {
    const f = fixture(); const first = f.service.create(scope, draft()), second = f.service.create(scope, draft());
    expect(await rejection(f.service.create(scope, draft()))).toMatchObject({ code: "rate_limited", status: 429 });
    await Promise.all([first, second]);
    for (let n = 2; n < 10; n++) await f.service.create(scope, draft());
    expect(await rejection(f.service.create(scope, draft()))).toMatchObject({ code: "rate_limited" });
    for (let n = 0; n < 20; n++) await f.service.create({ ...scope, user: { ...scope.user, id: `user-${n}` } }, draft());
    expect(await rejection(f.service.create({ ...scope, user: { ...scope.user, id: "last-user" } }, draft()))).toMatchObject({ code: "rate_limited" });
  });
  test("aggregate evidence excess rejects atomically and report reasons are UTF-8 bounded", async () => {
    const f = fixture(); f.captures[1].spans[0].input_payload = "界".repeat(L.CHECK_ACQUISITION_BYTES / 3);
    expect(await rejection(f.service.create(scope, draft()))).toMatchObject({ code: "too_large" }); expect(f.saved).toHaveLength(0);
    const clean = fixture(); const check = await clean.service.create(scope, draft());
    check.results[0].ruleResults[0].reason = "界".repeat(512); const report = createCheckReport(check);
    expect(Buffer.byteLength(report.results[0].rules[0].reason)).toBeLessThanOrEqual(512); expect(report.results[0].rules[0].truncated).toBe(true);
  });
});
