/**
 * The layer of the marks that belong to a window — the outlines of the
 * windows guests may use, and the names on them — under the browser's own
 * surfaces over the desk (docs/live-share.md §6.3). This window lies over
 * the whole browser window, so whatever it draws is over the shell's too: a
 * toast, the Live card, a menu, the palette. Main says where those lie
 * (`onChrome`, window px), and the layer is clipped to what they leave of
 * the window (chrome-cut.ts) — or not drawn at all while something no box
 * holds lies over the desk. Set by ref as main's word changes and as the
 * window is resized, never per frame: the outlines inside it move on their
 * own. The pointers, ink, pings, reactions, faces and pill are not in it:
 * they are drawn over everything, the browser's own included.
 */

import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { LiveRect } from "@pistachio/shell-contracts/live-share";
import { chromeCut } from "./chrome-cut";
import type { LiveHostSession } from "./host-session";

export function WindowMarks({ session, children }: { session: LiveHostSession; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  // (Before the layer is first painted: it never shows uncut over what is over the desk.)
  useLayoutEffect(() => {
    const layer = ref.current;
    if (layer === null) return;
    let over: readonly LiveRect[] | null = [];
    const apply = (): void => {
      const cut = chromeCut(over, { w: window.innerWidth, h: window.innerHeight });
      layer.style.visibility = cut.kind === "hidden" ? "hidden" : "";
      layer.style.clipPath = cut.kind === "cut" ? cut.clipPath : "";
      // (What it is cut out by, for whoever looks at the window from outside: the specs.)
      if (cut.kind === "whole") delete layer.dataset["cut"];
      else layer.dataset["cut"] = cut.kind === "hidden" ? "all" : JSON.stringify(cut.holes);
    };
    const off = session.onChrome((next) => {
      over = next;
      apply();
    });
    window.addEventListener("resize", apply);
    return () => {
      off();
      window.removeEventListener("resize", apply);
    };
  }, [session]);

  return (
    <div ref={ref} className="live-host-marks" data-testid="live-host-marks">
      {children}
    </div>
  );
}
