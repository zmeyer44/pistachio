import { useEffect, useRef, useState } from "react";
import { advanceReveal, revealCut } from "../../lib/smooth-text";

/**
 * The prefix of a streamed reply to show right now (lib/smooth-text.ts).
 *
 * `target` is the reply as far as the shell has it; what comes back trails
 * it by a few words and closes the gap a frame at a time, so the text
 * flows at a steady pace rather than jumping a clause at every publish.
 * Whatever is showing when the hook mounts shows at once — a page opened
 * mid-reply does not replay the reply — and the pacing applies only to
 * words that land afterwards. Once `streaming` is false the rest settles
 * quickly and the hook goes quiet.
 */
export function useSmoothText(target: string, streaming: boolean): { text: string; settled: boolean } {
  const shownRef = useRef(target.length);
  const [shown, setShown] = useState(target.length);
  const reduceMotion = useRef(typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  useEffect(() => {
    // Snap when the text was replaced (a new step's reply), or when motion is unwelcome.
    if (target.length < shownRef.current || reduceMotion.current) {
      shownRef.current = target.length;
      setShown(target.length);
      return;
    }
    if (target.length === shownRef.current) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = advanceReveal(shownRef.current, target.length, now - last, streaming);
      last = now;
      shownRef.current = next;
      setShown(next);
      if (next < target.length) frame = requestAnimationFrame(tick);
      else frame = 0;
    };
    frame = requestAnimationFrame(tick);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [target, streaming]);

  const length = Math.min(shown, target.length);
  const cut = streaming ? revealCut(target, length) : length >= target.length ? target.length : revealCut(target, length);
  return { text: target.slice(0, cut), settled: cut >= target.length };
}
