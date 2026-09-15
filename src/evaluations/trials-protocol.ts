import type { Status } from "./protocol";

export const TRIAL_ANALYSIS_FORMAT = "runphantom-repeated-trial-analysis/v1" as const;
export const MAX_TRIALS = 20;
export const MAX_TRIAL_ACQUISITION_BYTES = 8 * 1024 * 1024;
export interface TrialCounts {
  total: number; pass: number; fail: number; inconclusive: number; passRate: number; resolvedCoverage: number;
  unresolvedBounds: { lower: number; upper: number };
}
export interface TrialAnalysis {
  format: typeof TRIAL_ANALYSIS_FORMAT;
  dataset: { id: string; name: string; version: number; hash: string };
  evaluationVersion: number; snapshotVersion: number;
  trials: Array<{ experimentId: string; name: string; status: "completed" | "cancelled"; createdAt: number; completedAt: number | null; gatePass: boolean; executionError: boolean }>;
  cases: Array<{ caseId: string; name: string; evaluatorVersions: string[]; counts: TrialCounts; outcomes: Array<{ experimentId: string; runId: string; status: Status }> }>;
  summary: TrialCounts;
  gate: { pass: boolean; reasons: string[] };
  limitations: string[];
}
