import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  clearRunPhantom,
  FIXTURE_LIVE_RUN_ID,
  FIXTURE_PRIMARY_RUN_ID,
  listRunPhantomRuns,
  saveRunPhantomRun,
  seedRunPhantomFixtures,
} from "./helpers";

function monitorLocalRuntimeIssues(page: Page): string[] {
  const issues: string[] = [];

  page.on("pageerror", (error) => issues.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      issues.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      issues.push(`request failed: ${request.method()} ${url.pathname} (${request.failure()?.errorText ?? "unknown"})`);
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      url.pathname.startsWith("/api/") &&
      response.status() >= 400
    ) {
      issues.push(`http ${response.status()}: ${response.request().method()} ${url.pathname}`);
    }
  });

  return issues;
}

function relativeLuminance(rgb: string): number {
  const hex = rgb.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (hex) {
    const value = hex[1]!;
    const expanded = value.length === 3
      ? value.split("").map((channel) => channel + channel).join("")
      : value;
    const channels = [
      Number.parseInt(expanded.slice(0, 2), 16),
      Number.parseInt(expanded.slice(2, 4), 16),
      Number.parseInt(expanded.slice(4, 6), 16),
    ];
    return relativeLuminance(`rgb(${channels.join(", ")})`);
  }

  const channels = rgb.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
  if (channels.length !== 3) return 0;
  const linear = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

test.beforeEach(async ({ page, runPhantom }) => {
  await clearRunPhantom(runPhantom.url);
  await page.route("https://openrouter.ai/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: [] }),
  }));
});

test("release audit: visible save and delete stay local and error-free", async ({ page, runPhantom }) => {
  const issues = monitorLocalRuntimeIssues(page);
  await seedRunPhantomFixtures(runPhantom.url);

  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  const saveButton = page.getByRole("button", { name: /^save$/i });
  await expect(saveButton).toBeVisible({ timeout: 10_000 });
  await saveButton.click();
  await expect(page.getByRole("button", { name: /^saved$/i })).toBeVisible({ timeout: 5_000 });

  await expect.poll(async () => {
    const response = await fetch(`${runPhantom.url}/api/saved-runs`);
    const body = await response.json() as { events?: Array<{ id?: string }> };
    return body.events?.some((event) => event.id === FIXTURE_PRIMARY_RUN_ID) ?? false;
  }).toBe(true);

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "More actions" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("menuitem", { name: "Delete run" }).click();

  await expect(page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`)).toHaveCount(0, { timeout: 5_000 });
  await expect.poll(async () => (await listRunPhantomRuns(runPhantom.url)).length).toBe(2);
  expect(issues).toEqual([]);
});

test("release audit: status is explicit without relying on color", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  const liveResponse = await fetch(`${runPhantom.url}/v1/live`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      traceId: FIXTURE_LIVE_RUN_ID,
      type: "message",
      content: "Still working",
      timestamp: Date.now(),
    }),
  });
  expect(liveResponse.ok).toBe(true);

  await page.goto(`${runPhantom.url}/runs/${FIXTURE_LIVE_RUN_ID}`);
  const liveRow = page.locator(`[data-run-id="${FIXTURE_LIVE_RUN_ID}"]`);
  await expect(liveRow.getByText("Run live", { exact: true })).toBeAttached();
  await expect(page.getByText("Run live", { exact: true }).last()).toBeVisible();

  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  await expect(page.getByText("Run complete", { exact: true }).last()).toBeVisible();
});

test("release audit: run detail is usable at a 390px viewport", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedRunPhantomFixtures(runPhantom.url);

  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  await expect(page.getByRole("button", { name: "Back to runs" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByPlaceholder("Search runs...")).toBeHidden();
  await expect(page.getByText("Fix the typo in README.md", { exact: true })).toBeVisible();

  const sidebarToggleBox = await page.getByRole("button", { name: "Toggle Sidebar" }).boundingBox();
  const backLabelBox = await page.getByText("Back to runs", { exact: true }).boundingBox();
  expect(sidebarToggleBox).not.toBeNull();
  expect(backLabelBox).not.toBeNull();
  expect(backLabelBox!.x).toBeGreaterThanOrEqual(sidebarToggleBox!.x + sidebarToggleBox!.width + 4);

  for (const name of ["Annotate", "Debug", "Download", "Save", "Replay", "More actions"]) {
    const button = page.getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box, `${name} should have a rendered box`).not.toBeNull();
    expect(box!.x, `${name} should start inside the viewport`).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, `${name} should end inside the viewport`).toBeLessThanOrEqual(390);
  }

  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(widths.document).toBe(widths.viewport);
});

test("release audit: mobile route headings clear the sidebar trigger", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedRunPhantomFixtures(runPhantom.url);

  const routes = [
    { path: "/runs", label: "connected", role: "status" as const },
    { path: "/search", label: "Local Search", role: "heading" as const },
    { path: "/saved", label: "Saved Runs", role: "heading" as const },
    { path: "/settings", label: "Settings", role: "heading" as const },
  ];

  for (const route of routes) {
    await page.goto(`${runPhantom.url}${route.path}`);
    const sidebarToggle = page.getByRole("button", { name: "Toggle Sidebar" });
    const routeLabel = route.role === "status"
      ? page.getByRole("status").filter({ hasText: route.label }).first()
      : page.getByRole("heading", { name: route.label, exact: true }).first();
    await expect(routeLabel).toBeVisible({ timeout: 10_000 });

    const sidebarToggleBox = await sidebarToggle.boundingBox();
    const routeLabelBox = await routeLabel.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    expect(sidebarToggleBox, `${route.path} sidebar trigger should render`).not.toBeNull();
    expect(routeLabelBox.width, `${route.path} label should render`).toBeGreaterThan(0);
    expect(routeLabelBox.x, `${route.path} label should clear the sidebar trigger`).toBeGreaterThanOrEqual(
      sidebarToggleBox!.x + sidebarToggleBox!.width + 4,
    );
  }
});

test("release audit: mobile span inspection uses the full detail width", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedRunPhantomFixtures(runPhantom.url);

  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}/spans`);
  const spanRow = page.locator("[data-span-row]").filter({ hasText: "llm.generate" }).first();
  await expect(spanRow).toBeVisible({ timeout: 10_000 });
  await spanRow.click();

  const backButton = page.getByRole("button", { name: "Back to span list" });
  await expect(backButton).toBeVisible();
  const detailPanel = page.getByRole("region", { name: "Span details" });
  const detailBox = await detailPanel.boundingBox();
  expect(detailBox).not.toBeNull();
  expect(detailBox!.width).toBeGreaterThanOrEqual(350);

  await backButton.click();
  await expect(spanRow).toBeVisible();
});

test("release audit: run navigation arrows stay scoped to the run list", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}/spans`);

  const spanRow = page.locator("[data-span-row]").first();
  await expect(spanRow).toBeVisible({ timeout: 10_000 });
  await spanRow.focus();
  await page.keyboard.press("ArrowDown");

  await expect(page).toHaveURL(new RegExp(`/runs/${FIXTURE_PRIMARY_RUN_ID}/spans`));
  await expect(spanRow).toBeFocused();
});

test("release audit: mobile search uses a list-to-detail flow", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedRunPhantomFixtures(runPhantom.url);

  await page.goto(`${runPhantom.url}/search`);
  const searchField = page.getByPlaceholder("Search by title, event, user, conversation, or id");
  await expect(searchField).toBeVisible({ timeout: 10_000 });
  await page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`).click();
  await expect(page.getByRole("button", { name: "Back to search" })).toBeVisible();
  await expect(searchField).toBeHidden();
  await page.getByRole("button", { name: "Back to search" }).click();
  await expect(searchField).toBeVisible();
});

test("release audit: mobile saved runs use a list-to-detail flow", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedRunPhantomFixtures(runPhantom.url);
  await saveRunPhantomRun(runPhantom.url, FIXTURE_PRIMARY_RUN_ID);

  await page.goto(`${runPhantom.url}/saved/${FIXTURE_PRIMARY_RUN_ID}`);
  await expect(page.getByRole("button", { name: "Back to saved runs" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Saved Runs", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Back to saved runs" }).click();
  await expect(page.getByText("Saved Runs", { exact: true })).toBeVisible();
});

test("release audit: reduced motion freezes the empty-state signal field", async ({ page, runPhantom }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${runPhantom.url}/runs`);

  const canvas = page.locator("canvas[aria-hidden='true']");
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  const firstFrame = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  await page.waitForTimeout(350);
  const laterFrame = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  expect(laterFrame).toBe(firstFrame);
});

test("release audit: reduced motion disables looping status animation", async ({ page, runPhantom }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await seedRunPhantomFixtures(runPhantom.url);
  await page.goto(`${runPhantom.url}/runs/${FIXTURE_LIVE_RUN_ID}`);

  const animations = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".pulse-dot, .spin, .animate-spin, .animate-pulse"))
      .map((element) => ({
        className: element.className,
        animationName: getComputedStyle(element).animationName,
      }))
      .filter((entry) => entry.animationName !== "none"),
  );
  expect(animations).toEqual([]);
});

test("release audit: optional provider routes degrade cleanly without API keys", async ({ runPhantom }) => {
  const modelsResponse = await fetch(`${runPhantom.url}/api/models/anthropic`);
  expect(modelsResponse.status).toBe(200);
  expect(await modelsResponse.json()).toMatchObject({
    models: [],
    configured: false,
  });

  const summaryResponse = await fetch(`${runPhantom.url}/api/summarize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "A local trace that needs a title." }),
  });
  expect(summaryResponse.status).toBe(200);
  expect(await summaryResponse.json()).toMatchObject({
    summary: null,
    available: false,
    reason: "missing_provider_key",
  });
});

test("release audit: replay reports actionable setup state through SSE", async ({ runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  const response = await fetch(`${runPhantom.url}/api/replay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId: FIXTURE_PRIMARY_RUN_ID }),
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const body = await response.text();
  expect(body).toContain('"type":"error"');
  expect(body).toContain('"code":"missing_replay_agent"');
  expect(body).toContain('"setupRequired":true');
  expect(body).toContain("/setup-agent-replay");
});

test("release audit: settings tabs, secrets, agents, and 320px reflow work end to end", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(`${runPhantom.url}/settings`);

  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible({ timeout: 10_000 });
  const keysTab = page.getByRole("tab", { name: "API Keys" });
  await expect(keysTab).toHaveAttribute("aria-selected", "true");

  const keysPanel = page.getByRole("tabpanel", { name: "API Keys" });
  await expect(keysPanel.getByRole("note")).toContainText("send the selected trace content");
  const openAiKey = keysPanel.getByLabel("OpenAI", { exact: true });
  await openAiKey.fill("test-key-stored-only-in-the-isolated-playwright-home");
  await keysPanel.getByRole("button", { name: "Save OpenAI key" }).click();
  await expect(keysPanel.getByText("saved", { exact: true })).toBeVisible();
  await keysPanel.getByRole("button", { name: "Clear saved OpenAI key" }).click();
  await expect(keysPanel.getByText("saved", { exact: true })).toHaveCount(0);

  await keysTab.focus();
  await page.keyboard.press("ArrowRight");
  const agentsTab = page.getByRole("tab", { name: "Agent Endpoints" });
  await expect(agentsTab).toBeFocused();
  await expect(agentsTab).toHaveAttribute("aria-selected", "true");

  const agentsPanel = page.getByRole("tabpanel", { name: "Agent Endpoints" });
  await agentsPanel.getByLabel("Agent name").fill("test-agent");
  await agentsPanel.getByLabel("Replay endpoint URL").fill("http://127.0.0.1:65530/replay");
  await agentsPanel.getByRole("button", { name: "Add agent endpoint" }).click();
  await expect(agentsPanel.getByText("test-agent", { exact: true })).toBeVisible();
  await agentsPanel.getByRole("button", { name: "Remove test-agent" }).click();
  await expect(agentsPanel.getByText("test-agent", { exact: true })).toHaveCount(0);

  await agentsTab.focus();
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Debug" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "show again" })).toBeVisible();

  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(widths.document).toBe(widths.viewport);
});

test("release audit: Run Phantom renders a high-contrast daylight identity", async ({ page, runPhantom }) => {
  await fetch(`${runPhantom.url}/api/clear`, { method: "POST" });
  await page.goto(`${runPhantom.url}/runs`);

  await expect(page.getByText("Run Phantom", { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#runphantom-main").getByText("See the run. Find the reason.", { exact: true })).toBeVisible();
  await expect(page.locator("svg[data-runphantom-mark]").first()).toBeVisible();
  const sidebarTaglineFits = await page.locator("[data-runphantom-tagline]").evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  );
  expect(sidebarTaglineFits).toBe(true);

  const palette = await page.evaluate(() => {
    const normalizeColor = (value: string) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) return value;
      context.fillStyle = "#000000";
      context.fillStyle = value;
      return context.fillStyle;
    };
    const appRoot = document.getElementById("root");
    const root = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const app = appRoot ? getComputedStyle(appRoot) : null;
    return {
      colorScheme: root.colorScheme,
      background: normalizeColor(body.backgroundColor || root.backgroundColor || app?.backgroundColor || "#ffffff"),
      foreground: normalizeColor(body.color || root.color || app?.color || "#000000"),
    };
  });

  expect(palette.colorScheme).toBe("light");
  expect(relativeLuminance(palette.background)).toBeGreaterThan(0.78);
  expect(contrastRatio(palette.background, palette.foreground)).toBeGreaterThanOrEqual(4.5);

  const favicon = await (await fetch(`${runPhantom.url}/favicon.svg`)).text();
  expect(favicon).not.toMatch(/#080A0F|#63E6D6|#9B87F5|linearGradient/i);
});

test("release audit: timeline labels remain readable and replay options are named", async ({ page, runPhantom }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);

  const llmBar = page.getByRole("button", { name: /^Inspect llm\.generate,/ }).first();
  await expect(llmBar).toBeVisible({ timeout: 10_000 });
  const colors = await llmBar.evaluate((element) => {
    const resolveColor = (value: string) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) return value;
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
      return `rgb(${red}, ${green}, ${blue})`;
    };
    const label = element.querySelector("span");
    return {
      background: resolveColor(getComputedStyle(element).backgroundColor),
      foreground: resolveColor(label ? getComputedStyle(label).color : "transparent"),
    };
  });
  expect(contrastRatio(colors.background, colors.foreground)).toBeGreaterThanOrEqual(4.5);

  const replayOptions = page.getByTitle("Replay with options");
  await expect(replayOptions).toHaveAttribute("aria-label", "Replay with options");
  await replayOptions.click();
  await expect(page.getByRole("dialog", { name: "Replay options" })).toBeVisible();
  await expect(page.getByLabel("Replay model")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Replay options" })).toHaveCount(0);
  await expect(replayOptions).toBeFocused();

  const moreActions = page.getByRole("button", { name: "More actions" });
  await moreActions.click();
  await expect(page.getByRole("menu", { name: "Run actions" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete run" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Run actions" })).toHaveCount(0);
  await expect(moreActions).toBeFocused();
});

test("release audit: mobile navigation exposes an explicit close control", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${runPhantom.url}/runs`);

  await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  const navigation = page.getByRole("dialog", { name: "Navigation" });
  await expect(navigation).toBeVisible();
  await navigation.getByRole("button", { name: "Close" }).click();
  await expect(navigation).toHaveCount(0);
});

test("release audit: keyboard users receive a visible skip target", async ({ page, runPhantom }) => {
  await page.goto(`${runPhantom.url}/runs`);
  await page.keyboard.press("Tab");

  const active = page.locator(":focus");
  await expect(active).toHaveText("Skip to trace workspace");
  await expect(active).toBeVisible();
  const focusStyle = await active.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(focusStyle.outlineStyle).not.toBe("none");
  expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThanOrEqual(2);
});

test("release audit: the empty workspace reflows at 320px", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await fetch(`${runPhantom.url}/api/clear`, { method: "POST" });
  await page.goto(`${runPhantom.url}/runs`);

  await expect(page.locator("#runphantom-main").getByText("No runs", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("textbox", { name: "Search runs", exact: true })).toBeVisible();
  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(widths.document).toBe(widths.viewport);
});
