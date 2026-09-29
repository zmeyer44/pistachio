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
 * sidebar layout the desk opens once it has gone.
 */
export function toggleDesk(groupId: string): void {
  if (!deskAvailable()) return;
  const desk = useDeskStore.getState();
  if (desk.groupId === groupId || desk.opening === groupId) {
    desk.leave();
    return;
  }
  if (desk.groupId !== null) desk.leave({ immediate: true });
  useDeskStore.getState().open(groupId, { afterSidebar: useAppStore.getState().settings.layout.mode === "sidebar" });
}
