import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { snapshotRun } from "../src/evaluations/snapshot";
import { evaluateRule } from "../src/evaluations/rules";
import { parseRule, parseDatasetExport } from "../src/evaluations/validation";
import type { SnapshotSpan } from "../src/evaluations/protocol";
import { closeDb, getDrizzleDb } from "../src/db";
import { createEvaluationService, type EvaluationService } from "../src/evaluations/service";
import { EVALUATION_TOOLS, callEvaluationTool } from "../src/mcp/evaluation-tools";
import { buildRule, emptyRule } from "../app/src/components/evaluations/RuleEditor";

const run = { id: "argument-run", name: "Tool argument fixture" };
const root: SnapshotSpan = { id: "root", run_id: run.id, parent_span_id: null, name: "agent", span_type: "AGENT_ROOT",
  status: "OK", input_payload: "Refund this order", output_payload: "Refund requested", start_time_ms: 1, end_time_ms: 100, attributes: "{}" };
const call = (id: string, input: string | null, changes: Partial<SnapshotSpan> = {}): SnapshotSpan => ({
  ...root, id, parent_span_id: root.id, name: "refund", span_type: "TOOL_CALL", input_payload: input,
  output_payload: "{}", start_time_ms: 10, end_time_ms: 20, ...changes,
});
const args = (match: "any" | "all" = "all", changes: Record<string, unknown> = {}) => parseRule({
  kind: "toolArgument", name: "refund", path: "customer.id", equals: "customer-1", match, ...changes,
});

test("captured JSON-path numbers cannot pass after rounding while JSON syntax remains valid", () => {
  for (const [token, rounded] of [["9007199254740993", 9007199254740992], ["1e-400", 0], ["1e400", null], ["0.123456789012345678901", 0.12345678901234568]] as const) {
    const output = `{"id":${token}}`;
    const snapshot = snapshotRun(run, [{ ...root, output_payload: output }]);
    expect(evaluateRule({ kind: "jsonPath", path: "id", equals: rounded }, snapshot).status).toBe("inconclusive");
    const syntax = evaluateRule({ kind: "json" }, snapshot); expect(syntax.status).toBe("pass"); expect(syntax.actual).toBe(output);
  }
  for (const token of ["0.1", "1.00", "1e3"]) {
    const snapshot = snapshotRun(run, [{ ...root, output_payload: `{"id":${token}}` }]);
    expect(evaluateRule({ kind: "jsonPath", path: "id", equals: Number(token) }, snapshot).status).toBe("pass");
  }
});
const check = (calls: SnapshotSpan[], match: "any" | "all" = "all") => evaluateRule(args(match), snapshotRun(run, [root, ...calls]));
const good = '{"customer":{"id":"customer-1"},"amount":10}';
const bad = '{"customer":{"id":"other-customer"},"amount":10}';

describe("deterministic tool argument expectations", () => {
  test("right tool with wrong arguments fails while existing name checks retain their behavior", () => {
    const snapshot = snapshotRun(run, [root, call("wrong", bad)]);
    expect(evaluateRule({ kind: "tools", operation: "required", names: ["refund"] }, snapshot)).toMatchObject({ status: "pass", evaluatorVersion: "code:2" });
    expect(evaluateRule(args(), snapshot)).toMatchObject({ status: "fail", evaluatorVersion: "toolargs:1", spanIds: ["wrong"] });
    expect(check([call("correct", good)])).toMatchObject({ status: "pass", evaluatorVersion: "toolargs:1", spanIds: ["correct"] });
  });
  test("any/all truth tables retain decisive evidence and never pass an empty call set", () => {
    for (const match of ["any", "all"] as const) expect(check([], match).status).toBe("fail");
    const unknown = call("unknown", null);
    expect(check([call("good", good), call("bad", bad)], "any").status).toBe("pass");
    expect(check([call("good", good), call("bad", bad)], "all").status).toBe("fail");
    expect(check([call("good", good), unknown], "any").status).toBe("pass");
    expect(check([call("good", good), unknown], "all").status).toBe("inconclusive");
    expect(check([call("bad", bad), unknown], "any").status).toBe("inconclusive");
    expect(check([call("bad", bad), unknown], "all").status).toBe("fail");
    expect(check([unknown], "all").status).toBe("inconclusive");
  });
  test("unknown identities cannot prove absence or certify every call, but preserve a known witness", () => {
    const unknown = call("unknown-name", good, { attributes: null, unavailable: { input: false, output: false, attributes: true } });
    expect(check([unknown]).status).toBe("inconclusive");
    expect(check([call("good", good), unknown], "any").status).toBe("pass");
    expect(check([call("good", good), unknown], "all").status).toBe("inconclusive");
    expect(check([call("bad", bad), unknown], "all").status).toBe("fail");
  });
  test("missing, malformed, withheld, redacted and oversized evidence is inconclusive", () => {
    for (const input of [null, "", "not JSON", "[TRUNCATED]", "[REDACTED]", '{"password":"secret","customer":{"id":"customer-1"}}', JSON.stringify({ text: "x".repeat(20_000) })]) {
      expect(check([call("unknown", input)]).status).toBe("inconclusive");
    }
    expect(check([call("withheld", good, { unavailable: { input: true, output: false, attributes: false }, attributes: JSON.stringify({ "ai.toolCall.name": "refund", "ai.toolCall.args": good }) })]).status).toBe("inconclusive");
  });
  test("captures actual adapter input without inventing an empty argument object", () => {
    const snapshot = snapshotRun(run, [root, call("sdk", null, { attributes: JSON.stringify({ "ai.toolCall.name": "refund", "ai.toolCall.args": good }) })]);
    expect(snapshot.tools[0].arguments).toMatchObject({ status: "available", source: "adapterInput", value: JSON.parse(good) });
    expect(evaluateRule(args(), snapshot).status).toBe("pass");
    const empty = snapshotRun(run, [root, call("empty", null, { attributes: '{"ai.toolCall.name":"refund"}' })]);
    expect(evaluateRule(args("all", { path: "", equals: {} }), empty).status).toBe("inconclusive");
    expect(evaluateRule(args("all", { path: "", equals: {} }), snapshotRun(run, [root, call("empty-object", "{}")])).status).toBe("pass");
  });
  test("lossy numeric and bounded serialization never become known JSON values after persistence", () => {
    for (const input of ['{"customer":{"id":1e400}}', '{"customer":{"id":-1e400}}', '{"customer":{"id":' + JSON.stringify(Array.from({ length: 101 }, () => 1)) + '}}']) {
      const snapshot = JSON.parse(JSON.stringify(snapshotRun(run, [root, call("lossy", input)])));
      expect(snapshot.tools[0].arguments.status).toBe("truncated");
      expect(evaluateRule(args("all", { equals: null }), snapshot).status).toBe("inconclusive");
    }
  });
  test("captured rounded or underflowing numeric literals cannot pass their rounded expectation", () => {
    for (const token of ["9007199254740993", "-9007199254740993", "1e-400", "-1e-400", "0.100000000000000005", "3e-324", "1.7976931348623158e308"]) {
      const snapshot = snapshotRun(run, [root, call("rounded", `{"customer":{"id":${token}}}`)]);
      expect(snapshot.tools[0].arguments?.status).toBe("truncated");
      expect(evaluateRule(args("all", { equals: Number(token) }), JSON.parse(JSON.stringify(snapshot))).status).toBe("inconclusive");
    }
    for (const token of ["0.1", "1.00", "1e3", "1e+03", "0.0100e+1", "-0", "0e99999", "5e-324", "-5e-324", "1.7976931348623157e308", "9007199254740992", '"1e400"', JSON.stringify('escaped "1e400" and \\1e400')]) {
      const snapshot = snapshotRun(run, [root, call("exact", `{"customer":{"id":${token}}}`)]);
      expect(evaluateRule(args("all", { equals: JSON.parse(token) }), JSON.parse(JSON.stringify(snapshot))).status).toBe("pass");
    }
  });
  test("editor expectations reject numeric loss before request serialization", () => {
    for (const kind of ["toolArgument", "jsonPath"] as const) {
      for (const expected of ["1e400", '{"amount":1e400}', "[9007199254740993]", "1e-400", "0.100000000000000005"]) {
        expect(() => JSON.stringify(buildRule({ ...emptyRule(), kind, name: "refund", expected }))).toThrow();
      }
      for (const expected of ["0.1", "1.00", "1e3", '{"amount":0.1,"text":"1e400"}']) {
        const saved = parseRule(JSON.parse(JSON.stringify(buildRule({ ...emptyRule(), kind, name: "refund", expected }))));
        expect(saved).toMatchObject({ kind, equals: JSON.parse(expected) });
      }
    }
    for (const equals of [Infinity, -Infinity, NaN, { amount: Infinity }, [NaN]]) expect(() => args("all", { equals })).toThrow();
  });
  test("MCP rejects nonfinite expectations before forwarding update or import", async () => {
    const originalFetch = globalThis.fetch;
    let forwarded = false;
    globalThis.fetch = (async () => { forwarded = true; return Response.json({ ok: true }); }) as typeof fetch;
    try {
      for (const equals of [Infinity, { amount: -Infinity }, [NaN]]) {
        const cases = [{ name: "Refund", input: "Refund", rules: [{ kind: "toolArgument", name: "refund", path: "", equals, match: "all" }] }];
        for (const payload of [{ action: "update", datasetId: "fixture", expectedVersion: 1, cases }, { action: "import", data: { format: "runphantom-evaluations/v1", name: "Arguments", cases } }]) {
          const error = await callEvaluationTool("eval_dataset", payload, "http://127.0.0.1:1").then(() => null, error => error);
          expect(error).toMatchObject({ code: -32602 });
        }
      }
      expect(forwarded).toBe(false);
    } finally { globalThis.fetch = originalFetch; }
  });
  test("OpenInference redaction markers cannot certify arguments or task input", () => {
    for (const input of ['"__REDACTED__"', '{"customer":{"id":"__REDACTED__"}}']) {
      const snapshot = snapshotRun(run, [root, call("redacted", null, { attributes: JSON.stringify({ "openinference.span.kind": "TOOL", "tool.name": "refund", "input.value": input }) })]);
      expect(snapshot.tools[0].arguments?.status).toBe("redacted");
      expect(evaluateRule(args(), snapshot).status).toBe("inconclusive");
    }
    expect(snapshotRun(run, [{ ...root, input_payload: "__REDACTED__" }]).input).toBeNull();
  });
  test("checks complete failed calls but withholds every verdict for incomplete global traces", () => {
    const snapshot = snapshotRun(run, [root, call("failed", good, { status: "ERROR" })]);
    expect(evaluateRule(args(), snapshot).status).toBe("pass");
    expect(evaluateRule({ kind: "errors", max: 0 }, snapshot).status).toBe("fail");
    expect(check([call("good", good), call("pending", bad, { end_time_ms: null })], "any").status).toBe("inconclusive");
    expect(check([call("bad", bad), call("pending", good, { end_time_ms: null })], "all").status).toBe("inconclusive");
  });
  test("uses structural JSON equality and safe own-property paths", () => {
    const snapshot = snapshotRun(run, [root, call("json", '{"items":[{"n":1,"ok":true}],"empty":null}')]);
    expect(evaluateRule(args("all", { path: "items.0", equals: { ok: true, n: 1 } }), snapshot).status).toBe("pass");
    expect(evaluateRule(args("all", { path: "items.0.n", equals: "1" }), snapshot).status).toBe("fail");
    expect(evaluateRule(args("all", { path: "missing", equals: null }), snapshot).status).toBe("fail");
    expect(evaluateRule(args("all", { path: "empty", equals: null }), snapshot).status).toBe("pass");
    for (const unsafe of ["__proto__.x", "constructor", "prototype.x", "password", "x..y"]) expect(() => args("all", { path: unsafe })).toThrow();
    for (const changes of [{ match: "some" }, { name: "" }, { name: "[REDACTED]" }, { equals: undefined }, { extra: true }]) expect(() => args("all", changes)).toThrow();
  });
  test("old frozen snapshots remain unavailable and never obtain evidence from later mutations", () => {
    const snapshot = snapshotRun(run, [root, call("old", good)]);
    delete snapshot.tools[0].arguments;
    const frozen = JSON.stringify(snapshot);
    const later = snapshotRun(run, [root, call("old", bad)]);
    expect(evaluateRule(args(), later).status).toBe("fail");
    expect(evaluateRule(args(), JSON.parse(frozen)).status).toBe("inconclusive");
  });
  test("bounds argument evidence without dropping existing tool identities", () => {
    const snapshot = snapshotRun(run, [root, ...Array.from({ length: 40 }, (_, i) => call(`tool-${i}`, JSON.stringify({ customer: { id: "customer-1" }, padding: "x".repeat(3000) })))]);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(64 * 1024);
    expect(snapshot.tools).toHaveLength(40);
    expect(snapshot.toolsComplete).toBe(true);
    expect(evaluateRule({ kind: "tools", operation: "required", names: ["refund"] }, snapshot).status).toBe("pass");
    expect(evaluateRule(args("any"), snapshot).status).toBe("pass");
    expect(evaluateRule(args("all"), snapshot).status).toBe("inconclusive");
    expect(JSON.stringify(snapshotRun(run, [root, call("secret", '{"password":"never-export-this-value"}')]))).not.toContain("never-export-this-value");
  });
  test("optional argument metadata gives way to existing tool identity evidence at the snapshot limit", () => {
    const name = `refund-${"x".repeat(118)}`;
    const snapshot = snapshotRun(run, [root, ...Array.from({ length: 200 }, (_, i) => call(`tool-${i}-${"x".repeat(70)}`, null, { name }))]);
    expect(snapshot.tools).toHaveLength(200);
    expect(snapshot.toolsComplete).toBe(true);
    expect(evaluateRule({ kind: "tools", operation: "required", names: [name] }, snapshot).status).toBe("pass");
    expect(evaluateRule(args("all", { name }), snapshot).status).toBe("inconclusive");
  });
  test("portable definitions and the MCP schema expose explicit matching semantics", () => {
    const rule = args("any");
    const portable = parseDatasetExport({ format: "runphantom-evaluations/v1", name: "Arguments", cases: [{ name: "Refund", input: "Refund", rules: [rule] }] });
    expect(portable.cases[0].rules).toEqual([rule]);
    const schema = EVALUATION_TOOLS.find(tool => tool.name === "eval_dataset")!.inputSchema;
    const definitions = (schema.properties!.cases as { items: { properties: { rules: { items: { oneOf: unknown[] } } } } }).items.properties.rules.items.oneOf;
    expect(definitions).toContainEqual(expect.objectContaining({ required: ["kind", "name", "path", "equals", "match"], properties: expect.objectContaining({ kind: { const: "toolArgument" }, match: expect.objectContaining({ enum: ["any", "all"] }) }) }));
  });
  test("OpenInference evaluation snapshots retain the actual response model and unknown usage", () => {
    const generation: SnapshotSpan = { ...root, id: "generation", parent_span_id: root.id, span_type: "LLM_GENERATION", model: "stored-request-model", provider: "stored-provider", input_tokens: null, output_tokens: null,
      attributes: JSON.stringify({ "openinference.span.kind": "LLM", "llm.response.model_name": "actual-response", "llm.model_name": "requested-model", "llm.provider": "actual-provider" }) };
    const snapshot = snapshotRun(run, [root, generation]);
    expect(snapshot.models).toContainEqual(expect.objectContaining({ model: "actual-response", provider: "actual-provider", inputTokens: null, outputTokens: null, costUsd: null }));
    expect(snapshot.metrics).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null });
  });
});

describe("frozen tool argument experiments", () => {
  let directory: string, previousDb: string | undefined, service: EvaluationService | undefined;
  beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), "rp-tool-arguments-")); previousDb = process.env.RUNPHANTOM_DB_PATH;
    closeDb(); process.env.RUNPHANTOM_DB_PATH = path.join(directory, "evaluations.db"); getDrizzleDb();
  });
  afterEach(() => { service?.close(); service = undefined; });
  afterAll(() => {
    closeDb(); if (previousDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = previousDb;
    rmSync(directory, { recursive: true, force: true });
  });
  test("pending and input-mismatched checks retain the new evaluator version", async () => {
    service = createEvaluationService();
    const db = getDrizzleDb().$client;
    db.query("INSERT INTO runs(id,name,started_at,last_updated_at) VALUES('mismatch','mismatch',1,10)").run();
    db.query("INSERT INTO spans(run_id,id,name,span_type,status,input_payload,output_payload,start_time_ms,end_time_ms,attributes) VALUES('mismatch','root','agent','AGENT_ROOT','OK','Different task','Done',1,10,'{}')").run();
    const created = service.createDataset({ name: "Argument checks" });
    const revision = service.updateDataset(created.datasetId, { expectedVersion: 1, cases: [{ name: "Refund", input: "Refund this order", rules: [args()] }] });
    const started = service.start({ datasetId: revision.datasetId, name: "Different input", assignments: [{ caseId: revision.cases[0].id, runId: "mismatch" }] });
    expect(started.results[0].checks[0].evaluatorVersion).toBe("toolargs:1");
    let result = started;
    for (let i = 0; i < 100 && result.status !== "completed"; i++) { await new Promise(resolve => setTimeout(resolve, 5)); result = service.getExperiment(started.id); }
    expect(result.status).toBe("completed");
    expect(result.results[0]).toMatchObject({ inputMatch: "mismatch", status: "inconclusive" });
    expect(result.results[0].checks[0].evaluatorVersion).toBe("toolargs:1");
  });
});
