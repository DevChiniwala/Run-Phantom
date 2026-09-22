import type { WebSocketRoute } from "@playwright/test";
import { expect, test } from "./fixtures";
import { clearRunPhantom, FIXTURE_PRIMARY_RUN_ID, FIXTURE_SAVED_SIBLING_RUN_ID, seedRunPhantomFixtures } from "./helpers";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

for (const view of ["", "/convo"]) {
  test(`deletion suspends selected detail reads until the held DELETE settles (${view || "overview"})`, async ({ page, runPhantom }) => {
    await clearRunPhantom(runPhantom.url);
    await seedRunPhantomFixtures(runPhantom.url);
    let socket!: WebSocketRoute;
    await page.routeWebSocket("**/ws", ws => { socket = ws; ws.connectToServer(); });
    const issues: string[] = [];
    page.on("console", message => {
      if (["error", "warning"].includes(message.type())) issues.push(message.text());
    });
    page.on("pageerror", error => issues.push(error.message));
    page.on("response", response => {
      if (new URL(response.url()).pathname.startsWith("/api/") && response.status() >= 400) {
        issues.push(`${response.status()} ${response.url()}`);
      }
    });
    const failedRequests: Array<{ url: string; error: string | undefined }> = [];
    page.on("requestfailed", request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
    const detailUrl = `${runPhantom.url}/api/runs/detail/${FIXTURE_PRIMARY_RUN_ID}`;
    const initialDetail = await (await fetch(detailUrl)).json() as { run: { convo_id: string } };
    const conversationUrl = `${runPhantom.url}/api/convo/${encodeURIComponent(initialDetail.run.convo_id)}`;
    let detailRequests = 0;
    let holdDetail = false;
    const detailHeld = gate();
    const detailRelease = gate();
    await page.route(detailUrl, async route => {
      detailRequests++;
      const response = await route.fetch();
      if (holdDetail) {
        detailHeld.release();
        await detailRelease.promise;
      }
      await route.fulfill({ response });
    });
    const deleteHeld = gate();
    const deleteRelease = gate();
    await page.route(`${runPhantom.url}/api/runs/${FIXTURE_PRIMARY_RUN_ID}`, async route => {
      if (route.request().method() !== "DELETE") return route.continue();
      const response = await route.fetch(); // Deletes and broadcasts before the response reaches the UI.
      expect(response.ok()).toBe(true);
      deleteHeld.release();
      await deleteRelease.promise;
      await route.fulfill({ response });
    });
    await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}${view}`);
    await expect(page.getByRole("button", { name: "More actions" })).toBeVisible();
    if (view) await expect(page.getByLabel("Conversation", { exact: true }).getByText("conversation", { exact: true })).toBeVisible();
    const listHeld = gate();
    const listRelease = gate();
    let holdNextList = true;
    await page.route(`${runPhantom.url}/api/runs`, async route => {
      if (!holdNextList) return route.continue();
      holdNextList = false;
      const response = await route.fetch();
      listHeld.release();
      await listRelease.promise;
      await route.fulfill({ response });
    });
    // Start a real refresh, then keep its old data in flight across the delete.
    holdDetail = true;
    socket.send(JSON.stringify({ event: "spans", data: { runIds: [FIXTURE_PRIMARY_RUN_ID] } }));
    await Promise.all([detailHeld.promise, listHeld.promise]);
    await page.getByRole("button", { name: "More actions" }).click();
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("menuitem", { name: "Delete run" }).click();
    await deleteHeld.promise;
    await expect(page).toHaveURL(new RegExp(`${FIXTURE_PRIMARY_RUN_ID}${view}$`));
    const readsWhileDeleting = detailRequests;
    // The list refresh proves that the same frame which used to refetch the
    // removed detail has been processed, without relying on a sleep.
    const listRefreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/runs");
    socket.send(JSON.stringify({ event: "spans", data: { runIds: [FIXTURE_PRIMARY_RUN_ID] } }));
    socket.send(JSON.stringify({ event: "live", data: { traceId: FIXTURE_PRIMARY_RUN_ID } }));
    await listRefreshed;
    expect(detailRequests).toBe(readsWhileDeleting);
    deleteRelease.release();
    await expect(page).not.toHaveURL(new RegExp(FIXTURE_PRIMARY_RUN_ID));
    detailRelease.release();
    const staleListDelivered = page.waitForResponse(response => new URL(response.url()).pathname === "/api/runs");
    listRelease.release();
    await staleListDelivered;
    await expect(page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "More actions" })).toBeVisible();
    // Reopen the surviving conversation in the same client/cache. The removed
    // run must not be reintroduced by the held detail or conversation response.
    await page.locator(`[data-run-id="${FIXTURE_SAVED_SIBLING_RUN_ID}"]`).click();
    await expect(page).toHaveURL(new RegExp(FIXTURE_SAVED_SIBLING_RUN_ID));
    await page.getByRole("tab", { name: "Conversation" }).click();
    await expect(page.getByLabel("Conversation", { exact: true }).getByText("conversation", { exact: true })).toBeVisible();
    expect(detailRequests).toBe(readsWhileDeleting);
    expect(issues).toEqual([]);
    // Deletion/unmount cancels these fixture-owned detail and conversation reads.
    // All other failed requests still fail; the release audit remains unchanged.
    for (const failure of failedRequests) {
      expect([detailUrl, conversationUrl, `${runPhantom.url}/api/runs/detail/${FIXTURE_SAVED_SIBLING_RUN_ID}`]).toContain(failure.url);
      expect(failure.error).toBe("net::ERR_ABORTED");
    }
  });
}

test("failed deletion keeps the selected trace and resumes live reads", async ({ page, runPhantom }) => {
  await clearRunPhantom(runPhantom.url);
  await seedRunPhantomFixtures(runPhantom.url);
  let socket!: WebSocketRoute;
  await page.routeWebSocket("**/ws", ws => { socket = ws; ws.connectToServer(); });
  const held = gate();
  const release = gate();
  await page.route(`**/api/runs/${FIXTURE_PRIMARY_RUN_ID}`, async route => {
    held.release();
    await release.promise;
    await route.fulfill({ status: 503, json: { error: "Delete temporarily unavailable" } });
  });
  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  await page.getByRole("button", { name: "More actions" }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("menuitem", { name: "Delete run" }).click();
  await held.promise;
  await expect(page).toHaveURL(new RegExp(`${FIXTURE_PRIMARY_RUN_ID}$`));
  release.release();
  await expect(page.getByRole("alert")).toHaveText("Delete temporarily unavailable");
  await expect(page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`)).toBeVisible();
  const refreshed = page.waitForResponse(`**/api/runs/detail/${FIXTURE_PRIMARY_RUN_ID}`);
  socket.send(JSON.stringify({ event: "spans", data: { runIds: [FIXTURE_PRIMARY_RUN_ID] } }));
  expect((await refreshed).status()).toBe(200);
  await expect(page).toHaveURL(new RegExp(`${FIXTURE_PRIMARY_RUN_ID}$`));
});

test("an unknown trace still returns a meaningful 404", async ({ page, runPhantom }) => {
  const missing = "ffffffffffffffffffffffffffffffff";
  const response = page.waitForResponse(`**/api/runs/detail/${missing}`);
  await page.goto(`${runPhantom.url}/runs/${missing}`);
  expect((await response).status()).toBe(404);
  await expect(page.getByText("This trace is not available in the current workspace.", { exact: false })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${missing}$`));
});

for (const status of [200, 503]) {
  test(`settling DELETE(${status}) does not change another selected run`, async ({ page, runPhantom }) => {
    await clearRunPhantom(runPhantom.url);
    await seedRunPhantomFixtures(runPhantom.url);
    const held = gate();
    const release = gate();
    await page.route(`**/api/runs/${FIXTURE_PRIMARY_RUN_ID}`, async route => {
      held.release();
      await release.promise;
      if (status === 200) await route.continue();
      else await route.fulfill({ status, json: { error: "Delete temporarily unavailable" } });
    });
    await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
    await page.getByRole("button", { name: "More actions" }).click();
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("menuitem", { name: "Delete run" }).click();
    await held.promise;
    await page.locator(`[data-run-id="${FIXTURE_SAVED_SIBLING_RUN_ID}"]`).click();
    await expect(page).toHaveURL(new RegExp(FIXTURE_SAVED_SIBLING_RUN_ID));
    const settled = page.waitForResponse(`**/api/runs/${FIXTURE_PRIMARY_RUN_ID}`);
    release.release();
    expect((await settled).status()).toBe(status);
    // A render boundary after the response also exercises reuse of MoreMenu.
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Delete run" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(FIXTURE_SAVED_SIBLING_RUN_ID));
  });
}

test("returning to a pending deletion still navigates away on success", async ({ page, runPhantom }) => {
  await clearRunPhantom(runPhantom.url);
  await seedRunPhantomFixtures(runPhantom.url);
  const held = gate();
  const release = gate();
  await page.route(`**/api/runs/${FIXTURE_PRIMARY_RUN_ID}`, async route => {
    held.release();
    await release.promise;
    await route.continue();
  });
  await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
  await page.getByRole("button", { name: "More actions" }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("menuitem", { name: "Delete run" }).click();
  await held.promise;
  await page.locator(`[data-run-id="${FIXTURE_SAVED_SIBLING_RUN_ID}"]`).click();
  await expect(page).toHaveURL(new RegExp(FIXTURE_SAVED_SIBLING_RUN_ID));
  await page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`).click();
  await expect(page).toHaveURL(new RegExp(FIXTURE_PRIMARY_RUN_ID));
  const detailReads: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === `/api/runs/detail/${FIXTURE_PRIMARY_RUN_ID}`) detailReads.push(request.url());
  });
  release.release();
  await expect(page).not.toHaveURL(new RegExp(FIXTURE_PRIMARY_RUN_ID));
  await expect(page.getByRole("button", { name: "More actions" })).toBeVisible();
  expect(detailReads).toEqual([]);
});

test("failed deletion resumes an initially pending conversation query", async ({ page, runPhantom }) => {
  await clearRunPhantom(runPhantom.url);
  await seedRunPhantomFixtures(runPhantom.url);
  const firstHeld = gate();
  const firstRelease = gate();
  let conversationRequests = 0;
  await page.route("**/api/convo/*", async route => {
    conversationRequests++;
    if (conversationRequests !== 1) return route.continue();
    const response = await route.fetch();
    firstHeld.release();
    await firstRelease.promise;
    await route.fulfill({ response });
  });
  await page.route(`**/api/runs/${FIXTURE_PRIMARY_RUN_ID}`, route =>
    route.fulfill({ status: 503, json: { error: "Delete temporarily unavailable" } }));
  try {
    await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}/convo`);
    await firstHeld.promise;
    await page.getByRole("button", { name: "More actions" }).click();
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("menuitem", { name: "Delete run" }).click();
    await expect(page.getByRole("alert")).toHaveText("Delete temporarily unavailable");
    await expect.poll(() => conversationRequests).toBeGreaterThan(1);
    await expect(page.getByLabel("Conversation", { exact: true }).getByText("conversation", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${FIXTURE_PRIMARY_RUN_ID}/convo$`));
  } finally { firstRelease.release(); }
});

test("successful deletion resumes a newly selected pending conversation", async ({ page, runPhantom }) => {
  await clearRunPhantom(runPhantom.url);
  await seedRunPhantomFixtures(runPhantom.url);
  const deleteHeld = gate();
  const deleteRelease = gate();
  const conversationHeld = gate();
  const conversationRelease = gate();
  let conversationRequests = 0;
  await page.route(`**/api/runs/${FIXTURE_PRIMARY_RUN_ID}`, async route => {
    deleteHeld.release();
    await deleteRelease.promise;
    await route.continue();
  });
  await page.route("**/api/convo/*", async route => {
    conversationRequests++;
    if (conversationRequests !== 1) return route.continue();
    const response = await route.fetch();
    conversationHeld.release();
    await conversationRelease.promise;
    await route.fulfill({ response });
  });
  try {
    await page.goto(`${runPhantom.url}/runs/${FIXTURE_PRIMARY_RUN_ID}`);
    await page.getByRole("button", { name: "More actions" }).click();
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("menuitem", { name: "Delete run" }).click();
    await deleteHeld.promise;
    await page.locator(`[data-run-id="${FIXTURE_SAVED_SIBLING_RUN_ID}"]`).click();
    await page.getByRole("tab", { name: "Conversation" }).click();
    await conversationHeld.promise;
    const deleted = page.waitForResponse(response => response.request().method() === "DELETE");
    deleteRelease.release();
    expect((await deleted).status()).toBe(200);
    await expect.poll(() => conversationRequests).toBeGreaterThan(1);
    await expect(page.getByLabel("Conversation", { exact: true }).getByText("conversation", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${FIXTURE_SAVED_SIBLING_RUN_ID}/convo$`));
    await expect(page.locator(`[data-run-id="${FIXTURE_PRIMARY_RUN_ID}"]`)).toHaveCount(0);
  } finally { deleteRelease.release(); conversationRelease.release(); }
});
