import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavigationType, useNavigate, useNavigationType, useParams } from "react-router-dom";
import { runPath } from "../utils/navigation";
import { RunListItem } from "../components/RunList";
import { RunDetail } from "../components/RunDetail";
import { EmptyState } from "../components/EmptyState";
import { ReplayView } from "../components/ReplayView";
import { RunComparison } from "../components/RunComparison";
import { useReplay } from "../hooks/use-replay";
import { RotateCcw, ArrowRight, X, ChevronDown, ArrowLeft } from "lucide-react";
import { C } from "../utils/colors";
import { fetchPrices, modelPricingConsentEnabled } from "../utils/costs";
import { parseReplayMetadata } from "../utils/types";
import type { Run } from "../utils/types";
import { runDisplayName, safeDecodeParam } from "../utils/helpers";
import { useRunPhantomConnected, useRunPhantomMessage } from "../hooks/use-runphantom-ws";
import { useIsMobile } from "../hooks/use-mobile";
import { useScrollRestoration } from "../hooks/use-scroll-restoration";

const FIRST_TIME_SETUP_DISMISSED_KEY = "runphantom:firstTimeSetupDismissed";
const RUNS_REFRESH_WINDOW_MS = 400;

function loadFirstTimeSetupDismissed(): boolean {
  try {
    return localStorage.getItem(FIRST_TIME_SETUP_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveFirstTimeSetupDismissed(): void {
  try {
    localStorage.setItem(FIRST_TIME_SETUP_DISMISSED_KEY, "1");
  } catch {}
}

function isDefaultDemoRun(run: Run): boolean {
  if (run.id.startsWith("demo_")) return true;
  if (!run.metadata) return false;
  try {
    const metadata = JSON.parse(run.metadata);
    return metadata?.demo === true && metadata?.default === true;
  } catch {
    return false;
  }
}

export function RunsPage() {
  const navigate = useNavigate();
  const { runId: routeRunId } = useParams<{ runId?: string }>();
  const selectedId = routeRunId ? safeDecodeParam(routeRunId) : null;
  const isMobile = useIsMobile();
  const [runs, setRuns] = useState<Run[]>([]);
  const [replayOriginalId, setReplayOriginalId] = useState<string | null>(null);
  const [replayCompare, setReplayCompare] = useState(false);
  const replay = useReplay();
  const [search, setSearch] = useState("");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const wsConnected = useRunPhantomConnected();
  const [hoveredSourceId, setHoveredSourceId] = useState<string | null>(null);
  const [firstTimeSetupDismissed, setFirstTimeSetupDismissed] = useState(loadFirstTimeSetupDismissed);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigationType = useNavigationType();
  const [runsError, setRunsError] = useState<string | null>(null);
  useScrollRestoration(listRef, "runs-list");
  // The onboarding pane is shown when there are no runs, and "no runs yet" and
  // "haven't asked yet" looked identical — so a slow /api/runs greeted a user
  // with a full first-run setup screen for a machine that had traces all along.
  const [runsLoaded, setRunsLoaded] = useState(false);

  useEffect(() => {
    if (modelPricingConsentEnabled()) void fetchPrices();
  }, []);
  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/runs");
      if (!res.ok) throw new Error(`Run list request failed (${res.status})`);
      const fresh: unknown = await res.json();
      // A 5xx still returns valid JSON — an error object, not an array. The
      // updater below runs outside this try, so `fresh.map` threw there and took
      // the whole route down through the error boundary instead of showing a
      // recoverable failure in the one column that failed.
      if (!Array.isArray(fresh)) throw new Error("Run list response was not a list");
      setRunsError(null);
      const list = fresh as Run[];
      setRuns(prev => {
        if (prev.length === 0) return list;
        const freshById = new Map(list.map(r => [r.id, r]));
        const prevIds = new Set(prev.map(r => r.id));
        const freshIds = new Set(list.map(r => r.id));
        // If run set changed (added/deleted), use server ordering to avoid
        // stale runs appearing at wrong positions.
        const same = prevIds.size === freshIds.size && [...prevIds].every(id => freshIds.has(id));
        if (!same) return list;
        // Same set of runs — update data in place, keep client ordering
        return prev.map(r => freshById.get(r.id)!);
      });
    } catch (err) {
      setRunsError((err as Error).message || "Could not load runs");
    } finally {
      setRunsLoaded(true);
    }
  }, []);

  useEffect(() => { fetchRuns(); }, [fetchRuns]);

  // Every WebSocket frame used to trigger a full /api/runs fetch, and a streaming
  // agent emits one per token — so a single live run put the list endpoint under
  // continuous load and re-rendered the sidebar on every token. Coalesce to one
  // refresh per window, with a trailing call so the settled state always lands.
  const refreshTimer = useRef<number | null>(null);
  const refreshPending = useRef(false);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) { refreshPending.current = true; return; }
    void fetchRuns();
    refreshTimer.current = window.setTimeout(function settle() {
      refreshTimer.current = null;
      if (!refreshPending.current) return;
      refreshPending.current = false;
      scheduleRefresh();
    }, RUNS_REFRESH_WINDOW_MS);
  }, [fetchRuns]);

  useEffect(() => () => {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
  }, []);

  useRunPhantomMessage(scheduleRefresh);

  useEffect(() => {
    const handleRunRemoved = (event: Event) => {
      const runId = (event as CustomEvent<{ runId?: string }>).detail?.runId;
      if (!runId) return;
      setRuns((prev) => prev.filter((run) => run.id !== runId));
    };
    window.addEventListener("runphantom:run-removed", handleRunRemoved);
    return () => window.removeEventListener("runphantom:run-removed", handleRunRemoved);
  }, []);

  const hasUserTraces = useMemo(
    () => runs.some((run) => !isDefaultDemoRun(run)),
    [runs],
  );

  useEffect(() => {
    if (!hasUserTraces || firstTimeSetupDismissed) return;
    saveFirstTimeSetupDismissed();
    setFirstTimeSetupDismissed(true);
  }, [firstTimeSetupDismissed, hasUserTraces]);

  useEffect(() => {
    if (runs.length === 0 || replayOriginalId) return;
    // An explicit run id in the URL (valid or not) must reach RunDetail so it can
    // resolve the trace or render TraceNotFound on a 404. Only auto-pick a default
    // when nothing is selected — otherwise a deep-link to a deleted/unknown run
    // would silently redirect to an unrelated run.
    if (selectedId) return;
    if (isMobile) return;
    const firstUserTrace = runs.find((run) => !isDefaultDemoRun(run));
    if (firstUserTrace) navigate(runPath(firstUserTrace.id), { replace: true });
  }, [isMobile, navigate, replayOriginalId, runs, selectedId]);

  useEffect(() => {
    if (isMobile && replayCompare) setReplayCompare(false);
  }, [isMobile, replayCompare]);

  const [, setTick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setTick(t => t + 1), 5000);
    return () => clearInterval(i);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape") {
        if (search) { setSearch(""); searchRef.current?.blur(); }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [search]);

  useEffect(() => {
    if (replay.replayRunId && replayOriginalId) {
      navigate(runPath(replay.replayRunId), { replace: true });
      listRef.current?.scrollTo({ top: 0 });
    }
  }, [navigate, replay.replayRunId, replayOriginalId]);

  const agentTypes = useMemo(() => {
    const names = new Set<string>();
    for (const r of runs) {
      const name = (r.event_name ?? "").replace(/^replay:/, "");
      if (name) names.add(name);
    }
    return [...names].sort();
  }, [runs]);

  const filtered = useMemo(() => {
    let list = runs;
    if (agentFilter !== "all") {
      list = list.filter(r => {
        const name = (r.event_name ?? "").replace(/^replay:/, "");
        return name === agentFilter;
      });
    }
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(r =>
      runDisplayName(r).toLowerCase().includes(q) ||
      (r.event_name ?? "").toLowerCase().includes(q) ||
      (r.name ?? "").toLowerCase().includes(q) ||
      (r.user_id ?? "").toLowerCase().includes(q) ||
      (r.convo_id ?? "").toLowerCase().includes(q) ||
      r.id.toLowerCase().includes(q)
    );
  }, [runs, search, agentFilter]);


  const handleClear = async () => {
    if (!confirm("Clear all runs?")) return;
    await fetch("/api/clear", { method: "POST" });
    navigate("/runs", { replace: true });
    setRuns([]);
  };

  const openDemoTrace = useCallback(async () => {
    const response = await fetch("/api/demo-traces/replay", { method: "POST" });
    if (!response.ok) throw new Error("Failed to load demo traces");
    const body = await response.json().catch(() => null) as { runIds?: string[] } | null;
    if (replayOriginalId) { replay.reset(); setReplayOriginalId(null); }
    const fresh: Run[] = await (await fetch("/api/runs")).json();
    setRuns(fresh);
    const firstDemoRunId =
      body?.runIds?.find((id) => fresh.some((run) => run.id === id)) ??
      fresh.find(isDefaultDemoRun)?.id ??
      "demo_triage";
    navigate(runPath(firstDemoRunId));
  }, [navigate, replay, replayOriginalId]);

  const handleFork = useCallback((sourceRunId: string, userMessage?: string, mode?: "local", model?: string, contextOverrides?: Record<string, any>) => {
    setReplayOriginalId(sourceRunId);
    replay.reset();
    replay.startReplay({ runId: sourceRunId, userMessage, mode: "local", model, contextOverrides });
  }, [replay]);

  const handleSelectRun = useCallback((id: string) => {
    if (replayOriginalId) { replay.reset(); setReplayOriginalId(null); }
    navigate(runPath(id));
  }, [navigate, replay, replayOriginalId]);

  useEffect(() => {
    // Not on Back/Forward: useScrollRestoration is putting the list back where
    // the reader left it, and revealing the selected row fought that restore and
    // won, snapping the list to the selected run instead.
    //
    // Not on Replace either, which is how this page auto-selects a run on load.
    // scrollIntoView moves the sequential focus navigation starting point to the
    // revealed row, so the very first Tab landed inside the run list and skipped
    // both the skip link and the entire sidebar.
    if (navigationType === NavigationType.Pop || navigationType === NavigationType.Replace) return;
    const selected = selectedId
      ? Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-run-id]") ?? [])
          .find(el => el.dataset.runId === selectedId)
      : null;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedId, filtered, navigationType]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const target = e.target as HTMLElement | null;
      const isTypingTarget =
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable ||
        (target instanceof HTMLInputElement && target !== searchRef.current);
      if (isTypingTarget || filtered.length === 0 || !target || !listRef.current?.contains(target)) return;

      e.preventDefault();
      const currentIndex = filtered.findIndex(run => run.id === selectedId);
      const nextIndex = e.key === "ArrowDown"
        ? Math.min(currentIndex + 1, filtered.length - 1)
        : Math.max(currentIndex === -1 ? filtered.length - 1 : currentIndex - 1, 0);
      const nextRun = filtered[nextIndex];
      if (!nextRun || nextRun.id === selectedId) return;
      handleSelectRun(nextRun.id);
      window.requestAnimationFrame(() => {
        const nextRow = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-run-id]") ?? [])
          .find((row) => row.dataset.runId === nextRun.id);
        nextRow?.querySelector<HTMLElement>("button")?.focus();
      });
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [filtered, handleSelectRun, selectedId]);

  return (
    <div className="h-full flex">
      <h1 className="sr-only">Runs</h1>
      <div
        // On mobile the list is hidden only when a run is open. It used to be
        // hidden whenever the filter matched nothing too, which took the search
        // box away with it — leaving no way to correct or clear the query, and
        // showing first-run onboarding to someone who simply mistyped.
        className={`${isMobile ? (selectedId ? "hidden" : "w-full") : "w-[248px]"} flex-shrink-0 flex flex-col`}
        style={{ borderRight: isMobile ? "none" : "1px solid var(--rp-ink-a06)" }}
      >
        <div className="p-3" style={{ borderBottom: "1px solid var(--rp-ink-a06)" }}>
          <div className="mb-3 flex items-center justify-between pl-10 lg:pl-0">
            <div role="status" aria-live="polite" className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full" title={wsConnected ? "Connected" : "Disconnected"}
                style={{ background: wsConnected ? C.green : C.red, opacity: wsConnected ? 0.6 : 1 }} />
              <span className="text-[10px] font-mono" style={{ color: C.fg0 }}>{wsConnected ? "connected" : "disconnected"}</span>
            </div>
            <button type="button" aria-label="Clear all runs" className="min-h-7 rounded px-1.5 text-[10px] font-medium transition hover:bg-red-700/10" style={{ color: C.fg0 }} onClick={handleClear}>
              Clear
            </button>
          </div>
          <div className="relative mb-2">
            <input
              ref={searchRef}
              aria-label="Search runs"
              className="w-full px-2 py-1.5 rounded text-[11px] font-mono outline-none"
              style={{ background: "var(--rp-ink-a04)", color: C.fg3, border: `1px solid ${search ? "var(--rp-ink-a12)" : "var(--rp-ink-a06)"}` }}
              placeholder="Search runs..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button type="button" aria-label="Clear run search" className="absolute right-1.5 top-1/2 min-h-7 -translate-y-1/2 rounded px-1 text-[10px] font-mono"
                style={{ color: C.fg0 }} onClick={() => setSearch("")}>
                esc
              </button>
            )}
          </div>
          {agentTypes.length > 1 && (
            <div className="relative mb-2">
              <select
                aria-label="Filter runs by agent"
                className="w-full appearance-none px-2 py-1.5 pr-6 rounded text-[11px] font-mono outline-none cursor-pointer"
                style={{ background: "var(--rp-ink-a04)", color: agentFilter === "all" ? C.fg1 : C.fg3, border: `1px solid ${agentFilter !== "all" ? "var(--rp-ink-a12)" : "var(--rp-ink-a06)"}` }}
                value={agentFilter}
                onChange={e => setAgentFilter(e.target.value)}
              >
                <option value="all">All agents</option>
                {agentTypes.map(name => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 pointer-events-none" style={{ color: C.fg0 }} />
            </div>
          )}
        </div>

        <div ref={listRef} className="flex-1 overflow-auto p-2 space-y-0.5 sb rp-list-scroll">
          {runsError
              ? <div role="alert" className="mt-8 px-3 text-center">
                  <div className="text-xs font-medium" style={{ color: C.fg3 }}>Couldn&rsquo;t load runs</div>
                  <div className="mt-1 text-[11px] leading-relaxed" style={{ color: C.fg1 }}>{runsError}</div>
                  <button
                    type="button"
                    className="mt-3 min-h-7 rounded-md border px-2.5 text-[11px] font-medium"
                    style={{ borderColor: C.borderLight, color: C.fg4, background: C.elevated }}
                    onClick={() => { void fetchRuns(); }}
                  >
                    Retry
                  </button>
                </div>
              : filtered.length === 0
              ? <div className="text-center text-xs mt-8" style={{ color: C.fg0 }}>
                  {search ? "No matching runs" : "No runs"}
                </div>
              : filtered.map(run => (
                  <RunListItem key={run.id} run={run}
                    selected={run.id === selectedId}
                    highlighted={run.id === hoveredSourceId}
                    faded={!!hoveredSourceId && run.id !== hoveredSourceId}
                    onClick={() => handleSelectRun(run.id)}
                  />
                ))}
        </div>
      </div>

      <div className={`${isMobile && !selectedId ? "hidden" : ""} flex-1 min-w-0 relative overflow-hidden`}>
        {(replay.state !== "idle" || replay.replayRunId) && replayOriginalId
          ? (() => {
              const origRun = runs.find(r => r.id === replayOriginalId);
              const origName = origRun ? runDisplayName(origRun) : replayOriginalId!.slice(0, 12);
              return <ReplayView
                originalRunId={replayOriginalId}
                originalName={origName}
                replayRunId={replay.replayRunId}
                error={replay.error}
                isRunning={replay.state === "running"}
                isCancelled={replay.state === "cancelled"}
                onCancel={() => replay.cancel()}
                onReplay={() => handleFork(replayOriginalId!)}
              />;
            })()
          : selectedId
              ? (() => {
                  const selectedRun = runs.find(r => r.id === selectedId);
                  const meta = selectedRun ? parseReplayMetadata(selectedRun) : null;
                  const srcRun = meta ? runs.find(r => r.id === meta.replay.sourceRunId) : null;
                  const srcName = meta ? (srcRun ? runDisplayName(srcRun) : meta.replay.sourceRunId.slice(0, 12)) : "";
                  return (
                    <div className="h-full flex flex-col">
                      {isMobile && (
                        <button
                          type="button"
                          className="flex flex-shrink-0 items-center gap-2 py-2 pl-12 pr-4 text-left text-[12px] font-medium"
                          style={{ color: C.fg3, borderBottom: `1px solid ${C.border}` }}
                          onClick={() => navigate("/runs")}
                        >
                          <ArrowLeft className="h-3.5 w-3.5" />
                          <span>Back to runs</span>
                        </button>
                      )}
                      {meta && (
                        <div className="flex-shrink-0 flex z-10" style={{ borderBottom: `1px solid ${C.border}` }}>
                          <div
                            className="flex items-center justify-between px-3 py-1.5 min-w-0"
                            style={{ background: "var(--rp-ink-a10)", width: replayCompare ? "50%" : "100%" }}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <RotateCcw style={{ width: 12, height: 12, color: C.fg1, flexShrink: 0 }} />
                              <span className="text-[12px] truncate" style={{ color: C.fg1 }}>
                                replay of{" "}
                                <button className="font-medium hover:underline transition-colors" style={{ color: C.fg3 }}
                                  onClick={() => { setReplayCompare(false); navigate(runPath(meta.replay.sourceRunId)); }}
                                  onMouseEnter={() => {
                                    const el = listRef.current?.querySelector(`[data-run-id="${meta.replay.sourceRunId}"]`);
                                    if (el) {
                                      const listRect = listRef.current!.getBoundingClientRect();
                                      const elRect = el.getBoundingClientRect();
                                      if (elRect.bottom > listRect.top && elRect.top < listRect.bottom) {
                                        setHoveredSourceId(meta.replay.sourceRunId);
                                      }
                                    }
                                  }}
                                  onMouseLeave={() => setHoveredSourceId(null)}>
                                  {srcName}
                                </button>
                                <span className="font-mono text-[10px] ml-1.5" style={{ color: C.fg0 }}>({meta.replay.sourceRunId.slice(0, 5)})</span>
                              </span>
                              {!replayCompare && !isMobile && (
                                <button
                                  className="flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded transition-colors hover:bg-[color:var(--rp-ink-wash)] flex-shrink-0"
                                  style={{ color: C.fg2, border: `1px solid var(--rp-ink-a15)` }}
                                  onClick={() => setReplayCompare(true)}>
                                  compare <ArrowRight className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          </div>

                          {replayCompare && (
                            <>
                              <div className="flex-shrink-0 w-[1px]" style={{ background: C.border }} />
                              <div
                                className="flex items-center justify-between px-3 py-1.5 min-w-0"
                                style={{ background: "var(--rp-ink-a04)", flex: 1 }}
                              >
                                <span className="text-[12px] truncate" style={{ color: C.fg1 }}>
                                  original — <span style={{ color: C.fg3 }}>{srcName}</span>
                                </span>
                                <button
                                  className="p-0.5 rounded transition-colors hover:bg-[color:var(--rp-ink-wash)] flex-shrink-0"
                                  onClick={() => setReplayCompare(false)}
                                >
                                  <X className="h-3.5 w-3.5" style={{ color: C.fg1 }} />
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                      {meta && <RunComparison baselineRunId={meta.replay.sourceRunId} candidateRunId={selectedId} />}
                      <div className="flex-1 min-h-0 flex">
                        <div className="flex-1 min-w-0 overflow-auto sb">
                          <RunDetail runId={selectedId} routeBase="/runs" onForkStarted={handleFork} />
                        </div>
                        {replayCompare && meta && (
                          <>
                            <div className="flex-shrink-0 w-[1px]" style={{ background: C.border }} />
                            <div className="flex-1 min-w-0 overflow-auto sb">
                              <RunDetail key={meta.replay.sourceRunId} runId={meta.replay.sourceRunId} />
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })()
              : runsLoaded
                ? <EmptyState onSeeDemoTraces={openDemoTrace} />
                : (
                  <div className="flex h-full items-center justify-center" role="status" aria-live="polite">
                    <span className="text-[12px]" style={{ color: C.fg1 }}>Loading runs…</span>
                  </div>
                )
        }
      </div>
    </div>
  );
}
