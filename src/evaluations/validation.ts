import { EVALUATION_LIMITS as L, UNAVAILABLE_EVIDENCE, type Rule, type DatasetCaseDraft, type DatasetCase, type DatasetExport, type ExperimentDraft } from "./protocol";
import { redactText, sanitizeWithReport } from "../verification/serialization";
import { isSensitiveKey } from "../verification/redaction";

export class EvaluationError extends Error {
  constructor(message: string, public readonly status = 400) { super(message.slice(0, L.MAX_REASON)); this.name = "EvaluationError"; }
}
const unsafe = new Set(["__proto__", "constructor", "prototype"]);
function error(message: string): never { throw new EvaluationError(message); }
function array(value: unknown, label: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max) error(`${label} requires ${min} to ${max} entries`);
  const out: unknown[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) error(`${label} requires ordinary JSON arrays`);
  }
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor)) error(`${label} cannot contain accessors or holes`);
    out.push(descriptor.value);
  }
  return out;
}
export function object(value: unknown, label = "value"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return error(`${label} must be an object`);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return error(`${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || unsafe.has(key)) error(`${label} contains an unsupported key`);
    if (!("value" in Object.getOwnPropertyDescriptor(value, key)!)) error(`${label} cannot contain accessors`);
  }
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, allowed: readonly string[], label = "value"): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) error(`${label} has an unsupported field`);
}
export function boundedText(value: unknown, label: string, max: number = L.MAX_NAME, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || value.includes(String.fromCharCode(0))) return error(`${label} must be ${empty ? "a" : "a nonempty"} string of at most ${max} characters`);
  return value;
}
export function parseId(value: unknown): string {
  const id = boundedText(value, "ID", 128);
  if (redactText(id) !== id || UNAVAILABLE_EVIDENCE.test(id)) error("ID contains credentials or unavailable data");
  return id;
}
export function parseVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return error("version must be a positive integer");
  return value;
}
function number(value: unknown, label: string, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) return error(`${label} must be a finite nonnegative ${integer ? "integer" : "number"}`);
  return value;
}
function safeJson(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (depth > 8 || ++budget.nodes > 500) error("expected value exceeds its structure limit");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") { boundedText(value, "expected value", L.MAX_EXPECTED, true); return; }
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of array(value, "expected array", 500)) safeJson(item, depth + 1, budget);
    return;
  }
  const obj = object(value, "expected value");
  for (const key of Object.keys(obj)) { boundedText(key, "expected key", 128); safeJson(obj[key], depth + 1, budget); }
}
function expectation(value: unknown): void {
  safeJson(value);
  if (JSON.stringify(value).length > L.MAX_EXPECTED) error("expected value exceeds its size limit");
  const safe = sanitizeWithReport(value);
  if (safe.redacted || safe.truncation || UNAVAILABLE_EVIDENCE.test(JSON.stringify(value))) error("expected values cannot contain credentials or unavailable data");
}
export function parseRule(value: unknown): Rule {
  const obj = object(value, "rule");
  switch (obj.kind) {
    case "output": {
      fields(obj, ["kind", "operation", "value"], "output rule");
      if (typeof obj.operation !== "string" || !["equals", "contains", "notContains"].includes(obj.operation)) error("unsupported output operation");
      const text = boundedText(obj.value, "expected output", L.MAX_EXPECTED, obj.operation === "equals");
      expectation(text);
      return { kind: "output", operation: obj.operation as "equals" | "contains" | "notContains", value: text };
    }
    case "json": fields(obj, ["kind"], "JSON rule"); return { kind: "json" };
    case "jsonPath": case "toolArgument": {
      fields(obj, obj.kind === "toolArgument" ? ["kind", "name", "path", "equals", "match"] : ["kind", "path", "equals"], "JSON path rule");
      const path = boundedText(obj.path, "JSON path", 1024, true);
      expectation(path);
      const parts = path === "" ? [] : path.split(".");
      if (parts.length > 32 || parts.some((part) => !part || unsafe.has(part) || isSensitiveKey(part))) error("JSON path contains an unsupported or credential-bearing segment");
      if (!Object.hasOwn(obj, "equals")) error("JSON path rule requires equals");
      expectation(obj.equals);
      if (obj.kind === "toolArgument") {
        const name = boundedText(obj.name, "tool name");
        expectation(name);
        if (obj.match !== "any" && obj.match !== "all") error("tool argument matching must be any or all");
        return { kind: "toolArgument", name, path, equals: obj.equals, match: obj.match };
      }
      return { kind: "jsonPath", path, equals: obj.equals };
    }
    case "tools": {
      fields(obj, ["kind", "operation", "names"], "tool rule");
      if (typeof obj.operation !== "string" || !["required", "forbidden", "sequence"].includes(obj.operation)) error("unsupported tool operation");
      const names = array(obj.names, "tool names", 20, 1).map((name) => boundedText(name, "tool name"));
      names.forEach(expectation);
      if (obj.operation !== "sequence" && new Set(names).size !== names.length) error("required/forbidden tool names must be unique");
      return { kind: "tools", operation: obj.operation as "required" | "forbidden" | "sequence", names };
    }
    case "budget": {
      fields(obj, ["kind", "metric", "max"], "budget rule");
      if (typeof obj.metric !== "string" || !["inputTokens", "outputTokens", "totalTokens", "durationMs", "costUsd", "toolCalls"].includes(obj.metric)) error("unsupported budget metric");
      return { kind: "budget", metric: obj.metric as Extract<Rule, { kind: "budget" }>["metric"], max: number(obj.max, "budget", !["durationMs", "costUsd"].includes(obj.metric)) };
    }
    case "errors": fields(obj, ["kind", "max"], "error rule"); return { kind: "errors", max: number(obj.max, "maximum errors", true) };
    case "rubric": {
      fields(obj, ["kind", "provider", "model", "rubric", "threshold"], "rubric rule");
      if (obj.provider !== "openai" && obj.provider !== "anthropic") error("unsupported judge provider");
      const model = boundedText(obj.model, "judge model");
      const rubric = boundedText(obj.rubric, "rubric", L.MAX_RUBRIC);
      expectation(model); expectation(rubric);
      const threshold = number(obj.threshold, "threshold");
      if (threshold > 1) error("threshold must be between 0 and 1");
      return { kind: "rubric", provider: obj.provider, model, rubric, threshold };
    }
    default: return error("unsupported rule kind");
  }
}
export function parseCaseDrafts(value: unknown): DatasetCaseDraft[] {
  const ids = new Set<string>();
  return array(value, "cases", L.MAX_CASES).map((raw) => {
    const obj = object(raw, "case");
    fields(obj, ["id", "name", "input", "sourceRunId", "sourceSpanId", "tags", "rules"], "case");
    const rules = array(obj.rules, "case rules", L.MAX_RULES, 1).map(parseRule);
    const id = Object.hasOwn(obj, "id") ? parseId(obj.id) : undefined;
    if (id && ids.has(id)) error("duplicate case ID");
    if (id) ids.add(id);
    const tags = array(obj.tags === undefined ? [] : obj.tags, "tags", L.MAX_TAGS);
    const sourceRunId = Object.hasOwn(obj, "sourceRunId") ? parseId(obj.sourceRunId) : undefined;
    const sourceSpanId = Object.hasOwn(obj, "sourceSpanId") ? parseId(obj.sourceSpanId) : undefined;
    if (sourceSpanId && !sourceRunId) error("sourceSpanId requires sourceRunId");
    return { ...(id ? { id } : {}), name: boundedText(obj.name, "case name"),
      ...(Object.hasOwn(obj, "input") ? { input: boundedText(obj.input, "case input", L.MAX_TEXT_BYTES, true) } : {}),
      ...(sourceRunId ? { sourceRunId } : {}), ...(sourceSpanId ? { sourceSpanId } : {}),
      tags: tags.map((tag) => boundedText(tag, "tag", 64)), rules };
  });
}
export function parseDatasetCreate(value: unknown): { name: string } {
  const obj = object(value); fields(obj, ["name"]); return { name: boundedText(obj.name, "dataset name") };
}
export function parseDatasetUpdate(value: unknown): { expectedVersion: number; cases: DatasetCaseDraft[] } {
  const obj = object(value); fields(obj, ["expectedVersion", "cases"]);
  return { expectedVersion: parseVersion(obj.expectedVersion), cases: parseCaseDrafts(obj.cases) };
}
export function parseDatasetExport(value: unknown): DatasetExport {
  const obj = object(value); fields(obj, ["format", "name", "cases"]);
  if (obj.format !== "runphantom-evaluations/v1") error("unsupported dataset export format");
  const cases = parseCaseDrafts(obj.cases).map(({ name, input, tags, rules }) => ({ name, ...(input === undefined ? {} : { input }), tags, rules }));
  return { format: "runphantom-evaluations/v1", name: boundedText(obj.name, "dataset name"), cases };
}
export function parseExperimentDraft(value: unknown): ExperimentDraft {
  const obj = object(value); fields(obj, ["datasetId", "version", "name", "assignments", "allowModelJudges"]);
  const seen = new Set<string>();
  const assignments = array(obj.assignments, "candidate assignments", L.MAX_CASES, 1).map((raw) => {
    const assignment = object(raw, "assignment"); fields(assignment, ["caseId", "runId", "outputSpanId"], "assignment");
    const caseId = parseId(assignment.caseId);
    if (seen.has(caseId)) error("duplicate case assignment"); seen.add(caseId);
    return { caseId, runId: parseId(assignment.runId), ...(Object.hasOwn(assignment, "outputSpanId") ? { outputSpanId: parseId(assignment.outputSpanId) } : {}) };
  });
  if (Object.hasOwn(obj, "allowModelJudges") && typeof obj.allowModelJudges !== "boolean") error("allowModelJudges must be boolean");
  return { datasetId: parseId(obj.datasetId), name: boundedText(obj.name, "experiment name"), assignments,
    ...(obj.version === undefined ? {} : { version: parseVersion(obj.version) }),
    ...(obj.allowModelJudges === undefined ? {} : { allowModelJudges: obj.allowModelJudges as boolean }) };
}
export function parseReviewDraft(value: unknown): { caseId: string; rating: "pass" | "fail"; note: string } {
  const obj = object(value); fields(obj, ["caseId", "rating", "note"]);
  if (obj.rating !== "pass" && obj.rating !== "fail") error("review rating must be pass or fail");
  return { caseId: parseId(obj.caseId), rating: obj.rating, note: obj.note === undefined ? "" : boundedText(obj.note, "review note", L.MAX_NOTE, true) };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) out[key] = canonical((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}
export function canonicalCaseDefinitions(cases: DatasetCase[]): string {
  return JSON.stringify(canonical(cases.map(({ sourceCapturedAt: _capturedAt, ...definition }) => definition)));
}
