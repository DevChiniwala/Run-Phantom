import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const compiledUrl = process.env.RUNPHANTOM_COMPILED_URL;
const screenshotDir = process.env.RUNPHANTOM_SCREENSHOT_DIR;

test("compiled binary serves its embedded Run Phantom UI", async ({ page }) => {
  test.skip(!compiledUrl, "RUNPHANTOM_COMPILED_URL is required for the native smoke gate");

  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });

  const clearResponse = await fetch(`${compiledUrl}/api/clear`, { method: "POST" });
  expect(clearResponse.ok).toBe(true);
  const demoResponse = await fetch(`${compiledUrl}/api/demo-traces/replay`, { method: "POST" });
  expect(demoResponse.ok).toBe(true);
  // The regression this gate exists for: both listings returned 503 from the
  // binary while the UI still rendered, because the listing worker was not embedded.
  for (const route of ["/api/agent/sessions", "/api/claude/sessions"]) {
    const response = await fetch(`${compiledUrl}${route}`);
    expect(response.status, route).toBe(200);
  }

  await page.goto(`${compiledUrl}/runs`);
  await expect(page).toHaveTitle("Run Phantom");
  await expect(page.getByRole("link", { name: /^Run Phantom/ }).first()).toBeVisible();
  expect(await page.locator("[data-runphantom-tagline]").evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
  const firstRun = page.locator("[data-run-id]").first();
  await expect(firstRun).toBeVisible();
  if (screenshotDir) {
    mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDir, "runphantom-desktop.png"), fullPage: true });
  }

  await firstRun.click();
  await expect(page).toHaveURL(/\/runs\/[^/?#]+(?:[/?#]|$)/);
  await expect(page.locator("#runphantom-main").getByText(/^Run (?:live|complete|failed)$/).last()).toBeVisible();
  await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
  const unnamedDesktopButtons = await page.locator("button:visible").evaluateAll((buttons) =>
    buttons
      .filter((button) => !button.getAttribute("aria-label") && !button.getAttribute("title") && !button.textContent?.trim())
      .map((button) => button.outerHTML.slice(0, 160)),
  );
  expect(unnamedDesktopButtons).toEqual([]);
  if (screenshotDir) {
    await page.screenshot({ path: path.join(screenshotDir, "runphantom-desktop-detail.png"), fullPage: true });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Back to runs" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  const toggleBox = await page.getByRole("button", { name: "Toggle Sidebar" }).boundingBox();
  const backLabelBox = await page.getByText("Back to runs", { exact: true }).boundingBox();
  expect(toggleBox).not.toBeNull();
  expect(backLabelBox).not.toBeNull();
  expect(backLabelBox!.x).toBeGreaterThanOrEqual(toggleBox!.x + toggleBox!.width + 4);
  const unnamedMobileButtons = await page.locator("button:visible").evaluateAll((buttons) =>
    buttons
      .filter((button) => !button.getAttribute("aria-label") && !button.getAttribute("title") && !button.textContent?.trim())
      .map((button) => button.outerHTML.slice(0, 160)),
  );
  expect(unnamedMobileButtons).toEqual([]);
  if (screenshotDir) {
    await page.screenshot({ path: path.join(screenshotDir, "runphantom-mobile.png"), fullPage: true });
  }
  expect(runtimeErrors).toEqual([]);
});
