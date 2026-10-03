import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { agentDrivenTabId } from "@pistachio/shell-contracts/agent-glow";
import { SURFACE_GUTTER } from "@pistachio/shell-contracts/chrome";
import type { BrowserTabInfo, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { isShellPageUrl } from "@pistachio/shell-contracts/shell-pages";
import { tabGroupTitle, type TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { nativeApi } from "../../api";
import { cn } from "../../lib/cn";
import { agentActivity } from "../../lib/desk/agent";
import { useGroupContexts, useGroupContextsLoaded } from "../../lib/desk/group-context";
import { useFileWindows } from "../../lib/desk/group-files";
import { useNowPlaying } from "../../lib/desk/now-playing";
import { documentWindowIds, fileOf } from "../../lib/desk/documents";
import { fileItemOf, fileWindowId, isTabWindow } from "../../lib/desk/windows";
import { displayHost } from "../../lib/url";
import { deskFor, lendDeskArrange, lendDeskAsk, lendDeskEngine } from "../../lib/desk/open";
import { useDeskChrome, type DeskMark } from "../../lib/desk/chrome";
import { deskGroups, isDayTab, passedEntry, tabDeskOf, useDeskStore, type DeskVariants } from "../../lib/desk/store";
import { useAppStore } from "../../store";
import { GlanceOverlay } from "../GlanceOverlay";
import { DeskBar } from "./DeskBar";
import { CHROME_INSETS, DeskEngine, type DeskLayoutSnapshot } from "./desk-engine";
import { answerDeskRequest, type DeskAnswerDeps } from "./desk-requests";
import { DeskDropRail } from "./DeskDropRail";
import { DeskDropZone } from "./DeskDropZone";
import { DeskSideCard } from "./DeskSideCard";
import { DeskWindow, holdsGrab } from "./DeskWindow";
import { SmartArranger, type WindowWords } from "./smart-arrange";
import type { ShellWindowSubject } from "./window-kinds";

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

/** The stage's corner in the window (where the drop rail, over the sidebar, is placed from). */
function stageCorner(stage: HTMLElement | null): { left: number; top: number } {
  const box = stage?.getBoundingClientRect();
  return { left: box?.left ?? 0, top: box?.top ?? 0 };
}

/**
 * Where a window lives in the sidebar, the desk's dock (DeskHost.homeOf):
 * a tab's row — or, its group folded away or the row scrolled out of
 * sight, its group's — another group's row, or the Stack's (the group's
 * context row), for a document. Null where the sidebar shows none.
 */
function sidebarHome(kind: "tab" | "group" | "file", id: string, groupId: string): HTMLElement | null {
  const pane = document.querySelector<HTMLElement>("[data-testid='sidebar-pane']");
  if (pane === null) return null;
  const list = pane.querySelector<HTMLElement>("[data-testid='sidebar-tab-list']")?.getBoundingClientRect() ?? null;
  const inSight = (el: HTMLElement | null): HTMLElement | null => {
    if (el === null || list === null) return el;
    const box = el.getBoundingClientRect();
    const middle = box.top + box.height / 2;
    return box.width > 0 && middle >= list.top && middle <= list.bottom ? el : null;
  };
  // (The favorites stand above the list: drawn is enough.)
  const shown = (el: HTMLElement | null): HTMLElement | null => (el !== null && el.getBoundingClientRect().width > 0 ? el : null);
  const tabRow = (tabId: string): HTMLElement | null =>
    inSight(pane.querySelector<HTMLElement>(`[role='tab'][data-tab-id='${CSS.escape(tabId)}']`)) ??
    // A favorite's page: its tile, or on the rail its row under the folder.
    shown(pane.querySelector<HTMLElement>(`[data-live-tab-id='${CSS.escape(tabId)}']`));
  // A page's own desk, or a loose tab's group, has no group's row: its tab's own is its home.
  const groupRow = (gid: string): HTMLElement | null => {
    const lone = tabDeskOf(gid) ?? useAppStore.getState().snapshot?.looseGroups?.find((group) => group.id === gid)?.tabIds[0] ?? null;
    if (lone !== null) return tabRow(lone);
    return inSight(pane.querySelector<HTMLElement>(`[data-testid='tab-group'][data-group-id='${CSS.escape(gid)}'] [data-group-header]`));
  };
  if (kind === "group") return groupRow(id);
  if (kind === "file") return inSight(pane.querySelector<HTMLElement>("[data-testid='desk-stack']")) ?? groupRow(groupId);
  return tabRow(id) ?? groupRow(groupId);
}

/**
 * The desk: a tab group's tabs as free windows over the surface (docs/desk.md),
 * with the sidebar's column beside it as its dock — the group's tabs as rows
 * there, which windows come out of and go back into. It takes the browser
 * surface's place while it is up — same box, same gutter — so the page in
 * view becomes a window without moving a pixel, and it gives the box back
 * the same way.
 *
 * The motion is the engine's (desk-engine.ts); this component keeps it fed
 * with what the browser says — the group's tabs, which one is active,
 * which are asleep — and draws what the engine says is on the desk.
 *
 * The desk can pass to another of the Space's groups in place (that group's
 * desk button in the sidebar: useDeskStore's switchTo): `groupId` changes
 * under the same engine, which sends the old group's windows into its row
 * and brings the new group's out of theirs (DeskEngine.switchGroup).
 */
export default function DeskSurface({ groupId }: { groupId: string }) {
  // A page's own desk (tabDeskId: a favorite's, a pinned page's) is that tab's alone: no group, no Stack, no Bar.
  const pageTabId = tabDeskOf(groupId);
  // The desk's group: one the chrome draws, or a loose tab's (TabGroupInfo.loose).
  const group = useAppStore((state) => deskGroups(state.snapshot).find((candidate) => candidate.id === groupId) ?? null);
  const tabs = useAppStore(useShallow((state) => (pageTabId === null ? groupTabs(state.snapshot, group) : tabsOf(state.snapshot, [pageTabId]))));
  // A loose tab's group goes by its tab's name, as the sidebar draws it: the Bar asks about it, the Stack is its.
  const looseTitle = useAppStore((state) => (group?.loose === true ? (state.snapshot?.tabs.find((tab) => tab.id === group.tabIds[0])?.title ?? "") : ""));
  const deskGroup = useMemo(() => (group?.loose === true ? { ...group, title: tabGroupTitle(looseTitle) } : group), [group, looseTitle]);
  const allTabIds = useAppStore(useShallow((state) => state.snapshot?.tabs.map((tab) => tab.id) ?? EMPTY_IDS));
  const activeTabId = useAppStore((state) => state.snapshot?.activeTabId ?? null);
  const wakingTabIds = useAppStore((state) => state.snapshot?.wakingTabIds ?? EMPTY_IDS);
  const overlayActive = useAppStore((state) => state.overlayActive);
  const paneStills = useAppStore((state) => state.paneStills);
  const glance = useAppStore((state) => state.glance);
  const sidebarLayout = useAppStore((state) => state.settings.layout.mode === "sidebar");
  const setContentBounds = useAppStore((state) => state.setContentBounds);
  const run = useAppStore((state) => state.snapshot?.run ?? null);
  const threads = useAppStore((state) => state.snapshot?.threads ?? EMPTY_THREADS);
  const drawnGroups = useAppStore((state) => state.snapshot?.tabGroups ?? EMPTY_GROUPS);
  const looseGroups = useAppStore((state) => state.snapshot?.looseGroups ?? EMPTY_GROUPS);
  const groups = useMemo(() => (looseGroups.length === 0 ? drawnGroups : [...drawnGroups, ...looseGroups]), [drawnGroups, looseGroups]);
  const contexts = useGroupContexts();
  const contextsLoaded = useGroupContextsLoaded();
  const variants = useDeskStore((state) => state.variants);
  const leaving = useDeskStore((state) => state.leaving);
  const stageRef = useRef<HTMLDivElement>(null);
  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  const tabKey = tabIds.join(" ");

  // What the engine asks of the browser, always answered from the latest render.
  const latest = useRef({ tabs, wakingTabIds, variants, group: deskGroup, contexts, contextsLoaded });
  latest.current = { tabs, wakingTabIds, variants, group: deskGroup, contexts, contextsLoaded };
  /** The group the engine's windows are of: it moves on only once the engine has passed to the next (and saved this one under its own id). */
  const shownGroup = useRef(groupId);

  const [engine, setEngine] = useState<DeskEngine | null>(null);
  // The tab in view when the desk opened, not one of the group's: it stays
  // the active one until the browser has selected the tab the desk opened on.
  const opener = useRef<string | null>(null);
  // The desk passes to a tab's own because that tab was chosen: it comes up on it.
  const passFor = useRef<string | null>(null);
  // The desk's own changed under its windows (a loose tab put in a group, a group gone): no passing, the windows stay.
  const inPlace = useRef(false);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const created = new DeskEngine({
      variants: (): DeskVariants => latest.current.variants,
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
        if (isTabWindow(tabId)) void useAppStore.getState().closeTab(tabId);
      },
      editAddress: (tabId) => {
        if (isTabWindow(tabId)) useAppStore.getState().openUrlBar(tabId);
      },
      save: (windows) => useDeskStore.getState().save(shownGroup.current, { windows }),
      moveTabToGroup: (tabId, groupId, next) => {
        void (async () => {
          const store = useAppStore.getState();
          // The desk never stands on a tab that is not its group's: another
          // of them is in use first — the window left on top, or with none,
          // the tab used last, which comes out.
          if (store.snapshot?.activeTabId === tabId) {
            const others = latest.current.tabs.filter((tab) => tab.id !== tabId);
            const other = next ?? [...others].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id ?? null;
            if (other !== null) await store.selectTab(other);
          }
          await store.tabGroupCommand({ type: "addTab", groupId, tabId });
        })();
      },
      leaveDone: () => useDeskStore.getState().finishLeave(),
      sidebar: () => {
        const slot = document.querySelector<HTMLElement>("[data-testid='sidebar-motion-slot']");
        if (slot === null) return null;
        const box = slot.getBoundingClientRect();
        return box.width < 1 ? null : { x: box.left, y: box.top, w: box.width, h: box.height };
      },
      homeOf: (kind, id) => sidebarHome(kind, id, shownGroup.current),
    });
    created.attachStage(stage);
    const snapshot = useAppStore.getState().snapshot;
    const ids = latest.current.tabs.map((tab) => tab.id);
    const active = snapshot?.activeTabId ?? null;
    // The tab in view becomes the first window; with none of the group's in
    // view, the one used last.
    const entry =
      active !== null && ids.includes(active)
        ? active
        : ([...latest.current.tabs].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id ?? null);
    // Its documents, once main has said what the context holds (until then the saved ones come out, and go if they are gone).
    const documents = latest.current.contextsLoaded ? documentWindowIds(latest.current.contexts.find((candidate) => candidate.groupId === groupId)) : null;
    created.start(useDeskStore.getState().saved[groupId]?.windows ?? [], entry, ids, documents);
    if (entry !== null && entry !== active) {
      opener.current = active;
      useAppStore.getState().selectTab(entry).catch(() => undefined);
    }
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
    // The pointer on a minimized window's live page, which the shell never hears: main's word (a parked one rises into view).
    const offHover = nativeApi()?.onDeskHover((hover) => created.hoverMini(hover.tabId, "page", hover.over));
    const offPage = nativeApi()?.onDeskPageInput((input) => {
      // A press on a live page while a document was in use: that page is in use now. (Pressed, a page
      // the browser had not selected is selected, and comes up that way; the one it had, only here.)
      if (input === "press") {
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
    // One engine per desk (the component's key); a group passed to later is the engine's to run (below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Passed to another group: the engine sends this group's windows into
  // its icon, and brings the new one's out to where they were left — its
  // top window then in use, or with none left, its tab used last; passed to
  // because one of its tabs was chosen, that tab. A loose tab's desk comes
  // up as its one window, in the middle.
  useLayoutEffect(() => {
    const from = shownGroup.current;
    if (engine === null || from === groupId) return;
    const groupTabIds = latest.current.tabs.map((tab) => tab.id);
    const shellIds = latest.current.contextsLoaded ? documentWindowIds(latest.current.contexts.find((candidate) => candidate.groupId === groupId)) : null;
    const chosen = passFor.current;
    passFor.current = null;
    if (inPlace.current) {
      inPlace.current = false;
      // (What it saves from here is the new desk's.)
      shownGroup.current = groupId;
      engine.regroup(groupTabIds, shellIds);
      return;
    }
    const saved = useDeskStore.getState().saved[groupId]?.windows ?? [];
    const entry = chosen !== null && groupTabIds.includes(chosen) ? chosen : passedEntry(saved, latest.current.tabs);
    // The old group's tab stays the active one until the new one's is selected: no reason to leave.
    opener.current = useAppStore.getState().snapshot?.activeTabId ?? null;
    engine.switchGroup({ from, groupId, tabIds: groupTabIds, shellIds, saved, entry });
    shownGroup.current = groupId;
  }, [engine, groupId]);

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
      notify: (message, undo) => useAppStore.getState().showNotice(message, undo === null ? {} : { action: { label: "Undo", run: undo } }),
      later: (run, ms) => {
        const timer = window.setTimeout(run, ms);
        return () => window.clearTimeout(timer);
      },
    });
    arranger.current = created;
    return () => {
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

  // The keyboard's Tile, Cascade and Arrange (chrome/actions.tsx) reach this desk's engine.
  useEffect(() => {
    if (engine === null) return;
    lendDeskArrange((kind) => (kind === "smart" ? void arranger.current?.ask() : engine.arrange(kind)));
    return () => lendDeskArrange(null);
  }, [engine]);

  // ── The desk's agent (docs/desk-agent.md) ──────────────────────────────

  // Main opens the group's conversation while its desk is up, and goes back
  // to the one before when it leaves; passing to another group, that one's.
  // A page's own desk has no group, so no conversation of its own: main
  // goes back to the one before, as when a desk is left.
  useEffect(() => {
    void nativeApi()?.deskConversation(pageTabId === null ? { type: "enter", groupId } : { type: "leave" }).catch(() => undefined);
  }, [groupId, pageTabId]);
  useEffect(() => () => void nativeApi()?.deskConversation({ type: "leave" }).catch(() => undefined), []);

  // ⌘I puts the keyboard in the Bar. A page's own desk has none: there ⌘I opens the console, as anywhere.
  const [askSignal, setAskSignal] = useState(0);
  const barUp = deskGroup !== null;
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
      groupId: () => shownGroup.current,
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

  // The sidebar marks the tabs whose windows are out on the desk, and the one in use (lib/desk/chrome.ts).
  useEffect(() => {
    const marks = new Map<string, DeskMark>();
    for (const window of view?.windows ?? []) if (window.flight !== "away" && isTabWindow(window.tabId)) marks.set(window.tabId, window.focused ? "focused" : "out");
    useDeskChrome.getState().setMarks(marks);
  }, [view]);
  // A tab sent to the now playing (lib/desk/now-playing.ts) whose window is out again, or whose media has gone, is
  // sent no more; nor is any once the desk is left.
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
      chrome.closeCard();
      chrome.setHovered(null);
      chrome.setAgentTab(null);
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

  // The group lost a tab (closed, moved out): its window goes. The tab in
  // use joined it (a new tab on the desk, below): its window comes out.
  const tabsBefore = useRef(tabIds);
  useEffect(() => {
    const before = tabsBefore.current;
    tabsBefore.current = tabIds;
    // The desk's own group gone (ungrouped, a loose tab's put in another): its windows wait for the desk to pass
    // (below), which keeps the one in use where it is, in place, or sends them home — not taken off here first.
    if (engine === null || (group === null && pageTabId === null)) return;
    engine.syncTabs(tabIds);
    const active = useAppStore.getState().snapshot?.activeTabId ?? null;
    if (!leaving && active !== null && tabIds.includes(active) && !before.includes(active) && !engine.windowTabIds().includes(active)) engine.activeChanged(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, tabKey]);

  // The group lost the tab in use, and it is still open (pinned, made a
  // favorite, taken out of the group or put in another — from its icon's
  // menu, say): the desk never stands on a tab not its own, so another of
  // the group's is in use — the window left on top, or with none out, the
  // tab used last, which comes out. (The group gone altogether ends the desk, below.)
  // (Passed to another group, the desk chooses the tab it comes up on itself.)
  const groupBefore = useRef({ groupId, tabIds });
  useEffect(() => {
    const before = groupBefore.current;
    groupBefore.current = { groupId, tabIds };
    const active = useAppStore.getState().snapshot?.activeTabId ?? null;
    if (engine === null || leaving || before.groupId !== groupId || active === null || tabIds.length === 0) return;
    if (tabIds.includes(active) || !before.tabIds.includes(active)) return;
    const top = engine.windowTabIds().filter((tabId) => tabIds.includes(tabId)).at(-1);
    const next = top ?? [...latest.current.tabs].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id;
    if (next !== undefined) void useAppStore.getState().selectTab(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, groupId, tabKey]);

  // A tab woke, a variant changed, the overlay rose or fell: re-decide what is live.
  useEffect(() => {
    engine?.refresh();
  }, [engine, tabs, wakingTabIds, variants, overlayActive]);

  // The browser's active tab is the desk's business: one of the group's
  // comes to the top (or out of the inventory). A tab new since the last one
  // and in no group (the address palette's, a link's) is a new tab on the
  // desk: it joins the group, and comes out (above). Any other — from the
  // sidebar, the tab switcher, the address palette — passes the desk to its
  // own (deskFor): its group's, a loose tab's group made for it, or a page's
  // own desk. A desk is left only by leaving it. (Unless the tab only became
  // active because a desk window's tab was closed: the window left on top is
  // in use.)
  const previous = useRef({ activeTabId, allTabIds });
  useEffect(() => {
    const before = previous.current;
    previous.current = { activeTabId, allTabIds };
    if (engine === null || activeTabId === null || leaving) return;
    if (tabIds.includes(activeTabId)) {
      opener.current = null;
      engine.activeChanged(activeTabId);
      return;
    }
    // Still the tab from before the desk, its own on the way: no reason to pass.
    if (activeTabId === opener.current) return;
    const closed = before.activeTabId !== null && !allTabIds.includes(before.activeTabId);
    const top = closed ? engine.windowTabIds().filter((id) => isTabWindow(id) && tabIds.includes(id)).at(-1) : undefined;
    if (top !== undefined) {
      void useAppStore.getState().selectTab(top);
      return;
    }
    const snapshot = useAppStore.getState().snapshot;
    const chosen = snapshot?.tabs.find((tab) => tab.id === activeTabId);
    const fresh = chosen !== undefined && !before.allTabIds.includes(activeTabId) && isDayTab(chosen) && !deskGroups(snapshot).some((other) => other.tabIds.includes(activeTabId));
    if (fresh && group !== null) {
      void useAppStore.getState().tabGroupCommand({ type: "addTab", groupId, tabId: activeTabId });
      return;
    }
    void deskFor(activeTabId).then((next) => {
      const desk = useDeskStore.getState();
      // (Only while the desk, and the tab in use, are as they were.)
      if (next === null || desk.groupId !== groupId || desk.leaving || useAppStore.getState().snapshot?.activeTabId !== activeTabId) return;
      passFor.current = activeTabId;
      desk.switchTo(next);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, activeTabId]);

  // The desk's own went from under it. A page's own desk whose tab is put
  // in a group: the desk passes to that group, on that tab. A group gone —
  // a loose tab's, its tab put in another group (dragged into one); any
  // group ungrouped, its tabs closed, moved to another Space — passes the
  // desk to the tab in use's own (deskFor), in place when that desk was
  // never up before and its window is out here (a loose tab's group made
  // now, a group never on a desk): the window stays where it is, the others
  // go home. With no tab in use, it is left.
  const pageHome = useAppStore((state) =>
    pageTabId === null ? null : (deskGroups(state.snapshot).find((candidate) => candidate.tabIds.includes(pageTabId))?.id ?? null),
  );
  const pageGone = pageTabId !== null && !allTabIds.includes(pageTabId);
  useEffect(() => {
    const desk = useDeskStore.getState();
    // (Passed on already, the tab in use having changed with it: above.)
    if (engine === null || desk.leaving || desk.groupId !== groupId) return;
    if (pageTabId !== null && pageHome !== null) {
      passFor.current = pageTabId;
      desk.switchTo(pageHome);
      return;
    }
    if (pageTabId !== null ? !pageGone : group !== null) return;
    const active = useAppStore.getState().snapshot?.activeTabId ?? null;
    if (active === null) {
      desk.leave({ immediate: true });
      return;
    }
    void deskFor(active).then((next) => {
      const now = useDeskStore.getState();
      if (now.groupId !== groupId || now.leaving) return;
      if (next === null) {
        now.leave({ immediate: true });
        return;
      }
      inPlace.current = now.saved[next] === undefined && engine.windowTabIds().includes(active);
      passFor.current = active;
      now.switchTo(next);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, group, pageHome, pageGone]);

  useEffect(() => {
    if (leaving) engine?.leave();
  }, [engine, leaving]);

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

  const stillByTab = useMemo(() => new Map(paneStills.map((still) => [still.tabId, still.dataUrl])), [paneStills]);
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
    const insets = CHROME_INSETS[variants.chrome];
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
  }, [view, tabsById, variants.chrome]);
  useEffect(() => () => nativeApi()?.setDeskShelf(null), []);
  // The pointer onto one of the shelf view's windows is onto its frame (it rises), or off it.
  useEffect(() => nativeApi()?.onDeskShelfInput((input) => engine?.hoverMini(input.tabId, "frame", input.over)), [engine]);
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
    const owner = found?.groupId ?? before?.groupId ?? groupId;
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
  /** A window in hand: the drop rail may stand over the sidebar. */
  const carrying = view?.gesture === "move" || view?.gesture === "spawn";

  return (
    <section
      data-testid="desk-surface"
      className={cn("browser-surface desk-surface relative flex min-h-0 min-w-0 flex-1 bg-background-200 p-2", sidebarLayout && "drag-region")}
      style={{ paddingTop: SURFACE_GUTTER, paddingLeft: sidebarLayout ? 0 : SURFACE_GUTTER }}
    >
      <div
        ref={stageRef}
        data-phase={view?.phase ?? "entering"}
        data-gesture={view?.gesture ?? undefined}
        data-snapping={view?.snapping === true ? "" : undefined}
        data-group-color={group?.color}
        className="desk-stage no-drag tab-group-tone relative min-h-0 min-w-0 flex-1"
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
              const overlayStill = overlayActive && window.mask === null ? stillByTab.get(window.tabId) : undefined;
              return (
                <DeskWindow
                  key={window.tabId}
                  view={overlayStill === undefined || window.stillShows === "page" ? window : { ...window, stillShows: "page" }}
                  tab={tabsById.get(window.tabId) ?? null}
                  chrome={variants.chrome}
                  grab={variants.grab}
                  still={overlayStill ?? window.still}
                  waking={wakingTabIds.includes(window.tabId)}
                  engine={engine}
                  agent={agentTab === window.tabId ? activity : null}
                  note={notes.get(window.tabId) ?? null}
                  onDismissNote={dismissNote}
                  shell={shellSubject(window.tabId)}
                />
              );
            })}
        {/* (A page's own desk has no group: its More card and drop rail, but no Stack, file drops or Bar.) */}
        {engine === null || view === null || (deskGroup === null && pageTabId === null) ? null : (
          <DeskSideCard engine={engine} view={view} stageRef={stageRef} group={deskGroup} context={context} others={otherContexts} />
        )}
        {engine === null || view === null || (deskGroup === null && pageTabId === null) ? null : (
          <DeskDropRail
            engine={engine}
            drops={view.drops}
            stage={stageCorner(stageRef.current)}
            shown={carrying && view.dropsShown}
            drop={carrying ? view.dockDrop : null}
            groupColor={deskGroup?.color ?? null}
          />
        )}
        {engine === null || view === null || deskGroup === null ? null : (
          <DeskDropZone group={deskGroup} engine={engine} view={view} />
        )}
        {engine === null || view === null || deskGroup === null ? null : (
          <DeskBar group={deskGroup} groups={groups} engine={engine} view={view} run={run} threads={threads} undo={undoShown} onUndo={onUndo} focusSignal={askSignal} context={context} />
        )}
        {glance === null ? null : <GlanceOverlay key={glance.tab.id} glance={glance} surfaceRef={stageRef} />}
      </div>
    </section>
  );
}
