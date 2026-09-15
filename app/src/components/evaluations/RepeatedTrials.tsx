import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { evaluationsApi, type ExperimentSummary, type TrialAnalysis } from "../../api/evaluations";

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

export function RepeatedTrials({ experiments, onOpen }: { experiments: ExperimentSummary[]; onOpen: (id: string) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<TrialAnalysis | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { generation.current++; request.current?.abort(); }, []);
  function select(id: string) {
    generation.current++; request.current?.abort(); setBusy(false); setAnalysis(null); setError("");
    setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  }
  async function analyze() {
    const current = ++generation.current; request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(""); setAnalysis(null);
    try {
      const result = await evaluationsApi.analyzeTrials(selected, controller.signal);
      if (current === generation.current) setAnalysis(result);
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : "Could not analyze selected trials.");
    } finally { if (current === generation.current) setBusy(false); }
  }
  function download() {
    if (!analysis) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(analysis)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "repeated-trial-analysis.json"; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return <section aria-label="Repeated trial analysis" className="space-y-4 border-t border-[color:var(--rp-border)] pt-5">
    <h2 className="text-sm font-semibold">Analyze repeated trials</h2>
    <p className="text-xs text-[color:var(--rp-ink-soft)]">Select 2–20 finished experiments with the same dataset revision and evaluators. Each case must use a distinct captured run. The analysis describes your selection; it does not establish independent sampling.</p>
    <fieldset className="max-h-64 space-y-2 overflow-y-auto"><legend className="mb-2 text-xs">{selected.length} of 20 selected</legend>
      {!experiments.length && <p className="text-xs">Finished experiments will appear here.</p>}
      {experiments.map(item => <label key={item.id} className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={selected.includes(item.id)} disabled={["queued", "running"].includes(item.status) || (!selected.includes(item.id) && selected.length === 20)} onChange={() => select(item.id)} /><span className="break-all">{item.name} · r{item.datasetVersion} · {item.status}</span></label>)}
      {selected.filter(id => !experiments.some(item => item.id === id)).map(id => <label key={id} className="flex gap-2 text-xs"><input type="checkbox" checked onChange={() => select(id)} /><span className="break-all">Selected experiment outside the current list: {id}</span></label>)}
    </fieldset>
    <Button disabled={selected.length < 2 || busy} onClick={() => void analyze()}>{busy ? "Analyzing trials…" : "Analyze selected trials"}</Button>
    {error && <p role="alert" className="text-xs">{error}</p>}
    {analysis && <div aria-label="Repeated trial results" className="space-y-3 text-xs">
      <p role="status">{analysis.trials.length} selected trials · {analysis.cases.length} cases · {analysis.summary.total} case-trial outcomes</p>
      <p>Pass: {analysis.summary.pass} · Fail: {analysis.summary.fail} · Inconclusive: {analysis.summary.inconclusive}</p>
      <p>Observed pass: {percent(analysis.summary.passRate)} · Resolved coverage: {percent(analysis.summary.resolvedCoverage)}</p>
      <p>Unresolved-outcome bounds: {percent(analysis.summary.unresolvedBounds.lower)}–{percent(analysis.summary.unresolvedBounds.upper)}. This range reflects missing evidence; it is not a confidence interval.</p>
      <p>All-trial gate: {analysis.gate.pass ? "pass" : "not passing"}. {analysis.gate.reasons.join(" ")}</p>
      <ul className="space-y-2">{analysis.trials.filter(item => item.status === "cancelled" || item.executionError).map(item => <li key={item.experimentId}>{item.name}: {item.status}{item.executionError ? " · execution error recorded" : ""}</li>)}</ul>
      <Button variant="outline" onClick={download}>Download trial analysis JSON</Button>
      <ul className="space-y-3">{analysis.cases.map(item => <li key={item.caseId} className="space-y-2 border-b border-[color:var(--rp-border)] pb-3"><strong>{item.name}</strong><p>{item.counts.pass}/{item.counts.total} passed · {item.counts.fail} failed · {item.counts.inconclusive} inconclusive</p><ul className="space-y-1">{item.outcomes.map(outcome => <li key={outcome.experimentId}><button className="text-left underline underline-offset-2" onClick={() => onOpen(outcome.experimentId)}>{analysis.trials.find(trial => trial.experimentId === outcome.experimentId)?.name}: {outcome.status}</button></li>)}</ul></li>)}</ul>
      <p className="text-[color:var(--rp-ink-soft)]">{analysis.limitations.filter(text => !text.includes("confidence interval")).join(" ")}</p>
    </div>}
  </section>;
}
