import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/cn";
import { Markdown } from "./Markdown";

/** "Thought for 4s", "Thought for 1m 12s"; under a second it was a moment. */
export function thinkingLabel(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "Thought for a moment";
  if (seconds < 60) return `Thought for ${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `Thought for ${String(minutes)}m` : `Thought for ${String(minutes)}m ${String(rest)}s`;
}

/** How many lines of live reasoning the ticker shows at once. */
const TICKER_LINES = 2;

/**
 * What the model thought before it answered. While it thinks, the block
 * is a ticker: the latest two lines of its reasoning scroll by under a
 * shimmering "Thinking…", masked at the edges so more reads as above and
 * below (the reasoning-stream pattern). Once the reply begins the block
 * folds to "Thought for 4s", and opens on a click to the whole of it.
 *
 * `thinking` is whether reasoning is still arriving; `startedAt` is when
 * it began, for the live clock; `thinkingMs` is the settled duration a
 * finished reply carries. `live` (LiveReply) keeps the ticker up through
 * the steps between thoughts, still on the last lines and its line saying
 * what is in hand (`status`), until the reply has begun: the block holds
 * its height while the turn works rather than folding and opening with
 * every step. (Until 2026-10-21 it folded the moment a thought ended.)
 */
export const ReasoningBlock = memo(function ReasoningBlock({
  reasoning,
  thinking,
  startedAt = null,
  thinkingMs = null,
  live = thinking,
  status = null,
  density = "page",
  className,
}: {
  reasoning: string;
  thinking: boolean;
  startedAt?: string | null;
  thinkingMs?: number | null;
  /** The turn still works (its reply not begun): open on the ticker, thinking or not. */
  live?: boolean;
  /** What is in hand between thoughts, for the line while `live`. */
  status?: string | null;
  density?: "page" | "panel";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const elapsed = useElapsedSeconds(thinking ? startedAt : null);
  const working = thinking || live;
  const label = thinking
    ? elapsed === null || elapsed < 1
      ? "Thinking…"
      : `Thinking · ${String(elapsed)}s`
    : live && status !== null
      ? status
      : thinkingLabel(thinkingMs ?? 0);
  const expanded = open || (working && reasoning.trim() !== "");
  return (
    <div
      data-testid="reasoning-block"
      data-thinking={thinking ? "" : undefined}
      data-live={working ? "" : undefined}
      data-open={expanded ? "" : undefined}
      className={cn("chat-reasoning", density === "panel" && "chat-reasoning-panel", className)}
    >
      <button
        type="button"
        className="chat-reasoning-head"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        data-testid="reasoning-toggle"
      >
        <span className={cn("chat-reasoning-label", working && "agent-shimmer")}>{label}</span>
        <ChevronRight className={cn("size-3.5 shrink-0 text-gray-700 transition-transform duration-200", open && "rotate-90")} aria-hidden="true" />
      </button>
      {working && !open ? (
        <ReasoningTicker text={reasoning} idle={!thinking} />
      ) : open ? (
        <div className="chat-reasoning-body" data-testid="reasoning-text">
          <Markdown text={reasoning} density="panel" />
        </div>
      ) : null}
    </div>
  );
});

/** A clock that ticks once a second from `startedAt`; null with nothing to time. */
export function useElapsedSeconds(startedAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  if (startedAt === null) return null;
  const since = Date.parse(startedAt);
  return Number.isNaN(since) ? null : Math.max(0, Math.floor((now - since) / 1000));
}

/**
 * The tail of the live reasoning in a two-line window. The text is laid
 * out at full height and translated up so its last lines sit in the
 * window; the translate is transitioned, so each new line steps the
 * transcript up rather than snapping it. `idle` (between thoughts, the
 * turn still working) rests it on the last lines, dimmed.
 */
function ReasoningTicker({ text, idle }: { text: string; idle: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const scroll = scrollRef.current;
    if (viewport === null || scroll === null) return;
    const offset = Math.max(0, scroll.offsetHeight - viewport.clientHeight);
    scroll.style.transform = `translateY(${String(-offset)}px)`;
  }, [text]);
  return (
    <div
      ref={viewportRef}
      className="chat-reasoning-ticker"
      style={{ "--ticker-lines": TICKER_LINES } as React.CSSProperties}
      data-testid="reasoning-ticker"
      data-idle={idle ? "" : undefined}
      aria-hidden="true"
    >
      <div ref={scrollRef} className="chat-reasoning-scroll">
        {text.trim() === "" ? "…" : text}
      </div>
    </div>
  );
}
