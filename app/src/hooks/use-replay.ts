import { useCallback, useEffect, useRef, useState } from "react";
import { getRunDetail } from "../api/runs";
import { startReplayStream } from "../api/replay";

export type ReplayMode = "local";

export interface ReplayConfig {
  runId: string;
  mode?: ReplayMode;
  userMessage?: string;
  model?: string;
  systemPrompt?: string;
  maxIterations?: number;
  contextOverrides?: Record<string, string>;
}

export interface ReplayProgress {
  iteration: number;
  toolsMocked: number;
  matchStats: { exact: number; ordered: number; name_only: number; fallback: number };
}

export type ReplayState = "idle" | "running" | "complete" | "error" | "cancelled";

const initialProgress = (): ReplayProgress => ({ iteration: 0, toolsMocked: 0, matchStats: { exact: 0, ordered: 0, name_only: 0, fallback: 0 } });
interface ReplayAttempt {
  generation: number;
  abort: AbortController;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  timer?: ReturnType<typeof setInterval>;
  finished: boolean;
}
function release(attempt: ReplayAttempt) {
  clearInterval(attempt.timer);
  attempt.abort.abort();
  void attempt.reader?.cancel().catch(() => {});
}

export function useReplay(onReplayRunId?: (runId: string) => void) {
  const [state, setState] = useState<ReplayState>("idle");
  const [replayRunId, setReplayRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ReplayProgress>(initialProgress);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const active = useRef<ReplayAttempt | null>(null);
  const onReplayRunIdRef = useRef(onReplayRunId);
  onReplayRunIdRef.current = onReplayRunId;

  const invalidate = useCallback(() => {
    generation.current++;
    const previous = active.current;
    active.current = null;
    if (previous) { previous.finished = true; release(previous); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; invalidate(); };
  }, [invalidate]);

  const startReplay = useCallback(async (config: ReplayConfig) => {
    invalidate();
    if (!mounted.current) return null;
    const attempt: ReplayAttempt = { generation: generation.current, abort: new AbortController(), finished: false };
    active.current = attempt;
    const owns = () => mounted.current && active.current === attempt && generation.current === attempt.generation && !attempt.abort.signal.aborted;
    const live = () => owns() && !attempt.finished;
    let foundRunId: string | null = null;
    let placeholderRunId: string | null = null;
    let currentProgress = initialProgress();
    let polling = false;
    let completed = false;
    setState("running"); setError(null); setReplayRunId(null); setProgress(currentProgress);
    const publish = (runId: string) => {
      if (!owns()) return;
      foundRunId = runId;
      setReplayRunId(runId);
      if (owns()) onReplayRunIdRef.current?.(runId);
    };
    const fail = (message: string) => {
      if (!live()) return;
      attempt.finished = true;
      clearInterval(attempt.timer);
      setError(message); setState("error");
    };

    // Only this attempt's placeholder is attributable before authoritative
    // completion. A recent trace or shared source ID is not an attempt identity.
    attempt.timer = setInterval(async () => {
      if (!live() || polling || foundRunId || !placeholderRunId) return;
      polling = true;
      try {
        const detail = await getRunDetail(placeholderRunId, attempt.abort.signal);
        if (!live()) return;
        if (detail.spans?.length) { clearInterval(attempt.timer); publish(placeholderRunId); }
      } catch { /* The placeholder may be replaced by its final OTLP trace. */ }
      finally { polling = false; }
    }, 800);

    const consume = (line: string) => {
      if (!live() || !line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      let event: Record<string, unknown>;
      try { event = JSON.parse(data); } catch { fail("Replay returned an invalid event before completion."); return; }
      if (!event || typeof event !== "object") { fail("Replay returned an invalid event before completion."); return; }
      if (!live()) return;
      if (event.type === "replay_started" && typeof event.replayRunId === "string" && event.replayRunId) placeholderRunId = event.replayRunId;
      if (event.type === "llm_start" && typeof event.iteration === "number" && Number.isFinite(event.iteration)) {
        currentProgress = { ...currentProgress, iteration: event.iteration }; setProgress(currentProgress);
      }
      if (event.type === "tool_mocked" && typeof event.matchType === "string" && Object.prototype.hasOwnProperty.call(currentProgress.matchStats, event.matchType)) {
        const key = event.matchType as keyof ReplayProgress["matchStats"];
        currentProgress = { ...currentProgress, toolsMocked: currentProgress.toolsMocked + 1,
          matchStats: { ...currentProgress.matchStats, [key]: currentProgress.matchStats[key] + 1 } };
        setProgress(currentProgress);
      }
      if (event.type === "error") fail(typeof event.message === "string" ? event.message : "Replay failed before completion.");
      if (event.type === "replay_complete") {
        if (typeof event.replayRunId !== "string" || !event.replayRunId) { fail("Replay completed without an authoritative run identifier."); return; }
        completed = true; attempt.finished = true; clearInterval(attempt.timer);
        const count = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
        const stats = event.matchStats && typeof event.matchStats === "object" ? event.matchStats as Record<string, unknown> : {};
        currentProgress = { iteration: count(event.iterations, currentProgress.iteration), toolsMocked: count(event.toolCallCount, currentProgress.toolsMocked),
          matchStats: { exact: count(stats.exact, 0), ordered: count(stats.ordered, 0), name_only: count(stats.name_only, 0), fallback: count(stats.fallback, 0) } };
        setProgress(currentProgress); setState("complete");
        if (owns()) publish(event.replayRunId);
      }
    };
    try {
      const response = await startReplayStream(config, attempt.abort.signal);
      if (!live()) { void response.body?.cancel().catch(() => {}); return null; }
      if (!response.ok) {
        const message = await response.text();
        if (live()) fail(message || `Replay request failed (${response.status}).`);
        return null;
      }
      if (!response.body) { fail("Cannot read replay response stream."); return null; }
      attempt.reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (live()) {
        const { done, value } = await attempt.reader.read();
        if (!live()) break;
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (buffer.length > 1024 * 1024) { fail("Replay event exceeded the supported size before completion."); break; }
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) { if (!live()) break; consume(line); }
        if (done) { if (buffer && live()) consume(buffer); break; }
      }
      if (live()) fail("Replay stream ended before completion. Retry the replay to capture a complete result.");
      return owns() && completed ? foundRunId : null;
    } catch (cause) {
      if (live()) fail(cause instanceof Error ? cause.message : "Replay interrupted before completion.");
      return null;
    } finally {
      release(attempt);
      if (active.current === attempt) active.current = null;
    }
  }, [invalidate]);

  const cancel = useCallback(() => { invalidate(); if (mounted.current) setState("cancelled"); }, [invalidate]);
  const reset = useCallback(() => {
    invalidate();
    if (!mounted.current) return;
    setState("idle"); setReplayRunId(null); setError(null); setProgress(initialProgress());
  }, [invalidate]);
  const viewExisting = useCallback((runId: string) => {
    invalidate();
    if (!mounted.current) return;
    setReplayRunId(runId); setState("complete"); setError(null);
    onReplayRunIdRef.current?.(runId);
  }, [invalidate]);

  return { state, replayRunId, progress, error, startReplay, cancel, reset, viewExisting };
}
