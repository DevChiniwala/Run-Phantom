import type { ApiError } from "./protocol";

export type TeamErrorCode = ApiError["error"]["code"];

const STATUS: Record<TeamErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  quota_exceeded: 409,
  busy: 503,
  query_timeout: 503,
  internal_error: 500,
};

/** Messages must be fixed safe text, never interpolated captured or credential data. */
export class TeamError extends Error {
  readonly status: number;

  constructor(
    readonly code: TeamErrorCode,
    message: string,
    readonly field?: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "TeamError";
    this.status = STATUS[code];
  }
}
