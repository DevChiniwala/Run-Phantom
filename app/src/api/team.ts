import type { ApiError, SessionResponse } from "../../../src/team/protocol";
export type * from "../../../src/team/protocol";

export class TeamApiError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string) {
    super(message);
    this.name = "TeamApiError";
  }
}

/** One in-memory client per team session provider; no local daemon requests. */
export class TeamClient {
  private csrf: string | null = null;
  private principal: string | null = null;
  private generation = 0;
  private projectGenerations = new Map<string, number>();
  constructor(private onAccessError: (status: number, path: string) => void) {}

  setSession(session: SessionResponse) {
    const principal = session.authenticated ? session.session.id : null;
    if (this.principal !== principal) { this.generation++; this.projectGenerations.clear(); }
    this.principal = principal;
    this.csrf = session.csrfToken;
  }

  async request<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const generation = this.generation;
    const project = path.match(/^\/projects\/([^/?]+)(?:\/|$)/)?.[1];
    const projectGeneration = project ? this.projectGenerations.get(project) ?? 0 : 0;
    const method = options.method ?? "GET";
    // A fresh membership read resolves permission changes. Its caller cancels
    // the previous read, while resource responses retain generation protection.
    const membershipRead = project && method === "GET" && path === `/projects/${project}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET" && this.csrf) headers["X-RunPhantom-CSRF"] = this.csrf;
    const response = await fetch(`/api/team${path}`, {
      method, headers, credentials: "same-origin", cache: "no-store", signal: options.signal,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const data: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined);
    if (generation !== this.generation || options.signal?.aborted || project && !membershipRead && projectGeneration !== (this.projectGenerations.get(project) ?? 0)) throw new DOMException("Request superseded", "AbortError");
    if (!response.ok) {
      const failure = (data as ApiError | undefined)?.error;
      // A response issued under the previous project permission state must not
      // reveal a one-time credential after a later request discovers revocation.
      if (response.status === 403 && project) this.projectGenerations.set(project, projectGeneration + 1);
      if (response.status === 401 || response.status === 403 || response.status === 404) this.onAccessError(response.status, path);
      throw new TeamApiError(response.status, failure?.code ?? "request_failed", failure?.message ?? "The request could not be completed. Please try again.", failure?.requestId);
    }
    return data as T;
  }
}

export function teamQuery(values: object): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  const text = query.toString();
  return text ? `?${text}` : "";
}

export function projectApi(projectId: string): string { return `/projects/${encodeURIComponent(projectId)}`; }
export function projectPath(projectId: string): string { return `/team/projects/${encodeURIComponent(projectId)}`; }

export function downloadTeamJson(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
