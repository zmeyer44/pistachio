import { useEffect, useState } from "react";
import { shellApi } from "../api";
import { FIND_BAR, FIND_BAR_ROOM } from "@pistachio/shell-contracts/browser-controls";
import { FindApp } from "../FindApp";

/**
 * The find bar on a stream surface. The desktop draws `FindApp` in a native
 * overlay view that main places over the active pane and shows while find is
 * open; the web app has no such view, so the same bar is an ordinary element
 * in the active pane's corner, shown by the same `FindState.open`.
 */
export function StreamFindBar() {
  const [open, setOpen] = useState(false);
  const [smart, setSmart] = useState(false);
  useEffect(() => {
    let active = true;
    void shellApi().getFindState().then((state) => {
      if (!active) return;
      setOpen(state.open);
      setSmart(state.mode === "smart");
    });
    const off = shellApi().onFindStateChanged((state) => {
      setOpen(state.open);
      setSmart(state.mode === "smart");
    });
    return () => {
      active = false;
      off();
    };
  }, []);
  if (!open) return null;
  // The desktop overlay's geometry (apps/desktop main, `publishFind`): the
  // card plus the room its shadow paints into, which lets the page's clicks through.
  const height = smart ? FIND_BAR.height + FIND_BAR.detailHeight : FIND_BAR.height;
  const width = smart ? FIND_BAR.smartWidth : FIND_BAR.width;
  return (
    <div
      data-testid="stream-find-bar"
      className="pointer-events-none absolute z-20 [&_[data-find-card]]:pointer-events-auto"
      style={{
        top: FIND_BAR.inset - FIND_BAR_ROOM.top,
        right: FIND_BAR.inset - FIND_BAR_ROOM.side,
        height: height + FIND_BAR_ROOM.top + FIND_BAR_ROOM.bottom,
        width: `min(${width + 2 * FIND_BAR_ROOM.side}px, calc(100% - ${2 * (FIND_BAR.inset - FIND_BAR_ROOM.side)}px))`,
      }}
    >
      <FindApp />
    </div>
  );
}
