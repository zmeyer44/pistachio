/**
 * The shell-local state and command vocabulary shared by chrome actions.
 * Keeping controls behind this host gives buttons and configured shortcuts
 * one execution path, including commands main relays from native tab pages.
 */

import { createContext, useContext, useLayoutEffect, useMemo } from "react";
import type { ShellCommand, ShellState } from "@pistachio/shell-contracts/chrome";
import { isChatInsert } from "@pistachio/shell-contracts/chat-insert";
import { isSettingsSection, nextSidebarMode, type SidebarMode } from "@pistachio/shell-contracts/settings";
import { RUN_SHORTCUT_EVENT } from "@pistachio/shell-contracts/shortcuts";
import { liveCloudThreads } from "../lib/cloud";
import { prepareBrief, useBriefStore } from "../components/reports/use-brief";
import { localDayOf } from "../lib/reports";
import { askDesk, deskAvailable, newTabOnDesk } from "../lib/desk/open";
import {
  railOffered,
  sidebarModeOf,
  sidebarOnScreen,
  sidebarOverlays,
  useSidebarColumn,
  useSidebarMode,
  useSidebarOnScreen,
} from "../lib/sidebar-mode";
import { updatePromptShows } from "../lib/update-prompt";
import { useAppStore, type AppState } from "../store";
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
    veiled: veiledOf(state),
    sidebarRevealed: sidebarRevealedOf(state, useSidebarColumn.getState().out),
    sidebarRail: sidebarModeOf(state.settings) === "rail",
  };
}

/** A shell overlay is up over the native views (ShellState.veiled): they stay underneath it. */
export function veiledOf(state: AppState): boolean {
  return (
    state.overlay === "url" ||
    state.overlay === "site" ||
    state.overlay === "watchtower" ||
    state.overlay === "site-info" ||
    state.overlay === "permission" ||
    state.overlay === "space-fork" ||
    state.overlay === "update" ||
    state.overlay === "tab-switcher" ||
    state.overlay === "context-menu" ||
    state.overlay === "downloads" ||
    state.screenshotSelecting ||
    state.error !== null ||
    state.glance !== null
  );
}

/**
 * The column is on screen (lib/sidebar-mode.ts's sidebarOnScreen): whole or a rail, always; hidden, once brought out
 * — over the desk, once OUT (its cover clear, its slide begun), never on the intent alone. Main keys the window's
 * buttons off this (and `sidebarRail`), and arms the hidden sidebar's edge only while it is false.
 */
function sidebarRevealedOf(state: Pick<AppState, "settings" | "sidebarRevealed">, out: boolean): boolean {
  const mode = sidebarModeOf(state.settings);
  return sidebarOnScreen(mode, sidebarOverlays(mode), state.sidebarRevealed, out);
}

function useStoreShellState(): ShellState {
  const consoleOpen = useAppStore((s) => s.consoleOpen);
  const evidenceOpen = useAppStore((s) => s.evidence !== null);
  const settingsOpen = useAppStore((s) => s.overlay === "settings");
  const remindersOpen = useAppStore((s) => s.overlay === "reminders");
  const bookmarksOpen = useAppStore((s) => s.overlay === "bookmarks");
  const liveViewOpen = useAppStore((s) => s.overlay === "liveView");
  const tabSwitcherOpen = useAppStore((s) => s.tabSwitcher !== null);
  const veiled = useAppStore(veiledOf);
  // The rail is the desktop's alone: elsewhere a stored rail is drawn whole (lib/sidebar-mode.ts).
  const sidebarRail = useSidebarMode() === "rail";
  const sidebarRevealed = useSidebarOnScreen();
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
      sidebarRail,
    }),
    [consoleOpen, evidenceOpen, settingsOpen, remindersOpen, bookmarksOpen, liveViewOpen, tabSwitcherOpen, veiled, sidebarRevealed, sidebarRail],
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
      // On the desk, the agent is in its Bar (the console only before the desk's engine is up, or on the web).
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
    case "showUpdate": {
      // Asked for, the dialog does not wait on the screen as the offer does (lib/update-prompt.ts): it goes up over
      // whatever was raised, put off or not — except where it never stands, and there the update's controls are About's.
      // (On the desk too since 2026-10-09: a page over the surface, as Settings is.)
      const dialogStands = !s.onboardingOpen && s.glance === null;
      if (updatePromptShows(s.update) && dialogStands) s.openUpdatePrompt();
      else s.openSettings("about");
      break;
    }
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
    case "toggleLibrary":
      s.toggleLibrary();
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
      // On the desk (the desktop), a new tab is a new window there, as its dock's + makes one:
      // in the current space, on the home page, brought out as the window in use
      // (on a loose tab's space, a space of the two: lib/desk/open.ts). General's
      // "New tabs open" is the web's.
      if (deskAvailable()) {
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
    case "toggleSidebarPinned":
      // ⌘S: the next mode — whole → rail → hidden → whole, or whole ⇄ hidden where the rail is not offered (the web).
      setSidebarMode(nextSidebarMode(sidebarModeOf(s.settings), railOffered()));
      break;
    case "setSidebarMode":
      setSidebarMode(command.mode);
      break;
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

/**
 * The sidebar to `mode` (docs/spaces.md §3), a setting: ⌘S's next, a column's button to the next place, Settings ›
 * General. Going hidden, the column goes at once, rather than staying out until the pointer happens to leave it; any
 * other mode starts the hidden sidebar's reveal over (ChromeLayoutRoot). A rail asked for where none is offered is
 * stored as asked — the Mac that synced it keeps it — and drawn whole.
 */
function setSidebarMode(mode: SidebarMode): void {
  const s = useAppStore.getState();
  if (mode === "hidden") s.setSidebarRevealed(false);
  if (s.settings.layout.sidebar === mode) return;
  void s.updateSettings({ layout: { sidebar: mode } });
}
