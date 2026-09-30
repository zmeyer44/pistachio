/**
 * Opening a tab group's desk (components/desk), from the group's row, its
 * chip or its menu. The desk is the native surface's — a stream pane has
 * no page view to free — so on the web there is nothing to open.
 */

import { nativeApi } from "../../api";
import { useAppStore } from "../../store";
import { useDeskStore } from "./store";

export function deskAvailable(): boolean {
  return nativeApi() !== null;
}

/**
 * Open the group's desk, or put it away if it is the one up. The sidebar is
 * put away while a desk is up (layouts/SidebarLayout.tsx), and in the
 * sidebar layout the desk opens once it has gone. Another group's desk
 * up, it passes to this group in place.
 */
export function toggleDesk(groupId: string): void {
  if (!deskAvailable()) return;
  const desk = useDeskStore.getState();
  if (desk.groupId === groupId || desk.opening === groupId) {
    desk.leave();
    return;
  }
  if (desk.groupId !== null && !desk.leaving) {
    desk.switchTo(groupId);
    return;
  }
  if (desk.groupId !== null) desk.leave({ immediate: true });
  useDeskStore.getState().open(groupId, { afterSidebar: useAppStore.getState().settings.layout.mode === "sidebar" });
}

/**
 * The desk that is up arranges its windows (its dock's More card, or a
 * keyboard shortcut, which can come from anywhere in the shell). The desk's
 * surface lends its engine here while it is mounted (lendDeskArrange).
 */
let arrangeUp: ((kind: "tile" | "cascade") => void) | null = null;

export function lendDeskArrange(arrange: ((kind: "tile" | "cascade") => void) | null): void {
  arrangeUp = arrange;
}

/** Tile or cascade the desk's windows; false with no desk up (the shortcut is then no one's). */
export function arrangeDesk(kind: "tile" | "cascade"): boolean {
  const desk = useDeskStore.getState();
  if (arrangeUp === null || desk.groupId === null || desk.leaving) return false;
  arrangeUp(kind);
  return true;
}
