import type { Page, RunFilters, RunSummary } from "./protocol";
import type { Paging } from "./store-utils";

export interface TeamSearchWork {
  dbPath: string;
  projectId: string;
  filters: RunFilters;
  paging: Paging;
  started: number;
  deadline: number;
  maxBytes: number;
  projectBytes: number;
  projectRuns: number;
  projectSpans: number;
  cancellation: SharedArrayBuffer;
}
export type TeamSearchResult = Page<RunSummary> & { elapsedMs: number };

// Self-contained runtime source works in compiled binaries without loose worker files.
export async function teamSearchWorker(): Promise<void> {
  const { parentPort, workerData } = await import("node:worker_threads");
  const { Database } = await import("bun:sqlite");
  const work = workerData as TeamSearchWork;
  const cancel = new Int32Array(work.cancellation);
  let db: InstanceType<typeof Database> | undefined;
  let response: { ok: true; result: TeamSearchResult } | { ok: false; code: string };
  const deadline = () => { if (Atomics.load(cancel, 0) || Date.now() >= work.deadline) throw new Error("deadline"); };
  const cursor = (run: RunSummary) => Buffer.from(JSON.stringify({ v: 1, k: work.paging.key, a: [run.startedAt, run.id] })).toString("base64url");
  try {
    deadline();
    db = new Database(work.dbPath, { readonly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;");
    const project = db.query("SELECT evidence_bytes,run_count,span_count FROM projects WHERE id=?").get(work.projectId) as { evidence_bytes: number; run_count: number; span_count: number } | null;
    if (!project || project.evidence_bytes > work.projectBytes || project.run_count > work.projectRuns || project.span_count > work.projectSpans) throw new Error("quota");
    const params: (string | number)[] = [work.projectId];
    const where = ["r.project_id=?"];
    const filters = work.filters;
    if (filters.status !== undefined) { where.push("r.status=?"); params.push(filters.status); }
    if (filters.from !== undefined) { where.push("r.started_at>=?"); params.push(filters.from); }
    if (filters.to !== undefined) { where.push("r.started_at<?"); params.push(filters.to); }
    if (filters.q !== undefined) {
      where.push("(instr(lower(json_extract(r.data,'$.name')),lower(?))>0 OR instr(lower(json_extract(r.data,'$.displayName')),lower(?))>0 OR instr(lower(r.search_text),lower(?))>0 OR EXISTS(SELECT 1 FROM spans s WHERE s.project_id=r.project_id AND s.run_id=r.id AND (instr(lower(s.name),lower(?))>0 OR instr(lower(json_extract(s.data,'$.inputPayload')),lower(?))>0 OR instr(lower(json_extract(s.data,'$.outputPayload')),lower(?))>0)))");
      params.push(filters.q, filters.q, filters.q, filters.q, filters.q, filters.q);
    }
    if (filters.model !== undefined || filters.provider !== undefined) {
      const clauses = ["s.project_id=r.project_id", "s.run_id=r.id"];
      if (filters.model !== undefined) { clauses.push("s.model=?"); params.push(filters.model); }
      if (filters.provider !== undefined) { clauses.push("s.provider=?"); params.push(filters.provider); }
      where.push(`EXISTS(SELECT 1 FROM spans s WHERE ${clauses.join(" AND ")})`);
    }
    if (work.paging.anchor) {
      const [time, id] = work.paging.anchor;
      if (time === null) { where.push("r.started_at IS NULL AND r.id<?"); params.push(id); }
      else { where.push("(r.started_at<? OR (r.started_at=? AND r.id<?) OR r.started_at IS NULL)"); params.push(time, time, id); }
    }
    params.push(work.paging.limit + 1);
    const sql = `SELECT r.data FROM runs r WHERE ${where.join(" AND ")} ORDER BY r.started_at DESC,r.id DESC LIMIT ?`;
    const items: RunSummary[] = [];
    let hasMore = false;
    for (const item of db.query(sql).iterate(...params)) {
      deadline();
      if (items.length === work.paging.limit) { hasMore = true; break; }
      const run = JSON.parse((item as { data: string }).data) as RunSummary;
      const proposed: TeamSearchResult = { items: [...items, run], hasMore: true, nextCursor: cursor(run), elapsedMs: Date.now() - work.started };
      if (Buffer.byteLength(JSON.stringify(proposed)) > work.maxBytes - 64) {
        if (!items.length) throw new Error("size");
        hasMore = true; break;
      }
      items.push(run);
    }
    deadline();
    response = { ok: true, result: { items, hasMore, nextCursor: hasMore && items.length ? cursor(items[items.length - 1]) : null, elapsedMs: Date.now() - work.started } };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "query";
    response = { ok: false, code: reason === "size" ? "too_large" : reason === "quota" ? "quota_exceeded" : Atomics.load(cancel, 0) || Date.now() >= work.deadline ? "query_timeout" : "internal_error" };
  } finally { db?.close(); }
  // Parent capacity is released only after native execution and connection close.
  parentPort!.postMessage(response);
  parentPort!.close();
}
