import { describe, expect, test } from "bun:test";
import * as protobuf from "protobufjs";
import { parseOtlpRequest } from "../src/parse";
import { decodeOtlpProtobuf } from "../src/otlp-protobuf";
import { normalizeStoredSpan } from "../src/spans/normalize";
import { snapshotRun } from "../src/evaluations/snapshot";
import { evaluateRule } from "../src/evaluations/rules";

const traceId = "1234567890abcdef1234567890abcdef";
const spanId = "1234567890abcdef";
function value(input: unknown): any {
  if (typeof input === "string") return { stringValue: input };
  if (typeof input === "number") return Number.isInteger(input) ? { intValue: String(input) } : { doubleValue: input };
  if (typeof input === "boolean") return { boolValue: input };
  if (Array.isArray(input)) return { arrayValue: { values: input.map(value) } };
  if (input && typeof input === "object") return { kvlistValue: { values: attributes(input as Record<string, unknown>) } };
  return {};
}
function attributes(input: Record<string, unknown>) {
  return Object.entries(input).map(([key, item]) => ({ key, value: value(item) }));
}
function request(attrs: Record<string, unknown>, changes: Record<string, unknown> = {}) {
  return { resourceSpans: [{ resource: { attributes: attributes({ "service.name": "interop" }) }, scopeSpans: [{
    scope: { name: "interop-fixture", version: "1", attributes: attributes({ "scope.marker": "retained" }) },
    spans: [{ traceId, spanId, name: "operation", startTimeUnixNano: "1000000", endTimeUnixNano: "2000000",
      attributes: attributes(attrs), ...changes }],
  }] }] };
}
function parsed(attrs: Record<string, unknown>, changes: Record<string, unknown> = {}) {
  return parseOtlpRequest(request(attrs, changes))[0];
}
function stored(span: ReturnType<typeof parsed>) {
  return { id: span.spanId, run_id: span.traceId, parent_span_id: span.parentSpanId ?? null,
    name: span.name, span_type: span.spanType, status: span.status, input_payload: span.inputPayload ?? null,
    output_payload: span.outputPayload ?? null, start_time_ms: span.startTimeMs, end_time_ms: span.endTimeMs,
    input_tokens: span.inputTokens ?? null, output_tokens: span.outputTokens ?? null, attributes: JSON.stringify(span.attributes) };
}

// Independent minimal wire schema: field numbers come from the OTLP specification.
const wire = protobuf.parse(`syntax = "proto3";
message AnyValue { oneof value { string string_value=1; bool bool_value=2; int64 int_value=3; double double_value=4; ArrayValue array_value=5; KeyValueList kvlist_value=6; bytes bytes_value=7; } }
message ArrayValue { repeated AnyValue values=1; }
message KeyValueList { repeated KeyValue values=1; }
message KeyValue { string key=1; AnyValue value=2; }
message Resource { repeated KeyValue attributes=1; uint32 dropped_attributes_count=2; }
message Scope { string name=1; string version=2; repeated KeyValue attributes=3; uint32 dropped_attributes_count=4; }
message Event { fixed64 time_unix_nano=1; string name=2; repeated KeyValue attributes=3; uint32 dropped_attributes_count=4; }
message Link { bytes trace_id=1; bytes span_id=2; string trace_state=3; repeated KeyValue attributes=4; uint32 dropped_attributes_count=5; fixed32 flags=6; }
message Status { string message=2; int32 code=3; }
message Span { bytes trace_id=1; bytes span_id=2; string trace_state=3; bytes parent_span_id=4; string name=5; int32 kind=6; fixed64 start_time_unix_nano=7; fixed64 end_time_unix_nano=8; repeated KeyValue attributes=9; uint32 dropped_attributes_count=10; repeated Event events=11; uint32 dropped_events_count=12; repeated Link links=13; uint32 dropped_links_count=14; Status status=15; fixed32 flags=16; }
message ScopeSpans { Scope scope=1; repeated Span spans=2; string schema_url=3; }
message ResourceSpans { Resource resource=1; repeated ScopeSpans scope_spans=2; string schema_url=3; }
message Request { repeated ResourceSpans resource_spans=1; }`).root.lookupType("Request");

describe("telemetry interoperability", () => {
  test("structured and string-encoded GenAI conversations preserve nested values", () => {
    const messages = [{ role: "user", parts: [{ type: "text", content: "Inspect the checkout" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "call-1", name: "lookup", arguments: { active: false, count: 0, tags: [], nested: { label: "" } } }] }];
    const structured = parsed({ "gen_ai.operation.name": "chat", "gen_ai.input.messages": messages });
    const stringified = parsed({ "gen_ai.operation.name": "chat", "gen_ai.input.messages": JSON.stringify(messages) });
    expect(structured.normalized).toEqual(stringified.normalized);
    expect(structured.normalized).toMatchObject({ kind: "llm", userMessage: "Inspect the checkout" });
    expect(JSON.parse(String(structured.attributes["gen_ai.input.messages"]))).toEqual(messages);
  });

  test("nested arbitrary keys and scalar defaults survive without prototype changes", () => {
    const nested = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"value":0},"values":[false,0,"",[],{}]}');
    const span = parsed({ nested, "__proto__": "ignored-by-object-literal" });
    expect(JSON.parse(String(span.attributes.nested))).toEqual(nested);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const special = parsed(JSON.parse('{"__proto__":"own attribute"}'));
    expect(Object.hasOwn(special.attributes, "__proto__")).toBe(true);
    expect(special.attributes["__proto__"]).toBe("own attribute");
  });

  test("standard tool execution has captured arguments, result and error status", () => {
    const span = parsed({ "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "lookup_order",
      "gen_ai.tool.call.arguments": { order: { id: "A-42" }, retry: false }, "gen_ai.tool.call.result": { found: false } },
    { status: { code: 2 } });
    expect(span).toMatchObject({ name: "lookup_order", spanType: "TOOL_CALL", status: "ERROR" });
    expect(span.normalized).toEqual({ kind: "tool", name: "lookup_order", args: { order: { id: "A-42" }, retry: false }, result: { found: false }, resultIsError: true });
    expect(normalizeStoredSpan(stored(span))).toEqual({ inputPayload: span.inputPayload, outputPayload: span.outputPayload, normalized: span.normalized });
    const missing = parsed({ "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "lookup_order" });
    expect(missing.inputPayload).toBeUndefined();
    expect(missing.normalized).toMatchObject({ kind: "tool", args: undefined });
  });

  test("structured numeric loss stays unavailable before JSON flattening or protobuf persistence", () => {
    for (const numeric of [{ intValue: "9007199254740993" }, { intValue: "-9007199254740993" },
      { doubleValue: Infinity }, { doubleValue: -Infinity }, { doubleValue: NaN }]) {
      const body = request({ "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "refund" });
      body.resourceSpans[0].scopeSpans[0].spans[0].attributes.push({ key: "gen_ai.tool.call.arguments", value: {
        kvlistValue: { values: [{ key: "allowed", value: { boolValue: true } },
          { key: "details", value: { arrayValue: { values: [{ kvlistValue: { values: [{ key: "amount", value: numeric }] } }] } } }] },
      } });
      const binary = structuredClone(body) as any;
      binary.resourceSpans[0].scopeSpans[0].spans[0].traceId = Buffer.from(traceId, "hex");
      binary.resourceSpans[0].scopeSpans[0].spans[0].spanId = Buffer.from(spanId, "hex");
      for (const input of [body, decodeOtlpProtobuf(wire.encode(wire.fromObject(binary)).finish())]) {
        const span = parseOtlpRequest(input)[0];
        expect(span.inputPayload).toContain("[UNAVAILABLE]");
        const snapshot = snapshotRun({ id: traceId }, [stored(span)]);
        expect(snapshot.tools[0].arguments?.status).not.toBe("available");
        for (const rule of [
          { path: "details.0.amount", equals: "intValue" in numeric ? Number(numeric.intValue) : null },
          { path: "allowed", equals: true },
        ]) expect(evaluateRule({ kind: "toolArgument", name: "refund", match: "all", ...rule }, snapshot).status).toBe("inconclusive");
      }
    }
  });

  test("GenAI tool results preserve response and a single call identity", () => {
    const span = parsed({ "gen_ai.operation.name": "chat", "gen_ai.input.messages": [{ role: "tool", parts: [{ type: "tool_call_response", id: "call-1", response: { paid: true } }] }] });
    expect(span.normalized).toMatchObject({ kind: "llm", messages: [{ role: "tool", content: '{"paid":true}', toolCallId: "call-1" }] });
    const multiple = parsed({ "gen_ai.operation.name": "chat", "gen_ai.input.messages": [{ role: "tool", parts: [
      { type: "tool_call_response", id: "call-1", response: "first" }, { type: "tool_call_response", id: "call-2", response: "second" },
    ] }] });
    expect(multiple.normalized).toMatchObject({ kind: "llm", messages: [{ content: "first\nsecond" }] });
    if (multiple.normalized.kind === "llm") expect(multiple.normalized.messages[0].toolCallId).toBeUndefined();
  });

  test("agent invocation keeps root or nested parentage and wrappers stay non-LLM", () => {
    for (const parentSpanId of [undefined, "fedcba0987654321"]) {
      const span = parsed({ "gen_ai.operation.name": "invoke_agent", "gen_ai.conversation.id": "conversation-1" }, { parentSpanId });
      expect(span).toMatchObject({ spanType: "AGENT_ROOT", convoId: "conversation-1" });
      expect(span.parentSpanId).toBe(parentSpanId);
      expect(span.normalized.kind).toBe("other");
    }
    expect(parsed({ "openinference.span.kind": "CHAIN" }).spanType).toBe("TRACE");
    expect(parsed({ "openinference.span.kind": "AGENT" }).spanType).toBe("AGENT_ROOT");
  });

  test("OpenInference LLM messages, identity and measurements are usable after storage", () => {
    const span = parsed({ "openinference.span.kind": "LLM", "llm.model_name": "model-requested", "llm.response.model_name": "model-answered",
      "llm.provider": "provider", "llm.token_count.prompt": 12, "llm.token_count.completion": 8, "session.id": "session-1",
      "llm.input_messages.0.message.role": "system", "llm.input_messages.0.message.content": "Be precise",
      "llm.input_messages.2.message.role": "user", "llm.input_messages.2.message.content": "Earlier question",
      "llm.input_messages.10.message.role": "user", "llm.input_messages.10.message.content": "Inspect the checkout",
      "llm.output_messages.0.message.role": "assistant", "llm.output_messages.0.message.content": "It is paid" });
    expect(span).toMatchObject({ spanType: "LLM_GENERATION", model: "model-answered", provider: "provider", inputTokens: 12, outputTokens: 8, convoId: "session-1", outputPayload: "It is paid" });
    expect(span.normalized).toMatchObject({ kind: "llm", systemPrompt: "Be precise", userMessage: "Inspect the checkout", model: "model-answered",
      messages: [{ role: "user", content: "Earlier question" }, { role: "user", content: "Inspect the checkout" }] });
    expect(normalizeStoredSpan(stored(span)).normalized).toEqual(span.normalized);
    const snapshot = snapshotRun({ id: traceId, name: "OpenInference" }, [stored(span)]);
    expect(snapshot.input).toBe("Inspect the checkout");
    expect(snapshot.metrics).toMatchObject({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });
  });

  test("OpenInference tool payloads do not invent absent arguments", () => {
    const span = parsed({ "openinference.span.kind": "TOOL", "tool.name": "lookup_order", "input.value": '{"orderId":"A-42"}', "output.value": '{"paid":true}' });
    expect(span.normalized).toMatchObject({ kind: "tool", name: "lookup_order", args: { orderId: "A-42" }, result: { paid: true } });
    expect(span.inputPayload).toBe('{"orderId":"A-42"}');
    const missing = parsed({ "openinference.span.kind": "TOOL", "tool.name": "lookup_order" });
    expect(missing.inputPayload).toBeUndefined();
    expect(missing.normalized).toMatchObject({ kind: "tool", args: undefined });
  });

  test("OpenInference indexed output cannot promote a raw response envelope into final text", () => {
    const envelope = JSON.stringify({ choices: [{ message: { role: "assistant", content: null,
      tool_calls: [{ function: { name: "lookup_order", arguments: '{"id":"A-42"}' } }] }, finish_reason: "tool_calls" }] });
    for (const input of [{}, { "llm.input_messages.0.message.role": "user", "llm.input_messages.0.message.content": "Fetch the order" }]) {
      for (const output of [
        { "llm.output_messages.0.message.tool_calls.0.tool_call.function.name": "lookup_order",
          "llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments": '{"id":"A-42"}' },
        { "llm.output_messages.0.message.contents.0.message_content.type": "image",
          "llm.output_messages.0.message.contents.0.message_content.image.image.url": "https://example.invalid/output.png" },
      ]) {
        const span = parsed({ "openinference.span.kind": "LLM", "output.value": envelope,
          "llm.output_messages.0.message.role": "assistant", ...input, ...output });
        expect(span.outputPayload).toBeUndefined();
        expect(span.attributes["output.value"]).toBe(envelope);
        expect(normalizeStoredSpan(stored(span)).outputPayload).toBeUndefined();
        const snapshot = snapshotRun({ id: traceId }, [stored(span)]);
        expect(snapshot.output).toMatchObject({ value: null, complete: false });
        expect(evaluateRule({ kind: "output", operation: "contains", value: "lookup_order" }, snapshot).status).toBe("inconclusive");
      }
    }
  });

  test("OpenInference indexed text takes precedence over the raw response envelope", () => {
    for (const answer of ["The order is paid", ""]) {
      const envelope = JSON.stringify({ choices: [{ message: { role: "assistant", content: answer }, finish_reason: "stop" }] });
      const span = parsed({ "openinference.span.kind": "LLM", "output.value": envelope,
        "llm.output_messages.0.message.role": "assistant", "llm.output_messages.0.message.content": answer });
      expect(span.outputPayload).toBe(answer);
      expect(span.attributes["output.value"]).toBe(envelope);
      const snapshot = snapshotRun({ id: traceId }, [stored(span)]);
      expect(snapshot.output).toMatchObject({ value: answer, complete: true });
      expect(evaluateRule({ kind: "output", operation: "equals", value: answer }, snapshot).status).toBe("pass");
      expect(evaluateRule({ kind: "output", operation: "contains", value: "choices" }, snapshot).status).toBe("fail");
    }
  });

  test("OpenInference tool results retain correlation and tool-only assistant messages", () => {
    const span = parsed({ "openinference.span.kind": "LLM",
      "llm.input_messages.0.message.role": "assistant",
      "llm.input_messages.0.message.tool_calls.0.tool_call.id": "call-1",
      "llm.input_messages.0.message.tool_calls.0.tool_call.function.name": "lookup_order",
      "llm.input_messages.0.message.tool_calls.0.tool_call.function.arguments": '{"id":"A-42"}',
      "llm.input_messages.1.message.role": "tool", "llm.input_messages.1.message.content": "Paid",
      "llm.input_messages.1.message.tool_call_id": "call-1" });
    expect(span.normalized).toMatchObject({ kind: "llm", messages: [{ role: "assistant" }, { role: "tool", content: "Paid", toolCallId: "call-1" }] });
    if (span.normalized.kind === "llm") expect(JSON.stringify(span.normalized.messages[0].raw)).toContain("lookup_order");
  });

  test("multimodal OpenInference evidence cannot become a text-only evaluation input", () => {
    const span = parsed({ "openinference.span.kind": "LLM", "llm.input_messages.0.message.role": "user",
      "llm.input_messages.0.message.contents.0.message_content.type": "text",
      "llm.input_messages.0.message.contents.0.message_content.text": "Describe this image",
      "llm.input_messages.0.message.contents.1.message_content.type": "image",
      "llm.input_messages.0.message.contents.1.message_content.image.image.url": "https://example.invalid/image.png" });
    expect(span.normalized.kind).toBe("llm");
    expect(snapshotRun({ id: traceId }, [stored(span)]).input).toBeNull();
    expect(JSON.stringify(span.normalized)).toContain("example.invalid/image.png");
  });

  test("metadata-only and malformed optional fields retain known LLM identity", () => {
    for (const attrs of [
      { "openinference.span.kind": "LLM", "llm.model_name": "test" },
      { "gen_ai.operation.name": "chat", "gen_ai.input.messages": 123 },
      { "openinference.span.kind": "LLM", "llm.input_messages.0.message.role": false, "input.value": "__REDACTED__" },
    ]) expect(parsed(attrs).normalized.kind).toBe("llm");
    const metadata = parsed({ "openinference.span.kind": "LLM" });
    expect(metadata.inputPayload).toBeUndefined();
    expect(metadata.outputPayload).toBeUndefined();
  });

  test("explicit empty text outputs stay known while generated tool calls are not final answers", () => {
    for (const attrs of [
      { "gen_ai.operation.name": "chat", "gen_ai.output.messages": [{ role: "assistant", parts: [{ type: "text", content: "" }] }] },
      { "openinference.span.kind": "LLM", "llm.output_messages.0.message.role": "assistant", "llm.output_messages.0.message.content": "" },
    ]) expect(parsed(attrs).outputPayload).toBe("");
    for (const attrs of [
      { "gen_ai.operation.name": "chat", "gen_ai.output.messages": [{ role: "assistant", parts: [{ type: "tool_call", id: "call-1", name: "lookup", arguments: {} }] }] },
      { "openinference.span.kind": "LLM", "llm.output_messages.0.message.role": "assistant", "llm.output_messages.0.message.tool_calls.0.tool_call.function.name": "lookup" },
    ]) expect(parsed(attrs).outputPayload).toBeUndefined();
  });

  test("explicit local and established SDK conventions keep precedence", () => {
    expect(parsed({ "runphantom.span.kind": "trace", "gen_ai.operation.name": "chat", "openinference.span.kind": "LLM" }).spanType).toBe("TRACE");
    const ai = parsed({ "runphantom.span.kind": "llm_call", "openinference.span.kind": "LLM",
      "ai.prompt.messages": JSON.stringify([{ role: "user", content: "AI SDK wins" }]),
      "llm.input_messages.0.message.role": "user", "llm.input_messages.0.message.content": "OpenInference fallback" });
    expect(ai.normalized).toMatchObject({ kind: "llm", userMessage: "AI SDK wins" });
    expect(parsed({ "gen_ai.operation.name": "chat", "ai.prompt": "Raw prompt wins" }).normalized)
      .toMatchObject({ kind: "llm", userMessage: "Raw prompt wins" });
    const tool = parsed({ "ai.toolCall.name": "ai_tool", "ai.toolCall.args": '{"chosen":"ai"}',
      "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "genai_tool", "gen_ai.tool.call.arguments": '{"chosen":"genai"}' });
    expect(tool.normalized).toMatchObject({ kind: "tool", name: "ai_tool", args: { chosen: "ai" } });
  });

  test("retrieval and embedding attributes do not imply generation", () => {
    for (const kind of ["EMBEDDING", "RETRIEVER", "RERANKER", "GUARDRAIL", "EVALUATOR"]) {
      expect(parsed({ "openinference.span.kind": kind, "llm.model_name": "model", "gen_ai.input.messages": "[]" }).spanType).toBe("INTERNAL");
    }
    for (const operation of ["embeddings", "retrieval", "create_agent"]) {
      expect(parsed({ "gen_ai.operation.name": operation, "gen_ai.request.model": "model" }).spanType).toBe("INTERNAL");
    }
  });

  test("protobuf preserves structured attributes, scope metadata, bytes, flags and links", () => {
    const body = request({ "gen_ai.operation.name": "chat", "gen_ai.input.messages": [{ role: "user", parts: [{ type: "text", content: "Parity" }] }] });
    const resource = body.resourceSpans[0] as any;
    resource.schemaUrl = "https://schemas.example/resource/1";
    resource.resource.droppedAttributesCount = 1;
    const scope = resource.scopeSpans[0];
    scope.schemaUrl = "https://schemas.example/scope/1";
    scope.scope.droppedAttributesCount = 2;
    const span = scope.spans[0];
    Object.assign(span, { traceState: "vendor=value", flags: 257, droppedAttributesCount: 3, droppedEventsCount: 4, droppedLinksCount: 5,
      links: [{ traceId, spanId, traceState: "vendor=linked", flags: 1, droppedAttributesCount: 6, attributes: attributes({ linked: true }) }],
      events: [{ name: "event", timeUnixNano: "1500000", droppedAttributesCount: 7, attributes: attributes({ count: 0, enabled: false }) }] });
    span.attributes.push({ key: "blob", value: { bytesValue: "AP8B" } });
    const binary = structuredClone(body) as any;
    const binarySpan = binary.resourceSpans[0].scopeSpans[0].spans[0];
    binarySpan.traceId = Buffer.from(traceId, "hex"); binarySpan.spanId = Buffer.from(spanId, "hex");
    binarySpan.links[0].traceId = Buffer.from(traceId, "hex"); binarySpan.links[0].spanId = Buffer.from(spanId, "hex");
    binarySpan.attributes.at(-1).value.bytesValue = Buffer.from([0, 255, 1]);
    const decoded = decodeOtlpProtobuf(wire.encode(wire.fromObject(binary)).finish());
    expect(decoded.resourceSpans[0]).toMatchObject(resource);
    expect(parseOtlpRequest(decoded)).toEqual(parseOtlpRequest(body));
  });
});
