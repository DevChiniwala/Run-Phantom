import { useEffect, useId, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { apiJson } from "../api/request";
import { C } from "../utils/colors";
import type { ComparisonField, ComparisonFieldName, ComparisonRow, ComparisonSpanLink, ComparisonValue, RunComparison as Comparison } from "../../../src/run-comparison-protocol";

const labels: Record<ComparisonFieldName, string> = { name: "Name", span_type: "Span kind", status: "Status", model: "Model", provider: "Provider",
  input_payload: "Input", output_payload: "Output", duration_ms: "Duration (ms)", input_tokens: "Input tokens", output_tokens: "Output tokens" };
const buttonClass = "min-h-8 rounded border px-2.5 text-xs transition-colors hover:bg-[color:var(--rp-ink-wash)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";
function Evidence({ evidence }: { evidence: ComparisonValue }) {
  if (evidence.unavailable) return <span style={{ color: C.fg1 }}>Unavailable · {evidence.unavailable}</span>;
  return <><pre className="whitespace-pre-wrap break-all text-[11px] leading-relaxed">{String(evidence.value)}</pre>
    {evidence.previewTruncated && <span className="text-[10px]" style={{ color: C.fg1 }}>Preview shortened; equality uses the complete captured field.</span>}</>;
}
function SpanLinks({ links, side }: { links: ComparisonSpanLink[]; side: "Baseline" | "Candidate" }) {
  return <div className="min-w-0 space-y-1"><span className="text-[10px] font-medium uppercase tracking-wide" style={{ color: C.fg1 }}>{side} · {links.length}</span>
    {links.length ? links.map(item => <a key={item.id} href={item.href} target="_blank" rel="noreferrer" aria-label={`Open ${side.toLowerCase()} span ${item.name} in a new tab`}
      className="block break-all text-xs underline underline-offset-2" style={{ color: C.fg3 }}>{item.name || item.id} <span className="font-mono text-[10px]" style={{ color: C.fg1 }}>({item.id}) ↗</span></a>)
      : <p className="text-xs" style={{ color: C.fg1 }}>No matched captured span</p>}</div>;
}
function FieldRow({ field }: { field: ComparisonField }) {
  return <div className="grid min-w-0 gap-2 border-t py-2 sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)]" style={{ borderColor: C.border }} data-comparison-field={field.name}>
    <div className="text-[11px]"><span className="font-medium">{labels[field.name]}</span><span className="ml-1 sm:block sm:ml-0" style={{ color: field.state === "changed" ? C.orange : C.fg1 }}>{field.state}</span>
      {field.delta !== null && field.delta !== 0 && <span className="block font-mono" style={{ color: C.fg1 }}>Δ {field.delta > 0 ? "+" : ""}{field.delta}</span>}</div>
    <div className="min-w-0"><span className="text-[10px] sm:hidden" style={{ color: C.fg1 }}>Baseline</span><Evidence evidence={field.baseline} /></div>
    <div className="min-w-0"><span className="text-[10px] sm:hidden" style={{ color: C.fg1 }}>Candidate</span><Evidence evidence={field.candidate} /></div>
  </div>;
}
function Difference({ row }: { row: ComparisonRow }) {
  const fields = row.fields.filter(item => item.state !== "same");
  return <details className="rounded border" style={{ borderColor: C.border, background: C.surface }} data-comparison-row={row.state}>
    <summary className="cursor-pointer rounded px-3 py-2 text-xs focus-visible:outline focus-visible:outline-2">
      <span className="font-medium" style={{ color: row.state === "changed" ? C.orange : row.state === "ambiguous" ? C.purple : C.fg3 }}>{row.state}</span>
      <span className="ml-2 break-all">{row.baseline[0]?.name || row.candidate[0]?.name || "Captured spans"}</span>
      {row.reordered && <span className="ml-2" style={{ color: C.fg1 }}>order changed</span>}
      {row.match && <span className="ml-2 text-[10px]" style={{ color: C.fg1 }}>{row.match}</span>}
      {row.state === "ambiguous" && <span className="ml-2" style={{ color: C.fg1 }}>{row.baseline.length} baseline · {row.candidate.length} candidate spans</span>}
    </summary>
    <div className="space-y-3 px-3 pb-3">
      {row.reason && <p className="text-xs" style={{ color: C.fg1 }}>{row.reason}</p>}
      <div className="grid gap-3 sm:grid-cols-2"><SpanLinks links={row.baseline} side="Baseline" /><SpanLinks links={row.candidate} side="Candidate" /></div>
      {fields.map(field => <FieldRow key={field.name} field={field} />)}
      {row.fields.length > 0 && <details><summary className="cursor-pointer text-[11px]" style={{ color: C.fg1 }}>All captured field comparisons</summary>
        {row.fields.filter(field => field.state === "same").map(field => <FieldRow key={field.name} field={field} />)}</details>}
    </div>
  </details>;
}

/** This is a local, read-only inspector. Team code must use its authenticated API. */
export function RunComparison({ baselineRunId, candidateRunId }: { baselineRunId: string; candidateRunId: string }) {
  const [params, setParams] = useSearchParams();
  const expanded = params.get("debugCompare") === "1";
  const rawOffset = params.get("debugOffset") ?? "0";
  const offset = /^\d{1,4}$/.test(rawOffset) && Number(rawOffset) <= 4000 ? Number(rawOffset) : 0;
  const [revision, setRevision] = useState(0);
  const [response, setResponse] = useState<{ key: string; data?: Comparison; error?: string } | null>(null);
  const panelId = useId();
  const key = JSON.stringify([baselineRunId, candidateRunId, offset, revision]);
  const current = response?.key === key ? response : null;
  const setOffset = (next: number) => setParams(previous => { const value = new URLSearchParams(previous); value.set("debugOffset", String(next)); return value; });
  useEffect(() => {
    if (!expanded) return;
    const abort = new AbortController();
    const query = new URLSearchParams({ baseline: baselineRunId, candidate: candidateRunId, offset: String(offset), limit: "25" });
    void apiJson<Comparison>(`/api/runs/compare?${query}`, { signal: abort.signal }).then(data => {
      if (!abort.signal.aborted) setResponse({ key, data });
    }).catch(error => { if (!abort.signal.aborted) setResponse({ key, error: error instanceof Error ? error.message : "Comparison could not be loaded." }); });
    return () => abort.abort();
  }, [baselineRunId, candidateRunId, offset, expanded, key]);
  return <section aria-label="Captured run comparison" className="min-h-0 flex-shrink-0 border-b" style={{ borderColor: C.border, color: C.fg2, maxHeight: expanded ? "55%" : undefined, overflow: "auto" }}>
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
      <button type="button" aria-expanded={expanded} aria-controls={panelId} className="flex min-h-8 items-center gap-1.5 rounded text-xs font-medium focus-visible:outline focus-visible:outline-2"
        onClick={() => setParams(previous => { const value = new URLSearchParams(previous); if (expanded) { value.delete("debugCompare"); value.delete("debugOffset"); } else value.set("debugCompare", "1"); return value; })}>
        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}Compare captured changes
      </button>
      {expanded && <button type="button" aria-label="Refresh comparison" className="min-h-8 min-w-8 rounded p-1 focus-visible:outline focus-visible:outline-2" onClick={() => setRevision(value => value + 1)}><RefreshCw className="size-3.5" /></button>}
    </div>
    {expanded && <div id={panelId} className="space-y-3 px-3 pb-3">
      {!current && <p role="status" className="text-xs">Comparing captured evidence…</p>}
      {current?.error && <div role="alert" className="space-y-2 text-xs"><p>Comparison unavailable. {current.error}</p>
        <button type="button" className={buttonClass} style={{ borderColor: C.border }} onClick={() => setRevision(value => value + 1)}>Retry comparison</button></div>}
      {current?.data && <>
        <div className="grid gap-2 text-xs sm:grid-cols-2">
          {(["baseline", "candidate"] as const).map(side => <a key={side} href={current.data![side].href} target="_blank" rel="noreferrer" className="min-w-0 break-all underline underline-offset-2">
            {side === "baseline" ? "Baseline" : "Candidate"}: {current.data![side].name} · {current.data![side].spanCount} spans ↗</a>)}
        </div>
        <dl className="flex flex-wrap gap-x-4 gap-y-2 text-xs" aria-label="Comparison counts">
          {(["changed", "unchanged", "added", "removed", "ambiguous", "unavailable"] as const).map(state => <div key={state} className="flex gap-1"><dt className="capitalize">{state}</dt><dd className="font-mono font-medium" data-comparison-count={state}>{current.data!.counts[state]}</dd></div>)}
        </dl>
        <p className="text-[11px]" style={{ color: C.fg1 }}>{current.data.counts.paired} paired spans · ambiguous spans: {current.data.counts.ambiguousBaselineSpans} baseline / {current.data.counts.ambiguousCandidateSpans} candidate · {current.data.counts.unavailableFields} unavailable field comparisons</p>
        <p className="text-[11px]" style={{ color: C.fg1 }}>Exact captured text comparison. Links open the original evidence in a new tab.</p>
        {current.data.warnings.map(warning => <p key={warning} className="text-[11px]" style={{ color: C.fg1 }}>{warning}</p>)}
        {current.data.rows.length ? <div className="space-y-2">{current.data.rows.map(row => <Difference key={row.id} row={row} />)}</div>
          : <p className="text-xs">No comparison rows on this page. Empty evidence cannot establish equivalence.</p>}
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <button type="button" disabled={offset === 0} className={`${buttonClass} disabled:opacity-40`} style={{ borderColor: C.border }} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous differences</button>
          <span>{current.data.rows.length ? offset + 1 : 0}–{Math.min(offset + current.data.rows.length, current.data.totalRows)} of {current.data.totalRows}</span>
          <button type="button" disabled={current.data.nextOffset === null} className={`${buttonClass} disabled:opacity-40`} style={{ borderColor: C.border }} onClick={() => { if (current.data?.nextOffset !== null && current.data?.nextOffset !== undefined) setOffset(current.data.nextOffset); }}>Next differences</button>
        </div>
      </>}
    </div>}
  </section>;
}
