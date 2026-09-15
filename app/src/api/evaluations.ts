import { apiJson, jsonInit } from "./request";
import type { Dataset, DatasetRevision, DatasetCaseDraft, DatasetExport, Snapshot, Experiment, ExperimentSummary, ExperimentDraft, Comparison, Review } from "../../../src/evaluations/protocol";
export type { Rule, RuleResult, Snapshot, Dataset, DatasetRevision, DatasetCase, DatasetCaseDraft, DatasetExport, Assignment, Experiment, ExperimentSummary, ExperimentDraft, Review, Comparison, Status } from "../../../src/evaluations/protocol";
import type { TrialAnalysis } from "../../../src/evaluations/trials-protocol";
export type { TrialAnalysis } from "../../../src/evaluations/trials-protocol";
const root = "/api/evaluations";
const datasetPath = (id: string) => `${root}/datasets/${encodeURIComponent(id)}`;
const experimentPath = (id: string) => `${root}/experiments/${encodeURIComponent(id)}`;
const versionQuery = (version?: number) => version === undefined ? "" : `?version=${version}`;

export const evaluationsApi = {
  datasets: () => apiJson<Dataset[]>(`${root}/datasets`),
  createDataset: (name: string) => apiJson<DatasetRevision>(`${root}/datasets`, jsonInit("POST", { name })),
  revision: (id: string, version?: number) => apiJson<DatasetRevision>(datasetPath(id) + versionQuery(version)),
  saveRevision: (id: string, expectedVersion: number, cases: DatasetCaseDraft[]) => apiJson<DatasetRevision>(datasetPath(id), jsonInit("PUT", { expectedVersion, cases })),
  deleteDataset: async (id: string) => {
    const response = await fetch(datasetPath(id), { method: "DELETE" });
    if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(typeof body?.error === "string" ? body.error : "Could not delete dataset."); }
  },
  exportDataset: (id: string, version?: number) => apiJson<DatasetExport>(`${datasetPath(id)}/export${versionQuery(version)}`),
  importDataset: (value: unknown) => apiJson<DatasetRevision>(`${root}/datasets/import`, jsonInit("POST", value)),
  snapshot: (id: string, outputSpanId?: string) => apiJson<Snapshot>(`${root}/runs/${encodeURIComponent(id)}/snapshot${outputSpanId ? `?outputSpanId=${encodeURIComponent(outputSpanId)}` : ""}`),
  responseSpans: (runId: string) => apiJson<{ spans: Array<{ id: string; name: string; spanType: string }>; truncated: boolean }>(`${root}/runs/${encodeURIComponent(runId)}/response-spans`),
  analyzeTrials: (experimentIds: string[], signal?: AbortSignal) => apiJson<TrialAnalysis>(`${root}/analyses/repeated-trials`, jsonInit("POST", { experimentIds }, { signal })),
  experiments: () => apiJson<ExperimentSummary[]>(`${root}/experiments`),
  start: (draft: ExperimentDraft) => apiJson<Experiment>(`${root}/experiments`, jsonInit("POST", draft)),
  experiment: (id: string) => apiJson<Experiment>(experimentPath(id)),
  report: async (id: string, format: "json" | "junit") => {
    const response = await fetch(`${experimentPath(id)}/report?${new URLSearchParams({ format })}`);
    if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(typeof body?.error === "string" ? body.error : "Could not export evaluation report."); }
    return response.blob();
  },
  cancel: (id: string) => apiJson<Experiment>(`${experimentPath(id)}/cancel`, { method: "POST" }),
  compare: (baseline: string, candidate: string) => apiJson<Comparison>(`${root}/compare?${new URLSearchParams({ baseline, candidate })}`),
  reviews: (id: string) => apiJson<Review[]>(`${experimentPath(id)}/reviews`),
  review: (id: string, caseId: string, rating: "pass" | "fail", note: string) => apiJson<Review>(`${experimentPath(id)}/reviews`, jsonInit("POST", { caseId, rating, note })),
};
