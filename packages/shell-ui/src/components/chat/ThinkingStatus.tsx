import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

/** How long the outgoing line takes to leave; the incoming one enters over the same span. */
const SWAP_MS = 180;

/**
 * The status line under a reply that is not written yet — "Thinking…",
 * "Searching saved pages…", "Working in your browser…" — shimmering while
 * a state holds and swapping to the next with the outgoing line rising out
 * through a small blur as the new one rises in (the thinking-states
 * pattern). Both lines are laid over the same box, so a swap costs one
 * SWAP_MS and the line never jumps in height.
 *
 * `shimmer` off holds the line still (a settled state still swaps in);
 * `announce` off drops the live region, for a line whose every change
 * would be noise read aloud — a turn's steps narrating each tool call.
 */
export function ThinkingStatus({
  text,
  className,
  testId = "thinking-status",
  shimmer = true,
  announce = true,
}: {
  text: string;
  className?: string;
  testId?: string;
  shimmer?: boolean;
  announce?: boolean;
}) {
  const [current, setCurrent] = useState(text);
  const [leaving, setLeaving] = useState<string | null>(null);
  const timer = useRef(0);
  useEffect(() => {
    if (text === current) return;
    setLeaving(current);
    setCurrent(text);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setLeaving(null), SWAP_MS + 30);
    return () => window.clearTimeout(timer.current);
  }, [text, current]);
  return (
    <span
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : undefined}
      data-testid={testId}
      className={cn("chat-think", className)}
    >
      {/* The sizer keeps the box as wide as the longer of the two lines through a swap. */}
      <span className="chat-think-sizer" aria-hidden="true">
        {leaving !== null && leaving.length > current.length ? leaving : current}
      </span>
      {leaving === null ? null : (
        <span key={`out:${leaving}`} className="chat-think-text chat-think-exit" aria-hidden="true">
          {leaving}
        </span>
      )}
      <span key={`in:${current}`} className={cn("chat-think-text", shimmer && "agent-shimmer", leaving !== null && "chat-think-enter")}>
        {current}
      </span>
    </span>
  );
}
