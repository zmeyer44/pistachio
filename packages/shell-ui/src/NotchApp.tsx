/**
 * The desk's idle Bar over a live page (docs/desk.md, "The foot"): a utility
 * chrome view of its own (main/chrome-view.ts, id "notch"), because a tab's
 * view paints over everything the shell draws, and the notch is to lie over
 * the windows' pages, not to cut them short. The shell says where it is and
 * what it says while a live page is under it (DeskBar → main); the view is
 * the notch, edge to edge: its shoulders, and the flares into the desk's
 * foot. The pointer on it and a press go back to the shell's Bar, which grows
 * from there as if the pointer were on it — and once it has, this view goes.
 *
 * Elsewhere the notch is a hole down to the shell's ground; here a page lies
 * under it, so the view paints that ground itself (shell.css .desk-notch-view):
 * the theme's gradient laid over the shell's ground box (`frame.ground`) as
 * the shell lays it, its grain tiled from the same corner, and cut to the
 * notch's outline.
 */

import { useEffect, useState } from "react";
import type { DeskNotchFrame } from "@pistachio/shell-contracts/desk";
import { nativeApi } from "./api";
import { DeskNotchFace } from "./components/desk/DeskNotchFace";
import { notchOutline } from "./lib/desk/geometry";

export function NotchApp() {
  const [frame, setFrame] = useState<DeskNotchFrame | null>(null);

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

  if (frame === null) return null;
  const send = (input: "enter" | "leave" | "press"): void => nativeApi()?.sendDeskNotchInput(input);
  const { bounds, ground, flare } = frame;
  const outline = notchOutline({ x: flare, y: 0, w: bounds.width - flare * 2, h: bounds.height, radius: frame.radius, flare }, bounds.height, 0, 0);
  const px = (value: number): string => `${value.toFixed(1)}px`;
  return (
    <div
      className="desk-notch-view tab-group-tone"
      data-group-color={frame.color}
      style={
        {
          "--desk-notch-radius": `${String(frame.radius)}px`,
          "--desk-notch-flare": `${String(flare)}px`,
          // The shell's ground box, where it lies from this view's corner.
          "--desk-notch-ground-x": px(ground.x - bounds.x),
          "--desk-notch-ground-y": px(ground.y - bounds.y),
          "--desk-notch-ground-w": px(ground.width),
          "--desk-notch-ground-h": px(ground.height),
          clipPath: `path("${outline}")`,
        } as React.CSSProperties
      }
    >
      <button
        type="button"
        className="desk-notch-view-face"
        data-testid="desk-notch-view"
        aria-label={frame.label}
        onPointerEnter={() => send("enter")}
        onPointerLeave={() => send("leave")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => send("press")}
      >
        <DeskNotchFace label={frame.label} shortcut={frame.shortcut} />
      </button>
    </div>
  );
}
