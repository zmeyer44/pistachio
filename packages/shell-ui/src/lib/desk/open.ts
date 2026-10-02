/**
 * Opening a tab group's desk (components/desk), from the group's row, its
 * chip or its menu. The desk is the native surface's — a stream pane has
 * no page view to free — so on the web there is nothing to open.
 */

import type { DeskEngine } from "../../components/desk/desk-engine";
import { nativeApi } from "../../api";
import { useAppStore } from "../../store";
import { useDeskStore } from "./store";

export function deskAvailable(): boolean {
  return nativeApi() !== null;
}

/**
 * Open the group's desk, or put it away if it is the one up. While a desk is
 * up the sidebar's column is its dock (layouts/SidebarLayout.tsx's
 * SidebarColumn), and the desk opens once the column has settled at its desk
 * width. Another group's desk up, it passes to this group in place.
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
  useDeskStore.getState().open(groupId, { afterSidebar: true });
}

/**
 * The Toggle desk shortcut, from anywhere in the shell or a page: the desk
 * that is up is left; with none up, the tab in use opens its group's desk.
 * A tab in no group has no desk, and a notice says how to get one.
 */
export function toggleDeskOfActiveTab(): boolean {
  if (!deskAvailable()) return false;
  const desk = useDeskStore.getState();
  if (desk.groupId !== null && !desk.leaving) {
    desk.leave();
    return true;
  }
  const store = useAppStore.getState();
  const snapshot = store.snapshot;
  const activeTabId = snapshot?.activeTabId ?? null;
  if (snapshot === null || activeTabId === null) return false;
  const group = snapshot.tabGroups.find((candidate) => candidate.tabIds.includes(activeTabId));
  if (group === undefined) {
    store.showNotice("A desk is a tab group's: put this tab in a group to open it as a desk");
    return true;
  }
  toggleDesk(group.id);
  return true;
}

/**
 * The desk that is up arranges its windows (its dock's More card, or a
 * keyboard shortcut, which can come from anywhere in the shell). The desk's
 * surface lends its engine here while it is mounted (lendDeskArrange).
 */
let arrangeUp: ((kind: DeskArrangement) => void) | null = null;

/** Tile, cascade, or — smart — the layout the desk's layout model judges best (docs/desk-layout.md). */
export type DeskArrangement = "tile" | "cascade" | "smart";

export function lendDeskArrange(arrange: ((kind: DeskArrangement) => void) | null): void {
  arrangeUp = arrange;
}

/** Tile, cascade or arrange the desk's windows; false with no desk up (the shortcut is then no one's). */
export function arrangeDesk(kind: DeskArrangement): boolean {
  const desk = useDeskStore.getState();
  if (arrangeUp === null || desk.groupId === null || desk.leaving) return false;
  arrangeUp(kind);
  return true;
}

/**
 * ⌘I on a desk puts the keyboard in its Bar (docs/desk-agent.md §1) rather
 * than opening the sidebar's chat: the desk's surface lends its Bar here
 * while it is mounted (lendDeskAsk).
 */
let askUp: (() => void) | null = null;

export function lendDeskAsk(ask: (() => void) | null): void {
  askUp = ask;
}

/** The Bar takes the keyboard; false with no desk up (⌘I then toggles the chat as ever). */
export function askDesk(): boolean {
  const desk = useDeskStore.getState();
  if (askUp === null || desk.groupId === null || desk.leaving) return false;
  askUp();
  return true;
}

/**
 * The desk that is up, for the sidebar — its dock — to act on its windows:
 * a tab's row brings its window out or puts it away from its menu, and a row
 * pulled out over the desk is its window in hand (chrome/shelf-drag.tsx).
 * The desk's surface lends its engine here while it is mounted.
 */
let engineUp: DeskEngine | null = null;

export function lendDeskEngine(engine: DeskEngine | null): void {
  engineUp = engine;
}

/** The desk's engine while one is up and open (not leaving), or null. */
export function deskEngine(): DeskEngine | null {
  const desk = useDeskStore.getState();
  return desk.groupId === null || desk.leaving ? null : engineUp;
}

/** How long a tab that just joined the desk's group may take to reach the desk (the snapshot that says so). */
const JOIN_WAIT_MS = 1500;

/**
 * A tab's row let go over the desk (chrome/shelf-drag.tsx): its window comes
 * out where it was let go. A tab that is not the group's joins it first —
 * the desk hears of it with the snapshot that says so.
 */
export async function dropTabOnDesk(tabId: string, client: { x: number; y: number }): Promise<void> {
  const groupId = useDeskStore.getState().groupId;
  const engine = deskEngine();
  if (groupId === null || engine === null) return;
  if (!engine.hasGroupTab(tabId)) {
    const joined = await useAppStore.getState().tabGroupCommand({ type: "addTab", groupId, tabId });
    if (joined === null) return;
    const until = performance.now() + JOIN_WAIT_MS;
    while (deskEngine()?.hasGroupTab(tabId) !== true) {
      if (performance.now() > until || useDeskStore.getState().groupId !== groupId) return;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }
  deskEngine()?.addAt(tabId, client);
}
