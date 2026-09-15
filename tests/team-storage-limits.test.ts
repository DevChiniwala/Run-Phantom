import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamCheckService } from "../src/team/checks";
import { TeamError } from "../src/team/errors";
import { normalizeTeamIngest } from "../src/team/ingest";
import { TEAM_LIMITS as L } from "../src/team/protocol";
import { hashTeamToken, TeamStore } from "../src/team/store";

const cleanups: Array<() => void> = [];
const runId = (n: number) => n.toString(16).padStart(32, "0");
const spanId = (n: number) => n.toString(16).padStart(16, "0");
const ownerPassword = "fixture-owner-password-hash";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rp-team-limits-")), path = join(dir, "team.sqlite");
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const store = new TeamStore(path, { bootstrapHash: hashTeamToken("bootstrap"), now });
  const db = new Database(path, { strict: true });
  cleanups.push(() => { db.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const owner = store.setupOwner({ setupCodeHash: hashTeamToken("bootstrap"), email: "owner@example.test", passwordHash: ownerPassword, sessionHash: hashTeamToken("owner-session") });
  const project = store.createProject(owner, { name: "Quota boundary" });
  const scope = store.projectScope(owner, project.id);
  return { store, db, owner, scope, path, now, advance: (ms: number) => { clock += ms; } };
}
type Fixture = ReturnType<typeof fixture>;
function exporter(f: Fixture) {
  const key = f.store.createKey(f.scope, { label: "Fixture exporter" });
  return { ...key, context: f.store.getIngestContext(hashTeamToken(key.token))! };
}
function batch(token: string, run: number, start = 1, count = 1, output = "Answer") {
  return joinedBatch(token, [[run, start, count, output]]);
}
function joinedBatch(token: string, selections: Array<[number, number?, number?, string?]>) {
  const spans = selections.flatMap(([run, start = 1, count = 1, output = "Answer"]) => Array.from({ length: count }, (_, n) => ({ traceId: runId(run), spanId: spanId(start + n), name: "agent", startTimeUnixNano: "1800000000000000000", endTimeUnixNano: "1800000001000000000", status: { code: 1 }, attributes: [
    { key: "runphantom.input", value: { stringValue: "Question" } },
    { key: "runphantom.output", value: { stringValue: output } },
  ] })));
  return normalizeTeamIngest(Buffer.from(JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] })), "json", token);
}
function state(f: Fixture) {
  return {
    project: f.db.query("SELECT evidence_bytes,run_count,span_count,check_count FROM projects WHERE id=?").get(f.scope.projectId),
    runs: f.db.query("SELECT * FROM runs ORDER BY project_id,id").all(),
    spans: f.db.query("SELECT * FROM spans ORDER BY project_id,run_id,id").all(),
    notes: f.db.query("SELECT * FROM notes ORDER BY project_id,id").all(),
    checks: f.db.query("SELECT * FROM checks ORDER BY project_id,id").all(),
    keys: f.db.query("SELECT id,last_used_at FROM ingest_keys ORDER BY id").all(),
    audit: f.db.query("SELECT * FROM audit_events ORDER BY sequence").all(),
  };
}
function code(work: () => unknown): string {
  try { work(); } catch (error) { expect(error).toBeInstanceOf(TeamError); return (error as TeamError).code; }
  throw new Error("Expected operation to reject");
}
async function asyncCode(work: Promise<unknown>): Promise<string> {
  try { await work; } catch (error) { expect(error).toBeInstanceOf(TeamError); return (error as TeamError).code; }
  throw new Error("Expected operation to reject");
}
const checkDraft = { name: "Frozen answer", referenceRunId: runId(1), candidateRunIds: [runId(2)], rules: [{ kind: "output" as const, operation: "equals" as const, value: "Answer" }] };
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

describe("team storage quota and retention boundaries", () => {
  test("full evidence quota rolls back writes but permits security actions and selected-run deletion", async () => {
    const f = fixture(), ingest = exporter(f), service = new TeamCheckService(f.store);
    f.store.ingest(ingest.context, batch(ingest.token, 1));
    f.store.ingest(ingest.context, batch(ingest.token, 2));
    const note = f.store.createNote(f.scope, runId(1), { kind: "note", text: "Delete with its source" });
    const saved = await service.create(f.scope, checkDraft), report = f.store.getCheckReport(f.scope, saved.id);
    const invite = f.store.createInvite(f.scope, { email: "editor@example.test", role: "editor" });
    const member = f.store.acceptInvite({ tokenHash: hashTeamToken(invite.token), email: invite.invite.email, passwordHash: "editor-hash", expectedAccountId: null, sessionHash: hashTeamToken("editor-session") });
    const memberScope = f.store.projectScope(member.context, f.scope.projectId);
    const unused = f.store.createInvite(f.scope, { email: "unused@example.test", role: "viewer" });
    const extraSession = f.store.loginSession({ accountId: f.owner.user.id, passwordHash: ownerPassword, sessionHash: hashTeamToken("extra-session") });
    // Saturate the persisted accounting boundary without allocating a 512 MiB test database.
    f.db.query("UPDATE projects SET evidence_bytes=? WHERE id=?").run(L.PROJECT_BYTES, f.scope.projectId);
    f.advance(1);
    const before = state(f), replacement = joinedBatch(ingest.token, [[1, 1, 1, "Modified and larger"], [3]]);
    expect(code(() => f.store.ingest(ingest.context, replacement))).toBe("quota_exceeded");
    expect(code(() => f.store.createNote(f.scope, runId(1), { kind: "issue", text: "Over quota" }))).toBe("quota_exceeded");
    expect(await asyncCode(service.create(f.scope, checkDraft))).toBe("quota_exceeded");
    expect(state(f)).toEqual(before);
    expect(f.store.getSpan(f.scope, runId(1), spanId(1)).outputPayload).toBe("Answer");
    expect(f.store.getRun(f.scope, runId(2)).run.id).toBe(runId(2));
    f.store.removeMember(f.scope, member.context.user.id);
    expect(code(() => f.store.createNote(memberScope, runId(1), { kind: "note", text: "Stale member" }))).toBe("not_found");
    f.store.revokeKey(f.scope, ingest.key.id);
    expect(f.store.getIngestContext(hashTeamToken(ingest.token))).toBeNull();
    f.store.revokeInvite(f.scope, unused.invite.id);
    expect(f.store.getInviteForAcceptance(hashTeamToken(unused.token), unused.invite.email)).toBeNull();
    f.store.revokeSession(f.owner, extraSession.session.id);
    expect(f.store.getSession(extraSession.tokenHash)).toBeNull();
    expect(code(() => f.store.removeMember(f.scope, f.owner.user.id))).toBe("conflict");
    const reclaimed = (f.db.query("SELECT (SELECT byte_size FROM runs WHERE project_id=? AND id=?)+(SELECT SUM(byte_size) FROM spans WHERE project_id=? AND run_id=?)+(SELECT SUM(byte_size) FROM notes WHERE project_id=? AND run_id=?) AS n").get(f.scope.projectId, runId(1), f.scope.projectId, runId(1), f.scope.projectId, runId(1)) as { n: number }).n;
    f.store.deleteRun(f.scope, runId(1));
    expect(code(() => f.store.getRun(f.scope, runId(1)))).toBe("not_found");
    expect(f.db.query("SELECT id FROM notes WHERE id=?").get(note.id)).toBeNull();
    expect(f.db.query("SELECT evidence_bytes,run_count,span_count,check_count FROM projects WHERE id=?").get(f.scope.projectId)).toEqual({ evidence_bytes: L.PROJECT_BYTES - reclaimed, run_count: 1, span_count: 1, check_count: 1 });
    expect(f.store.getCheck(f.scope, saved.id)).toEqual(saved);
    expect(f.store.getCheckReport(f.scope, saved.id)).toEqual(report);
    expect(f.store.getRun(f.scope, runId(2)).run.id).toBe(runId(2));
    service.close();
  });

  for (const [column, limit] of [["run_count", L.PROJECT_RUNS], ["span_count", L.PROJECT_SPANS]] as const) {
    test(`project ${column} limit rolls back replacements and additions together`, () => {
      const f = fixture(), ingest = exporter(f);
      f.store.ingest(ingest.context, batch(ingest.token, 1));
      f.db.query(`UPDATE projects SET ${column}=? WHERE id=?`).run(limit, f.scope.projectId);
      f.advance(1);
      const before = state(f), replacement = joinedBatch(ingest.token, [[1, 1, 1, "Changed"], [2]]);
      expect(code(() => f.store.ingest(ingest.context, replacement))).toBe("quota_exceeded");
      expect(state(f)).toEqual(before);
    });
  }

  test("saved-check count rejects atomically with existing reports intact", async () => {
    const f = fixture(), ingest = exporter(f), service = new TeamCheckService(f.store);
    f.store.ingest(ingest.context, batch(ingest.token, 1)); f.store.ingest(ingest.context, batch(ingest.token, 2));
    const saved = await service.create(f.scope, checkDraft);
    f.db.query("UPDATE projects SET check_count=? WHERE id=?").run(L.PROJECT_CHECKS, f.scope.projectId);
    const before = state(f);
    expect(await asyncCode(service.create(f.scope, checkDraft))).toBe("quota_exceeded");
    expect(state(f)).toEqual(before);
    expect(f.store.getCheck(f.scope, saved.id)).toEqual(saved);
    service.close();
  });

  test("the 1001st span rejects the entire capture batch at the real 1000-span trace boundary", () => {
    const f = fixture(), ingest = exporter(f);
    f.store.ingest(ingest.context, batch(ingest.token, 1, 1, L.TRACE_SPANS));
    expect(f.store.getRun(f.scope, runId(1)).run.spanCount).toBe(L.TRACE_SPANS);
    const before = state(f), mixed = joinedBatch(ingest.token, [[2], [1, L.TRACE_SPANS + 1]]);
    expect(code(() => f.store.ingest(ingest.context, mixed))).toBe("quota_exceeded");
    expect(state(f)).toEqual(before);
    expect(f.store.getSpan(f.scope, runId(1), spanId(L.TRACE_SPANS)).outputPayload).toBe("Answer");
    expect(code(() => f.store.getRun(f.scope, runId(2)))).toBe("not_found");
  });

  test("real UTF-8 evidence reaches the trace byte cap without partial overflow writes", () => {
    const f = fixture(), ingest = exporter(f), output = "界".repeat(8_000);
    let committed = 0;
    for (let n = 1; n <= 100; n++) {
      const next = batch(ingest.token, 1, n, 1, output);
      try { f.store.ingest(ingest.context, next); committed++; }
      catch (error) { expect(error).toBeInstanceOf(TeamError); expect((error as TeamError).code).toBe("quota_exceeded"); break; }
    }
    const size = (f.db.query("SELECT (SELECT SUM(byte_size) FROM spans)+(SELECT SUM(byte_size) FROM runs) AS n").get() as { n: number }).n;
    expect(committed).toBeGreaterThan(1); expect(committed).toBeLessThan(100);
    expect(size).toBeLessThanOrEqual(L.TRACE_BYTES); expect(size).toBeGreaterThan(L.TRACE_BYTES - L.SPAN_BYTES);
    const before = state(f);
    expect(code(() => f.store.ingest(ingest.context, batch(ingest.token, 1, committed + 1, 1, output)))).toBe("quota_exceeded");
    expect(state(f)).toEqual(before);
    expect(f.store.getRun(f.scope, runId(1)).run.spanCount).toBe(committed);
    expect(f.store.getSpan(f.scope, runId(1), spanId(committed)).outputPayload).toBe(output);
  });

  test("check acquisition includes all selected spans and rejects before payload materialization", () => {
    const f = fixture(), ingest = exporter(f);
    f.store.ingest(ingest.context, batch(ingest.token, 1, 1, L.CHECK_ACQUISITION_SPANS - 1));
    f.store.ingest(ingest.context, batch(ingest.token, 2));
    expect(f.store.acquireCheckEvidence(f.scope, [runId(1), runId(2)], 128).runs.reduce((sum, run) => sum + run.spans.length, 0)).toBe(L.CHECK_ACQUISITION_SPANS);
    f.store.ingest(ingest.context, batch(ingest.token, 2, 2));
    expect(code(() => f.store.acquireCheckEvidence(f.scope, [runId(1), runId(2)], 128))).toBe("too_large");
    // Valid JSON with an invalid payload shape detects accidental materialization before the SQL preflight.
    f.db.query("UPDATE spans SET data='null' WHERE project_id=?").run(f.scope.projectId);
    expect(code(() => f.store.acquireCheckEvidence(f.scope, [runId(1), runId(2)], 128))).toBe("too_large");
    expect(f.store.listChecks(f.scope).items).toHaveLength(0);
  });

  test("check acquisition accepts exactly 256 KiB including definition bytes, then rejects one byte more", () => {
    const f = fixture(), ingest = exporter(f);
    f.store.ingest(ingest.context, batch(ingest.token, 1, 1, 2, "界".repeat(8_100)));
    f.store.ingest(ingest.context, batch(ingest.token, 2, 1, 2, "界".repeat(8_100)));
    const evidenceBytes = (f.db.query("SELECT (SELECT SUM(byte_size) FROM spans)+(SELECT SUM(byte_size) FROM runs) AS n").get() as { n: number }).n;
    const definitionBytes = L.CHECK_ACQUISITION_BYTES - evidenceBytes;
    expect(definitionBytes).toBeGreaterThanOrEqual(0); expect(definitionBytes + 1).toBeLessThanOrEqual(L.CHECK_REQUEST_BYTES);
    expect(f.store.acquireCheckEvidence(f.scope, [runId(1), runId(2)], definitionBytes).runs).toHaveLength(2);
    expect(code(() => f.store.acquireCheckEvidence(f.scope, [runId(1), runId(2)], definitionBytes + 1))).toBe("too_large");
    f.db.query("UPDATE runs SET data='null' WHERE project_id=?").run(f.scope.projectId);
    expect(code(() => f.store.acquireCheckEvidence(f.scope, [runId(1), runId(2)], definitionBytes + 1))).toBe("too_large");
  });

  test("credential caps remain bounded during revoke/reissue churn and preserve audit history", () => {
    const f = fixture();
    const keys = Array.from({ length: L.PROJECT_KEYS }, () => f.store.createKey(f.scope, { label: "Bounded key" }));
    const invites = Array.from({ length: L.PROJECT_INVITES }, (_, n) => f.store.createInvite(f.scope, { email: `pending-${n}@example.test`, role: "viewer" }));
    const sessions = Array.from({ length: L.USER_SESSIONS - 1 }, (_, n) => f.store.loginSession({ accountId: f.owner.user.id, passwordHash: ownerPassword, sessionHash: hashTeamToken(`session-${n}`) }));
    expect(code(() => f.store.createKey(f.scope, { label: "Overflow" }))).toBe("quota_exceeded");
    expect(code(() => f.store.createInvite(f.scope, { email: "overflow@example.test", role: "viewer" }))).toBe("quota_exceeded");
    expect(code(() => f.store.loginSession({ accountId: f.owner.user.id, passwordHash: ownerPassword, sessionHash: hashTeamToken("overflow") }))).toBe("quota_exceeded");
    const deleted = { key: keys[0].key.id, invite: invites[0].invite.id, session: sessions[0].session.id };
    for (let n = 0; n < 125; n++) {
      const key = keys.shift()!, invite = invites.shift()!, session = sessions.shift()!;
      f.store.revokeKey(f.scope, key.key.id); f.store.revokeInvite(f.scope, invite.invite.id); f.store.revokeSession(f.owner, session.session.id);
      keys.push(f.store.createKey(f.scope, { label: "Replacement" }));
      invites.push(f.store.createInvite(f.scope, { email: `replacement-${n}@example.test`, role: "editor" }));
      sessions.push(f.store.loginSession({ accountId: f.owner.user.id, passwordHash: ownerPassword, sessionHash: hashTeamToken(`replacement-${n}`) }));
    }
    expect(f.db.query("SELECT (SELECT COUNT(*) FROM ingest_keys) AS keys,(SELECT COUNT(*) FROM invites) AS invites,(SELECT COUNT(*) FROM sessions) AS sessions").get()).toEqual({ keys: L.PROJECT_KEYS, invites: L.PROJECT_INVITES, sessions: L.USER_SESSIONS });
    expect(code(() => f.store.revokeKey(f.scope, deleted.key))).toBe("not_found"); expect(code(() => f.store.revokeInvite(f.scope, deleted.invite))).toBe("not_found"); expect(code(() => f.store.revokeSession(f.owner, deleted.session))).toBe("not_found");
    expect((f.db.query("SELECT COUNT(*) AS n FROM audit_events WHERE json_extract(data,'$.target.id')=?").get(deleted.key) as { n: number }).n).toBeGreaterThan(0);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("fresh startup removes expired credentials, preserves live ones, and never reopens bootstrap", () => {
    const f = fixture(), shortKey = f.store.createKey(f.scope, { label: "Expires", expiresInDays: 1 }), longKey = f.store.createKey(f.scope, { label: "Survives", expiresInDays: 3 });
    const shortInvite = f.store.createInvite(f.scope, { email: "expires@example.test", role: "viewer", expiresInHours: 1 });
    const longInvite = f.store.createInvite(f.scope, { email: "survives@example.test", role: "viewer", expiresInHours: 72 });
    f.advance(24 * 60 * 60 * 1000 + 1);
    f.store.close();
    const reopened = new TeamStore(f.path, { now: f.now, bootstrapHash: hashTeamToken("replacement-bootstrap") });
    try {
      expect(reopened.setupRequired()).toBe(false);
      expect(code(() => reopened.setupOwner({ setupCodeHash: hashTeamToken("replacement-bootstrap"), email: "attacker@example.test", passwordHash: "hash", sessionHash: hashTeamToken("attacker") }))).toBe("conflict");
      expect(f.db.query("SELECT (SELECT COUNT(*) FROM sessions) AS sessions,(SELECT COUNT(*) FROM invites) AS invites,(SELECT COUNT(*) FROM ingest_keys) AS keys").get()).toEqual({ sessions: 0, invites: 1, keys: 1 });
      expect(reopened.getIngestContext(hashTeamToken(shortKey.token))).toBeNull(); expect(reopened.getIngestContext(hashTeamToken(longKey.token))).not.toBeNull();
      expect(reopened.getInviteForAcceptance(hashTeamToken(shortInvite.token), shortInvite.invite.email)).toBeNull(); expect(reopened.getInviteForAcceptance(hashTeamToken(longInvite.token), longInvite.invite.email)).not.toBeNull();
      const session = reopened.loginSession({ accountId: f.owner.user.id, passwordHash: ownerPassword, sessionHash: hashTeamToken("after-restart") });
      expect(reopened.listSessions(session)).toHaveLength(1);
      expect(reopened.listInvites(reopened.projectScope(session, f.scope.projectId)).items.map(invite => invite.id)).toEqual([longInvite.invite.id]);
    } finally { reopened.close(); }
  });

  test("unsupported schema versions reject without deleting existing evidence", () => {
    const f = fixture(), ingest = exporter(f);
    f.store.ingest(ingest.context, batch(ingest.token, 1));
    const before = state(f);
    f.store.close(); f.db.exec("PRAGMA user_version=999");
    expect(code(() => new TeamStore(f.path, { now: f.now }))).toBe("conflict");
    expect(state(f)).toEqual(before);
    expect(f.db.query("PRAGMA user_version").get()).toEqual({ user_version: 999 });
  });

  test("a foreign version-zero database is rejected without initializing team tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "rp-team-foreign-")), path = join(dir, "foreign.sqlite"), db = new Database(path);
    cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    db.exec("CREATE TABLE foreign_data(value TEXT); INSERT INTO foreign_data VALUES('preserved');");
    expect(code(() => new TeamStore(path))).toBe("conflict");
    expect(db.query("SELECT value FROM foreign_data").all()).toEqual([{ value: "preserved" }]);
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: "foreign_data" }]);
  });
});
