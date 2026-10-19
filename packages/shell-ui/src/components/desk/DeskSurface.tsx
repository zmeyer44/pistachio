import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { agentDrivenTabId } from "@pistachio/shell-contracts/agent-glow";
import { SURFACE_GUTTER } from "@pistachio/shell-contracts/chrome";
import type { BrowserTabInfo, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { isDeskUndoKey } from "@pistachio/shell-contracts/desk";
import { isShellPageUrl } from "@pistachio/shell-contracts/shell-pages";
import { tabGroupTitle, type TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { nativeApi, shellApi } from "../../api";
import { agentActivity } from "../../lib/desk/agent";
import { useGroupContexts, useGroupContextsLoaded } from "../../lib/desk/group-context";
import { useFileWindows } from "../../lib/desk/group-files";
import { useNowPlaying } from "../../lib/desk/now-playing";
import { documentWindowIds, fileOf } from "../../lib/desk/documents";
import { fileItemOf, fileWindowId, isTabWindow } from "../../lib/desk/windows";
import { displayHost } from "../../lib/url";
import { lendDeskArrange, lendDeskAsk, lendDeskEngine, revealFor, takeSpaceChoice } from "../../lib/desk/open";
import { useDeskChrome, type DeskMark } from "../../lib/desk/chrome";
import type { DockItem, DockRailItem, DockTargets } from "../../lib/desk/dock-drop";
import type { Rect } from "../../lib/desk/geometry";
import { isHomeSpace, roomForSpace } from "../space-rail/rail-model";
import { useLiveDeskReport } from "../live/useLiveDeskReport";
import { useLiveShareHost } from "../live/useLiveShareHost";
import { deskGroups, groupPageOf, passedEntry, useDeskStore, type DeskVariants } from "../../lib/desk/store";
import { useAppStore } from "../../store";
import { GlanceOverlay, type GlanceDesk } from "../GlanceOverlay";
import { DeskBar } from "./DeskBar";
import { DeskEngine, LAYOUT_PREVIEW_COVER, takesOnInPlace, WINDOW_INSETS, type DeskLayoutSnapshot } from "./desk-engine";
import { answerDeskRequest, type DeskAnswerDeps } from "./desk-requests";
import { DeskDropZone } from "./DeskDropZone";
import { DeskEmpty } from "./DeskEmpty";
import { DeskSideCard } from "./DeskSideCard";
import { DeskWindow, holdsGrab } from "./DeskWindow";
import { LayoutGhosts } from "./LayoutControl";
import { SmartArranger, type WindowWords } from "./smart-arrange";
import type { ShellWindowSubject } from "./window-kinds";

/** While a parked window is raised, the OS's pointer is read this often, for a leave nothing hears (the shelf view's). */
const MINI_POINTER_CHECK_MS = 120;

const EMPTY_TABS: readonly BrowserTabInfo[] = [];
const EMPTY_IDS: readonly string[] = [];
const EMPTY_GROUPS: readonly TabGroupInfo[] = [];
const EMPTY_THREADS: NonNullable<ShellSnapshot["threads"]> = [];

/** The group's tabs in the group's order, keeping each tab object's identity (the store shares structure). */
function groupTabs(snapshot: ShellSnapshot | null, group: TabGroupInfo | null): readonly BrowserTabInfo[] {
  if (snapshot === null || group === null) return EMPTY_TABS;
  return tabsOf(snapshot, group.tabIds);
}

function tabsOf(snapshot: ShellSnapshot | null, tabIds: readonly string[]): readonly BrowserTabInfo[] {
  if (snapshot === null || tabIds.length === 0) return EMPTY_TABS;
  const byId = new Map(snapshot.tabs.map((tab) => [tab.id, tab]));
  return tabIds.map((tabId) => byId.get(tabId)).filter((tab): tab is BrowserTabInfo => tab !== undefined);
}

/**
 * Where a window lives in the sidebar, the desk's dock (DeskHost.homeOf).
 * In the double sidebar (docs/double-sidebar.md, since 2026-10-13): a tab's
 * row while the card draws it (in sight in its list) — or its favorite's
 * tile — else its space's tile on the rail, or Home's button for a space of
 * Home's (a loose tab's, a page's alone); a space's home is its tile; a
 * document's the Stack's row while it is drawn, else its space's tile. So a
 * window flies to and from the rail when the card shows another view. (The
 * single sidebar's group rows are still looked for after those, for the
 * web's list, which no desk draws beside.) Null where the sidebar shows none.
 *
 * A hidden sidebar's pane keeps its layout while it is away — translated
 * off the window's left edge, `visibility: hidden` — so its rows have boxes
 * there, x ≈ −238 (docs/spaces.md §3). They are found by their height alone
 * (in sight is the list's vertical span, which the translation leaves
 * where it is), and their x is never taken: the engine asks whether the
 * column is away (DeskHost.sidebarAway) and puts the window's way home on
 * the window's edge at the row's height instead.
 */
function sidebarHome(kind: "tab" | "group" | "file", id: string, groupId: string): HTMLElement | null {
  const pane = document.querySelector<HTMLElement>("[data-testid='sidebar-pane']");
  if (pane === null) return null;
  const snapshot = useAppStore.getState().snapshot;
  // (A view fading out is a picture without ids: the first list found is the card's live one.)
  const list = pane.querySelector<HTMLElement>("[data-testid='sidebar-tab-list']")?.getBoundingClientRect() ?? null;
  const rail = pane.querySelector<HTMLElement>("[data-testid='space-rail-list']")?.getBoundingClientRect() ?? null;
  const within = (el: HTMLElement | null, span: DOMRect | null): HTMLElement | null => {
    if (el === null || span === null) return el;
    const box = el.getBoundingClientRect();
    const middle = box.top + box.height / 2;
    return box.width > 0 && middle >= span.top && middle <= span.bottom ? el : null;
  };
  const inSight = (el: HTMLElement | null): HTMLElement | null => within(el, list);
  // (The favorites stand above the list: drawn is enough.)
  const shown = (el: HTMLElement | null): HTMLElement | null => (el !== null && el.getBoundingClientRect().width > 0 ? el : null);
  const tabRow = (tabId: string): HTMLElement | null =>
    inSight(pane.querySelector<HTMLElement>(`[role='tab'][data-tab-id='${CSS.escape(tabId)}']`)) ??
    // A favorite's page: its tile.
    shown(pane.querySelector<HTMLElement>(`[data-live-tab-id='${CSS.escape(tabId)}']`));
  // A space's tile on the rail (in sight on the rail's list), or Home's own button for a space of Home's.
  const tile = (gid: string): HTMLElement | null => {
    const el = pane.querySelector<HTMLElement>(`[data-testid='rail-space'][data-group-id='${CSS.escape(gid)}']`);
    if (el !== null) return within(el, rail);
    const home = snapshot?.looseGroups?.some((group) => group.id === gid) === true || (snapshot?.anchorGroups?.find((group) => group.id === gid)?.tabIds.length ?? 2) < 2;
    return home ? shown(pane.querySelector<HTMLElement>("[data-testid='rail-home']")) : null;
  };
  // The single sidebar's: a loose tab's group or a page's group has no group's row, its tab's own is its home (a page's,
  // its favorite's tile or pin's row); a space's, its header.
  const groupRow = (gid: string): HTMLElement | null => {
    const pageGroup = snapshot?.anchorGroups?.find((group) => group.id === gid);
    const lone =
      snapshot?.looseGroups?.find((group) => group.id === gid)?.tabIds[0] ??
      (pageGroup === undefined ? null : groupPageOf(pageGroup, snapshot?.tabs ?? []));
    if (lone !== null) return tabRow(lone);
    return inSight(pane.querySelector<HTMLElement>(`[data-testid='tab-group'][data-group-id='${CSS.escape(gid)}'] [data-group-header]`));
  };
  // The Stack's row: in the list under Home's row in use (in sight there), or pinned to a space's card foot (drawn).
  const stack = (): HTMLElement | null => {
    const el = pane.querySelector<HTMLElement>("[data-testid='desk-stack']");
    return el !== null && el.closest("[data-testid='sidebar-tab-list']") !== null ? inSight(el) : shown(el);
  };
  if (kind === "group") return tile(id) ?? groupRow(id);
  if (kind === "file") return stack() ?? tile(groupId) ?? groupRow(groupId);
  return tabRow(id) ?? tile(groupId) ?? groupRow(groupId);
}

/**
 * A tab of the desk's space sent out of it — to another space, to Home, to a
 * new space of its own — by `send` (told the tab's entry, a favorite's or
 * pin's page's, or null). The desk never stands on a tab that is not its
 * space's: were it the tab in use, another of them is in use first — the
 * window left on top (`next`), or with none, the tab used last, which comes
 * out. (A document's window is no tab to choose.) With none at all, the desk
 * goes where the tab goes, as main makes the space of the tab in use current.
 *
 * True once the tab has left the space it was in; false where main kept it
 * there — no room for another space, a Stack the target cannot take — and
 * the engine brings its window back (DeskHost.moveTabToGroup). Read off a
 * snapshot asked for afresh where the store's does not show it gone yet:
 * main's answer to the command can reach the shell before the snapshot it
 * published for it does (seen 2026-10-14), and only a reply after the
 * command's is surely main's word.
 */
async function sendOut(tabId: string, next: string | null, send: (store: ReturnType<typeof useAppStore.getState>, anchorId: string | null) => Promise<unknown>): Promise<boolean> {
  const store = useAppStore.getState();
  const anchorId = store.snapshot?.tabs.find((tab) => tab.id === tabId)?.anchorId ?? null;
  const spaceOf = (snapshot: ShellSnapshot | null): string | null => deskGroups(snapshot).find((group) => group.tabIds.includes(tabId))?.id ?? null;
  const from = spaceOf(store.snapshot);
  if (store.snapshot?.activeTabId === tabId) {
    const groupId = store.snapshot.currentGroupId;
    const members = deskGroups(store.snapshot).find((group) => group.id === groupId)?.tabIds ?? [];
    const others = store.snapshot.tabs.filter((tab) => tab.id !== tabId && members.includes(tab.id));
    const other = (next !== null && isTabWindow(next) ? next : null) ?? [...others].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id ?? null;
    if (other !== null) await store.selectTab(other);
  }
  await send(store, anchorId);
  if (from === null || spaceOf(useAppStore.getState().snapshot) !== from) return true;
  const fresh = await shellApi()
    .getSnapshot()
    .catch(() => null);
  return fresh === null || spaceOf(fresh) !== from;
}

/**
 * The sidebar's column as a desk window carried over it reads it (lib/desk/
 * dock-drop.ts, DeskHost.dockTargets): the rail's items — Home, every space's
 * tile, New space — and the card, with the space it shows (null for Home's)
 * and its rows' list, in the window's coordinates. Null with the column
 * hidden: it goes away as a window is taken in hand, and takes nothing.
 */
function dockTargetsOf(groupId: string | null): DockTargets | null {
  const slot = document.querySelector<HTMLElement>("[data-testid='sidebar-motion-slot']");
  if (slot === null || slot.dataset["mode"] === "hidden") return null;
  const rectOf = (el: Element): Rect => {
    const box = el.getBoundingClientRect();
    return { x: box.left, y: box.top, w: box.width, h: box.height };
  };
  const railEl = slot.querySelector<HTMLElement>("[data-testid='space-rail']");
  const listEl = railEl?.querySelector<HTMLElement>("[data-testid='space-rail-list']") ?? null;
  const span = listEl?.getBoundingClientRect() ?? null;
  const rail: DockTargets["rail"] =
    railEl === null || railEl === undefined
      ? null
      : {
          box: rectOf(railEl),
          list: span === null ? null : { top: span.top, bottom: span.bottom },
          items: [...railEl.querySelectorAll<HTMLElement>("[data-rail-drop]")].flatMap((el): DockRailItem[] => {
            const item = el.dataset["railDrop"];
            if (item !== "home" && item !== "new" && item !== "space") return [];
            return [{ item, groupId: el.dataset["groupId"] ?? null, color: el.dataset["groupColor"] ?? null, box: rectOf(el), listed: listEl?.contains(el) === true }];
          }),
        };
  const cardEl = slot.querySelector<HTMLElement>("[data-testid='space-card']");
  // (The view going is a picture without ids: the space view found is the card's live one.)
  const viewEl = cardEl?.querySelector<HTMLElement>("[data-testid='space-view']") ?? null;
  const rowsEl = cardEl?.querySelector<HTMLElement>("[data-testid='sidebar-tab-list']") ?? null;
  const card: DockTargets["card"] =
    cardEl === null || cardEl === undefined
      ? null
      : { box: rectOf(cardEl), groupId: cardEl.dataset["view"] === "space" ? (viewEl?.dataset["groupId"] ?? null) : null, list: rowsEl === null ? null : rectOf(rowsEl) };
  const snapshot = useAppStore.getState().snapshot;
  return { rail, card, homeSpace: groupId !== null && isHomeSpace(groupId, snapshot), spacesFull: !roomForSpace(snapshot) };
}

/** The rail item (a space's tile: `groupId`'s) or the card a window carried over the column went into. */
function dockItemOf(item: DockItem, groupId: string | null): HTMLElement | null {
  const pane = document.querySelector<HTMLElement>("[data-testid='sidebar-pane']");
  if (pane === null) return null;
  if (item === "home") return pane.querySelector<HTMLElement>("[data-testid='rail-home']");
  if (item === "new") return pane.querySelector<HTMLElement>("[data-testid='rail-new-space']");
  if (item === "card") return pane.querySelector<HTMLElement>("[data-testid='space-card']");
  return groupId === null ? null : pane.querySelector<HTMLElement>(`[data-testid='rail-space'][data-group-id='${CSS.escape(groupId)}']`);
}

/**
 * The desk: a space's (tab group's) tabs as free windows over the surface
 * (docs/desk.md), with the sidebar's column beside it as its dock — the
 * space's tabs as rows there, which windows come out of and go back into.
 *
 * Since 2026-10-09 it IS the desktop's browser surface (docs/spaces.md):
 * mounted whenever the surface is native (ContentArea), never opened or
 * left, and showing main's current space (ShellSnapshot.currentGroupId) —
 * main decides which that is, the desk follows. It draws its stage from the
 * first frame, but builds its engine only once there is something to start
 * from — the snapshot in, a current space named and listed, the stage laid
 * out — and then once: a later change of the current space is the desk
 * PASSING (DeskEngine.switchGroup: this space's windows go home into its
 * row, the next one's come out of theirs), or, the tab in use having stayed
 * while its space changed under it, the windows staying where they are
 * (regroup). A fresh engine is a fresh mount (the shell's boot, a reload, a
 * Profile switch: ContentArea's key), and it starts COLD (DeskEngine.start).
 *
 * The motion is the engine's (desk-engine.ts); this component keeps it fed
 * with what the browser says — the space's tabs, which one is active,
 * which are asleep — and draws what the engine says is on the desk. On an
 * empty space (no tabs) with nothing out it draws the empty desk's mark
 * (DeskEmpty).
 */
export default function DeskSurface() {
  // The space the desk shows: main's (null until main has named one).
  const groupId = useAppStore((state) => state.snapshot?.currentGroupId ?? null);
  // One the chrome draws (empty ones too), a loose tab's (TabGroupInfo.loose), or a page's (TabGroupInfo.anchorId).
  const group = useAppStore((state) => (groupId === null ? null : (deskGroups(state.snapshot).find((candidate) => candidate.id === groupId) ?? null)));
  const tabs = useAppStore(useShallow((state) => groupTabs(state.snapshot, group)));
  // A loose tab's group goes by its tab's name, as the sidebar draws it, and a page's group by its page's: the Bar asks
  // about it, the Stack is its.
  const ownTitle = useAppStore((state) => {
    if (group === null || (group.loose !== true && group.anchorId === undefined)) return null;
    const own = group.anchorId === undefined ? group.tabIds[0] : groupPageOf(group, state.snapshot?.tabs ?? []);
    return state.snapshot?.tabs.find((tab) => tab.id === own)?.title ?? "";
  });
  const deskGroup = useMemo(() => (group !== null && ownTitle !== null ? { ...group, title: tabGroupTitle(ownTitle) } : group), [group, ownTitle]);
  const activeTabId = useAppStore((state) => state.snapshot?.activeTabId ?? null);
  const wakingTabIds = useAppStore((state) => state.snapshot?.wakingTabIds ?? EMPTY_IDS);
  const overlayActive = useAppStore((state) => state.overlayActive);
  const paneStills = useAppStore((state) => state.paneStills);
  const glance = useAppStore((state) => state.glance);
  const glanceStaged = useAppStore((state) => state.glanceStaged);
  const glanceClosing = useAppStore((state) => state.glanceClosing);
  const setContentBounds = useAppStore((state) => state.setContentBounds);
  const run = useAppStore((state) => state.snapshot?.run ?? null);
  const threads = useAppStore((state) => state.snapshot?.threads ?? EMPTY_THREADS);
  const drawnGroups = useAppStore((state) => state.snapshot?.tabGroups ?? EMPTY_GROUPS);
  const looseGroups = useAppStore((state) => state.snapshot?.looseGroups ?? EMPTY_GROUPS);
  const pageGroups = useAppStore((state) => state.snapshot?.anchorGroups ?? EMPTY_GROUPS);
  const groups = useMemo(
    () => (looseGroups.length === 0 && pageGroups.length === 0 ? drawnGroups : [...drawnGroups, ...looseGroups, ...pageGroups]),
    [drawnGroups, looseGroups, pageGroups],
  );
  const contexts = useGroupContexts();
  const contextsLoaded = useGroupContextsLoaded();
  const variants = useDeskStore((state) => state.variants);
  const stageRef = useRef<HTMLDivElement>(null);
  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  const tabKey = tabIds.join(" ");

  /** The group the engine's windows are of: it moves on only once the engine has passed to the next (and saved this one under its own id). */
  const shownGroup = useRef<string | null>(null);
  // The space as last known, for as long as the engine shows it: one snapshot that leaves it out (main mid-change) does
  // not take the Bar down — a draft in it, an answer card, its covers — nor the drop zone (2026-10-09; the latch below
  // kept the engine, not them).
  const lastGroup = useRef<TabGroupInfo | null>(null);
  if (deskGroup !== null) lastGroup.current = deskGroup;
  const shownDeskGroup = deskGroup ?? (lastGroup.current !== null && lastGroup.current.id === shownGroup.current ? lastGroup.current : null);
  // What the engine asks of the browser, always answered from the latest render.
  const latest = useRef({ groupId, tabs, wakingTabIds, variants, group: shownDeskGroup, contexts, contextsLoaded });
  latest.current = { groupId, tabs, wakingTabIds, variants, group: shownDeskGroup, contexts, contextsLoaded };

  // The stage laid out: windows saved as fractions of the desk are placed in it at once, so it must have its size.
  const [sized, setSized] = useState(false);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (stage === null || sized) return;
    const laidOut = (): boolean => {
      const box = stage.getBoundingClientRect();
      return box.width >= 2 && box.height >= 2;
    };
    if (laidOut()) {
      setSized(true);
      return;
    }
    const observer = new ResizeObserver(() => {
      if (laidOut()) setSized(true);
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [sized]);
  // The engine starts once (a latch: the space going unknown for a snapshot does not take the desk down).
  const [started, setStarted] = useState(false);
  if (!started && sized && group !== null) setStarted(true);

  const [engine, setEngine] = useState<DeskEngine | null>(null);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const startGroup = latest.current.groupId;
    if (!started || stage === null || startGroup === null) return;
    const created = new DeskEngine({
      variants: (): DeskVariants => latest.current.variants,
      spaceSwitch: () => {
        const { spaceExit, spaceArrival } = useAppStore.getState().settings.layout;
        return { exit: spaceExit, arrival: spaceArrival };
      },
      hasLivePage: (tabId) => {
        // A document is the shell's own, drawn always.
        if (!isTabWindow(tabId)) return false;
        // Any tab, not only the group's: a window of a group the desk has
        // passed from is still live until its still is up.
        const tab = latest.current.tabs.find((candidate) => candidate.id === tabId) ?? useAppStore.getState().snapshot?.tabs.find((candidate) => candidate.id === tabId);
        return tab !== undefined && tab.lifecycle === "live" && !latest.current.wakingTabIds.includes(tabId) && !isShellPageUrl(tab.url);
      },
      select: (tabId) => {
        // A document is no tab: the browser's tab in use stays as it was.
        if (!isTabWindow(tabId)) return;
        const store = useAppStore.getState();
        if (store.snapshot?.activeTabId !== tabId) void store.selectTab(tabId);
      },
      focusWindow: (id) => useFileWindows.getState().requestFocus(id),
      // A document's window let go on Close only closes the window: the file stays in the Stack.
      close: (tabId) => {
        if (!isTabWindow(tabId)) return;
        // Going, not playing on, until main has it gone (lib/desk/now-playing.ts).
        useNowPlaying.getState().setClosing(tabId, true);
        void useAppStore.getState().closeTab(tabId).finally(() => useNowPlaying.getState().setClosing(tabId, false));
      },
      editAddress: (tabId) => {
        if (isTabWindow(tabId)) useAppStore.getState().openUrlBar(tabId);
      },
      // A Home tab's window taken off the whole desk — moved, resized, let go of, masked — is no browser's tab any more:
      // its space is one of its own, on the rail (main's ownSpace: the same space, so the desk stays on it, the window
      // where it was let go). Until 2026-10-14 it stayed a Home tab, its window wherever it was left.
      brokeAway: (tabId) => {
        const store = useAppStore.getState();
        const groupId = shownGroup.current;
        if (groupId === null || !isTabWindow(tabId) || !isHomeSpace(groupId, store.snapshot)) return;
        if (!latest.current.tabs.some((tab) => tab.id === tabId)) return;
        void store.tabGroupCommand({ type: "ownSpace", groupId });
      },
      save: (windows, reserve) => {
        if (shownGroup.current !== null) useDeskStore.getState().save(shownGroup.current, reserve > 0 ? { windows, reserve } : { windows });
      },
      // (A favorite's or pin's page is no day tab for main's addTab or create: it is brought down, its entry kept linked
      // to it — @pistachio/shell-contracts/sidebar's bringDown.)
      moveTabToGroup: (tabId, groupId, next) =>
        sendOut(tabId, next, (store, anchorId) =>
          anchorId !== null ? store.sidebarCommand({ type: "bringDown", anchorId, groupId }) : store.tabGroupCommand({ type: "addTab", groupId, tabId }),
        ),
      // A window let go on Home on the rail: a Home tab of its own (main's removeTab); on New space, a space of its own,
      // not chosen (main's create, as a row let go there makes one: chrome/shelf-drag.tsx) — the desk stays where it is.
      // (A favorite's or pin's page is Home's already: its window collapses on Home instead, homeOwns.)
      toHome: (tabId, next) => sendOut(tabId, next, (store, anchorId) => (anchorId !== null ? Promise.resolve() : store.tabGroupCommand({ type: "removeTab", tabId }))),
      // (Not offered with the Profile full — dockTargetsOf's spacesFull — but main has the last word, and a refusal brings
      // the window back.)
      toNewSpace: (tabId, next) =>
        sendOut(tabId, next, (store, anchorId) =>
          anchorId !== null
            ? store.sidebarCommand({ type: "bringDown", anchorId, newGroupId: crypto.randomUUID() })
            : store.tabGroupCommand({ type: "create", id: crypto.randomUUID(), tabIds: [tabId] }),
        ),
      homeOwns: (tabId) => (useAppStore.getState().snapshot?.tabs.find((tab) => tab.id === tabId)?.anchorId ?? null) !== null,
      dockTargets: () => dockTargetsOf(shownGroup.current),
      dockItem: (item, gid) => dockItemOf(item, gid),
      sidebar: () => {
        const slot = document.querySelector<HTMLElement>("[data-testid='sidebar-motion-slot']");
        if (slot === null) return null;
        const box = slot.getBoundingClientRect();
        return box.width < 1 ? null : { x: box.left, y: box.top, w: box.width, h: box.height };
      },
      // Hidden and not out (or going): the pane is translated off the window's edge (layouts/SidebarLayout.tsx).
      sidebarAway: () => document.querySelector("[data-testid='sidebar-pane']")?.hasAttribute("data-hidden") ?? true,
      homeOf: (kind, id) => sidebarHome(kind, id, shownGroup.current ?? ""),
    });
    created.attachStage(stage);
    shownGroup.current = startGroup;
    const ids = latest.current.tabs.map((tab) => tab.id);
    const active = useAppStore.getState().snapshot?.activeTabId ?? null;
    // The tab in use is on top (main's: it is always the current space's, or none, the space empty). With none, the
    // window left on top comes up so (#laidOut).
    const entry = active !== null && ids.includes(active) ? active : null;
    // Its documents, once main has said what the context holds (until then the saved ones come out, and go if they are gone).
    const documents = latest.current.contextsLoaded ? documentWindowIds(latest.current.contexts.find((candidate) => candidate.groupId === startGroup)) : null;
    // (Saved with room kept for the chat's place, its boxes are of the desk short of it; the card, once up, asks for
    // the room kept now — DeskBar — and the engine gives it then.)
    const startDesk = useDeskStore.getState().saved[startGroup];
    created.start(startDesk?.windows ?? [], entry, ids, documents, startGroup, startDesk?.reserve ?? 0);
    setEngine(created);

    const measure = (): void => {
      created.measure();
      const box = stage.getBoundingClientRect();
      setContentBounds({ x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    window.addEventListener("resize", measure);
    // A press with the grab key on a live page: main took it from the page and hands the move here.
    const offGrab = nativeApi()?.onDeskGrab((grab) => created.grabFromPage(grab));
    // Shift is the snap key: followed from the shell's own keys, and from
    // main's relay of every view's (a page has the keyboard as often as not;
    // main also lets go of it when the window loses focus — the shell page
    // blurs whenever a page takes the keyboard, Shift held or not).
    const offShift = nativeApi()?.onDeskShift((held) => created.setShift(held));
    const onKey = (event: KeyboardEvent): void => created.setShift(event.shiftKey);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    // The pointer on a window's live page, which the shell never hears: main's word (a parked one rises into view, a drawer comes out).
    const offHover = nativeApi()?.onDeskHover((hover) => created.hoverPage(hover.tabId, hover.over, hover.top));
    const offPage = nativeApi()?.onDeskPageInput((input) => {
      // A press on a live page while a document was in use: that page is in use now. (Pressed, a page
      // the browser had not selected is selected, and comes up that way; the one it had, only here.)
      if (input === "press") {
        // And a window left for the desk's surface is the person's again.
        created.pagePressed();
        window.setTimeout(() => {
          const focused = created.focusedTabId();
          const active = useAppStore.getState().snapshot?.activeTabId ?? null;
          if (focused !== null && !isTabWindow(focused) && active !== null && created.windowTabIds().includes(active)) created.activeChanged(active);
        }, 150);
      }
    });
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      offGrab?.();
      offShift?.();
      offHover?.();
      offPage?.();
      created.destroy();
      setEngine(null);
    };
    // One engine per mount (the component's key: ContentArea), from the moment there is something to start; a space
    // passed to later is the engine's to run (below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  // Main made another space current: the desk passes to it. The engine sends
  // this space's windows into its row, and brings the next one's out to
  // where they were left — the tab in use then on top (main's choice: the
  // tab chosen, or the window that was on top when the space was left,
  // which the shell named as it selected it), or, none of them out, that tab
  // alone. An empty space comes up as nothing: the empty desk. The tab in
  // use having stayed while its space changed under it — a loose tab put in
  // a group, its window out here and staying, that group never on a desk —
  // the windows stay where they are (regroup). Its window on its way into a
  // row is the passing's to turn round (takesOnInPlace).
  const groupKnown = group !== null;
  useLayoutEffect(() => {
    const from = shownGroup.current;
    if (engine === null || groupId === null || !groupKnown || from === groupId) return;
    // A layout ⌃Z would put back is the last desk's.
    arranger.current?.passed();
    const groupTabIds = latest.current.tabs.map((tab) => tab.id);
    const shellIds = latest.current.contextsLoaded ? documentWindowIds(latest.current.contexts.find((candidate) => candidate.groupId === groupId)) : null;
    const active = useAppStore.getState().snapshot?.activeTabId ?? null;
    const chosen = active !== null && groupTabIds.includes(active) ? active : null;
    // (Read on every passing, so a mark never outlives the passing it was for.)
    const spaceChosen = takeSpaceChoice(groupId, chosen);
    const desk = useDeskStore.getState();
    if (takesOnInPlace(engine, chosen, desk.saved[groupId] !== undefined)) {
      // (What it saves from here is the new desk's.)
      shownGroup.current = groupId;
      engine.regroup(groupTabIds, shellIds, groupId);
      return;
    }
    // A Glance taken in filling the desk from a Home tab: a Home tab of its own (main's; a Home tab's space takes no tab,
    // docs/double-sidebar.md §1), its window where the preview landed already — the desk takes its space on in place,
    // the page it was opened from going home to its row, rather than passing to it (2026-10-14).
    if (chosen !== null && desk.saved[groupId] === undefined && engine.awaitsLanding(chosen)) {
      shownGroup.current = groupId;
      engine.regroup(groupTabIds, shellIds, groupId);
      engine.add(chosen, { focus: true });
      return;
    }
    const saved = desk.saved[groupId]?.windows ?? [];
    const reserve = desk.saved[groupId]?.reserve ?? 0;
    const entry = chosen ?? passedEntry(saved, latest.current.tabs);
    // A tab chosen (not the space: selectSpace marks that) comes out whole, minimized or not (2026-10-09).
    engine.switchGroup({ from: from ?? groupId, groupId, tabIds: groupTabIds, shellIds, saved, reserve, entry, reveal: revealFor(chosen, spaceChosen) });
    shownGroup.current = groupId;
  }, [engine, groupId, groupKnown]);

  // ── The smart layout (docs/desk-layout.md) ─────────────────────────────

  // What each window is, kept after it has gone: a window just closed is no tab any more, and the layout model is told what left.
  const windowWords = useRef(new Map<string, WindowWords>());
  useEffect(() => {
    for (const tab of tabs) windowWords.current.set(tab.id, { title: tab.title, site: displayHost(tab.url), kind: "page" });
    const files = contexts.find((candidate) => candidate.groupId === shownGroup.current)?.items ?? [];
    for (const item of files) if (item.kind === "file") windowWords.current.set(fileWindowId(item.id), { title: item.name, site: "", kind: "document" });
  });
  // Windows coming and going may lay the others out anew, and the person can ask (⌘⌥L, the More card).
  const arranger = useRef<SmartArranger | null>(null);
  useEffect(() => {
    if (engine === null) return;
    const api = nativeApi();
    const created = new SmartArranger(engine, {
      auto: () => latest.current.variants.layout === "smart",
      busy: () => {
        const current = useAppStore.getState().snapshot?.run ?? null;
        return current !== null && current.status === "running" && current.control === "agent";
      },
      judge: api === null ? null : (request) => api.judgeDeskLayout(request),
      group: () => shownGroup.current,
      describe: (id) => {
        const tab = isTabWindow(id) ? useAppStore.getState().snapshot?.tabs.find((candidate) => candidate.id === id) : undefined;
        if (tab !== undefined) windowWords.current.set(id, { title: tab.title, site: displayHost(tab.url), kind: "page" });
        return windowWords.current.get(id) ?? (isTabWindow(id) ? null : { title: fileItemOf(id) ?? "", site: "", kind: "document" });
      },
      notify: (message) => useAppStore.getState().showNotice(message),
      later: (run, ms) => {
        const timer = window.setTimeout(run, ms);
        return () => window.clearTimeout(timer);
      },
    });
    arranger.current = created;
    // ⌃Z a moment after the desk laid itself out, wherever the keyboard is: main takes it from a page while the engine
    // says so; struck here it is heard here — unless a terminal has the keyboard, whose ⌃Z stops the job in front.
    const offPage = api?.onDeskPageInput((input) => {
      if (input === "undo") created.undo();
      // Tab, ⇧Tab, from a page with a layout looked at with the pointer (DeskState.cycleKey): its windows go round its places.
      else if (input === "cycle" || input === "cycleBack") engine.cycleLayout(input === "cycle" ? 1 : -1);
    });
    const onKey = (event: KeyboardEvent): void => {
      if (!isDeskUndoKey({ type: "keyDown", key: event.key, shift: event.shiftKey, control: event.ctrlKey, alt: event.altKey, meta: event.metaKey })) return;
      if (event.target instanceof Element && event.target.closest(".terminal-page") !== null) return;
      if (!created.undo()) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      offPage?.();
      window.removeEventListener("keydown", onKey, true);
      created.destroy();
      arranger.current = null;
    };
  }, [engine]);

  // The sidebar — the desk's dock — acts on its windows through it (lib/desk/open.ts).
  useEffect(() => {
    if (engine === null) return;
    lendDeskEngine(engine);
    return () => lendDeskEngine(null);
  }, [engine]);

  // A live share (docs/live-share.md §6.4): its state and notices while the desk is up, and the shared space's desk
  // reported to main from the engine — per frame, never through React.
  useLiveShareHost();
  useLiveDeskReport(engine, contexts);

  // The keyboard's Tile, Cascade and Arrange (chrome/actions.tsx) reach this desk's engine: Tile and Cascade are named
  // layouts (layOut, ⌃Z putting them back a moment after), Arrange the layout model's.
  useEffect(() => {
    if (engine === null) return;
    lendDeskArrange((kind) => (kind === "smart" ? void arranger.current?.ask() : void engine.layOut(kind)));
    return () => lendDeskArrange(null);
  }, [engine]);

  // ── The desk's agent (docs/desk-agent.md) ──────────────────────────────

  // (Which conversation is the space's is main's: its session follows the current space, RunController.followGroup.
  // Until 2026-10-09 the desk said when it came up for a group, and when it was left — DeskConversationCommand
  // "enter" and "leave".)

  // ⌘I puts the keyboard in the Bar. Before the engine is up (the first frames) there is no Bar: ⌘I opens the console.
  const [askSignal, setAskSignal] = useState(0);
  const barUp = engine !== null && shownDeskGroup !== null;
  useEffect(() => {
    if (!barUp) return;
    lendDeskAsk(() => setAskSignal((count) => count + 1));
    return () => lendDeskAsk(null);
  }, [barUp]);

  // The notes the agent pinned to windows, until the next turn starts; and
  // where every window was before the agent first moved one this turn, for
  // Undo layout.
  const [notes, setNotes] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [undo, setUndo] = useState<{ runId: string; turn: number; layout: DeskLayoutSnapshot } | null>(null);
  const turnKey = run === null ? "" : `${run.runId}:${String(run.turns)}`;
  useEffect(() => {
    setNotes((current) => (current.size === 0 ? current : new Map()));
  }, [turnKey]);
  const dismissNote = useCallback((tabId: string) => {
    setNotes((current) => {
      if (!current.has(tabId)) return current;
      const next = new Map(current);
      next.delete(tabId);
      return next;
    });
  }, []);
  const undoShown = undo !== null && run !== null && undo.runId === run.runId && undo.turn === run.turns;
  const onUndo = useCallback(() => {
    if (engine === null || undo === null) return;
    engine.restoreLayout(undo.layout);
    setUndo(null);
  }, [engine, undo]);

  // Main's questions about the desk (the agent's desk tools, a tab it
  // opened): answered from the engine, as the desk stands now (desk-requests.ts).
  useEffect(() => {
    const api = nativeApi();
    if (engine === null || api === null) return;
    const deps: DeskAnswerDeps = {
      engine,
      groupId: () => shownGroup.current ?? "",
      title: () => latest.current.group?.title ?? "",
      tab: (tabId) => useAppStore.getState().snapshot?.tabs.find((tab) => tab.id === tabId),
      file: (itemId) => {
        const item = latest.current.contexts.find((candidate) => candidate.groupId === shownGroup.current)?.items.find((entry) => entry.id === itemId);
        return item?.kind === "file" ? { name: item.name } : undefined;
      },
      turn: () => {
        const current = useAppStore.getState().snapshot?.run ?? null;
        return current === null ? null : { runId: current.runId, turns: current.turns };
      },
      remember: (turn, layout) =>
        setUndo((before) => (before !== null && before.runId === turn.runId && before.turn === turn.turns ? before : { runId: turn.runId, turn: turn.turns, layout })),
      note: (tabId, text) =>
        setNotes((current) => {
          const next = new Map(current);
          if (text === null) next.delete(tabId);
          else next.set(tabId, text);
          return next;
        }),
    };
    return api.onDeskRequest((id, request) => {
      answerDeskRequest(deps, request).then(
        (reply) => api.deskReply(id, reply),
        (error: unknown) => api.deskReply(id, { ok: false, error: error instanceof Error ? error.message : "the desk could not do that" }),
      );
    });
  }, [engine]);

  // Where the agent is: the window whose tab it works in wears its ring, and says what it is doing.
  const agentTab = agentDrivenTabId(run);
  const activity = agentActivity(run);
  const context = contexts.find((candidate) => candidate.groupId === groupId) ?? null;
  // The documents this desk may show: a window whose file has gone from the context goes too.
  const documentKey = documentWindowIds(context).join(" ");
  useEffect(() => {
    engine?.setShellWindows(contextsLoaded ? (documentKey === "" ? [] : documentKey.split(" ")) : null);
  }, [engine, contextsLoaded, documentKey]);

  const otherContexts = useMemo(
    () => contexts.filter((candidate) => candidate.groupId !== groupId && candidate.items.length > 0 && !groups.some((other) => other.id === candidate.groupId)),
    [contexts, groupId, groups],
  );

  const view = useSyncExternalStore(
    useCallback((listener: () => void) => engine?.subscribe(listener) ?? (() => undefined), [engine]),
    () => engine?.getView() ?? null,
  );

  // A window carried over the column: the rail item or the card it would go into lights (lib/desk/chrome.ts's dockDrop).
  const dockDrop = view?.dockDrop ?? null;
  useEffect(() => {
    useDeskChrome.getState().setDockDrop(dockDrop);
  }, [dockDrop]);
  // The sidebar marks the tabs whose windows are out on the desk, and the one in use (lib/desk/chrome.ts).
  useEffect(() => {
    const marks = new Map<string, DeskMark>();
    for (const window of view?.windows ?? []) if (window.flight !== "away" && isTabWindow(window.tabId)) marks.set(window.tabId, window.focused ? "focused" : "out");
    useDeskChrome.getState().setMarks(marks);
  }, [view]);
  // The windows behind one filling the desk are out of sight, as a tab left in the background is: a video playing in
  // one floats (DeskPip, docs/desk.md "Now playing"), and comes back to its window when it is in sight again.
  const behindKey = useMemo(() => {
    const windows = view?.windows ?? [];
    const filling = windows.filter((window) => window.maximized && window.flight === null && window.mini === null && !window.closing);
    const top = filling.length === 0 ? -1 : Math.max(...filling.map((window) => window.z));
    return windows
      .filter((window) => window.z < top && window.mini === null && window.flight === null && isTabWindow(window.tabId))
      .map((window) => window.tabId)
      .join(" ");
  }, [view]);
  const behind = useMemo(() => new Set(behindKey === "" ? [] : behindKey.split(" ")), [behindKey]);
  useEffect(() => {
    useDeskChrome.getState().setBehind(behind);
  }, [behind]);
  // A tab sent to the now playing (lib/desk/now-playing.ts) whose window is out again, or whose media has gone, is
  // sent no more; nor is any once the desk is mounted anew (a reload, a Profile switch). A space switch keeps it: a
  // pop stays until its window is out again or its media ends.
  const popped = useNowPlaying((state) => state.popped);
  const mediaTabIds = useAppStore(useShallow((state) => state.media.map((item) => item.tabId)));
  useEffect(() => {
    for (const tabId of popped) {
      const out = view?.windows.some((window) => window.tabId === tabId && window.flight !== "away") === true;
      if (out || !mediaTabIds.includes(tabId)) useNowPlaying.getState().forget(tabId);
    }
  }, [view, popped, mediaTabIds]);
  useEffect(() => () => useNowPlaying.setState({ popped: [] }), []);
  // The agent's tab wears its ring in the sidebar too.
  useEffect(() => {
    useDeskChrome.getState().setAgentTab(agentTab);
  }, [agentTab]);
  useEffect(
    () => () => {
      const chrome = useDeskChrome.getState();
      chrome.setMarks(new Map());
      chrome.setBehind(new Set());
      chrome.closeCard();
      chrome.setHovered(null);
      chrome.setAgentTab(null);
      chrome.setDockDrop(null);
    },
    [],
  );

  // One of the group's rows in the sidebar under the pointer: ⇧⌫ closes that tab, wherever the keyboard is
  // (main takes the key while the engine says a row is hovered, and says when it is struck).
  const hovered = useDeskChrome((state) => state.hovered);
  const closable = hovered !== null && tabIds.includes(hovered) && view?.gesture == null ? hovered : null;
  useEffect(() => {
    if (engine === null) return;
    engine.setDockHover(closable !== null);
    if (closable === null) return;
    const offPage = nativeApi()?.onDeskPageInput((input) => {
      if (input === "close") void useAppStore.getState().closeTab(closable);
    });
    return () => offPage?.();
  }, [engine, closable]);

  // The space lost a tab (closed, moved out): its window goes. The tab in
  // use joined it (a new tab, which main puts in the current space): its
  // window comes out.
  const tabsBefore = useRef(tabIds);
  useEffect(() => {
    const before = tabsBefore.current;
    tabsBefore.current = tabIds;
    // (The space not known for a moment, or still to be passed to: its windows wait for the passing, above.)
    if (engine === null || group === null || shownGroup.current !== groupId) return;
    engine.syncTabs(tabIds);
    const active = useAppStore.getState().snapshot?.activeTabId ?? null;
    if (active !== null && tabIds.includes(active) && !before.includes(active) && !engine.windowTabIds().includes(active)) engine.activeChanged(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, tabKey]);

  // A tab woke, a variant changed, the overlay rose or fell: re-decide what is live.
  useEffect(() => {
    engine?.refresh();
  }, [engine, tabs, wakingTabIds, variants, overlayActive]);

  // The tab in use is the desk's business: one of the space's — chosen in
  // the sidebar, the tab switcher, the palette — comes to the top (or out of
  // the dock). Main keeps the tab in use in the current space, so one of
  // another space is the desk passing (above), never something to decide
  // here; none in use is the empty space's keyboard, the shell's. (Until
  // 2026-10-09 the desk decided here which desk a tab chosen elsewhere passed
  // it to, making a loose tab's group for it if need be, and waited for the
  // snapshot to name it.)
  useEffect(() => {
    if (engine === null || activeTabId === null || shownGroup.current !== groupId) return;
    if (tabIds.includes(activeTabId)) engine.activeChanged(activeTabId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, activeTabId]);

  // The desk's corners are a window's (the Appearance radius): read again as it changes, a frame later, once the
  // radius is on the page (ThemeRuntime), so windows filling the desk are clipped to its curve.
  const cornerRadius = useAppStore((state) => state.settings.appearance.radius);
  useEffect(() => {
    if (engine === null) return;
    const frame = requestAnimationFrame(() => engine.measure());
    return () => cancelAnimationFrame(frame);
  }, [engine, cornerRadius]);

  // The grab key held over the desk: the frames show an open hand.
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null || variants.grab === "off") return;
    const arm = (event: KeyboardEvent | PointerEvent): void => {
      if (holdsGrab(event, variants.grab)) stage.dataset["grabArmed"] = "";
      else delete stage.dataset["grabArmed"];
    };
    const disarm = (): void => {
      delete stage.dataset["grabArmed"];
    };
    window.addEventListener("keydown", arm);
    window.addEventListener("keyup", arm);
    stage.addEventListener("pointermove", arm);
    window.addEventListener("blur", disarm);
    return () => {
      window.removeEventListener("keydown", arm);
      window.removeEventListener("keyup", arm);
      stage.removeEventListener("pointermove", arm);
      window.removeEventListener("blur", disarm);
      disarm();
    };
  }, [variants.grab]);

  // Under a Glance its owner recedes, and main takes every live page down for it: the windows show what it captured as
  // the Glance came up (as the panes do: ContentArea), not what they last had.
  const coverStills = glance?.backgroundStills ?? paneStills;
  const stillByTab = useMemo(() => new Map(coverStills.map((still) => [still.tabId, still.dataUrl])), [coverStills]);
  // The windows' tabs: the group's, and a moment after passing to another group, the old one's on their way home.
  const strayKey = view?.windows
    .map((window) => window.tabId)
    .filter((tabId) => !tabIds.includes(tabId))
    .join(" ");
  const strays = useAppStore(useShallow((state) => tabsOf(state.snapshot, strayKey === undefined || strayKey === "" ? EMPTY_IDS : strayKey.split(" "))));
  const tabsById = useMemo(() => new Map([...tabs, ...strays].map((tab) => [tab.id, tab])), [tabs, strays]);
  // Over a live page, the parked windows are main's shelf view (ShelfApp), drawn over the page as nothing of the
  // shell's can be: it is told where each stands (in the window, cut off at the desk's foot) and what it shows.
  const sentShelf = useRef("");
  useLayoutEffect(() => {
    const api = nativeApi();
    const stage = stageRef.current;
    const shelf = view?.shelf ?? null;
    if (api === null) return;
    if (shelf === null || shelf.length === 0 || stage === null) {
      if (sentShelf.current !== "") api.setDeskShelf(null);
      sentShelf.current = "";
      return;
    }
    const at = stage.getBoundingClientRect();
    const pad = 2;
    const left = Math.min(...shelf.map((spot) => spot.rect.x));
    const right = Math.max(...shelf.map((spot) => spot.rect.x + spot.rect.w));
    const top = Math.min(...shelf.map((spot) => spot.rect.y));
    const insets = WINDOW_INSETS;
    const frame = {
      bounds: { x: at.left + left - pad, y: at.top + top - pad, width: right - left + pad * 2, height: at.height - top + pad },
      pad,
      insets: { top: insets.top, left: insets.left, right: insets.right },
      windows: shelf.map((spot) => {
        const tab = tabsById.get(spot.tabId) ?? null;
        const host = displayHost(tab?.url ?? "");
        return {
          tabId: spot.tabId,
          x: spot.rect.x - left + pad,
          width: spot.rect.w,
          height: spot.rect.h,
          title: tab?.title || host || "Untitled",
          host,
          faviconUrl: tab?.faviconUrl ?? null,
          still: view?.windows.find((window) => window.tabId === spot.tabId)?.still ?? null,
        };
      }),
    };
    const key = JSON.stringify(frame);
    if (key === sentShelf.current) return;
    sentShelf.current = key;
    api.setDeskShelf(frame);
  }, [view, tabsById]);
  useEffect(() => () => nativeApi()?.setDeskShelf(null), []);
  // The pointer onto one of the shelf view's windows (it rises), or off it: the view's own word, apart from the shell's.
  useEffect(() => nativeApi()?.onDeskShelfInput((input) => engine?.hoverMini(input.tabId, "shelf", input.over)), [engine]);
  // A parked window raised by the pointer goes back down once the OS's pointer is off it. Raised from the shelf view, it
  // covered the page under it, and the view went from under the pointer as it rose — so the view never hears the
  // pointer go, nor does the shell unless it crosses the window's frame on its way (onto the page above, it does not):
  // it stayed up for good (2026-10-08). While one is up, then, the OS's pointer is read now and then.
  const raisedMini = view?.windows.find((window) => window.raised)?.tabId ?? null;
  useEffect(() => {
    if (raisedMini === null || engine === null) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      void (async () => {
        let point: { x: number; y: number } | null = null;
        try {
          point = (await nativeApi()?.getCursorPoint()) ?? null;
        } catch {
          point = null;
        }
        // (Unreadable — Playwright — the pointer events have the last word.)
        if (stopped || point === null) return;
        const under = document.elementFromPoint(point.x, point.y);
        const on = under?.closest(`[data-testid="desk-window"][data-tab-id="${CSS.escape(raisedMini)}"]`) ?? null;
        if (on === null) engine.leaveMini(raisedMini);
      })();
    }, MINI_POINTER_CHECK_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [raisedMini, engine]);
  const attachZone = useCallback((el: HTMLDivElement | null) => engine?.attachZone(el), [engine]);
  // What a shell window shows (a document's file), one object per file so its window only re-renders when the file changes.
  // The file is found in whichever group's context holds it: a window of the group the desk has
  // just passed from keeps its own file while it goes home, and saves an edit there.
  const subjects = useRef(new Map<string, ShellWindowSubject>());
  const shellSubject = (windowId: string): ShellWindowSubject | null => {
    const itemId = fileItemOf(windowId);
    if (itemId === null) return null;
    const before = subjects.current.get(windowId);
    const found = fileOf(contexts, itemId);
    // Not found (the context not loaded yet, or the file just removed): the window keeps what it had.
    const owner = found?.groupId ?? before?.groupId ?? groupId ?? "";
    const item = found?.item ?? null;
    if (before !== undefined && before.item === item && before.groupId === owner) return before;
    const subject: ShellWindowSubject = {
      kind: "file",
      groupId: owner,
      item,
      openElsewhere: () => void nativeApi()?.groupContext({ type: "open", groupId: owner, itemId }).catch(() => undefined),
    };
    subjects.current.set(windowId, subject);
    return subject;
  };
  const attachGuides = useCallback((el: HTMLDivElement | null) => engine?.attachGuides(el), [engine]);
  // A Glance taken in is one of the desk's windows (receiveGlance): filling the desk, or a tile among the others.
  const grouped = shownDeskGroup !== null;
  const glanceDesk = useMemo<GlanceDesk | undefined>(
    () =>
      engine === null || !grouped
        ? undefined
        : {
            land: (how) => {
              const current = useAppStore.getState().glance;
              // In Home, filling the desk it is a Home tab of its own (main's promotion; the desk takes its space on in
              // place, its window where it lands here: the passing, above); as a tile beside the page in use, main grows
              // the two into a space, as the row's + does — back to Home once one is closed (#setBeside's `grow`).
              const landing = current === null ? null : engine.receiveGlance(current.tab.id, how, current.ownerTabId);
              if (landing === null) return null;
              const bounds = ({ x, y, w, h }: { x: number; y: number; w: number; h: number }) => ({ x, y, width: w, height: h });
              return { local: bounds(landing.stage), window: bounds(landing.window) };
            },
          },
    [engine, grouped],
  );
  // An EMPTY space — no tabs (docs/spaces.md §1) — with nothing of it out (a document's window may be; another space's
  // windows may still be on their way home): the empty desk's mark. A space whose windows were all put away has its
  // tabs in its rows, and is no empty space (2026-10-09: until then it was drawn as one, "New tab · Drop files here").
  const empty =
    engine !== null &&
    view !== null &&
    deskGroup !== null &&
    deskGroup.tabIds.length === 0 &&
    !view.windows.some((window) => window.flight !== "away" && (tabIds.includes(window.tabId) || (!isTabWindow(window.tabId) && documentKey.split(" ").includes(window.tabId))));

  // A layout looked at in the space view (DeskEngine.previewLayout): its ghosts, once no live page is under their cover.
  const layoutGhosts = view !== null && view.preview !== null && view.clearCovers.has(LAYOUT_PREVIEW_COVER);

  return (
    <section
      data-testid="desk-surface"
      className="browser-surface desk-surface drag-region relative flex min-h-0 min-w-0 flex-1 bg-background-200 p-2"
      style={{ paddingTop: SURFACE_GUTTER, paddingLeft: 0 }}
    >
      <div
        ref={stageRef}
        data-phase={view?.phase ?? "entering"}
        data-gesture={view?.gesture ?? undefined}
        data-snapping={view?.snapping === true ? "" : undefined}
        // The space shown (main's current one), once the engine shows it; and whether it is an empty one, nothing of it out.
        data-group-id={view === null ? undefined : (shownGroup.current ?? undefined)}
        data-empty={empty ? "" : undefined}
        data-group-color={group?.color}
        data-glance={glance !== null && glanceStaged ? "" : undefined}
        data-glance-closing={glanceClosing ? "" : undefined}
        // A layout looked at in the space view, its ghosts up (LayoutGhosts): the windows recede under them.
        data-layout-preview={layoutGhosts ? "" : undefined}
        className="desk-stage no-drag tab-group-tone relative min-h-0 min-w-0 flex-1"
        // A press on the desk's own surface, between its windows (not on one, nor on anything drawn over it):
        // the window in use is left, as a click on the desktop leaves an app's window.
        onPointerDown={(event) => {
          if (event.button === 0 && event.target === event.currentTarget) engine?.pressDesk();
        }}
      >
        <div ref={attachZone} className="desk-zone" aria-hidden="true" />
        <div ref={attachGuides} className="desk-guides" aria-hidden="true">
          <span />
          <span />
        </div>
        {engine === null || view === null
          ? null
          : view.windows.map((window) => {
              // Under a raised overlay (a menu, the address palette) the live pages are down: paint
              // what they were showing, a picture of the whole page — whether or not the engine had
              // one of its own (the window in use, live since it landed, often has none). Not for a
              // masked window: that still would be the whole page's, with nothing to say so.
              const overlayStill = (overlayActive || glance !== null) && window.mask === null ? stillByTab.get(window.tabId) : undefined;
              return (
                <DeskWindow
                  key={window.tabId}
                  view={overlayStill === undefined || (window.stillShows === "page" && window.stillSize === null) ? window : { ...window, stillShows: "page", stillSize: null }}
                  tab={tabsById.get(window.tabId) ?? null}
                  grab={variants.grab}
                  still={overlayStill ?? window.still}
                  // Main is waking it, or is to (wanted live, still asleep): a window left asleep on purpose says nothing.
                  waking={wakingTabIds.includes(window.tabId) || (window.live && tabsById.get(window.tabId)?.lifecycle === "suspended")}
                  behind={behind.has(window.tabId)}
                  engine={engine}
                  agent={agentTab === window.tabId ? activity : null}
                  note={notes.get(window.tabId) ?? null}
                  onDismissNote={dismissNote}
                  shell={shellSubject(window.tabId)}
                />
              );
            })}
        {layoutGhosts && view !== null && view.preview !== null ? <LayoutGhosts preview={view.preview} tabsById={tabsById} contexts={contexts} /> : null}
        {empty && deskGroup !== null ? <DeskEmpty title={deskGroup.title} /> : null}
        {/* (The space not known for a moment: the More card, but no Stack, file drops or Bar.) */}
        {engine === null || view === null ? null : (
          <DeskSideCard engine={engine} view={view} stageRef={stageRef} group={shownDeskGroup} context={context} others={otherContexts} />
        )}
        {engine === null || view === null || shownDeskGroup === null ? null : (
          <DeskDropZone group={shownDeskGroup} engine={engine} view={view} />
        )}
        {engine === null || view === null || shownDeskGroup === null ? null : (
          <DeskBar group={shownDeskGroup} groups={groups} engine={engine} view={view} run={run} threads={threads} undo={undoShown} onUndo={onUndo} focusSignal={askSignal} context={context} />
        )}
        {glance === null ? null : <GlanceOverlay key={glance.tab.id} glance={glance} surfaceRef={stageRef} desk={glanceDesk} />}
      </div>
    </section>
  );
}
