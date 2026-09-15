import type { Comparison, Experiment, Status } from "./protocol";
import { EVALUATION_LIMITS as L } from "./protocol";
import { EvaluationError } from "./validation";
import { redactText } from "../verification/serialization";

export const REPORT_FORMAT = "runphantom-evaluation-report/v1" as const;
export const MAX_REPORT_BYTES = 1024 * 1024;

export interface EvaluationReport {
  format: typeof REPORT_FORMAT;
  experiment: { id: string; name: string; status: Experiment["status"]; evaluationVersion: number; snapshotVersion: number; createdAt: number; completedAt: number | null };
  dataset: { id: string; name: string; version: number; hash: string };
  summary: { total: number; pass: number; fail: number; inconclusive: number; passRate: number };
  gate: { pass: boolean; reasons: string[] };
  cases: Array<{ id: string; name: string; runId: string; status: Status; checks: Array<{
    status: Status; source: "code" | "llm"; evaluatorVersion: string; reason: string;
  }> }>;
  comparison: { baselineId: string; candidateId: string; summary: Comparison["summary"] } | null;
}

function label(value: string, max: number = L.MAX_NAME): string {
  return redactText(value).slice(0, max);
}

/** Project frozen results; raw inputs, outputs, expectations and model explanations stay out of CI artifacts. */
export function createEvaluationReport(experiment: Experiment, comparison?: Comparison): EvaluationReport {
  if (experiment.results.length > L.MAX_CASES || experiment.results.some(result => result.checks.length > L.MAX_RULES)) {
    throw new EvaluationError("Experiment exceeds report limits", 413);
  }
  if (comparison && (comparison.candidateId !== experiment.id || comparison.datasetHash !== experiment.datasetHash)) {
    throw new EvaluationError("Report comparison does not match this experiment", 409);
  }
  const cases: EvaluationReport["cases"] = experiment.results.map(result => {
    const checks = result.checks.map(check => ({
      status: check.status,
      source: check.source,
      evaluatorVersion: label(check.evaluatorVersion, 64),
      reason: check.source === "llm"
        ? "Advisory model judgment; inspect its explanation in the local workspace."
        : label(check.reason, L.MAX_REASON),
    }));
    // A missing check must not disappear behind a persisted aggregate verdict.
    const complete = result.inputMatch === "match" && result.snapshot.complete && checks.length > 0 && checks.length === result.case.rules.length;
    const status: Status = result.status === "fail" || checks.some(check => check.status === "fail") ? "fail"
      : complete && result.status === "pass" && checks.every(check => check.status === "pass") ? "pass" : "inconclusive";
    return { id: label(result.caseId), name: label(result.caseName), runId: label(result.runId), status, checks };
  });
  const summary = { total: cases.length, pass: 0, fail: 0, inconclusive: 0, passRate: 0 };
  for (const result of cases) summary[result.status]++;
  summary.passRate = summary.total ? summary.pass / summary.total : 0;
  const reasons: string[] = [];
  if (experiment.status !== "completed") reasons.push("Experiment has not completed.");
  if (!summary.total) reasons.push("Experiment has no evaluated cases.");
  if (summary.fail) reasons.push(`${summary.fail} case(s) failed.`);
  if (summary.inconclusive) reasons.push(`${summary.inconclusive} case(s) have inconclusive evidence.`);
  if (summary.total !== experiment.summary.total) reasons.push("Stored case count does not match the frozen results.");
  if (experiment.error) reasons.push("Experiment records an execution error; inspect it in the local workspace.");
  if (experiment.verdict !== "pass" && !summary.fail && !summary.inconclusive) reasons.push("Experiment does not have a passing machine verdict.");
  if (comparison?.summary.regressions) reasons.push(`${comparison.summary.regressions} regression(s) against the baseline.`);
  if (comparison?.summary.inconclusive) reasons.push("Baseline comparison contains inconclusive cases.");
  const report: EvaluationReport = {
    format: REPORT_FORMAT,
    experiment: { id: label(experiment.id), name: label(experiment.name), status: experiment.status,
      evaluationVersion: experiment.evaluationVersion, snapshotVersion: experiment.snapshotVersion,
      createdAt: experiment.createdAt, completedAt: experiment.completedAt },
    dataset: { id: label(experiment.datasetId), name: label(experiment.datasetName), version: experiment.datasetVersion, hash: label(experiment.datasetHash) },
    summary, gate: { pass: reasons.length === 0, reasons }, cases,
    comparison: comparison ? { baselineId: label(comparison.baselineId), candidateId: label(comparison.candidateId), summary: { ...comparison.summary } } : null,
  };
  if (Buffer.byteLength(JSON.stringify(report), "utf8") > MAX_REPORT_BYTES) throw new EvaluationError("Evaluation report exceeds 1 MiB", 413);
  return report;
}

function xml(value: string): string {
  // XML 1.0 excludes most C0 controls, lone surrogates, U+FFFE and U+FFFF.
  return Array.from(value, char => {
    const point = char.codePointAt(0)!;
    return point === 9 || point === 10 || point === 13 || point >= 0x20 && point <= 0xd7ff || point >= 0xe000 && point <= 0xfffd || point >= 0x10000 && point <= 0x10ffff ? char : "\uFFFD";
  }).join("").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function evaluationReportJUnit(report: EvaluationReport): string {
  const extraGate = !report.gate.pass && (!report.summary.fail && !report.summary.inconclusive || report.experiment.status !== "completed");
  const tests = report.summary.total + Number(extraGate);
  const errors = report.summary.inconclusive + Number(extraGate);
  const body = report.cases.map(result => {
    const details = result.checks.filter(check => check.status !== "pass").map(check => `${check.evaluatorVersion}: ${check.reason}`).join("\n");
    const problem = result.status === "pass" ? "" : result.status === "fail"
      ? `<failure message="Evaluation failed">${xml(details || "The frozen case failed.")}</failure>`
      : `<error message="Inconclusive evidence">${xml(details || "The frozen case lacks sufficient evidence.")}</error>`;
    return `    <testcase name="${xml(result.name)}" classname="${xml(report.dataset.name)}">${problem}</testcase>`;
  });
  if (extraGate) body.push(`    <testcase name="Experiment quality gate" classname="Run Phantom"><error message="Quality gate incomplete">${xml(report.gate.reasons.join("\n"))}</error></testcase>`);
  const attributes = `tests="${tests}" failures="${report.summary.fail}" errors="${errors}" skipped="0"`;
  const result = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites ${attributes}>`,
    `  <testsuite name="${xml(report.experiment.name)}" ${attributes}>`,
    "    <properties>",
    ...Object.entries({ experiment: report.experiment.id, dataset: report.dataset.id, revision: report.dataset.version,
      datasetHash: report.dataset.hash, evaluationVersion: report.experiment.evaluationVersion, snapshotVersion: report.experiment.snapshotVersion,
      gate: report.gate.pass ? "pass" : "fail", ...(report.comparison ? { baseline: report.comparison.baselineId } : {}) })
      .map(([key, value]) => `      <property name="${key}" value="${xml(String(value))}"/>`),
    "    </properties>", ...body, "  </testsuite>", "</testsuites>", "",
  ].join("\n");
  if (Buffer.byteLength(result, "utf8") > MAX_REPORT_BYTES) throw new EvaluationError("JUnit report exceeds 1 MiB", 413);
  return result;
}
