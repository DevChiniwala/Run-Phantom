import { normalizeOtelId } from "./ids";
import { normalizeSpan } from "./spans/normalize";
import type { NormalizedSpan } from "./spans/normalized";

export interface ParsedSpan {
  traceId: string; spanId: string; parentSpanId?: string; name: string; spanType: string;
  status: string; inputPayload?: string; outputPayload?: string; startTimeMs: number;
  endTimeMs: number; durationMs: number; model?: string; provider?: string;
  inputTokens?: number; outputTokens?: number; attributes: Record<string, string | number | boolean>;
  eventId?: string; eventName?: string; userId?: string; convoId?: string;
  replayRunId?: string;
  /**
   * SDK-agnostic typed view of this span. Computed via the adapter dispatcher
   * at ingest time so consumers (replay engine, UI, MCP tools) read typed
   * fields without re-parsing `input_payload` strings. See `src/spans/`.
   */
  normalized: NormalizedSpan;
}

/**
 * Flattens one OTLP AnyValue.
 *
 * The proto defines seven variants, not four. Dropping arrayValue and
 * kvlistValue silently loses whole attributes that real exporters emit —
 * `gen_ai.request.stop_sequences` and OpenInference's message lists are arrays,
 * and Traceloop nests association properties as a kvlist — so those spans
 * arrived with the attribute missing rather than with a value we could not
 * type. Composite variants are JSON-encoded because the span attribute map is
 * flat by design; a consumer that wants structure re-parses the string.
 */
function anyValue(v: any): string | number | boolean | undefined {
  const decoded = decodeAnyValue(v);
  return decoded !== null && typeof decoded === "object" ? JSON.stringify(decoded) : decoded;
}

function decodeAnyValue(v: any): any {
  if (!v || typeof v !== "object") return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  // Flattening rounded int64s or nonfinite doubles would certify invented
  // numbers/nulls as captured arguments. Keep their unavailability explicit.
  if (v.intValue !== undefined) {
    const integer = Number(v.intValue);
    return Number.isSafeInteger(integer) ? integer : "[UNAVAILABLE]";
  }
  if (v.doubleValue !== undefined) {
    return typeof v.doubleValue === "number" && Number.isFinite(v.doubleValue) ? v.doubleValue : "[UNAVAILABLE]";
  }
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue !== undefined) {
    return (v.arrayValue.values ?? []).map(decodeAnyValue);
  }
  if (v.kvlistValue !== undefined) {
    const obj: Record<string, unknown> = Object.create(null);
    for (const kv of v.kvlistValue.values ?? []) {
      if (typeof kv?.key !== "string") continue;
      const inner = decodeAnyValue(kv.value);
      if (inner !== undefined) obj[kv.key] = inner;
    }
    return obj;
  }
  if (v.bytesValue !== undefined) {
    return typeof v.bytesValue === "string" ? v.bytesValue : String(v.bytesValue);
  }
  return undefined;
}

function getAttr(attrs: any[], key: string): string | number | boolean | undefined {
  const a = attrs?.find((x: any) => x.key === key);
  if (!a?.value) return undefined;
  return anyValue(a.value);
}

function collectAttrs(
  attrs: any[] | undefined,
  into: Record<string, string | number | boolean>,
): void {
  for (const a of attrs ?? []) {
    if (typeof a?.key !== "string") continue;
    const v = anyValue(a.value);
    if (v !== undefined) into[a.key] = v;
  }
}

function first(attrs: any[], ...keys: string[]): string | number | boolean | undefined {
  for (const k of keys) { const v = getAttr(attrs, k); if (v !== undefined) return v; }
  return undefined;
}

function inferSpanType(
  operationId?: string,
  traceloopKind?: string,
  hasToolName = false,
  runPhantomSpanKind?: string,
  attrs: Record<string, string | number | boolean> = {},
): "LLM_GENERATION" | "TOOL_CALL" | "AGENT_ROOT" | "TRACE" | "INTERNAL" {
  // Prefer an explicit Run Phantom role over operation-name heuristics.
  if (runPhantomSpanKind === "agent_root") return "AGENT_ROOT";
  if (runPhantomSpanKind === "trace") return "TRACE";
  if (runPhantomSpanKind === "llm_call") return "LLM_GENERATION";
  if (runPhantomSpanKind === "tool_call") return "TOOL_CALL";

  // Fall back to provider-neutral and factual third-party conventions.
  if (hasToolName) return "TOOL_CALL";
  if (traceloopKind === "tool") return "TOOL_CALL";
  if (traceloopKind === "llm") return "LLM_GENERATION";
  switch (attrs["openinference.span.kind"]) {
    case "LLM": return "LLM_GENERATION";
    case "TOOL": return "TOOL_CALL";
    case "AGENT": return "AGENT_ROOT";
    case "CHAIN": return "TRACE";
    case "EMBEDDING": case "RETRIEVER": case "RERANKER":
    case "GUARDRAIL": case "EVALUATOR": case "PROMPT": return "INTERNAL";
  }
  if (attrs["gen_ai.operation.name"] === "execute_tool") return "TOOL_CALL";
  if (attrs["gen_ai.operation.name"] === "invoke_agent") return "AGENT_ROOT";
  if (attrs["gen_ai.operation.name"] === "invoke_workflow") return "TRACE";
  if (isGenAiInferenceSpan(attrs)) return "LLM_GENERATION";
  if (typeof attrs["lk.chat_ctx"] === "string") return "LLM_GENERATION";
  if (typeof operationId === "string") {
    if (operationId === "ai.toolCall") return "TOOL_CALL";
    if (operationId === "chat" || operationId === "llm" || operationId === "generation" || operationId === "response") return "LLM_GENERATION";
    if (operationId === "ConverseCommand" || operationId === "InvokeModelCommand") return "LLM_GENERATION";
    if (operationId.includes("Stream") || operationId.includes("Generate") ||
        operationId.includes("stream") || operationId.includes("generate")) return "LLM_GENERATION";
  }
  return "INTERNAL";
}

function isGenAiInferenceSpan(attrs: Record<string, string | number | boolean>): boolean {
  const operationName = attrs["gen_ai.operation.name"];
  if (
    operationName === "chat" ||
    operationName === "text_completion" ||
    operationName === "generate_content"
  ) {
    return true;
  }

  // Legacy OpenLLMetry provider spans emitted this shape before the current
  // OTel GenAI message attributes existed. Treat chat/completion calls as LLMs,
  // but avoid broad `gen_ai.*` matching so embeddings/retrievals remain INTERNAL
  // until Run Phantom supports them explicitly.
  const requestType = attrs["llm.request.type"];
  if (requestType === "chat" || requestType === "completion") return true;

  return hasIndexedAttr(attrs, "gen_ai.prompt.") || hasIndexedAttr(attrs, "gen_ai.completion.");
}

function hasIndexedAttr(attrs: Record<string, string | number | boolean>, prefix: string): boolean {
  return Object.keys(attrs).some((key) => key.startsWith(prefix));
}

function status(code: number | string | undefined): string {
  // OTLP JSON requires numeric enums. Also accept named enums from exporters
  // using generic protobuf JSON so their errors do not silently become OK.
  if (typeof code === "string") {
    const name = code.toUpperCase();
    if (name === "STATUS_CODE_ERROR" || name === "ERROR") return "ERROR";
    if (name === "STATUS_CODE_OK" || name === "OK") return "OK";
    const numeric = Number(code);
    if (Number.isFinite(numeric)) return status(numeric);
    return "OK";
  }
  if (code === 1) return "OK";
  if (code === 2) return "ERROR";
  // OTel spec: UNSET is the default for ended spans that completed without
  // an explicit error. Instrumentation libraries are only supposed to call
  // setStatus(OK) to override an explicit ERROR — most (Vercel AI SDK,
  // Traceloop) leave successful spans at UNSET. Run Phantom only sees
  // ended spans (OTel exports on end), so coerce UNSET → OK so downstream
  // "is this run finished?" logic doesn't get stuck waiting for an explicit
  // OK that's never coming. Manual-SDK synthetic spans that legitimately
  // mean "still in flight" go through `upsertEventSpan` directly, not this
  // path, so their UNSET-during-begin signal is preserved.
  return "OK";
}

// The value was cast, not checked, so an exporter sending this attribute as a
// string wrote that string straight into a REAL column — every later duration
// sort, sum and format then operated on text.
function numericAttr(value: string | number | boolean | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function spanErrorMessage(span: any): string | undefined {
  if (typeof span.status?.message === "string" && span.status.message) {
    return span.status.message;
  }

  for (const event of span.events ?? []) {
    const attrs = event.attributes ?? [];
    const message = first(attrs, "exception.message", "message");
    if (typeof message === "string" && message) return message;
  }

  return undefined;
}

function otlpNanosToMs(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  try {
    return Number(BigInt(value as string | number | bigint) / 1_000_000n);
  } catch {
    return Number.NaN;
  }
}

/**
 * Replaces NUL with U+FFFD in stored text.
 *
 * SQLite's LENGTH() and SUBSTR() stop at the first NUL even though the value
 * round-trips intact, so a payload containing one reported only the characters
 * before it — every size hint, preview and payload_total_chars silently wrong,
 * and the span looked far smaller than it was. A NUL carries nothing a reader
 * can use, so the visible replacement character is both honest and measurable.
 */
function stripNul<T extends string | undefined>(value: T): T {
  return (typeof value === "string" && value.includes("\0")
    ? value.replace(/\0/g, "\uFFFD")
    : value) as T;
}

export function parseOtlpRequest(body: any): ParsedSpan[] {
  const spans: ParsedSpan[] = [];
  if (!body?.resourceSpans) return spans;
  for (const rs of body.resourceSpans) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const s of ss.spans ?? []) {
        const attrs = s.attributes ?? [];
        // BigInt() throws SyntaxError on anything non-numeric, so a single bad
        // timestamp from one exporter used to abort the whole batch with a 500.
        // Yield NaN instead and let the ingest validator reject that span with a
        // 400 that actually says which field was wrong.
        const startMs = otlpNanosToMs(s.startTimeUnixNano);
        const endMs = otlpNanosToMs(s.endTimeUnixNano);
        // Resource and scope attributes were discarded, so `service.name`,
        // `deployment.environment` and the instrumentation scope never reached
        // the span — the fields you need to tell two services apart in one trace.
        // Least-specific first: a span attribute of the same key still wins.
        const allAttrs: Record<string, string | number | boolean> = Object.create(null);
        collectAttrs(rs.resource?.attributes, allAttrs);
        collectAttrs(ss.scope?.attributes, allAttrs);
        if (typeof ss.scope?.name === "string" && ss.scope.name) {
          allAttrs["otel.scope.name"] = ss.scope.name;
        }
        if (typeof ss.scope?.version === "string" && ss.scope.version) {
          allAttrs["otel.scope.version"] = ss.scope.version;
        }
        collectAttrs(attrs, allAttrs);
        for (const [k, v] of Object.entries(allAttrs)) {
          if (typeof v === "string") allAttrs[k] = stripNul(v);
        }
        if (typeof s.status?.code === "number" || typeof s.status?.code === "string") {
          allAttrs["otel.status.code"] = s.status.code;
        }
        const errorMessage = spanErrorMessage(s);
        if (errorMessage) allAttrs["otel.status.message"] = errorMessage;

        const operationId = getAttr(attrs, "ai.operationId") as string | undefined;
        const traceloopKind = getAttr(attrs, "traceloop.span.kind") as string | undefined;
        const runPhantomSpanKind = getAttr(attrs, "runphantom.span.kind") as string | undefined;
        const legacyToolName = first(attrs, "ai.toolCall.name", "tool.name", "lk.function_tool.name");
        const spanType = inferSpanType(operationId, traceloopKind, typeof legacyToolName === "string" && !!legacyToolName, runPhantomSpanKind, allAttrs);
        const toolName = legacyToolName ?? (spanType === "TOOL_CALL" ? getAttr(attrs, "gen_ai.tool.name") : undefined);
        const toolCallName = typeof toolName === "string" && toolName ? toolName : undefined;

        // For tool calls, prefer the actual tool name over generic wrapper
        // span names like "ai.toolCall" or Traceloop's "foo.tool".
        let name = s.name as string;
        if (toolCallName) name = toolCallName;
        else if (spanType === "TOOL_CALL" && traceloopKind === "tool") {
          const traceloopEntityName = getAttr(attrs, "traceloop.entity.name") as string | undefined;
          name = traceloopEntityName || name.replace(/\.tool$/, "");
        }

        // Adapters know which attributes hold the canonical input/output payload
        // for their SDK and produce a typed `normalized` view in a single pass,
        // so downstream consumers don't need to coalesce or try/catch-and-guess.
        const match = normalizeSpan({
          spanName: name,
          attrs: allAttrs,
          spanType,
          operationId,
          traceloopKind,
        });

        let inputPayload = match.inputPayload;
        let outputPayload = match.outputPayload;

        // Fallback for spans no adapter recognized — e.g. internal Express
        // middleware or otel-instrumented HTTP calls — so the "raw view" tab
        // still has something to render.
        if (inputPayload === undefined && outputPayload === undefined) {
          inputPayload = first(attrs, "runphantom.input", "traceloop.entity.input", "tool.input", "input.value") as string | undefined;
          if (!match.outputUnavailable) {
            outputPayload = first(attrs, "runphantom.output", "traceloop.entity.output", "tool.output", "output.value") as string | undefined;
          }
        }

        const model = first(attrs, "gen_ai.response.model", "ai.response.model", "llm.response.model_name", "gen_ai.request.model", "ai.model.id", "llm.request.model", "llm.model_name", "llm.request.model_name") as string | undefined;
        const provider = first(attrs, "gen_ai.provider.name", "ai.model.provider", "gen_ai.system", "llm.provider", "llm.system") as string | undefined;
        const inputTokens = first(attrs, "ai.usage.inputTokens", "ai.usage.promptTokens", "ai.usage.prompt_tokens", "gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens", "llm.token_count.prompt") as number | undefined;
        const outputTokens = first(attrs, "ai.usage.outputTokens", "ai.usage.completionTokens", "ai.usage.completion_tokens", "gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens", "llm.token_count.completion") as number | undefined;

        const eventId = first(attrs, "ai.telemetry.metadata.runphantom.eventId", "runphantom.event.id", "traceloop.association.properties.event_id") as string | undefined;
        const eventName = first(attrs, "ai.telemetry.metadata.runphantom.eventName", "runphantom.event.name", "traceloop.association.properties.event_name") as string | undefined;
        const userId = first(attrs, "ai.telemetry.metadata.runphantom.userId", "runphantom.user.id", "traceloop.association.properties.user_id", "user.id") as string | undefined;
        const convoId = first(attrs, "ai.telemetry.metadata.runphantom.convoId", "runphantom.conversation.id", "traceloop.association.properties.convo_id", "gen_ai.conversation.id", "session.id") as string | undefined;
        // Replay exporters echo this stitch key so the received trace replaces
        // the placeholder created when replay began.
        let replayRunId = first(
          attrs,
          "ai.telemetry.metadata.runphantom.replayRunId",
          // Exporters that flatten nested metadata emit this spelling instead of
          // the JSON blob read below, and it was recognised by neither — so a
          // replay from such an exporter never stitched and timed out.
          "ai.telemetry.metadata.runphantom.properties.replayRunId",
          "runphantom.replay.run_id",
          "traceloop.association.properties.replayRunId",
        ) as string | undefined;
        if (!replayRunId) {
          const propsStr = getAttr(attrs, "ai.telemetry.metadata.runphantom.properties") as string | undefined;
          if (propsStr) {
            try {
              const props = JSON.parse(propsStr);
              if (props && typeof props.replayRunId === "string" && props.replayRunId) {
                replayRunId = props.replayRunId;
              }
            } catch { /* properties wasn't JSON; nothing to do */ }
          }
        }

        spans.push({
          traceId: normalizeOtelId(s.traceId, 16) ?? s.traceId,
          spanId: normalizeOtelId(s.spanId, 8) ?? s.spanId,
          parentSpanId:
            normalizeOtelId(s.parentSpanId || undefined, 8) ??
            s.parentSpanId ??
            undefined,
          name, spanType,
          status: status(s.status?.code),
          inputPayload: stripNul(inputPayload), outputPayload: stripNul(outputPayload),
          startTimeMs: startMs, endTimeMs: endMs,
          durationMs: numericAttr(getAttr(attrs, "traceloop.entity.duration_ms")) ?? (endMs - startMs),
          model, provider,
          inputTokens: typeof inputTokens === "number" ? inputTokens : undefined,
          outputTokens: typeof outputTokens === "number" ? outputTokens : undefined,
          attributes: allAttrs,
          eventId, eventName, userId, convoId, replayRunId,
          normalized: match.normalized,
        });
      }
    }
  }
  return spans;
}
