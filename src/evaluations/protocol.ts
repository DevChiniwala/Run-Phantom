/** Versioned evaluation contracts. Independent implementation of the documented research concepts. */
export const EVALUATION_VERSION = 1 as const;
export const SNAPSHOT_VERSION = 1 as const;
export const UNAVAILABLE_EVIDENCE = /\[(?:REDACTED|TRUNCATED|UNSERIALIZABLE|CIRCULAR|UNAVAILABLE)\]|__REDACTED__/i;
export const EVALUATION_LIMITS = {
  MAX_SPANS: 5000, MAX_TRACE_DEPTH: 128, MAX_PAYLOAD_BYTES: 64 * 1024, MAX_ACQUIRED_PAYLOAD_BYTES: 32 * 1024 * 1024, MAX_DATASETS: 50, MAX_REVISIONS: 20,
  MAX_CASES: 50, MAX_RULES: 8, MAX_TAGS: 8, MAX_NAME: 128, MAX_EXPECTED: 4096,
  MAX_RUBRIC: 2000, MAX_NOTE: 2000, MAX_REQUEST: 2 * 1024 * 1024, MAX_SNAPSHOT: 64 * 1024,
  MAX_TEXT_BYTES: 16 * 1024, MAX_FROZEN_EXPERIMENT: 3 * 1024 * 1024, MAX_RESULT_BYTES: 2048,
  MAX_TOOL_ARGUMENT_BYTES: 8 * 1024, MAX_TOOL_ARGUMENT_TOTAL_BYTES: 16 * 1024,
  MAX_EXPERIMENT: 4 * 1024 * 1024, MAX_EXPERIMENTS: 200, MAX_REVIEWS: 1000,
  MAX_ACTIVE_JOBS: 2, MAX_REASON: 512, MAX_JUDGE_RESPONSE_BYTES: 64 * 1024, JUDGE_TIMEOUT_MS: 30_000,
} as const;
export type Status = "pass" | "fail" | "inconclusive";
export type BudgetMetric = "inputTokens" | "outputTokens" | "totalTokens" | "durationMs" | "costUsd" | "toolCalls";
export type Rule =
  | { kind: "output"; operation: "equals" | "contains" | "notContains"; value: string }
  | { kind: "json" }
  | { kind: "jsonPath"; path: string; equals: unknown }
  | { kind: "tools"; operation: "required" | "forbidden" | "sequence"; names: string[] }
  | { kind: "toolArgument"; name: string; path: string; equals: unknown; match: "any" | "all" }
  | { kind: "budget"; metric: BudgetMetric; max: number }
  | { kind: "errors"; max: number }
  | { kind: "rubric"; provider: "openai" | "anthropic"; model: string; rubric: string; threshold: number };
export type RubricRule = Extract<Rule, { kind: "rubric" }>;
export interface RuleResult {
  status: Status; source: "code" | "llm"; evaluatorVersion: string; score: number | null;
  reason: string; actual: unknown; expected: unknown; spanIds: string[]; redacted: boolean; truncated: boolean;
}
export interface PayloadUnavailable { input: boolean; output: boolean; attributes: boolean }
/** Exact stored identities with acquisition-time payload withholding. No coalesced display metrics. */
export interface SnapshotRun {
  id: string; name?: string | null; display_name?: string | null; event_name?: string | null;
  started_at?: number | null; last_updated_at?: number | null;
}
export interface SnapshotSpan {
  id: string; run_id: string; parent_span_id?: string | null; name: string; span_type: string | null;
  status?: string | null; input_payload: string | null; output_payload: string | null;
  start_time_ms?: number | null; end_time_ms?: number | null; duration_ms?: number | null;
  model?: string | null; provider?: string | null; input_tokens?: number | null; output_tokens?: number | null;
  attributes: string | null; unavailable?: PayloadUnavailable;
}
export interface SnapshotMetrics {
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  durationMs: number | null; costUsd: number | null; toolCalls: number | null; errorSpans: number | null;
}
export interface ToolArgumentEvidence {
  status: "available" | "missing" | "withheld" | "redacted" | "truncated" | "invalid" | "incomplete";
  source: "inputPayload" | "adapterInput" | "runphantomInput" | null;
  value: unknown;
}
export interface Snapshot {
  version: typeof SNAPSHOT_VERSION; runId: string; runName: string; capturedAt: number;
  complete: boolean; warnings: string[]; input: string | null;
  output: { value: string | null; spanId: string | null; source: "agentRoot" | "selected" | "terminalGeneration" | "unavailable"; complete: boolean };
  tools: Array<{ spanId: string; name: string; startedAt: number | null; endedAt: number | null; error: boolean; arguments?: ToolArgumentEvidence }>;
  toolsComplete: boolean; metrics: SnapshotMetrics;
  models: Array<{ provider: string; model: string; requests: number; errorSpans: number | null; inputTokens: number | null; outputTokens: number | null; costUsd: number | null }>;
  redacted: boolean; truncated: boolean;
}
export interface DatasetCaseDraft {
  id?: string; name: string; input?: string; sourceRunId?: string; sourceSpanId?: string; tags?: string[]; rules: Rule[];
}
export interface DatasetCase {
  id: string; name: string; input: string | null; sourceRunId: string | null; sourceSpanId: string | null;
  sourceOutput: string | null; tags: string[]; rules: Rule[]; sourceCapturedAt: number | null;
  sourceRedacted: boolean; sourceTruncated: boolean; sourceSnapshotVersion: number | null;
}
export interface Dataset { id: string; name: string; latestVersion: number; caseCount: number; createdAt: number }
export type DatasetSummary = Dataset;
export interface DatasetRevision { datasetId: string; datasetName: string; version: number; hash: string; cases: DatasetCase[]; createdAt: number }
export interface DatasetExport { format: "runphantom-evaluations/v1"; name: string; cases: DatasetCaseDraft[] }
export interface Assignment { caseId: string; runId: string; outputSpanId?: string }
export interface CaseResult {
  caseId: string; caseName: string; runId: string; inputMatch: "match" | "mismatch" | "unavailable";
  status: Status; checks: RuleResult[]; snapshot: Snapshot; case: DatasetCase;
}
export interface Experiment {
  evaluationVersion: typeof EVALUATION_VERSION; snapshotVersion: typeof SNAPSHOT_VERSION;
  id: string; name: string; datasetId: string; datasetName: string; datasetVersion: number; datasetHash: string;
  status: "queued" | "running" | "completed" | "cancelled"; verdict: Status | null;
  createdAt: number; completedAt: number | null; results: CaseResult[];
  summary: { total: number; pass: number; fail: number; inconclusive: number; passRate: number }; error: string | null;
}
export type ExperimentSummary = Omit<Experiment, "results">;
export interface Review { id: string; experimentId: string; caseId: string; rating: "pass" | "fail"; note: string; createdAt: number }
export interface Comparison {
  baselineId: string; candidateId: string; datasetHash: string;
  summary: { regressions: number; improvements: number; unchanged: number; inconclusive: number };
  cases: Array<{ caseId: string; caseName: string; baseline: Status; candidate: Status;
    change: "regression" | "improvement" | "unchanged" | "inconclusive";
    deltas: { totalTokens: number | null; durationMs: number | null; costUsd: number | null } }>;
}
export interface ExperimentDraft { datasetId: string; version?: number; name: string; assignments: Assignment[]; allowModelJudges?: boolean }
