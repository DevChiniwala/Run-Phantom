import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import protobuf from "protobufjs";
import { startTeamFixture, type TeamFixture } from "../../tests/helpers/team-server";

const test = base.extend<{ team: TeamFixture }>({ team: async ({}, use) => { const team = await startTeamFixture("browser", process.env.RUNPHANTOM_TEAM_TEST_BINARY); try { await use(team); } finally { await team.close(); } } });
const password = "Team acceptance passphrase 2026";
const id = (n: number) => n.toString(16).padStart(32, "0");
const evidence = process.env.RUNPHANTOM_TEAM_EVIDENCE_DIR ?? path.resolve(import.meta.dirname, "../../output/playwright/team-workspace");
const capturedOutput = 'Searchable customer reply: <img src="https://captured.example.invalid/pixel">';
const literal = '{"n":9007199254740993,"duplicate":1,"duplicate":2,"html":"<img src=https://captured.example.invalid/pixel>"}';
const wire = protobuf.parse(`syntax="proto3";
message Value { string string_value=1; } message Attribute { string key=1; Value value=2; }
message Status { int32 code=3; } message Span { bytes trace_id=1; bytes span_id=2; string name=5; fixed64 start_time_unix_nano=7; fixed64 end_time_unix_nano=8; repeated Attribute attributes=9; Status status=15; }
message ScopeSpans { repeated Span spans=2; } message ResourceSpans { repeated ScopeSpans scope_spans=2; } message Request { repeated ResourceSpans resource_spans=1; }`).root.lookupType("Request");

async function mutate<T>(request: APIRequestContext, url: string, endpoint: string, body?: unknown, method = "POST"): Promise<T> {
  const session = await (await request.get(`${url}/api/team/session`)).json();
  const response = await request.fetch(`${url}/api/team${endpoint}`, { method, headers: { Origin: url, ...(session.csrfToken ? { "X-RunPhantom-CSRF": session.csrfToken } : {}) }, ...(body === undefined ? {} : { data: body }) });
  expect(response.ok(), `${method} ${endpoint}: ${await response.text()}`).toBe(true);
  return response.status() === 204 ? undefined as T : response.json();
}
async function setup(page: Page, team: TeamFixture, name = "Support agents") {
  await page.goto(`${team.url}/team`);
  await page.getByLabel("Setup code").fill(team.setupCode);
  await page.getByLabel("Email", { exact: true }).fill("owner@example.test");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create owner account", exact: true }).click();
  await page.getByLabel("Project name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page).toHaveURL(/\/team\/projects\/[^/]+$/);
  return new URL(page.url()).pathname.split("/")[3];
}
async function seed(request: APIRequestContext, team: TeamFixture, key: string, count = 3, binary = false) {
  const started = Date.now() - 60_000;
  const spans = Array.from({ length: count }, (_, n) => ({ traceId: id(n + 1), spanId: id(n + 101).slice(-16), name: `Team capture ${n + 1}`,
    startTimeUnixNano: String(BigInt(started - n * 1000) * 1_000_000n), endTimeUnixNano: String(BigInt(started - n * 1000 + 50) * 1_000_000n), status: { code: 1 },
    attributes: Object.entries({ "openinference.span.kind": "AGENT", "input.value": "Same captured input", "output.value": n === 2 ? capturedOutput : "Approved answer", "gen_ai.request.model": n === 1 ? "team-beta" : "team-alpha", "gen_ai.provider.name": "openai" }).map(([key, value]) => ({ key, value: { stringValue: value } })),
  }));
  const payload = { resourceSpans: [{ scopeSpans: [{ spans: binary ? spans.map(span => ({ ...span, traceId: Buffer.from(span.traceId, "hex"), spanId: Buffer.from(span.spanId, "hex") })) : spans }] }] };
  const response = await request.post(`${team.url}/api/team/ingest/v1/traces`, { headers: { Authorization: `Bearer ${key}`, "Content-Type": binary ? "application/x-protobuf" : "application/json", ...(binary ? { "Content-Encoding": "gzip" } : {}) }, data: binary ? gzipSync(wire.encode(wire.fromObject(payload)).finish()) : payload });
  expect(response.ok(), await response.text()).toBe(true);
}
async function accept(page: Page, team: TeamFixture, token: string, email: string) {
  await page.goto(`${team.url}/team/invite`); await page.getByLabel("Invitation code").fill(token); await page.getByLabel("Email", { exact: true }).fill(email); await page.getByLabel("Password").fill(password); await page.getByRole("button", { name: "Accept invitation", exact: true }).click(); await expect(page).toHaveURL(/\/team\/projects\/[^/]+$/);
}

test("team workspace completes setup, role-based sharing, inert evidence, checks and credential lifecycle", async ({ page, browser, team }) => {
  test.setTimeout(180_000);
  const localRequests: string[] = [], external: string[] = [], errors: string[] = [];
  page.on("request", request => { const url = new URL(request.url()); if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/team/")) localRequests.push(url.pathname); if (url.hostname === "captured.example.invalid") external.push(request.url()); });
  page.on("websocket", socket => localRequests.push(socket.url())); page.on("pageerror", error => errors.push(error.message));
  const project = await setup(page, team); const prefix = `/projects/${project}`;
  await page.getByRole("link", { name: "Ingestion keys", exact: true }).click();
  await page.getByLabel("Key label", { exact: true }).fill("Acceptance producer"); await page.getByRole("button", { name: "Create ingestion key", exact: true }).click();
  const key = await page.getByRole("textbox", { name: "Ingestion key", exact: true }).inputValue(); expect(key).toBeTruthy();
  await page.getByRole("button", { name: "Hide ingestion key" }).click(); await expect(page.getByRole("textbox", { name: "Ingestion key", exact: true })).toHaveCount(0);
  await seed(page.request, team, key, 3, true);
  await page.getByRole("link", { name: "Traces", exact: true }).click(); await expect(page.getByText("Team capture 3", { exact: true })).toBeVisible();
  await page.getByText("Team capture 3", { exact: true }).click(); await page.getByRole("button", { name: /Team capture 3/ }).click();
  await expect(page.getByRole("region", { name: "Output", exact: true }).locator("pre")).toHaveText(capturedOutput);
  await expect(page.locator("img[src*='captured.example.invalid']")).toHaveCount(0); expect(external).toEqual([]);
  await page.getByLabel("Your note").fill("<script>window.teamInjected=true</script> Investigate this result"); await page.getByRole("button", { name: "Add note", exact: true }).click(); await expect(page.getByText("<script>window.teamInjected=true</script> Investigate this result", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { teamInjected?: boolean }).teamInjected)).toBeUndefined();
  await page.getByRole("link", { name: "Members", exact: true }).click(); await page.getByLabel("Invite email", { exact: true }).fill("editor@example.test"); await page.getByRole("combobox", { name: "Role", exact: true }).selectOption("editor"); await page.getByRole("button", { name: "Create invitation", exact: true }).click();
  const invitation = await page.getByRole("textbox", { name: "Invitation code", exact: true }).inputValue(); await page.getByRole("button", { name: "Hide invitation code" }).click();
  const editorContext = await browser.newContext(), viewerContext = await browser.newContext();
  try {
    const editor = await editorContext.newPage(); await accept(editor, team, invitation, "editor@example.test");
    await editor.getByRole("link", { name: "Checks", exact: true }).click(); await editor.getByRole("link", { name: "Create check", exact: true }).click(); await editor.getByLabel("Check name", { exact: true }).fill("Support answer contract");
    await editor.getByRole("radio", { name: "Reference Team capture 1", exact: true }).check(); await editor.getByRole("checkbox", { name: "Candidate Team capture 2", exact: true }).check(); await editor.getByLabel("Expected text", { exact: true }).fill("Approved answer"); await editor.getByRole("button", { name: "Save and evaluate check" }).click();
    await expect(editor.getByRole("heading", { name: "Support answer contract", exact: true })).toBeVisible(); await expect(editor.locator(".team-badge-pass").first()).toBeVisible(); const checkUrl = editor.url();
    const downloading = editor.waitForEvent("download"); await editor.getByRole("button", { name: "Download check report" }).click(); const download = await downloading; const report = JSON.parse(readFileSync((await download.path())!, "utf8")); expect(report.format).toBe("runphantom-team-check/v1"); expect(JSON.stringify(report)).not.toContain("Same captured input");
    const invite = await mutate<{ token: string }>(page.request, team.url, `${prefix}/invites`, { email: "viewer@example.test", role: "viewer" }); const viewer = await viewerContext.newPage(); await accept(viewer, team, invite.token, "viewer@example.test");
    await viewer.goto(checkUrl); await expect(viewer.getByRole("heading", { name: "Support answer contract", exact: true })).toBeVisible(); await expect(viewer.getByRole("link", { name: "Members", exact: true })).toHaveCount(0);
    await viewer.goto(`${team.url}/team/projects/${project}/traces/${id(3)}`); await expect(viewer.getByText("<script>window.teamInjected=true</script> Investigate this result", { exact: true })).toBeVisible(); await expect(viewer.getByRole("button", { name: "Add note", exact: true })).toHaveCount(0); await expect(viewer.getByRole("button", { name: "Delete trace", exact: true })).toHaveCount(0);
    mkdirSync(evidence, { recursive: true }); await viewer.screenshot({ path: path.join(evidence, "desktop-shared-trace.png"), fullPage: true });
    const members = await (await page.request.get(`${team.url}/api/team${prefix}/members`)).json(); const viewerId = members.items.find((member: { user: { email: string } }) => member.user.email === "viewer@example.test").user.id;
    await mutate(page.request, team.url, `${prefix}/members/${viewerId}`, undefined, "DELETE"); await viewer.reload(); await expect(viewer.getByText("Return to projects", { exact: true })).toBeVisible(); await expect(viewer.getByText("Investigate this result", { exact: false })).toHaveCount(0);
    await editor.getByRole("link", { name: "editor@example.test", exact: true }).click(); await editor.getByLabel("Current password", { exact: true }).fill(password); await editor.getByLabel("New password", { exact: false }).fill(`${password} updated`); await editor.getByRole("button", { name: "Change password", exact: true }).click(); await expect(editor.getByLabel("Current password", { exact: true })).toHaveValue("");
    await editor.getByRole("button", { name: "Sign out", exact: true }).first().click(); await expect(editor.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  } finally { await editorContext.close(); await viewerContext.close(); }
  expect(localRequests).toEqual([]); expect(errors).toEqual([]);
});

test("team mobile search filters, pagination, errors and selected deep links remain scoped", async ({ page, team }) => {
  const project = await setup(page, team); const credential = await mutate<{ token: string }>(page.request, team.url, `/projects/${project}/keys`, { label: "Search producer" }); await seed(page.request, team, credential.token, 55);
  await page.goto(`${team.url}/team/projects/${project}/traces`); await expect(page.getByRole("status")).toContainText("50 traces loaded"); await page.getByRole("button", { name: "Load more", exact: true }).click(); await expect(page.getByRole("status")).toContainText("55 traces loaded");
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole("textbox", { name: "Search traces", exact: true }).fill("customer reply"); await expect(page.getByRole("status")).toContainText("1 trace loaded"); await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("completed"); await page.getByLabel("Model", { exact: true }).fill("team-alpha"); await page.getByLabel("Provider", { exact: true }).fill("openai");
  await page.getByText("Team capture 3", { exact: true }).click(); await page.getByRole("button", { name: /Team capture 3/ }).click(); await expect(page.getByRole("region", { name: "Output", exact: true }).locator("pre")).toHaveText(capturedOutput); await expect(page).toHaveURL(/q=customer\+reply/);
  await page.getByRole("link", { name: "← All traces", exact: true }).click(); await expect(page.getByRole("textbox", { name: "Search traces", exact: true })).toHaveValue("customer reply"); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, "mobile-search.png"), fullPage: true });
  let fail = true; await page.route("**/api/team/projects/*/runs?*", async route => { if (fail) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "busy", message: "Search is temporarily busy.", requestId: "browser-fixture" } }) }); else await route.continue(); });
  await page.getByRole("textbox", { name: "Search traces", exact: true }).fill("nothing"); await expect(page.getByRole("alert")).toContainText("Search is temporarily busy"); await expect(page.getByText("No matching traces", { exact: true })).toHaveCount(0); fail = false; await page.getByRole("button", { name: "Try again", exact: true }).click(); await expect(page.getByText("No matching traces", { exact: true })).toBeVisible();
});

test("team ignores late results after project and principal changes", async ({ page, team }) => {
  const projectA = await setup(page, team, "Project A"); const projectB = await mutate<{ id: string }>(page.request, team.url, "/projects", { name: "Project B" }); const keyA = await mutate<{ token: string }>(page.request, team.url, `/projects/${projectA}/keys`, { label: "A" }); await seed(page.request, team, keyA.token); await page.reload();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/team/projects/${projectA}/runs?*`, async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }).catch(() => {}); });
  const requested = page.waitForRequest(request => request.url().includes(`/projects/${projectA}/runs?`)); await page.getByRole("link", { name: "Traces", exact: true }).click(); await requested;
  await page.getByLabel("Project", { exact: true }).selectOption(projectB.id); await expect(page.getByRole("heading", { name: "Project B", exact: true })).toBeVisible(); release(); await expect(page.getByText("Team capture 1", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out", exact: true }).click(); await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible(); await expect(page.getByRole("heading", { name: "Project B", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }))).toEqual({ local: [], session: [] });
});

test("team admin recovers quota, revokes credentials and preserves frozen checks", async ({ page, team }) => {
  const project = await setup(page, team); const prefix = `/projects/${project}`;
  const key = await mutate<{ token: string }>(page.request, team.url, `${prefix}/keys`, { label: "Temporary producer" }); await seed(page.request, team, key.token);
  const check = await mutate<{ id: string }>(page.request, team.url, `${prefix}/checks`, { name: "Frozen before deletion", referenceRunId: id(1), candidateRunIds: [id(2)], rules: [{ kind: "output", operation: "equals", value: "Approved answer" }] });
  await page.goto(`${team.url}/team/projects/${project}/traces/${id(2)}`); await page.getByRole("button", { name: "Delete trace", exact: true }).click(); await expect(page.getByText(/Saved checks keep their frozen evidence/)).toBeVisible(); await page.getByRole("button", { name: "Confirm trace deletion", exact: true }).click(); await expect(page.getByText("Team capture 2", { exact: true })).toHaveCount(0);
  await page.goto(`${team.url}/team/projects/${project}/checks/${check.id}`); await expect(page.getByRole("heading", { name: "Frozen before deletion", exact: true })).toBeVisible(); await expect(page.locator(".team-badge-pass").first()).toBeVisible();
  await page.getByRole("link", { name: "Ingestion keys", exact: true }).click(); await page.getByRole("button", { name: "Revoke key Temporary producer", exact: true }).click(); await expect(page.getByText("Temporary producer", { exact: true })).toHaveCount(0);
  const denied = await page.request.post(`${team.url}/api/team/ingest/v1/traces`, { headers: { Authorization: `Bearer ${key.token}` }, data: {} }); expect(denied.status()).toBe(401);
  await mutate(page.request, team.url, `${prefix}/invites`, { email: "unused@example.test", role: "viewer" }); await page.getByRole("link", { name: "Members", exact: true }).click(); await page.getByRole("button", { name: "Revoke invitation for unused@example.test", exact: true }).click(); await expect(page.getByText("unused@example.test", { exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Role for owner@example.test", exact: true }).selectOption("viewer"); await page.getByRole("button", { name: "Save role", exact: true }).click(); await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("link", { name: "Audit log", exact: true }).click(); await expect(page.getByText("run deleted", { exact: true })).toBeVisible(); await expect(page.getByText("key revoked", { exact: true })).toBeVisible();
  await page.goto(`${team.url}/team/projects/${project}/traces?q=Approved`); await expect(page.getByRole("textbox", { name: "Search traces", exact: true })).toHaveValue("Approved"); await page.getByRole("link", { name: "Traces", exact: true }).click(); await expect(page.getByRole("textbox", { name: "Search traces", exact: true })).toHaveValue(""); await expect(page).not.toHaveURL(/q=/);
  await page.keyboard.press("/"); await expect(page.getByRole("textbox", { name: "Search traces", exact: true })).toBeFocused(); await page.keyboard.type("no matches"); await page.keyboard.press("Escape"); await expect(page.getByRole("textbox", { name: "Search traces", exact: true })).toHaveValue("");
  const session = await (await page.request.get(`${team.url}/api/team/session`)).json(); await mutate(page.request, team.url, `/sessions/${session.session.id}`, undefined, "DELETE"); await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible({ timeout: 10_000 }); await expect(page.getByText("Team capture 1", { exact: true })).toHaveCount(0);
});

test("team evidence renderer preserves supplied numeric tokens and duplicate keys verbatim", async ({ page, team }) => {
  const project = await setup(page, team); const key = await mutate<{ token: string }>(page.request, team.url, `/projects/${project}/keys`, { label: "Renderer fixture" }); await seed(page.request, team, key.token);
  // Ingestion deliberately withholds lossy JSON; this controlled wire response tests
  // the independent renderer boundary, which must never reparse captured strings.
  await page.route(`**/api/team/projects/${project}/runs/${id(3)}/spans/${id(103).slice(-16)}`, async route => { const response = await route.fetch(); const span = await response.json(); await route.fulfill({ response, json: { ...span, outputPayload: literal, unavailable: { ...span.unavailable, output: false } } }); });
  await page.goto(`${team.url}/team/projects/${project}/traces/${id(3)}/spans/${id(103).slice(-16)}`);
  await expect(page.getByRole("region", { name: "Output", exact: true }).locator("pre")).toHaveText(literal);
  await expect(page.locator("img[src*='captured.example.invalid']")).toHaveCount(0);
});

test("team clears an open frozen check immediately after report denial confirms membership loss", async ({ page, browser, team }) => {
  const project = await setup(page, team); const prefix = `/projects/${project}`;
  const key = await mutate<{ token: string }>(page.request, team.url, `${prefix}/keys`, { label: "Revocation fixture" }); await seed(page.request, team, key.token);
  const check = await mutate<{ id: string }>(page.request, team.url, `${prefix}/checks`, { name: "Private frozen check", referenceRunId: id(1), candidateRunIds: [id(2)], rules: [{ kind: "output", operation: "equals", value: "Approved answer" }] });
  const invitation = await mutate<{ token: string }>(page.request, team.url, `${prefix}/invites`, { email: "revoked-viewer@example.test", role: "viewer" });
  const context = await browser.newContext();
  try {
    const viewer = await context.newPage(); await accept(viewer, team, invitation.token, "revoked-viewer@example.test");
    await viewer.goto(`${team.url}/team/projects/${project}/checks/${check.id}`); await viewer.getByText("Frozen candidate evidence", { exact: true }).click(); await expect(viewer.getByRole("region", { name: "Captured input", exact: true })).toContainText("Same captured input");
    const members = await (await page.request.get(`${team.url}/api/team${prefix}/members`)).json(); const member = members.items.find((item: { user: { email: string } }) => item.user.email === "revoked-viewer@example.test");
    await mutate(page.request, team.url, `${prefix}/members/${member.user.id}`, undefined, "DELETE");
    const denied = viewer.waitForResponse(response => response.url().endsWith(`/checks/${check.id}/report`) && response.status() === 404);
    await viewer.getByRole("button", { name: "Download check report", exact: true }).click(); await denied;
    await expect(viewer.getByRole("link", { name: "Return to projects", exact: true })).toBeVisible({ timeout: 3000 });
    await expect(viewer.getByRole("heading", { name: "Private frozen check", exact: true })).toHaveCount(0);
    await expect(viewer.getByText("Same captured input", { exact: true })).toHaveCount(0);
  } finally { await context.close(); }
});

test("team keeps project access after an ordinary missing-object response without a retry loop", async ({ page, team }) => {
  const project = await setup(page, team); let membershipReads = 0, missingReads = 0;
  page.on("request", request => { const pathname = new URL(request.url()).pathname; if (pathname === `/api/team/projects/${project}`) membershipReads++; if (pathname === `/api/team/projects/${project}/runs/${id(999)}`) missingReads++; });
  await page.goto(`${team.url}/team/projects/${project}/traces/${id(999)}`);
  await expect(page.getByRole("alert")).toBeVisible(); await expect(page.getByRole("link", { name: "Overview", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Try again", exact: true }).click(); await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("link", { name: "Overview", exact: true }).click(); await expect(page.getByRole("heading", { name: "Support agents", exact: true })).toBeVisible();
  expect(missingReads).toBeLessThanOrEqual(2); expect(membershipReads).toBeLessThanOrEqual(4);
});

test("team hides a revealed key on permission denial before a delayed role refresh", async ({ page, browser, team }) => {
  const project = await setup(page, team); const prefix = `/projects/${project}`; const invite = await mutate<{ token: string }>(page.request, team.url, `${prefix}/invites`, { email: "other-admin@example.test", role: "admin" });
  const context = await browser.newContext(); let release: () => void = () => {};
  try {
    const admin = await context.newPage(); await accept(admin, team, invite.token, "other-admin@example.test");
    const missing = await mutate<{ key: { id: string } }>(admin.request, team.url, `${prefix}/keys`, { label: "Already removed key" });
    await admin.getByRole("link", { name: "Ingestion keys", exact: true }).click(); await admin.getByLabel("Key label", { exact: true }).fill("Reveal revocation fixture"); await admin.getByRole("button", { name: "Create ingestion key", exact: true }).click(); await expect(admin.getByRole("textbox", { name: "Ingestion key", exact: true })).toBeVisible();
    await mutate(page.request, team.url, `${prefix}/keys/${missing.key.id}`, undefined, "DELETE");
    const gate = new Promise<void>(resolve => { release = resolve; }); await admin.route(`**/api/team/projects/${project}`, async route => { await gate; await route.continue(); });
    const rechecking = admin.waitForRequest(request => new URL(request.url()).pathname === `/api/team${prefix}`);
    const absent = admin.waitForResponse(response => response.url().endsWith(`/keys/${missing.key.id}`) && response.status() === 404);
    await admin.getByRole("button", { name: "Revoke key Already removed key", exact: true }).click(); await absent; await rechecking;
    const members = await (await page.request.get(`${team.url}/api/team${prefix}/members`)).json(); const member = members.items.find((item: { user: { email: string } }) => item.user.email === "other-admin@example.test"); await mutate(page.request, team.url, `${prefix}/members/${member.user.id}`, { role: "viewer" }, "PATCH");
    const denied = admin.waitForResponse(response => response.url().includes(`${prefix}/keys/`) && response.status() === 403); await admin.getByRole("button", { name: "Revoke key Reveal revocation fixture", exact: true }).click(); await denied;
    await expect(admin.getByRole("textbox", { name: "Ingestion key", exact: true })).toHaveCount(0, { timeout: 1500 }); release();
    await expect(admin.getByRole("heading", { name: "Administrator access required", exact: true })).toBeVisible();
  } finally { release(); await context.close(); }
});

test("team ignores a late key issuance response after project permission denial", async ({ page, browser, team }) => {
  const project = await setup(page, team); const prefix = `/projects/${project}`; const invitation = await mutate<{ token: string }>(page.request, team.url, `${prefix}/invites`, { email: "pending-admin@example.test", role: "admin" });
  const context = await browser.newContext(); let releaseCreate: () => void = () => {}, releaseRole: () => void = () => {};
  try {
    const admin = await context.newPage(); await accept(admin, team, invitation.token, "pending-admin@example.test"); await mutate(admin.request, team.url, `${prefix}/keys`, { label: "Existing key" });
    await admin.getByRole("link", { name: "Ingestion keys", exact: true }).click(); await expect(admin.getByRole("button", { name: "Revoke key Existing key", exact: true })).toBeVisible();
    let captured!: () => void; const issued = new Promise<void>(resolve => { captured = resolve; }); const createGate = new Promise<void>(resolve => { releaseCreate = resolve; }); const roleGate = new Promise<void>(resolve => { releaseRole = resolve; });
    await admin.route(`**/api/team/projects/${project}/keys`, async route => { if (route.request().method() !== "POST") return route.continue(); const response = await route.fetch(); expect(response.status()).toBe(201); captured(); await createGate; await route.fulfill({ response }); });
    await admin.getByLabel("Key label", { exact: true }).fill("Late issued key"); await admin.getByRole("button", { name: "Create ingestion key", exact: true }).click(); await issued;
    const members = await (await page.request.get(`${team.url}/api/team${prefix}/members`)).json(); const member = members.items.find((item: { user: { email: string } }) => item.user.email === "pending-admin@example.test"); await mutate(page.request, team.url, `${prefix}/members/${member.user.id}`, { role: "viewer" }, "PATCH");
    await admin.route(`**/api/team/projects/${project}`, async route => { await roleGate; await route.continue(); });
    const denied = admin.waitForResponse(response => response.url().includes(`${prefix}/keys/`) && response.status() === 403); await admin.getByRole("button", { name: "Revoke key Existing key", exact: true }).click(); await denied;
    releaseCreate(); await expect(admin.getByRole("button", { name: "Create ingestion key", exact: true })).toBeEnabled(); await expect(admin.getByRole("textbox", { name: "Ingestion key", exact: true })).toHaveCount(0);
    releaseRole(); await expect(admin.getByRole("heading", { name: "Administrator access required", exact: true })).toBeVisible();
  } finally { releaseCreate(); releaseRole(); await context.close(); }
});
