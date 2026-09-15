import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Field, Select } from "../verification/PredicateEditor";
import type { Rule } from "../../api/evaluations";
import { LossyJsonNumberError, parseJsonEvidence } from "../../../../src/evaluations/json-evidence";

export const textareaClass = "min-h-20 w-full rounded-md border border-[color:var(--rp-border)] bg-[color:var(--rp-surface)] p-2 text-xs text-[color:var(--rp-ink)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring";
export interface RuleDraft { kind: Rule["kind"]; operation: string; value: string; path: string; expected: string; names: string; name: string; match: "any" | "all"; metric: Extract<Rule, { kind: "budget" }>["metric"]; max: string; provider: "openai" | "anthropic"; model: string; rubric: string; threshold: string }
export function emptyRule(): RuleDraft { return { kind: "output", operation: "equals", value: "", path: "", expected: "null", names: "", name: "", match: "all", metric: "totalTokens", max: "0", provider: "openai", model: "", rubric: "", threshold: "0.8" }; }
export function ruleDraft(rule: Rule): RuleDraft {
  const draft = emptyRule();
  switch (rule.kind) {
    case "output": return { ...draft, ...rule };
    case "json": return { ...draft, kind: rule.kind };
    case "jsonPath": return { ...draft, kind: rule.kind, path: rule.path, expected: JSON.stringify(rule.equals) };
    case "tools": return { ...draft, ...rule, names: rule.names.join("\n") };
    case "toolArgument": return { ...draft, ...rule, expected: JSON.stringify(rule.equals) };
    case "budget": return { ...draft, ...rule, max: String(rule.max) };
    case "errors": return { ...draft, ...rule, max: String(rule.max) };
    case "rubric": return { ...draft, ...rule, threshold: String(rule.threshold) };
  }
}
export function buildRule(draft: RuleDraft): Rule {
  const number = (text: string, label: string) => { const value = Number(text); if (!text.trim() || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number.`); return value; };
  const expected = () => {
    try { return parseJsonEvidence(draft.expected); }
    catch (error) { throw new Error(error instanceof LossyJsonNumberError ? error.message : "Expected JSON value is invalid."); }
  };
  switch (draft.kind) {
    case "output": if (draft.operation !== "equals" && !draft.value) throw new Error("Contains checks require nonempty expected text."); return { kind: "output", operation: draft.operation as "equals" | "contains" | "notContains", value: draft.value };
    case "json": return { kind: "json" };
    case "jsonPath": return { kind: "jsonPath", path: draft.path.trim(), equals: expected() };
    case "tools": { const names = draft.names.split("\n").map(name => name.trim()).filter(Boolean); if (!names.length) throw new Error("Enter at least one tool name."); return { kind: "tools", operation: draft.operation as "required" | "forbidden" | "sequence", names }; }
    case "toolArgument": {
      if (!draft.name.trim()) throw new Error("Enter the tool name.");
      return { kind: "toolArgument", name: draft.name.trim(), path: draft.path.trim(), equals: expected(), match: draft.match };
    }
    case "budget": return { kind: "budget", metric: draft.metric, max: number(draft.max, "Maximum") };
    case "errors": { const max = number(draft.max, "Maximum errors"); if (!Number.isInteger(max)) throw new Error("Maximum errors must be a whole number."); return { kind: "errors", max }; }
    case "rubric": { const threshold = number(draft.threshold, "Passing score"); if (threshold > 1) throw new Error("Passing score must be from 0 to 1."); if (!draft.model.trim() || !draft.rubric.trim()) throw new Error("Model and rubric are required."); return { kind: "rubric", provider: draft.provider, model: draft.model.trim(), rubric: draft.rubric, threshold }; }
  }
}
export function ruleLabel(rule: Rule): string {
  switch (rule.kind) {
    case "output": return `Output ${rule.operation === "equals" ? "equals" : rule.operation === "contains" ? "contains" : "does not contain"} ${JSON.stringify(rule.value)}`;
    case "json": return "Output is valid JSON";
    case "jsonPath": return `JSON ${rule.path || "root"} equals ${JSON.stringify(rule.equals)}`;
    case "tools": return `${rule.operation === "sequence" ? "Ordered tools" : rule.operation === "required" ? "Required tools" : "Forbidden tools"}: ${rule.names.join(", ")}`;
    case "toolArgument": return `${rule.match === "all" ? "Every" : "At least one"} ${rule.name} call: argument ${rule.path || "root"} equals ${JSON.stringify(rule.equals)}`;
    case "budget": return `${({ inputTokens: "Input tokens", outputTokens: "Output tokens", totalTokens: "Total tokens", durationMs: "Duration (ms)", costUsd: "Reported cost (USD)", toolCalls: "Recorded tool calls" })[rule.metric]} ≤ ${rule.max}`;
    case "errors": return `Recorded error spans ≤ ${rule.max}`;
    case "rubric": return `${rule.provider} / ${rule.model}: score ≥ ${rule.threshold}`;
  }
}
export function RuleEditor({ draft, onChange, index, onRemove }: { draft: RuleDraft; onChange: (draft: RuleDraft) => void; index: number; onRemove?: () => void }) {
  const change = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => onChange({ ...draft, [key]: value });
  return <fieldset className="space-y-3 border-t border-[color:var(--rp-border)] pt-3" aria-label={`Rule ${index + 1}`}>
    <div className="flex items-center justify-between"><span className="text-xs font-medium">Rule {index + 1}</span>{onRemove && <Button variant="ghost" size="sm" onClick={onRemove}>Remove rule {index + 1}</Button>}</div>
    <Field label="Rule type"><Select value={draft.kind} onChange={event => onChange({ ...draft, kind: event.target.value as Rule["kind"], operation: event.target.value === "tools" ? "required" : "equals" })}><option value="output">Output text</option><option value="json">Valid JSON</option><option value="jsonPath">JSON value</option><option value="tools">Tool calls</option><option value="toolArgument">Tool argument</option><option value="budget">Usage budget</option><option value="errors">Recorded errors</option><option value="rubric">Model rubric</option></Select></Field>
    {draft.kind === "output" && <><Field label="Text condition"><Select value={draft.operation} onChange={event => change("operation", event.target.value)}><option value="equals">Equals</option><option value="contains">Contains</option><option value="notContains">Does not contain</option></Select></Field><Field label="Expected text" hint="An empty Equals expectation checks an explicitly empty response."><textarea className={textareaClass} maxLength={4096} value={draft.value} onChange={event => change("value", event.target.value)} /></Field></>}
    {draft.kind === "json" && <p className="text-xs text-[color:var(--rp-ink-soft)]">The selected response must parse as JSON. Missing or incomplete output is inconclusive.</p>}
    {draft.kind === "toolArgument" && <><Field label="Tool name"><Input value={draft.name} maxLength={128} onChange={event => change("name", event.target.value)} placeholder="submit_order" /></Field><Field label="Matching calls" hint="Checks captured input, including calls ending in an error. No matching calls fail; missing evidence may be inconclusive."><Select value={draft.match} onChange={event => change("match", event.target.value as RuleDraft["match"])}><option value="all">Every call</option><option value="any">At least one call</option></Select></Field></>}
    {(draft.kind === "jsonPath" || draft.kind === "toolArgument") && <><Field label="JSON property path" hint="Own-property names separated by dots. Leave empty to compare the entire JSON value."><Input value={draft.path} maxLength={1024} onChange={event => change("path", event.target.value)} placeholder="order.status" /></Field><Field label="Expected JSON value" hint='Use a JSON value, for example "paid", 3, true, or {"ok":true}.'><textarea className={textareaClass} maxLength={4096} value={draft.expected} onChange={event => change("expected", event.target.value)} /></Field></>}
    {draft.kind === "tools" && <><Field label="Tool condition"><Select value={draft.operation} onChange={event => change("operation", event.target.value)}><option value="required">Required</option><option value="forbidden">Forbidden</option><option value="sequence">Ordered subsequence</option></Select></Field><Field label="Tool names" hint="One name per line. Sequence preserves repeated names and checks captured non-overlapping call order."><textarea className={textareaClass} value={draft.names} onChange={event => change("names", event.target.value)} /></Field></>}
    {draft.kind === "budget" && <Field label="Budget metric"><Select value={draft.metric} onChange={event => change("metric", event.target.value as RuleDraft["metric"])}><option value="inputTokens">Input tokens</option><option value="outputTokens">Output tokens</option><option value="totalTokens">Total tokens</option><option value="durationMs">Duration (ms)</option><option value="costUsd">Reported cost (USD)</option><option value="toolCalls">Recorded tool calls</option></Select></Field>}
    {(draft.kind === "budget" || draft.kind === "errors") && <Field label={draft.kind === "errors" ? "Maximum errors" : "Maximum"} hint="Unavailable measurements remain inconclusive, including unreported cost."><Input type="number" min={0} step="any" value={draft.max} onChange={event => change("max", event.target.value)} /></Field>}
    {draft.kind === "rubric" && <><Field label="Judge provider"><Select value={draft.provider} onChange={event => change("provider", event.target.value as RuleDraft["provider"])}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></Select></Field><Field label="Judge model"><Input value={draft.model} onChange={event => change("model", event.target.value)} placeholder="Exact model ID" maxLength={128} /></Field><Field label="Rubric"><textarea className={textareaClass} value={draft.rubric} onChange={event => change("rubric", event.target.value)} maxLength={2000} /></Field><Field label="Passing score" hint="A model judgment is advisory; code checks and human review remain separate."><Input type="number" min={0} max={1} step="0.05" value={draft.threshold} onChange={event => change("threshold", event.target.value)} /></Field></>}
  </fieldset>;
}
