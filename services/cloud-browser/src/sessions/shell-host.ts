import { boundPageResumes, capturePageResume, restorePageResume, sanitizePageResume, type PageResumeState } from "@pistachio/shell-contracts/page-resume";
/**
 * `ShellHost` — the worker's counterpart of Electron main, for one browser
 * session (docs/web-browser-design.md W3, §6.3).
 *
 * The desktop's main process is the source of truth for `ShellSnapshot`, owns
 * the stores, and executes every `PistachioApi` call. On the web the page is
 * only chrome: it subscribes to snapshots and sends commands, and this object
 * is what answers them. It implements `ShellApi` — the half of the surface
 * that does not need an Electron window or a `WebContentsView` (W6) — and it
 * follows the same publishing rules as main (docs/architecture.md, "How state
 * reaches the shell"): one coalesced flush per tick, the tab side and the run
 * side on separate channels, and `getSnapshot` answering whole.
 *
 * What it deliberately does NOT do is pretend. Every member it does not
 * implement answers `unsupported` and is named in `UNSUPPORTED` below with
 * the stage that will, so the list is a thing a reader can watch shrink
 * rather than a surprise a person meets as a dead button.
 *
 * Tab ids are the HOST's, not the backend's. A suspended tab has no Chromium
 * page at all (§6.3: "the page is closed and the durable tab kept"), and
 * waking it opens a new one — so if the shell's id were the backend's, every
 * sleep would rename the tab, break the session record, and lose the split
 * group it was in.
 */

import { randomUUID } from "node:crypto";
import type { BrowserContext, FileChooser, Page } from "playwright-core";
import {
  SMART_FIND_ADOPT_STYLE_SCRIPT,
  SMART_FIND_CLEAR_SCRIPT,
  SmartFindSession,
  smartFindCollectScript,
  smartFindPaintScript,
} from "@pistachio/smart-find";
import type { AgentTabInfo } from "@pistachio/agent-runtime";
import { evaluateAddressIntent } from "@pistachio/agent-runtime/address-intent";
import {
  sanitizeAddressIntentRequest,
  type AddressIntentRanking,
  type AddressIntentRequest,
} from "@pistachio/shell-contracts/address-intent";
import type { Experimental_EvaluationModel } from "ai";
import type { EvidenceEntry } from "@pistachio/evidence";
import type {
  AgentAttachment,
  RunContentEvent,
  RunControlEvent,
  RunSummary,
  StoredRunEvent,
  ThreadListItem,
} from "@pistachio/protocol";
import { isTerminalStatus } from "@pistachio/protocol";
import {
  foldRunInto,
  parseContentEvent,
  parseStoredRunEvent,
  webStartUrl,
} from "@pistachio/shell-contracts/run-fold";
import type {
  AppInfo,
  BrowserTabInfo,
  CloudLiveInput,
  CloudStartRunRequest,
  CommandPaletteSnapshot,
  RecentlyClosedTabInfo,
  ShellApi,
  ShellRunSnapshot,
  ShellSnapshot,
  ShellGlanceOpenRequest,
  ShellTabsSnapshot,
  SpaceInfo,
  SplitGroupInfo,
  SplitMode,
  SplitSide,
  TabSwitcherPreview,
} from "@pistachio/shell-contracts/ipc";
import {
  BROWSER_PERMISSIONS,
  GUARDED_BROWSER_ACTIONS,
  browserOrigin,
  isSecureBrowserUrl,
  type ActionDecision,
  type BrowserControlCommand,
  type BrowserControlsSnapshot,
  type BrowserDownload,
  type BrowserPermission,
  type BrowserPolicyEvent,
  type BrowserPolicyVerdict,
  CLOSED_FIND,
  IDLE_SMART_FIND,
  type FindCommand,
  type FindMode,
  type FindState,
  type GuardedBrowserAction,
  type PendingPermissionRequest,
  type PermissionDecision,
} from "@pistachio/shell-contracts/browser-controls";
import type {
  BrowserMediaInfo,
  MediaControl,
  ReadAloudStatus,
} from "@pistachio/shell-contracts/media";
import type {
  Bookmark,
  BookmarkInput,
  BookmarkPatch,
  BookmarkSnapshot,
} from "@pistachio/shell-contracts/bookmarks";
import {
  PROFILE_KEY,
  type MemoryAddInput,
  type MemoryBucket,
  type MemoryEntry,
  type MemoryKind,
  type MemoryReview,
  type MemorySnapshot,
  type MemoryUpdateInput,
} from "@pistachio/shell-contracts/memory";
import type {
  Reminder,
  ReminderInput,
  ReminderPatch,
  ReminderSnapshot,
} from "@pistachio/shell-contracts/reminders";
import {
  favoriteApp,
  sanitizeOnboardingCompletion,
  WELCOME_TABS,
  type OnboardingCompletion,
  type WelcomeTab,
} from "@pistachio/shell-contracts/onboarding";
import { welcomeDocumentHtml, welcomeTabFor, type WelcomePageContext } from "@pistachio/shell-contracts/welcome-pages";
import { HOME_PAGE_FAVICON, HOME_PAGE_TITLE, HOME_PAGE_URL } from "@pistachio/shell-contracts/home";
import { BRIEF_PAGE_FAVICON, isShellPageUrl, shellPageOf, shellPagePlaceholderHtml, type ShellPage } from "@pistachio/shell-contracts/shell-pages";
import { BRIEF_PAGE_TITLE, briefUrl, briefUrlDate } from "@pistachio/shell-contracts/reports";
import {
  isNoteBlobId,
  isNoteId,
  MAX_NOTES,
  MAX_NOTE_TITLE,
  NOTES_PAGE_FAVICON,
  NOTES_PAGE_TITLE,
  NOTE_BLOB_MEDIA_TYPES,
  noteUrl,
  notesUrlId,
  type NoteBlobMediaType,
  type NoteInput,
  type NotePatch,
  type NoteRequest,
  type NoteResponse,
  type NoteSnapshot,
} from "@pistachio/shell-contracts/notes";
import { renderNoteHtml } from "@pistachio/notes";
import { normalizeReaderArticle, plainInline, type ReaderArticle } from "@pistachio/shell-contracts/reader";
import { draftFromPage, pageSnapshotFromHtml } from "@pistachio/shell-contracts/bookmarks";
import { pageFileName } from "@pistachio/shell-contracts/page-context-menu";
import { copyUrlNotice } from "@pistachio/shell-contracts/page-link";
import { TAB_SWITCHER_LIMIT } from "@pistachio/shell-contracts/tab-switcher";
import type { UpdateState } from "@pistachio/shell-contracts/updates";
import {
  MAX_UPLOAD_BYTES,
  type StreamClipboardCopy,
  type StreamContextMenuEvent,
  type StreamFile,
  type StreamFileRequest,
  type StreamGeolocation,
  type StreamShellApi,
} from "@pistachio/shell-contracts/socket";
import { READER_EXTRACT_SCRIPT } from "@pistachio/shell-contracts/reader-extract";
import { SessionDownloads, safeFileName, type DownloadStream } from "./downloads.js";
import { installTabBridge, shellBridgeBinding, type TabReport } from "./tab-bridge.js";
import { mirrorRecorderSource } from "@pistachio/dom-mirror";
import { AssetBroker } from "./mirror/asset-broker.js";
import { TabMirror } from "./mirror/tab-mirror.js";
import { currentViewer } from "./viewer-context.js";
import {
  DEFAULT_SIDEBAR_STATE,
  isSidebarCommand,
  type SidebarCommand,
  type SidebarState,
} from "@pistachio/shell-contracts/sidebar";
import {
  SidebarController,
  type SidebarShelfStore,
  type SidebarTabHost,
} from "@pistachio/shell-contracts/sidebar-controller";
import {
  gridLayoutForSide,
  MAX_SPLIT_PANES,
  orientationForSide,
  splitGroupInfo,
} from "@pistachio/shell-contracts/split";
import {
  BROWSER_SESSION_VERSION,
  MAX_RESTORABLE_URL_LENGTH,
  readBrowserSessionState,
  sanitizeSitePermissions,
  type BrowserSessionState,
  type BrowserSessionTab,
} from "@pistachio/shell-contracts/tab-session";
import { isAllowedNavigation, normalizeNavigation } from "@pistachio/shell-contracts/url";
import { applySettingsPatch, DEFAULT_SETTINGS, sanitizeSettings, type DesktopSettings, type SettingsPatch } from "@pistachio/shell-contracts/settings";
import { SHELL_SETTINGS_RECORD_VERSION } from "@pistachio/sync-protocol";
import type { ShellMethodName } from "@pistachio/shell-contracts/ipc";
import type { ShellControl } from "@pistachio/shell-contracts/socket";
import { errorMessage, silentLogger, type Logger } from "../logger.js";
import type { CloudBrowser, SpaceSession } from "../sync/session.js";
import type { WorkspacePersonHost, WorkspaceToolStore } from "../sync/workspace-tools.js";

/**
 * Every `ShellApi` member this host does not answer yet, and the stage that
 * will. A member here refuses with `unsupported`, which the shell renders as
 * an affordance that is visibly unavailable rather than one that silently
 * does nothing (W12 and §11 use the same code for the capabilities that will
 * never be supported at all).
 *
 * The list is what shrinks: S5 took the whole console out of it, so what is
 * left is S6's.
 */
/**
 * The one reason most of the account surface answers with. The web app is
 * where this person signed in, enrolled this browser, turned the cloud on
 * and named their devices; the shell inside it does not need a second set of
 * those screens, and a worker acting as a `cloud` device could not drive them
 * anyway (control turns a cloud device away from every device-bearer route).
 */
const MANAGED_IN_WEB = "managed from the web app's settings pages";

const UPDATE_REASON =
  "a browser tab is already running the newest build the moment it reloads; there is nothing to download or install (W12)";

const PASSKEY_REASON =
  "a passkey assertion binds to the site's origin and to a key on your own device, which the cloud browser is not (W12). Open this site in the desktop app.";

const EXTERNAL_APP_REASON =
  "apps are on your own device, not on the worker (W12). Open this site in the desktop app.";

const MEDIA_DEVICE_REASON =
  "the camera and microphone are on your own device, not on the worker (W12). Open this site in the desktop app.";

/** How much text one paste may carry into a page. */
const MAX_PASTE_TEXT = 1_000_000;
/** How many policy decisions Site Controls shows, newest first. */
const MAX_POLICY_EVENTS = 200;

/** How long a page's file picker waits for the pane before it is cancelled. */
const FILE_REQUEST_TIMEOUT_MS = 5 * 60_000;

export const UNSUPPORTED = {
  watchtower: "Watchtower currently stores browsing memories on the desktop. Open Pistachio on your Mac to search its archive.",
  tabGroupCommand: "Tab groups are kept by the desktop app for now. Open Pistachio on your Mac to group tabs.",
  tabArchive: "The tab archive is kept by the desktop app. Open Pistachio on your Mac to see archived tabs.",
  tidy: "Tidy runs in the desktop app for now. Open Pistachio on your Mac to tidy tabs.",
  reports: "The daily brief is built by the desktop app for now. Open Pistachio on your Mac to read it.",
  // ── W12 and its neighbours: things a browser tab cannot be ─────────────
  openLiveView:
    "the pane you are looking at IS the live view: a run in this session acts in these very tabs, so there is no second window to open (W1, W10)",
  forkSpace:
    "forking a Space clones a live browser profile, which only the desktop app can do; the fork appears here once it syncs",
  submitFeedback:
    "the feedback endpoint is reached with the desktop app's own API client; write to us from the web app instead",
  cancelReadAloud:
    "read aloud needs a speech model and a speaker on the host; the cloud browser plays no audio",
  readAloudText:
    "read aloud needs a speech model and a speaker on the host; the cloud browser plays no audio",
  retryAgentTurn:
    "a hosted run's turns are control's record; send the message again to continue the thread",
  transcribeSpeech:
    "the microphone is on your own device, not on the worker (W12); the walkthrough on your Mac can listen",
  extractOnboardingIntake:
    "the walkthrough that gathers an introduction runs on your Mac; this browser's first run is signing in",
  openBookmarksPage:
    "the bookmarks page is a native pistachio:// view; the web app has its own bookmarks page",
  acknowledgeReminders:
    "a reminder's fired occurrences are the log of whichever host ran the schedule and carry no synced record (§9)",
  snoozeReminder:
    "a reminder's fired occurrences are the log of whichever host ran the schedule and carry no synced record (§9)",
  // ── Managed from the web app's own settings pages ──────────────────────
  // Every one of these has a page in the web app already, signed in as this
  // person, talking to control directly. The shell shows them as unavailable
  // with this reason rather than offering a second, worse copy.
  getAiStatus: MANAGED_IN_WEB,
  getAiUsage: MANAGED_IN_WEB,
  getAccount: MANAGED_IN_WEB,
  signUp: MANAGED_IN_WEB,
  signIn: MANAGED_IN_WEB,
  enroll: MANAGED_IN_WEB,
  signOut: MANAGED_IN_WEB,
  changePassword: MANAGED_IN_WEB,
  recoveryCode: MANAGED_IN_WEB,
  listDevices: MANAGED_IN_WEB,
  renameDevice: MANAGED_IN_WEB,
  revokeDevice: MANAGED_IN_WEB,
  confirmCloudDevice: MANAGED_IN_WEB,
  getSyncStatus: MANAGED_IN_WEB,
  getSyncOriginInfo: MANAGED_IN_WEB,
  setSyncOriginOverride: MANAGED_IN_WEB,
  rollbackSyncOrigin: MANAGED_IN_WEB,
  retrySync: MANAGED_IN_WEB,
  getWorkspaceSync: MANAGED_IN_WEB,
  runWorkspaceSync: MANAGED_IN_WEB,
  getEgressStatus: MANAGED_IN_WEB,
  setSpaceEgressPolicy: MANAGED_IN_WEB,
  browseDirectForNow: MANAGED_IN_WEB,
  getCloudStatus: MANAGED_IN_WEB,
  enableCloud: MANAGED_IN_WEB,
  disableCloud: MANAGED_IN_WEB,
  listChannels: MANAGED_IN_WEB,
  createChannel: MANAGED_IN_WEB,
  deleteChannel: MANAGED_IN_WEB,
  getIMessageLink: MANAGED_IN_WEB,
  startIMessageLink: MANAGED_IN_WEB,
  verifyIMessageLink: MANAGED_IN_WEB,
  unlinkIMessage: MANAGED_IN_WEB,
  vaultList: MANAGED_IN_WEB,
  vaultReveal: MANAGED_IN_WEB,
  vaultSave: MANAGED_IN_WEB,
  vaultDelete: MANAGED_IN_WEB,
  integrationProviders: MANAGED_IN_WEB,
  integrationList: MANAGED_IN_WEB,
  integrationConnect: MANAGED_IN_WEB,
  integrationSetAccess: MANAGED_IN_WEB,
  integrationDisconnect: MANAGED_IN_WEB,
  integrationCalendarEvents: MANAGED_IN_WEB,
} as const satisfies Partial<Record<ShellMethodName, string>>;

export type UnsupportedShellMethod = keyof typeof UNSUPPORTED;

/**
 * Thrown by a member this host does not answer; the socket turns it into
 * `unsupported`, and the shell shows the affordance as unavailable with the
 * REASON as its message (W12). The message is the whole point: a person who
 * clicks a dead button is owed a sentence, not a shrug.
 */
export class UnsupportedShellMethodError extends Error {
  constructor(readonly member: string, readonly reason: string) {
    super(reason);
    this.name = "UnsupportedShellMethodError";
  }
}

function unsupported(member: UnsupportedShellMethod): never {
  throw new UnsupportedShellMethodError(member, UNSUPPORTED[member]);
}

/** Whether a call was refused because this host does not answer that member. */
export function isUnsupportedShellMethod(error: unknown): error is UnsupportedShellMethodError {
  return error instanceof UnsupportedShellMethodError;
}

/**
 * One tab, as the host keeps it. The backend owns the page; this owns the
 * identity, so a tab survives being put to sleep and woken up somewhere else.
 */
interface HostTab {
  resume?: PageResumeState;
  id: string;
  spaceId: string;
  /** The backend's own id while the page is open; null while suspended. */
  backendTabId: string | null;
  title: string;
  url: string;
  faviconUrl: string | null;
  kind: "human" | "agent";
  runId: string | null;
  anchorId: string | null;
  lastActiveAt: number;
  unlisted: boolean;
  /** The tab this one is the reader view of, when it is one (§11). */
  readerFor: string | null;
  /**
   * The shell-drawn page this tab's placeholder document stands for, or null
   * while a host draws its pane. There is no `pistachio://` protocol in a
   * cloud tab, and the shell paints these pages in the pane itself
   * (@pistachio/shell-contracts/shell-pages), so the tab holds the
   * placeholder as a `data:` document — a real history entry, which
   * Chromium's initial `about:blank` is not — while `url` stays the
   * `pistachio://` address the strip and the record report, including after
   * Back returns to it.
   */
  shellPage: ShellPage | null;
  /**
   * What the shell named this tab while it draws the page (a note's own
   * title), bound to the address it was given for. The placeholder behind a
   * shell page carries a static `<title>` that lands whenever it loads, so
   * without this a name the shell set a moment earlier would be written back
   * over. Any other address forgets it. The desktop keeps the same pair
   * (`browser-controller.ts` `shellTitle`).
   */
  shellTitle: { url: string; title: string } | null;
}

/** One channel subscription, and the viewer it belongs to (null: everyone). */
interface StreamListener {
  listener: (payload: unknown) => void;
  viewerId: string | null;
}

/** One unanswered site prompt: the request the shell shows, and the page's parked call. */
interface PendingPermission {
  request: PendingPermissionRequest;
  answer: (granted: boolean) => void;
  promise: Promise<boolean>;
}

/**
 * What the host needs of the Space it drives: the guarded browser, a way to
 * hear that its tabs changed, and the workspace store the durable record and
 * the Space names come from. `SpaceSession` satisfies it; narrowing it here
 * is what lets a test drive the host against a real Chromium context without
 * a hub socket behind it.
 */
export interface ShellHostSpace {
  browser: { backend: CloudBrowser; onTabsChanged(listener: () => void): () => void };
  workspace: WorkspaceToolStore | null;
}

/**
 * A Space held open for a browser session: a host space that has finished its
 * first hydration. `SpaceSession` satisfies it.
 */
export interface SessionSpace extends ShellHostSpace {
  /** Resolves once the first sync hydration completed. */
  readonly ready: Promise<void>;
}

const _spaceSessionIsASessionSpace = (session: SpaceSession): SessionSpace => session;

/**
 * What the host needs to drive the session's runs (§8).
 *
 * Control forbids a `cloud` device from every device-bearer route, so the
 * host cannot be the person on `POST /runs` or the sponsor routes. It acts
 * through the lease-authenticated session routes instead, and this is that
 * surface, narrowed: the transport, the Space key and the audit actor all
 * live behind it, so the host holds no crypto and no HTTP of its own and a
 * test can drive every console member against a fake.
 */
export interface ShellRunGateway {
  /** Create a run on this session. `startUrl` only when the shell named one. */
  start(input: {
    intent: string;
    attachments: AgentAttachment[];
    startUrl?: string;
  }): Promise<{ runId: string; at: string; events: RunControlEvent[] }>;
  /** One of the person's commands on a run of this session. */
  command(
    runId: string,
    command: SessionRunCommandName,
    body: {
      text?: string;
      attachments?: AgentAttachment[];
      questionId?: string;
      value?: string;
      approvalId?: string;
    },
  ): Promise<{ status: string; at: string; events: RunControlEvent[] }>;
  /** The session's Space's threads, with any sealed whole-thread snapshot. */
  list(): Promise<{
    runs: ThreadListItem[];
    threads: Array<{ runId: string; spaceId: string; sealed: string }>;
  }>;
  /** One run's stored events, for reopening a conversation the cloud drove. */
  events(runId: string, since?: number): Promise<StoredRunEvent[]>;
  /** Hide one run from this session's thread list (S6's `deleteThread` route). */
  remove?(runId: string): Promise<void>;
  /** Open one sealed content event with the session's Space keys; null when it cannot be read. */
  openEvent(runId: string, eventId: string, sealed: string): Promise<RunContentEvent | null>;
  /** Open a desktop executor's whole-thread snapshot; null for a cloud run's checkpoint. */
  openThread(runId: string, sealed: string): Promise<RunSummary | null>;
  /** Move the session's control fence to what control just decided (W7). */
  setControl(control: ShellControl): void;
}

/** The commands the console can issue on a run of its session (§8). */
export type SessionRunCommandName =
  | "message"
  | "answer"
  | "interrupt"
  | "release"
  | "revoke"
  | "approve"
  | "reject";

/**
 * What the address bar asks what typed prose means
 * (docs/smart-suggestions.md §4), or null when this worker has nothing to
 * ask. A factory rather than a model, and threaded in rather than looked up,
 * so a host built for a test reaches no gateway at all.
 */
export type IntentModelFactory = () => Experimental_EvaluationModel | null;

export interface ShellHostOptions {
  sessionId: string;
  userId: string;
  spaceId: string;
  space: ShellHostSpace;
  /** The session's control fence; input and agent calls are checked against it. */
  control: () => ShellControl;
  /** How the console reaches control (§8). Without it every run member refuses. */
  runs?: ShellRunGateway | null;
  /** Where a download's bytes live (§11). Without it a page's download is cancelled. */
  downloads?: SessionDownloads | null;
  /**
   * The evaluation model behind the address bar's smart suggestions
   * (docs/smart-suggestions.md), built from this worker's own gateway key.
   * Without one — a test, a worker with no key, `PISTACHIO_INTENT_MODEL=off`
   * — `rankAddressIntent` answers null and the bar keeps its own order.
   */
  intentModel?: IntentModelFactory | null;
  /** The app version this worker reports as `getAppInfo().version`. */
  version?: string;
  /** Chromium's version string, for `getAppInfo().chrome`. */
  chromeVersion?: () => string;
  now?: () => number;
  log?: Logger;
}

const DEFAULT_PANE_WIDTH = 1280;
const DEFAULT_PANE_HEIGHT = 800;
const MAX_RECENTLY_CLOSED = 25;
const VIEWPORT_DEBOUNCE_MS = 100;

export class ShellHost implements ShellApi, StreamShellApi {
  readonly sessionId: string;
  readonly userId: string;
  readonly spaceId: string;
  readonly #space: ShellHostSpace;
  readonly #controlOf: () => ShellControl;
  readonly #now: () => number;
  readonly #log: Logger;
  readonly #version: string;
  readonly #chromeVersion: () => string;
  readonly #intentModel: () => Experimental_EvaluationModel | null;
  /** The one live intent question for this session; a newer one supersedes it. */
  #intentInFlight: AbortController | null = null;

  readonly #tabs = new Map<string, HostTab>();
  /**
   * Every tab id this session has ever held, closed ones included. It is what
   * tells a tab handed over from ANOTHER Space (a fresh id, in the stored
   * record, never seen here) from a tab the person deliberately closed (a
   * known id) — so one is adopted and the other stays closed.
   */
  readonly #seenTabIds = new Set<string>();
  /** Host order; the backend's own order follows it through `reorder`. */
  #order: string[] = [];
  #activeTabId: string | null = null;
  #splitGroups = new Map<string, SplitGroupInfo>();
  #shelf: SidebarState = DEFAULT_SIDEBAR_STATE;
  /**
   * The shell's settings for this session.
   *
   * These defaults are used before a settings record is loaded. The web
   * entry reads the account's database onboarding status and copies it here
   * before mounting the shell, overriding either value in synced settings.
   * `completeOnboarding` writes the shell flag; the web then records account
   * completion in control. The database governs subsequent web visits.
   */
  #settings: DesktopSettings = {
    ...DEFAULT_SETTINGS,
    onboarding: { ...DEFAULT_SETTINGS.onboarding, completed: true },
  };
  /** When the settings this host holds were written, for the LWW read. */
  #settingsAt = 0;
  #zoom: Record<string, number> = {};
  /** What each site was allowed, per origin host; durable in the record (§9). */
  #sitePermissions: Record<string, Record<string, PermissionDecision>> = {};
  /** Which tabs the person muted, this session only: mute is not a site's. */
  readonly #muted = new Map<string, boolean>();
  /** The playing element in each tab, as its bridge reports it. */
  readonly #media = new Map<string, BrowserMediaInfo>();
  /** Prompts the person has not answered; the page's own call is parked on one. */
  #pendingPermissions: PendingPermission[] = [];
  /**
   * File pickers a page opened and the pane has not answered. Each one is
   * addressed to ONE viewer — the person who is driving is the person who is
   * going to pick a file — and each one has a deadline, because a page whose
   * picker nobody answers waits for ever and the chooser is never released.
   */
  readonly #fileRequests = new Map<
    string,
    { tabId: string; chooser: FileChooser; viewerId: string | null; timer: NodeJS.Timeout }
  >();
  /** The viewer whose call ran most recently: who a page's picker is shown to. */
  #drivingViewerId: string | null = null;
  /**
   * Pages that already carry the bridge, and the promise that put it there.
   * A caller that has just opened a tab awaits it: a tab whose right-click
   * does nothing, or whose copy never reaches the person, is not a tab the
   * shell should have been handed yet.
   */
  readonly #bridged = new WeakMap<Page, Promise<void>>();
  /** The binding name this session's pages call; random per session (§11). */
  readonly #bridgeBinding = shellBridgeBinding();
  /**
   * The DOM mirror's two random names for this session (§16): the global the
   * recorder's control object lives under, and the binding it reports through.
   * Random for the same reason the bridge's is — a constant is a fingerprint.
   */
  readonly #mirrorControl = shellBridgeBinding();
  readonly #mirrorBinding = shellBridgeBinding();
  /** One live DOM mirror per tab that a `dom` pane is painting (§16). */
  readonly #mirrors = new Map<string, { mirror: TabMirror; session: import("playwright-core").CDPSession }>();
  /** The session's asset broker, built the first time a mirror needs it (§16.3). */
  #broker: AssetBroker | null = null;
  #unobservePages: (() => void) | undefined;
  /**
   * The welcome documents this session has rendered: the `data:` address each
   * one was navigated to, and the welcome tab it IS (§14).
   *
   * A welcome tab is not a stored address, it is a rendering — so what makes
   * a tab a welcome tab is the document it currently shows. Keying on the
   * rendered address rather than stamping the tab means Back, Forward and
   * Reload all keep the logical address honest for free, and navigating
   * anywhere else stops being a welcome tab the moment the page changes.
   */
  readonly #welcomeDocuments = new Map<string, WelcomeTab["id"]>();
  readonly #downloads: SessionDownloads | null;
  /** Hands this Space's downloads back to the backend's "cancel them" default. */
  readonly #releaseDownloads: (() => void) | null;
  #closedTabs: RecentlyClosedTabInfo[] = [];
  /** Tabs whose page is being opened right now; the strip shows them waking. */
  readonly #waking = new Set<string>();
  #findState: FindState = CLOSED_FIND;
  /** The smart find under way, if any: one session per tab (docs/smart-find.md). */
  #smartFind: { tabId: string; session: SmartFindSession } | null = null;
  /** What this session's policy decided, newest first (`recentEvents`). */
  #policyEvents: BrowserPolicyEvent[] = [];
  #spaceName: string;

  readonly #tabListeners = new Set<(snapshot: ShellTabsSnapshot) => void>();
  readonly #runListeners = new Set<(snapshot: ShellRunSnapshot) => void>();
  readonly #settingsListeners = new Set<(settings: DesktopSettings) => void>();
  readonly #findListeners = new Set<(state: FindState) => void>();
  readonly #stateListeners = new Set<(state: BrowserSessionState) => void>();
  readonly #mediaListeners = new Set<(media: BrowserMediaInfo[]) => void>();
  readonly #controlsListeners = new Set<(snapshot: BrowserControlsSnapshot) => void>();
  /** One listener set per `StreamShellApi` channel (`socket.ts`). */
  readonly #streamListeners = new Map<string, Set<StreamListener>>();
  #tabsPending = false;
  #runPending = false;
  #flushScheduled = false;

  /**
   * How many `openTab` calls the host itself has in flight. The backend
   * announces a new page synchronously, from inside `openTab`, before the id
   * has come back here — so adoption (below) has to stand still for that
   * moment or it would claim the host's own tab as a stranger's.
   */
  #opening = 0;

  /** Pane geometry per tab, and the timer that lets a drag settle before resizing. */
  readonly #panes = new Map<string, { width: number; height: number; dpr: number; visible: boolean }>();
  readonly #viewportTimers = new Map<string, NodeJS.Timeout>();

  readonly #shelfStore: SidebarShelfStore;
  readonly #sidebar: SidebarController;
  #closed = false;

  /* ------------------------------ the console ------------------------------ */

  #runs: ShellRunGateway | null;
  /** The conversation the console has open, folded from its own event stream. */
  #run: RunSummary | null = null;
  /** The open run's evidence chain, as the events carried it. */
  #evidence: EvidenceEntry[] = [];
  /** The session's Space's threads, newest first, as control lists them. */
  #threads: ThreadListItem[] = [];
  /** One list refresh at a time; a burst of reasons to refresh is one read. */
  #listing: Promise<void> | null = null;

  constructor(options: ShellHostOptions) {
    this.sessionId = options.sessionId;
    this.userId = options.userId;
    this.spaceId = options.spaceId;
    this.#space = options.space;
    this.#controlOf = options.control;
    this.#now = options.now ?? ((): number => Date.now());
    this.#log = options.log ?? silentLogger;
    this.#version = options.version ?? "0.0.0";
    this.#chromeVersion = options.chromeVersion ?? ((): string => "");
    this.#intentModel = options.intentModel ?? ((): null => null);
    this.#runs = options.runs ?? null;
    this.#downloads = options.downloads ?? null;
    this.#spaceName = options.spaceId;
    this.#shelfStore = {
      get: () => this.#shelf,
      set: (_spaceId, state) => {
        this.#shelf = state;
        this.publish();
      },
    };
    this.#sidebar = new SidebarController({
      store: this.#shelfStore,
      browser: this.#sidebarTabHost(),
      settings: () => this.#settings,
      // A favorite pulled into a split becomes its own tab on the desktop,
      // where the tile follows the live view. A stream surface has no such
      // tile to follow, so an anchor survives the split (§10). Passed as an
      // override because the controller installs the desktop rule otherwise —
      // which is what used to overwrite the value below on the next line.
      anchorLeavesOnSplit: () => false,
    });
    this.#unobservePages = this.#backend.onPage?.(async page => {
      this.assetBroker().observe(page);
      // MediaSource buffers must be captured before the first site script.
      // The per-tab binding is attached later, before recording starts.
      await page.addInitScript(mirrorRecorderSource({ control: this.#mirrorControl, binding: this.#mirrorBinding }));
    });
    this.#space.browser.onTabsChanged(() => this.#syncFromBackend());
    // This host keeps the Space's downloads while it lives; without a keeper
    // the backend cancels them where they start, which is what an ordinary
    // hosted run — no session, no place to put bytes — needs (§11).
    this.#releaseDownloads = this.#downloads === null ? null : (this.#backend.claimDownloads?.() ?? null);
  }

  /* ------------------------------ lifecycle ------------------------------ */

  async resumeDesktop(desktop: BrowserSessionState): Promise<void> {
    const current = this.sessionState();
    // Preserve web-only preferences and permissions, but close stale human
    // pages before restoring their native counterparts (no duplicate tabs).
    this.#opening += 1;
    try {
      for (const tab of this.#orderedTabs()) if (tab.kind === "human") await this.#forget(tab);
      await this.restore({ ...current, tabs: desktop.tabs, activeTabId: desktop.activeTabId, splitGroups: desktop.splitGroups });
    } finally { this.#opening -= 1; }
  }

  /** Rebuild from the sealed record (§9): the tabs, the shelf, the splits, the zoom. */
  async restore(state: BrowserSessionState | null): Promise<void> {
    if (state === null) {
      // Nothing durable to rebuild, but the Space's context may already have
      // pages in it — a run's tabs, on a worker that was driving one before
      // this session attached (§8). Adopt them rather than paint an empty
      // strip over a browser that is not.
      this.#syncFromBackend();
      return;
    }
    this.#shelf = state.shelf;
    this.#zoom = { ...state.zoom };
    this.#sitePermissions = sanitizeSitePermissions(state.permissions);
    this.#tabs.clear();
    this.#order = [];
    for (const tab of state.tabs) {
      // A stored `pistachio://…` address rebuilds as the shell page it is:
      // the strip shows it under that address and its pane is the shell's to
      // paint, before the tab is ever woken.
      const address = shellPageAddress(tab.url) ?? tab.url;
      const shellPage = shellPageOf(address);
      this.#tabs.set(tab.id, {
        id: tab.id,
        spaceId: this.spaceId,
        backendTabId: null,
        title: tab.title,
        url: address,
        faviconUrl: tab.favicon,
        ...(tab.resume ? { resume: tab.resume } : {}),
        kind: "human",
        runId: null,
        anchorId: tab.pinnedAnchor ?? null,
        // The record carries it now: stamping every tab with the record's own
        // `updatedAt` made the switcher insertion order after a rebuild.
        lastActiveAt: tab.lastActiveAt ?? state.updatedAt,
        unlisted: false,
        readerFor: null,
        shellPage,
        // The note's own name was stored with the tab; keeping it is what
        // stops the strip reading "Notes" until the editor mounts again.
        shellTitle: shellPage === null || tab.title === "" ? null : { url: address, title: tab.title },
      });
      this.#seenTabIds.add(tab.id);
      this.#order.push(tab.id);
    }
    this.#splitGroups = new Map(state.splitGroups.map((group) => [group.id, group]));
    this.#activeTabId = state.activeTabId;
    this.#syncFromBackend();
    // Only the active tab's page is opened: a session with forty tabs must not
    // start forty Chromium pages to be usable, and selecting a sleeping tab
    // wakes it (§6.3).
    if (this.#activeTabId !== null) {
      await this.#wake(this.#activeTabId).catch((error: unknown) => {
        this.#log.warn("restoring the active tab failed", { error: errorMessage(error) });
      });
    }
    this.publish();
  }

  close(): void {
    this.#unobservePages?.();
    this.#closed = true;
    this.#endSmartFind();
    this.#intentInFlight?.abort();
    this.#intentInFlight = null;
    this.#releaseDownloads?.();
    for (const timer of this.#viewportTimers.values()) clearTimeout(timer);
    this.#viewportTimers.clear();
    this.#tabListeners.clear();
    this.#runListeners.clear();
    this.#settingsListeners.clear();
    this.#findListeners.clear();
    this.#stateListeners.clear();
    this.#mediaListeners.clear();
    this.#controlsListeners.clear();
    this.#streamListeners.clear();
    for (const pending of this.#pendingPermissions) pending.answer(false);
    this.#pendingPermissions = [];
    // A picker nobody answered is released rather than left holding the page:
    // an unresolved `filechooser` is a tab that can never be typed into again.
    for (const [requestId, pending] of [...this.#fileRequests]) {
      clearTimeout(pending.timer);
      this.#fileRequests.delete(requestId);
      void pending.chooser.setFiles([]).catch(() => undefined);
    }
    for (const [tabId] of [...this.#mirrors]) this.#disposeMirror(tabId);
    this.#downloads?.close();
  }

  /**
   * The session's control fence, as the host sees it (W7). The host does not
   * enforce it — the socket drops stale input before it ever reaches a page —
   * but a member that acts on the person's behalf reads it here.
   */
  get control(): ShellControl {
    return this.#controlOf();
  }

  /**
   * Refuse a member that MUTATES THE PAGE on the person's behalf while the
   * agent holds the wheel (W7). `Input.insertText`, a file the picker is
   * waiting for and a print are forwarded input by any other name; the
   * socket already drops raw input under an old fence, and these went round
   * it because they arrive as RPC calls.
   */
  #requireControl(what: string): void {
    if (this.control.holder === "human") return;
    throw new Error(`the agent has control of this session; take control before you ${what}`);
  }

  /**
   * A person's navigation, history move, reload or tab close on a session the
   * agent is driving IS a takeover (§13, revision 6).
   *
   * The desktop lets a person navigate their own tab whenever they like — it
   * is a collaborative browser — but here the agent's authority is fenced by
   * a generation, and these commands used to go round the fence entirely: the
   * address bar could replace the page under a running turn while the session
   * still reported `agent`, and the agent's next tool call would land in a
   * document nobody had told it about. So the fence moves FIRST, through the
   * very path `takeControl` uses — control's `interrupt`, which aborts the
   * executor's turn and moves the generation — and the page changes only
   * afterwards. What the person meant is unchanged; what the agent is told is
   * now true.
   *
   * Answers the generation the caller may act under.
   */
  async #takeoverForPageChange(what: string): Promise<number> {
    if (this.control.holder !== "human") {
      try {
        await this.takeControl();
      } catch (error) {
        throw new Error(
          `the agent has control of this session and it could not be taken back before you ${what}: ${errorMessage(error)}`,
        );
      }
      // Re-read: the takeover is a round trip to control, and what came back
      // is the fence this call may act under — or, if control did not move
      // it, a refusal rather than an action under the agent's.
      const moved: ShellControl = this.control;
      if (moved.holder !== "human") {
        throw new Error(`the agent has control of this session; take control before you ${what}`);
      }
      return moved.generation;
    }
    return this.control.generation;
  }

  /**
   * The fence has not moved since the takeover authorised this call. Taking
   * control, waking a sleeping tab and reading the backend are all awaits,
   * and control can hand the wheel back to a run inside any of them — so the
   * generation is re-read immediately before the mutation, exactly as the
   * agent's own side of the fence does (`runs/control-fence.ts`).
   */
  #stillHeld(generation: number, what: string): void {
    const control = this.control;
    if (control.holder === "human" && control.generation === generation) return;
    throw new Error(`the agent took control of this session before ${what} could happen; it was not performed`);
  }

  /**
   * Apply a guarded action's verdict, and record the decision either way.
   *
   * The shell reads `getBrowserControls().actions` to decide whether to offer
   * the affordance at all, so the host and that snapshot have to be the same
   * judgement: a menu row that is enabled and then refused, or disabled while
   * the host would happily perform it, is the snapshot lying about the host.
   */
  #requireAction(tabId: string | null, action: GuardedBrowserAction): void {
    const verdict = this.#actionVerdict(action);
    this.#recordPolicy(tabId, action, verdict);
    if (verdict.decision === "block") throw new Error(verdict.reason);
  }

  /* ------------------------------ publishing ------------------------------ */

  /**
   * The tab side changed. Coalesced exactly as main coalesces it: every
   * change in one synchronous burst produces one flush, on a microtask so a
   * caller that awaits a mutation and then reads the store sees the new
   * state (architecture.md).
   */
  publish(): void {
    this.#tabsPending = true;
    this.#scheduleFlush();
  }

  /** The run side changed: the conversation and the thread list (§8). */
  publishRun(): void {
    this.#runPending = true;
    this.#scheduleFlush();
  }

  #scheduleFlush(): void {
    if (this.#flushScheduled || this.#closed) return;
    this.#flushScheduled = true;
    queueMicrotask(() => this.#flush());
  }

  #flush(): void {
    this.#flushScheduled = false;
    const tabs = this.#tabsPending;
    const run = this.#runPending;
    this.#tabsPending = false;
    this.#runPending = false;
    if (this.#closed || (!tabs && !run)) return;
    if (tabs) {
      const { run: _run, threads: _threads, ...tabsSnapshot } = this.#snapshot();
      for (const listener of [...this.#tabListeners]) this.#safely(() => listener(tabsSnapshot));
      const state = this.sessionState();
      for (const listener of [...this.#stateListeners]) this.#safely(() => listener(state));
    }
    if (run) {
      const snapshot: ShellRunSnapshot = { run: this.#run, threads: this.#threads };
      for (const listener of [...this.#runListeners]) this.#safely(() => listener(snapshot));
    }
  }

  #safely(work: () => void): void {
    try {
      work();
    } catch (error) {
      this.#log.warn("a shell listener threw", { error: errorMessage(error) });
    }
  }

  /**
   * The state to publish, with anything the STORED record holds that this
   * session has never seen folded back in (§6.3, "moving a tab between
   * Spaces").
   *
   * The record is one last-writer-wins register and a hand-off has two
   * writers: the Space giving the tab away writes it into the destination's
   * record, and the destination session's very next publish — a title tick
   * suffices — used to replace that record wholesale. The source had already
   * closed the tab, so it was gone from both.
   *
   * A tab is only adopted when its id is one this session has NEVER held.
   * That is what tells an arriving tab from one the person closed a moment
   * ago, which must stay closed.
   */
  mergeStoredState(stored: unknown, pending: BrowserSessionState): BrowserSessionState {
    const read = readBrowserSessionState(stored, this.spaceId);
    if (read.kind !== "state") return pending;
    const arrivals = read.state.tabs.filter((tab) => !this.#seenTabIds.has(tab.id));
    if (arrivals.length === 0) return pending;
    for (const tab of arrivals) {
      this.#seenTabIds.add(tab.id);
      const address = shellPageAddress(tab.url) ?? tab.url;
      const shellPage = shellPageOf(address);
      this.#tabs.set(tab.id, {
        id: tab.id,
        spaceId: this.spaceId,
        backendTabId: null,
        title: tab.title,
        url: address,
        faviconUrl: tab.favicon,
        ...(tab.resume ? { resume: tab.resume } : {}),
        kind: "human",
        runId: null,
        anchorId: tab.pinnedAnchor ?? null,
        lastActiveAt: tab.lastActiveAt ?? this.#now(),
        unlisted: false,
        readerFor: null,
        shellPage,
        shellTitle: shellPage === null || tab.title === "" ? null : { url: address, title: tab.title },
      });
      this.#order.push(tab.id);
    }
    this.publish();
    return this.sessionState();
  }

  /** The durable half of this session, for the sealed record (§9). */
  sessionState(): BrowserSessionState {
    const tabs: BrowserSessionTab[] = this.#orderedTabs()
      .filter((tab) => tab.kind === "human" && !tab.unlisted && this.#isRestorable(tab))
      .map((tab) => {
        // A welcome tab travels as its LOGICAL address: the `data:` document
        // is a rendering, and the next session renders it again (§14).
        const welcome = this.#welcomeOf(tab);
        return {
          id: tab.id,
          // A shell page travels as its own `pistachio://` address too; the
          // placeholder is a rendering, and the next session renders it again.
          url: welcome !== null ? this.#welcomeAddress(welcome) : (shellDocumentAddress(tab.url) ?? tab.url),
          title: tab.title,
          favicon: tab.faviconUrl,
          kind: "human" as const,
          lastActiveAt: tab.lastActiveAt,
          ...(tab.resume?.url === tab.url ? { resume: tab.resume } : {}),
          ...(tab.anchorId === null ? {} : { pinnedAnchor: tab.anchorId }),
        };
      });
    const ids = new Set(tabs.map((tab) => tab.id));
    return {
      version: BROWSER_SESSION_VERSION,
      spaceId: this.spaceId,
      tabs: boundPageResumes(tabs, this.#activeTabId),
      activeTabId: this.#activeTabId !== null && ids.has(this.#activeTabId) ? this.#activeTabId : (tabs[0]?.id ?? null),
      splitGroups: [...this.#splitGroups.values()].filter((group) => group.tabIds.every((id) => ids.has(id))),
      shelf: this.#shelf,
      zoom: { ...this.#zoom },
      permissions: structuredClone(this.#sitePermissions),
      updatedAt: this.#now(),
    };
  }

  /**
   * Whether a tab belongs in the sealed record at all.
   *
   * A reader tab's address IS the article — a `data:text/html,…` URL holding
   * the whole document — so persisting it verbatim put page HTML in the
   * workspace (which security.md says never leaves the worker) and pushed the
   * record past the hub's frame cap after a few long pieces, at which point
   * the WHOLE session record silently stopped syncing. The reader view is a
   * rendering of a tab that is still in the strip; it is rebuilt, not stored.
   */
  #isRestorable(tab: HostTab): boolean {
    if (tab.readerFor !== null) return false;
    // A welcome tab is the same kind of rendering, and it IS restorable — by
    // its logical `pistachio://` address, which the next session renders
    // again rather than storing the document it produced (§14).
    if (this.#welcomeOf(tab) !== null) return true;
    // A shell-drawn page likewise travels as its address, never as
    // `about:blank` and never as the placeholder it was drawn from.
    if (isShellPageUrl(shellDocumentAddress(tab.url) ?? tab.url)) return true;
    return tab.url.length <= MAX_RESTORABLE_URL_LENGTH && isAllowedNavigation(tab.url);
  }

  /** Fires whenever the durable half changed, so the record store can debounce a write. */
  onSessionState(listener: (state: BrowserSessionState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  /* ------------------------------ the surface ------------------------------ */

  async getSnapshot(): Promise<ShellSnapshot> {
    return this.#snapshot();
  }

  onSnapshot(listener: (snapshot: ShellTabsSnapshot) => void): () => void {
    this.#tabListeners.add(listener);
    return () => this.#tabListeners.delete(listener);
  }

  onRun(listener: (run: ShellRunSnapshot) => void): () => void {
    this.#runListeners.add(listener);
    return () => this.#runListeners.delete(listener);
  }

  async getCommandPalette(): Promise<CommandPaletteSnapshot> {
    return {
      tabs: this.#tabInfos(),
      recentlyClosedTabs: [...this.#closedTabs],
      // The person's clipboard belongs to their own browser, not to the
      // worker: the web pane reads it locally where the paste happens.
      clipboardUrl: null,
    };
  }

  /**
   * What the typed words most likely mean (docs/smart-suggestions.md), on
   * the same evaluator the Mac uses — the only difference is whose key pays
   * for it: there, the account's device token through control's `/v1/ai/*`
   * proxy; here, this worker's own gateway key.
   *
   * One question per session, like main's one per window (§7). A person
   * types faster than the model answers, so a new request aborts the one
   * before it and that one resolves null: the page has already moved on, and
   * an answer about words they have finished typing would reorder the list
   * under their hands.
   *
   * Every refusal is null and none is an error: the setting is off, this
   * worker has no model, the request is not worth asking about, the gateway
   * said no, or the deadline passed.
   */
  async rankAddressIntent(request: AddressIntentRequest): Promise<AddressIntentRanking | null> {
    const sanitized = sanitizeAddressIntentRequest(request);
    if (sanitized === null) return null;
    if (!this.#readSettings().search.smartSuggestions) return null;
    const model = this.#intentModel();
    if (model === null || this.#closed) return null;

    this.#intentInFlight?.abort();
    const controller = new AbortController();
    this.#intentInFlight = controller;
    const superseded = new Promise<null>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    try {
      const ranking = await Promise.race([
        evaluateAddressIntent({ model, request: sanitized, abortSignal: controller.signal }).catch(() => null),
        superseded,
      ]);
      return controller.signal.aborted ? null : ranking;
    } finally {
      if (this.#intentInFlight === controller) this.#intentInFlight = null;
    }
  }

  /**
   * One `BrowserSession` per Space (§6.3, W4). Switching Space is therefore
   * the client's move — it opens or resumes the other Space's session and
   * swaps sockets — and the host answers only for its own.
   */
  async switchSpace(spaceId: string): Promise<void> {
    if (spaceId === this.spaceId) return;
    throw new UnsupportedShellMethodError(
      "switchSpace",
      "the shell opens the other Space's own session (§6.3)",
    );
  }


  /* --------------------------------- tabs --------------------------------- */

  async createTab(url?: string): Promise<void> {
    await this.#createTab(url ?? this.#settings.general.homeUrl, {});
  }

  async closeTab(tabId: string): Promise<void> {
    if (!this.#tabs.has(tabId)) return;
    const generation = await this.#takeoverForPageChange("close this tab");
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) return;
    if (tab.kind === "human" && !tab.unlisted) {
      this.#closedTabs = [
        {
          spaceId: tab.spaceId,
          title: tab.title,
          url: tab.url,
          faviconUrl: tab.faviconUrl,
          anchorId: tab.anchorId,
          closedAt: this.#now(),
        },
        ...this.#closedTabs,
      ].slice(0, MAX_RECENTLY_CLOSED);
    }
    this.#stillHeld(generation, "closing the tab");
    await this.#forget(tab);
    this.publish();
  }

  /**
   * The selection moves FIRST, and the page is opened behind it.
   *
   * A suspended tab takes a whole page load to wake, and publishing only
   * afterwards left the strip on the old selection, painting the previous
   * tab's frames, for the entire wait. `wakingTabIds` is what the shell
   * shows in the meantime — the same thing `ipc.ts` added it for.
   */
  async selectTab(tabId: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) return;
    this.#activeTabId = tabId;
    tab.lastActiveAt = this.#now();
    const sleeping = tab.backendTabId === null;
    if (sleeping) this.#waking.add(tabId);
    this.publish();
    try {
      if (sleeping) await this.#wake(tabId);
    } finally {
      this.#waking.delete(tabId);
    }
    const woken = this.#tabs.get(tabId);
    if (woken?.backendTabId != null) {
      await this.#backend.focusTab(woken.backendTabId).catch(() => undefined);
    }
    if (woken !== undefined) woken.lastActiveAt = this.#now();
    this.publish();
  }

  /**
   * Sleep: the page is closed and the durable tab kept (§6.3). Selecting it
   * later reopens a page and navigates it back to where it was.
   */
  /** Not offered here: the cloud host never reports BrowserTabInfo.forcedFocus. */
  async setForcedFocus(): Promise<void> {}

  async suspendTab(tabId: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined || tab.backendTabId === null) return;
    if (tabId === this.#activeTabId) return;
    const backendTabId = tab.backendTabId;
    tab.backendTabId = null;
    this.#panes.delete(tabId);
    await this.#backend.closeTab(backendTabId).catch(() => undefined);
    this.publish();
  }

  async navigate(tabId: string, url: string): Promise<void> {
    const generation = await this.#takeoverForPageChange("navigate this tab");
    const backendTabId = await this.#liveBackendId(tabId);
    if (backendTabId === null) return;
    this.#stillHeld(generation, "the navigation");
    const target = normalizeNavigation(url, this.#settings.search.webProvider);
    const shellPage = shellPageAddress(target);
    if (shellPage !== null) {
      // Straight to the placeholder, as the reader and the welcome pages go
      // to theirs: the backend's navigation would put a `pistachio://`
      // address before the network policy, which refuses it. Library → note
      // and back is this same path, and each placeholder is its own
      // document, so the history entries are real ones.
      await this.#showShellPage(tabId, shellPage);
    } else {
      await this.#backend.navigate(backendTabId, target);
    }
    await this.#refresh(tabId);
  }

  async goBack(tabId: string): Promise<void> {
    const generation = await this.#takeoverForPageChange("go back");
    const backendTabId = await this.#liveBackendId(tabId);
    if (backendTabId === null) return;
    this.#stillHeld(generation, "going back");
    await this.#backend.back(backendTabId);
    await this.#refresh(tabId);
  }

  async goForward(tabId: string): Promise<void> {
    const generation = await this.#takeoverForPageChange("go forward");
    const backendTabId = await this.#liveBackendId(tabId);
    if (backendTabId === null) return;
    this.#stillHeld(generation, "going forward");
    await this.#backend.forward(backendTabId);
    await this.#refresh(tabId);
  }

  async reload(tabId: string): Promise<void> {
    const generation = await this.#takeoverForPageChange("reload this tab");
    const backendTabId = await this.#liveBackendId(tabId);
    if (backendTabId === null) return;
    this.#stillHeld(generation, "the reload");
    await this.#backend.reload(backendTabId);
    await this.#refresh(tabId);
  }

  async duplicateTab(tabId: string): Promise<string> {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) throw new Error(`unknown tab ${tabId}`);
    const created = await this.#createTab(tab.url, { anchorId: null });
    this.#place(created, this.#order.indexOf(tabId) + 1);
    this.publish();
    return created;
  }

  async restoreClosedTab(): Promise<void> {
    const [newest, ...rest] = this.#closedTabs;
    if (newest === undefined) return;
    this.#closedTabs = rest;
    await this.#createTab(newest.url, { anchorId: newest.anchorId });
    this.publish();
  }

  async clearUnpinnedTabs(): Promise<void> {
    const generation = await this.#takeoverForPageChange("close these tabs");
    for (const tab of [...this.#tabs.values()]) {
      if (tab.kind !== "human" || tab.anchorId !== null || tab.unlisted) continue;
      this.#stillHeld(generation, "closing the tabs");
      await this.#forget(tab);
    }
    this.publish();
  }


  /** Move a tab to `index` among all tabs, counted with it lifted out. */
  async reorderTab(tabId: string, index: number): Promise<void> {
    this.#place(tabId, index);
    this.publish();
  }

  /* ------------------------------ split groups ------------------------------ */

  async setSplit(mode: SplitMode): Promise<void> {
    const activeTabId = this.#activeTabId;
    if (activeTabId === null) return;
    const current = this.#groupFor(activeTabId);
    if (mode === "single") {
      if (current !== undefined) this.#splitGroups.delete(current.id);
      this.publish();
      return;
    }
    if (current !== undefined) {
      this.#splitGroups.set(current.id, splitGroupInfo(current.id, current.tabIds, mode, current.gridLayout));
      this.publish();
      return;
    }
    const partner = this.#orderedTabs().find(
      (tab) => tab.id !== activeTabId && this.#groupFor(tab.id) === undefined && !tab.unlisted,
    );
    if (partner === undefined) return;
    const id = randomUUID();
    this.#splitGroups.set(id, splitGroupInfo(id, [activeTabId, partner.id], mode));
    await this.#wake(partner.id).catch(() => undefined);
    this.publish();
  }

  /**
   * Add or reposition a tab at one edge of the active group — the desktop's
   * own arithmetic (`browser-controller.ts`), including the two branches the
   * first cloud version dropped: no active tab is a plain linear split, and a
   * tab dropped onto ITSELF splits with a fresh duplicate rather than pulling
   * in an unrelated neighbour.
   *
   * The capacity check runs FIRST and throws. It used to run last, after the
   * dragged tab had already been detached from its own group and without a
   * publish — so dropping a pane onto a full group silently dissolved the
   * group it came from and told nobody.
   */
  async splitWith(tabId: string, side: SplitSide): Promise<void> {
    if (!this.#tabs.has(tabId)) return;
    const activeTabId = this.#activeTabId;
    const orientation = orientationForSide(side);
    if (activeTabId === null) {
      await this.setSplit(orientation);
      return;
    }
    const current = this.#groupFor(activeTabId);
    const atStart = side === "left" || side === "top";
    const addsPane = activeTabId === tabId || (current !== undefined && !current.tabIds.includes(tabId));
    if (current !== undefined && addsPane && current.tabIds.length >= MAX_SPLIT_PANES) {
      throw new Error("Split views can contain up to four tabs.");
    }
    const paneTabId = activeTabId === tabId ? await this.duplicateTab(tabId) : tabId;
    this.#detachFromGroup(paneTabId);
    const group = this.#groupFor(activeTabId);
    const existing = group?.tabIds.filter((candidate) => candidate !== paneTabId) ?? [activeTabId];
    const tabIds = atStart ? [paneTabId, ...existing] : [...existing, paneTabId];
    const mode = tabIds.length === 3 || group?.mode === "grid" ? "grid" : orientation;
    const gridLayout = tabIds.length === 3 ? gridLayoutForSide(side) : (group?.gridLayout ?? gridLayoutForSide(side));
    const id = group?.id ?? randomUUID();
    this.#splitGroups.set(id, splitGroupInfo(id, tabIds, mode, gridLayout));
    await this.#wake(paneTabId).catch(() => undefined);
    this.publish();
  }

  async removeFromSplit(tabId: string): Promise<void> {
    this.#detachFromGroup(tabId);
    this.publish();
  }

  /* -------------------------------- shelf --------------------------------- */

  async sidebarCommand(command: SidebarCommand): Promise<void> {
    if (!isSidebarCommand(command)) throw new Error("not a sidebar command");
    await this.#sidebar.run(command);
    this.publish();
  }

  /* ------------------------------- settings ------------------------------- */

  async getSettings(): Promise<DesktopSettings> {
    return this.#readSettings();
  }

  async updateSettings(patch: SettingsPatch): Promise<DesktopSettings> {
    // Section by section, the way the Mac's store merges: a patch names only
    // the fields it changed (`search: { aiProvider }`), and the rest of its
    // section has to survive it.
    this.#applySettings(applySettingsPatch(this.#readSettings(), patch));
    return this.#settings;
  }

  /**
   * Back to the defaults — except the walkthrough, which stays finished.
   *
   * `DEFAULT_SETTINGS.onboarding.completed` is `false`, and the shell turns
   * that into the first-run wizard. On a Mac that is right: a reset there is
   * a fresh install. In a browser tab it would raise the Mac's walkthrough —
   * importing from installed browsers, naming a window theme — over a live
   * session with the person's tabs behind it. Resetting the shell is not
   * asking to be onboarded again (§14).
   */
  async resetSettings(): Promise<DesktopSettings> {
    const current = this.#readSettings();
    this.#applySettings({
      ...DEFAULT_SETTINGS,
      onboarding: { ...current.onboarding, completed: true },
    });
    return this.#settings;
  }

  /**
   * The settings, from the sealed account-global register when the Space has
   * one (§6.3). They are not this worker's: a person who changed their theme
   * here finds it changed on their Mac, and a session rebuilt on another
   * worker an hour later is still the shell they left.
   */
  #readSettings(): DesktopSettings {
    const stored = this.#space.workspace?.shellSettings() ?? null;
    if (stored === null || stored.updatedAt <= this.#settingsAt) return this.#settings;
    this.#settingsAt = stored.updatedAt;
    this.#settings = sanitizeSettings(stored.settings);
    return this.#settings;
  }

  #applySettings(next: DesktopSettings): void {
    this.#settings = next;
    this.#settingsAt = this.#now();
    const workspace = this.#space.workspace;
    if (workspace !== null) {
      try {
        workspace.putShellSettings({
          version: SHELL_SETTINGS_RECORD_VERSION,
          settings: this.#settings,
          updatedAt: this.#settingsAt,
        });
      } catch (error) {
        this.#log.warn("the shell settings could not be published", { error: errorMessage(error) });
      }
    }
    for (const listener of [...this.#settingsListeners]) this.#safely(() => listener(this.#settings));
    this.publish();
  }

  onSettings(listener: (settings: DesktopSettings) => void): () => void {
    this.#settingsListeners.add(listener);
    // A correction another device made lands here too: the register is
    // account-global, so a theme changed on the Mac reaches this tab.
    const off = this.#onRecords(() => {
      const before = this.#settings;
      const after = this.#readSettings();
      if (after !== before) listener(after);
    });
    return () => {
      off();
      this.#settingsListeners.delete(listener);
    };
  }

  /* ------------------------------ find in page ----------------------------- */

  async getFindState(): Promise<FindState> {
    const smartAvailable = this.#smartFindAvailable();
    return { ...this.#findState, mode: smartAvailable ? this.#findState.mode : "exact", smartAvailable };
  }

  /** Whether a smart find could run now: the setting is on and this worker has a model to ask. */
  #smartFindAvailable(): boolean {
    return this.#readSettings().search.smartFind && this.#intentModel() !== null;
  }

  #endSmartFind(): void {
    const smart = this.#smartFind;
    this.#smartFind = null;
    if (smart !== null) void smart.session.close();
  }

  /**
   * The smart find session for a tab. Its scripts run in the page's own
   * world — Playwright has no isolated world to offer — so the reading dies
   * with the document, and a paint after a navigation reports itself stale.
   */
  #smartFindFor(tabId: string, page: Page): SmartFindSession {
    if (this.#smartFind?.tabId === tabId) return this.#smartFind.session;
    this.#endSmartFind();
    const evaluate = <T>(script: string): Promise<T> => page.evaluate(script) as Promise<T>;
    const session = new SmartFindSession({
      page: {
        collect: (known) => (/^https?:/i.test(page.url()) ? evaluate(smartFindCollectScript(known)) : Promise.resolve(null)),
        paint: async (paint) => {
          if (paint.matches.length > 0) await evaluate(SMART_FIND_ADOPT_STYLE_SCRIPT).catch(() => false);
          return evaluate(smartFindPaintScript(paint));
        },
        clear: async () => {
          await evaluate(SMART_FIND_CLEAR_SCRIPT).catch(() => undefined);
        },
      },
      model: () => (this.#readSettings().search.smartFind ? this.#intentModel() : null),
      onChange: (view) => {
        if (this.#smartFind?.session !== session || this.#findState.mode !== "smart" || this.#closed) return;
        this.#setFind({ ...this.#findState, activeMatchOrdinal: view.activeMatchOrdinal, matches: view.matches, smart: view.smart });
      },
    });
    this.#smartFind = { tabId, session };
    return session;
  }

  onFindStateChanged(listener: (state: FindState) => void): () => void {
    this.#findListeners.add(listener);
    return () => this.#findListeners.delete(listener);
  }

  /**
   * Find in the page with `window.find`, counting matches by walking the whole
   * document once and then stepping (§6.3). Chromium's own find bar is a
   * browser control the worker has no window for, so the count is computed in
   * the page rather than reported by the embedder.
   */
  async find(command: FindCommand): Promise<void> {
    const tabId = this.#activeTabId;
    const backendTabId = tabId === null ? null : (this.#tabs.get(tabId)?.backendTabId ?? null);
    const page = backendTabId === null ? null : (this.#backend.pageFor?.(backendTabId) ?? null);
    if (command.type === "close") {
      if (page !== null) await page.evaluate(FIND_CLEAR_SCRIPT).catch(() => undefined);
      this.#endSmartFind();
      this.#setFind(CLOSED_FIND);
      return;
    }
    const mode: FindMode = (command.mode ?? this.#findState.mode) === "smart" && this.#smartFindAvailable() ? "smart" : "exact";
    if (mode !== this.#findState.mode || !this.#findState.open) {
      // Whatever the other mode had on the page comes down: the two never paint at once.
      if (page !== null) await page.evaluate(FIND_CLEAR_SCRIPT).catch(() => undefined);
      this.#endSmartFind();
      this.#setFind({ ...this.#findState, open: true, mode, matches: 0, activeMatchOrdinal: 0, smart: IDLE_SMART_FIND });
      if (command.type === "mode") {
        // Back in exact mode, the typed text is searched as it would have been.
        if (mode === "exact" && this.#findState.query !== "") await this.find({ type: "search", query: this.#findState.query, forward: true, mode });
        return;
      }
    } else if (command.type === "mode") return;
    const query = command.query;
    if (mode === "smart") {
      this.#setFind({ ...this.#findState, open: true, query });
      if (tabId === null || page === null) return;
      const session = this.#smartFindFor(tabId, page);
      if (command.draft === true) session.edit(query);
      else session.search(query, command.forward);
      return;
    }
    if (page === null || query === "") {
      this.#setFind({ ...this.#findState, open: true, query, matches: 0, activeMatchOrdinal: 0 });
      return;
    }
    const result = (await page
      .evaluate(findScript(query, !command.forward))
      .catch(() => null)) as { matches: number; activeMatch: number } | null;
    this.#setFind({
      ...this.#findState,
      open: true,
      query,
      matches: result?.matches ?? 0,
      activeMatchOrdinal: result?.activeMatch ?? 0,
    });
  }

  #setFind(next: FindState): void {
    const smartAvailable = this.#smartFindAvailable();
    const state: FindState = { ...next, mode: smartAvailable ? next.mode : "exact", smartAvailable };
    this.#findState = state;
    for (const listener of [...this.#findListeners]) this.#safely(() => listener(state));
  }

  /* -------------------------------- app info ------------------------------- */

  async getAppInfo(): Promise<AppInfo> {
    // No `electron` and no `userDataPath`: both are optional on `AppInfo`
    // because this host has neither, and an empty string would reach the
    // About page as "Electron  · Chromium …" and a path of "/settings.json".
    return { version: this.#version, chrome: this.#chromeVersion(), platform: "web" };
  }

  /* ------------------------------ panes & input ---------------------------- */

  /**
   * A pane reported its CSS size. The page's viewport follows it, debounced
   * so a resize drag does not reflow the page on every frame (§6.3).
   */
  setPane(tabId: string, pane: { width: number; height: number; dpr: number; visible: boolean }): void {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) return;
    if (!pane.visible) {
      this.#panes.delete(tabId);
      return;
    }
    this.#panes.set(tabId, pane);
    // A restored/synced tab may be visible before any selection RPC wakes it.
    // Coalesce with restore/select so a visible pane cannot wait forever for
    // a page that nobody has requested, or open duplicate backend pages.
    if (tab.backendTabId === null) void this.#wake(tabId).then(() => this.publish()).catch(() => {
      this.#log.warn("waking a visible pane failed", { tabId });
    });
    const existing = this.#viewportTimers.get(tabId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#viewportTimers.delete(tabId);
      const backendTabId = this.#tabs.get(tabId)?.backendTabId;
      if (backendTabId == null) return;
      void this.#backend
        .setViewport?.(backendTabId, { width: pane.width, height: pane.height })
        .catch(() => undefined);
    }, VIEWPORT_DEBOUNCE_MS);
    timer.unref();
    this.#viewportTimers.set(tabId, timer);
  }

  paneFor(tabId: string): { width: number; height: number; dpr: number; visible: boolean } | null {
    return this.#panes.get(tabId) ?? null;
  }

  /** The guard session behind a host tab id — what a screencast and input attach to. */
  guardSessionFor(tabId: string): import("playwright-core").CDPSession | null {
    const backendTabId = this.#tabs.get(tabId)?.backendTabId ?? null;
    return backendTabId === null ? null : (this.#backend.guardFor(backendTabId)?.session ?? null);
  }

  /** Tabs the shell is painting right now, in stable split-group order. */
  visibleTabIds(): string[] {
    return this.#visibleTabIds();
  }

  hasTab(tabId: string): boolean {
    return this.#tabs.has(tabId);
  }

  /**
   * A viewer is driving. The socket says so before it dispatches that
   * viewer's call, and it is what decides who a page's file picker is shown
   * to: the person about to choose a file is the person who just clicked
   * something (§11). A page event has no viewer of its own to ask.
   */
  noteViewerActivity(viewerId: string): void {
    this.#drivingViewerId = viewerId;
  }

  /** Who the host believes is driving, for the socket's tests and its logs. */
  drivingViewerId(): string | null {
    return this.#drivingViewerId;
  }

  /** File pickers still waiting for an answer, for the socket's teardown and tests. */
  pendingFileRequests(): string[] {
    return [...this.#fileRequests.keys()];
  }

  /* -------------------------------- console -------------------------------- */

  /**
   * Attach the console to control. The registry does this when the session is
   * built, and the executor's own events arrive through `receiveRunEvent`
   * below — same process, so the open run's snapshot never waits on a stream.
   */
  setRunGateway(gateway: ShellRunGateway | null): void {
    this.#runs = gateway;
    if (gateway !== null) void this.refreshThreads();
  }

  /**
   * A new conversation, the desktop's own motion (`main/run-controller.ts`):
   * a task still acting is stopped, then the console is cleared. The RUN is
   * created by the `startDelegation` that follows — a thread with no intent
   * is not something control can be asked for.
   */
  async newThread(): Promise<void> {
    const open = this.#run;
    if (open !== null && !isTerminalStatus(open.status)) {
      await this.revokeRun().catch((error: unknown) => {
        this.#log.warn("stopping the open run before a new thread failed", { error: errorMessage(error) });
      });
    }
    this.#adopt(null);
  }

  /** The console's composer: a run on this session's own tabs (§8). */
  async startDelegation(intent: string, attachments?: AgentAttachment[]): Promise<void> {
    await this.#startRun({ intent, attachments: attachments ?? [] });
  }

  /**
   * On the web every run is a cloud run — the tabs are already the cloud's —
   * so the shell's "run this in the cloud" is the same motion as delegating,
   * and answers the run it made.
   */
  async startCloudRun(request: CloudStartRunRequest): Promise<{ runId: string }> {
    const startUrl = webStartUrl(request.startUrl);
    return {
      runId: await this.#startRun({
        intent: request.intent,
        attachments: request.attachments ?? [],
        ...(startUrl === undefined ? {} : { startUrl }),
      }),
    };
  }

  async sendAgentMessage(content: string, attachments?: AgentAttachment[]): Promise<void> {
    await this.#command("message", {
      text: content,
      ...(attachments === undefined || attachments.length === 0 ? {} : { attachments }),
    });
  }

  async answerAgentQuestion(questionId: string, answer: string): Promise<void> {
    await this.#command("answer", { questionId, value: answer });
  }

  async approve(approvalId: string): Promise<void> {
    await this.#command("approve", { approvalId });
  }

  async reject(approvalId: string): Promise<void> {
    await this.#command("reject", { approvalId });
  }

  async interruptAgent(): Promise<void> {
    await this.#command("interrupt", {});
  }

  /**
   * Control's `interrupt` IS the takeover on a hosted run (§7.5: running →
   * `human_control`), and it is what moves the session's fence to the person
   * — so from the answer's `{t:'control', generation}` the pane starts
   * accepting input, and the agent's next tool call is already stale.
   */
  async takeControl(): Promise<void> {
    await this.#command("interrupt", {});
  }

  /**
   * Control releases a run only from `human_control`. A takeover the agent
   * asked for parks at `waiting_for_step_up` and a stopped run at
   * `interrupted`; for both, taking control is the documented exit, and only
   * then does release hand the wheel back — the desktop's cloud path exactly.
   */
  async releaseControl(): Promise<void> {
    if (this.#run !== null && this.#run.status !== "human_control") await this.#command("interrupt", {});
    await this.#command("release", {});
  }

  async revokeRun(): Promise<void> {
    await this.#command("revoke", {});
  }

  /**
   * Reopen a saved conversation. A run a desktop executor mirrored carries
   * its whole `RunSummary` in one sealed snapshot; a run the cloud drove
   * carries an execution checkpoint instead, so that one is rebuilt the way
   * the desktop rebuilds it — by folding its event stream, with the content
   * events opened under this session's Space keys.
   */
  async openThread(runId: string): Promise<void> {
    if (this.#run?.runId === runId) return;
    if (this.#run !== null && !isTerminalStatus(this.#run.status)) {
      throw new Error("pause or end the current task before opening another conversation");
    }
    const gateway = this.#requireRuns();
    const listed = await gateway.list();
    this.#threads = listed.runs;
    const sealed = listed.threads.find((thread) => thread.runId === runId);
    const mirrored = sealed === undefined ? null : await gateway.openThread(runId, sealed.sealed);
    if (mirrored !== null) {
      this.#adopt(mirrored);
      return;
    }
    const { run, evidence } = await this.#replay(runId);
    if (run === null) throw new Error("that conversation is no longer available");
    this.#adopt(run, evidence);
  }


  async getEvidence(): Promise<EvidenceEntry[]> {
    return [...this.#evidence];
  }

  /**
   * The pane IS the live view here (W1, W10): the session's tabs are already
   * painted into the shell over this socket, and a run acts in those very
   * tabs. So the three live-view members are no-ops that answer success
   * rather than refusals — a shell that opens the live view of the run it is
   * watching is already watching it, and forwarded input travels as `input`
   * on the shell socket under the session's own control generation, not as
   * `sendLiveInput`.
   */
  async openLiveView(): Promise<never> {
    return unsupported("openLiveView");
  }

  async closeLiveView(): Promise<void> {
    // Nothing to close: the pane keeps painting whoever holds the wheel.
  }

  sendLiveInput(_input: CloudLiveInput): void {
    // Input arrives as `{t:'input'}` on the shell socket, fenced by the
    // session's control generation (§5). Nothing to forward here.
  }

  /* ------------------------- the console's internals ------------------------ */

  #requireRuns(): ShellRunGateway {
    const gateway = this.#runs;
    if (gateway === null) throw new UnsupportedShellMethodError("startDelegation", "this session has no control client");
    return gateway;
  }

  async #startRun(input: { intent: string; attachments: AgentAttachment[]; startUrl?: string }): Promise<string> {
    const intent = input.intent.trim();
    if (intent === "") throw new Error("say what the agent should do");
    const gateway = this.#requireRuns();
    const started = await gateway.start({ ...input, intent });
    this.#adopt(null);
    this.#applyEvents(started.runId, started.events, started.at);
    void this.refreshThreads();
    return started.runId;
  }

  async #command(command: SessionRunCommandName, body: Parameters<ShellRunGateway["command"]>[2]): Promise<void> {
    const run = this.#run;
    if (run === null) throw new Error("no conversation is open");
    const gateway = this.#requireRuns();
    const result = await gateway.command(run.runId, command, body);
    this.#applyEvents(run.runId, result.events, result.at);
  }

  /**
   * One event the run produced, from wherever it came: the answer to a
   * command control just applied, or — for a run this very worker is
   * executing — the executor's own callback, in plaintext, before it is ever
   * sealed. That second path is why the open run's snapshot never waits on
   * SSE (§8).
   */
  receiveRunEvent(runId: string, event: RunControlEvent | RunContentEvent, at: string): void {
    this.#applyEvents(runId, [event], at);
  }

  #applyEvents(runId: string, events: Array<RunControlEvent | RunContentEvent>, at: string): void {
    if (events.length === 0) return;
    // The fence control moved travels on the run's own stream, and it is the
    // SESSION's fence, not the conversation's: a hand-back from a run started
    // on another device belongs to this pane too. Mirrored before the "is
    // this the open conversation" guard, which used to make such a hand-back
    // wait for the next heartbeat with the agent's veil still up (W7).
    for (const event of events) {
      if (event.t === "control" && "generation" in event && typeof event.generation === "number") {
        this.#runs?.setControl({
          holder: event.control === "agent" ? "agent" : "human",
          generation: event.generation,
        });
      }
    }
    if (this.#run !== null && this.#run.runId !== runId) return; // another conversation's stream
    let changed = false;
    for (const event of events) {
      if (event.t === "evidence") {
        this.#evidence = [...this.#evidence, event.entry as unknown as EvidenceEntry];
        changed = true;
      }
      let folded: RunSummary | null;
      try {
        folded = foldRunInto(this.#run, runId, event, at);
      } catch (error) {
        this.#log.warn("a run event could not be folded", { runId, t: event.t, error: errorMessage(error) });
        continue;
      }
      if (folded === null) continue;
      const wasTerminal = this.#run !== null && isTerminalStatus(this.#run.status);
      this.#run = folded;
      changed = true;
      if (event.t === "status" && isTerminalStatus(event.status) && !wasTerminal) void this.refreshThreads();
      if (event.t === "title") void this.refreshThreads();
    }
    if (changed) this.publishRun();
  }

  /** Read the run's stream and fold it whole, opening what this Space can open. */
  async #replay(runId: string): Promise<{ run: RunSummary | null; evidence: EvidenceEntry[] }> {
    const gateway = this.#requireRuns();
    const stored = await gateway.events(runId);
    const evidence: EvidenceEntry[] = [];
    let run: RunSummary | null = null;
    let seq = 0;
    for (const raw of stored) {
      const parsed = parseStoredRunEvent(raw);
      if (parsed === null || parsed.seq <= seq) continue;
      seq = parsed.seq;
      let event: RunControlEvent | RunContentEvent | null;
      if (parsed.event.t === "sealed") {
        event = await gateway.openEvent(runId, parsed.eventId, parsed.event.sealed);
        if (event !== null) event = parseContentEvent(event);
      } else {
        event = parsed.event as RunControlEvent;
      }
      if (event === null) continue;
      if (event.t === "evidence") evidence.push(event.entry as unknown as EvidenceEntry);
      try {
        run = foldRunInto(run, runId, event, parsed.at) ?? run;
      } catch (error) {
        this.#log.warn("a replayed run event could not be folded", { runId, error: errorMessage(error) });
      }
    }
    return { run, evidence };
  }

  /** Put a conversation in the console (or clear it) and publish once. */
  #adopt(run: RunSummary | null, evidence: EvidenceEntry[] = []): void {
    this.#run = run;
    this.#evidence = evidence;
    this.publishRun();
  }

  /**
   * Re-read the session's Space's threads. Single-flight: a burst of reasons
   * to refresh (a run created, a title, a run ending) is one read.
   */
  refreshThreads(): Promise<void> {
    const gateway = this.#runs;
    if (gateway === null || this.#closed) return Promise.resolve();
    const existing = this.#listing;
    if (existing !== null) return existing;
    const work = gateway
      .list()
      .then((listed) => {
        if (this.#closed) return;
        this.#threads = listed.runs;
        this.publishRun();
      })
      .catch((error: unknown) => {
        this.#log.warn("the session's thread list could not be read", { error: errorMessage(error) });
      })
      .finally(() => {
        if (this.#listing === work) this.#listing = null;
      });
    this.#listing = work;
    return work;
  }

  /* ---------------------------- the page bridge ---------------------------- */

  /**
   * Give a page the bridge (`tab-bridge.ts`) and the two Playwright events a
   * cloud tab needs answering for it: a download, and a file picker. Once per
   * page, and never awaited by a caller — a tab that cannot be instrumented
   * still browses, it just reports nothing, which every affordance below
   * already reads as "nothing here".
   */
  #instrument(tabId: string, page: Page): Promise<void> {
    const already = this.#bridged.get(page);
    if (already !== undefined) return already;
    page.on("download", (download) => {
      const downloads = this.#downloads;
      if (downloads === null) {
        this.#log.warn("a download arrived with nowhere to keep it", { tabId, url: download.url() });
        void download.cancel().catch(() => undefined);
        return;
      }
      this.#log.info("a download started", { tabId, url: download.url() });
      const verdict = this.#actionVerdict("download");
      this.#recordPolicy(tabId, "download", verdict);
      if (verdict.decision === "block") {
        void download.cancel().catch(() => undefined);
        return;
      }
      downloads.accept(tabId, page.url(), download);
    });
    page.on("filechooser", (chooser) => {
      const requestId = randomUUID();
      const viewerId = this.#drivingViewerId;
      const timer = setTimeout(() => {
        void this.cancelFileRequest(requestId).catch(() => undefined);
      }, FILE_REQUEST_TIMEOUT_MS);
      timer.unref();
      this.#fileRequests.set(requestId, { tabId, chooser, viewerId, timer });
      this.#emitStream(
        "pistachio:file-request",
        {
          requestId,
          tabId,
          multiple: chooser.isMultiple(),
          accept: [],
        } satisfies StreamFileRequest,
        viewerId,
      );
    });
    page.on("close", () => {
      this.#bridged.delete(page);
      this.#media.delete(tabId);
      this.#disposeMirror(tabId);
      this.#publishMedia();
    });
    this.assetBroker().observe(page);
    const installed = (async (): Promise<void> => {
      await installTabBridge(
        page,
        tabId,
        { onReport: (id, report, origin) => this.#onTabReport(id, report, origin) },
        this.#bridgeBinding,
      );
      await this.#installMirrorRecorder(page, tabId);
      await this.#installPageResume(page, tabId);
    })();
    this.#bridged.set(page, installed);
    return installed;
  }

  async #installPageResume(page: Page, tabId: string): Promise<void> {
    const binding = `__${randomUUID().replaceAll("-", "")}`;
    await page.exposeBinding(binding, (source, value: unknown) => {
      const tab = this.#tabs.get(tabId);
      if (!tab || source.frame !== page.mainFrame() || tab.kind !== "human") return;
      const resume = sanitizePageResume(value, page.url());
      if (!resume || JSON.stringify(resume) === JSON.stringify(tab.resume)) return;
      tab.resume = resume;
      this.publish();
    });
    const script = `(() => {
      if (window.top !== window) return;
      const name = ${JSON.stringify(binding)};
      const descriptor = Object.getOwnPropertyDescriptor(window, name);
      if (descriptor) Object.defineProperty(window, name, { ...descriptor, enumerable: false });
      let timer;
      const report = () => { timer = undefined; window[${JSON.stringify(binding)}]((${capturePageResume.toString()})()).catch(() => {}); };
      const queue = () => { if (timer === undefined) timer = setTimeout(report, 600); };
      addEventListener("scroll", queue, {passive:true});
      addEventListener("input", queue, {passive:true});
      addEventListener("pagehide", report);
      queue();
    })()`;
    await page.addInitScript({ content: script });
    await page.evaluate(script).catch(() => undefined);
  }

  /* ------------------------------ DOM mirror ------------------------------- */

  /**
   * Install the recorder (docs/web-browser-design.md §16.2) in a page: a
   * binding it reports through, and its source as an init script (for the
   * documents to come) and an immediate evaluate (for the one already here).
   * Like the bridge, it is best-effort — a page that cannot be instrumented
   * simply has no `dom` pane, and its panes stay on pixels.
   */
  async #installMirrorRecorder(page: Page, tabId: string): Promise<void> {
    const source = mirrorRecorderSource({ control: this.#mirrorControl, binding: this.#mirrorBinding });
    await page
      .exposeBinding(this.#mirrorBinding, (source, payload: unknown) => {
        if (source.frame !== page.mainFrame()) return;
        this.#mirrors.get(tabId)?.mirror.onReport(payload);
      })
      .catch(() => undefined);
    await page.addInitScript(source).catch(() => undefined);
    await page.evaluate(source).catch(() => undefined);
  }

  /** Captured page responses, without any additional origin requests. */
  assetBroker(): AssetBroker {
    if (this.#broker !== null) return this.#broker;
    this.#broker = new AssetBroker({ log: this.#log });
    return this.#broker;
  }

  /**
   * The live DOM mirror for a tab, created on demand and bound to the tab's
   * current page and guard session. A tab that woke into a fresh page gets a
   * fresh mirror; a tab with no page yet has none.
   */
  mirrorFor(tabId: string): TabMirror | null {
    const page = this.#pageFor(tabId);
    const session = this.guardSessionFor(tabId);
    if (page === null || session === null) return null;
    const existing = this.#mirrors.get(tabId);
    if (existing !== undefined) {
      if (existing.session === session) return existing.mirror;
      existing.mirror.dispose();
      this.#mirrors.delete(tabId);
    }
    const mirror = new TabMirror({ page, session, tabId, broker: this.assetBroker(), control: this.#mirrorControl,
      ready: () => this.#instrument(tabId, page), log: this.#log,
      media: this.#backend.guardFor(this.#tabs.get(tabId)?.backendTabId ?? "")?.media });
    this.#mirrors.set(tabId, { mirror, session });
    return mirror;
  }

  #disposeMirror(tabId: string): void {
    const existing = this.#mirrors.get(tabId);
    if (existing === undefined) return;
    this.#mirrors.delete(tabId);
    existing.mirror.dispose();
  }

  /** One report from a tab. A permission report answers with the decision. */
  #onTabReport(tabId: string, report: TabReport, origin: string): unknown {
    // A page's copy and a page's context menu are consequences of somebody's
    // input, exactly as a file picker is, and they belong to the viewer whose
    // input caused them: mirroring a copy into every attached browser's
    // clipboard, or raising a menu in a tab nobody right-clicked, is the same
    // mistake as showing the picker to the wrong person (§13, revision 6).
    const driver = this.#drivingViewerId;
    if (report.kind === "clipboard") {
      this.#emitStream(
        "pistachio:clipboard-copy",
        { tabId, text: report.text } satisfies StreamClipboardCopy,
        driver,
      );
      return undefined;
    }
    if (report.kind === "contextmenu") {
      this.#emitStream(
        "pistachio:context-menu",
        {
          tabId,
          x: report.x,
          y: report.y,
          target: report.target,
        } satisfies StreamContextMenuEvent,
        driver,
      );
      return undefined;
    }
    if (report.kind === "link") {
      // One of the browser's own addresses, clicked inside a host-rendered
      // document. The only ones this host serves are the welcome pages (§14).
      this.#followWelcomeLink(tabId, report.url);
      return undefined;
    }
    if (report.kind === "media") {
      const tab = this.#tabs.get(tabId);
      if (tab === undefined) return undefined;
      if (report.report === null) this.#media.delete(tabId);
      else {
        const previous = this.#media.get(tabId);
        this.#media.set(tabId, {
          ...report.report,
          tabId,
          tabTitle: tab.title,
          tabUrl: tab.url,
          faviconUrl: tab.faviconUrl,
          muted: report.report.elementMuted,
          audible: report.report.playing && !report.report.elementMuted,
          updatedAt: this.#now(),
          lastActiveAt:
            previous !== undefined && previous.playing === report.report.playing
              ? previous.lastActiveAt
              : this.#now(),
          // Read aloud is refused here (UNSUPPORTED), so no card has a page to follow.
          followText: null,
          // A cloud session never grants the camera or microphone.
          call: false,
        });
      }
      this.#publishMedia();
      return undefined;
    }
    // The origin is the calling FRAME's, resolved by Playwright — never the
    // one the page put in the payload (tab-bridge.ts).
    return this.#askPermission(tabId, report.permission, origin);
  }

  /* ------------------------------- media stack ----------------------------- */

  async getMedia(): Promise<BrowserMediaInfo[]> {
    return this.#mediaList();
  }

  onMediaChanged(listener: (media: BrowserMediaInfo[]) => void): () => void {
    this.#mediaListeners.add(listener);
    return () => this.#mediaListeners.delete(listener);
  }

  /**
   * Drive the playing element in a tab. The desktop relays these to the tab's
   * isolated preload; here the same intent is one `page.evaluate`, because
   * the element is in a page this process can reach directly.
   */
  async controlMedia(tabId: string, control: MediaControl): Promise<void> {
    if (control.type === "dismiss") {
      this.#media.delete(tabId);
      this.#publishMedia();
      return;
    }
    if (control.type === "focus") {
      await this.selectTab(tabId);
      return;
    }
    // Only a read-aloud card offers it, and there are none here.
    if (control.type === "followText") return;
    const page = this.#pageFor(tabId);
    if (page === null) return;
    await page.evaluate(mediaControlScript(control)).catch(() => undefined);
  }

  #mediaList(): BrowserMediaInfo[] {
    return [...this.#media.values()]
      .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
      .map((info) => ({ ...info }));
  }

  #publishMedia(): void {
    const media = this.#mediaList();
    for (const listener of [...this.#mediaListeners]) this.#safely(() => listener(media));
  }

  /* -------------------------------- read aloud ----------------------------- */

  /**
   * Nothing is generating. The worker synthesizes no audio (there is no
   * speaker on it and no clip tab to open), so the honest answer is an empty
   * list rather than a refusal: the toast belongs above the media stack, and
   * there is nothing to put there.
   */
  async getReadAloud(): Promise<ReadAloudStatus[]> {
    return [];
  }

  onReadAloudChanged(): () => void {
    return () => undefined;
  }

  async cancelReadAloud(): Promise<never> {
    return unsupported("cancelReadAloud");
  }

  async readAloudText(): Promise<never> {
    return unsupported("readAloudText");
  }

  async retryAgentTurn(): Promise<never> {
    return unsupported("retryAgentTurn");
  }

  /* --------------------------- site controls & policy ---------------------- */

  async getBrowserControls(): Promise<BrowserControlsSnapshot> {
    return this.#controls();
  }

  onBrowserControlsChanged(listener: (snapshot: BrowserControlsSnapshot) => void): () => void {
    this.#controlsListeners.add(listener);
    return () => this.#controlsListeners.delete(listener);
  }

  async browserControl(command: BrowserControlCommand): Promise<void> {
    switch (command.type) {
      case "resolvePermission": {
        const pending = this.#pendingPermissions.find((entry) => entry.request.id === command.requestId);
        if (pending === undefined) return;
        this.#pendingPermissions = this.#pendingPermissions.filter((entry) => entry !== pending);
        const granted = command.decision !== "block";
        if (command.decision !== "allow-once") {
          this.#setSitePermission(originHost(pending.request.origin), pending.request.permission, granted ? "allow" : "block");
        }
        if (granted) await this.#grant(pending.request.origin, pending.request.permission);
        pending.answer(granted);
        // "Allow this time" means this time. `grantPermissions` persists for
        // the life of the context with no revoke of its own, so the grant is
        // taken back the moment the page's parked call has spent it —
        // otherwise the site holds a permanent grant that Site Controls shows
        // as `ask`, which is a lie in the person's favour of the site.
        if (granted && command.decision === "allow-once") await this.#revokeLiveGrants();
        if (!granted) await this.#revokeLiveGrants();
        this.#publishControls();
        return;
      }
      case "setPermission": {
        const url = this.#activeUrl();
        const host = originHost(url);
        if (host === "") return;
        this.#setSitePermission(host, command.permission, command.decision);
        if (command.decision === "allow") await this.#grant(url, command.permission);
        // Blocking a site it was already granted has to take the grant back:
        // storing "block" beside a live grant blocks nothing at all.
        else await this.#revokeLiveGrants();
        this.#publishControls();
        return;
      }
      case "clearPermissions": {
        const host = originHost(this.#activeUrl());
        if (host === "") return;
        const next = { ...this.#sitePermissions };
        delete next[host];
        this.#sitePermissions = next;
        // `clearPermissions` is whole-CONTEXT: resetting this site would
        // otherwise revoke every other site's live grant while leaving their
        // stored decisions in place, so the survivors are re-granted.
        await this.#revokeLiveGrants();
        this.publish();
        this.#publishControls();
        return;
      }
      case "selectPasskey": {
        // W12: an assertion binds to the site's origin and to a key that
        // lives on the person's own device. Nothing here can produce one.
        const pending = this.#pendingPermissions;
        void pending;
        throw new Error(PASSKEY_REASON);
      }
      case "zoomIn":
      case "zoomOut":
      case "zoomReset": {
        await this.#zoomBy(command.type);
        return;
      }
      case "toggleMute": {
        const tabId = this.#activeTabId;
        const page = tabId === null ? null : this.#pageFor(tabId);
        if (tabId === null || page === null) return;
        const muted = !(this.#muted.get(tabId) ?? false);
        this.#muted.set(tabId, muted);
        await page.evaluate(MUTE_SCRIPT(muted)).catch(() => undefined);
        this.#publishControls();
        return;
      }
      case "print": {
        const tabId = this.#activeTabId;
        if (tabId !== null) await this.printToPdf(tabId);
        return;
      }
      case "copyUrl": {
        // The clipboard is the person's, in their own browser. The pane does
        // the writing; the host only says what the text should be.
        const url = this.#activeUrl();
        const title = this.#activeTabId === null ? "" : (this.#tabs.get(this.#activeTabId)?.title ?? "");
        this.#emitStream(
          "pistachio:clipboard-copy",
          {
            tabId: this.#activeTabId ?? "",
            text: command.format === "markdown" ? `[${title === "" ? url : title}](${url})` : url,
            notice: copyUrlNotice(command.format),
          } satisfies StreamClipboardCopy,
          // The viewer that asked for the copy, not everyone watching.
          currentViewer()?.id ?? null,
        );
        return;
      }
      case "cancelDownload": {
        await this.#downloads?.cancel(command.downloadId);
        this.#publishControls();
        return;
      }
      case "removeDownload": {
        await this.#downloads?.remove(command.downloadId);
        this.#publishControls();
        return;
      }
      case "clearDownloads": {
        await this.#downloads?.clearFinished();
        this.#publishControls();
        return;
      }
      case "openDownload":
      case "showDownload":
      case "retryDownload": {
        // "Open" and "Show in Finder" name a desktop this worker is not, and
        // a retry is the page's own click to make again. The pane fetches a
        // finished download over `downloadUrl` instead.
        throw new Error(
          "A cloud download is fetched into your own browser — use the arrow beside it. There is no folder on this worker to open.",
        );
      }
    }
  }

  /**
   * The person answered nothing yet: park the page's own call, raise the
   * prompt in the shell, and resolve when they decide. A site whose decision
   * is already stored never gets here.
   */
  #askPermission(tabId: string, permission: BrowserPermission, origin: string): Promise<boolean> | boolean {
    // An opaque origin — a sandboxed iframe, a `data:` document, `about:blank`
    // — is nobody the person could sensibly be asked about, and it is exactly
    // what a hostile frame would present. It is refused without a prompt.
    const host = originHost(origin);
    if (host === "") return false;
    const stored = this.#sitePermissions[host]?.[permission];
    if (stored === "allow") {
      void this.#grant(origin, permission);
      return true;
    }
    if (stored === "block") return false;
    const existing = this.#pendingPermissions.find(
      (entry) => entry.request.tabId === tabId && entry.request.permission === permission,
    );
    if (existing !== undefined) return existing.promise;
    let answer: (granted: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((resolve) => {
      answer = resolve;
    });
    this.#pendingPermissions = [
      ...this.#pendingPermissions,
      {
        request: {
          id: randomUUID(),
          tabId,
          origin,
          permission,
          permissions: [permission],
          requestedAt: this.#now(),
        },
        answer,
        promise,
      },
    ];
    this.#publishControls();
    return promise;
  }

  async #grant(origin: string, permission: BrowserPermission): Promise<void> {
    const context = this.#context();
    if (context === null || originHost(origin) === "") return;
    await context.grantPermissions([permission], { origin: originOf(origin) }).catch(() => undefined);
  }

  /**
   * Put the context's live grants back in step with the durable decisions.
   *
   * Playwright has no per-origin revoke: `clearPermissions()` empties the
   * whole context. So the only honest way to take one grant back is to empty
   * it and re-grant everything that is still allowed — which is also what
   * makes "Block" and "Reset" mean anything at all, and what keeps a site's
   * "allow once" from outliving the call it was given for.
   */
  async #revokeLiveGrants(): Promise<void> {
    const context = this.#context();
    if (context === null) return;
    await context.clearPermissions().catch(() => undefined);
    for (const [origin, decisions] of Object.entries(this.#sitePermissions)) {
      const allowed = Object.entries(decisions)
        .filter(([, decision]) => decision === "allow")
        .map(([permission]) => permission as BrowserPermission);
      if (allowed.length === 0) continue;
      await context.grantPermissions(allowed, { origin }).catch(() => undefined);
    }
  }

  #setSitePermission(host: string, permission: BrowserPermission, decision: PermissionDecision): void {
    if (host === "") return;
    this.#sitePermissions = {
      ...this.#sitePermissions,
      [host]: { ...this.#sitePermissions[host], [permission]: decision },
    };
    // The decision is durable: it rides the sealed session record (§9).
    this.publish();
  }

  #activeUrl(): string {
    const tabId = this.#activeTabId;
    return tabId === null ? "" : (this.#tabs.get(tabId)?.url ?? "");
  }

  #actionVerdict(action: GuardedBrowserAction): BrowserPolicyVerdict<ActionDecision> {
    void action;
    return { decision: "allow", source: "default", reason: "Allowed by default." };
  }

  /**
   * Write one policy decision into the session's own log, the way the
   * desktop's `#recordPolicy` does. Site Controls reads it back as
   * `recentEvents`, and a decision that is applied but never recorded is a
   * decision the person cannot see was ever made.
   */
  #recordPolicy(
    tabId: string | null,
    capability: BrowserPermission | GuardedBrowserAction | "passkey",
    verdict: BrowserPolicyVerdict<"allow" | "block" | "ask">,
  ): void {
    this.#policyEvents = [
      {
        id: randomUUID(),
        tabId: tabId ?? "",
        origin: browserOrigin(tabId === null ? "" : (this.#tabs.get(tabId)?.url ?? "")),
        capability,
        decision: verdict.decision,
        source: verdict.source,
        reason: verdict.reason,
        occurredAt: this.#now(),
      },
      ...this.#policyEvents,
    ].slice(0, MAX_POLICY_EVENTS);
    this.#publishControls();
  }

  #controls(): BrowserControlsSnapshot {
    const tabId = this.#activeTabId;
    const tab = tabId === null ? undefined : this.#tabs.get(tabId);
    const url = tab?.url ?? "";
    const host = hostOfUrl(url);
    const stored = this.#sitePermissions[originHost(url)] ?? {};
    const permissions = Object.fromEntries(
      BROWSER_PERMISSIONS.map((permission) => {
        if (permission === "camera" || permission === "microphone") {
          return [permission, { decision: "block", source: "managed", reason: MEDIA_DEVICE_REASON }];
        }
        // A cloud page has no app of yours to open: the worker's Chromium
        // drops such links, and the controls say why rather than offer a
        // switch that does nothing.
        if (permission === "external-app") {
          return [permission, { decision: "block", source: "managed", reason: EXTERNAL_APP_REASON }];
        }
        const decision = stored[permission] ?? "ask";
        return [
          permission,
          {
            decision,
            source: stored[permission] === undefined ? "default" : "user",
            reason:
              stored[permission] === undefined
                ? "This site has not asked yet."
                : decision === "allow"
                  ? "You allowed this site."
                  : decision === "block"
                    ? "You blocked this site."
                    : "This site is asked about each time.",
          },
        ];
      }),
    ) as Record<BrowserPermission, BrowserPolicyVerdict<PermissionDecision>>;
    const actions = Object.fromEntries(
      GUARDED_BROWSER_ACTIONS.map((action) => [action, this.#actionVerdict(action)]),
    ) as Record<GuardedBrowserAction, BrowserPolicyVerdict<ActionDecision>>;
    return {
      tabId,
      tabKind: tab?.kind ?? null,
      origin: browserOrigin(url),
      secure: isSecureBrowserUrl(url),
      zoomPercent: Math.round((this.#zoom[host] ?? 1) * 100),
      muted: tabId === null ? false : (this.#muted.get(tabId) ?? false),
      permissions,
      externalAppSchemes: [],
      actions,
      passkeys: {
        // W12, reported rather than discovered: the shell shows the
        // affordance as unavailable with this reason.
        webAuthnAvailable: false,
        platformAuthenticatorAvailable: false,
        conditionalMediationAvailable: false,
        touchIdConfigured: false,
      },
      pendingPermissions: this.#pendingPermissions.map((entry) => ({ ...entry.request })),
      pendingPasskeyRequests: [],
      downloads: this.#downloads?.list() ?? [],
      recentEvents: this.#policyEvents.map((event) => ({ ...event })),
    };
  }

  #publishControls(): void {
    const snapshot = this.#controls();
    for (const listener of [...this.#controlsListeners]) this.#safely(() => listener(snapshot));
  }

  /* ---------------------------------- zoom --------------------------------- */

  /**
   * Zoom is per ORIGIN HOST and lives in the session record, so a site the
   * person enlarged is enlarged on the next worker too (§9, §11). CDP's page
   * scale factor is not used: it moves the compositor under the screencast
   * and the pane's pointer arithmetic stops agreeing with the page.
   */
  async #zoomBy(kind: "zoomIn" | "zoomOut" | "zoomReset"): Promise<void> {
    const tabId = this.#activeTabId;
    const url = this.#activeUrl();
    const host = hostOfUrl(url);
    if (tabId === null || host === "") return;
    const current = this.#zoom[host] ?? 1;
    const next =
      kind === "zoomReset" ? 1 : Math.min(3, Math.max(0.5, Math.round((current + (kind === "zoomIn" ? 0.1 : -0.1)) * 100) / 100));
    if (next === 1) {
      const rest = { ...this.#zoom };
      delete rest[host];
      this.#zoom = rest;
    } else {
      this.#zoom = { ...this.#zoom, [host]: next };
    }
    await this.#applyZoom(tabId);
    this.publish();
    this.#publishControls();
  }

  async #applyZoom(tabId: string): Promise<void> {
    const page = this.#pageFor(tabId);
    if (page === null) return;
    const host = hostOfUrl(this.#tabs.get(tabId)?.url ?? "");
    const factor = this.#zoom[host] ?? 1;
    await page.evaluate(zoomScript(factor)).catch(() => undefined);
  }

  /* -------------------------------- downloads ------------------------------ */

  async getDownloads(): Promise<BrowserDownload[]> {
    return this.#downloads?.list() ?? [];
  }

  onDownloadsChanged(listener: (downloads: BrowserDownload[]) => void): () => void {
    const downloads = this.#downloads;
    if (downloads === null) return () => undefined;
    return downloads.onChanged(listener);
  }

  /**
   * A one-use URL for a finished download (§11). The bytes travel over plain
   * HTTP, not the socket, and the token is bound to the viewer's device: a
   * link that leaves this browser tab opens nothing.
   */
  async downloadUrl(downloadId: string): Promise<{ url: string }> {
    const downloads = this.#downloads;
    const viewer = currentViewer();
    if (downloads === null) throw new Error("this session keeps no downloads");
    if (viewer === null) throw new Error("a download is fetched by a viewer, and no viewer asked");
    const token = downloads.mint(downloadId, viewer.downloadKey);
    if (token === null) throw new Error("that download is not ready");
    return {
      url: `/v1/shell/${encodeURIComponent(this.sessionId)}/downloads/${encodeURIComponent(downloadId)}?access_token=${token}`,
    };
  }

  /**
   * Spend a minted token. The shell server calls this from its HTTP route
   * with the key the request presented: the token alone is not enough, or a
   * URL that leaves this browser tab would still open somebody's file.
   */
  async openDownload(downloadId: string, token: string, viewerKey: string): Promise<DownloadStream | null> {
    return (await this.#downloads?.redeem(downloadId, token, viewerKey)) ?? null;
  }

  /**
   * Print a tab to PDF; the result is a download like any other (§11).
   *
   * The desktop applies the `print` verdict and records the decision before
   * it prints; a managed deployment that blocks printing must be blocked here
   * too, or the cloud browser is the way around the policy.
   */
  async printToPdf(tabId: string): Promise<void> {
    this.#requireControl("print");
    this.#requireAction(tabId, "print");
    const downloads = this.#downloads;
    const page = this.#pageFor(tabId);
    if (downloads === null || page === null) throw new Error("that tab has no page to print");
    const tab = this.#tabs.get(tabId);
    const name = pageFileName(tab?.title ?? "", tab?.url ?? "");
    const reserved = await downloads.reserve(`${name}.pdf`);
    const bytes = await page.pdf({ path: reserved.path, printBackground: true }).catch((error: unknown) => {
      throw new Error(`this page could not be printed: ${errorMessage(error)}`);
    });
    downloads.adopt({
      tabId,
      pageUrl: tab?.url ?? "",
      fileName: `${name}.pdf`,
      path: reserved.path,
      bytes: bytes.byteLength,
    });
    this.#publishControls();
  }

  /* --------------------------------- uploads ------------------------------- */

  onFileRequest(listener: (request: StreamFileRequest) => void): () => void {
    return this.#streamOn("pistachio:file-request", listener as (payload: unknown) => void);
  }

  /**
   * The person picked files in their own browser; they land in the page's
   * waiting `filechooser`. The bytes come base64 over the socket, which is
   * why the whole request is capped: an upload is a person-sized thing, and a
   * frame big enough to stall every pane on the session is not.
   */
  async provideFiles(requestId: string, files: StreamFile[]): Promise<void> {
    this.#requireControl("upload a file");
    const pending = this.#fileRequests.get(requestId);
    if (pending === undefined || !this.#ownsFileRequest(pending)) {
      throw new Error("that file request is no longer open");
    }
    this.#requireAction(pending.tabId, "upload");
    this.#forgetFileRequest(requestId);
    const chosen = files.slice(0, 32);
    // Measured BEFORE anything is decoded. Allocating every buffer and then
    // comparing the total is the allocation the cap exists to prevent: base64
    // is 3 bytes for every 4, so the encoded length is the cheap upper bound.
    const encoded = chosen.reduce((sum, file) => sum + file.base64.length, 0);
    if (Math.floor((encoded / 4) * 3) > MAX_UPLOAD_BYTES) {
      await pending.chooser.setFiles([]).catch(() => undefined);
      throw new Error("That is more than the 32 MB one upload can carry through the cloud browser.");
    }
    let total = 0;
    const payload = chosen.map((file) => {
      const buffer = Buffer.from(file.base64, "base64");
      total += buffer.byteLength;
      return {
        name: safeFileName(file.name),
        mimeType: file.type === "" ? "application/octet-stream" : file.type.slice(0, 200),
        buffer,
      };
    });
    if (total > MAX_UPLOAD_BYTES) {
      await pending.chooser.setFiles([]).catch(() => undefined);
      throw new Error("That is more than the 32 MB one upload can carry through the cloud browser.");
    }
    await pending.chooser.setFiles(payload);
  }

  async cancelFileRequest(requestId: string): Promise<void> {
    const pending = this.#fileRequests.get(requestId);
    // Only the viewer the picker was shown to may dismiss it: the request
    // used to be broadcast, so a second viewer closing its own dialog
    // cancelled the first viewer's upload halfway through.
    if (pending === undefined || !this.#ownsFileRequest(pending)) return;
    this.#forgetFileRequest(requestId);
    await pending.chooser.setFiles([]).catch(() => undefined);
  }

  /** Whether the caller is the viewer this request was addressed to. */
  #ownsFileRequest(pending: { viewerId: string | null }): boolean {
    const viewer = currentViewer();
    if (pending.viewerId === null || viewer === null) return true;
    return viewer.id === pending.viewerId;
  }

  #forgetFileRequest(requestId: string): void {
    const pending = this.#fileRequests.get(requestId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#fileRequests.delete(requestId);
  }

  /* -------------------------------- clipboard ------------------------------ */

  onClipboardCopy(listener: (copy: StreamClipboardCopy) => void): () => void {
    return this.#streamOn("pistachio:clipboard-copy", listener as (payload: unknown) => void);
  }

  /**
   * Paste what the person's own clipboard holds. `Input.insertText` is what
   * a real paste does to the focused field — it fires the input events a
   * page listens for — where a synthesized key sequence would not.
   */
  async pasteText(tabId: string, text: string): Promise<void> {
    this.#requireControl("paste into the page");
    this.#requireAction(tabId, "paste");
    const session = this.guardSessionFor(tabId);
    if (session === null) throw new Error("that tab has no page to paste into");
    await session.send("Input.insertText", { text: text.slice(0, MAX_PASTE_TEXT) });
  }

  /* ------------------------------- context menu ---------------------------- */

  onContextMenu(listener: (event: StreamContextMenuEvent) => void): () => void {
    return this.#streamOn("pistachio:context-menu", listener as (payload: unknown) => void);
  }

  /* ------------------------------- geolocation ----------------------------- */

  /**
   * The position the person's own browser reported, emulated for the cloud
   * page. Playwright sets it per CONTEXT, so it is this Space's position
   * while the pane holds it — which is the truth: one person, one place.
   */
  async setGeolocation(tabId: string, position: StreamGeolocation): Promise<void> {
    void tabId;
    const context = this.#context();
    if (context === null) return;
    await context
      .setGeolocation({
        latitude: clamp(position.latitude, -90, 90),
        longitude: clamp(position.longitude, -180, 180),
        accuracy: Math.max(0, Math.min(position.accuracy, 100_000)),
      })
      .catch(() => undefined);
  }

  /* ------------------------------ tab switcher ----------------------------- */

  /**
   * The five most recently active tabs with a still of each, captured from
   * the host rather than from a native view (§10). A sleeping tab has no
   * page and answers with metadata alone, exactly as the desktop's does.
   */
  async getTabSwitcherPreviews(): Promise<TabSwitcherPreview[]> {
    const recent = [...this.#tabs.values()]
      .filter((tab) => !tab.unlisted)
      .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
      .slice(0, TAB_SWITCHER_LIMIT);
    return Promise.all(
      recent.map(async (tab) => {
        const page = tab.backendTabId === null ? null : this.#pageFor(tab.id);
        if (page === null) return { tab: this.#info(tab), dataUrl: null };
        const shot = await page
          .screenshot({ type: "jpeg", quality: 55, scale: "css" })
          .catch(() => null);
        return {
          tab: this.#info(tab),
          dataUrl: shot === null ? null : `data:image/jpeg;base64,${shot.toString("base64")}`,
        };
      }),
    );
  }

  /** Control–Tab is the OS's on a Mac; in a browser tab the shell owns it. */
  onTabSwitcherInput(): () => void {
    return () => undefined;
  }

  /* ---------------------------------- glance ------------------------------- */

  /**
   * There is never a glance on a stream surface (§10). The hover preview is
   * a native view floating over the page, and this shell paints DOM: so a
   * glance request opens the target as a tab beside the current one, which is
   * what the person wanted to see, and the overlay never exists.
   */
  async getGlance(): Promise<null> {
    return null;
  }

  onGlanceChanged(): () => void {
    return () => undefined;
  }

  async openGlance(request: ShellGlanceOpenRequest): Promise<boolean> {
    const activeTabId = this.#activeTabId;
    const id = await this.#createTab(request.url, { activate: true });
    if (activeTabId !== null) this.#place(id, this.#orderedTabs().findIndex((tab) => tab.id === activeTabId) + 1);
    this.publish();
    return true;
  }

  async closeGlance(): Promise<void> {
    return undefined;
  }

  async promoteGlance(): Promise<void> {
    return undefined;
  }

  async splitGlance(): Promise<void> {
    return undefined;
  }

  onGlanceDismissRequested(): () => void {
    return () => undefined;
  }

  onShellCommand(): () => void {
    return () => undefined;
  }

  async submitFeedback(): Promise<never> {
    return unsupported("submitFeedback");
  }

  /* ---------------------------------- reader ------------------------------- */

  /**
   * Reader view, without a `pistachio://` protocol to serve it from: the
   * article is extracted in the page with the desktop's own script, rendered
   * to a self-contained document, and navigated to as a `data:` URL in a tab
   * beside the original. Leaving reader view is the Back the tab already has,
   * and the shell's toggle closes the tab.
   */
  async toggleReaderView(tabId?: string): Promise<boolean> {
    const target = tabId ?? this.#activeTabId;
    if (target === null) return false;
    const tab = this.#tabs.get(target);
    if (tab === undefined) return false;
    if (tab.readerFor !== null) {
      await this.closeTab(target);
      return true;
    }
    const page = this.#pageFor(target);
    if (page === null) return false;
    const raw = await page.evaluate(READER_EXTRACT_SCRIPT).catch((error: unknown) => {
      // The desktop warns here. A reader view that silently answers "no" is
      // indistinguishable from a page with no article, which is the one thing
      // a person reporting "reader does nothing" needs told apart.
      this.#log.warn("reading the article failed", { tabId: target, error: errorMessage(error) });
      return null;
    });
    const article = normalizeReaderArticle(raw);
    if (article === null || article.wordCount < 120) return false;
    // The tab is opened blank and then pointed at the article, because the
    // `data:` document is not a place the SSRF policy has any business
    // vetting: it makes no request, it IS the bytes. Going through
    // `openTab(url)` would send it to `assertAllowed`, which refuses every
    // scheme that is not http(s) — rightly, for anything a page can ask for.
    const id = await this.#createTab(undefined, { activate: true });
    const reader = this.#tabs.get(id);
    const readerPage = this.#pageFor(id);
    if (reader === undefined || readerPage === null) return false;
    await readerPage.goto(readerDataUrl(article), { waitUntil: "domcontentloaded" }).catch((error: unknown) => {
      this.#log.warn("opening the reader page failed", { tabId: target, error: errorMessage(error) });
    });
    reader.readerFor = target;
    reader.title = article.title;
    reader.url = readerPage.url();
    this.#place(id, this.#orderedTabs().findIndex((entry) => entry.id === target) + 1);
    this.publish();
    return true;
  }

  /* --------------------------------- welcome ------------------------------- */

  /**
   * The welcome page a tab is showing, or null when it is showing anything
   * else. Two addresses answer: the `data:` document this host rendered, and
   * the `pistachio://` address a restored (still sleeping) tab carries.
   */
  #welcomeOf(tab: HostTab): WelcomeTab["id"] | null {
    return this.#welcomeDocuments.get(tab.url) ?? welcomeTabFor(tab.url)?.id ?? null;
  }

  /** The logical address a welcome tab shows in the address bar. */
  #welcomeAddress(id: WelcomeTab["id"]): string {
    return (WELCOME_TABS.find((tab) => tab.id === id) ?? WELCOME_TABS[0]!).url;
  }

  /**
   * What the pages are personalised with: the person's own name, their
   * appearance and their shortcut labels. There is no `pistachio://` protocol
   * in a cloud tab, so there is no font and no asset directory to serve from
   * either — the package draws a system stack instead (§14).
   */
  #welcomeContext(name: string): WelcomePageContext {
    const settings = this.#readSettings();
    return {
      name,
      appearance: settings.appearance,
      shortcuts: settings.shortcuts,
      // `ShortcutPlatform` is "darwin" or "other", and the worker's Chromium
      // is Linux — so the labels are the plain ones (Ctrl, not ⌘), which is
      // what §11 already decided for the context menu's accelerators.
      platform: "other",
      // A browser follows its own `prefers-color-scheme`; `scheme: "system"`
      // therefore emits BOTH palettes rather than resolving one here.
      systemDark: false,
      assetBase: null,
      fontSrc: null,
    };
  }

  /** The name the greeting carries: what the walkthrough wrote to memory. */
  #welcomeName(): string {
    const workspace = this.#space.workspace;
    if (workspace === null) return "";
    try {
      const entry = workspace
        .person()
        .memory()
        .entries.find((candidate) => candidate.key === PROFILE_KEY.name && !candidate.isForgotten);
      return entry?.content ?? "";
    } catch {
      return "";
    }
  }

  /**
   * Render one welcome page into a tab, the way the reader renders an article
   * (§11): a self-contained `data:` document the tab is navigated to
   * directly, because a cloud tab has no `pistachio://` protocol and a
   * `data:` document makes no request for the SSRF policy to vet.
   */
  async #showWelcome(tabId: string, id: WelcomeTab["id"], name: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    const page = this.#pageFor(tabId);
    if (tab === undefined || page === null) return;
    const document = welcomeDocumentHtml(id, this.#welcomeContext(name));
    const address = `data:text/html;charset=utf-8,${encodeURIComponent(document)}`;
    this.#remember(address, id);
    await page.goto(address, { waitUntil: "domcontentloaded" }).catch((error: unknown) => {
      this.#log.warn("opening a welcome page failed", { tabId, welcome: id, error: errorMessage(error) });
    });
    // Chromium may hand the address back re-encoded; both spellings name the
    // same document, and the map is what decides a tab is a welcome tab. Only
    // a document that actually loaded: a goto that failed leaves the page on
    // `about:blank`, and remembering THAT would make every blank tab a
    // welcome tab.
    if (page.url().startsWith("data:")) this.#remember(page.url(), id);
    const current = this.#tabs.get(tabId);
    if (current === undefined) return;
    current.url = page.url();
    current.title = (WELCOME_TABS.find((entry) => entry.id === id) ?? WELCOME_TABS[0]!).title;
    this.publish();
  }

  /**
   * Remember one rendered welcome document, oldest first out. The bound is
   * generous — a render is deterministic, so the same page in the same theme
   * is the same address, and only a changed appearance or a changed name
   * makes a new one — and what falls out is a document nothing is showing
   * any more.
   */
  #remember(address: string, id: WelcomeTab["id"]): void {
    this.#welcomeDocuments.delete(address);
    this.#welcomeDocuments.set(address, id);
    while (this.#welcomeDocuments.size > MAX_WELCOME_DOCUMENTS) {
      const oldest = this.#welcomeDocuments.keys().next();
      if (oldest.done === true) break;
      this.#welcomeDocuments.delete(oldest.value);
    }
  }

  /**
   * The welcome tabs a finished walkthrough opens (§14): one per
   * `WELCOME_TABS` entry, the overview active, each showing its own
   * `pistachio://` address.
   */
  async #openWelcomeTabs(name: string): Promise<void> {
    for (const [index, tab] of WELCOME_TABS.entries()) {
      // Opened blank and then pointed at the document, exactly as the reader
      // is: `openTab(url)` would send a `data:` address to `assertAllowed`,
      // which rightly refuses every scheme a page can ask for.
      const id = await this.#createTab(undefined, { activate: index === 0 });
      await this.#showWelcome(id, tab.id, name);
    }
    this.publish();
  }

  /**
   * A link inside a welcome page. The pages link to each other by their
   * `pistachio://` addresses, and a `data:` document cannot navigate to one —
   * there is no such protocol in a cloud tab, and rewriting the links to the
   * next document's `data:` address is impossible anyway (each page links to
   * pages that link back). So the click is intercepted in the page bridge and
   * answered here: the tab is re-rendered with the page the link named, which
   * is the same move the person's own address bar would make on the desktop.
   */
  #followWelcomeLink(tabId: string, href: string): void {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined || this.#welcomeOf(tab) === null) return;
    const target = welcomeTabFor(href);
    if (target === null) return;
    void this.#showWelcome(tabId, target.id, this.#welcomeName());
  }

  /* ---------------------------- browsing data ------------------------------ */

  /** Archive capture and storage belong to the desktop installation. */
  async watchtower(): Promise<never> { return unsupported("watchtower"); }

  /** Tab groups, the tab archive and Tidy are the desktop's in v1 (docs/tab-tidy.md §5). */
  async tabGroupCommand(): Promise<never> { return unsupported("tabGroupCommand"); }
  async tabArchive(): Promise<never> { return unsupported("tabArchive"); }
  async tidy(): Promise<never> { return unsupported("tidy"); }

  /** The daily brief is gathered and composed in the desktop's main process (docs/reports.md). */
  async reports(): Promise<never> { return unsupported("reports"); }

  /**
   * The person's notes, out of the sealed workspace (docs/notes.md §7).
   *
   * The same registers their Mac writes, read and written here as the PERSON
   * — `{kind:"user", runId:null}` — so a note typed in a browser tab and a
   * note typed on the desktop are one document under LWW. The request is
   * checked before the store sees it: the shell is ours, but a socket frame
   * is not, and `noteRequest` is the same guard the desktop's `ipcMain`
   * handler runs.
   */
  async notes(request: unknown): Promise<NoteResponse> {
    const wanted = noteRequest(request);
    const person = this.#person();
    switch (wanted.type) {
      case "list":
        return { type: "list", notes: person.listNotes() };
      case "search":
        return { type: "list", notes: person.searchNotes(wanted.query, wanted.limit ?? MAX_NOTES) };
      case "get":
        return { type: "maybeNote", note: person.getNote(wanted.id) };
      case "create":
        return { type: "note", note: person.createNote(wanted.input ?? {}) };
      case "update":
        return { type: "note", note: person.updateNote(wanted.id, wanted.patch) };
      case "delete":
        person.deleteNote(wanted.id);
        return { type: "deleted" };
      case "putBlob":
        // The store hashes, dedupes and caps; `data` is base64 either way (N3).
        return { type: "blobId", id: person.putNoteBlob(wanted.data, wanted.mediaType).id };
      case "getBlob":
        return { type: "blob", blob: person.getNoteBlob(wanted.id) };
      case "exportHtml": {
        const note = person.getNote(wanted.id);
        if (note === null) throw new Error(`no note ${wanted.id}`);
        // Rendered on the worker, where the note already is: the pictures are
        // inlined from the same sealed registers (N9).
        return { type: "html", html: renderNoteHtml(note, { blob: (id) => person.getNoteBlob(id) }) };
      }
      // ── The sharing seam (stage 2b, docs/notes.md §8) ────────────────────
      // Publishing reads and writes `hosted_artifacts` with a DEVICE bearer,
      // which control forbids a `cloud` device (§7). Until stage 2b gives
      // this host a route of its own, nothing is published from here and the
      // Share menu is told so rather than shown a note as private that is not.
      case "sharing":
        return { type: "sharing", hosting: null };
      case "setVisibility":
        throw new Error("Sharing from the web arrives later");
      // Sharing with named accounts is the owner's Mac's too (§9): the body a
      // share reads is pushed with the same device bearer.
      case "shares":
        return { type: "shares", shares: null, found: true };
      case "share":
      case "unshare":
        throw new Error("Sharing with people from the web arrives later");
    }
  }

  onNotes(listener: (snapshot: NoteSnapshot) => void): () => void {
    // Metadata only, and `note-blob:` writes are silent in the store, so a
    // dropped picture does not re-serialise the library (N3, §4).
    return this.#onRecords(() => listener({ notes: this.#person().listNotes() }));
  }

  /**
   * A shell-drawn page naming its own tab (docs/notes.md §4): the note's
   * title on the strip, where the static placeholder could only say "Notes".
   * Refused for any other address — a page must not be able to relabel the
   * tab a person is reading — and bound to the address it was given for, so
   * the placeholder's own `<title>` landing a moment later, or a Back to the
   * library, does not leave the wrong name up.
   */
  async setTabTitle(tabId: string, title: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) throw new Error(`no tab ${tabId}`);
    const page = shellPageOf(tab.url);
    if (page === null) throw new Error("only a shell page may name its own tab");
    const wanted = (typeof title === "string" ? title : "").replace(/\s+/gu, " ").trim().slice(0, MAX_NOTE_TITLE);
    const named = wanted === "" ? SHELL_PAGE_TITLES[page] : wanted;
    tab.shellTitle = { url: tab.url, title: named };
    if (tab.title === named) return;
    tab.title = named;
    this.publish();
  }

  /** Wipe this Space's site data: cookies through the context, storage per origin. */
  async clearBrowsingData(): Promise<void> {
    const context = this.#context();
    if (context === null) return;
    await context.clearCookies().catch(() => undefined);
    await context.clearPermissions().catch(() => undefined);
    for (const tab of this.#tabs.values()) {
      const page = tab.backendTabId === null ? null : this.#pageFor(tab.id);
      if (page === null) continue;
      await page.evaluate(CLEAR_STORAGE_SCRIPT).catch(() => undefined);
    }
    this.#publishControls();
  }

  /* -------------------------- personal records ----------------------------- */

  async getMemory(): Promise<MemorySnapshot> {
    return this.#person().memory();
  }

  async addMemory(input: MemoryAddInput): Promise<MemoryEntry> {
    return this.#person().addMemory(input);
  }

  async updateMemory(id: string, patch: MemoryUpdateInput): Promise<MemoryEntry> {
    return this.#person().updateMemory(id, patch);
  }

  async forgetMemory(id: string, reason: string): Promise<MemoryEntry> {
    return this.#person().forgetMemory(id, reason);
  }

  async restoreMemory(id: string): Promise<MemoryEntry> {
    return this.#person().restoreMemory(id);
  }

  async reviewMemory(id: string, decision: Exclude<MemoryReview, "pending">): Promise<MemoryEntry> {
    return this.#person().reviewMemory(id, decision);
  }

  async forgetAllMemory(): Promise<number> {
    return this.#person().forgetAllMemory();
  }

  onMemory(listener: (snapshot: MemorySnapshot) => void): () => void {
    return this.#onRecords(() => listener(this.#person().memory()));
  }

  async getReminders(): Promise<ReminderSnapshot> {
    return this.#person().reminders();
  }

  onReminders(listener: (snapshot: ReminderSnapshot) => void): () => void {
    return this.#onRecords(() => listener(this.#person().reminders()));
  }

  async addReminder(input: ReminderInput): Promise<Reminder> {
    return this.#person().addReminder(input);
  }

  async updateReminder(id: string, patch: ReminderPatch): Promise<Reminder> {
    return this.#person().updateReminder(id, patch);
  }

  async cancelReminder(id: string): Promise<Reminder> {
    return this.#person().cancelReminder(id);
  }

  async deleteReminder(id: string): Promise<void> {
    this.#person().deleteReminder(id);
  }

  async runReminderNow(id: string): Promise<void> {
    this.#person().runReminderNow(id);
  }

  async acknowledgeReminders(): Promise<never> {
    return unsupported("acknowledgeReminders");
  }

  async snoozeReminder(): Promise<never> {
    return unsupported("snoozeReminder");
  }

  async getBookmarks(): Promise<BookmarkSnapshot> {
    return this.#person().bookmarks();
  }

  onBookmarks(listener: (snapshot: BookmarkSnapshot) => void): () => void {
    return this.#onRecords(() => listener(this.#person().bookmarks()));
  }

  /** Save a tab's page as the person, the way the double tap of shift does. */
  async bookmarkTab(tabId?: string): Promise<Bookmark> {
    const target = tabId ?? this.#activeTabId;
    const tab = target === null ? undefined : this.#tabs.get(target);
    if (tab === undefined) throw new Error("there is no page to save");
    return this.#person().addBookmark({
      url: tab.url,
      title: tab.title,
      ...(tab.faviconUrl === null ? {} : { faviconUrl: tab.faviconUrl }),
    });
  }

  async addBookmark(input: BookmarkInput): Promise<Bookmark> {
    return this.#person().addBookmark(input);
  }

  async updateBookmark(id: string, patch: BookmarkPatch): Promise<Bookmark> {
    return this.#person().updateBookmark(id, patch);
  }

  async deleteBookmark(id: string): Promise<void> {
    this.#person().deleteBookmark(id);
  }

  async refreshBookmark(id: string): Promise<Bookmark> {
    return this.#person().refreshBookmark(id);
  }

  /**
   * No card is up. The desktop's toast is a native view floating over the
   * page; this shell has no such view, so the honest answer is "nothing is
   * showing" rather than a refusal the settings page would have to explain.
   */
  async getBookmarkToast(): Promise<null> {
    return null;
  }

  onBookmarkToast(): () => void {
    return () => undefined;
  }

  openBookmarksPage(): void {
    unsupported("openBookmarksPage");
  }

  /* -------------------------------- onboarding ----------------------------- */

  async transcribeSpeech(): Promise<never> {
    return unsupported("transcribeSpeech");
  }

  async extractOnboardingIntake(): Promise<never> {
    return unsupported("extractOnboardingIntake");
  }

  /**
   * Apply everything the walkthrough gathered — all four of the desktop's
   * effects (§14). The introduction becomes the same keyed memories, the
   * first Space is renamed through its own synced record, the chosen sites go
   * onto the shelf, the flag is written, and the welcome tabs open as
   * host-rendered documents. The one part that is about a Mac stays a Mac's:
   * importing from installed browsers is W12, and the web's import step says
   * so rather than calling anything here.
   */
  async completeOnboarding(input: OnboardingCompletion): Promise<void> {
    const completion = sanitizeOnboardingCompletion(input);
    if (completion === null) throw new Error("nothing to finish");
    const person = this.#person();
    const remember = (content: string, key: string | null, bucket: MemoryBucket, kind: MemoryKind, label: string | null): void => {
      if (content.trim() === "") return;
      try {
        person.addMemory({
          content,
          bucket,
          kind,
          ...(key === null ? {} : { key }),
          ...(label === null ? {} : { label }),
        });
      } catch {
        // A fact the store refuses (a secret, a duplicate) is not a reason
        // to lose the rest of the walkthrough.
      }
    };
    remember(completion.name, PROFILE_KEY.name, "profile", "static", "Name");
    remember(completion.about, PROFILE_KEY.about, "profile", "static", "About");
    for (const fact of completion.facts) {
      remember(fact.content, null, fact.bucket, fact.kind, fact.label);
    }
    // Catalog apps and typed-in sites, in the one order they were picked.
    for (const pick of completion.favorites) {
      if (pick.kind === "site") {
        await this.sidebarCommand({ type: "addFavorite", source: { url: pick.url, title: pick.title } });
        continue;
      }
      const app = favoriteApp(pick.id);
      if (app === null) continue;
      await this.sidebarCommand({ type: "addFavorite", source: { url: app.url, title: app.name } });
    }
    if (completion.spaceName !== null) this.#renameSpace(completion.spaceName);
    await this.updateSettings({ onboarding: { completed: true, completedAt: new Date(this.#now()).toISOString() } });
    if (completion.openWelcomeTabs) await this.#openWelcomeTabs(completion.name);
  }

  /**
   * Name this Space after its person, the way the desktop's `SpaceStore`
   * does: by publishing the Space's own sealed `space:<id>` record, which is
   * account-global and therefore what every device's Space menu reads (§14).
   *
   * Control's row is the web app's to correct — its `completeOnboarding`
   * wrapper calls `PUT /v1/spaces/:id` — but the snapshot must show the new
   * name the moment the walkthrough closes, so the host holds the local name
   * too for the case where no Space record has synced yet.
   */
  #renameSpace(name: string): void {
    const workspace = this.#space.workspace;
    if (workspace !== null) {
      const current = workspace.spaces().find((space) => space.id === this.spaceId) ?? null;
      try {
        workspace.putSpace({
          kind: "space",
          id: this.spaceId,
          name,
          color: current?.color ?? "#4b7f52",
          parentSpaceId: current?.parentSpaceId ?? null,
          purpose: current?.purpose ?? "",
          createdAt: current?.createdAt ?? this.#now(),
          carriedOrigins: current === null ? [] : [...current.carriedOrigins],
          egressPolicy: current?.egressPolicy ?? "direct",
          cloudEnabled: current?.cloudEnabled ?? true,
        });
      } catch (error) {
        this.#log.warn("the Space's new name could not be published", { error: errorMessage(error) });
      }
    }
    this.setSpaceName(name);
  }

  /* --------------------------------- threads ------------------------------- */

  /**
   * Forget a conversation. Control hides the run from the session's list
   * (§8.1's open question, answered in S6 by
   * `DELETE /v1/internal/browser-sessions/:id/runs/:runId`); the console
   * clears if it was the one open.
   */
  async deleteThread(runId: string): Promise<void> {
    const gateway = this.#runs;
    if (gateway?.remove === undefined) throw new Error("this session has no control client");
    await gateway.remove(runId);
    if (this.#run?.runId === runId) {
      this.#run = null;
      this.#evidence = [];
    }
    this.#threads = this.#threads.filter((thread) => thread.runId !== runId);
    this.publishRun();
    void this.refreshThreads();
  }

  /* ---------------------------------- spaces ------------------------------- */

  /**
   * Hand a tab to another Space (§6.3). One `BrowserSession` drives one
   * Space's context, so the tab cannot simply be re-parented: it is written
   * into the destination Space's sealed session record, which is what that
   * Space's session restores from when a viewer next attaches, and closed
   * here. The page's live state does not travel — W9 says as much — but the
   * tab, its address and its place do.
   */
  async moveTabToSpace(tabId: string, spaceId: string): Promise<void> {
    const workspace = this.#space.workspace;
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) return;
    if (spaceId === this.spaceId) return;
    if (workspace === null) throw new Error("this Space has no synced workspace to hand the tab to");
    const known =
      workspace.spaces().some((space) => space.id === spaceId) || workspace.browserSession(spaceId) !== null;
    if (!known) throw new Error("that Space is not one of this account's");
    const current = workspace.browserSession(spaceId);
    const record = current ?? {
      version: BROWSER_SESSION_VERSION,
      spaceId,
      tabs: [],
      activeTabId: null,
      splitGroups: [],
      shelf: DEFAULT_SIDEBAR_STATE,
      zoom: {},
      permissions: {},
      updatedAt: this.#now(),
    };
    const moved = {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      favicon: tab.faviconUrl,
      kind: "human" as const,
      lastActiveAt: this.#now(),
    };
    workspace.putBrowserSession({
      ...record,
      tabs: [...record.tabs.filter((entry) => entry.id !== tab.id), moved],
      activeTabId: tab.id,
      updatedAt: this.#now(),
    });
    await this.closeTab(tabId);
  }

  async forkSpace(): Promise<never> {
    return unsupported("forkSpace");
  }

  /* ------------------------------ unsupported ------------------------------ */

  async getAiStatus(): Promise<never> {
    return unsupported("getAiStatus");
  }
  async getAiUsage(): Promise<never> {
    return unsupported("getAiUsage");
  }
  /**
   * A browser tab is already running the newest build the moment it reloads,
   * so there is nothing to check for and nothing to install (W12). This is
   * reported rather than refused: `UpdateState` has a status for exactly
   * this, and the settings section renders the reason.
   */
  async getUpdateState(): Promise<UpdateState> {
    return { status: "unsupported", reason: UPDATE_REASON };
  }
  async checkForUpdates(): Promise<UpdateState> {
    return { status: "unsupported", reason: UPDATE_REASON };
  }
  async downloadUpdate(): Promise<UpdateState> {
    return { status: "unsupported", reason: UPDATE_REASON };
  }
  async getAccount(): Promise<never> {
    return unsupported("getAccount");
  }
  onAccount(): () => void {
    return () => undefined;
  }
  async signUp(): Promise<never> {
    return unsupported("signUp");
  }
  async signIn(): Promise<never> {
    return unsupported("signIn");
  }
  async enroll(): Promise<never> {
    return unsupported("enroll");
  }
  async signOut(): Promise<never> {
    return unsupported("signOut");
  }
  async changePassword(): Promise<never> {
    return unsupported("changePassword");
  }
  async recoveryCode(): Promise<never> {
    return unsupported("recoveryCode");
  }
  async listDevices(): Promise<never> {
    return unsupported("listDevices");
  }
  onDevices(): () => void {
    return () => undefined;
  }
  async renameDevice(): Promise<never> {
    return unsupported("renameDevice");
  }
  async revokeDevice(): Promise<never> {
    return unsupported("revokeDevice");
  }
  async confirmCloudDevice(): Promise<never> {
    return unsupported("confirmCloudDevice");
  }
  async getSyncStatus(): Promise<never> {
    return unsupported("getSyncStatus");
  }
  onSyncStatus(): () => void {
    return () => undefined;
  }
  async getSyncOriginInfo(): Promise<never> {
    return unsupported("getSyncOriginInfo");
  }
  async setSyncOriginOverride(): Promise<never> {
    return unsupported("setSyncOriginOverride");
  }
  async rollbackSyncOrigin(): Promise<never> {
    return unsupported("rollbackSyncOrigin");
  }
  async retrySync(): Promise<never> {
    return unsupported("retrySync");
  }
  async getWorkspaceSync(): Promise<never> {
    return unsupported("getWorkspaceSync");
  }
  onWorkspaceSync(): () => void {
    return () => undefined;
  }
  async runWorkspaceSync(): Promise<never> {
    return unsupported("runWorkspaceSync");
  }
  async getEgressStatus(): Promise<never> {
    return unsupported("getEgressStatus");
  }
  onEgressStatus(): () => void {
    return () => undefined;
  }
  async setSpaceEgressPolicy(): Promise<never> {
    return unsupported("setSpaceEgressPolicy");
  }
  async browseDirectForNow(): Promise<never> {
    return unsupported("browseDirectForNow");
  }
  async getCloudStatus(): Promise<never> {
    return unsupported("getCloudStatus");
  }
  onCloudStatus(): () => void {
    return () => undefined;
  }
  async enableCloud(): Promise<never> {
    return unsupported("enableCloud");
  }
  async disableCloud(): Promise<never> {
    return unsupported("disableCloud");
  }
  onCloudFrame(): () => void {
    return () => undefined;
  }
  async listChannels(): Promise<never> {
    return unsupported("listChannels");
  }
  async createChannel(): Promise<never> {
    return unsupported("createChannel");
  }
  async deleteChannel(): Promise<never> {
    return unsupported("deleteChannel");
  }
  async getIMessageLink(): Promise<never> {
    return unsupported("getIMessageLink");
  }
  async startIMessageLink(): Promise<never> {
    return unsupported("startIMessageLink");
  }
  async verifyIMessageLink(): Promise<never> {
    return unsupported("verifyIMessageLink");
  }
  async unlinkIMessage(): Promise<never> {
    return unsupported("unlinkIMessage");
  }
  async vaultList(): Promise<never> {
    return unsupported("vaultList");
  }
  async vaultReveal(): Promise<never> {
    return unsupported("vaultReveal");
  }
  async vaultSave(): Promise<never> {
    return unsupported("vaultSave");
  }
  async vaultDelete(): Promise<never> {
    return unsupported("vaultDelete");
  }
  async integrationProviders(): Promise<never> {
    return unsupported("integrationProviders");
  }
  async integrationList(): Promise<never> {
    return unsupported("integrationList");
  }
  async integrationConnect(): Promise<never> {
    return unsupported("integrationConnect");
  }
  async integrationSetAccess(): Promise<never> {
    return unsupported("integrationSetAccess");
  }
  async integrationDisconnect(): Promise<never> {
    return unsupported("integrationDisconnect");
  }
  async integrationCalendarEvents(): Promise<never> {
    return unsupported("integrationCalendarEvents");
  }

  /* ------------------------- capability internals -------------------------- */

  /** The Playwright page behind a host tab id, when the tab is awake. */
  #pageFor(tabId: string): Page | null {
    const backendTabId = this.#tabs.get(tabId)?.backendTabId ?? null;
    return backendTabId === null ? null : (this.#backend.pageFor?.(backendTabId) ?? null);
  }

  /**
   * This Space's `BrowserContext`, reached through any page it owns. The
   * context is what carries permissions, geolocation and cookies, and it is
   * the same object the run executor drives — one Space, one context (W11).
   */
  #context(): BrowserContext | null {
    for (const tab of this.#tabs.values()) {
      const page = tab.backendTabId === null ? null : this.#pageFor(tab.id);
      if (page !== null) return page.context();
    }
    return null;
  }

  /** The person's own half of the workspace store; throws when the Space has none. */
  #person(): WorkspacePersonHost {
    const workspace = this.#space.workspace;
    if (workspace === null) {
      throw new Error("this Space has no synced workspace yet; enable the cloud for it and try again");
    }
    return workspace.person({ enrich: (input) => this.#readPage(input.url) });
  }

  /** Subscribe to any register change, with the first snapshot left to the caller. */
  #onRecords(emit: () => void): () => void {
    const workspace = this.#space.workspace;
    if (workspace === null) return () => undefined;
    return workspace.onRecordsChanged(() => this.#safely(emit));
  }

  /**
   * Read a page for a bookmark, THROUGH this Space's context — so the fetch
   * carries the Space's cookies and the person's egress identity, as every
   * other request from these tabs does. A page already open is read in place.
   */
  async #readPage(url: string): Promise<Partial<Bookmark>> {
    const open = [...this.#tabs.values()].find((tab) => tab.url === url && tab.backendTabId !== null);
    if (open !== undefined) {
      const page = this.#pageFor(open.id);
      const html = page === null ? null : await page.content().catch(() => null);
      if (html !== null) return draftFromPage(pageSnapshotFromHtml(html, url));
    }
    const context = this.#context();
    if (context === null) return {};
    const response = await context.request.get(url, { timeout: 10_000 }).catch(() => null);
    if (response === null || !response.ok()) return {};
    const html = await response.text().catch(() => "");
    return html === "" ? {} : draftFromPage(pageSnapshotFromHtml(html, url));
  }

  /* --------------------------- the stream surface -------------------------- */

  #streamOn(channel: string, listener: (payload: unknown) => void): () => void {
    // The viewer is captured at SUBSCRIBE time: the socket subscribes each
    // viewer's channels inside that viewer's context, so a targeted event can
    // find the one listener that belongs to it.
    const entry = { listener, viewerId: currentViewer()?.id ?? null };
    const set = this.#streamListeners.get(channel) ?? new Set<StreamListener>();
    set.add(entry);
    this.#streamListeners.set(channel, set);
    return () => set.delete(entry);
  }

  /**
   * Publish on a `StreamShellApi` channel. `viewerId` addresses ONE viewer:
   * a file picker belongs to the person who is about to pick a file, not to
   * every browser tab attached to the session.
   */
  #emitStream(channel: string, payload: unknown, viewerId?: string | null): void {
    const set = this.#streamListeners.get(channel);
    if (set === undefined) return;
    for (const entry of [...set]) {
      if (viewerId != null && entry.viewerId !== null && entry.viewerId !== viewerId) continue;
      this.#safely(() => entry.listener(payload));
    }
  }

  /* ------------------------------- internals ------------------------------- */

  get #backend(): CloudBrowser {
    return this.#space.browser.backend;
  }

  #sidebarTabHost(): SidebarTabHost {
    return {
      // Replaced by the controller with what the constructor was given (§10).
      anchorLeavesOnSplit: () => false,
      activeSpaceId: () => this.spaceId,
      tabs: () => this.#tabInfos(),
      tab: (tabId) => this.#tabInfos().find((tab) => tab.id === tabId) ?? null,
      tabForAnchor: (anchorId) => {
        const tab = [...this.#tabs.values()].find((candidate) => candidate.anchorId === anchorId);
        return tab === undefined ? null : this.#info(tab);
      },
      setAnchor: (tabId, anchorId) => {
        const tab = this.#tabs.get(tabId);
        if (tab === undefined) return;
        tab.anchorId = anchorId;
        this.publish();
      },
      reorderTab: (tabId, index) => {
        this.#place(tabId, index);
        this.publish();
      },
      selectTab: (tabId) => this.selectTab(tabId),
      createTab: (url, options) =>
        this.#createTab(url, { anchorId: options?.anchorId ?? null, activate: options?.activate }),
      navigate: (tabId, url) => this.navigate(tabId, url),
    };
  }

  #snapshot(): ShellSnapshot {
    const visible = this.#visibleTabIds();
    const activeTabId = this.#activeTabId;
    const group = activeTabId === null ? undefined : this.#groupFor(activeTabId);
    // Every Space this account has, from the same sealed `space:` registers
    // the desktop's Space menu reads. A single fabricated entry made the
    // switcher's "others" list permanently empty, so the properly implemented
    // `switchSpace` was unreachable from the UI.
    const known = this.#space.workspace?.spaces() ?? [];
    const spaces: SpaceInfo[] = known.map((doc) => ({
      id: doc.id,
      name: doc.name,
      color: doc.color,
      parentSpaceId: doc.parentSpaceId,
      purpose: doc.purpose,
      createdAt: doc.createdAt,
      carriedOrigins: [...doc.carriedOrigins],
      egressPolicy: doc.egressPolicy,
      cloudEnabled: doc.cloudEnabled,
    }));
    if (!spaces.some((space) => space.id === this.spaceId)) {
      spaces.unshift({
        id: this.spaceId,
        name: this.#spaceName,
        color: "#4b7f52",
        parentSpaceId: null,
        purpose: "",
        createdAt: 0,
        carriedOrigins: [],
        egressPolicy: "direct",
        cloudEnabled: true,
      });
    }
    return {
      spaces,
      activeSpaceId: this.spaceId,
      tabs: this.#tabInfos(),
      activeTabId,
      visibleTabIds: visible,
      wakingTabIds: [...this.#waking],
      secondaryTabId: visible.find((id) => id !== activeTabId) ?? null,
      splitMode: group?.mode ?? "single",
      splitGroups: [...this.#splitGroups.values()],
      tabGroups: [],
      run: this.#run,
      threads: this.#threads,
      sidebar: this.#shelf,
    };
  }

  /** A Space's Space record, when the sync engine has one, refines the name. */
  setSpaceName(name: string): void {
    if (name === this.#spaceName || name === "") return;
    this.#spaceName = name;
    this.publish();
  }

  #tabInfos(): BrowserTabInfo[] {
    return this.#orderedTabs().map((tab) => this.#info(tab));
  }

  #info(tab: HostTab): BrowserTabInfo {
    const backend = tab.backendTabId === null ? undefined : this.#backendTab(tab.backendTabId);
    // A welcome tab shows the address it IS, not the `data:` document it was
    // rendered into (§14) — the same reason the desktop's welcome tabs read
    // `pistachio://welcome/` in the address bar.
    const shellPage = tab.readerFor === null ? shellPageOf(tab.url) : null;
    if (shellPage !== null) {
      return {
        id: tab.id,
        spaceId: tab.spaceId,
        title: this.#shellPageTitle(tab, tab.url),
        url: tab.url,
        faviconUrl: SHELL_PAGE_FAVICONS[shellPage],
        loading: false,
        canGoBack: backend?.canGoBack ?? false,
        canGoForward: backend?.canGoForward ?? false,
        kind: tab.kind,
        runId: tab.runId,
        lifecycle: tab.backendTabId === null ? "suspended" : "live",
        lastActiveAt: tab.lastActiveAt,
        unlisted: tab.unlisted,
        anchorId: tab.anchorId,
      };
    }
    const welcome = this.#welcomeOf(tab);
    if (welcome !== null) {
      return {
        id: tab.id,
        spaceId: tab.spaceId,
        title: tab.title,
        url: this.#welcomeAddress(welcome),
        faviconUrl: tab.faviconUrl,
        loading: backend?.loading ?? false,
        canGoBack: backend?.canGoBack ?? false,
        canGoForward: backend?.canGoForward ?? false,
        kind: tab.kind,
        runId: tab.runId,
        lifecycle: tab.backendTabId === null ? "suspended" : "live",
        lastActiveAt: tab.lastActiveAt,
        unlisted: tab.unlisted,
        anchorId: tab.anchorId,
      };
    }
    return {
      id: tab.id,
      spaceId: tab.spaceId,
      title: backend?.title !== undefined && backend.title !== "" ? backend.title : tab.title,
      url: backend?.url ?? tab.url,
      faviconUrl: tab.faviconUrl,
      loading: backend?.loading ?? false,
      canGoBack: backend?.canGoBack ?? false,
      canGoForward: backend?.canGoForward ?? false,
      kind: tab.kind,
      runId: tab.runId,
      lifecycle: tab.backendTabId === null ? "suspended" : "live",
      lastActiveAt: tab.lastActiveAt,
      unlisted: tab.unlisted,
      anchorId: tab.anchorId,
    };
  }

  /**
   * What the strip reads over a shell-drawn page: the name the page gave
   * itself through `setTabTitle` while it is still at that address, else the
   * page's own constant. Any other address keeps whatever the page said.
   */
  #shellPageTitle(tab: HostTab, address: string): string {
    const page = shellPageOf(address);
    if (page === null) return tab.title;
    const named = tab.shellTitle;
    return named !== null && named.url === address ? named.title : SHELL_PAGE_TITLES[page];
  }

  /**
   * Take what the backend says a tab's page is and record it: a shell page's
   * own `pistachio://` address rather than the placeholder it was drawn
   * from, and the address left alone while a shell-page tab is still on the
   * blank page it opens with (its placeholder is navigated to a beat later).
   * Answers whether the address changed.
   */
  #adoptAddress(tab: HostTab, backendUrl: string, backendTitle: string): boolean {
    const seen = shellDocumentAddress(backendUrl) ?? backendUrl;
    const blank = seen === "" || seen === "about:blank";
    const address = tab.shellPage !== null && blank ? tab.url : seen;
    tab.shellPage = shellPageOf(address);
    const navigated = address !== tab.url;
    tab.url = address;
    tab.title = tab.shellPage === null ? backendTitle : this.#shellPageTitle(tab, address);
    return navigated;
  }

  /** Put a tab on a shell-drawn page's placeholder (see `HostTab.shellPage`). */
  async #showShellPage(tabId: string, url: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    const page = this.#pageFor(tabId);
    const address = shellPageAddress(url);
    const document = address === null ? null : shellDocumentUrl(address);
    if (tab === undefined || page === null || address === null || document === null) return;
    // Claimed before the navigation: a backend tick arriving mid-flight must
    // see a shell-page tab whose address is already the `pistachio://` one.
    tab.shellPage = shellPageOf(address);
    tab.url = address;
    await page.goto(document, { waitUntil: "domcontentloaded" }).catch((error: unknown) => {
      this.#log.warn("opening a shell page failed", { tabId, url: address, error: errorMessage(error) });
    });
    const current = this.#tabs.get(tabId);
    if (current === undefined) return;
    current.shellPage = shellPageOf(address);
    current.url = address;
    current.title = this.#shellPageTitle(current, address);
    this.publish();
  }

  #backendTab(backendTabId: string): AgentTabInfo | undefined {
    return this.#backend.listTabs().find((tab) => tab.id === backendTabId);
  }

  #orderedTabs(): HostTab[] {
    const seen = new Set<string>();
    const ordered: HostTab[] = [];
    for (const id of this.#order) {
      const tab = this.#tabs.get(id);
      if (tab === undefined || seen.has(id)) continue;
      seen.add(id);
      ordered.push(tab);
    }
    for (const tab of this.#tabs.values()) if (!seen.has(tab.id)) ordered.push(tab);
    return ordered;
  }

  /** Every pane on screen: the active tab's split group, or the active tab alone. */
  #visibleTabIds(): string[] {
    const activeTabId = this.#activeTabId;
    if (activeTabId === null) return [];
    const group = this.#groupFor(activeTabId);
    return group === undefined ? [activeTabId] : [...group.tabIds];
  }

  #groupFor(tabId: string): SplitGroupInfo | undefined {
    for (const group of this.#splitGroups.values()) if (group.tabIds.includes(tabId)) return group;
    return undefined;
  }

  #detachFromGroup(tabId: string): void {
    const group = this.#groupFor(tabId);
    if (group === undefined) return;
    const survivors = group.tabIds.filter((id) => id !== tabId);
    if (survivors.length >= 2) {
      this.#splitGroups.set(group.id, splitGroupInfo(group.id, survivors, group.mode, group.gridLayout));
    } else {
      this.#splitGroups.delete(group.id);
    }
  }

  #place(tabId: string, index: number): void {
    if (!this.#tabs.has(tabId)) return;
    const rest = this.#orderedTabs()
      .map((tab) => tab.id)
      .filter((id) => id !== tabId);
    const at = Math.min(Math.max(Math.trunc(index), 0), rest.length);
    this.#order = [...rest.slice(0, at), tabId, ...rest.slice(at)];
    const tab = this.#tabs.get(tabId);
    if (tab?.backendTabId != null) this.#backend.reorder?.(tab.backendTabId, at);
  }

  async #createTab(url: string | undefined, options: { anchorId?: string | null; activate?: boolean }): Promise<string> {
    const target = url === undefined || url.trim() === "" ? undefined : normalizeNavigation(url, this.#settings.search.webProvider);
    // A shell-drawn page opens blank: its address is not one the backend may
    // load, and the placeholder is put in front of it below.
    const shellUrl = target === undefined ? null : shellPageAddress(target);
    this.#opening += 1;
    let backendTabId: string;
    try {
      backendTabId = await this.#backend.openTab(shellUrl === null ? target : undefined, { kind: "human" });
    } finally {
      this.#opening -= 1;
    }
    const id = `web:${randomUUID()}`;
    this.#seenTabIds.add(id);
    const backend = this.#backendTab(backendTabId);
    this.#tabs.set(id, {
      id,
      spaceId: this.spaceId,
      backendTabId,
      title: backend?.title ?? "",
      url: shellUrl ?? (backend?.url ?? target ?? "about:blank"),
      faviconUrl: null,
      kind: "human",
      runId: null,
      anchorId: options.anchorId ?? null,
      lastActiveAt: this.#now(),
      unlisted: false,
      readerFor: null,
      shellPage: shellUrl === null ? null : shellPageOf(shellUrl),
      shellTitle: null,
    });
    this.#order.push(id);
    if (options.activate !== false) this.#activeTabId = id;
    // Anything the backend announced while this open was in flight (a popup,
    // a run's tab) was skipped by the adoption guard; pick it up now.
    const initializing = Promise.resolve().then(async () => {
      this.#syncFromBackend();
      const page = this.#pageFor(id);
      if (page !== null) await this.#instrument(id, page);
      if (shellUrl !== null) await this.#showShellPage(id, shellUrl);
      else void this.#loadFavicon(id);
    });
    this.#wakeRequests.set(id, initializing);
    try { await initializing; } finally { this.#wakeRequests.delete(id); }
    return id;
  }

  /** Reopen a suspended tab's page and put it back where it was. */
  readonly #wakeRequests = new Map<string, Promise<void>>();
  async #wake(tabId: string): Promise<void> {
    const pending = this.#wakeRequests.get(tabId);
    if (pending) return pending;
    const work = this.#wakeOnce(tabId);
    this.#wakeRequests.set(tabId, work);
    try { await work; } finally { this.#wakeRequests.delete(tabId); }
  }

  async #wakeOnce(tabId: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined || tab.backendTabId !== null) return;
    // A restored welcome tab carries a `pistachio://` address no cloud tab
    // can navigate to; it opens blank and is RE-RENDERED (§14).
    const welcome = this.#welcomeOf(tab);
    // So does a shell-drawn page: its page is the placeholder, shown again
    // below, under the very address the record carried.
    const shellUrl = tab.readerFor === null ? shellPageAddress(tab.url) : null;
    // Claimed before the blank page exists, so the backend tick that sees it
    // leaves the `pistachio://` address where it is.
    if (shellUrl !== null) tab.shellPage = shellPageOf(shellUrl);
    const target = welcome !== null || tab.url === "" || shellUrl !== null ? undefined : tab.url;
    this.#opening += 1;
    let backendTabId: string;
    try {
      // Retain the page ID even when its navigation fails (for example HTTP 403).
      backendTabId = await this.#backend.openTab(undefined, { kind: tab.kind });
    } finally {
      this.#opening -= 1;
    }
    if (this.#closed || this.#tabs.get(tabId) !== tab) {
      await this.#backend.closeTab(backendTabId).catch(() => undefined);
      return;
    }
    tab.backendTabId = backendTabId;
    const pane = this.#panes.get(tabId);
    if (pane) await this.#backend.setViewport?.(backendTabId, { width: pane.width, height: pane.height }).catch(() => undefined);
    if (target !== undefined) {
      try { await this.#backend.navigate(backendTabId, target); }
      catch { this.#log.warn("restored page navigation failed", { tabId }); }
    }
    this.#backend.reorder?.(backendTabId, this.#order.indexOf(tabId));
    this.#syncFromBackend();
    const page = this.#pageFor(tabId);
    if (page !== null) await this.#instrument(tabId, page);
    if (welcome !== null) await this.#showWelcome(tabId, welcome, this.#welcomeName());
    if (shellUrl !== null) await this.#showShellPage(tabId, shellUrl);
    await this.#applyZoom(tabId);
    if (page !== null && tab.resume?.url === page.url()) await page.evaluate(restorePageResume, tab.resume).catch(() => undefined);
    void this.#loadFavicon(tabId);
  }

  async #liveBackendId(tabId: string): Promise<string | null> {
    // A visible home/restored tab can accept an address before its initial
    // document is ready. Finish that load before the user navigation starts.
    await this.#wakeRequests.get(tabId);
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) return null;
    if (tab.backendTabId === null) await this.#wake(tabId);
    return this.#tabs.get(tabId)?.backendTabId ?? null;
  }

  async #forget(tab: HostTab): Promise<void> {
    this.#tabs.delete(tab.id);
    this.#order = this.#order.filter((id) => id !== tab.id);
    this.#panes.delete(tab.id);
    this.#detachFromGroup(tab.id);
    if (this.#activeTabId === tab.id) {
      this.#activeTabId = this.#orderedTabs()[0]?.id ?? null;
    }
    if (tab.backendTabId !== null) await this.#backend.closeTab(tab.backendTabId).catch(() => undefined);
  }

  async #refresh(tabId: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined || tab.backendTabId === null) return;
    const backend = this.#backendTab(tab.backendTabId);
    if (backend !== undefined) this.#adoptAddress(tab, backend.url, backend.title);
    this.publish();
    await this.#loadFavicon(tabId);
  }

  async #loadFavicon(tabId: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (tab?.backendTabId == null) return;
    const favicon = await this.#backend.favicon?.(tab.backendTabId).catch(() => null);
    const current = this.#tabs.get(tabId);
    if (current === undefined || favicon == null || current.faviconUrl === favicon) return;
    current.faviconUrl = favicon;
    this.publish();
  }

  /** A page that appeared in this Space's context without the host opening it. */
  #adoptBackendTab(backend: AgentTabInfo): void {
    const id = `web:${randomUUID()}`;
    this.#seenTabIds.add(id);
    this.#tabs.set(id, {
      id,
      spaceId: this.spaceId,
      backendTabId: backend.id,
      title: backend.title,
      url: backend.url,
      faviconUrl: null,
      kind: backend.kind,
      runId: this.#run?.runId ?? null,
      anchorId: null,
      lastActiveAt: this.#now(),
      unlisted: false,
      readerFor: null,
      shellPage: null,
      shellTitle: null,
    });
    this.#order.push(id);
    void this.#loadFavicon(id);
  }

  /** Forget a tab whose page is already gone; nothing to close on the backend. */
  #drop(tab: HostTab): void {
    this.#tabs.delete(tab.id);
    this.#order = this.#order.filter((id) => id !== tab.id);
    this.#panes.delete(tab.id);
    this.#detachFromGroup(tab.id);
    if (this.#activeTabId === tab.id) this.#activeTabId = this.#orderedTabs()[0]?.id ?? null;
  }

  /**
   * The backend's tab list changed — a title tick, a navigation, a page that
   * closed itself. Mirror what the host keeps and publish once.
   */
  #syncFromBackend(): void {
    if (this.#closed) return;
    const live = new Map(this.#backend.listTabs().map((tab) => [tab.id, tab]));
    const mapped = new Set<string>();
    for (const tab of [...this.#tabs.values()]) {
      if (tab.backendTabId === null) continue;
      const backend = live.get(tab.backendTabId);
      if (backend === undefined) {
        // The page went away under us (a script closed the window, a crash,
        // or a run closing the tab it opened). A person's tab keeps its
        // durable identity and goes to sleep; an agent's tab has none to
        // keep, so it leaves the strip with its page.
        if (tab.kind === "agent") this.#drop(tab);
        else tab.backendTabId = null;
        continue;
      }
      mapped.add(backend.id);
      const page = this.#backend.pageFor?.(backend.id) ?? null;
      if (page !== null) void this.#instrument(tab.id, page);
      if (this.#adoptAddress(tab, backend.url, backend.title)) {
        void this.#loadFavicon(tab.id);
        // Zoom is the SITE's, so a new address gets that site's factor
        // (or none) rather than keeping the last page's.
        void this.#applyZoom(tab.id);
        if (tab.id === this.#activeTabId) this.#publishControls();
      }
    }
    // Tabs this host did not open: the ones a run acting in this session
    // opened for itself (§8), and the popups those pages opened, which the
    // backend gives the same kind. They belong in the strip exactly as the
    // desktop's agent tabs do — same context, same cookies, drawn as the
    // agent's. Only `agent` ones: a `human` page the host has no record of is
    // a leftover from a context this session no longer owns, and adopting it
    // would resurrect a tab the person already closed.
    if (this.#opening === 0) {
      for (const backend of live.values()) {
        if (mapped.has(backend.id) || backend.kind !== "agent") continue;
        this.#adoptBackendTab(backend);
      }
    }
    if (this.#controlsListeners.size > 0) this.#publishControls();
    // Always: `loading`, `canGoBack` and `canGoForward` are read straight off
    // the backend, so an edge that changed only one of those is invisible to
    // the comparison above and would otherwise never reach the shell. The
    // flush is coalesced, so a burst of them is still one publish.
    this.publish();
  }
}

/** What the strip reads over a shell-drawn page the page itself has not named. */
const SHELL_PAGE_TITLES: Record<ShellPage, string> = {
  home: HOME_PAGE_TITLE,
  brief: BRIEF_PAGE_TITLE,
  notes: NOTES_PAGE_TITLE,
};

const SHELL_PAGE_FAVICONS: Record<ShellPage, string> = {
  home: HOME_PAGE_FAVICON,
  brief: BRIEF_PAGE_FAVICON,
  notes: NOTES_PAGE_FAVICON,
};

/**
 * One spelling per shell-drawn page, or null when the address is not one.
 *
 * `pistachio://home` and `pistachio://home/` are the same page, and a tab is
 * reported (and stored) under one of them whichever was typed.
 */
function shellPageAddress(url: string): string | null {
  const page = shellPageOf(url);
  if (page === null) return null;
  if (page === "home") return HOME_PAGE_URL;
  if (page === "notes") return noteUrl(notesUrlId(url));
  return briefUrl(briefUrlDate(url.trim()));
}

/**
 * The placeholder a shell-drawn page's tab holds (see `HostTab.shellPage`),
 * with its own address written into it.
 *
 * The address has to be IN the document because the address is the only
 * thing that tells `pistachio://notes/` from `pistachio://notes/<id>`: their
 * placeholders are otherwise identical, and two history entries cannot share
 * one `data:` address — Back from a note would land on the note again.
 */
function shellDocumentUrl(address: string): string | null {
  const html = shellPagePlaceholderHtml(address);
  if (html === null) return null;
  return `data:text/html;charset=utf-8,${encodeURIComponent(`${html}\n<!--${address}-->`)}`;
}

const SHELL_DOCUMENT_MARK = /<!--(pistachio:\/\/[^\s>]*)-->\s*$/u;

/**
 * The shell page a placeholder document stands for, or null for every other
 * address. Read back out of the `data:` URL rather than remembered, so a tab
 * that goes Back to a note opened an hour ago still knows which note it is.
 * No page reaches a top-level `data:` document on its own — Chromium refuses
 * those navigations — so only this host's own placeholders answer.
 */
function shellDocumentAddress(url: string): string | null {
  if (!url.startsWith("data:text/html")) return null;
  const at = url.indexOf(",");
  if (at === -1) return null;
  let document: string;
  try {
    document = decodeURIComponent(url.slice(at + 1));
  } catch {
    return null;
  }
  const marked = SHELL_DOCUMENT_MARK.exec(document)?.[1];
  return marked === undefined ? null : shellPageAddress(marked);
}

/**
 * One `NoteRequest` off the wire, or a thrown error naming what was wrong
 * with it (docs/notes.md §4). The shell is ours, but a socket frame is
 * anybody's: the union is checked here so the store is never called with
 * `undefined`. The FIELDS are the store's own business — `sanitizeNoteInput`
 * and `sanitizeNotePatch` run inside it — exactly as on the desktop, whose
 * `ipcMain` handler this mirrors.
 */
function noteRequest(value: unknown): NoteRequest {
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const type = raw["type"];
  const id = (): string => {
    const candidate = raw["id"];
    if (typeof candidate !== "string" || !isNoteId(candidate)) throw new Error("a note request needs a note id");
    return candidate;
  };
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
      return { type, id: id() };
    case "create":
      return { type: "create", input: typeof raw["input"] === "object" && raw["input"] !== null ? (raw["input"] as NoteInput) : {} };
    case "update":
      return {
        type: "update",
        id: id(),
        patch: typeof raw["patch"] === "object" && raw["patch"] !== null ? (raw["patch"] as NotePatch) : {},
      };
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
    case "shares":
      return { type: "shares", id: id() };
    case "share":
      return { type: "share", id: id(), email: String(raw["email"] ?? ""), role: raw["role"] === "editor" ? "editor" : "viewer" };
    case "unshare":
      return { type: "unshare", id: id(), shareId: String(raw["shareId"] ?? "") };
    default:
      throw new Error(`unknown note request ${String(type)}`);
  }
}

/** How many rendered welcome documents one session keeps addresses for (§14). */
const MAX_WELCOME_DOCUMENTS = 32;

/** Reset a previous search's selection so the next one starts from the top. */
const FIND_CLEAR_SCRIPT = `(() => { window.getSelection()?.removeAllRanges(); return true; })()`;

/**
 * `window.find` steps the selection; the count comes from scanning the text
 * nodes once. Both are approximations of Chromium's own find bar, which the
 * worker has no window to drive, and both are what the shell's `FindState`
 * needs: how many, and which one you are on.
 */
function findScript(query: string, backwards: boolean): string {
  return `(() => {
    const query = ${JSON.stringify(query)};
    const backwards = ${JSON.stringify(backwards)};
    const text = document.body ? document.body.innerText : "";
    const needle = query.toLowerCase();
    let matches = 0;
    if (needle !== "") {
      const hay = text.toLowerCase();
      let at = hay.indexOf(needle);
      while (at !== -1) {
        matches += 1;
        at = hay.indexOf(needle, at + needle.length);
      }
    }
    let activeMatch = 0;
    if (matches > 0 && typeof window.find === "function") {
      const found = window.find(query, false, backwards, true, false, false, false);
      if (found) {
        const state = window.__pistachioFind ?? { query: "", index: 0 };
        if (state.query !== query) { state.query = query; state.index = backwards ? matches : 1; }
        else { state.index = backwards ? (state.index <= 1 ? matches : state.index - 1) : (state.index >= matches ? 1 : state.index + 1); }
        window.__pistachioFind = state;
        activeMatch = state.index;
      }
    }
    return { matches, activeMatch };
  })()`;
}


/**
 * The key a site's permission decisions are stored under: its whole ORIGIN.
 *
 * The host alone was the bug: it made `http://bank.example` and
 * `https://bank.example` one site, so a grant the person gave the secure
 * origin was spent by the plaintext one — which is the one anybody on the
 * path can become. Anything that is not http(s) has no key at all: an opaque
 * origin is nobody the person could be asked about.
 */
function originHost(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : "";
  } catch {
    return "";
  }
}

/** The origin Playwright is given for a grant. */
function originOf(value: string): string {
  return originHost(value);
}

/** The plain host of a page address, for zoom and for display. */
function hostOfUrl(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

/**
 * Zoom in the page rather than in the compositor. `Emulation.setPageScaleFactor`
 * moves the layers under the screencast and the pane's pointer arithmetic
 * stops agreeing with what the person sees; `zoom` on the root element
 * reflows the document, which is what the person meant by "bigger".
 */
function zoomScript(factor: number): string {
  return `(() => {
    const factor = ${JSON.stringify(factor)};
    if (!document.documentElement) return false;
    document.documentElement.style.zoom = factor === 1 ? "" : String(factor);
    return true;
  })()`;
}

const MUTE_SCRIPT = (muted: boolean): string => `(() => {
  const muted = ${JSON.stringify(muted)};
  for (const media of document.querySelectorAll("video,audio")) media.muted = muted;
  return true;
})()`;

/** Drive the page's most interesting player, the way the tab preload does. */
function mediaControlScript(control: MediaControl): string {
  return `(() => {
    const control = ${JSON.stringify(control)};
    const all = [...document.querySelectorAll("video,audio")];
    let media = null;
    for (const candidate of all) {
      if (media === null) { media = candidate; continue; }
      const better = (!candidate.paused && !candidate.ended) && (media.paused || media.ended);
      if (better) media = candidate;
    }
    if (!media) return false;
    switch (control.type) {
      case "playPause":
        if (media.paused) { void media.play()?.catch?.(() => undefined); } else { media.pause(); }
        return true;
      case "pause":
        media.pause();
        return true;
      case "mute":
        media.muted = !media.muted;
        return true;
      case "seek":
        media.currentTime = control.position;
        return true;
      case "setRate":
        media.playbackRate = control.rate;
        return true;
      case "pictureInPicture":
        if (document.pictureInPictureElement === media) return document.exitPictureInPicture();
        if (!(media instanceof HTMLVideoElement) || media.disablePictureInPicture) return false;
        return media.requestPictureInPicture();
      case "previous":
      case "next": {
        const selector = control.type === "previous"
          ? '[aria-label*="previous" i],[title*="previous" i],.ytp-prev-button'
          : '[aria-label*="next" i],[title*="next" i],.ytp-next-button';
        const button = document.querySelector(selector);
        if (button) { button.click(); return true; }
        return false;
      }
      default:
        return false;
    }
  })()`;
}

/** Everything a Space's origins keep in the page, from the pages we can reach. */
const CLEAR_STORAGE_SCRIPT = `(() => {
  try { localStorage.clear(); } catch { /* an opaque origin has none */ }
  try { sessionStorage.clear(); } catch { /* same */ }
  try {
    if (indexedDB.databases) {
      void indexedDB.databases().then((dbs) => {
        for (const db of dbs) { if (db.name) indexedDB.deleteDatabase(db.name); }
      }).catch(() => undefined);
    }
  } catch { /* not available */ }
  try { void caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))).catch(() => undefined); } catch { /* not available */ }
  return true;
})()`;

/**
 * The reader page, as a document the cloud tab can actually navigate to.
 *
 * The desktop serves `pistachio://reader/<id>` from a protocol handler it
 * registered in its own session. A cloud tab has no such protocol and no
 * server of its own to point at, so the article is rendered here and handed
 * over as a `data:` URL — self-contained, no network, and it survives the
 * session record (a restored reader tab is still the article).
 */
export function readerDataUrl(article: ReaderArticle): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(readerHtml(article))}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function readerInline(runs: Parameters<typeof plainInline>[0]): string {
  return runs
    .map((run) => {
      const text = escapeHtml(run.text);
      switch (run.type) {
        case "strong":
          return `<strong>${text}</strong>`;
        case "emphasis":
          return `<em>${text}</em>`;
        case "code":
          return `<code>${text}</code>`;
        case "link":
          return `<a href="${escapeHtml(run.href)}">${text}</a>`;
        default:
          return text;
      }
    })
    .join("");
}

function readerHtml(article: ReaderArticle): string {
  const body = article.blocks
    .map((block) => {
      switch (block.type) {
        case "heading":
          return `<h${String(block.level)} id="${escapeHtml(block.id)}">${readerInline(block.text)}</h${String(block.level)}>`;
        case "paragraph":
          return `<p>${readerInline(block.text)}</p>`;
        case "list": {
          const tag = block.ordered ? "ol" : "ul";
          return `<${tag}>${block.items.map((item) => `<li>${readerInline(item)}</li>`).join("")}</${tag}>`;
        }
        case "quote":
          return `<blockquote>${block.paragraphs.map((item) => `<p>${readerInline(item)}</p>`).join("")}</blockquote>`;
        case "code":
          return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
        case "image":
          return `<figure><img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt)}">${
            block.caption === null ? "" : `<figcaption>${escapeHtml(block.caption)}</figcaption>`
          }</figure>`;
        default:
          return "<hr>";
      }
    })
    .join("\n");
  const byline = [article.byline, article.siteName, article.published].filter((part) => part !== null && part !== "");
  return `<!doctype html><html lang="${escapeHtml(article.lang || "en")}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(article.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0 auto; max-width: 42rem; padding: 3rem 1.5rem 6rem; font: 1.125rem/1.7 ui-serif, Georgia, serif; }
  h1 { font-size: 2rem; line-height: 1.2; }
  h2, h3, h4 { line-height: 1.3; margin-top: 2.5rem; }
  .lede { font: 0.875rem/1.5 ui-sans-serif, system-ui, sans-serif; opacity: 0.7; }
  img { max-width: 100%; height: auto; }
  figure { margin: 2rem 0; }
  figcaption { font: 0.8125rem/1.5 ui-sans-serif, system-ui, sans-serif; opacity: 0.7; }
  pre { overflow-x: auto; padding: 1rem; border-radius: 0.5rem; background: rgba(127,127,127,0.12); font-size: 0.9375rem; }
  blockquote { margin: 1.5rem 0; padding-left: 1rem; border-left: 3px solid currentColor; opacity: 0.85; }
</style></head><body>
<h1>${escapeHtml(article.title)}</h1>
<p class="lede">${escapeHtml(byline.join(" · "))}${byline.length > 0 ? " · " : ""}${String(article.readingMinutes)} min read</p>
${body}
</body></html>`;
}

export { DEFAULT_PANE_HEIGHT, DEFAULT_PANE_WIDTH };
