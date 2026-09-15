import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let directory: string;
let bundle: string;
test.beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "rp-replay-hook-"));
  const outfile = path.join(directory, "harness.js");
  execFileSync("bun", ["build", path.join(import.meta.dirname, "replay-hook-harness.tsx"), "--target=browser", "--outfile", outfile], { stdio: "pipe" });
  bundle = readFileSync(outfile, "utf8");
});
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));
test.beforeEach(async ({ page }) => {
  await page.route("http://replay.test/**", route => route.fulfill({ contentType: route.request().url().endsWith(".js") ? "text/javascript" : "text/html",
    body: route.request().url().endsWith(".js") ? bundle : '<div id="root"></div><script type="module" src="/harness.js"></script>' }));
  await page.goto("http://replay.test/");
  await expect(page.getByTestId("state")).toHaveText("idle");
  await page.clock.install();
});

const act = (page: Page, code: string) => page.evaluate(`(() => { const h = window.replayHarness; ${code} })()`);
async function start(page: Page, index: number, placeholder = `placeholder-${index}`) {
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(() => act(page, "return h.requests.length")).toBe(index + 1);
  await act(page, `h.open(${index}); h.emit(${index}, {type:'replay_started', replayRunId:${JSON.stringify(placeholder)}});`);
  await expect(page.getByTestId("state")).toHaveText("running");
}
const completed = (id: string) => ({ type: "replay_complete", replayRunId: id, iterations: 2, toolCallCount: 0, matchStats: { exact: 0, ordered: 0, name_only: 0, fallback: 0 } });

test("a held attempt never selects a recent unrelated replay", async ({ page }) => {
  await start(page, 0);
  await page.clock.runFor(850);
  await expect.poll(() => act(page, "return h.details.length")).toBe(1);
  await act(page, "h.detail(0, false)");
  await expect(page.getByTestId("run")).toHaveText("none");
  expect(await act(page, "return h.listRequests")).toBe(0);
});

for (const sameSource of [false, true]) test(`overlapping starts retain ownership (${sameSource ? "same" : "different"} source)`, async ({ page }) => {
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(() => act(page, "return h.requests.length")).toBe(1);
  if (!sameSource) await page.getByLabel("Source").fill("source-b");
  await start(page, 1);
  await act(page, `h.emit(1, ${JSON.stringify(completed("final-b"))}); h.end(1);`);
  await expect(page.getByTestId("run")).toHaveText("final-b");
  await act(page, `h.open(0); h.emit(0, ${JSON.stringify(completed("late-a"))}); h.end(0);`);
  await expect(page.getByTestId("state")).toHaveText("complete");
  await expect(page.getByTestId("run")).toHaveText("final-b");
  expect(await act(page, "return h.callbacks")).toEqual(["final-b"]);
  expect(await act(page, "return h.requests[0].signal.aborted")).toBe(true);
});

test("late placeholder polls cannot overwrite completion or a new attempt", async ({ page }) => {
  await start(page, 0);
  await page.clock.runFor(850);
  await expect.poll(() => act(page, "return h.details.length")).toBe(1);
  await act(page, `h.emit(0, ${JSON.stringify(completed("final-a"))}); h.end(0);`);
  await expect(page.getByTestId("run")).toHaveText("final-a");
  await act(page, "h.detail(0)");
  await expect(page.getByTestId("run")).toHaveText("final-a");
  await start(page, 1);
  await page.clock.runFor(850);
  await expect.poll(() => act(page, "return h.details.length")).toBe(2);
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await start(page, 2);
  await act(page, "h.detail(1)");
  await expect(page.getByTestId("run")).toHaveText("none");
  await expect(page.getByTestId("state")).toHaveText("running");
  expect(await act(page, "return h.callbacks")).toEqual(["final-a"]);
});

for (const action of ["Cancel", "Reset", "Toggle mount", "Existing"]) test(`${action} invalidates pending requests and cleans readers`, async ({ page }) => {
  await start(page, 0);
  await page.clock.runFor(850);
  await expect.poll(() => act(page, "return h.details.length")).toBe(1);
  await page.getByRole("button", { name: action, exact: true }).click();
  await act(page, "h.detail(0)");
  expect(await act(page, "return h.requests[0].signal.aborted")).toBe(true);
  await expect.poll(() => act(page, "return h.cancelledReaders")).toBe(1);
  expect(await act(page, "return h.callbacks")).toEqual(action === "Existing" ? ["existing-run"] : []);
  if (action !== "Toggle mount") await expect(page.getByTestId("run")).toHaveText(action === "Existing" ? "existing-run" : "none");
  await page.clock.runFor(2500);
  expect(await act(page, "return h.details.length")).toBe(1);
});

test("bare stream EOF is interrupted while authoritative completion succeeds", async ({ page }) => {
  await start(page, 0);
  await act(page, "h.end(0)");
  await expect(page.getByTestId("state")).toHaveText("error");
  await expect(page.getByTestId("error")).toContainText("before completion");
  await start(page, 1);
  await act(page, `h.emit(1, ${JSON.stringify(completed("success"))}); h.end(1);`);
  await expect(page.getByTestId("state")).toHaveText("complete");
  await expect(page.getByTestId("run")).toHaveText("success");
});

test("stale HTTP failure cannot overwrite a newer successful replay", async ({ page }) => {
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await start(page, 1);
  await act(page, `h.emit(1, ${JSON.stringify(completed("new-success"))}); h.end(1); h.fail(0);`);
  await expect(page.getByTestId("state")).toHaveText("complete");
  await expect(page.getByTestId("error")).toHaveText("none");
  await expect(page.getByTestId("run")).toHaveText("new-success");
});
