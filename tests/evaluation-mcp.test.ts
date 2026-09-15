import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { closeDb, upsertRun, insertSpan } from "../src/db";
import { createServer } from "../src/server";
import { runMcpServer, type McpServerHandle } from "../src/mcp/index";
import type { DatasetRevision, DatasetExport, Experiment, Comparison, Review, Snapshot } from "../src/evaluations/protocol";

let client: Client;
let mcp: McpServerHandle;
let server: import("node:http").Server;
let directory: string;
let oldDb: string | undefined;

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "rp-evaluation-mcp-"));
  oldDb = process.env.RUNPHANTOM_DB_PATH;
  closeDb();
  process.env.RUNPHANTOM_DB_PATH = path.join(directory, "evaluations.db");
  ({ server } = await createServer(0));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcp = await runMcpServer({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, transport: serverTransport });
  client = new Client({ name: "evaluation-mcp-regression", version: "1.0.0" });
  await client.connect(clientTransport);
});
afterEach(async () => {
  await client?.close();
  await mcp?.close();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb();
  if (oldDb === undefined) delete process.env.RUNPHANTOM_DB_PATH; else process.env.RUNPHANTOM_DB_PATH = oldDb;
  rmSync(directory, { recursive: true, force: true });
});
async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const response = await client.callTool({ name, arguments: args });
  return JSON.parse((response.content as Array<{ text: string }>)[0].text) as T;
}
async function expectError(name: string, args: Record<string, unknown>, contains?: string) {
  try { await call(name, args); throw new Error("Expected MCP argument error"); }
  catch (error) { expect(error).toMatchObject({ code: ErrorCode.InvalidParams }); if (contains) expect(String(error)).toContain(contains); }
}
function seedRun(id: string, output = "paid", input = "Complete checkout", tokens = 10) {
  upsertRun({ id, name: id, started_at: 1000, last_updated_at: 1100 });
  insertSpan({ id: `${id}-root`, run_id: id, name: "Checkout agent", span_type: "AGENT_ROOT", status: "OK", input_payload: input, output_payload: output, start_time_ms: 1000, end_time_ms: 1100, duration_ms: 100, attributes: "{}" });
  insertSpan({ id: `${id}-generation`, run_id: id, parent_span_id: `${id}-root`, name: "Response generation", span_type: "LLM_GENERATION", status: "OK", input_payload: input, output_payload: output, start_time_ms: 1010, end_time_ms: 1090, duration_ms: 80, input_tokens: tokens, output_tokens: 5, model: "fixture-model", provider: "fixture-provider", attributes: JSON.stringify({ "gen_ai.usage.cost": 0.01 }) });
}
async function dataset() {
  seedRun("baseline");
  const created = await call<DatasetRevision>("eval_dataset", { action: "create", name: "Checkout regression" });
  return call<DatasetRevision>("eval_dataset", { action: "update", datasetId: created.datasetId, expectedVersion: 1, cases: [{ name: "Checkout result", sourceRunId: "baseline", rules: [{ kind: "output", operation: "equals", value: "paid" }] }] });
}
async function experiment(revision: DatasetRevision, runId: string, name: string) {
  const started = await call<Experiment>("eval_run", { action: "start", datasetId: revision.datasetId, version: revision.version, name, assignments: revision.cases.map(item => ({ caseId: item.id, runId })) });
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await call<Experiment>("eval_run", { action: "get", experimentId: started.id });
    if (current.status === "completed" || current.status === "cancelled") return current;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Experiment did not finish");
}

test("MCP repeated trials matches HTTP and keeps failed and unavailable captures in its denominator", async () => {
  const revision = await dataset();
  const first = await experiment(revision, "baseline", "First trial");
  seedRun("trial-failed", "declined"); seedRun("trial-unknown", "paid", "Different input");
  const second = await experiment(revision, "trial-failed", "Second trial");
  const third = await experiment(revision, "trial-unknown", "Third trial");
  const experimentIds = [first.id, second.id, third.id];
  const result = await call<import("../src/evaluations/trials").TrialAnalysis>("eval_run", { action: "analyze", experimentIds });
  expect(result.summary).toMatchObject({ total: 3, pass: 1, fail: 1, inconclusive: 1, passRate: 1 / 3, resolvedCoverage: 2 / 3, unresolvedBounds: { lower: 1 / 3, upper: 2 / 3 } });
  expect(result.gate.pass).toBe(false);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/evaluations/analyses/repeated-trials`;
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ experimentIds }) });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store"); expect(await response.json()).toEqual(result);
  const duplicate = await experiment(revision, "baseline", "Re-graded first trial");
  await expectError("eval_run", { action: "analyze", experimentIds: [first.id, duplicate.id] }, "same captured run");
  await expectError("eval_run", { action: "analyze", experimentIds: [first.id, "missing"] }, "not found");
  expect(JSON.stringify(result)).not.toContain("Complete checkout"); expect(JSON.stringify(result)).not.toContain("declined");
});

test("MCP report returns a strict gate without frozen payloads and rejects incompatible baselines", async () => {
  const revision = await dataset();
  const baseline = await experiment(revision, "baseline", "Report baseline");
  seedRun("report-failed", "declined");
  const failed = await experiment(revision, "report-failed", "Report failure");
  const report = await call<import("../src/evaluations/report").EvaluationReport>("eval_run", { action: "report", experimentId: failed.id, baseline: baseline.id });
  expect(report.format).toBe("runphantom-evaluation-report/v1");
  expect(report.gate.pass).toBe(false);
  expect(report.comparison?.summary.regressions).toBe(1);
  expect(report.cases[0]).not.toHaveProperty("snapshot");
  expect(JSON.stringify(report)).not.toContain("Complete checkout");
  await expectError("eval_run", { action: "report", experimentId: failed.id, baseline: "missing" });
});

test("MCP tool-argument cases distinguish the same tool called for the wrong customer", async () => {
  for (const [id, customer] of [["refund-good", "customer-1"], ["refund-wrong", "customer-2"]]) {
    seedRun(id);
    insertSpan({ id: `${id}-tool`, run_id: id, parent_span_id: `${id}-root`, name: "refund", span_type: "TOOL_CALL", status: "OK",
      input_payload: JSON.stringify({ customer: { id: customer } }), output_payload: "{}", start_time_ms: 1020, end_time_ms: 1030, duration_ms: 10, attributes: "{}" });
  }
  const initial = await call<DatasetRevision>("eval_dataset", { action: "create", name: "Refund arguments" });
  const revision = await call<DatasetRevision>("eval_dataset", { action: "update", datasetId: initial.datasetId, expectedVersion: 1,
    cases: [{ name: "Refund correct customer", sourceRunId: "refund-good", rules: [{ kind: "toolArgument", name: "refund", path: "customer.id", equals: "customer-1", match: "all" }] }] });
  const passing = await experiment(revision, "refund-good", "Correct refund");
  const failing = await experiment(revision, "refund-wrong", "Wrong refund");
  expect(passing.verdict).toBe("pass");
  expect(failing.verdict).toBe("fail");
  expect(failing.results[0].checks[0].evaluatorVersion).toBe("toolargs:1");
  expect((await call<Comparison>("eval_compare", { baseline: passing.id, candidate: failing.id })).summary.regressions).toBe(1);
});

test("evaluation tools coexist with traces and verification; snapshots preserve selected output and missing metrics", async () => {
  const listed = await client.listTools();
  const names = listed.tools.map(tool => tool.name);
  for (const name of ["query_traces", "app_assert", "eval_dataset", "eval_run", "eval_compare", "eval_review"]) expect(names).toContain(name);
  expect(names.length).toBe(new Set(names).size);
  seedRun("baseline");
  const snapshot = await call<Snapshot>("eval_run", { action: "snapshot", runId: "baseline", outputSpanId: "baseline-generation" });
  expect(snapshot.output).toMatchObject({ value: "paid", spanId: "baseline-generation", source: "selected" });
  expect(snapshot.metrics.totalTokens).toBe(15);
  const traces = await call<{ rows: unknown[] }>("query_traces", { sql: "SELECT id FROM runs" });
  expect(traces.rows).toHaveLength(1);
  expect(await call("app_session", { action: "list" })).toEqual([]);
  await expectError("eval_run", { action: "snapshot", runId: "baseline", outputSpanId: "foreign-span" });
});

test("real MCP dataset revisions enforce OCC and portable export/import drops source identities", async () => {
  const revision = await dataset();
  expect(revision.version).toBe(2);
  expect(await call<Array<{ id: string }>>("eval_dataset", { action: "list" })).toMatchObject([{ id: revision.datasetId }]);
  expect(revision.cases[0].sourceRunId).toBe("baseline");
  expect(revision.cases[0].input).toBe("Complete checkout");
  expect((await call<DatasetRevision>("eval_dataset", { action: "get", datasetId: revision.datasetId, version: 1 })).cases).toHaveLength(0);
  await expectError("eval_dataset", { action: "update", datasetId: revision.datasetId, expectedVersion: 1, cases: [] });
  const exported = await call<DatasetExport>("eval_dataset", { action: "export", datasetId: revision.datasetId, version: 2 });
  expect(exported.format).toBe("runphantom-evaluations/v1");
  expect(exported.cases[0]).not.toHaveProperty("sourceRunId");
  const imported = await call<DatasetRevision>("eval_dataset", { action: "import", data: exported });
  expect(imported.datasetId).not.toBe(revision.datasetId);
  expect(imported.cases[0].sourceRunId).toBeNull();
  expect(imported.cases[0].rules).toEqual(revision.cases[0].rules);
  expect(await call("eval_dataset", { action: "delete", datasetId: imported.datasetId })).toEqual({ ok: true });
  await expectError("eval_dataset", { action: "get", datasetId: imported.datasetId });
});

test("MCP experiments freeze baseline/failing/corrected candidates, compare and retain separate review history", async () => {
  const revision = await dataset();
  seedRun("rejected", "declined", "Complete checkout", 20);
  seedRun("repaired", "paid", "Complete checkout", 8);
  const baseline = await experiment(revision, "baseline", "Baseline");
  const rejected = await experiment(revision, "rejected", "Rejected");
  const repaired = await experiment(revision, "repaired", "Repaired");
  expect(baseline.verdict).toBe("pass"); expect(rejected.verdict).toBe("fail"); expect(repaired.verdict).toBe("pass");
  const summaries = await call<Array<Record<string, unknown>>>("eval_run", { action: "list" });
  expect(summaries).toHaveLength(3);
  expect(summaries[0]).not.toHaveProperty("results");
  expect((await call<Experiment>("eval_run", { action: "cancel", experimentId: baseline.id })).verdict).toBe("pass");
  const regression = await call<Comparison>("eval_compare", { baseline: baseline.id, candidate: rejected.id });
  expect(regression.summary.regressions).toBe(1);
  expect(regression.cases[0].deltas.totalTokens).toBe(10);
  const improvement = await call<Comparison>("eval_compare", { baseline: rejected.id, candidate: repaired.id });
  expect(improvement.summary.improvements).toBe(1);
  const caseId = revision.cases[0].id;
  await call("eval_review", { action: "create", experimentId: rejected.id, caseId, rating: "pass", note: "Human exception; automatic failure stays visible" });
  await call("eval_review", { action: "create", experimentId: rejected.id, caseId, rating: "fail", note: "Exception rejected after review" });
  expect(await call<Review[]>("eval_review", { action: "list", experimentId: rejected.id })).toHaveLength(2);
  expect((await call<Experiment>("eval_run", { action: "get", experimentId: rejected.id })).verdict).toBe("fail");
  await call("eval_dataset", { action: "delete", datasetId: revision.datasetId });
  closeDb();
  expect((await call<Experiment>("eval_run", { action: "get", experimentId: rejected.id })).results[0].snapshot.output.value).toBe("declined");
  expect(await call<Review[]>("eval_review", { action: "list", experimentId: rejected.id })).toHaveLength(2);
});

test("MCP makes incompatible inputs/revisions inconclusive and refuses incomplete assignments or implicit model consent", async () => {
  const revision = await dataset();
  seedRun("different-input", "paid", "Refund checkout");
  const mismatch = await experiment(revision, "different-input", "Mismatched candidate");
  expect(mismatch.verdict).toBe("inconclusive");
  expect(mismatch.results[0].inputMatch).toBe("mismatch");
  await expectError("eval_run", { action: "start", datasetId: revision.datasetId, name: "Missing mapping", assignments: [] });
  await expectError("eval_run", { action: "start", datasetId: revision.datasetId, name: "Wrong mapping", assignments: [{ caseId: "unknown", runId: "baseline" }] });
  const next = await call<DatasetRevision>("eval_dataset", { action: "update", datasetId: revision.datasetId, expectedVersion: 2, cases: [{ name: "New expectation", sourceRunId: "baseline", rules: [{ kind: "output", operation: "contains", value: "paid" }] }] });
  const nextExperiment = await experiment(next, "baseline", "New revision");
  await expectError("eval_compare", { baseline: mismatch.id, candidate: nextExperiment.id });
  const rubric = await call<DatasetRevision>("eval_dataset", { action: "update", datasetId: revision.datasetId, expectedVersion: 3, cases: [{ name: "Rubric case", sourceRunId: "baseline", rules: [{ kind: "rubric", provider: "openai", model: "fixture-model", rubric: "Check that checkout is complete", threshold: 0.8 }] }] });
  await expectError("eval_run", { action: "start", datasetId: rubric.datasetId, version: 4, name: "No consent", assignments: [{ caseId: rubric.cases[0].id, runId: "baseline" }] }, "allowModelJudges");
  await expectError("eval_run", { action: "start", datasetId: rubric.datasetId, name: "Malformed consent", assignments: [{ caseId: rubric.cases[0].id, runId: "baseline" }], allowModelJudges: "true" });
  await expectError("eval_dataset", { action: "get", datasetId: rubric.datasetId, version: -1 });
  await expectError("eval_run", { action: "cancel", experimentId: "missing" });
  await expectError("eval_dataset", { action: "list", unknown: true });
});
