/**
 * Shared contracts for the desktop chrome.
 *
 * The sidebar has three modes (settings' SidebarMode, docs/spaces.md §3):
 * whole, a rail of its icons, or hidden at the window's left edge. The
 * hidden sidebar stays in the shell page: brought out, it is the whole
 * sidebar's own column back — on the web in the shell's layout, the page
 * reflowing beside it as beside the whole one; on the desk (since
 * 2026-10-09) laid OVER the desk's windows, a cover they give way to, so no
 * page is laid out anew. The only thing hidden adds is the auto-hide
 * (layouts/SidebarLayout.tsx). Main takes two parts in it: it hears whether
 * the column is on screen (ShellState.sidebarRevealed, for the traffic
 * lights), and while it is out it WATCHES THE OS POINTER for the column
 * (PistachioApi.setSidebarWatch) — the authority on whether the pointer has
 * left, since the shell page's own leave events lie: the column is a window
 * drag region, whose native handling makes the page see the pointer leave
 * while it is still there, and the tab views above the page and the traffic
 * lights above the column take the pointer without a word. The allowance:
 * the pointer may leave the window through the column's own edge and stay
 * within SIDEBAR_POINTER_SLACK_X of it, or hover the traffic lights, and
 * the column keeps.
 *
 * The drag layer (#drag) is a transparent utility view. It holds the pointer
 * for any drag that crosses the tab views and, for a tab drag, paints only
 * the small tab ghost above the still-live pages — see drag capture below.
 * The find layer (#find) is the other utility view, positioned above a live
 * page so the native find controls remain interactive.
 *
 * This is the contract between the shell page, main, and those utility views. The
 * renderer-side manifest of chrome FEATURES (what the chrome contains, and
 * where each feature goes in the sidebar) is renderer/src/chrome/manifest.ts.
 */

import { isShortcutActionId, type ShortcutActionId } from "./shortcuts.js";
import { isChatInsert, type ChatInsert } from "./chat-insert.js";
import { isNoticeTone, NOTICE_MESSAGE_MAX, type NoticeTone } from "./notice.js";

// (Types only from settings: the shell's preload imports this module, and settings' own imports would ride in with it.)
import type { SettingsSection, SidebarMode } from "./settings.js";
import type { TidySummary } from "./tidy.js";

/**
 * The utility chrome views main hosts beside the shell window's page: the
 * drag layer, the find bar, the bookmark card that rises over the page
 * after a capture (renderer/src/BookmarkToastApp.tsx), and the notice stack
 * (./notice.ts, renderer/src/NoticeApp.tsx).
 */
export type ChromeViewId = "drag" | "find" | "bookmark" | "notice" | "notch" | "shelf" | "pip";

/** The URL hash each chrome view loads the renderer bundle with. */
export const CHROME_VIEW_HASHES: Record<ChromeViewId, `#${ChromeViewId}`> = {
  drag: "#drag",
  find: "#find",
  bookmark: "#bookmark",
  notice: "#notice",
  notch: "#notch",
  shelf: "#shelf",
  pip: "#pip",
};

export function chromeViewFromHash(hash: string): ChromeViewId | null {
  for (const id of Object.keys(CHROME_VIEW_HASHES) as ChromeViewId[]) {
    if (CHROME_VIEW_HASHES[id] === hash) return id;
  }
  return null;
}

/* ------------------------------ geometry -------------------------------- */
/**
 * The hidden sidebar's layout slot (SidebarMode "hidden"; "compact" until
 * 2026-10-09): a strip at the window's left edge that preserves the page's
 * — or the desk's — left inset while the column is away.
 */
export const SIDEBAR_EDGE_W = 10;
/**
 * The hidden sidebar's interaction target. It may extend over the page
 * without changing the hidden slot or the content card's position.
 */
export const SIDEBAR_TRIGGER_W = 14;
/**
 * The hidden sidebar's interaction target on the desk: half the strip. The
 * 14px target lay wholly over the west resize edge of a window flush with
 * the desk's leading edge, so reaching for that edge brought the column out
 * instead (2026-10-09).
 */
export const SIDEBAR_DESK_TRIGGER_W = 5;
/** The sidebar's width bounds (px), whole or brought out from hidden. The renderer persists the choice per machine. */
export const SIDEBAR_DEFAULT_W = 248;
export const SIDEBAR_MIN_W = 200;
export const SIDEBAR_MAX_W = 380;
/**
 * The sidebar as a rail (SidebarMode "rail", docs/desk.md): its icons
 * alone. A mode a person chooses since 2026-10-09 — until then the desk's
 * own, kept by the desk apart from the setting. A row's icon sits 16px in
 * (the list's padding and the row's), so a column this wide centres them.
 */
export const SIDEBAR_RAIL_W = 48;
/**
 * Clearance for the macOS traffic lights at the window's top-left
 * (BrowserWindow trafficLightPosition {x: 16, y: 15}, three 12px buttons on
 * 20px centers). The sidebar's toolbar, which occupies that corner, pads
 * its leading edge by this much, measured from the WINDOW's left edge.
 */
export const TRAFFIC_LIGHTS_W = 86;
/**
 * The buttons' vertical centre, from the WINDOW's top edge (y 15 + half of
 * 12). A toolbar sharing the titlebar centres its controls on this line so
 * they read as one row with the buttons.
 */
export const TRAFFIC_LIGHTS_CENTER_Y = 21;
/** The corner the buttons occupy: x < TRAFFIC_LIGHTS_W, y < this. */
export const TRAFFIC_LIGHTS_H = 2 * TRAFFIC_LIGHTS_CENTER_Y;
/**
 * How far past the window's edge the pointer may go, having left through
 * the hidden sidebar's own edge, before the column counts it as gone.
 * Sliding off the screen's edge is not leaving
 * the sidebar.
 */
export const SIDEBAR_POINTER_SLACK_X = 250;
/** How far off the column's box, in any direction, still counts as on it. */
export const SIDEBAR_POINTER_SLACK = 7;

/**
 * Whether a window-relative pointer is inside the hidden sidebar's reveal
 * target, `width` wide from the window's left edge (SIDEBAR_DESK_TRIGGER_W
 * on the desk).
 */
export function pointerHitsSidebarTrigger(point: { x: number; y: number }, contentHeight: number, width: number = SIDEBAR_TRIGGER_W): boolean {
  return point.x >= 0 && point.x < width && point.y >= 0 && point.y < contentHeight;
}

/**
 * Whether a pointer at `point` (window content coordinates) still holds the
 * hidden sidebar's column, brought out, at `box`: on the column (with a little slack),
 * over the traffic lights above its toolbar, or past the window's edge on
 * the column's side within the column's vertical span. Pure, so the shell
 * and main agree, and vitest pins it.
 */
export function pointerHoldsSidebar(point: { x: number; y: number }, box: { x: number; y: number; width: number; height: number }): boolean {
  const withinY = point.y >= box.y - SIDEBAR_POINTER_SLACK && point.y < box.y + box.height + SIDEBAR_POINTER_SLACK;
  if (!withinY) return false;
  if (point.x >= box.x - SIDEBAR_POINTER_SLACK_X && point.x < box.x + box.width + SIDEBAR_POINTER_SLACK) return true;
  return false;
}

/* ---------------------------- pane toolbar ------------------------------ */
/**
 * The pane toolbar (renderer/src/components/PaneToolbar.tsx): the page card
 * sits SURFACE_GUTTER px below the window's top edge,
 * and pointer movement in that gap slides the card down by the rest of a
 * toolbar row — the same TRAFFIC_LIGHTS_H row the sidebar's toolbar is, so
 * the per-pane controls (close, pin, bookmark) line up with back, forward
 * and reload. The gap is a window drag region, whose native handling keeps
 * pointer moves from the page, and the tab views take the pointer below it:
 * main watches the OS pointer for both the trigger and the hold, exactly as
 * it does for the hidden sidebar.
 */
/**
 * BrowserSurface's gutter around the page card (its Tailwind p-2). In the
 * sidebar layout the card's leading edge takes none: the column beside it
 * owns that side (ContentArea's leadingGutter).
 */
export const SURFACE_GUTTER = 8;
/** The revealed toolbar's row: the card's top edge moves down to this line. */
export const PANE_TOOLBAR_H = TRAFFIC_LIGHTS_H;
/**
 * The reveal target's height from the window's top edge. A little deeper
 * than the gutter — the last 2px sit under the native page, which main's
 * watch sees through — so a pointer that just grazes the card's edge counts.
 */
export const PANE_TOOLBAR_TRIGGER_H = SURFACE_GUTTER + 2;
/**
 * How far above the window's top edge the pointer may go — into the menu
 * bar — and still hold the toolbar. Overshooting the row is not leaving it.
 */
export const PANE_TOOLBAR_POINTER_SLACK_Y = 40;

/** Whether a window-relative pointer is inside the toolbar's reveal target (`box` spans the trigger). */
export function pointerHitsPaneToolbarTrigger(point: { x: number; y: number }, box: { x: number; y: number; width: number; height: number }): boolean {
  return point.x >= box.x && point.x < box.x + box.width && point.y >= box.y && point.y < box.y + box.height;
}

/**
 * Whether a pointer at `point` (window content coordinates) still holds the
 * revealed toolbar at `box`: on the row (with a little slack around it), or
 * above the window's top edge within the row's horizontal span. Pure, so
 * the shell and main agree, and vitest pins it.
 */
export function pointerHoldsPaneToolbar(point: { x: number; y: number }, box: { x: number; y: number; width: number; height: number }): boolean {
  const withinX = point.x >= box.x - SIDEBAR_POINTER_SLACK && point.x < box.x + box.width + SIDEBAR_POINTER_SLACK;
  if (!withinX) return false;
  return point.y >= box.y - PANE_TOOLBAR_POINTER_SLACK_Y && point.y < box.y + box.height + SIDEBAR_POINTER_SLACK;
}

/* --------------------------- drag capture ------------------------------- */

/**
 * A pane-resize drag — the split divider, the console's edge, the sidebar's —
 * starts on the shell page but travels over the tab views, which sit ABOVE it
 * and swallow every pointer move that lands on them.
 *
 * The old answer was to raise the chrome for the drag, which hides the tab
 * views and leaves a captured still of each page in their place: the pages
 * then appeared to STRETCH with the panes, snapping to the new size only when
 * the drag ended. The answer now is the drag layer — a transparent
 * WebContentsView over the whole window (main/chrome-view.ts, id "drag") that
 * holds the pointer for the gesture and relays each sample back to the shell.
 * The tab views stay visible and main tracks them to the panes every frame,
 * so the pages reflow under the handle instead of after it.
 *
 * Coordinates are the window's content box, which is also the shell page's
 * viewport and the drag layer's: clientX/clientY mean the same thing in both.
 */

/** The cursor the drag layer paints while it holds the pointer. */
export type DragCursor =
  | "col-resize"
  | "row-resize"
  | "grabbing"
  // A desk window's edges and corners (@pistachio/shell-contracts/desk).
  | "ew-resize"
  | "ns-resize"
  | "nwse-resize"
  | "nesw-resize";

const DRAG_CURSORS: readonly string[] = ["col-resize", "row-resize", "grabbing", "ew-resize", "ns-resize", "nwse-resize", "nesw-resize"];

export function isDragCursor(value: unknown): value is DragCursor {
  return typeof value === "string" && DRAG_CURSORS.includes(value);
}

/**
 * The tab ghost drawn by the drag layer while the live page panes reflow
 * below it. The shell hands the dragged element over to the layer as soon as
 * its box would leave the chrome that holds it — the sidebar column clips at
 * its edge and the page views paint over anything past it, so a row lifted
 * toward the page would otherwise be cut off at the column until the POINTER
 * reached the page. The layer draws the ghost at the pointer minus the grab
 * point, under `clamp`, from every sample it sees.
 */
export interface TabDragVisual {
  x: number;
  y: number;
  grabX: number;
  grabY: number;
  width: number;
  height: number;
  title: string;
  url: string;
  faviconUrl: string | null;
  zone: "left" | "right" | "top" | "bottom" | null;
  /**
   * Limits on the ghost's top-left corner, viewport px — the same ones the
   * shell puts on the source element (a sidebar row never moves left of its
   * slot). The layer applies
   * them to each pointer sample it predicts from, so its prediction and the
   * shell's next update agree.
   */
  clamp?: TabDragClamp;
}

export interface TabDragClamp {
  minLeft?: number;
  maxLeft?: number;
  minTop?: number;
  maxTop?: number;
}

/** `value` held to `[min, max]`, either side optional. */
export function clampTo(value: number, min: number | undefined, max: number | undefined): number {
  const floored = min === undefined ? value : Math.max(min, value);
  return max === undefined ? floored : Math.min(max, floored);
}

function isTabDragClamp(value: unknown): value is TabDragClamp {
  if (typeof value !== "object" || value === null) return false;
  const clamp = value as Record<string, unknown>;
  return (["minLeft", "maxLeft", "minTop", "maxTop"] as const).every(
    (key) => clamp[key] === undefined || (typeof clamp[key] === "number" && Number.isFinite(clamp[key])),
  );
}

export function isTabDragVisual(value: unknown): value is TabDragVisual {
  if (typeof value !== "object" || value === null) return false;
  const visual = value as Record<string, unknown>;
  const finite = (key: string): boolean => typeof visual[key] === "number" && Number.isFinite(visual[key]);
  const zone = visual["zone"];
  return (
    finite("x") &&
    finite("y") &&
    finite("grabX") &&
    finite("grabY") &&
    finite("width") &&
    finite("height") &&
    typeof visual["title"] === "string" &&
    typeof visual["url"] === "string" &&
    (visual["faviconUrl"] === null || typeof visual["faviconUrl"] === "string") &&
    (zone === null || zone === "left" || zone === "right" || zone === "top" || zone === "bottom") &&
    (visual["clamp"] === undefined || isTabDragClamp(visual["clamp"]))
  );
}

/** One pointer sample the drag layer relays to the shell. */
export interface DragSample {
  x: number;
  y: number;
  /** "up" ends the gesture; so does "cancel" (a lost pointer, a blurred window). */
  phase: "move" | "up" | "cancel";
  /**
   * Whether Shift was down, when the source knows: a pointer event says, but
   * main's relay of a grabbed desk press does not (Electron's mouse hook
   * carries no modifiers), and then it is left out.
   */
  shift?: boolean;
}

export function isDragSample(value: unknown): value is DragSample {
  if (typeof value !== "object" || value === null) return false;
  const sample = value as Record<string, unknown>;
  return (
    typeof sample["x"] === "number" &&
    Number.isFinite(sample["x"]) &&
    typeof sample["y"] === "number" &&
    Number.isFinite(sample["y"]) &&
    (sample["phase"] === "move" || sample["phase"] === "up" || sample["phase"] === "cancel") &&
    (sample["shift"] === undefined || typeof sample["shift"] === "boolean")
  );
}

/* ------------------------------ state ----------------------------------- */

/** Shell-owned UI state main needs for native chrome and window controls. */
export interface ShellState {
  /** The agent console (the right-hand delegation panel) is open. */
  consoleOpen: boolean;
  evidenceOpen: boolean;
  settingsOpen: boolean;
  /** A shell overlay is up: native utility views must stay underneath it. */
  veiled: boolean;
  /**
   * The sidebar's column is ON SCREEN: always while it is whole or a rail;
   * while it is hidden, only brought out — and on the desk only once its
   * cover is up and its slide has begun (docs/spaces.md §3), so the buttons
   * never show over a window's live page before the column is there. Main
   * keys the macOS traffic lights off it: they sit in the sidebar's
   * toolbar, so they hide with the column. (Until 2026-10-09: the compact
   * sidebar's column was in the layout; always true when pinned.)
   */
  sidebarRevealed: boolean;
  /**
   * The sidebar is the narrow rail (SidebarMode "rail"): the window's
   * buttons, which would hang over the desk's corner, are hidden at once
   * (the whole sidebar has room for them in its toolbar). Always false
   * without a desk.
   */
  sidebarRail: boolean;
  /** The reminders page (pistachio://reminders) is over the content hole. */
  remindersOpen: boolean;
  /** The bookmarks page (pistachio://bookmarks) is over the content hole. */
  bookmarksOpen: boolean;
  /**
   * A cloud run's live view is over the content hole
   * (docs/cloud-sync-design.md §8.5). Like the pages above it, it is drawn
   * by the shell into the browser surface, so main only needs to know it is
   * there — the raise itself is the overlay reporting's.
   */
  liveViewOpen: boolean;
  /**
   * The shell is running a tab switcher session — shown, or about to be.
   * When it ends, main forgets the gesture and gives the keyboard back to
   * the page the person chose (@pistachio/shell-contracts/tab-switcher).
   */
  tabSwitcherOpen: boolean;
}

export const DEFAULT_SHELL_STATE: ShellState = {
  consoleOpen: false,
  evidenceOpen: false,
  settingsOpen: false,
  remindersOpen: false,
  bookmarksOpen: false,
  liveViewOpen: false,
  tabSwitcherOpen: false,
  veiled: false,
  sidebarRevealed: false,
  sidebarRail: false,
};

export function isShellState(value: unknown): value is ShellState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    [
      "consoleOpen",
      "evidenceOpen",
      "settingsOpen",
      "veiled",
      "sidebarRevealed",
      "sidebarRail",
      "remindersOpen",
      "bookmarksOpen",
      "liveViewOpen",
      "tabSwitcherOpen",
    ] as const
  ).every((key) => typeof state[key] === "boolean");
}

/* ----------------------------- commands --------------------------------- */

/**
 * Commands against shell-local UI state. Chrome actions use this vocabulary
 * in the shell, and main relays the same commands when a native page or
 * utility view catches a configured shortcut.
 */
export type ShellCommand =
  | { type: "toggleConsole" }
  | { type: "openConsole" }
  | { type: "toggleEvidence" }
  | { type: "cycleSplit" }
  | { type: "toggleSettings" }
  | { type: "openSiteControls" }
  | { type: "openSpaceFork" }
  | { type: "openFind" }
  | { type: "openSmartFind" }
  | { type: "openSettings"; section: SettingsSection }
  /** Lower the settings page — main opened a tab the person must see. */
  | { type: "closeSettings" }
  /**
   * The update's notification was clicked: the update dialog, asked for, so
   * even while it is put off — or About in Settings where the dialog does not
   * go up (a Glance, the desk, the first-run wizard).
   */
  | { type: "showUpdate" }
  /** The reminders page, optionally landing on one occurrence. */
  | { type: "openReminders"; occurrenceId?: string }
  | { type: "toggleReminders" }
  /** Today's daily brief (docs/reports.md): the tab showing it, or a new one. */
  | { type: "openBrief" }
  /** The morning schedule asks the shell to make today's brief: only the shell has the to-dos. */
  | { type: "prepareBrief"; spaceId: string }
  /** A scheduled brief is ready and the window is in front: say so in the app. */
  | { type: "briefReady"; title: string }
  /** The bookmarks page, optionally landing on one bookmark. */
  | { type: "openBookmarks"; bookmarkId?: string }
  /** The notes library (docs/notes.md §4), or one note's page. */
  | { type: "openNotes"; noteId?: string }
  /** Write a new note and open it: what ⌘⌥N does. */
  | { type: "newNote" }
  | { type: "toggleBookmarks" }
  /**
   * Watchtower, optionally landing on one index entry (a save's card names
   * what the page was filed under) or on the Saved view.
   */
  | { type: "openWatchtower"; entityId?: number; view?: "saved" }
  /** The archive of tabs Tidy put away and groups that were closed (docs/tab-tidy.md §3.6). */
  | { type: "openArchive" }
  /** Everything kept, in one place: artifacts, notes, saved pages and what Watchtower read. */
  | { type: "toggleLibrary" }
  /** Run Tidy now for the active Space, and say what it did (§3.2). */
  | { type: "tidyTabs" }
  /** Take the last Tidy run back. */
  | { type: "undoTidy" }
  /**
   * Main finished a Tidy run on its own clock. The shell says so in a notice
   * that carries Undo — an action, which a plain `notice` cannot (§3.1).
   */
  | { type: "tidyFinished"; summary: TidySummary }
  /** The downloads list (components/DownloadsPopover.tsx), a popover under its chip. */
  | { type: "openDownloads" }
  | { type: "toggleDownloads" }
  /**
   * The live view of a cloud run (§8.5). Without a run id it opens the one
   * main already has a socket for, so a shortcut can bring back a live view
   * that was closed by accident.
   */
  | { type: "openLiveView"; runId?: string }
  | { type: "closeLiveView" }
  /** Save a tab's page (the active one when omitted): what the double tap of shift does. */
  | { type: "bookmarkPage"; tabId?: string }
  /** Edit a tab's address in the address modal; the active tab when omitted. */
  | { type: "openUrlBar"; tabId?: string }
  /** What ⌘T does: the configured page, or the address modal composing a new tab. */
  | { type: "newTab" }
  /** Hand a tab (the active one when omitted) to the console as the delegation context. */
  | { type: "delegate"; tabId?: string }
  /**
   * ⌘S: the sidebar's next mode (nextSidebarMode): whole → rail → hidden → whole, or whole ⇄ hidden where the rail
   * is not offered. The name is the shortcut's id, kept: it is a key in everyone's saved shortcuts.
   */
  | { type: "toggleSidebarPinned" }
  /** A mode chosen outright — a column's button to the next place, Settings › General. */
  | { type: "setSidebarMode"; mode: SidebarMode }
  /** A binding caught in a native webpage view and relayed to the shell. */
  | { type: "runShortcut"; id: ShortcutActionId; tabId?: string }
  /**
   * A brief word in the notice stack (./notice.ts) about something main
   * just did with no visible result of its own — "URL copied" after ⌘⇧C.
   */
  | { type: "notice"; message: string; tone?: NoticeTone }
  /** Stage an image or selected words from a page in the console's composer. */
  | { type: "attachToChat"; insert: ChatInsert }
  /** The page's menu offered it, but the image could not be read. */
  | { type: "attachToChatFailed"; reason: string };

export function isShellCommand(value: unknown): value is ShellCommand {
  if (typeof value !== "object" || value === null) return false;
  const { type } = value as { type?: unknown };
  const optionalTabId = (): boolean => {
    const tabId = (value as { tabId?: unknown }).tabId;
    return tabId === undefined || (typeof tabId === "string" && tabId.length > 0 && tabId.length <= 128);
  };
  switch (type) {
    case "toggleConsole":
    case "openConsole":
    case "toggleEvidence":
    case "cycleSplit":
    case "toggleSettings":
    case "openSiteControls":
    case "openSpaceFork":
    case "openFind":
    case "openSmartFind":
    case "newTab":
    case "toggleSidebarPinned":
    case "toggleReminders":
    case "openBrief":
    case "openArchive":
    case "toggleLibrary":
    case "tidyTabs":
    case "undoTidy":
    case "toggleBookmarks":
    case "newNote":
    case "openDownloads":
    case "toggleDownloads":
    case "closeLiveView":
    case "showUpdate":
      return true;
    case "openLiveView": {
      const runId = (value as { runId?: unknown }).runId;
      return runId === undefined || (typeof runId === "string" && runId.length > 0 && runId.length <= 128);
    }
    case "openReminders": {
      const occurrenceId = (value as { occurrenceId?: unknown }).occurrenceId;
      return occurrenceId === undefined || (typeof occurrenceId === "string" && occurrenceId.length > 0 && occurrenceId.length <= 128);
    }
    case "openBookmarks": {
      const bookmarkId = (value as { bookmarkId?: unknown }).bookmarkId;
      return bookmarkId === undefined || (typeof bookmarkId === "string" && bookmarkId.length > 0 && bookmarkId.length <= 128);
    }
    case "openWatchtower": {
      const { entityId, view } = value as { entityId?: unknown; view?: unknown };
      return (entityId === undefined || (typeof entityId === "number" && Number.isSafeInteger(entityId) && entityId > 0)) && (view === undefined || view === "saved");
    }
    case "setSidebarMode": {
      // (Compared, not imported: settings.ts at runtime would ride into the shell's preload with all it imports.)
      const mode = (value as { mode?: unknown }).mode;
      return mode === "whole" || mode === "rail" || mode === "hidden";
    }
    case "openNotes": {
      const noteId = (value as { noteId?: unknown }).noteId;
      return noteId === undefined || (typeof noteId === "string" && noteId.length > 0 && noteId.length <= 128);
    }
    case "runShortcut":
      return isShortcutActionId((value as { id?: unknown }).id) && optionalTabId();
    case "openUrlBar":
    case "delegate":
    case "bookmarkPage":
      return optionalTabId();
    case "openSettings": {
      const section = (value as { section?: unknown }).section;
      return typeof section === "string" && section.length <= 128;
    }
    case "attachToChat":
      return isChatInsert((value as { insert?: unknown }).insert);
    case "attachToChatFailed": {
      const reason = (value as { reason?: unknown }).reason;
      return typeof reason === "string" && reason.length > 0 && reason.length <= 256;
    }
    case "prepareBrief": {
      const spaceId = (value as { spaceId?: unknown }).spaceId;
      return typeof spaceId === "string" && spaceId.length > 0 && spaceId.length <= 120;
    }
    case "briefReady": {
      const title = (value as { title?: unknown }).title;
      return typeof title === "string" && title.length > 0 && title.length <= 80;
    }
    case "tidyFinished": {
      const summary = (value as { summary?: unknown }).summary;
      if (typeof summary !== "object" || summary === null) return false;
      const raw = summary as Record<string, unknown>;
      return (
        typeof raw["runId"] === "string" &&
        typeof raw["spaceId"] === "string" &&
        (raw["trigger"] === "auto" || raw["trigger"] === "manual") &&
        ["archivedTabs", "newGroups", "joinedTabs", "favoritesReset"].every(
          (key) => typeof raw[key] === "number" && Number.isInteger(raw[key]) && (raw[key] as number) >= 0,
        ) &&
        (raw["favoriteGroups"] === undefined || (typeof raw["favoriteGroups"] === "number" && Number.isInteger(raw["favoriteGroups"]) && raw["favoriteGroups"] >= 0)) &&
        typeof raw["usedModel"] === "boolean" &&
        typeof raw["firstRun"] === "boolean"
      );
    }
    case "notice": {
      const { message, tone } = value as { message?: unknown; tone?: unknown };
      return (
        typeof message === "string" &&
        message.length > 0 &&
        message.length <= NOTICE_MESSAGE_MAX &&
        (tone === undefined || isNoticeTone(tone))
      );
    }
    default:
      return false;
  }
}
