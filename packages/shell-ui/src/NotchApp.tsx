/**
 * The desk's idle nub over a live page (docs/desk.md, "The foot"): a
 * utility chrome view of its own (main/chrome-view.ts, id "notch"), because
 * a tab's view paints over everything the shell draws, and the nub is to lie
 * over the windows' pages in the desk's trailing foot corner, not to cut
 * them short. The shell says where it is and what it shows while a live page
 * is under it (DeskBar → main); the view is the box the nub may fill, its
 * bottom-right corner the desk's, cut to the nub's outline. The pointer on it
 * and a press go back to the shell's Bar, which swells the nub and opens its
 * menu as if the pointer were on it — and once what it opens has made the
 * page under it a still, this view goes.
 *
 * The swell is drawn here too, read off the same clock as the shell's own
 * (DeskNotchFrame.swelling, nub-motion's swellAt): the view's box holds the
 * nub swelled, so it only changes its outline as it swells, never its box.
 *
 * Elsewhere the nub is a hole down to the shell's ground; here a page lies
 * under it, so the view paints that ground itself (shell.css .desk-notch-view):
 * the theme's gradient laid over the shell's ground box (`frame.ground`) as
 * the shell lays it, its grain tiled from the same corner, and cut to the
 * nub's outline.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DeskNotchFrame } from "@pistachio/shell-contracts/desk";
import { nativeApi } from "./api";
import { DeskNubMark } from "./components/desk/DeskNub";
import { swellAt, swellDone } from "./components/desk/nub-motion";
import { nubBetween, nubFace, nubOutline } from "./lib/desk/geometry";

/** The pointer moving on the view says it is there at most this often. */
const ENTER_REPEAT_MS = 100;

export function NotchApp() {
  const [frame, setFrame] = useState<DeskNotchFrame | null>(null);
  const saidEnter = useRef(Number.NEGATIVE_INFINITY);
  const rootRef = useRef<HTMLDivElement>(null);
  const faceRef = useRef<HTMLSpanElement>(null);
  const markRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const api = nativeApi();
    if (api === null) return;
    let active = true;
    let heard = false;
    void api.getDeskNotch().then((next) => {
      // A change that arrived while this was in flight is the newer word.
      if (active && !heard) setFrame(next);
    });
    const off = api.onDeskNotch((next) => {
      heard = true;
      setFrame(next);
    });
    return () => {
      active = false;
      off();
    };
  }, []);

  // The nub as it swells or settles: its outline and its face, every frame until it is still.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const face = faceRef.current;
    const mark = markRef.current;
    if (frame === null || root === null || face === null || mark === null) return;
    const { bounds, swelling } = frame;
    let raf = 0;
    const draw = (): void => {
      const s = swellAt(swelling);
      const shape = nubBetween(frame.idle, frame.swell, s);
      root.style.clipPath = `path("${nubOutline(shape, bounds.width, bounds.height, frame.corner, 0, 0)}")`;
      const at = nubFace(shape);
      face.style.left = `${(bounds.width + at.x).toFixed(2)}px`;
      face.style.top = `${(bounds.height + at.y).toFixed(2)}px`;
      mark.style.transform = `scale(${(1 + 0.08 * s).toFixed(4)})`;
      if (!swellDone(swelling)) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [frame]);

  if (frame === null) return null;
  const send = (input: "enter" | "leave" | "press"): void => nativeApi()?.sendDeskNotchInput(input);
  // Hidden under the pointer (once what the nub opens has made the page under it a still), the view never hears it
  // go, and shown again its page has the pointer there still: the coming it then reports may be no one's (the shell
  // checks the OS's pointer), and a real one, onto a button its page thinks is under the pointer already, would go
  // unsaid. So a move on it says so too.
  const enter = (): void => {
    const now = performance.now();
    if (now - saidEnter.current < ENTER_REPEAT_MS) return;
    saidEnter.current = now;
    send("enter");
  };
  const { bounds, ground } = frame;
  const px = (value: number): string => `${value.toFixed(1)}px`;
  return (
    <div
      ref={rootRef}
      className="desk-notch-view tab-group-tone"
      data-group-color={frame.color}
      style={
        {
          // The shell's ground box, where it lies from this view's corner.
          "--desk-notch-ground-x": px(ground.x - bounds.x),
          "--desk-notch-ground-y": px(ground.y - bounds.y),
          "--desk-notch-ground-w": px(ground.width),
          "--desk-notch-ground-h": px(ground.height),
        } as React.CSSProperties
      }
    >
      <button
        type="button"
        className="desk-notch-view-hit"
        data-testid="desk-notch-view"
        aria-label={frame.shortcut === null ? frame.label : `${frame.label} (${frame.shortcut})`}
        onPointerEnter={enter}
        onPointerMove={enter}
        onPointerLeave={() => {
          saidEnter.current = Number.NEGATIVE_INFINITY;
          send("leave");
        }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => send("press")}
      >
        <span ref={faceRef} className="desk-notch-view-face">
          <DeskNubMark ref={markRef} acting={frame.acting} floating={frame.floating} />
        </span>
      </button>
    </div>
  );
}
