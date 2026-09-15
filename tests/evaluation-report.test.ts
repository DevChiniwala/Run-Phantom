import { describe, expect, test } from "bun:test";
import { createEvaluationReport, evaluationReportJUnit } from "../src/evaluations/report";
import { snapshotRun } from "../src/evaluations/snapshot";
import type { Experiment, RuleResult, Status } from "../src/evaluations/protocol";

function experiment(status: Status = "pass"): Experiment {
  const snapshot = snapshotRun({ id: "run" }, [{
    id: "root", run_id: "run", name: "root", span_type: "AGENT_ROOT", status: "OK",
    input_payload: "private captured prompt", output_payload: "private captured answer", attributes: "{}",
    start_time_ms: 1, end_time_ms: 100,
  }]);
  const check: RuleResult = { status, source: "code", evaluatorVersion: "code:1", reason: "Compared the captured response",
    actual: "private captured answer", expected: "private reference answer", score: status === "pass" ? 1 : 0,
    spanIds: ["root"], redacted: false, truncated: false };
  return { evaluationVersion: 1, snapshotVersion: 1, id: "experiment", name: 'Checkout <&"\u0001', datasetId: "dataset", datasetName: "Checkout",
    datasetVersion: 2, datasetHash: "hash", status: "completed", verdict: status, createdAt: 100, completedAt: 200,
    error: null, summary: { total: 1, pass: Number(status === "pass"), fail: Number(status === "fail"), inconclusive: Number(status === "inconclusive"), passRate: Number(status === "pass") },
    results: [{ caseId: "case", caseName: "Saved order", runId: "run", inputMatch: "match", status, checks: [check], snapshot,
      case: { id: "case", name: "Saved order", input: "private captured prompt", sourceRunId: "run", sourceSpanId: "root", sourceOutput: "private reference answer",
        tags: [], rules: [{ kind: "output", operation: "equals", value: "private reference answer" }], sourceCapturedAt: 100, sourceSnapshotVersion: 1, sourceRedacted: false, sourceTruncated: false } }],
  };
}

describe("portable evaluation reports", () => {
  test("projects complete counts and machine verdicts without prompts, outputs, expectations or model explanations", () => {
    const source = experiment();
    source.results[0].checks[0].source = "llm";
    source.results[0].checks[0].reason = "A private narrative quoting the whole captured response";
    const report = createEvaluationReport(source);
    const body = JSON.stringify(report);
    expect(report.gate).toEqual({ pass: true, reasons: [] });
    expect(report.summary).toEqual(source.summary);
    for (const text of ["private captured", "private reference", "private narrative", "actual", "expected"]) expect(body.toLowerCase()).not.toContain(text);
    expect(report.cases[0]).not.toHaveProperty("snapshot");
    expect(report.cases[0].checks[0].reason).toContain("Advisory model judgment");
    expect(source.results[0].checks[0].reason).toStartWith("A private narrative");
  });
  test("redacts credentials in labels and code reasons and makes valid XML with exact failure/error counts", () => {
    const source = experiment("fail");
    source.datasetName = "password=secret-dataset";
    source.results[0].checks[0].reason = 'token=secret-value <rejected> "detail"\u0000\ud800';
    const report = createEvaluationReport(source);
    const xml = evaluationReportJUnit(report);
    expect(xml).toContain('tests="1" failures="1" errors="0" skipped="0"');
    expect(xml).toContain("Checkout &lt;&amp;&quot;\uFFFD");
    expect(xml).toContain("&lt;rejected&gt;");
    expect(xml).not.toContain("secret-dataset");
    expect(xml).not.toContain("secret-value");
    expect(xml).not.toContain("\u0000");
    expect(Array.from(xml).some(char => char.codePointAt(0)! >= 0xd800 && char.codePointAt(0)! <= 0xdfff)).toBe(false);
    expect(xml).not.toContain("private captured answer");
  });
  test("inconclusive, cancelled, running, queued and empty experiments cannot pass", () => {
    const unknown = createEvaluationReport(experiment("inconclusive"));
    expect(unknown.gate.pass).toBe(false);
    expect(evaluationReportJUnit(unknown)).toContain('tests="1" failures="0" errors="1"');
    for (const status of ["queued", "running", "cancelled"] as const) {
      const source = experiment(); source.status = status;
      const report = createEvaluationReport(source);
      expect(report.gate.pass).toBe(false);
      expect(evaluationReportJUnit(report)).toContain('tests="2" failures="0" errors="1"');
    }
    const empty = experiment(); empty.results = []; empty.summary.total = 0;
    const report = createEvaluationReport(empty);
    expect(report.gate.pass).toBe(false);
    expect(evaluationReportJUnit(report)).toContain('tests="1" failures="0" errors="1"');
  });
  test("missing checks, mismatched case counts, execution errors and input mismatch cannot be hidden by a passing summary", () => {
    for (const change of [
      (source: Experiment) => { source.results[0].checks = []; },
      (source: Experiment) => { source.summary.total = 2; },
      (source: Experiment) => { source.error = "private execution error"; },
      (source: Experiment) => { source.results[0].inputMatch = "mismatch"; },
      (source: Experiment) => { source.results[0].snapshot.complete = false; },
    ]) {
      const source = experiment(); change(source);
      const report = createEvaluationReport(source);
      expect(report.gate.pass).toBe(false);
      expect(JSON.stringify(report)).not.toContain("private execution error");
    }
  });
  test("baseline uncertainty blocks success and incompatible report identity is rejected", () => {
    const comparison = { baselineId: "baseline", candidateId: "experiment", datasetHash: "hash", summary: { regressions: 0, improvements: 0, unchanged: 0, inconclusive: 1 }, cases: [] };
    const report = createEvaluationReport(experiment(), comparison);
    expect(report.gate.pass).toBe(false);
    expect(evaluationReportJUnit(report)).toContain("Experiment quality gate");
    expect(() => createEvaluationReport(experiment(), { ...comparison, datasetHash: "different" })).toThrow("does not match");
    expect(() => createEvaluationReport(experiment(), { ...comparison, candidateId: "different" })).toThrow("does not match");
  });
});
