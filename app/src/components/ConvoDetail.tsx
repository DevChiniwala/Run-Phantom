import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { HelpCircle } from "lucide-react";
import { C } from "../utils/colors";
import { ago } from "../utils/helpers";
import { Dots } from "./Icons";
import { ToolCallPill } from "./ToolCallPill";
import { Markdown } from "./Markdown";
import type { Run } from "../utils/types";
import { buildConvoEvents } from "./convo-events";
import { useRunPhantomEvent } from "../hooks/use-runphantom-ws";
import { isRunDeleting, useConversationDetail } from "../hooks/use-runs";

function ConversationHeader({ runCount }: { runCount: number }) {
  return (
    <div className="text-[11px] font-mono inline-flex items-center gap-1.5" style={{ color: C.fg1 }}>
      <span>conversation</span>
      <span className="relative group inline-flex items-center">
        <HelpCircle size={13} style={{ color: C.fg0, cursor: "help" }} />
        <div className="absolute left-0 top-full mt-2 z-50 hidden group-hover:block">
          <div className="rounded-lg px-3 py-2 text-[11px] leading-relaxed whitespace-nowrap shadow-xl"
            style={{ background: C.elevated, border: `1px solid ${C.borderLight}`, color: C.fg3 }}>
            Conversation groups separate runs that share the same conversation ID.
          </div>
        </div>
      </span>
      <span style={{ color: C.fg0 }}>&middot;</span>
      <span>{runCount} run{runCount !== 1 ? "s" : ""}</span>
    </div>
  );
}

function UserMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-end px-4 pt-5 pb-1">
      <div className="max-w-[65%] px-3.5 py-2.5 rounded-2xl rounded-br-md" style={{ background: C.user }}>
        <div className="relative">
          <pre className="text-sm leading-relaxed font-sans whitespace-pre-wrap" style={{ color: C.fg3 }}>
            {content}
          </pre>
        </div>
      </div>
    </div>
  );
}

function TurnDivider({ index, run, onOpen, onHover }: { index: number; run: Run; onOpen: () => void; onHover: (hovering: boolean) => void }) {
  return (
    <div className="flex items-center gap-3 px-4 pt-6 pb-2">
      <div className="flex-1 h-px" style={{ background: "var(--rp-ink-a08)" }} />
      <span className="rounded border px-2 py-0.5 text-[10px] font-mono" style={{ color: C.fg1, background: C.surface, borderColor: C.border }}>
        Run {index + 1}
      </span>
      <span className="text-[10px]" style={{ color: C.fg0 }}>{ago(run.started_at)}</span>
      <button
        className="text-[10px] font-mono px-2 py-0.5 rounded transition-colors"
        style={{ color: C.fg1, background: C.surface, border: `1px solid ${C.border}` }}
        onMouseEnter={e => { e.currentTarget.style.background = "var(--rp-surface-raised)"; onHover(true); }}
        onMouseLeave={e => { e.currentTarget.style.background = "var(--rp-surface)"; onHover(false); }}
        onClick={onOpen}
      >
        open &rarr;
      </button>
      <div className="flex-1 h-px" style={{ background: "var(--rp-ink-a08)" }} />
    </div>
  );
}

export function ConvoDetail({ convoId, onOpenTurn }: { convoId: string; onOpenTurn?: (runId: string) => void }) {
  const queryClient = useQueryClient();
  const { turns, runIds, isLoading, isError } = useConversationDetail(convoId);
  const [hoveredTurn, setHoveredTurn] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const colorMap = useMemo(() => new Map<string, string>(), []);

  useRunPhantomEvent("spans", () => {
    void queryClient.invalidateQueries({ queryKey: ["conversation-runs", convoId] });
    for (const runId of runIds) {
      if (isRunDeleting(runId)) continue;
      void queryClient.invalidateQueries({ queryKey: ["run-detail", runId] });
    }
  });
  useRunPhantomEvent("live", () => {
    for (const runId of runIds) {
      if (isRunDeleting(runId)) continue;
      void queryClient.invalidateQueries({ queryKey: ["run-detail", runId] });
    }
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Only auto-scroll when the user is already near the bottom, so a live turn
    // update (WS-triggered) doesn't yank them back down while reading history.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const events = useMemo(() => buildConvoEvents(turns), [turns]);

  if (isLoading) return <div className="flex items-center justify-center h-full gap-2" style={{ color: C.fg1 }}>Loading <Dots /></div>;
  if (isError) return <div className="flex items-center justify-center h-full" style={{ color: C.fg1 }}>Could not load conversation</div>;
  if (turns.length === 0) return <div className="flex items-center justify-center h-full" style={{ color: C.fg1 }}>No runs found</div>;

  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 px-4 py-3" style={{ borderBottom: `1px solid ${C.border}` }}>
        <ConversationHeader runCount={turns.length} />
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto sb pb-24">
        {events.map((evt, i) => {
          const turnIdx = evt.turnIndex;
          const dimmed = hoveredTurn !== null && turnIdx !== hoveredTurn;

          if (evt.type === "turn_start") {
            return (
              <div key={`td${i}`} style={{ opacity: dimmed ? 0.35 : 1, transition: "opacity 0.15s" }}>
                <TurnDivider index={evt.turnIndex} run={evt.run}
                  onOpen={() => onOpenTurn?.(evt.run.id)}
                  onHover={(h) => setHoveredTurn(h ? evt.turnIndex : null)} />
              </div>
            );
          }

          if (evt.type === "user_msg") {
            return (
              <div key={`um${i}`} style={{ opacity: dimmed ? 0.35 : 1, transition: "opacity 0.15s" }}>
                <UserMessage content={evt.content} />
              </div>
            );
          }

          if (evt.type === "tool_group") {
            return (
              <div key={`tg${i}`} className="flex flex-wrap gap-1.5 px-4 py-1" style={{ opacity: dimmed ? 0.35 : 1, transition: "opacity 0.15s" }}>
                {evt.spans.map(s => (
                  <ToolCallPill key={s.id} span={s} colorMap={colorMap} />
                ))}
              </div>
            );
          }

          if (evt.type === "llm_out") {
            return (
              <div key={`lo${i}`} className="max-w-[85%] px-4 py-2" style={{ opacity: dimmed ? 0.35 : 1, transition: "opacity 0.15s" }}>
                <div className="text-message leading-relaxed" style={{ color: C.fg3 }}>
                  <Markdown>{evt.content}</Markdown>
                </div>
              </div>
            );
          }

          if (evt.type === "active") {
            return (
              <div key={`act${i}`} className="px-4 py-2 text-[11px] font-mono" style={{ opacity: dimmed ? 0.35 : 1, transition: "opacity 0.15s", color: C.fg0 }}>
                running <Dots />
              </div>
            );
          }

          return null;
        })}
      </div>
    </div>
  );
}
