import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures";
import { seedEvaluationRuns, createEvaluationDataset, EVALUATION_RUNS } from "./evaluation-fixture";
import type { Experiment } from "../../src/evaluations/protocol";

test("explicit repeated trials preserve mixed outcomes and export the displayed selection", async ({ page, request, runPhantom }, testInfo) => {
  await seedEvaluationRuns(request, runPhantom.url);
  const revision = await createEvaluationDataset(request, runPhantom.url, [{ kind: "output", operation: "equals", value: '{"status":"paid"}' }]);
  const trials: Array<{ id: string; name: string }> = [];
  for (const [index, runId] of [EVALUATION_RUNS.baseline, EVALUATION_RUNS.rejected, EVALUATION_RUNS.mismatch, EVALUATION_RUNS.baseline].entries()) {
    const name = `Trial ${index + 1}`;
    const response = await request.post(`${runPhantom.url}/api/evaluations/experiments`, { data: { datasetId: revision.datasetId, name, assignments: [{ caseId: revision.cases[0].id, runId }] } });
    expect(response.status()).toBe(202); const value = await response.json() as Experiment;
    await expect.poll(async () => (await (await request.get(`${runPhantom.url}/api/evaluations/experiments/${value.id}`)).json() as Experiment).status).toBe("completed");
    trials.push({ id: value.id, name });
  }
  await page.goto(`${runPhantom.url}/evaluations`);
  const panel = page.getByRole("region", { name: "Repeated trial analysis" });
  for (const trial of trials.slice(0, 3)) await panel.getByRole("checkbox", { name: new RegExp(`^${trial.name} ·`) }).check();
  await panel.getByRole("button", { name: "Analyze selected trials" }).click();
  const result = panel.getByLabel("Repeated trial results");
  await expect(result).toContainText("3 selected trials · 1 cases · 3 case-trial outcomes");
  await expect(result).toContainText("Pass: 1 · Fail: 1 · Inconclusive: 1");
  await expect(result).toContainText("not a confidence interval");
  const downloadPromise = page.waitForEvent("download"); await panel.getByRole("button", { name: "Download trial analysis JSON" }).click();
  const download = await downloadPromise; const file = testInfo.outputPath(download.suggestedFilename()); await download.saveAs(file);
  const text = await readFile(file, "utf8"); const report = JSON.parse(text);
  expect(report.format).toBe("runphantom-repeated-trial-analysis/v1"); expect(report.trials.map((item: { experimentId: string }) => item.experimentId)).toEqual(trials.slice(0, 3).map(item => item.id));
  expect(report.summary).toMatchObject({ pass: 1, fail: 1, inconclusive: 1, total: 3 }); expect(text).not.toContain("Describe the result of this checkout.");
  await result.getByRole("button", { name: "Trial 1: pass", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "View experiment", exact: true })).toHaveValue(trials[0].id);
  await panel.getByRole("checkbox", { name: /^Trial 4 ·/ }).check();
  await expect(panel.getByLabel("Repeated trial results")).toHaveCount(0);
  await panel.getByRole("button", { name: "Analyze selected trials" }).click();
  await expect(panel.getByRole("alert")).toContainText("same captured run");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
