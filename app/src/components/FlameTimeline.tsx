import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
import { C, spanColor } from "../utils/colors";
import { displayPayload, fmt, plural, tryJson } from "../utils/helpers";
import { setMeridian, clearMeridian } from "../utils/meridian";
import type { Span } from "../utils/types";

// Half the width of the widest axis label ("1.0s"/"10.0s" at 9px mono). A label
// whose centre falls within this of the right edge is right-aligned instead.
const LABEL_EDGE_GUARD_PX = 24;

function spanTypeInfo(span: Span): { color: string; label: string } {
  if (span.span_type === "TRACE") return { color: C.purple, label: "TRACE" };
  if (span.span_type === "TOOL_CALL") return { color: C.orange, label: "TOOL" };
  if (span.span_type?.includes("LLM")) return { color: C.fg1, label: "LLM" };
  return { color: C.fg0, label: "SPAN" };
}

const LLM_BAR_COLOR = "color-mix(in srgb, var(--rp-info) 38%, white 62%)";
const LLM_LABEL_COLOR = "color-mix(in srgb, var(--rp-info) 72%, var(--rp-ink-soft) 28%)";

function TooltipPayloadBlock({
  label,
  payload,
  isErr,
  showTopBorder,
}: {
  label: string;
  payload: string;
  isErr?: boolean;
  showTopBorder?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const display = displayPayload(payload);
  const copyText = tryJson(payload);

  return (
    <div
      className="px-3 py-1.5 flex flex-col min-h-0"
      style={{ flex: 1, ...(showTopBorder ? { borderTop: `1px solid ${C.border}` } : {}) }}
    >
      <div className="flex items-center justify-between gap-2 mb-0.5 flex-shrink-0">
        <div className="text-[9px] uppercase tracking-wide font-medium" style={{ color: C.fg0 }}>{label}</div>
        <button
          type="button"
          aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
          className="flex-shrink-0 rounded p-1 transition-colors hover:bg-[color:var(--rp-ink-wash)]"
          style={{ color: copied ? C.green : C.fg0 }}
          title="Copy"
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard.writeText(copyText ?? "");
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </button>
      </div>
      <pre
        className="text-[10px] font-mono leading-relaxed whitespace-pre-wrap break-words"
        style={{
          color: isErr ? C.red : C.fg1,
          flex: 1,
          minHeight: 0,
          overflow: "auto",
        }}
      >
        {display}
      </pre>
    </div>
  );
}

function SpanTooltip({
  span,
  barRect,
  onPointerEnter,
  onPointerLeave,
}: {
  span: Span;
  barRect: DOMRect;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const W = Math.min(320, Math.max(160, window.innerWidth - 16));
  const H = 480;
  const pad = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const MIN_H = 160;
  let maxH = Math.min(H, Math.max(0, vh - 2 * pad));
  let left = barRect.left + barRect.width / 2 - W / 2;
  if (left + W > vw - pad) left = vw - W - pad;
  if (left < pad) left = pad;
  // Never cover the bar: clamping a tooltip that fits neither below nor above
  // pinned it over its own bar, so the bar could not be clicked while hovered.
  const below = vh - barRect.bottom - 2 * pad;
  const above = barRect.top - 2 * pad;
  let top: number;
  if (below >= maxH) {
    top = barRect.bottom + pad;
  } else if (above >= maxH) {
    top = barRect.top - maxH - pad;
  } else if (Math.max(below, above) >= MIN_H) {
    maxH = Math.max(below, above);
    top = below >= above ? barRect.bottom + pad : pad;
  } else {
    top = Math.max(pad, Math.min(barRect.top, vh - maxH - pad));
    left = barRect.right + pad + W <= vw - pad ? barRect.right + pad : Math.max(pad, barRect.left - W - pad);
  }

  const isErr = span.status === "ERROR";
  const type = spanTypeInfo(span);
  const inTok = span.input_tokens ?? 0;
  const outTok = span.output_tokens ?? 0;
  const inputRaw = span.input_payload?.trim() ?? "";
  const outputRaw = span.output_payload?.trim() ?? "";

  return (
    <div
      data-span-tooltip
      className="fixed z-[9999] rounded-lg shadow-2xl overflow-hidden flex flex-col pointer-events-auto"
      style={{
        left,
        top,
        width: W,
        maxHeight: maxH,
        background: C.elevated,
        border: `1px solid ${C.borderLight}`,
      }}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      <div className="px-3 py-2 flex items-center gap-2 flex-shrink-0" style={{ borderBottom: `1px solid ${C.border}` }}>
        <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded"
          style={{
            color: type.color,
            background: C.selected,
          }}>
          {type.label}
        </span>
        <span className="text-[11px] font-mono font-medium truncate" style={{ color: C.fg4 }}>{span.name}</span>
      </div>
      <div className="px-3 py-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono flex-shrink-0" style={{ borderBottom: `1px solid ${C.border}` }}>
        <span style={{ color: C.fg2 }}>{fmt(span.duration_ms)}</span>
        <span style={{ color: isErr ? C.red : C.green }}>{span.status}</span>
        {span.model && <span style={{ color: C.fg1 }}>{span.model}</span>}
        {(inTok > 0 || outTok > 0) && (
          <span style={{ color: C.fg1 }}>{inTok.toLocaleString()} in / {outTok.toLocaleString()} out</span>
        )}
      </div>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {inputRaw ? <TooltipPayloadBlock label="Input" payload={span.input_payload!} /> : null}
        {outputRaw ? (
          <TooltipPayloadBlock
            label="Output"
            payload={span.output_payload!}
            isErr={isErr}
            showTopBorder={!!inputRaw}
          />
        ) : null}
      </div>
    </div>
  );
}

export function FlameTimeline({ spans }: { spans: Span[] }) {
  const colorMap = useMemo(() => new Map<string, string>(), []);
  const vizSpans = useMemo(() => spans.filter(s => s.span_type === "TRACE" || s.span_type === "TOOL_CALL" || s.span_type?.includes("LLM")), [spans]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  const [hovered, setHovered] = useState<{ span: Span; rect: DOMRect } | null>(null);
  const [hoveredLabelName, setHoveredLabelName] = useState<string | null>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelTooltipDismiss = useCallback(() => {
    if (leaveTimerRef.current != null) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
  }, []);

  const scheduleTooltipDismiss = useCallback(() => {
    cancelTooltipDismiss();
    leaveTimerRef.current = setTimeout(() => {
      leaveTimerRef.current = null;
      setHovered(null);
    }, 200);
  }, [cancelTooltipDismiss]);

  useEffect(() => () => cancelTooltipDismiss(), [cancelTooltipDismiss]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(([entry]) => setContainerW(entry.contentRect.width));
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const handleBarEnter = useCallback((span: Span, e: React.SyntheticEvent<HTMLElement>) => {
    cancelTooltipDismiss();
    setMeridian(span.id);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setHovered({ span, rect });
  }, [cancelTooltipDismiss]);

  const handleBarLeave = useCallback(() => {
    clearMeridian();
    scheduleTooltipDismiss();
  }, [scheduleTooltipDismiss]);

  if (vizSpans.length === 0) return null;

  const minT = Math.min(...vizSpans.map(s => s.start_time_ms));
  const maxT = Math.max(...vizSpans.map(s => s.end_time_ms));
  // A corrupt span (end before start, or an out-of-range future timestamp) must not
  // drive the axis math: an unbounded `dur` makes the grid loop below allocate tens of
  // millions of nodes and crashes the tab. Clamp to a sane trace window.
  const MAX_TRACE_MS = 24 * 60 * 60 * 1000;
  const rawDur = maxT - minT;
  const dur = Number.isFinite(rawDur) ? Math.min(Math.max(rawDur, 1), MAX_TRACE_MS) : 1;
  const llmNames = new Set<string>();
  for (const span of vizSpans) {
    if (span.span_type?.includes("LLM")) llmNames.add(span.name);
  }
  const rowPriority = (span: Span): number => {
    if (span.span_type === "TRACE" || span.span_type?.includes("LLM")) return 0;
    return 1;
  };
  const firstSpanByName = new Map<string, Span>();
  for (const span of [...vizSpans].sort((a, b) =>
    (a.start_time_ms - b.start_time_ms) || (rowPriority(a) - rowPriority(b))
  )) {
    if (!firstSpanByName.has(span.name)) firstSpanByName.set(span.name, span);
  }
  const toolNames: string[] = [...firstSpanByName.keys()];
  const firstToolSpanByName = new Map<string, Span>();
  for (const span of [...vizSpans].sort((a, b) => a.start_time_ms - b.start_time_ms)) {
    if (span.span_type === "TOOL_CALL" && !firstToolSpanByName.has(span.name)) {
      firstToolSpanByName.set(span.name, span);
    }
  }

  const focusTool = (spanId: string) => {
    document.dispatchEvent(new CustomEvent("runphantom:focus-tool", { detail: { spanId } }));
  };

  const ROW = 24;
  const BAR_H = 14;
  const BAR_Y_OFF = (ROW - BAR_H) / 2;
  const MIN_LABEL_W = 120;
  const MAX_LABEL_W = 420;
  const LABEL_CHAR_PX = 6.2;
  const LABEL_PAD = 28;
  const AXIS_H = 22;
  const MIN_PX_PER_MS = 0.005;
  // Below this the chart scrolls horizontally rather than compressing every
  // short span to the same minimum-width blob, which destroys the duration
  // signal the timeline exists to show (narrow panes, mobile, chat open).
  const MIN_CHART_W = 480;
  // Short spans must still read as bars, not uniform dots.
  const MIN_BAR_W = 3;

  const longestNameLen = toolNames.reduce((m, n) => Math.max(m, n.length), 0);
  const widthFromContent = Math.ceil(longestNameLen * LABEL_CHAR_PX + LABEL_PAD);
  const maxLabelByContainer =
    containerW > 0 ? Math.min(MAX_LABEL_W, Math.floor(containerW * 0.46)) : MAX_LABEL_W;
  const labelW = Math.max(MIN_LABEL_W, Math.min(widthFromContent, maxLabelByContainer));
  const labelColumnCapped = widthFromContent > maxLabelByContainer;
  const totalH = toolNames.length * ROW + AXIS_H;
  const scrollViewportW = Math.max((containerW || 300) - labelW, 160);
  const chartW = Math.max(scrollViewportW, dur * MIN_PX_PER_MS, MIN_CHART_W);
  const pxPerMs = chartW / dur;

  const gridIntervals = [100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000];
  const targetGrids = Math.floor(chartW / 90);
  const gridMs = gridIntervals.find(g => dur / g <= targetGrids) ?? gridIntervals[gridIntervals.length - 1]!;

  return (
    <div ref={containerRef} className="rp-clipped-ring rounded-lg mb-4" style={{ background: C.surface, border: `1px solid ${C.border}`, overflow: "hidden" }}>
      <div className="flex items-center justify-between px-3 py-1.5" style={{ borderBottom: `1px solid ${C.border}` }}>
        <span className="text-[10px] uppercase tracking-wider font-medium" style={{ color: C.fg1 }}>Trajectory</span>
        <span className="text-[10px] font-mono" style={{ color: C.fg0 }}>{plural(vizSpans.length, "span")} &middot; {fmt(dur)}</span>
      </div>

      {containerW > 0 && (
      <div style={{ display: "flex", height: totalH }}>
        <div style={{ width: labelW, flexShrink: 0 }}>
          {toolNames.map(name => {
            const firstToolSpan = firstToolSpanByName.get(name);
            const labelHovered = hoveredLabelName === name;
            const label = (
              <div
                className={`flex items-center px-3 text-[10px] font-mono min-w-0 ${labelColumnCapped ? "truncate" : "whitespace-nowrap"}`}
                style={{
                  height: ROW,
                  color: labelHovered ? C.fg5 : llmNames.has(name) ? LLM_LABEL_COLOR : spanColor(name, colorMap),
                }}
                title={name}
              >
                {name}
              </div>
            );
            if (!firstToolSpan) return <Fragment key={name}>{label}</Fragment>;
            return (
              <button
                key={name}
                type="button"
                className="block w-full text-left"
                style={{
                  padding: 0,
                  border: 0,
                  background: labelHovered ? "var(--rp-ink-wash)" : "transparent",
                  boxShadow: labelHovered ? `inset 2px 0 0 ${spanColor(name, colorMap)}` : undefined,
                  cursor: "pointer",
                  transition: "background 120ms ease, box-shadow 120ms ease",
                }}
                onMouseEnter={() => setHoveredLabelName(name)}
                onMouseLeave={() => setHoveredLabelName((current) => current === name ? null : current)}
                onClick={() => focusTool(firstToolSpan.id)}
                title={`${name} - jump to first tool call`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Chart area — explicit width + horizontal scroll for long runs */}
        <div
          className="min-w-0 flex-1"
          style={{
            overflowX: "auto",
            overflowY: "hidden",
            overscrollBehaviorX: "contain",
          }}
        >
        <div style={{ position: "relative", width: chartW, height: totalH }}>
          {/* floor, not ceil: ceil put the final gridline a whole interval past
              the end of the chart, so its label rendered outside the canvas and
              was cut in half ("1.0s" as "1."). */}
          {Array.from({ length: Math.min(Math.floor(dur / gridMs) + 1, 500) }, (_, i) => {
            const x = i * gridMs * pxPerMs;
            return (
              <Fragment key={i}>
                <div style={{ position: "absolute", left: x, top: 0, bottom: AXIS_H, borderLeft: `1px solid ${C.border}` }} />
                {i > 0 && (
                  // Centred on its gridline, except near the right edge: the last
                  // line sits at the chart's width, so half of a centred label
                  // fell outside it and rendered as "1." instead of "1.0s".
                  <div
                    style={{
                      position: "absolute",
                      left: x,
                      bottom: 0,
                      transform: x > chartW - LABEL_EDGE_GUARD_PX ? "translateX(-100%)" : "translateX(-50%)",
                      fontSize: 9,
                      color: C.fg0,
                      fontFamily: "var(--font-mono)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {fmt(i * gridMs)}
                  </div>
                )}
              </Fragment>
            );
          })}

          {vizSpans.map((span, idx) => {
            const row = toolNames.indexOf(span.name);
            const left = (span.start_time_ms - minT) * pxPerMs;
            const w = Math.max((span.end_time_ms - span.start_time_ms) * pxPerMs, MIN_BAR_W);
            const color = span.span_type?.includes("LLM") ? LLM_BAR_COLOR : spanColor(span.name, colorMap);
            const isErr = span.status === "ERROR";
            const isLLM = span.span_type?.includes("LLM");
            const focusBarTool = () => {
              if (span.span_type === "TOOL_CALL") {
                focusTool(span.id);
              }
            };
            if (isErr && w < 40) {
              const triSize = 14;
              return (
                <button
                  key={span.id}
                  type="button"
                  aria-label={`Jump to ${span.name}`}
                  className="absolute cursor-pointer"
                  style={{ left, top: row * ROW + (ROW - triSize) / 2, width: triSize, height: triSize, zIndex: idx }}
                  onMouseEnter={(e) => handleBarEnter(span, e)}
                  onMouseLeave={handleBarLeave}
                  onFocus={(e) => handleBarEnter(span, e)}
                  onBlur={handleBarLeave}
                  onClick={(e) => {
                    handleBarEnter(span, e);
                    focusBarTool();
                  }}
                >
                  <svg width={triSize} height={triSize - 1} viewBox="0 0 14 13" className="drop-shadow-sm">
                    <polygon points="7,0 14,13 0,13" fill={C.red} />
                    <text x="7" y="11" textAnchor="middle" fill="var(--rp-canvas)" stroke="var(--rp-canvas)" strokeWidth="0.2"
                      fontSize="9" fontWeight="900" fontFamily="ui-sans-serif, system-ui, sans-serif">!</text>
                  </svg>
                </button>
              );
            }
            return (
              <button
                key={span.id}
                type="button"
                aria-label={`Inspect ${span.name}, ${isLLM ? "LLM" : span.span_type === "TOOL_CALL" ? "tool" : "span"}, ${fmt(span.duration_ms)}, ${span.status.toLowerCase()}`}
                data-meridian-key={span.id}
                className="timeline-bar absolute flex items-center justify-center rounded-sm cursor-pointer"
                style={{ left, top: row * ROW + BAR_Y_OFF, width: w, height: BAR_H, backgroundColor: isErr ? C.red : color, zIndex: idx, border: isLLM ? `1px solid ${C.borderLight}` : `1.5px solid ${C.borderLight}`, boxSizing: "border-box", padding: 0 }}
                onMouseEnter={(e) => handleBarEnter(span, e)}
                onMouseLeave={handleBarLeave}
                onFocus={(e) => handleBarEnter(span, e)}
                onBlur={handleBarLeave}
                onClick={(e) => {
                  handleBarEnter(span, e);
                  focusBarTool();
                }}
              >
                {w >= 40 && (
                  <span style={{ fontSize: 11, fontWeight: 500, color: isLLM ? C.fg4 : "var(--rp-canvas)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", padding: "0 3px", display: "flex", alignItems: "center", gap: 3 }}>
                    {isErr && (
                      <svg width="10" height="10" viewBox="0 0 14 13" style={{ flexShrink: 0 }}>
                        <polygon points="7,0 14,13 0,13" fill="var(--rp-canvas)" />
                        <text x="7" y="11" textAnchor="middle" fill={C.red} fontSize="9" fontWeight="900" fontFamily="ui-sans-serif, system-ui, sans-serif">!</text>
                      </svg>
                    )}
                    {fmt(span.duration_ms)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        </div>
      </div>
      )}

      {hovered && (
        <SpanTooltip
          span={hovered.span}
          barRect={hovered.rect}
          onPointerEnter={cancelTooltipDismiss}
          onPointerLeave={scheduleTooltipDismiss}
        />
      )}
    </div>
  );
}
