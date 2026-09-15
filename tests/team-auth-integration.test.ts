import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTeamFixture, type TeamFixture } from "./helpers/team-server";
import type { SessionResponse } from "../src/team/protocol";

type Session = Extract<SessionResponse, { authenticated: true }>;
let fixture: TeamFixture;
let cookie: string;
let session: Session;
const password = "Exact password with spaces 42! ";

async function call(route: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${fixture.url}/api/team${route}`, {
    method,
    headers: { ...(method === "GET" ? {} : { Origin: fixture.url, "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function authorized() { return { Cookie: cookie, "X-RunPhantom-CSRF": session.csrfToken }; }

beforeAll(async () => { fixture = await startTeamFixture("auth", process.env.RUNPHANTOM_TEAM_TEST_BINARY); }, 20_000);
afterAll(async () => { await fixture?.close(); });

describe("team authentication and transport through the actual CLI", () => {
  test("concurrent bootstrap consumes one capability and creates only one owner", async () => {
    const before = await (await call("/session")).json();
    expect(before).toMatchObject({ authenticated: false, setupRequired: true, csrfToken: null });
    const responses = await Promise.all(["a", "b"].map(() => call("/setup", "POST", {
      setupCode: fixture.setupCode, email: "OWNER@example.test", password,
    })));
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    const successful = responses.find(response => response.status === 201)!;
    const header = successful.headers.get("set-cookie")!;
    cookie = header.split(";")[0];
    session = await successful.json() as Session;
    expect(session.user.email).toBe("owner@example.test");
    expect(session.user.isOwner).toBe(true);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
    expect(header).not.toContain("Domain=");
    expect(session.session.id).not.toBe(cookie.split("=")[1]);
    expect(JSON.stringify(session)).not.toContain(password);
    expect(fixture.logs()).not.toContain(fixture.setupCode);
    const projects = await (await call("/projects", "GET", undefined, authorized())).json();
    expect(projects.items).toEqual([]);
  });

  test("Host, Origin and CSRF checks reject hostile requests before mutations", async () => {
    const project = { name: "Must not be created" };
    const hostile = await call("/projects", "POST", project, { ...authorized(), Origin: "https://foreign.example.test" });
    expect(hostile.status).toBe(403);
    expect((await call("/projects", "POST", project, { Cookie: cookie })).status).toBe(403);
    expect((await call("/projects", "POST", project, { ...authorized(), "X-RunPhantom-CSRF": "wrong" })).status).toBe(403);
    expect((await call("/projects", "POST", project, { ...authorized(), "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await call("/session", "GET", undefined, { Host: "foreign.example.test", "X-Forwarded-Host": new URL(fixture.url).host })).status).toBe(403);
    const absentOrigin = await fetch(`${fixture.url}/api/team/projects`, {
      method: "POST", headers: { ...authorized(), "Content-Type": "application/json" }, body: JSON.stringify(project),
    });
    expect(absentOrigin.status).toBe(403);
    const nullOrigin = await call("/projects", "POST", project, { ...authorized(), Origin: "null" });
    expect(nullOrigin.status).toBe(403);
    const projects = await (await call("/projects", "GET", undefined, authorized())).json();
    expect(projects.items).toEqual([]);
  });

  test("unknown accounts and incorrect passwords return the same safe failure", async () => {
    const [unknown, wrong] = await Promise.all([
      call("/login", "POST", { email: "unknown@example.test", password }),
      call("/login", "POST", { email: "owner@example.test", password: "Wrong valid password 42!" }),
    ]);
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    const unknownBody = await unknown.json(), wrongBody = await wrong.json();
    expect(unknownBody.error.code).toBe(wrongBody.error.code);
    expect(unknownBody.error.message).toBe(wrongBody.error.message);
    expect(unknownBody.error.requestId).not.toBe(wrongBody.error.requestId);
    expect(JSON.stringify([unknownBody, wrongBody])).not.toContain("passwordHash");
    expect(JSON.stringify([unknownBody, wrongBody])).not.toContain("$argon2");
  });

  test("password change verifies exact bytes, rotates current session and revokes other sessions", async () => {
    const secondLogin = await call("/login", "POST", { email: "owner@example.test", password });
    expect(secondLogin.status).toBe(200);
    const otherCookie = secondLogin.headers.get("set-cookie")!.split(";")[0];
    const otherSession = await secondLogin.json() as Session;
    expect(otherSession.session.id).not.toBe(session.session.id);
    const wrongCurrent = await call("/password", "POST", { currentPassword: password.trim(), newPassword: "Changed precise password 42!" }, authorized());
    expect(wrongCurrent.status).toBe(400);
    expect(wrongCurrent.headers.get("set-cookie")).toBeNull();
    const oldCookie = cookie, oldCsrf = session.csrfToken;
    const changed = await call("/password", "POST", { currentPassword: password, newPassword: "Changed precise password 42!" }, authorized());
    expect(changed.status).toBe(200);
    cookie = changed.headers.get("set-cookie")!.split(";")[0];
    session = await changed.json() as Session;
    expect(cookie).not.toBe(oldCookie);
    expect(session.csrfToken).not.toBe(oldCsrf);
    for (const staleCookie of [oldCookie, otherCookie]) {
      const stale = await (await call("/session", "GET", undefined, { Cookie: staleCookie })).json();
      expect(stale.authenticated).toBe(false);
    }
    expect((await call("/projects", "POST", { name: "stale CSRF" }, { Cookie: cookie, "X-RunPhantom-CSRF": oldCsrf })).status).toBe(403);
    const sessions = await (await call("/sessions", "GET", undefined, authorized())).json();
    expect(sessions.items).toHaveLength(1);
    expect(sessions.items[0]).toMatchObject({ id: session.session.id, current: true });
    expect((await call("/logout", "POST", {}, authorized())).status).toBe(204);
    expect((await (await call("/session", "GET", undefined, { Cookie: cookie })).json()).authenticated).toBe(false);
  });
});
