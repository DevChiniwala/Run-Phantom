import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useParams } from "react-router-dom";
import { TeamApiError, TeamClient, projectApi, teamQuery, type Page, type Project, type SessionResponse } from "../api/team";
import { ErrorNotice, Loading } from "./common";

type Authenticated = Extract<SessionResponse, { authenticated: true }>;
const signedOut: SessionResponse = { authenticated: false, setupRequired: false, user: null, session: null, csrfToken: null };
interface TeamContextValue { client: TeamClient; session: SessionResponse; acceptSession: (session: SessionResponse) => void; notice: string; permissionRevisions: Readonly<Record<string, number>>; clearSession: () => void }
const TeamContext = createContext<TeamContextValue | null>(null);
const ProjectContext = createContext<Project | null>(null);
export function useTeam() { const value = useContext(TeamContext); if (!value) throw new Error("Team session context is missing"); return value; }
export function useAccount(): Authenticated { const { session } = useTeam(); if (!session.authenticated) throw new Error("Sign in to continue"); return session; }
export function useProject() { const project = useContext(ProjectContext); if (!project) throw new Error("Select a project to continue"); return project; }

export function TeamProvider({ children }: { children: ReactNode }) {
  const [queries] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0, refetchOnWindowFocus: true }, mutations: { retry: false } } }));
  const [session, setSession] = useState<SessionResponse | null>(null);
  const current = useRef<SessionResponse | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [permissionRevisions, setPermissionRevisions] = useState<Record<string, number>>({});
  const accessChecks = useRef(new Set<string>());
  const [client] = useState(() => new TeamClient((status, path) => {
    if (status === 401 && !["/login", "/setup", "/invites/accept"].includes(path)) {
      current.current = signedOut;
      client.setSession(signedOut);
      void queries.cancelQueries(); queries.clear(); setSession(signedOut);
      setNotice("Your session has ended. Sign in to continue.");
    }
    if (status !== 403 && status !== 404) return;
    const project = path.match(/^\/projects\/([^/?]+)(?:\/|$)/)?.[1];
    const principal = current.current;
    if (!project || !principal?.authenticated) return;
    if (status === 403) {
      // One-time values disappear immediately, before the membership response.
      setPermissionRevisions(value => ({ ...value, [project]: (value[project] ?? 0) + 1 }));
    }
    const owner = `${principal.session.id}:${project}`;
    if (accessChecks.current.has(owner)) return;
    if (status === 403) {
      queries.removeQueries({ predicate: q => q.queryKey.includes(project) && q.queryKey.includes("admin") });
    }
    // A missing object and a revoked membership intentionally share 404. Recheck
    // only the membership endpoint, never recursively recheck its own failure.
    if (path === projectApi(project)) return;
    const key = ["team", principal.session.id, principal.user.id, project, "project"];
    accessChecks.current.add(owner);
    void (async () => {
      try {
        await queries.cancelQueries({ queryKey: key, exact: true });
        if (current.current?.session?.id !== principal.session.id) return;
        await queries.fetchQuery({ queryKey: key, queryFn: ({ signal }) => client.request<Project>(projectApi(project), { signal }), staleTime: 0 });
      } catch (cause) {
        if (cause instanceof TeamApiError && cause.status === 404 && current.current?.session?.id === principal.session.id) {
          const scope = { predicate: (q: { queryKey: readonly unknown[] }) => q.queryKey[1] === principal.session.id && q.queryKey.includes(project) && !q.queryKey.includes("project") };
          await queries.cancelQueries(scope);
          queries.removeQueries(scope);
        }
      } finally { accessChecks.current.delete(owner); }
    })();
  }));
  const acceptSession = (next: SessionResponse) => {
    const previousId = current.current?.session?.id;
    if (previousId !== next.session?.id) { void queries.cancelQueries(); queries.clear(); setPermissionRevisions({}); }
    if (current.current?.authenticated && !next.authenticated) setNotice("Your session has ended. Sign in to continue.");
    else if (next.authenticated) setNotice("");
    current.current = next; client.setSession(next); setSession(next);
  };
  const acceptRef = useRef(acceptSession); acceptRef.current = acceptSession;
  useEffect(() => {
    let active = true;
    let loading = false;
    const controller = new AbortController();
    const load = async () => {
      if (loading) return;
      loading = true;
      try { const result = await client.request<SessionResponse>("/session", { signal: controller.signal }); if (active) { setError(null); acceptRef.current(result); } }
      catch (cause) { if (active && !(cause instanceof DOMException && cause.name === "AbortError")) setError(cause); }
      finally { loading = false; }
    };
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30_000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [client, attempt]);
  return <QueryClientProvider client={queries}>{session ? <TeamContext.Provider value={{ client, session, acceptSession, notice, permissionRevisions, clearSession: () => { acceptSession(signedOut); setNotice(""); } }}>{children}</TeamContext.Provider> : <main className="team-auth"><ErrorNotice error={error} retry={() => setAttempt(n => n + 1)} />{!error && <Loading />}</main>}</QueryClientProvider>;
}

export function useTeamQuery<T>(key: readonly unknown[], path: string, poll = 0) {
  const { client } = useTeam(); const session = useAccount();
  return useQuery({ queryKey: ["team", session.session.id, session.user.id, ...key], queryFn: ({ signal }) => client.request<T>(path, { signal }), refetchInterval: poll || false, refetchIntervalInBackground: false });
}
export function useTeamPages<T>(key: readonly unknown[], path: string, filters: object = {}, poll = 0) {
  const { client } = useTeam(); const session = useAccount();
  const queryKey = ["team", session.session.id, session.user.id, ...key, filters];
  const result = useInfiniteQuery({ queryKey, initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => client.request<Page<T>>(`${path}${teamQuery({ ...filters, limit: 50, cursor: pageParam })}`, { signal }),
    getNextPageParam: page => page.hasMore ? page.nextCursor ?? undefined : undefined });
  usePagePolling(queryKey, poll, result.refetch);
  return result;
}
export function usePagePolling(key: readonly unknown[], poll: number, refresh: () => unknown) {
  const queries = useQueryClient(); const stableKey = JSON.stringify(key);
  const latest = useRef({ key, refresh }); latest.current = { key, refresh };
  useEffect(() => {
    if (!poll) return;
    const timer = window.setInterval(() => {
      const currentKey = latest.current.key;
      if (document.visibilityState !== "visible" || queries.isFetching({ queryKey: currentKey, exact: true })) return;
      queries.setQueryData<{ pages: unknown[]; pageParams: unknown[] }>(currentKey, value => value ? { ...value, pages: value.pages.slice(0, 1), pageParams: value.pageParams.slice(0, 1) } : value);
      void latest.current.refresh();
    }, poll);
    return () => clearInterval(timer);
  }, [poll, stableKey, queries]);
}
export function ProjectBoundary({ children }: { children: ReactNode }) {
  const { projectId = "" } = useParams(); const queries = useQueryClient();
  const result = useTeamQuery<Project>([projectId, "project"], projectApi(projectId), 30_000);
  useEffect(() => { if (result.error) queries.removeQueries({ predicate: q => q.queryKey.includes(projectId) && !q.queryKey.includes("project") }); }, [projectId, queries, result.error]);
  if (result.isPending) return <Loading text="Opening project…" />;
  if (result.error) return <div className="team-page"><ErrorNotice error={result.error} retry={() => void result.refetch()} /><p><a href="/team">Return to projects</a></p></div>;
  return <ProjectContext.Provider key={`${projectId}:${result.data.role}`} value={result.data}>{children}</ProjectContext.Provider>;
}
export function RequireSession({ children }: { children: ReactNode }) { return useTeam().session.authenticated ? children : <Navigate to="/team/login" replace />; }
