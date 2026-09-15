import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { outputCompletionEvidence } from "./spans/completion";
import { COMPARISON_FIELDS, RUN_COMPARISON_LIMITS as L, type ComparisonField, type ComparisonFieldName, type ComparisonRow,
  type ComparisonRowState, type ComparisonSpanLink, type ComparisonValue, type RunComparison, type CapturedComparisonSpan, type CapturedComparisonRun } from "./run-comparison-protocol";
export type { CapturedComparisonSpan, CapturedComparisonRun } from "./run-comparison-protocol";

export class RunComparisonError extends Error {
  constructor(message: string, public readonly code = "invalid_comparison", public readonly status = 400) { super(message); }
}
interface Options { baseline: string; candidate: string; offset: number; limit: number }
const SPAN_TEXT = ["id", "run_id", "parent_span_id", "name", "span_type", "status", "input_payload", "output_payload", "model", "provider", "attributes"] as const;
const RUN_TEXT = ["id", "name", "display_name", "event_name"];
const NUMBERS = ["start_time_ms", "end_time_ms", "duration_ms", "input_tokens", "output_tokens"];
const UNAVAILABLE = /\[(?:REDACTED|TRUNCATED|UNSERIALIZABLE|CIRCULAR|UNAVAILABLE|COMPACTED)\]|__REDACTED__/i;
const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
const link = (runId: string, spanId?: string) => `/runs/${encodeURIComponent(runId)}${spanId === undefined ? "" : `/span/${encodeURIComponent(spanId)}`}`;
const lengthSql = (fields: readonly string[]) => fields.map(field => `COALESCE(length(CAST(${field} AS BLOB)), 0)`).join(" + ");
function clipped(value: string, bytes: number = L.previewBytes): string {
  if (byteLength(value) <= bytes) return value;
  let result = "", used = 0;
  for (const char of value) { const n = byteLength(char); if (used + n > bytes) break; result += char; used += n; }
  return result;
}
function parseId(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 1024 || byteLength(value) > L.scalarBytes) {
    throw new RunComparisonError("Run identifiers must contain 1–1024 characters.");
  }
  return value;
}
function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d{1,6}$/.test(value)) throw new RunComparisonError("Invalid comparison pagination.");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > max) throw new RunComparisonError("Invalid comparison pagination.");
  return n;
}
function options(value: unknown): Options {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RunComparisonError("Baseline and candidate identifiers are required.");
  const query = value as Record<string, unknown>;
  if (Object.keys(query).some(key => !["baseline", "candidate", "offset", "limit"].includes(key))) throw new RunComparisonError("Unknown comparison parameter.");
  const limit = integer(query.limit, 50, L.pageRows);
  if (!limit) throw new RunComparisonError("Comparison limit must be at least 1.");
  return { baseline: parseId(query.baseline), candidate: parseId(query.candidate), offset: integer(query.offset, 0, L.spansPerRun * 2), limit };
}

/** All selected TEXT bytes and row counts are checked before raw acquisition.
 * No local database singleton, writes, normalization, or network calls belong here. */
export function getRunComparison(client: Database, query: unknown): RunComparison {
  const input = options(query);
  return client.transaction(() => {
    let total = 0;
    for (const id of [input.baseline, input.candidate]) {
      const run = client.prepare(`SELECT ${lengthSql(RUN_TEXT)} AS bytes FROM runs WHERE id = ?`).get(id) as { bytes: number } | null;
      const cache = client.prepare("SELECT 1 FROM saved_run_cache WHERE id = ?").get(id);
      if (!run) {
        if (cache) throw new RunComparisonError("Saved cache evidence cannot be compared as a complete captured run. Open the saved trace to inspect it.", "cached_evidence", 409);
        throw new RunComparisonError("A selected run no longer exists.", "run_not_found", 404);
      }
      const size = client.prepare(`SELECT count(*) AS count, COALESCE(SUM(${lengthSql(SPAN_TEXT)}), 0) AS bytes,
        MAX(MAX(length(CAST(id AS BLOB)), length(CAST(run_id AS BLOB)), COALESCE(length(CAST(parent_span_id AS BLOB)), 0))) AS identityBytes
        FROM spans WHERE run_id = ?`).get(id) as { count: number; bytes: number; identityBytes: number | null };
      if (!size.count && cache) throw new RunComparisonError("This run displays saved cache evidence; raw captured spans are unavailable for comparison.", "cached_evidence", 409);
      total += run.bytes + size.bytes;
      if (size.count > L.spansPerRun || total > L.acquiredBytes || (size.identityBytes ?? 0) > L.scalarBytes) {
        throw new RunComparisonError("Selected runs exceed comparison evidence limits (2,000 spans per run, 8 MiB combined text).", "evidence_limit", 413);
      }
    }
    const acquire = (id: string): CapturedComparisonRun => {
      const run = client.prepare("SELECT id, COALESCE(display_name, name, event_name) AS name FROM runs WHERE id = ?").get(id) as { id: string; name: string | null };
      const payloads = ["input_payload", "output_payload", "attributes"];
      const fields = SPAN_TEXT.map(field => payloads.includes(field)
        ? `CASE WHEN length(CAST(${field} AS BLOB)) <= ${L.fieldBytes} THEN ${field} ELSE NULL END AS ${field}` : field);
      const flags = payloads.map(field => `COALESCE(length(CAST(${field} AS BLOB)) > ${L.fieldBytes}, 0) AS ${field === "input_payload" ? "input" : field === "output_payload" ? "output" : field}_oversized`);
      const spans = client.prepare(`SELECT ${[...fields, ...NUMBERS, ...flags].join(", ")} FROM spans WHERE run_id = ? ORDER BY start_time_ms, id`).all(id) as CapturedComparisonSpan[];
      return { ...run, spans };
    };
    return compareCapturedRuns(acquire(input.baseline), acquire(input.candidate), input.offset, input.limit);
  })();
}

type Evidence = { value: string | number | null; unavailable: ComparisonValue["unavailable"] };
type View = { span: CapturedComparisonSpan; fields: Record<ComparisonFieldName, Evidence>; identity: string | null; inputKey: string | null; complete: boolean };
const missing = (reason: ComparisonValue["unavailable"]): Evidence => ({ value: null, unavailable: reason });
function text(value: string | null, max: number = L.scalarBytes): Evidence {
  if (value === null) return missing("missing");
  if (typeof value !== "string") return missing("invalid");
  if (byteLength(value) > max) return missing("oversized");
  if (UNAVAILABLE.test(value)) return missing(/REDACTED/i.test(value) ? "redacted" : "incomplete");
  return { value, unavailable: null };
}
const finite = (value: number | null): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
function view(span: CapturedComparisonSpan): View {
  const complete = finite(span.start_time_ms) && finite(span.end_time_ms) && span.end_time_ms >= span.start_time_ms && ["OK", "ERROR"].includes(span.status ?? "");
  const attrs = span.attributes ?? "";
  const evidenceFlag = UNAVAILABLE.test(attrs) ? (/REDACTED/i.test(attrs) ? "redacted" : "incomplete") : null;
  const outputConfirmed = outputCompletionEvidence(span.attributes) !== "unconfirmed";
  const payload = (key: "input_payload" | "output_payload"): Evidence => {
    if (span[key === "input_payload" ? "input_oversized" : "output_oversized"]) return missing("oversized");
    if (evidenceFlag) return missing(evidenceFlag);
    if (span.attributes_oversized || byteLength(attrs) > L.fieldBytes) return missing("oversized");
    if (key === "output_payload" && (!complete || !outputConfirmed) && span[key] !== null) return missing("incomplete");
    return text(span[key], L.fieldBytes);
  };
  const number = (key: "duration_ms" | "input_tokens" | "output_tokens"): Evidence => {
    if (span[key] === null) return missing("missing");
    if (!finite(span[key]) || key !== "duration_ms" && !Number.isSafeInteger(span[key])) return missing("invalid");
    if (!complete) return missing("incomplete");
    return { value: span[key], unavailable: null };
  };
  const fields: Record<ComparisonFieldName, Evidence> = { name: text(span.name), span_type: text(span.span_type), status: text(span.status),
    model: text(span.model), provider: text(span.provider), input_payload: payload("input_payload"), output_payload: payload("output_payload"),
    duration_ms: number("duration_ms"), input_tokens: number("input_tokens"), output_tokens: number("output_tokens") };
  if (span.status === "UNSET" || span.status === "") fields.status = missing("incomplete");
  const identity = fields.name.unavailable || fields.span_type.unavailable || !span.name || !span.span_type ? null : JSON.stringify([span.span_type, span.name]);
  const inputKey = fields.input_payload.unavailable ? null : createHash("sha256").update(String(fields.input_payload.value)).digest("hex");
  return { span, fields, identity, inputKey, complete };
}
function fieldState(a: Evidence, b: Evidence): ComparisonField["state"] {
  return a.unavailable || b.unavailable ? "unavailable" : a.value === b.value ? "same" : "changed";
}
function pairedState(a: View, b: View): "changed" | "unchanged" | "unavailable" {
  const states = COMPARISON_FIELDS.map(key => fieldState(a.fields[key], b.fields[key]));
  return states.includes("changed") ? "changed" : states.includes("unavailable") ? "unavailable" : "unchanged";
}
function publicValue(value: Evidence): ComparisonValue {
  const preview = typeof value.value === "string" ? clipped(value.value) : value.value;
  return { ...value, value: preview, previewTruncated: preview !== value.value };
}
function comparedFields(a: View, b: View): ComparisonField[] {
  return COMPARISON_FIELDS.map(name => {
    const baseline = a.fields[name], candidate = b.fields[name];
    const delta = !baseline.unavailable && !candidate.unavailable && typeof baseline.value === "number" && typeof candidate.value === "number"
      ? candidate.value - baseline.value : null;
    return { name, state: fieldState(baseline, candidate), baseline: publicValue(baseline), candidate: publicValue(candidate), delta: delta !== null && Number.isFinite(delta) ? delta : null };
  });
}
interface Aligned { baseline: View[]; candidate: View[]; state: ComparisonRowState; match: ComparisonRow["match"]; reason: string | null; reordered: boolean; orderAvailable?: boolean }
const sortViews = (a: View, b: View) => (a.span.start_time_ms ?? Infinity) - (b.span.start_time_ms ?? Infinity) || a.span.id.localeCompare(b.span.id);
function structure(views: View[]) {
  const byId = new Map(views.map(item => [item.span.id, item]));
  if (byId.size !== views.length) throw new RunComparisonError("Captured span identifiers are duplicated.", "invalid_evidence", 422);
  const children = new Map<string | null, View[]>();
  const invalid = new Map<string, View[]>();
  for (const item of views) {
    const seen = new Set([item.span.id]);
    let parent = item.span.parent_span_id, reason: string | null = null;
    while (parent !== null) {
      if (seen.has(parent)) { reason = "Cyclic ancestry"; break; }
      if (seen.size >= L.depth) { reason = "Ancestry exceeds supported depth"; break; }
      const ancestor = byId.get(parent);
      if (!ancestor) { reason = "Missing parent span"; break; }
      seen.add(parent); parent = ancestor.span.parent_span_id;
    }
    const group = reason ? invalid : children;
    const key = reason ?? item.span.parent_span_id;
    const list = group.get(key as string) ?? [];
    list.push(item); group.set(key as string, list);
  }
  for (const group of children.values()) group.sort(sortViews);
  return { children, invalid };
}

/** Deterministic, conservative correspondence under paired parents. All inputs
 * are bounded even when called directly rather than through the SQL reader. */
export function compareCapturedRuns(baseline: CapturedComparisonRun, candidate: CapturedComparisonRun, offset = 0, limit = 50): RunComparison {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > L.pageRows) throw new RunComparisonError("Invalid comparison pagination.");
  let acquired = 0;
  for (const run of [baseline, candidate]) {
    parseId(run.id);
    if (run.spans.length > L.spansPerRun) throw new RunComparisonError("Run exceeds comparison span limit.", "evidence_limit", 413);
    acquired += byteLength(run.id) + byteLength(run.name ?? "");
    for (const span of run.spans) {
      parseId(span.id);
      if (span.run_id !== run.id) throw new RunComparisonError("Captured span does not belong to the selected run.", "invalid_evidence", 422);
      for (const key of SPAN_TEXT) { const value = span[key]; if (typeof value === "string") acquired += byteLength(value); }
      if (acquired > L.acquiredBytes) throw new RunComparisonError("Runs exceed combined comparison evidence limit.", "evidence_limit", 413);
    }
  }
  if (acquired > L.acquiredBytes) throw new RunComparisonError("Runs exceed combined comparison evidence limit.", "evidence_limit", 413);
  const left = baseline.spans.map(view), right = candidate.spans.map(view);
  const ls = structure(left), rs = structure(right);
  const aligned: Aligned[] = [];
  const counts: RunComparison["counts"] = { changed: 0, unchanged: 0, unavailable: 0, added: 0, removed: 0, ambiguous: 0,
    paired: 0, ambiguousBaselineSpans: 0, ambiguousCandidateSpans: 0, unavailableFields: 0 };
  const push = (row: Aligned) => {
    aligned.push(row); counts[row.state]++;
    if (row.match) {
      counts.paired++;
      counts.unavailableFields += COMPARISON_FIELDS.filter(key => fieldState(row.baseline[0].fields[key], row.candidate[0].fields[key]) === "unavailable").length;
    }
    if (row.state === "ambiguous") { counts.ambiguousBaselineSpans += row.baseline.length; counts.ambiguousCandidateSpans += row.candidate.length; }
  };
  const subtree = (items: View[], children: Map<string | null, View[]>): View[] => {
    const all: View[] = [], queue = [...items];
    for (let index = 0; index < queue.length; index++) { const item = queue[index]; all.push(item); queue.push(...children.get(item.span.id) ?? []); }
    return all;
  };
  const ambiguous = (a: View[], b: View[], reason: string) => {
    push({ baseline: subtree(a, ls.children), candidate: subtree(b, rs.children), state: "ambiguous", match: null, reason, reordered: false });
  };
  const unmatched = (items: View[], side: "baseline" | "candidate") => {
    for (const item of subtree(items, side === "baseline" ? ls.children : rs.children)) {
      push({ baseline: side === "baseline" ? [item] : [], candidate: side === "candidate" ? [item] : [],
        state: side === "baseline" ? "removed" : "added", match: null, reason: "Unmatched in the other captured run; this does not prove an action never occurred.", reordered: false });
    }
  };
  const pairs: [string | null, string | null][] = [[null, null]];
  for (let index = 0; index < pairs.length; index++) {
    const [lp, rp] = pairs[index];
    const a = [...ls.children.get(lp) ?? []], b = [...rs.children.get(rp) ?? []];
    const usedA = new Set<View>(), usedB = new Set<View>();
    const matched: { a: View; b: View; match: ComparisonRow["match"] }[] = [];
    const pair = (one: View, two: View, match: ComparisonRow["match"]) => { usedA.add(one); usedB.add(two); matched.push({ a: one, b: two, match }); pairs.push([one.span.id, two.span.id]); };
    const keys = new Set([...a, ...b].map(item => item.identity).filter((key): key is string => key !== null));
    for (const key of [...keys].sort()) {
      const aa = a.filter(item => item.identity === key), bb = b.filter(item => item.identity === key);
      if (aa.length === 1 && bb.length === 1) pair(aa[0], bb[0], "unique sibling key");
    }
    // Input anchors are scoped to the same captured name and already paired
    // parent. Kind changes remain visible when exact input supports the pair.
    const names = new Set([...a, ...b].filter(item => item.identity !== null).map(item => item.span.name));
    for (const name of [...names].sort()) {
      const aa = a.filter(item => item.identity !== null && item.span.name === name && !usedA.has(item)), bb = b.filter(item => item.identity !== null && item.span.name === name && !usedB.has(item));
      const hashes = new Set(aa.map(item => item.inputKey).filter((key): key is string => key !== null));
      for (const hash of hashes) {
        const al = aa.filter(item => item.inputKey === hash), bl = bb.filter(item => item.inputKey === hash);
        if (al.length === 1 && bl.length === 1 && al[0].fields.input_payload.value === bl[0].fields.input_payload.value) pair(al[0], bl[0], "unique captured input");
      }
    }
    const orderA = [...matched].sort((x, y) => a.indexOf(x.a) - a.indexOf(y.a));
    const orderB = [...matched].sort((x, y) => b.indexOf(x.b) - b.indexOf(y.b));
    const definiteOrder = (side: "a" | "b") => matched.every(entry => finite(entry[side].span.start_time_ms))
      && new Set(matched.map(entry => entry[side].span.start_time_ms)).size === matched.length;
    // ID tie-breaks make display stable; they are not recorded execution order.
    const orderAvailable = matched.length <= 1 || definiteOrder("a") && definiteOrder("b");
    for (const entry of orderA) {
      push({ baseline: [entry.a], candidate: [entry.b], state: pairedState(entry.a, entry.b), match: entry.match, reason: null,
        orderAvailable, reordered: orderAvailable && orderA.indexOf(entry) !== orderB.indexOf(entry) });
    }
    const leftoversA = a.filter(item => !usedA.has(item)), leftoversB = b.filter(item => !usedB.has(item));
    const grouped = new Set([...leftoversA, ...leftoversB].map(item => item.fields.name.unavailable || !item.span.name ? null : item.span.name));
    for (const name of grouped) {
      const aa = leftoversA.filter(item => (item.fields.name.unavailable || !item.span.name ? null : item.span.name) === name);
      const bb = leftoversB.filter(item => (item.fields.name.unavailable || !item.span.name ? null : item.span.name) === name);
      if (name === null || aa.length && bb.length || [...aa, ...bb].some(item => item.identity === null)) ambiguous(aa, bb, "Correspondence is ambiguous or captured identity is unavailable; descendants are unresolved.");
      else if (aa.length) unmatched(aa, "baseline");
      else unmatched(bb, "candidate");
    }
  }
  for (const reason of new Set([...ls.invalid.keys(), ...rs.invalid.keys()])) {
    push({ baseline: ls.invalid.get(reason) ?? [], candidate: rs.invalid.get(reason) ?? [], state: "ambiguous", match: null, reason, reordered: false });
  }
  const completeA = left.length > 0 && !ls.invalid.size && left.every(item => item.complete);
  const completeB = right.length > 0 && !rs.invalid.size && right.every(item => item.complete);
  const summary = (run: CapturedComparisonRun, complete: boolean) => ({ id: run.id, name: clipped(run.name ?? run.id), spanCount: run.spans.length, complete, href: link(run.id) });
  const result: RunComparison = { format: "runphantom-run-comparison/v1", baseline: summary(baseline, completeA), candidate: summary(candidate, completeB), counts,
    rows: [], totalRows: aligned.length, offset, nextOffset: offset + limit < aligned.length ? offset + limit : null,
    warnings: ["Structural correspondence and exact captured text differences do not establish workflow identity or root cause."], equality: "exact captured text" };
  if (!completeA || !completeB) result.warnings.push("At least one captured run is incomplete. Missing observations cannot establish that an action did not occur.");
  if (counts.ambiguous) result.warnings.push("Ambiguous groups include their unresolved descendants; those spans are not counted as paired, added, or removed.");
  if (counts.unavailableFields) result.warnings.push("Missing, incomplete, oversized, or redacted fields remain unavailable. Unchanged counts require every compared field to be available.");
  if (aligned.some(row => row.match && !row.orderAvailable)) result.warnings.push("Recorded timestamps do not establish a relative order for some matched siblings; order comparison is unavailable.");
  let outputBytes = byteLength(JSON.stringify(result));
  const spanLink = (item: View): ComparisonSpanLink => ({ id: item.span.id, runId: item.span.run_id, name: clipped(item.span.name), href: link(item.span.run_id, item.span.id) });
  for (let n = offset; n < Math.min(aligned.length, offset + limit); n++) {
    const row = aligned[n];
    const publicRow: ComparisonRow = { id: `comparison-${n}`, state: row.state, match: row.match, reason: row.reason, reordered: row.reordered, orderAvailable: row.orderAvailable ?? false,
      baseline: [], candidate: [], fields: row.match ? comparedFields(row.baseline[0], row.candidate[0]) : [] };
    const reserve = (bytes: number) => {
      outputBytes += bytes;
      if (outputBytes > L.responseBytes) throw new RunComparisonError("Comparison page exceeds the 1 MiB response limit; request fewer rows.", "response_limit", 413);
    };
    reserve(byteLength(JSON.stringify(publicRow)) + 1);
    for (const side of ["baseline", "candidate"] as const) for (const item of row[side]) {
      const entry = spanLink(item);
      reserve(byteLength(JSON.stringify(entry)) + 1);
      publicRow[side].push(entry);
    }
    result.rows.push(publicRow);
  }
  if (byteLength(JSON.stringify(result)) > L.responseBytes) throw new RunComparisonError("Comparison response exceeds the supported size.", "response_limit", 413);
  return result;
}
