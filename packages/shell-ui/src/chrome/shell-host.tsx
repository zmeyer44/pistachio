/**
 * The shell-local state and command vocabulary shared by chrome actions.
 * Keeping controls behind this host gives buttons and configured shortcuts
 * one execution path, including commands main relays from native tab pages.
 */

import { createContext, useContext, useLayoutEffect, useMemo } from "react";
import type { ShellCommand, ShellState } from "@pistachio/shell-contracts/chrome";
import { isChatInsert } from "@pistachio/shell-contracts/chat-insert";
import { isSettingsSection } from "@pistachio/shell-contracts/settings";
import { RUN_SHORTCUT_EVENT } from "@pistachio/shell-contracts/shortcuts";
import { liveCloudThreads } from "../lib/cloud";
import { prepareBrief, useBriefStore } from "../components/reports/use-brief";
import { localDayOf } from "../lib/reports";
import { askDesk, newTabOnDesk } from "../lib/desk/open";
import { useDeskStore } from "../lib/desk/store";
import { useAppStore, type AppState } from "../store";
import { nextSplitMode } from "./split-mode";
import { nativeApi, shellApi } from "../api";

export interface ShellHost {
  state: ShellState;
  run(command: ShellCommand): void;
}

const ShellHostContext = createContext<ShellHost | null>(null);

export function useShell(): ShellHost {
  const host = useContext(ShellHostContext);
  if (host === null) throw new Error("useShell() needs a <ShellHostProvider> above it");
  return host;
}

/** The slice of the shell's store a chrome view reflects. */
export function shellStateOf(state: AppState): ShellState {
  return {
    consoleOpen: state.consoleOpen,
    evidenceOpen: state.evidence !== null,
    settingsOpen: state.overlay === "settings",
    remindersOpen: state.overlay === "reminders",
    bookmarksOpen: state.overlay === "bookmarks",
    liveViewOpen: state.overlay === "liveView",
    tabSwitcherOpen: state.tabSwitcher !== null,
    veiled:
      state.overlay === "url" ||
      state.overlay === "site" ||
      state.overlay === "watchtower" ||
      state.overlay === "site-info" ||
      state.overlay === "permission" ||
      state.overlay === "space-fork" ||
      state.overlay === "tab-switcher" ||
      state.overlay === "context-menu" ||
      state.overlay === "downloads" ||
      state.error !== null ||
      state.glance !== null,
    sidebarRevealed: sidebarRevealedOf(state, deskUp(useDeskStore.getState())),
    sidebarOnDesk: deskUp(useDeskStore.getState()),
    sidebarRail: railOf(useDeskStore.getState()),
  };
}

/** The desk's dock is the sidebar's rail (where the window's buttons would sit over it). */
function railOf(desk: { opening: string | null; groupId: string | null; rail: boolean }): boolean {
  return deskUp(desk) && desk.rail;
}

/** A tab group's desk is up, or waiting to open: the sidebar's column is its dock (layouts/SidebarLayout.tsx). */
function deskUp(desk: { opening: string | null; groupId: string | null }): boolean {
  return desk.opening !== null || desk.groupId !== null;
}

/** The compact column is out: pinned it always is; compact, while the pointer holds it out. (On a desk it is the dock: `sidebarOnDesk`.) */
function sidebarRevealedOf(state: Pick<AppState, "settings" | "sidebarRevealed">, onDesk: boolean): boolean {
  return !onDesk && (state.settings.layout.sidebar === "pinned" || state.sidebarRevealed);
}

function useStoreShellState(): ShellState {
  const consoleOpen = useAppStore((s) => s.consoleOpen);
  const evidenceOpen = useAppStore((s) => s.evidence !== null);
  const settingsOpen = useAppStore((s) => s.overlay === "settings");
  const remindersOpen = useAppStore((s) => s.overlay === "reminders");
  const bookmarksOpen = useAppStore((s) => s.overlay === "bookmarks");
  const liveViewOpen = useAppStore((s) => s.overlay === "liveView");
  const tabSwitcherOpen = useAppStore((s) => s.tabSwitcher !== null);
  const veiled = useAppStore(
    (s) =>
      s.overlay === "url" ||
      s.overlay === "site" ||
      s.overlay === "watchtower" ||
      s.overlay === "site-info" ||
      s.overlay === "permission" ||
      s.overlay === "space-fork" ||
      s.overlay === "tab-switcher" ||
      s.overlay === "context-menu" ||
      s.overlay === "downloads" ||
      s.error !== null ||
      s.glance !== null,
  );
  const sidebarOnDesk = useDeskStore(deskUp);
  const sidebarRail = useDeskStore(railOf);
  const sidebarRevealed = useAppStore((s) => sidebarRevealedOf(s, sidebarOnDesk));
  return useMemo(
    () => ({
      consoleOpen,
      evidenceOpen,
      settingsOpen,
      remindersOpen,
      bookmarksOpen,
      liveViewOpen,
      tabSwitcherOpen,
      veiled,
      sidebarRevealed,
      sidebarOnDesk,
      sidebarRail,
    }),
    [consoleOpen, evidenceOpen, settingsOpen, remindersOpen, bookmarksOpen, liveViewOpen, tabSwitcherOpen, veiled, sidebarRevealed, sidebarOnDesk, sidebarRail],
  );
}

/** Publish shell state to main and run every shell command against the store. */
export function ShellHostProvider({ children }: { children: React.ReactNode }) {
  const state = useStoreShellState();
  useLayoutEffect(() => {
    nativeApi()?.setShellState(state);
  }, [state]);
  useLayoutEffect(() => shellApi().onShellCommand(runShellCommand), []);
  const host = useMemo<ShellHost>(() => ({ state, run: runShellCommand }), [state]);
  return <ShellHostContext.Provider value={host}>{children}</ShellHostContext.Provider>;
}

/** The SHELL's implementation of every command, against the live store. */
export function runShellCommand(command: ShellCommand): void {
  const s = useAppStore.getState();
  switch (command.type) {
    case "toggleConsole":
      // On a desk, the agent is in its Bar.
      if (askDesk()) break;
      s.toggleConsole();
      break;
    case "openConsole":
      s.setConsoleOpen(true);
      break;
    case "toggleEvidence":
      if (s.evidence !== null) s.closeEvidence();
      else if (s.snapshot !== null && s.snapshot.run !== null) void s.loadEvidence();
      break;
    case "cycleSplit":
      void s.setSplit(nextSplitMode(s.snapshot?.splitMode ?? "single"));
      break;
    case "toggleSettings":
      if (s.overlay === "settings") s.closeSettings();
      else s.openSettings();
      break;
    case "openSiteControls":
      s.openSiteControls();
      break;
    case "openSpaceFork":
      s.openSpaceFork();
      break;
    case "openFind":
      void shellApi().find({ type: "search", query: "", forward: true });
      break;
    case "openSmartFind":
      void shellApi().find({ type: "mode", mode: "smart" });
      break;
    case "openSettings":
      // The section crossed a process boundary: only a section we have.
      if (isSettingsSection(command.section)) s.openSettings(command.section);
      break;
    case "closeSettings":
      s.closeSettings();
      break;
    case "openReminders":
      s.openReminders(command.occurrenceId);
      break;
    case "toggleReminders":
      s.toggleReminders();
      break;
    case "openBrief":
      s.openBrief();
      break;
    case "openNotes":
      s.openNotes(command.noteId);
      break;
    case "newNote":
      void s.newNote();
      break;
    case "prepareBrief":
      prepareBrief(command.spaceId);
      break;
    case "briefReady": {
      // The host made it; this window's store has not heard. Read it, so the home page's line and an open brief page show it.
      const spaceId = s.snapshot?.activeSpaceId;
      if (spaceId !== undefined) void useBriefStore.getState().load(spaceId, localDayOf(new Date()), { force: true });
      s.showNotice(`${command.title} is ready`, { action: { label: "Read", run: () => s.openBrief() } });
      break;
    }
    case "openWatchtower":
      if (command.view === "saved") s.openBookmarks();
      else s.openWatchtower(command.entityId);
      break;
    case "openArchive":
      s.setOverlay("archive");
      break;
    case "tidyTabs":
      void s.tidyTabs();
      break;
    case "undoTidy":
      void s.undoTidy();
      break;
    case "tidyFinished":
      s.announceTidy(command.summary);
      break;
    case "openBookmarks":
      s.openBookmarks(command.bookmarkId);
      break;
    case "toggleBookmarks":
      s.toggleBookmarks();
      break;
    case "openDownloads":
      s.openDownloads();
      break;
    case "toggleDownloads":
      s.toggleDownloads();
      break;
    case "bookmarkPage":
      void s.bookmarkTab(command.tabId);
      break;
    case "openLiveView": {
      // Named run, else the one main already holds a socket for, else the
      // newest cloud run this Mac knows about. With none of those there is
      // nothing to watch, and the command is a no-op rather than an error.
      const runId = command.runId ?? s.cloud.liveRunId ?? liveCloudThreads(s.snapshot?.threads ?? []).at(0)?.runId;
      if (runId !== undefined) void s.openLiveView(runId);
      break;
    }
    case "closeLiveView":
      void s.closeLiveView();
      break;
    case "openUrlBar":
      s.openUrlBar(command.tabId);
      break;
    case "newTab": {
      // On a desk, a new tab is a new window there, as its dock's + makes one:
      // in the desk's group, on the home page, brought out as the window in use
      // (on a loose tab's desk, in a new group of the two: lib/desk/open.ts).
      const desk = useDeskStore.getState();
      if (desk.groupId !== null && !desk.leaving) {
        void newTabOnDesk();
        break;
      }
      const general = s.settings.general;
      if (general.newTab === "url" && general.newTabUrl !== "") void s.createTab(general.newTabUrl);
      else if (general.newTab === "address") s.openNewTabBar();
      // The home page (@pistachio/shell-contracts/home) is a tab of its own:
      // its search takes the keyboard as the pane mounts.
      else void s.createTab(general.homeUrl);
      break;
    }
    case "delegate":
      if (command.tabId !== undefined && command.tabId !== s.snapshot?.activeTabId) void s.selectTab(command.tabId);
      s.setConsoleOpen(true);
      break;
    case "toggleSidebarPinned": {
      // On a desk the sidebar is its dock, pinned: ⌘S switches it between the whole sidebar and its rail.
      const desk = useDeskStore.getState();
      if (desk.groupId !== null || desk.opening !== null) {
        desk.setRail(!desk.rail);
        break;
      }
      const layout = s.settings.layout;
      // Going compact from a pinned column: it leaves the layout at once,
      // rather than staying "revealed" until the pointer happens to leave it.
      s.setSidebarRevealed(false);
      void s.updateSettings({
        layout: { sidebar: layout.sidebar === "pinned" ? "compact" : "pinned" },
      });
      break;
    }
    case "runShortcut":
      window.dispatchEvent(new CustomEvent(RUN_SHORTCUT_EVENT, { detail: { id: command.id, tabId: command.tabId } }));
      break;
    case "attachToChat":
      // Crossed a process boundary: only the shapes the composer stages.
      if (isChatInsert(command.insert)) s.receiveChatInsert(command.insert);
      break;
    case "attachToChatFailed":
      s.rejectChatInsert(command.reason);
      break;
    case "notice":
      s.showNotice(command.message, command.tone === undefined ? {} : { tone: command.tone });
      break;
  }
}
