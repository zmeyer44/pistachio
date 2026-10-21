import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { RunSummary } from "@pistachio/protocol";
import { cn } from "../../lib/cn";

/**
 * Its children at their own height, the height eased from one to the next
 * as they grow or shrink — a step added, the reasoning opening or folding,
 * the reply's first words — so what a thread's live turn draws never jumps,
 * as the high-end chats' never does. It clips while it eases (a little past
 * its edges, for rings and shadows); at rest it is the content's own height.
 */
export function SmoothHeight({ children, className }: { children: ReactNode; className?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (box === null || content === null || typeof ResizeObserver === "undefined") return;
    let last = content.offsetHeight;
    box.style.height = `${String(last)}px`;
    const observer = new ResizeObserver(() => {
      const next = content.offsetHeight;
      if (next === last) return;
      last = next;
      box.style.height = `${String(next)}px`;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={outer} className={cn("chat-smooth-height", className)}>
      <div ref={inner} className="flow-root">
        {children}
      </div>
    </div>
  );
}

/**
 * How long a step's words must stay before they read as the reply. A step
 * that goes on to call a tool says a few words first ("Let me look that
 * up.") and the controller drops them as the call starts
 * (run-controller.ts #streamCallbacks): folding the live turn for those
 * would fold it only to open it again.
 */
export const REPLY_SETTLE_MS = 600;

/**
 * Whether the live turn's reply has begun: its words have stayed a moment
 * (REPLY_SETTLE_MS). Until then the turn's work — its steps, its reasoning —
 * stays open and only grows; from then it folds, once.
 */
export function useReplyBegun(run: Pick<RunSummary, "draft"> | null): boolean {
  const words = (run?.draft?.text ?? "") !== "";
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!words) {
      setHeld(false);
      return;
    }
    const timer = window.setTimeout(() => setHeld(true), REPLY_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [words]);
  return words && held;
}
