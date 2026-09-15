import { randomUUID } from "node:crypto";
import { EVALUATION_VERSION, SNAPSHOT_VERSION, EVALUATION_LIMITS as L, type Rule, type RuleResult, type Status, type DatasetCase, type DatasetCaseDraft, type DatasetExport, type Experiment, type Comparison } from "./protocol";
import { parseDatasetCreate, parseDatasetUpdate, parseDatasetExport, parseExperimentDraft, parseReviewDraft, parseId, EvaluationError } from "./validation";
import { sanitizeInput, sanitizeSnapshotText } from "./snapshot";
import { evaluateRule, boundRuleResult, CODE_EVALUATOR_VERSION, TOOL_ARGUMENT_EVALUATOR_VERSION } from "./rules";
import { evaluateRubric } from "./judge";
import { loadSnapshot } from "./loader";
import * as store from "./store";

const safeText = (text: string) => sanitizeSnapshotText(text).value ?? "[UNAVAILABLE]";
const fold = (statuses: Status[]): Status => statuses.includes("fail") ? "fail" : !statuses.length || statuses.includes("inconclusive") ? "inconclusive" : "pass";
function portableDataset(name: string, cases: DatasetCase[]): DatasetExport {
  const portable: DatasetExport = { format: "runphantom-evaluations/v1", name,
    cases: cases.map(({ name, input, tags, rules }) => ({ name, ...(input === null ? {} : { input }), tags, rules })) };
  // Match the UI download format so every accepted revision fits the same import boundary.
  if (Buffer.byteLength(JSON.stringify(portable, null, 2)) > L.MAX_REQUEST) {
    throw new EvaluationError("Dataset portable export exceeds the import size limit; use fewer or smaller cases", 413);
  }
  return portable;
}
function pending(rule: Rule, reason = "Pending evaluation"): RuleResult {
  return boundRuleResult({ status: "inconclusive", source: rule.kind === "rubric" ? "llm" : "code",
    evaluatorVersion: rule.kind === "rubric" ? "rubric:1" : rule.kind === "toolArgument" ? TOOL_ARGUMENT_EVALUATOR_VERSION : CODE_EVALUATOR_VERSION, score: null, reason,
    actual: null, expected: rule, spanIds: [], redacted: false, truncated: false });
}
function aggregate(experiment: Experiment): void {
  for (const result of experiment.results) result.status = fold(result.checks.map((check) => check.status));
  const counts = { total: experiment.results.length, pass: 0, fail: 0, inconclusive: 0, passRate: 0 };
  for (const result of experiment.results) counts[result.status]++;
  counts.passRate = counts.total ? counts.pass / counts.total : 0;
  experiment.summary = counts;
  experiment.verdict = experiment.status === "queued" || experiment.status === "running" ? null : fold(experiment.results.map((result) => result.status));
}
function finishUnstarted(experiment: Experiment, completedChecks: number, reason: string, cancelled: boolean): void {
  let index = 0;
  for (const result of experiment.results) result.checks = result.checks.map((check, position) =>
    index++ < completedChecks ? check : pending(result.case.rules[position], reason));
  experiment.status = cancelled ? "cancelled" : "completed";
  experiment.completedAt = Date.now(); experiment.error = reason; aggregate(experiment);
}
interface Job { token: string; generation: number; abort: AbortController; timer: ReturnType<typeof setTimeout> }
export interface EvaluationServiceOptions { judge?: typeof evaluateRubric }

export class EvaluationService {
  private jobs = new Map<string, Job>();
  private generation = 0;
  private closed = false;
  private judge: typeof evaluateRubric;
  constructor(options: EvaluationServiceOptions = {}) {
    this.judge = options.judge ?? evaluateRubric;
    // Recover persisted work without repeating a possibly paid provider request.
    for (const { id } of store.activeExperiments()) {
      const record = store.getExperimentRecord(id);
      finishUnstarted(record.experiment, record.completedChecks, "Interrupted by daemon restart", false);
      store.updateExperiment(record.experiment, record.token, record.completedChecks);
    }
  }
  createDataset(body: unknown) { return store.createDataset(safeText(parseDatasetCreate(body).name)); }
  private freezeCases(drafts: DatasetCaseDraft[], prior: DatasetCase[] = []): DatasetCase[] {
    return drafts.map((draft) => {
      const existing = prior.find((item) => item.id === draft.id);
      const sourceRunId = draft.sourceRunId ?? null, sourceSpanId = draft.sourceSpanId ?? null;
      let frozen: Pick<DatasetCase, "sourceOutput" | "sourceCapturedAt" | "sourceRedacted" | "sourceTruncated" | "sourceSnapshotVersion"> = {
        sourceOutput: null, sourceCapturedAt: null, sourceRedacted: false, sourceTruncated: false, sourceSnapshotVersion: null,
      };
      let input: string | null = null;
      if (sourceRunId) {
        // An unchanged reference keeps its immutable source evidence, even after source deletion.
        if (existing && existing.sourceRunId === sourceRunId && existing.sourceSpanId === sourceSpanId) {
          const { sourceOutput, sourceCapturedAt, sourceRedacted, sourceTruncated, sourceSnapshotVersion } = existing;
          frozen = { sourceOutput, sourceCapturedAt, sourceRedacted, sourceTruncated, sourceSnapshotVersion }; input = existing.input;
        } else {
          const snapshot = loadSnapshot(sourceRunId, sourceSpanId ?? undefined);
          frozen = { sourceOutput: snapshot.output.value, sourceCapturedAt: snapshot.capturedAt, sourceRedacted: snapshot.redacted,
            sourceTruncated: snapshot.truncated, sourceSnapshotVersion: snapshot.version }; input = snapshot.input;
        }
      }
      if (draft.input !== undefined) {
        const safe = sanitizeSnapshotText(draft.input); input = sanitizeInput(draft.input);
        frozen.sourceRedacted ||= safe.redacted; frozen.sourceTruncated ||= safe.truncated;
      }
      return { id: draft.id ?? randomUUID(), name: safeText(draft.name), input, sourceRunId, sourceSpanId, ...frozen,
        tags: (draft.tags ?? []).map(safeText), rules: draft.rules };
    });
  }
  updateDataset(id: string, body: unknown) {
    parseId(id); const draft = parseDatasetUpdate(body), prior = store.getRevision(id);
    if (prior.version !== draft.expectedVersion) throw new EvaluationError("Dataset changed; reload before saving", 409);
    const cases = this.freezeCases(draft.cases, prior.cases);
    portableDataset(prior.datasetName, cases);
    return store.appendRevision(id, draft.expectedVersion, cases);
  }
  importDataset(body: unknown) {
    const draft = parseDatasetExport(body);
    const name = safeText(draft.name), cases = this.freezeCases(draft.cases);
    portableDataset(name, cases);
    return store.createDataset(name, cases);
  }
  exportDataset(id: string, version?: number): DatasetExport {
    const revision = store.getRevision(parseId(id), version);
    return portableDataset(revision.datasetName, revision.cases);
  }
  getExperiment(id: string) { return store.getExperiment(parseId(id)); }
  start(body: unknown): Experiment {
    if (this.closed) throw new EvaluationError("Evaluation service is closed", 409);
    const draft = parseExperimentDraft(body), revision = store.getRevision(draft.datasetId, draft.version);
    if (!revision.cases.length || draft.assignments.length !== revision.cases.length ||
      revision.cases.some((item) => !draft.assignments.some((assignment) => assignment.caseId === item.id))) {
      throw new EvaluationError("Assign exactly one candidate run to every dataset case", 400);
    }
    if (revision.cases.some((item) => item.rules.some((rule) => rule.kind === "rubric")) && draft.allowModelJudges !== true) {
      throw new EvaluationError("Model judge rules require explicit allowModelJudges=true", 400);
    }
    if (store.activeExperiments().length >= L.MAX_ACTIVE_JOBS) throw new EvaluationError("Two experiments are already queued or running", 409);
    const results = revision.cases.map((item) => {
      const assignment = draft.assignments.find((candidate) => candidate.caseId === item.id)!;
      const snapshot = loadSnapshot(assignment.runId, assignment.outputSpanId);
      const inputMatch = item.input === null || snapshot.input === null ? "unavailable" as const :
        item.input.replace(/\r\n/g, "\n") === snapshot.input.replace(/\r\n/g, "\n") ? "match" as const : "mismatch" as const;
      return { caseId: item.id, caseName: item.name, runId: assignment.runId, inputMatch, status: "inconclusive" as const,
        checks: item.rules.map((rule) => pending(rule)), snapshot, case: item };
    });
    if (Buffer.byteLength(JSON.stringify(results.map((result) => ({ case: result.case, snapshot: result.snapshot })))) > L.MAX_FROZEN_EXPERIMENT) {
      throw new EvaluationError("Frozen dataset and candidate snapshots exceed the experiment limit", 413);
    }
    const experiment: Experiment = { evaluationVersion: EVALUATION_VERSION, snapshotVersion: SNAPSHOT_VERSION, id: randomUUID(),
      name: safeText(draft.name), datasetId: revision.datasetId, datasetName: revision.datasetName,
      datasetVersion: revision.version, datasetHash: revision.hash, status: "queued", verdict: null, createdAt: Date.now(), completedAt: null,
      results, summary: { total: results.length, pass: 0, fail: 0, inconclusive: results.length, passRate: 0 }, error: null };
    const token = randomUUID(); store.insertExperiment(experiment, token);
    const job: Job = { token, generation: this.generation, abort: new AbortController(), timer: setTimeout(() => { void this.run(experiment.id); }, 0) };
    this.jobs.set(experiment.id, job);
    return structuredClone(experiment);
  }
  private valid(id: string, job: Job): boolean {
    return !this.closed && !job.abort.signal.aborted && job.generation === this.generation && this.jobs.get(id) === job;
  }
  private async run(id: string): Promise<void> {
    const job = this.jobs.get(id); if (!job || !this.valid(id, job)) return;
    let completedChecks = 0;
    try {
      const experiment = store.getExperiment(id); experiment.status = "running";
      if (!store.updateExperiment(experiment, job.token, completedChecks)) return;
      for (const result of experiment.results) for (let i = 0; i < result.case.rules.length; i++) {
        if (!this.valid(id, job)) return;
        const rule = result.case.rules[i];
        let check: RuleResult;
        if (result.inputMatch !== "match") check = pending(rule, result.inputMatch === "mismatch" ? "Candidate input does not match the frozen case input" : "Case or candidate input is unavailable");
        else if (rule.kind === "rubric") {
          try { check = await this.judge(rule, result.snapshot, result.case.input, { signal: job.abort.signal }); }
          catch { check = pending(rule, "Model judge could not produce a usable result"); }
        } else check = evaluateRule(rule, result.snapshot);
        if (!this.valid(id, job)) return;
        result.checks[i] = boundRuleResult(check); completedChecks++; aggregate(experiment);
        if (!store.updateExperiment(experiment, job.token, completedChecks)) return;
        // Yield between persisted checks so cancellation and other daemon requests remain responsive.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (!this.valid(id, job)) return;
      experiment.status = "completed"; experiment.completedAt = Date.now(); aggregate(experiment);
      store.updateExperiment(experiment, job.token, completedChecks);
    } catch {
      if (this.valid(id, job)) {
        try {
          const record = store.getExperimentRecord(id);
          finishUnstarted(record.experiment, record.completedChecks, "Evaluation interrupted by an internal error", false);
          store.updateExperiment(record.experiment, job.token, record.completedChecks);
        } catch { /* A clear may have removed the row. Never recreate it. */ }
      }
    } finally { if (this.jobs.get(id) === job) this.jobs.delete(id); }
  }
  cancel(id: string): Experiment {
    parseId(id); const record = store.getExperimentRecord(id);
    if (record.experiment.status === "completed" || record.experiment.status === "cancelled") return record.experiment;
    const job = this.jobs.get(id);
    if (job) { clearTimeout(job.timer); job.abort.abort(); this.jobs.delete(id); }
    finishUnstarted(record.experiment, record.completedChecks, "Cancelled before all checks completed", true);
    store.updateExperiment(record.experiment, record.token, record.completedChecks);
    return record.experiment;
  }
  reset(): void {
    this.generation++;
    for (const job of this.jobs.values()) { clearTimeout(job.timer); job.abort.abort(); }
    this.jobs.clear();
  }
  close(): void {
    if (this.closed) return;
    for (const id of this.jobs.keys()) this.cancel(id);
    this.reset(); this.closed = true;
  }
  addReview(id: string, body: unknown) {
    const draft = parseReviewDraft(body);
    return store.addReview(parseId(id), { ...draft, note: safeText(draft.note) });
  }
  compare(baselineId: string, candidateId: string): Comparison {
    const baseline = store.getExperiment(parseId(baselineId)), candidate = store.getExperiment(parseId(candidateId));
    const compatible = baseline.status === "completed" && candidate.status === "completed" &&
      baseline.evaluationVersion === candidate.evaluationVersion && baseline.snapshotVersion === candidate.snapshotVersion &&
      baseline.datasetId === candidate.datasetId && baseline.datasetVersion === candidate.datasetVersion && baseline.datasetHash === candidate.datasetHash &&
      baseline.results.length === candidate.results.length && baseline.results.every((left) => {
        const right = candidate.results.find((result) => result.caseId === left.caseId);
        return !!right && left.checks.length === right.checks.length && left.checks.every((check, index) => check.evaluatorVersion === right.checks[index].evaluatorVersion);
      });
    if (!compatible) throw new EvaluationError("Comparison requires completed experiments with identical dataset revisions and evaluator versions", 409);
    const summary = { regressions: 0, improvements: 0, unchanged: 0, inconclusive: 0 };
    const cases = baseline.results.map((left) => {
      const right = candidate.results.find((result) => result.caseId === left.caseId)!;
      const change = left.status === "inconclusive" || right.status === "inconclusive" ? "inconclusive" as const :
        left.status === right.status ? "unchanged" as const : left.status === "pass" ? "regression" as const : "improvement" as const;
      summary[change === "regression" ? "regressions" : change === "improvement" ? "improvements" : change]++;
      const delta = (metric: "totalTokens" | "durationMs" | "costUsd") => {
        const a = left.snapshot.metrics[metric], b = right.snapshot.metrics[metric];
        return left.inputMatch === "match" && right.inputMatch === "match" && left.snapshot.complete && right.snapshot.complete && a !== null && b !== null && Number.isFinite(b - a) ? b - a : null;
      };
      return { caseId: left.caseId, caseName: left.caseName, baseline: left.status, candidate: right.status, change,
        deltas: { totalTokens: delta("totalTokens"), durationMs: delta("durationMs"), costUsd: delta("costUsd") } };
    });
    return { baselineId, candidateId, datasetHash: baseline.datasetHash, summary, cases };
  }
}
export function createEvaluationService(options?: EvaluationServiceOptions) { return new EvaluationService(options); }
