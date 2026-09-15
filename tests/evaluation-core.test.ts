import { describe, expect, test } from "bun:test";
import { snapshotRun, sanitizeInput, REPORTED_COST_ALIASES } from "../src/evaluations/snapshot";
import { evaluateRule, boundRuleResult } from "../src/evaluations/rules";
import { parseRule, parseId, parseCaseDrafts, parseDatasetExport, parseExperimentDraft, canonicalCaseDefinitions } from "../src/evaluations/validation";
import { EVALUATION_LIMITS as L, type SnapshotSpan, type SnapshotRun, type Rule, type RuleResult, type DatasetCase } from "../src/evaluations/protocol";
import { parseOtlpRequest } from "../src/parse";

const run: SnapshotRun = { id: "run-1", name: "Evaluation fixture" };
const span = (id: string, changes: Partial<SnapshotSpan> = {}): SnapshotSpan => ({ id, run_id: run.id, parent_span_id: "root", name: id,
  span_type: "LLM_GENERATION", status: "OK", input_payload: "request", output_payload: "answer",
  start_time_ms: 10, end_time_ms: 20, input_tokens: 10, output_tokens: 5, attributes: "{}", ...changes });
const root = (changes: Partial<SnapshotSpan> = {}): SnapshotSpan => span("root", { parent_span_id: null, span_type: "AGENT_ROOT", input_payload: "request", output_payload: "answer", start_time_ms: 1, end_time_ms: 100, ...changes });
const complete = () => snapshotRun(run, [root(), span("generation", { attributes: JSON.stringify({ "gen_ai.usage.cost": .02 }) })]);
const tool = (id: string, name: string, start: number, end: number) => span(id, { span_type: "TOOL_CALL", name: "ai.toolCall", start_time_ms: start, end_time_ms: end, attributes: JSON.stringify({ "ai.toolCall.name": name }) });
const frozenCase = (): DatasetCase => ({ id: "case-1", name: "A case", input: "request", sourceRunId: "run-1", sourceSpanId: "root", sourceOutput: "answer",
  tags: [], rules: [{ kind: "jsonPath", path: "", equals: { b: 2, a: 1 } }], sourceCapturedAt: 100, sourceSnapshotVersion: 1, sourceRedacted: false, sourceTruncated: false });

describe("evaluation snapshot provenance", () => {
  test("uses explicit root response and preserves intentionally empty output", () => {
    expect(complete().output).toMatchObject({ value: "answer", spanId: "root", source: "agentRoot", complete: true });
    expect(snapshotRun(run, [root({ output_payload: "" })]).output.value).toBe("");
  });
  test("explicit response selector must belong to this exact run and expose output", () => {
    const snapshot = snapshotRun(run, [root(), span("generation", { output_payload: "selected" })], "generation");
    expect(snapshot.output).toMatchObject({ value: "selected", spanId: "generation", source: "selected" });
    expect(() => snapshotRun(run, [root()], "foreign")).toThrow("belong");
    expect(() => snapshotRun(run, [root(), span("missing", { output_payload: null })], "missing")).toThrow("readable");
    expect(() => snapshotRun(run, [root({ run_id: "other-run" })])).toThrow("belong");
  });
  test("does not substitute an earlier response when the terminal generation output is missing", () => {
    const snapshot = snapshotRun(run, [root({ output_payload: null }), span("early", { output_payload: "stale", start_time_ms: 10, end_time_ms: 20 }), span("last", { output_payload: null, start_time_ms: 30, end_time_ms: 40 })]);
    expect(snapshot.output.value).toBeNull();
    expect(snapshot.output.complete).toBe(false);
    expect(snapshot.metrics.inputTokens).toBe(20);
  });
  test("parallel generations and known nested subagents cannot silently determine final output", () => {
    const parallel = snapshotRun(run, [root({ output_payload: null }), span("left", { start_time_ms: 10, end_time_ms: 50 }), span("right", { start_time_ms: 20, end_time_ms: 60 })]);
    expect(parallel.output.source).toBe("unavailable");
    const nested = snapshotRun(run, [root({ output_payload: null }), span("tool", { span_type: "TOOL_CALL", output_payload: null }), span("child", { parent_span_id: "tool" })]);
    expect(nested.output.value).toBeNull();
  });
  test("missing attributes cannot establish main-agent fallback provenance", () => {
    const snapshot = snapshotRun(run, [root({ output_payload: null }), span("generation", { attributes: null, unavailable: { input: false, output: false, attributes: true } })]);
    expect(snapshot.output.complete).toBe(false);
    expect(snapshot.metrics.inputTokens).toBeNull();
    expect(snapshot.metrics.errorSpans).toBeNull();
    expect(snapshot.metrics.durationMs).toBe(99);
    const selected = snapshotRun(run, [root(), span("generation", { attributes: null, unavailable: { input: false, output: false, attributes: true } })], "generation");
    // Selecting a span restores its text, but cannot restore withheld completion evidence.
    expect(selected.output.value).toBe("answer");
    expect(selected.metrics.durationMs).toBe(99);
    expect(evaluateRule({ kind: "output", operation: "equals", value: "answer" }, selected).status).toBe("inconclusive");
  });
  test("clipped tool identities are explicitly unavailable for name and order assertions", () => {
    const snapshot = snapshotRun(run, [root(), span("tool", { span_type: "TOOL_CALL", name: "A".repeat(129) })]);
    expect(snapshot.toolsComplete).toBe(false);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.metrics.toolCalls).toBe(1);
  });
  test("placeholder input and output never satisfy deterministic checks", () => {
    for (const marker of ["[UNAVAILABLE]", "[unavailable]", "[redacted]", "[Truncated]"]) {
      expect(sanitizeInput(marker)).toBeNull();
      const snapshot = snapshotRun(run, [root({ input_payload: marker, output_payload: marker })]);
      expect(snapshot.input).toBeNull();
      expect(evaluateRule({ kind: "output", operation: "equals", value: marker }, snapshot).status).toBe("inconclusive");
      expect(() => parseRule({ kind: "output", operation: "equals", value: marker })).toThrow();
    }
  });
  test("OTLP records actual response model and canonical provider before request and legacy aliases", () => {
    const attributes = { "ai.model.id": "requested-ai", "ai.response.model": "answered-ai", "gen_ai.request.model": "requested-canonical", "gen_ai.response.model": "answered-canonical", "ai.model.provider": "legacy-provider", "gen_ai.system": "legacy-system", "gen_ai.provider.name": "canonical-provider" };
    const [parsed] = parseOtlpRequest({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: "run-1", spanId: "gen", name: "ai.generateText", startTimeUnixNano: "1000000", endTimeUnixNano: "2000000",
      attributes: Object.entries(attributes).map(([key, stringValue]) => ({ key, value: { stringValue } })) }] }] }] });
    expect(parsed.model).toBe("answered-canonical");
    expect(parsed.provider).toBe("canonical-provider");
  });
  test("non-text user content is unavailable instead of matching a lossy text projection", () => {
    for (const image of ["cat.png", "dog.png"]) for (const text of [[], [{ type: "text", text: "Describe this" }]]) {
      const messages = [{ role: "user", content: [...text, { type: "image", image }] }];
      const snapshot = snapshotRun(run, [span("generation", { parent_span_id: null, input_payload: null,
        attributes: JSON.stringify({ "ai.prompt.messages": JSON.stringify(messages) }) })]);
      expect(snapshot.input).toBeNull();
      expect(snapshot.warnings.some((warning) => warning.includes("non-text"))).toBe(true);
    }
  });
  test("supported adapter families reject discarded non-text content while preserving all-text input", () => {
    const families = (parts: unknown[]) => [
      { "ai.prompt.messages": JSON.stringify([{ role: "user", content: parts }]) },
      { "gen_ai.input.messages": JSON.stringify([{ role: "user", parts }]) },
      { "lk.chat_ctx": JSON.stringify({ items: [{ type: "message", role: "user", content: parts }] }) },
      { "traceloop.span.kind": "llm", "traceloop.entity.input": JSON.stringify({ messages: [{ role: "user", content: parts }] }) },
      { "gen_ai.prompt.0.role": "user", "gen_ai.prompt.0.content": JSON.stringify(parts) },
    ];
    for (const extra of [[], [{ type: "image", image: "cat.png" }], [{ type: "audio", data: "opaque" }], [{ type: "file", data: "opaque" }]]) {
      for (const attrs of families([{ type: "text", text: "Question" }, ...extra])) {
        const snapshot = snapshotRun(run, [span("generation", { parent_span_id: null, input_payload: null, attributes: JSON.stringify(attrs) })]);
        expect(snapshot.input).toBe(extra.length ? null : "Question");
      }
    }
  });
  test("rejects excessive depth at the maximum span count while accepting a shallow trace", () => {
    const deep = Array.from({ length: L.MAX_SPANS }, (_, i) => span(`depth-${i}`, { parent_span_id: i ? `depth-${i - 1}` : null }));
    expect(() => snapshotRun(run, deep)).toThrow("depth limit");
    const shallow = [root({ output_payload: null }), ...Array.from({ length: L.MAX_SPANS - 1 }, (_, i) => span(`child-${i}`))];
    expect(snapshotRun(run, shallow).complete).toBe(true);
  });
  test("rejects credential-shaped identities without changing exact benign identifiers", () => {
    const credential = `sk-proj-${"z".repeat(50)}`;
    expect(parseId("trace:exact-123")).toBe("trace:exact-123");
    expect(() => parseId(credential)).toThrow("credentials");
    expect(() => snapshotRun({ id: credential }, [])).toThrow("credentials");
    expect(() => snapshotRun(run, [span(credential)])).toThrow("credentials");
    expect(() => snapshotRun(run, [root({ parent_span_id: credential })])).toThrow("credentials");
    expect(() => snapshotRun(run, [root()], credential)).toThrow("credentials");
    const result = boundRuleResult({ ...evaluateRule({ kind: "json" }, complete()), spanIds: [credential] });
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(result.redacted).toBe(true);
  });
});

describe("evaluation measurements and completeness", () => {
  test("missing and invalid token counts stay unavailable; explicit zero remains known", () => {
    for (const value of [null, undefined, -1, NaN, Infinity, 1.5]) {
      const snapshot = snapshotRun(run, [root(), span("generation", { input_tokens: value })]);
      expect(snapshot.metrics.inputTokens).toBeNull();
      expect(snapshot.metrics.totalTokens).toBeNull();
      expect(snapshot.metrics.outputTokens).toBe(5);
    }
    const zero = snapshotRun(run, [root(), span("generation", { input_tokens: 0, output_tokens: 0 })]);
    expect(zero.metrics.totalTokens).toBe(0);
    expect(snapshotRun(run, [root()]).metrics.inputTokens).toBeNull();
  });
  test("uses canonical totals without adding cache and reasoning subsets", () => {
    const attrs = { "gen_ai.usage.input_tokens": 80, "gen_ai.usage.output_tokens": 20, "gen_ai.usage.total_tokens": 100,
      "gen_ai.usage.cache_read.input_tokens": 60, "gen_ai.usage.reasoning.output_tokens": 10 };
    const snapshot = snapshotRun(run, [root(), span("generation", { attributes: JSON.stringify(attrs) })]);
    expect(snapshot.metrics).toMatchObject({ inputTokens: 80, outputTokens: 20, totalTokens: 100 });
    const conflict = snapshotRun(run, [root(), span("generation", { attributes: JSON.stringify({ ...attrs, "gen_ai.usage.total_tokens": 999 }) })]);
    expect(conflict.metrics.totalTokens).toBeNull();
    expect(conflict.metrics.inputTokens).toBe(80);
  });
  test("reported USD aliases are explicit and absent cost never becomes zero", () => {
    for (const alias of REPORTED_COST_ALIASES) {
      const snapshot = snapshotRun(run, [root(), span("generation", { attributes: JSON.stringify({ [alias]: .0123 }) })]);
      expect(snapshot.metrics.costUsd).toBe(.0123);
      expect(snapshot.models[0].costUsd).toBe(.0123);
    }
    expect(snapshotRun(run, [root(), span("generation")]).metrics.costUsd).toBeNull();
    for (const value of [-1, "0.05", null]) expect(snapshotRun(run, [root(), span("generation", { attributes: JSON.stringify({ "gen_ai.usage.cost": value }) })]).metrics.costUsd).toBeNull();
  });
  test("nested generations cannot double-count usage or cost", () => {
    const snapshot = snapshotRun(run, [root(), span("outer", { start_time_ms: 2, end_time_ms: 80 }), span("inner", { parent_span_id: "outer" })]);
    expect(snapshot.metrics).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, durationMs: 99 });
    expect(snapshot.warnings.some((warning) => warning.includes("double-counting"))).toBe(true);
  });
  test("groups actual response models and providers with independent measurements", () => {
    const snapshot = snapshotRun(run, [root(), span("one", { attributes: JSON.stringify({ "gen_ai.response.model": "actual", "ai.response.model": "fallback", "gen_ai.provider.name": "provider", "gen_ai.usage.cost": .01 }) }),
      span("two", { model: "second", provider: "other", attributes: JSON.stringify({ "gen_ai.usage.cost": .02 }) })]);
    expect(snapshot.models).toEqual([
      { provider: "provider", model: "actual", requests: 1, errorSpans: 0, inputTokens: 10, outputTokens: 5, costUsd: .01 },
      { provider: "other", model: "second", requests: 1, errorSpans: 0, inputTokens: 10, outputTokens: 5, costUsd: .02 },
    ]);
    expect(snapshot.metrics.costUsd).toBe(.03);
  });
  test("unknown per-model error status stays unavailable in diagnostic breakdowns", () => {
    const snapshot = snapshotRun(run, [root(), span("generation", { status: "UNKNOWN" })]);
    expect(snapshot.metrics.errorSpans).toBeNull();
    expect(snapshot.models[0].errorSpans).toBeNull();
    expect(snapshot.models[0].inputTokens).toBe(10);
  });
  test("invalid graph and in-flight evidence cannot certify finished-run rules", () => {
    const variants = [[], [root(), span("orphan", { parent_span_id: "missing" })], [root(), span("a", { parent_span_id: "b" }), span("b", { parent_span_id: "a" })],
      [root(), span("repeat"), span("repeat")], [root(), span("open", { end_time_ms: null })], [root(), span("reversed", { end_time_ms: 2 })]];
    for (const spans of variants) {
      const snapshot = snapshotRun(run, spans);
      expect(snapshot.complete).toBe(false);
      expect(evaluateRule({ kind: "output", operation: "equals", value: "answer" }, snapshot).status).toBe("inconclusive");
      expect(evaluateRule({ kind: "budget", metric: "toolCalls", max: 100 }, snapshot).status).toBe("inconclusive");
    }
  });
  test("withheld payloads cannot fall back to attribute copies and preserve independent budgets", () => {
    const withheld = snapshotRun(run, [root({ input_payload: null, output_payload: null, unavailable: { input: true, output: true, attributes: false }, attributes: JSON.stringify({ "runphantom.input": "hidden", "runphantom.output": "hidden" }) })]);
    expect(withheld.input).toBeNull(); expect(withheld.output.complete).toBe(false);
    const sensitive = snapshotRun(run, [root({ output_payload: '{"password":"arbitrary-value"}' }), span("generation")]);
    expect(sensitive.redacted).toBe(true);
    expect(evaluateRule({ kind: "output", operation: "contains", value: "arbitrary" }, sensitive).status).toBe("inconclusive");
    expect(evaluateRule({ kind: "budget", metric: "inputTokens", max: 10 }, sensitive).status).toBe("pass");
    expect(sanitizeInput("a".repeat(L.MAX_TEXT_BYTES + 1))).toBeNull();
    const manyTools = snapshotRun(run, [root(), ...Array.from({ length: 201 }, (_, i) => tool(`tool-${i}`, "lookup", 10, 20))]);
    expect(manyTools.toolsComplete).toBe(false);
    expect(manyTools.metrics.toolCalls).toBe(201);
  });
});

describe("declarative evaluation rules", () => {
  test("output checks preserve exact empty values and structural JSON equality", () => {
    const snapshot = snapshotRun(run, [root({ output_payload: '{"items":[{"b":2,"a":1}],"empty":""}' })]);
    const rules: Array<[Rule, string]> = [
      [{ kind: "json" }, "pass"], [{ kind: "jsonPath", path: "items.0", equals: { a: 1, b: 2 } }, "pass"],
      [{ kind: "jsonPath", path: "items.1", equals: null }, "fail"], [{ kind: "jsonPath", path: "empty", equals: "" }, "pass"],
      [{ kind: "output", operation: "contains", value: '"items"' }, "pass"], [{ kind: "output", operation: "notContains", value: "absent" }, "pass"],
      [{ kind: "output", operation: "equals", value: "wrong" }, "fail"],
    ];
    for (const [rule, status] of rules) expect(evaluateRule(rule, snapshot)).toMatchObject({ status, source: "code", evaluatorVersion: "code:2", spanIds: ["root"] });
    expect(evaluateRule({ kind: "json" }, complete()).status).toBe("fail");
    expect(evaluateRule({ kind: "output", operation: "equals", value: "" }, snapshotRun(run, [root({ output_payload: "" })])).status).toBe("pass");
  });
  test("every budget supports pass/fail and missing measurements remain inconclusive", () => {
    const snapshot = complete();
    for (const metric of ["inputTokens", "outputTokens", "totalTokens", "durationMs", "costUsd", "toolCalls"] as const) {
      expect(evaluateRule({ kind: "budget", metric, max: snapshot.metrics[metric]! }, snapshot).status).toBe("pass");
      const more = { ...snapshot, metrics: { ...snapshot.metrics, [metric]: 10 } };
      expect(evaluateRule({ kind: "budget", metric, max: 9 }, more).status).toBe("fail");
      expect(evaluateRule({ kind: "budget", metric, max: 100 }, { ...snapshot, metrics: { ...snapshot.metrics, [metric]: null } }).status).toBe("inconclusive");
    }
    expect(evaluateRule({ kind: "errors", max: 0 }, snapshot).status).toBe("pass");
    expect(evaluateRule({ kind: "errors", max: 0 }, snapshotRun(run, [root({ status: "ERROR" })])).status).toBe("fail");
    expect(evaluateRule({ kind: "errors", max: 0 }, snapshotRun(run, [root({ status: null })])).status).toBe("inconclusive");
  });
  test("normalized tool requirements and duplicate strict subsequences use actual end times", () => {
    const snapshot = snapshotRun(run, [root(), tool("a", "lookup", 10, 20), tool("b", "lookup", 20, 25), tool("c", "save", 30, 40)]);
    expect(evaluateRule({ kind: "tools", operation: "required", names: ["lookup", "save"] }, snapshot).status).toBe("pass");
    expect(evaluateRule({ kind: "tools", operation: "forbidden", names: ["delete"] }, snapshot).status).toBe("pass");
    expect(evaluateRule({ kind: "tools", operation: "forbidden", names: ["lookup"] }, snapshot).status).toBe("fail");
    expect(evaluateRule({ kind: "tools", operation: "sequence", names: ["lookup", "lookup", "save"] }, snapshot).status).toBe("pass");
    expect(evaluateRule({ kind: "tools", operation: "sequence", names: ["save", "lookup"] }, snapshot).status).toBe("fail");
    expect(evaluateRule({ kind: "tools", operation: "sequence", names: ["lookup", "lookup", "lookup"] }, snapshot).status).toBe("fail");
    const overlap = snapshotRun(run, [root(), tool("a", "lookup", 10, 30), tool("b", "save", 20, 40)]);
    expect(evaluateRule({ kind: "tools", operation: "sequence", names: ["lookup", "save"] }, overlap).status).toBe("inconclusive");
  });
  test("bounded results preserve typed outcome and disclose evidence redaction/truncation", () => {
    const result: RuleResult = { status: "pass", source: "llm", evaluatorVersion: "rubric:1", score: .9, reason: "界".repeat(1000),
      actual: { token: "arbitrary-value" }, expected: "A".repeat(10000), spanIds: Array.from({ length: 20 }, (_, i) => `span-${i}`), redacted: false, truncated: false };
    const bounded = boundRuleResult(result);
    expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThanOrEqual(L.MAX_RESULT_BYTES);
    expect(bounded).toMatchObject({ status: "pass", source: "llm", evaluatorVersion: "rubric:1", score: .9, redacted: true, truncated: true });
    expect(JSON.stringify(bounded)).not.toContain("arbitrary-value");
    expect(boundRuleResult({ ...result, score: NaN })).toMatchObject({ status: "inconclusive", score: null });
    expect(new TextEncoder().encode(JSON.stringify(boundRuleResult({ ...result, evaluatorVersion: "x".repeat(5000) }))).byteLength).toBeLessThanOrEqual(L.MAX_RESULT_BYTES);
  });
});

describe("evaluation schema and immutable definitions", () => {
  test("rejects executable, prototype, credential and placeholder expectations", () => {
    const secret = `sk-proj-${"z".repeat(50)}`;
    const bad: unknown[] = [ { kind: "script", code: "1" }, { kind: "json", extra: true }, { kind: "jsonPath", path: "__proto__.x", equals: 1 },
      { kind: "jsonPath", path: "constructor", equals: 1 }, { kind: "jsonPath", path: secret, equals: 1 },
      { kind: "jsonPath", path: "", equals: JSON.parse('{"__proto__":1}') }, { kind: "jsonPath", path: "", equals: { password: "arbitrary-value" } },
      { kind: "jsonPath", path: "", equals: ["[unavailable]"] }, { kind: "jsonPath", path: "", equals: undefined },
      { kind: "output", operation: "contains", value: "" }, { kind: "output", operation: "equals", value: "a".repeat(L.MAX_EXPECTED + 1) },
      { kind: "budget", metric: "totalTokens", max: -1 }, { kind: "budget", metric: "toolCalls", max: 1.5 }, { kind: "rubric", provider: "other", model: "x", rubric: "x", threshold: .5 } ];
    for (const rule of bad) expect(() => parseRule(rule)).toThrow();
    expect(parseRule({ kind: "output", operation: "equals", value: "" })).toMatchObject({ value: "" });
    expect(parseRule({ kind: "tools", operation: "sequence", names: ["lookup", "lookup"] })).toMatchObject({ names: ["lookup", "lookup"] });
    expect(() => parseRule({ kind: "tools", operation: "required", names: ["lookup", "lookup"] })).toThrow();
  });
  test("rejects expected-value accessors and coercion hooks without running them", () => {
    let invoked = 0;
    const equals = Object.defineProperty({}, "field", { enumerable: true, get: () => { invoked++; return 1; } });
    expect(() => parseRule({ kind: "jsonPath", path: "", equals })).toThrow();
    const operation = { toString: () => { invoked++; return "equals"; } };
    expect(() => parseRule({ kind: "output", operation, value: "x" })).toThrow();
    const names = Object.defineProperty(["lookup"], "0", { get: () => { invoked++; return "lookup"; } });
    expect(() => parseRule({ kind: "tools", operation: "required", names })).toThrow();
    const hooked = Object.assign([1], { toJSON: () => { invoked++; return [1]; } });
    expect(() => parseRule({ kind: "jsonPath", path: "", equals: hooked })).toThrow();
    expect(invoked).toBe(0);
  });
  test("requires nonempty rules, bounded trees and unique assignments", () => {
    expect(() => parseCaseDrafts([{ name: "case", rules: [] }])).toThrow();
    expect(() => parseCaseDrafts([{ name: "case", sourceSpanId: "span", rules: [{ kind: "json" }] }])).toThrow();
    let deep: unknown = 1; for (let i = 0; i < 10; i++) deep = { child: deep };
    expect(() => parseRule({ kind: "jsonPath", path: "", equals: deep })).toThrow("structure");
    const draft = { datasetId: "dataset", name: "experiment", assignments: [{ caseId: "case", runId: "run-1" }] };
    expect(parseExperimentDraft(draft).allowModelJudges).toBeUndefined();
    expect(() => parseExperimentDraft({ ...draft, allowModelJudges: "true" })).toThrow();
    expect(() => parseExperimentDraft({ ...draft, assignments: [...draft.assignments, ...draft.assignments] })).toThrow("duplicate");
  });
  test("portable import drops source identities and canonical hashes freeze definitions, not capture time", () => {
    const portable = parseDatasetExport({ format: "runphantom-evaluations/v1", name: "portable", cases: [{ id: "old-case", name: "case", input: "request", sourceRunId: "old-run", sourceSpanId: "old-span", rules: [{ kind: "json" }] }] });
    expect(portable.cases[0]).toEqual({ name: "case", input: "request", tags: [], rules: [{ kind: "json" }] });
    const original = frozenCase();
    expect(canonicalCaseDefinitions([original])).toBe(canonicalCaseDefinitions([{ ...original, sourceCapturedAt: 999, rules: [{ kind: "jsonPath", equals: { a: 1, b: 2 }, path: "" }] }]));
    expect(canonicalCaseDefinitions([original])).not.toBe(canonicalCaseDefinitions([{ ...original, sourceSnapshotVersion: 2 }]));
    expect(canonicalCaseDefinitions([original])).not.toBe(canonicalCaseDefinitions([{ ...original, sourceOutput: "changed" }]));
  });
});
