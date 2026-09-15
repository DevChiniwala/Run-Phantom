import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Search, Upload, X } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { RunDetail } from "../components/RunDetail";
import { RunListItem } from "../components/RunList";
import { searchRuns, type RunSearchResult } from "../api/runs";
import { useRunPhantomMessage } from "../hooks/use-runphantom-ws";
import { C } from "../utils/colors";
import { useScrollRestoration } from "../hooks/use-scroll-restoration";
import { safeDecodeParam } from "../utils/helpers";
import { tracePath } from "../utils/navigation";
import { useIsMobile } from "../hooks/use-mobile";

const PAGE_SIZE = 50;

export function SearchPage() {
  const navigate = useNavigate();
  const { runId: routeRunId } = useParams<{ runId?: string }>();
  const selectedId = routeRunId ? safeDecodeParam(routeRunId) : null;
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const model = params.get("model") ?? "";
  const provider = params.get("provider") ?? "";
  const options = useMemo(() => ({ q: query.trim(), status, model: model.trim(), provider: provider.trim(), limit: PAGE_SIZE }), [query, status, model, provider]);
  const filterKey = JSON.stringify(options);
  const hasFilters = !!(options.q || status && status !== "all" || options.model || options.provider);
  const querySuffix = params.size ? `?${params}` : "";
  const updateFilter = useCallback((key: string, value: string) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  }, [setParams]);
  const clearFilters = () => setParams({}, { replace: true });
  const searchListRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  useScrollRestoration(searchListRef, "searchpage-list");
  const isMobile = useIsMobile();
  const [result, setResult] = useState<(RunSearchResult & { key: string }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [demoLoading, setDemoLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const busyRef = useRef(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentResult = result?.key === filterKey ? result : null;
  const runs = currentResult?.runs ?? [];

  useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    busyRef.current = true;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    const timer = setTimeout(async () => {
      try {
        const next = await searchRuns(options, controller.signal);
        if (generation !== generationRef.current || controller.signal.aborted) return;
        setResult({ ...next, key: filterKey });
      } catch (cause) {
        if (generation !== generationRef.current || controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Search could not be completed.");
      } finally {
        if (generation === generationRef.current && !controller.signal.aborted) {
          busyRef.current = false;
          setLoading(false);
        }
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
      requestRef.current?.abort();
    };
  }, [options, filterKey, refresh]);

  const loadMore = async () => {
    if (!currentResult?.nextCursor || busyRef.current) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    busyRef.current = true;
    setLoadingMore(true);
    setError(null);
    try {
      const next = await searchRuns({ ...options, cursor: currentResult.nextCursor }, controller.signal);
      if (generation !== generationRef.current || controller.signal.aborted) return;
      setResult((previous) => {
        if (!previous || previous.key !== filterKey) return previous;
        const seen = new Set(previous.runs.map((run) => run.id));
        return { ...next, key: filterKey, runs: [...previous.runs, ...next.runs.filter((run) => !seen.has(run.id))] };
      });
    } catch (cause) {
      if (generation !== generationRef.current || controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "More results could not be loaded.");
    } finally {
      if (generation === generationRef.current && !controller.signal.aborted) {
        busyRef.current = false;
        setLoadingMore(false);
      }
    }
  };

  // Coalesce ingest bursts and let the current search finish before refreshing.
  const queueRefresh = useCallback(() => {
    if (refreshTimerRef.current) return;
    const refreshWhenIdle = () => {
      if (busyRef.current) {
        refreshTimerRef.current = setTimeout(refreshWhenIdle, 500);
        return;
      }
      refreshTimerRef.current = null;
      setRefresh((value) => value + 1);
    };
    refreshTimerRef.current = setTimeout(refreshWhenIdle, 500);
  }, []);
  useRunPhantomMessage<{ event?: string }>((message) => {
    if (["spans", "live", "clear"].includes(message.event ?? "")) queueRefresh();
  });
  useEffect(() => {
    window.addEventListener("runphantom:run-removed", queueRefresh);
    return () => {
      window.removeEventListener("runphantom:run-removed", queueRefresh);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [queueRefresh]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const editing = event.target instanceof HTMLElement && (event.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName));
      if (event.key === "/" && !editing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape" && query) {
        updateFilter("q", "");
        searchRef.current?.blur();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [query, updateFilter]);

  useEffect(() => {
    if (!currentResult?.runs.length || loading || selectedId || isMobile) return;
    navigate(`${tracePath("/search", currentResult.runs[0].id)}${querySuffix}`, { replace: true });
  }, [currentResult, loading, isMobile, navigate, selectedId, querySuffix]);

  const loadDemoTraces = async () => {
    setDemoLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/demo-traces/replay", { method: "POST" });
      if (!response.ok) throw new Error(`Could not load demo traces (${response.status})`);
      const body = await response.json() as { runIds?: string[] };
      setRefresh((value) => value + 1);
      if (body.runIds?.[0]) navigate(`${tracePath("/search", body.runIds[0])}${querySuffix}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load demo traces.");
    } finally {
      setDemoLoading(false);
    }
  };
  const importTrace = async (file: File) => {
    setImportError(null);
    setImporting(true);
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("Choose a trace file smaller than 10 MiB.");
      const payload: unknown = JSON.parse(await file.text());
      const response = await fetch("/api/import-run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json() as { runId?: string; error?: string };
      if (!response.ok || !body.runId) throw new Error(body.error ?? `Could not import trace (${response.status})`);
      setRefresh((value) => value + 1);
      navigate(`${tracePath("/search", body.runId)}${querySuffix}`);
    } catch (cause) {
      setImportError(cause instanceof SyntaxError ? "This file is not valid JSON." : cause instanceof Error ? cause.message : "Could not import trace.");
    } finally {
      setImporting(false);
      if (importRef.current) importRef.current.value = "";
    }
  };
  const controlStyle = { background: C.surface, color: C.fg4, borderColor: C.border };
  const controlClass = "w-full min-w-0 rounded-lg border px-2.5 py-2 text-[12px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--rp-accent)]";

  return (
    <div className="flex h-full">
      <div
        className={`${isMobile ? (selectedId ? "hidden" : "w-full") : "w-[280px]"} min-h-0 flex-shrink-0 flex flex-col`}
        style={{ borderRight: isMobile ? "none" : `1px solid ${C.border}` }}
      >
        <div className="px-4 py-4" style={{ borderBottom: `1px solid ${C.border}` }}>
          <div className="flex items-center justify-between gap-3 pl-10 lg:pl-0">
            <div>
              <h1 className="text-[11px] uppercase tracking-[0.18em]" style={{ color: C.fg0 }}>Local Search</h1>
              <div className="mt-1 text-[14px] font-medium" style={{ color: C.fg4 }}>Search captured runs</div>
            </div>
            <div aria-label={`${runs.length}${currentResult?.hasMore ? " or more" : ""} results loaded`} className="rounded-full border px-2 py-1 text-[10px] font-mono" style={{ background: C.surface, color: C.fg1, borderColor: C.border }}>
              {runs.length}{currentResult?.hasMore ? "+" : ""}
            </div>
          </div>
          <div className="relative mt-4">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2" style={{ color: C.fg0 }} />
            <input
              ref={searchRef}
              aria-label="Search captured runs"
              aria-describedby="search-scope"
              maxLength={256}
              value={query}
              onChange={(event) => updateFilter("q", event.target.value)}
              placeholder="Search by title, event, user, conversation, or id"
              className={`${controlClass} pl-9 pr-9`}
              style={{ ...controlStyle, borderColor: query ? C.selectedBorder : C.border }}
            />
            {query && <button type="button" className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full hover:bg-[color:var(--rp-ink-wash)]" onClick={() => updateFilter("q", "")} aria-label="Clear search">
              <X className="h-3.5 w-3.5" style={{ color: C.fg1 }} />
            </button>}
          </div>
          <p id="search-scope" className="mt-2 text-[11px] leading-5" style={{ color: C.fg1 }}>Search all local runs, captured inputs, outputs, and tool names.</p>
          <input ref={importRef} type="file" accept=".json,application/json" aria-label="Import trace file" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importTrace(file); }} />
          <button type="button" disabled={importing} onClick={() => importRef.current?.click()} className="mt-2 flex items-center gap-1.5 text-[11px] disabled:opacity-60" style={{ color: C.fg3 }}><Upload className="h-3.5 w-3.5" />{importing ? "Importing trace…" : "Import trace"}</button>
          {importError && <div role="alert" className="mt-2 text-[11px] leading-5" style={{ color: C.fg3 }}><strong>Import failed.</strong> {importError}</div>}
          <div className="mt-3 space-y-2">
            <label className="block text-[11px]" style={{ color: C.fg2 }}>
              Status
              <select value={status} onChange={(event) => updateFilter("status", event.target.value)} className={`${controlClass} mt-1`} style={controlStyle}>
                <option value="">All statuses</option>
                <option value="running">Running</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block min-w-0 text-[11px]" style={{ color: C.fg2 }}>
                Model
                <input value={model} onChange={(event) => updateFilter("model", event.target.value)} maxLength={256} placeholder="Any model" className={`${controlClass} mt-1`} style={controlStyle} />
              </label>
              <label className="block min-w-0 text-[11px]" style={{ color: C.fg2 }}>
                Provider
                <input value={provider} onChange={(event) => updateFilter("provider", event.target.value)} maxLength={256} placeholder="Any provider" className={`${controlClass} mt-1`} style={controlStyle} />
              </label>
            </div>
            <p className="text-[10px] leading-4" style={{ color: C.fg1 }}>Model and provider match exact names.</p>
            {hasFilters && <button type="button" onClick={clearFilters} className="text-[11px] underline underline-offset-4" style={{ color: C.fg3 }}>Clear all filters</button>}
          </div>
        </div>
        <div ref={searchListRef} aria-label="Search results" aria-busy={loading || loadingMore} className="flex-1 overflow-auto px-3 py-3 space-y-1.5 rp-list-scroll">
          <div role="status" className="text-[11px] leading-5" style={{ color: C.fg1 }}>
            {loading ? "Searching local traces…" : currentResult && !error ? `${runs.length} ${runs.length === 1 ? "run" : "runs"} loaded${currentResult.hasMore ? "; more available" : ""}` : ""}
          </div>
          {error && <div role="alert" className="rounded-xl border px-3 py-3" style={controlStyle}>
            <p className="text-[13px] font-medium">Search unavailable</p>
            <p className="mt-1 break-words text-[11px] leading-5" style={{ color: C.fg2 }}>{error}</p>
            <button type="button" className="mt-2 text-[12px] underline underline-offset-4" onClick={() => setRefresh((value) => value + 1)}>Retry search</button>
          </div>}
          {!loading && !error && currentResult && runs.length === 0 && <div className="rounded-2xl border px-4 py-5 text-center" style={{ borderColor: C.border, background: C.surface }}>
            <div className="text-[13px] font-medium" style={{ color: C.fg3 }}>{hasFilters ? "No matching runs" : "No captured runs yet"}</div>
            <p className="mt-2 text-[11px] leading-5" style={{ color: C.fg1 }}>{hasFilters ? "Try a shorter phrase or clear the filters to browse all captured runs." : "Capture a local agent run or load demo traces to start searching."}</p>
            {!hasFilters && <button type="button" disabled={demoLoading} onClick={() => void loadDemoTraces()} className="mt-3 text-[12px] underline underline-offset-4 disabled:opacity-60" style={{ color: C.fg3 }}>{demoLoading ? "Loading demo traces…" : "Load demo traces"}</button>}
          </div>}
          {runs.map((run) => <RunListItem key={run.id} run={run} selected={selectedId === run.id} onClick={() => navigate(`${tracePath("/search", run.id)}${querySuffix}`)} />)}
          {currentResult?.hasMore && <button type="button" onClick={() => void loadMore()} disabled={loading || loadingMore} className="w-full rounded-lg border px-3 py-2 text-[12px] disabled:opacity-60" style={controlStyle}>{loadingMore ? "Loading more…" : "Load more runs"}</button>}
        </div>
      </div>
      <div className={`${isMobile && !selectedId ? "hidden" : ""} flex-1 min-w-0`}>
        {selectedId ? <div className="flex h-full flex-col">
          {isMobile && <button type="button" className="flex flex-shrink-0 items-center gap-2 py-2 pl-12 pr-4 text-left text-[12px] font-medium" style={{ color: C.fg3, borderBottom: `1px solid ${C.border}` }} onClick={() => navigate(`/search${querySuffix}`)}>
            <ArrowLeft className="h-3.5 w-3.5" /><span>Back to search</span>
          </button>}
          <div className="min-h-0 flex-1 overflow-auto"><RunDetail key={selectedId} runId={selectedId} routeBase="/search" /></div>
        </div> : <div className="flex h-full items-center justify-center px-8">
          <div className="max-w-md text-center">
            <div className="text-[18px] font-medium" style={{ color: C.fg4 }}>Search your local traces</div>
            <p className="mt-3 text-[13px] leading-6" style={{ color: C.fg1 }}>Pick a run from the left to inspect spans, conversation turns, and replay context without leaving the local workspace.</p>
          </div>
        </div>}
      </div>
    </div>
  );
}
