import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, getDrizzleDb } from "../src/db";
import { snapshotRun } from "../src/evaluations/snapshot";
import { analyzeTrials, parseTrialSelection, MAX_TRIAL_ACQUISITION_BYTES } from "../src/evaluations/trials";
import { insertExperiment, readExperimentSelection } from "../src/evaluations/store";
import { evaluateRule } from "../src/evaluations/rules";
import type { DatasetCase, Experiment, Status } from "../src/evaluations/protocol";

function experiment(id: string, outcomes: Status[] = ["pass"]): Experiment {
  const results = outcomes.map((status, index) => {
    const runId = `${id}-run-${index}`;
    const snapshot = snapshotRun({ id: runId, name: "Private input label" }, [{ id: "root", run_id: runId, name: "agent", span_type: "AGENT_ROOT", status: "OK", input_payload: "private input", output_payload: "private output", attributes: "{}", start_time_ms: 1, end_time_ms: 2 }]);
    const item: DatasetCase = { id: `case-${index}`, name: `Case ${index}`, input: "private input", sourceRunId: null, sourceSpanId: null, sourceOutput: null, tags: [], rules: [{ kind: "output", operation: "equals", value: "private output" }], sourceCapturedAt: null, sourceRedacted: false, sourceTruncated: false, sourceSnapshotVersion: null };
    const check = evaluateRule(item.rules[0], snapshot); check.status = status;
    return { caseId: item.id, caseName: item.name, runId, inputMatch: "match" as const, status, checks: [check], snapshot, case: item };
  });
  return { id, name: id, evaluationVersion: 1, snapshotVersion: 1, datasetId: "dataset", datasetName: "Dataset", datasetVersion: 2, datasetHash: "hash", status: "completed", verdict: outcomes.includes("fail") ? "fail" : outcomes.includes("inconclusive") ? "inconclusive" : "pass", createdAt: 1, completedAt: 2, results,
    summary: { total: outcomes.length, pass: 0, fail: 0, inconclusive: 0, passRate: 0 }, error: null };
}
function analyze(values: Experiment[]) { return analyzeTrials(values.map(item => item.id), (_ids, consume) => values.forEach(consume)); }

describe("repeated trial evidence", () => {
  test("keeps every selected outcome and independently reconciles denominators and missing-evidence bounds", () => {
    const result = analyze([experiment("a", ["pass", "pass"]), experiment("b", ["fail", "pass"]), experiment("c", ["inconclusive", "fail"])]);
    expect(result.cases[0].counts).toEqual({ total: 3, pass: 1, fail: 1, inconclusive: 1, passRate: 1 / 3, resolvedCoverage: 2 / 3, unresolvedBounds: { lower: 1 / 3, upper: 2 / 3 } });
    expect(result.cases[1].counts).toEqual({ total: 3, pass: 2, fail: 1, inconclusive: 0, passRate: 2 / 3, resolvedCoverage: 1, unresolvedBounds: { lower: 2 / 3, upper: 2 / 3 } });
    expect(result.summary).toEqual({ total: 6, pass: 3, fail: 2, inconclusive: 1, passRate: .5, resolvedCoverage: 5 / 6, unresolvedBounds: { lower: .5, upper: 2 / 3 } });
    expect(result.gate.pass).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private input"); expect(JSON.stringify(result)).not.toContain("private output");
  });
  test("small exhaustive outcomes bound every completion of unknown evidence", () => {
    const states: Status[] = ["pass", "fail", "inconclusive"];
    for (const a of states) for (const b of states) for (const c of states) {
      const statuses = [a, b, c]; const result = analyze(statuses.map((status, index) => experiment(String(index), [status])));
      const unknown = statuses.filter(status => status === "inconclusive").length;
      const completions = Array.from({ length: 2 ** unknown }, (_, mask) => {
        let index = 0; return statuses.filter(status => status === "pass" || status === "inconclusive" && Boolean(mask & (1 << index++))).length / 3;
      });
      expect(result.summary.unresolvedBounds).toEqual({ lower: Math.min(...completions), upper: Math.max(...completions) });
      expect(result.gate.pass).toBe(statuses.every(status => status === "pass"));
    }
  });
  test("cancellation and execution errors keep preserved passes but deny the trial gate", () => {
    for (const field of ["cancelled", "error"]) {
      const value = experiment("b"); if (field === "cancelled") value.status = "cancelled"; else value.error = "execution interrupted";
      const result = analyze([experiment("a"), value]); expect(result.summary.passRate).toBe(1); expect(result.gate.pass).toBe(false);
    }
    const missing = experiment("missing"); missing.results[0].inputMatch = "unavailable";
    expect(analyze([experiment("a"), missing]).summary.inconclusive).toBe(1);
  });
  test("rejects duplicates, active/missing trials and incompatible frozen definitions", () => {
    expect(() => parseTrialSelection({ experimentIds: ["a", "a"] })).toThrow("only once");
    expect(() => parseTrialSelection({ experimentIds: ["a"] })).toThrow("at least two");
    expect(() => parseTrialSelection({ experimentIds: Array.from({ length: 21 }, (_, n) => String(n)) })).toThrow("at most 20");
    expect(() => parseTrialSelection({ experimentIds: ["a", "b"], latest: true })).toThrow("unsupported");
    const duplicate = experiment("b"); duplicate.results[0].runId = "a-run-0";
    expect(() => analyze([experiment("a"), duplicate])).toThrow("same captured run");
    for (const status of ["queued", "running"] as const) { const value = experiment("b"); value.status = status; expect(() => analyze([experiment("a"), value])).toThrow("terminal"); }
    for (const field of ["datasetId", "datasetVersion", "datasetHash", "evaluationVersion", "snapshotVersion"] as const) {
      const value = experiment("b"); (value as unknown as Record<string, unknown>)[field] = `${value[field]}-changed`;
      expect(() => analyze([experiment("a"), value])).toThrow("identical");
    }
    const evaluator = experiment("b"); evaluator.results[0].checks[0].evaluatorVersion = "code:1";
    expect(() => analyze([experiment("a"), evaluator])).toThrow("identical");
    expect(() => analyzeTrials(["a", "missing"], (_ids, consume) => consume(experiment("a")))).toThrow("not found");
  });
  test("case and trial order cannot change identity, and malformed membership cannot pass", () => {
    const a = experiment("a", ["pass", "fail"]), b = experiment("b", ["fail", "pass"]); b.results.reverse();
    const result = analyzeTrials(["a", "b"], (_ids, consume) => { consume(b); consume(a); });
    expect(result.trials.map(item => item.experimentId)).toEqual(["a", "b"]);
    expect(result.cases.find(item => item.caseId === "case-0")!.outcomes.map(item => item.status)).toEqual(["pass", "fail"]);
    b.results[0] = b.results[1]; expect(() => analyze([a, b])).toThrow("inconsistent");
  });
  test("Unicode collation equivalence cannot make reordered identical case sets incompatible", () => {
    const a = experiment("a", ["pass", "pass"]), b = experiment("b", ["pass", "pass"]);
    for (const value of [a, b]) for (const [index, caseId] of ["é", "e\u0301"].entries()) { value.results[index].caseId = caseId; value.results[index].case.id = caseId; }
    b.results.reverse(); expect(analyze([a, b]).summary.pass).toBe(4);
  });
  test("old numeric evaluator evidence remains frozen and incompatible with the corrected version", () => {
    const old = experiment("old"), current = experiment("current"); old.results[0].checks[0].evaluatorVersion = "code:1";
    const prior = JSON.stringify(old);
    expect(current.results[0].checks[0].evaluatorVersion).toBe("code:2");
    expect(() => analyze([old, current])).toThrow("evaluator versions"); expect(JSON.stringify(old)).toBe(prior);
  });
});

describe("repeated trial bounded frozen acquisition", () => {
  let directory: string, oldDb: string | undefined;
  beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), "rp-trials-")); oldDb = process.env.RUNPHANTOM_DB_PATH; closeDb(); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "test.db"); });
  afterEach(() => { closeDb(); if (oldDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = oldDb; rmSync(directory, { recursive: true, force: true }); });
  test("retained frozen rows are enough without any live dataset or run", () => {
    insertExperiment(experiment("a"), "a"); insertExperiment(experiment("b"), "b");
    expect(analyzeTrials(["a", "b"], readExperimentSelection).summary.pass).toBe(2);
    expect(() => analyzeTrials(["a", "gone"], readExperimentSelection)).toThrow("not found");
  });
  test("UTF-8 aggregate storage is rejected before JSON parsing or consumer access", () => {
    for (const id of ["a", "b", "c"]) insertExperiment(experiment(id), id);
    const text = JSON.stringify({ payload: "界".repeat(Math.ceil(MAX_TRIAL_ACQUISITION_BYTES / 9)) });
    getDrizzleDb().$client.query("UPDATE evaluation_experiments SET data=?").run(text);
    const parse = spyOn(JSON, "parse"); let consumed = 0;
    try { expect(() => readExperimentSelection(["a", "b", "c"], () => { consumed++; })).toThrow("8 MiB"); expect(consumed).toBe(0); expect(parse).not.toHaveBeenCalled(); }
    finally { parse.mockRestore(); }
  });
});
