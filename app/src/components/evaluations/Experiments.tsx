import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Field, Select } from "../verification/PredicateEditor";
import { ResponseSpanSelect, SnapshotPreview, Verdict, measurement } from "./SnapshotPreview";
import { textareaClass, ruleLabel } from "./RuleEditor";
import { evaluationsApi, type DatasetRevision, type Experiment, type Snapshot, type Comparison, type ExperimentSummary } from "../../api/evaluations";
import { useRuns } from "../../hooks/use-runs";
import { runDisplayName } from "../../utils/helpers";

function evidenceValue(value: unknown): string { if (value === null || value === undefined) return "Unavailable"; if (typeof value === "string") return value === "" ? "(Empty text)" : value; return JSON.stringify(value); }
export function StartExperiment({ revision, onStarted }: { revision: DatasetRevision; onStarted: (experiment: Experiment) => void }) {
  const runs = useRuns();
  const [name, setName] = useState("");
  const [assignments, setAssignments] = useState<Record<string, { runId: string; outputSpanId: string }>>({});
  const [preview, setPreview] = useState<{ caseId: string; snapshot: Snapshot } | null>(null);
  const [allowModelJudges, setAllowModelJudges] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hasRubric = revision.cases.some(item => item.rules.some(rule => rule.kind === "rubric"));
  async function perform(work: () => Promise<void>) { if (busy) return; setBusy(true); setError(""); try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start experiment."); } finally { setBusy(false); } }
  return <section aria-label="Start experiment" className="space-y-4 border-t border-[color:var(--rp-border)] pt-5">
    <h2 className="text-sm font-semibold">Evaluate captured candidates</h2>
    <p className="text-xs leading-relaxed text-[color:var(--rp-ink-soft)]">Assign every case in revision {revision.version}. Candidate runs are frozen at start. Their captured input must match the reference input; selecting a run does not replay the agent.</p>
    {error && <p role="alert" className="text-xs text-[color:var(--rp-danger)]">{error}</p>}
    {!revision.cases.length && <p className="text-xs text-[color:var(--rp-ink-soft)]">Save at least one case before starting an experiment.</p>}
    <fieldset className="space-y-4" disabled={busy}>
      <Field label="Experiment name"><Input value={name} onChange={event => setName(event.target.value)} maxLength={128} placeholder="Baseline checkout" /></Field>
      {revision.cases.map(item => { const assignment = assignments[item.id] ?? { runId: "", outputSpanId: "" }; return <div key={item.id} className="space-y-3 rounded-md border border-[color:var(--rp-border)] p-3"><h3 className="text-xs font-semibold">{item.name}</h3><Field label={`Candidate run for ${item.name}`}><Select value={assignment.runId} onChange={event => { setAssignments(previous => ({ ...previous, [item.id]: { runId: event.target.value, outputSpanId: "" } })); setPreview(null); }}><option value="">Choose a captured run</option>{runs.data?.map(run => <option key={run.id} value={run.id}>{runDisplayName(run)}</option>)}</Select></Field>{assignment.runId && <><ResponseSpanSelect runId={assignment.runId} value={assignment.outputSpanId} label={`Response span for ${item.name}`} onChange={value => { setAssignments(previous => ({ ...previous, [item.id]: { ...assignment, outputSpanId: value } })); setPreview(null); }} /><Button variant="ghost" size="sm" aria-label={`Preview candidate for ${item.name}`} onClick={() => void perform(async () => setPreview({ caseId: item.id, snapshot: await evaluationsApi.snapshot(assignment.runId, assignment.outputSpanId || undefined) }))}>Preview candidate</Button></>}{preview?.caseId === item.id && <SnapshotPreview snapshot={preview.snapshot} title="Candidate snapshot" />}</div>; })}
      {hasRubric && <label className="flex items-start gap-2 text-xs leading-relaxed"><input type="checkbox" className="mt-0.5" checked={allowModelJudges} onChange={event => setAllowModelJudges(event.target.checked)} /><span>Allow model judges to send selected trace data to the chosen providers<span className="mt-1 block text-[color:var(--rp-ink-soft)]">This experiment includes external OpenAI or Anthropic calls using configured credentials. Model scores are advisory. This permission applies to this start only.</span></span></label>}
      <Button disabled={!name.trim() || !revision.cases.length || revision.cases.some(item => !assignments[item.id]?.runId) || (hasRubric && !allowModelJudges)} onClick={() => void perform(async () => { const consent = allowModelJudges; setAllowModelJudges(false); const started = await evaluationsApi.start({ datasetId: revision.datasetId, version: revision.version, name: name.trim(), assignments: revision.cases.map(item => ({ caseId: item.id, runId: assignments[item.id].runId, ...(assignments[item.id].outputSpanId ? { outputSpanId: assignments[item.id].outputSpanId } : {}) })), ...(hasRubric ? { allowModelJudges: consent } : {}) }); onStarted(started); })}>Start experiment</Button>
    </fieldset>
    {busy && <p role="status" className="text-xs">Preparing frozen evaluation data…</p>}
  </section>;
}

export function ExperimentResults({ experimentId }: { experimentId: string }) {
  const experiment = useQuery({ queryKey: ["evaluations", "experiment", experimentId], queryFn: () => evaluationsApi.experiment(experimentId), refetchInterval: query => !query.state.data || ["queued", "running"].includes(query.state.data.status) ? 1000 : false });
  const reviews = useQuery({ queryKey: ["evaluations", "reviews", experimentId], queryFn: () => evaluationsApi.reviews(experimentId) });
  const [caseId, setCaseId] = useState("");
  const [rating, setRating] = useState<"pass" | "fail">("pass");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function perform(work: () => Promise<void>) { setBusy(true); setError(""); try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update experiment."); } finally { setBusy(false); } }
  if (experiment.isLoading) return <p role="status" className="text-xs">Loading experiment results…</p>;
  if (experiment.error) return <p role="alert" className="text-xs text-[color:var(--rp-danger)]">{experiment.error.message}</p>;
  const data = experiment.data;
  if (!data) return null;
  const active = data.status === "queued" || data.status === "running";
  const orderedReviews = [...(reviews.data ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  return <section aria-label="Experiment results" className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-semibold">{data.name}</h2><div className="flex items-center gap-3"><span role="status" className="text-xs capitalize">{data.status}</span><Verdict status={data.verdict} /></div></div>
    <p className="text-xs text-[color:var(--rp-ink-soft)]">{data.datasetName} · revision {data.datasetVersion} · {data.summary.pass} / {data.summary.total} cases passed ({measurement(data.summary.passRate * 100, "%")}). {data.summary.fail} failed; {data.summary.inconclusive} inconclusive. All assigned cases count toward the pass rate.</p>
    {(error || data.error) && <p role="alert" className="text-xs text-[color:var(--rp-danger)]">{error || data.error}</p>}
    {notice && <p role="status" className="text-xs">{notice}</p>}
    <div className="flex flex-wrap gap-2">
      {(["json", "junit"] as const).map(format => <Button key={format} size="sm" variant="outline" disabled={busy} onClick={() => void perform(async () => {
        const blob = await evaluationsApi.report(data.id, format);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = `evaluation-${data.id}.${format === "junit" ? "junit.xml" : "json"}`; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice("Report downloaded. Failed, incomplete and inconclusive results do not pass the quality gate.");
      })}>Download {format === "junit" ? "JUnit" : "JSON"} report</Button>)}
    </div>
    <p className="text-xs text-[color:var(--rp-ink-soft)]">Reports include case verdicts and a strict quality gate. Captured prompts, responses and model explanations stay in the local workspace.</p>
    {active && <Button variant="outline" disabled={busy} onClick={() => void perform(async () => { await evaluationsApi.cancel(data.id); await experiment.refetch(); setNotice("Cancellation requested. Finished checks remain; unfinished checks are inconclusive."); })}>Cancel experiment</Button>}
    {data.results.map(result => { const latestReview = orderedReviews.find(review => review.caseId === result.caseId); return <article key={result.caseId} aria-label={`${result.caseName}: ${result.status}`} className="space-y-3 border-t border-[color:var(--rp-border)] pt-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{result.caseName}</h3><Verdict status={result.status} /></div>
      <p className="text-xs" style={{ color: result.inputMatch === "match" ? "var(--rp-ink-soft)" : "var(--rp-warning)" }}>{result.inputMatch === "match" ? "Candidate input matches the frozen reference." : result.inputMatch === "mismatch" ? "Input mismatch: candidate and reference inputs differ. No model judge was called for this case." : "Input unavailable: exact comparison is impossible. No model judge was called for this case."}</p>
      {result.inputMatch !== "match" && <details><summary className="cursor-pointer text-xs">Compare reference and candidate input</summary><dl className="mt-2 space-y-2 text-xs"><div><dt className="font-medium">Frozen reference input</dt><dd className="whitespace-pre-wrap break-words">{result.case.input ?? "Unavailable"}</dd></div><div><dt className="font-medium">Captured candidate input</dt><dd className="whitespace-pre-wrap break-words">{result.snapshot.input ?? "Unavailable"}</dd></div></dl></details>}
      <ol className="space-y-3">{result.checks.map((check, index) => <li key={index} className="space-y-2 rounded-md border border-[color:var(--rp-border)] p-3 text-xs"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{check.source === "llm" ? "Model judgment" : "Code check"} · {check.evaluatorVersion}</span><span>{check.status}</span></div><p className="break-words">{result.case.rules[index] ? ruleLabel(result.case.rules[index]) : "Retained check"}</p><p className="break-words text-[color:var(--rp-ink-soft)]">{check.reason}</p><p aria-label={check.source === "llm" ? "Model judge score" : "Code check score"}>Score: {measurement(check.score)}</p>{(check.redacted || check.truncated) && <p className="text-[color:var(--rp-warning)]">{check.redacted ? "Sensitive evidence was redacted. " : ""}{check.truncated ? "Some expected or actual evidence was omitted." : ""}</p>}<details><summary className="cursor-pointer">Expected and actual evidence</summary><dl className="mt-2 space-y-2"><div><dt className="font-medium">Expected</dt><dd className="whitespace-pre-wrap break-words">{evidenceValue(check.expected)}</dd></div><div><dt className="font-medium">Actual</dt><dd className="whitespace-pre-wrap break-words">{evidenceValue(check.actual)}</dd></div></dl></details>{check.spanIds.map((spanId, at) => <Link key={spanId} className="mr-3 inline-block underline" to={`/runs/${encodeURIComponent(result.runId)}/span/${encodeURIComponent(spanId)}`}>Evidence span {at + 1}</Link>)}</li>)}</ol>
      <details><summary className="cursor-pointer text-xs">Frozen candidate snapshot</summary><div className="mt-3"><SnapshotPreview snapshot={result.snapshot} title="Frozen candidate snapshot" /></div></details>
      <p className="text-xs text-[color:var(--rp-ink-soft)]">Latest human review: {latestReview ? `${latestReview.rating === "pass" ? "Pass" : "Fail"}${latestReview.note ? ` — ${latestReview.note}` : ""}` : "Not reviewed"}. Human review does not change the automatic verdict.</p>
    </article>; })}
    <section aria-label="Human review" className="space-y-3 border-t border-[color:var(--rp-border)] pt-4"><h3 className="text-sm font-semibold">Human review</h3><p className="text-xs text-[color:var(--rp-ink-soft)]">Add a separate assessment. Previous reviews and automatic scores remain intact.</p><Field label="Review case"><Select value={caseId} onChange={event => setCaseId(event.target.value)}><option value="">Choose a case</option>{data.results.map(result => <option key={result.caseId} value={result.caseId}>{result.caseName}</option>)}</Select></Field><Field label="Human rating"><Select value={rating} onChange={event => setRating(event.target.value as "pass" | "fail")}><option value="pass">Pass</option><option value="fail">Fail</option></Select></Field><Field label="Review note"><textarea className={textareaClass} maxLength={2000} value={note} onChange={event => setNote(event.target.value)} /></Field><Button disabled={busy || !caseId || active} onClick={() => void perform(async () => { await evaluationsApi.review(data.id, caseId, rating, note); setNote(""); await reviews.refetch(); setNotice("Human review saved separately from automatic scores."); })}>Save human review</Button>
      {reviews.error && <p role="alert" className="text-xs text-[color:var(--rp-danger)]">{reviews.error.message}</p>}
      <details><summary className="cursor-pointer text-xs">Review history ({orderedReviews.length})</summary><ol className="mt-2 space-y-2 text-xs">{orderedReviews.map(review => <li key={review.id}><strong>{data.results.find(result => result.caseId === review.caseId)?.caseName ?? "Case"}: {review.rating}</strong> · {new Date(review.createdAt).toLocaleString()}<p className="break-words">{review.note || "No note"}</p></li>)}</ol></details>
    </section>
  </section>;
}

export function CompareExperiments({ experiments }: { experiments: ExperimentSummary[] }) {
  const [baseline, setBaseline] = useState("");
  const [candidate, setCandidate] = useState("");
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const completed = experiments.filter(experiment => experiment.status === "completed");
  return <section aria-label="Experiment comparison" className="space-y-4 border-t border-[color:var(--rp-border)] pt-5"><h2 className="text-sm font-semibold">Compare experiments</h2><p className="text-xs text-[color:var(--rp-ink-soft)]">Both experiments must use the same saved dataset revision and evaluators. Unknown measurements stay unavailable.</p><div className="grid gap-3 sm:grid-cols-2"><Field label="Compare baseline"><Select value={baseline} disabled={busy} onChange={event => { setBaseline(event.target.value); setComparison(null); setError(""); }}><option value="">Choose baseline</option>{completed.map(item => <option key={item.id} value={item.id}>{item.name} · r{item.datasetVersion}</option>)}</Select></Field><Field label="Compare candidate"><Select value={candidate} disabled={busy} onChange={event => { setCandidate(event.target.value); setComparison(null); setError(""); }}><option value="">Choose candidate</option>{completed.map(item => <option key={item.id} value={item.id}>{item.name} · r{item.datasetVersion}</option>)}</Select></Field></div><Button disabled={!baseline || !candidate || baseline === candidate || busy} onClick={async () => { setBusy(true); setError(""); setComparison(null); try { setComparison(await evaluationsApi.compare(baseline, candidate)); } catch (cause) { setError(cause instanceof Error ? cause.message : "Comparison failed."); } finally { setBusy(false); } }}>Compare experiments</Button>{error && <p role="alert" className="text-xs text-[color:var(--rp-danger)]">{error}</p>}{comparison && <div aria-label="Comparison results" className="space-y-3 text-xs"><p role="status">Regressions: {comparison.summary.regressions} · Improvements: {comparison.summary.improvements} · Unchanged: {comparison.summary.unchanged} · Inconclusive: {comparison.summary.inconclusive}</p><ul className="space-y-3">{comparison.cases.map(item => <li key={item.caseId} className="space-y-1 border-b border-[color:var(--rp-border)] pb-3"><strong>{item.caseName}: {item.change}</strong><p>{item.baseline} → {item.candidate}</p><p>Candidate minus baseline: Tokens {measurement(item.deltas.totalTokens)} · Duration {measurement(item.deltas.durationMs, " ms")} · Reported cost {measurement(item.deltas.costUsd, " USD")}</p></li>)}</ul></div>}</section>;
}
