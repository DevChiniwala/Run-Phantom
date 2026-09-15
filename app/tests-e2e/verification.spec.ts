import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect, connectTarget, act, observe, assertRuntime } from "./verification-fixture";
import { REPO_ROOT_PATH } from "./fixtures";
import { FIXTURE_PRIMARY_RUN_ID, seedRunPhantomFixtures } from "./helpers";
import type { VerificationFlow, VerificationReport, SessionSummary } from "../../src/verification/protocol";

test("runtime verification: user pairs an app, runs a check, and saves and replays a flow through the UI", async ({ page, context, runPhantom, targetApp }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  await page.goto(`${runPhantom.url}/verification`);
  await page.getByLabel(/^App origin/).fill(targetApp.origin);
  await page.getByLabel(/^Link to run \(optional\)/).selectOption(FIXTURE_PRIMARY_RUN_ID);
  await page.getByRole("button", { name: "Pair app", exact: true }).click();
  const snippet = page.getByLabel("Application connection snippet", { exact: true });
  await expect(snippet).toBeVisible();
  const source = await snippet.innerText();
  const sessionId = /["']?sessionId["']?\s*:\s*["']([^"']+)["']/.exec(source)?.[1];
  const token = /["']?token["']?\s*:\s*["']([^"']+)["']/.exec(source)?.[1];
  if (!sessionId || !token) throw new Error("UI setup snippet must include a session ID and one-time credential");
  const app = await context.newPage();
  try {
    await app.goto(targetApp.origin);
    await app.evaluate(async ({ daemon, id, credential }) => {
      const sdk = await import(`${daemon}/verification/sdk.js`);
      window.runtime = sdk.connect({ url: daemon, sessionId: id, token: credential });
      window.runtime.registerStore("checkout", () => window.checkoutState);
    }, { daemon: runPhantom.url, id: sessionId, credential: token });
    await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Dismiss setup", exact: true }).click();
    await page.getByRole("button", { name: "Run action", exact: true }).click();
    await expect(page.getByRole("region", { name: "App inspection", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Use selector for checkout", exact: true }).click();
    await expect(page.getByLabel(/^Action selector/)).toHaveValue("#checkout");
    await page.getByRole("combobox", { name: "Action", exact: true }).selectOption("click");
    await page.getByRole("combobox", { name: "Check type", exact: true }).selectOption("network");
    await page.getByLabel("Request URL contains", { exact: true }).fill("/api/checkout");
    await page.getByRole("combobox", { name: "Request method", exact: true }).selectOption("POST");
    await page.getByLabel(/^Response status/).fill("200");
    await page.getByLabel("Check name (optional)", { exact: true }).fill("Checkout from user controls");

    await page.getByRole("button", { name: "Run action", exact: true }).click();
    await expect(app.locator("#status")).toHaveText("failed");
    await page.getByRole("button", { name: "Check outcome", exact: true }).click();
    const failedReport = page.getByRole("article", { name: "Checkout from user controls: fail", exact: true });
    await expect(failedReport).toBeVisible({ timeout: 15_000 });
    await expect(failedReport.getByText("POST /api/checkout returns 200", { exact: true })).toBeVisible();
    await expect(failedReport.getByText("Complete capture", { exact: true })).toBeVisible();
    await expect(failedReport.getByText("0 events dropped", { exact: true })).toBeVisible();
    await failedReport.getByText("Capture details", { exact: true }).click();
    await expect(failedReport.getByText(/The starting cursor is excluded/)).toBeVisible();
    await expect(failedReport.getByText("network: observed", { exact: true })).toBeVisible();

    targetApp.setBroken(false);
    await page.getByRole("button", { name: "Run action", exact: true }).click();
    await expect(app.locator("#status")).toHaveText("paid");
    await page.getByRole("button", { name: "Check outcome", exact: true }).click();
    await expect(page.getByRole("article", { name: "Checkout from user controls: pass", exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByLabel("Include current action in step", { exact: true }).check();
    await page.getByRole("button", { name: "Add step to flow", exact: true }).click();
    await page.getByLabel("Flow name", { exact: true }).fill("UI checkout regression");
    await page.getByRole("button", { name: "Save flow", exact: true }).click();
    const replay = page.getByRole("button", { name: "Replay UI checkout regression", exact: true });
    await expect(replay).toBeVisible();
    await replay.focus();
    await replay.press("Enter");
    await expect(page.getByRole("article", { name: "UI checkout regression: pass", exact: true })).toBeVisible({ timeout: 15_000 });
    targetApp.setBroken(true);
    await replay.click();
    await expect(page.getByRole("article", { name: "UI checkout regression: fail", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(`a[href*="${FIXTURE_PRIMARY_RUN_ID}"]`).first()).toBeVisible();

    const screenshotDir = path.join(REPO_ROOT_PATH, "output");
    mkdirSync(screenshotDir, { recursive: true });
    await page.getByRole("heading", { name: "Verification", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(screenshotDir, "verification-desktop.png"), fullPage: true, mask: [snippet] });
    await page.getByRole("heading", { name: "Verification reports", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(screenshotDir, "verification-desktop-reports.png"), fullPage: true, mask: [snippet] });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("heading", { name: "Verification", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Pair app", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: path.join(screenshotDir, "verification-mobile.png"), fullPage: true, mask: [snippet] });
    await page.getByRole("heading", { name: "Verification reports", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(screenshotDir, "verification-mobile-reports.png"), fullPage: true, mask: [snippet] });
    await page.locator(`a[href="/runs/${FIXTURE_PRIMARY_RUN_ID}"]`).first().click();
    await expect(page).toHaveURL(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
    await expect(page.getByRole("tab", { name: "Overview", exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("runtime verification: real cross-origin SDK observes actions, fails broken checkout, and replays a saved fix", async ({ page, context, request, runPhantom, targetApp }) => {
  await seedRunPhantomFixtures(runPhantom.url);
  const session = await connectTarget(page, request, runPhantom, targetApp.origin, FIXTURE_PRIMARY_RUN_ID);
  const filled = await act(request, runPhantom, session.id, { type: "fill", selector: "#name", value: "Ada" });
  expect(filled).toBeGreaterThanOrEqual(0);
  await expect(page.locator("#name")).toHaveValue("Ada");

  const beforeBroken = await act(request, runPhantom, session.id, { type: "click", selector: "#checkout" });
  await expect(page.locator("#status")).toHaveText("failed");
  const broken = await assertRuntime(request, runPhantom, session.id, { kind: "network", urlContains: "/api/checkout", method: "POST", status: 200 }, beforeBroken, "Broken checkout diagnosis");
  expect(broken.status).toBe("fail");
  expect(broken.runId).toBe(FIXTURE_PRIMARY_RUN_ID);

  targetApp.setBroken(false);
  const beforeFixed = await act(request, runPhantom, session.id, { type: "click", selector: "#checkout" });
  const fixed = await assertRuntime(request, runPhantom, session.id, {
    kind: "allOf", predicates: [
      { kind: "network", urlContains: "/api/checkout", method: "POST", status: 200 },
      { kind: "state", store: "checkout", path: "status", equals: "paid" },
      { kind: "element", selector: "#status", state: "present" },
    ],
  }, beforeFixed, "Checkout fixed in browser");
  expect(fixed.status).toBe("pass");
  expect(fixed.evidence.length).toBeGreaterThan(0);

  const flowResponse = await request.post(`${runPhantom.url}/api/verification/flows`, { data: {
    name: "Checkout regression", origin: targetApp.origin,
    steps: [{ command: { type: "click", selector: "#checkout" }, predicate: { kind: "network", urlContains: "/api/checkout", method: "POST", status: 200 } }],
  } });
  expect(flowResponse.ok()).toBe(true);
  const flow = await flowResponse.json() as VerificationFlow;
  for (const [isBroken, expected] of [[true, "fail"], [false, "pass"]] as const) {
    targetApp.setBroken(isBroken);
    const replayResponse = await request.post(`${runPhantom.url}/api/verification/flows/${flow.id}/run`, { data: { sessionId: session.id } });
    expect(replayResponse.ok()).toBe(true);
    const replay = await replayResponse.json() as VerificationReport;
    expect(replay.status).toBe(expected);
    expect(replay.flowId).toBe(flow.id);
    expect(replay.runId).toBe(FIXTURE_PRIMARY_RUN_ID);
  }

  const ui = await context.newPage();
  try {
    await ui.goto(`${runPhantom.url}/verification`);
    await expect(ui.getByRole("heading", { name: /verification/i }).first()).toBeVisible();
    await expect(ui.getByText("Checkout fixed in browser", { exact: true })).toBeVisible();
    await expect(ui.locator(`a[href*="${FIXTURE_PRIMARY_RUN_ID}"]`).first()).toBeVisible();
    await expect(ui.getByRole("button", { name: /pair|create session|connect app/i }).first()).toBeVisible();
    const actionButtons = ui.getByRole("button", { name: /run flow|replay|run saved/i });
    await expect(actionButtons.first()).toBeVisible();
    await actionButtons.first().focus();
    await expect(actionButtons.first()).toBeFocused();
  } finally {
    await ui.close();
  }
});

test("runtime verification: capture includes XHR, routes, signals, and console errors; quiet checks await delayed errors", async ({ page, request, runPhantom, targetApp }) => {
  const session = await connectTarget(page, request, runPhantom, targetApp.origin);
  const xhrCursor = await act(request, runPhantom, session.id, { type: "click", selector: "#xhr" });
  expect((await assertRuntime(request, runPhantom, session.id, { kind: "network", urlContains: "/api/details", status: 200 }, xhrCursor)).status).toBe("pass");
  await act(request, runPhantom, session.id, { type: "click", selector: "#route" });
  await expect(page).toHaveURL(`${targetApp.origin}/confirmed`);
  const signalCursor = await act(request, runPhantom, session.id, { type: "click", selector: "#signal" });
  expect((await assertRuntime(request, runPhantom, session.id, { kind: "signal", name: "checkout.confirmed" }, signalCursor)).status).toBe("pass");
  const consoleCursor = await act(request, runPhantom, session.id, { type: "click", selector: "#console" });
  expect((await assertRuntime(request, runPhantom, session.id, { kind: "console", level: "error", absent: false }, consoleCursor)).status).toBe("pass");
  const events = (await observe(request, runPhantom, session.id)).events;
  expect(events.some((event) => event.type === "route" && String(event.data.url).includes("/confirmed"))).toBe(true);
  expect(events.some((event) => event.type === "network" && event.data.initiator === "xhr")).toBe(true);

  const delayedCursor = await act(request, runPhantom, session.id, { type: "click", selector: "#late-error" });
  expect((await assertRuntime(request, runPhantom, session.id, { kind: "console", level: "error", absent: true }, delayedCursor)).status).toBe("fail");
  const quietCursor = await act(request, runPhantom, session.id, { type: "click", selector: "#noop" });
  const started = Date.now();
  expect((await assertRuntime(request, runPhantom, session.id, { kind: "console", level: "error", absent: true }, quietCursor)).status).toBe("pass");
  expect(Date.now() - started).toBeGreaterThanOrEqual(250);
});

test("runtime verification: a prior action's delayed network response cannot satisfy the next action", async ({ page, request, runPhantom, targetApp }) => {
  const session = await connectTarget(page, request, runPhantom, targetApp.origin);
  await act(request, runPhantom, session.id, { type: "click", selector: "#slow" });
  await expect.poll(async () => (await observe(request, runPhantom, session.id)).events.some((event) => event.type === "network.start" && String(event.data.url).includes("/api/late"))).toBe(true);
  const nextCursor = await act(request, runPhantom, session.id, { type: "click", selector: "#noop" });
  targetApp.releaseDelayed();
  await expect.poll(async () => (await observe(request, runPhantom, session.id)).events.some((event) => event.type === "network" && String(event.data.url).includes("/api/late"))).toBe(true);
  const report = await assertRuntime(request, runPhantom, session.id, { kind: "network", urlContains: "/api/late", status: 200 }, nextCursor);
  expect(report.status).toBe("fail");
});

test("runtime verification: target cannot mutate the daemon and fill secrets never enter evidence or saved flows", async ({ page, request, runPhantom, targetApp }) => {
  const session = await connectTarget(page, request, runPhantom, targetApp.origin);
  const sessionsBefore = await request.get(`${runPhantom.url}/api/verification/sessions`);
  const rawSessions = await sessionsBefore.text();
  expect(rawSessions.includes('"token"')).toBe(false);

  const browserRead = await page.evaluate(async ({ daemon, origin }) => {
    try {
      const response = await fetch(`${daemon}/api/verification/sessions`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ origin }) });
      return { readable: true, status: response.status };
    } catch {
      return { readable: false, status: null };
    }
  }, { daemon: runPhantom.url, origin: targetApp.origin });
  expect(browserRead.readable).toBe(false);
  const forbidden = await request.post(`${runPhantom.url}/api/verification/sessions`, {
    headers: { Origin: targetApp.origin }, data: { origin: targetApp.origin },
  });
  expect(forbidden.status()).toBe(403);
  const after = await request.get(`${runPhantom.url}/api/verification/sessions`);
  expect((await after.json() as SessionSummary[]).length).toBe(1);

  const sentinel = "fixture-only-secret-a62d8";
  await act(request, runPhantom, session.id, { type: "fill", selector: "#password", value: sentinel });
  await expect(page.locator("#password")).toHaveValue(sentinel);
  await act(request, runPhantom, session.id, { type: "state", store: "checkout" });
  await act(request, runPhantom, session.id, { type: "snapshot" });
  const observed = JSON.stringify(await observe(request, runPhantom, session.id));
  expect(observed.includes(sentinel)).toBe(false);

  const save = await request.post(`${runPhantom.url}/api/verification/flows`, { data: {
    name: "Forbidden saved fill", origin: targetApp.origin,
    steps: [{ command: { type: "fill", selector: "#password", value: sentinel }, predicate: { kind: "element", selector: "#status", state: "present" } }],
  } });
  expect(save.status()).toBe(400);
  expect((await save.text()).includes(sentinel)).toBe(false);
  const reports = await request.get(`${runPhantom.url}/api/verification/reports`);
  expect((await reports.text()).includes(sentinel)).toBe(false);
  for (const suffix of ["", "-wal"]) {
    const file = `${runPhantom.dbPath}${suffix}`;
    if (existsSync(file)) expect(readFileSync(file).includes(Buffer.from(sentinel))).toBe(false);
  }
});

test("runtime verification: disconnect restores browser methods and invalidates pending checks", async ({ page, request, runPhantom, targetApp }) => {
  const session = await connectTarget(page, request, runPhantom, targetApp.origin);
  const cursor = await act(request, runPhantom, session.id, { type: "click", selector: "#slow" });
  const checking = assertRuntime(request, runPhantom, session.id, { kind: "network", urlContains: "/never-arrives", status: 200 }, cursor);
  await page.evaluate(() => window.runtime.disconnect());
  expect((await checking).status).toBe("inconclusive");
  expect(await page.evaluate(() => ({
    fetch: fetch === window.originalMethods.fetch,
    pushState: history.pushState === window.originalMethods.pushState,
    console: console.error === window.originalMethods.error,
    xhrOpen: XMLHttpRequest.prototype.open === window.originalMethods.xhrOpen,
    xhrSend: XMLHttpRequest.prototype.send === window.originalMethods.xhrSend,
  }))).toEqual({ fetch: true, pushState: true, console: true, xhrOpen: true, xhrSend: true });
  targetApp.releaseDelayed();
  await expect.poll(async () => (await observe(request, runPhantom, session.id)).session.connected).toBe(false);
  expect((await assertRuntime(request, runPhantom, session.id, { kind: "console", level: "error", absent: true }, cursor)).status).toBe("inconclusive");
});

test("runtime verification: teardown preserves a browser wrapper installed after the SDK", async ({ page, request, runPhantom, targetApp }) => {
  await connectTarget(page, request, runPhantom, targetApp.origin);
  const preserved = await page.evaluate(async () => {
    const captured = window.fetch.bind(window);
    window.lateFetchWrapper = (...args) => captured(...args);
    window.fetch = window.lateFetchWrapper;
    window.runtime.disconnect();
    const identityPreserved = window.fetch === window.lateFetchWrapper;
    const response = await fetch("/api/details");
    return identityPreserved && response.ok;
  });
  expect(preserved).toBe(true);
});

test("runtime verification: compiled SDK serves the exact embedded module and connects from another origin", async ({ page, request, targetApp }) => {
  const compiledUrl = process.env.RUNPHANTOM_COMPILED_URL;
  test.skip(!compiledUrl, "RUNPHANTOM_COMPILED_URL is required for the compiled SDK gate");
  const daemon = { url: compiledUrl!, port: Number(new URL(compiledUrl!).port), dbPath: "" };
  const source = await request.get(`${daemon.url}/verification/sdk.js`, { headers: { Origin: targetApp.origin } });
  expect(source.ok()).toBe(true);
  expect(source.headers()["content-type"]).toContain("javascript");
  expect(source.headers()["access-control-allow-origin"]).toBe(targetApp.origin);
  expect(await source.text()).toBe(readFileSync(path.join(REPO_ROOT_PATH, "src/verification/browser-sdk.js"), "utf8"));
  const session = await connectTarget(page, request, daemon, targetApp.origin);
  try {
    const cursor = await act(request, daemon, session.id, { type: "click", selector: "#signal" });
    const report = await assertRuntime(request, daemon, session.id, { kind: "signal", name: "checkout.confirmed" }, cursor);
    expect(report.status).toBe("pass");
  } finally {
    await page.evaluate(() => window.runtime.disconnect());
    await request.delete(`${daemon.url}/api/verification/sessions/${session.id}`);
  }
});
