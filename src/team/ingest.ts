import { parseOtlpRequest } from "../parse";
import { hasDuplicateJsonKeys } from "../json-keys";
import { decodeOtlpProtobuf } from "../otlp-protobuf";
import { parseJsonEvidence } from "../evaluations/json-evidence";
import { defaultIsSensitiveKey, redactUrl, scrubKnownSecrets } from "../verification/redaction";
import { TeamError } from "./errors";
import { TEAM_LIMITS as L, type Span } from "./protocol";

type ObjectValue = Record<string, unknown>;
export interface TeamCapture {
  readonly span: Span;
  readonly searchMetadata: string;
  readonly eventName: string | null;
}
export interface TeamIngestBatch { readonly captures: readonly TeamCapture[] }
const admitted = new WeakSet<object>();
const unavailable = /\[(?:REDACTED|TRUNCATED|UNAVAILABLE|UNSERIALIZABLE|CIRCULAR)\]|__REDACTED__/i;
const invalid = () => new TeamError("invalid_request", "Invalid OTLP trace batch");
const large = () => new TeamError("too_large", "OTLP trace batch exceeds a capture limit");


function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as ObjectValue;
}
function array(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid();
  return value;
}
function validateTree(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++nodes > L.INGEST_NODES || next.depth > L.INGEST_DEPTH) throw large();
    if (next.value && typeof next.value === "object") {
      for (const child of Object.values(next.value)) pending.push({ value: child, depth: next.depth + 1 });
    }
  }
}

// Check nested message lengths before protobufjs recursively decodes AnyValue.
// Unknown fields are skipped; no arbitrary message bytes are interpreted as text.
const messages: Record<string, Record<number, string>> = {
  request: { 1: "resourceSpans" }, resourceSpans: { 1: "resource", 2: "scopeSpans" },
  resource: { 1: "keyValue" }, scopeSpans: { 1: "scope", 2: "span" }, scope: { 3: "keyValue" },
  span: { 9: "keyValue", 11: "event", 13: "link", 15: "status" }, event: { 3: "keyValue" },
  link: { 4: "keyValue" }, status: {}, keyValue: { 2: "any" }, any: { 5: "array", 6: "kvlist" },
  array: { 1: "any" }, kvlist: { 1: "keyValue" },
};
function checkProtobuf(bytes: Uint8Array): Array<{ start: boolean; end: boolean }> {
  let nodes = 0;
  const times: Array<{ start: boolean; end: boolean }> = [];
  function visit(type: string, start: number, end: number, depth: number): void {
    if (depth > L.INGEST_DEPTH) throw large();
    let position = start;
    const timing = type === "span" ? { start: false, end: false } : null;
    if (timing) { times.push(timing); if (times.length > L.INGEST_SPANS) throw large(); }
    function varint(): number {
      let number = 0;
      for (let n = 0; n < 10; n++) {
        if (position >= end) throw invalid();
        const byte = bytes[position++];
        if (n < 7) number += (byte & 127) * 2 ** (n * 7);
        if (!(byte & 128)) return number;
      }
      throw invalid();
    }
    while (position < end) {
      if (++nodes > L.INGEST_NODES) throw large();
      const tag = varint(), field = Math.floor(tag / 8), wire = tag & 7;
      if (!field) throw invalid();
      if (timing && field === 7) timing.start = true;
      if (timing && field === 8) timing.end = true;
      if (wire === 0) varint();
      else if (wire === 1) position += 8;
      else if (wire === 5) position += 4;
      else if (wire === 2) {
        const size = varint(), until = position + size;
        if (!Number.isSafeInteger(size) || until > end) throw invalid();
        const child = messages[type]?.[field];
        if (child) visit(child, position, until, depth + 1);
        position = until;
      } else throw invalid();
      if (position > end) throw invalid();
    }
  }
  visit("request", 0, bytes.length, 0);
  return times;
}

/** Fixed floor; does not read or mutate the configurable ambient SDK policy. */
export function redactTeamText(text: string, activeSecret = ""): string {
  let nodes = 0;
  function plain(value: string): string {
    let safe = value.replace(/\0/g, "\uFFFD");
    if (activeSecret) safe = safe.split(activeSecret).join("[REDACTED]");
    safe = safe.replace(/rp_team_(?:session|setup|invite|ingest)_[A-Za-z0-9_-]{16,}/g, "[REDACTED]");
    // The shared JWT recognizer backtracks on long base64 runs without dots.
    // Bound ambiguous tokens before invoking it, keeping their loss explicit.
    safe = safe.replace(/[A-Za-z0-9_.-]+/g, token => token.length > 256 && token.includes("eyJ") ? "[UNAVAILABLE]" : scrubKnownSecrets(token));
    safe = safe.replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, url => redactUrl(url, defaultIsSensitiveKey));
    safe = safe.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{8,}/gi, "[REDACTED]");
    safe = safe.replace(/\b(?:authorization|proxy-authorization|x-api-key|api[_-]?key|password|cookie|set-cookie)\s*[:=]\s*[^\r\n,;]+/gi, "[REDACTED]");
    return safe;
  }
  function visit(value: unknown, depth: number): unknown {
    if (++nodes > L.INGEST_NODES || depth > L.INGEST_DEPTH) return "[TRUNCATED]";
    if (typeof value === "string") {
      let safe = plain(value);
      if (/^\s*[[{"]/.test(value)) {
        try {
          const parsed: unknown = parseJsonEvidence(value);
          if (hasDuplicateJsonKeys(value)) return "[UNAVAILABLE]";
          const scrubbed = visit(parsed, depth + 1);
          if (JSON.stringify(parsed) !== JSON.stringify(scrubbed)) safe = JSON.stringify(scrubbed);
        } catch { return "[UNAVAILABLE]"; }
      }
      return safe;
    }
    if (Array.isArray(value)) return value.map(item => visit(item, depth + 1));
    if (value && typeof value === "object") {
      const output: ObjectValue = Object.create(null);
      for (const [key, child] of Object.entries(value)) {
        const safeKey = plain(key);
        output[safeKey] = defaultIsSensitiveKey(key) || ["__proto__", "constructor", "prototype"].includes(key)
          ? "[REDACTED]" : visit(child, depth + 1);
      }
      return output;
    }
    return typeof value === "number" && !Number.isFinite(value) ? "[UNAVAILABLE]" : value;
  }
  return visit(text, 0) as string;
}

function timing(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if ((typeof value !== "number" && typeof value !== "string") || !/^\d{1,20}$/.test(String(value))) return null;
  try {
    const nanos = BigInt(value);
    if (nanos > 18_446_744_073_709_551_615n) return null;
    return Number(nanos / 1_000_000n) + Number(nanos % 1_000_000n) / 1_000_000;
  } catch { return null; }
}
function boundedName(value: unknown, fallback: string, secret: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || Buffer.byteLength(value) > L.NAME_BYTES || [...value].length > L.NAME_CHARACTERS) throw large();
  return redactTeamText(value, secret);
}
function attributes(value: unknown, byteValues: ObjectValue[]): unknown[] {
  const attrs = array(value);
  if (attrs.length > L.SPAN_ATTRIBUTES) throw large();
  for (const item of attrs) {
    const attr = object(item);
    if (typeof attr.key !== "string" || Buffer.byteLength(attr.key) > L.NAME_BYTES || !attr.value || typeof attr.value !== "object") throw invalid();
    const wire = object(attr.value);
    const keys = Object.keys(wire);
    if (keys.length > 1) throw invalid();
    for (const key of keys) {
      const child = wire[key];
      if (key === "stringValue" && typeof child === "string") continue;
      if (key === "boolValue" && typeof child === "boolean") continue;
      if (key === "intValue" && (typeof child === "string" && /^-?\d{1,20}$/.test(child) || typeof child === "number" && Number.isSafeInteger(child))) continue;
      if (key === "doubleValue" && typeof child === "number") continue;
      if (key === "bytesValue" && typeof child === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(child)) { byteValues.push(wire); continue; }
      if (key === "arrayValue") {
        for (const inner of array(object(child).values)) attributes([{ key: "value", value: inner }], byteValues);
        continue;
      }
      if (key === "kvlistValue") { attributes(object(child).values, byteValues); continue; }
      throw invalid();
    }
  }
  return attrs;
}
function dropped(value: ObjectValue | undefined): boolean {
  if (!value) return false;
  let result = false;
  for (const key of ["droppedAttributesCount", "droppedEventsCount", "droppedLinksCount"]) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || (value[key] as number) < 0) throw invalid();
    result ||= (value[key] as number) > 0;
  }
  return result;
}

export function normalizeTeamIngest(bytes: Uint8Array, format: "json" | "protobuf", activeSecret: string): TeamIngestBatch {
  if (bytes.byteLength > L.INGEST_EXPANDED_BYTES) throw large();
  let body: ObjectValue;
  let rawTimes: Array<{ start: boolean; end: boolean }> | undefined;
  try {
    if (format === "protobuf") {
      rawTimes = checkProtobuf(bytes);
      body = decodeOtlpProtobuf(bytes);
    } else if (format === "json") body = object(parseJsonEvidence(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    else throw invalid();
  } catch (error) { if (error instanceof TeamError) throw error; throw invalid(); }
  validateTree(body);
  if (Object.keys(body).some(key => key !== "resourceSpans")) throw invalid();
  const rawSpans: ObjectValue[] = [];
  const lostEvidence: boolean[] = [];
  const byteValues: ObjectValue[] = [];
  const usedResources: ObjectValue[] = [];
  let effectiveBytes = 0;
  for (const resourceValue of array(body.resourceSpans)) {
    const resource = object(resourceValue);
    const resourceByteValues: ObjectValue[] = [];
    if (resource.resource !== undefined) attributes(object(resource.resource).attributes, resourceByteValues);
    const resourceDropped = dropped(resource.resource === undefined ? undefined : object(resource.resource));
    const resourceBytes = Buffer.byteLength(JSON.stringify(resource.resource ?? {}));
    const usedScopes: ObjectValue[] = [];
    for (const scopeValue of array(resource.scopeSpans)) {
      const scope = object(scopeValue);
      const scopeByteValues: ObjectValue[] = [];
      if (scope.scope !== undefined) attributes(object(scope.scope).attributes, scopeByteValues);
      const scopeDropped = dropped(scope.scope === undefined ? undefined : object(scope.scope));
      const inheritedBytes = resourceBytes + Buffer.byteLength(JSON.stringify(scope.scope ?? {}));
      const spans = array(scope.spans);
      for (const spanValue of spans) {
        const span = object(spanValue);
        const captureBytes = inheritedBytes + Buffer.byteLength(JSON.stringify(span));
        effectiveBytes += captureBytes;
        if (captureBytes > L.RAW_SPAN_BYTES || effectiveBytes > L.RAW_BATCH_CAPTURE_BYTES) throw large();
        attributes(span.attributes, byteValues);
        for (const event of array(span.events)) attributes(object(event).attributes, byteValues);
        for (const link of array(span.links)) attributes(object(link).attributes, byteValues);
        if (typeof span.name !== "string") throw invalid();
        if (span.status !== undefined) {
          const status = object(span.status);
          if (status.code !== undefined && ![0, 1, 2, "0", "1", "2", "UNSET", "OK", "ERROR", "STATUS_CODE_UNSET", "STATUS_CODE_OK", "STATUS_CODE_ERROR"].includes(status.code as string | number)) throw invalid();
          if (status.message !== undefined && typeof status.message !== "string") throw invalid();
        }
        if (rawTimes) {
          const presence = rawTimes[rawSpans.length];
          if (!presence?.start) delete span.startTimeUnixNano;
          if (!presence?.end) delete span.endTimeUnixNano;
        }
        rawSpans.push(span);
        lostEvidence.push(dropped(span) || resourceDropped || scopeDropped);
        if (rawSpans.length > L.INGEST_SPANS) throw large();
      }
      if (spans.length) { usedScopes.push(scope); byteValues.push(...scopeByteValues); }
    }
    if (usedScopes.length) {
      resource.scopeSpans = usedScopes;
      usedResources.push(resource);
      byteValues.push(...resourceByteValues);
    }
  }
  // Metadata with no recipient spans is validated above, but never becomes
  // captured evidence and must not trigger unbounded credential processing.
  body.resourceSpans = usedResources;
  for (const wire of byteValues) {
    const decoded = Buffer.from(wire.bytesValue as string, "base64").toString("utf8");
    if (redactTeamText(decoded, activeSecret) !== decoded) {
      delete wire.bytesValue;
      wire.stringValue = "[REDACTED]";
    }
  }
  let parsed;
  try { parsed = parseOtlpRequest(body); } catch { throw invalid(); }
  const captures: TeamCapture[] = parsed.map((source, index) => {
    if (!/^[0-9a-f]{32}$/.test(source.traceId) || /^0+$/.test(source.traceId)
      || !/^[0-9a-f]{16}$/.test(source.spanId) || /^0+$/.test(source.spanId)) throw invalid();
    let parent = source.parentSpanId || null;
    if (parent && /^0+$/.test(parent)) parent = null;
    if (parent && !/^[0-9a-f]{16}$/.test(parent)) throw invalid();
    if (Object.keys(source.attributes).length > L.SPAN_ATTRIBUTES) throw large();
    const safeAttrs = Object.create(null) as ObjectValue;
    for (const [key, value] of Object.entries(source.attributes)) {
      safeAttrs[redactTeamText(key, activeSecret)] = defaultIsSensitiveKey(key)
        ? "[REDACTED]" : typeof value === "string" ? redactTeamText(value, activeSecret) : value;
    }
    const attrs = JSON.stringify(safeAttrs);
    const input = typeof source.inputPayload === "string" ? redactTeamText(source.inputPayload, activeSecret) : null;
    const output = typeof source.outputPayload === "string" ? redactTeamText(source.outputPayload, activeSecret) : null;
    const start = timing(rawSpans[index].startTimeUnixNano), capturedEnd = timing(rawSpans[index].endTimeUnixNano);
    const end = capturedEnd !== null && (start === null || capturedEnd >= start) ? capturedEnd : null;
    const tokens = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    const span: Span = {
      id: source.spanId, runId: source.traceId, parentSpanId: parent,
      name: boundedName(source.name, "Span", activeSecret), kind: source.spanType,
      status: source.status === "ERROR" ? "ERROR" : end !== null ? "OK" : "UNSET",
      startedAt: start, endedAt: end, durationMs: start !== null && end !== null ? end - start : null,
      model: source.model === undefined ? null : boundedName(source.model, "", activeSecret),
      provider: source.provider === undefined ? null : boundedName(source.provider, "", activeSecret),
      inputTokens: tokens(source.inputTokens), outputTokens: tokens(source.outputTokens),
      inputPayload: input, outputPayload: output, attributes: attrs,
      unavailable: { input: lostEvidence[index] || input === null || unavailable.test(input), output: lostEvidence[index] || output === null || unavailable.test(output), attributes: lostEvidence[index] || unavailable.test(attrs) },
    };
    if (Buffer.byteLength(JSON.stringify(span)) + Buffer.byteLength(span.name) + Buffer.byteLength(span.model ?? "") + Buffer.byteLength(span.provider ?? "") + 128 > L.SPAN_BYTES) throw large();
    const metadata = [source.eventId, source.eventName, source.userId, source.convoId].map(value => boundedName(value, "", activeSecret));
    return Object.freeze({ span: Object.freeze({ ...span, unavailable: Object.freeze(span.unavailable) }), searchMetadata: JSON.stringify(metadata), eventName: metadata[1] || null });
  });
  const batch = Object.freeze({ captures: Object.freeze(captures) });
  admitted.add(batch);
  return batch;
}

export function assertTeamIngestBatch(batch: TeamIngestBatch): void {
  if (!admitted.has(batch)) throw new TeamError("invalid_request", "Ingestion requires an admitted sanitized batch");
}
