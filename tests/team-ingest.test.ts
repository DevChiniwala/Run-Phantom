import { describe, expect, test } from "bun:test";
import * as protobuf from "protobufjs";
import { normalizeTeamIngest, redactTeamText } from "../src/team/ingest";
import { setActiveRedactionPolicy, resetActiveRedactionPolicy } from "../src/verification/redaction";
import { TEAM_LIMITS as L } from "../src/team/protocol";

const secret = "rp_team_ingest_" + "a".repeat(43);
const id = "1".repeat(32), spanId = "2".repeat(16);
function capture(attributes: unknown[], additions: Record<string, unknown> = {}) {
  return { traceId: id, spanId, name: "tool", startTimeUnixNano: "0", endTimeUnixNano: "1000000", attributes, ...additions };
}
function normalize(spans: unknown[]) {
  return normalizeTeamIngest(Buffer.from(JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] })), "json", secret);
}
const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
const proto = protobuf.parse(`syntax="proto3";
  message AnyValue { oneof value { string string_value=1; int64 int_value=3; double double_value=4; ArrayValue array_value=5; KeyValueList kvlist_value=6; } }
  message ArrayValue { repeated AnyValue values=1; }
  message KeyValue { string key=1; AnyValue value=2; }
  message KeyValueList { repeated KeyValue values=1; }
  message Status { int32 code=3; }
  message Span { bytes trace_id=1; bytes span_id=2; string name=5; fixed64 start_time_unix_nano=7; fixed64 end_time_unix_nano=8; repeated KeyValue attributes=9; Status status=15; }
  message ScopeSpans { repeated Span spans=2; }
  message ResourceSpans { repeated ScopeSpans scope_spans=2; }
  message Export { repeated ResourceSpans resource_spans=1; }
`).root.lookupType("Export");

describe("team ingestion admission and fixed redaction", () => {
  test("redacts credential canaries across raw, nested JSON, URL, key and transport forms regardless of ambient policy", () => {
    const canary = "REVIEW_CANARY_PASSWORD";
    setActiveRedactionPolicy({ isSensitiveKey: () => false });
    try {
      const result = normalize([capture([
        attr("runphantom.input", JSON.stringify({ password: canary, child: { safe: secret }, url: "https://u:URL_PASSWORD@example.test/?access_token=QUERY_CANARY" })),
        attr("runphantom.output", "echo " + secret + " and Bearer HEADER_CANARY"),
        attr("Authorization", "Bearer ATTR_CANARY"),
        attr("nested", JSON.stringify({ child: JSON.stringify({ apiKey: "EMBEDDED_CANARY" }) })),
        attr(secret, "safe"),
        attr("provider-token", "sk-ant-" + "b".repeat(28)),
      ])]);
      const text = JSON.stringify(result);
      for (const value of [canary, secret, "URL_PASSWORD", "QUERY_CANARY", "HEADER_CANARY", "ATTR_CANARY", "EMBEDDED_CANARY", "sk-ant-"]) expect(text).not.toContain(value);
      expect(result.captures[0].span.unavailable).toEqual({ input: true, output: true, attributes: true });
      expect(result.captures[0]).not.toHaveProperty("normalized");
    } finally { resetActiveRedactionPolicy(); }
  });

  test("lossy, truncated and duplicate-key JSON never falls back to an unsanitized duplicate", () => {
    for (const input of [
      '{"n":9007199254740993,"password":"REVIEW_CANARY_PASSWORD"}',
      '{"password":"REVIEW_CANARY_PASSWORD"',
      '{"x":{"password":"REVIEW_CANARY_PASSWORD"},"x":"safe"}',
      '{"x":{"password":"REVIEW_CANARY_PASSWORD"},"\\u0078":"safe"}',
    ]) {
      expect(redactTeamText(input)).toBe("[UNAVAILABLE]");
      const span = normalize([capture([attr("runphantom.input", input)])]).captures[0].span;
      expect(JSON.stringify(span)).not.toContain("REVIEW_CANARY_PASSWORD");
      expect(span.unavailable.input).toBe(true);
    }
    const harmless = '{ "order": "A-42", "amount": 2 }';
    expect(redactTeamText(harmless)).toBe(harmless);
  });

  test("byte-valued attributes cannot retain encoded copies of recognized credentials", () => {
    const encoded = Buffer.from(secret).toString("base64");
    const span = normalize([capture([{ key: "encoded", value: { bytesValue: encoded } }])]).captures[0].span;
    expect(JSON.stringify(span)).not.toContain(encoded);
    expect(span.unavailable.attributes).toBe(true);
  });

  test("unused resource and scope metadata is validated without credential processing", () => {
    const encoded = Buffer.from("https://example.test/?" + Array.from({ length: 30000 }, (_, n) => `password${n}=canary`).join("&")).toString("base64");
    const metadata = { attributes: [{ key: "encoded", value: { bytesValue: encoded } }] };
    const used = { scopeSpans: [{ spans: [capture([attr("runphantom.output", "visible")])] }] };
    for (const unused of [
      { resource: metadata, scopeSpans: [{ spans: [] }] },
      { scopeSpans: [{ scope: metadata, spans: [] }] },
    ]) {
      for (const mixed of [false, true]) {
        const bytes = Buffer.from(JSON.stringify({ resourceSpans: mixed ? [unused, used] : [unused] }));
        expect(bytes.length).toBeLessThan(L.INGEST_WIRE_BYTES);
        const start = performance.now();
        const batch = normalizeTeamIngest(bytes, "json", secret);
        expect(performance.now() - start).toBeLessThan(1000);
        expect(batch.captures).toHaveLength(mixed ? 1 : 0);
        expect(JSON.stringify(batch)).not.toContain(encoded);
        if (mixed) expect(batch.captures[0].span.outputPayload).toBe("visible");
      }
    }
    expect(() => normalizeTeamIngest(Buffer.from(JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: "invalid", value: { boolValue: "wrong" } }] }, scopeSpans: [] }] })), "json", secret)).toThrow();
  });

  test("JSON/protobuf AnyValue parity preserves unavailable integers, missing timings and explicit zero", () => {
    const attrs = [{ key: "gen_ai.operation.name", value: { stringValue: "execute_tool" } }, { key: "gen_ai.tool.name", value: { stringValue: "charge" } }, { key: "gen_ai.tool.call.arguments", value: { kvlistValue: { values: [{ key: "amount", value: { intValue: "9007199254740993" } }] } } }];
    const json = normalize([capture(attrs)]).captures[0].span;
    const binarySpan = { traceId: Buffer.from(id, "hex"), spanId: Buffer.from(spanId, "hex"), name: "tool", startTimeUnixNano: "0", endTimeUnixNano: "1000000", attributes: attrs };
    const encoded = proto.encode(proto.fromObject({ resourceSpans: [{ scopeSpans: [{ spans: [binarySpan] }] }] })).finish();
    const binary = normalizeTeamIngest(encoded, "protobuf", secret).captures[0].span;
    expect(binary).toEqual(json);
    expect(binary.startedAt).toBe(0);
    expect(binary.inputPayload).toContain("[UNAVAILABLE]");
    const missing = proto.encode(proto.fromObject({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: Buffer.from(id, "hex"), spanId: Buffer.from(spanId, "hex"), name: "untimed" }] }] }] })).finish();
    expect(normalizeTeamIngest(missing, "protobuf", secret).captures[0].span).toMatchObject({ startedAt: null, endedAt: null, durationMs: null, status: "UNSET" });
  });

  test("count, expanded bytes, attribute, depth, node and span storage limits reject whole batches", () => {
    expect(() => normalizeTeamIngest(new Uint8Array(L.INGEST_EXPANDED_BYTES + 1), "json", secret)).toThrow();
    expect(() => normalize(Array.from({ length: L.INGEST_SPANS + 1 }, () => capture([])))).toThrow();
    expect(() => normalize([capture(Array.from({ length: L.SPAN_ATTRIBUTES + 1 }, (_, n) => attr(`field${n}`, "value")))])).toThrow();
    let value: unknown = { stringValue: "bottom" };
    for (let n = 0; n < 25; n++) value = { arrayValue: { values: [value] } };
    expect(() => normalize([capture([{ key: "nested", value }])])).toThrow();
    expect(() => normalize([capture([{ key: "wide", value: { arrayValue: { values: Array.from({ length: L.INGEST_NODES }, () => ({ boolValue: true })) } } }])])).toThrow();
    expect(() => normalize([capture([attr("runphantom.input", "x".repeat(L.SPAN_BYTES))])])).toThrow();
    expect(() => normalize([capture([], { traceId: "0".repeat(32) })])).toThrow();
    expect(() => normalize([capture([]), capture([], { spanId: "invalid" })])).toThrow();
    expect(normalizeTeamIngest(Buffer.from("{}"), "json", secret).captures).toEqual([]);
    expect(() => normalizeTeamIngest(Buffer.from('{"projectId":"foreign","resourceSpans":[]}'), "json", secret)).toThrow();
  });

  test("malformed AnyValue scalar types reject and exporter-dropped evidence remains unavailable", () => {
    expect(() => normalize([capture([{ key: "broken", value: { stringValue: { password: "CANARY" } } }])])).toThrow();
    const span = normalize([capture([attr("runphantom.input", '{"id":"A"}')], { droppedAttributesCount: 1 })]).captures[0].span;
    expect(span.unavailable.input).toBe(true);
    expect(span.unavailable.attributes).toBe(true);
  });

  test("unknown status values cannot become invented successful captures", () => {
    for (const status of ["OK", 1, [], { code: "not-an-OTLP-status" }, { code: 3 }, { code: {} }, { code: 1, message: 42 }]) {
      expect(() => normalize([capture([], { status })])).toThrow();
    }
    expect(normalize([capture([], { status: { code: "STATUS_CODE_ERROR" } })]).captures[0].span.status).toBe("ERROR");
  });

  test("long ambiguous JWT-shaped tokens are bounded before the shared credential recognizer", () => {
    expect(redactTeamText("eyJ".repeat(20000))).toBe("[UNAVAILABLE]");
    expect(redactTeamText("x".repeat(60000))).toBe("x".repeat(60000));
  });

  test("raw effective capture limits precede parser expansion and inherited attribute amplification", () => {
    expect(() => normalize([capture([attr("runphantom.input", "eyJ".repeat(300000))])])).toThrow();
    const body = { resourceSpans: [{ resource: { attributes: [attr("shared", "x".repeat(30000))] }, scopeSpans: [{ spans: Array.from({ length: 40 }, (_, n) => capture([], { spanId: (n + 1).toString(16).padStart(16, "0") })) }] }] };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(L.INGEST_EXPANDED_BYTES);
    expect(() => normalizeTeamIngest(Buffer.from(JSON.stringify(body)), "json", secret)).toThrow();
  });
});
