import { Worker } from "node:worker_threads";
import { TeamError, type TeamErrorCode } from "./errors";
import { TEAM_LIMITS as L, type PageQuery, type RunFilters } from "./protocol";
import { bytes, digest, pageInput } from "./store-utils";
import { teamSearchWorker, type TeamSearchResult, type TeamSearchWork } from "./search-worker";

let activeWorkers = 0;
export function teamSearchActiveWorkers(): number { return activeWorkers; }
function normalizedFilters(query: RunFilters): RunFilters {
  const filters: RunFilters = {};
  for (const key of ["q", "model", "provider"] as const) {
    const value = query[key];
    if (value !== undefined) {
      if (typeof value !== "string" || [...value].length > L.FILTER_CHARACTERS || bytes(value) > L.FILTER_BYTES || value.includes("\0")) throw new TeamError("invalid_request", "Invalid search filter");
      if (value !== "") filters[key] = value;
    }
  }
  if (query.status !== undefined) {
    if (!["running", "completed", "failed"].includes(query.status)) throw new TeamError("invalid_request", "Invalid run status");
    filters.status = query.status;
  }
  for (const key of ["from", "to"] as const) if (query[key] !== undefined) {
    if (!Number.isSafeInteger(query[key]) || query[key]! < 0) throw new TeamError("invalid_request", "Invalid search time boundary");
    filters[key] = query[key];
  }
  if (filters.from !== undefined && filters.to !== undefined && filters.from >= filters.to) throw new TeamError("invalid_request", "Invalid search time window");
  return filters;
}

export async function searchTeamRuns(dbPath: string, projectId: string, query: PageQuery & RunFilters = {}, signal?: AbortSignal): Promise<TeamSearchResult> {
  const filters = normalizedFilters(query), paging = pageInput(query, digest(JSON.stringify([projectId, "runs", filters])));
  if (signal?.aborted) throw new TeamError("query_timeout", "Search was cancelled", undefined, 1);
  if (activeWorkers >= L.QUERY_CONCURRENCY) throw new TeamError("busy", "Search capacity is busy; retry shortly", undefined, 1);
  const started = Date.now(), cancellation = new SharedArrayBuffer(4);
  const workerData: TeamSearchWork = { dbPath, projectId, filters, paging, started, deadline: started + L.QUERY_DEADLINE_MS, maxBytes: L.SEARCH_BYTES, projectBytes: L.PROJECT_BYTES, projectRuns: L.PROJECT_RUNS, projectSpans: L.PROJECT_SPANS, cancellation };
  activeWorkers++;
  let worker: Worker;
  try { worker = new Worker(`(${teamSearchWorker.toString()})()`, { eval: true, workerData }); }
  catch { activeWorkers--; throw new TeamError("internal_error", "Unable to start search"); }
  return new Promise((resolve, reject) => {
    let settled = false, released = false;
    const release = () => { if (!released) { released = true; activeWorkers--; } };
    const settle = (error?: TeamError, result?: TeamSearchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => { Atomics.store(new Int32Array(cancellation), 0, 1); settle(new TeamError("query_timeout", "Search was cancelled", undefined, 1)); };
    const timer = setTimeout(() => { Atomics.store(new Int32Array(cancellation), 0, 1); settle(new TeamError("query_timeout", "Search deadline exceeded; narrow the query", undefined, 1)); }, L.QUERY_DEADLINE_MS);
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (message: { ok: boolean; result?: TeamSearchResult; code?: TeamErrorCode }) => {
      release();
      settle(message.ok ? undefined : new TeamError(message.code ?? "internal_error", "Search could not complete", undefined, 1), message.result);
    });
    worker.once("error", () => settle(new TeamError("internal_error", "Search worker failed")));
    worker.once("exit", () => { release(); settle(new TeamError("internal_error", "Search worker exited before completion")); });
    if (signal?.aborted) abort();
  });
}
