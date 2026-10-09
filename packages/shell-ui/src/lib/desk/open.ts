/**
 * The desk (components/desk) as the rest of the shell reaches it. Since
 * 2026-10-09 the desk is the desktop browser itself (docs/spaces.md): it is
 * always up on the native surface, showing main's current space
 * (ShellSnapshot.currentGroupId), so there is nothing here to open, leave or
 * toggle — only the space to choose (`selectSpace`, main's `select`), and the
 * engine the desk lends while it is mounted. A stream pane (the web app, the
 * cloud browser) has no page view to free, and keeps the pane surface.
 */

import { useCallback, useSyncExternalStore } from "react";
import type { ShortcutSurface } from "@pistachio/shell-contracts/shortcuts";
import type { DeskEngine } from "../../components/desk/desk-engine";
import { nativeApi } from "../../api";
import { useAppStore } from "../../store";
import { deskGroups, passedEntry, useDeskStore } from "./store";

/**
 * THE predicate for "this is the desktop", where the desk is: a native
 * surface (the Mac's window, with its page views). ContentArea mounts the
 * desk on it and every helper here asks it, so the two never disagree.
 * (`useSurface().kind` says the same in all three hosts — the Mac's entry
 * provides "native", the web's and the hero's "stream" — but it is a hook,
 * and it DEFAULTS to native with no provider, as in a unit render, where
 * there is no bridge and so no desk; this one is callable from actions'
 * `enabled`, drag code and store actions, and is honest there.)
 */
export function deskAvailable(): boolean {
  return nativeApi() !== null;
}

/**
 * Whether splits can be made here: the web's alone since 2026-10-09 (a desk
 * tiles windows instead, docs/spaces.md §1). Gated on the SURFACE, never on
 * whether a desk's engine is up — that is null for the first frames of a
 * cold start, and a split let through then would be made in main.
 */
export function splitAvailable(): boolean {
  return !deskAvailable();
}

/** The surface a shortcut is offered on (ShortcutDefinition.surfaces): the desktop's, or the web's. */
export function shortcutSurface(): ShortcutSurface {
  return deskAvailable() ? "native" : "stream";
}

/** The space (tab group) the desk shows: main's current one, or null before main has named one (or where there are none). */
export function currentSpace(): string | null {
  return useAppStore.getState().snapshot?.currentGroupId ?? null;
}

/** currentSpace() for a component. */
export function useCurrentSpace(): string | null {
  return useAppStore((state) => state.snapshot?.currentGroupId ?? null);
}

/**
 * Make a space current (main's `select`): the desk passes to it. Its window
 * on top when it was left comes up in use — the arrangement is the shell's,
 * so the shell names it (passedEntry) — or, with none, main's choice: its tab
 * used last, or for an empty space nothing. The passing is marked a SPACE
 * chosen (takeSpaceChoice): the space comes up as it was left, its window
 * on top too, minimized if it was.
 */
export function selectSpace(groupId: string): void {
  const store = useAppStore.getState();
  if (store.snapshot?.currentGroupId === groupId) return;
  const group = deskGroups(store.snapshot).find((candidate) => candidate.id === groupId);
  const tabs = group === undefined ? [] : (store.snapshot?.tabs ?? []).filter((tab) => group.tabIds.includes(tab.id));
  const tabId = passedEntry(useDeskStore.getState().saved[groupId]?.windows ?? [], tabs);
  spaceChoice = { groupId, tabId, at: performance.now() };
  void store.tabGroupCommand(tabId === null ? { type: "select", groupId } : { type: "select", groupId, tabId });
}

/**
 * The space the shell itself chose (selectSpace) — and the tab it named, or
 * none — until main's snapshot makes it current and the desk passes to it.
 * The desk tells a space chosen from a TAB chosen by it (since 2026-10-09):
 * any other change of the current space with a tab in use came from a tab
 * chosen somewhere (a row of another space, the tab switcher, the palette,
 * a favorite's page, a link, the agent's tab_show), and that tab's window
 * comes out whole (revealFor).
 */
let spaceChoice: { groupId: string; tabId: string | null; at: number } | null = null;

/** How long a space chosen waits for main to make it current before it is taken for stale. */
const SPACE_CHOICE_MS = 3_000;

/**
 * Whether the passing to `groupId` (DeskSurface), its tab in use `chosen`, is
 * the space the shell chose: that space, and the tab it named (or, naming
 * none, main's choice). Read once: any passing clears the mark.
 */
export function takeSpaceChoice(groupId: string, chosen: string | null): boolean {
  const choice = spaceChoice;
  spaceChoice = null;
  return choice !== null && choice.groupId === groupId && (choice.tabId === null || choice.tabId === chosen) && performance.now() - choice.at < SPACE_CHOICE_MS;
}

/**
 * Whether the passing reveals the tab in use (DeskEngine.switchGroup's
 * `reveal`): a tab of the space in use, which a space chosen did not name.
 * A tab chosen comes out whole — minimized, it grows back — as a row chosen
 * in the space it is in does; a space chosen comes up as it was left.
 */
export function revealFor(chosen: string | null, spaceChosen: boolean): boolean {
  return chosen !== null && !spaceChosen;
}

/**
 * A new, empty space, current at once ("New space": docs/spaces.md §1).
 * Its id is the shell's, so the name field can open on it once it is in the
 * snapshot (useNewGroupNaming's `track`, which is handed the id).
 */
export async function newSpace(): Promise<string | null> {
  const id = crypto.randomUUID();
  const made = await useAppStore.getState().tabGroupCommand({ type: "create", id, tabIds: [], select: true });
  return made === null ? null : id;
}

/** How long a tab that just joined the desk's space may take to reach the snapshot. */
const JOIN_WAIT_MS = 1500;

/**
 * The desk arranges its windows (its dock's More card, or a keyboard
 * shortcut, which can come from anywhere in the shell). The desk's surface
 * lends its engine here while it is mounted (lendDeskArrange).
 */
let arrangeUp: ((kind: DeskArrangement) => void) | null = null;

/** Tile, cascade, or — smart — the layout the desk's layout model judges best (docs/desk-layout.md). */
export type DeskArrangement = "tile" | "cascade" | "smart";

export function lendDeskArrange(arrange: ((kind: DeskArrangement) => void) | null): void {
  arrangeUp = arrange;
}

/** Tile, cascade or arrange the desk's windows; false before the desk's engine is up, or off the desktop (the shortcut is then no one's). */
export function arrangeDesk(kind: DeskArrangement): boolean {
  if (arrangeUp === null) return false;
  arrangeUp(kind);
  return true;
}

/**
 * ⌘I on the desk puts the keyboard in its Bar (docs/desk-agent.md §1)
 * rather than opening the sidebar's chat: the desk's surface lends its Bar
 * here while it is mounted (lendDeskAsk).
 */
let askUp: (() => void) | null = null;

export function lendDeskAsk(ask: (() => void) | null): void {
  askUp = ask;
}

/** The Bar takes the keyboard; false before the desk's engine is up, or off the desktop (⌘I then toggles the chat as ever). */
export function askDesk(): boolean {
  if (askUp === null) return false;
  askUp();
  return true;
}

/**
 * The desk, for the sidebar — its dock — to act on its windows: a tab's row
 * brings its window out or puts it away from its menu, and a row pulled out
 * over the desk is its window in hand (chrome/shelf-drag.tsx). The desk's
 * surface lends its engine here while it is mounted.
 */
let engineUp: DeskEngine | null = null;

const engineListeners = new Set<() => void>();

export function lendDeskEngine(engine: DeskEngine | null): void {
  engineUp = engine;
  for (const listener of engineListeners) listener();
}

/**
 * The tabs with a window on the desk — one flying into its row included —
 * as one key ("" with no desk). A page is the desk's while its window is: a
 * picture of it elsewhere (the media stack's card, the rail's floating
 * player) waits until the window has gone, or main's layout, which still has
 * the page in it, would take the picture back.
 */
export function useDeskWindowKey(): string {
  const engine = useDeskEngine();
  return useSyncExternalStore(
    useCallback((listener: () => void) => engine?.subscribe(listener) ?? (() => undefined), [engine]),
    () => (engine === null ? "" : engine.getView().windows.map((window) => window.tabId).join(" ")),
    () => "",
  );
}

/** deskEngine() for a component: rendered again as an engine is lent or taken back. */
export function useDeskEngine(): DeskEngine | null {
  return useSyncExternalStore(
    (listener) => {
      engineListeners.add(listener);
      return () => engineListeners.delete(listener);
    },
    () => engineUp,
    () => null,
  );
}

/** The desk's engine, or null before it is up (the first frames of a cold start) and off the desktop. */
export function deskEngine(): DeskEngine | null {
  return engineUp;
}

/**
 * A tab of the desk's space shown on the desk: its window out, or back out,
 * in use (the media stack's "show the tab", the floating player's "back to
 * the desk"). Through the engine, not by selecting the tab: a window sent
 * out of the desk leaves its tab the one in use when it was the last out,
 * and selecting it again would change nothing. False for any other tab
 * (another space's, or no engine yet): selecting it is the browser's, and
 * the desk passes to its own.
 */
export function showOnDesk(tabId: string): boolean {
  const engine = deskEngine();
  if (engine === null || !engine.hasGroupTab(tabId)) return false;
  engine.add(tabId, { focus: true });
  return true;
}

/**
 * A new tab on the desk (⌘T, the sidebar's +): in the current space, on the
 * home page, brought out as the window in use (main's `newTab` in that
 * space; the window comes out as its tab joins and is in use: DeskSurface).
 * On a loose tab's space that makes it a space of two, drawn as any is from
 * then on (main). Before main has named a current space (the first frames),
 * a plain new tab, which main puts in the current space.
 */
export async function newTabOnDesk(): Promise<void> {
  const store = useAppStore.getState();
  const groupId = currentSpace();
  // (createTab has no `group` option on the wire yet: main's default for a tab the shell makes is the current space.)
  if (groupId === null) await store.createTab(store.settings.general.homeUrl);
  else await store.tabGroupCommand({ type: "newTab", groupId });
}

/**
 * A tab's row let go over the desk (chrome/shelf-drag.tsx): its window comes
 * out where it was let go. A tab that is not the current space's joins it
 * first — the desk hears of it with the snapshot that says so. A favorite's
 * or a pin's page comes down into the space (its page's group with it), the
 * entry staying, closed.
 */
export async function dropTabOnDesk(tabId: string, client: { x: number; y: number }): Promise<void> {
  const groupId = currentSpace();
  const engine = deskEngine();
  if (groupId === null || engine === null) return;
  if (!engine.hasGroupTab(tabId)) {
    const store = useAppStore.getState();
    const anchorId = store.snapshot?.tabs.find((tab) => tab.id === tabId)?.anchorId ?? null;
    if (anchorId !== null) await store.sidebarCommand({ type: "bringDown", anchorId, groupId });
    else if ((await store.tabGroupCommand({ type: "addTab", groupId, tabId })) === null) return;
    const until = performance.now() + JOIN_WAIT_MS;
    while (deskEngine()?.hasGroupTab(tabId) !== true) {
      if (performance.now() > until || currentSpace() !== groupId) return;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }
  deskEngine()?.addAt(tabId, client);
}

/**
 * A favorite or pin with no page open let go over the desk: a fresh page of
 * it comes down into the current space, its window out where it was let go,
 * the entry staying as it was.
 */
export async function dropEntryOnDesk(anchorId: string, client: { x: number; y: number }): Promise<void> {
  const groupId = currentSpace();
  const store = useAppStore.getState();
  if (groupId === null || deskEngine() === null) return;
  const members = (): readonly string[] => deskGroups(useAppStore.getState().snapshot).find((group) => group.id === groupId)?.tabIds ?? [];
  const before = new Set(members());
  await store.sidebarCommand({ type: "bringDown", anchorId, groupId });
  const until = performance.now() + JOIN_WAIT_MS;
  let fresh: string | undefined;
  while ((fresh = members().find((tabId) => !before.has(tabId) && deskEngine()?.hasGroupTab(tabId) === true)) === undefined) {
    if (performance.now() > until || currentSpace() !== groupId) return;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  deskEngine()?.addAt(fresh, client);
}

/**
 * A tab's row let go on a space's header in the sidebar (chrome/shelf-drag.tsx)
 * that had no tabs: it joins the space (the drop did that), and — the space
 * the current one — its window comes out on the desk, in use (docs/spaces.md
 * §1, "Where an empty space stands").
 *
 * A favorite or pin let go there comes down into the space (the drop's
 * bringDown) as a tab the drop may not know — a fresh page of it, none
 * being open: `tabId` null then, and the tab is the space's first once the
 * snapshot has it, the space having had none (since 2026-10-09; until then
 * the page joined and its window stayed in its row).
 */
export async function bringOutJoined(tabId: string | null, groupId: string): Promise<void> {
  if (currentSpace() !== groupId) return;
  const joined = (): string | null => tabId ?? deskGroups(useAppStore.getState().snapshot).find((group) => group.id === groupId)?.tabIds[0] ?? null;
  const until = performance.now() + JOIN_WAIT_MS;
  let fresh: string | null;
  while ((fresh = joined()) === null || deskEngine()?.hasGroupTab(fresh) !== true) {
    if (performance.now() > until || currentSpace() !== groupId) return;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  deskEngine()?.add(fresh, { focus: true });
}
