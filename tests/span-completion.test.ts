import { describe, expect, test } from "bun:test";
import { parseOtlpRequest } from "../src/parse";
import { snapshotRun } from "../src/evaluations/snapshot";
import { evaluateRule } from "../src/evaluations/rules";
import { compareCapturedRuns, type CapturedComparisonSpan } from "../src/run-comparison";
import { outputCompletionEvidence } from "../src/spans/completion";
import { startTeamFixture } from "./helpers/team-server";
import type { Check, Project, SessionResponse, Span } from "../src/team/protocol";

const runId = "1".repeat(32), spanId = "2".repeat(16);
const message = (finish_reason?: string) => ({ role: "assistant", parts: [{ type: "text", content: "Hello" }], ...(finish_reason === undefined ? {} : { finish_reason }) });
function request(extra: Record<string, unknown>) {
  const attrs = { "gen_ai.operation.name": "chat", "gen_ai.request.model": "model-a", "gen_ai.provider.name": "local",
    "gen_ai.input.messages": JSON.stringify([{ role: "user", parts: [{ type: "text", content: "Question" }] }]),
    "gen_ai.output.messages": JSON.stringify([message()]), ...extra };
  return { resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: runId, spanId, name: "chat", startTimeUnixNano: "1000000", endTimeUnixNano: "2000000", status: { code: 1 },
    attributes: Object.entries(attrs).map(([key, value]) => ({ key, value: typeof value === "boolean" ? { boolValue: value } : { stringValue: typeof value === "string" ? value : JSON.stringify(value) } })),
  }] }] }] };
}
function captured(extra: Record<string, unknown>): CapturedComparisonSpan {
  const span = parseOtlpRequest(request(extra))[0];
  return { id: span.spanId, run_id: span.traceId, parent_span_id: null, name: span.name, span_type: span.spanType, status: span.status,
    input_payload: span.inputPayload ?? null, output_payload: span.outputPayload ?? null, attributes: JSON.stringify(span.attributes),
    start_time_ms: span.startTimeMs, end_time_ms: span.endTimeMs, duration_ms: span.endTimeMs - span.startTimeMs,
    model: span.model ?? null, provider: span.provider ?? null, input_tokens: 0, output_tokens: 0 };
}
const compare = (row: CapturedComparisonSpan) => compareCapturedRuns({ id: runId, name: "before", spans: [row] }, { id: "3".repeat(32), name: "after", spans: [{ ...row, run_id: "3".repeat(32) }] });

describe("captured streaming output completion", () => {
  test("an ended OK partial stream stays inspectable without certifying output or equality", () => {
    const row = captured({ "gen_ai.is_streaming": true, "gen_ai.output.messages": JSON.stringify([message("")]) });
    const snapshot = snapshotRun({ id: runId }, [row]);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.output).toMatchObject({ value: "Hello", complete: false, spanId });
    expect(evaluateRule({ kind: "output", operation: "equals", value: "Hello" }, snapshot)).toMatchObject({ status: "inconclusive", evaluatorVersion: "code:2" });
    expect(snapshot.metrics.durationMs).toBe(1);
    expect(snapshot.metrics.totalTokens).toBe(0);
    const comparison = compare(row);
    expect(comparison.counts).toMatchObject({ unchanged: 0, unavailable: 1 });
    expect(comparison.rows[0].fields.find(field => field.name === "output_payload")).toMatchObject({ state: "unavailable", baseline: { unavailable: "incomplete" } });
    expect(comparison.rows[0].fields.find(field => field.name === "duration_ms")?.state).toBe("same");
    expect(row.output_payload).toBe("Hello");
  });

  test("finished streams and generic spans without finish markers retain normal output proof", () => {
    for (const attrs of [
      {}, { "gen_ai.is_streaming": false },
      { "gen_ai.is_streaming": true, "gen_ai.response.finish_reasons": ["stop"], "gen_ai.output.messages": JSON.stringify([message("stop")]) },
    ]) {
      const row = captured(attrs);
      const snapshot = snapshotRun({ id: runId }, [row]);
      expect(snapshot.output).toMatchObject({ value: "Hello", complete: true });
      expect(evaluateRule({ kind: "output", operation: "equals", value: "Hello" }, snapshot).status).toBe("pass");
      expect(compare(row).counts.unchanged).toBe(1);
      expect(snapshotRun({ id: runId }, [{ ...row, input_tokens: null, output_tokens: null }]).output.complete).toBe(true);
    }
  });

  test("one finished choice does not certify another explicitly unfinished captured choice", () => {
    const row = captured({ "gen_ai.is_streaming": true, "gen_ai.response.finish_reasons": ["stop"], "gen_ai.output.messages": JSON.stringify([message("stop"), message("")]) });
    expect(snapshotRun({ id: runId }, [row]).output.complete).toBe(false);
    expect(compare(row).counts.unchanged).toBe(0);
  });

  test("explicit selection cannot bypass streamed completion evidence withheld with attributes", () => {
    const row = captured({ "gen_ai.is_streaming": true });
    const snapshot = snapshotRun({ id: runId }, [{ ...row, unavailable: { input: false, output: false, attributes: true } }], spanId);
    expect(snapshot.output).toMatchObject({ value: "Hello", complete: false });
  });

  test("missing, malformed, withheld and partially finished choices never provide completion proof", () => {
    for (const messages of [[], null, "broken JSON", [message("")], [message()], [message("stop"), message()], [message("stop"), null], [message("[REDACTED]")]]) {
      expect(outputCompletionEvidence({ "gen_ai.is_streaming": true, "gen_ai.response.finish_reasons": '["stop"]', "gen_ai.output.messages": messages })).toBe("unconfirmed");
    }
    for (const reasons of [undefined, [], "", [""], ["stop", ""], ["[UNAVAILABLE]"], [null], "not JSON"]) {
      expect(outputCompletionEvidence({ "gen_ai.is_streaming": true, "gen_ai.response.finish_reasons": reasons })).toBe("unconfirmed");
    }
    expect(outputCompletionEvidence({ "gen_ai.is_streaming": "true", "gen_ai.response.finish_reasons": '["length"]' })).toBe("confirmed");
    expect(outputCompletionEvidence({ "gen_ai.is_streaming": true, "gen_ai.output.messages": [message("tool_calls")] })).toBe("confirmed");
    expect(outputCompletionEvidence({ "gen_ai.is_streaming": true, "gen_ai.output.messages": [message("stop")] }, false)).toBe("unconfirmed");
    expect(outputCompletionEvidence({ "gen_ai.is_streaming": "false", "gen_ai.output.messages": [message("")] })).toBe("not-streaming");
  });

  test("explicit requested choice counts cannot be certified from a smaller captured subset", () => {
    for (const key of ["gen_ai.request.choice.count", "gen_ai.request.n"]) {
      const attrs = { "gen_ai.is_streaming": true, [key]: 2, "gen_ai.response.finish_reasons": ["stop"] };
      expect(outputCompletionEvidence(attrs)).toBe("unconfirmed");
      expect(outputCompletionEvidence({ ...attrs, "gen_ai.output.messages": [message("stop")] })).toBe("unconfirmed");
      expect(outputCompletionEvidence({ ...attrs, "gen_ai.response.finish_reasons": ["stop", "stop"], "gen_ai.output.messages": [message("stop"), message("stop")] })).toBe("confirmed");
      expect(outputCompletionEvidence({ ...attrs, "gen_ai.response.finish_reasons": ["stop", "stop"] })).toBe("confirmed");
      expect(outputCompletionEvidence({ ...attrs, [key]: "[UNAVAILABLE]" })).toBe("unconfirmed");
    }
  });

  test("ambiguous JSON, conflicting finish channels and withheld attributes cannot restore output proof", () => {
    expect(outputCompletionEvidence({ "gen_ai.is_streaming": true, "gen_ai.output.messages": '[{"finish_reason":"","finish_reason":"stop"}]' })).toBe("unconfirmed");
    expect(outputCompletionEvidence({ "gen_ai.is_streaming": true, "gen_ai.output.messages": '[{"finish_reason":"","finish_\\u0072eason":"stop"}]' })).toBe("unconfirmed");
    for (const reasons of [["stop", ""], ["stop", "stop"], null, []]) {
      expect(outputCompletionEvidence({ "gen_ai.is_streaming": true, "gen_ai.output.messages": [message("stop")], "gen_ai.response.finish_reasons": reasons })).toBe("unconfirmed");
    }
    const base = captured({});
    for (const attributes of ['{"gen_ai.is_streaming":true,"gen_ai.is_streaming":false}', JSON.stringify({ "gen_ai.is_streaming": true, padding: "x".repeat(65536) })]) {
      expect(snapshotRun({ id: runId }, [{ ...base, attributes }], spanId).output.complete).toBe(false);
      expect(compare({ ...base, attributes }).counts.unchanged).toBe(0);
    }
    const snapshot = snapshotRun({ id: runId }, [{ ...base, attributes: null, unavailable: { attributes: true } }], spanId);
    expect(snapshot.output).toMatchObject({ value: "Hello", complete: false });
  });

  test("an explicitly withheld or malformed streaming marker is unknown rather than non-streaming", () => {
    for (const marker of [null, "[REDACTED]", "[UNAVAILABLE]", 0, 1, {}, "invalid"]) {
      const row = captured({ "gen_ai.is_streaming": marker });
      expect(snapshotRun({ id: runId }, [row], spanId).output).toMatchObject({ value: "Hello", complete: false });
      expect(compare(row).counts.unchanged).toBe(0);
    }
  });

  test("lossy numeric choice counts cannot become valid completion proof after JSON parsing", () => {
    const attributes = '{"gen_ai.is_streaming":true,"gen_ai.request.n":1.0000000000000000001,"gen_ai.response.finish_reasons":["stop"]}';
    expect(outputCompletionEvidence(attributes)).toBe("unconfirmed");
    const row = { ...captured({}), attributes };
    expect(snapshotRun({ id: runId }, [row], spanId).output.complete).toBe(false);
    expect(compare(row).counts.unchanged).toBe(0);
  });

  test("actual team OTLP ingestion retains partial text while saved checks withhold its output verdict", async () => {
    const fixture = await startTeamFixture("stream-completion", process.env.RUNPHANTOM_TEAM_TEST_BINARY);
    try {
      const setup = await fetch(`${fixture.url}/api/team/setup`, { method: "POST", headers: { Origin: fixture.url, "Content-Type": "application/json" }, body: JSON.stringify({ setupCode: fixture.setupCode, email: "stream@example.test", password: "Captured stream fixture 42!" }) });
      expect(setup.status).toBe(201);
      const session = await setup.json() as Extract<SessionResponse, { authenticated: true }>;
      const headers = { Cookie: setup.headers.get("set-cookie")!.split(";")[0], Origin: fixture.url, "Content-Type": "application/json", "X-RunPhantom-CSRF": session.csrfToken };
      const post = (path: string, body: unknown) => fetch(`${fixture.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      const created = await post("/api/team/projects", { name: "Stream evidence" }); expect(created.status).toBe(201);
      const project = await created.json() as Project, root = `/api/team/projects/${project.id}`;
      const issued = await post(`${root}/keys`, { label: "Stream exporter" }); expect(issued.status).toBe(201);
      const { token } = await issued.json() as { token: string };
      const variants = [
        {},
        { "gen_ai.is_streaming": true, "gen_ai.output.messages": JSON.stringify([message("")]) },
        { "gen_ai.is_streaming": true, "gen_ai.output.messages": JSON.stringify([message("stop")]), "gen_ai.response.finish_reasons": ["stop"] },
        {},
      ];
      const ids = variants.map((_, n) => (n + 1).toString(16).repeat(32));
      for (const [index, attrs] of variants.entries()) {
        const body = request(attrs); body.resourceSpans[0].scopeSpans[0].spans[0].traceId = ids[index];
        const ingested = await fetch(`${fixture.url}/api/team/ingest/v1/traces`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
        expect(ingested.status).toBe(200);
      }
      const rawResponse = await fetch(`${fixture.url}${root}/runs/${ids[1]}/spans/${spanId}`, { headers }); expect(rawResponse.status).toBe(200);
      const raw = await rawResponse.json() as Span;
      expect(raw).toMatchObject({ outputPayload: "Hello", status: "OK", endedAt: 2, unavailable: { output: false } });
      expect(JSON.parse(raw.attributes!)["gen_ai.output.messages"]).toContain('"finish_reason":""');
      const response = await post(`${root}/checks`, { name: "Stream completion check", referenceRunId: ids[0], candidateRunIds: ids.slice(1), rules: [{ kind: "output", operation: "equals", value: "Hello" }] });
      expect(response.status).toBe(201);
      const check = await response.json() as Check;
      expect(check.results.map(result => result.ruleResults[0].status)).toEqual(["inconclusive", "pass", "pass"]);
      expect(check.results[0].snapshot.output).toMatchObject({ value: "Hello", complete: false });
      expect(check.results[0].snapshot.complete).toBe(true);
      const saved = await fetch(`${fixture.url}${root}/checks/${check.id}`, { headers });
      expect(saved.status).toBe(200);
      expect((await saved.json() as Check).results[0].ruleResults[0]).toMatchObject({ status: "inconclusive", evaluatorVersion: "code:2" });
    } finally { await fixture.close(); }
  }, 30_000);
});
