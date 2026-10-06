/**
 * Opening a tab group's desk (components/desk), from the group's row, its
 * chip or its menu. The desk is the native surface's — a stream pane has
 * no page view to free — so on the web there is nothing to open.
 */

import { useCallback, useSyncExternalStore } from "react";
import type { DeskEngine } from "../../components/desk/desk-engine";
import { nativeApi } from "../../api";
import { useAppStore } from "../../store";
import { deskGroups, isDayTab, isEntryPage, tabDeskId, tabDeskOf, useDeskStore } from "./store";

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
 * that is up is left; with none up, the tab in use opens its desk — its
 * group's, or, in no group, its own (deskFor).
 */
export function toggleDeskOfActiveTab(): boolean {
  if (!deskAvailable()) return false;
  const desk = useDeskStore.getState();
  if (desk.groupId !== null && !desk.leaving) {
    desk.leave();
    return true;
  }
  const activeTabId = useAppStore.getState().snapshot?.activeTabId ?? null;
  if (activeTabId === null) return false;
  void deskFor(activeTabId).then((deskId) => {
    const now = useDeskStore.getState();
    if (deskId !== null && now.groupId === null && now.opening === null) toggleDesk(deskId);
  });
  return true;
}

/** How long a group just made, or a tab that just joined the desk's group, may take to reach the snapshot. */
const JOIN_WAIT_MS = 1500;

/**
 * The desk a tab is shown on (docs/desk.md): its group's — one the chrome
 * draws, a loose tab's or a page's. A day tab in no group gets a loose
 * tab's group made for it now (TabGroupInfo.loose), and a favorite's or a
 * pinned page's a page's group (TabGroupInfo.anchorId), so that its desk has
 * all a group's does; any other tab, which no group can hold, a desk of its
 * own (tabDeskId), as a page's does should its group not come. Null for a
 * tab that is gone, or not in the Space in view, or when a day tab's group
 * could not be made.
 */
export async function deskFor(tabId: string): Promise<string | null> {
  const snapshot = useAppStore.getState().snapshot;
  const tab = snapshot?.tabs.find((candidate) => candidate.id === tabId);
  if (snapshot === null || tab === undefined || tab.spaceId !== snapshot.activeSpaceId) return null;
  const group = deskGroups(snapshot).find((candidate) => candidate.tabIds.includes(tabId));
  if (group !== undefined) return group.id;
  const page = isEntryPage(tab);
  if (!page && !isDayTab(tab)) return tabDeskId(tabId);
  const fallback = page ? tabDeskId(tabId) : null;
  const id = crypto.randomUUID();
  const made = await useAppStore.getState().tabGroupCommand({ type: "create", id, tabIds: [tabId], ...(page ? { anchored: true } : { loose: true }) });
  if (made === null) return fallback;
  // Its desk can be up once the snapshot lists it.
  const until = performance.now() + JOIN_WAIT_MS;
  while (!deskGroups(useAppStore.getState().snapshot).some((candidate) => candidate.id === id)) {
    if (performance.now() > until) return fallback;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  // A page whose own desk was up before it had a group: its window comes back where that desk left it.
  const desk = useDeskStore.getState();
  const before = desk.saved[tabDeskId(tabId)];
  if (page && before !== undefined && desk.saved[id] === undefined) desk.save(id, before);
  return id;
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

const engineListeners = new Set<() => void>();

export function lendDeskEngine(engine: DeskEngine | null): void {
  engineUp = engine;
  for (const listener of engineListeners) listener();
}

/**
 * The tabs with a window on the desk that is up — one flying into its row
 * included — as one key ("" with no desk). A page is the desk's while its
 * window is: a picture of it elsewhere (the media stack's card, the rail's
 * floating player) waits until the window has gone, or main's layout, which
 * still has the page in it, would take the picture back.
 */
export function useDeskWindowKey(): string {
  const engine = useDeskEngine();
  return useSyncExternalStore(
    useCallback((listener: () => void) => engine?.subscribe(listener) ?? (() => undefined), [engine]),
    () => (engine === null ? "" : engine.getView().windows.map((window) => window.tabId).join(" ")),
    () => "",
  );
}

/** deskEngine() for a component: rendered again as an engine is lent, taken back, or its desk leaves. */
export function useDeskEngine(): DeskEngine | null {
  const lent = useSyncExternalStore(
    (listener) => {
      engineListeners.add(listener);
      return () => engineListeners.delete(listener);
    },
    () => engineUp,
    () => null,
  );
  const open = useDeskStore((state) => state.groupId !== null && !state.leaving);
  return open ? lent : null;
}

/** The desk's engine while one is up and open (not leaving), or null. */
export function deskEngine(): DeskEngine | null {
  const desk = useDeskStore.getState();
  return desk.groupId === null || desk.leaving ? null : engineUp;
}

/**
 * A tab of the desk's group shown on the desk: its window out, or back out,
 * in use (the media stack's "show the tab", the floating player's "back to
 * the desk"). Through the engine, not by selecting the tab: a window sent
 * out of the desk leaves its tab the one in use when it was the last out,
 * and selecting it again would change nothing. False for any other tab
 * (no desk, or another group's): selecting it is the browser's, and the
 * desk passes to its own.
 */
export function showOnDesk(tabId: string): boolean {
  const engine = deskEngine();
  if (engine === null || !engine.hasGroupTab(tabId)) return false;
  engine.add(tabId, { focus: true });
  return true;
}

/**
 * A new tab on the desk that is up (⌘T, the sidebar's +): in the desk's
 * group, on the home page, brought out as the window in use. On a loose
 * tab's desk that makes its group one of two, drawn as any group is from
 * then on (main). A page's own desk has no group to hold it: the new tab is
 * a loose one, and the desk passes to it (DeskSurface).
 */
export async function newTabOnDesk(): Promise<void> {
  const desk = useDeskStore.getState();
  if (desk.groupId === null || desk.leaving) return;
  const store = useAppStore.getState();
  if (tabDeskOf(desk.groupId) !== null) {
    await store.createTab(store.settings.general.homeUrl);
    return;
  }
  await store.tabGroupCommand({ type: "newTab", groupId: desk.groupId });
}

/**
 * A tab's row let go over the desk (chrome/shelf-drag.tsx): its window comes
 * out where it was let go. A tab that is not the group's joins it first —
 * the desk hears of it with the snapshot that says so. A favorite's or a
 * pin's page comes down into the group (its page's group with it), the
 * entry staying, closed. (A page's own desk has no group to take it: the
 * tab is chosen, and the desk passes to it.)
 */
export async function dropTabOnDesk(tabId: string, client: { x: number; y: number }): Promise<void> {
  const groupId = useDeskStore.getState().groupId;
  const engine = deskEngine();
  if (groupId === null || engine === null) return;
  if (tabDeskOf(groupId) !== null) {
    await useAppStore.getState().selectTab(tabId);
    return;
  }
  if (!engine.hasGroupTab(tabId)) {
    const store = useAppStore.getState();
    const anchorId = store.snapshot?.tabs.find((tab) => tab.id === tabId)?.anchorId ?? null;
    if (anchorId !== null) await store.sidebarCommand({ type: "bringDown", anchorId, groupId });
    else if ((await store.tabGroupCommand({ type: "addTab", groupId, tabId })) === null) return;
    const until = performance.now() + JOIN_WAIT_MS;
    while (deskEngine()?.hasGroupTab(tabId) !== true) {
      if (performance.now() > until || useDeskStore.getState().groupId !== groupId) return;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }
  deskEngine()?.addAt(tabId, client);
}

/**
 * A favorite or pin with no page open let go over the desk: a fresh page of
 * it comes down into the desk's group, its window out where it was let go,
 * the entry staying as it was. (A page's own desk has no group: the entry
 * opens, and the desk passes to it.)
 */
export async function dropEntryOnDesk(anchorId: string, client: { x: number; y: number }): Promise<void> {
  const groupId = useDeskStore.getState().groupId;
  const store = useAppStore.getState();
  if (groupId === null || deskEngine() === null) return;
  if (tabDeskOf(groupId) !== null) {
    await store.sidebarCommand({ type: "open", anchorId });
    return;
  }
  const members = (): readonly string[] => deskGroups(useAppStore.getState().snapshot).find((group) => group.id === groupId)?.tabIds ?? [];
  const before = new Set(members());
  await store.sidebarCommand({ type: "bringDown", anchorId, groupId });
  const until = performance.now() + JOIN_WAIT_MS;
  let fresh: string | undefined;
  while ((fresh = members().find((tabId) => !before.has(tabId) && deskEngine()?.hasGroupTab(tabId) === true)) === undefined) {
    if (performance.now() > until || useDeskStore.getState().groupId !== groupId) return;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  deskEngine()?.addAt(fresh, client);
}
