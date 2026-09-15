import express from "express";
import type { Request, Response, NextFunction } from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { normalizeOtelId } from "./ids";
import { searchRuns, RunSearchError } from "./run-search";
import { getRunComparison, RunComparisonError } from "./run-comparison";
import { parseOtlpRequest } from "./parse";
import { decodeOtlpProtobuf } from "./otlp-protobuf";
import {
  upsertRun,
  insertSpan,
  getRuns,
  getDrizzleDb,
  getRunWithSpans,
  getRunsByConvoId,
  clearAll,
  upsertLiveEvent,
  getLiveEvents,
  cacheSavedRun,
  getCachedRun,
  deleteCachedRun,
  deleteRun,
  getSpanMeta,
  getSpanPayloadColumn,
  getSpanContext,
  getMostRecentlyTouchedRun,
  getRunById,
  getRunOutline,
  listSpansFiltered,
  countSpansFiltered,
  searchRun,
  tailLiveEvents,
  listSavedEvents,
  getSavedEvent,
  upsertSavedEvent,
  patchSavedEvent,
  deleteSavedEvent,
  listSavedFolders,
  ensureSavedFolder,
  deleteSavedFolder,
  setRunDisplayName,
  type SavedEventRow,
  runInTransaction,
  queryTracesBounded,
} from "./db";
import { sliceSpanPayload } from "./payload-slice";
import { exportTrace, importTrace, InvalidTraceImportError } from "./trace-export";
import { detectSubAgents } from "./agents";
import { detectProvider, getProviderBaseURL, getProviderHeaders, isSupportedProvider } from "./provider-options";
import { runReplay } from "./replay";
import { discoverReplayAgents, loadAgentsConfig, saveAgentsConfig, extractContextFromTrace, registerReplayProjectIfPresent, setActiveDaemonPort } from "./agents-config";
import { resolveBuiltAppDir } from "./ui-assets";
import { setReplayTrace } from "./replay-map";
import { getClaudeSession, getLatestClaudeLoadout, type ClaudeLoadout } from "./claude-sessions";
import { getCodexSession } from "./codex-sessions";
import { listAgentSessions } from "./sessions-listing";
import { runClaudeCliChat } from "./claude-cli-chat";
import { runCodexCliChat } from "./codex-cli-chat";
import {
  agentAnnotationSource,
  agentProviderLabel,
  defaultAgentLoadout,
  getAgentProvider,
  parseAgentProvider,
  setAgentProvider,
  type AgentProviderId,
} from "./agent-chat";
import { loadInstallRegistry } from "./install/registry";
import {
  ACTIVE_WORKSPACE_MISSING_MESSAGE,
  type ActiveWorkspace,
  getActiveWorkspace,
  setActiveWorkspace,
} from "./active-workspace";
import {
  AskUserQuestionBridge,
  askUserQuestionAllow,
  askUserQuestionDeny,
  parseAnswerMap,
  parseAskUserQuestionHookInput,
} from "./claude-ask-user-question";
import { createViewingRegistry } from "./viewing-registry";
import { createLocalOriginGuard, isAllowedRunPhantomOrigin, parseAllowedOriginsEnv } from "./local-origin-guard";
import { hostnameOnly, isAllowedRemoteAddress, parseAllowedHostsEnv, parseAllowedSourceIpsEnv } from "./local-access";
import {
  createAnnotation,
  deleteAnnotation,
  getAnnotationsByRun,
  AnnotationNotFoundError,
  InvalidAnnotationError,
  type AnnotationKind,
  type AnnotationSource,
} from "./annotations";
import { replayDefaultDemoTraces } from "./demo-traces";
import { createVerificationService } from "./verification/service";
import { createVerificationRouter } from "./verification/router";
import { parseAppOrigin } from "./verification/bridge";
import verificationSdk from "./verification/browser-sdk.js" with { type: "text" };
import { VERIFICATION_LIMITS } from "./verification/protocol";
import { createEvaluationService } from "./evaluations/service";
import { createEvaluationRouter } from "./evaluations/router";
import { EVALUATION_LIMITS } from "./evaluations/protocol";
import { parseJsonEvidence, LossyJsonNumberError } from "./evaluations/json-evidence";
import {
  getEffectiveSecret,
  getSecretStatus,
  getSecretStatuses,
  parseSecretKey,
  setStoredSecret,
  deleteStoredSecret,
} from "./secret-store";

function parseAnnotationSource(value: unknown): AnnotationSource | null {
  return value === "user" || value === "claude-code" || value === "codex" ? value : null;
}

function getStringMetadata(
  metadata: unknown,
  key: string
): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : undefined;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isAllowedLocalHostname(hostname: string, allowedHosts?: ReadonlySet<string>): boolean {
  if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
  return allowedHosts?.has(hostname.toLowerCase()) ?? false;
}

function isAllowedLocalAccess(
  hostHeader: string | string[] | undefined,
  originHeader: string | string[] | undefined,
  allowedHosts?: ReadonlySet<string>,
  allowedOrigins?: ReadonlySet<string>,
): boolean {
  const host = firstHeader(hostHeader) ?? "";
  const hostName = hostnameOnly(host);
  if (hostName && !isAllowedLocalHostname(hostName, allowedHosts)) return false;

  const origin = firstHeader(originHeader);
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return isAllowedLocalHostname(u.hostname, allowedHosts) || allowedOrigins?.has(u.origin.toLowerCase()) === true;
  } catch {
    return false;
  }
}

function allowedIngestCorsOrigin(
  originHeader: string | string[] | undefined,
  allowedHosts?: ReadonlySet<string>,
): string | null {
  const origin = firstHeader(originHeader);
  if (!origin) return null;
  try {
    const u = new URL(origin);
    return isAllowedLocalHostname(u.hostname, allowedHosts) || u.protocol === "chrome-extension:" ? origin : null;
  } catch {
    return null;
  }
}

function createReplayAbortLifecycle(req: express.Request, res: express.Response) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  const onRequestClose = () => {
    if (req.aborted || !req.complete) abort();
  };
  const onResponseClose = () => {
    if (!res.writableEnded) abort();
  };
  const cleanup = () => {
    req.off("aborted", abort);
    req.off("close", onRequestClose);
    res.off("close", onResponseClose);
    res.off("finish", cleanup);
  };

  req.once("aborted", abort);
  req.once("close", onRequestClose);
  res.once("close", onResponseClose);
  res.once("finish", cleanup);
  return { controller, cleanup };
}

const DEMO_CHAT_MODEL = process.env.RUNPHANTOM_DEMO_CHAT_MODEL ?? "gpt-5.6-luna";
const DEMO_CHAT_TIMEOUT_MS = 60_000;
const DEMO_CHAT_MAX_FRAME_BYTES = 128 * 1024;
const DEMO_CHAT_MAX_STREAM_BYTES = 1024 * 1024;
const DEMO_CHAT_MAX_OUTPUT_BYTES = 64 * 1024;

class DemoChatStreamError extends Error {}

type DemoChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

function parseDemoMessages(value: unknown): DemoChatMessage[] | null {
  if (!Array.isArray(value)) return null;
  const messages: DemoChatMessage[] = [];
  for (const item of value.slice(-16)) {
    if (!item || typeof item !== "object") continue;
    const role = (item as Record<string, unknown>).role;
    const content = (item as Record<string, unknown>).content;
    if (
      (role === "system" || role === "user" || role === "assistant") &&
      typeof content === "string" &&
      content.trim()
    ) {
      messages.push({ role, content: content.trim().slice(0, 8000) });
    }
  }
  return messages.some((message) => message.role === "user") ? messages : null;
}

async function streamOpenAiDemoChat(req: express.Request, res: express.Response): Promise<void> {
  const messages = parseDemoMessages((req.body as Record<string, unknown> | null)?.messages);
  if (!messages) {
    res.status(400).json({ error: "messages must include at least one user message" });
    return;
  }

  const apiKey = getEffectiveSecret("openai");
  if (!apiKey) {
    res.status(400).json({ error: "No OpenAI API key. Add one in Run Phantom Settings or set OPENAI_API_KEY." });
    return;
  }

  const lifecycle = createReplayAbortLifecycle(req, res);
  const { controller } = lifecycle;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelReader = () => { void reader?.cancel().catch(() => undefined); };
  controller.signal.addEventListener("abort", cancelReader, { once: true });
  const timeout = setTimeout(() => controller.abort(new DemoChatStreamError("Demo request timed out. Please try again.")), DEMO_CHAT_TIMEOUT_MS);
  timeout.unref();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let streamBytes = 0;
  let outputBytes = 0;
  const writeEvent = (event: { type: "delta"; delta: string } | { type: "complete" } | { type: "error"; error: string }) => {
    if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
  };

  try {
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DEMO_CHAT_MODEL,
        instructions:
          "You are the tiny Run Phantom demo bot. Be warm, concise, and explain how Run Phantom helps debug AI agents with local traces.",
        input: messages.map((message) => ({ role: message.role, content: message.content })),
        stream: true,
        max_output_tokens: 4096,
      }),
    });
    reader = upstream.body?.getReader();
    controller.signal.throwIfAborted();
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `OpenAI request failed (${upstream.status}). Please try again.` });
      return;
    }
    if (!reader) throw new DemoChatStreamError("OpenAI response did not include a readable stream.");

    // This private demo transport carries an explicit terminal record so a clean
    // downstream EOF cannot turn an interrupted reply into completed history.
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");

    while (true) {
      const { done, value } = await reader.read();
      controller.signal.throwIfAborted();
      if (done) throw new DemoChatStreamError("OpenAI stream ended before the reply completed. Please try again.");
      streamBytes += value.byteLength;
      if (streamBytes > DEMO_CHAT_MAX_STREAM_BYTES) throw new DemoChatStreamError("OpenAI stream exceeded the size limit.");
      buffer += decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (Buffer.byteLength(frame) > DEMO_CHAT_MAX_FRAME_BYTES) throw new DemoChatStreamError("OpenAI stream frame exceeded the size limit.");
        const data = frame.split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        if (data === "[DONE]") throw new DemoChatStreamError("OpenAI stream ended before the reply completed. Please try again.");
        const payload = JSON.parse(data);
        if (!payload || typeof payload !== "object" || typeof payload.type !== "string") {
          throw new DemoChatStreamError("OpenAI returned a malformed stream event.");
        }
        if (["response.failed", "response.incomplete", "response.cancelled", "error"].includes(payload.type)) {
          throw new DemoChatStreamError(payload.type === "response.incomplete"
            ? "OpenAI could not finish the reply. Please try again."
            : "OpenAI failed to complete the reply. Please try again.");
        }
        if (payload.type === "response.completed") {
          if (payload.response?.status !== "completed" || payload.response.error || payload.response.incomplete_details) {
            throw new DemoChatStreamError("OpenAI did not confirm a successful reply.");
          }
          writeEvent({ type: "complete" });
          res.end();
          return;
        }
        // Done events repeat the full text, and other delta types may contain
        // reasoning or tool arguments that do not belong in the visible reply.
        if (payload.type === "response.output_text.delta" || payload.type === "response.refusal.delta") {
          if (typeof payload.delta !== "string") throw new DemoChatStreamError("OpenAI returned a malformed text delta.");
          outputBytes += Buffer.byteLength(payload.delta);
          if (outputBytes > DEMO_CHAT_MAX_OUTPUT_BYTES) throw new DemoChatStreamError("OpenAI reply exceeded the size limit.");
          if (payload.delta) writeEvent({ type: "delta", delta: payload.delta });
        }
      }
      if (Buffer.byteLength(buffer) > DEMO_CHAT_MAX_FRAME_BYTES) throw new DemoChatStreamError("OpenAI stream frame exceeded the size limit.");
    }
  } catch (err) {
    if (res.writableEnded || res.destroyed) return;
    const failure = controller.signal.aborted ? controller.signal.reason : err;
    const error = failure instanceof DemoChatStreamError ? failure.message : "OpenAI stream failed. Please try again.";
    if (!res.headersSent) res.status(502).type("json").json({ error });
    else {
      writeEvent({ type: "error", error });
      res.end();
    }
  } finally {
    clearTimeout(timeout);
    lifecycle.cleanup();
    controller.abort();
    cancelReader();
    controller.signal.removeEventListener("abort", cancelReader);
  }
}

function demoChatHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Run Phantom Demo Chat</title>
  <style>
    :root {
      color-scheme: light;
      font-family: "Avenir Next", "Segoe UI Variable Text", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      --canvas: #F8F4EE;
      --surface: #FFFBF6;
      --surface-raised: #F2EADF;
      --ink: #302730;
      --ink-soft: #6A5E67;
      --muted: #6C616C;
      --border: #9C8870;
      --accent: #B83C24;
      --mark-accent: #C7462D;
      --accent-strong: #9F301D;
      --focus: #9F301D;
      --info: #275EA8;
      --danger: #A83440;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100svh;
      padding: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      background:
        linear-gradient(rgba(48,39,48,.026) 1px, transparent 1px),
        linear-gradient(90deg, rgba(48,39,48,.026) 1px, transparent 1px),
        var(--canvas);
      background-size: 32px 32px;
      color: var(--ink);
    }
    .shell {
      width: min(760px, 100%);
      height: min(760px, calc(100svh - 32px));
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 28px;
      background: var(--surface);
      box-shadow: 0 28px 80px rgba(48,39,48,.14);
    }
    header { padding: 24px 24px 18px; border-bottom: 1px solid var(--border); }
    .brand { display: flex; gap: 16px; align-items: flex-start; }
    .mark {
      position: relative;
      flex: 0 0 auto;
      width: 52px;
      height: 52px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background: var(--canvas);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.86);
      padding: 8px;
      color: var(--ink);
    }
    .mark path { stroke: currentColor; }
    .mark circle { fill: var(--mark-accent); }
    .eyebrow {
      margin: 1px 0 7px;
      color: var(--muted);
      font: 700 .72rem/1.3 "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      letter-spacing: .18em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      color: var(--ink);
      font-family: "Avenir Next Condensed", "Arial Narrow", "Segoe UI Variable Display", sans-serif;
      font-size: clamp(2rem, 5vw, 2.9rem);
      line-height: 1;
      letter-spacing: -.04em;
    }
    .tagline { margin: 16px 0 8px; color: var(--accent); font-size: 1rem; font-weight: 700; }
    .sub { margin-top: 0; color: var(--muted); font-size: 14px; line-height: 1.6; }
    .model {
      color: var(--ink-soft);
      font-family: "SFMono-Regular", Menlo, monospace;
      background: rgba(48,39,48,.06);
      border: 1px solid rgba(48,39,48,.08);
      border-radius: 999px;
      padding: 2px 8px;
      white-space: nowrap;
    }
    main {
      flex: 1;
      overflow: auto;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      background:
        linear-gradient(rgba(48,39,48,.028) 1px, transparent 1px),
        linear-gradient(90deg, rgba(48,39,48,.028) 1px, transparent 1px);
      background-size: 28px 28px;
    }
    .msg {
      min-width: 0;
      max-width: min(100%, 82%);
      padding: 12px 14px;
      border-radius: 18px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
      line-height: 1.55;
      font-size: 14px;
    }
    .user {
      align-self: flex-end;
      background: color-mix(in srgb, var(--info) 8%, var(--surface));
      border: 1px solid color-mix(in srgb, var(--info) 24%, transparent);
      color: var(--ink);
    }
    .assistant {
      align-self: flex-start;
      background: rgba(48,39,48,.045);
      border: 1px solid rgba(48,39,48,.10);
      color: var(--ink);
    }
    .error {
      align-self: center;
      color: var(--ink);
      border: 1px solid color-mix(in srgb, var(--danger) 24%, transparent);
      background: color-mix(in srgb, var(--danger) 7%, var(--surface));
    }
    form {
      display: grid;
      gap: 10px;
      padding: 14px;
      border-top: 1px solid var(--border);
      background: var(--surface);
    }
    .composer-copy {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }
    label { color: var(--ink); font-size: 13px; font-weight: 700; }
    .hint { color: var(--muted); font-size: 12px; }
    textarea {
      min-height: 48px;
      max-height: 140px;
      width: 100%;
      resize: vertical;
      color: var(--ink);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 13px 14px;
      outline: none;
      font: inherit;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.75);
    }
    textarea::placeholder { color: var(--muted); }
    textarea:focus-visible, button:focus-visible {
      outline: 3px solid var(--focus);
      outline-offset: 3px;
    }
    .actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }
    button {
      border: 1px solid var(--accent);
      border-radius: 16px;
      background: var(--accent);
      color: var(--surface);
      min-height: 46px;
      padding: 0 18px;
      font-weight: 650;
      cursor: pointer;
      box-shadow: 0 10px 24px rgba(184,60,36,.18);
    }
    button:hover:not(:disabled) { background: var(--accent-strong); }
    button:disabled { opacity: .45; cursor: not-allowed; box-shadow: none; }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    @media (max-width: 640px) {
      body { padding: 12px; }
      .shell { height: min(760px, calc(100svh - 24px)); border-radius: 22px; }
      header { padding: 20px 18px 16px; }
      .brand { gap: 12px; }
      .mark { width: 46px; height: 46px; border-radius: 14px; }
      main { padding: 14px; }
      form { padding: 12px; }
      .actions { flex-direction: column; align-items: stretch; }
      button { width: 100%; }
      .msg { max-width: 100%; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; scroll-behavior: auto !important; transition: none !important; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="brand">
        <svg class="mark" viewBox="0 0 64 64" fill="none" role="img" aria-label="Run Phantom">
          <path d="M12 26V12H26M38 52H52V38" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"></path>
          <path d="M12 42C20 42 20 22 30 22C40 22 39 42 52 42" stroke-width="4.5" stroke-linecap="round"></path>
          <circle cx="30" cy="22" r="5"></circle>
        </svg>
        <div>
          <p class="eyebrow">Run Phantom demo</p>
          <h1>Run Phantom Demo Chat</h1>
        </div>
      </div>
      <p class="tagline">See the run. Find the reason.</p>
      <div class="sub">A tiny standalone bot streamed through OpenAI <span class="model">${DEMO_CHAT_MODEL}</span>. It uses your saved Run Phantom OpenAI key when available.</div>
    </header>
    <main id="log" aria-live="polite" aria-label="Conversation transcript">
      <div class="msg assistant">Hi, I’m the Run Phantom demo bot. Ask me what a trace is, or how Run Phantom helps debug an agent locally.</div>
    </main>
    <form id="form">
      <div class="composer-copy">
        <label for="input">Prompt</label>
        <span class="hint">This standalone provider demo does not create a trace. Load demo traces in the main workspace to explore the debugger.</span>
      </div>
      <textarea id="input" placeholder="Ask the demo bot..." autofocus></textarea>
      <div class="actions">
        <span id="status" class="hint" role="status" aria-live="polite"></span>
        <button id="send" type="submit">Send</button>
      </div>
    </form>
  </div>
  <script>
    const log = document.getElementById("log");
    const form = document.getElementById("form");
    const input = document.getElementById("input");
    const send = document.getElementById("send");
    const status = document.getElementById("status");
    const messages = [{ role: "assistant", content: "Hi, I’m the Run Phantom demo bot. Ask me what a trace is, or how Run Phantom helps debug an agent locally." }];

    function add(role, text) {
      const el = document.createElement("div");
      el.className = "msg " + role;
      el.textContent = text;
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
      return el;
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text || send.disabled) return;
      input.value = "";
      send.disabled = true;
      status.textContent = "Running...";
      messages.push({ role: "user", content: text });
      add("user", text);
      const assistant = add("assistant", "");
      let reply = "";
      let reader;
      try {
        const res = await fetch("/api/demo-chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ messages }),
        });
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Demo request failed.");
        }
        reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let buffer = "";
        let completed = false;
        while (!completed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf("\\n")) !== -1) {
            const line = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 1);
            const event = JSON.parse(line);
            if (event.type === "error") throw new Error(event.error || "Demo request failed.");
            if (event.type === "complete") {
              completed = true;
              break;
            }
            if (event.type !== "delta" || typeof event.delta !== "string") throw new Error("Invalid demo reply.");
            reply += event.delta;
            assistant.textContent = reply || "…";
            log.scrollTop = log.scrollHeight;
          }
        }
        if (!completed) throw new Error("Reply interrupted before completion. Please try again.");
        messages.push({ role: "assistant", content: reply });
        status.textContent = "Reply complete.";
      } catch (err) {
        if (reply) {
          assistant.classList.add("error");
          assistant.setAttribute("aria-label", "Incomplete assistant reply");
        } else assistant.remove();
        add("error", err instanceof Error ? err.message : String(err));
        status.textContent = "Request failed.";
      } finally {
        if (reader) void reader.cancel().catch(() => {});
        send.disabled = false;
        input.focus();
      }
    });
  </script>
</body>
</html>`;
}

export async function createServer(port: number) {
  const app = express();
  const server = http.createServer(app);

  const currentServerPort = (): number | null => {
    const address = server.address();
    return address && typeof address !== "string" ? address.port : (port > 0 ? port : null);
  };

  // Replay agents export their traces back to whichever daemon is named here, so
  // it has to be this one rather than whatever the shared port file says.
  server.on("listening", () => setActiveDaemonPort(currentServerPort()));
  server.on("close", () => setActiveDaemonPort(null));

  const configuredUiPort = (() => {
    const parsed = Number.parseInt(process.env.RUNPHANTOM_UI_PORT ?? "5948", 10);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : 5948;
  })();
  const allowedOrigins = parseAllowedOriginsEnv(process.env.RUNPHANTOM_ALLOWED_ORIGINS);

  // Run Phantom is a local control plane with UI actions that can launch local
  // agents. Do not allow a remote page to frame the UI and drive those actions.
  // Express advertises itself in every response and there is nothing to gain from
  // telling a caller what the server is built with.
  app.disable("x-powered-by");

  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    // This daemon serves both JSON and user-supplied payload text. Without it a
    // browser may sniff a response into a type the server never declared.
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  // Hostnames and source addresses are separate gates. Adding an accepted Host
  // must never widen which machines can reach the daemon.
  const allowedHosts = parseAllowedHostsEnv(process.env.RUNPHANTOM_ALLOWED_HOSTS);
  const allowedSourceIps = parseAllowedSourceIpsEnv(process.env.RUNPHANTOM_ALLOWED_SOURCE_IPS);

  const wss = new WebSocketServer({
    noServer: true,
    path: "/ws",
    maxPayload: 1024 * 1024,
    verifyClient: (info, done) => {
      const browserOrigin = info.origin || info.req.headers.origin;
      done(
        isAllowedRemoteAddress(info.req.socket.remoteAddress, allowedSourceIps) &&
          isAllowedLocalAccess(info.req.headers.host, browserOrigin, allowedHosts, allowedOrigins) &&
          (!browserOrigin || isAllowedRunPhantomOrigin(browserOrigin, currentServerPort(), configuredUiPort, allowedOrigins)),
        403,
        "Forbidden",
      );
    },
  });

  const clients = new Set<WebSocket>();

  function broadcast(event: string, data: any) {
    const msg = JSON.stringify({ event, data });
    for (const ws of clients) { if (ws.readyState === WebSocket.OPEN) ws.send(msg); }
  }

  const verification = createVerificationService({ broadcast, allowedSourceIps, allowedHosts });
  const evaluations = createEvaluationService();
  server.on("upgrade", (req, socket, head) => {
    let pathname: string;
    try { pathname = new URL(req.url ?? "", "http://localhost").pathname; } catch { socket.destroy(); return; }
    if (pathname === "/verification/ws") verification.bridge.handleUpgrade(req, socket, head);
    else if (pathname === "/ws") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    else socket.destroy();
  });

  const askUserQuestions = new AskUserQuestionBridge(broadcast);
  let agentProvider: AgentProviderId = getAgentProvider();
  let latestClaudeLoadout: ClaudeLoadout | null = null;

  const viewingRegistry = createViewingRegistry();
  const ANTHROPIC_MODELS_CACHE_TTL_MS = 60 * 60 * 1000;
  let anthropicModelsCache: { expiresAt: number; models: string[] } | null = null;
  const claudeCliChatEnabled =
    port !== 0 && process.env.RUNPHANTOM_CLAUDE_CLI_CHAT !== "0";
  const localOriginGuard = createLocalOriginGuard({
    daemonPort: currentServerPort,
    uiPort: configuredUiPort,
    extraAllowedOrigins: allowedOrigins,
  });

  function backendUrl(): string {
    return `http://127.0.0.1:${currentServerPort() ?? port}`;
  }

  function hasConnectedUi(): boolean {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  function activeWorkspaceOrError(res: express.Response): ActiveWorkspace | null {
    const workspace = getActiveWorkspace();
    if (workspace) return workspace;
    res.status(409).json({ error: ACTIVE_WORKSPACE_MISSING_MESSAGE });
    return null;
  }

  function expandHome(inputPath: string): string {
    return inputPath === "~" || inputPath.startsWith("~/")
      ? path.join(os.homedir(), inputPath.slice(2))
      : inputPath;
  }

  function resolveDirectory(inputPath: string): string {
    // statSync's own error text is returned to the caller, and it carries the
    // resolved absolute path plus the Node error code — so a bad ?cwd= reported
    // "ENOENT ... stat '/Users/<name>/...'" while the sibling not-a-directory
    // branch two lines down already answered with a clean message. Normalise
    // both to the same shape.
    if (inputPath.includes("\0")) throw new Error("directory path must not contain null bytes");
    const resolved = path.resolve(expandHome(inputPath));
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`directory not found: ${resolved}`);
    }
    if (!stat.isDirectory()) throw new Error(`directory not found: ${resolved}`);
    return resolved;
  }

  function isDirectoryEntry(entry: fs.Dirent, parentPath: string): boolean {
    if (entry.name === "." || entry.name === "..") return false;
    if (entry.isDirectory()) return true;
    if (!entry.isSymbolicLink()) return false;
    try {
      return fs.statSync(path.join(parentPath, entry.name)).isDirectory();
    } catch {
      return false;
    }
  }

  function listSubdirectories(parentPath: string): { name: string; path: string }[] {
    return fs.readdirSync(parentPath, { withFileTypes: true })
      .filter((entry) => isDirectoryEntry(entry, parentPath))
      .map((entry) => ({ name: entry.name, path: path.join(parentPath, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function requestCwd(req: express.Request): string | null {
    const body = req.body as Record<string, unknown> | null;
    const value = typeof req.query.cwd === "string"
      ? req.query.cwd
      : typeof body?.cwd === "string"
        ? body.cwd
        : null;
    return value && value.trim() ? value : null;
  }

  function cwdFromRequestOrActive(req: express.Request, res: express.Response): string | null {
    const requested = requestCwd(req);
    if (requested) {
      try {
        return resolveDirectory(requested);
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
        return null;
      }
    }
    const workspace = activeWorkspaceOrError(res);
    return workspace?.cwd ?? null;
  }

  function rememberClaudeLoadout(event: unknown) {
    if (!event || typeof event !== "object") return;
    const typed = event as Record<string, unknown>;
    if (typed.type !== "loadout") return;
    const tools = stringList(typed.tools);
    const mcps = stringList(typed.mcps);
    const skills = stringList(typed.skills);
    const plugins = stringList(typed.plugins);
    const slashCommands = stringList(typed.slash_commands);
    latestClaudeLoadout = {
      tools: tools.length ? tools : latestClaudeLoadout?.tools ?? [],
      mcps: mcps.length ? mcps : latestClaudeLoadout?.mcps ?? [],
      skills: skills.length ? skills : latestClaudeLoadout?.skills ?? [],
      plugins: plugins.length ? plugins : latestClaudeLoadout?.plugins ?? [],
      slash_commands: slashCommands.length ? slashCommands : latestClaudeLoadout?.slash_commands ?? [],
      model: typeof typed.model === "string" ? typed.model : undefined,
    };
    broadcast("claude_loadout", latestClaudeLoadout);
    broadcast("agent_loadout", latestClaudeLoadout);
  }

  function currentLoadout(cwd: string) {
    if (agentProvider === "codex") return defaultAgentLoadout("codex");
    if (!latestClaudeLoadout) {
      latestClaudeLoadout = getLatestClaudeLoadout(cwd);
    }
    return latestClaudeLoadout ?? defaultAgentLoadout("claude");
  }

  wss.on("connection", (ws) => {
    const wsId = randomUUID();
    clients.add(ws);
    if (latestClaudeLoadout) {
      ws.send(JSON.stringify({ event: "claude_loadout", data: latestClaudeLoadout }));
    }
    ws.send(JSON.stringify({ event: "agent_provider", data: { provider: agentProvider } }));
    const workspace = getActiveWorkspace();
    if (workspace) {
      ws.send(JSON.stringify({ event: "agent_loadout", data: currentLoadout(workspace.cwd) }));
    }
    for (const pending of askUserQuestions.active()) {
      ws.send(JSON.stringify({ event: "claude_ask_user_question", data: pending }));
    }
    ws.on("message", (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ui_view") {
        const runId = typeof msg.run_id === "string" && msg.run_id ? msg.run_id : null;
        const selectedSpanId = typeof msg.span_id === "string" && msg.span_id ? msg.span_id : null;
        viewingRegistry.update(wsId, runId, selectedSpanId);
      }
    });
    ws.on("close", () => {
      clients.delete(ws);
      viewingRegistry.unregister(wsId);
    });
  });

  const INGEST_PATHS = new Set([
    "/v1/traces",
    "/v1/otel/v1/traces",
    "/otel/v1/traces",
    "/v1/live",
  ]);

  // Run Phantom is a local control plane. Enforce loopback at the socket layer so
  // spoofable Host/Origin headers cannot turn a broad listener into LAN access.
  app.use((req, res, next) => {
    if (!isAllowedRemoteAddress(req.socket.remoteAddress, allowedSourceIps)) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  });

  // This code-only module can be imported by a paired local app; control APIs retain their own guards.
  app.get("/verification/sdk.js", (req, res) => {
    if (!isAllowedLocalAccess(req.headers.host, undefined, allowedHosts)) return res.status(403).json({ error: "forbidden" });
    const origin = firstHeader(req.headers.origin);
    if (origin) {
      try { res.setHeader("Access-Control-Allow-Origin", parseAppOrigin(origin)); }
      catch { return res.status(403).json({ error: "forbidden" }); }
      res.setHeader("Vary", "Origin");
    }
    res.type("application/javascript").send(verificationSdk);
  });

  // CORS for the ingestion routes browser SDKs actually post to —
  // narrower than `/v1/*` so future routes under that prefix don't
  // inherit cross-origin access by default.
  app.use(
    [...INGEST_PATHS],
    (req, res, next) => {
      const origin = firstHeader(req.headers.origin);
      const corsOrigin = allowedIngestCorsOrigin(req.headers.origin, allowedHosts);
      if (!isAllowedLocalAccess(req.headers.host, undefined, allowedHosts) || (origin && !corsOrigin)) {
        return res.status(403).json({ error: "forbidden" });
      }
      if (corsOrigin) res.setHeader("Access-Control-Allow-Origin", corsOrigin);
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (req.method === "OPTIONS") return res.sendStatus(204);
      next();
    },
  );

  // Block cross-origin requests to everything except ingestion routes.
  // Non-browser callers (MCP stdio, curl, local SDKs) send no Origin.
  app.use((req, res, next) => {
    if (INGEST_PATHS.has(req.path)) return next();
    if (!isAllowedLocalAccess(req.headers.host, req.headers.origin, allowedHosts, allowedOrigins)) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  });

  app.use("/api", (req, res, next) => {
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE") {
      return localOriginGuard(req, res, next);
    }
    next();
  });

  app.use(["/api/verification", "/api/evaluations"], (req, res, next) => {
    const hasBody = req.headers["transfer-encoding"] !== undefined || Number(req.headers["content-length"] ?? 0) > 0;
    if (hasBody && !req.is("application/json")) {
      res.status(400).json({ error: "This API accepts JSON request bodies only" });
      return;
    }
    next();
  });
  app.use("/api/verification", express.json({ limit: VERIFICATION_LIMITS.MAX_FRAME_BYTES }));
  app.use("/api/evaluations", express.json({
    limit: EVALUATION_LIMITS.MAX_REQUEST,
    verify: (_req, _res, body, encoding) => { parseJsonEvidence(new TextDecoder(encoding).decode(body)); },
  }));
  app.use(express.json({ limit: "50mb" }));
  // Accept protobuf bodies so Traceloop OTLP exports aren't silently dropped
  app.use(express.raw({ limit: "50mb", type: "application/x-protobuf" }));

  // A malformed or oversized body would otherwise fall through to Express's
  // default handler, which renders an HTML stack trace exposing absolute
  // node_modules paths (and the OS username). Keep the JSON error contract.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (!err) return next();
    if (err instanceof LossyJsonNumberError) {
      res.status(400).json({ error: err.message });
      return;
    }
    const status = (err as { status?: number; statusCode?: number }).status
      ?? (err as { statusCode?: number }).statusCode
      ?? 500;
    if (status === 413) {
      res.status(413).json({ error: "request body too large" });
      return;
    }
    if (err instanceof SyntaxError || (err as { type?: string }).type === "entity.parse.failed") {
      res.status(400).json({ error: "invalid JSON body" });
      return;
    }
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: "request failed" });
  });

  server.on("close", () => {
    askUserQuestions.closeAll();
    verification.close();
    evaluations.close();
  });

  app.use("/api/verification", createVerificationRouter(verification));
  app.use("/api/evaluations", createEvaluationRouter(evaluations));

  // Health check endpoint — used by SDKs to auto-detect a running debugger
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "runphantom", port: currentServerPort() ?? port, pid: process.pid });
  });

  app.get("/demo-chat", (_req, res) => {
    res.type("html").send(demoChatHtml());
  });

  app.post("/api/demo-chat", (req, res) => {
    streamOpenAiDemoChat(req, res).catch((err) => {
      console.error("[runphantom] demo chat error:", err);
      if (res.writableEnded || res.destroyed) return;
      if (!res.headersSent) {
        res.status(500).json({ error: "Demo chat failed." });
        return;
      }
      res.destroy();
    });
  });

  app.post("/api/demo-traces/replay", (_req, res) => {
    try {
      const result = replayDefaultDemoTraces({ broadcast });
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[runphantom] demo trace replay failed:", err);
      res.status(500).json({ error: (err as Error).message || "Failed to replay demo traces." });
    }
  });

  // Shared OTLP trace ingestion handler
  function ingestTraces(req: any, res: any) {
    try {
      let body = req.body;
      const isProtobuf = Buffer.isBuffer(body);

      // Neither body parser claims a request without a recognised Content-Type,
      // so req.body was {} and the export fell through to "0 spans, 200 OK" —
      // the exporter recorded a success and the whole batch was gone. OTLP/HTTP
      // requires the header, so say so instead of silently accepting.
      if (!isProtobuf && !req.is("application/json") && !req.is("application/x-protobuf")) {
        res.status(415).json({
          error: "OTLP requires Content-Type: application/json or application/x-protobuf",
        });
        return;
      }

      if (isProtobuf) {
        try {
          body = decodeOtlpProtobuf(body);
        } catch (err) {
          console.error("[runphantom] Failed to decode protobuf OTLP:", err);
          res.status(400).json({ error: "Failed to decode protobuf OTLP body" });
          return;
        }
      }

      // OTLP/HTTP requires the response to use the request's encoding. An empty
      // body is a well-formed ExportTraceServiceResponse with no partial_success,
      // i.e. full success; strict exporters reject a JSON body here.
      const ok = (payload: Record<string, unknown>) => {
        if (isProtobuf) {
          res.status(200).type("application/x-protobuf").send(Buffer.alloc(0));
          return;
        }
        res.json(payload);
      };

      const spans = parseOtlpRequest(body);
      if (spans.length === 0) { ok({ ok: true, spansIngested: 0 }); return; }

      // Reject structurally impossible spans up front. These are client errors, and
      // letting them reach SQLite turns a bad export into a 500 plus a half-written
      // batch. An empty traceId is singled out because it used to create a run whose
      // id was "" that every later id-less span then joined.
      const invalid = spans.find((s) =>
        typeof s.traceId !== "string" || s.traceId.length === 0 ||
        typeof s.spanId !== "string" || s.spanId.length === 0 ||
        typeof s.name !== "string" || s.name.length === 0 ||
        !Number.isFinite(s.startTimeMs) || !Number.isFinite(s.endTimeMs));
      if (invalid) {
        res.status(400).json({
          error: "invalid span: traceId, spanId and name must be non-empty strings and timestamps must be finite",
        });
        return;
      }

      // Deduplicated per trace before insert. A batch that repeats a span id
      // upserts the same row twice, so counting parsed spans reported more
      // ingested than were stored and an exporter had no way to notice it had
      // sent a duplicate.
      const byTrace = new Map<string, typeof spans>();
      for (const s of spans) { const a = byTrace.get(s.traceId) ?? []; a.push(s); byTrace.set(s.traceId, a); }

      const updatedRunIds: string[] = [];
      let spansPersisted = 0;
      // All-or-nothing: a throw here rolls the whole batch back, so a retry cannot
      // duplicate the traces that had already been written.
      runInTransaction(() => {
      for (const [traceId, traceSpans] of byTrace) {
        const now = Date.now();
        const minStart = Math.min(...traceSpans.map(s => s.startTimeMs));
        const maxEnd = Math.max(...traceSpans.map(s => s.endTimeMs));
        // Only a genuine root names the run. Falling back to traceSpans[0] meant a
        // later batch carrying just child spans renamed the run after whichever
        // leaf happened to be first — a run called "code_review_agent" would
        // silently become "read_file" as more spans arrived.
        const root = traceSpans.find(s => !s.parentSpanId);

        // Record mapping if this trace carries a replayRunId so the
        // replay system can find this run by its replayRunId
        const replayRunId = traceSpans.find(s => s.replayRunId)?.replayRunId;
        if (replayRunId) {
          setReplayTrace(replayRunId, traceId);
        }

        const eventId = traceSpans.find(s => s.eventId)?.eventId;

        upsertRun({
          id: traceId, event_id: eventId,
          // undefined leaves the stored name alone (upsertRun COALESCEs it); the
          // short-id fallback is only for a run that does not exist yet.
          name: root?.name ?? (getRunById(traceId) ? undefined : traceId.slice(0, 8)),
          event_name: traceSpans.find(s => s.eventName)?.eventName,
          user_id: traceSpans.find(s => s.userId)?.userId,
          convo_id: traceSpans.find(s => s.convoId)?.convoId,
          started_at: minStart || now, last_updated_at: maxEnd || now,
        });
        const seenSpanIds = new Set<string>();
        for (const s of traceSpans) {
          if (seenSpanIds.has(s.spanId)) continue;
          seenSpanIds.add(s.spanId);
          spansPersisted++;
          insertSpan({
            id: s.spanId, run_id: traceId, parent_span_id: s.parentSpanId,
            name: s.name, span_type: s.spanType, status: s.status,
            input_payload: s.inputPayload, output_payload: s.outputPayload,
            start_time_ms: s.startTimeMs, end_time_ms: s.endTimeMs, duration_ms: s.durationMs,
            model: s.model, provider: s.provider,
            input_tokens: s.inputTokens, output_tokens: s.outputTokens,
            attributes: JSON.stringify(s.attributes),
          });
        }

        updatedRunIds.push(traceId);
      }
      });

      broadcast("spans", { runIds: updatedRunIds, count: spansPersisted });
      ok({
        ok: true,
        spansIngested: spansPersisted,
        ...(spansPersisted === spans.length ? {} : { spansDeduplicated: spans.length - spansPersisted }),
      });
    } catch (err) {
      // A malformed body that survives parsing still surfaces here as a SQLite or
      // TypeError. That is the client's payload being wrong, not the server
      // failing, and returning 500 makes conforming exporters retry it forever.
      const message = err instanceof Error ? err.message : String(err);
      const clientFault = err instanceof TypeError
        || err instanceof RangeError
        || err instanceof SyntaxError
        || /datatype mismatch|NOT NULL constraint|CHECK constraint|FOREIGN KEY constraint|too large|malformed/i.test(message);
      if (clientFault) {
        res.status(400).json({ error: "invalid OTLP payload" });
        return;
      }
      console.error("[runphantom] Error ingesting:", err);
      res.status(500).json({ error: "Failed to ingest" });
    }
  }

  // Accept OTLP trace exports at multiple paths to handle various SDK exporters
  // (direct shipper, Traceloop, standard OTLP exporters)
  app.post("/v1/traces", ingestTraces);
  app.post("/v1/otel/v1/traces", ingestTraces);
  app.post("/otel/v1/traces", ingestTraces);

  app.post("/v1/live", (req, res) => {
    try {
      const { traceId, spanId, type, content, timestamp, metadata } = req.body;
      const normalizedTraceId =
        typeof traceId === "string" ? normalizeOtelId(traceId, 16) ?? traceId : undefined;
      const normalizedSpanId =
        typeof spanId === "string" ? normalizeOtelId(spanId, 8) ?? spanId : undefined;
      if (!normalizedTraceId || !type) { res.status(400).json({ error: "traceId and type required" }); return; }
      if ((type === "tool_start" || type === "tool_result") && !normalizedSpanId) {
        res.status(400).json({ error: "spanId is required for tool_start and tool_result live events" });
        return;
      }
      // A caller-supplied timestamp is written straight into runs.started_at /
      // last_updated_at, which order the whole run list. A string or NaN there
      // sorts unpredictably and cannot be corrected by any later event, so a
      // single malformed live post permanently strands the run. Reject it
      // instead of persisting it.
      if (timestamp !== undefined && timestamp !== null && !Number.isFinite(timestamp)) {
        res.status(400).json({ error: "timestamp must be a finite number of milliseconds" });
        return;
      }
      const ts = (timestamp as number | undefined | null) ?? Date.now();
      const eventId =
        getStringMetadata(metadata, "eventId") ??
        getStringMetadata(metadata, "event_id");

      upsertLiveEvent({
        traceId: normalizedTraceId,
        spanId: normalizedSpanId,
        type,
        content,
        timestamp: ts,
        metadata,
      });
      upsertRun({
        id: normalizedTraceId,
        event_id: eventId,
        event_name: getStringMetadata(metadata, "eventName"),
        user_id: getStringMetadata(metadata, "userId"),
        convo_id: getStringMetadata(metadata, "convoId"),
        started_at: ts,
        last_updated_at: ts,
      });
      broadcast("live", {
        traceId: normalizedTraceId,
        spanId: normalizedSpanId,
        type,
        content,
        timestamp: ts,
        metadata,
      });
      res.json({ ok: true });
    } catch (err) {
      console.error("[runphantom] Error:", err);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.get("/api/runs", (req, res) => {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 5000) : 5000;
    res.json(getRuns(limit));
  });
  app.get("/api/runs/search", async (req, res) => {
    const cancellation = new AbortController();
    const onClose = () => { if (!res.writableEnded) cancellation.abort(); };
    res.on("close", onClose);
    try {
      const result = await searchRuns(req.query, { signal: cancellation.signal });
      if (!res.destroyed) res.json(result);
    } catch (error) {
      if (!res.destroyed) {
        const status = error instanceof RunSearchError ? error.status : 500;
        if (status === 503) res.setHeader("Retry-After", "1");
        res.status(status).json({ error: error instanceof Error ? error.message : "Search failed" });
      }
    } finally {
      res.removeListener("close", onClose);
    }
  });
  app.get("/api/runs/compare", (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(getRunComparison(getDrizzleDb().$client, req.query));
    } catch (error) {
      const expected = error instanceof RunComparisonError;
      res.status(expected ? error.status : 500).json({
        error: expected ? error.message : "Run comparison failed",
        code: expected ? error.code : "comparison_failed",
      });
    }
  });
  app.get("/api/runs/active", (_req, res) => {
    const run = getMostRecentlyTouchedRun();
    if (!run) { res.status(404).json({ error: "No runs yet" }); return; }
    res.json(run);
  });
  app.post("/api/traces/query", async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    if (typeof body.sql !== "string" || !body.sql.trim()) {
      res.status(400).json({ error: "sql required" });
      return;
    }
    try {
      // Time-bounded: this endpoint runs caller-supplied SQL, and a shape that must
      // fully materialise would otherwise block the daemon's only thread.
      res.json(await queryTracesBounded(body.sql, {
        limit: typeof body.limit === "number" ? body.limit : undefined,
        maxBytes: typeof body.max_bytes === "number" ? body.max_bytes : undefined,
      }));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });
  app.get("/api/ui/connected", (_req, res) => {
    res.json({ connected: hasConnectedUi() });
  });
  app.get("/api/ui/viewing", (_req, res) => {
    const view = viewingRegistry.getMostRecentView();
    if (!view || !view.run_id) { res.status(404).json({ error: "No UI reporting a view" }); return; }
    // Hydrate with the run row + size hints so MCP get_current_run can size the trace upfront.
    // Fall back to the minimal shape if the registry knows the run_id but the row hasn't been
    // inserted yet (race during stream startup). Always include `run_id` so callers don't have
    // to branch on response shape.
    const run = getRunById(view.run_id) as any;
    // Metadata + size hints, never the raw payload columns. This body has exactly
    // one consumer, the MCP get_current_run tool, and getSpanById returned the
    // full input_payload, output_payload and attributes — about 6x the raw
    // payload bytes. On an ordinary agent trace with a 2MB tool result that is a
    // 12MB response, which overruns the MCP stdio 10MB read buffer, desyncs
    // framing and drops the session until the client fully reconnects.
    // get_span_payload is the tool for reading content, in bounded pages.
    const selectedSpan = view.selected_span_id ? getSpanMeta(view.selected_span_id, view.run_id) : null;
    // attributes is the remaining unbounded column: adapters copy the prompt and
    // the response into it, so on the trace above it is still 4MB on its own.
    const selected_span = selectedSpan?.run_id === view.run_id
      ? { ...selectedSpan, attributes: undefined, attributes_chars: selectedSpan.attributes?.length ?? 0 }
      : null;
    if (run) { res.json({ ...run, run_id: view.run_id, selected_span_id: view.selected_span_id, selected_span, ts: view.ts }); return; }
    res.json({ run_id: view.run_id, selected_span_id: view.selected_span_id, selected_span, ts: view.ts });
  });

  app.get("/api/secrets", localOriginGuard, (_req, res) => {
    res.json({ keys: getSecretStatuses() });
  });

  app.put("/api/secrets/:key", localOriginGuard, (req, res) => {
    const key = parseSecretKey(req.params.key);
    if (!key) {
      res.status(404).json({ error: "unknown secret key" });
      return;
    }
    const value = typeof req.body?.value === "string" ? req.body.value.trim() : "";
    if (!value) {
      deleteStoredSecret(key);
      broadcast("secrets_updated", { key, status: getSecretStatus(key) });
      res.json({ key, status: getSecretStatus(key) });
      return;
    }
    setStoredSecret(key, value);
    broadcast("secrets_updated", { key, status: getSecretStatus(key) });
    res.json({ key, status: getSecretStatus(key) });
  });

  app.delete("/api/secrets/:key", localOriginGuard, (req, res) => {
    const key = parseSecretKey(req.params.key);
    if (!key) {
      res.status(404).json({ error: "unknown secret key" });
      return;
    }
    deleteStoredSecret(key);
    broadcast("secrets_updated", { key, status: getSecretStatus(key) });
    res.json({ key, status: getSecretStatus(key) });
  });

  app.post("/api/agent-ui/commands", (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const command = canonicalizeAgentUiCommand(body as Record<string, unknown>);
    if (!command) {
      res.status(400).json({ error: "Unknown or ambiguous run_id" });
      return;
    }
    if (
      command.type === "compose_annotation" &&
      typeof command.run_id === "string" &&
      typeof command.note === "string"
    ) {
      try {
        const annotation = createAnnotation({
          run_id: command.run_id,
          span_id: typeof command.span_id === "string" ? command.span_id : null,
          kind: "note",
          note: command.note,
          source: parseAnnotationSource(command.source) ?? agentAnnotationSource(agentProvider),
        });
        broadcast("annotation", {
          op: "insert",
          run_id: annotation.run_id,
          span_id: annotation.span_id,
          annotation,
        });
      } catch {}
    }
    broadcast("agent_ui_command", command);
    res.json({ ok: true, command });
  });
  app.get("/api/spans/:id", (req, res) => {
    // A span id is only unique within its run, so allow callers that know the run
    // to disambiguate. Unscoped resolves to the most recently updated run.
    const runId = typeof req.query.run_id === "string" && req.query.run_id ? req.query.run_id : undefined;
    const row = getSpanMeta(req.params.id, runId) as any;
    if (!row) { res.status(404).json({ error: "Span not found" }); return; }
    const { input_head, output_head, input_chars, output_chars, ...rest } = row;
    res.json({
      ...rest,
      input_chars,
      output_chars,
      input_preview: input_chars > 80 ? input_head.slice(0, 80) + "…" : input_head,
      output_preview: output_chars > 80 ? output_head.slice(0, 80) + "…" : output_head,
    });
  });
  app.get("/api/spans/:id/payload", (req, res) => {
    const target = req.query.target;
    if (target !== "input" && target !== "output") {
      res.status(400).json({ error: "target must be input or output" }); return;
    }
    const runId = typeof req.query.run_id === "string" && req.query.run_id ? req.query.run_id : undefined;
    const payload = getSpanPayloadColumn(req.params.id, target, runId);
    if (payload === null) { res.status(404).json({ error: "Span not found" }); return; }
    const opts: any = { payload };
    if (typeof req.query.jsonpath === "string" && req.query.jsonpath) opts.jsonpath = req.query.jsonpath;
    if (typeof req.query.max_chars === "string") {
      const n = Number(req.query.max_chars);
      if (!Number.isFinite(n)) {
        res.status(400).json({ error: "max_chars must be a finite number" });
        return;
      }
      opts.maxChars = n;
    }
    if (typeof req.query.format === "string") opts.format = req.query.format;
    if (typeof req.query.range === "string") {
      const [a, b] = req.query.range.split(",").map(Number);
      if (Number.isFinite(a) && Number.isFinite(b)) opts.range = [a, b];
    }
    try {
      const result = sliceSpanPayload(opts);
      res.json({ span_id: req.params.id, target, ...result });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });
  app.get("/api/spans/:id/context", (req, res) => {
    let before: number | undefined;
    let after: number | undefined;
    if (req.query.before !== undefined) {
      const n = Number(req.query.before);
      if (!Number.isFinite(n)) {
        res.status(400).json({ error: "before must be a finite number" }); return;
      }
      before = n;
    }
    if (req.query.after !== undefined) {
      const n = Number(req.query.after);
      if (!Number.isFinite(n)) {
        res.status(400).json({ error: "after must be a finite number" }); return;
      }
      after = n;
    }
    const includeParent = req.query.include_parent !== "false";
    const out = getSpanContext(req.params.id, { before, after, includeParent });
    if (!out) { res.status(404).json({ error: "Span not found" }); return; }
    res.json(out);
  });
  // The same prompt/response text reaches this response three times: the
  // input_payload/output_payload columns, the raw `attributes` blob the adapter
  // read them from, and the `normalized` view built from them. Measured at 3.00x
  // — 2.4MB of payload became a 7.2MB response — for a body the UI fetches on
  // every run open. The payload columns and `normalized` are what render; the
  // oversized attribute copies are not, and their full text stays reachable
  // through get_span_payload.
  const MAX_DETAIL_ATTR_CHARS = 2_000;
  function compactSpanForDetail(span: any): any {
    if (typeof span?.attributes !== "string" || span.attributes.length <= MAX_DETAIL_ATTR_CHARS) return span;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(span.attributes);
    } catch {
      return span;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return span;
    let trimmed = false;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string" || value.length <= MAX_DETAIL_ATTR_CHARS) continue;
      parsed[key] = `${value.slice(0, MAX_DETAIL_ATTR_CHARS)}\u2026 [${value.length.toLocaleString()} chars; read with get_span_payload]`;
      trimmed = true;
    }
    return trimmed ? { ...span, attributes: JSON.stringify(parsed) } : span;
  }

  app.get("/api/convo/:convoId", (req, res) => res.json(getRunsByConvoId(req.params.convoId)));
  // Regex route so run IDs containing ':', '/', or '.' aren't parsed as Express path-param separators
  app.get(/^\/api\/runs\/detail\/(.+)$/, (req, res) => {
    const id = (req.params as unknown as string[])[0];
    const { run, spans } = getRunWithSpans(id);
    if (!run || spans.length === 0) {
      // Fall back to saved run cache
      const cached = getCachedRun(id);
      if (cached) {
        try { const data = JSON.parse(cached); if (data.run) { res.json(data); return; } } catch {}
      }
      if (!run) { res.status(404).json({ error: "Not found" }); return; }
    }
    const subAgents = detectSubAgents(spans as any);
    res.json({ run, spans: spans.map(compactSpanForDetail), liveEvents: getLiveEvents(id), subAgents });
  });
  app.get("/api/runs/:id/outline", (req, res) => {
    const previewRaw = Number(req.query.payload_preview_chars ?? 80);
    const preview = Number.isFinite(previewRaw) ? previewRaw : 80;
    const out = getRunOutline(req.params.id, preview);
    if (!out.run) { res.status(404).json({ error: "Not found" }); return; }
    res.json(out);
  });
  app.get("/api/runs/:id/spans", (req, res) => {
    const opts: any = { filter: {} };
    for (const k of ["span_type", "status", "name", "name_regex", "model", "parent_span_id", "has_payload_match"]) {
      const v = req.query[k];
      if (typeof v === "string" && v) opts.filter[k] = v;
    }
    // Number("abc") is NaN, and NaN bound to a SQL parameter fails as
    // "SQLiteError: datatype mismatch" — a 500 for what is really a bad request.
    // Every other numeric query param in this file is Number.isFinite-guarded;
    // these two loops were the exception.
    for (const k of ["min_duration_ms", "min_tokens"]) {
      const n = Number(req.query[k]);
      if (typeof req.query[k] === "string" && req.query[k] && Number.isFinite(n)) {
        opts.filter[k] = n;
      }
    }
    // Finite is not enough: SQLite binds these as integers, so 1.5 and 1e20 both
    // reach it as "datatype mismatch" — a raw engine error surfacing for what is
    // plainly a bad query string. Floor and clamp to a bindable range instead.
    for (const k of ["limit", "offset", "payload_preview_chars"]) {
      const raw = req.query[k];
      if (typeof raw !== "string" || !raw) continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        res.status(400).json({ error: `${k} must be a finite number` });
        return;
      }
      opts[k] = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(n)));
    }
    const sort = req.query.sort;
    if (typeof sort === "string") opts.sort = sort;
    let spans;
    try {
      spans = listSpansFiltered(req.params.id, opts);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    // The result is capped, and the bare array gave a caller no way to tell a
    // complete run from a truncated page. Headers keep the array contract intact
    // for existing consumers while making the truncation visible.
    const total = countSpansFiltered(req.params.id, opts);
    res.setHeader("X-Total-Count", String(total));
    res.setHeader("X-Result-Truncated", String(spans.length < total));
    res.json(spans);
  });
  app.get("/api/runs/:id/search", (req, res) => {
    const pattern = req.query.pattern;
    if (typeof pattern !== "string" || !pattern) {
      res.status(400).json({ error: "pattern required" }); return;
    }
    const opts: any = { pattern };
    if (req.query.regex === "true") opts.regex = true;
    if (req.query.case_sensitive === "true") opts.case_sensitive = true;
    if (typeof req.query.scope === "string" && req.query.scope) opts.scope = req.query.scope.split(",");
    if (typeof req.query.span_type === "string") opts.span_type = req.query.span_type;
    if (typeof req.query.context_chars === "string") {
      const n = Number(req.query.context_chars);
      if (!Number.isFinite(n)) {
        res.status(400).json({ error: "context_chars must be a finite number" });
        return;
      }
      opts.context_chars = n;
    }
    if (typeof req.query.max_matches === "string") {
      const n = Number(req.query.max_matches);
      if (!Number.isFinite(n)) {
        res.status(400).json({ error: "max_matches must be a finite number" });
        return;
      }
      opts.max_matches = n;
    }
    try { res.json(searchRun(req.params.id, opts)); }
    catch (err: any) { res.status(400).json({ error: err.message }); }
  });
  app.get("/api/runs/:id/events", (req, res) => {
    const opts: any = {};
    if (typeof req.query.after_id === "string") {
      const n = Number(req.query.after_id);
      if (!Number.isFinite(n)) {
        res.status(400).json({ error: "after_id must be a finite number" });
        return;
      }
      opts.after_id = n;
    }
    if (typeof req.query.types === "string" && req.query.types) opts.types = req.query.types.split(",");
    if (typeof req.query.limit === "string") {
      const n = Number(req.query.limit);
      if (!Number.isFinite(n)) {
        res.status(400).json({ error: "limit must be a finite number" });
        return;
      }
      opts.limit = n;
    }
    res.json(tailLiveEvents(req.params.id, opts));
  });
  app.post("/api/clear", (_req, res) => {
    evaluations.reset();
    for (const id of verification.bridge.sessions.keys()) verification.bridge.remove(id);
    clearAll(); broadcast("clear", {}); res.json({ ok: true });
  });

  app.get("/api/workspace/active", (_req, res) => {
    const workspace = getActiveWorkspace();
    if (!workspace) {
      res.status(404).json({ error: ACTIVE_WORKSPACE_MISSING_MESSAGE });
      return;
    }
    res.json(workspace);
  });

  app.get("/api/workspace/registered", (_req, res) => {
    const active = getActiveWorkspace();
    const byCwd = new Map<string, { cwd: string; agents: string[]; active: boolean }>();
    const add = (cwd: string | null | undefined, agent?: string) => {
      if (!cwd || !path.isAbsolute(cwd)) return;
      try {
        if (!fs.statSync(cwd).isDirectory()) return;
      } catch {
        return;
      }
      const existing = byCwd.get(cwd) ?? { cwd, agents: [], active: active?.cwd === cwd };
      if (agent && !existing.agents.includes(agent)) existing.agents.push(agent);
      existing.active = active?.cwd === cwd;
      byCwd.set(cwd, existing);
    };

    if (active) add(active.cwd);
    try {
      for (const entry of loadInstallRegistry().installs) {
        if (entry.scope === "local") add(entry.cwd, entry.agent);
      }
    } catch {
      // Keep the selector usable even if the optional install registry is unreadable.
    }

    res.json({
      workspaces: [...byCwd.values()].sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return a.cwd.localeCompare(b.cwd);
      }),
    });
  });

  app.get("/api/directories", localOriginGuard, (req, res) => {
    const requestedPath = typeof req.query.path === "string" && req.query.path.trim()
      ? req.query.path
      : getActiveWorkspace()?.cwd ?? os.homedir();
    try {
      const currentPath = resolveDirectory(requestedPath);
      const parent = path.dirname(currentPath);
      res.json({
        path: currentPath,
        parent: parent === currentPath ? null : parent,
        home: os.homedir(),
        entries: listSubdirectories(currentPath),
      });
    } catch {
      // Raw fs errors carry the absolute path being stat'd; don't reflect them.
      res.status(400).json({ error: "directory not found" });
    }
  });

  app.post("/api/workspace/active", (req, res) => {
    const cwd = (req.body as Record<string, unknown> | null)?.cwd;
    if (typeof cwd !== "string" || !cwd.trim()) {
      res.status(400).json({ error: "cwd required" });
      return;
    }
    try {
      const workspace = setActiveWorkspace(cwd);
      registerReplayProjectIfPresent(workspace.cwd).catch((err) => {
        console.warn("[runphantom] failed to refresh replay project registration:", err);
      });
      try {
        latestClaudeLoadout = getLatestClaudeLoadout(workspace.cwd);
      } catch (err) {
        latestClaudeLoadout = null;
        console.warn("[runphantom] failed to load Claude loadout for active workspace:", err);
      }
      broadcast("workspace_changed", workspace);
      res.json(workspace);
    } catch {
      // Raw fs errors carry the absolute path being stat'd; don't reflect them.
      res.status(400).json({ error: "workspace directory not found" });
    }
  });

  app.get("/api/agent/provider", (_req, res) => {
    res.json({ provider: agentProvider });
  });

  app.post("/api/agent/provider", (req, res) => {
    const provider = parseAgentProvider((req.body as Record<string, unknown> | null)?.provider);
    if (!provider) {
      res.status(400).json({ error: "provider must be 'claude' or 'codex'" });
      return;
    }
    agentProvider = setAgentProvider(provider);
    broadcast("agent_provider", { provider: agentProvider });
    const workspace = getActiveWorkspace();
    if (workspace) broadcast("agent_loadout", currentLoadout(workspace.cwd));
    res.json({ provider: agentProvider });
  });

  app.get("/api/agent/sessions", (req, res) => {
    const cwd = cwdFromRequestOrActive(req, res);
    if (!cwd) return;
    const requestedProvider = req.query.provider === undefined
      ? null
      : parseAgentProvider(req.query.provider);
    if (req.query.provider !== undefined && !requestedProvider) {
      res.status(400).json({ error: "provider must be 'claude' or 'codex'" });
      return;
    }
    const targetProvider = requestedProvider ?? agentProvider;
    void listAgentSessions(targetProvider, cwd)
      .then(({ sessions, stale }) => {
        res.setHeader("X-Sessions-Stale", String(stale));
        res.json(sessions);
      })
      .catch((err) => {
        console.error("[runphantom] session listing failed:", err);
        res.status(503).json({ error: `could not list ${targetProvider} sessions: ${(err as Error).message}` });
      });
  });

  app.get("/api/agent/loadout", (req, res) => {
    const cwd = cwdFromRequestOrActive(req, res);
    if (!cwd) return;
    res.json(currentLoadout(cwd));
  });

  app.get("/api/agent/sessions/:id", (req, res) => {
    const cwd = cwdFromRequestOrActive(req, res);
    if (!cwd) return;
    // The sibling list route honours ?provider=, this one only read the daemon's
    // global provider — so opening a row listed under one provider while the
    // daemon was set to the other looked in the wrong store and 404'd every time.
    const requestedProvider = req.query.provider === undefined
      ? null
      : parseAgentProvider(req.query.provider);
    if (req.query.provider !== undefined && !requestedProvider) {
      res.status(400).json({ error: "provider must be 'claude' or 'codex'" });
      return;
    }
    const targetProvider = requestedProvider ?? agentProvider;
    const session = targetProvider === "codex"
      ? getCodexSession(cwd, req.params.id)
      : getClaudeSession(cwd, req.params.id);
    if (!session) {
      res.status(404).json({ error: `${targetProvider === "codex" ? "Codex" : "Claude"} session not found` });
      return;
    }
    res.json(session);
  });

  app.post("/api/agent/messages", localOriginGuard, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { content, session_id, run_id, client_message_id } = body;
    if (typeof content !== "string" || !content.trim()) {
      res.status(400).json({ error: "content required" });
      return;
    }
    if (session_id != null && typeof session_id !== "string") {
      res.status(400).json({ error: "session_id must be a string" });
      return;
    }
    const requestProvider = agentProvider;
    if (requestProvider === "claude" && !claudeCliChatEnabled) {
      res.status(409).json({ error: "Claude Code chat is disabled" });
      return;
    }
    const cwd = cwdFromRequestOrActive(req, res);
    if (!cwd) return;

    let providerSessionId = typeof session_id === "string" && session_id ? session_id : null;
    // Claude Code owns its resume-token validity. Run Phantom's JSONL reader can
    // miss a valid Claude session when Claude stores it under a normalized
    // project path or before the file is visible here, so pass --resume through
    // and let Claude decide. Codex sessions are local Run Phantom-readable state.
    if (providerSessionId && requestProvider === "codex") {
      const existingSession = getCodexSession(cwd, providerSessionId);
      if (!existingSession) {
        res.status(404).json({ error: `${agentProviderLabel(requestProvider)} session not found for ${cwd}` });
        return;
      }
    }
    const clientMessageId = typeof client_message_id === "string" && client_message_id
      ? client_message_id
      : randomUUID();
    let text = "";
    let errorText = "";
    const events: unknown[] = [];
    const broadcastStreamEvent = (event: unknown) => {
      const data = {
        client_message_id: clientMessageId,
        session_id: providerSessionId,
        provider: requestProvider,
        event,
      };
      broadcast("agent_message_stream", data);
      if (requestProvider === "claude") broadcast("claude_message_stream", data);
    };
    try {
      const chatInput = {
        backendUrl: backendUrl(),
        content,
        cwd,
        runId: typeof run_id === "string" ? run_id : null,
        resumeSessionId: providerSessionId,
      };
      const result = requestProvider === "codex"
        ? await runCodexCliChat(chatInput, {
          onEvent(event) {
            events.push(event);
            broadcastStreamEvent(event);
          },
          onProviderSession(sessionId) {
            providerSessionId = sessionId;
            broadcastStreamEvent({ type: "provider_session", sessionId });
          },
          onText(nextContent) {
            text = nextContent;
            broadcastStreamEvent({ type: "text", content: nextContent });
          },
          onStatus() {},
          onError(nextContent) {
            errorText = nextContent;
            broadcastStreamEvent({ type: "error", content: nextContent });
          },
        })
        : await runClaudeCliChat(chatInput, {
          onEvent(event) {
            events.push(event);
            rememberClaudeLoadout(event);
            broadcastStreamEvent(event);
          },
          onClaudeSession(sessionId) {
            providerSessionId = sessionId;
            broadcastStreamEvent({ type: "provider_session", sessionId });
          },
          onText(nextContent) {
            text = nextContent;
            broadcastStreamEvent({ type: "text", content: nextContent });
          },
          onStatus() {},
          onError(nextContent) {
            errorText = nextContent;
            broadcastStreamEvent({ type: "error", content: nextContent });
          },
        });
      if (result.code !== 0 || errorText) {
        res.status(502).json({
          error: errorText || result.stderr || `${agentProviderLabel(requestProvider)} exited with code ${result.code ?? "unknown"}`,
          client_message_id: clientMessageId,
          session_id: providerSessionId,
          events,
        });
        return;
      }
      res.json({
        client_message_id: clientMessageId,
        session_id: providerSessionId,
        text,
        events,
        session: providerSessionId
          ? requestProvider === "claude"
            ? getClaudeSession(cwd, providerSessionId)
            : getCodexSession(cwd, providerSessionId)
          : null,
      });
    } catch (err) {
      res.status(500).json({
        error: (err as Error).message || `${agentProviderLabel(requestProvider)} chat failed`,
        client_message_id: clientMessageId,
        session_id: providerSessionId,
        events,
      });
    }
  });

  app.get("/api/claude/sessions", (req, res) => {
    const cwd = cwdFromRequestOrActive(req, res);
    if (!cwd) return;
    void listAgentSessions("claude", cwd)
      .then(({ sessions, stale }) => {
        res.setHeader("X-Sessions-Stale", String(stale));
        res.json(sessions);
      })
      .catch((err) => {
        console.error("[runphantom] claude session listing failed:", err);
        res.status(503).json({ error: `could not list claude sessions: ${(err as Error).message}` });
      });
  });

  app.get("/api/claude/loadout", (req, res) => {
    const cwd = cwdFromRequestOrActive(req, res);
    if (!cwd) return;
    if (!latestClaudeLoadout) {
      latestClaudeLoadout = getLatestClaudeLoadout(cwd);
    }
    res.json(latestClaudeLoadout ?? { tools: [], mcps: [], skills: [], plugins: [], slash_commands: [] });
  });

  app.get("/api/claude/sessions/:id", (req, res) => {
    const cwd = cwdFromRequestOrActive(req, res);
    if (!cwd) return;
    const session = getClaudeSession(cwd, req.params.id);
    if (!session) {
      res.status(404).json({ error: "Claude session not found" });
      return;
    }
    res.json(session);
  });

  app.post("/api/claude/ask-user-question/hook", async (req, res) => {
    const hookInput = parseAskUserQuestionHookInput(req.body);
    if (!hookInput) {
      res.status(400).json({ error: "AskUserQuestion tool_input.questions required" });
      return;
    }

    const answers = await askUserQuestions.ask(hookInput);
    res.json(answers
      ? askUserQuestionAllow(hookInput.toolInput, answers)
      : askUserQuestionDeny("Run Phantom closed before the question was answered."));
  });

  app.post("/api/claude/ask-user-question/:id/answer", (req, res) => {
    const answers = parseAnswerMap((req.body as Record<string, unknown> | null)?.answers);
    if (!answers) {
      res.status(400).json({ error: "answers must be a non-empty string map" });
      return;
    }
    if (!askUserQuestions.answer(req.params.id, answers)) {
      res.status(404).json({ error: "pending question not found" });
      return;
    }
    res.json({ ok: true });
  });

  app.post("/api/claude/messages", localOriginGuard, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { content, session_id, run_id, client_message_id } = body;
    if (typeof content !== "string" || !content.trim()) {
      res.status(400).json({ error: "content required" });
      return;
    }
    if (session_id != null && typeof session_id !== "string") {
      res.status(400).json({ error: "session_id must be a string" });
      return;
    }
    if (!claudeCliChatEnabled) {
      res.status(409).json({ error: "Claude Code chat is disabled" });
      return;
    }
    const cwd = cwdFromRequestOrActive(req, res);
    if (!cwd) return;

    let claudeSessionId = typeof session_id === "string" && session_id ? session_id : null;
    const clientMessageId = typeof client_message_id === "string" && client_message_id
      ? client_message_id
      : randomUUID();
    let text = "";
    let errorText = "";
    const events: unknown[] = [];
    const broadcastStreamEvent = (event: unknown) => {
      broadcast("claude_message_stream", {
        client_message_id: clientMessageId,
        session_id: claudeSessionId,
        event,
      });
    };
    try {
      const result = await runClaudeCliChat(
        {
          backendUrl: backendUrl(),
          content,
          cwd,
          runId: typeof run_id === "string" ? run_id : null,
          resumeSessionId: claudeSessionId,
        },
        {
          onEvent(event) {
            events.push(event);
            rememberClaudeLoadout(event);
            broadcastStreamEvent(event);
          },
          onClaudeSession(sessionId) {
            claudeSessionId = sessionId;
            broadcastStreamEvent({ type: "provider_session", sessionId });
          },
          onText(content) {
            text = content;
            broadcastStreamEvent({ type: "text", content });
          },
          onStatus() {},
          onError(content) {
            errorText = content;
            broadcastStreamEvent({ type: "error", content });
          },
        },
      );
      if (result.code !== 0 || errorText) {
        res.status(502).json({
          error: errorText || result.stderr || `Claude Code exited with code ${result.code ?? "unknown"}`,
          client_message_id: clientMessageId,
          session_id: claudeSessionId,
          events,
        });
        return;
      }
      res.json({
        client_message_id: clientMessageId,
        session_id: claudeSessionId,
        text,
        events,
        session: claudeSessionId ? getClaudeSession(cwd, claudeSessionId) : null,
      });
    } catch (err) {
      res.status(500).json({
        error: (err as Error).message || "Claude Code chat failed",
        client_message_id: clientMessageId,
        session_id: claudeSessionId,
        events,
      });
    }
  });

  app.get("/api/status", (_req, res) => {
    res.json({
      agent_provider: agentProvider,
      agent: {
        provider: agentProvider,
        mode: agentProvider === "codex" ? "codex_exec_stream" : "cli_stream",
        state: agentProvider === "codex" || claudeCliChatEnabled ? "green" : "gray",
      },
      claude_code: {
        mode: "cli_stream",
        state: claudeCliChatEnabled ? "green" : "gray",
      },
      codex: {
        mode: "codex_exec_stream",
        state: "green",
      },
    });
  });

  app.get("/api/models/anthropic", async (req, res) => {
    if (anthropicModelsCache && anthropicModelsCache.expiresAt > Date.now()) {
      res.json({ models: anthropicModelsCache.models, cached: true });
      return;
    }

    const apiKey = getEffectiveSecret("anthropic");
    if (!apiKey) {
      res.json({
        models: anthropicModelsCache?.models ?? [],
        cached: Boolean(anthropicModelsCache?.models?.length),
        configured: false,
        stale: Boolean(anthropicModelsCache?.models?.length),
      });
      return;
    }

    try {
      const resp = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      });
      if (!resp.ok) {
        const err = await resp.text();
        if (anthropicModelsCache?.models?.length) {
          res.json({ models: anthropicModelsCache.models, cached: true, stale: true });
          return;
        }
        res.status(resp.status).json({ error: err || `Anthropic models request failed (${resp.status})` });
        return;
      }

      const payload = await resp.json().catch(() => ({}));
      const rows = Array.isArray((payload as any)?.data)
        ? (payload as any).data
        : Array.isArray((payload as any)?.models)
          ? (payload as any).models
          : [];
      const models = rows
        .map((m: any) => (typeof m?.id === "string" ? m.id : null))
        .filter((id: string | null): id is string => !!id)
        .sort((a: string, b: string) => a.localeCompare(b));

      if (models.length === 0) {
        if (anthropicModelsCache?.models?.length) {
          res.json({ models: anthropicModelsCache.models, cached: true, stale: true });
          return;
        }
        res.status(502).json({ error: "Anthropic models response was empty." });
        return;
      }

      anthropicModelsCache = {
        expiresAt: Date.now() + ANTHROPIC_MODELS_CACHE_TTL_MS,
        models,
      };
      res.json({ models, cached: false });
    } catch (err: any) {
      if (anthropicModelsCache?.models?.length) {
        res.json({ models: anthropicModelsCache.models, cached: true, stale: true });
        return;
      }
      res.status(500).json({ error: err?.message ?? "Failed to fetch Anthropic models." });
    }
  });

  app.get("/api/annotations", (req, res) => {
    const runId = req.query.run_id;
    if (typeof runId !== "string" || !runId) {
      res.status(400).json({ error: "run_id required" });
      return;
    }
    res.json(getAnnotationsByRun(runId));
  });

  app.post("/api/annotations", (req, res) => {
    const body = (req.body ?? {}) as {
      run_id?: unknown;
      span_id?: unknown;
      kind?: unknown;
      note?: unknown;
      source?: unknown;
    };
    if (typeof body.run_id !== "string" || !body.run_id) {
      res.status(400).json({ error: "run_id required" });
      return;
    }
    if (typeof body.kind !== "string") {
      res.status(400).json({ error: "kind required" });
      return;
    }
    if (typeof body.source !== "string") {
      res.status(400).json({ error: "source required" });
      return;
    }
    // These used to be coerced to null on a type mismatch, so a caller that sent
    // span_id: 123 got a run-level annotation and one that sent an object note
    // got an empty one — both with 201. The write looked accepted and the content
    // was gone.
    if (body.span_id !== undefined && body.span_id !== null && typeof body.span_id !== "string") {
      res.status(400).json({ error: "span_id must be a string when provided" });
      return;
    }
    if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
      res.status(400).json({ error: "note must be a string when provided" });
      return;
    }
    try {
      const annotation = createAnnotation({
        run_id: body.run_id,
        span_id: typeof body.span_id === "string" ? body.span_id : null,
        kind: body.kind as AnnotationKind,
        note: typeof body.note === "string" ? body.note : null,
        source: body.source as AnnotationSource,
      });
      broadcast("annotation", {
        op: "insert",
        run_id: annotation.run_id,
        span_id: annotation.span_id,
        annotation,
      });
      res.status(201).json(annotation);
    } catch (err) {
      if (err instanceof InvalidAnnotationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.delete("/api/annotations/:id", (req, res) => {
    try {
      const removed = deleteAnnotation(req.params.id);
      broadcast("annotation", {
        op: "delete",
        run_id: removed.run_id,
        span_id: removed.span_id,
        annotation: removed,
      });
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof AnnotationNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.delete("/api/runs/:id", (req, res) => {
    try {
      deleteRun(req.params.id);
      broadcast("spans", { runIds: [req.params.id] });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.patch("/api/runs/:id", (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.name !== "string") {
      res.status(400).json({ error: "name must be a string" });
      return;
    }
    const name = body.name.trim();
    if (name.length > 200) {
      res.status(400).json({ error: "name must be 200 characters or fewer" });
      return;
    }
    if (!getRunById(req.params.id)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    setRunDisplayName(req.params.id, name || null);
    broadcast("spans", { runIds: [req.params.id] });
    res.json({ ok: true });
  });

  // Saved run cache — persists across clears
  app.put(/^\/api\/saved-runs\/cache\/(.+)$/, (req, res) => {
    const id = (req.params as unknown as string[])[0];
    cacheSavedRun(id, JSON.stringify(req.body));
    res.json({ ok: true });
  });
  app.get(/^\/api\/saved-runs\/cache\/(.+)$/, (req, res) => {
    const id = (req.params as unknown as string[])[0];
    const data = getCachedRun(id);
    if (!data) { res.status(404).json({ error: "Not cached" }); return; }
    res.json(JSON.parse(data));
  });
  app.delete(/^\/api\/saved-runs\/cache\/(.+)$/, (req, res) => {
    const id = (req.params as unknown as string[])[0];
    deleteCachedRun(id);
    res.json({ ok: true });
  });

  // Saved events index + folders — server-side store so saves are visible
  // across browsers (Cursor, Chrome, …) hitting the same Run Phantom instance.
  app.get("/api/saved-runs", (_req, res) => {
    res.json({ events: listSavedEvents(), folders: listSavedFolders() });
  });

  app.get("/api/saved-runs/folders", (_req, res) => {
    res.json({ folders: listSavedFolders() });
  });

  app.post("/api/saved-runs/folders", (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const color = typeof req.body?.color === "string" ? req.body.color : undefined;
    if (!name) { res.status(400).json({ error: "name required" }); return; }
    if (name.length > 200) { res.status(400).json({ error: "name too long" }); return; }
    res.json({ folder: ensureSavedFolder(name, color) });
  });

  app.delete(/^\/api\/saved-runs\/folders\/(.+)$/, (req, res) => {
    // Express already percent-decodes regex captures. Decoding again throws on any
    // name that legitimately contains '%' (i.e. was sent as %25), so treat a failed
    // second decode as "already decoded" rather than letting URIError escape.
    const raw = (req.params as unknown as string[])[0];
    let name: string;
    try {
      name = decodeURIComponent(raw);
    } catch {
      name = raw;
    }
    deleteSavedFolder(name);
    res.json({ ok: true });
  });

  app.get(/^\/api\/saved-runs\/events\/(.+)$/, (req, res) => {
    const id = (req.params as unknown as string[])[0];
    const event = getSavedEvent(id);
    if (!event) { res.status(404).json({ error: "Not saved" }); return; }
    res.json({ event });
  });

  app.put(/^\/api\/saved-runs\/events\/(.+)$/, (req, res) => {
    const id = (req.params as unknown as string[])[0];
    const body = req.body ?? {};
    if (typeof body !== "object") { res.status(400).json({ error: "body required" }); return; }
    if (typeof body.event_name !== "string" || !body.event_name) {
      res.status(400).json({ error: "event_name required" }); return;
    }
    if (typeof body.timestamp !== "string" || !body.timestamp) {
      res.status(400).json({ error: "timestamp required" }); return;
    }
    // These went into the row with a bare `?? null`, so an object or array
    // reached the driver as an unbindable value and surfaced as a 500.
    for (const field of ["user_id", "convo_id", "user_input", "assistant_output", "summary"] as const) {
      const value = body[field];
      if (value !== undefined && value !== null && typeof value !== "string") {
        res.status(400).json({ error: `${field} must be a string when provided` });
        return;
      }
    }
    const event: SavedEventRow = {
      id,
      event_name: body.event_name,
      user_id: body.user_id ?? null,
      convo_id: body.convo_id ?? null,
      timestamp: body.timestamp,
      user_input: body.user_input ?? null,
      assistant_output: body.assistant_output ?? null,
      signals: Array.isArray(body.signals) ? body.signals : null,
      properties: body.properties && typeof body.properties === "object" ? body.properties : null,
      saved_at: typeof body.saved_at === "number" ? body.saved_at : Date.now(),
      summary: body.summary ?? null,
      source: body.source === "local" ? body.source : null,
      folder: typeof body.folder === "string" && body.folder ? body.folder : null,
    };
    upsertSavedEvent(event);
    if (event.folder) ensureSavedFolder(event.folder);
    res.json({ event });
  });

  app.patch(/^\/api\/saved-runs\/events\/(.+)$/, (req, res) => {
    const id = (req.params as unknown as string[])[0];
    const body = req.body ?? {};
    const patch: Partial<Omit<SavedEventRow, "id">> = {};
    if (Object.prototype.hasOwnProperty.call(body, "folder")) {
      patch.folder = typeof body.folder === "string" && body.folder ? body.folder : null;
    }
    if (typeof body.summary === "string") patch.summary = body.summary;
    if (typeof body.user_input === "string") patch.user_input = body.user_input;
    if (typeof body.assistant_output === "string") patch.assistant_output = body.assistant_output;
    if (typeof body.saved_at === "number") patch.saved_at = body.saved_at;
    if (body.properties && typeof body.properties === "object" && !Array.isArray(body.properties)) {
      patch.properties = body.properties;
    }
    const event = patchSavedEvent(id, patch);
    if (!event) { res.status(404).json({ error: "Not saved" }); return; }
    if (event.folder) ensureSavedFolder(event.folder);
    res.json({ event });
  });

  app.delete(/^\/api\/saved-runs\/events\/(.+)$/, (req, res) => {
    const id = (req.params as unknown as string[])[0];
    deleteSavedEvent(id);
    deleteCachedRun(id);
    res.json({ ok: true });
  });

  app.get("/api/runs/:id/export", (req, res) => {
    try {
      const trace = exportTrace(req.params.id);
      if (!trace) { res.status(404).json({ error: "Not found" }); return; }
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`trace-${req.params.id}.json`)}`);
      res.json(trace);
    } catch (error) {
      if (error instanceof InvalidTraceImportError) { res.status(413).json({ error: error.message }); return; }
      res.status(500).json({ error: "Could not export trace" });
    }
  });

  app.post("/api/import-run", (req, res) => {
    try {
      const imported = importTrace(req.body);
      broadcast("spans", { runIds: [imported.runId] });
      res.json({ ok: true, ...imported });
    } catch (error) {
      const message = error instanceof InvalidTraceImportError || error instanceof InvalidAnnotationError
        ? error.message : "stored data conflicts with imported trace";
      res.status(400).json({ error: `import rejected: ${message}` });
    }
  });

  // Summarize an event using Haiku (server-side to avoid CORS)
  app.post("/api/summarize", async (req, res) => {
    const { content } = req.body;
    if (typeof content !== "string" || content.trim().length === 0) {
      res.json({ summary: null, available: false, reason: "empty_content" });
      return;
    }
    const key = getEffectiveSecret("anthropic");
    if (!key) {
      res.json({ summary: null, available: false, reason: "missing_provider_key" });
      return;
    }
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 200,
          system: "Summarize this AI agent interaction in 1-2 sentences. Focus on what user asked and what happened (tools used, outcome). Be specific and brief. Avoid unnecessary articles like 'the', 'a', 'an' — write in a terse, telegraphic style. If the trace is sparse or incomplete, summarize whatever is present in one short phrase; NEVER ask for more information or reply with a request for clarification.",
          messages: [{ role: "user", content }],
        }),
      });
      if (!r.ok) {
        res.json({ summary: null, available: false, reason: "provider_error" });
        return;
      }
      const data = await r.json();
      const text = data.content?.find((b: any) => b.type === "text")?.text?.trim() ?? "";
      res.json({ summary: text });
    } catch {
      res.json({ summary: null, available: false, reason: "provider_unavailable" });
    }
  });

  app.get("/api/agents", async (_req, res) => {
    const discovered = await discoverReplayAgents();
    res.json({ ...loadAgentsConfig(), ...discovered });
  });

  app.put("/api/agents", (req, res) => {
    try {
      const agents = saveAgentsConfig(req.body);
      // Notify any open Run Phantom UIs that the registry changed so the
      // "Local Agent" replay button un-greys without a page reload.
      broadcast("agents_updated", { agents });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/agents/refresh", async (_req, res) => {
    await discoverReplayAgents();
    const agents = loadAgentsConfig();
    broadcast("agents_updated", { agents });
    res.json({ ok: true, agents });
  });

  // Proxy health check for agent endpoints (avoids CORS issues from browser)
  async function probeAgentHealth(): Promise<Record<string, "online" | "offline">> {
    const discovered = await discoverReplayAgents();
    const agents = { ...loadAgentsConfig(), ...discovered };
    const results: Record<string, "online" | "offline"> = {};
    await Promise.all(
      Object.entries(agents).map(async ([name, config]) => {
        // discoverReplayAgents only returns agents that just responded healthy.
        if (discovered[name]) { results[name] = "online"; return; }
        if (!config.url) { results[name] = "offline"; return; }
        const base = config.url.replace(/\/replay\/?$/, "");
        try {
          const resp = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
          results[name] = resp.ok ? "online" : "offline";
        } catch {
          results[name] = "offline";
        }
      })
    );
    return results;
  }

  app.get("/api/agents/health", async (_req, res) => {
    res.json(await probeAgentHealth());
  });

  app.post("/api/agents/ask", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) {
      res.status(400).json({ status: "invalid_request", error: "question is required" });
      return;
    }

    const requestedRunId = typeof body.run_id === "string"
      ? body.run_id
      : typeof body.runId === "string"
        ? body.runId
        : null;
    const runId = requestedRunId ? resolveRunId(requestedRunId) : getMostRecentlyTouchedRun()?.id;
    if (!runId) {
      res.status(404).json({ status: "missing_run", error: "No Run Phantom trace is selected or available." });
      return;
    }

    const { run, spans } = getRunWithSpans(runId);
    if (!run) {
      res.status(404).json({ status: "missing_run", run_id: runId, error: "Run not found." });
      return;
    }

    const workspace = getActiveWorkspace();
    const continuation = extractAgentAskContinuation(spans);
    if (!continuation) {
      res.json({
        status: "missing_context",
        run_id: runId,
        cwd: workspace?.cwd ?? null,
        message: "This run does not include an LLM input payload that Run Phantom can continue.",
      });
      return;
    }

    const requestedModel = typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : null;
    const model = requestedModel ?? continuation.model ?? "claude-sonnet-5";
    const provider = requestedModel
      ? detectProvider(requestedModel)
      : detectProvider(model, continuation.provider);
    if (!isSupportedProvider(provider)) {
      res.status(422).json({
        status: "unsupported_provider",
        run_id: runId,
        provider,
        model,
        message: `Run Phantom cannot continue runs from provider "${provider}".`,
      });
      return;
    }
    const changingProvider = requestedModel !== null
      && provider !== detectProvider(continuation.model, continuation.provider);
    const providerMessages = continuation.messages.map((message) => changingProvider
      ? cleanCrossProviderTextMessage(message)
      : cleanProviderMessage(message));
    if (providerMessages.some((message) => message === null)) {
      res.status(422).json({
        status: "unsupported_context", run_id: runId, provider, model,
        message: "Switching providers requires captured text messages. This trace contains provider-specific tool, image, or reasoning content; choose a model from the original provider or a trace with text-only context.",
      });
      return;
    }
    const env = providerEnvForProvider(provider);
    const apiKey = provider === "openai"
      ? getEffectiveSecret("openai")
      : getEffectiveSecret("anthropic");

    if (!apiKey) {
      res.json({
        status: "missing_provider_key",
        run_id: runId,
        provider,
        env_var: env.envVar,
        cwd: workspace?.cwd ?? null,
        message: `Add a ${provider === "openai" ? "OpenAI" : "Anthropic"} API key in Run Phantom Settings, or set ${env.envVar}=... and restart Run Phantom.`,
      });
      return;
    }

    const framedQuestion = buildAgentAskQuestion({ question, run, spans });
    const contextMessages = [
      ...providerMessages,
      cleanProviderMessage({ role: "user", content: framedQuestion }),
    ];

    const requestBody: Record<string, any> = {
      model,
      stream: false,
    };
    if (provider === "openai") {
      requestBody.messages = [
        { role: "system", content: continuation.systemPrompt },
        ...contextMessages,
      ];
      requestBody.max_completion_tokens = 4096;
    } else {
      requestBody.system = continuation.systemPrompt;
      requestBody.messages = contextMessages;
      requestBody.max_tokens = 4096;
    }

    try {
      const apiHeaders = getProviderHeaders(provider, apiKey);

      const agentRes = await fetch(getProviderBaseURL(provider, null), {
        method: "POST",
        headers: apiHeaders,
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify(requestBody),
      });

      const responseText = await agentRes.text();
      const responseBody = parseJsonObject(responseText);
      if (!agentRes.ok) {
        res.json({
          status: "provider_error",
          run_id: runId,
          provider,
          model,
          message: answerFromProviderResponse(responseBody, responseText) || `Provider returned ${agentRes.status}.`,
        });
        return;
      }

      res.json({
        status: "answered",
        run_id: runId,
        provider,
        model,
        answer: answerFromProviderResponse(responseBody, responseText),
      });
    } catch (err) {
      res.json({
        status: "provider_error",
        run_id: runId,
        provider,
        model,
        message: (err as Error).message,
      });
    }
  });

  // Resolve agent context from a trace — returns the key/value pairs that would be sent to the agent
  app.post("/api/replay/context", (req, res) => {
    const { runId, eventName } = req.body;
    // Both are used as strings below — eventName in a .replace(), runId as a
    // lookup key — so a non-string threw a TypeError and surfaced as a 500 for
    // what is plainly a malformed request.
    if (typeof runId !== "string" || !runId) {
      res.status(400).json({ error: "runId must be a non-empty string" });
      return;
    }
    if (eventName !== undefined && eventName !== null && typeof eventName !== "string") {
      res.status(400).json({ error: "eventName must be a string when provided" });
      return;
    }
    const agents = loadAgentsConfig();
    const name = (eventName ?? "").replace(/^replay:/, "");
    const agentConfig = agents[name];
    const mapping = agentConfig?.prefillFromTrace;
    if (!mapping) { res.json({ context: {}, mapping: {} }); return; }
    const { spans } = getRunWithSpans(runId);
    const context = extractContextFromTrace(spans, mapping);
    res.json({ context, mapping });
  });

  // Replay endpoint
  app.post("/api/replay", async (req, res) => {
    const { runId, userMessage, model, systemPrompt, maxIterations, contextOverrides } = req.body;
    // An object or array runId reached SQLite and came back as an unhandled
    // driver error, reported to the UI as the opaque "replay_internal_error".
    if (typeof runId !== "string" || !runId) {
      res.status(400).json({ error: "runId must be a non-empty string" });
      return;
    }
    for (const [field, value] of Object.entries({ userMessage, model, systemPrompt })) {
      if (value !== undefined && value !== null && typeof value !== "string") {
        res.status(400).json({ error: `${field} must be a string when provided` });
        return;
      }
    }
    if (maxIterations !== undefined && maxIterations !== null &&
        (typeof maxIterations !== "number" || !Number.isFinite(maxIterations))) {
      res.status(400).json({ error: "maxIterations must be a finite number when provided" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    const lifecycle = createReplayAbortLifecycle(req, res);

    try {
      await runReplay(
        {
          sourceRunId: runId,
          mode: "local",
          userMessage,
          model,
          systemPrompt,
          apiKey: getEffectiveSecret("anthropic") ?? undefined,
          openaiKey: getEffectiveSecret("openai") ?? undefined,
          maxIterations,
          contextOverrides,
        },
        res,
        broadcast,
        { signal: lifecycle.controller.signal },
      );
    } catch (err) {
      if (lifecycle.controller.signal.aborted) return;
      console.error("[runphantom] Replay error:", err);
      if (!res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify({ type: "error", code: "replay_internal_error", message: "Replay failed unexpectedly." })}\n\n`);
        res.end();
      }
    } finally {
      lifecycle.cleanup();
    }
  });

  // Serve built Vite UI (skip if debugger UI dev server is running separately)
  let spaIndexPath: string | null = null;
  if (!process.env.RUNPHANTOM_DEV) {
    const builtAppDir = await resolveBuiltAppDir();
    spaIndexPath = path.join(builtAppDir, "index.html");
    app.use(express.static(builtAppDir));
    // An unmatched /api/ path is a client error, not a page. Without this it fell
    // through to the SPA catch-all below and answered 200 + index.html, so a typo'd
    // endpoint looked like a success and JSON.parse failed somewhere far away.
    app.all("/api/*", (_req, res) => {
      res.status(404).json({ error: "not found" });
    });
    app.get("*", (_req, res) => res.sendFile(spaIndexPath!));
    // Any other verb on an unknown path. Express's built-in fallback answers with
    // an HTML page naming the method and path, which is the one response shape on
    // this daemon that is neither the SPA nor JSON.
    app.all("*", (_req, res) => {
      res.status(404).json({ error: "not found" });
    });
  }

  // Terminal error handler. MUST be last: Express only routes errors to middleware
  // registered after the throwing handler, so an identical guard higher in the stack
  // does not cover route bodies. Without this, any uncaught route error renders
  // Express's default HTML page, leaking absolute paths and the OS username.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (!err) return next();
    if (res.headersSent) return next(err);
    // ENAMETOOLONG comes from the static-file middleware stat'ing a URL longer
    // than the filesystem allows. That is an unroutable URL, not a server fault,
    // and it was reported as 500 on a page that then rendered perfectly well —
    // so a browser and any uptime check saw a hard error for a working load.
    const code = (err as { code?: string }).code;
    const status = code === "ENAMETOOLONG" || code === "ENOENT"
      ? 404
      : (err as { status?: number; statusCode?: number }).status
        ?? (err as { statusCode?: number }).statusCode
        ?? (err instanceof URIError || err instanceof SyntaxError ? 400 : 500);
    if (status >= 500) console.error("[runphantom] unhandled request error:", err);
    // A browser navigating to a malformed deep link (a bookmark with a stray `%`,
    // say) fails Express's own path decoding before any route matches. Answering
    // that with JSON shows the user raw `{"error":...}` instead of the app, so
    // serve the SPA and let the client router render its not-found state. API
    // clients still get JSON.
    const wantsHtml = req.method === "GET"
      && !req.path.startsWith("/api/")
      && (req.headers.accept ?? "").includes("text/html");
    if (wantsHtml && spaIndexPath) {
      // 200: the document that follows is the app, and it loads and routes fine.
      // The client renders its own not-found state for an id it cannot resolve.
      return res.status(200).sendFile(spaIndexPath, (sendErr) => {
        if (sendErr && !res.headersSent) res.status(status).json({ error: "invalid request" });
      });
    }
    res.status(status).json({ error: status >= 500 ? "request failed" : "invalid request" });
  });

  return {
    app,
    server,
    get port() {
      return currentServerPort() ?? port;
    },
  };
}

export const _serverInternal = { createReplayAbortLifecycle, extractAgentAskContinuation };

function parseJsonObject(text: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : null;
  } catch {
    return null;
  }
}

type AgentAskContinuation = {
  systemPrompt: string;
  messages: any[];
  model: string | null;
  provider: string | null;
};

function buildAgentAskQuestion(input: { question: string; run: any; spans: any[] }): string {
  const traceContext = buildAgentAskTraceContext(input.run, input.spans);
  return [
    "You are being asked a follow-up question after one of your completed agent runs.",
    "Run Phantom captured the trace below. Use it as context to reflect on what happened in your run.",
    "If the user asks why you called a tool, what a tool did, or which tool was most useful/fun, answer from the trace evidence instead of saying you lack context.",
    "For subjective wording like \"fun\", interpret it as the tool that seemed most satisfying, useful, or high-leverage in the run.",
    "",
    "TRACE CONTEXT:",
    traceContext,
    "",
    "USER QUESTION:",
    input.question,
  ].join("\n");
}

function buildAgentAskTraceContext(run: any, spans: any[]): string {
  const lines: string[] = [
    `run_id: ${run?.id ?? "unknown"}`,
    `event_name: ${run?.event_name ?? run?.name ?? "unknown"}`,
    `span_count: ${spans.length}`,
  ];
  const toolSpans = spans.filter((span) => span?.span_type === "TOOL_CALL").slice(0, 20);
  const llmSpans = spans.filter((span) => span?.span_type?.includes("LLM")).slice(0, 10);
  if (toolSpans.length > 0) {
    lines.push("", "tools:");
    for (const span of toolSpans) {
      lines.push(`- ${span.name ?? span.id ?? "tool"} (${span.status ?? "unknown"}, ${span.duration_ms ?? 0}ms)`);
      const inputPreview = previewText(span.input_payload, 140);
      const outputPreview = previewText(span.output_payload, 180);
      if (inputPreview) lines.push(`  input: ${inputPreview}`);
      if (outputPreview) lines.push(`  output: ${outputPreview}`);
    }
  }
  if (llmSpans.length > 0) {
    lines.push("", "llm_spans:");
    for (const span of llmSpans) {
      lines.push(`- ${span.name ?? span.id ?? "llm"} (${span.model ?? "unknown model"})`);
      const outputPreview = previewText(span.output_payload, 180);
      if (outputPreview) lines.push(`  output: ${outputPreview}`);
    }
  }
  return lines.join("\n").slice(0, 12_000);
}

function extractAgentAskContinuation(spans: any[]): AgentAskContinuation | null {
  const llmSpans = spans.filter((s) => s?.span_type?.includes("LLM") && s.input_payload);
  let selected = llmSpans[0];
  for (const span of llmSpans.slice(1)) {
    if ((span.input_payload?.length ?? 0) > (selected.input_payload?.length ?? 0)) {
      selected = span;
    }
  }

  if (!selected?.input_payload) return null;

  let systemPrompt = "You are a helpful assistant.";
  let messages: any[] = [];
  try {
    const parsed = JSON.parse(selected.input_payload);
    if (Array.isArray(parsed)) {
      const systemMessages: string[] = [];
      for (const message of parsed) {
        if (message?.role === "system") {
          systemMessages.push(contentToText(message.content));
        } else {
          messages.push(message);
        }
      }
      if (systemMessages.length > 0) systemPrompt = systemMessages.join("\n\n");
    } else if (parsed && typeof parsed === "object") {
      if (parsed.system) systemPrompt = systemToText(parsed.system);
      if (Array.isArray(parsed.messages)) messages = parsed.messages;
      if (parsed.prompt && !Array.isArray(parsed.messages)) {
        messages = [{ role: "user", content: contentToText(parsed.prompt) }];
      }
    }
  } catch {
    return null;
  }

  const finalOutput = llmSpans[llmSpans.length - 1]?.output_payload;
  const lastMessage = messages[messages.length - 1];
  if (finalOutput && lastMessage?.role !== "assistant") {
    messages.push({ role: "assistant", content: finalOutput });
  }

  return {
    systemPrompt,
    messages,
    model: selected.model ?? null,
    provider: selected.provider ?? null,
  };
}

function previewText(value: unknown, limit: number): string | null {
  if (value == null) return null;
  const text = contentToText(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function contentToText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

function systemToText(system: any): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system.map((part) => typeof part === "string" ? part : part?.content ?? JSON.stringify(part)).join("\n\n");
  }
  return system?.content ? contentToText(system.content) : JSON.stringify(system);
}

const ALLOWED_PROVIDER_MESSAGE_KEYS = new Set(["role", "content"]);
const ALLOWED_PROVIDER_CONTENT_KEYS: Record<string, Set<string>> = {
  text: new Set(["type", "text"]),
  tool_use: new Set(["type", "id", "name", "input"]),
  tool_result: new Set(["type", "tool_use_id", "content", "is_error"]),
  thinking: new Set(["type", "thinking", "signature"]),
};

function cleanProviderMessage(message: any): Record<string, any> {
  const clean: Record<string, any> = {};
  for (const key of Object.keys(message ?? {})) {
    if (ALLOWED_PROVIDER_MESSAGE_KEYS.has(key)) clean[key] = message[key];
  }
  if (clean.role === "tool") clean.role = "user";
  if (Array.isArray(clean.content)) {
    clean.content = clean.content.map((contentPart: any) => {
      if (typeof contentPart === "string") return contentPart;
      const allowed = ALLOWED_PROVIDER_CONTENT_KEYS[contentPart?.type];
      if (!allowed) return { type: "text", text: JSON.stringify(contentPart) };
      const filteredPart: Record<string, any> = {};
      for (const key of Object.keys(contentPart)) {
        if (allowed.has(key)) filteredPart[key] = contentPart[key];
      }
      return filteredPart;
    });
  }
  return clean;
}

function cleanCrossProviderTextMessage(message: any): Record<string, any> | null {
  if (!message || !["user", "assistant", "tool"].includes(message.role)
    || Object.hasOwn(message, "tool_calls") || Object.hasOwn(message, "function_call")) return null;
  let content: string;
  if (typeof message.content === "string") content = message.content;
  else if (Array.isArray(message.content) && message.content.every((part: any) =>
    typeof part === "string" || part?.type === "text" && typeof part.text === "string")) {
    content = message.content.map((part: any) => typeof part === "string" ? part : part.text).join("\n");
  } else return null;
  return { role: message.role === "tool" ? "user" : message.role, content };
}

function providerEnvForProvider(provider: string): { envVar: "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" } {
  return provider === "openai" ? { envVar: "OPENAI_API_KEY" } : { envVar: "ANTHROPIC_API_KEY" };
}

function answerFromProviderResponse(body: Record<string, any> | null, text: string): string {
  if (!body) return text.trim();
  const openAiContent = body.choices?.[0]?.message?.content;
  if (typeof openAiContent === "string") return openAiContent.trim();
  if (Array.isArray(body.content)) {
    const joined = body.content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("");
    if (joined.trim()) return joined.trim();
  }
  for (const key of ["answer", "response", "message", "summary", "error"]) {
    if (typeof body[key] === "string" && body[key].trim()) return body[key].trim();
  }
  return JSON.stringify(body, null, 2);
}

function canonicalizeAgentUiCommand(command: Record<string, unknown>): Record<string, unknown> | null {
  if (command.type === "open_filter") return command;
  if (
    command.type !== "navigate_to_run" &&
    command.type !== "compose_annotation"
  ) {
    return null;
  }
  if (typeof command.run_id !== "string" || !command.run_id) return null;
  const runId = resolveRunId(command.run_id);
  if (!runId) return null;
  return { ...command, run_id: runId };
}

function resolveRunId(input: string): string | null {
  if (getRunById(input)) return input;
  if (input.length < 4) return null;
  const matches = (getRuns() as Array<{ id: string }>).filter((run) => run.id.startsWith(input));
  if (matches.length !== 1) return null;
  return matches[0].id;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
