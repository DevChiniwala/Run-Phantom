import { gzipSync } from "node:zlib";
import protobuf from "protobufjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test, REPO_ROOT_PATH } from "./fixtures";
import { snapshot } from "./evaluation-fixture";

const wire = protobuf.parse(`syntax="proto3";
message Value { oneof value { string string_value=1; bool bool_value=2; int64 int_value=3; ArrayValue array_value=5; ObjectValue kvlist_value=6; } }
message ArrayValue { repeated Value values=1; } message ObjectValue { repeated Attribute values=1; }
message Attribute { string key=1; Value value=2; } message Scope { string name=1; repeated Attribute attributes=3; }
message Span { bytes trace_id=1; bytes span_id=2; bytes parent_span_id=4; string name=5; fixed64 start_time_unix_nano=7; fixed64 end_time_unix_nano=8; repeated Attribute attributes=9; }
message ScopeSpans { Scope scope=1; repeated Span spans=2; } message ResourceSpans { repeated ScopeSpans scope_spans=2; }
message Request { repeated ResourceSpans resource_spans=1; }`).root.lookupType("Request");

type Value = { stringValue: string } | { intValue: string } | { boolValue: boolean }
  | { arrayValue: { values: Value[] } } | { kvlistValue: { values: Array<{ key: string; value: Value }> } };
function otlpValue(value: unknown): Value {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") return { intValue: String(value) };
  if (typeof value === "boolean") return { boolValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(otlpValue) } };
  return { kvlistValue: { values: attrs(value as Record<string, unknown>) } };
}
function attrs(value: Record<string, unknown>) { return Object.entries(value).map(([key, value]) => ({ key, value: otlpValue(value) })); }

for (const family of ["OpenInference JSON", "GenAI gzipped protobuf"]) {
  test(`${family} reaches conversation, tool detail, evaluations and MCP`, async ({ page, request, runPhantom }) => {
    const genAi = family.startsWith("GenAI");
    const traceId = `f01234567890abcdef1234567890abc0${genAi ? "11" : "22"}`;
    const rootId = "f000000000000001", toolId = "f000000000000002", generationId = "f000000000000003";
    const stamp = (offset: number) => String((1_790_000_000_000n + BigInt(offset)) * 1_000_000n);
    const span = (spanId: string, name: string, attributes: Record<string, unknown>, from: number, to: number, parentSpanId?: string) => ({
      traceId, spanId, parentSpanId, name, startTimeUnixNano: stamp(from), endTimeUnixNano: stamp(to), attributes: attrs(attributes),
    });
    const body = { resourceSpans: [{ scopeSpans: [{ scope: { name: "interop-browser", attributes: attrs({ "scope.marker": "retained" }) }, spans: [
      span(rootId, `Interop ${family}`, genAi ? { "gen_ai.operation.name": "invoke_agent" } : { "openinference.span.kind": "AGENT" }, 0, 1000),
      span(toolId, "lookup", genAi ? {
        "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "lookup_order", "gen_ai.tool.call.arguments": { orderId: "A-42" }, "gen_ai.tool.call.result": { paid: true },
      } : { "openinference.span.kind": "TOOL", "tool.name": "lookup_order", "input.value": '{"orderId":"A-42"}', "output.value": '{"paid":true}' }, 20, 50, rootId),
      span(generationId, "model answer", genAi ? {
        "gen_ai.operation.name": "chat", "gen_ai.request.model": "interop-model", "gen_ai.provider.name": "fixture-provider",
        "gen_ai.input.messages": [{ role: "user", parts: [{ type: "text", content: "Inspect order A-42" }] }],
        "gen_ai.output.messages": [{ role: "assistant", parts: [{ type: "text", content: "Order A-42 is paid" }] }],
        "gen_ai.usage.input_tokens": 12, "gen_ai.usage.output_tokens": 8,
      } : { "openinference.span.kind": "LLM", "llm.model_name": "interop-model", "llm.provider": "fixture-provider",
        "llm.input_messages.0.message.role": "user", "llm.input_messages.0.message.content": "Inspect order A-42",
        "llm.output_messages.0.message.role": "assistant", "llm.output_messages.0.message.content": "Order A-42 is paid",
        "llm.token_count.prompt": 12, "llm.token_count.completion": 8 }, 100, 800, rootId),
    ] }] }] };
    let response;
    if (genAi) {
      const binary = { resourceSpans: body.resourceSpans.map((resource) => ({ scopeSpans: resource.scopeSpans.map((scope) => ({
        ...scope, spans: scope.spans.map((span) => ({ ...span, traceId: Buffer.from(span.traceId, "hex"), spanId: Buffer.from(span.spanId, "hex"),
          parentSpanId: span.parentSpanId ? Buffer.from(span.parentSpanId, "hex") : undefined })),
      })) })) };
      response = await request.post(`${runPhantom.url}/v1/traces`, { headers: { "content-type": "application/x-protobuf", "content-encoding": "gzip" },
        data: gzipSync(wire.encode(wire.fromObject(binary)).finish()) });
      expect(response.headers()["content-type"]).toContain("application/x-protobuf");
    } else response = await request.post(`${runPhantom.url}/v1/traces`, { data: body });
    expect(response.status()).toBe(200);

    const captured = await snapshot(request, runPhantom.url, traceId);
    expect(captured.input).toBe("Inspect order A-42");
    expect(captured.output.value).toBe("Order A-42 is paid");
    expect(captured.metrics).toMatchObject({ inputTokens: 12, outputTokens: 8, totalTokens: 20, toolCalls: 1 });
    const toolResponse = await request.get(`${runPhantom.url}/api/spans/${toolId}?run_id=${traceId}`);
    expect(await toolResponse.json()).toMatchObject({ name: "lookup_order", span_type: "TOOL_CALL", input_preview: '{"orderId":"A-42"}' });

    await page.goto(`${runPhantom.url}/runs/${traceId}`);
    await expect(page.getByText("Inspect order A-42", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Order A-42 is paid", { exact: true }).first()).toBeVisible();
    await page.getByRole("tab", { name: "Span Tree", exact: true }).click();
    await page.locator(`[data-span-row="${toolId}"]`).click();
    await expect(page.getByText("A-42", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("orderId", { exact: false }).first()).toBeVisible();

    const client = new Client({ name: "interop-browser-test", version: "1" });
    const transport = new StdioClientTransport({ command: "bun", args: ["src/index.ts", "mcp"], cwd: REPO_ROOT_PATH,
      env: { ...getDefaultEnvironment(), RUNPHANTOM_URL: runPhantom.url }, stderr: "pipe" });
    try {
      await client.connect(transport);
      const evidence = await client.callTool({ name: "get_span_payload", arguments: { span_id: toolId, target: "input" } });
      expect(JSON.stringify(evidence)).toContain("A-42");
      expect(JSON.stringify(evidence)).toContain("orderId");
    } finally { await client.close(); }
  });
}
