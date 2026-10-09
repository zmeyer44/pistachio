import { SIDEBAR_DESK_TRIGGER_W, SIDEBAR_EDGE_W, SIDEBAR_TRIGGER_W } from "@pistachio/shell-contracts/chrome";
import { veiledOf } from "../chrome/shell-host";
import { cn } from "../lib/cn";
import { deskAvailable, deskEngine } from "../lib/desk/open";
import { useAppStore } from "../store";
import { useScreenShares, useScreenShareStartNotice } from "./ScreenShareIndicator";

/**
 * The hidden sidebar's trigger: the column the shell keeps at the window's
 * left edge while the sidebar is hidden. Pointer movement inside it brings
 * the sidebar's column out (layouts/SidebarLayout.tsx) — on the desk over the
 * desk's windows, on the web back into the layout in this column's place;
 * nothing paints here but a faint handle on hover, the hint that the edge is
 * live — or, while a tab shares the screen, a red one that stays.
 *
 * The arrival is a pointer MOVE inside the column, never `pointerenter`:
 * Chromium synthesizes an enter for whatever lands under a cursor that has
 * not moved — this column mounting at launch, or when hidden is chosen —
 * and a sidebar that opens by itself because the cursor happened to rest at
 * the window's edge is exactly the launch nobody can predict. A move is the
 * person's.
 *
 * On the web it overlaps the page (SIDEBAR_TRIGGER_W) instead of widening the
 * layout slot, so the page card keeps its original clearance; main mirrors
 * the target with the OS pointer where a native view sits over its last
 * pixels. On the desk it is half the slot's strip (SIDEBAR_DESK_TRIGGER_W,
 * since 2026-10-09): the wider target lay wholly over the west resize edge of
 * a window flush with the desk's leading edge.
 */
export function SidebarEdge() {
  // With the sidebar out of sight, so is a screen share's card: the handle
  // stays up in the share's red while one runs, and a share that begins
  // meanwhile says so as a notice.
  const shares = useScreenShares();
  const sharing = shares.length > 0;
  useScreenShareStartNotice(shares);
  return (
    <div
      data-testid="sidebar-edge"
      data-screen-share={sharing ? "" : undefined}
      className="no-drag group absolute inset-y-0 left-0 z-10 shrink-0"
      style={{ width: deskAvailable() ? SIDEBAR_DESK_TRIGGER_W : SIDEBAR_TRIGGER_W }}
      onPointerMove={revealSidebar}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute top-1/2 w-[3px] -translate-1/2 rounded-full transition-opacity duration-150",
          sharing ? "sidebar-edge-share h-12 bg-red-700" : "h-8 bg-alpha-500 opacity-0 group-hover:opacity-100",
        )}
        style={{ left: SIDEBAR_EDGE_W / 2 }}
      />
    </div>
  );
}

/**
 * The pointer came to the hidden sidebar's edge (this column, or main's
 * watch of it): it is brought out — the reveal's intent, the store's
 * `sidebarRevealed` — unless the column coming out would be in the way of
 * what has the pointer: a window in hand on the desk (carried to the desk's
 * leading edge, it passes over the strip), a row being dragged, a column
 * being resized, or an overlay over the shell (the palette, a menu; main's
 * watch is off under one too).
 */
export function revealSidebar(): void {
  const state = useAppStore.getState();
  if (state.sidebarRevealed || state.tabDragging || state.paneResizing || veiledOf(state)) return;
  if ((deskEngine()?.getView().gesture ?? null) !== null) return;
  state.setSidebarRevealed(true);
}
