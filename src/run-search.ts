import { Worker } from "node:worker_threads";
import { getDbPath } from "./db";
import { runSearchWorker, type RunSearchWork } from "./run-search-worker";

export const RUN_SEARCH_LIMITS = { queryChars: 256, pageSize: 100, responseBytes: 120_000, timeoutMs: 5_000, workers: 2 } as const;
export type RunSearchStatus = "running" | "completed" | "failed";
export interface RunSearchSummary {
  id: string;
  name: string | null;
  event_name: string | null;
  display_name: string | null;
  user_id: string | null;
  convo_id: string | null;
  started_at: number;
  last_updated_at: number;
  metadata: null;
  model: string | null;
  provider: string | null;
  status: RunSearchStatus;
  finished: number;
  error_count: number;
  span_count: number;
  live_event_count: number;
}
export interface RunSearchResult { runs: RunSearchSummary[]; nextCursor: string | null; hasMore: boolean; elapsedMs: number }
interface SearchCursor { v: 1; startedAt: number; id: string }
interface SearchInput { q: string; status?: RunSearchStatus; model: string; provider: string; limit: number; cursor?: SearchCursor }
interface ExecutionOptions { signal?: AbortSignal; dbPath?: string; timeoutMs?: number; maxBytes?: number }

export class RunSearchError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number) { super(message); this.name = "RunSearchError"; }
}
const invalid = (message: string): never => { throw new RunSearchError(message, "invalid_search", 400); };

function parseInput(value: unknown): SearchInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("Search parameters must be an object");
  const input = value as Record<string, unknown>;
  const field = (key: string, max: number = RUN_SEARCH_LIMITS.queryChars): string => {
    const raw = input[key];
    if (raw === undefined) return "";
    if (typeof raw !== "string" || raw.length > max || raw.includes("\0")) return invalid(`${key} must be a string of at most ${max} characters without null bytes`);
    return raw;
  };
  const q = field("q");
  const model = field("model");
  const provider = field("provider");
  const rawStatus = field("status");
  if (rawStatus && rawStatus !== "all" && !["running", "completed", "failed"].includes(rawStatus)) return invalid("status must be running, completed, failed, or all");
  const rawLimit = input.limit === undefined ? 50 : input.limit;
  if ((typeof rawLimit !== "string" && typeof rawLimit !== "number") || rawLimit === "" || !Number.isInteger(Number(rawLimit)) || Number(rawLimit) < 1 || Number(rawLimit) > RUN_SEARCH_LIMITS.pageSize) return invalid("limit must be an integer from 1 to 100");
  const encoded = field("cursor", 4096);
  let cursor: SearchCursor | undefined;
  if (encoded) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
      const raw = Buffer.from(encoded, "base64url").toString("utf8");
      if (Buffer.from(raw).toString("base64url") !== encoded) throw new Error();
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      const c = parsed as Record<string, unknown>;
      if (c.v !== 1 || typeof c.startedAt !== "number" || !Number.isFinite(c.startedAt) || typeof c.id !== "string" || !c.id || c.id.length > 1024 || c.id.includes("\0")) throw new Error();
      cursor = { v: 1, startedAt: c.startedAt as number, id: c.id };
    } catch { return invalid("Invalid search cursor; refresh the results"); }
  }
  return { q, model, provider, status: rawStatus && rawStatus !== "all" ? rawStatus as RunSearchStatus : undefined, limit: Number(rawLimit), cursor };
}

function buildQuery(input: SearchInput): { sql: string; params: (string | number)[] } {
  const params: (string | number)[] = [];
  const where = ["1 = 1"];
  if (input.cursor) {
    where.push("(r.started_at < ? OR (r.started_at = ? AND r.id < ?))");
    params.push(input.cursor.startedAt, input.cursor.startedAt, input.cursor.id);
  }
  if (input.q) {
    // INSTR treats %, _ and quotes literally. SQLite lower() folds ASCII; other
    // Unicode is matched literally without relying on optional ICU extensions.
    const runFields = ["r.id", "r.name", "r.event_id", "r.event_name", "r.display_name", "r.user_id", "r.convo_id", "r.metadata"];
    const spanFields = ["s.name", "s.input_payload", "s.output_payload"];
    const contains = (column: string) => { params.push(input.q); return `instr(lower(${column}), lower(?)) > 0`; };
    where.push(`(${runFields.map(contains).join(" OR ")} OR EXISTS (SELECT 1 FROM spans s WHERE s.run_id = r.id AND (${spanFields.map(contains).join(" OR ")})))`);
  }
  if (input.model || input.provider) {
    const match = [];
    if (input.model) { match.push("s.model = ?"); params.push(input.model); }
    if (input.provider) { match.push("s.provider = ?"); params.push(input.provider); }
    where.push(`EXISTS (SELECT 1 FROM spans s WHERE s.run_id = r.id AND ${match.join(" AND ")})`);
  }
  const failed = "EXISTS (SELECT 1 FROM spans s WHERE s.run_id = r.id AND s.status = 'ERROR')";
  const finished = "(EXISTS (SELECT 1 FROM spans s WHERE s.run_id = r.id AND s.parent_span_id IS NULL) AND NOT EXISTS (SELECT 1 FROM spans s WHERE s.run_id = r.id AND s.parent_span_id IS NULL AND (s.status IS NULL OR s.status NOT IN ('OK', 'ERROR'))))";
  if (input.status === "failed") where.push(failed);
  if (input.status === "completed") where.push(`NOT ${failed} AND ${finished}`);
  if (input.status === "running") where.push(`NOT ${failed} AND NOT ${finished}`);
  params.push(input.limit + 1);
  return {
    params,
    sql: `WITH matching AS MATERIALIZED (
      SELECT r.id FROM runs r WHERE ${where.join(" AND ")} ORDER BY r.started_at DESC, r.id DESC LIMIT ?
    ) SELECT r.id, ${["name", "event_name", "display_name", "user_id", "convo_id"].map(key => `substr(r.${key}, 1, 512) AS ${key}`).join(", ")},
      r.started_at, r.last_updated_at, NULL AS metadata,
      (SELECT substr(s.model, 1, 512) FROM spans s WHERE s.run_id = r.id AND s.model IS NOT NULL ORDER BY s.start_time_ms, s.id LIMIT 1) AS model,
      (SELECT substr(s.provider, 1, 512) FROM spans s WHERE s.run_id = r.id AND s.provider IS NOT NULL ORDER BY s.start_time_ms, s.id LIMIT 1) AS provider,
      CASE WHEN ${failed} THEN 'failed' WHEN ${finished} THEN 'completed' ELSE 'running' END AS status,
      ${finished} AS finished,
      (SELECT COUNT(*) FROM spans s WHERE s.run_id = r.id AND s.status = 'ERROR') AS error_count,
      (SELECT COUNT(*) FROM spans s WHERE s.run_id = r.id) AS span_count,
      (SELECT COUNT(*) FROM live_events e WHERE e.trace_id = r.id) AS live_event_count
      FROM matching JOIN runs r ON r.id = matching.id ORDER BY r.started_at DESC, r.id DESC`,
  };
}

let activeWorkers = 0;

/** Keyset pages are stable for a static store; refresh after new or updated runs.
 * Deadlines are checked between rows; an executing SQLite step may finish later.
 * Capacity stays occupied after callers leave until the read actually finishes. */
export async function searchRuns(value: unknown = {}, options: ExecutionOptions = {}): Promise<RunSearchResult> {
  const input = parseInput(value);
  if (options.signal?.aborted) throw new RunSearchError("Search cancelled", "cancelled", 499);
  if (activeWorkers >= RUN_SEARCH_LIMITS.workers) throw new RunSearchError("Search is busy; retry shortly", "search_busy", 503);
  const started = Date.now();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(RUN_SEARCH_LIMITS.timeoutMs, options.timeoutMs!)) : RUN_SEARCH_LIMITS.timeoutMs;
  const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(1024, Math.min(RUN_SEARCH_LIMITS.responseBytes, options.maxBytes!)) : RUN_SEARCH_LIMITS.responseBytes;
  const cancellation = new SharedArrayBuffer(4);
  const workerData: RunSearchWork = { ...buildQuery(input), dbPath: options.dbPath ?? getDbPath(), limit: input.limit, maxBytes, started, deadline: started + timeoutMs, cancellation };
  activeWorkers++;
  let worker: Worker;
  try { worker = new Worker(`(${runSearchWorker.toString()})()`, { eval: true, workerData }); }
  catch (error) { activeWorkers--; throw error; }
  return new Promise<RunSearchResult>((resolve, reject) => {
    let settled = false;
    let released = false;
    const release = () => { if (!released) { released = true; activeWorkers--; } };
    const settle = (error?: Error, result?: RunSearchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => { Atomics.store(new Int32Array(cancellation), 0, 1); settle(new RunSearchError("Search cancelled", "cancelled", 499)); };
    const timer = setTimeout(() => settle(new RunSearchError("Search timed out; narrow the query or filters", "timeout", 504)), timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (message: { ok: boolean; result?: RunSearchResult; error?: string; code?: string }) => {
      release();
      settle(message.ok ? undefined : new RunSearchError(message.error ?? "Search failed", message.code ?? "query_failed", message.code === "timeout" ? 504 : 500), message.result);
    });
    worker.once("error", error => { settle(new RunSearchError(error.message, "worker_failed", 500)); });
    worker.once("exit", () => { release(); settle(new RunSearchError("Search worker exited before completing", "worker_failed", 500)); });
    if (options.signal?.aborted) abort();
  });
}

export const _runSearchInternal = { activeWorkers: () => activeWorkers };
