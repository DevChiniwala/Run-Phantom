import { getCachedRun, getDrizzleDb, runInTransaction } from "./db";
import { importAnnotations, parseImportedAnnotations, MAX_IMPORTED_ANNOTATIONS, type Annotation } from "./annotations";

export const TRACE_FORMAT = "runphantom-trace/v1";
export const TRACE_LIMITS = { bytes: 10 * 1024 * 1024, spans: 10_000, liveEvents: 20_000, annotations: MAX_IMPORTED_ANNOTATIONS } as const;

type Row = Record<string, unknown>;
const RUN_STRINGS = ["event_id", "name", "event_name", "display_name", "user_id", "convo_id", "metadata"] as const;
const SPAN_STRINGS = ["parent_span_id", "span_type", "status", "input_payload", "output_payload", "model", "provider", "attributes"] as const;
const RUN_COLUMNS = ["id", ...RUN_STRINGS, "started_at", "last_updated_at"];
const SPAN_COLUMNS = ["id", "run_id", "name", ...SPAN_STRINGS, "start_time_ms", "end_time_ms", "duration_ms", "input_tokens", "output_tokens"];
const EVENT_COLUMNS = ["span_id", "type", "content", "timestamp", "metadata"];
const has = (value: Row, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export class InvalidTraceImportError extends Error {}

function invalid(message: string): never { throw new InvalidTraceImportError(message); }
function object(value: unknown, label: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Row;
}
function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.length || value.length > 1024) invalid(`${label} must be a non-empty string of at most 1024 characters`);
  return value;
}
function requiredText(value: unknown, label: string): void {
  if (typeof value !== "string" || !value.length) invalid(`${label} must be a non-empty string`);
}
function optionalString(value: unknown, label: string): void {
  if (value !== undefined && value !== null && typeof value !== "string") invalid(`${label} must be a string or null`);
}
function number(value: unknown, label: string, optional = false): void {
  if (optional && (value === undefined || value === null)) return;
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(`${label} must be a finite number`);
}
function list(value: unknown, label: string, maximum: number, optional = false): unknown[] {
  if (optional && value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) invalid(`${label} must be an array of at most ${maximum} entries`);
  return value;
}
function project(value: Row, fields: readonly string[]): Row {
  return Object.fromEntries(fields.map(field => [field, value[field] ?? null]));
}
function boundedJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (!json || Buffer.byteLength(json, "utf8") > TRACE_LIMITS.bytes) invalid("trace exceeds the 10 MiB portable file limit");
  return json;
}

export interface PortableTrace {
  format: typeof TRACE_FORMAT;
  run: Row;
  spans: Row[];
  liveEvents: Row[];
  annotations: Annotation[];
}

interface CachedTrace {
  run: Row;
  spans: Row[];
  liveEvents: Row[];
  annotations: Annotation[];
  exportSource: "saved-cache";
  exportNotice: string;
}
type ExportedTrace = PortableTrace | CachedTrace;
const ANNOTATION_TEXT_COLUMNS = ["id", "run_id", "span_id", "kind", "note", "source"] as const;

function checkExportRows(runId: string, selections: readonly (readonly [string, string, number, readonly string[]])[], initialBytes = 0): void {
  const client = getDrizzleDb().$client;
  let totalBytes = initialBytes;
  for (const [table, key, maximum, textFields] of selections) {
    const lengths = textFields.map(field => `COALESCE(length(CAST(${field} AS BLOB)), 0)`).join(" + ");
    const size = client.prepare(`SELECT count(*) AS count, COALESCE(SUM(${lengths}), 0) AS bytes FROM ${table} WHERE ${key} = ?`).get(runId) as { count: number; bytes: number };
    totalBytes += size.bytes;
    if (size.count > maximum || totalBytes > TRACE_LIMITS.bytes) invalid("trace exceeds portable export limits");
  }
}

function exportCachedTrace(runId: string): CachedTrace | null {
  const client = getDrizzleDb().$client;
  const size = client.prepare("SELECT length(CAST(data AS BLOB)) AS bytes FROM saved_run_cache WHERE id = ?").get(runId) as { bytes: number } | null;
  if (!size) return null;
  if (size.bytes > TRACE_LIMITS.bytes) invalid("saved trace exceeds the 10 MiB portable file limit");
  checkExportRows(runId, [["annotations", "run_id", TRACE_LIMITS.annotations, ANNOTATION_TEXT_COLUMNS]], size.bytes);
  const cached = getCachedRun(runId);
  if (!cached) return null;
  const data = object(JSON.parse(cached), "saved trace");
  const run = object(data.run, "saved trace run");
  if (run.id !== runId) throw new Error("Saved trace identity does not match requested run");
  const trace: CachedTrace = {
    run,
    spans: list(data.spans, "spans", TRACE_LIMITS.spans) as Row[],
    liveEvents: list(data.liveEvents, "liveEvents", TRACE_LIMITS.liveEvents, true) as Row[],
    annotations: client.prepare("SELECT id, run_id, span_id, kind, note, source, created_at FROM annotations WHERE run_id = ? ORDER BY created_at, id").all(runId) as Annotation[],
    exportSource: "saved-cache",
    exportNotice: "Legacy saved trace: payloads reflect the cached view and may be compacted. Only annotations still present in this store are included.",
  };
  parseTrace(trace);
  return trace;
}

/** Prefer persisted raw evidence; identify saved-cache fallback as a legacy view. */
export function exportTrace(runId: string): ExportedTrace | null {
  return runInTransaction(() => {
    const client = getDrizzleDb().$client;
    const hasRun = client.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId);
    const hasSpans = client.prepare("SELECT 1 FROM spans WHERE run_id = ? LIMIT 1").get(runId);
    // Match saved detail behavior, including a placeholder with no persisted
    // spans. Cache evidence remains a labelled legacy file, never a raw v1 claim.
    if (!hasRun || !hasSpans) {
      const cached = exportCachedTrace(runId);
      if (cached) return cached;
    }
    if (!hasRun) return null;
    // Count every selected text column across all tables before loading any raw
    // row. JSON escaping can add bytes, so parseTrace enforces the final cap too.
    checkExportRows(runId, [
      ["runs", "id", 1, ["id", ...RUN_STRINGS]],
      ["spans", "run_id", TRACE_LIMITS.spans, ["id", "run_id", "name", ...SPAN_STRINGS]],
      ["live_events", "trace_id", TRACE_LIMITS.liveEvents, ["span_id", "type", "content", "metadata"]],
      ["annotations", "run_id", TRACE_LIMITS.annotations, ANNOTATION_TEXT_COLUMNS],
    ]);
    const run = client.prepare(`SELECT ${RUN_COLUMNS.join(", ")} FROM runs WHERE id = ?`).get(runId) as Row;
    const trace: PortableTrace = {
      format: TRACE_FORMAT,
      run,
      spans: client.prepare(`SELECT ${SPAN_COLUMNS.join(", ")} FROM spans WHERE run_id = ? ORDER BY start_time_ms, id`).all(runId) as Row[],
      // Numeric live-event IDs belong to the exporting database, not the trace.
      liveEvents: client.prepare(`SELECT ${EVENT_COLUMNS.join(", ")} FROM live_events WHERE trace_id = ? ORDER BY timestamp, id`).all(runId) as Row[],
      annotations: client.prepare("SELECT id, run_id, span_id, kind, note, source, created_at FROM annotations WHERE run_id = ? ORDER BY created_at, id").all(runId) as Annotation[],
    };
    parseTrace(trace);
    return trace;
  });
}

function parseTrace(value: unknown) {
  const body = object(value, "trace");
  boundedJson(body);
  const versioned = has(body, "format");
  if (versioned && body.format !== TRACE_FORMAT) invalid("unsupported trace format; expected runphantom-trace/v1");
  const storedEvidence = versioned || body.exportSource === "saved-cache";
  const run = object(body.run, "run");
  const runId = id(run.id, "run.id");
  for (const field of RUN_STRINGS) optionalString(run[field], `run.${field}`);
  for (const field of ["started_at", "last_updated_at"]) number(run[field], `run.${field}`, !versioned);
  const spanIds = new Set<string>();
  const incomingSpans: Row[] = list(body.spans, "spans", TRACE_LIMITS.spans).map((value, index) => {
    const span = object(value, `spans[${index}]`);
    const spanId = id(span.id, `spans[${index}].id`);
    if (spanIds.has(spanId)) invalid(`duplicate span identity: ${spanId}`);
    spanIds.add(spanId);
    requiredText(span.name, `spans[${index}].name`);
    if (span.run_id !== undefined && span.run_id !== runId) invalid(`spans[${index}].run_id must match run.id`);
    for (const field of SPAN_STRINGS) optionalString(span[field], `spans[${index}].${field}`);
    for (const field of ["start_time_ms", "end_time_ms", "duration_ms"]) number(span[field], `spans[${index}].${field}`, storedEvidence);
    for (const field of ["input_tokens", "output_tokens"]) number(span[field], `spans[${index}].${field}`, true);
    return { ...project(span, SPAN_COLUMNS), run_id: runId, status: storedEvidence ? span.status ?? null : span.status ?? "UNSET" };
  });
  const eventIds = new Set<number>();
  const incomingEvents: Row[] = list(body.liveEvents, "liveEvents", TRACE_LIMITS.liveEvents, !versioned).map((value, index) => {
    const event = object(value, `liveEvents[${index}]`);
    requiredText(event.type, `liveEvents[${index}].type`);
    if (event.trace_id !== undefined && event.trace_id !== runId) invalid(`liveEvents[${index}].trace_id must match run.id`);
    for (const field of ["span_id", "content"]) optionalString(event[field], `liveEvents[${index}].${field}`);
    number(event.timestamp, `liveEvents[${index}].timestamp`, !versioned);
    if (event.id !== undefined && (!Number.isSafeInteger(event.id) || (event.id as number) < 0)) invalid(`liveEvents[${index}].id must be a non-negative integer`);
    if (typeof event.id === "number") {
      if (eventIds.has(event.id)) invalid(`duplicate live event identity: ${event.id}`);
      eventIds.add(event.id);
    }
    if (event.metadata !== undefined && event.metadata !== null && typeof event.metadata !== "string"
      && (typeof event.metadata !== "object" || Array.isArray(event.metadata))) invalid(`liveEvents[${index}].metadata must be a string, object or null`);
    return {
      ...project(event, EVENT_COLUMNS), timestamp: event.timestamp ?? run.started_at ?? 0,
      metadata: event.metadata && typeof event.metadata === "object" ? JSON.stringify(event.metadata) : event.metadata ?? null,
    };
  });
  if (versioned && !has(body, "annotations")) invalid("annotations must be an array");
  const incomingAnnotations = parseImportedAnnotations(body.annotations, runId, spanIds);
  return { run, runId, spanIds, incomingSpans, incomingEvents, incomingAnnotations };
}

export function importTrace(value: unknown): { runId: string; spansImported: number; liveEventsImported: number; annotationsImported: number } {
  const { run, runId, spanIds, incomingSpans, incomingEvents, incomingAnnotations } = parseTrace(value);

  runInTransaction(() => {
    const client = getDrizzleDb().$client;
    // Conflict and orphan checks share the write transaction, so no concurrent
    // writer can invalidate the decision between validation and replacement.
    importAnnotations(incomingAnnotations, runId, spanIds);
    const existing = client.prepare(`SELECT ${RUN_COLUMNS.join(", ")} FROM runs WHERE id = ?`).get(runId) as Row | null;
    const restoredRun = project(run, RUN_COLUMNS);
    for (const field of ["event_id", "display_name"]) {
      if (!has(run, field)) restoredRun[field] = existing?.[field] ?? null;
    }
    restoredRun.started_at = run.started_at ?? existing?.started_at ?? Date.now();
    restoredRun.last_updated_at = run.last_updated_at ?? existing?.last_updated_at ?? restoredRun.started_at;
    if (existing) {
      let captured: ExportedTrace | null = null;
      try { captured = exportTrace(runId); } catch (error) {
        if (!(error instanceof InvalidTraceImportError)) throw error;
      }
      const same = (left: Row, right: Row, columns: readonly string[]) => columns.every(field => left[field] === right[field]);
      const byId = new Map(incomingSpans.map(span => [span.id, span]));
      const orderedEvents = [...incomingEvents].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
      if (captured && "format" in captured && same(captured.run, restoredRun, RUN_COLUMNS)
        && captured.spans.length === incomingSpans.length
        && captured.spans.every(span => byId.has(span.id) && same(span, byId.get(span.id)!, SPAN_COLUMNS))
        && captured.liveEvents.length === orderedEvents.length
        && captured.liveEvents.every((event, index) => same(event, orderedEvents[index], EVENT_COLUMNS))) return;
    }
    client.prepare(`INSERT INTO runs (${RUN_COLUMNS.join(", ")}) VALUES (${RUN_COLUMNS.map(() => "?").join(", ")})
      ON CONFLICT(id) DO UPDATE SET ${RUN_COLUMNS.filter(field => field !== "id").map(field => `${field} = excluded.${field}`).join(", ")}`)
      .run(...RUN_COLUMNS.map(field => restoredRun[field]) as (string | number | null)[]);
    client.prepare("DELETE FROM spans WHERE run_id = ?").run(runId);
    client.prepare("DELETE FROM live_events WHERE trace_id = ?").run(runId);
    const insertSpan = client.prepare(`INSERT INTO spans (${SPAN_COLUMNS.join(", ")}) VALUES (${SPAN_COLUMNS.map(() => "?").join(", ")})`);
    for (const span of incomingSpans) insertSpan.run(...SPAN_COLUMNS.map(field => span[field]) as (string | number | null)[]);
    const insertEvent = client.prepare(`INSERT INTO live_events (trace_id, ${EVENT_COLUMNS.join(", ")}) VALUES (?, ${EVENT_COLUMNS.map(() => "?").join(", ")})`);
    for (const event of incomingEvents) insertEvent.run(runId, ...EVENT_COLUMNS.map(field => event[field]) as (string | number | null)[]);
  });
  return { runId, spansImported: incomingSpans.length, liveEventsImported: incomingEvents.length, annotationsImported: incomingAnnotations.length };
}
