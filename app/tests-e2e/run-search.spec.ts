import type { APIRequestContext } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, REPO_ROOT_PATH } from "./fixtures";

const runId = (index: number) => (0x5ea000 + index).toString(16).padStart(32, "0");
const row = (index: number) => `[data-run-id="${runId(index)}"]`;
const evidencePath = path.join(REPO_ROOT_PATH, "output/playwright/research-search");

async function seedSearchRuns(request: APIRequestContext, url: string, count = 3, offset = 0) {
  const base = Date.now() - 60_000;
  const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
  const spans = Array.from({ length: count }, (_, position) => {
    const index = position + offset;
    const start = base - index * 1000;
    return {
      traceId: runId(index), spanId: runId(index).slice(-16), name: `Search fixture ${index}`,
      startTimeUnixNano: String(BigInt(start) * 1_000_000n),
      endTimeUnixNano: String(BigInt(start + 100) * 1_000_000n),
      status: { code: index === 1 ? 2 : 1 },
      attributes: [
        attribute("ai.operationId", "ai.generateText"),
        attribute("ai.telemetry.metadata.runphantom.eventName", `Search fixture ${index}`),
        attribute("ai.prompt", JSON.stringify({ messages: [{ role: "user", content: index === 0 ? "amber-only request" : "Shared request" }] })),
        attribute("ai.response.text", index === 1 ? "cobalt-only payload response" : "Shared response"),
        attribute("gen_ai.request.model", index === 1 ? "model-beta" : "model-alpha"),
        attribute("gen_ai.provider.name", index === 1 ? "anthropic" : "openai"),
      ],
    };
  });
  const response = await request.post(`${url}/v1/traces`, { data: { resourceSpans: [{ scopeSpans: [{ spans }] }] } });
  expect(response.ok(), `Seed search traces (HTTP ${response.status()})`).toBe(true);
}

test("search finds payload-only evidence and persists filters through a direct link", async ({ page, request, runPhantom }) => {
  await seedSearchRuns(request, runPhantom.url);
  await page.goto(`${runPhantom.url}/search`);
  await expect(page.locator(row(0))).toBeVisible();
  await page.getByRole("textbox", { name: "Search captured runs", exact: true }).fill("cobalt-only");
  await expect(page.locator(row(1))).toBeVisible();
  await expect(page.locator("[data-run-id]")).toHaveCount(1);
  await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("failed");
  await page.getByLabel("Model", { exact: true }).fill("model-beta");
  await page.getByLabel("Provider", { exact: true }).fill("anthropic");
  await expect(page.getByRole("status").filter({ hasText: "1 run loaded" })).toBeVisible();
  await page.locator(row(1)).click();
  await expect(page).toHaveURL(new RegExp(`/search/${runId(1)}\\?`));
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Search captured runs", { exact: true })).toHaveValue("cobalt-only");
  await expect(page.getByLabel("Provider", { exact: true })).toHaveValue("anthropic");
  await expect(page.locator(row(1))).toBeVisible();
  await page.getByLabel("Provider", { exact: true }).fill("openai");
  await expect(page.getByText("No matching runs", { exact: true })).toBeVisible();
  // A filter change does not evict the independently loaded selected trace.
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toBeVisible();
  mkdirSync(evidencePath, { recursive: true });
  await page.screenshot({ path: path.join(evidencePath, "desktop-filtered-detail.png"), fullPage: true });
});

test("search loads another server page without duplicates and opens an older direct link", async ({ page, request, runPhantom }) => {
  await seedSearchRuns(request, runPhantom.url, 55);
  await page.goto(`${runPhantom.url}/search`);
  await expect(page.locator("[data-run-id]")).toHaveCount(50);
  await expect(page.locator(row(54))).toHaveCount(0);
  await page.getByRole("button", { name: "Load more runs", exact: true }).click();
  await expect(page.locator("[data-run-id]")).toHaveCount(55);
  await expect(page.getByRole("button", { name: "Load more runs", exact: true })).toHaveCount(0);
  const ids = await page.locator("[data-run-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-run-id")));
  expect(new Set(ids).size).toBe(55);
  await page.goto(`${runPhantom.url}/search/${runId(54)}?q=cobalt-only`);
  await expect(page.locator(row(1))).toBeVisible();
  await expect(page.locator(row(54))).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toBeVisible();
  await expect(page.getByText("Search fixture 54", { exact: true }).first()).toBeVisible();
});

test("search distinguishes loading, failures, empty workspace, and no matching results", async ({ page, request, runPhantom }) => {
  let failSearch = true;
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route("**/api/runs/search?*", async (route) => {
    if (!failSearch) return route.continue();
    await responseGate;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Search capacity is busy. Retry shortly." }) });
  });
  await page.goto(`${runPhantom.url}/search`);
  await expect(page.getByRole("status").filter({ hasText: "Searching local traces" })).toBeVisible();
  await expect(page.getByText("No captured runs yet", { exact: true })).toHaveCount(0);
  releaseResponse();
  await expect(page.getByRole("alert")).toContainText("Search capacity is busy");
  await expect(page.getByText("No captured runs yet", { exact: true })).toHaveCount(0);
  failSearch = false;
  await page.getByRole("button", { name: "Retry search" }).click();
  await expect(page.getByText("No captured runs yet", { exact: true })).toBeVisible();
  await seedSearchRuns(request, runPhantom.url);
  await expect(page.locator(row(0))).toBeVisible();
  await page.getByLabel("Search captured runs", { exact: true }).fill("nothing matches this phrase");
  await expect(page.getByText("No matching runs", { exact: true })).toBeVisible();
  await expect(page.getByText("No captured runs yet", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Clear all filters" }).click();
  await expect(page.locator("[data-run-id]")).toHaveCount(3);
});

test("search ignores late query responses and refreshes matching ingested traces", async ({ page, request, runPhantom }) => {
  await seedSearchRuns(request, runPhantom.url);
  let releaseOld!: () => void;
  let oldHandled!: () => void;
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  const handled = new Promise<void>((resolve) => { oldHandled = resolve; });
  await page.route("**/api/runs/search?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("q") !== "amber-only") return route.continue();
    const response = await route.fetch();
    await oldGate;
    try { await route.fulfill({ response }); } finally { oldHandled(); }
  });
  await page.goto(`${runPhantom.url}/search`);
  await expect(page.locator(row(0))).toBeVisible();
  const oldRequest = page.waitForRequest((req) => new URL(req.url()).pathname === "/api/runs/search" && new URL(req.url()).searchParams.get("q") === "amber-only");
  await page.getByLabel("Search captured runs", { exact: true }).fill("amber-only");
  await oldRequest;
  await page.getByLabel("Search captured runs", { exact: true }).fill("cobalt-only");
  await expect(page.locator(row(1))).toBeVisible();
  await expect(page.locator("[data-run-id]")).toHaveCount(1);
  releaseOld();
  await handled;
  await expect(page.locator(row(0))).toHaveCount(0);
  await expect(page.getByLabel("Search captured runs", { exact: true })).toHaveValue("cobalt-only");
  await page.getByLabel("Search captured runs", { exact: true }).fill("Search fixture 9");
  await expect(page.getByText("No matching runs", { exact: true })).toBeVisible();
  await seedSearchRuns(request, runPhantom.url, 1, 9);
  await expect(page.locator(row(9))).toBeVisible();
  await expect(page.locator("[data-run-id]")).toHaveCount(1);
});

test("mobile search keeps direct links and keyboard controls usable", async ({ page, request, runPhantom }) => {
  await seedSearchRuns(request, runPhantom.url);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${runPhantom.url}/search/${runId(0)}?q=cobalt-only`);
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toBeVisible();
  await expect(page.getByLabel("Search captured runs", { exact: true })).toBeHidden();
  await page.getByRole("tab", { name: "Span Tree", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/search/${runId(0)}/spans\\?q=cobalt-only`));
  await page.locator("[data-span-row]").first().click();
  expect(new URL(page.url()).searchParams.get("q")).toBe("cobalt-only");
  await page.getByRole("button", { name: "Back to search", exact: true }).click();
  const search = page.getByLabel("Search captured runs", { exact: true });
  await expect(search).toBeVisible();
  await expect(search).toHaveValue("cobalt-only");
  await expect(page.locator(row(1))).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Status", exact: true })).toBeVisible();
  await expect(page.getByLabel("Model", { exact: true })).toBeVisible();
  const bounds = await page.getByLabel("Search results", { exact: true }).boundingBox();
  expect(bounds!.width).toBeGreaterThan(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press("/");
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(page.locator("[data-run-id]")).toHaveCount(3);
  mkdirSync(evidencePath, { recursive: true });
  await page.screenshot({ path: path.join(evidencePath, "mobile-search-filters.png"), fullPage: true });
});

test("mobile search shows a missing deep link instead of hiding the detail view", async ({ page, runPhantom }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${runPhantom.url}/search/${runId(999)}`);
  await expect(page.getByText("Trace not found", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to search", exact: true }).click();
  await expect(page.getByText("No captured runs yet", { exact: true })).toBeVisible();
});

test("search preserves filters through invalid span routes and external span navigation", async ({ page, request, runPhantom }) => {
  await seedSearchRuns(request, runPhantom.url);
  const base = `${runPhantom.url}/search/${runId(0)}`;
  const filters = "?q=amber-only&model=model-alpha&provider=openai";
  await page.goto(`${base}/span/missing-span${filters}`);
  await expect(page).toHaveURL(`${base}/spans${filters}`);
  await expect(page.getByLabel("Search captured runs", { exact: true })).toHaveValue("amber-only");
  await page.goto(`${base}/convo${filters}`);
  await expect(page).toHaveURL(`${base}${filters}`);
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toBeVisible();
  await page.evaluate((spanId) => window.dispatchEvent(new CustomEvent("runphantom:deep-link-span", { detail: { spanId } })), runId(0).slice(-16));
  await expect(page).toHaveURL(`${base}/span/${runId(0).slice(-16)}${filters}`);
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("model-alpha");
  await expect(page.getByLabel("Provider", { exact: true })).toHaveValue("openai");
});

test("search import reports malformed and oversized files before contacting the server", async ({ page, runPhantom }) => {
  let imports = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/import-run") imports++; });
  await page.goto(`${runPhantom.url}/search`);
  const file = page.getByLabel("Import trace file", { exact: true });
  await file.setInputFiles({ name: "broken.json", mimeType: "application/json", buffer: Buffer.from("{broken") });
  await expect(page.getByRole("alert")).toContainText("This file is not valid JSON.");
  await file.setInputFiles({ name: "oversized.json", mimeType: "application/json", buffer: Buffer.alloc(10 * 1024 * 1024 + 1, " ") });
  await expect(page.getByRole("alert")).toContainText("smaller than 10 MiB");
  expect(imports).toBe(0);
  await expect(page.getByRole("button", { name: "Import trace", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Search captured runs", { exact: true })).toBeVisible();
});
