import type { APIRequestContext } from "@playwright/test";
import { test, expect, replayTelemetry, SOURCE_RUN_ID, SOURCE_TOOL_ID, SOURCE_MESSAGE, SOURCE_OUTPUT, REPLAY_OUTPUT } from "./replay-debugging-fixture";

async function exported(request: APIRequestContext, url: string, runId: string) {
  const response = await request.get(`${url}/api/runs/${runId}/export`);
  expect(response.ok()).toBe(true);
  return response.json();
}

test("local replay: pending agent registry blocks replay entry points until configuration arrives", async ({ page, runPhantom, localReplayAgent }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/agents", async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.goto(`${runPhantom.url}/runs/${SOURCE_RUN_ID}`);
    await expect(page.getByRole("button", { name: "Replay", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Replay with options", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Edit message and replay run", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Edit & Replay", exact: true });
    await expect(edit.getByRole("status")).toHaveText("Checking agent replay setup…");
    await expect(edit.getByRole("button", { name: "Replay", exact: true })).toBeDisabled();
    await expect(page.getByRole("dialog", { name: "Set Up Agent Replay", exact: true })).toHaveCount(0);
    await edit.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(localReplayAgent.requests).toHaveLength(0);

    release();
    await expect(page.getByRole("button", { name: "Replay", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Replay with options", exact: true }).click();
    await page.getByRole("dialog", { name: "Replay options", exact: true }).getByRole("button", { name: "Replay", exact: true }).click();
    await expect(page.getByText(REPLAY_OUTPUT, { exact: true }).first()).toBeVisible();
    expect(localReplayAgent.requests).toHaveLength(1);
  } finally { release(); }
});

test("local replay: agent registry failures remain retryable without opening setup", async ({ page, runPhantom, localReplayAgent }) => {
  let fail = true;
  await page.route("**/api/agents", async (route) => {
    if (!fail) return route.continue();
    await route.fulfill({ status: 503, json: { error: "Registry temporarily unavailable" } });
  });
  await page.goto(`${runPhantom.url}/runs/${SOURCE_RUN_ID}`);
  await expect(page.getByRole("alert").filter({ hasText: "Could not load agent replay setup." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Replay", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Replay with options", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Edit message and replay run", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit & Replay", exact: true });
  await expect(edit.getByRole("alert")).toContainText("Could not load agent replay setup.");
  await expect(edit.getByRole("button", { name: "Replay", exact: true })).toBeDisabled();
  await expect(page.getByRole("dialog", { name: "Set Up Agent Replay", exact: true })).toHaveCount(0);
  expect(localReplayAgent.requests).toHaveLength(0);

  fail = false;
  await edit.getByRole("button", { name: "Retry agent replay setup", exact: true }).click();
  await expect(edit.getByRole("button", { name: "Replay", exact: true })).toBeEnabled();
  await edit.getByRole("button", { name: "Replay", exact: true }).click();
  await expect(page.getByText(REPLAY_OUTPUT, { exact: true }).first()).toBeVisible();
  expect(localReplayAgent.requests).toHaveLength(1);
});

test("local replay: a successful empty agent registry still offers setup", async ({ page, runPhantom, localReplayAgent }) => {
  await page.route("**/api/agents", (route) => route.fulfill({ json: {} }));
  await page.goto(`${runPhantom.url}/runs/${SOURCE_RUN_ID}`);
  await page.getByRole("button", { name: "Replay", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Set Up Agent Replay", exact: true })).toBeVisible();
  expect(localReplayAgent.requests).toHaveLength(0);
});

test("local replay: inspect a failure, edit the input, execute the registered fixture and compare persisted evidence", async ({ page, request, runPhantom, localReplayAgent }) => {
  const original = await exported(request, runPhantom.url, SOURCE_RUN_ID);
  await page.goto(`${runPhantom.url}/runs/${SOURCE_RUN_ID}`);
  await expect(page.getByText(SOURCE_OUTPUT, { exact: true }).first()).toBeVisible();
  await page.getByRole("tab", { name: "Span Tree", exact: true }).click();
  await page.locator(`[data-span-row="${SOURCE_TOOL_ID}"]`).click();
  await expect(page.getByText("fixture payment declined", { exact: false }).first()).toBeVisible();

  await page.getByRole("button", { name: "Replay with options", exact: true }).click();
  const options = page.getByRole("dialog", { name: "Replay options" });
  const editedMessage = "Retry order local-42 without charging a card";
  await options.getByLabel("Replay user message").fill(editedMessage);
  await options.getByRole("button", { name: "Replay", exact: true }).click();
  await expect.poll(() => localReplayAgent.requests.length).toBe(1);
  await expect.poll(() => localReplayAgent.traceIds.length).toBe(1);
  const replayId = localReplayAgent.traceIds[0];
  await expect(page).toHaveURL(new RegExp(`/runs/${replayId}$`));
  await expect(page.getByRole("button", { name: "Replay again", exact: true })).toBeVisible();
  await expect(page.getByText(REPLAY_OUTPUT, { exact: true }).first()).toBeVisible();
  const outbound = localReplayAgent.requests[0];
  expect(outbound).toMatchObject({ sourceRunId: SOURCE_RUN_ID, userMessage: editedMessage, systemPrompt: "Use the local checkout fixture only.",
    messages: [{ role: "user", content: editedMessage }] });
  expect(outbound).not.toHaveProperty("apiKey");
  expect(outbound).not.toHaveProperty("openaiKey");

  await page.getByRole("button", { name: "compare", exact: true }).click();
  await expect(page.getByText(SOURCE_OUTPUT, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(REPLAY_OUTPUT, { exact: true }).first()).toBeVisible();
  const separator = page.getByRole("separator", { name: "Resize replay comparison" });
  await expect(separator).toBeVisible();
  await separator.focus();
  await separator.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "55");
  await page.getByRole("button", { name: "Close original run comparison" }).click();

  await page.getByRole("button", { name: "Compare captured changes", exact: true }).click();
  const changes = page.getByRole("region", { name: "Captured run comparison" });
  const changedTool = changes.locator('[data-comparison-row="changed"]').filter({ has: page.locator("summary", { hasText: "fixture_payment" }) });
  await changedTool.locator("summary").first().click();
  await expect(changedTool.locator('[data-comparison-field="status"]')).toContainText("ERROR");
  await expect(changedTool.locator('[data-comparison-field="status"]')).toContainText("OK");
  await expect(changedTool.locator('[data-comparison-field="output_payload"]')).toContainText("fixture payment declined");
  await expect(changedTool.getByRole("link", { name: "Open candidate span fixture_payment in a new tab", exact: true })).toHaveAttribute("href", `/runs/${replayId}/span/${SOURCE_TOOL_ID}`);
  await page.getByRole("button", { name: "Compare captured changes", exact: true }).click();

  const replay = await exported(request, runPhantom.url, replayId);
  expect(JSON.parse(replay.run.metadata).replay).toMatchObject({ sourceRunId: SOURCE_RUN_ID, mode: "local" });
  expect(replay.spans).toHaveLength(3);
  expect(replay.spans.find((span: { id: string }) => span.id === SOURCE_TOOL_ID).status).toBe("OK");
  expect((await request.get(`${runPhantom.url}/api/runs/${outbound.replayRunId}/export`)).status()).toBe(404);
  expect(await exported(request, runPhantom.url, SOURCE_RUN_ID)).toEqual(original);

  await page.reload();
  await expect(page.getByText(REPLAY_OUTPUT, { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "compare", exact: true }).click();
  await expect(page.getByText(SOURCE_OUTPUT, { exact: true }).first()).toBeVisible();
});

test("local replay: endpoint failure retains actionable evidence and a browser retry completes", async ({ page, request, runPhantom, localReplayAgent }) => {
  localReplayAgent.mode = "failure";
  const original = await exported(request, runPhantom.url, SOURCE_RUN_ID);
  await page.goto(`${runPhantom.url}/runs/${SOURCE_RUN_ID}`);
  await page.getByRole("button", { name: "Replay", exact: true }).click();
  await expect(page.getByText("Agent endpoint returned HTTP 503: Fixture blocked unsafe checkout", { exact: true })).toBeVisible();
  expect(localReplayAgent.requests).toHaveLength(1);
  const failed = await exported(request, runPhantom.url, localReplayAgent.requests[0].replayRunId);
  expect(JSON.parse(failed.run.metadata).replay).toMatchObject({ sourceRunId: SOURCE_RUN_ID, error: { code: "agent_http_error", status: 503 } });
  expect(failed.spans).toHaveLength(0);

  localReplayAgent.mode = "success";
  await page.getByRole("button", { name: "Replay again", exact: true }).click();
  await expect.poll(() => localReplayAgent.traceIds.length).toBe(1);
  await expect(page).toHaveURL(new RegExp(`/runs/${localReplayAgent.traceIds[0]}$`));
  await expect(page.getByText(REPLAY_OUTPUT, { exact: true }).first()).toBeVisible();
  expect(localReplayAgent.requests).toHaveLength(2);
  expect(localReplayAgent.requests[1].messages).toEqual([{ role: "user", content: SOURCE_MESSAGE }]);
  expect(await exported(request, runPhantom.url, SOURCE_RUN_ID)).toEqual(original);
});

test("local replay: cancel stops an in-flight endpoint request and preserves the source", async ({ page, request, runPhantom, localReplayAgent }) => {
  localReplayAgent.mode = "hold";
  const original = await exported(request, runPhantom.url, SOURCE_RUN_ID);
  await page.goto(`${runPhantom.url}/runs/${SOURCE_RUN_ID}`);
  await page.getByRole("button", { name: "Replay", exact: true }).click();
  await expect.poll(() => localReplayAgent.requests.length).toBe(1);
  await page.getByRole("button", { name: "cancel", exact: true }).click();
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  const placeholderId = localReplayAgent.requests[0].replayRunId;
  await expect.poll(() => localReplayAgent.disconnectedRequests).toContain(placeholderId);
  await expect.poll(async () => JSON.parse((await exported(request, runPhantom.url, placeholderId)).run.metadata).replay.error?.code).toBe("replay_cancelled");
  expect(localReplayAgent.traceIds).toHaveLength(0);
  expect((await exported(request, runPhantom.url, placeholderId)).spans).toHaveLength(0);
  expect(await exported(request, runPhantom.url, SOURCE_RUN_ID)).toEqual(original);
});

for (const sameSource of [false, true]) test(`registered replay attempts complete in reverse order (${sameSource ? "same" : "different"} source) without sharing evidence`, async ({ page, context, request, runPhantom, localReplayAgent }) => {
  const sourceB = sameSource ? SOURCE_RUN_ID : "b2000000000000000000000000000001";
  if (!sameSource) expect((await request.post(`${runPhantom.url}/v1/traces`, { data: replayTelemetry(sourceB) })).ok()).toBe(true);
  localReplayAgent.mode = "hold";
  await page.goto(`${runPhantom.url}/runs/${SOURCE_RUN_ID}`);
  await page.getByRole("button", { name: "Replay", exact: true }).click();
  await expect.poll(() => localReplayAgent.requests.length).toBe(1);
  const a = localReplayAgent.requests[0];
  localReplayAgent.mode = "success";
  const other = await context.newPage();
  try {
    await other.goto(`${runPhantom.url}/runs/${sourceB}`);
    await other.getByRole("button", { name: "Replay", exact: true }).click();
    await expect.poll(() => localReplayAgent.traceIds.length).toBe(1);
    const bId = localReplayAgent.traceIds[0];
    await expect(other).toHaveURL(new RegExp(`/runs/${bId}$`));
    // Span discovery polls every 800ms; exercise multiple real polling ticks.
    await page.waitForTimeout(1800);
    await expect(page.getByText("Replaying agent…", { exact: true })).toBeVisible();
    await expect(page.getByText(REPLAY_OUTPUT, { exact: true })).toHaveCount(0);
    expect(page.url()).not.toContain(bId);
    const aId = await localReplayAgent.completeHeld(a.replayRunId);
    await expect(page).toHaveURL(new RegExp(`/runs/${aId}$`));
    await expect(other).toHaveURL(new RegExp(`/runs/${bId}$`));
    expect(aId).not.toBe(bId);
    expect(JSON.parse((await exported(request, runPhantom.url, aId)).run.metadata).replay.sourceRunId).toBe(SOURCE_RUN_ID);
    expect(JSON.parse((await exported(request, runPhantom.url, bId)).run.metadata).replay.sourceRunId).toBe(sourceB);
  } finally { await other.close(); }
});
