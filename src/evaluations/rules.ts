import { EVALUATION_LIMITS as L, UNAVAILABLE_EVIDENCE, type Rule, type RuleResult, type Snapshot, type Status } from "./protocol";
import { redactText, sanitizeWithReport } from "../verification/serialization";
import { selectPath } from "../verification/state-select";
import { structurallyEqual } from "../verification/predicates";
import { parseId } from "./validation";
import { LossyJsonNumberError, parseJsonEvidence } from "./json-evidence";

export const CODE_EVALUATOR_VERSION = "code:2";
export const RUBRIC_EVALUATOR_VERSION = "rubric:1";
export const TOOL_ARGUMENT_EVALUATOR_VERSION = "toolargs:1";
const encoder = new TextEncoder();
/** Bound untrusted evidence separately from the outcome metadata, which must retain its types. */
export function boundRuleResult(result: RuleResult): RuleResult {
  let redacted = result.redacted, truncated = result.truncated;
  const safe = (value: unknown): unknown => {
    const cleaned = sanitizeWithReport(value);
    redacted ||= !!cleaned.redacted; truncated ||= !!cleaned.truncation;
    if (encoder.encode(JSON.stringify(cleaned.value)).byteLength > 700) { truncated = true; return "[TRUNCATED]"; }
    return cleaned.value;
  };
  const reason = safe(result.reason);
  const actual = safe(result.actual), expected = safe(result.expected);
  const spanIds = result.spanIds.filter((id) => {
    try { parseId(id); return true; } catch { redacted = true; return false; }
  }).slice(0, 5);
  truncated ||= spanIds.length !== result.spanIds.length || typeof reason === "string" && reason.length > L.MAX_REASON;
  const out: RuleResult = { status: result.status, source: result.source, evaluatorVersion: result.evaluatorVersion,
    score: result.score, reason: (typeof reason === "string" ? reason : "Evaluation evidence was unavailable").slice(0, L.MAX_REASON),
    actual, expected, spanIds, redacted, truncated };
  if (out.evaluatorVersion.length > 64 || redactText(out.evaluatorVersion) !== out.evaluatorVersion || !/^[a-z]+:\d+$/.test(out.evaluatorVersion)) {
    out.evaluatorVersion = out.source === "llm" ? RUBRIC_EVALUATOR_VERSION : CODE_EVALUATOR_VERSION;
    out.status = "inconclusive"; out.score = null; out.reason = "Evaluator returned invalid version metadata"; out.truncated = true;
  }
  if (out.score !== null && (!Number.isFinite(out.score) || out.score < 0 || out.score > 1)) {
    out.status = "inconclusive"; out.score = null; out.reason = "Evaluator returned an invalid score";
  }
  if (encoder.encode(JSON.stringify(out)).byteLength > L.MAX_RESULT_BYTES) { out.actual = null; out.expected = null; out.truncated = true; }
  while (encoder.encode(JSON.stringify(out)).byteLength > L.MAX_RESULT_BYTES && out.spanIds.length) { out.spanIds.pop(); out.truncated = true; }
  if (encoder.encode(JSON.stringify(out)).byteLength > L.MAX_RESULT_BYTES) { out.reason = "Evaluation evidence was shortened to its storage limit"; out.truncated = true; }
  return out;
}

/** Evaluate only declarative local rules. Model rubrics are dispatched by the explicitly opted-in service. */
export function evaluateRule(rule: Rule, snapshot: Snapshot): RuleResult {
  const make = (status: Status, reason: string, actual: unknown = null, expected: unknown = rule, spanIds: string[] = []): RuleResult =>
    boundRuleResult({ status, source: "code", evaluatorVersion: rule.kind === "toolArgument" ? TOOL_ARGUMENT_EVALUATOR_VERSION : CODE_EVALUATOR_VERSION, score: status === "pass" ? 1 : status === "fail" ? 0 : null,
      reason, actual, expected, spanIds, redacted: false, truncated: false });
  const unknown = (reason: string, actual: unknown = null) => make("inconclusive", reason, actual);
  if (rule.kind === "rubric") return unknown("Model rubric requires the opted-in model evaluator");
  if (!snapshot.complete) return unknown("Captured trace is incomplete; a finished-run outcome cannot be certified");
  if (rule.kind === "budget") {
    const actual = snapshot.metrics[rule.metric];
    if (actual === null || !Number.isFinite(actual)) return unknown(`The ${rule.metric} measurement is unavailable`);
    return make(actual <= rule.max ? "pass" : "fail", `Recorded ${rule.metric} ${actual} ${actual <= rule.max ? "is within" : "exceeds"} the declared maximum ${rule.max}`, actual, rule.max);
  }
  if (rule.kind === "errors") {
    const actual = snapshot.metrics.errorSpans;
    if (actual === null) return unknown("Recorded error count is unavailable");
    return make(actual <= rule.max ? "pass" : "fail", "Compared recorded error spans with the declared maximum", actual, rule.max);
  }
  if (rule.kind === "tools") {
    if (!snapshot.toolsComplete) return unknown("Recorded tool identities or timing evidence are incomplete");
    const tools = snapshot.tools, names = tools.map((tool) => tool.name);
    let pass: boolean;
    if (rule.operation === "required") pass = rule.names.every((name) => names.includes(name));
    else if (rule.operation === "forbidden") pass = rule.names.every((name) => !names.includes(name));
    else {
      if (tools.some((tool) => tool.startedAt === null || tool.endedAt === null || tool.endedAt < tool.startedAt)) return unknown("Tool order requires valid start and end timestamps");
      let previousEnd = -Infinity;
      const selected = new Set<string>();
      pass = true;
      for (const name of rule.names) {
        const next = tools.filter((tool) => tool.name === name && !selected.has(tool.spanId) && tool.startedAt! >= previousEnd)
          .sort((a, b) => a.endedAt! - b.endedAt!)[0];
        if (!next) { pass = false; break; }
        selected.add(next.spanId); previousEnd = next.endedAt!;
      }
      if (!pass) {
        const relevant = tools.filter((tool) => rule.names.includes(tool.name));
        if (relevant.some((a, i) => relevant.slice(i + 1).some((b) => a.startedAt! < b.endedAt! && b.startedAt! < a.endedAt!))) {
          return unknown("Requested strict tool order is ambiguous because relevant calls overlap", names);
        }
      }
    }
    return make(pass ? "pass" : "fail", "Compared the recorded normalized tool calls with the declared requirement", names, rule.names, tools.map((tool) => tool.spanId));
  }
  if (rule.kind === "toolArgument") {
    const calls = snapshot.tools.filter((tool) => tool.name === rule.name);
    let unavailable = !snapshot.toolsComplete;
    const observations: Array<{ spanId: string; found: boolean; value: unknown }> = [];
    for (const tool of calls) {
      const evidence = tool.arguments;
      if (evidence?.status !== "available" || evidence.source === null || tool.startedAt === null || tool.endedAt === null || tool.endedAt < tool.startedAt) {
        unavailable = true; continue;
      }
      const serialized = JSON.stringify(evidence.value);
      if (serialized === undefined || UNAVAILABLE_EVIDENCE.test(serialized)) { unavailable = true; continue; }
      const selected = selectPath(evidence.value, rule.path);
      const matches = selected.found && structurallyEqual(selected.value, rule.equals);
      observations.push({ spanId: tool.spanId, found: selected.found, value: selected.value });
      if (rule.match === "any" && matches || rule.match === "all" && !matches) {
        return make(matches ? "pass" : "fail", matches ? "At least one captured tool call has the declared argument value"
          : selected.found ? "A captured tool call has a different argument value" : "The declared argument path is absent from a complete captured tool input",
        selected.value, rule.equals, [tool.spanId]);
      }
    }
    if (unavailable) return unknown("Tool argument or identity evidence is missing, withheld, incomplete, redacted, truncated or invalid");
    if (!calls.length) return make("fail", "No captured call has the declared tool name", [], rule.name);
    const pass = rule.match === "all";
    return make(pass ? "pass" : "fail", pass ? "Every captured call with the declared name has the expected argument value"
      : "No captured call with the declared name has the expected argument value", observations,
    rule.equals, observations.map(({ spanId }) => spanId));
  }
  const output = snapshot.output;
  if (!output.complete || output.value === null || UNAVAILABLE_EVIDENCE.test(output.value)) return unknown("The selected response is unavailable, redacted, truncated or ambiguous");
  const spanIds = output.spanId ? [output.spanId] : [];
  if (rule.kind === "output") {
    const pass = rule.operation === "equals" ? output.value === rule.value : rule.operation === "contains" ? output.value.includes(rule.value) : !output.value.includes(rule.value);
    return make(pass ? "pass" : "fail", `Applied ${rule.operation} to the selected captured response`, output.value, rule.value, spanIds);
  }
  let json: unknown;
  try { json = parseJsonEvidence(output.value); } catch (error) {
    if (error instanceof LossyJsonNumberError) return rule.kind === "json"
      ? make("pass", "Selected response is valid JSON; numeric evidence is retained as captured text", output.value, "valid JSON", spanIds)
      : unknown("Captured JSON numeric values cannot be compared without rounding, overflow or underflow");
    return make("fail", "Selected response is not valid JSON", output.value, "valid JSON", spanIds);
  }
  if (rule.kind === "json") return make("pass", "Selected response is valid JSON", json, "valid JSON", spanIds);
  const selected = selectPath(json, rule.path);
  if (!selected.found) return make("fail", "The declared own-property JSON path is absent from the complete response", null, rule.equals, spanIds);
  if (UNAVAILABLE_EVIDENCE.test(JSON.stringify(selected.value))) return unknown("Selected JSON value contains unavailable evidence");
  const pass = structurallyEqual(selected.value, rule.equals);
  return make(pass ? "pass" : "fail", "Compared the selected JSON value using structural equality", selected.value, rule.equals, spanIds);
}
