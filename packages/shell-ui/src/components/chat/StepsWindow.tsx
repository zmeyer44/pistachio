import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * A turn's steps in a window of a few lines (the user, 2026-11-19, of a turn
 * that had taken nineteen: "we should never let the tools list get this tall
 * in the AI chat"). Until then the list was as tall as its steps, and a long
 * turn pushed everything else in the thread out of sight.
 *
 * The window is no taller than `--steps-window` (shell.css `.steps-window`):
 * a turn of a few steps is drawn whole, as before; past that the list
 * scrolls inside it, its edges faded where there is more beyond them — the
 * top once it has been scrolled, the foot until it is at its end (shadcn's
 * `scroll-fade`, ui.shadcn.com/docs/changelog/2026-06-chat-components: a
 * mask driven by the scroll position itself, in CSS, with no listener).
 *
 * While the turn works (`follow`) the window keeps to the newest step: each
 * one that comes scrolls it to its foot, eased. It is the person's the
 * moment they scroll it or press in it — a step opened to read is not
 * carried off by the next — and follows again once they are back at its
 * foot. A finished turn opened to read starts at its first step.
 */

/** Within this of its end (px), the window is at its foot. */
const FOOT_SLACK = 6;

function calm(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function StepsWindow({ follow, children, className }: { follow: boolean; children: ReactNode; className?: string }) {
  const windowRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(follow);
  following.current = follow;
  /** Kept on the newest step: the person's from their first scroll or press in it, until they are back at its foot. */
  const held = useRef(true);
  /** A scroll of the window's own is on its way: what it passes is not the person's doing. */
  const own = useRef(false);

  useLayoutEffect(() => {
    const el = windowRef.current;
    const content = contentRef.current;
    if (el === null || content === null) return;
    const atFoot = (): boolean => el.scrollHeight - el.scrollTop - el.clientHeight <= FOOT_SLACK;
    const toFoot = (eased: boolean): void => {
      if (atFoot()) return;
      own.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior: eased && !calm() ? "smooth" : "instant" });
      if (atFoot()) own.current = false;
    };
    const scrolled = (): void => {
      if (own.current) {
        if (atFoot()) own.current = false;
        return;
      }
      held.current = atFoot();
    };
    const settled = (): void => {
      own.current = false;
    };
    // The person's own: a wheel or a touch moves it from here on, and a press in it (a step opened to read, the
    // scrollbar taken) leaves it where it is.
    const wheeled = (): void => {
      own.current = false;
    };
    const pressed = (): void => {
      own.current = false;
      held.current = false;
    };
    let shown = el.clientHeight > 0;
    const grown = (): void => {
      const visible = el.clientHeight > 0;
      // Opened (the turn's line pressed, or the turn come to work): on the newest step while it works; from its first
      // step once it is done and somebody opens it to read.
      if (visible && !shown) {
        own.current = false;
        held.current = true;
        if (following.current) toFoot(false);
        else el.scrollTop = 0;
      } else if (visible && following.current && held.current) toFoot(true);
      shown = visible;
    };
    if (shown && following.current) toFoot(false);
    el.addEventListener("scroll", scrolled, { passive: true });
    el.addEventListener("scrollend", settled);
    el.addEventListener("wheel", wheeled, { passive: true });
    el.addEventListener("touchmove", wheeled, { passive: true });
    el.addEventListener("pointerdown", pressed);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(grown);
    observer?.observe(content);
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", scrolled);
      el.removeEventListener("scrollend", settled);
      el.removeEventListener("wheel", wheeled);
      el.removeEventListener("touchmove", wheeled);
      el.removeEventListener("pointerdown", pressed);
      observer?.disconnect();
    };
  }, []);

  // A turn come to work again (the same list, a step held for the person now given): on its newest step from here.
  useLayoutEffect(() => {
    const el = windowRef.current;
    if (!follow || el === null) return;
    held.current = true;
    if (el.clientHeight > 0 && el.scrollHeight - el.scrollTop - el.clientHeight > FOOT_SLACK) {
      own.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
      own.current = false;
    }
  }, [follow]);

  return (
    <div ref={windowRef} className={cn("steps-window", className)} data-testid="steps-window" data-follow={follow ? "" : undefined}>
      <div ref={contentRef} className="flow-root">
        {children}
      </div>
    </div>
  );
}
