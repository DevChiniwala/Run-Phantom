import type { Database } from "bun:sqlite";
import { TeamError } from "./errors";

export const TEAM_SCHEMA_VERSION = 1;

/** A separate schema: the team listener never opens or migrates the local database. */
export function initializeTeamSchema(db: Database): void {
  const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version !== 0 && version !== TEAM_SCHEMA_VERSION) throw new TeamError("conflict", "Unsupported team database version");
  if (version === TEAM_SCHEMA_VERSION) return;
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  if (tables.length) throw new TeamError("conflict", "The selected database is not an initialized team database");
  db.transaction(() => {
    db.exec(`
      CREATE TABLE team_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO team_meta VALUES ('initialized','0');
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        is_owner INTEGER NOT NULL CHECK(is_owner IN (0,1)), created_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64), created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, idle_expires_at INTEGER NOT NULL
      );
      CREATE INDEX sessions_account ON sessions(account_id);
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,
        evidence_bytes INTEGER NOT NULL DEFAULT 0 CHECK(evidence_bytes>=0),
        run_count INTEGER NOT NULL DEFAULT 0 CHECK(run_count>=0),
        span_count INTEGER NOT NULL DEFAULT 0 CHECK(span_count>=0),
        check_count INTEGER NOT NULL DEFAULT 0 CHECK(check_count>=0),
        audit_pruned INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE memberships (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')), joined_at INTEGER NOT NULL,
        PRIMARY KEY(project_id,account_id)
      );
      CREATE INDEX memberships_account ON memberships(account_id,project_id);
      CREATE TABLE invites (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')),
        issuer_id TEXT NOT NULL REFERENCES accounts(id), token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX invites_project ON invites(project_id,created_at DESC,id DESC);
      CREATE TABLE ingest_keys (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        label TEXT NOT NULL, prefix TEXT NOT NULL, creator_id TEXT NOT NULL REFERENCES accounts(id),
        token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE INDEX ingest_keys_project ON ingest_keys(project_id,created_at DESC,id DESC);
      CREATE TABLE runs (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, id TEXT NOT NULL,
        started_at REAL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
        data TEXT NOT NULL CHECK(json_valid(data)), search_text TEXT NOT NULL, metadata TEXT NOT NULL CHECK(json_valid(metadata)), byte_size INTEGER NOT NULL CHECK(byte_size>=0),
        PRIMARY KEY(project_id,id)
      );
      CREATE INDEX runs_project_start ON runs(project_id,started_at DESC,id DESC);
      CREATE INDEX runs_project_status_start ON runs(project_id,status,started_at DESC,id DESC);
      CREATE TABLE spans (
        project_id TEXT NOT NULL, run_id TEXT NOT NULL, id TEXT NOT NULL,
        name TEXT NOT NULL, model TEXT, provider TEXT, started_at REAL,
        data TEXT NOT NULL CHECK(json_valid(data)), byte_size INTEGER NOT NULL CHECK(byte_size>=0),
        PRIMARY KEY(project_id,run_id,id),
        FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id) ON DELETE CASCADE
      );
      CREATE INDEX spans_project_model_provider ON spans(project_id,model,provider,run_id);
      CREATE INDEX spans_project_start ON spans(project_id,run_id,started_at,id);
      CREATE TABLE notes (
        project_id TEXT NOT NULL, run_id TEXT NOT NULL, id TEXT NOT NULL, span_id TEXT,
        author_id TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)), byte_size INTEGER NOT NULL CHECK(byte_size>=0),
        PRIMARY KEY(project_id,id),
        FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id) ON DELETE CASCADE,
        FOREIGN KEY(project_id,run_id,span_id) REFERENCES spans(project_id,run_id,id) ON DELETE CASCADE
      );
      CREATE INDEX notes_project_run ON notes(project_id,run_id,created_at DESC,id DESC);
      CREATE TABLE checks (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, id TEXT NOT NULL,
        created_at INTEGER NOT NULL, summary TEXT NOT NULL CHECK(json_valid(summary)),
        data TEXT NOT NULL CHECK(json_valid(data)), report TEXT NOT NULL CHECK(json_valid(report)),
        byte_size INTEGER NOT NULL CHECK(byte_size>=0), PRIMARY KEY(project_id,id)
      );
      CREATE INDEX checks_project_created ON checks(project_id,created_at DESC,id DESC);
      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        id TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
      );
      CREATE INDEX audit_project_created ON audit_events(project_id,created_at DESC,id DESC);
      CREATE TABLE operational_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
        account_id TEXT, action TEXT NOT NULL, request_id TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
  }).immediate();
}
