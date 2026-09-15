import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { callVerificationTool, VERIFICATION_TOOLS } from "./verification-tools";
import { callEvaluationTool, EVALUATION_TOOLS } from "./evaluation-tools";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import {
  agentAnnotationSource,
  getAgentProvider,
  parseAgentProvider,
  type AgentAnnotationSource,
} from "../agent-chat";

const TOOLS = [
  {
    name: "search_runs",
    description: "Search all local run history with literal text across run metadata and span names, inputs and outputs. Returns bounded run summaries without payloads, newest started_at first. Text matching folds ASCII case and treats other Unicode literally. Filter model/provider exactly on the same span. Follow nextCursor while hasMore; refresh after runs change. Use get_run_outline or get_span_payload to inspect evidence.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", maxLength: 256, description: "Literal substring; empty browses all runs. %, _ and quotes are literal." },
        status: { type: "string", enum: ["all", "running", "completed", "failed"] },
        model: { type: "string", maxLength: 256 },
        provider: { type: "string", maxLength: 256 },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size, default 50." },
        cursor: { type: "string", maxLength: 4096, description: "Opaque nextCursor from the preceding page." },
      },
    },
  },
  {
    name: "get_current_run",
    description: "Resolve the single run Run Phantom is focused on, plus the selected span when the UI has one. Takes no arguments. Use when the user refers to the trace, run, screen, or selected span without giving ids. Returns source, run, selected_span_id, selected_span, and size hints. This is the focused run, not search or history.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "query_traces",
    description:
      "Run one read-only SQLite SELECT over local Run Phantom trace data. CTEs are not allowed. Required: sql. Use for discovery, joins, counts, filtering, and lightweight previews before reading payload bytes. Main tables: runs(id,event_id,name,event_name,user_id,convo_id,started_at,last_updated_at,metadata), runs_with_hints(id,event_id,name,event_name,user_id,convo_id,started_at,last_updated_at,metadata,model,finished,span_count,live_event_count,payload_total_chars), spans(id,run_id,parent_span_id,name,span_type,status,input_payload,output_payload,start_time_ms,end_time_ms,duration_ms,model,provider,input_tokens,output_tokens,attributes), live_events(id,trace_id,span_id,type,content,timestamp,metadata), annotations(id,run_id,span_id,kind,note,source,created_at). Prefer runs_with_hints for discovery. Select ids, metadata, counts, lengths, and SUBSTR previews; use get_span_payload for full payloads.",
    inputSchema: {
      type: "object",
      required: ["sql"],
      properties: {
        sql: { type: "string", description: "A single SELECT statement. CTEs are not allowed." },
        limit: { type: "number", description: "Max rows returned, default 100, max 1000." },
        max_bytes: { type: "number", description: "Max serialized response bytes, default 120000, max 1000000." },
      },
    },
  },
  {
    name: "get_span_payload",
    description: "Read the actual payload content for one span. Required: span_id and target, where target must be exactly 'input' or 'output'. Use after get_run_outline, search_run, query_traces, or get_current_run identifies a span whose raw prompt/tool/result payload is needed as evidence. Defaults to the first max_chars (8000) and returns next_offset when more is available. Use jsonpath for JSON subtrees or range: [start, end] for UTF-16 character offsets.",
    inputSchema: {
      type: "object",
      required: ["span_id", "target"],
      properties: {
        span_id: { type: "string", description: "Span id returned by get_current_run, get_run_outline, search_run, get_span_context, or query_traces." },
        target: { type: "string", enum: ["input", "output"], description: "Which payload to read. Must be 'input' or 'output'." },
        jsonpath: { type: "string", description: "Optional JSONPath selecting a subtree before slicing." },
        range: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "Optional UTF-16 character range [start, end]." },
        max_chars: { type: "number", description: "Default 8000, max 32000" },
        format: { type: "string", enum: ["json", "text"] },
      },
    },
  },
  {
    name: "annotate",
    description: "Create a durable annotation saved in Run Phantom. Required: run_id and kind. kind must be 'issue', 'good', or 'note'. Include span_id for evidence on one span; omit it for a run-level verdict. note is shown in the UI.",
    inputSchema: {
      type: "object",
      required: ["run_id", "kind"],
      properties: {
        run_id: { type: "string", description: "Run id or unambiguous visible run id prefix." },
        span_id: { type: "string", description: "Optional span id for span-level evidence." },
        kind: { type: "string", enum: ["issue", "good", "note"], description: "Annotation category." },
        note: { type: "string", description: "Short explanation, typically one sentence." },
      },
    },
  },
  {
    name: "get_run_outline",
    description: "Return a structural overview for one run. Required: run_id. Includes totals, span type counts, tool call counts with representative input/output previews, first/final LLM previews, a flat span list with depth/name/type/status/tokens/previews, live-event histogram, detected sub-agents, error spans shortlist, and annotations. It intentionally does not dump full payloads. Use when you need to understand a run's shape before deciding whether search_run, query_traces, get_span_context, or get_span_payload is needed.",
    inputSchema: {
      type: "object",
      required: ["run_id"],
      properties: {
        run_id: { type: "string", description: "Run id or unambiguous visible run id prefix." },
        payload_preview_chars: { type: "number", description: "Preview chars per span. Default 80, max 400." },
      },
    },
  },
  {
    name: "ask_agent",
    description: "Ask the captured agent context to explain or debug a Run Phantom trace. This continues the recorded agent conversation when Run Phantom can reconstruct it. Use when the user explicitly wants the captured agent's perspective or a continuation. Pass run_id when available; otherwise the active run is used.",
    inputSchema: {
      type: "object",
      required: ["question"],
      properties: {
        question: { type: "string", description: "The debugging question to ask the captured agent context." },
        run_id: { type: "string", description: "Run id or visible run id prefix. Defaults to the active Run Phantom run." },
      },
    },
  },
  {
    name: "replay_run",
    description: "Replay a Run Phantom run against the registered local agent. Required: run_id. Checks health, scans replay ports, starts the stored command when needed, prefills context, sends /replay, and waits for completion.",
    inputSchema: {
      type: "object",
      required: ["run_id"],
      properties: {
        run_id: { type: "string", description: "Source run id or visible run id prefix." },
        user_message: { type: "string", description: "Optional replacement for the last user message." },
        model: { type: "string", description: "Optional model override." },
        system_prompt: { type: "string", description: "Optional system prompt override." },
        context: { type: "object", description: "Optional context overrides merged after trace prefill." },
      },
    },
  },
  {
    name: "search_run",
    description: "Search one run's span payloads, span attributes, and live events with substring or regex matching. Required: run_id and pattern. Returns matches with span_id, scope (span_input/span_output/span_attributes/live_event), character range, and a snippet with surrounding context. Use to answer whether text, ids, errors, tool names, or phrases appeared anywhere in the run without pulling full payloads. Set regex:true only for JavaScript regex patterns.",
    inputSchema: {
      type: "object",
      required: ["run_id", "pattern"],
      properties: {
        run_id: { type: "string" },
        pattern: { type: "string" },
        regex: { type: "boolean", description: "Treat pattern as a JS regex. Default false." },
        case_sensitive: { type: "boolean", description: "Default false." },
        scope: { type: "array", items: { type: "string", enum: ["span_input", "span_output", "span_attributes", "live_event"] }, description: "Default: all scopes." },
        span_type: { type: "string", enum: ["TRACE", "LLM_GENERATION", "TOOL_CALL", "AGENT_ROOT", "INTERNAL"] },
        context_chars: { type: "number", description: "Chars of context around each match. Default 80." },
        max_matches: { type: "number", description: "Default 50, max 200." },
      },
    },
  },
  {
    name: "get_span_context",
    description: "Return lightweight skeletons around one span. Required: span_id. Includes nearby siblings before and after by start time, plus the parent by default. Each skeleton has id, parent_id, name, span_type, status, start_time_ms, duration_ms, tokens, and model. Use after finding a span of interest to see immediate local context without reloading the whole run outline or payloads.",
    inputSchema: {
      type: "object",
      required: ["span_id"],
      properties: {
        span_id: { type: "string" },
        before: { type: "number", description: "Siblings before the span. Default 2." },
        after: { type: "number", description: "Siblings after the span. Default 2." },
        include_parent: { type: "boolean", description: "Default true." },
      },
    },
  },
  {
    name: "show_in_ui",
    description: "Ask the connected Run Phantom browser UI to show a run, span, or filter. Use when visible evidence helps the user follow along. Can navigate to a run, open a coarse event_name or user_id filter, and draft an annotation. This helper navigates the UI; it does not inspect traces.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Full run id or unambiguous visible prefix." },
        span_id: { type: "string", description: "Optional span id used only when drafting a note." },
        event_name: { type: "string" },
        user_id: { type: "string" },
        note: { type: "string", description: "Optional note to draft/create for the run or span." },
      },
    },
  },
] as const;

function backendUnreachableError(backendUrl: string, err?: unknown): McpError {
  const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
  return new McpError(
    ErrorCode.InternalError,
    `Run Phantom backend unreachable at ${backendUrl}${detail}. Start it with: runphantom serve`
  );
}

/**
 * Turns a backend 404 into something the caller can act on.
 *
 * Echoing the internal route ("Not found: /api/runs/active") tells an agent
 * nothing it can use — it never chose that path — and for get_current_run, whose
 * schema takes no arguments, an empty database was reported as an invalid
 * parameter.
 */
function describeNotFound(path: string): string {
  if (path.startsWith("/api/runs/active")) {
    return "No runs have been recorded yet. Start an instrumented agent so Run Phantom has a trace to report.";
  }
  const runMatch = /^\/api\/runs\/(?:detail\/)?([^/?]+)/.exec(path);
  if (runMatch) return `No run found with id "${decodeURIComponent(runMatch[1])}".`;
  const spanMatch = /^\/api\/spans\/([^/?]+)/.exec(path);
  if (spanMatch) return `No span found with id "${decodeURIComponent(spanMatch[1])}".`;
  return "The requested Run Phantom resource does not exist.";
}

async function callBackend(url: string, path: string, signal?: AbortSignal): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url + path, { signal });
  } catch (err) {
    throw backendUnreachableError(url, err);
  }
  if (res.status === 400) {
    const body = await res.json().catch(() => ({}));
    throw new McpError(ErrorCode.InvalidParams, body?.error ?? `Bad request: ${path}`);
  }
  if (res.status === 404) {
    // The route is an internal detail the caller never supplied and cannot act
    // on; for a tool that takes no arguments it also mislabels an empty database
    // as the caller's mistake.
    throw new McpError(ErrorCode.InvalidParams, describeNotFound(path));
  }
  if (!res.ok) {
    throw new McpError(
      ErrorCode.InternalError,
      `Run Phantom backend returned ${res.status} for ${path}`
    );
  }
  return res.json();
}

function textResult(body: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
}

function currentAnnotationSource(): AgentAnnotationSource {
  const explicit = process.env.RUNPHANTOM_ANNOTATION_SOURCE;
  if (explicit === "claude-code" || explicit === "codex") return explicit;
  return agentAnnotationSource(parseAgentProvider(process.env.RUNPHANTOM_AGENT_PROVIDER) ?? getAgentProvider());
}

/**
 * Strips the raw payloads out of the selected span.
 *
 * get_current_run is the orientation call an agent makes first, and it returned
 * the span row verbatim. One selected span holding a multi-MB tool result put
 * that whole payload into the agent's context before it had decided it wanted
 * it — for a 10MB result that is the context window, spent. The size hints stay
 * so the agent can decide, and get_span_payload already serves the content in
 * bounded, offset-addressable pages.
 */
const MCP_SPAN_INLINE_CHARS = 2000;

function spanForMcp(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const span = { ...(value as Record<string, unknown>) };
  for (const field of ["input_payload", "output_payload", "attributes"] as const) {
    const raw = span[field];
    if (typeof raw !== "string") continue;
    span[`${field}_chars`] = raw.length;
    if (raw.length <= MCP_SPAN_INLINE_CHARS) continue;
    span[field] = raw.slice(0, MCP_SPAN_INLINE_CHARS);
    span[`${field}_truncated`] = true;
  }
  if (span.input_payload_truncated || span.output_payload_truncated) {
    span.payload_hint =
      "Payload truncated. Call get_span_payload with this span_id and target 'input' or 'output' to page through the full content.";
  }
  return span;
}

function runForMcp(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  const runId = typeof row.run_id === "string" ? row.run_id : row.id;
  if (typeof runId !== "string") return value;
  const { id: _id, ...rest } = row;
  return { run_id: runId, ...rest };
}

/**
 * Turns a run id or an unambiguous visible prefix into a full run id.
 *
 * Several tool schemas document "run id or unambiguous visible run id prefix",
 * but nothing implemented it — a prefix produced a bare 404 with no hint that a
 * prefix was even supposed to work. Exact matches short-circuit, so this only
 * costs a run-list fetch when the caller actually passed a prefix.
 */
async function resolveRunId(backendUrl: string, runId: string): Promise<string> {
  const detail = await fetch(`${backendUrl}/api/runs/detail/${encodeURIComponent(runId)}`);
  if (detail.ok) return runId;

  let runs: Array<{ id?: string }>;
  try {
    const res = await fetch(`${backendUrl}/api/runs`);
    if (!res.ok) throw new Error(String(res.status));
    runs = await res.json() as Array<{ id?: string }>;
  } catch (err) {
    throw backendUnreachableError(backendUrl, err);
  }

  const matches = runs.map((r) => r.id).filter((id): id is string => typeof id === "string" && id.startsWith(runId));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, `No run matches id or prefix "${runId}".`);
  }
  throw new McpError(
    ErrorCode.InvalidParams,
    `Run id prefix "${runId}" is ambiguous — it matches ${matches.length} runs (${matches.slice(0, 4).join(", ")}${matches.length > 4 ? ", …" : ""}).`,
  );
}

/**
 * A non-string run_id used to be coerced to undefined, so the tool quietly acted
 * on the active run instead and reported success for a run the caller never
 * named.
 */
function requireRunId(value: unknown, optional = false): string | undefined {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new McpError(ErrorCode.InvalidParams, "run_id required");
  }
  if (typeof value !== "string" || !value) {
    throw new McpError(ErrorCode.InvalidParams, "run_id must be a non-empty string");
  }
  return value;
}

export function registerTraceReadTools(
  mcp: Server,
  backendUrl: string,
) {
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...TOOLS, ...VERIFICATION_TOOLS, ...EVALUATION_TOOLS].map((t) => ({ ...t })),
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args = {} } = req.params;
    const verificationResult = await callVerificationTool(name, args, backendUrl);
    if (verificationResult) return verificationResult;
    const evaluationResult = await callEvaluationTool(name, args, backendUrl);
    if (evaluationResult) return evaluationResult;
    switch (name) {
      case "search_runs": {
        const params = new URLSearchParams();
        for (const key of ["q", "status", "model", "provider", "cursor"] as const) {
          if (args[key] === undefined) continue;
          if (typeof args[key] !== "string") throw new McpError(ErrorCode.InvalidParams, `${key} must be a string`);
          params.set(key, args[key]);
        }
        if (args.limit !== undefined) {
          if (typeof args.limit !== "number" || !Number.isInteger(args.limit)) throw new McpError(ErrorCode.InvalidParams, "limit must be an integer from 1 to 100");
          params.set("limit", String(args.limit));
        }
        return textResult(await callBackend(backendUrl, `/api/runs/search?${params}`, extra.signal));
      }
      case "get_current_run": {
        try {
          const viewedRes = await fetch(`${backendUrl}/api/ui/viewing`);
          if (viewedRes.ok) {
            const viewed = await viewedRes.json();
            const { selected_span_id: selectedSpanId, selected_span: selectedSpan, ...run } = viewed;
            return textResult({
              source: "viewed_run",
              selected_span_id: typeof selectedSpanId === "string" ? selectedSpanId : null,
              selected_span: selectedSpan && typeof selectedSpan === "object" ? spanForMcp(selectedSpan) : null,
              run: runForMcp(run),
            });
          }
          if (viewedRes.status !== 404) {
            throw new McpError(ErrorCode.InternalError, `Run Phantom backend returned ${viewedRes.status} for /api/ui/viewing`);
          }
        } catch (err) {
          if (err instanceof McpError) throw err;
          throw backendUnreachableError(backendUrl, err);
        }

        const active = await callBackend(backendUrl, "/api/runs/active");
        return textResult({ source: "active_run", selected_span_id: null, selected_span: null, run: runForMcp(active) });
      }
      case "query_traces": {
        if (typeof args.sql !== "string" || !args.sql.trim()) {
          throw new McpError(ErrorCode.InvalidParams, "sql required");
        }
        let res: Response;
        try {
          res = await fetch(`${backendUrl}/api/traces/query`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sql: args.sql,
              limit: typeof args.limit === "number" ? args.limit : undefined,
              max_bytes: typeof args.max_bytes === "number" ? args.max_bytes : undefined,
            }),
          });
        } catch (err) {
          if (err instanceof McpError) throw err;
          throw backendUnreachableError(backendUrl, err);
        }
        if (res.status === 400) {
          const body = await res.json().catch(() => ({}));
          throw new McpError(ErrorCode.InvalidParams, body?.error ?? "Bad trace query");
        }
        if (!res.ok) {
          throw new McpError(ErrorCode.InternalError, `Run Phantom backend returned ${res.status} running trace query`);
        }
        return textResult(await res.json());
      }
      case "get_span_payload": {
        if (typeof args.span_id !== "string" || !args.span_id) {
          throw new McpError(ErrorCode.InvalidParams, "span_id required");
        }
        if (args.target !== "input" && args.target !== "output") {
          throw new McpError(ErrorCode.InvalidParams, "target must be 'input' or 'output'");
        }
        const params = new URLSearchParams({ target: args.target });
        if (typeof args.jsonpath === "string" && args.jsonpath) params.set("jsonpath", args.jsonpath);
        if (typeof args.max_chars === "number") params.set("max_chars", String(args.max_chars));
        if (typeof args.format === "string") params.set("format", args.format);
        if (Array.isArray(args.range) && args.range.length === 2) {
          params.set("range", `${args.range[0]},${args.range[1]}`);
        }
        const out = await callBackend(
          backendUrl,
          `/api/spans/${encodeURIComponent(args.span_id)}/payload?${params.toString()}`
        );
        return textResult(out);
      }
      case "annotate": {
        const kind = args.kind;
        if (kind !== "issue" && kind !== "good" && kind !== "note") {
          throw new McpError(ErrorCode.InvalidParams, "kind must be issue|good|note");
        }
        const runId = await resolveRunId(backendUrl, requireRunId(args.run_id)!);
        const spanId = typeof args.span_id === "string" && args.span_id ? args.span_id : null;
        let res: Response;
        try {
          res = await fetch(`${backendUrl}/api/annotations`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              run_id: runId,
              span_id: spanId,
              kind,
              note: typeof args.note === "string" ? args.note : null,
              source: currentAnnotationSource(),
            }),
          });
        } catch (err) {
          if (err instanceof McpError) throw err;
          throw backendUnreachableError(backendUrl, err);
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          let message = text;
          try { message = JSON.parse(text).error ?? text; } catch { /* not JSON */ }
          // A 4xx is the caller's argument being wrong, so report it as such.
          // InternalError told the agent the server had failed and invited a retry
          // of a request that can never succeed.
          throw new McpError(
            res.status >= 400 && res.status < 500 ? ErrorCode.InvalidParams : ErrorCode.InternalError,
            res.status >= 400 && res.status < 500
              ? message
              : `Run Phantom backend returned ${res.status} creating annotation: ${text}`,
          );
        }
        const created = await res.json();
        return textResult({ ok: true, annotation_id: created.id, run_id: created.run_id, span_id: created.span_id });
      }
      case "get_run_outline": {
        const outlineRunId = await resolveRunId(backendUrl, requireRunId(args.run_id)!);
        const params = new URLSearchParams();
        if (typeof args.payload_preview_chars === "number") {
          params.set("payload_preview_chars", String(args.payload_preview_chars));
        }
        const qs = params.toString();
        return textResult(await callBackend(backendUrl, `/api/runs/${encodeURIComponent(outlineRunId)}/outline${qs ? "?" + qs : ""}`));
      }
      case "ask_agent": {
        if (typeof args.question !== "string" || !args.question.trim()) {
          throw new McpError(ErrorCode.InvalidParams, "question required");
        }
        const askRunIdRaw = requireRunId(args.run_id, true);
        const askRunId = askRunIdRaw ? await resolveRunId(backendUrl, askRunIdRaw) : undefined;
        let res: Response;
        try {
          res = await fetch(`${backendUrl}/api/agents/ask`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              question: args.question,
              run_id: askRunId,
            }),
          });
        } catch (err) {
          throw backendUnreachableError(backendUrl, err);
        }
        if (res.status === 400) {
          const body = await res.json().catch(() => ({}));
          throw new McpError(ErrorCode.InvalidParams, body?.error ?? "Bad ask_agent request");
        }
        if (!res.ok && res.status !== 404) {
          throw new McpError(ErrorCode.InternalError, `Run Phantom backend returned ${res.status} asking the captured agent context`);
        }
        return textResult(await res.json());
      }
      case "replay_run": {
        if (typeof args.run_id !== "string" || !args.run_id) {
          throw new McpError(ErrorCode.InvalidParams, "run_id required");
        }
        let res: Response;
        try {
          res = await fetch(`${backendUrl}/api/replay`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              runId: args.run_id,
              userMessage: typeof args.user_message === "string" ? args.user_message : undefined,
              model: typeof args.model === "string" ? args.model : undefined,
              systemPrompt: typeof args.system_prompt === "string" ? args.system_prompt : undefined,
              contextOverrides: args.context && typeof args.context === "object" && !Array.isArray(args.context) ? args.context : undefined,
            }),
          });
        } catch (err) {
          throw backendUnreachableError(backendUrl, err);
        }
        if (res.status === 400) {
          const body = await res.json().catch(() => ({}));
          throw new McpError(ErrorCode.InvalidParams, body?.error ?? "Bad replay_run request");
        }
        if (!res.ok) {
          throw new McpError(ErrorCode.InternalError, `Run Phantom backend returned ${res.status} replaying run`);
        }
        const text = await res.text();
        const events = text
          .split(/\n\n+/)
          .map((chunk) => chunk.trim())
          .filter(Boolean)
          .map((chunk) => chunk.replace(/^data:\s*/, ""))
          .map((line) => {
            try { return JSON.parse(line); } catch { return { type: "raw", text: line }; }
          });
        const complete = [...events].reverse().find((event) => event?.type === "replay_complete");
        const started = events.find((event) => event?.type === "replay_started");
        const error = events.find((event) => event?.type === "error");
        if (error) {
          return textResult({
            ok: false,
            source_run_id: args.run_id,
            code: error.code ?? "replay_failed",
            message: error.message ?? "Replay failed.",
            setup_required: error.setupRequired === true,
            suggested_action: error.suggestedAction,
            command: error.command,
            cwd: error.cwd,
            log_path: error.logPath,
            attempted_start: error.attemptedStart,
            events,
          });
        }
        return textResult({
          ok: true,
          source_run_id: args.run_id,
          replay_run_id: complete?.replayRunId ?? started?.replayRunId ?? null,
          events,
        });
      }
      case "search_run": {
        // Resolving first turns "no such run" into an explicit error rather than
        // an empty match list, which reads identically to "searched it, found
        // nothing" and sent agents hunting for a phantom negative result.
        const searchRunId = await resolveRunId(backendUrl, requireRunId(args.run_id)!);
        if (typeof args.pattern !== "string" || !args.pattern) {
          throw new McpError(ErrorCode.InvalidParams, "pattern required");
        }
        const params = new URLSearchParams({ pattern: args.pattern });
        if (args.regex === true) params.set("regex", "true");
        if (args.case_sensitive === true) params.set("case_sensitive", "true");
        if (Array.isArray(args.scope) && args.scope.length) {
          const VALID_SCOPES = ["span_input", "span_output", "span_attributes", "live_event"];
          const bad = (args.scope as unknown[]).filter((v) => typeof v !== "string" || !VALID_SCOPES.includes(v));
          if (bad.length) {
            throw new McpError(ErrorCode.InvalidParams,
              `invalid scope ${JSON.stringify(bad)} — allowed: ${VALID_SCOPES.join(", ")}`);
          }
          params.set("scope", (args.scope as string[]).join(","));
        }
        if (typeof args.span_type === "string" && args.span_type) params.set("span_type", args.span_type);
        if (typeof args.context_chars === "number") params.set("context_chars", String(args.context_chars));
        if (typeof args.max_matches === "number") params.set("max_matches", String(args.max_matches));
        return textResult(await callBackend(backendUrl, `/api/runs/${encodeURIComponent(searchRunId)}/search?${params}`));
      }
      case "get_span_context": {
        if (typeof args.span_id !== "string" || !args.span_id) {
          throw new McpError(ErrorCode.InvalidParams, "span_id required");
        }
        const params = new URLSearchParams();
        if (typeof args.before === "number") params.set("before", String(args.before));
        if (typeof args.after === "number") params.set("after", String(args.after));
        if (args.include_parent === false) params.set("include_parent", "false");
        const qs = params.toString();
        return textResult(await callBackend(backendUrl, `/api/spans/${encodeURIComponent(args.span_id)}/context${qs ? "?" + qs : ""}`));
      }
      case "show_in_ui": {
        try {
          const conn = await fetch(`${backendUrl}/api/ui/connected`);
          if (!conn.ok) {
            throw new McpError(ErrorCode.InternalError, `Run Phantom backend returned ${conn.status} for /api/ui/connected`);
          }
          const { connected } = await conn.json() as { connected: boolean };
          if (!connected) {
            return textResult({ ok: false, reason: "no Run Phantom UI is connected" });
          }
        } catch (err) {
          if (err instanceof McpError) throw err;
          throw backendUnreachableError(backendUrl, err);
        }

        const command =
          typeof args.run_id === "string"
              ? { type: "navigate_to_run", run_id: args.run_id }
              : { type: "open_filter", event_name: args.event_name, user_id: args.user_id };

        let res: Response;
        try {
          res = await fetch(`${backendUrl}/api/agent-ui/commands`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(command),
          });
        } catch (err) {
          throw backendUnreachableError(backendUrl, err);
        }
        if (res.status === 400) {
          const body = await res.json().catch(() => ({}));
          throw new McpError(ErrorCode.InvalidParams, body?.error ?? "Bad UI command");
        }
        if (!res.ok) {
          throw new McpError(ErrorCode.InternalError, `Run Phantom backend returned ${res.status} for UI command`);
        }

        if (typeof args.note === "string" && args.note && typeof args.run_id === "string") {
          const noteRes = await fetch(`${backendUrl}/api/agent-ui/commands`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "compose_annotation",
              run_id: args.run_id,
              span_id: typeof args.span_id === "string" ? args.span_id : undefined,
              note: args.note,
              source: currentAnnotationSource(),
            }),
          });
          if (!noteRes.ok) {
            throw new McpError(ErrorCode.InternalError, `Run Phantom backend returned ${noteRes.status} drafting annotation`);
          }
        }
        return textResult(await res.json());
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  });
}
