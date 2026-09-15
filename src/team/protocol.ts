import type { Rule, RuleResult, Snapshot } from "../evaluations/protocol";

/** Shared contracts for the isolated Run Phantom team service. */
export const TEAM_LIMITS = {
  CONTROL_BYTES: 16 * 1024,
  CHECK_REQUEST_BYTES: 64 * 1024,
  INGEST_WIRE_BYTES: 1024 * 1024,
  INGEST_EXPANDED_BYTES: 1024 * 1024,
  INGEST_SPANS: 1000,
  INGEST_DEPTH: 24,
  INGEST_NODES: 50_000,
  SPAN_ATTRIBUTES: 256,
  RAW_SPAN_BYTES: 64 * 1024,
  RAW_BATCH_CAPTURE_BYTES: 1024 * 1024,
  SPAN_BYTES: 64 * 1024,
  TRACE_BYTES: 4 * 1024 * 1024,
  TRACE_SPANS: 1000,
  PROJECT_BYTES: 512 * 1024 * 1024,
  PROJECT_RUNS: 10_000,
  PROJECT_SPANS: 100_000,
  PROJECT_CHECKS: 1000,
  RUN_NOTES: 500,
  NOTE_BYTES: 8 * 1024,
  CHECK_CANDIDATES: 10,
  CHECK_RULES: 8,
  CHECK_ACQUISITION_BYTES: 256 * 1024,
  CHECK_ACQUISITION_SPANS: 200,
  CHECK_BYTES: 1024 * 1024,
  API_BYTES: 2 * 1024 * 1024,
  SEARCH_BYTES: 120 * 1024,
  PAGE_DEFAULT: 50,
  PAGE_MAX: 100,
  CURSOR_BYTES: 512,
  FILTER_CHARACTERS: 256,
  FILTER_BYTES: 1024,
  NAME_CHARACTERS: 128,
  NAME_BYTES: 512,
  EMAIL_BYTES: 128,
  PASSWORD_MIN: 12,
  PASSWORD_MAX: 128,
  PASSWORD_BYTES: 512,
  HASH_CONCURRENCY: 2,
  QUERY_CONCURRENCY: 2,
  QUERY_DEADLINE_MS: 5000,
  CHECK_CONCURRENCY: 2,
  REQUEST_CONCURRENCY: 100,
  HEADER_BYTES: 16 * 1024,
  REQUEST_TIMEOUT_MS: 30_000,
  PROJECTS: 100,
  ACCOUNTS: 1000,
  USER_SESSIONS: 10,
  PROJECT_MEMBERS: 100,
  PROJECT_INVITES: 100,
  PROJECT_KEYS: 50,
  PROJECT_AUDIT: 10_000,
  SESSION_IDLE_MS: 30 * 60 * 1000,
  SESSION_ABSOLUTE_MS: 12 * 60 * 60 * 1000,
  INVITE_DEFAULT_HOURS: 24,
  INVITE_MAX_HOURS: 168,
  KEY_DEFAULT_DAYS: 90,
  KEY_MAX_DAYS: 365,
  RATE_WINDOW_MS: 60_000,
  RATE_SOCKET_IDENTITIES: 1024,
  AUTH_PER_SOCKET: 10,
  AUTH_GLOBAL: 60,
  REQUESTS_PER_SESSION: 120,
  INGEST_PER_KEY: 60,
  CHECKS_PER_USER: 10,
  CHECKS_GLOBAL: 30,
} as const;

export const TEAM_CHECK_FORMAT = "runphantom-team-check/v1" as const;

export type Id = string; // Generated UUID for team entities; never an authority token.
export type Milliseconds = number;
export type Role = "admin" | "editor" | "viewer";
export type RunStatus = "running" | "completed" | "failed";
export type CheckStatus = "pass" | "fail" | "inconclusive";

export interface PageQuery { limit?: number; cursor?: string }
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}
export interface ApiError {
  error: {
    code: "invalid_request" | "unauthenticated" | "forbidden" | "not_found"
      | "conflict" | "too_large" | "unsupported_media_type" | "rate_limited"
      | "quota_exceeded" | "busy" | "query_timeout" | "internal_error";
    message: string; // Safe, <=512 UTF-8 bytes; never supplied values or internals.
    requestId: string; // Server-generated; also X-Request-ID.
    field?: string; // Allowlisted form field, never raw request content.
  };
}

export interface Account {
  id: Id;
  email: string; // Normalized login identifier; not externally verified identity.
  isOwner: boolean; // Allows project creation, never an implicit project membership.
  createdAt: Milliseconds;
}
export interface SessionInfo {
  id: Id; // Safe record ID; unrelated to the opaque cookie value.
  current: boolean;
  createdAt: Milliseconds;
  lastActiveAt: Milliseconds;
  expiresAt: Milliseconds;
  idleExpiresAt: Milliseconds;
}
export type SessionResponse =
  | { authenticated: false; setupRequired: boolean; user: null; session: null; csrfToken: null }
  | { authenticated: true; setupRequired: false; user: Account; session: SessionInfo; csrfToken: string };
export interface SetupRequest { setupCode: string; email: string; password: string }
export interface LoginRequest { email: string; password: string }
export interface PasswordRequest { currentPassword: string; newPassword: string }

export interface Actor { id: Id; email: string }
export interface Project {
  id: Id;
  name: string;
  createdAt: Milliseconds;
  role: Role; // This caller's current explicit membership.
}
export interface Member {
  user: Actor;
  role: Role;
  joinedAt: Milliseconds;
}
export interface Invite {
  id: Id;
  email: string;
  role: Role;
  issuedBy: Actor;
  createdAt: Milliseconds;
  expiresAt: Milliseconds;
  status: "pending" | "accepted" | "revoked" | "expired";
}
export interface IngestKey {
  id: Id;
  label: string;
  prefix: string; // Safe generated display prefix, never sufficient to authenticate.
  createdBy: Actor;
  createdAt: Milliseconds;
  expiresAt: Milliseconds;
  lastUsedAt: Milliseconds | null;
  revokedAt: Milliseconds | null;
}
export interface InviteCreate { email: string; role: Role; expiresInHours?: number }
export interface InviteAccept { token: string; email: string; password: string }
export interface KeyCreate { label: string; expiresInDays?: number }

export interface RunFilters {
  q?: string; // Literal payload/metadata text; no SQL/wildcard language.
  status?: RunStatus; // Omit for all.
  model?: string; // Exact model match on a span.
  provider?: string; // If combined with model, both match the same span.
  from?: Milliseconds; // Inclusive captured startedAt; omit for all retained history.
  to?: Milliseconds; // Exclusive captured startedAt; omit for no upper bound.
}
export interface RunSummary {
  id: string;
  name: string;
  displayName: string | null;
  firstSeenAt: Milliseconds;
  updatedAt: Milliseconds;
  startedAt: Milliseconds | null;
  endedAt: Milliseconds | null;
  status: RunStatus;
  spanCount: number;
  errorCount: number;
  model: string | null;
  provider: string | null;
  durationMs: number | null;
}
export interface Span {
  id: string;
  runId: string;
  parentSpanId: string | null;
  name: string;
  kind: string | null;
  status: string | null;
  startedAt: Milliseconds | null;
  endedAt: Milliseconds | null;
  durationMs: number | null;
  model: string | null;
  provider: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  inputPayload: string | null;
  outputPayload: string | null;
  attributes: string | null; // Captured JSON text, rendered inertly.
  unavailable: { input: boolean; output: boolean; attributes: boolean };
}
export type SpanSummary = Omit<Span, "inputPayload" | "outputPayload" | "attributes">;
export interface RunDetail { run: RunSummary; spans: Page<SpanSummary> }
export interface Note {
  id: Id;
  runId: string;
  spanId: string | null;
  kind: "note" | "issue" | "good";
  text: string;
  author: Actor;
  createdAt: Milliseconds;
}
export interface NoteCreate { spanId?: string; kind: Note["kind"]; text: string }
export interface Metrics {
  asOf: Milliseconds;
  window: { selection: "1h" | "24h" | "7d" | "30d"; from: Milliseconds; to: Milliseconds; field: "startedAt" };
  traces: { total: number; running: number; completed: number; failed: number; terminal: number };
  duration: {
    population: "completedTraces";
    knownCount: number;
    unavailableCount: number;
    p50Ms: number | null;
    p95Ms: number | null;
  };
}

export type DeterministicRule = Exclude<Rule, { kind: "rubric" }>;
export interface CheckCreate {
  name: string;
  referenceRunId: string;
  candidateRunIds: string[]; // 1–10 distinct IDs, in explicit UI order.
  rules: DeterministicRule[]; // 1–8 rules, in explicit UI order.
}
export interface CheckSummary {
  id: Id;
  projectId: Id;
  name: string;
  author: Actor;
  createdAt: Milliseconds;
  referenceRunId: string;
  candidateRunIds: string[];
  status: CheckStatus;
  counts: { total: number; pass: number; fail: number; inconclusive: number };
  evaluationVersion: number;
  snapshotVersion: number;
  definitionDigest: string; // SHA-256 of canonical frozen definition/reference input.
  calculationDurationMs: number; // Recorded server calculation time, excluding acquisition and persistence.
}
export interface Check extends CheckSummary {
  definition: CheckCreate;
  referenceSnapshot: Snapshot;
  results: Array<{
    runId: string;
    inputMatch: "match" | "mismatch" | "unavailable";
    status: CheckStatus;
    snapshot: Snapshot;
    ruleResults: RuleResult[]; // Runtime source is always "code".
  }>;
}
export interface CheckReport {
  format: "runphantom-team-check/v1";
  check: CheckSummary;
  results: Array<{
    runId: string;
    inputMatch: "match" | "mismatch" | "unavailable";
    status: CheckStatus;
    rules: Array<{
      kind: DeterministicRule["kind"];
      status: CheckStatus;
      evaluatorVersion: string;
      reason: string; // Redacted allowlisted reason, <=512 UTF-8 bytes.
      redacted: boolean;
      truncated: boolean;
    }>;
  }>;
}

export type AuditAction = "project.created" | "member.role_changed" | "member.removed"
  | "invite.created" | "invite.accepted" | "invite.revoked"
  | "key.created" | "key.revoked" | "ingest.committed"
  | "note.created" | "note.deleted" | "check.created" | "run.deleted";
export interface AuditEvent {
  id: Id;
  createdAt: Milliseconds;
  requestId: string;
  actor: { type: "account" | "ingestKey"; id: Id };
  action: AuditAction;
  target: { type: "project" | "member" | "invite" | "key" | "run" | "runBatch" | "note" | "check"; id: Id | null };
  outcome: "success";
  details: { previousRole?: Role; role?: Role; spans?: number; traces?: number; bytes?: number };
}
export interface AuditPage extends Page<AuditEvent> {
  retention: { maxEntries: number; oldestAvailableAt: Milliseconds | null; hasPrunedHistory: boolean };
}
