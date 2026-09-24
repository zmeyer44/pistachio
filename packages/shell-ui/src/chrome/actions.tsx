/**
 * The action registry: every chrome BUTTON, declared once. The strip's
 * trailing cluster, the sidebar's toolbar and footer, and the keyboard
 * shortcuts all read label, icon, hint, and on-state from
 * here, so a control cannot drift between the places it appears.
 *
 * An action sees the world through an ActionContext assembled by `useAction`
 * from the shell host (state and `run`) and this renderer's store. Anything
 * that touches shell-local state goes through `ctx.run(command)` so the same
 * button works inside a chrome view; tab operations and the split mode are
 * IPC to main and call the store directly. That is also why the keyboard
 * handler (ChromeShortcuts) runs in the shell page; utility views relay
 * configured shortcuts through main.
 */

import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  AlarmClock,
  Newspaper,
  Archive,
  Bookmark,
  BookmarkPlus,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Download,
  FileClock,
  FilePlus2,
  FileText,
  GitFork,
  NotebookPen,
  Globe,
  Grid2X2,
  Link,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  PinOff,
  Plus,
  RotateCw,
  Settings,
  Sparkles,
  SplitSquareHorizontal,
  Undo2,
} from "lucide-react";
import type { ShellCommand, ShellState } from "@pistachio/shell-contracts/chrome";
import type { BrowserTabInfo, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { canReadUrl, isReaderUrl } from "@pistachio/shell-contracts/reader";
import type { DesktopSettings } from "@pistachio/shell-contracts/settings";
import {
  RUN_SHORTCUT_EVENT,
  shortcutActionForEvent,
  shortcutLabel,
  type ShortcutActionId,
  type ShortcutPlatform,
} from "@pistachio/shell-contracts/shortcuts";
import { MenuItem } from "../components/ui/menu";
import { cn } from "../lib/cn";
import { selectActiveTab, useAppStore, type AppState } from "../store";
import { useShell, type ShellHost } from "./shell-host";
import { nextSplitMode, toggledSplitMode } from "./split-mode";

export type ChromeActionId =
  | "back"
  | "forward"
  | "reload"
  | "newTab"
  | "delegate"
  | "editAddress"
  | "toggleSplit"
  | "toggleConsole"
  | "toggleEvidence"
  | "openSettings"
  | "openReminders"
  | "openBrief"
  | "openNotes"
  | "newNote"
  | "openBookmarks"
  | "openWatchtower"
  | "openArchive"
  | "tidyTabs"
  | "undoTidy"
  | "bookmarkPage"
  | "openDownloads"
  | "readerView"
  | "copyUrl"
  | "copyUrlMarkdown"
  | "forkSpace"
  | "toggleSidebarPinned"
  | "togglePin";

/**
 * The slice of the snapshot an action reads. Selected with useShallow, so a
 * button re-renders when one of THESE changes — not on every tab tick and
 * every agent step, which is what subscribing to the snapshot itself meant.
 */
export interface ActionSnapshot {
  spaces: ShellSnapshot["spaces"];
  activeSpaceId: string;
  activeTabId: string | null;
  splitMode: ShellSnapshot["splitMode"];
  sidebar: ShellSnapshot["sidebar"];
  /** A run exists (live or finished) — what "Evidence" needs to know. */
  hasRun: boolean;
}

export function actionSnapshotOf(snapshot: ShellSnapshot | null): ActionSnapshot | null {
  if (snapshot === null) return null;
  return {
    spaces: snapshot.spaces,
    activeSpaceId: snapshot.activeSpaceId,
    activeTabId: snapshot.activeTabId,
    splitMode: snapshot.splitMode,
    sidebar: snapshot.sidebar,
    hasRun: snapshot.run !== null,
  };
}

export interface ActionContext {
  /** The active tab. */
  tab: BrowserTabInfo | null;
  snapshot: ActionSnapshot | null;
  settings: DesktopSettings;
  shell: ShellState;
  /** This renderer's store — for the tab operations that are IPC anyway. */
  store: AppState;
  run(command: ShellCommand): void;
}

export interface ChromeAction {
  id: ChromeActionId;
  label(ctx: ActionContext): string;
  /** A bare lucide element: the button variant sizes it. */
  icon(ctx: ActionContext): React.ReactNode;
  /** The persisted binding shown beside this action and matched at runtime. */
  shortcutId?: ShortcutActionId;
  /** A persistent on-state (a panel this action opened is open). */
  active?(ctx: ActionContext): boolean;
  /** Absent means always. A disabled action still renders; it just does nothing. */
  enabled?(ctx: ActionContext): boolean;
  run(ctx: ActionContext): void;
  /**
   * What the key does when that differs from what the button does — the
   * same action, so hint, on-state and enablement stay single-sourced, but
   * a press can be a toggle where a click cycles. Absent means `run`.
   */
  shortcut?(ctx: ActionContext): void;
}

/** The active tab is a pin (not a favorite or a preset — those are the grid's). */
function pinnedTab(ctx: ActionContext): boolean {
  const anchorId = ctx.tab?.anchorId ?? null;
  return anchorId !== null && (ctx.snapshot?.sidebar.entries.some((e) => e.kind === "pin" && e.id === anchorId) ?? false);
}

export const CHROME_ACTIONS: Record<ChromeActionId, ChromeAction> = {
  back: {
    id: "back",
    label: () => "Back",
    icon: () => <ChevronLeft aria-hidden="true" />,
    shortcutId: "back",
    enabled: ({ tab }) => tab?.canGoBack === true,
    run: ({ tab, store }) => {
      if (tab !== null) void store.goBack(tab.id);
    },
  },
  forward: {
    id: "forward",
    label: () => "Forward",
    icon: () => <ChevronRight aria-hidden="true" />,
    shortcutId: "forward",
    enabled: ({ tab }) => tab?.canGoForward === true,
    run: ({ tab, store }) => {
      if (tab !== null) void store.goForward(tab.id);
    },
  },
  reload: {
    id: "reload",
    label: () => "Reload",
    icon: () => <RotateCw aria-hidden="true" />,
    shortcutId: "reload",
    enabled: ({ tab }) => tab !== null,
    run: ({ tab, store }) => {
      if (tab !== null) void store.reload(tab.id);
    },
  },
  readerView: {
    id: "readerView",
    label: ({ tab }) => (tab !== null && isReaderUrl(tab.url) ? "Hide reader" : "Reader view"),
    icon: () => <BookOpen aria-hidden="true" />,
    shortcutId: "readerView",
    enabled: ({ tab }) => tab !== null && canReadUrl(tab.url),
    run: ({ tab, store }) => {
      if (tab !== null) void store.toggleReaderView(tab.id);
    },
  },
  copyUrl: {
    id: "copyUrl",
    label: () => "Copy page URL",
    icon: () => <Link aria-hidden="true" />,
    shortcutId: "copyUrl",
    enabled: ({ tab }) => tab !== null && tab.url !== "",
    run: ({ tab, store }) => {
      if (tab !== null) void store.browserControl({ type: "copyUrl", format: "plain" });
    },
  },
  copyUrlMarkdown: {
    id: "copyUrlMarkdown",
    label: () => "Copy page URL as Markdown",
    icon: () => <FileText aria-hidden="true" />,
    shortcutId: "copyUrlMarkdown",
    enabled: ({ tab }) => tab !== null && tab.url !== "",
    run: ({ tab, store }) => {
      if (tab !== null) void store.browserControl({ type: "copyUrl", format: "markdown" });
    },
  },
  newTab: {
    id: "newTab",
    label: () => "New tab",
    icon: () => <Plus aria-hidden="true" />,
    shortcutId: "newTab",
    run: ({ run }) => run({ type: "newTab" }),
  },
  delegate: {
    id: "delegate",
    label: () => "Ask Pistachio",
    icon: () => <Sparkles aria-hidden="true" />,
    shortcutId: "delegate",
    run: ({ run, tab }) => run({ type: "delegate", ...(tab === null ? {} : { tabId: tab.id }) }),
  },
  editAddress: {
    id: "editAddress",
    label: () => "Edit address",
    icon: () => <Globe aria-hidden="true" />,
    shortcutId: "editAddress",
    run: ({ run, tab }) => run({ type: "openUrlBar", ...(tab === null ? {} : { tabId: tab.id }) }),
  },
  toggleSplit: {
    id: "toggleSplit",
    label: ({ snapshot }) => {
      const mode = snapshot?.splitMode ?? "single";
      return mode === "single" ? "Split view" : `Split: ${mode}`;
    },
    icon: ({ snapshot }) =>
      snapshot?.splitMode === "grid" ? (
        <Grid2X2 aria-hidden="true" />
      ) : snapshot?.splitMode === "horizontal" ? (
        <SplitSquareHorizontal aria-hidden="true" />
      ) : (
        <Columns2 aria-hidden="true" />
      ),
    shortcutId: "toggleSplit",
    active: ({ snapshot }) => (snapshot?.splitMode ?? "single") !== "single",
    // One cycle everywhere — single → vertical → horizontal → grid → single — and
    // straight to main: the split mode is the window's, not the shell page's.
    run: ({ snapshot, store }) => void store.setSplit(nextSplitMode(snapshot?.splitMode ?? "single")),
    // The key toggles (split ⇄ single) as it always has: nobody presses ⌘\
    // twice to leave a split.
    shortcut: ({ snapshot, store }) => void store.setSplit(toggledSplitMode(snapshot?.splitMode ?? "single")),
  },
  toggleConsole: {
    id: "toggleConsole",
    label: ({ shell }) => (shell.consoleOpen ? "Close agent panel" : "Open agent panel"),
    icon: ({ shell }) => (shell.consoleOpen ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />),
    shortcutId: "toggleConsole",
    active: ({ shell }) => shell.consoleOpen,
    run: ({ run }) => run({ type: "toggleConsole" }),
  },
  toggleEvidence: {
    id: "toggleEvidence",
    label: ({ shell }) => (shell.evidenceOpen ? "Close evidence" : "Evidence"),
    icon: () => <FileClock aria-hidden="true" />,
    shortcutId: "toggleEvidence",
    active: ({ shell }) => shell.evidenceOpen,
    // Nothing to replay without a run; closing is always possible.
    enabled: ({ shell, snapshot }) => shell.evidenceOpen || (snapshot !== null && snapshot.hasRun),
    run: ({ run }) => run({ type: "toggleEvidence" }),
  },
  openSettings: {
    id: "openSettings",
    label: () => "Settings",
    icon: () => <Settings aria-hidden="true" />,
    shortcutId: "openSettings",
    active: ({ shell }) => shell.settingsOpen,
    // Toggles, like ⌘, does: the row that opened Settings closes it again.
    run: ({ run }) => run({ type: "toggleSettings" }),
  },
  openReminders: {
    id: "openReminders",
    label: () => "Reminders",
    icon: () => <AlarmClock aria-hidden="true" />,
    shortcutId: "openReminders",
    active: ({ shell }) => shell.remindersOpen,
    run: ({ run }) => run({ type: "toggleReminders" }),
  },
  openBrief: {
    id: "openBrief",
    label: () => "Daily Brief",
    icon: () => <Newspaper aria-hidden="true" />,
    run: ({ run }) => run({ type: "openBrief" }),
  },
  openNotes: {
    id: "openNotes",
    label: () => "Notes",
    icon: () => <NotebookPen aria-hidden="true" />,
    shortcutId: "openNotes",
    run: ({ run }) => run({ type: "openNotes" }),
  },
  newNote: {
    id: "newNote",
    label: () => "New note",
    icon: () => <FilePlus2 aria-hidden="true" />,
    shortcutId: "newNote",
    run: ({ run }) => run({ type: "newNote" }),
  },
  openWatchtower: {
    id: "openWatchtower",
    label: ({ store }) =>
      store.watchtowerCapture === "recording"
        ? "Watchtower · saving what you read"
        : store.watchtowerCapture === "paused"
          ? "Watchtower · paused"
          : "Watchtower",
    icon: () => <FileClock aria-hidden="true" />,
    // The on-state is the capture state, not "the page is open".
    active: ({ store }) => store.watchtowerCapture === "recording",
    run: ({ run }) => run({ type: "openWatchtower" }),
  },
  openArchive: {
    id: "openArchive",
    label: () => "Archived tabs",
    icon: () => <Archive aria-hidden="true" />,
    active: ({ store }) => store.overlay === "archive",
    run: ({ run }) => run({ type: "openArchive" }),
  },
  tidyTabs: {
    id: "tidyTabs",
    label: ({ store }) => (store.tidyRunning ? "Tidying tabs…" : "Tidy tabs"),
    icon: () => <Sparkles aria-hidden="true" />,
    shortcutId: "tidyTabs",
    enabled: ({ store }) => !store.tidyRunning,
    run: ({ run }) => run({ type: "tidyTabs" }),
  },
  undoTidy: {
    id: "undoTidy",
    label: () => "Undo last tidy",
    icon: () => <Undo2 aria-hidden="true" />,
    run: ({ run }) => run({ type: "undoTidy" }),
  },
  openBookmarks: {
    id: "openBookmarks",
    label: () => "Bookmarks",
    icon: () => <Bookmark aria-hidden="true" />,
    shortcutId: "openBookmarks",
    active: ({ shell }) => shell.bookmarksOpen,
    run: ({ run }) => run({ type: "toggleBookmarks" }),
  },
  bookmarkPage: {
    id: "bookmarkPage",
    label: () => "Bookmark this page",
    icon: () => <BookmarkPlus aria-hidden="true" />,
    shortcutId: "bookmarkPage",
    // A web page of the person's own: the app's pages are chrome, not things.
    enabled: ({ tab }) => tab !== null && tab.kind === "human" && /^https?:/i.test(tab.url),
    run: ({ run, tab }) => run({ type: "bookmarkPage", ...(tab === null ? {} : { tabId: tab.id }) }),
  },
  openDownloads: {
    id: "openDownloads",
    label: () => "Downloads",
    icon: () => <Download aria-hidden="true" />,
    shortcutId: "openDownloads",
    // No on-state: the list is a popover, and its chip shows what is live.
    run: ({ run }) => run({ type: "toggleDownloads" }),
  },
  forkSpace: {
    id: "forkSpace",
    label: ({ snapshot }) => {
      const space = snapshot?.spaces.find((candidate) => candidate.id === snapshot.activeSpaceId);
      return space === undefined ? "Fork Space" : `Fork ${space.name}`;
    },
    icon: () => <GitFork aria-hidden="true" />,
    shortcutId: "forkSpace",
    enabled: ({ snapshot }) => snapshot !== null && snapshot.activeTabId !== null,
    run: ({ run }) => run({ type: "openSpaceFork" }),
  },
  toggleSidebarPinned: {
    id: "toggleSidebarPinned",
    label: ({ settings }) => (settings.layout.sidebar === "pinned" ? "Compact sidebar" : "Pin sidebar"),
    icon: ({ settings }) =>
      settings.layout.sidebar === "pinned" ? <PanelLeftClose aria-hidden="true" /> : <PanelLeftOpen aria-hidden="true" />,
    shortcutId: "toggleSidebarPinned",
    enabled: ({ settings }) => settings.layout.mode === "sidebar",
    run: ({ run }) => run({ type: "toggleSidebarPinned" }),
  },
  togglePin: {
    id: "togglePin",
    label: (ctx) => (pinnedTab(ctx) ? "Unpin tab" : "Pin tab"),
    icon: (ctx) => (pinnedTab(ctx) ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />),
    shortcutId: "togglePin",
    active: (ctx) => pinnedTab(ctx),
    // A day tab of the person's own; an agent tab is a run's, a favorite is the grid's.
    enabled: ({ tab, ...ctx }) => tab !== null && tab.kind === "human" && (tab.anchorId === null || pinnedTab({ tab, ...ctx })),
    run: ({ tab, store, ...ctx }) => {
      if (tab === null) return;
      if (pinnedTab({ tab, store, ...ctx })) void store.sidebarCommand({ type: "unpin", pinId: tab.anchorId ?? "" });
      else void store.sidebarCommand({ type: "pinTab", tabId: tab.id, folderId: null, index: 10_000 });
    },
    // The key is ⌘D, which saves a bookmark in most browsers; here it pins.
    // A button shows its result (the row moves to the shelf), a key does not,
    // so the shortcut says what it did and offers the bookmark instead — the
    // page is never quietly kept somewhere the person will not look.
    shortcut: ({ tab, store, run, ...ctx }) => {
      if (tab === null) return;
      if (pinnedTab({ tab, store, run, ...ctx })) {
        void store.sidebarCommand({ type: "unpin", pinId: tab.anchorId ?? "" });
        store.showNotice("Tab unpinned", { tone: "success" });
        return;
      }
      void store.sidebarCommand({ type: "pinTab", tabId: tab.id, folderId: null, index: 10_000 });
      const bookmarkable = tab.kind === "human" && /^https?:/i.test(tab.url);
      store.showNotice(
        ctx.settings.layout.mode === "top" ? "Pinned (see the address bar)" : "Pinned to the sidebar",
        bookmarkable
          ? {
              tone: "success",
              action: {
                label: "Bookmark instead",
                run: () => {
                  // The pin's id is main's, assigned after the command: read it fresh.
                  const state = useAppStore.getState();
                  const current = state.snapshot?.tabs.find((candidate) => candidate.id === tab.id);
                  if (current?.anchorId != null) void state.sidebarCommand({ type: "unpin", pinId: current.anchorId });
                  run({ type: "bookmarkPage", tabId: tab.id });
                },
              },
            }
          : { tone: "success" },
      );
    },
  },
};

function contextOf(state: AppState, shell: ShellState, run: (command: ShellCommand) => void): ActionContext {
  return { tab: selectActiveTab(state), snapshot: actionSnapshotOf(state.snapshot), settings: state.settings, shell, store: state, run };
}

/**
 * Run an action's SHORTCUT outside any component, against this renderer's
 * store and whichever host it runs in (chrome/shell-host.tsx). False when
 * the action is disabled right now, so the caller can leave the key event
 * alone.
 */
export function runChromeShortcut(id: ChromeActionId, host: Pick<ShellHost, "state" | "run">, tabId?: string): boolean {
  const state = useAppStore.getState();
  const base = contextOf(state, host.state, host.run);
  const ctx =
    tabId === undefined
      ? base
      : { ...base, tab: state.snapshot?.tabs.find((candidate) => candidate.id === tabId) ?? base.tab };
  const action = CHROME_ACTIONS[id];
  if (action.enabled?.(ctx) === false) return false;
  (action.shortcut ?? action.run)(ctx);
  return true;
}

function isChromeActionId(id: ShortcutActionId): id is ChromeActionId & ShortcutActionId {
  return Object.hasOwn(CHROME_ACTIONS, id);
}

/** Run every editable binding, including actions that have no chrome button. */
export function runConfiguredShortcut(
  id: ShortcutActionId,
  host: Pick<ShellHost, "state" | "run">,
  tabId?: string,
): boolean {
  if (isChromeActionId(id)) return runChromeShortcut(id, host, tabId);
  const store = useAppStore.getState();
  const tab = tabId === undefined ? selectActiveTab(store) : (store.snapshot?.tabs.find((candidate) => candidate.id === tabId) ?? null);
  switch (id) {
    case "closeTab":
      if (tab === null) return false;
      void store.closeTab(tab.id);
      return true;
    case "restoreClosedTab":
      void store.restoreClosedTab();
      return true;
    case "find":
      if (tab === null) return false;
      host.run({ type: "openFind" });
      return true;
    case "smartFind":
      if (tab === null) return false;
      host.run({ type: "openSmartFind" });
      return true;
    case "print":
      if (tab === null) return false;
      void store.browserControl({ type: "print" });
      return true;
    case "zoomIn":
      if (tab === null) return false;
      void store.browserControl({ type: "zoomIn" });
      return true;
    case "zoomOut":
      if (tab === null) return false;
      void store.browserControl({ type: "zoomOut" });
      return true;
    case "zoomReset":
      if (tab === null) return false;
      void store.browserControl({ type: "zoomReset" });
      return true;
  }
}

/**
 * Editable shortcuts, mounted once per chrome page inside its host. A binding
 * caught while a native webpage has focus is relayed back as RUN_SHORTCUT_EVENT
 * and enters through the same executor, so confirmations and enablement match.
 */
export function ChromeShortcuts() {
  const host = useShell();
  // The listeners read the host through a ref: they are installed once, not
  // re-installed on every shell-state flip (a modal opening, the console).
  const hostRef = useRef(host);
  hostRef.current = host;
  useEffect(() => {
    const platform: ShortcutPlatform = /Mac|iPhone|iPad/.test(navigator.platform) ? "darwin" : "other";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const action = shortcutActionForEvent(useAppStore.getState().settings.shortcuts, event, platform);
      if (action !== null && runConfiguredShortcut(action, hostRef.current)) event.preventDefault();
    };
    const onRelayedShortcut = (event: Event) => {
      const detail = (event as CustomEvent<{ id: ShortcutActionId; tabId?: string }>).detail;
      runConfiguredShortcut(detail.id, hostRef.current, detail.tabId);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(RUN_SHORTCUT_EVENT, onRelayedShortcut);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(RUN_SHORTCUT_EVENT, onRelayedShortcut);
    };
  }, []);
  return null;
}

export interface BoundAction {
  action: ChromeAction;
  ctx: ActionContext;
  label: string;
  icon: React.ReactNode;
  hint: string | null;
  /** The on-state, or undefined for an action that has none (Back, Reload …). */
  active: boolean | undefined;
  enabled: boolean;
  run(): void;
}

/**
 * An action bound to this renderer: presentation from the subscribed slices
 * (active tab, snapshot, settings, shell state), `run` against the live
 * store. The store is read, not subscribed — nothing an action SHOWS depends
 * on the parts of it that change per frame (content bounds, stills).
 */
export function useAction(id: ChromeActionId): BoundAction {
  const shell = useShell();
  const tab = useAppStore(selectActiveTab);
  const snapshot = useAppStore(useShallow((s) => actionSnapshotOf(s.snapshot)));
  const settings = useAppStore((s) => s.settings);
  const action = CHROME_ACTIONS[id];
  const ctx: ActionContext = { tab, snapshot, settings, shell: shell.state, store: useAppStore.getState(), run: shell.run };
  const enabled = action.enabled?.(ctx) ?? true;
  return {
    action,
    ctx,
    label: action.label(ctx),
    icon: action.icon(ctx),
    hint: action.shortcutId === undefined ? null : shortcutLabel(settings.shortcuts[action.shortcutId], /Mac|iPhone|iPad/.test(navigator.platform) ? "darwin" : "other"),
    active: action.active?.(ctx),
    enabled,
    run: () => {
      if (!enabled) return;
      action.run({ ...ctx, store: useAppStore.getState() });
    },
  };
}

/**
 * The classes of the shared 24px chrome icon button, so a control bound to
 * something other than the active tab (the pane toolbar's per-pane buttons)
 * reads exactly like the toolbar's.
 */
export function chromeIconButtonClass(state: { enabled: boolean; pressed: boolean }, className?: string): string {
  return cn(
    "no-drag grid size-6 shrink-0 place-items-center rounded-sm transition-colors [&_svg]:size-3.5",
    !state.enabled
      ? "cursor-default text-gray-600"
      : state.pressed
        ? "cursor-pointer bg-green-100 text-green-900 hover:bg-green-400"
        : "cursor-pointer text-gray-900 hover:bg-alpha-200 hover:text-gray-1000",
    className,
  );
}

/** The shared 24px button for the strip and sidebar chrome. */
export function ActionButton({
  id,
  variant,
  testId,
}: {
  id: ChromeActionId;
  variant: "strip" | "sidebar";
  testId?: string;
}) {
  const bound = useAction(id);
  const { enabled, run } = bound;
  // `aria-pressed` only where there is an on-state: its mere presence makes a
  // button a toggle to assistive tech, and Back is not one.
  const active = bound.active;
  const pressed = active === true;

  const { label, icon } = bound;
  const title = bound.hint === null ? label : `${label} (${bound.hint})`;
  return (
    <button
      type="button"
      title={title}
      aria-label={label}
      aria-pressed={active}
      aria-disabled={enabled ? undefined : true}
      data-testid={testId}
      data-variant={variant}
      onClick={run}
      className={chromeIconButtonClass({ enabled, pressed })}
    >
      {icon}
    </button>
  );
}

/**
 * The same action as a row in a menu (components/ui/menu.tsx) — the sidebar
 * footer folds its buttons into one. Label, icon, hint, on-state and
 * enablement come from the registry exactly as the button's do.
 */
export function ActionMenuItem({ id, testId }: { id: ChromeActionId; testId?: string }) {
  const { label, icon, hint, active, enabled, run } = useAction(id);
  return <MenuItem icon={icon} label={label} hint={hint} active={active === true} disabled={!enabled} testId={testId} onSelect={run} />;
}
