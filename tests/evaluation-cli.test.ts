import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

let server: Server | undefined;
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } });

async function cli(response: string, status = 200, args: string[] = []) {
  server = createServer((_request, reply) => { reply.writeHead(status, { "Content-Type": "application/json" }); reply.end(response); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const process = spawn("bun", ["scripts/check-evaluation.ts", "--experiment", "fixture", "--url", `http://127.0.0.1:${address.port}`, ...args], { cwd: import.meta.dir + "/..", stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  process.stdout.on("data", chunk => { stdout += String(chunk); });
  process.stderr.on("data", chunk => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => { process.once("error", reject); process.once("close", resolve); });
  return { code, stdout, stderr };
}

const valid = () => ({ format: "runphantom-evaluation-report/v1", experiment: { id: "fixture", name: "Fixture", status: "completed", evaluationVersion: 1, snapshotVersion: 1, createdAt: 1, completedAt: 2 },
  dataset: { id: "dataset", name: "Dataset", version: 2, hash: "a".repeat(64) }, summary: { total: 1, pass: 1, fail: 0, inconclusive: 0, passRate: 1 }, gate: { pass: true, reasons: [] },
  cases: [{ id: "case", name: "Case", runId: "run", status: "pass", checks: [{ status: "pass", source: "code", evaluatorVersion: "code:1", reason: "Matched" }] }], comparison: null });

test("CLI requires the explicitly requested baseline comparison even if all candidate cases pass", async () => {
  const result = await cli(JSON.stringify(valid()), 200, ["--baseline", "requested-baseline"]);
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
});

test("CLI refuses unsupported experiment versions", async () => {
  const report = valid(); report.experiment.evaluationVersion = 999;
  const result = await cli(JSON.stringify(report));
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
});

test("CLI refuses extra response fields that could carry captured content", async () => {
  const report = { ...valid(), snapshot: { input: "private captured response" } };
  const result = await cli(JSON.stringify(report));
  expect(result.code).toBe(2);
  expect(result.stdout + result.stderr).not.toContain("private captured response");
});

test("CLI refuses payload fields nested inside a passing check", async () => {
  const report = valid(); Object.assign(report.cases[0].checks[0], { actual: "private nested content" });
  const result = await cli(JSON.stringify(report));
  expect(result.code).toBe(2);
  expect(result.stdout + result.stderr).not.toContain("private nested content");
});

test("CLI passes a complete versioned report", async () => {
  const result = await cli(JSON.stringify(valid()));
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).gate.pass).toBe(true);
});

test("CLI accepts the current lossless code evaluator while preserving historical reports", async () => {
  const report = valid(); report.cases[0].checks[0].evaluatorVersion = "code:2";
  const result = await cli(JSON.stringify(report));
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).cases[0].checks[0].evaluatorVersion).toBe("code:2");
});

test.each([["code", "code:999"], ["llm", "code:2"], ["code", "rubric:1"]])("CLI refuses unsupported evaluator provenance %s / %s", async (source, evaluatorVersion) => {
  const report = valid(); Object.assign(report.cases[0].checks[0], { source, evaluatorVersion });
  const result = await cli(JSON.stringify(report));
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
});

test("CLI refuses an arbitrary passing-looking response from a wrong or incompatible daemon", async () => {
  const result = await cli(JSON.stringify({ format: "runphantom-evaluation-report/v1", experiment: { id: "fixture" }, gate: { pass: true } }));
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("invalid evaluation report");
});

test("CLI operational errors never echo daemon response content", async () => {
  const result = await cli("private response fragment that is not JSON");
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("invalid JSON");
  expect(result.stderr).not.toContain("private response fragment");
});

test("CLI reports incompatible comparisons as operational failure without exposing error bodies", async () => {
  const result = await cli(JSON.stringify({ error: "private incompatible details" }), 409);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("HTTP 409");
  expect(result.stderr).not.toContain("private incompatible details");
});

test("CLI bounds report acquisition before parsing oversized replies", async () => {
  const result = await cli(" ".repeat(1024 * 1024 + 1));
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("exceeds 1 MiB");
});
