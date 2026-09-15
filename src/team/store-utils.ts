import { createHash } from "node:crypto";
import { TeamError } from "./errors";
import { TEAM_LIMITS as L, type Page, type PageQuery, type Role } from "./protocol";

export const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const hasControl = (value: string) => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
export function requiredId(value: string): string {
  if (typeof value !== "string" || !value || value.length > 128 || hasControl(value) || /[\s/\\]/.test(value)) throw new TeamError("invalid_request", "Invalid identifier");
  return value;
}
export function requiredName(value: string): string {
  if (typeof value !== "string" || !value.trim() || [...value].length > L.NAME_CHARACTERS || bytes(value) > L.NAME_BYTES || hasControl(value)) throw new TeamError("invalid_request", "Invalid name or label");
  return value.trim();
}
export function requiredEmail(value: string): string {
  if (typeof value !== "string" || value !== value.trim().toLowerCase() || bytes(value) > L.EMAIL_BYTES || hasControl(value) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new TeamError("invalid_request", "Invalid email identifier");
  return value;
}
export function requiredHash(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new TeamError("invalid_request", "Invalid credential digest");
  return value;
}
export function requiredRole(value: Role): Role {
  if (!["admin", "editor", "viewer"].includes(value)) throw new TeamError("invalid_request", "Invalid project role");
  return value;
}
export function lifetime(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new TeamError("invalid_request", "Invalid credential lifetime");
  return result;
}
export interface Paging { limit: number; key: string; anchor: [number | null, string] | null }
export function pageInput(query: PageQuery = {}, key: string): Paging {
  const limit = query.limit ?? L.PAGE_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > L.PAGE_MAX) throw new TeamError("invalid_request", "Invalid page size");
  let anchor: Paging["anchor"] = null;
  if (query.cursor !== undefined) {
    try {
      if (typeof query.cursor !== "string" || !query.cursor || bytes(query.cursor) > L.CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
      const parsed = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      if (parsed.v !== 1 || parsed.k !== key || !Array.isArray(parsed.a) || parsed.a.length !== 2
        || (parsed.a[0] !== null && (typeof parsed.a[0] !== "number" || !Number.isFinite(parsed.a[0]))) || typeof parsed.a[1] !== "string") throw new Error();
      requiredId(parsed.a[1]);
      anchor = parsed.a;
    } catch { throw new TeamError("invalid_request", "Invalid or mismatched page cursor"); }
  }
  return { limit, key, anchor };
}
export function encodeCursor(key: string, anchor: [number | null, string]): string {
  const cursor = Buffer.from(JSON.stringify({ v: 1, k: key, a: anchor })).toString("base64url");
  if (bytes(cursor) > L.CURSOR_BYTES) throw new TeamError("too_large", "Page identity exceeds its representation limit");
  return cursor;
}
export function pageResult<T>(rows: T[], paging: Paging, anchor: (item: T) => [number | null, string]): Page<T> {
  const hasMore = rows.length > paging.limit;
  const items = rows.slice(0, paging.limit);
  const result = { items, hasMore, nextCursor: hasMore && items.length ? encodeCursor(paging.key, anchor(items[items.length - 1])) : null };
  if (bytes(JSON.stringify(result)) > L.API_BYTES) throw new TeamError("too_large", "Page exceeds the response limit");
  return result;
}
