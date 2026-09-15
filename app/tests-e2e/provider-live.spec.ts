import { expect, test } from "@playwright/test";
import { FIXTURE_PRIMARY_RUN_ID, seedRunPhantomFixtures } from "./helpers";
import { createEvaluationDataset, EVALUATION_RUNS, seedEvaluationRuns } from "./evaluation-fixture";
import type { Experiment } from "../../src/evaluations/protocol";

// Opt in only against an isolated daemon with synthetic traces and its own provider credentials.
const liveUrl = process.env.RUNPHANTOM_LIVE_URL;
test.use({ screenshot: "off", trace: "off", video: "off" });
test.describe.configure({ timeout: 180_000 });
test.beforeEach(() => {
  test.skip(process.env.RUNPHANTOM_LIVE_TESTS !== "1" || !liveUrl, "Requires an explicitly configured isolated live-provider daemon");
});

test("live providers: OpenAI streams a reply and a follow-up through the demo UI", async ({ page, request }) => {
  const configured = await request.get(`${liveUrl}/api/secrets`);
  expect((await configured.json()).keys.openai.configured).toBe(true);
  await page.goto(`${liveUrl}/demo-chat`);
  for (const prompt of ["In one sentence, what can a local agent trace explain?", "Which single trace detail would you inspect first?"]) {
    const before = await page.locator("#log .assistant").count();
    await page.getByLabel("Prompt", { exact: true }).fill(prompt);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Reply complete.", { timeout: 120_000 });
    expect(await page.locator("#log .assistant").count()).toBe(before + 1);
    expect((await page.locator("#log .assistant").last().textContent())?.trim().length).toBeGreaterThan(10);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  }
});

test("live providers: saving a synthetic run in the UI persists an Anthropic summary", async ({ page, request }) => {
  await seedRunPhantomFixtures(liveUrl!);
  const configured = await request.get(`${liveUrl}/api/secrets`);
  expect((await configured.json()).keys.anthropic.configured).toBe(true);
  await page.goto(`${liveUrl}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  const summaryResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/summarize", { timeout: 120_000 });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const result = await (await summaryResponse).json();
  expect(typeof result.summary).toBe("string");
  expect(result.summary?.length).toBeGreaterThan(10);
  await expect.poll(async () => {
    const response = await request.get(`${liveUrl}/api/saved-runs/events/${FIXTURE_PRIMARY_RUN_ID}`);
    const saved = await response.json();
    return saved.event?.summary === result.summary;
  }, { timeout: 10_000 }).toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
});

for (const [provider, model] of [
  ["openai", process.env.RUNPHANTOM_LIVE_OPENAI_MODEL ?? "gpt-4.1-mini"],
  ["anthropic", process.env.RUNPHANTOM_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001"],
] as const) {
  test(`live providers: ${provider} answers from the selected trace through the backend`, async ({ request }) => {
    await seedRunPhantomFixtures(liveUrl!);
    const response = await request.post(`${liveUrl}/api/agents/ask`, {
      data: { run_id: FIXTURE_PRIMARY_RUN_ID, model, question: "Summarize the user request and the observed result in one sentence. Do not execute anything." },
      timeout: 150_000,
    });
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result.status).toBe("answered");
    expect(result.provider).toBe(provider);
    expect(result.run_id).toBe(FIXTURE_PRIMARY_RUN_ID);
    expect(typeof result.answer).toBe("string");
    expect(result.answer?.length).toBeGreaterThan(10);
  });

  test(`live providers: ${provider} grades a captured case from the UI and rejects a failing candidate`, async ({ page, request }) => {
    await seedEvaluationRuns(request, liveUrl!);
    const revision = await createEvaluationDataset(request, liveUrl!, [{
      kind: "rubric", provider, model, threshold: 0.5,
      rubric: 'Score 1 if the candidate is a JSON object whose status is exactly "paid". Score 0 if status is anything else, including "declined". Judge only this condition. Explain the observed status briefly.',
    }], `Live ${provider} checkout rubric`);
    await page.goto(`${liveUrl}/evaluations`);
    await page.getByRole("combobox", { name: "Dataset", exact: true }).selectOption(revision.datasetId);
    await page.getByLabel("Experiment name", { exact: true }).fill(`Live ${provider} accepted checkout`);
    await page.getByRole("combobox", { name: "Candidate run for Checkout result", exact: true }).selectOption(EVALUATION_RUNS.baseline);
    const consent = page.getByRole("checkbox", { name: /^Allow model judges to send selected trace data to the chosen providers/ });
    await expect(consent).not.toBeChecked();
    await consent.check();
    const accepted = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/evaluations/experiments");
    await page.getByRole("button", { name: "Start experiment", exact: true }).click();
    const admitted = await accepted;
    expect(admitted.status()).toBe(202);
    const initial = await admitted.json() as Experiment;
    let complete = initial;
    const waitForCompletion = async (id: string) => {
      await expect.poll(async () => {
        const response = await request.get(`${liveUrl}/api/evaluations/experiments/${id}`);
        expect(response.ok()).toBe(true);
        complete = await response.json() as Experiment;
        return complete.status;
      }, { timeout: 45_000 }).toBe("completed");
      return complete;
    };
    const passed = await waitForCompletion(initial.id);
    expect(passed.verdict, passed.results[0].checks[0].reason).toBe("pass");
    expect(passed.results[0].checks[0]).toMatchObject({ source: "llm", evaluatorVersion: "rubric:1", status: "pass" });
    expect(passed.results[0].checks[0].score).toBeGreaterThanOrEqual(0.5);
    await expect(page.getByRole("article", { name: "Checkout result: pass", exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel("Model judge score", { exact: true })).toBeVisible();

    const rejected = await request.post(`${liveUrl}/api/evaluations/experiments`, { data: {
      datasetId: revision.datasetId, version: revision.version, name: `Live ${provider} declined checkout`,
      assignments: [{ caseId: revision.cases[0].id, runId: EVALUATION_RUNS.rejected }], allowModelJudges: true,
    } });
    expect(rejected.status()).toBe(202);
    const failed = await waitForCompletion((await rejected.json() as Experiment).id);
    expect(failed.verdict, failed.results[0].checks[0].reason).toBe("fail");
    expect(failed.results[0].checks[0].score).toBeLessThan(0.5);
    const comparison = await request.get(`${liveUrl}/api/evaluations/compare?baseline=${passed.id}&candidate=${failed.id}`);
    expect(comparison.ok()).toBe(true);
    expect((await comparison.json()).summary.regressions).toBe(1);
  });
}

test("live providers: cancelling model grading in the UI retains an interrupted experiment", async ({ page, request }) => {
  await seedEvaluationRuns(request, liveUrl!);
  const revision = await createEvaluationDataset(request, liveUrl!, Array.from({ length: 8 }, () => ({
    kind: "rubric" as const, provider: "anthropic" as const,
    model: process.env.RUNPHANTOM_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
    rubric: "Score 1 if the output describes a paid checkout and 0 otherwise. Explain the observed checkout status.", threshold: 0.5,
  })), "Live cancellable grading");
  await page.goto(`${liveUrl}/evaluations`);
  await page.getByRole("combobox", { name: "Dataset", exact: true }).selectOption(revision.datasetId);
  await page.getByLabel("Experiment name", { exact: true }).fill("Live interrupted grading");
  await page.getByRole("combobox", { name: "Candidate run for Checkout result", exact: true }).selectOption(EVALUATION_RUNS.baseline);
  await page.getByRole("checkbox", { name: /^Allow model judges to send selected trace data to the chosen providers/ }).check();
  const admitted = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/evaluations/experiments");
  await page.getByRole("button", { name: "Start experiment", exact: true }).click();
  const response = await admitted;
  expect(response.status()).toBe(202);
  const initial = await response.json() as Experiment;
  await page.getByRole("button", { name: "Cancel experiment", exact: true }).click();
  await expect.poll(async () => {
    const current = await request.get(`${liveUrl}/api/evaluations/experiments/${initial.id}`);
    return (await current.json() as Experiment).status;
  }).toBe("cancelled");
  const saved = await request.get(`${liveUrl}/api/evaluations/experiments/${initial.id}`);
  const interrupted = await saved.json() as Experiment;
  expect(interrupted.results[0].checks).toHaveLength(8);
  expect(interrupted.results[0].checks.some(check => check.status === "inconclusive")).toBe(true);
  expect(interrupted.verdict).toBe("inconclusive");
  await page.reload();
  await page.getByRole("combobox", { name: "View experiment", exact: true }).selectOption(initial.id);
  await expect(page.getByRole("region", { name: "Experiment results", exact: true }).getByRole("status")).toHaveText("cancelled");
  await expect(page.getByRole("article", { name: "Checkout result: inconclusive", exact: true })).toBeVisible();
});
