import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures";
import {
  clearRunPhantom,
  expectRunPhantomBranding,
  FIXTURE_DISPLAY_NAME,
  FIXTURE_LIVE_RUN_ID,
  FIXTURE_PRIMARY_RUN_ID,
  FIXTURE_SAVED_SIBLING_RUN_ID,
  FIXTURE_SPAN_COUNT,
  hasLegacyIdentityKey,
  listRunPhantomRuns,
  readLocalStorageKeys,
  readRunPhantomRun,
  readRunPhantomSpans,
  saveRunPhantomRun,
  seedRunPhantomFixtures,
} from "./helpers";

test.beforeEach(async ({ runPhantom }) => {
  await clearRunPhantom(runPhantom.url);
});

test("Run Phantom UI: clean-break branding and setup state use Run Phantom keys", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);

  await page.goto(runPhantom.url);
  await expectRunPhantomBranding(page);
  await expect
    .poll(async () => page.evaluate(() => localStorage.getItem("runphantom:firstTimeSetupDismissed")), {
      timeout: 10_000,
    })
    .toBe("1");

  const localStorageKeys = await readLocalStorageKeys(page);
  expect(hasLegacyIdentityKey(localStorageKeys)).toBe(false);
});

test("Run Phantom UI: initial runs view avoids optional-provider request failures", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);

  const failingResponses: Array<{ url: string; status: number }> = [];
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/")) return;
    failingResponses.push({ url: url.pathname, status: response.status() });
  });

  await page.goto(`${runPhantom.url}/runs`, { waitUntil: "networkidle" });

  expect(failingResponses).toEqual([]);
});

test("Run Phantom UI: mobile layout exposes a visible sidebar toggle", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  await page.setViewportSize({ width: 430, height: 932 });

  await page.goto(`${runPhantom.url}/runs`, { waitUntil: "networkidle" });

  const sidebarToggle = page.getByRole("button", { name: /toggle sidebar/i });
  await expect(sidebarToggle).toBeVisible({ timeout: 10_000 });
  await sidebarToggle.click();
  await expect(page.getByRole("link", { name: /^search$/i })).toBeVisible({ timeout: 5_000 });
});

test("Run Phantom UI: mobile viewport keeps the runs list usable when chat is expanded", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("runphantom:messagePane:collapsed", "0");
    localStorage.setItem("runphantom:messagePane:width", "460");
  });

  await page.goto(`${runPhantom.url}/runs`, { waitUntil: "networkidle" });

  const row = page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  const box = await row.boundingBox();
  expect(box, "expected the primary run row to render in the mobile list").not.toBeNull();
  expect(box!.width, "mobile chat must not squeeze the runs list below a usable width").toBeGreaterThan(300);
});

test("Run Phantom UI: clear button empties runs list and database", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);

  const before = await listRunPhantomRuns(runPhantom.url);
  expect(before.length).toBeGreaterThanOrEqual(3);

  await page.goto(runPhantom.url);
  page.on("dialog", (dialog) => dialog.accept());

  const clearButton = page.getByRole("button", { name: /^clear all runs$/i });
  await expect(clearButton).toBeVisible({ timeout: 10_000 });
  await clearButton.click();

  await expect.poll(async () => (await listRunPhantomRuns(runPhantom.url)).length, {
    timeout: 10_000,
  }).toBe(0);
});

test("Run Phantom UI: seeded runs appear live without a reload", async ({ page, runPhantom }) => {
  await page.goto(runPhantom.url);
  await expect(page.getByText(/no runs/i).first()).toBeVisible({ timeout: 10_000 });

  await seedRunPhantomFixtures(runPhantom.url);

  await expect(page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`[data-run-id="${FIXTURE_LIVE_RUN_ID}"]`)).toBeVisible({ timeout: 10_000 });
});

test("Run Phantom UI: local search filters seeded runs", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);

  await page.goto(`${runPhantom.url}/search`);
  await expectRunPhantomBranding(page);

  const searchField = page.getByPlaceholder("Search by title, event, user, conversation, or id");
  await expect(page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`)).toBeVisible({ timeout: 10_000 });

  await searchField.fill("definitely-not-a-real-event-name-xyz");
  await expect(page.getByText(/no matching runs/i)).toBeVisible({ timeout: 5_000 });

  await searchField.fill(FIXTURE_DISPLAY_NAME);
  await expect(page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`)).toBeVisible({ timeout: 5_000 });
  await page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/search/${FIXTURE_PRIMARY_RUN_ID}(?:[/?#]|$)`));
});

test("Run Phantom UI: span tree and side panel render the seeded trace", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);

  const run = await readRunPhantomRun(runPhantom.url, FIXTURE_PRIMARY_RUN_ID);
  expect(run, `expected seeded run ${FIXTURE_PRIMARY_RUN_ID} in the database`).not.toBeNull();

  const spans = await readRunPhantomSpans(runPhantom.url, FIXTURE_PRIMARY_RUN_ID);
  expect(spans.length).toBe(FIXTURE_SPAN_COUNT);

  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  await expect(page.getByText(run!.event_name ?? FIXTURE_PRIMARY_RUN_ID).first()).toBeVisible({ timeout: 10_000 });

  const overviewTab = page.getByRole("tab", { name: "Overview" });
  const spansTab = page.getByRole("tab", { name: "Span Tree" });
  await expect(spansTab).toBeVisible({ timeout: 10_000 });
  await overviewTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(spansTab).toBeFocused();
  await expect(spansTab).toHaveAttribute("aria-selected", "true");
  const rows = page.locator("[data-span-row]");
  await expect.poll(async () => rows.count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(FIXTURE_SPAN_COUNT);
  for (const span of spans) {
    await expect(page.locator(`[data-span-row="${span.id}"]`)).toBeVisible({ timeout: 5_000 });
  }

  const detailSpan = spans.find((span) => span.input_payload && span.output_payload);
  expect(detailSpan, "expected one seeded span with both input and output payloads").toBeTruthy();
  const detailRow = page.locator(`[data-span-row="${detailSpan!.id}"]`);
  await detailRow.focus();
  await page.keyboard.press("Shift+F10");
  const annotationMenu = page.getByRole("menu", { name: "Annotate span" });
  await expect(annotationMenu).toBeVisible();
  await expect(annotationMenu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(annotationMenu.getByRole("menuitem", { name: "Add note…" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(annotationMenu).toBeHidden();

  await detailRow.click();
  await expect(page).toHaveURL(new RegExp(`/span/${detailSpan!.id}(?:[/?#]|$)`));
  await expect(page.getByText(/^Input$/).first()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/^Output$/).first()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/Fix the typo in README\.md/).first()).toBeVisible({ timeout: 5_000 });
});

test("Run Phantom UI: download exports the selected trace as JSON", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);

  const detailResponse = await fetch(`${runPhantom.url}/api/runs/detail/${FIXTURE_PRIMARY_RUN_ID}`);
  expect(detailResponse.ok).toBe(true);
  const expectedTrace = await detailResponse.json();

  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  const downloadButton = page.getByRole("button", { name: /^download$/i });
  await expect(downloadButton).toBeVisible({ timeout: 10_000 });

  const downloadPromise = page.waitForEvent("download");
  await downloadButton.click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe(`trace-${FIXTURE_PRIMARY_RUN_ID}.json`);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  expect(JSON.parse(readFileSync(downloadPath!, "utf8"))).toEqual(expectedTrace);
});

test("Run Phantom UI: saved conversation routes stay scoped to saved and live traces", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  await saveRunPhantomRun(runPhantom.url, FIXTURE_PRIMARY_RUN_ID);

  await page.goto(`${runPhantom.url}/saved/${FIXTURE_PRIMARY_RUN_ID}/convo`);
  await expect(page.getByRole("tab", { name: "Conversation" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("2 runs", { exact: true })).toBeVisible({ timeout: 10_000 });

  const openButtons = page.getByRole("button", { name: /^open →$/i });
  await expect(openButtons).toHaveCount(2);

  await openButtons.first().click();
  await expect(page).toHaveURL(new RegExp(`/saved/${FIXTURE_PRIMARY_RUN_ID}(?:[/?#]|$)`));

  await page.goto(`${runPhantom.url}/saved/${FIXTURE_PRIMARY_RUN_ID}/convo`);
  await expect(openButtons).toHaveCount(2);
  await openButtons.nth(1).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${FIXTURE_SAVED_SIBLING_RUN_ID}(?:[/?#]|$)`));

  await saveRunPhantomRun(runPhantom.url, FIXTURE_SAVED_SIBLING_RUN_ID);
  await page.goto(`${runPhantom.url}/saved/${FIXTURE_PRIMARY_RUN_ID}/convo`);
  await expect(openButtons).toHaveCount(2);
  await openButtons.nth(1).click();
  await expect(page).toHaveURL(new RegExp(`/saved/${FIXTURE_SAVED_SIBLING_RUN_ID}(?:[/?#]|$)`));
});

test("Run Phantom UI: deleting a trace via the API removes only that sidebar row", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);

  await page.goto(runPhantom.url);
  const targetRow = page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`);
  await expect(targetRow).toBeVisible({ timeout: 10_000 });

  const deleteResponse = await fetch(`${runPhantom.url}/api/runs/${FIXTURE_PRIMARY_RUN_ID}`, {
    method: "DELETE",
  });
  expect(deleteResponse.ok, `DELETE /api/runs/${FIXTURE_PRIMARY_RUN_ID} -> ${deleteResponse.status}`).toBe(true);

  await expect(targetRow).toHaveCount(0, { timeout: 5_000 });
  await expect.poll(async () => page.locator("[data-run-id]").count(), { timeout: 5_000 }).toBe(2);
});
