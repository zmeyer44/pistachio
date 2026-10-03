/**
 * The desk's idle Bar over a live page (docs/desk.md, "The foot"): a utility
 * chrome view of its own (main/chrome-view.ts, id "notch"), because a tab's
 * view paints over everything the shell draws, and the notch is to lie over
 * the windows' pages, not to cut them short. The shell says where it is and
 * what it says while a live page is under it (DeskBar → main); the view is
 * the notch, edge to edge: its shoulders, and the flares into the desk's
 * foot. The pointer on it and a press go back to the shell's Bar, which grows
 * from there as if the pointer were on it — and once it has, this view goes.
 */

import { useEffect, useState } from "react";
import type { DeskNotchFrame } from "@pistachio/shell-contracts/desk";
import { nativeApi } from "./api";
import { DeskNotchFace } from "./components/desk/DeskNotchFace";

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
  return (
    <div
      className="desk-notch-view tab-group-tone"
      data-group-color={frame.color}
      style={{ "--desk-notch-radius": `${String(frame.radius)}px`, "--desk-notch-flare": `${String(frame.flare)}px` } as React.CSSProperties}
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
