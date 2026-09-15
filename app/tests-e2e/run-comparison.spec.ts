import { test, expect } from "./fixtures";
import type { CapturedComparisonSpan, RunComparison } from "../../src/run-comparison-protocol";

const BASELINE = "comparison-browser-before";
const CANDIDATE = "comparison-browser-after";
function evidence(candidate: boolean) {
  const runId = candidate ? CANDIDATE : BASELINE;
  const suffix = candidate ? "new" : "old";
  const at = Date.now() - 10000;
  const span = (id: string, name: string, extra: Partial<CapturedComparisonSpan> = {}): CapturedComparisonSpan => ({
    id: `${id}-${suffix}`, run_id: runId, name, parent_span_id: id === "root" ? null : `root-${suffix}`, span_type: id === "root" ? "AGENT_ROOT" : "TOOL_CALL",
    status: "OK", input_payload: '{"order":"local-42"}', output_payload: '{"ok":true}', model: "fixture-model", provider: "local-fixture",
    start_time_ms: at, end_time_ms: at + 10, duration_ms: 10, input_tokens: 0, output_tokens: 0, attributes: null, ...extra,
  });
  const spans = [span("root", "Comparison checkout", { output_payload: candidate ? "Checkout verified" : "Checkout failed" }),
    span("payment", "fixture_payment", { status: candidate ? "OK" : "ERROR", input_payload: candidate ? '{"dryRun":true}' : '{"dryRun":false}',
      output_payload: candidate ? '{"ok":true}' : '{"error":"declined"}', input_tokens: null }),
    span("catalog", "catalog_lookup"), span("retry-a", "duplicate_retry"), span("retry-b", "duplicate_retry")];
  if (candidate) spans.push(span("audit", "audit_receipt"));
  return { format: "runphantom-trace/v1", run: { id: runId, name: runId, started_at: at, last_updated_at: at + 10,
    metadata: candidate ? JSON.stringify({ replay: { sourceRunId: BASELINE, mode: "local" } }) : null }, spans, annotations: [], liveEvents: [] };
}

for (const mobile of [false, true]) test(`captured comparison shows actual field changes and ambiguity with original span links (${mobile ? "mobile" : "desktop"})`, async ({ page, request, runPhantom }, testInfo) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  for (const candidate of [false, true]) expect((await request.post(`${runPhantom.url}/api/import-run`, { data: evidence(candidate) })).ok()).toBe(true);
  const response = await request.get(`${runPhantom.url}/api/runs/compare?baseline=${BASELINE}&candidate=${CANDIDATE}`);
  expect(response.ok()).toBe(true); expect(response.headers()["cache-control"]).toContain("no-store");
  const report = await response.json() as RunComparison;
  expect(report.counts).toMatchObject({ paired: 3, changed: 2, unchanged: 1, added: 1, removed: 0, ambiguous: 1, ambiguousBaselineSpans: 2, ambiguousCandidateSpans: 2 });

  await page.goto(`${runPhantom.url}/runs/${CANDIDATE}`);
  const comparison = page.getByRole("region", { name: "Captured run comparison" });
  const toggle = comparison.getByRole("button", { name: "Compare captured changes", exact: true });
  await toggle.focus(); await toggle.press("Enter");
  await expect(page).toHaveURL(/debugCompare=1/);
  await expect(comparison.locator('[data-comparison-count="changed"]')).toHaveText("2");
  await expect(comparison.locator('[data-comparison-count="ambiguous"]')).toHaveText("1");
  const payment = comparison.locator('[data-comparison-row="changed"]').filter({ has: page.locator("summary", { hasText: "fixture_payment" }) });
  await payment.locator("summary").first().click();
  await expect(payment.locator('[data-comparison-field="input_payload"]')).toContainText('{"dryRun":false}');
  await expect(payment.locator('[data-comparison-field="input_payload"]')).toContainText('{"dryRun":true}');
  await expect(payment.locator('[data-comparison-field="status"]')).toContainText("ERROR");
  await expect(payment.locator('[data-comparison-field="status"]')).toContainText("OK");
  await expect(payment.locator('[data-comparison-field="input_tokens"]')).toContainText("Unavailable · missing");
  const originalLink = payment.getByRole("link", { name: "Open baseline span fixture_payment in a new tab", exact: true });
  const [detail] = await Promise.all([page.waitForEvent("popup"), originalLink.click()]);
  try {
    await expect(detail).toHaveURL(new RegExp(`/runs/${BASELINE}/span/payment-old$`));
    await expect(detail.locator('[data-span-row="payment-old"]')).toBeVisible();
  } finally { await detail.close(); }
  const ambiguous = comparison.locator('[data-comparison-row="ambiguous"]');
  await ambiguous.locator("summary").click();
  await expect(ambiguous.getByRole("link")).toHaveCount(4);
  await expect(ambiguous).toContainText("2 baseline · 2 candidate spans");
  await expect(ambiguous).toContainText("Correspondence is ambiguous");
  await expect(ambiguous.locator("[data-comparison-field]")).toHaveCount(0);
  await comparison.evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath(`captured-comparison-${mobile ? "mobile" : "desktop"}.png`), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.reload();
  await expect(comparison.locator('[data-comparison-count="changed"]')).toHaveText("2");
  await toggle.click(); await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.goBack(); await expect(toggle).toHaveAttribute("aria-expanded", "true");
  if (!mobile) {
    await page.getByRole("button", { name: "compare", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Span Tree", exact: true })).toHaveCount(2);
    await page.getByRole("tab", { name: "Span Tree", exact: true }).last().click();
    await expect(page.locator('[data-span-row="payment-old"]')).toBeVisible();
  }
});

test("deleted comparison evidence clears the report and remains retryable", async ({ page, request, runPhantom }) => {
  for (const candidate of [false, true]) expect((await request.post(`${runPhantom.url}/api/import-run`, { data: evidence(candidate) })).ok()).toBe(true);
  await page.goto(`${runPhantom.url}/runs/${CANDIDATE}?debugCompare=1`);
  const comparison = page.getByRole("region", { name: "Captured run comparison" });
  await expect(comparison.locator('[data-comparison-count="changed"]')).toHaveText("2");
  expect((await request.delete(`${runPhantom.url}/api/runs/${BASELINE}`)).ok()).toBe(true);
  await comparison.getByRole("button", { name: "Refresh comparison", exact: true }).click();
  await expect(comparison.getByRole("alert")).toContainText("no longer exists");
  await expect(comparison.locator("[data-comparison-count]")).toHaveCount(0);
  expect((await request.post(`${runPhantom.url}/api/import-run`, { data: evidence(false) })).ok()).toBe(true);
  await comparison.getByRole("button", { name: "Retry comparison", exact: true }).click();
  await expect(comparison.locator('[data-comparison-count="changed"]')).toHaveText("2");
});
