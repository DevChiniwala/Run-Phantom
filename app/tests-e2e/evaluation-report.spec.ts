import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, REPO_ROOT_PATH } from "./fixtures";
import { seedEvaluationRuns, createEvaluationDataset, EVALUATION_RUNS } from "./evaluation-fixture";
import type { Experiment } from "../../src/evaluations/protocol";

async function gate(args: string[]) {
  const child = spawn("bun", ["scripts/check-evaluation.ts", ...args], { cwd: REPO_ROOT_PATH, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += String(data); });
  child.stderr.on("data", data => { stderr += String(data); });
  const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { exitCode, stdout, stderr };
}

test("evaluation reports: user downloads JSON/JUnit and a real CLI gate distinguishes pass, failure, unknown and incompatible input", async ({ page, request, runPhantom }, testInfo) => {
  await seedEvaluationRuns(request, runPhantom.url);
  const revision = await createEvaluationDataset(request, runPhantom.url, [{ kind: "output", operation: "equals", value: '{"status":"paid"}' }]);
  async function evaluate(runId: string) {
    const response = await request.post(`${runPhantom.url}/api/evaluations/experiments`, { data: { datasetId: revision.datasetId, name: `Report ${runId}`, assignments: [{ caseId: revision.cases[0].id, runId }] } });
    expect(response.status()).toBe(202);
    const initial = await response.json() as Experiment;
    await expect.poll(async () => (await (await request.get(`${runPhantom.url}/api/evaluations/experiments/${initial.id}`)).json() as Experiment).status).toBe("completed");
    return initial.id;
  }
  const passed = await evaluate(EVALUATION_RUNS.baseline);
  const failed = await evaluate(EVALUATION_RUNS.rejected);
  const unknown = await evaluate(EVALUATION_RUNS.mismatch);
  await page.goto(`${runPhantom.url}/evaluations`);
  await page.getByRole("combobox", { name: "View experiment", exact: true }).selectOption(passed);
  for (const format of ["JSON", "JUnit"]) {
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: `Download ${format} report`, exact: true }).click();
    const download = await downloadPromise;
    const file = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(file);
    const text = await readFile(file, "utf8");
    expect(text).not.toContain("Describe the result of this checkout.");
    expect(text).not.toContain('{"status":"paid"}');
    if (format === "JSON") expect(JSON.parse(text).gate.pass).toBe(true);
    else {
      const validity = await page.evaluate(xml => {
        const document = new DOMParser().parseFromString(xml, "application/xml");
        return { errors: document.querySelectorAll("parsererror").length, tests: document.documentElement.getAttribute("tests") };
      }, text);
      expect(validity).toEqual({ errors: 0, tests: "1" });
    }
  }
  for (const [id, code] of [[passed, 0], [failed, 1], [unknown, 1]] as const) {
    const result = await gate(["--url", runPhantom.url, "--experiment", id]);
    expect(result.exitCode, result.stderr).toBe(code);
    expect(JSON.parse(result.stdout).gate.pass).toBe(code === 0);
  }
  const file = path.join(testInfo.outputDir, "ci.junit.xml");
  const regression = await gate(["--url", runPhantom.url, "--experiment", failed, "--baseline", passed, "--format", "junit", "--output", file]);
  expect(regression.exitCode, regression.stderr).toBe(1);
  expect(await readFile(file, "utf8")).toContain('<failure message="Evaluation failed">');
  const badBaseline = await gate(["--url", runPhantom.url, "--experiment", passed, "--baseline", "missing"]);
  expect(badBaseline.exitCode).toBe(2);
  expect((await gate(["--experiment", passed, "--format", "bad"])).exitCode).toBe(2);
  expect((await request.get(`${runPhantom.url}/api/evaluations/experiments/${passed}/report?format=bad`)).status()).toBe(400);
});
