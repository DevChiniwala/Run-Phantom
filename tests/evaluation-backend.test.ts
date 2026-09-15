import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import express from "express";
import { closeDb, clearAll, getDrizzleDb, deleteRun } from "../src/db";
import { createEvaluationService, type EvaluationService, type EvaluationServiceOptions } from "../src/evaluations/service";
import { createEvaluationRouter } from "../src/evaluations/router";
import { loadSnapshot } from "../src/evaluations/loader";
import * as store from "../src/evaluations/store";
import { EVALUATION_LIMITS as L, type Experiment, type Rule, type RuleResult } from "../src/evaluations/protocol";
import { evaluationsApi } from "../app/src/api/evaluations";

let directory: string, oldDb: string | undefined;
const services: EvaluationService[] = [];
const pause = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));
beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "rp-evaluations-")); oldDb = process.env.RUNPHANTOM_DB_PATH;
  closeDb(); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "evaluations.db"); getDrizzleDb();
});
beforeEach(() => clearAll());
afterEach(() => { for (const service of services.splice(0)) service.close(); });
afterAll(() => {
  closeDb(); if (oldDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = oldDb;
  rmSync(directory, { recursive: true, force: true });
});
function service(options?: EvaluationServiceOptions) { const instance = createEvaluationService(options); services.push(instance); return instance; }
function run(id = "candidate", input: string | null = "Question", output = "Answer") {
  const db = getDrizzleDb().$client;
  db.query("INSERT INTO runs(id,name,started_at,last_updated_at) VALUES(?,?,1,10)").run(id, id);
  db.query(`INSERT INTO spans(run_id,id,name,span_type,status,input_payload,output_payload,start_time_ms,end_time_ms,input_tokens,output_tokens,attributes)
    VALUES(?,?,'agent','AGENT_ROOT','OK',?,?,1,10,2,3,'{}')`).run(id, "root", input, output);
  return id;
}
const outputRule: Rule = { kind: "output", operation: "equals", value: "Answer" };
const rubric: Rule = { kind: "rubric", provider: "openai", model: "test-model", rubric: "Answer clearly", threshold: .8 };
function dataset(s: EvaluationService, rules: Rule[] = [outputRule], input: string | undefined = "Question") {
  const created = s.createDataset({ name: "Regression" });
  return s.updateDataset(created.datasetId, { expectedVersion: 1, cases: [{ name: "Question case", ...(input === undefined ? {} : { input }), rules }] });
}
function start(s: EvaluationService, revision: ReturnType<typeof dataset>, runId = "candidate", allowModelJudges?: boolean) {
  return s.start({ datasetId: revision.datasetId, name: "Candidate", assignments: revision.cases.map((item) => ({ caseId: item.id, runId })), ...(allowModelJudges === undefined ? {} : { allowModelJudges }) });
}
async function until<T>(read: () => T, ready: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 300; i++) { const value = read(); if (ready(value)) return value; await pause(); }
  throw new Error("Timed out waiting for evaluation state");
}
const terminal = (s: EvaluationService, id: string) => until(() => s.getExperiment(id), (item) => item.status === "completed" || item.status === "cancelled");
function deferredJudge() {
  let calls = 0, resolve!: (result: RuleResult) => void;
  const value = new Promise<RuleResult>((done) => { resolve = done; });
  const judge: NonNullable<EvaluationServiceOptions["judge"]> = async () => { calls++; return value; };
  const result: RuleResult = { status: "pass", source: "llm", evaluatorVersion: "rubric:1", score: 1,
    reason: "Judge passed", actual: 1, expected: .8, spanIds: [], redacted: false, truncated: false };
  return { judge, calls: () => calls, resolve: () => resolve(result) };
}

describe("evaluation workbench backend", () => {
  test("dataset OCC freezes source evidence and retains revision hashes after edits and source deletion", () => {
    const s = service(); run("source");
    const first = s.createDataset({ name: "Dataset" });
    const second = s.updateDataset(first.datasetId, { expectedVersion: 1, cases: [{ name: "Case", sourceRunId: "source", rules: [outputRule] }] });
    expect(second.cases[0]).toMatchObject({ input: "Question", sourceOutput: "Answer", sourceSnapshotVersion: 1 });
    expect(() => s.updateDataset(first.datasetId, { expectedVersion: 1, cases: [] })).toThrow("changed");
    deleteRun("source");
    const item = second.cases[0];
    const third = s.updateDataset(first.datasetId, { expectedVersion: 2, cases: [{ id: item.id, name: item.name, sourceRunId: "source", rules: item.rules }] });
    expect(third.cases).toEqual(second.cases); expect(third.hash).toBe(second.hash);
    expect(store.getRevision(first.datasetId, 1).cases).toEqual([]);
    expect(store.getRevision(first.datasetId, 2).hash).toBe(second.hash);
    expect(() => s.updateDataset(first.datasetId, { expectedVersion: 3, cases: [{ name: "New source", sourceRunId: "gone", rules: [outputRule] }] })).toThrow("Run not found");
  });
  test("portable import drops identity and withholds secret input and review text", async () => {
    const s = service(); run(); const revision = dataset(s);
    const portable = s.exportDataset(revision.datasetId);
    expect(portable.cases[0]).not.toHaveProperty("id"); expect(portable.cases[0]).not.toHaveProperty("sourceRunId");
    const imported = s.importDataset({ ...portable, cases: [{ ...portable.cases[0], id: "foreign", sourceRunId: "absent", input: '{"password":"private-value"}' }] });
    expect(imported.cases[0]).toMatchObject({ input: null, sourceRunId: null, sourceSnapshotVersion: null, sourceRedacted: true });
    expect(imported.cases[0].id).not.toBe("foreign");
    const done = await terminal(s, start(s, revision).id);
    s.addReview(done.id, { caseId: revision.cases[0].id, rating: "fail", note: '{"password":"private-review"}' });
    const rows = getDrizzleDb().$client.query("SELECT cases FROM evaluation_revisions UNION ALL SELECT note FROM evaluation_reviews").all();
    expect(JSON.stringify(rows)).not.toContain("private-value"); expect(JSON.stringify(rows)).not.toContain("private-review");
    expect(s.getExperiment(done.id).verdict).toBe("pass");
  });
  test("source expansion cannot save a revision whose portable export exceeds the import limit", () => {
    const s = service(); run("large-source", "q".repeat(16 * 1024));
    const initial = s.createDataset({ name: "Portable boundary" });
    const cases = Array.from({ length: 50 }, (_, index) => ({
      name: `Case ${index + 1}`, sourceRunId: "large-source",
      rules: Array.from({ length: 8 }, () => ({ kind: "output", operation: "equals", value: "a".repeat(4000) })),
    }));
    const draft = { expectedVersion: initial.version, cases };
    expect(Buffer.byteLength(JSON.stringify(draft))).toBeLessThan(L.MAX_REQUEST);
    expect(() => s.updateDataset(initial.datasetId, draft)).toThrow("portable export");
    expect(store.getRevision(initial.datasetId)).toEqual(initial);
    const saved = s.updateDataset(initial.datasetId, { ...draft, cases: cases.slice(0, 20) });
    const portable = s.exportDataset(saved.datasetId);
    expect(Buffer.byteLength(JSON.stringify(portable, null, 2))).toBeLessThanOrEqual(L.MAX_REQUEST);
    const imported = s.importDataset(JSON.parse(JSON.stringify(portable, null, 2)));
    expect(imported.cases).toHaveLength(saved.cases.length);
    expect(imported.cases[0]).toMatchObject({ input: saved.cases[0].input, rules: saved.cases[0].rules });
  });
  test("all placeholders persist before work, snapshots remain frozen, and code results/reviews survive reopen and source/dataset deletion", async () => {
    const s = service(); run(); const revision = dataset(s, [outputRule, { kind: "errors", max: 0 }]);
    const queued = start(s, revision);
    expect(queued.status).toBe("queued"); expect(queued.results[0].checks).toHaveLength(2);
    expect(queued.results[0].checks.every((check) => check.status === "inconclusive" && check.reason.includes("Pending"))).toBe(true);
    getDrizzleDb().$client.query("UPDATE spans SET output_payload='Changed' WHERE run_id='candidate'").run();
    const done = await terminal(s, queued.id);
    expect(done.verdict).toBe("pass"); expect(done.results[0].snapshot.output.value).toBe("Answer");
    expect(done.summary).toMatchObject({ total: 1, pass: 1, inconclusive: 0, passRate: 1 });
    const clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      const firstReview = s.addReview(done.id, { caseId: revision.cases[0].id, rating: "fail", note: "Needs better wording" });
      const secondReview = s.addReview(done.id, { caseId: revision.cases[0].id, rating: "pass" });
      expect(secondReview.createdAt).toBe(firstReview.createdAt + 1);
    } finally { clock.mockRestore(); }
    deleteRun("candidate"); store.deleteDataset(revision.datasetId); s.close(); closeDb(); getDrizzleDb();
    expect(store.getExperiment(done.id)).toEqual(done); expect(store.listReviews(done.id)).toHaveLength(2);
    expect(store.listReviews(done.id).map((review) => review.rating)).toEqual(["pass", "fail"]);
    expect(store.listExperiments()[0]).not.toHaveProperty("results");
  });
  test("exact input match normalizes CRLF only and skips model calls for mismatch or unavailable inputs", async () => {
    let calls = 0;
    const s = service({ judge: async () => { calls++; throw new Error("unexpected judge"); } });
    run("mismatch", "Question "); run("unknown", null); run("line", "First\r\nSecond");
    const revision = dataset(s, [rubric]);
    for (const [id, match] of [["mismatch", "mismatch"], ["unknown", "unavailable"]]) {
      const done = await terminal(s, start(s, revision, id, true).id);
      expect(done.results[0].inputMatch).toBe(match); expect(done.verdict).toBe("inconclusive");
    }
    expect(calls).toBe(0);
    const line = dataset(s, [outputRule], "First\nSecond");
    expect((await terminal(s, start(s, line, "line").id)).verdict).toBe("pass");
  });
  test("opt-in and exact membership fail before model work; two queued plus running jobs exhaust admission", async () => {
    const gate = deferredJudge(), s = service({ judge: gate.judge }); run(); const revision = dataset(s, [rubric]);
    expect(() => start(s, revision)).toThrow("allowModelJudges");
    expect(() => s.start({ datasetId: revision.datasetId, name: "Extra", assignments: [{ caseId: "unknown", runId: "candidate" }], allowModelJudges: true })).toThrow("every dataset case");
    const first = start(s, revision, "candidate", true), second = start(s, revision, "candidate", true);
    expect(() => start(s, revision, "candidate", true)).toThrow("Two experiments");
    expect(gate.calls()).toBe(0);
    await until(gate.calls, (n) => n === 2);
    s.cancel(first.id); s.cancel(second.id); gate.resolve();
  });
  test("same-text multimodal source and candidate inputs remain unavailable and never call a judge", async () => {
    let calls = 0; const s = service({ judge: async () => { calls++; throw new Error("unexpected model request"); } });
    const prompt = (image: string) => JSON.stringify([{ role: "user", content: [{ type: "text", text: "Describe this" }, { type: "image", image }] }]);
    run("cat", prompt("cat.png")); run("dog", prompt("dog.png"));
    const first = s.createDataset({ name: "Images" });
    const revision = s.updateDataset(first.datasetId, { expectedVersion: 1, cases: [{ name: "Describe", sourceRunId: "cat", rules: [rubric] }] });
    const done = await terminal(s, start(s, revision, "dog", true).id);
    expect(revision.cases[0].input).toBeNull(); expect(done.results[0].snapshot.input).toBeNull();
    expect(done.results[0].inputMatch).toBe("unavailable"); expect(done.verdict).toBe("inconclusive"); expect(calls).toBe(0);
  });
  test("cancel preserves completed failure and unfinished denominator, and ignores late judge success", async () => {
    const gate = deferredJudge(), s = service({ judge: gate.judge }); run();
    const revision = dataset(s, [{ kind: "output", operation: "equals", value: "Wrong" }, rubric]);
    const queued = start(s, revision, "candidate", true); await until(gate.calls, (n) => n === 1);
    const cancelled = s.cancel(queued.id);
    expect(cancelled.status).toBe("cancelled"); expect(cancelled.verdict).toBe("fail");
    expect(cancelled.results[0].checks.map((check) => check.status)).toEqual(["fail", "inconclusive"]);
    expect(cancelled.summary).toMatchObject({ total: 1, fail: 1, passRate: 0 });
    gate.resolve(); await pause(20); expect(s.getExperiment(queued.id)).toEqual(cancelled);
  });
  test("UI cancellation client reaches the daemon and preserves interrupted checks", async () => {
    const { createServer } = await import("../src/server");
    const { server } = await createServer(0);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const gate = deferredJudge(), s = service({ judge: gate.judge });
    run(); const revision = dataset(s, [outputRule, rubric]);
    const queued = start(s, revision, "candidate", true);
    const fetchRequest = globalThis.fetch;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((input, init) => fetchRequest(
      typeof input === "string" && input.startsWith("/") ? new URL(input, base) : input, init,
    ));
    try {
      await until(gate.calls, (calls) => calls === 1);
      const cancelled = await evaluationsApi.cancel(queued.id);
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.verdict).toBe("inconclusive");
      expect(cancelled.results[0].checks.map((check) => check.status)).toEqual(["pass", "inconclusive"]);
      expect(cancelled.results[0].checks[1].reason).toContain("Cancelled");
      expect(await evaluationsApi.experiment(queued.id)).toEqual(cancelled);
      gate.resolve(); await pause(20);
      expect(await evaluationsApi.experiment(queued.id)).toEqual(cancelled);
    } finally {
      fetchSpy.mockRestore(); gate.resolve(); s.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  test("restart recovery preserves completed checks and never resumes judges or allows old jobs to replace terminal data", async () => {
    const gate = deferredJudge(), old = service({ judge: gate.judge }); run();
    const revision = dataset(old, [outputRule, rubric]); const queued = start(old, revision, "candidate", true);
    await until(gate.calls, (n) => n === 1);
    const resumed = service({ judge: async () => { throw new Error("restart must not call judge"); } });
    const recovered = resumed.getExperiment(queued.id);
    expect(recovered.status).toBe("completed"); expect(recovered.results[0].checks.map((check) => check.status)).toEqual(["pass", "inconclusive"]);
    expect(recovered.error).toContain("restart"); gate.resolve(); await pause(20);
    expect(resumed.getExperiment(queued.id)).toEqual(recovered);
  });
  test("global clear and shutdown abort calls and prevent deleted experiment resurrection", async () => {
    const gate = deferredJudge(); let aborted = false;
    const s = service({ judge: async (...args) => { args[3]?.signal?.addEventListener("abort", () => { aborted = true; }); return gate.judge(...args); } });
    run(); const revision = dataset(s, [rubric]); const queued = start(s, revision, "candidate", true); await until(gate.calls, (n) => n === 1);
    s.reset(); clearAll(); expect(aborted).toBe(true); gate.resolve(); await pause(20);
    expect(store.listExperiments()).toEqual([]); expect(() => s.getExperiment(queued.id)).toThrow("not found");
    const secondGate = deferredJudge(), second = service({ judge: secondGate.judge }); run();
    const other = start(second, dataset(second, [rubric]), "candidate", true); await until(secondGate.calls, (n) => n === 1);
    second.close(); secondGate.resolve(); await pause(20); expect(store.getExperiment(other.id).status).toBe("cancelled");
  });
  test("comparison reports regressions and refuses revision/version mismatches while retaining unavailable deltas", async () => {
    const s = service(); run("good"); run("bad", "Question", "Wrong"); run("unknown", null); run("different", "Different question");
    getDrizzleDb().$client.query("UPDATE spans SET span_type='LLM_GENERATION',attributes=? WHERE run_id IN ('good','different')")
      .run(JSON.stringify({ "gen_ai.usage.cost_usd": .05 }));
    const revision = dataset(s), baseline = await terminal(s, start(s, revision, "good").id), candidate = await terminal(s, start(s, revision, "bad").id);
    const compared = s.compare(baseline.id, candidate.id);
    expect(compared.summary.regressions).toBe(1); expect(compared.cases[0].deltas.costUsd).toBeNull();
    const unknown = await terminal(s, start(s, revision, "unknown").id);
    expect(s.compare(candidate.id, unknown.id).cases[0].change).toBe("inconclusive");
    expect(s.compare(candidate.id, unknown.id).cases[0].deltas).toEqual({ totalTokens: null, durationMs: null, costUsd: null });
    const mismatch = await terminal(s, start(s, revision, "different").id);
    expect(mismatch.results[0].inputMatch).toBe("mismatch");
    expect(mismatch.results[0].snapshot.metrics).toMatchObject({ totalTokens: 5, durationMs: 9, costUsd: .05 });
    expect(baseline.results[0].snapshot.metrics).toMatchObject({ totalTokens: 5, durationMs: 9, costUsd: .05 });
    expect(s.compare(baseline.id, mismatch.id).cases[0].deltas).toEqual({ totalTokens: null, durationMs: null, costUsd: null });
    const next = s.updateDataset(revision.datasetId, { expectedVersion: 2, cases: [{ id: revision.cases[0].id, name: "Changed", input: "Question", rules: [outputRule] }] });
    const incompatible = await terminal(s, start(s, next, "good").id);
    expect(() => s.compare(baseline.id, incompatible.id)).toThrow("identical dataset");
    const tampered = structuredClone(candidate); tampered.results[0].checks[0].evaluatorVersion = "code:999";
    getDrizzleDb().$client.query("UPDATE evaluation_experiments SET data=? WHERE id=?").run(JSON.stringify(tampered), candidate.id);
    expect(() => s.compare(baseline.id, candidate.id)).toThrow("evaluator versions");
  });
  test("acquisition withholds whole oversized payloads and rejects excessive spans, aggregate bytes, and pathological exact IDs", () => {
    run("large", "Question", "x".repeat(L.MAX_PAYLOAD_BYTES + 1));
    const large = loadSnapshot("large"); expect(large.truncated).toBe(true); expect(large.output.value).toBeNull();
    expect(JSON.stringify(large)).not.toContain("x".repeat(100));
    run("ids"); getDrizzleDb().$client.query("UPDATE spans SET id=? WHERE run_id='ids'").run("x".repeat(50000));
    expect(() => loadSnapshot("ids")).toThrow("identity");
    run("many"); const db = getDrizzleDb().$client;
    db.transaction(() => { const query = db.query("INSERT INTO spans(run_id,id,name) VALUES('many',?,'span')"); for (let i = 0; i < L.MAX_SPANS; i++) query.run(`span-${i}`); })();
    expect(() => loadSnapshot("many")).toThrow("span limit");
    run("bytes"); db.transaction(() => {
      const query = db.query("INSERT INTO spans(run_id,id,name,input_payload) VALUES('bytes',?,'span',CAST(zeroblob(64000) AS TEXT))");
      for (let i = 0; i < 530; i++) query.run(`bytes-${i}`);
    })();
    expect(() => loadSnapshot("bytes")).toThrow("acquisition limit");
    expect(() => loadSnapshot("absent")).toThrow("Run not found");
    expect(() => loadSnapshot("large", "other-run-span")).toThrow("exact run");
  });
  test("frozen experiment size rejects before row insertion or judge calls", () => {
    let calls = 0; const s = service({ judge: async () => { calls++; throw new Error("unexpected"); } });
    run("large-case", "a".repeat(L.MAX_TEXT_BYTES), "b".repeat(L.MAX_TEXT_BYTES));
    const created = s.createDataset({ name: "Large cases" });
    const revision = s.updateDataset(created.datasetId, { expectedVersion: 1,
      cases: Array.from({ length: 50 }, (_, i) => ({ name: `Case ${i}`, sourceRunId: "large-case", rules: [rubric] })) });
    expect(() => start(s, revision, "large-case", true)).toThrow("Frozen dataset");
    expect(store.listExperiments()).toEqual([]); expect(calls).toBe(0);
  });
  test("dataset revision and count caps reject without overwriting history", () => {
    const s = service(); const first = s.createDataset({ name: "Bounded" });
    for (let version = 1; version < L.MAX_REVISIONS; version++) s.updateDataset(first.datasetId, { expectedVersion: version, cases: [] });
    expect(() => s.updateDataset(first.datasetId, { expectedVersion: L.MAX_REVISIONS, cases: [] })).toThrow("revision limit");
    for (let i = 1; i < L.MAX_DATASETS; i++) s.createDataset({ name: `Dataset ${i}` });
    expect(() => s.createDataset({ name: "Overflow" })).toThrow("Dataset limit");
    expect(store.getRevision(first.datasetId, 1).cases).toEqual([]);
  });
  test("terminal retention evicts oldest history with reviews, keeps active jobs, and caps append-only reviews", async () => {
    const s = service(); run(); const revision = dataset(s); const finished = await terminal(s, start(s, revision).id);
    for (let i = 0; i < L.MAX_REVIEWS + 1; i++) s.addReview(finished.id, { caseId: revision.cases[0].id, rating: "pass", note: String(i) });
    expect(store.listReviews(finished.id)).toHaveLength(L.MAX_REVIEWS);
    const gate = deferredJudge(), runningService = service({ judge: gate.judge }), activeRevision = dataset(runningService, [rubric]);
    const active = start(runningService, activeRevision, "candidate", true);
    for (let i = 0; i < L.MAX_EXPERIMENTS; i++) {
      const item: Experiment = { ...structuredClone(finished), id: `retention-${i}`, status: "queued", createdAt: finished.createdAt + i + 1 };
      store.insertExperiment(item, `token-${i}`); item.status = "completed"; store.updateExperiment(item, `token-${i}`, 1);
    }
    expect(() => store.getExperiment(finished.id)).toThrow("not found"); expect(store.getExperiment(active.id).status).toBe("queued");
    expect(getDrizzleDb().$client.query("SELECT COUNT(*) AS n FROM evaluation_experiments").get()).toEqual({ n: L.MAX_EXPERIMENTS });
    expect(getDrizzleDb().$client.query("SELECT COUNT(*) AS n FROM evaluation_reviews").get()).toEqual({ n: 0 });
    expect(store.listExperiments()).toHaveLength(50); runningService.cancel(active.id); gate.resolve();
  });
  test("real REST routes preserve status contracts, version validation, body cap, and lightweight experiment lists", async () => {
    const s = service(), app = express();
    app.use(express.json({ limit: L.MAX_REQUEST })); app.use("/api/evaluations", createEvaluationRouter(s));
    app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ error: "request failed" }));
    const server = http.createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/evaluations`;
    const request = async (route: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
      const response = await fetch(base + route, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: response.status === 204 ? null : await response.json() as any };
    };
    try {
      run(); const created = await request("/datasets", { name: "REST" }); expect(created.status).toBe(201);
      const secret = "sk-proj-" + "a".repeat(50);
      getDrizzleDb().$client.query("UPDATE spans SET name=? WHERE run_id='candidate'").run("Response " + secret);
      const choices = await request("/runs/candidate/response-spans");
      expect(choices.status).toBe(200); expect(choices.body.truncated).toBe(true);
      expect(JSON.stringify(choices.body)).not.toContain(secret); expect(choices.body.spans[0].id).toBe("root");
      getDrizzleDb().$client.query("UPDATE spans SET name=? WHERE run_id='candidate'").run("z".repeat(50000));
      const oversizedNames = await request("/runs/candidate/response-spans");
      expect(oversizedNames.body.truncated).toBe(true); expect(oversizedNames.body.spans[0].name).toBe("[UNAVAILABLE]");
      getDrizzleDb().$client.query("UPDATE spans SET id=? WHERE run_id='candidate'").run("q".repeat(10000));
      expect((await request("/runs/candidate/response-spans")).status).toBe(413);
      getDrizzleDb().$client.query("UPDATE spans SET id=?,name='agent' WHERE run_id='candidate'").run(secret);
      const badIdentity = await request("/runs/candidate/response-spans"); expect(badIdentity.status).toBe(400);
      expect(JSON.stringify(badIdentity.body)).not.toContain(secret);
      getDrizzleDb().$client.query("UPDATE spans SET id='root' WHERE run_id='candidate'").run();
      const badKey = await request("/datasets", { [secret]: "invalid" }); expect(badKey.status).toBe(400);
      expect(JSON.stringify(badKey.body)).not.toContain(secret);
      const id = created.body.datasetId;
      const updated = await request(`/datasets/${id}`, { expectedVersion: 1, cases: [{ name: "Case", input: "Question", rules: [outputRule] }] }, "PUT"); expect(updated.status).toBe(201);
      expect((await request(`/datasets/${id}?version=invalid`)).status).toBe(400);
      expect((await request(`/datasets/${id}?version=1`)).body.cases).toEqual([]);
      expect((await request("/datasets/import", (await request(`/datasets/${id}/export`)).body)).status).toBe(201);
      const job = await request("/experiments", { datasetId: id, name: "REST job", assignments: [{ caseId: updated.body.cases[0].id, runId: "candidate" }] }); expect(job.status).toBe(202);
      await terminal(s, job.body.id); expect((await request("/experiments")).body[0]).not.toHaveProperty("results");
      expect((await request(`/experiments/${job.body.id}/reviews`, { caseId: "not-member", rating: "pass" })).status).toBe(400);
      expect((await request("/datasets", { name: "x".repeat(L.MAX_REQUEST) })).status).toBe(413);
      expect((await request(`/datasets/${id}`, undefined, "DELETE")).status).toBe(204);
      expect((await request(`/datasets/${id}`)).status).toBe(404);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  test("daemon rejects numeric expectations that would change during JSON parsing", async () => {
    const { createServer } = await import("../src/server");
    const { server } = await createServer(0);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/evaluations`;
    try {
      const created = await fetch(`${base}/datasets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"name":"Numeric evidence"}' });
      expect(created.status).toBe(201);
      const { datasetId } = await created.json() as { datasetId: string };
      const malformed = await fetch(`${base}/datasets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"name":"' + '\\"'.repeat(65_536) });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({ error: "invalid JSON body" });
      const body = (token: string, version = 1) => `{"expectedVersion":${version},"cases":[{"name":"Amount","input":"Question","rules":[{"kind":"toolArgument","name":"refund","path":"amount","match":"all","equals":${token}}]}]}`;
      for (const encoding of ["utf8", "utf16le"] as const) {
        for (const token of ["1e400", "1e-400", "9007199254740993", "0.1234567890123456789"]) {
          const response = await fetch(`${base}/datasets/${datasetId}`, { method: "PUT", headers: { "Content-Type": `application/json; charset=${encoding === "utf8" ? "utf-8" : "utf-16le"}` }, body: Buffer.from(body(token), encoding) });
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({ error: "JSON numbers must be representable without rounding, underflow or overflow." });
        }
      }
      let version = 1;
      for (const token of ["0.1", "1.00", "1e3", '"1e400"']) {
        const response = await fetch(`${base}/datasets/${datasetId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: body(token, version++) });
        expect(response.status).toBe(201);
        const revision = await response.json() as { version: number; cases: Array<{ rules: Array<{ equals: unknown }> }> };
        expect(revision.version).toBe(version);
        expect(revision.cases[0].rules[0].equals).toEqual(JSON.parse(token));
      }
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  test("daemon rejects non-JSON control bodies before the general 50MiB protobuf parser", async () => {
    const { createServer } = await import("../src/server");
    const { server } = await createServer(0);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      for (const namespace of ["evaluations/datasets", "verification/sessions"]) for (const type of ["application/x-protobuf", "text/plain", "application/octet-stream"]) {
        const response = await fetch(`${base}/api/${namespace}`, { method: "POST", headers: { "Content-Type": type }, body: "x".repeat(L.MAX_REQUEST + 100) });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "This API accepts JSON request bodies only" });
      }
      expect((await fetch(`${base}/api/evaluations/datasets`, { headers: { "Content-Type": "application/x-protobuf" } })).status).toBe(200);
      const cancelled = await fetch(`${base}/api/evaluations/experiments/absent/cancel`, { method: "POST" });
      expect(cancelled.status).toBe(404);
      const json = await fetch(`${base}/api/evaluations/datasets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x".repeat(L.MAX_REQUEST) }) });
      expect(json.status).toBe(413);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
