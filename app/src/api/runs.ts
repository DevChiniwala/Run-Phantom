import { apiJson, apiJsonOrNull, jsonInit } from "./request";
import type { LiveEvent, Run, Span, SubAgent } from "../utils/types";

export interface RunDetailData {
  run: Run;
  spans: Span[];
  liveEvents?: LiveEvent[];
  subAgents?: SubAgent[];
}

export interface NormalizedRunDetailData {
  run: Run;
  spans: Span[];
  liveEvents: LiveEvent[];
  subAgents: SubAgent[];
}

export async function listRuns(): Promise<Run[]> {
  return apiJson<Run[]>("/api/runs");
}

export interface RunSearchOptions {
  q?: string;
  status?: string;
  model?: string;
  provider?: string;
  limit?: number;
  cursor?: string;
}

export interface RunSearchResult {
  runs: Run[];
  nextCursor: string | null;
  hasMore: boolean;
  elapsedMs: number;
}

export async function searchRuns(options: RunSearchOptions, signal?: AbortSignal): Promise<RunSearchResult> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return apiJson<RunSearchResult>(`/api/runs/search?${params}`, { signal });
}

export async function getRunDetail(runId: string, signal?: AbortSignal): Promise<RunDetailData> {
  return apiJson<RunDetailData>(`/api/runs/detail/${encodeURIComponent(runId)}`, { signal });
}

export async function getRunDetailOrNull(runId: string): Promise<RunDetailData | null> {
  return apiJsonOrNull<RunDetailData>(`/api/runs/detail/${encodeURIComponent(runId)}`);
}

export async function listConversationRuns(convoId: string): Promise<Run[]> {
  return apiJson<Run[]>(`/api/convo/${encodeURIComponent(convoId)}`);
}

export async function deleteRun(runId: string): Promise<void> {
  await apiJson(`/api/runs/${encodeURIComponent(runId)}`, jsonInit("DELETE"));
}

export async function renameRun(runId: string, name: string): Promise<void> {
  await apiJson(`/api/runs/${encodeURIComponent(runId)}`, jsonInit("PATCH", { name }));
}

export async function clearRuns(): Promise<void> {
  await apiJson("/api/clear", jsonInit("POST"));
}

export function normalizeRunDetail(detail: RunDetailData): NormalizedRunDetailData {
  return {
    run: detail.run,
    spans: detail.spans,
    liveEvents: detail.liveEvents ?? [],
    subAgents: detail.subAgents ?? [],
  };
}
