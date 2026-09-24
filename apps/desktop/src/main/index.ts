import { applyDesktopIcon, desktopIconPath } from "./desktop-icon";
import { DEFAULT_WATCHTOWER_SETTINGS, WATCHTOWER_URL } from "@pistachio/shell-contracts/watchtower";
import { join, resolve, relative, isAbsolute } from "node:path";
import { hostname } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  Notification,
  powerMonitor,
  protocol,
  screen,
  session,
  systemPreferences,
} from "electron";
import {
  NotificationRouter,
  type NotificationAdapter,
} from "@pistachio/notifications";
import { isIntegrationAccess, isIntegrationProvider, type AgentAttachment } from "@pistachio/protocol";
import { BrowserController, isLoadFailure } from "./browser-controller";
import { detectBrowsers, importBrowserProfile } from "./browser-import";
import { extractIntake, transcribeIntroduction } from "./onboarding";
import { setWelcomeContext, welcomePageResponse } from "./welcome-pages";
import {
  ArtifactStore,
  artifactResponse,
  setArtifactStore,
} from "./artifact-store";
import { NoteStore } from "./note-store";
import { ThreadStore } from "./thread-store";
import { VaultService } from "./account/vault-service";
import { IntegrationService } from "./account/integration-service";
import { ChromeOverlayView } from "./chrome-view";
import { NoticeLayer } from "./notice-layer";
import { PointerZoneWatch } from "./pointer-zone-watch";
import { submitFeedback } from "./feedback";
import {
  demoAuthRelyingPartyHtml,
  demoOAuthCallbackHtml,
  demoOAuthHtml,
  demoPortalHtml,
  demoToneWav,
  demoVendorHtml,
} from "./demo-page";
import { UpdateService } from "./update-service";
import { ReadAloudService } from "./read-aloud";
import { WatchtowerService } from "./watchtower/service";
import { watchtowerRequestSchema } from "@pistachio/shell-contracts/watchtower";
import { ReaderStore } from "./reader-store";
import { RunController } from "./run-controller";
import { createMemoryEmbedder } from "./memory-engine";
import { aiProviderStatus, configuredBriefModel, configuredIntentModel, configuredTidyModel, setAiSession } from "./model-provider";
import type { ReportRecord } from "@pistachio/reports/contract";
import { BriefScheduler } from "./brief-scheduler";
import { BriefService, scriptedBriefMaterials } from "./brief-service";
import { TabArchiveStore } from "./tab-archive-store";
import { scriptedGroupNamer, scriptedTidyJudge, TabTidy } from "./tab-tidy";
import { judgeTidy, nameTabGroup } from "@pistachio/agent-runtime/tab-tidy";
import { archiveEntryView, isTabArchiveRequest, type TabArchiveResponse } from "@pistachio/shell-contracts/tab-archive";
import { isTabGroupCommand, type TabGroupCommandResult } from "@pistachio/shell-contracts/tab-groups";
import { isTidyRequest, type TidyResponse } from "@pistachio/shell-contracts/tidy";
import { AddressIntentRanker, scriptedIntentModel } from "./address-intent";
import { scriptedFindModelFromEnv } from "@pistachio/smart-find/scripted";
import { MemoryStore } from "./memory-store";
import { ReminderScheduler, type ReminderExecutor } from "./reminder-scheduler";
import { ReminderStore } from "./reminder-store";
import { BookmarkStore } from "./bookmark-store";
import { BookmarkService } from "./bookmarks";
import { SettingsStore } from "./settings-store";
import { BrowserPolicyStore } from "./browser-policy-store";
import { SidebarController } from "@pistachio/shell-contracts/sidebar-controller";
import { SidebarStore } from "./sidebar-store";
import { SpaceStore } from "./space-store";
import { TabSessionStore } from "./tab-session-store";
import { DeviceStore } from "./account/device-store";
import { AuthService } from "./account/auth-service";
import {
  resolveControlUrl,
  resolveWebUrl,
  type ControlClient,
  type ControlHostedNote,
  type ControlNoteShare,
} from "./account/control-client";
import { EgressService } from "./egress/egress-service";
import { spacesFileHasIdentitySpace } from "./egress/egress-state";
import { featureHandlers, installFeatureHandlers } from "./feature-handlers";
import { WorkspaceRecords } from "./sync/records";
import { SyncService } from "./sync/service";
import { CloudRunService } from "./cloud/cloud-run-service";
import { LiveViewClient } from "./cloud/live-view-client";
import { createChannelsFeature } from "./cloud/channels";
import {
  DEFAULT_SHELL_STATE,
  isShellState,
  isDragCursor,
  isDragSample,
  isTabDragVisual,
  type ChromeViewId,
  type DragCursor,
  type ShellCommand,
  type ShellState,
  pointerHitsPaneToolbarTrigger,
  pointerHitsSidebarTrigger,
  pointerHoldsPaneToolbar,
  pointerHoldsSidebar,
} from "@pistachio/shell-contracts/chrome";
import { EMPTY_NOTICE_STACK, isNoticeEvent, isNoticeFrame } from "@pistachio/shell-contracts/notice";
import { agentDrivenTabId } from "@pistachio/shell-contracts/agent-glow";
import {
  IPC,
  type AccountState,
  type AppInfo,
  type BrowserLayout,
  type ChannelCreateRequest,
  type CloudFrame,
  type CloudLiveInput,
  type CloudStartRunRequest,
  type CloudStatus,
  type ContentBounds,
  type CursorPoint,
  type DeviceInfo,
  type EgressStatus,
  type FeedbackOutcome,
  type GlanceIntentRequest,
  type GlanceOpenRequest,
  type GlanceState,
  type MediaPreviewPlacement,
  type ShellGlanceOpenRequest,
  type ShellLaunchState,
  type SplitMode,
  type SplitSide,
  type SyncOriginOverride,
  type SyncStatus,
  type TabSwitcherInput,
  type VaultEntryDraft,
  type WorkspaceSyncAction,
  type WorkspaceSyncStatus,
} from "@pistachio/shell-contracts/ipc";
import {
  MAX_FAVORITES,
  favoriteOf,
  isPresetAnchorId,
  presetAnchorId,
  type SidebarFavorite,
} from "@pistachio/shell-contracts/sidebar";
import {
  sanitizeBrowserImportRequests,
  type BrowserImportResult,
} from "@pistachio/shell-contracts/browser-import";
import {
  favoriteApp,
  MAX_INTRO_AUDIO_BYTES,
  MAX_INTRO_TRANSCRIPT,
  sanitizeOnboardingCompletion,
  WELCOME_TABS,
  type OnboardingCompletion,
} from "@pistachio/shell-contracts/onboarding";
import {
  factKey,
  MAX_MEMORY_REASON,
  PROFILE_KEY,
  sanitizeMemoryAddInput,
  sanitizeMemoryUpdateInput,
  type MemorySource,
} from "@pistachio/shell-contracts/memory";
import {
  isRemindersUrl,
  REMINDERS_URL,
  sanitizeReminderInput,
  sanitizeReminderPatch,
  type ReminderOccurrence,
  type ReminderSource,
} from "@pistachio/shell-contracts/reminders";
import {
  isBookmarksUrl,
  sanitizeBookmarkInput,
  sanitizeBookmarkPatch,
  type BookmarkToast,
} from "@pistachio/shell-contracts/bookmarks";
import {
  isNoteBlobId,
  isNoteId,
  MAX_NOTE_TITLE,
  NOTE_BLOB_MEDIA_TYPES,
  NOTES_PAGE_TITLE,
  type NoteBlobMediaType,
  type NoteHosting,
  type NoteInput,
  type NotePatch,
  type NoteRequest,
  type NoteResponse,
  type NoteSource,
} from "@pistachio/shell-contracts/notes";
import { isShellPageUrl } from "@pistachio/shell-contracts/shell-pages";
import { renderNoteHtml } from "@pistachio/notes";
import { DoubleTap } from "@pistachio/shell-contracts/double-shift";
import type { DesktopSettings } from "@pistachio/shell-contracts/settings";
import {
  shortcutAccelerator,
  shortcutActionForEvent,
  type ShortcutPlatform,
} from "@pistachio/shell-contracts/shortcuts";
import {
  isMediaControl,
  type BrowserMediaInfo,
  type ReadAloudStatus,
} from "@pistachio/shell-contracts/media";
import { isSidebarCommand } from "@pistachio/shell-contracts/sidebar";
import {
  isSpaceEgressPolicy,
  sanitizeForkSpaceRequest,
  spacePartition,
} from "@pistachio/shell-contracts/spaces";
import {
  FIND_BAR,
  FIND_BAR_ROOM,
  isBrowserControlCommand,
  isFindCommand,
  isGuardedBrowserAction,
  type BrowserControlsSnapshot,
  type BrowserDownload,
  type FindState,
} from "@pistachio/shell-contracts/browser-controls";

protocol.registerSchemesAsPrivileged([
  { scheme: "pistachio-app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  {
    scheme: "pistachio",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const currentDir = fileURLToPath(new URL(".", import.meta.url));
let shellWindow: BrowserWindow | null = null;
let updates: UpdateService | null = null;
let browser: BrowserController | null = null;
let runs: RunController | null = null;
let settings: SettingsStore | null = null;
let memory: MemoryStore | null = null;
/** Every write from the settings page is the person's own word. */
const USER_MEMORY_SOURCE: MemorySource = { kind: "user", runId: null };
let reminders: ReminderStore | null = null;
let reminderScheduler: ReminderScheduler | null = null;
let artifacts: ArtifactStore | null = null;
/** The person's own writing (docs/notes.md §3); local on a signed-out Mac, synced on an enrolled one. */
let notes: NoteStore | null = null;
/** Every write from the notes page is the person's own; the agent's carry its run. */
const USER_NOTE_SOURCE: NoteSource = { kind: "user", runId: null };
/**
 * How long a published note's edits settle before the public copy is
 * refreshed (docs/notes.md §8). The editor saves every 600 ms of quiet, so
 * without this a person typing a paragraph would publish it a dozen times.
 */
const NOTE_PUBLISH_DEBOUNCE_MS = 2_000;
/**
 * How often a shared note is read back from control (docs/notes.md §9), on
 * top of a read whenever the window is focused. An editor writing on the web
 * has nowhere to push to but control; this is how their writing gets into
 * the sealed note, and from there onto the person's other devices.
 */
const SHARED_NOTE_POLL_MS = 30_000;
/**
 * What this Mac believes about each note it owns: whether anyone has been
 * named on it, and what control last agreed its shared body was (§9).
 *
 * The mirror is what keeps the two from chasing each other. Applying a
 * pulled revision is a local write, which bumps the note past what control
 * holds, which has to be pushed back or the next poll pulls the same thing
 * again — so a push is sent when the note has moved past the mirror, and
 * skipped when it has not.
 */
const noteSharing = new Map<
  string,
  { shared: boolean; mirror: { title: string; markdown: string; revision: number } | null }
>();
/** Note ids a refused push is already reading back; one pass, not a chain. */
const reconciling = new Set<string>();
/** Long after startup has settled, then twice a day: collecting pictures is never urgent. */
const NOTE_BLOB_SWEEP_DELAY_MS = 30_000;
const NOTE_BLOB_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1_000;
let threads: ThreadStore | null = null;
/** Every write from the reminders page is the person's own. */
const USER_REMINDER_SOURCE: ReminderSource = { kind: "user", runId: null };
let bookmarks: BookmarkStore | null = null;
let bookmarkService: BookmarkService | null = null;
/**
 * The bookmark card above the page (@pistachio/shell-contracts/chrome, view "bookmark"): a
 * utility view like the find bar, since the tab views sit above the shell
 * page and a card drawn there would be invisible. Sized to what the card
 * reports (IPC.bookmarkToastResize) and parked at the active pane's
 * bottom-right corner.
 */
let bookmarkLayer: ChromeOverlayView | null = null;
/**
 * The notice stack above the page (@pistachio/shell-contracts/notice, view
 * "notice"): the shell's brief words, drawn where a hidden sidebar or a
 * fullscreen page cannot take them away.
 */
let noticeLayer: NoticeLayer | null = null;
let bookmarkToastHeight = 104;
const BOOKMARK_TOAST_WIDTH = 400;
const BOOKMARK_TOAST_MARGIN = 4;
/**
 * The double tap of shift that saves the page. One detector for every
 * view: only one has the keyboard at a time, and a tap that lands in the
 * page and a tap that lands in the chrome are the same gesture.
 */
const doubleShift = new DoubleTap("Shift");
let sidebar: SidebarStore | null = null;
/** Tabs Tidy put away and groups that were closed (docs/tab-tidy.md §3.6). */
let tabArchive: TabArchiveStore | null = null;
/** The Tidy pass over the window's tabs; it goes with the window, as the controller does. */
let tabTidy: TabTidy<Awaited<ReturnType<BrowserController["resetFavoriteTabs"]>>[number]> | null = null;
let sidebarController: SidebarController | null = null;
let spaces: SpaceStore | null = null;
let tabSessions: TabSessionStore | null = null;
let touchIdConfigured = false;
/**
 * Everything in docs/cloud-sync-design.md is off under Playwright (D22):
 * no account.json, no control, no hub, no gateway, no proxy.
 */
const featureEnabled = process.env["PISTACHIO_E2E"] !== "1";
let deviceStore: DeviceStore | null = null;
let auth: AuthService | null = null;
let egress: EgressService | null = null;
/** Cookie + workspace sync (main/sync), the cloud run observer and live view (main/cloud); null under E2E. */
let syncService: SyncService | null = null;
let cloudRuns: CloudRunService | null = null;
/** Dedicated integrations (D29): the consent flow and the sealed grants; null under E2E. */
let integrationService: IntegrationService | null = null;
let briefScheduler: BriefScheduler | null = null;
/** Held until clicked or closed: a Notification that is collected never delivers its click. */
const briefNotifications = new Set<Notification>();
const readAloud = new ReadAloudService();
const reader = new ReaderStore();
let watchtower: WatchtowerService | null = null;

/**
 * Where an artifact link points. The web app renders an artifact out of the
 * signed-in account's sync session, so an unenrolled Mac gets null and links
 * to its own `pistachio://artifact/<id>` copy instead of a page that cannot
 * show its build. The origin itself follows PISTACHIO_WEB_URL/packaging —
 * never a hardcoded production host, so a dev or self-hosted control links
 * to the web app that belongs to it.
 */
function artifactWebOrigin(): string | null {
  return auth?.enrolled() === true ? resolveWebUrl(process.env, app.isPackaged) : null;
}

/** AppKit's behind-window material: it samples and blurs the real desktop. */
const DESKTOP_GLASS_MATERIAL = "under-window" as const;

/** The compact column's CSS retreat; its native traffic lights leave after it lands. */
const SIDEBAR_CLOSE_MS = 180;
const cursorWatchDisabled = process.env["PISTACHIO_E2E"] === "1";

/**
 * The compact sidebar's pointer watch (@pistachio/shell-contracts/chrome, "the compact
 * sidebar"). The shell says where its column is; this polls the OS pointer
 * and tells the shell once the pointer no longer holds the column — the one
 * reading the drag region, the tab views, and the traffic lights cannot
 * fake. While the column is hidden it watches the reveal target instead.
 */
class SidebarWatch {
  readonly #window: BrowserWindow;
  readonly #zone: PointerZoneWatch;
  #entryEnabled = false;

  constructor(window: BrowserWindow) {
    this.#window = window;
    this.#zone = new PointerZoneWatch(
      window,
      { entered: IPC.sidebarPointerEntered, left: IPC.sidebarPointerLeft },
      () => cursorPoint(window),
      { enabled: !cursorWatchDisabled },
    );
  }

  set(box: ContentBounds | null): void {
    if (box !== null) {
      // The column is up: the reveal target has done its work.
      this.#entryEnabled = false;
      this.#zone.setEntry(null);
    }
    this.#zone.setHold(box === null ? null : (point) => pointerHoldsSidebar(point, box));
  }

  /** Watch the hidden sidebar's wider target without changing shell layout. */
  setEntryEnabled(enabled: boolean): void {
    if (enabled === this.#entryEnabled) return;
    this.#entryEnabled = enabled;
    // A hidden column must not retain the revealed column's old leave box.
    if (enabled) this.#zone.setHold(null);
    this.#zone.setEntry(
      enabled
        ? (point) => pointerHitsSidebarTrigger(point, this.#window.getContentBounds().height)
        : null,
    );
  }

  dispose(): void {
    this.#entryEnabled = false;
    this.#zone.dispose();
  }
}

/**
 * The pane toolbar's pointer watch (@pistachio/shell-contracts/chrome, "pane toolbar"). The
 * shell names both boxes — the reveal target in the gap above the page card,
 * and the revealed row — since both are its layout; this only reads the
 * pointer against them, which the drag region and the tab views keep from
 * the shell.
 */
class PaneToolbarWatch {
  readonly #zone: PointerZoneWatch;

  constructor(window: BrowserWindow) {
    this.#zone = new PointerZoneWatch(
      window,
      { entered: IPC.paneToolbarPointerEntered, left: IPC.paneToolbarPointerLeft },
      () => cursorPoint(window),
      { enabled: !cursorWatchDisabled },
    );
  }

  setTrigger(box: ContentBounds | null): void {
    this.#zone.setEntry(box === null ? null : (point) => pointerHitsPaneToolbarTrigger(point, box));
  }

  setWatch(box: ContentBounds | null): void {
    this.#zone.setHold(box === null ? null : (point) => pointerHoldsPaneToolbar(point, box));
  }

  dispose(): void {
    this.#zone.dispose();
  }
}

/** The OS pointer in the window's content box, or null when it cannot be read. */
function cursorPoint(window: BrowserWindow): CursorPoint | null {
  if (
    cursorWatchDisabled ||
    window.isDestroyed() ||
    !window.isVisible() ||
    window.isMinimized()
  )
    return null;
  const cursor = screen.getCursorScreenPoint();
  const content = window.getContentBounds();
  return { x: cursor.x - content.x, y: cursor.y - content.y };
}

let sidebarWatch: SidebarWatch | null = null;
let paneToolbarWatch: PaneToolbarWatch | null = null;
/**
 * The transparent, full-window view that holds the pointer for a pane-resize
 * drag (@pistachio/shell-contracts/chrome, "drag capture").
 */
let dragLayer: ChromeOverlayView | null = null;
/** Native page-find bar above live tab views. */
let findLayer: ChromeOverlayView | null = null;
/** The shell's last published state, used by native window/view coordination. */
let shellState: ShellState = DEFAULT_SHELL_STATE;
let tabSwitcherChordActive = false;
let windowButtonHideTimer: NodeJS.Timeout | null = null;

/** One native Control–Tab chord, independent of which child WebContents has focus. */
function relayTabSwitcherInput(
  event: Electron.Event,
  input: Electron.Input,
): boolean {
  const key = input.key.toLowerCase();
  if (
    input.type === "keyDown" &&
    key === "tab" &&
    input.control &&
    !input.alt &&
    !input.meta
  ) {
    event.preventDefault();
    tabSwitcherChordActive = true;
    publishTabSwitcherInput({ type: "step", reverse: input.shift });
    return true;
  }
  if (
    tabSwitcherChordActive &&
    input.type === "keyUp" &&
    (!input.control || key.startsWith("control"))
  ) {
    event.preventDefault();
    tabSwitcherChordActive = false;
    publishTabSwitcherInput({ type: "commit" });
    return true;
  }
  if (tabSwitcherChordActive && input.type === "keyDown" && key === "escape") {
    event.preventDefault();
    tabSwitcherChordActive = false;
    publishTabSwitcherInput({ type: "cancel" });
    return true;
  }
  return false;
}

function publishTabSwitcherInput(input: TabSwitcherInput): void {
  if (shellWindow === null || shellWindow.isDestroyed()) return;
  shellWindow.webContents.send(IPC.tabSwitcherInput, input);
}

/**
 * Shift, shift: bookmark the page in front, whichever view had the
 * keyboard. Both taps must finish without another key before saving.
 */
function relayDoubleShift(input: Electron.Input): boolean {
  if (settings === null || !settings.get().bookmarks.doubleShift) {
    doubleShift.reset();
    return false;
  }
  if (!doubleShift.press(input)) return false;
  // The page saw both key-downs; let their releases through as well.
  captureActivePage();
  return true;
}

/** Save the active tab's page, quietly declining pages that are not web pages. */
function captureActivePage(tabId?: string): void {
  const service = bookmarkService;
  if (service === null) return;
  try {
    service.captureTab(tabId);
  } catch (error) {
    console.warn("[bookmarks]", error instanceof Error ? error.message : error);
  }
}

/** Every chrome view and the shell relay the same two chords. */
function relayChromeInput(event: Electron.Event, input: Electron.Input): boolean {
  // The detector must see even the events consumed by another shortcut.
  return relayDoubleShift(input) || relayTabSwitcherInput(event, input);
}

/** The compact sidebar: the column hides itself, and the window buttons with it. */
function isCompactSidebar(current: DesktopSettings): boolean {
  return (
    current.layout.mode === "sidebar" && current.layout.sidebar === "compact"
  );
}

/** Keep the native reveal target active only while compact mode is hidden. */
function syncSidebarEntryWatch(): void {
  if (sidebarWatch === null || settings === null) return;
  sidebarWatch.setEntryEnabled(
    isCompactSidebar(settings.get()) && !shellState.sidebarRevealed,
  );
}

/**
 * The macOS traffic lights sit in the sidebar's toolbar. While the compact
 * sidebar is hidden nothing is under them, so they hide with it and come
 * back with the column — the shell says when it is up
 * (ShellState.sidebarRevealed), since the column is the shell's own layout.
 * On close they remain through the CSS retreat rather than popping away from
 * a toolbar that is still visible. A reversal cancels that pending hide.
 *
 * In native fullscreen they stay on: macOS then keeps them in the titlebar
 * that slides down with the menu bar when the pointer reaches the top edge,
 * which is where one reaches for them there — not the sidebar's left edge.
 * `immediate` skips the retreat wait (leaving fullscreen has no retreat).
 */
function applyWindowButtons(immediate = false): void {
  if (
    process.platform !== "darwin" ||
    shellWindow === null ||
    shellWindow.isDestroyed()
  )
    return;
  const window = shellWindow;
  const shouldShow = () =>
    window.isFullScreen() ||
    !isCompactSidebar(requireSettings().get()) ||
    shellState.sidebarRevealed;
  if (shouldShow()) {
    if (windowButtonHideTimer !== null) clearTimeout(windowButtonHideTimer);
    windowButtonHideTimer = null;
    shellWindow.setWindowButtonVisibility(true);
    return;
  }
  const hide = () => {
    windowButtonHideTimer = null;
    if (window.isDestroyed()) return;
    if (!shouldShow()) window.setWindowButtonVisibility(false);
  };
  // Startup has no transition to watch and the window is not visible yet.
  if (immediate || !window.isVisible()) {
    hide();
    return;
  }
  if (windowButtonHideTimer !== null) clearTimeout(windowButtonHideTimer);
  windowButtonHideTimer = setTimeout(hide, SIDEBAR_CLOSE_MS);
}

function requireMemory(): MemoryStore {
  if (memory === null) throw new Error("memory store is not ready");
  return memory;
}

function requireReminders(): ReminderStore {
  if (reminders === null) throw new Error("reminder store is not ready");
  return reminders;
}

function requireBookmarks(): BookmarkStore {
  if (bookmarks === null) throw new Error("bookmark store is not ready");
  return bookmarks;
}

function requireBookmarkService(): BookmarkService {
  if (bookmarkService === null) throw new Error("bookmarks are not ready");
  return bookmarkService;
}

function requireNotes(): NoteStore {
  if (notes === null) throw new Error("note store is not ready");
  return notes;
}

/**
 * One note as the finished document that gets published (docs/notes.md N9).
 * Rendered here, on the owner's device: control is handed HTML and never
 * learns markdown, and the pictures travel inside it as `data:` URIs.
 */
function noteHtml(id: string): string {
  const store = requireNotes();
  const note = store.get(id);
  if (note === null) throw new Error(`no note ${id}`);
  return renderNoteHtml(note, { blob: (blobId) => store.getBlob(blobId) });
}

/** Control's hosting row as the editor's Share menu reads it. */
function noteHosting(row: ControlHostedNote): NoteHosting {
  const web = artifactWebOrigin();
  return {
    visibility: row.visibility,
    shareId: row.shareId,
    revision: row.revision,
    publicUrl: row.visibility === "public" && web !== null ? `${web}/notes/${row.shareId}` : null,
  };
}

/**
 * The control client a note's sharing needs, or null. Sharing is an account
 * feature end to end: without one there is nowhere to publish to, and saying
 * so (a null hosting) is better than a refusal the Share menu has to decode.
 */
function sharingClient(): ControlClient | null {
  if (auth?.enrolled() !== true || artifactWebOrigin() === null) return null;
  return auth.controlClient();
}

/**
 * The account client a note's SHARES need. Unlike publishing, this one does
 * not want a web origin: a share is read in the dashboard, which control
 * knows the address of, not at a public link this Mac has to compose.
 */
function shareClient(): ControlClient | null {
  return auth?.enrolled() === true ? auth.controlClient() : null;
}

/** Record what control just said about one note's shares, keeping the mirror. */
function rememberNoteShares(id: string, shares: ControlNoteShare[]): ControlNoteShare[] {
  const held = noteSharing.get(id);
  // No share left, no reason to remember a body: control has deleted its
  // copy, and this Mac forgets what it thought control held.
  noteSharing.set(id, {
    shared: shares.length > 0,
    mirror: shares.length > 0 ? (held?.mirror ?? null) : null,
  });
  return shares;
}

/**
 * Push this note's plaintext to control while someone is named on it
 * (docs/notes.md §9). Nothing is sent for a note nobody shares — that is
 * the whole of the promise — and nothing is sent when control already
 * agrees, so a poll does not re-upload an untouched note every 30 seconds.
 */
async function pushSharedNote(id: string): Promise<void> {
  const client = shareClient();
  const state = noteSharing.get(id);
  if (client === null || state?.shared !== true) return;
  const note = notes?.get(id) ?? null;
  if (note === null) return;
  const mirror = state.mirror;
  if (
    mirror !== null &&
    mirror.revision >= note.revision &&
    mirror.title === note.title &&
    mirror.markdown === note.markdown
  ) return;
  const result = await client.putSharedNote(id, {
    title: note.title,
    markdown: note.markdown,
    revision: note.revision,
  });
  if (result.note === undefined) {
    // Another device pushed a later revision, or the last share went while
    // we were typing. Forget the mirror and read what is actually there —
    // once: two devices racing must not turn into a chain of round trips,
    // and the 30 s poll settles whatever one pass did not.
    noteSharing.set(id, { shared: state.shared, mirror: null });
    if (!reconciling.has(id)) {
      reconciling.add(id);
      try {
        await pullSharedNote(id);
      } finally {
        reconciling.delete(id);
      }
    }
    return;
  }
  noteSharing.set(id, {
    shared: true,
    mirror: { title: result.note.title, markdown: result.note.markdown, revision: result.note.revision },
  });
}

/**
 * Read back what an editor wrote (§9). A revision above this Mac's is
 * applied as the person's OWN write — it is their note, edited by someone
 * they named — so it seals, syncs to their other devices and shows up in the
 * open editor like any other remote change. That write climbs past the
 * shared revision, so it goes straight back to control and the two agree.
 */
async function pullSharedNote(id: string): Promise<void> {
  const client = shareClient();
  const state = noteSharing.get(id);
  if (client === null || state?.shared !== true) return;
  const remote = await client.sharedNote(id);
  if (remote === null) return;
  noteSharing.set(id, {
    shared: true,
    mirror: { title: remote.title, markdown: remote.markdown, revision: remote.revision },
  });
  const local = notes?.get(id) ?? null;
  if (local === null || remote.revision <= local.revision) return;
  notes?.update(id, { title: remote.title, markdown: remote.markdown }, USER_NOTE_SOURCE);
  await pushSharedNote(id);
}

/**
 * One `NoteRequest` answered against the library (docs/notes.md §4, §8). The
 * renderer is ours, but the union is still checked: a request whose shape is
 * wrong is a bug to say out loud rather than a store call made with
 * undefined.
 */
async function handleNoteRequest(value: unknown): Promise<NoteResponse> {
  const request = noteRequest(value);
  const store = requireNotes();
  switch (request.type) {
    case "list":
      return { type: "list", notes: store.list() };
    case "search":
      return { type: "list", notes: store.search(request.query, request.limit) };
    case "get":
      return { type: "maybeNote", note: store.get(request.id) };
    case "create":
      return { type: "note", note: store.create(request.input ?? {}, USER_NOTE_SOURCE) };
    case "update":
      return { type: "note", note: store.update(request.id, request.patch, USER_NOTE_SOURCE) };
    case "delete":
      store.remove(request.id);
      return { type: "deleted" };
    case "putBlob":
      return { type: "blobId", id: store.putBlob(new Uint8Array(Buffer.from(request.data, "base64")), request.mediaType).id };
    case "getBlob":
      return { type: "blob", blob: store.getBlob(request.id) };
    case "exportHtml":
      return { type: "html", html: noteHtml(request.id) };
    case "sharing": {
      const client = sharingClient();
      if (client === null) return { type: "sharing", hosting: null };
      const row = await client.notePublishing(request.id);
      return { type: "sharing", hosting: row === null ? null : noteHosting(row) };
    }
    case "setVisibility": {
      const client = sharingClient();
      if (client === null) return { type: "sharing", hosting: null };
      const note = store.get(request.id);
      if (note === null) throw new Error(`no note ${request.id}`);
      const row = await client.setNoteVisibility(request.id, {
        revision: note.revision,
        visibility: request.visibility,
        // Publishing sends the body as it stands now; revoking sends nothing,
        // and control clears the copy it held.
        ...(request.visibility === "public" ? { html: noteHtml(request.id) } : {}),
      });
      return { type: "sharing", hosting: noteHosting(row) };
    }
    case "shares": {
      const client = shareClient();
      if (client === null) return { type: "shares", shares: null, found: true };
      return { type: "shares", shares: rememberNoteShares(request.id, await client.noteShares(request.id)), found: true };
    }
    case "share": {
      const client = shareClient();
      if (client === null) return { type: "shares", shares: null, found: true };
      const { share, shares } = await client.shareNote(request.id, { email: request.email, role: request.role });
      rememberNoteShares(request.id, shares);
      // A share has nothing to read until this Mac has pushed the body once,
      // so the first one carries it up rather than waiting for a keystroke.
      if (share !== null) await pushSharedNote(request.id);
      return { type: "shares", shares, found: share !== null };
    }
    case "unshare": {
      const client = shareClient();
      if (client === null) return { type: "shares", shares: null, found: true };
      return {
        type: "shares",
        shares: rememberNoteShares(request.id, await client.unshareNote(request.id, request.shareId)),
        found: true,
      };
    }
  }
}

/** The renderer's `NoteRequest`, or a thrown error naming what was wrong with it. */
function noteRequest(value: unknown): NoteRequest {
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const type = raw["type"];
  const id = (): string => {
    const candidate = raw["id"];
    if (typeof candidate !== "string" || !isNoteId(candidate)) throw new Error("a note request needs a note id");
    return candidate;
  };
  const patch = (): NotePatch =>
    typeof raw["patch"] === "object" && raw["patch"] !== null ? (raw["patch"] as NotePatch) : {};
  switch (type) {
    case "list":
      return { type: "list" };
    case "search":
      return {
        type: "search",
        query: typeof raw["query"] === "string" ? raw["query"] : "",
        ...(typeof raw["limit"] === "number" && Number.isFinite(raw["limit"]) ? { limit: Math.floor(raw["limit"]) } : {}),
      };
    case "get":
    case "delete":
    case "exportHtml":
    case "sharing":
    case "shares":
      return { type, id: id() };
    case "share": {
      const email = raw["email"];
      if (typeof email !== "string" || email.trim() === "") throw new Error("a share needs an email address");
      return { type: "share", id: id(), email: email.trim(), role: raw["role"] === "editor" ? "editor" : "viewer" };
    }
    case "unshare": {
      const shareId = raw["shareId"];
      if (typeof shareId !== "string" || shareId === "") throw new Error("a share to end needs its id");
      return { type: "unshare", id: id(), shareId };
    }
    case "create":
      return { type: "create", input: typeof raw["input"] === "object" && raw["input"] !== null ? (raw["input"] as NoteInput) : {} };
    case "update":
      // The store sanitizes every field; what is checked here is that there
      // is an id and something shaped like a patch to apply to it.
      return { type: "update", id: id(), patch: patch() };
    case "putBlob": {
      const mediaType = raw["mediaType"];
      if (typeof mediaType !== "string" || !(NOTE_BLOB_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
        throw new Error("that is not an image a note can hold");
      }
      if (typeof raw["data"] !== "string" || raw["data"] === "") throw new Error("an image needs bytes");
      return { type: "putBlob", mediaType: mediaType as NoteBlobMediaType, data: raw["data"] };
    }
    case "getBlob": {
      const blobId = raw["id"];
      if (typeof blobId !== "string" || !isNoteBlobId(blobId)) throw new Error("that is not a note image id");
      return { type: "getBlob", id: blobId };
    }
    case "setVisibility":
      return { type: "setVisibility", id: id(), visibility: raw["visibility"] === "public" ? "public" : "private" };
    default:
      throw new Error(`unknown note request ${String(type)}`);
  }
}

/**
 * The bookmark card: told to the shell and the card's own view, and the
 * view placed over the active pane's corner — or taken down. Re-run on
 * every layout change so the card follows its pane.
 */
function publishBookmarkToast(toast: BookmarkToast | null): void {
  if (shellWindow !== null && !shellWindow.isDestroyed())
    shellWindow.webContents.send(IPC.bookmarkToastChanged, toast);
  bookmarkLayer?.webContents.send(IPC.bookmarkToastChanged, toast);
  syncBookmarkLayer();
}

function syncBookmarkLayer(): void {
  const layer = bookmarkLayer;
  if (layer === null) return;
  const toast = bookmarkService?.toast() ?? null;
  const pane = browser?.activePaneBounds() ?? null;
  if (pane === null || toast === null) {
    layer.setShown(false);
    return;
  }
  const width = Math.min(BOOKMARK_TOAST_WIDTH, Math.max(280, pane.width - 2 * BOOKMARK_TOAST_MARGIN));
  const height = Math.min(bookmarkToastHeight, Math.max(64, pane.height - 2 * BOOKMARK_TOAST_MARGIN));
  layer.setSlot({
    x: pane.x + pane.width - width - BOOKMARK_TOAST_MARGIN,
    y: pane.y + pane.height - height - BOOKMARK_TOAST_MARGIN,
    width,
    height,
  });
  // The card has nothing to say over the bookmarks page itself, and stays
  // under any full-window veil like the find bar does.
  layer.setVeiled(shellState.veiled || shellState.bookmarksOpen);
  layer.setShown(true);
  layer.raise();
}

/** Ask the shell to do something UI-side, if there is a shell to ask. */
/**
 * The controller's `nameTabGroup` hook (docs/tab-tidy.md §3.3). Null AT ONCE
 * when no model will be asked — grouping switched off, signed out, a spec
 * with no script — so the chrome offers the name field instead of waiting.
 */
function nameTabGroupHook(tabs: ReadonlyArray<{ title: string; url: string }>, existingTitles: readonly string[]): Promise<string | null> | null {
  if (!requireSettings().get().tabs.groupRelated) return null;
  const scripted = scriptedGroupNamer();
  if (scripted !== null) return scripted();
  if (process.env["PISTACHIO_E2E"] === "1" && process.env["PISTACHIO_AGENT_LIVE"] !== "1") return null;
  const model = configuredTidyModel();
  return model === null ? null : nameTabGroup(tabs, existingTitles, { model: model.model });
}

/**
 * Tidy for this window's tabs (docs/tab-tidy.md). Under Playwright the model
 * is a spec's script or nothing, the way bookmarks and the embedder stay
 * offline; otherwise it is the account's, and null — the clock alone — when
 * signed out or switched off.
 */
function startTabTidy(controller: BrowserController): void {
  const archive = tabArchive;
  if (archive === null) return;
  const scripted = scriptedTidyJudge();
  const offline = process.env["PISTACHIO_E2E"] === "1" && process.env["PISTACHIO_AGENT_LIVE"] !== "1";
  tabTidy = new TabTidy({
    host: controller,
    archive,
    settings: () => requireSettings().get().tabs,
    spaceIds: () => spaces?.all().map((space) => space.id) ?? [],
    activeSpaceId: () => controller.activeSpaceId(),
    favoriteHome: (spaceId, anchorId) => {
      if (isPresetAnchorId(anchorId)) {
        const preset = requireSettings().get().organization.presetLinks.find((link) => presetAnchorId(link.url) === anchorId);
        return preset === undefined ? null : { url: preset.url, title: preset.title };
      }
      const favorite = sidebar === null ? null : favoriteOf(sidebar.get(spaceId), anchorId);
      return favorite === null ? null : { url: favorite.url, title: favorite.title };
    },
    judge: async (input) => {
      if (scripted !== null) return scripted(input);
      const model = offline ? null : configuredTidyModel();
      return model === null ? null : judgeTidy(input, { model: model.model });
    },
    // Most runs happen while nobody is looking — tabs go idle overnight — and
    // a notice that came and went unseen explains nothing. It is held until
    // the window is next in front (docs/tab-tidy.md §3.1).
    announce: (summary) => {
      const say = (): void => sendShellCommand({ type: "tidyFinished", summary });
      const window = shellWindow;
      if (window === null || window.isDestroyed() || window.isFocused()) say();
      else window.once("focus", say);
    },
  });
  tabTidy.start();
}

function sendShellCommand(command: ShellCommand): void {
  if (shellWindow === null || shellWindow.isDestroyed()) return;
  shellWindow.webContents.send(IPC.shellCommand, command);
}

/**
 * A scheduled brief is ready. In front of the person it is a note in the
 * window; behind other apps it is a system notification whose click opens
 * the brief; with notifications off it waits for the window to come forward.
 */
function announceBrief(record: ReportRecord): void {
  const window = shellWindow !== null && !shellWindow.isDestroyed() ? shellWindow : null;
  const inApp = () => sendShellCommand({ type: "briefReady", title: record.title });
  if (window?.isFocused() === true) {
    inApp();
    return;
  }
  const wanted = requireSettings().get().general.morningBriefNotify;
  if (!wanted || process.env["PISTACHIO_E2E"] === "1" || !Notification.isSupported()) {
    window?.once("focus", inApp);
    return;
  }
  const headline = ((record.spec.state ?? {}) as { text?: { headline?: unknown } }).text?.headline;
  const notice = new Notification({ title: `${record.title} is ready`, body: typeof headline === "string" ? headline : "Your day, on one page.", silent: true });
  briefNotifications.add(notice);
  notice.on("close", () => briefNotifications.delete(notice));
  // The system can refuse — notifications turned off for Pistachio, or an
  // unsigned development build. The news then waits in the window instead.
  notice.on("failed", (_event, error) => {
    briefNotifications.delete(notice);
    console.error("[brief] the notification was refused:", error);
    window?.once("focus", inApp);
  });
  notice.on("click", () => {
    briefNotifications.delete(notice);
    const target = shellWindow;
    if (target === null || target.isDestroyed()) {
      // No window: the new one opens on the home page, whose teaser carries the brief.
      void createWindow();
      return;
    }
    target.show();
    target.focus();
    sendShellCommand({ type: "openBrief" });
  });
  notice.show();
}

/** What the renderer sees before sign-in, in an E2E run, or when the keychain is unavailable. */
function accountState(): AccountState {
  return (
    auth?.state() ?? {
      state: "unenrolled",
      email: null,
      userId: null,
      deviceId: null,
      deviceName: "",
      controlUrl: "",
      encryptionAvailable: false,
      cloudDevicePin: null,
      cloudDeviceChanged: null,
      revoked: false,
      hubUrl: null,
      cloudBrowserUrl: null,
      error: featureEnabled && deviceStore === null ? "Account features could not start on this Mac." : null,
    }
  );
}

function egressStatus(): EgressStatus {
  return (
    egress?.status() ?? {
      enabled: false,
      gateway: null,
      health: "unknown",
      credentialExpiresAt: null,
      quicDisabledAtStartup,
      spaces: requireSpaces()
        .all()
        .map((space) => ({
          spaceId: space.id,
          policy: space.egressPolicy,
          failClosed: false,
          temporaryDirectOverride: false,
          restartRequired: false,
        })),
    }
  );
}

/**
 * `cloud:status` is composed: the account half (what this Mac knows from
 * AuthService and SpaceStore) under the live-view half the cloud service
 * installs on `featureHandlers.cloud` (main/feature-handlers.ts).
 */
function cloudStatus(): CloudStatus {
  const state = auth?.state() ?? null;
  return {
    available: auth?.enrolled() === true && auth.cloudBrowserUrl() !== null,
    cloudBrowserUrl: auth?.cloudBrowserUrl() ?? null,
    device: state?.cloudDevicePin ?? null,
    spaces: requireSpaces()
      .all()
      .map((space) => ({ spaceId: space.id, enabled: space.cloudEnabled })),
    ...featureHandlers.cloud.status(),
  };
}

function sendToShell(channel: string, payload: unknown): void {
  if (shellWindow !== null && !shellWindow.isDestroyed())
    shellWindow.webContents.send(channel, payload);
}

function publishAccount(state: AccountState): void {
  sendToShell(IPC.accountChanged, state);
  // The pin and the enabled Spaces ride on the cloud status too.
  publishCloudStatus();
}

function publishDevices(devices: DeviceInfo[]): void {
  sendToShell(IPC.devicesUpdated, devices);
  // `devices:updated` re-reads the verifier registry (§10.2). The registry
  // reads control directly, so this never loops back here.
  syncService?.refreshRegistry();
}

function publishEgressStatus(status: EgressStatus): void {
  sendToShell(IPC.egressChanged, status);
}

/** For the sync service (main/sync): its status on `sync:changed`. */
function publishSyncStatus(status: SyncStatus): void {
  sendToShell(IPC.syncChanged, status);
}

/** For the workspace sync service: its status on `workspaceSync:changed`. */
function publishWorkspaceSyncStatus(status: WorkspaceSyncStatus): void {
  sendToShell(IPC.workspaceSyncChanged, status);
}

/** For the cloud service: the composed status on `cloud:changed`. */
function publishCloudStatus(): void {
  if (spaces === null) return;
  sendToShell(IPC.cloudChanged, cloudStatus());
}

/** For the live-view client: one screencast frame on `cloud:frame`. */
function publishCloudFrame(frame: CloudFrame): void {
  sendToShell(IPC.cloudFrame, frame);
}

/**
 * The publishers the sync, workspace-sync, and cloud services take when they
 * are constructed here in `initializeAccountServices` (main/feature-handlers.ts).
 */
export const featurePublishers = {
  publishSyncStatus,
  publishWorkspaceSyncStatus,
  publishCloudStatus,
  publishCloudFrame,
};

/** This Mac's name as the account's device list shows it. */
function computerName(): string {
  const name = hostname().replace(/\.local$/i, "").trim();
  return name === "" ? "This Mac" : name;
}

/**
 * Sign-out (§10.1): every Space's cookies, storage, and cached credentials
 * go, so the account's sessions do not linger on a Mac that no longer holds
 * the account; the Spaces and their tabs stay, and reload signed out.
 */
async function clearSpaceSessions(): Promise<void> {
  browser?.clearPageResume();
  for (const space of requireSpaces().all()) {
    const target = session.fromPartition(spacePartition(space.id));
    try {
      await target.clearStorageData();
      await target.clearCache();
      await target.clearAuthCache();
    } catch (error) {
      console.error(`[account] could not clear the session of Space ${space.id}`, error);
    }
    browser?.reloadSpace(space.id);
  }
}

/**
 * The account, egress, and feature seam, built once the stores exist and
 * before the window (the `login` listener must be installed before any page
 * can be challenged). Nothing here runs under PISTACHIO_E2E.
 */
async function initializeAccountServices(): Promise<void> {
  const userData = app.getPath("userData");
  try {
    deviceStore = await DeviceStore.load(userData, { deviceName: computerName() });
  } catch (error) {
    console.error("[account] the device store could not be opened; account features are off", error);
    return;
  }
  const store = deviceStore;
  const refreshPublicArtifact = async (client: ControlClient, id: string): Promise<void> => {
    const record = artifacts?.syncGet(id) ?? null;
    if (record === null) return;
    const hosted = await client.artifactPublishing(id);
    // Private HTML is never sent to control. A public row is the owner's
    // explicit instruction to keep its plaintext share snapshot current.
    if (hosted?.visibility !== "public") return;
    await client.putArtifactRevision(id, {
      revision: record.revision,
      html: record.html,
    });
  };
  const refreshPublicArtifacts = (client: ControlClient): void => {
    for (const record of artifacts?.syncAll() ?? []) {
      void refreshPublicArtifact(client, record.id).catch((error: unknown) => {
        console.error(`[artifacts] could not refresh public artifact ${record.id}`, error);
      });
    }
  };
  /**
   * The same bargain a published artifact strikes (docs/notes.md §8): read
   * the hosting row first — metadata only — and upload a freshly rendered
   * document ONLY while the owner still has this note public. A private note
   * never leaves this Mac in plaintext.
   */
  const refreshPublicNote = async (client: ControlClient, id: string): Promise<void> => {
    const note = notes?.get(id) ?? null;
    if (note === null) return;
    const hosted = await client.notePublishing(id);
    if (hosted?.visibility !== "public") return;
    await client.putNoteRevision(id, { revision: note.revision, html: noteHtml(id) });
  };
  /**
   * A deleted note must not go on being readable. Whatever control still
   * holds for it — the public page, the plaintext the people named on it
   * read — comes down the moment this Mac sees the note go, whoever deleted
   * it: the person, the agent, or another device through sync. Nothing is
   * retired on mere absence, though: a Mac that has just enrolled holds no
   * notes until the workspace hydrates, and that is not a deletion.
   */
  const retireNoteSharing = async (client: ControlClient, id: string): Promise<void> => {
    const hosted = await client.notePublishing(id);
    if (hosted !== null && hosted.visibility === "public") {
      await client.setNoteVisibility(id, { revision: hosted.revision, visibility: "private" });
    }
    for (const share of await client.noteShares(id)) await client.unshareNote(id, share.id);
    noteSharing.delete(id);
  };
  const refreshPublicNotes = (client: ControlClient): void => {
    for (const record of notes?.syncAll("note") ?? []) {
      void refreshPublicNote(client, record.id).catch((error: unknown) => {
        console.error(`[notes] could not refresh public note ${record.id}`, error);
      });
    }
  };
  /**
   * Which notes anyone is named on, and what they hold now (docs/notes.md
   * §9). One request answers the first half for every note at once — a
   * person with five hundred notes and two shares asks about two — and each
   * of those is then read back in case an editor has written into it.
   */
  const refreshSharedNotes = async (client: ControlClient): Promise<void> => {
    const shares = await client.myNoteShares();
    const shared = new Set(shares.map((share) => share.noteId));
    for (const [id, state] of noteSharing) {
      if (!shared.has(id) && state.shared) noteSharing.set(id, { shared: false, mirror: null });
    }
    for (const id of shared) {
      const held = noteSharing.get(id);
      noteSharing.set(id, { shared: true, mirror: held?.mirror ?? null });
    }
    for (const id of shared) {
      await pullSharedNote(id).catch((error: unknown) => {
        console.error(`[notes] could not read the shared copy of ${id}`, error);
      });
    }
  };
  const pollSharedNotes = (): void => {
    if (!auth?.enrolled()) return;
    void refreshSharedNotes(auth.controlClient()).catch((error: unknown) => {
      console.error("[notes] could not read what is shared", error);
    });
  };
  const egressService = new EgressService({
    spaces: requireSpaces(),
    control: () => (auth?.enrolled() === true ? auth.controlClient() : null),
    quicDisabledAtStartup,
    egressUrlPin: process.env["PISTACHIO_EGRESS_URL"],
    publish: publishEgressStatus,
  });
  egress = egressService;
  const authService = new AuthService({
    store,
    spaces: requireSpaces(),
    controlUrl: resolveControlUrl(process.env, app.isPackaged),
    hubUrlPin: process.env["PISTACHIO_HUB_URL"] ?? null,
    // `PISTACHIO_ANONYMOUS=0` keeps a signed-out Mac accountless, as before.
    anonymousAccounts: process.env["PISTACHIO_ANONYMOUS"] !== "0",
    publish: publishAccount,
    publishDevices,
    onEnrolled: () => {
      egressService.start();
      featureHandlers.lifecycle.onEnrolled();
      // A completed install may enroll later, or predate account-backed
      // onboarding. Reconcile on enrollment and startup so its next web
      // sign-in resumes browsing instead of repeating the walkthrough.
      if (requireSettings().get().onboarding.completed) {
        void authService.controlClient().completeOnboarding().catch((error: unknown) => {
          console.error("[account] could not sync onboarding completion", error);
        });
      }
      refreshPublicArtifacts(authService.controlClient());
      refreshPublicNotes(authService.controlClient());
      void refreshSharedNotes(authService.controlClient()).catch((error: unknown) => {
        console.error("[notes] could not read what is shared", error);
      });
      publishCloudStatus();
    },
    onSignedOut: async (reason) => {
      egressService.stop();
      // Await the drain: an apply already inside Electron's cookie API must
      // settle before the partition is wiped, or it recreates what we cleared.
      await featureHandlers.lifecycle.onSignedOut(reason);
      if (reason === "sign-out") await clearSpaceSessions();
      publishCloudStatus();
    },
    onTokenChanged: () => featureHandlers.lifecycle.onTokenChanged(),
  });
  auth = authService;
  // Every model call the agent, memory, and read-aloud make goes to control
  // under this Mac's device token; there is no key on the device to set.
  // Signed in or not: a Mac nobody signed in on holds an anonymous account's
  // token (docs/anonymous-accounts.md), good for the models and nothing else.
  setAiSession({
    controlUrl: authService.controlClient().url,
    enrolled: () => authService.modelsAvailable(),
    getToken: () => authService.getModelToken(),
  });
  artifacts?.onRecordChange((id) => {
    if (!authService.enrolled()) return;
    void refreshPublicArtifact(authService.controlClient(), id).catch((error: unknown) => {
      console.error(`[artifacts] could not refresh public artifact ${id}`, error);
    });
  });
  // An artifact is rewritten when the agent rebuilds it — rarely. A note is
  // saved every 600 ms the person is typing (docs/notes.md §5), so the same
  // hook here would ask control about a published note twice a second. One
  // timer per note id collapses a burst of keystrokes into one upload.
  const notePublishTimers = new Map<string, NodeJS.Timeout>();
  notes?.onRecordChange((kind, id) => {
    if (kind !== "note" || !authService.enrolled()) return;
    const held = notePublishTimers.get(id);
    if (held !== undefined) clearTimeout(held);
    notePublishTimers.set(
      id,
      setTimeout(() => {
        notePublishTimers.delete(id);
        if (!authService.enrolled()) return;
        void refreshPublicNote(authService.controlClient(), id).catch((error: unknown) => {
          console.error(`[notes] could not refresh public note ${id}`, error);
        });
        // The same edit, to the same debounce, for the people named on this
        // note (docs/notes.md §9). A note nobody shares sends nothing.
        void pushSharedNote(id).catch((error: unknown) => {
          console.error(`[notes] could not send the shared copy of ${id}`, error);
        });
      }, NOTE_PUBLISH_DEBOUNCE_MS).unref(),
    );
  });
  // Deletions, from whichever side: the snapshot is the one place every
  // way a note can go — the library, the agent's tool, a tombstone from
  // another device — shows up the same, as an id that was there and is not.
  let knownNoteIds = new Set((notes?.list() ?? []).map((summary) => summary.id));
  notes?.onChange((snapshot) => {
    const current = new Set(snapshot.notes.map((summary) => summary.id));
    for (const id of knownNoteIds) {
      if (current.has(id)) continue;
      const held = notePublishTimers.get(id);
      if (held !== undefined) {
        clearTimeout(held);
        notePublishTimers.delete(id);
      }
      if (!authService.enrolled()) continue;
      void retireNoteSharing(authService.controlClient(), id).catch((error: unknown) => {
        console.error(`[notes] could not take down what was shared of deleted note ${id}`, error);
      });
    }
    knownNoteIds = current;
  });
  // An editor writing on the web has nowhere to push but control, so this
  // Mac is the one that goes and looks: on a timer, and the moment the
  // person comes back to the window, which is when they would notice.
  setInterval(pollSharedNotes, SHARED_NOTE_POLL_MS).unref();
  app.on("browser-window-focus", pollSharedNotes);
  // A fork made after enrollment needs a root secret and a control row
  // before its cookies can sync; a Space that arrived from another device
  // already has both.
  requireSpaces().onChange((change) => {
    if (!change.remote && change.kind === "created") void authService.ensureSpaceSecrets();
    if (change.kind === "created" || change.kind === "removed" || change.kind === "updated") publishCloudStatus();
  });
  // The gateway's proxy challenge, and nothing else, is answered with the
  // egress credential (§10.3). Installed before createWindow.
  app.on("login", (event, _contents, details, authInfo, callback) =>
    egressService.handleLogin(event, details, authInfo, callback),
  );
  const controlWhenEnrolled = (): ControlClient | null =>
    authService.enrolled() ? authService.controlClient() : null;
  const sync = new SyncService({
    device: store,
    spaces: requireSpaces(),
    // What the person keeps travels with the account, not with this Mac.
    records: new WorkspaceRecords({
      bookmark: requireBookmarks(),
      reminder: requireReminders(),
      memory: requireMemory(),
      artifact: {
        all: () => artifacts?.syncAll() ?? [],
        get: (id) => artifacts?.syncGet(id) ?? null,
        applyRemote: (value) => artifacts?.applyRemote(value) ?? null,
        removeRemote: (id) => artifacts?.removeRemote(id) ?? false,
        onRecordChange: (listener) => artifacts?.onRecordChange(listener) ?? (() => undefined),
      },
      // A note is one register; each picture it references is another, so a
      // keystroke re-seals kilobytes of text (docs/notes.md N2, N3).
      note: {
        all: () => notes?.syncAll("note") ?? [],
        get: (id) => notes?.syncGet("note", id) ?? null,
        applyRemote: (value) => notes?.applyRemote("note", value) ?? null,
        removeRemote: (id) => notes?.removeRemote("note", id) ?? false,
        onRecordChange: (listener) =>
          notes?.onRecordChange((kind, id) => {
            if (kind === "note") listener(id);
          }) ?? (() => undefined),
      },
      noteBlob: {
        all: () => notes?.syncAll("noteBlob") ?? [],
        get: (id) => notes?.syncGet("noteBlob", id) ?? null,
        applyRemote: (value) => notes?.applyRemote("noteBlob", value) ?? null,
        removeRemote: (id) => notes?.removeRemote("noteBlob", id) ?? false,
        onRecordChange: (listener) =>
          notes?.onRecordChange((kind, id) => {
            if (kind === "noteBlob") listener(id);
          }) ?? (() => undefined),
      },
    }),
    browser: () => browser,
    restorePoint: () => requireTabSessions().get(),
    onSessionPersisted: (listener) => requireTabSessions().onChange(() => listener()),
    control: controlWhenEnrolled,
    enrolled: () => authService.enrolled(),
    getToken: () => authService.getToken(),
    hubUrl: () => authService.hubUrl(),
    hubUrlPinned: (process.env["PISTACHIO_HUB_URL"] ?? "").trim() !== "",
    packaged: app.isPackaged,
    listDevices: () => authService.controlClient().listDevices(),
    userDataDir: userData,
    publishStatus: publishSyncStatus,
    publishWorkspaceStatus: publishWorkspaceSyncStatus,
  });
  syncService = sync;
  const cloud = new CloudRunService({
    control: controlWhenEnrolled,
    spaces: requireSpaces(),
    spaceSecret: (spaceId) => store.spaceSecret(spaceId),
    threads: requireThreads(),
    runs: () => runs,
    activeTab: () => browser?.activeTab() ?? null,
    onChange: publishRun,
  });
  cloudRuns = cloud;
  const live = new LiveViewClient({
    // Control names the worker holding the run and mints the credential for
    // it; this Mac's own device token never rides in the socket's URL (§8.5).
    ticket: async (runId) => (await controlWhenEnrolled()?.runLiveTicket(runId)) ?? null,
    // The runner makes every viewer prove it holds the run's Space key before
    // it sends a pixel; this Mac answers with the key it already syncs under.
    proveSpaceKey: (spaceId, runId, nonce) => cloud.proveSpaceKey(spaceId, runId, nonce),
    publishFrame: publishCloudFrame,
    onStatusChanged: publishCloudStatus,
  });
  installFeatureHandlers({
    sync: {
      status: () => sync.status(),
      originInfo: (spaceId, host) => sync.originInfo(spaceId, host),
      setOriginOverride: (spaceId, host, override) => sync.setOriginOverride(spaceId, host, override),
      rollbackOrigin: async (spaceId, host) => {
        await sync.rollbackOrigin(spaceId, host);
      },
      retry: () => sync.retry(),
    },
    workspaceSync: {
      status: () => sync.workspaceStatus(),
      run: (action) => sync.runWorkspaceSync(action),
    },
    cloud: {
      status: () => live.status(),
      startRun: (request) => cloud.startRun(request),
      liveOpen: (runId) => live.open(runId),
      liveClose: () => live.close(),
      liveInput: (input) => live.input(input),
    },
    channels: createChannelsFeature({ control: controlWhenEnrolled }),
    lifecycle: {
      onEnrolled: () => {
        sync.start();
        cloud.start();
      },
      onSignedOut: async (reason) => {
        void live.close();
        cloud.stop();
        await sync.stop(reason ?? "sign-out");
      },
      onTokenChanged: () => sync.refreshAuth(),
      onSessionCreated: (target, spaceId, partition, kind) => sync.onSessionCreated(target, spaceId, partition, kind),
      beginBulkCookieWrite: (spaceId) => sync.beginBulkCookieWrite(spaceId),
      endBulkCookieWrite: (spaceId) => sync.endBulkCookieWrite(spaceId),
      flush: () => sync.flush(),
    },
  });
  authService.start();
}

function requireUpdates(): UpdateService {
  if (updates === null) throw new Error("updates are not ready");
  return updates;
}

function requireSettings(): SettingsStore {
  if (settings === null) throw new Error("settings are not ready");
  return settings;
}

function requireSpaces(): SpaceStore {
  if (spaces === null) throw new Error("Space store is not ready");
  return spaces;
}

function requireTabSessions(): TabSessionStore {
  if (tabSessions === null) throw new Error("tab session store is not ready");
  return tabSessions;
}

function requireThreads(): ThreadStore {
  if (threads === null) throw new Error("thread store is not ready");
  return threads;
}

function requireSidebar(): SidebarStore {
  if (sidebar === null) throw new Error("sidebar store is not ready");
  return sidebar;
}

function requireSidebarController(): SidebarController {
  if (sidebarController === null)
    throw new Error("sidebar controller is not ready");
  return sidebarController;
}

// Publishing is coalesced: a tab event, a sidebar write, and an agent step
// that land in the same synchronous run produce one flush, and the tab side
// and the run side of the snapshot travel on separate channels (@pistachio/shell-contracts/ipc
// ShellTabsSnapshot / ShellRunSnapshot). A title tick therefore no longer
// re-serializes the whole conversation, and a tool step no longer re-sends
// every tab.
let tabsPublishPending = false;
let runPublishPending = false;
let publishScheduled = false;
/** Whether the run last sent to the shell was visible (scoped into the active Space). */
let lastRunVisible: boolean | null = null;

/** The tab side changed: tabs, spaces, split groups, the shelf. */
function publish(): void {
  tabsPublishPending = true;
  schedulePublish();
}

/** The run side changed: the conversation, its status, the thread list. */
function publishRun(): void {
  runPublishPending = true;
  schedulePublish();
}

function schedulePublish(): void {
  if (publishScheduled) return;
  publishScheduled = true;
  // A microtask, not setImmediate: every publish a mutation handler causes
  // is queued before that handler's promise settles, so the flush — and the
  // snapshot it sends — always precedes the handler's IPC reply. Renderers
  // that await a mutation and then read the store (a drag positioning the
  // rest of a split after `reorderTab`) see the new order, as they did when
  // publishing was synchronous. Publishes within one synchronous burst
  // still coalesce into a single flush.
  queueMicrotask(flushPublish);
}

function flushPublish(): void {
  publishScheduled = false;
  if (shellWindow === null || browser === null || shellWindow.isDestroyed()) {
    tabsPublishPending = false;
    runPublishPending = false;
    return;
  }
  const shelf = requireSidebar();
  if (tabsPublishPending) {
    // An anchored tab's title and favicon are the entry's too, so a pin whose
    // page is closed keeps showing what it last was.
    browser.persistSession();
    for (const tab of browser.allTabs()) {
      if (tab.anchorId !== null && !tab.loading)
        shelf.syncAnchor(tab.spaceId, tab.anchorId, tab.title, tab.faviconUrl);
    }
  }
  const tabsChanged = tabsPublishPending;
  const runChanged = runPublishPending;
  tabsPublishPending = false;
  runPublishPending = false;
  if (!tabsChanged && !runChanged) return;
  // The live run, not a clone: IPC serializes at send time, and the scoping
  // below only reads it.
  const { run, threads, ...tabs } = browser.snapshot(
    runs?.peek() ?? null,
    shelf.get(browser.activeSpaceId()),
    runChanged ? (runs?.threads() ?? []) : [],
  );
  if (tabsChanged) shellWindow.webContents.send(IPC.snapshotChanged, tabs);
  // A Space switch can scope the same run in or out of view: that is a run
  // publish too, even though nothing in the run changed.
  const runVisible = run !== null;
  if (runChanged || runVisible !== lastRunVisible) {
    lastRunVisible = runVisible;
    shellWindow.webContents.send(IPC.runChanged, {
      run,
      threads: runChanged ? threads : (runs?.threads() ?? []),
    });
  }
  // The very tab the shell puts the highlight ring around: the ring is
  // chrome, the glow inside the pane is injected into the page, and one
  // predicate means neither can outlast the other. A finished turn is
  // `completed` before its answer is published, so this publish carries the
  // answer and takes the light off the page together. A cloud run names no
  // tab here: its light is on its live view, not on these panes.
  browser.setAgentGlow(agentDrivenTabId(run));
}

function publishGlance(glance: GlanceState | null): void {
  if (shellWindow === null || shellWindow.isDestroyed()) return;
  shellWindow.webContents.send(IPC.glanceChanged, glance);
}

/** Media is shell-only and intentionally separate from the high-fanout snapshot. */
function publishMedia(media: BrowserMediaInfo[]): void {
  if (shellWindow === null || shellWindow.isDestroyed()) return;
  shellWindow.webContents.send(IPC.mediaChanged, media);
}

function publishReadAloud(jobs: ReadAloudStatus[]): void {
  if (shellWindow === null || shellWindow.isDestroyed()) return;
  shellWindow.webContents.send(IPC.readAloudChanged, jobs);
}

function publishBrowserControls(snapshot: BrowserControlsSnapshot): void {
  if (shellWindow === null || shellWindow.isDestroyed()) return;
  shellWindow.webContents.send(IPC.browserControlsChanged, snapshot);
}

function publishDownloads(downloads: BrowserDownload[]): void {
  if (shellWindow === null || shellWindow.isDestroyed()) return;
  shellWindow.webContents.send(IPC.downloadsChanged, downloads);
}

function publishFind(state: FindState): void {
  if (shellWindow === null || shellWindow.isDestroyed()) return;
  shellWindow.webContents.send(IPC.findChanged, state);
  const layer = findLayer;
  const pane = browser?.activePaneBounds() ?? null;
  if (layer === null) return;
  // A description is longer than a word: smart mode gets a wider bar.
  const width =
    pane === null
      ? 0
      : Math.min(state.mode === "smart" ? FIND_BAR.smartWidth : FIND_BAR.width, Math.max(260, pane.width - 2 * FIND_BAR.inset));
  // Smart mode has a second line: what is happening, then the match's key sentence.
  const height = state.mode === "smart" ? FIND_BAR.height + FIND_BAR.detailHeight : FIND_BAR.height;
  // The view is the card plus transparent room for its shadow.
  layer.setSlot(
    pane === null
      ? null
      : {
          x: pane.x + pane.width - width - FIND_BAR.inset - FIND_BAR_ROOM.side,
          y: pane.y + FIND_BAR.inset - FIND_BAR_ROOM.top,
          width: width + 2 * FIND_BAR_ROOM.side,
          height: height + FIND_BAR_ROOM.top + FIND_BAR_ROOM.bottom,
        },
  );
  layer.setVeiled(shellState.veiled);
  layer.setShown(state.open);
  if (state.open) {
    layer.raise();
    layer.webContents.send(IPC.findChanged, state);
    layer.webContents.focus();
    const focusRetry = setTimeout(() => {
      if (browser?.findState().open !== true || findLayer !== layer) return;
      layer.webContents.focus();
      layer.webContents.send(IPC.findChanged, state);
    }, 60);
    focusRetry.unref();
  }
}

function requireBrowser(): BrowserController {
  if (browser === null) throw new Error("browser is not ready");
  return browser;
}

function requireRuns(): RunController {
  if (runs === null) throw new Error("run controller is not ready");
  return runs;
}

function desktopAdapter(
  window: BrowserWindow,
  store: SettingsStore,
): NotificationAdapter {
  return {
    id: "desktop",
    async deliver(message) {
      const settings = store.get();
      const prefs = settings.approvals;
      if (prefs.flashDock && !window.isDestroyed()) {
        window.flashFrame(true);
        const timer = setTimeout(() => {
          if (!window.isDestroyed()) window.flashFrame(false);
        }, 1_800);
        timer.unref();
      }
      const wanted =
        message.kind === "reminder"
          ? settings.reminders.desktopNotifications
          : prefs.desktopNotifications;
      if (!wanted) return;
      if (process.env["PISTACHIO_E2E"] === "1" || !Notification.isSupported())
        return;
      const notice = new Notification({
        title: message.title,
        body: message.body,
        silent: message.kind !== "reminder",
      });
      notice.on("click", () => {
        if (window.isDestroyed()) return;
        window.show();
        window.focus();
        // A reminder lands in the console; that is where the click should go.
        if (message.kind === "reminder")
          sendShellCommand({ type: "openConsole" });
      });
      notice.show();
    },
  };
}

/**
 * What a reminder does to the outside world once the scheduler has
 * recorded it: a desktop notification under the reminder's own title,
 * and the console brought forward if the person asked for that. The
 * console card itself follows from the store's snapshot.
 */
function reminderExecutor(store: SettingsStore): ReminderExecutor {
  return {
    async runAgent(request) {
      // No window (macOS, every window closed): the task waits for one.
      if (runs === null) return { status: "busy" };
      return runs.startScheduled(request);
    },
    async notify(occurrence: ReminderOccurrence) {
      const prefs = store.get().reminders;
      if (prefs.openConsoleOnFire) sendShellCommand({ type: "openConsole" });
      const router = notifications;
      if (router === null) return;
      const body = (occurrence.output ?? occurrence.error ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const short = body.length > 200 ? `${body.slice(0, 197)}…` : body;
      const title =
        occurrence.status === "completed"
          ? `Done: ${occurrence.title}`
          : occurrence.status === "failed"
            ? `Couldn’t run: ${occurrence.title}`
            : occurrence.status === "missed"
              ? `Missed: ${occurrence.title}`
              : occurrence.title;
      await router.deliver({
        id: `reminder:${occurrence.id}:${occurrence.status}`,
        userId: "local-user",
        runId: occurrence.runId ?? occurrence.reminderId,
        kind: "reminder",
        title,
        body: short === "" ? "Open Pistachio to see it" : short,
        actionUrl: REMINDERS_URL,
        capabilityCeiling: [],
      });
    },
  };
}

/** The router the window's run controller and the reminder executor share. */
let notifications: NotificationRouter | null = null;

async function createWindow(): Promise<void> {
  const store = requireSettings();
  const initialSettings = store.get();
  const initialGlass = desktopGlassEnabled(initialSettings);
  const windowIcon =
    process.platform === "darwin" ? null : desktopIconPath(initialSettings.appearance.desktopIcon);
  const window = new BrowserWindow({
    width: 1450,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    show: false,
    title: app.isPackaged ? "Pistachio" : "Pistachio (dev)",
    // macOS takes the app icon from the dock (set at startup), not the window.
    ...(windowIcon !== null ? { icon: windowIcon } : {}),
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 15 },
    backgroundColor: windowBackground(initialSettings),
    // Transparency is a construction-time window property. Keep it available
    // on macOS and paint an opaque shell when glass is disabled, so switching
    // the setting never has to destroy and recreate the browser window.
    transparent: process.platform === "darwin",
    // CSS backdrop-filter cannot sample pixels outside Chromium. AppKit's
    // behind-window material is what actually blurs the macOS desktop; install
    // it at construction so the first visible frame is already glass.
    ...(initialGlass
      ? {
          vibrancy: DESKTOP_GLASS_MATERIAL,
          visualEffectState: "followWindow" as const,
        }
      : {}),
    webPreferences: {
      preload: join(currentDir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // This app-owned bridge needs the full preload runtime. Untrusted tab
      // contents remain isolated in sandboxed WebContentsViews with a tiny,
      // separate gesture-only preload.
      sandbox: false,
      // The shell bundle is large and identical across launches: keep its
      // compiled code in V8's cache without waiting for it to run hot.
      v8CacheOptions: "bypassHeatCheck",
    },
  });
  shellWindow = window;
  const preload = join(currentDir, "../preload/index.cjs");
  const tabPreload = join(currentDir, "../preload/tab.cjs");
  const dragView = new ChromeOverlayView(window, {
    id: "drag",
    preload,
  });
  const findView = new ChromeOverlayView(window, {
    id: "find",
    preload,
  });
  const bookmarkView = new ChromeOverlayView(window, {
    id: "bookmark",
    preload,
  });
  const noticeView = new ChromeOverlayView(window, {
    id: "notice",
    preload,
  });
  const notices = new NoticeLayer(noticeView, window, () => {
    if (browser?.focusActivePage() === true) return;
    if (!window.isDestroyed()) window.webContents.focus();
  });
  noticeLayer = notices;
  dragLayer = dragView;
  findLayer = findView;
  bookmarkLayer = bookmarkView;
  for (const contents of [
    window.webContents,
    dragView.webContents,
    findView.webContents,
    bookmarkView.webContents,
    noticeView.webContents,
  ]) {
    contents.on("before-input-event", (event, input) => {
      relayChromeInput(event, input);
    });
  }
  window.on("blur", () => {
    doubleShift.reset();
    if (!tabSwitcherChordActive) return;
    tabSwitcherChordActive = false;
    publishTabSwitcherInput({ type: "cancel" });
  });
  sidebarWatch = new SidebarWatch(window);
  paneToolbarWatch = new PaneToolbarWatch(window);
  syncSidebarEntryWatch();
  browser = new BrowserController(
    window,
    publish,
    () => {
      if (findView.shown) findView.raise();
      if (bookmarkView.shown) bookmarkView.raise();
      if (noticeView.shown) noticeView.raise();
      // Last, so a drag in progress keeps the pointer over a tab view that
      // was created under it.
      dragView.raise();
    },
    tabPreload,
    publishGlance,
    publishMedia,
    new BrowserPolicyStore(app.getPath("userData")),
    publishBrowserControls,
    publishFind,
    touchIdConfigured,
    requireSpaces(),
    requireTabSessions(),
    () => store.get(),
    relayChromeInput,
    readAloud,
    publishReadAloud,
    (spaceId, anchorId) =>
      isPresetAnchorId(anchorId) ||
      (sidebar !== null && favoriteOf(sidebar.get(spaceId), anchorId) !== null),
    reader,
    // Reader view bookmarks the ARTICLE's address, not the reader page's.
    async (url, title) => {
      await requireBookmarkService().create({ url, title }, { kind: "user", runId: null });
    },
    {
      onArchiveTab: (id, contents) => watchtower?.attach(id, contents),
      archiveResponse: (url, spaceId) => watchtower?.respond(url, spaceId) ?? null,
      // A group made by hand is named by the fast model from its tabs — under the same switch as
      // Tidy's grouping, since it sends the same thing: titles, and addresses without queries.
      nameTabGroup: nameTabGroupHook,
      // A spec that scripts the answer (PISTACHIO_FIND_SCRIPT) gets its script;
      // everything else gets the account's model, or none (docs/smart-find.md §9).
      findModel: () => scriptedFindModelFromEnv(process.env) ?? configuredIntentModel()?.model ?? null,
      prepareSpaceSession: async (target, spaceId, _kind, partition) => {
        if (egress !== null) await egress.applyProxy(target, spaceId, partition);
      },
      proxyCredentialFor: (spaceId) => egress?.proxyCredentialFor(spaceId) ?? null,
      onProxyCredentialRejected: () => void egress?.refreshCredential(),
      onSessionCreated: (target, spaceId, partition, kind) =>
        featureHandlers.lifecycle.onSessionCreated(target, spaceId, partition, kind),
      beginBulkCookieWrite: (spaceId) => featureHandlers.lifecycle.beginBulkCookieWrite(spaceId),
      endBulkCookieWrite: (spaceId) => featureHandlers.lifecycle.endBulkCookieWrite(spaceId),
      focusShell: () => {
        if (shellWindow === null || shellWindow.isDestroyed()) return;
        // A shown utility layer that is being typed into (the find bar, the
        // bookmark toast) keeps the keyboard: it is the shell's, drawn in a
        // view of its own.
        for (const layer of [findLayer, bookmarkLayer])
          if (layer !== null && layer.shown && !layer.webContents.isDestroyed() && layer.webContents.isFocused()) return;
        shellWindow.webContents.focus();
      },
    },
  );
  browser.onDownloadsChange = publishDownloads;
  // The drag layer covers the whole content box. Sizing it here — and on
  // every window resize — keeps it laid out BEFORE a gesture shows it: a
  // view resized while visible shows its last frame stretched until it
  // paints again (see ChromeOverlayView).
  const sizeDragLayer = (): void => {
    if (window.isDestroyed()) return;
    const { width, height } = window.getContentBounds();
    dragView.setSlot({ x: 0, y: 0, width, height });
  };
  sizeDragLayer();
  window.on("resize", sizeDragLayer);
  // Fullscreen keeps the traffic lights in the top-edge titlebar; leaving it
  // returns them to the compact sidebar's rule (applyWindowButtons).
  window.on("enter-full-screen", () => applyWindowButtons());
  window.on("leave-full-screen", () => applyWindowButtons(true));
  notifications = new NotificationRouter([desktopAdapter(window, store)]);
  runs = new RunController({
    browser,
    notifications,
    onChange: publishRun,
    settings: () => store.get(),
    memory: requireMemory(),
    reminders: requireReminders(),
    artifacts,
    watchtower,
    bookmarks: { store: requireBookmarks(), service: requireBookmarkService() },
    threads,
    // Cloud runs are steered through control (§10.4); null under E2E.
    cloud: cloudRuns,
    spaceId: () => requireSpaces().activeId(),
    artifactWebUrl: artifactWebOrigin,
    // Read per run: a connection made in Settings applies to the next turn.
    integrations: { hostsFor: (spaceId) => integrationService?.hostsFor(spaceId) ?? Promise.resolve([]) },
    onRunEnded: () => {
      // The turn is over and its answer is out: take the light off the pages
      // here rather than leave it to the publish that follows. The glow is
      // injected INTO each page, so a run that ends without one reaching it
      // would strand a lit page with no agent behind it.
      browser?.setAgentGlow(null);
      // The console freed up: a queued scheduled task can take it.
      void reminderScheduler?.tick();
    },
  });
  // The person's notes: read, searched and written by the agent's tools, and
  // the page in view when a note tab is in front (docs/notes.md §6).
  runs.setNoteStore(notes);
  // The conversation that was open when the app last quit comes back.
  runs.restore();
  const offMemory = requireMemory().onChange((next) => {
    if (!window.isDestroyed()) window.webContents.send(IPC.memoryChanged, next);
  });
  const offReminders = requireReminders().onChange((next) => {
    if (!window.isDestroyed())
      window.webContents.send(IPC.remindersChanged, next);
  });
  // The card's view reads the same file the page does: a completed
  // extraction reaches both in one push.
  const offBookmarks = requireBookmarks().onChange((next) => {
    if (!window.isDestroyed())
      window.webContents.send(IPC.bookmarksChanged, next);
    if (!bookmarkView.webContents.isDestroyed())
      bookmarkView.webContents.send(IPC.bookmarksChanged, next);
  });
  // Metadata only, so a keystroke in one note never serialises the library
  // (docs/notes.md §3); it is also how a note edited on another device
  // reaches an open editor.
  const offNotes = requireNotes().onChange((next) => {
    if (!window.isDestroyed()) window.webContents.send(IPC.notesChanged, next);
  });
  sidebarController = new SidebarController({
    store: requireSidebar(),
    browser,
    settings: () => store.get(),
  });
  const offSidebar = requireSidebar().onChange(publish);
  let paneMaterialSignature = nativePaneMaterialSignature(store.get());
  let windowMaterialSignature = nativeWindowMaterialSignature(store.get());
  let shortcutsSignature = JSON.stringify(store.get().shortcuts);
  const offSettings = store.onChange((next) => {
    if (window.isDestroyed()) return;
    window.webContents.send(IPC.settingsChanged, next);
    dragView.webContents.send(IPC.settingsChanged, next);
    findView.webContents.send(IPC.settingsChanged, next);
    bookmarkView.webContents.send(IPC.settingsChanged, next);
    const nextPaneMaterialSignature = nativePaneMaterialSignature(next);
    if (nextPaneMaterialSignature !== paneMaterialSignature) {
      paneMaterialSignature = nextPaneMaterialSignature;
      browser?.refreshAppearance();
    }
    const nextWindowMaterialSignature = nativeWindowMaterialSignature(next);
    if (nextWindowMaterialSignature !== windowMaterialSignature) {
      windowMaterialSignature = nextWindowMaterialSignature;
      applyWindowMaterial(window, next);
    }
    const nextShortcutsSignature = JSON.stringify(next.shortcuts);
    if (nextShortcutsSignature !== shortcutsSignature) {
      shortcutsSignature = nextShortcutsSignature;
      installMenu();
    }
    applyWindowButtons();
    syncSidebarEntryWatch();
  });

  // The drag layer takes the pointer for the WHOLE window, so it must never
  // outlive the gesture that showed it: a shell that reloaded mid-drag has
  // forgotten it started one, and a layer whose own renderer died can no
  // longer report the pointerup. Either way the window would be left unable
  // to take a click.
  window.webContents.on("did-finish-load", () => setDragCapture(null));
  dragView.webContents.on("render-process-gone", () => setDragCapture(null));

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  // The shell installs the React shortcut handler. The two utility views do
  // not, so main relays a configured binding caught there to the shell.
  dragView.webContents.on("before-input-event", nativeChromeShortcut);
  findView.webContents.on("before-input-event", nativeChromeShortcut);
  bookmarkView.webContents.on("before-input-event", nativeChromeShortcut);
  noticeView.webContents.on("before-input-event", nativeChromeShortcut);

  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  const rendererFile = join(currentDir, "../renderer/index.html");
  if (rendererUrl !== undefined) {
    await loadDevShell(window, rendererUrl);
  } else {
    await window.loadURL("pistachio-app://shell/index.html");
  }
  // The utility views load alongside the first tab but do not gate the first
  // frame: the drag layer is needed at the first gesture, the find layer at
  // the first ⌘F, and each loads its own small chunk of the renderer bundle.
  const utilityViews = Promise.all([
    dragView.load(rendererUrl, rendererFile),
    findView.load(rendererUrl, rendererFile),
  ]);
  await browser.initialize();
  startTabTidy(browser);
  publish();
  publishBrowserControls(browser.browserControls());
  publishFind(browser.findState());
  applyWindowButtons();
  window.show();
  void utilityViews;
  // The card is not needed until the first save: its view loads once the
  // window is up, off the path that gates the first frame and the first tab.
  void bookmarkView.load(rendererUrl, rendererFile).then(syncBookmarkLayer);
  // Nor the notice stack until the first notice; one said before its view
  // has loaded is handed over the moment it has.
  void noticeView.load(rendererUrl, rendererFile).then(() => notices.loaded());
  window.on("closed", () => {
    if (windowButtonHideTimer !== null) clearTimeout(windowButtonHideTimer);
    windowButtonHideTimer = null;
    offSettings();
    offMemory();
    offReminders();
    offBookmarks();
    offNotes();
    offSidebar();
    browser?.shutdown();
    sidebarController = null;
    dragView.destroy();
    findView.destroy();
    bookmarkView.destroy();
    notices.dispose();
    noticeView.destroy();
    noticeLayer = null;
    bookmarkService?.dismissToast();
    sidebarWatch?.dispose();
    sidebarWatch = null;
    paneToolbarWatch?.dispose();
    paneToolbarWatch = null;
    dragLayer = null;
    findLayer = null;
    bookmarkLayer = null;
    shellWindow = null;
    tabTidy?.stop();
    tabTidy = null;
    browser = null;
    // The controller goes with the window; the thread it held is written
    // and marked paused so the next window restores exactly that.
    runs?.shutdown();
    runs = null;
  });
}

function desktopGlassEnabled(settings: DesktopSettings): boolean {
  return process.platform === "darwin" && settings.appearance.desktopGlass;
}

function solidWindowBackground(settings: DesktopSettings): string {
  const dark =
    settings.appearance.scheme === "dark" ||
    (settings.appearance.scheme === "system" &&
      nativeTheme.shouldUseDarkColors);
  return dark ? "#191b1d" : "#f7f8f5";
}

function windowBackground(settings: DesktopSettings): string {
  return desktopGlassEnabled(settings)
    ? "#00000000"
    : solidWindowBackground(settings);
}

function nativePaneMaterialSignature(settings: DesktopSettings): string {
  // The palette is in here for the agent glow: it is painted inside the
  // pages, from the theme's own colours (BrowserController.refreshAppearance).
  return `${settings.appearance.scheme}:${settings.appearance.radius}:${settings.appearance.colors.join(",")}`;
}

function nativeWindowMaterialSignature(settings: DesktopSettings): string {
  return `${settings.appearance.scheme}:${settings.appearance.desktopGlass ? "glass" : "solid"}`;
}

function applyWindowMaterial(
  window: BrowserWindow,
  settings: DesktopSettings,
): void {
  window.setBackgroundColor(windowBackground(settings));
  if (process.platform === "darwin") {
    // This NSVisualEffectView uses behind-window blending, so it samples the
    // desktop and other windows instead of Chromium's own transparent surface.
    // The renderer adds only the selected tint/gradient above the native blur.
    window.setVibrancy(
      desktopGlassEnabled(settings) ? DESKTOP_GLASS_MATERIAL : null,
    );
    window.invalidateShadow();
  }
}

/** Configurable shortcuts for standalone chrome views that have no React host. */
function nativeChromeShortcut(
  event: Electron.Event,
  input: Electron.Input,
): void {
  if (
    input.type !== "keyDown" ||
    shellWindow === null ||
    shellWindow.isDestroyed()
  )
    return;
  const platform: ShortcutPlatform =
    process.platform === "darwin" ? "darwin" : "other";
  const action = shortcutActionForEvent(
    requireSettings().get().shortcuts,
    input,
    platform,
  );
  if (action === null) return;
  event.preventDefault();
  shellWindow.webContents.send(IPC.shellCommand, {
    type: "runShortcut",
    id: action,
  });
}

/**
 * The application menu, declared so that Electron's default one is not:
 * that one binds ⌘W to File › Close Window and ⌘R to View › Reload, and a
 * ⌘-key no page handled — one pressed while a tab's page or a chrome view
 * holds the keyboard — would fall through to them and close the whole
 * window or reload a renderer. This menu keeps the roles the app needs
 * (quit, the edit clipboard, the window controls, DevTools) and nothing
 * that shadows a tab shortcut.
 */
function installMenu(): void {
  const shortcuts = requireSettings().get().shortcuts;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          {
            label: "Find in Page",
            accelerator: shortcutAccelerator(shortcuts.find),
            click: () => requireBrowser().openFind(),
          },
          {
            label: "Find by Meaning",
            accelerator: shortcutAccelerator(shortcuts.smartFind),
            click: () => requireBrowser().openFind("smart"),
          },
          { type: "separator" },
          {
            label: "Zoom In",
            accelerator: shortcutAccelerator(shortcuts.zoomIn),
            click: () =>
              void requireBrowser().browserControl({ type: "zoomIn" }),
          },
          {
            label: "Zoom Out",
            accelerator: shortcutAccelerator(shortcuts.zoomOut),
            click: () =>
              void requireBrowser().browserControl({ type: "zoomOut" }),
          },
          {
            label: "Actual Size",
            accelerator: shortcutAccelerator(shortcuts.zoomReset),
            click: () =>
              void requireBrowser().browserControl({ type: "zoomReset" }),
          },
          { type: "separator" },
          {
            label: "Toggle Page Developer Tools",
            accelerator:
              process.platform === "darwin"
                ? "Alt+Command+I"
                : "Control+Shift+I",
            click: () => requireBrowser().togglePageDevTools(),
          },
          {
            label: "Toggle Pistachio Developer Tools",
            click: () => {
              if (shellWindow === null || shellWindow.isDestroyed()) return;
              shellWindow.webContents.toggleDevTools();
            },
          },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Page",
        submenu: [
          {
            label: "Copy URL",
            accelerator: shortcutAccelerator(shortcuts.copyUrl),
            click: () =>
              void requireBrowser().browserControl({
                type: "copyUrl",
                format: "plain",
              }),
          },
          {
            label: "Copy URL as Markdown",
            accelerator: shortcutAccelerator(shortcuts.copyUrlMarkdown),
            click: () =>
              void requireBrowser().browserControl({
                type: "copyUrl",
                format: "markdown",
              }),
          },
          { type: "separator" },
          {
            label: "Print…",
            accelerator: shortcutAccelerator(shortcuts.print),
            click: () =>
              void requireBrowser().browserControl({ type: "print" }),
          },
          { type: "separator" },
          {
            label: "Downloads",
            accelerator: shortcutAccelerator(shortcuts.openDownloads),
            click: () => sendShellCommand({ type: "toggleDownloads" }),
          },
          { type: "separator" },
          {
            // Archive idle tabs and group related ones, now (docs/tab-tidy.md §3.2).
            label: "Tidy Tabs",
            accelerator: shortcutAccelerator(shortcuts.tidyTabs),
            click: () => sendShellCommand({ type: "tidyTabs" }),
          },
          {
            label: "Archived Tabs",
            click: () => sendShellCommand({ type: "openArchive" }),
          },
          { type: "separator" },
          {
            // A blank note in a tab; there is nothing to save (docs/notes.md N8).
            label: "New Note",
            accelerator: shortcutAccelerator(shortcuts.newNote),
            click: () => sendShellCommand({ type: "newNote" }),
          },
          {
            label: "Notes",
            accelerator: shortcutAccelerator(shortcuts.openNotes),
            click: () => sendShellCommand({ type: "openNotes" }),
          },
        ],
      },
      { role: "windowMenu" },
    ]),
  );
}

/**
 * What the address bar asks when the typed words are prose
 * (docs/smart-suggestions.md). Both halves are read fresh on every
 * question: the setting can be turned off in the window that is asking,
 * and the model comes and goes with this Mac's enrollment.
 */
const addressIntent = new AddressIntentRanker({
  enabled: () => settings?.get().search.smartSuggestions ?? false,
  // A spec that scripts the answer (PISTACHIO_INTENT_SCRIPT) gets its script;
  // everything else gets the account's model, or none.
  model: () => scriptedIntentModel() ?? configuredIntentModel()?.model ?? null,
});

function installIpc(): void {
  ipcMain.handle(IPC.watchtower, async (event, value: unknown) => {
    if (!isShell(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error("Watchtower is shell-only.");
    if (!watchtower) throw new Error("Watchtower is starting.");
    const request = watchtowerRequestSchema.parse(value);
    const spaceId = requireBrowser().activeSpaceId();
    if (request.type === "export") {
      const result = await dialog.showOpenDialog({ title: "Export Watchtower as Markdown", properties: ["openDirectory", "createDirectory"] });
      if (result.canceled || !result.filePaths[0]) return { ...await watchtower.request(spaceId, { type: "status" }), exportPath: null };
      return watchtower.export(spaceId, join(result.filePaths[0], `Watchtower-${Date.now()}`));
    }
    return watchtower.request(spaceId, request);
  });
  ipcMain.handle(IPC.snapshot, () => {
    const browser = requireBrowser();
    return browser.snapshot(
      runs?.snapshot() ?? null,
      requireSidebar().get(browser.activeSpaceId()),
      runs?.threads() ?? [],
    );
  });
  ipcMain.handle(IPC.commandPaletteGet, (event) => {
    if (!isShell(event.sender))
      throw new Error("command palette data is shell-only");
    return requireBrowser().commandPaletteSnapshot();
  });
  ipcMain.handle(IPC.addressIntentRank, (event, request: unknown) => {
    if (!isShell(event.sender))
      throw new Error("address intent ranking is shell-only");
    return addressIntent.rank(event.sender.id, request);
  });
  ipcMain.handle(IPC.spaceSwitch, (_event, spaceId: unknown) =>
    requireBrowser().switchSpace(requireString(spaceId, "spaceId")),
  );
  ipcMain.handle(IPC.spaceFork, async (_event, value: unknown) => {
    const request = sanitizeForkSpaceRequest(value);
    if (request === null) throw new Error("Give the fork a name.");
    const result = await requireBrowser().forkSpace(request);
    requireSidebar().fork(
      result.parentSpaceId,
      result.spaceId,
      request.includeShelf,
    );
    publish();
    return result;
  });
  ipcMain.handle(IPC.tabCreate, (_event, url: unknown) => {
    // The reminders and bookmarks pages are chrome surfaces, not documents:
    // the address opens them in place rather than loading a tab.
    if (typeof url === "string" && (url === WATCHTOWER_URL || url === `${WATCHTOWER_URL}/`)) {
      sendShellCommand({ type: "openWatchtower" });
      return Promise.resolve();
    }
    if (typeof url === "string" && isRemindersUrl(url)) {
      sendShellCommand({ type: "openReminders" });
      return Promise.resolve();
    }
    if (typeof url === "string" && isBookmarksUrl(url)) {
      sendShellCommand({ type: "openBookmarks" });
      return Promise.resolve();
    }
    return requireBrowser()
      .createTab(typeof url === "string" ? url : newTabUrl())
      .then(() => undefined);
  });
  ipcMain.handle(IPC.tabClose, (_event, tabId: unknown) =>
    requireBrowser().closeTab(requireString(tabId, "tabId")),
  );
  ipcMain.handle(IPC.tabSelect, (_event, tabId: unknown) =>
    requireBrowser().selectTab(requireString(tabId, "tabId")),
  );
  ipcMain.handle(IPC.tabSuspend, (_event, tabId: unknown) =>
    requireBrowser().suspendTab(requireString(tabId, "tabId")),
  );
  ipcMain.handle(IPC.tabNavigate, (_event, tabId: unknown, url: unknown) => {
    const target = requireString(url, "url");
    if ((target === WATCHTOWER_URL || target === `${WATCHTOWER_URL}/`)) {
      sendShellCommand({ type: "openWatchtower" });
      return Promise.resolve();
    }
    if (isRemindersUrl(target)) {
      sendShellCommand({ type: "openReminders" });
      return Promise.resolve();
    }
    if (isBookmarksUrl(target)) {
      sendShellCommand({ type: "openBookmarks" });
      return Promise.resolve();
    }
    return requireBrowser()
      .navigate(requireString(tabId, "tabId"), target)
      .catch((error: unknown) => {
        // A load the network refused shows as the tab's error page (a
        // "This site can't be reached" document with Retry); the shell has
        // nothing to add. Anything else is still the shell's to report.
        if (!isLoadFailure(error)) throw error;
      });
  });
  ipcMain.handle(IPC.tabBack, (_event, tabId: unknown) =>
    requireBrowser().goBack(requireString(tabId, "tabId")),
  );
  ipcMain.handle(IPC.tabForward, (_event, tabId: unknown) =>
    requireBrowser().goForward(requireString(tabId, "tabId")),
  );
  ipcMain.handle(IPC.tabReload, (_event, tabId: unknown) =>
    requireBrowser().reload(requireString(tabId, "tabId")),
  );
  ipcMain.handle(IPC.splitSet, (_event, mode: unknown) =>
    requireBrowser().setSplit(requireSplitMode(mode)),
  );
  ipcMain.handle(IPC.tabReorder, (_event, tabId: unknown, index: unknown) => {
    requireBrowser().reorderTab(
      requireString(tabId, "tabId"),
      requireIndex(index),
    );
  });
  ipcMain.handle(IPC.tabSplitWith, (_event, tabId: unknown, side: unknown) =>
    requireBrowser().splitWith(
      requireString(tabId, "tabId"),
      requireSplitSide(side),
    ),
  );
  ipcMain.handle(IPC.tabRemoveFromSplit, (_event, tabId: unknown) => {
    requireBrowser().removeFromSplit(requireString(tabId, "tabId"));
  });
  ipcMain.handle(IPC.tabDuplicate, (_event, tabId: unknown) =>
    requireBrowser().duplicateTab(requireString(tabId, "tabId")),
  );
  ipcMain.handle(IPC.tabForcedFocus, (_event, tabId: unknown, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
    return requireBrowser().setForcedFocus(requireString(tabId, "tabId"), enabled);
  });
  ipcMain.handle(
    IPC.tabMoveToSpace,
    (_event, tabId: unknown, spaceId: unknown) =>
      requireBrowser().moveTabToSpace(
        requireString(tabId, "tabId"),
        requireString(spaceId, "spaceId"),
      ),
  );
  ipcMain.handle(IPC.tabRestoreClosed, () =>
    requireBrowser().restoreClosedTab(),
  );
  ipcMain.handle(IPC.tabsClearUnpinned, () =>
    requireBrowser().clearUnpinnedTabs(),
  );
  // ── Media: isolated tab observer → main-owned controls → shell stack ────
  ipcMain.handle(IPC.mediaGet, (event) =>
    isShell(event.sender) ? requireBrowser().media() : [],
  );
  ipcMain.on("pistachio:page-resume", (event, value: unknown) => {
    if (auth?.enrolled() !== true || event.senderFrame !== event.sender.mainFrame) return;
    browser?.acceptPageResume(event.sender.id, value);
  });
  ipcMain.on(IPC.mediaReport, (event, report: unknown) => {
    requireBrowser().acceptMediaReport(event.sender.id, report);
  });
  ipcMain.handle(IPC.readAloudGet, (event) =>
    isShell(event.sender) ? requireBrowser().readAloudJobs() : [],
  );
  ipcMain.handle(IPC.readerToggle, (_event, tabId: unknown) => {
    const browserNow = requireBrowser();
    const target =
      typeof tabId === "string" && tabId !== "" ? tabId : (browserNow.activeTab()?.id ?? null);
    if (target === null) return false;
    return browserNow.toggleReaderView(target);
  });
  ipcMain.handle(IPC.readAloudCancel, (event, id: unknown) => {
    if (!isShell(event.sender)) return;
    requireBrowser().cancelReadAloud(requireString(id, "read aloud id"));
  });
  ipcMain.handle(IPC.readAloudSpeak, async (event, text: unknown) => {
    if (!isShell(event.sender)) return;
    const browserNow = requireBrowser();
    // The player opens as a tab, so it needs a Space: the tab in view's.
    const tab = browserNow.activeTab();
    if (tab === null) throw new Error("There is no tab to play this in.");
    await browserNow.readAloud(requireString(text, "text"), { ...tab, title: "Pistachio" });
  });
  ipcMain.handle(
    IPC.mediaControl,
    (event, tabId: unknown, control: unknown) => {
      if (!isShell(event.sender)) return;
      if (!isMediaControl(control)) throw new Error("invalid media control");
      return requireBrowser().controlMedia(
        requireString(tabId, "tabId"),
        control,
      );
    },
  );
  ipcMain.on(IPC.mediaPreviewSet, (event, preview: unknown) => {
    if (!isShell(event.sender)) return;
    if (preview === null) {
      requireBrowser().setMediaPreview(null);
      return;
    }
    if (typeof preview !== "object" || preview === null) return;
    const candidate = preview as Record<string, unknown>;
    if (typeof candidate["tabId"] !== "string" || !isBounds(candidate["bounds"])) return;
    requireBrowser().setMediaPreview(candidate as unknown as MediaPreviewPlacement);
  });
  ipcMain.on(IPC.mediaPreviewHoverReport, (event, hovered: unknown) => {
    if (typeof hovered !== "boolean") return;
    requireBrowser().acceptMediaPreviewHover(event.sender.id, hovered);
  });
  ipcMain.handle(IPC.browserControlsGet, (event) => {
    if (!isShell(event.sender))
      throw new Error("browser controls are shell-only");
    return requireBrowser().browserControls();
  });
  ipcMain.handle(IPC.browserControl, (event, command: unknown) => {
    if (!isShell(event.sender) || !isBrowserControlCommand(command)) return;
    return requireBrowser().browserControl(command);
  });
  ipcMain.handle(IPC.downloadsGet, (event) => {
    if (!isShell(event.sender)) throw new Error("downloads are shell-only");
    return requireBrowser().downloads();
  });
  ipcMain.on(IPC.tabPolicyBlocked, (event, action: unknown) => {
    if (isGuardedBrowserAction(action))
      requireBrowser().acceptPolicyBlocked(event.sender.id, action);
  });
  ipcMain.on(IPC.tabPasskeySupportReport, (event, report: unknown) => {
    requireBrowser().acceptPasskeySupport(event.sender.id, report);
  });
  ipcMain.handle(IPC.findGet, () => requireBrowser().findState());
  ipcMain.handle(IPC.findCommand, (event, command: unknown) => {
    if (
      (isShell(event.sender) || chromeViewOf(event.sender) === "find") &&
      isFindCommand(command)
    ) {
      requireBrowser().find(command);
    }
  });
  ipcMain.handle(IPC.sidebarCommand, (_event, command: unknown) => {
    if (!isSidebarCommand(command)) throw new Error("invalid sidebar command");
    return requireSidebarController().run(command);
  });
  ipcMain.handle(IPC.tabGroupCommand, async (event, command: unknown): Promise<TabGroupCommandResult> => {
    if (!isShell(event.sender)) throw new Error("Tab groups are shell-only.");
    if (!isTabGroupCommand(command)) throw new Error("invalid tab group command");
    if (command.type !== "close") {
      await requireBrowser().tabGroupCommand(command);
      return { archivedEntryId: null };
    }
    // Closing a group files it whole, so it is one Restore away (docs/tab-tidy.md §3.5).
    const closed = await requireBrowser().closeTabGroup(command.groupId);
    if (closed === null || closed.tabs.length === 0 || tabArchive === null) return { archivedEntryId: null };
    const { title, color, origin } = closed.group;
    const [entry] = tabArchive.add([{ kind: "group", spaceId: closed.spaceId, reason: "closed", runId: null, group: { title, color, origin }, tabs: closed.tabs }]);
    return { archivedEntryId: entry?.id ?? null };
  });
  ipcMain.handle(IPC.tabArchive, async (event, request: unknown): Promise<TabArchiveResponse> => {
    if (!isShell(event.sender)) throw new Error("The tab archive is shell-only.");
    if (!isTabArchiveRequest(request) || tabArchive === null) throw new Error("invalid tab archive request");
    const archive = tabArchive;
    switch (request.type) {
      case "list":
        return { type: "list", entries: archive.list(request.spaceId).map(archiveEntryView), retentionDays: requireSettings().get().tabs.archiveRetentionDays };
      case "remove":
        return { type: "done", ok: archive.remove(request.entryId) !== null };
      case "clear":
        archive.clear(request.spaceId);
        return { type: "done", ok: true };
      case "restore": {
        const controller = requireBrowser();
        const entry = archive.get(request.entryId);
        if (entry === null) return { type: "done", ok: false };
        const spaceId = spaces?.get(entry.spaceId) === null ? controller.activeSpaceId() : entry.spaceId;
        let tabIds: string[];
        if (entry.kind === "group" && request.tabIndex !== undefined) {
          const tab = archive.removeGroupTab(entry.id, request.tabIndex);
          tabIds = tab === null ? [] : controller.restoreArchivedTabs(spaceId, [tab]);
        } else {
          archive.remove(entry.id);
          tabIds = controller.restoreArchivedTabs(spaceId, entry.kind === "tab" ? [entry.tab] : entry.tabs);
          if (entry.kind === "group") controller.createTabGroup({ ...entry.group, tabIds });
        }
        controller.commitTidy();
        const [first] = tabIds;
        if (first !== undefined && spaceId === controller.activeSpaceId()) await controller.selectTab(first);
        return { type: "done", ok: first !== undefined };
      }
    }
  });
  ipcMain.handle(IPC.tidy, async (event, request: unknown): Promise<TidyResponse> => {
    if (!isShell(event.sender)) throw new Error("Tidy is shell-only.");
    if (!isTidyRequest(request) || tabTidy === null) throw new Error("invalid tidy request");
    switch (request.type) {
      case "run":
        return { type: "ran", summary: await tabTidy.run(request.spaceId ?? requireBrowser().activeSpaceId(), "manual") };
      case "undo":
        return { type: "undone", ok: tabTidy.undo() };
      case "status":
        return { type: "status", ...tabTidy.status() };
    }
  });
  ipcMain.on(IPC.layoutSet, (_event, layout: BrowserLayout) => {
    requireBrowser().setLayout(layout);
    publishFind(requireBrowser().findState());
    syncBookmarkLayer();
  });
  ipcMain.handle(IPC.overlayPrepare, (event) =>
    isShell(event.sender) ? requireBrowser().prepareOverlay() : [],
  );
  ipcMain.handle(IPC.overlaySet, (event, active: unknown) => {
    if (isShell(event.sender)) requireBrowser().setOverlay(active === true);
  });
  ipcMain.handle(IPC.tabSwitcherPreviewsGet, (event) => {
    if (!isShell(event.sender)) return [];
    return requireBrowser().tabSwitcherPreviews();
  });
  // ── Glance: sandboxed tab gesture → main-owned view ↔ shell UI ─────
  ipcMain.handle(IPC.glanceGet, (event) =>
    isShell(event.sender) ? requireBrowser().glance() : null,
  );
  ipcMain.on(IPC.glanceOpenRequest, (event, request: unknown) => {
    if (!isGlanceOpenRequest(request)) return;
    void requireBrowser().openGlance(event.sender.id, request);
  });
  ipcMain.on(IPC.glanceIntent, (event, request: unknown) => {
    if (!isGlanceIntentRequest(request)) return;
    requireBrowser().recordGlanceIntent(event.sender.id, request.source);
  });
  ipcMain.handle(IPC.glanceOpenFromShell, (event, request: unknown) => {
    if (!isShell(event.sender) || !isShellGlanceOpenRequest(request))
      return false;
    return requireBrowser().openGlanceFromShell(request);
  });
  ipcMain.on(IPC.glanceDismissRequest, (event, hasFocused: unknown) => {
    if (!requireBrowser().acceptsGlanceDismiss(event.sender.id)) return;
    if (shellWindow !== null && !shellWindow.isDestroyed()) {
      shellWindow.webContents.send(
        IPC.glanceDismissRequested,
        hasFocused === true,
      );
    }
  });
  ipcMain.on(IPC.glanceOwnerRecede, (event) => {
    if (isShell(event.sender)) requireBrowser().recedeGlanceOwner();
  });
  ipcMain.on(IPC.glanceBoundsSet, (event, bounds: unknown) => {
    if (!isShell(event.sender) || (bounds !== null && !isBounds(bounds)))
      return;
    requireBrowser().setGlanceBounds(bounds as ContentBounds | null);
  });
  ipcMain.handle(IPC.glancePrepareClose, (event) =>
    isShell(event.sender) ? requireBrowser().prepareGlanceClose() : null,
  );
  ipcMain.handle(IPC.glancePromotionStage, (event, bounds: unknown) => {
    if (isShell(event.sender) && isBounds(bounds))
      requireBrowser().stageGlancePromotion(bounds);
  });
  ipcMain.handle(IPC.glanceClose, (event) => {
    if (isShell(event.sender)) requireBrowser().closeGlance();
  });
  ipcMain.handle(IPC.glancePromote, (event) => {
    if (isShell(event.sender)) requireBrowser().promoteGlance();
  });
  ipcMain.handle(IPC.glanceSplit, (event) => {
    if (isShell(event.sender)) requireBrowser().splitGlance();
  });
  // ── Shell and native utility views (@pistachio/shell-contracts/chrome) ──────────────────
  ipcMain.on(IPC.sidebarWatchSet, (event, box: unknown) => {
    if (!isShell(event.sender) || sidebarWatch === null) return;
    if (box !== null && !isBounds(box)) return;
    sidebarWatch.set(box as ContentBounds | null);
  });
  ipcMain.on(IPC.paneToolbarTriggerSet, (event, box: unknown) => {
    if (!isShell(event.sender) || paneToolbarWatch === null) return;
    if (box !== null && !isBounds(box)) return;
    paneToolbarWatch.setTrigger(box as ContentBounds | null);
  });
  ipcMain.on(IPC.paneToolbarWatchSet, (event, box: unknown) => {
    if (!isShell(event.sender) || paneToolbarWatch === null) return;
    if (box !== null && !isBounds(box)) return;
    paneToolbarWatch.setWatch(box as ContentBounds | null);
  });
  ipcMain.handle(IPC.cursorPoint, (event): CursorPoint | null => {
    if (!isShell(event.sender) || shellWindow === null) return null;
    return cursorPoint(shellWindow);
  });
  ipcMain.on(IPC.shellStateSet, (event, state: unknown) => {
    if (!isShell(event.sender) || !isShellState(state)) return;
    shellState = state;
    // The compact sidebar's column came or went: the traffic lights follow it.
    applyWindowButtons();
    syncSidebarEntryWatch();
    if (findLayer !== null) findLayer.setVeiled(state.veiled);
    syncBookmarkLayer();
  });
  // ── The drag layer: shell → main → layer, and the samples back ──────────
  ipcMain.on(IPC.dragCaptureSet, (event, cursor: unknown) => {
    if (!isShell(event.sender)) return;
    setDragCapture(
      cursor === null ? null : isDragCursor(cursor) ? cursor : "col-resize",
    );
  });
  ipcMain.on(IPC.tabDragVisualSet, (event, visual: unknown) => {
    if (!isShell(event.sender) || dragLayer === null) return;
    dragLayer.webContents.send(
      IPC.tabDragVisualChanged,
      visual === null || isTabDragVisual(visual) ? visual : null,
    );
  });
  ipcMain.on(IPC.dragSample, (event, sample: unknown) => {
    if (chromeViewOf(event.sender) !== "drag" || !isDragSample(sample)) return;
    if (shellWindow === null || shellWindow.isDestroyed()) return;
    shellWindow.webContents.send(IPC.dragSample, sample);
  });
  ipcMain.handle(
    IPC.runStart,
    (_event, intent: unknown, attachments: unknown, options: unknown) =>
      requireRuns().start(
        requireString(intent, "intent"),
        requireAttachments(attachments),
        turnOptions(options),
      ),
  );
  ipcMain.handle(
    IPC.runMessage,
    (_event, content: unknown, attachments: unknown, options: unknown) =>
      requireRuns().message(
        requireString(content, "content"),
        requireAttachments(attachments),
        turnOptions(options),
      ),
  );
  ipcMain.handle(
    IPC.runAnswer,
    (_event, questionId: unknown, answer: unknown) =>
      requireRuns().answerQuestion(
        requireString(questionId, "questionId"),
        requireString(answer, "answer"),
      ),
  );
  ipcMain.handle(IPC.runInterrupt, () => requireRuns().interrupt());
  ipcMain.handle(IPC.runRetry, () => requireRuns().retry());
  ipcMain.handle(IPC.runApprove, (_event, approvalId: unknown) =>
    requireRuns().approve(requireString(approvalId, "approvalId")),
  );
  ipcMain.handle(IPC.runReject, (_event, approvalId: unknown) =>
    requireRuns().reject(requireString(approvalId, "approvalId")),
  );
  ipcMain.handle(IPC.runTakeControl, () => requireRuns().takeControl());
  ipcMain.handle(IPC.runReleaseControl, () => requireRuns().releaseControl());
  ipcMain.handle(IPC.runRevoke, () => requireRuns().revoke());
  ipcMain.handle(IPC.threadOpen, (_event, runId: unknown) =>
    requireRuns().openThread(requireString(runId, "runId")),
  );
  ipcMain.handle(IPC.threadNew, () => requireRuns().newThread());
  ipcMain.handle(IPC.threadDelete, (_event, runId: unknown) =>
    requireRuns().deleteThread(requireString(runId, "runId")),
  );
  ipcMain.handle(IPC.evidenceGet, () => requireRuns().evidence());
  ipcMain.handle(
    IPC.feedbackSubmit,
    (event, input: unknown): Promise<FeedbackOutcome> => {
      if (!isShell(event.sender))
        return Promise.resolve({
          ok: false,
          error: "Feedback is sent from the console.",
        });
      const active = requireBrowser().activeTab();
      return submitFeedback(input, {
        app: appBuild(),
        browser: {
          activeTab:
            active === null ? null : { url: active.url, title: active.title },
          tabCount: requireBrowser().tabs().length,
        },
        run: runs?.snapshot() ?? null,
      });
    },
  );
  ipcMain.handle(IPC.settingsGet, () => requireSettings().get());
  ipcMain.handle(IPC.aiStatusGet, (event) => {
    if (!isShell(event.sender)) throw new Error("not the shell");
    return aiProviderStatus();
  });
  ipcMain.handle(IPC.aiUsageGet, (event) => {
    if (!isShell(event.sender)) throw new Error("not the shell");
    // An anonymous account has a meter too: its allowance is the cap it reports.
    return auth === null || !auth.modelsAvailable() ? null : auth.controlClient().aiUsage();
  });
  ipcMain.handle(IPC.settingsUpdate, (_event, patch: unknown) =>
    requireSettings().update(patch),
  );
  ipcMain.handle(IPC.settingsReset, () => requireSettings().reset());
  ipcMain.handle(IPC.memoryGet, () => requireMemory().snapshot());
  ipcMain.handle(IPC.memoryAdd, (_event, input: unknown) => {
    const sanitized = sanitizeMemoryAddInput(input);
    if (sanitized === null) throw new Error("a memory needs content");
    return requireMemory().add(sanitized, USER_MEMORY_SOURCE);
  });
  ipcMain.handle(IPC.memoryUpdate, (_event, id: unknown, patch: unknown) =>
    requireMemory().update(
      requireString(id, "id"),
      sanitizeMemoryUpdateInput(patch),
      USER_MEMORY_SOURCE,
    ),
  );
  ipcMain.handle(IPC.memoryForget, (_event, id: unknown, reason: unknown) =>
    requireMemory().forget(
      requireString(id, "id"),
      requireString(reason, "reason").slice(0, MAX_MEMORY_REASON),
      USER_MEMORY_SOURCE,
    ),
  );
  ipcMain.handle(IPC.memoryRestore, (_event, id: unknown) =>
    requireMemory().restore(requireString(id, "id")),
  );
  ipcMain.handle(IPC.memoryReview, (_event, id: unknown, decision: unknown) => {
    if (decision !== "approved" && decision !== "declined")
      throw new Error("decision must be approved or declined");
    return requireMemory().review(requireString(id, "id"), decision);
  });
  ipcMain.handle(IPC.memoryForgetAll, () =>
    requireMemory().forgetAll("Forgotten from Settings", USER_MEMORY_SOURCE),
  );
  ipcMain.handle(IPC.remindersGet, () => requireReminders().snapshot());
  ipcMain.handle(IPC.reminderAdd, (_event, input: unknown) => {
    const sanitized = sanitizeReminderInput(input);
    if (sanitized === null)
      throw new Error(
        "A reminder needs a schedule and something to say or do.",
      );
    return requireReminders().add(sanitized, USER_REMINDER_SOURCE);
  });
  ipcMain.handle(IPC.reminderUpdate, (_event, id: unknown, patch: unknown) =>
    requireReminders().update(
      requireString(id, "id"),
      sanitizeReminderPatch(patch),
      USER_REMINDER_SOURCE,
    ),
  );
  ipcMain.handle(IPC.reminderCancel, (_event, id: unknown) =>
    requireReminders().cancel(requireString(id, "id"), USER_REMINDER_SOURCE),
  );
  ipcMain.handle(IPC.reminderDelete, (_event, id: unknown) => {
    requireReminders().remove(requireString(id, "id"));
  });
  ipcMain.handle(IPC.reminderRunNow, async (_event, id: unknown) => {
    requireReminders().fireNow(requireString(id, "id"));
    await reminderScheduler?.tick();
  });
  ipcMain.handle(IPC.reminderAcknowledge, (_event, ids: unknown) => {
    if (ids === "all") return requireReminders().acknowledge("all");
    if (!Array.isArray(ids)) throw new Error('ids must be a list or "all"');
    return requireReminders().acknowledge(
      ids.map((id) => requireString(id, "id")),
    );
  });
  ipcMain.handle(
    IPC.reminderSnooze,
    (_event, occurrenceId: unknown, minutes: unknown) => {
      if (
        typeof minutes !== "number" ||
        !Number.isFinite(minutes) ||
        minutes < 1 ||
        minutes > 60 * 24 * 7
      ) {
        throw new Error("snooze minutes must be between 1 and a week");
      }
      return requireReminders().snooze(
        requireString(occurrenceId, "occurrenceId"),
        minutes,
        USER_REMINDER_SOURCE,
      );
    },
  );
  // ── Bookmarks: the store, the capture, and the card (@pistachio/shell-contracts/bookmarks) ─
  ipcMain.handle(IPC.bookmarksGet, () => requireBookmarks().snapshot());
  ipcMain.handle(IPC.bookmarkTab, (_event, tabId: unknown) =>
    requireBookmarkService().captureTab(
      typeof tabId === "string" && tabId !== "" ? tabId : undefined,
    ),
  );
  ipcMain.handle(IPC.bookmarkAdd, (_event, input: unknown) => {
    const sanitized = sanitizeBookmarkInput(input);
    if (sanitized === null) throw new Error("A bookmark needs a web address.");
    return requireBookmarkService().create(sanitized, {
      kind: "user",
      runId: null,
    });
  });
  ipcMain.handle(IPC.bookmarkUpdate, (_event, id: unknown, patch: unknown) =>
    requireBookmarks().update(
      requireString(id, "id"),
      sanitizeBookmarkPatch(patch),
    ),
  );
  ipcMain.handle(IPC.bookmarkDelete, (_event, id: unknown) => {
    const target = requireString(id, "id");
    const service = requireBookmarkService();
    if (service.toast()?.id === target) service.dismissToast();
    requireBookmarks().remove(target);
  });
  ipcMain.handle(IPC.bookmarkRefresh, (_event, id: unknown) =>
    requireBookmarkService().refresh(requireString(id, "id")),
  );
  ipcMain.handle(IPC.bookmarkToastGet, () => bookmarkService?.toast() ?? null);
  ipcMain.on(IPC.bookmarkToastDismiss, () => bookmarkService?.dismissToast());
  ipcMain.on(IPC.bookmarkToastResize, (event, height: unknown) => {
    if (chromeViewOf(event.sender) !== "bookmark") return;
    if (typeof height !== "number" || !Number.isFinite(height)) return;
    const next = Math.round(Math.min(720, Math.max(64, height)));
    if (next === bookmarkToastHeight) return;
    bookmarkToastHeight = next;
    syncBookmarkLayer();
  });
  // ── The notice stack: shell → main → view, and the view's clicks back ────
  ipcMain.on(IPC.noticesSet, (event, frame: unknown) => {
    if (!isShell(event.sender) || !isNoticeFrame(frame)) return;
    noticeLayer?.setFrame(frame);
  });
  ipcMain.handle(IPC.noticesGet, () => noticeLayer?.state() ?? EMPTY_NOTICE_STACK);
  ipcMain.on(IPC.noticeViewResize, (event, height: unknown) => {
    if (chromeViewOf(event.sender) !== "notice") return;
    if (typeof height !== "number" || !Number.isFinite(height)) return;
    noticeLayer?.resize(height);
  });
  ipcMain.on(IPC.noticeEvent, (event, noticeEvent: unknown) => {
    if (chromeViewOf(event.sender) !== "notice" || !isNoticeEvent(noticeEvent)) return;
    if (shellWindow === null || shellWindow.isDestroyed()) return;
    shellWindow.webContents.send(IPC.noticeEvent, noticeEvent);
  });
  ipcMain.on(IPC.bookmarksOpen, (_event, bookmarkId: unknown) => {
    bookmarkService?.dismissToast();
    sendShellCommand({
      type: "openBookmarks",
      ...(typeof bookmarkId === "string" && bookmarkId !== ""
        ? { bookmarkId }
        : {}),
    });
  });
  ipcMain.handle(IPC.browsingDataClear, async () => {
    const partition = session.fromPartition(
      spacePartition(requireBrowser().activeSpaceId()),
    );
    await partition.clearStorageData();
    await partition.clearCache();
  });
  ipcMain.handle(
    IPC.appInfo,
    (): AppInfo => ({
      ...appBuild(),
      userDataPath: app.getPath("userData"),
    }),
  );
  // ── Account, devices, sync, egress, cloud, channels (§10.5) ─────────────
  // Getters answer before sign-in and under PISTACHIO_E2E; every mutation is
  // shell-only. sync/workspaceSync/cloud/channels go through the seam in
  // main/feature-handlers.ts; account/devices/egress are wired here.
  const shellOnly = (event: Electron.IpcMainInvokeEvent, what: string): void => {
    if (!isShell(event.sender)) throw new Error(`${what} is shell-only`);
  };
  const requireAuth = (): AuthService => {
    if (auth === null) throw new Error(accountState().error ?? "Account features are off in this run.");
    return auth;
  };
  ipcMain.handle(IPC.accountGet, () => accountState());
  ipcMain.handle(IPC.accountSignUp, (event, email: unknown, password: unknown) => {
    shellOnly(event, "sign-up");
    return requireAuth().signUp(requireString(email, "email"), requireString(password, "password"));
  });
  ipcMain.handle(IPC.accountSignIn, (event, email: unknown, password: unknown) => {
    shellOnly(event, "sign-in");
    return requireAuth().signIn(requireString(email, "email"), requireString(password, "password"));
  });
  ipcMain.handle(IPC.accountEnroll, (event) => {
    shellOnly(event, "enroll");
    return requireAuth().enroll();
  });
  ipcMain.handle(IPC.accountSignOut, (event) => {
    shellOnly(event, "sign-out");
    return requireAuth().signOut();
  });
  ipcMain.handle(IPC.accountChangePassword, (event, current: unknown, next: unknown) => {
    shellOnly(event, "changing the password");
    return requireAuth().changePassword(
      requireString(current, "currentPassword"),
      requireString(next, "newPassword"),
    );
  });
  ipcMain.handle(IPC.accountRecoveryCode, (event) => {
    shellOnly(event, "the recovery code");
    return requireAuth().recoveryCode();
  });
  ipcMain.handle(IPC.devicesList, async () => (auth === null ? [] : auth.listDevices().catch(() => [])));
  ipcMain.handle(IPC.devicesRename, (event, deviceId: unknown, name: unknown) => {
    shellOnly(event, "renaming a device");
    return requireAuth().renameDevice(requireString(deviceId, "deviceId"), requireString(name, "name"));
  });
  ipcMain.handle(IPC.devicesRevoke, (event, deviceId: unknown) => {
    shellOnly(event, "revoking a device");
    return requireAuth().revokeDevice(requireString(deviceId, "deviceId"));
  });
  ipcMain.handle(IPC.devicesConfirmCloud, (event) => {
    shellOnly(event, "confirming the cloud device");
    return requireAuth().confirmCloudDevice();
  });
  ipcMain.handle(IPC.syncStatus, () => featureHandlers.sync.status());
  ipcMain.handle(IPC.syncOriginInfo, (_event, spaceId: unknown, host: unknown) =>
    featureHandlers.sync.originInfo(requireString(spaceId, "spaceId"), requireString(host, "host")),
  );
  ipcMain.handle(IPC.syncSetOriginOverride, (event, spaceId: unknown, host: unknown, override: unknown) => {
    shellOnly(event, "a sync override");
    if (override !== null && override !== "sync" && override !== "never") throw new Error("invalid override");
    return featureHandlers.sync.setOriginOverride(
      requireString(spaceId, "spaceId"),
      requireString(host, "host"),
      override as SyncOriginOverride | null,
    );
  });
  ipcMain.handle(IPC.syncRollbackOrigin, (event, spaceId: unknown, host: unknown) => {
    shellOnly(event, "a rollback");
    return featureHandlers.sync.rollbackOrigin(requireString(spaceId, "spaceId"), requireString(host, "host"));
  });
  ipcMain.handle(IPC.syncRetry, (event) => {
    shellOnly(event, "a sync retry");
    return featureHandlers.sync.retry();
  });
  ipcMain.handle(IPC.workspaceSyncGet, () => featureHandlers.workspaceSync.status());
  ipcMain.handle(IPC.workspaceSyncRun, (event, action: unknown) => {
    shellOnly(event, "workspace sync");
    if (typeof action !== "object" || action === null || typeof (action as { kind?: unknown }).kind !== "string")
      throw new Error("invalid workspace sync action");
    return featureHandlers.workspaceSync.run(action as WorkspaceSyncAction);
  });
  ipcMain.handle(IPC.egressStatus, () => egressStatus());
  ipcMain.handle(IPC.egressSetSpacePolicy, async (event, spaceId: unknown, policy: unknown) => {
    shellOnly(event, "the egress policy");
    const id = requireString(spaceId, "spaceId");
    if (!isSpaceEgressPolicy(policy)) throw new Error("invalid egress policy");
    if (egress !== null) return egress.setSpacePolicy(id, policy);
    if (requireSpaces().setEgressPolicy(id, policy) === null) throw new Error("unknown Space");
    const status = egressStatus();
    publishEgressStatus(status);
    return status;
  });
  ipcMain.handle(IPC.egressBrowseDirect, (event, spaceId: unknown) => {
    shellOnly(event, "browsing direct");
    if (egress === null) return egressStatus();
    return egress.browseDirect(requireString(spaceId, "spaceId"));
  });
  ipcMain.handle(IPC.cloudStatus, () => cloudStatus());
  ipcMain.handle(IPC.cloudEnable, async (event, spaceId: unknown) => {
    shellOnly(event, "enabling the cloud browser");
    await requireAuth().enableCloud(requireString(spaceId, "spaceId"));
    return cloudStatus();
  });
  ipcMain.handle(IPC.cloudDisable, async (event, spaceId: unknown) => {
    shellOnly(event, "disabling the cloud browser");
    await requireAuth().disableCloud(requireString(spaceId, "spaceId"));
    return cloudStatus();
  });
  ipcMain.handle(IPC.cloudStartRun, (event, request: unknown) => {
    shellOnly(event, "a cloud run");
    if (typeof request !== "object" || request === null) throw new Error("invalid run request");
    const raw = request as Record<string, unknown>;
    const input: CloudStartRunRequest = {
      intent: requireString(raw["intent"], "intent"),
      ...(typeof raw["spaceId"] === "string" ? { spaceId: raw["spaceId"] } : {}),
      ...(typeof raw["startUrl"] === "string" ? { startUrl: raw["startUrl"] } : {}),
      ...(raw["attachments"] === undefined ? {} : { attachments: requireAttachments(raw["attachments"]) }),
    };
    return featureHandlers.cloud.startRun(input);
  });
  ipcMain.handle(IPC.cloudLiveOpen, async (event, runId: unknown) => {
    shellOnly(event, "the live view");
    await featureHandlers.cloud.liveOpen(requireString(runId, "runId"));
    return cloudStatus();
  });
  ipcMain.handle(IPC.cloudLiveClose, (event) => {
    shellOnly(event, "the live view");
    return featureHandlers.cloud.liveClose();
  });
  ipcMain.on(IPC.cloudLiveInput, (event, input: unknown) => {
    if (!isShell(event.sender)) return;
    if (typeof input !== "object" || input === null || typeof (input as { t?: unknown }).t !== "string") return;
    featureHandlers.cloud.liveInput(input as CloudLiveInput);
  });
  ipcMain.handle(IPC.channelsList, () => featureHandlers.channels.list().catch(() => []));
  ipcMain.handle(IPC.channelsCreate, (event, request: unknown) => {
    shellOnly(event, "creating a channel");
    if (typeof request !== "object" || request === null) throw new Error("invalid channel request");
    const raw = request as Record<string, unknown>;
    const input: ChannelCreateRequest = {
      name: requireString(raw["name"], "name"),
      spaceId: requireString(raw["spaceId"], "spaceId"),
      ...(typeof raw["outboundUrl"] === "string" && raw["outboundUrl"] !== "" ? { outboundUrl: raw["outboundUrl"] } : {}),
    };
    return featureHandlers.channels.create(input);
  });
  ipcMain.handle(IPC.channelsDelete, (event, linkId: unknown) => {
    shellOnly(event, "deleting a channel");
    return featureHandlers.channels.delete(requireString(linkId, "linkId"));
  });
  ipcMain.handle(IPC.imessageGet, () =>
    auth === null || !auth.enrolled()
      ? { available: false, linked: false, phone: null, verifiedAt: null }
      : auth.controlClient().imessageLink(),
  );
  ipcMain.handle(IPC.imessageStart, (event, phone: unknown) => {
    shellOnly(event, "linking iMessage");
    return requireAuth().controlClient().startIMessageLink(requireString(phone, "phone"));
  });
  ipcMain.handle(IPC.imessageVerify, (event, challengeId: unknown, code: unknown) => {
    shellOnly(event, "verifying iMessage");
    return requireAuth().controlClient().verifyIMessageLink(
      requireString(challengeId, "challengeId"),
      requireString(code, "code"),
    );
  });
  ipcMain.handle(IPC.imessageUnlink, async (event) => {
    shellOnly(event, "unlinking iMessage");
    const control = requireAuth().controlClient();
    await control.unlinkIMessage();
    return control.imessageLink();
  });
  // ── Credential vault ────────────────────────────────────────────────
  // Values are opened on this side of the bridge with the Space key and
  // cross to the shell only on an explicit reveal or edit.
  const vault = new VaultService({
    control: () => requireAuth().controlClient(),
    spaceSecret: (spaceId) => deviceStore?.spaceSecret(spaceId) ?? null,
  });
  ipcMain.handle(IPC.credentialCaptureGet, (event, captureId: unknown) => {
    shellOnly(event, "loading a credential form");
    return requireAuth().controlClient().getCredentialCapture(requireString(captureId, "captureId"));
  });
  ipcMain.handle(IPC.credentialCaptureSubmit, (event, captureId: unknown, sealedPayload: unknown) => {
    shellOnly(event, "submitting encrypted credentials");
    const payload = requireString(sealedPayload, "sealedPayload");
    if (payload.length > 131_072) throw new Error("encrypted credential payload is too large");
    return requireAuth().controlClient().submitCredentialCapture(requireString(captureId, "captureId"), payload);
  });
  ipcMain.handle(IPC.vaultList, (event, spaceId: unknown) => {
    shellOnly(event, "reading the vault");
    return vault.list(requireString(spaceId, "spaceId"));
  });
  ipcMain.handle(IPC.vaultReveal, (event, spaceId: unknown, entryId: unknown) => {
    shellOnly(event, "revealing a vault entry");
    return vault.reveal(requireString(spaceId, "spaceId"), requireString(entryId, "entryId"));
  });
  ipcMain.handle(IPC.vaultSave, (event, spaceId: unknown, entryId: unknown, draft: unknown) => {
    shellOnly(event, "saving a vault entry");
    if (typeof draft !== "object" || draft === null) throw new Error("vault entry draft is required");
    return vault.save(
      requireString(spaceId, "spaceId"),
      entryId === null ? null : requireString(entryId, "entryId"),
      draft as VaultEntryDraft,
    );
  });
  ipcMain.handle(IPC.vaultDelete, (event, spaceId: unknown, entryId: unknown) => {
    shellOnly(event, "removing a vault entry");
    return vault.delete(requireString(spaceId, "spaceId"), requireString(entryId, "entryId"));
  });
  // ── Integrations (D29) ──────────────────────────────────────────────
  // The consent page opens as a tab of this browser — in the Space's own
  // session, so an account already signed in is one click — and the grant
  // is sealed on this side of the bridge before control ever sees it.
  const integrations = new IntegrationService({
    control: () => requireAuth().controlClient(),
    enrolled: () => auth?.enrolled() === true,
    spaceSecret: (spaceId) => deviceStore?.spaceSecret(spaceId) ?? null,
    openConsent: async (url, spaceId) => {
      // The Space being connected, not whichever one is showing: its cookie
      // jar is the account the person means, and it is where the grant is
      // sealed. Showing that Space first keeps the tab in front of them.
      const browser = requireBrowser();
      if (browser.activeSpaceId() !== spaceId) await browser.switchSpace(spaceId);
      const tabId = await browser.createTab(url, { spaceId, activate: true });
      sendShellCommand({ type: "closeSettings" });
      return () => {
        void requireBrowser().closeTab(tabId, { force: true }).catch(() => undefined);
        sendShellCommand({ type: "openSettings", section: "integrations" });
      };
    },
  });
  integrationService = integrations;
  ipcMain.handle(IPC.integrationProviders, () => integrations.providers());
  ipcMain.handle(IPC.integrationList, (event, spaceId: unknown) => {
    shellOnly(event, "listing integrations");
    return integrations.list(requireString(spaceId, "spaceId"));
  });
  ipcMain.handle(IPC.integrationConnect, (event, spaceId: unknown, provider: unknown, access: unknown) => {
    shellOnly(event, "connecting an integration");
    if (!isIntegrationProvider(provider)) throw new Error("unknown integration");
    if (!isIntegrationAccess(access)) throw new Error("unknown access level");
    return integrations.connect(requireString(spaceId, "spaceId"), provider, access);
  });
  ipcMain.handle(IPC.integrationSetAccess, (event, spaceId: unknown, connectionId: unknown, access: unknown) => {
    shellOnly(event, "changing an integration");
    if (!isIntegrationAccess(access)) throw new Error("unknown access level");
    return integrations.setAccess(requireString(spaceId, "spaceId"), requireString(connectionId, "connectionId"), access);
  });
  ipcMain.handle(IPC.integrationDisconnect, (event, spaceId: unknown, connectionId: unknown) => {
    shellOnly(event, "disconnecting an integration");
    return integrations.disconnect(requireString(spaceId, "spaceId"), requireString(connectionId, "connectionId"));
  });
  ipcMain.handle(IPC.integrationCalendarEvents, (event, spaceId: unknown, from: unknown, to: unknown) => {
    shellOnly(event, "reading the calendar");
    return integrations.calendarAgenda(requireString(spaceId, "spaceId"), requireString(from, "from"), requireString(to, "to"));
  });
  // ── Reports (docs/reports.md) ───────────────────────────────────────
  // The daily brief reads the same connections the home page's schedule
  // does, plus what this Mac already keeps: reminders, the archive, threads.
  // Under e2e the models stay off unless a spec asks for the live ones.
  const briefOffline = process.env["PISTACHIO_E2E"] === "1" && process.env["PISTACHIO_AGENT_LIVE"] !== "1";
  const briefs = new BriefService({
    userDataDir: app.getPath("userData"),
    enrolled: () => auth?.enrolled() === true,
    calendar: (spaceId, from, to) => integrations.calendarAgenda(spaceId, from, to),
    mail: (spaceId) => integrations.mailDigest(spaceId),
    reminders: () => reminders?.snapshot() ?? { reminders: [], occurrences: [] },
    watchtower: {
      settings: () => watchtower?.settings() ?? DEFAULT_WATCHTOWER_SETTINGS,
      request: (spaceId, request) => (watchtower === null ? Promise.reject(new Error("the archive is not running")) : watchtower.request(spaceId, request)),
    },
    threads: (spaceId) => {
      const store = threads;
      if (store === null) return [];
      const since = Date.now() - 2 * 86_400_000;
      return store
        .list()
        .filter((thread) => Date.parse(thread.updatedAt) >= since)
        .slice(0, 12)
        // A thread belongs to the Space it ran in; one written before Spaces carried an id belongs to none.
        .filter((thread) => store.get(thread.runId)?.spaceId === spaceId)
        .map((thread) => ({ id: thread.runId, title: thread.title, updatedAt: thread.updatedAt, status: thread.status }));
    },
    decide: () => (briefOffline ? null : configuredIntentModel()),
    write: () => (briefOffline ? null : configuredBriefModel()),
    scripted: () => scriptedBriefMaterials(),
    onGenerated: (record) => briefScheduler?.generated(record),
    onError: (error) => console.error("[brief]", error),
  });
  // The brief's clock (docs/reports.md "The morning brief"). The shell makes
  // a due brief when there is one to ask — it has the to-dos — and main makes
  // it alone when there is not.
  const scheduler = new BriefScheduler({
    userDataDir: app.getPath("userData"),
    schedule: () => {
      const general = requireSettings().get().general;
      return { enabled: general.morningBrief, time: general.morningBriefTime };
    },
    // The Space store, not the window's controller: closing the last window
    // leaves the app running with no controller, and the brief is still due.
    spaceId: () => browser?.activeSpaceId() ?? spaces?.activeId() ?? null,
    hasBrief: (spaceId, date) => briefs.has(spaceId, date),
    generating: (spaceId) => briefs.generating(spaceId),
    askShell: (spaceId) => {
      const window = shellWindow;
      if (window === null || window.isDestroyed() || window.webContents.isLoading()) return false;
      sendShellCommand({ type: "prepareBrief", spaceId });
      return true;
    },
    generate: (spaceId) => briefs.generateFromLastLocal(spaceId),
    announce: announceBrief,
    onError: (error) => console.error("[brief]", error),
  });
  briefScheduler = scheduler;
  // A Mac asleep at the hour makes the brief on waking; turning the schedule on, or moving it earlier, is looked at at once.
  powerMonitor.on("resume", () => scheduler.tick());
  powerMonitor.on("unlock-screen", () => scheduler.tick());
  requireSettings().onChange(() => scheduler.tick());
  ipcMain.handle(IPC.reports, (event, request: unknown) => {
    shellOnly(event, "reading the daily brief");
    return briefs.handle(request);
  });
  // ── Notes (@pistachio/shell-contracts/notes) ───────────────────────────
  ipcMain.handle(IPC.notes, (event, request: unknown) => {
    shellOnly(event, "the notes");
    return handleNoteRequest(request);
  });
  /**
   * A shell-drawn page naming its own tab (docs/notes.md §4): the note's
   * title on the strip, where the static placeholder document could only say
   * "Notes". Refused for any other address — a page must not be able to
   * relabel the tab a person is reading.
   */
  ipcMain.handle(IPC.setTabTitle, (event, tabId: unknown, title: unknown) => {
    shellOnly(event, "naming a tab");
    const id = requireString(tabId, "tabId");
    const tab = requireBrowser().tab(id);
    if (tab === null || !isShellPageUrl(tab.url)) throw new Error("only a shell page may name its own tab");
    const wanted = typeof title === "string" ? title.replace(/\s+/gu, " ").trim().slice(0, MAX_NOTE_TITLE) : "";
    requireBrowser().setShellPageTitle(id, wanted === "" ? NOTES_PAGE_TITLE : wanted);
  });
  // ── App updates (@pistachio/shell-contracts/updates) ────────────────────────────────────
  ipcMain.handle(IPC.updateGet, () => requireUpdates().state());
  ipcMain.handle(IPC.updateCheck, (event) =>
    isShell(event.sender) ? requireUpdates().check() : requireUpdates().state(),
  );
  ipcMain.handle(IPC.updateDownload, (event) =>
    isShell(event.sender) ? requireUpdates().download() : requireUpdates().state(),
  );
  ipcMain.on(IPC.updateInstall, (event) => {
    if (isShell(event.sender)) requireUpdates().install();
  });
  // ── First-run onboarding (@pistachio/shell-contracts/onboarding) ──────────────────────
  ipcMain.handle(IPC.browsersDetect, (event) =>
    isShell(event.sender) ? detectBrowsers() : [],
  );
  ipcMain.handle(IPC.browserImport, async (event, input: unknown) => {
    if (!isShell(event.sender)) throw new Error("import is shell-only");
    const requests = sanitizeBrowserImportRequests(input);
    if (requests === null)
      throw new Error("Choose at least one profile to bring over.");
    const spaceId = requireBrowser().activeSpaceId();
    // With the Space's proxy rules already in place (§10.3).
    const partition = await requireBrowser().prepareSpaceSession(spaceId);
    // One after another: profiles signed in to the same site both write its
    // cookies, and the order chosen decides which sign-in wins. Cookie
    // capture pauses for the bulk write (§10.2) and seeds what landed after.
    const results: BrowserImportResult[] = [];
    featureHandlers.lifecycle.beginBulkCookieWrite(spaceId);
    try {
      for (const request of requests) {
        const outcome = await importBrowserProfile(request, {
          session: partition,
        });
        if (outcome.entries.length > 0) {
          const shelf = requireSidebar();
          const state = shelf.get(spaceId);
          shelf.set(spaceId, {
            ...state,
            entries: [...state.entries, ...outcome.entries],
          });
        }
        results.push(outcome.result);
      }
    } finally {
      featureHandlers.lifecycle.endBulkCookieWrite(spaceId);
    }
    publish();
    return results;
  });
  ipcMain.handle(IPC.microphoneRequest, async (event) => {
    if (!isShell(event.sender)) return false;
    if (process.platform !== "darwin") return true;
    try {
      return await systemPreferences.askForMediaAccess("microphone");
    } catch {
      return false;
    }
  });
  ipcMain.handle(IPC.speechTranscribe, (event, input: unknown) => {
    if (!isShell(event.sender)) throw new Error("speech is shell-only");
    const { data, mediaType } = requireSpeechInput(input);
    return transcribeIntroduction(
      new Uint8Array(Buffer.from(data, "base64")),
      mediaType,
    );
  });
  ipcMain.handle(IPC.onboardingExtract, (event, transcript: unknown) => {
    if (!isShell(event.sender)) throw new Error("onboarding is shell-only");
    return extractIntake(
      requireString(transcript, "transcript").slice(0, MAX_INTRO_TRANSCRIPT),
    );
  });
  // Synchronous: the preload asks while the shell page loads, and the
  // renderer is blocked until `returnValue` is set — so it always is, even
  // for a sender that is not the shell or a store that is not ready.
  ipcMain.on(IPC.launchState, (event) => {
    let firstRun = false;
    try {
      firstRun = isShell(event.sender) && !requireSettings().get().onboarding.completed;
    } catch (error) {
      console.error("[onboarding] could not read launch state", error);
    }
    event.returnValue = { firstRun } satisfies ShellLaunchState;
  });
  ipcMain.handle(IPC.onboardingComplete, async (event, input: unknown) => {
    if (!isShell(event.sender)) throw new Error("onboarding is shell-only");
    const completion = sanitizeOnboardingCompletion(input);
    if (completion === null) throw new Error("nothing to finish");
    await completeOnboarding(completion);
  });
}

/**
 * Everything the wizard gathered, applied in one go: the introduction as
 * keyed memories (the same slots Settings → Memory edits), the first
 * Space named after its person, the chosen apps as favorites, the flag
 * that keeps the wizard from coming back, and the welcome tabs.
 */
async function completeOnboarding(
  completion: OnboardingCompletion,
): Promise<void> {
  const browser = requireBrowser();
  const memoryStore = requireMemory();
  const spaceId = browser.activeSpaceId();
  if (completion.name !== "") {
    memoryStore.add(
      {
        key: PROFILE_KEY.name,
        label: "Name",
        content: completion.name,
        kind: "static",
        bucket: "profile",
      },
      USER_MEMORY_SOURCE,
    );
  }
  if (completion.about !== "") {
    memoryStore.add(
      {
        key: PROFILE_KEY.about,
        label: "About",
        content: completion.about,
        kind: "static",
        bucket: "profile",
      },
      USER_MEMORY_SOURCE,
    );
  }
  for (const fact of completion.facts) {
    try {
      const key =
        fact.label !== null &&
        (fact.bucket === "location" || fact.bucket === "project")
          ? factKey(fact.bucket, fact.label)
          : null;
      memoryStore.add(
        {
          content: fact.content,
          bucket: fact.bucket,
          kind: fact.kind,
          label: fact.label,
          key,
        },
        USER_MEMORY_SOURCE,
      );
    } catch {
      // One refused fact (a secret, a clash) must not stop the rest.
    }
  }
  if (completion.spaceName !== null)
    requireSpaces().rename(spaceId, completion.spaceName);
  const shelf = requireSidebar();
  const state = shelf.get(spaceId);
  const taken = new Set(state.favorites.map((favorite) => favorite.url));
  const favorites: SidebarFavorite[] = [...state.favorites];
  // Catalog apps and sites typed in by hand, in the one order they were
  // picked — the order the wizard's preview showed them in.
  for (const pick of completion.favorites) {
    const appEntry = pick.kind === "app" ? favoriteApp(pick.id) : null;
    const site = pick.kind === "site" ? pick : appEntry === null ? null : { url: appEntry.url, title: appEntry.name };
    if (site === null || taken.has(site.url) || favorites.length >= MAX_FAVORITES) continue;
    taken.add(site.url);
    // A first icon for the grid: the site's own favicon replaces it the
    // moment its tab loads (SidebarStore.syncAnchor); until then a
    // catalog app should not sit there as a letter.
    favorites.push({
      id: randomUUID(),
      url: site.url,
      title: site.title,
      faviconUrl: seedFaviconUrl(site.url),
    });
  }
  shelf.set(spaceId, { ...state, favorites });
  // The web gate reads the account database. Finish that write before
  // dismissing this wizard; a failed save leaves setup open for retry.
  const accountCompletion = auth?.enrolled() === true
    ? await auth.controlClient().completeOnboarding()
    : null;
  if (completion.openWelcomeTabs) {
    for (const [index, tab] of WELCOME_TABS.entries()) {
      await browser.createTab(tab.url, { spaceId, activate: index === 0 });
    }
  }
  requireSettings().update({
    onboarding: { completed: true, completedAt: accountCompletion?.onboardingCompletedAt ?? new Date().toISOString() },
  });
  publish();
}

/** The favicon service's rendering of a catalog site, for a favorite whose page has not loaded yet. */
function seedFaviconUrl(url: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(url).host)}&sz=64`;
}

/** Where the welcome pages' videos live, if a directory for them exists (main/welcome-pages.ts). */
function welcomeAssetsDir(): string | null {
  const candidates = [
    process.env["PISTACHIO_WELCOME_ASSETS"],
    join(app.getAppPath(), "resources", "welcome"),
    join(app.getPath("userData"), "welcome"),
  ];
  return (
    candidates.find(
      (candidate): candidate is string =>
        candidate !== undefined && candidate !== "" && existsSync(candidate),
    ) ?? null
  );
}

/** A recording from the shell: base64 audio of a bounded size, and an audio media type. */
function requireSpeechInput(value: unknown): {
  data: string;
  mediaType: string;
} {
  if (typeof value !== "object" || value === null)
    throw new Error("no recording");
  const input = value as Record<string, unknown>;
  const data = input["data"];
  const mediaType = input["mediaType"];
  if (
    typeof data !== "string" ||
    data.length === 0 ||
    data.length > MAX_INTRO_AUDIO_BYTES * 1.4
  ) {
    throw new Error(
      "The recording is too long to send — keep it under a minute and a half.",
    );
  }
  if (
    typeof mediaType !== "string" ||
    !/^audio\/[\w.+-]+(;.*)?$/.test(mediaType)
  )
    throw new Error("not an audio recording");
  return { data, mediaType };
}

/**
 * Hand the pointer to the drag layer, or give it back. Unlike raising the
 * chrome, this leaves every tab view VISIBLE: the shell keeps re-reporting
 * its panes as the drag goes and main tracks the views to them, so the pages
 * reflow live instead of stretching a still (@pistachio/shell-contracts/chrome).
 */
function setDragCapture(cursor: DragCursor | null): void {
  const layer = dragLayer;
  if (layer === null || shellWindow === null || shellWindow.isDestroyed())
    return;
  layer.webContents.send(IPC.dragCaptureChanged, cursor);
  if (cursor !== null) {
    // Above the tab views and sidebar: nothing else may take the pointer for
    // this gesture.
    layer.raise();
    layer.setShown(true);
    return;
  }
  layer.setShown(false);
  layer.webContents.send(IPC.tabDragVisualChanged, null);
  // The pointerdown that ended over the layer left the keyboard there; a
  // A hidden utility view must never keep keyboard focus.
  if (layer.webContents.isFocused()) shellWindow.webContents.focus();
}

function isShell(sender: Electron.WebContents): boolean {
  return shellWindow !== null && sender.id === shellWindow.webContents.id;
}

/**
 * The build, as the About box and a feedback report name it.
 *
 * Spelled out rather than `Pick<AppInfo, …>`: `AppInfo.electron` is optional
 * on the contract because a session host has no Electron to name, while a
 * feedback report from THIS process always does — and the report's own type
 * requires it. What the desktop reports is unchanged either way.
 */
function appBuild(): {
  version: string;
  electron: string;
  chrome: string;
  platform: string;
} {
  return {
    version: app.getVersion(),
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    platform: `${process.platform} ${process.arch}`,
  };
}

/** Which chrome view a message came from, or null for anything else (the shell included). */
function chromeViewOf(sender: Electron.WebContents): ChromeViewId | null {
  if (dragLayer !== null && sender.id === dragLayer.webContents.id)
    return dragLayer.id;
  if (findLayer !== null && sender.id === findLayer.webContents.id)
    return findLayer.id;
  if (bookmarkLayer !== null && sender.id === bookmarkLayer.webContents.id)
    return bookmarkLayer.id;
  if (noticeLayer !== null && sender.id === noticeLayer.view.webContents.id)
    return noticeLayer.view.id;
  return null;
}

function isBounds(value: unknown): value is ContentBounds {
  if (typeof value !== "object" || value === null) return false;
  const box = value as Record<string, unknown>;
  return (["x", "y", "width", "height"] as const).every(
    (key) => typeof box[key] === "number" && Number.isFinite(box[key]),
  );
}

function isGlanceIntentRequest(value: unknown): value is GlanceIntentRequest {
  if (typeof value !== "object" || value === null) return false;
  return isBounds((value as Record<string, unknown>)["source"]);
}

function isGlanceOpenRequest(value: unknown): value is GlanceOpenRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request["url"] === "string" &&
    typeof request["automatic"] === "boolean" &&
    isBounds(request["source"])
  );
}

function isShellGlanceOpenRequest(
  value: unknown,
): value is ShellGlanceOpenRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return typeof request["url"] === "string" && isBounds(request["source"]);
}

function remindersPlaceholderHtml(): string {
  return `<!doctype html><meta charset="utf-8"><title>Reminders</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;color:#333;background:#f7f8f5;display:grid;place-items:center;height:100vh;margin:0}main{max-width:420px;text-align:center;padding:24px}h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#666}kbd{font:inherit;padding:1px 6px;border:1px solid #ccc;border-radius:4px;background:#fff}</style>
<main><h1>Reminders</h1><p>Reminders are a page of Pistachio itself. Press <kbd>⌘⇧R</kbd> or choose Reminders from the toolbar.</p></main>`;
}

function bookmarksPlaceholderHtml(): string {
  return `<!doctype html><meta charset="utf-8"><title>Bookmarks</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;color:#333;background:#f7f8f5;display:grid;place-items:center;height:100vh;margin:0}main{max-width:420px;text-align:center;padding:24px}h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#666}kbd{font:inherit;padding:1px 6px;border:1px solid #ccc;border-radius:4px;background:#fff}</style>
<main><h1>Bookmarks</h1><p>Bookmarks are a page of Pistachio itself. Press <kbd>⌘⇧B</kbd> or choose Bookmarks from the toolbar. Tap <kbd>⇧</kbd> twice on any page to save it.</p></main>`;
}

/** Where ⌘T lands when the renderer does not say: the configured page, or the home page. */
function newTabUrl(): string {
  const general = requireSettings().get().general;
  return general.newTab === "url" && general.newTabUrl !== ""
    ? general.newTabUrl
    : general.homeUrl;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * A dropped file arriving from the renderer. The renderer already refuses
 * anything larger, but this is the trust boundary, so the ceilings are
 * enforced here too — base64 costs ~4/3, plus room for the data: header.
 */
const MAX_ATTACHMENTS_PER_MESSAGE = 6;
const MAX_ATTACHMENT_URL_LENGTH = 6 * 1024 * 1024;

/** A console turn's options from the renderer; anything malformed is the default (page attached). */
function turnOptions(value: unknown): { page: boolean } {
  const page = typeof value === "object" && value !== null ? (value as { page?: unknown }).page : undefined;
  return { page: page !== false };
}

function requireAttachments(value: unknown): AgentAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("attachments must be an array");
  if (value.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(
      `at most ${String(MAX_ATTACHMENTS_PER_MESSAGE)} attachments per message`,
    );
  }
  return value.map((entry): AgentAttachment => {
    if (typeof entry !== "object" || entry === null)
      throw new Error("attachment must be an object");
    const record = entry as Record<string, unknown>;
    const url = record["url"];
    if (
      typeof url !== "string" ||
      !url.startsWith("data:") ||
      url.length > MAX_ATTACHMENT_URL_LENGTH
    ) {
      throw new Error("attachment url must be a data: URL under 6 MB");
    }
    return {
      id: requireString(record["id"], "attachment id"),
      name: requireString(record["name"], "attachment name"),
      mediaType: requireString(record["mediaType"], "attachment mediaType"),
      url,
    };
  });
}

function requireIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("index must be a non-negative integer");
  }
  return value;
}

function requireSplitSide(value: unknown): SplitSide {
  if (
    value !== "left" &&
    value !== "right" &&
    value !== "top" &&
    value !== "bottom"
  )
    throw new Error("invalid split side");
  return value;
}

function requireSplitMode(value: unknown): SplitMode {
  if (
    value !== "single" &&
    value !== "vertical" &&
    value !== "horizontal" &&
    value !== "grid"
  ) {
    throw new Error("invalid split mode");
  }
  return value;
}

/**
 * The dev shell comes over HTTP from Vite, so its one load goes through the
 * network service — and a dev launch is when that service is likeliest to be
 * restarted under it. The dev Electron shares the installed app's "Pistachio
 * Safe Storage" Keychain item but not its signature, so macOS answers the
 * first read with a password prompt; while that is up the service stalls,
 * Chromium restarts it, and the pending load rejects with ERR_FAILED. Left
 * at that, the window stays empty for the life of the process and the only
 * way out is to relaunch. So the dev load is tried again until it lands. A
 * packaged shell loads from its own scheme and never takes this path.
 */
const DEV_SHELL_LOAD_ATTEMPTS = 20;
const DEV_SHELL_RETRY_MS = 1_500;
async function loadDevShell(window: BrowserWindow, url: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await window.loadURL(url);
      return;
    } catch (error) {
      if (attempt >= DEV_SHELL_LOAD_ATTEMPTS || window.isDestroyed()) throw error;
      console.warn(
        `The dev shell did not load (${error instanceof Error ? error.message : String(error)}); trying again.`,
      );
      await new Promise((resolve) => setTimeout(resolve, DEV_SHELL_RETRY_MS));
    }
  }
}

// package.json "productName" names the packaged app (and its userData dir)
// "Pistachio". A dev run keeps its historical "@pistachio/desktop" directory,
// so it never shares a profile or the single-instance lock with an installed
// build, and so an installed build can run beside `pnpm dev`.
if (!app.isPackaged)
  app.setPath(
    "userData",
    join(app.getPath("appData"), "@pistachio", "desktop"),
  );

// Tests point userData at a scratch directory so a run never reads or writes
// the person's real settings file.
const userDataOverride = process.env["PISTACHIO_USER_DATA"];
if (userDataOverride !== undefined && userDataOverride !== "")
  app.setPath("userData", userDataOverride);

// Two Chromium processes must never mutate the same persistent Space session.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

/**
 * A CONNECT proxy tunnels TCP only: with QUIC on, Chromium would race HTTP/3
 * over UDP straight past the identity gateway and leak the real IP (D13).
 * The switch only counts before app ready, so it is keyed off the raw
 * spaces.json here; a Space switched to identity later browses direct until
 * the next launch and says so (EgressStatus.restartRequired).
 */
const quicDisabledAtStartup =
  featureEnabled && spacesFileHasIdentitySpace(join(app.getPath("userData"), "spaces.json"));
if (quicDisabledAtStartup) app.commandLine.appendSwitch("disable-quic");
if (featureEnabled) {
  // WebRTC never learns the real address either: only proxied UDP, which a
  // CONNECT proxy has none of.
  app.on("web-contents-created", (_event, contents) => {
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  });
}

/**
 * The Chromium lock alone does not keep that invariant: an orphaned run —
 * a dev server that died without its Electron — keeps the profile's
 * databases open, but its singleton socket lives in a temp directory the
 * OS may clean, so the next launch judges the lock stale, steals it, and
 * both processes mutate the same Space session. That is exactly the state
 * that leaves storage-hungry sites (x.com) hanging on their splash.
 *
 * So the winner of the Chromium lock also checks a pid file. A recorded
 * pid that is still alive *and* still an Electron is that unreachable
 * stray — unreachable, because a reachable one would have won the socket
 * race and this process would have quit above — and it is killed rather
 * than shared with. SIGKILL is safe here: Chromium's stores are
 * crash-safe, and the stray's helpers exit on their own once the browser
 * process dies.
 */
function reapStaleInstance(): void {
  const pidPath = join(app.getPath("userData"), "instance.pid");
  try {
    const recorded = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    if (Number.isInteger(recorded) && recorded > 0 && recorded !== process.pid && process.platform !== "win32") {
      const command = execFileSync("ps", ["-o", "command=", "-p", String(recorded)], {
        encoding: "utf8",
      });
      if (command.includes("Electron")) {
        process.kill(recorded, "SIGKILL");
        console.warn(
          `Killed stray Pistachio instance ${String(recorded)} that was still holding this profile.`,
        );
      }
    }
  } catch {
    // No pid file, or the recorded process is gone: nothing to reap.
  }
  try {
    writeFileSync(pidPath, String(process.pid));
  } catch {
    // A profile that cannot record a pid still runs; the guard just lapses.
  }
}
if (hasSingleInstanceLock) {
  reapStaleInstance();
  app.on("will-quit", () => {
    const pidPath = join(app.getPath("userData"), "instance.pid");
    try {
      // Only this process's own registration is cleaned up: a successor
      // that already took over the file keeps its record.
      if (readFileSync(pidPath, "utf8").trim() === String(process.pid)) unlinkSync(pidPath);
    } catch {
      // Already gone.
    }
  });
}
app.on("second-instance", () => {
  if (shellWindow === null || shellWindow.isDestroyed()) return;
  if (shellWindow.isMinimized()) shellWindow.restore();
  shellWindow.show();
  shellWindow.focus();
});

/** `<TEAM_ID>.<BUNDLE_ID>.webauthn`, matching entitlements.mac.plist. */
const DEFAULT_WEBAUTHN_ACCESS_GROUP =
  "PHSRT54C87.run.pistachio.desktop.webauthn";

function configurePlatformPasskeys(): boolean {
  if (process.platform !== "darwin") return false;
  // Packaged builds are signed with the keychain-access-groups entitlement in
  // entitlements.mac.plist, so they default to that group. Dev runs on the
  // unsigned stock Electron binary and stays opt-in via the env variable.
  const keychainAccessGroup =
    process.env["PISTACHIO_WEBAUTHN_ACCESS_GROUP"]?.trim() ||
    (app.isPackaged ? DEFAULT_WEBAUTHN_ACCESS_GROUP : "");
  if (keychainAccessGroup === "") return false;
  if (!/^[A-Za-z0-9.-]{3,255}$/.test(keychainAccessGroup)) {
    throw new Error(
      "PISTACHIO_WEBAUTHN_ACCESS_GROUP is not a valid keychain access group",
    );
  }
  app.configureWebAuthn({
    touchID: {
      keychainAccessGroup,
      promptReason: "sign in to $1",
    },
  });
  return true;
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  touchIdConfigured = configurePlatformPasskeys();
  // The trusted shell has its own origin. Sites always run in native tab views.
  protocol.handle("pistachio-app", request => {
    const url = new URL(request.url);
    const root = resolve(currentDir, "../renderer");
    const target = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    const path = relative(root, target);
    if (url.hostname !== "shell" || path.startsWith("..") || isAbsolute(path)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(target).href);
  });
  protocol.handle("pistachio", (request) => {
    const url = new URL(request.url);
    const archived = browser ? watchtower?.respond(url, browser.activeSpaceId()) : null;
    if (archived) return archived;
    const spoken = readAloud.respond(url, request.headers);
    if (spoken !== null) return spoken;
    const read = reader.respond(url, request);
    if (read !== null) return read;
    const welcome = welcomePageResponse(url);
    if (welcome !== null) return welcome;
    const artifact = artifactResponse(url);
    if (artifact !== null) return artifact;
    if (url.host === "demo" && url.pathname === "/invoices") {
      return new Response(demoPortalHtml(), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.host === "demo" && url.pathname === "/vendors/atlas-medical") {
      return new Response(demoVendorHtml(), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.host === "demo" && url.pathname === "/auth/relying-party") {
      return new Response(demoAuthRelyingPartyHtml(), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.host === "accounts" && url.pathname === "/oauth/google") {
      return new Response(
        demoOAuthHtml(url.searchParams.get("flow") ?? "youtube"),
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      );
    }
    if (url.host === "demo" && url.pathname === "/oauth/callback") {
      return new Response(
        demoOAuthCallbackHtml(url.searchParams.get("flow") ?? "youtube"),
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      );
    }
    if (url.host === "reminders") {
      // The page itself is chrome (the address opens it in place); this is
      // what a tab shows if something loads the address as a document.
      return new Response(remindersPlaceholderHtml(), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.host === "bookmarks") {
      return new Response(bookmarksPlaceholderHtml(), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.host === "demo" && url.pathname === "/media/test.wav") {
      return new Response(new Blob([demoToneWav()], { type: "audio/wav" }), {
        status: 200,
        headers: {
          "content-type": "audio/wav",
          "cache-control": "public, max-age=3600",
        },
      });
    }
    return new Response("Not found", { status: 404 });
  });
  settings = new SettingsStore(app.getPath("userData"));
  let desktopIcon = settings.get().appearance.desktopIcon;
  applyDesktopIcon(desktopIcon);
  settings.onChange((next) => {
    if (next.appearance.desktopIcon === desktopIcon) return;
    desktopIcon = next.appearance.desktopIcon;
    applyDesktopIcon(desktopIcon);
  });
  // Playwright starts every run from an empty userData; the wizard would
  // stand in front of every test. Only its own spec asks for it.
  if (
    process.env["PISTACHIO_E2E"] === "1" &&
    process.env["PISTACHIO_ONBOARDING"] !== "1" &&
    !settings.get().onboarding.completed
  ) {
    settings.update({ onboarding: { completed: true, completedAt: null } });
  }
  memory = new MemoryStore(app.getPath("userData"), {
    embedder: createMemoryEmbedder(),
    embeddingEnabled: settings.get().memory.enabled,
  });
  settings.onChange((next) => memory?.setEmbeddingEnabled(next.memory.enabled));
  reminders = new ReminderStore(app.getPath("userData"), {
    timezone: () => runs?.timezone() ?? "UTC",
  });
  const reminderSettings = settings;
  reminderScheduler = new ReminderScheduler(
    reminders,
    reminderExecutor(reminderSettings),
    {
      enabled: () => reminderSettings.get().reminders.enabled,
      onError: (error) => {
        console.error("[reminders]", error);
      },
    },
  );
  // Turning reminders back on looks at the clock at once.
  settings.onChange((next) => {
    if (next.reminders.enabled) void reminderScheduler?.tick();
  });
  // A Mac that slept through a fire catches up on waking, not a tick later.
  powerMonitor.on("resume", () => void reminderScheduler?.tick());
  powerMonitor.on("unlock-screen", () => void reminderScheduler?.tick());
  // The morning case: tabs went idle while the Mac slept, and Tidy should
  // not wait out another minute of the sweep to notice (docs/tab-tidy.md §3.1).
  powerMonitor.on("resume", () => void tabTidy?.sweep());
  powerMonitor.on("unlock-screen", () => void tabTidy?.sweep());
  artifacts = new ArtifactStore(app.getPath("userData"), { webUrl: artifactWebOrigin });
  notes = new NoteStore(app.getPath("userData"));
  // A picture an edit orphaned is collected a day later, not at once: ⌘Z puts
  // the image node back, and a blob taken the moment its last reference went
  // would come back as a broken box. Idle timers, unref'd, so a sweep never
  // holds the app open (the reminder and brief schedulers keep the same rule).
  const sweepNoteBlobs = (): void => {
    try {
      const swept = notes?.sweepOrphanBlobs() ?? [];
      if (swept.length > 0) console.log(`[notes] collected ${String(swept.length)} unreferenced image(s)`);
    } catch (error) {
      console.error("[notes] could not collect unreferenced images", error);
    }
  };
  setTimeout(sweepNoteBlobs, NOTE_BLOB_SWEEP_DELAY_MS).unref();
  setInterval(sweepNoteBlobs, NOTE_BLOB_SWEEP_INTERVAL_MS).unref();
  threads = new ThreadStore(app.getPath("userData"));
  setArtifactStore(artifacts);
  watchtower = new WatchtowerService(app.getPath("userData"), join(currentDir, "watchtower-worker.js"), () => browser?.watchtowerSources() ?? []);
  bookmarks = new BookmarkStore(app.getPath("userData"));
  const bookmarkSettings = settings;
  bookmarkService = new BookmarkService({
    store: bookmarks,
    // Reached through the live browser, which comes and goes with the window.
    reader: () => {
      const live = browser;
      if (live === null) return null;
      return {
        activeTab: () => live.activeTab(),
        tab: (tabId) => live.tab(tabId),
        allTabs: () => live.allTabs(),
        capturePage: (tabId) => live.capturePage(tabId),
        fetchHtml: (url) => live.fetchPageHtml(url),
      };
    },
    useModel: () => bookmarkSettings.get().bookmarks.enrichWithModel,
    onToast: publishBookmarkToast,
  });
  sidebar = new SidebarStore(app.getPath("userData"));
  tabArchive = new TabArchiveStore(app.getPath("userData"), () => requireSettings().get().tabs.archiveRetentionDays);
  spaces = new SpaceStore(app.getPath("userData"));
  setWelcomeContext(() => ({
    name: memory?.profile().name ?? "",
    appearance: requireSettings().get().appearance,
    shortcuts: requireSettings().get().shortcuts,
    platform: process.platform === "darwin" ? "darwin" : "other",
    assetsDir: welcomeAssetsDir(),
    systemDark: nativeTheme.shouldUseDarkColors,
  }));
  tabSessions = new TabSessionStore(
    app.getPath("userData"),
    () =>
      new Set(
        requireSpaces()
          .all()
          .map((space) => space.id),
      ),
  );
  nativeTheme.on("updated", () => {
    if (shellWindow !== null && !shellWindow.isDestroyed())
      applyWindowMaterial(shellWindow, requireSettings().get());
    browser?.refreshAppearance();
  });
  // Account, egress, and the feature seam (docs/cloud-sync-design.md §10),
  // before the window so the `login` listener precedes the first page.
  if (featureEnabled) await initializeAccountServices();
  updates = new UpdateService({
    publish: (state) => {
      if (shellWindow !== null && !shellWindow.isDestroyed())
        shellWindow.webContents.send(IPC.updateChanged, state);
    },
    focusUpdates: async () => {
      // Checks outlive the last window on macOS; a click on the notification
      // then needs a window before it has anywhere to open About. createWindow
      // resolves once the shell has loaded, so the command has a listener.
      if (shellWindow === null || shellWindow.isDestroyed()) await createWindow();
      if (shellWindow === null || shellWindow.isDestroyed()) return;
      shellWindow.show();
      shellWindow.focus();
      sendShellCommand({ type: "openSettings", section: "about" });
    },
  });
  installMenu();
  installIpc();
  await createWindow();
  void reminderScheduler.start();
  briefScheduler?.start();
  updates.start();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// The open thread's last changes are still coalescing; write them before the process goes.
app.on("before-quit", () => {
  briefScheduler?.stop();
  watchtower?.close();
  runs?.flush();
  sidebar?.flush();
  tabArchive?.flush();
  auth?.shutdown();
  featureHandlers.lifecycle.flush();
});
