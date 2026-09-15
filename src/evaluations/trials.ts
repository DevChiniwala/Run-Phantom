import { EVALUATION_LIMITS as L, type Experiment, type Status } from "./protocol";
import { createEvaluationReport, MAX_REPORT_BYTES } from "./report";
import { EvaluationError, fields, object, parseId } from "./validation";

import { TRIAL_ANALYSIS_FORMAT, MAX_TRIALS, type TrialAnalysis, type TrialCounts } from "./trials-protocol";
export { MAX_TRIAL_ACQUISITION_BYTES } from "./trials-protocol";
export type { TrialAnalysis } from "./trials-protocol";

export function parseTrialSelection(body: unknown): string[] {
  const value = object(body); fields(value, ["experimentIds"]);
  if (!Array.isArray(value.experimentIds) || value.experimentIds.length < 2) throw new EvaluationError("Select at least two experiments");
  if (value.experimentIds.length > MAX_TRIALS) throw new EvaluationError("Select at most 20 experiments", 413);
  const ids = value.experimentIds.map(parseId);
  if (new Set(ids).size !== ids.length) throw new EvaluationError("Select each experiment only once");
  return ids;
}

function counts(statuses: Status[]): TrialCounts {
  const result = { total: statuses.length, pass: 0, fail: 0, inconclusive: 0, passRate: 0, resolvedCoverage: 0, unresolvedBounds: { lower: 0, upper: 1 } };
  for (const status of statuses) result[status]++;
  if (result.total) {
    result.passRate = result.pass / result.total;
    result.resolvedCoverage = (result.pass + result.fail) / result.total;
    result.unresolvedBounds = { lower: result.passRate, upper: (result.pass + result.inconclusive) / result.total };
  }
  return result;
}

/** The reader preflights storage and yields one frozen experiment at a time. */
export function analyzeTrials(ids: string[], read: (ids: string[], consume: (experiment: Experiment) => void) => void): TrialAnalysis {
  parseTrialSelection({ experimentIds: ids });
  let analysis: TrialAnalysis | undefined;
  let definition: string | undefined;
  const observed = new Set<string>();
  const caseRuns = new Map<string, Set<string>>();
  read(ids, experiment => {
    if (!ids.includes(experiment.id) || observed.has(experiment.id)) throw new EvaluationError("Experiment selection is inconsistent", 409);
    observed.add(experiment.id);
    if (experiment.status !== "completed" && experiment.status !== "cancelled") throw new EvaluationError("Repeated trials require terminal experiments", 409);
    const caseIds = experiment.results.map(result => result.caseId);
    if (!caseIds.length || caseIds.length > L.MAX_CASES || new Set(caseIds).size !== caseIds.length || experiment.summary.total !== caseIds.length ||
      experiment.results.some(result => result.case.id !== result.caseId || !result.case.rules.length || result.case.rules.length > L.MAX_RULES || result.checks.length !== result.case.rules.length)) {
      throw new EvaluationError("Experiment case definitions are inconsistent", 409);
    }
    const identity = JSON.stringify([experiment.datasetId, experiment.datasetVersion, experiment.datasetHash, experiment.evaluationVersion, experiment.snapshotVersion,
      experiment.results.map(result => [result.caseId, result.checks.map(check => check.evaluatorVersion)]).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0)]);
    if (definition !== undefined && definition !== identity) throw new EvaluationError("Repeated trials require identical dataset revisions, case membership and evaluator versions", 409);
    definition = identity;
    const report = createEvaluationReport(experiment);
    analysis ??= { format: TRIAL_ANALYSIS_FORMAT, dataset: report.dataset, evaluationVersion: experiment.evaluationVersion, snapshotVersion: experiment.snapshotVersion,
      trials: [], cases: report.cases.map(item => ({ caseId: item.id, name: item.name, evaluatorVersions: item.checks.map(check => check.evaluatorVersion), counts: counts([]), outcomes: [] })),
      summary: counts([]), gate: { pass: true, reasons: [] }, limitations: [
        "Only explicitly selected captured trials are included. Distinct captures do not establish independent sampling or identical agent configuration.",
        "Unresolved-outcome bounds reflect missing evidence; they are not a confidence interval.",
        "Model judgments, when present, remain advisory. This analysis does not rerun agents or evaluators.",
      ] };
    analysis.trials.push({ experimentId: report.experiment.id, name: report.experiment.name, status: experiment.status, createdAt: report.experiment.createdAt,
      completedAt: report.experiment.completedAt, gatePass: report.gate.pass, executionError: experiment.error !== null });
    if (!report.gate.pass) analysis.gate.pass = false;
    for (const item of report.cases) {
      const seen = caseRuns.get(item.id) ?? new Set<string>();
      if (seen.has(item.runId)) throw new EvaluationError("Repeated trials cannot reuse the same captured run for a case", 409);
      seen.add(item.runId); caseRuns.set(item.id, seen);
      analysis.cases.find(result => result.caseId === item.id)!.outcomes.push({ experimentId: report.experiment.id, runId: item.runId, status: item.status });
    }
  });
  if (!analysis || observed.size !== ids.length) throw new EvaluationError("Experiment not found", 404);
  // The manifest follows explicit selection order, independent of database ordering.
  analysis.trials.sort((a, b) => ids.indexOf(a.experimentId) - ids.indexOf(b.experimentId));
  for (const item of analysis.cases) {
    item.outcomes.sort((a, b) => ids.indexOf(a.experimentId) - ids.indexOf(b.experimentId));
    item.counts = counts(item.outcomes.map(outcome => outcome.status));
  }
  analysis.summary = counts(analysis.cases.flatMap(item => item.outcomes.map(outcome => outcome.status)));
  if (!analysis.gate.pass) analysis.gate.reasons.push("One or more selected experiments have a nonpassing, cancelled or incomplete evidence gate.");
  if (Buffer.byteLength(JSON.stringify(analysis), "utf8") > MAX_REPORT_BYTES) throw new EvaluationError("Repeated-trial report exceeds 1 MiB", 413);
  return analysis;
}
