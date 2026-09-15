import { useCallback, useEffect, useRef, useState } from "react";
import { X, Loader2, AlertCircle, RotateCcw, ArrowRight } from "lucide-react";
import { RunDetail } from "./RunDetail";
import { RunComparison } from "./RunComparison";
import { C } from "../utils/colors";
import { useIsCompactWorkspace } from "../hooks/use-mobile";

interface ReplayViewProps {
  originalRunId: string;
  originalName?: string;
  replayRunId: string | null;
  error?: string | null;
  isRunning?: boolean;
  isCancelled?: boolean;
  initialCompare?: boolean;
  onCancel?: () => void;
  onReplay?: () => void;
}

export function ReplayView({ originalRunId, originalName, replayRunId, error, isRunning, isCancelled, initialCompare, onCancel, onReplay }: ReplayViewProps) {
  const isCompact = useIsCompactWorkspace();
  const [showOriginal, setShowOriginal] = useState(initialCompare ?? false);
  const [leftPct, setLeftPct] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setLeftPct(Math.min(Math.max(pct, 25), 75));
  }, []);

  const onPointerUp = useCallback(() => { dragging.current = false; }, []);

  useEffect(() => {
    if (isCompact) setShowOriginal(false);
  }, [isCompact]);

  const comparisonVisible = showOriginal && !isCompact;
  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    setLeftPct((current) => {
      if (event.key === "Home") return 25;
      if (event.key === "End") return 75;
      return Math.min(75, Math.max(25, current + (event.key === "ArrowRight" ? 5 : -5)));
    });
  };

  return (
    <div ref={containerRef} className="h-full flex flex-col" onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <div className="flex-shrink-0 flex z-10" style={{ borderBottom: `1px solid ${C.border}` }}>
        <div
          className="flex items-center justify-between px-3 py-1.5 min-w-0"
          style={{ background: "var(--rp-ink-a10)", width: comparisonVisible ? `${leftPct}%` : "100%" }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <RotateCcw style={{ width: 12, height: 12, color: C.fg1, flexShrink: 0 }} />
            <span className="text-[12px] truncate" style={{ color: C.fg1 }}>
              replay of{" "}
              <button
                className="font-medium hover:underline transition-colors"
                style={{ color: C.fg3 }}
                onClick={() => { if (!isCompact) setShowOriginal(!showOriginal); }}
              >
                {originalName ?? "run"}
              </button>
            </span>
            {!comparisonVisible && !isCompact && (
              <button
                className="flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded transition-colors hover:bg-[color:var(--rp-ink-wash)] flex-shrink-0"
                style={{ color: C.fg2, border: `1px solid var(--rp-ink-a15)` }}
                onClick={() => setShowOriginal(true)}
              >
                compare <ArrowRight className="size-3" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {isRunning && onCancel && (
              <button
                className="text-[10px] font-mono px-2 py-0.5 rounded transition-colors hover:bg-[color:var(--rp-ink-wash)]"
                style={{ color: C.red }}
                onClick={onCancel}
              >
                cancel
              </button>
            )}
            {!isRunning && onReplay && (
              <button
                type="button"
                aria-label="Replay again"
                className="grid min-h-6 min-w-6 place-items-center rounded transition-colors hover:bg-[color:var(--rp-ink-wash)]"
                title="Replay"
                onClick={onReplay}
              >
                <RotateCcw style={{ width: 12, height: 12, color: C.fg2 }} />
              </button>
            )}
          </div>
        </div>

        {comparisonVisible && (
          <>
            <div className="w-6 flex-shrink-0" />
            <div
              className="flex items-center justify-between px-3 py-1.5 min-w-0"
              style={{ background: "var(--rp-ink-a04)", flex: 1 }}
            >
              <span className="text-[12px] truncate" style={{ color: C.fg1 }}>
                original — <span style={{ color: C.fg3 }}>{originalName ?? "run"}</span>
              </span>
              <button
                type="button"
                aria-label="Close original run comparison"
                className="grid min-h-6 min-w-6 flex-shrink-0 place-items-center rounded transition-colors hover:bg-[color:var(--rp-ink-wash)]"
                onClick={() => setShowOriginal(false)}
              >
                <X className="size-3.5" style={{ color: C.fg1 }} />
              </button>
            </div>
          </>
        )}
      </div>

      {replayRunId && <RunComparison baselineRunId={originalRunId} candidateRunId={replayRunId} />}
      <div className="flex-1 flex min-h-0">
        <div className="min-w-0 overflow-auto sb" style={{ width: comparisonVisible ? `${leftPct}%` : "100%" }}>
          {replayRunId ? (
            <RunDetail runId={replayRunId} isReplay />
          ) : error ? (
            <div className="flex items-center justify-center h-full">
              <div className="flex flex-col items-center gap-3 max-w-xs text-center">
                <AlertCircle className="size-5" style={{ color: C.red }} />
                <span className="text-xs font-mono" style={{ color: C.fg2 }}>{error}</span>
              </div>
            </div>
          ) : isCancelled ? (
            <div className="flex items-center justify-center h-full">
              <span className="text-xs font-mono" style={{ color: C.fg1 }}>Stopped</span>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="size-5 animate-spin" style={{ color: C.fg1 }} />
                <span className="text-xs font-mono" style={{ color: C.fg1 }}>Replaying agent…</span>
              </div>
            </div>
          )}
        </div>

        {comparisonVisible && (
          <>
            <div
              role="separator"
              aria-label="Resize replay comparison"
              aria-orientation="vertical"
              aria-valuemin={25}
              aria-valuemax={75}
              aria-valuenow={Math.round(leftPct)}
              tabIndex={0}
              className="relative w-6 flex-shrink-0 cursor-col-resize transition-colors after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-[color:var(--rp-border)] hover:bg-[color:var(--rp-ink-wash)] active:bg-[color:var(--rp-ink-wash)]"
              onPointerDown={onPointerDown}
              onKeyDown={resizeWithKeyboard}
            />
            <div className="min-w-0 overflow-auto sb" style={{ flex: 1 }}>
              <RunDetail runId={originalRunId} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
