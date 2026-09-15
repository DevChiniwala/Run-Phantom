import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, REPO_ROOT_PATH } from "./fixtures";
import {
  createEvaluationDataset, EVALUATION_INPUT, EVALUATION_RUNS,
  seedEvaluationRuns, snapshot, startEvaluation,
} from "./evaluation-fixture";
import type { Comparison, DatasetRevision, Experiment, Snapshot } from "../../src/evaluations/protocol";

test("evaluations: user creates a regression case, compares frozen candidates, reviews results and imports an export", async ({ page, request, runPhantom }) => {
  await seedEvaluationRuns(request, runPhantom.url);
  await page.goto(`${runPhantom.url}/runs/${EVALUATION_RUNS.baseline}`);
  await page.getByRole("link", { name: "Evaluate run", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Evaluations", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Dataset name", exact: true }).fill("UI checkout dataset");
  await page.getByRole("button", { name: "Create dataset", exact: true }).click();
  const dataset = page.getByRole("combobox", { name: "Dataset", exact: true });
  await expect(dataset).not.toHaveValue("");
  const originalDataset = await dataset.inputValue();
  await page.getByRole("combobox", { name: "Source run", exact: true }).selectOption(EVALUATION_RUNS.baseline);
  await page.getByRole("button", { name: "Preview source", exact: true }).click();
  const source = page.getByRole("region", { name: "Source snapshot", exact: true });
  await expect(source.getByText('{"status":"paid"}', { exact: true })).toBeVisible();
  await expect(source.getByText(EVALUATION_INPUT, { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Case name", exact: true }).fill("Checkout result");
  const firstRule = page.getByRole("group", { name: "Rule 1", exact: true });
  await firstRule.getByRole("combobox", { name: "Text condition", exact: true }).selectOption("contains");
  await firstRule.getByRole("textbox", { name: /^Expected text/ }).fill("paid");
  await page.getByRole("button", { name: "Add rule", exact: true }).click();
  const secondRule = page.getByRole("group", { name: "Rule 2", exact: true });
  await secondRule.getByRole("combobox", { name: "Rule type", exact: true }).selectOption("budget");
  await secondRule.getByRole("combobox", { name: "Budget metric", exact: true }).selectOption("totalTokens");
  await secondRule.getByRole("spinbutton", { name: /^Maximum/ }).fill("100");
  await page.getByRole("button", { name: "Add case", exact: true }).click();
  await page.getByRole("button", { name: "Save new revision", exact: true }).click();
  const revision = page.getByRole("combobox", { name: "Revision", exact: true });
  await expect(revision).toHaveValue("2");

  const results = page.getByRole("region", { name: "Experiment results", exact: true });
  const startFromUi = async (name: string, runId: string, outcome: "pass" | "fail" | "inconclusive") => {
    const controls = page.getByRole("region", { name: "Start experiment", exact: true });
    await controls.getByRole("textbox", { name: "Experiment name", exact: true }).fill(name);
    await controls.getByRole("combobox", { name: "Candidate run for Checkout result", exact: true }).selectOption(runId);
    const start = controls.getByRole("button", { name: "Start experiment", exact: true });
    await start.focus();
    await start.press("Enter");
    await expect(results.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(results.getByRole("status").first()).toHaveText("completed");
    await expect(results.getByRole("article", { name: `Checkout result: ${outcome}`, exact: true })).toBeVisible();
    return page.getByRole("combobox", { name: "View experiment", exact: true }).inputValue();
  };
  const baseline = await startFromUi("UI baseline", EVALUATION_RUNS.baseline, "pass");
  const rejected = await startFromUi("UI rejected candidate", EVALUATION_RUNS.rejected, "fail");
  const repaired = await startFromUi("UI repaired candidate", EVALUATION_RUNS.repaired, "pass");
  await startFromUi("UI missing measurements", EVALUATION_RUNS.missing, "inconclusive");
  await results.locator("summary").filter({ hasText: /^Frozen candidate snapshot$/ }).click();
  const missing = results.getByRole("region", { name: "Frozen candidate snapshot", exact: true });
  await expect(missing.getByText("Total tokens", { exact: true }).locator("..").getByText("Unavailable", { exact: true })).toBeVisible();
  await startFromUi("UI different request", EVALUATION_RUNS.mismatch, "inconclusive");
  await expect(results.getByText(/^Input mismatch:/)).toBeVisible();
  await page.getByRole("combobox", { name: "View experiment", exact: true }).selectOption(repaired);
  await expect(results.getByRole("article", { name: "Checkout result: pass", exact: true })).toBeVisible();

  const review = results.getByRole("region", { name: "Human review", exact: true });
  await review.getByRole("combobox", { name: "Review case", exact: true }).selectOption({ label: "Checkout result" });
  await review.getByRole("combobox", { name: "Human rating", exact: true }).selectOption("fail");
  await review.getByRole("textbox", { name: "Review note", exact: true }).fill("Human review requests clearer wording despite passing code checks.");
  await review.getByRole("button", { name: "Save human review", exact: true }).click();
  await expect(results.getByText(/Latest human review: Fail — Human review requests clearer wording/)).toBeVisible();
  await expect(results.getByRole("article", { name: "Checkout result: pass", exact: true })).toBeVisible();
  const comparison = page.getByRole("region", { name: "Experiment comparison", exact: true });
  await comparison.getByRole("combobox", { name: "Compare baseline", exact: true }).selectOption(baseline);
  await comparison.getByRole("combobox", { name: "Compare candidate", exact: true }).selectOption(rejected);
  await comparison.getByRole("button", { name: "Compare experiments", exact: true }).click();
  await expect(comparison.getByRole("status")).toContainText("Regressions: 1");
  await comparison.getByRole("combobox", { name: "Compare baseline", exact: true }).selectOption(rejected);
  await comparison.getByRole("combobox", { name: "Compare candidate", exact: true }).selectOption(repaired);
  await comparison.getByRole("button", { name: "Compare experiments", exact: true }).click();
  await expect(comparison.getByRole("status")).toContainText("Improvements: 1");

  await page.getByRole("button", { name: "Edit case Checkout result", exact: true }).click();
  await firstRule.getByRole("textbox", { name: /^Expected text/ }).fill("declined");
  await page.getByRole("button", { name: "Update case draft", exact: true }).click();
  await page.getByRole("button", { name: "Save new revision", exact: true }).click();
  await expect(revision).toHaveValue("3");
  const changed = await startFromUi("UI changed expectations", EVALUATION_RUNS.rejected, "pass");
  await comparison.getByRole("combobox", { name: "Compare baseline", exact: true }).selectOption(baseline);
  await comparison.getByRole("combobox", { name: "Compare candidate", exact: true }).selectOption(changed);
  await comparison.getByRole("button", { name: "Compare experiments", exact: true }).click();
  await expect(comparison.getByRole("alert")).toBeVisible();
  await revision.selectOption("2");
  await expect(page.getByText(/This is an immutable historical revision/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit case Checkout result", exact: true })).toBeDisabled();
  await page.getByText("Import and export datasets", { exact: true }).click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export selected revision", exact: true }).click();
  const downloadPath = await (await downloaded).path();
  if (!downloadPath) throw new Error("Dataset export did not produce a downloadable artifact");
  const portable = JSON.parse(readFileSync(downloadPath, "utf8")) as { format: string; name: string; cases: Array<Record<string, unknown>> };
  expect(portable.format).toBe("runphantom-evaluations/v1");
  expect(portable.cases).toHaveLength(1);
  expect(portable.cases[0]).not.toHaveProperty("sourceRunId");
  await page.getByRole("textbox", { name: "Dataset JSON", exact: true }).fill(JSON.stringify({ ...portable, name: "Imported UI checkout" }));
  await page.getByRole("button", { name: "Import JSON", exact: true }).click();
  await expect(dataset).not.toHaveValue(originalDataset);
  await expect(revision).toHaveValue("1");
  await expect(page.getByText("Portable dataset imported. Local source identities were not imported.", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("combobox", { name: "View experiment", exact: true }).selectOption(repaired);
  await expect(results.getByText(/Latest human review: Fail — Human review requests clearer wording/)).toBeVisible();
  await expect(results.getByRole("article", { name: "Checkout result: pass", exact: true })).toBeVisible();

  const directory = path.join(REPO_ROOT_PATH, "output");
  mkdirSync(directory, { recursive: true });
  await page.getByRole("heading", { name: "Evaluations", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(directory, "evaluations-desktop.png"), fullPage: true });
  await results.getByRole("heading", { name: "UI repaired candidate", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(directory, "evaluations-desktop-results.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("heading", { name: "Evaluations", exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: path.join(directory, "evaluations-mobile.png"), fullPage: true });
  await results.getByRole("heading", { name: "UI repaired candidate", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(directory, "evaluations-mobile-results.png"), fullPage: true });
  await review.getByRole("combobox", { name: "Review case", exact: true }).selectOption({ label: "Checkout result" });
  await review.getByRole("combobox", { name: "Human rating", exact: true }).selectOption("pass");
  await review.getByRole("textbox", { name: "Review note", exact: true }).fill("Mobile keyboard confirmation.");
  const saveReview = review.getByRole("button", { name: "Save human review", exact: true });
  await saveReview.focus();
  await saveReview.press("Enter");
  await expect(results.getByText(/Latest human review: Pass — Mobile keyboard confirmation/)).toBeVisible();
  await expect(review.locator("summary").filter({ hasText: /^Review history \(2\)$/ })).toBeVisible();
  await expect(results.getByRole("article", { name: "Checkout result: pass", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("evaluations: user resolves ambiguous response selection and sees explicit model consent before grading", async ({ page, request, runPhantom }) => {
  await seedEvaluationRuns(request, runPhantom.url);
  const reference = await createEvaluationDataset(request, runPhantom.url, [{ kind: "output", operation: "equals", value: "First parallel response" }], "Response selection");
  const rubric = await createEvaluationDataset(request, runPhantom.url, [{
    kind: "rubric", provider: "openai", model: "fixture-model", rubric: "Describe the checkout result accurately.", threshold: 0.8,
  }], "Visible judge consent");
  await page.goto(`${runPhantom.url}/evaluations`);
  await page.getByRole("combobox", { name: "Dataset", exact: true }).selectOption(reference.datasetId);
  const controls = page.getByRole("region", { name: "Start experiment", exact: true });
  await controls.getByRole("textbox", { name: "Experiment name", exact: true }).fill("Explicit response selection");
  await controls.getByRole("combobox", { name: "Candidate run for Checkout result", exact: true }).selectOption(EVALUATION_RUNS.ambiguous);
  await controls.getByRole("button", { name: "Preview candidate for Checkout result", exact: true }).click();
  const candidate = controls.getByRole("region", { name: "Candidate snapshot", exact: true });
  await expect(candidate.getByText("Selection: Unavailable. Response unavailable or incomplete.", { exact: true })).toBeVisible();
  const selectedSpan = `${EVALUATION_RUNS.ambiguous.slice(-8)}00000004`;
  await controls.getByRole("combobox", { name: /^Response span for Checkout result/ }).selectOption(selectedSpan);
  await controls.getByRole("button", { name: "Preview candidate for Checkout result", exact: true }).click();
  await expect(candidate.getByText("First parallel response", { exact: true })).toBeVisible();
  await expect(candidate.getByText("Selection: Explicit response span. Complete response.", { exact: true })).toBeVisible();
  await expect(candidate.getByRole("link", { name: "View response span", exact: true })).toHaveAttribute("href", `/runs/${EVALUATION_RUNS.ambiguous}/span/${selectedSpan}`);
  await controls.getByRole("button", { name: "Start experiment", exact: true }).click();
  const results = page.getByRole("region", { name: "Experiment results", exact: true });
  await expect(results.getByRole("article", { name: "Checkout result: pass", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Dataset", exact: true }).selectOption(rubric.datasetId);
  await controls.getByRole("textbox", { name: "Experiment name", exact: true }).fill("Consent must be deliberate");
  await controls.getByRole("combobox", { name: "Candidate run for Checkout result", exact: true }).selectOption(EVALUATION_RUNS.baseline);
  const consent = controls.getByRole("checkbox", { name: /^Allow model judges to send selected trace data/ });
  const start = controls.getByRole("button", { name: "Start experiment", exact: true });
  await expect(consent).not.toBeChecked();
  await expect(start).toBeDisabled();
  await consent.check();
  await expect(start).toBeEnabled();
  await consent.uncheck();
  await expect(start).toBeDisabled();
  const experiments = await request.get(`${runPhantom.url}/api/evaluations/experiments`);
  expect(await experiments.json() as Experiment[]).toHaveLength(1);
});

test("evaluations: real ingested traces preserve output provenance, measured usage and missing evidence", async ({ request, runPhantom }) => {
  await seedEvaluationRuns(request, runPhantom.url);
  const baseline = await snapshot(request, runPhantom.url, EVALUATION_RUNS.baseline);
  expect(baseline.input).toBe(EVALUATION_INPUT);
  expect(baseline.complete).toBe(true);
  expect(baseline.output).toMatchObject({ value: '{"status":"paid"}', source: "agentRoot", complete: true });
  expect(baseline.metrics).toEqual({ inputTokens: 80, outputTokens: 20, totalTokens: 100, durationMs: 1000, costUsd: 0.001, toolCalls: 2, errorSpans: 0 });
  expect(baseline.models).toContainEqual(expect.objectContaining({ provider: "openai", model: "captured-response-model", inputTokens: 80, outputTokens: 20 }));
  const missing = await snapshot(request, runPhantom.url, EVALUATION_RUNS.missing);
  expect(missing.metrics).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, durationMs: 1000 });
  const ambiguous = await snapshot(request, runPhantom.url, EVALUATION_RUNS.ambiguous);
  expect(ambiguous.output).toMatchObject({ value: null, source: "unavailable", complete: false });
  const selectedSpan = `${EVALUATION_RUNS.ambiguous.slice(-8)}00000004`;
  const explicit = await request.get(`${runPhantom.url}/api/evaluations/runs/${EVALUATION_RUNS.ambiguous}/snapshot?outputSpanId=${selectedSpan}`);
  expect(explicit.ok()).toBe(true);
  expect((await explicit.json() as Snapshot).output).toMatchObject({ value: "First parallel response", spanId: selectedSpan, source: "selected", complete: true });
});

test("evaluations: frozen experiments distinguish regressions, unavailable telemetry and mismatched input", async ({ request, runPhantom }) => {
  await seedEvaluationRuns(request, runPhantom.url);
  const revision = await createEvaluationDataset(request, runPhantom.url, [
    { kind: "output", operation: "contains", value: "paid" },
    { kind: "budget", metric: "totalTokens", max: 100 },
  ]);
  const baseline = await startEvaluation(request, runPhantom.url, revision, EVALUATION_RUNS.baseline, "Measured baseline");
  const rejected = await startEvaluation(request, runPhantom.url, revision, EVALUATION_RUNS.rejected, "Broken candidate");
  const repaired = await startEvaluation(request, runPhantom.url, revision, EVALUATION_RUNS.repaired, "Repaired candidate");
  expect(baseline.verdict).toBe("pass");
  expect(rejected.verdict).toBe("fail");
  expect(repaired.verdict).toBe("pass");
  const unknown = await startEvaluation(request, runPhantom.url, revision, EVALUATION_RUNS.missing, "Unmeasured candidate");
  expect(unknown.verdict).toBe("inconclusive");
  expect(unknown.summary).toMatchObject({ total: 1, pass: 0, fail: 0, inconclusive: 1, passRate: 0 });
  const mismatched = await startEvaluation(request, runPhantom.url, revision, EVALUATION_RUNS.mismatch, "Wrong request candidate");
  expect(mismatched.verdict).toBe("inconclusive");
  expect(mismatched.results[0].inputMatch).toBe("mismatch");
  expect(mismatched.results[0].checks.every((check) => check.status === "inconclusive")).toBe(true);

  const comparison = async (from: Experiment, to: Experiment): Promise<Comparison> => {
    const response = await request.get(`${runPhantom.url}/api/evaluations/compare?baseline=${from.id}&candidate=${to.id}`);
    expect(response.ok()).toBe(true);
    return response.json() as Promise<Comparison>;
  };
  expect((await comparison(baseline, rejected)).summary.regressions).toBe(1);
  const improvement = await comparison(rejected, repaired);
  expect(improvement.summary.improvements).toBe(1);
  expect(improvement.cases[0].deltas.totalTokens).toBe(-25);
  expect(improvement.cases[0].deltas.costUsd).toBeCloseTo(-0.0003, 8);
  const uncertain = await comparison(baseline, unknown);
  expect(uncertain.summary.inconclusive).toBe(1);
  expect(uncertain.cases[0].deltas.totalTokens).toBeNull();
  expect(uncertain.cases[0].deltas.costUsd).toBeNull();

  const update = await request.put(`${runPhantom.url}/api/evaluations/datasets/${revision.datasetId}`, { data: {
    expectedVersion: revision.version,
    cases: revision.cases.map((entry) => ({ id: entry.id, name: entry.name, sourceRunId: entry.sourceRunId, rules: [{ kind: "output", operation: "contains", value: "declined" }] })),
  } });
  expect(update.status()).toBe(201);
  const changed = await update.json() as DatasetRevision;
  const changedExperiment = await startEvaluation(request, runPhantom.url, changed, EVALUATION_RUNS.rejected, "Changed expectations");
  expect(changedExperiment.verdict).toBe("pass");
  const incompatible = await request.get(`${runPhantom.url}/api/evaluations/compare?baseline=${baseline.id}&candidate=${changedExperiment.id}`);
  expect(incompatible.status()).toBe(409);
  const oldRevision = await request.get(`${runPhantom.url}/api/evaluations/datasets/${revision.datasetId}?version=${revision.version}`);
  expect(await oldRevision.json()).toEqual(revision);

  expect((await request.delete(`${runPhantom.url}/api/runs/${EVALUATION_RUNS.baseline}`)).ok()).toBe(true);
  expect((await request.delete(`${runPhantom.url}/api/evaluations/datasets/${revision.datasetId}`)).ok()).toBe(true);
  const preserved = await request.get(`${runPhantom.url}/api/evaluations/experiments/${baseline.id}`);
  expect(await preserved.json()).toEqual(baseline);
});

test("evaluations: compiled workbench stores and displays a completed evaluation", async ({ page, request }) => {
  const daemon = process.env.RUNPHANTOM_COMPILED_URL;
  test.skip(!daemon, "RUNPHANTOM_COMPILED_URL must identify an isolated compiled daemon");
  await seedEvaluationRuns(request, daemon!);
  const revision = await createEvaluationDataset(request, daemon!, [{ kind: "output", operation: "contains", value: "paid" }], "Compiled checkout dataset");
  const experiment = await startEvaluation(request, daemon!, revision, EVALUATION_RUNS.baseline, "Compiled checkout evaluation");
  expect(experiment.verdict).toBe("pass");
  await page.goto(`${daemon}/evaluations`);
  await expect(page.getByRole("heading", { name: "Evaluations", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Dataset", exact: true }).selectOption(revision.datasetId);
  await page.getByRole("combobox", { name: "View experiment", exact: true }).selectOption(experiment.id);
  const results = page.getByRole("region", { name: "Experiment results", exact: true });
  await expect(results.getByRole("heading", { name: "Compiled checkout evaluation", exact: true })).toBeVisible();
  await expect(results.getByRole("article", { name: "Checkout result: pass", exact: true })).toBeVisible();
});

test("evaluations: model grading requires explicit opt-in and imported definitions remain portable", async ({ request, runPhantom }) => {
  await seedEvaluationRuns(request, runPhantom.url);
  const rubric = await createEvaluationDataset(request, runPhantom.url, [{
    kind: "rubric", provider: "openai", model: "fixture-model", rubric: "The output clearly describes the checkout result.", threshold: 0.8,
  }], "Explicit judge consent");
  const denied = await request.post(`${runPhantom.url}/api/evaluations/experiments`, { data: {
    datasetId: rubric.datasetId, version: rubric.version, name: "No spending authorized",
    assignments: [{ caseId: rubric.cases[0].id, runId: EVALUATION_RUNS.baseline }],
  } });
  expect(denied.status()).toBe(400);
  const experiments = await request.get(`${runPhantom.url}/api/evaluations/experiments`);
  expect(await experiments.json()).toEqual([]);

  const exportResponse = await request.get(`${runPhantom.url}/api/evaluations/datasets/${rubric.datasetId}/export?version=${rubric.version}`);
  expect(exportResponse.ok()).toBe(true);
  const portable = await exportResponse.json() as { format: string; name: string; cases: Array<Record<string, unknown>> };
  expect(portable.format).toBe("runphantom-evaluations/v1");
  expect(portable.cases[0].input).toBe(EVALUATION_INPUT);
  expect(portable.cases[0]).not.toHaveProperty("sourceRunId");
  const importedResponse = await request.post(`${runPhantom.url}/api/evaluations/datasets/import`, { data: portable });
  expect(importedResponse.status()).toBe(201);
  const imported = await importedResponse.json() as DatasetRevision;
  expect(imported.datasetId).not.toBe(rubric.datasetId);
  expect(imported.cases[0].id).not.toBe(rubric.cases[0].id);
  expect(imported.cases[0]).toMatchObject({ sourceRunId: null, input: EVALUATION_INPUT, rules: rubric.cases[0].rules });
  const executable = await request.post(`${runPhantom.url}/api/evaluations/datasets/import`, { data: {
    ...portable, cases: [{ name: "Unsafe import", input: EVALUATION_INPUT, rules: [{ kind: "javascript", code: "process.exit(1)" }] }],
  } });
  expect(executable.status()).toBe(400);
});
