import { SIDEBAR_EDGE_W, SIDEBAR_TRIGGER_W } from "@pistachio/shell-contracts/chrome";
import { useAppStore } from "../store";

/**
 * The compact sidebar's trigger: the column the shell keeps at the window's
 * left edge while the sidebar is hidden. Pointer movement inside it brings
 * the sidebar's column back into the layout (layouts/SidebarLayout.tsx), in
 * this column's place; nothing paints here but a faint handle on hover, the
 * hint that the edge is live.
 *
 * The arrival is a pointer MOVE inside the column, never `pointerenter`:
 * Chromium synthesizes an enter for whatever lands under a cursor that has
 * not moved — this column mounting at launch, or when the layout switches —
 * and a sidebar that opens by itself because the cursor happened to rest at
 * the window's edge is exactly the launch nobody can predict. A move is the
 * person's.
 *
 * It overlaps the page instead of widening the layout slot, so the page card
 * keeps its original clearance. Main mirrors the target with the OS pointer
 * because the native tab view sits above the shell over the target's last few
 * pixels.
 */
export function SidebarEdge() {
  const setSidebarRevealed = useAppStore((s) => s.setSidebarRevealed);
  return (
    <div
      data-testid="sidebar-edge"
      className="no-drag group absolute inset-y-0 left-0 z-10 shrink-0"
      style={{ width: SIDEBAR_TRIGGER_W }}
      onPointerMove={() => setSidebarRevealed(true)}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 h-8 w-[3px] -translate-1/2 rounded-full bg-alpha-500 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        style={{ left: SIDEBAR_EDGE_W / 2 }}
      />
    </div>
  );
}
