import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { TeamStore, hashTeamToken, type ProjectContext } from "../src/team/store";
import { normalizeTeamIngest } from "../src/team/ingest";

const fixtures: Array<{ dir: string; store: TeamStore }> = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rp-team-store-"));
  let clock = 1_800_000_000_000;
  const store = new TeamStore(join(dir, "team.sqlite"), { bootstrapHash: hashTeamToken("bootstrap"), now: () => clock });
  fixtures.push({ dir, store });
  const owner = store.setupOwner({ setupCodeHash: hashTeamToken("bootstrap"), email: "alice@example.test", passwordHash: "alice-password-hash", sessionHash: hashTeamToken("alice-session") });
  const a = store.createProject(owner, { name: "A" });
  const b = store.createProject(owner, { name: "B" });
  const scope = store.projectScope(owner, a.id);
  const scopeB = store.projectScope(owner, b.id);
  return { dir, store, owner, scope, scopeB, advance: (ms: number) => { clock += ms; } };
}
function member(store: TeamStore, scope: ProjectContext, email: string, role: "admin" | "editor" | "viewer") {
  const invite = store.createInvite(scope, { email, role });
  return store.acceptInvite({ tokenHash: hashTeamToken(invite.token), email, expectedAccountId: null, passwordHash: "member-password-hash", sessionHash: hashTeamToken(email) });
}
const traceId = "1".repeat(32), spanId = "2".repeat(16);
function ingest(store: TeamStore, scope: ProjectContext, output: string, start = "1800000000000000000") {
  const key = store.createKey(scope, { label: "test exporter" });
  const context = store.getIngestContext(hashTeamToken(key.token))!;
  const batch = normalizeTeamIngest(Buffer.from(JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId, spanId, name: "chat", startTimeUnixNano: start, endTimeUnixNano: "1800000001000000000", status: { code: 1 }, attributes: [{ key: "runphantom.output", value: { stringValue: output } }] }] }] }] })), "json", key.token);
  store.ingest(context, batch);
  return { key, context, batch };
}
afterEach(() => { for (const f of fixtures.splice(0)) { f.store.close(); rmSync(f.dir, { recursive: true, force: true }); } });

describe("isolated team store", () => {
  test("bootstrap is consumed permanently and account credentials never enter public records", () => {
    const { store, owner } = fixture();
    expect(store.setupRequired()).toBe(false);
    expect(() => store.setupOwner({ setupCodeHash: hashTeamToken("bootstrap"), email: "other@example.test", passwordHash: "hash", sessionHash: hashTeamToken("other") })).toThrow();
    expect(JSON.stringify(store.listProjects(owner))).not.toContain("password-hash");
    expect(store.listSessions(owner)).toHaveLength(1);
  });

  test("foreign project and object lookups require explicit membership, including the instance owner", () => {
    const { store, scope, scopeB, owner } = fixture();
    const bob = member(store, scopeB, "bob@example.test", "admin");
    const bobB = store.projectScope(bob.context, scopeB.projectId);
    store.removeMember(bobB, owner.user.id);
    expect(() => store.projectScope(owner, scopeB.projectId)).toThrow();
    expect(() => store.projectScope(bob.context, scope.projectId)).toThrow();
    expect(store.listProjects(bob.context).items.map(p => p.id)).toEqual([scopeB.projectId]);
  });

  test("same trace and span IDs coexist and replacement quota bytes are idempotent", () => {
    const { store, scope, scopeB, dir } = fixture();
    const a = ingest(store, scope, "project-A-only");
    ingest(store, scopeB, "project-B-only");
    const db = new Database(join(dir, "team.sqlite"), { readonly: true });
    const bytes = () => (db.query("SELECT evidence_bytes AS n FROM projects WHERE id=?").get(scope.projectId) as {n:number}).n;
    const before = bytes();
    store.ingest(a.context, a.batch);
    expect(bytes()).toBe(before);
    expect(store.getSpan(scope, traceId, spanId).outputPayload).toBe("project-A-only");
    expect(store.getSpan(scopeB, traceId, spanId).outputPayload).toBe("project-B-only");
    expect(store.getRun(scope, traceId).spans.items).toHaveLength(1);
    expect(store.getRun(scope, traceId).spans.items[0]).not.toHaveProperty("outputPayload");
    db.close();
  });

  test("stale membership and ingestion contexts cannot commit after revocation", () => {
    const { store, scope } = fixture();
    const bob = member(store, scope, "bob@example.test", "editor");
    const bobScope = store.projectScope(bob.context, scope.projectId);
    const { key, context, batch } = ingest(store, scope, "first");
    store.removeMember(scope, bob.context.user.id);
    expect(() => store.createNote(bobScope, traceId, { kind: "note", text: "stale" })).toThrow();
    store.revokeKey(scope, key.key.id);
    expect(() => store.ingest(context, batch)).toThrow();
    expect(store.getIngestContext(hashTeamToken(key.token))).toBeNull();
  });

  test("last-admin and own-note permissions are enforced transactionally", () => {
    const { store, scope, owner } = fixture();
    expect(() => store.changeMemberRole(scope, owner.user.id, "viewer")).toThrow();
    expect(() => store.removeMember(scope, owner.user.id)).toThrow();
    ingest(store, scope, "answer");
    const editor = member(store, scope, "editor@example.test", "editor");
    const viewer = member(store, scope, "viewer@example.test", "viewer");
    const editorScope = store.projectScope(editor.context, scope.projectId);
    const viewerScope = store.projectScope(viewer.context, scope.projectId);
    expect(() => store.createNote(viewerScope, traceId, { kind: "good", text: "test" })).toThrow();
    const note = store.createNote(editorScope, traceId, { kind: "issue", text: "Check this result" });
    expect(() => store.deleteNote(scope, traceId, note.id)).toThrow();
    expect(store.listNotes(viewerScope, traceId).items[0].author.email).toBe(editor.context.user.email);
    store.deleteNote(editorScope, traceId, note.id);
  });

  test("invites are single use, cannot reset accounts, and lose authority with their issuer", () => {
    const { store, scope } = fixture();
    const issued = store.createInvite(scope, { email: "bob@example.test", role: "viewer" });
    const input = { tokenHash: hashTeamToken(issued.token), email: "bob@example.test", expectedAccountId: null, passwordHash: "bob-original", sessionHash: hashTeamToken("bob") };
    const accepted = store.acceptInvite(input);
    expect(() => store.acceptInvite(input)).toThrow();
    expect(store.getAccountByEmail(input.email)?.passwordHash).toBe("bob-original");
    expect(() => store.loginSession({ accountId: accepted.context.user.id, passwordHash: "replacement", sessionHash: hashTeamToken("wrong") })).toThrow();
    expect(store.listInvites(scope).items).toHaveLength(0);
  });

  test("expiry, logout and password rotation remove credential rows across restart", () => {
    const { store, scope, owner, dir, advance } = fixture();
    for (let n = 0; n < 55; n++) {
      const key = store.createKey(scope, { label: "ephemeral" });
      store.revokeKey(scope, key.key.id);
      const invite = store.createInvite(scope, { email: "unused@example.test", role: "viewer", expiresInHours: 1 });
      store.revokeInvite(scope, invite.invite.id);
    }
    const rotated = store.changePassword(owner, { currentPasswordHash: "alice-password-hash", newPasswordHash: "new-hash", sessionHash: hashTeamToken("rotated") });
    expect(store.getSession(owner.tokenHash)).toBeNull();
    store.logout(rotated);
    expect(store.getSession(rotated.tokenHash)).toBeNull();
    advance(24 * 60 * 60 * 1000);
    store.close();
    const reopened = new TeamStore(join(dir, "team.sqlite"));
    expect(reopened.setupRequired()).toBe(false);
    reopened.close();
    const db = new Database(join(dir, "team.sqlite"), { readonly: true });
    for (const table of ["sessions", "invites", "ingest_keys"]) expect((db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n:number}).n).toBe(0);
    db.close();
  });

  test("worker search is scoped, literal, filter-bound, paged and never returns payloads", async () => {
    const { store, scope, scopeB } = fixture();
    ingest(store, scope, "100%_done and ' OR 1=1 --");
    ingest(store, scopeB, "foreign needle");
    expect((await store.searchRuns(scope, { q: "%_" })).items.map(r => r.id)).toEqual([traceId]);
    expect((await store.searchRuns(scope, { q: "foreign needle" })).items).toEqual([]);
    const result = await store.searchRuns(scope, {});
    expect(result.items).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("OR 1=1");
  });

  test("an errored child does not finish a live root and late child updates retain run search metadata", async () => {
    const { store, scope, advance } = fixture();
    const key = store.createKey(scope, { label: "live exporter" });
    const context = store.getIngestContext(hashTeamToken(key.token))!;
    const submit = (spans: unknown[]) => store.ingest(context, normalizeTeamIngest(Buffer.from(JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] })), "json", key.token));
    const root = { traceId, spanId, name: "agent", startTimeUnixNano: "1800000000000000000", attributes: [{ key: "user.id", value: { stringValue: "SEARCH_USER_CANARY" } }] };
    submit([root]);
    submit([{ traceId, spanId: "3".repeat(16), parentSpanId: spanId, name: "tool", status: { code: 2 }, startTimeUnixNano: "1800000000000000000", endTimeUnixNano: "1800000000500000000" }]);
    advance(2000);
    expect(store.getRun(scope, traceId).run).toMatchObject({ status: "running", errorCount: 1 });
    expect(store.metrics(scope).traces).toMatchObject({ total: 1, running: 1, failed: 0, terminal: 0 });
    expect((await store.searchRuns(scope, { q: "SEARCH_USER_CANARY" })).items).toHaveLength(1);
    submit([{ ...root, endTimeUnixNano: "1800000001000000000" }]);
    expect(store.getRun(scope, traceId).run.status).toBe("failed");
    expect(store.metrics(scope).traces).toMatchObject({ total: 1, running: 0, failed: 1, terminal: 1 });
  });
});
