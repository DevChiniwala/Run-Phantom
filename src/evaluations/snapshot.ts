import { normalizeStoredSpan } from "../spans/normalize";
import type { NormalizedSpan } from "../spans/normalized";
import { outputCompletionEvidence, type OutputCompletion } from "../spans/completion";
import { redactText, sanitizeWithReport } from "../verification/serialization";
import { isSensitiveKey } from "../verification/redaction";
import { EVALUATION_LIMITS as L, SNAPSHOT_VERSION, UNAVAILABLE_EVIDENCE, type Snapshot, type SnapshotRun, type SnapshotSpan, type ToolArgumentEvidence } from "./protocol";
import { EvaluationError, parseId } from "./validation";
import { LossyJsonNumberError, parseJsonEvidence } from "./json-evidence";

export const REPORTED_COST_ALIASES = ["gen_ai.usage.cost_usd", "gen_ai.usage.cost", "runphantom.cost.usd", "llm.cost.total", "llm.usage.cost", "ai.usage.cost"] as const;
const INPUT_ALIASES = ["gen_ai.usage.input_tokens", "ai.usage.inputTokens", "gen_ai.usage.prompt_tokens", "ai.usage.promptTokens", "ai.usage.prompt_tokens", "llm.token_count.prompt"];
const OUTPUT_ALIASES = ["gen_ai.usage.output_tokens", "ai.usage.outputTokens", "gen_ai.usage.completion_tokens", "ai.usage.completionTokens", "ai.usage.completion_tokens", "llm.token_count.completion"];
const TOTAL_ALIASES = ["gen_ai.usage.total_tokens", "ai.usage.totalTokens", "llm.token_count.total"];
const encoder = new TextEncoder();
function bytes(value: string): number { return encoder.encode(value).byteLength; }
function clipped(value: string, max: number): string {
  if (bytes(value) <= max) return value;
  let end = Math.min(value.length, max);
  while (end > 0 && bytes(value.slice(0, end)) > max) end = Math.floor(end * .9);
  return value.slice(0, end);
}
function secretStructure(value: unknown, depth = 0, budget = { nodes: 0 }): boolean {
  if (depth > 16 || ++budget.nodes > 5000) return true;
  if (typeof value === "string") return redactText(value) !== value || UNAVAILABLE_EVIDENCE.test(value);
  if (!value || typeof value !== "object") return false;
  return Object.keys(value).some((key) => isSensitiveKey(key) || ["__proto__", "prototype", "constructor"].includes(key)
    || redactText(key) !== key || secretStructure((value as Record<string, unknown>)[key], depth + 1, budget));
}
export function sanitizeSnapshotText(value: unknown): { value: string | null; redacted: boolean; truncated: boolean } {
  if (typeof value !== "string") return { value: null, redacted: false, truncated: false };
  if (bytes(value) > L.MAX_PAYLOAD_BYTES) return { value: null, redacted: false, truncated: true };
  let sensitive = redactText(value) !== value;
  try { sensitive ||= secretStructure(JSON.parse(value)); } catch { /* plain text is a supported payload */ }
  if (sensitive) return { value: "[REDACTED]", redacted: true, truncated: false };
  if (UNAVAILABLE_EVIDENCE.test(value)) return { value: null, redacted: /\[REDACTED\]|__REDACTED__/i.test(value), truncated: true };
  const bounded = clipped(value, L.MAX_TEXT_BYTES);
  return { value: bounded, redacted: false, truncated: bounded !== value };
}
export function sanitizeInput(value: unknown): string | null {
  const safe = sanitizeSnapshotText(value);
  return safe.redacted || safe.truncated ? null : safe.value;
}
function finite(value: unknown, integer = false): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value)) ? value : null;
}
function sum(values: Array<number | null>): number | null {
  if (!values.length || values.some((value) => value === null)) return null;
  const total = values.reduce<number>((acc, value) => acc + (value ?? 0), 0);
  return Number.isFinite(total) && total <= Number.MAX_SAFE_INTEGER ? total : null;
}
interface SpanView {
  row: SnapshotSpan; attrs: Record<string, unknown>; attrsAvailable: boolean; normalized: NormalizedSpan;
  input: string | null; output: string | null; started: number | null; ended: number | null; complete: boolean;
  outputCompletion: OutputCompletion;
  inputSource: ToolArgumentEvidence["source"];
  error: boolean; statusKnown: boolean; provider: string; model: string;
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cost: number | null;
}
function toolArguments(view: SpanView, identityAvailable: boolean): ToolArgumentEvidence {
  const unavailable = (status: ToolArgumentEvidence["status"]): ToolArgumentEvidence => ({ status, source: view.inputSource, value: null });
  if (!view.complete) return unavailable("incomplete");
  if (!identityAvailable || view.row.unavailable?.input) return unavailable("withheld");
  if (view.input === null) return unavailable(view.row.input_payload !== null ? "truncated" : "missing");
  if (typeof view.input !== "string") return unavailable("invalid");
  if (bytes(view.input) > L.MAX_TOOL_ARGUMENT_BYTES) return unavailable("truncated");
  const safe = sanitizeSnapshotText(view.input);
  if (safe.redacted) return unavailable("redacted");
  if (safe.truncated || safe.value === null) return unavailable("truncated");
  try {
    const bounded = sanitizeWithReport(parseJsonEvidence(safe.value));
    if (bounded.redacted) return unavailable("redacted");
    if (bounded.truncation) return unavailable("truncated");
    return { status: "available", source: view.inputSource, value: bounded.value };
  }
  catch (error) { return unavailable(error instanceof LossyJsonNumberError ? "truncated" : "invalid"); }
}
function first(attrs: Record<string, unknown>, keys: readonly string[], fallback?: unknown): unknown {
  for (const key of keys) if (Object.hasOwn(attrs, key)) return attrs[key];
  return fallback;
}
function textContentOnly(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (typeof value === "string") return true;
  if (Array.isArray(value)) return value.every((part) => textContentOnly(part, depth + 1));
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (Object.hasOwn(obj, "role")) return textContentOnly(obj.parts ?? obj.content, depth + 1);
  if (obj.type === "text") return typeof obj.text === "string" || typeof obj.content === "string";
  return obj.type === undefined && Object.keys(obj).every((key) => key === "text" || key === "content")
    && (typeof obj.text === "string" || typeof obj.content === "string");
}
function hasNonTextPrompt(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return false; }
  const messages: unknown = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object"
    ? (parsed as Record<string, unknown>).messages ?? (parsed as Record<string, unknown>).items : undefined;
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    if (!message || typeof message !== "object" || ["system", "developer", "assistant", "tool"].includes(message.role)
      || ["function_call", "function_call_output"].includes(message.type)) return false;
    return !textContentOnly(message.parts ?? message.content);
  });
}
function hasLossyUserInput(view: SpanView): boolean {
  if (hasNonTextPrompt(view.input)) return true;
  if (view.normalized.kind === "llm" && view.normalized.messages.some((message) => message.role === "user"
    && message.raw !== undefined && !textContentOnly(message.raw))) return true;
  for (const [key, value] of Object.entries(view.attrs)) {
    if (["ai.prompt.messages", "ai.prompt", "gen_ai.input.messages", "lk.chat_ctx", "traceloop.entity.input"].includes(key)
      && hasNonTextPrompt(value)) return true;
    if (/^gen_ai\.prompt\.\d+\.content$/.test(key)
      && !["system", "assistant", "tool"].includes(String(view.attrs[key.replace(/content$/, "role")]))) {
      let content = value;
      if (typeof content === "string") try { content = JSON.parse(content); } catch { /* ordinary text */ }
      if (!textContentOnly(content)) return true;
    }
  }
  return false;
}

/** Build one immutable evaluation view from bounded SQL rows; never fetches data or contacts a provider. */
export function snapshotRun(run: SnapshotRun, spans: SnapshotSpan[], outputSpanId?: string): Snapshot {
  parseId(run.id);
  if (spans.length > L.MAX_SPANS) throw new EvaluationError("Trace contains too many spans for evaluation", 413);
  if (outputSpanId !== undefined) parseId(outputSpanId);
  const parents = new Map<string, string | null>();
  for (const row of spans) {
    parseId(row.id); parseId(row.run_id);
    if (row.parent_span_id) parseId(row.parent_span_id);
    parents.set(row.id, row.parent_span_id || null);
  }
  // Bound every parent walk before retaining ancestry arrays or normalizing payloads.
  for (const row of spans) {
    const visited = new Set([row.id]);
    let parent = parents.get(row.id);
    while (parent && parents.has(parent) && !visited.has(parent)) {
      if (visited.size >= L.MAX_TRACE_DEPTH) throw new EvaluationError("Trace exceeds the evaluation ancestry depth limit", 413);
      visited.add(parent); parent = parents.get(parent);
    }
  }
  const warnings: string[] = [];
  const warn = (message: string) => { if (!warnings.includes(message) && warnings.length < 20) warnings.push(message.slice(0, 256)); };
  let redacted = false, truncated = false;
  const text = (value: unknown): string | null => {
    const safe = sanitizeSnapshotText(value);
    redacted ||= safe.redacted; truncated ||= safe.truncated;
    return safe.redacted || safe.truncated ? null : safe.value;
  };
  const views: SpanView[] = spans.map((row) => {
    parseId(row.id);
    if (row.run_id !== run.id) throw new EvaluationError("Span does not belong to the requested run");
    let attrs: Record<string, unknown> = {}, attrsAvailable = !row.unavailable?.attributes;
    if (row.attributes !== null) {
      if (bytes(row.attributes) > L.MAX_PAYLOAD_BYTES) attrsAvailable = false;
      else try {
        const raw: unknown = JSON.parse(row.attributes);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) attrsAvailable = false;
        else attrs = raw as Record<string, unknown>;
      } catch { attrsAvailable = false; }
    }
    const outputCompletion = outputCompletionEvidence(row.attributes, attrsAvailable);
    if (!attrsAvailable) { attrs = {}; truncated = true; warn("Some span attributes were withheld or malformed; dependent measurements are unavailable."); }
    const unavailableInput = row.unavailable?.input || row.input_payload !== null && bytes(row.input_payload) > L.MAX_PAYLOAD_BYTES;
    const unavailableOutput = row.unavailable?.output || row.output_payload !== null && bytes(row.output_payload) > L.MAX_PAYLOAD_BYTES;
    if (unavailableInput || unavailableOutput) { truncated = true; warn("Some payloads were withheld by the acquisition size limit."); }
    let normalized: NormalizedSpan = { kind: "other" };
    let adapterInput: string | undefined, adapterOutput: string | undefined;
    try {
      const match = normalizeStoredSpan({ ...row, attributes: attrsAvailable ? JSON.stringify(attrs) : null,
        input_payload: unavailableInput ? null : row.input_payload, output_payload: unavailableOutput ? null : row.output_payload });
      normalized = match.normalized; adapterInput = match.inputPayload; adapterOutput = match.outputPayload;
    } catch { warn("A span's SDK payload could not be normalized."); }
    const input = unavailableInput ? null : row.input_payload ?? adapterInput ?? (typeof attrs["runphantom.input"] === "string" ? attrs["runphantom.input"] : null);
    const inputSource: ToolArgumentEvidence["source"] = row.input_payload !== null ? "inputPayload" : adapterInput !== undefined ? "adapterInput"
      : typeof attrs["runphantom.input"] === "string" ? "runphantomInput" : null;
    const output = unavailableOutput ? null : row.output_payload ?? adapterOutput ?? (typeof attrs["runphantom.output"] === "string" ? attrs["runphantom.output"] : null);
    const started = finite(row.start_time_ms), ended = finite(row.end_time_ms);
    const complete = started !== null && ended !== null && ended >= started && ended > 0;
    const status = typeof row.status === "string" ? row.status.toUpperCase() : "";
    const error = status === "ERROR" || normalized.kind === "tool" && normalized.resultIsError;
    const usage = (aliases: readonly string[], fallback?: unknown) => attrsAvailable ? finite(first(attrs, aliases, fallback), true) : null;
    const inputTokens = usage(INPUT_ALIASES, row.input_tokens), outputTokens = usage(OUTPUT_ALIASES, row.output_tokens);
    const explicitTotal = first(attrs, TOTAL_ALIASES);
    let totalTokens = explicitTotal === undefined ? sum([inputTokens, outputTokens]) : finite(explicitTotal, true);
    if (totalTokens !== null && inputTokens !== null && outputTokens !== null && totalTokens !== inputTokens + outputTokens) {
      totalTokens = null; warn("A reported token total conflicts with its input/output counts.");
    }
    return { row, attrs, attrsAvailable, normalized, input, inputSource, output, started, ended, complete, outputCompletion, error,
      statusKnown: attrsAvailable && ["OK", "UNSET", "ERROR"].includes(status),
      provider: text(first(attrs, ["gen_ai.provider.name", "llm.provider", "ai.model.provider", "gen_ai.system", "llm.system"], row.provider)) ?? "Unavailable",
      model: text(first(attrs, ["gen_ai.response.model", "ai.response.model", "llm.response.model_name", "gen_ai.request.model", "ai.model.id", "llm.model_name", "llm.request.model_name", "llm.request.model"], row.model)) ?? "Unavailable",
      inputTokens, outputTokens, totalTokens, cost: attrsAvailable ? finite(first(attrs, REPORTED_COST_ALIASES)) : null };
  });
  const byId = new Map<string, SpanView>();
  let structureComplete = true;
  for (const view of views) { if (byId.has(view.row.id)) structureComplete = false; byId.set(view.row.id, view); }
  const roots = views.filter((view) => !view.row.parent_span_id);
  if (!roots.length) structureComplete = false;
  function ancestors(view: SpanView): SpanView[] {
    const out: SpanView[] = [], visited = new Set([view.row.id]);
    let parent = view.row.parent_span_id;
    while (parent) {
      if (visited.has(parent)) { structureComplete = false; break; }
      visited.add(parent);
      const next = byId.get(parent);
      if (!next) { structureComplete = false; break; }
      out.push(next); parent = next.row.parent_span_id;
    }
    return out;
  }
  const ancestry = new Map(views.map((view) => [view.row.id, ancestors(view)]));
  if (!structureComplete) warn("Trace ancestry is missing, duplicated, orphaned or cyclic.");
  const complete = structureComplete && views.length > 0 && views.every((view) => view.complete);
  if (!complete) warn("Captured trace evidence is incomplete; finished-run checks cannot be certified.");
  const generations = views.filter((view) => view.row.span_type === "LLM_GENERATION");
  const agentRoots = views.filter((view) => view.row.span_type === "AGENT_ROOT"
    && !ancestry.get(view.row.id)?.some((ancestor) => ancestor.row.span_type === "AGENT_ROOT" || ancestor.row.span_type === "TOOL_CALL"));
  const mainGenerations = generations.filter((view) => view.row.name !== "agent.subagent" && view.attrs["runphantom.agent.role"] !== "subagent"
    && !view.attrs["runphantom.agent.parent_id"] && !ancestry.get(view.row.id)?.some((ancestor) => ancestor.row.span_type === "TOOL_CALL"
      || ancestor.row.name === "agent.subagent" || ancestor.attrs["runphantom.agent.role"] === "subagent"
      || ancestor.row.span_type === "AGENT_ROOT" && !agentRoots.includes(ancestor)));
  const generationProvenanceKnown = generations.every((view) => view.attrsAvailable
    && ancestry.get(view.row.id)!.every((ancestor) => ancestor.attrsAvailable));

  let selected: SpanView | undefined;
  let source: Snapshot["output"]["source"] = "unavailable";
  if (outputSpanId !== undefined) {
    selected = byId.get(parseId(outputSpanId));
    if (!selected) throw new EvaluationError("Selected response span does not belong to this run");
    if (selected.output === null) throw new EvaluationError("Selected response span has no readable output payload");
    source = "selected";
  } else {
    const rootOutputs = agentRoots.filter((view) => view.complete && view.output !== null);
    if (rootOutputs.length === 1) { selected = rootOutputs[0]; source = "agentRoot"; }
    else if (rootOutputs.length > 1) warn("Multiple agent roots contain output; select the intended response span.");
    else if (generationProvenanceKnown) {
      const mainAncestors = new Set(mainGenerations.flatMap((view) => ancestry.get(view.row.id)!.map((ancestor) => ancestor.row.id)));
      const leaves = mainGenerations.filter((view) => view.complete && !mainAncestors.has(view.row.id));
      const lastEnded = [...leaves].sort((a, b) => b.ended! - a.ended!).slice(0, 2);
      const terminal = leaves.filter((view) => {
        const latestOther = lastEnded[0] === view ? lastEnded[1] : lastEnded[0];
        return !latestOther || latestOther.ended! <= view.started!;
      });
      if (terminal.length === 1 && terminal[0].output !== null) { selected = terminal[0]; source = "terminalGeneration"; }
      else warn("No unambiguous terminal main-agent response is captured; select the response span.");
    } else warn("Missing attributes prevent proving which generation belongs to the main agent; select the response span.");
  }
  const safeOutput = sanitizeSnapshotText(selected?.output);
  redacted ||= safeOutput.redacted; truncated ||= safeOutput.truncated;
  if (selected && (safeOutput.redacted || safeOutput.truncated || safeOutput.value === null)) warn("Selected response is redacted, truncated or unavailable.");
  if (selected?.outputCompletion === "unconfirmed") warn("The selected response lacks trustworthy completion evidence; its captured output remains inspectable but completion is unknown.");
  let input: string | null = null;
  const rootInputs = agentRoots.filter((view) => view.input !== null);
  if (rootInputs.length === 1) {
    if (hasNonTextPrompt(rootInputs[0].input)) warn("Captured input contains unsupported non-text content; input matching is unavailable.");
    else input = text(rootInputs[0].input);
  }
  else if (rootInputs.length > 1) warn("Multiple agent roots contain input; candidate input is ambiguous.");
  else if (generationProvenanceKnown) {
    const earliest = mainGenerations.every((view) => view.started !== null) ? Math.min(...mainGenerations.map((view) => view.started!)) : null;
    const firstGenerations = mainGenerations.filter((view) => earliest !== null && view.started === earliest);
    const firstGeneration = firstGenerations.length === 1 ? firstGenerations[0] : mainGenerations.length === 1 ? mainGenerations[0] : undefined;
    if (firstGeneration && !firstGeneration.row.unavailable?.input) {
      const normalized = firstGeneration.normalized;
      const user = normalized.kind === "llm" ? normalized.messages.filter((message) => message.role === "user").at(-1) : undefined;
      if (hasLossyUserInput(firstGeneration)) {
        warn("Captured input contains unsupported non-text content; input matching is unavailable.");
      } else input = text(user ? user.content : firstGeneration.input);
    }
  }
  if (input === null) warn("The captured candidate input is unavailable.");
  const nested = new Set(generations.filter((view) => ancestry.get(view.row.id)?.some((ancestor) => ancestor.row.span_type === "LLM_GENERATION")).flatMap((view) => [view, ...ancestry.get(view.row.id)!.filter((ancestor) => ancestor.row.span_type === "LLM_GENERATION")]));
  if (nested.size) warn("Nested generation usage may overlap; affected token/cost totals are unavailable to avoid double-counting.");
  const metric = (rows: SpanView[], key: "inputTokens" | "outputTokens" | "totalTokens" | "cost") => sum(rows.map((view) => nested.has(view) ? null : view[key]));
  const toolRows = views.filter((view) => view.row.span_type === "TOOL_CALL");
  let toolsComplete = complete;
  let argumentBytes = 0;
  const tools = toolRows.slice(0, 200).map((view) => {
    const rawName = view.normalized.kind === "tool" ? view.normalized.name : view.row.name;
    let name = view.attrsAvailable ? text(rawName) : null;
    if (name !== null && bytes(name) > L.MAX_NAME) { name = null; truncated = true; warn("A tool identity exceeded its size limit; name/order assertions are unavailable."); }
    if (name === null || !view.complete) toolsComplete = false;
    const argumentsEvidence = toolArguments(view, name !== null);
    if (argumentsEvidence.status === "available") {
      const size = bytes(JSON.stringify(argumentsEvidence.value));
      if (argumentBytes + size > L.MAX_TOOL_ARGUMENT_TOTAL_BYTES) {
        argumentsEvidence.status = "truncated"; argumentsEvidence.value = null;
      } else argumentBytes += size;
    }
    redacted ||= argumentsEvidence.status === "redacted";
    truncated ||= argumentsEvidence.status === "truncated" || argumentsEvidence.status === "withheld";
    if (argumentsEvidence.status !== "available") warn("Some captured tool arguments are unavailable; argument checks may be inconclusive.");
    return { spanId: view.row.id, name: name ?? "Unavailable", startedAt: view.started, endedAt: view.ended, error: view.error, arguments: argumentsEvidence };
  }).sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));
  if (tools.length !== toolRows.length) { toolsComplete = false; truncated = true; warn("Tool evidence list was bounded; name/order assertions are unavailable."); }
  const groups = new Map<string, SpanView[]>();
  for (const view of generations) {
    const key = JSON.stringify([view.provider, view.model]);
    const group = groups.get(key) ?? []; group.push(view); groups.set(key, group);
  }
  const models = [...groups.values()].slice(0, 100).map((group) => ({ provider: clipped(group[0].provider, L.MAX_NAME), model: clipped(group[0].model, L.MAX_NAME),
    requests: group.length, errorSpans: group.every((view) => view.statusKnown) ? group.filter((view) => view.error).length : null,
    inputTokens: metric(group, "inputTokens"), outputTokens: metric(group, "outputTokens"), costUsd: metric(group, "cost") }));
  if (groups.size > models.length) { truncated = true; warn("Provider/model evidence list was bounded."); }
  const snapshot: Snapshot = {
    version: SNAPSHOT_VERSION, runId: run.id, runName: clipped(text(run.display_name ?? run.event_name ?? run.name ?? run.id) ?? "Unavailable", L.MAX_NAME), capturedAt: Date.now(),
    complete, warnings, input, output: { value: safeOutput.value, spanId: selected?.row.id ?? null, source,
      complete: complete && !!selected?.complete && selected.outputCompletion !== "unconfirmed" && safeOutput.value !== null && !safeOutput.redacted && !safeOutput.truncated },
    tools, toolsComplete, metrics: { inputTokens: metric(generations, "inputTokens"), outputTokens: metric(generations, "outputTokens"), totalTokens: metric(generations, "totalTokens"),
      durationMs: complete ? Math.max(...views.map((view) => view.ended!)) - Math.min(...views.map((view) => view.started!)) : null,
      costUsd: metric(generations, "cost"), toolCalls: toolRows.length,
      errorSpans: views.every((view) => view.statusKnown) ? views.filter((view) => view.error).length : null },
    models, redacted, truncated,
  };
  // Absent argument evidence stays unavailable; preserve established identity/timing evidence first.
  for (let i = snapshot.tools.length - 1; i >= 0 && bytes(JSON.stringify(snapshot)) > L.MAX_SNAPSHOT; i--) {
    delete snapshot.tools[i].arguments;
    snapshot.truncated = true;
    warn("Tool argument evidence was shortened to the snapshot storage limit.");
  }
  while (bytes(JSON.stringify(snapshot)) > L.MAX_SNAPSHOT && (snapshot.tools.length || snapshot.models.length)) {
    snapshot.truncated = true;
    if (snapshot.tools.length) { snapshot.tools.pop(); snapshot.toolsComplete = false; }
    else snapshot.models.pop();
    warn("Snapshot evidence was shortened to its storage limit; independent numeric measurements remain intact.");
  }
  if (bytes(JSON.stringify(snapshot)) > L.MAX_SNAPSHOT) throw new EvaluationError("Snapshot exceeds its storage limit", 413);
  return snapshot;
}
