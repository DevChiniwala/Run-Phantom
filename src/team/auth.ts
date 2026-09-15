import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { TeamError } from "./errors";
import { TEAM_LIMITS as L, type SessionResponse } from "./protocol";
import type { TeamConfig } from "./config";
import type { TeamStore, SessionContext } from "./store";

export function tokenHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function hasControlCharacters(value: string): boolean { return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127); }
export function sessionSecret(): string { return `rp_team_session_${randomBytes(32).toString("base64url")}`; }
export function csrfFor(secret: string): string { return createHmac("sha256", secret).update("runphantom-team-csrf/v1").digest("base64url"); }
export function cookieName(config: TeamConfig): string { return config.publicOrigin.startsWith("https:") ? "__Host-runphantom_team" : "runphantom_team_dev"; }

export function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new TeamError("invalid_request", "Request fields are invalid");
  return value as Record<string, unknown>;
}
export function emailValue(value: unknown): string {
  if (typeof value !== "string") throw new TeamError("invalid_request", "Enter a valid account email", "email");
  const email = value.trim().toLowerCase();
  if (Buffer.byteLength(email) > L.EMAIL_BYTES || hasControlCharacters(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new TeamError("invalid_request", "Enter a valid account email", "email");
  return email;
}
export function passwordValue(value: unknown, field = "password"): string {
  if (typeof value !== "string" || Array.from(value).length < L.PASSWORD_MIN || Array.from(value).length > L.PASSWORD_MAX || Buffer.byteLength(value) > L.PASSWORD_BYTES) {
    throw new TeamError("invalid_request", "Password must contain 12 to 128 characters within 512 bytes", field);
  }
  return value;
}
export function opaqueValue(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,160}$/.test(value)) throw new TeamError("invalid_request", "Credential format is invalid");
  return value;
}

export function rawHeader(req: Request, name: string): string | undefined {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) if (req.rawHeaders[index].toLowerCase() === name.toLowerCase()) count++;
  const value = req.headers[name.toLowerCase()];
  if (count > 1 || Array.isArray(value)) throw new TeamError("invalid_request", "Ambiguous request headers");
  return value;
}

export function readSessionSecret(req: Request, config: TeamConfig): string | null {
  const cookie = rawHeader(req, "cookie");
  if (!cookie) return null;
  const values = cookie.split(";").map(value => value.trim()).filter(value => value.slice(0, value.indexOf("=")) === cookieName(config));
  if (values.length > 1) throw new TeamError("invalid_request", "Ambiguous session cookie");
  if (!values.length) return null;
  const value = values[0].slice(values[0].indexOf("=") + 1);
  return /^rp_team_session_[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export function checkCsrf(req: Request, secret: string): void {
  const raw = rawHeader(req, "x-runphantom-csrf");
  if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) throw new TeamError("forbidden", "Session verification failed");
  const candidate = Buffer.from(raw, "base64url"), expected = Buffer.from(csrfFor(secret), "base64url");
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) throw new TeamError("forbidden", "Session verification failed");
}

export function setSessionCookie(res: Response, config: TeamConfig, secret: string | null): void {
  res.setHeader("Set-Cookie", `${cookieName(config)}=${secret ?? ""}; Path=/; HttpOnly; SameSite=Strict${config.publicOrigin.startsWith("https:") ? "; Secure" : ""}; Max-Age=${secret === null ? 0 : L.SESSION_ABSOLUTE_MS / 1000}`);
}

export function sessionResponse(context: SessionContext, secret: string): SessionResponse {
  const { user, session } = context;
  return { authenticated: true, setupRequired: false,
    user: { id: user.id, email: user.email, isOwner: user.isOwner, createdAt: user.createdAt },
    session: { id: session.id, current: true, createdAt: session.createdAt, lastActiveAt: session.lastActiveAt, expiresAt: session.expiresAt, idleExpiresAt: session.idleExpiresAt },
    csrfToken: csrfFor(secret) };
}

export class RateBuckets {
  private readonly buckets = new Map<string, { count: number; expires: number }>();
  constructor(private readonly max: number, private readonly now: () => number = Date.now) {}
  take(key: string, limit: number, expiresAt = Infinity): void {
    const now = this.now();
    for (const [id, bucket] of this.buckets) if (bucket.expires <= now) this.buckets.delete(id);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.max) throw new TeamError("rate_limited", "Request rate capacity reached", undefined, 60);
      bucket = { count: 0, expires: Math.min(now + L.RATE_WINDOW_MS, expiresAt) };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= limit) throw new TeamError("rate_limited", "Request rate limit reached", undefined, Math.max(1, Math.ceil((bucket.expires - now) / 1000)));
    bucket.count++;
  }
  clear(): void { this.buckets.clear(); }
  get size(): number { return this.buckets.size; }
}

let hashesInFlight = 0;
const DUMMY_HASH = "$argon2id$v=19$m=65536,t=2,p=1$1VTNjWv7y6XTxuRbo4IuuS38j2rmWIfQMSaAtk3/mtY$MnurOiUFqdJ1IN6mnk4ew2/m78BWVssN5GTVRcTtl48";

async function admittedHash<T>(work: () => Promise<T>): Promise<T> {
  if (hashesInFlight >= L.HASH_CONCURRENCY) throw new TeamError("rate_limited", "Password verification is busy", undefined, 1);
  hashesInFlight++;
  try { return await work(); } finally { hashesInFlight--; }
}
export async function hashPassword(password: string): Promise<string> {
  return admittedHash(() => Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 65536, timeCost: 2 }));
}
export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  const valid = await admittedHash(() => Bun.password.verify(password, hash ?? DUMMY_HASH));
  return hash !== null && valid;
}

export class TeamAuth {
  constructor(private readonly store: TeamStore) {}
  async setup(body: unknown, requestId: string): Promise<{ context: SessionContext; secret: string }> {
    const input = fields(body, ["setupCode", "email", "password"]);
    const setupCodeHash = tokenHash(opaqueValue(input.setupCode)), email = emailValue(input.email), password = passwordValue(input.password);
    if (!this.store.setupRequired()) throw new TeamError("conflict", "Team setup is already complete");
    const passwordHash = await hashPassword(password), secret = sessionSecret();
    return { context: this.store.setupOwner({ setupCodeHash, email, passwordHash, sessionHash: tokenHash(secret), requestId }), secret };
  }
  async login(body: unknown, requestId: string): Promise<{ context: SessionContext; secret: string }> {
    const input = fields(body, ["email", "password"]), email = emailValue(input.email), password = passwordValue(input.password);
    const account = this.store.getAccountByEmail(email);
    if (!await verifyPassword(password, account?.passwordHash ?? null) || !account) throw new TeamError("unauthenticated", "Email or password is incorrect");
    const secret = sessionSecret();
    return { context: this.store.loginSession({ accountId: account.user.id, passwordHash: account.passwordHash, sessionHash: tokenHash(secret), requestId }), secret };
  }
  async password(context: SessionContext, body: unknown): Promise<{ context: SessionContext; secret: string }> {
    const input = fields(body, ["currentPassword", "newPassword"]), current = passwordValue(input.currentPassword, "currentPassword"), next = passwordValue(input.newPassword, "newPassword");
    const account = this.store.getAccountByEmail(context.user.email);
    if (!await verifyPassword(current, account?.passwordHash ?? null) || !account) throw new TeamError("invalid_request", "Current password is incorrect", "currentPassword");
    const newPasswordHash = await hashPassword(next), secret = sessionSecret();
    return { context: this.store.changePassword(context, { currentPasswordHash: account.passwordHash, newPasswordHash, sessionHash: tokenHash(secret) }), secret };
  }
  async accept(body: unknown, requestId: string) {
    const input = fields(body, ["token", "email", "password"]), token = opaqueValue(input.token), email = emailValue(input.email), password = passwordValue(input.password);
    const invite = this.store.getInviteForAcceptance(tokenHash(token), email);
    if (!invite) throw new TeamError("invalid_request", "Invitation could not be accepted");
    const account = invite.account;
    if (account && !await verifyPassword(password, account.passwordHash)) throw new TeamError("invalid_request", "Invitation could not be accepted");
    const passwordHash = account?.passwordHash ?? await hashPassword(password), secret = sessionSecret();
    const accepted = this.store.acceptInvite({ tokenHash: tokenHash(token), email, passwordHash, expectedAccountId: account?.user.id ?? null, sessionHash: tokenHash(secret), requestId });
    return { ...accepted, secret };
  }
}
