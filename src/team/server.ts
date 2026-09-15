import express, { type Request, type Response, type NextFunction } from "express";
import { createServer as httpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { gunzip } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { resolveBuiltAppDir } from "../ui-assets";
import { parseJsonEvidence } from "../evaluations/json-evidence";
import { TeamStore, type SessionContext, type ProjectContext } from "./store";
import { TeamCheckService } from "./checks";
import { normalizeTeamIngest } from "./ingest";
import { TeamError } from "./errors";
import { TEAM_LIMITS as L, type PageQuery, type RunFilters, type Role, type InviteCreate, type KeyCreate, type NoteCreate } from "./protocol";
import { loadTeamConfig, validateTeamConfig, prepareTeamDirectory, loadBootstrapHash, normalizedAddress, loopbackAddress, type TeamConfig } from "./config";
import { TeamAuth, RateBuckets, rawHeader, readSessionSecret, checkCsrf, tokenHash, sessionResponse, setSessionCookie, fields, emailValue, hasControlCharacters } from "./auth";

const INGEST = "/api/team/ingest/v1/traces";
const PUBLIC_POSTS = new Set(["/api/team/setup", "/api/team/login", "/api/team/invites/accept"]);
const ERROR_FIELDS = new Set(["email", "password", "currentPassword", "newPassword", "name", "label", "text", "role", "rules", "referenceRunId", "candidateRunIds"]);
interface RequestState { requestId: string; signal: AbortSignal; session?: SessionContext; secret?: string }

function pageQuery(req: Request, extras: string[] = []): PageQuery & Record<string, string | number | undefined> {
  const allowed = new Set(["limit", "cursor", ...extras]);
  const out: Record<string, string | number> = {};
  for (const [key, value] of new URL(req.originalUrl, "http://team.invalid").searchParams) {
    if (!allowed.has(key) || Object.hasOwn(out, key)) throw new TeamError("invalid_request", "Query fields are invalid");
    if (key === "limit") {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > L.PAGE_MAX) throw new TeamError("invalid_request", "Page limit must be between 1 and 100");
      out[key] = Number(value);
    } else if (key === "from" || key === "to") {
      if (!value || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > Number.MAX_SAFE_INTEGER) throw new TeamError("invalid_request", "Date filter is invalid");
      out[key] = Number(value);
    } else {
      const max = key === "cursor" ? L.CURSOR_BYTES : L.FILTER_BYTES;
      if (Buffer.byteLength(value) > max || hasControlCharacters(value) || key !== "cursor" && Array.from(value).length > L.FILTER_CHARACTERS) throw new TeamError("invalid_request", "Query value exceeds its bounds");
      out[key] = value;
    }
  }
  if (out.from !== undefined && out.to !== undefined && Number(out.from) >= Number(out.to)) throw new TeamError("invalid_request", "Date range is invalid");
  if (out.status !== undefined && !["running", "completed", "failed"].includes(String(out.status))) throw new TeamError("invalid_request", "Run status is invalid");
  return out as PageQuery & Record<string, string | number | undefined>;
}

function validateIds(req: Request): void {
  for (const [name, id] of Object.entries(req.params)) {
    const valid = name === "runId" ? /^[a-f0-9]{32}$/.test(id) : name === "spanId" ? /^[a-f0-9]{16}$/.test(id) : /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
    if (!valid) throw new TeamError("invalid_request", "Resource identifier is invalid");
  }
}

function readBody(req: Request, limit: number): Promise<Buffer> {
  const length = rawHeader(req, "content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new TeamError("too_large", "Request body is too large");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => { req.off("data", onData); req.off("end", onEnd); req.off("error", onError); req.off("aborted", onAbort); };
    const fail = (error: TeamError) => { cleanup(); req.pause(); reject(error); };
    const onData = (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) { fail(new TeamError("too_large", "Request body is too large")); return; }
      chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); if (length && size !== Number(length)) reject(new TeamError("invalid_request", "Request body is incomplete")); else resolve(Buffer.concat(chunks, size)); };
    const onError = () => fail(new TeamError("invalid_request", "Request body could not be read"));
    const onAbort = () => fail(new TeamError("invalid_request", "Request body is incomplete"));
    req.on("data", onData); req.once("end", onEnd); req.once("error", onError); req.once("aborted", onAbort);
  });
}

function parseJson(body: Buffer): unknown {
  try {
    const text = new TextDecoder("utf8", { fatal: true }).decode(body);
    let depth = 0, quoted = false, escaped = false;
    for (const character of text) {
      if (quoted) { if (escaped) escaped = false; else if (character === "\\") escaped = true; else if (character === '"') quoted = false; }
      else if (character === '"') quoted = true;
      else if (character === "{" || character === "[") { if (++depth > L.INGEST_DEPTH) throw new Error(); }
      else if (character === "}" || character === "]") depth--;
    }
    return parseJsonEvidence(text);
  } catch { throw new TeamError("invalid_request", "JSON request body is invalid or exceeds nesting limits"); }
}

async function expandedBody(body: Buffer, encoding: string): Promise<Buffer> {
  if (encoding === "identity") return body;
  if (encoding !== "gzip") throw new TeamError("unsupported_media_type", "Unsupported request content encoding");
  return new Promise((resolve, reject) => gunzip(body, { maxOutputLength: L.INGEST_EXPANDED_BYTES }, (error, output) => {
    if (error) reject((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE"
      ? new TeamError("too_large", "Expanded request body is too large") : new TeamError("invalid_request", "Compressed request body is invalid"));
    else if (output.byteLength > L.INGEST_EXPANDED_BYTES) reject(new TeamError("too_large", "Expanded request body is too large"));
    else resolve(output);
  }));
}

export async function createTeamServer(input: TeamConfig = loadTeamConfig(), options: { uiDir?: string } = {}) {
  const config = validateTeamConfig(input);
  config.dataDir = prepareTeamDirectory(config.dataDir);
  const bootstrap = loadBootstrapHash(config);
  const dbPath = path.join(config.dataDir, "team.sqlite");
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new TeamError("invalid_request", "Team database files must be regular private files");
  }
  const store = new TeamStore(dbPath, { bootstrapHash: bootstrap.hash });
  if (process.platform !== "win32") for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  const checks = new TeamCheckService(store), auth = new TeamAuth(store);
  const app = express();
  app.disable("x-powered-by"); app.set("query parser", "simple"); app.set("trust proxy", false);
  const server = httpServer({ maxHeaderSize: L.HEADER_BYTES }, app);
  server.headersTimeout = L.REQUEST_TIMEOUT_MS; server.requestTimeout = L.REQUEST_TIMEOUT_MS;
  server.maxConnections = L.REQUEST_CONCURRENCY; server.keepAliveTimeout = 5000;
  server.on("upgrade", (_req, socket) => { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); });
  const states = new WeakMap<Request, RequestState>();
  const socketRates = new RateBuckets(L.RATE_SOCKET_IDENTITIES), globalRates = new RateBuckets(1);
  const sessionRates = new RateBuckets(L.ACCOUNTS * L.USER_SESSIONS), keyRates = new RateBuckets(L.PROJECTS * L.PROJECT_KEYS);
  let active = 0;

  const send = (res: Response, body: unknown, status = 200, limit: number = L.API_BYTES) => {
    const json = JSON.stringify(body);
    if (Buffer.byteLength(json) > limit) throw new TeamError("too_large", "Response exceeds its size limit");
    res.status(status).type("application/json").send(json);
  };
  app.use((req, res, next) => {
    const requestId = randomUUID(), controller = new AbortController();
    states.set(req, { requestId, signal: controller.signal });
    res.setHeader("X-Request-ID", requestId); res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    try {
      const peer = normalizedAddress(req.socket.remoteAddress ?? "");
      if (config.trustedProxyIps.length ? !config.trustedProxyIps.includes(peer) : !loopbackAddress(peer)) throw new TeamError("forbidden", "Network peer is not allowed");
      const host = rawHeader(req, "host"), expected = new URL(config.publicOrigin);
      if (!host || /[\s/@?#\\]/.test(host) || new URL(`${expected.protocol}//${host}`).host !== expected.host) throw new TeamError("forbidden", "Request host is not allowed");
      const origin = rawHeader(req, "origin"), site = rawHeader(req, "sec-fetch-site");
      if (req.path.startsWith("/api/") && site !== undefined && site !== "same-origin" && site !== "none") throw new TeamError("forbidden", "Request origin is not allowed");
      const write = !["GET", "HEAD", "OPTIONS"].includes(req.method);
      if (origin !== undefined && origin !== config.publicOrigin || write && req.path !== INGEST && origin === undefined) throw new TeamError("forbidden", "Request origin is not allowed");
      if (["GET", "HEAD", "DELETE"].includes(req.method) && (Number(rawHeader(req, "content-length") ?? 0) > 0 || rawHeader(req, "transfer-encoding") !== undefined)) throw new TeamError("invalid_request", "This endpoint does not accept a request body");
      if (active >= L.REQUEST_CONCURRENCY) throw new TeamError("busy", "Server request capacity reached", undefined, 1);
      active++;
      let released = false;
      const timer = setTimeout(() => { controller.abort(); req.destroy(); }, L.REQUEST_TIMEOUT_MS);
      timer.unref();
      const release = () => { if (!released) { released = true; active--; clearTimeout(timer); } };
      req.once("aborted", () => controller.abort());
      res.once("finish", release);
      res.once("close", () => { if (!res.writableEnded) controller.abort(); release(); });
      next();
    } catch (error) { next(error instanceof TeamError ? error : new TeamError("forbidden", "Request host is not allowed")); }
  });

  function authenticate(req: Request): { context: SessionContext; secret: string } {
    const state = states.get(req)!;
    if (state.session && state.secret) return { context: state.session, secret: state.secret };
    const secret = readSessionSecret(req, config), context = secret ? store.getSession(tokenHash(secret), state.requestId) : null;
    if (!secret || !context) throw new TeamError("unauthenticated", "Sign in to continue");
    sessionRates.take(context.session.id, L.REQUESTS_PER_SESSION, context.session.expiresAt);
    if (!["GET", "HEAD"].includes(req.method)) checkCsrf(req, secret);
    state.session = context; state.secret = secret;
    return { context, secret };
  }
  function scope(req: Request, role?: Role): ProjectContext { return store.projectScope(authenticate(req).context, req.params.projectId, role); }
  async function jsonBody(req: Request, limit: number = L.CONTROL_BYTES): Promise<unknown> {
    if (rawHeader(req, "content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" || ![undefined, "identity"].includes(rawHeader(req, "content-encoding"))) throw new TeamError("unsupported_media_type", "This endpoint accepts uncompressed JSON only");
    return parseJson(await readBody(req, limit));
  }
  const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve().then(() => {
      validateIds(req);
      const route = String(req.route.path);
      let allowed: string[] = [];
      if (req.method === "GET") {
        if (route === "/api/team/projects" || /\/(members|invites|keys|runs|notes|audit|checks)$/.test(route) || route.endsWith("/runs/:runId")) allowed = ["limit", "cursor"];
        if (route.endsWith("/runs")) allowed.push("q", "status", "model", "provider", "from", "to");
        if (route.endsWith("/metrics")) allowed = ["window"];
      }
      const seen = new Set<string>();
      for (const [key] of new URL(req.originalUrl, "http://team.invalid").searchParams) {
        if (!allowed.includes(key) || seen.has(key)) throw new TeamError("invalid_request", "Query fields are invalid");
        seen.add(key);
      }
      return fn(req, res);
    }).catch(next);
  };
  app.get("/api/team/session", wrap((req, res) => {
    pageQuery(req);
    const secret = readSessionSecret(req, config), context = secret ? store.getSession(tokenHash(secret), states.get(req)!.requestId) : null;
    if (secret && context) { sessionRates.take(context.session.id, L.REQUESTS_PER_SESSION, context.session.expiresAt); send(res, sessionResponse(context, secret)); }
    else { setSessionCookie(res, config, null); send(res, { authenticated: false, setupRequired: store.setupRequired(), user: null, session: null, csrfToken: null }); }
  }));
  for (const endpoint of PUBLIC_POSTS) app.post(endpoint, wrap(async (req, res) => {
    socketRates.take(normalizedAddress(req.socket.remoteAddress ?? ""), L.AUTH_PER_SOCKET); globalRates.take("auth", L.AUTH_GLOBAL);
    const body = await jsonBody(req), requestId = states.get(req)!.requestId;
    if (endpoint.endsWith("/accept")) {
      const result = await auth.accept(body, requestId); setSessionCookie(res, config, result.secret);
      send(res, { session: sessionResponse(result.context, result.secret), project: result.project }, 201);
    } else {
      const result = endpoint.endsWith("/setup") ? await auth.setup(body, requestId) : await auth.login(body, requestId);
      setSessionCookie(res, config, result.secret); send(res, sessionResponse(result.context, result.secret), endpoint.endsWith("/setup") ? 201 : 200);
    }
  }));
  app.post("/api/team/logout", wrap(async (req, res) => { const { context } = authenticate(req); fields(await jsonBody(req), []); store.logout(context); setSessionCookie(res, config, null); res.sendStatus(204); }));
  app.post("/api/team/password", wrap(async (req, res) => { const { context } = authenticate(req); const result = await auth.password(context, await jsonBody(req)); setSessionCookie(res, config, result.secret); send(res, sessionResponse(result.context, result.secret)); }));
  app.get("/api/team/sessions", wrap((req, res) => { send(res, { items: store.listSessions(authenticate(req).context) }); }));
  app.delete("/api/team/sessions/:sessionId", wrap((req, res) => { const { context } = authenticate(req); store.revokeSession(context, req.params.sessionId); if (context.session.id === req.params.sessionId) setSessionCookie(res, config, null); res.sendStatus(204); }));

  app.get("/api/team/projects", wrap((req, res) => send(res, store.listProjects(authenticate(req).context, pageQuery(req)))));
  app.post("/api/team/projects", wrap(async (req, res) => { const { context } = authenticate(req), body = fields(await jsonBody(req), ["name"]); send(res, store.createProject(context, { name: body.name as string }), 201); }));
  const p = "/api/team/projects/:projectId";
  app.get(p, wrap((req, res) => send(res, store.getProject(scope(req)))));
  app.get(`${p}/members`, wrap((req, res) => send(res, store.listMembers(scope(req, "admin"), pageQuery(req)))));
  app.patch(`${p}/members/:userId`, wrap(async (req, res) => { const ctx = scope(req, "admin"), body = fields(await jsonBody(req), ["role"]); send(res, store.changeMemberRole(ctx, req.params.userId, body.role as Role)); }));
  app.delete(`${p}/members/:userId`, wrap((req, res) => { store.removeMember(scope(req, "admin"), req.params.userId); res.sendStatus(204); }));
  app.get(`${p}/invites`, wrap((req, res) => send(res, store.listInvites(scope(req, "admin"), pageQuery(req)))));
  app.post(`${p}/invites`, wrap(async (req, res) => { const ctx = scope(req, "admin"), body = fields(await jsonBody(req), ["email", "role", "expiresInHours"]); send(res, store.createInvite(ctx, { ...body, email: emailValue(body.email) } as InviteCreate), 201); }));
  app.delete(`${p}/invites/:inviteId`, wrap((req, res) => { store.revokeInvite(scope(req, "admin"), req.params.inviteId); res.sendStatus(204); }));
  app.get(`${p}/keys`, wrap((req, res) => send(res, store.listKeys(scope(req, "admin"), pageQuery(req)))));
  app.post(`${p}/keys`, wrap(async (req, res) => { const ctx = scope(req, "admin"), body = fields(await jsonBody(req), ["label", "expiresInDays"]); send(res, store.createKey(ctx, body as unknown as KeyCreate), 201); }));
  app.delete(`${p}/keys/:keyId`, wrap((req, res) => { store.revokeKey(scope(req, "admin"), req.params.keyId); res.sendStatus(204); }));
  app.get(`${p}/runs`, wrap(async (req, res) => { const ctx = scope(req), result = await store.searchRuns(ctx, pageQuery(req, ["q", "status", "model", "provider", "from", "to"]) as PageQuery & RunFilters, states.get(req)!.signal); store.projectScope(authenticate(req).context, req.params.projectId); send(res, result, 200, L.SEARCH_BYTES); }));
  app.get(`${p}/runs/:runId`, wrap((req, res) => send(res, store.getRun(scope(req), req.params.runId, pageQuery(req)))));
  app.delete(`${p}/runs/:runId`, wrap((req, res) => { store.deleteRun(scope(req, "admin"), req.params.runId); res.sendStatus(204); }));
  app.get(`${p}/runs/:runId/spans/:spanId`, wrap((req, res) => send(res, store.getSpan(scope(req), req.params.runId, req.params.spanId))));
  app.get(`${p}/runs/:runId/notes`, wrap((req, res) => send(res, store.listNotes(scope(req), req.params.runId, pageQuery(req)))));
  app.post(`${p}/runs/:runId/notes`, wrap(async (req, res) => { const ctx = scope(req, "editor"), body = fields(await jsonBody(req), ["spanId", "kind", "text"]); send(res, store.createNote(ctx, req.params.runId, body as unknown as NoteCreate), 201); }));
  app.delete(`${p}/runs/:runId/notes/:noteId`, wrap((req, res) => { store.deleteNote(scope(req, "editor"), req.params.runId, req.params.noteId); res.sendStatus(204); }));
  app.get(`${p}/metrics`, wrap((req, res) => { const query = pageQuery(req, ["window"]); if (query.limit !== undefined || query.cursor !== undefined || query.window !== undefined && !["1h", "24h", "7d", "30d"].includes(String(query.window))) throw new TeamError("invalid_request", "Metrics window is invalid"); send(res, store.metrics(scope(req), query.window as "1h" | "24h" | "7d" | "30d" | undefined)); }));
  app.get(`${p}/audit`, wrap((req, res) => send(res, store.listAudit(scope(req, "admin"), pageQuery(req)))));
  app.get(`${p}/checks`, wrap((req, res) => send(res, checks.list(scope(req), pageQuery(req)))));
  app.post(`${p}/checks`, wrap(async (req, res) => { const ctx = scope(req, "editor"); send(res, await checks.create(ctx, await jsonBody(req, L.CHECK_REQUEST_BYTES), states.get(req)!.signal), 201, L.CHECK_BYTES); }));
  app.get(`${p}/checks/:checkId`, wrap((req, res) => send(res, checks.get(scope(req), req.params.checkId), 200, L.CHECK_BYTES)));
  app.get(`${p}/checks/:checkId/report`, wrap((req, res) => { const report = checks.report(scope(req), req.params.checkId); res.setHeader("Content-Disposition", `attachment; filename="runphantom-check-${req.params.checkId}.json"`); send(res, report, 200, L.CHECK_BYTES); }));

  app.post(INGEST, wrap(async (req, res) => {
    const header = rawHeader(req, "authorization");
    const match = header && /^Bearer (rp_team_ingest_[A-Za-z0-9_-]{43})$/.exec(header);
    if (!match) throw new TeamError("unauthenticated", "A valid project ingestion key is required");
    const ctx = store.getIngestContext(tokenHash(match[1]), states.get(req)!.requestId);
    if (!ctx) throw new TeamError("unauthenticated", "A valid project ingestion key is required");
    keyRates.take(ctx.keyId, L.INGEST_PER_KEY);
    const contentType = rawHeader(req, "content-type")?.split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json" && contentType !== "application/x-protobuf") throw new TeamError("unsupported_media_type", "Unsupported telemetry content type");
    const body = await expandedBody(await readBody(req, L.INGEST_WIRE_BYTES), rawHeader(req, "content-encoding") ?? "identity");
    const batch = normalizeTeamIngest(body, contentType === "application/json" ? "json" : "protobuf", match[1]);
    if (states.get(req)!.signal.aborted) return;
    store.ingest(ctx, batch);
    if (contentType === "application/json") send(res, {});
    else res.status(200).type("application/x-protobuf").send(Buffer.alloc(0));
  }));

  const uiDir = options.uiDir ?? await resolveBuiltAppDir();
  app.get("/", (_req, res) => res.redirect(302, "/team"));
  app.use("/assets", express.static(path.join(uiDir, "assets"), { dotfiles: "deny", fallthrough: false }));
  app.get(["/favicon.ico", "/favicon.svg"], (req, res, next) => res.sendFile(path.join(uiDir, req.path), error => { if (error) next(new TeamError("not_found", "Resource not found")); }));
  app.get(["/team", "/team/*"], (_req, res, next) => res.sendFile(path.join(uiDir, "index.html"), error => { if (error) next(new TeamError("not_found", "Build the team UI before opening this page")); }));
  app.use((_req, _res, next) => next(new TeamError("not_found", "Resource not found")));
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent || res.destroyed) return;
    const safe = error instanceof TeamError ? error : new TeamError("internal_error", "Request failed");
    if (safe.retryAfter !== undefined) res.setHeader("Retry-After", String(Math.min(3600, Math.max(1, Math.ceil(safe.retryAfter)))));
    if (safe.status === 401) {
      try {
        const secret = readSessionSecret(req, config);
        if (secret && !store.getSession(tokenHash(secret))) setSessionCookie(res, config, null);
      } catch { /* An ambiguous credential is rejected without changing another session. */ }
    }
    if (!req.complete) { res.setHeader("Connection", "close"); res.once("finish", () => req.destroy()); }
    send(res, { error: { code: safe.code, message: Buffer.byteLength(safe.message) <= 512 ? safe.message : "Request failed", requestId: states.get(req)?.requestId ?? randomUUID(), ...(safe.field && ERROR_FIELDS.has(safe.field) ? { field: safe.field } : {}) } }, safe.status);
  });
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    checks.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    socketRates.clear(); globalRates.clear(); sessionRates.clear(); keyRates.clear(); store.close();
  };
  return { app, server, store, config, bootstrapFile: bootstrap.file, close };
}
