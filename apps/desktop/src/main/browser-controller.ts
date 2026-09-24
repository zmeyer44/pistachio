import { sanitizePageResume, type PageResumeState } from "@pistachio/shell-contracts/page-resume";
import { randomUUID } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import {
  BrowserWindow,
  Menu,
  WebContentsView,
  app,
  clipboard,
  dialog,
  nativeTheme,
  net,
  session,
  shell,
  webContents as electronWebContents,
  type ContextMenuParams,
  type DownloadItem,
  type BrowserWindowConstructorOptions,
  type Cookie,
  type Event as ElectronEvent,
  type HandlerDetails,
  type NativeImage,
  type Session,
  type WebContents,
  type WebContentsDidStartNavigationEventParams,
} from "electron";
import { PolicyEnforcer, type PolicyDecision } from "@pistachio/policy";
import type { ThreadListItem } from "@pistachio/protocol";
import {
  clickPageScript,
  INSPECT_PAGE_SCRIPT,
  scrollScript,
  typePrepareScript,
  typeReadBackScript,
  type PageInspection,
} from "@pistachio/agent-runtime";
import type {
  BrowserLayout,
  BrowserTabInfo,
  CommandPaletteSnapshot,
  ContentBounds,
  GlanceOpenRequest,
  MediaPreviewPlacement,
  ShellGlanceOpenRequest,
  GlanceState,
  PaneStill,
  ShellSnapshot,
  SplitGridLayout,
  SplitGroupInfo,
  SplitMode,
  SplitOrientation,
  SplitSide,
  TabSwitcherPreview,
  RecentlyClosedTabInfo,
} from "@pistachio/shell-contracts/ipc";
import { IPC } from "@pistachio/shell-contracts/ipc";
import type { ShellCommand } from "@pistachio/shell-contracts/chrome";
import {
  gridLayoutForSide,
  MAX_SPLIT_PANES,
  splitGroupInfo,
} from "@pistachio/shell-contracts/split";
import {
  AGENT_GLOW_SUPPRESS_CSS,
  agentGlowCss,
  agentRingDelayMs,
} from "@pistachio/shell-contracts/agent-glow";
import { writeFile } from "node:fs/promises";
import { READ_ALOUD_MAX_ARTICLE_CHARS, ReadAloudService, type ReadAloudClip } from "./read-aloud";
import type { ReadAloudFollowMessage, ReadAloudFollowSync } from "@pistachio/shell-contracts/read-aloud";
import { extractReaderArticle } from "./reader-extract";
import { SmartFindSession } from "@pistachio/smart-find";
import type { Experimental_EvaluationModel } from "ai";
import { smartFindPageFor } from "./smart-find";
import { focusEmulationAttached, setFocusEmulation } from "./forced-focus";
import { ReaderStore, type ReaderActions } from "./reader-store";
import { readerSpeechText, readerUrl, type ReaderArticle } from "@pistachio/shell-contracts/reader";
import {
  buildPageContextMenu,
  contextMediaScript,
  pageFileName,
  type ContextMediaCommand,
} from "./page-context-menu";
import {
  canvasImageScript,
  imageInsertFromBytes,
  parseDataUrl,
  selectionInsert,
  type ChatInsertResult,
} from "./chat-attach";
import {
  authenticationRefreshPlan,
  cookieDomainMatchesHostname,
  shouldPreserveAuthenticationPopup,
} from "@pistachio/shell-contracts/auth-popup";
import {
  BROWSER_PERMISSIONS,
  GUARDED_BROWSER_ACTIONS,
  browserOrigin,
  isSecureBrowserUrl,
  normalizeTabPasskeySupport,
  type BrowserControlCommand,
  type BrowserControlsSnapshot,
  type BrowserDownload,
  type BrowserPermission,
  type BrowserPolicyEvent,
  type BrowserPolicyVerdict,
  type ActionDecision,
  type ExternalAppTarget,
  CLOSED_FIND,
  IDLE_SMART_FIND,
  type FindCommand,
  type FindMode,
  type FindState,
  type GuardedBrowserAction,
  type PermissionDecision,
  type PasskeyAccountOption,
  type TabPasskeySupport,
} from "@pistachio/shell-contracts/browser-controls";
import {
  normalizeTabMediaReport,
  type BrowserMediaInfo,
  type MediaControl,
  type MediaPresentation,
  type ReadAloudStatus,
  type TabMediaReport,
} from "@pistachio/shell-contracts/media";
import type { SidebarState } from "@pistachio/shell-contracts/sidebar";
import { DEFAULT_SETTINGS, type DesktopSettings } from "@pistachio/shell-contracts/settings";
import {
  shortcutActionForEvent,
  type ShortcutPlatform,
} from "@pistachio/shell-contracts/shortcuts";
import { copyUrlNotice, pageLinkMarkdown } from "@pistachio/shell-contracts/page-link";
import type { NoticeTone } from "@pistachio/shell-contracts/notice";
import { recordTabVisit, TAB_SWITCHER_LIMIT } from "@pistachio/shell-contracts/tab-switcher";
import { pasteAndGoUrl, searchUrl } from "@pistachio/shell-contracts/url";
import { isHomeUrl } from "@pistachio/shell-contracts/home";
import { isShellPageUrl, shellPageOf, shellPagePlaceholderHtml } from "@pistachio/shell-contracts/shell-pages";
import { isPrivateHost } from "@pistachio/shell-contracts/private-network";
import {
  spacePartition,
  type ForkSpaceRequest,
  type ForkSpaceResult,
} from "@pistachio/shell-contracts/spaces";
import {
  MAX_PAGE_IMAGES,
  MAX_PAGE_JSON_LD,
  MAX_PAGE_META,
  MAX_PAGE_TEXT,
  type PageSnapshot,
} from "@pistachio/shell-contracts/bookmarks";
import {
  externalAppScheme,
  isAllowedNavigation,
  normalizeNavigation,
} from "@pistachio/shell-contracts/url";
import { hasFileUpload } from "@pistachio/shell-contracts/request-upload";
import {
  demoAuthRelyingPartyHtml,
  demoOAuthCallbackHtml,
  demoOAuthHtml,
  demoPortalHtml,
  demoToneWav,
  demoVendorHtml,
} from "./demo-page";
import { welcomePageResponse } from "./welcome-pages";
import { navigationErrorScript } from "./navigation-error-page";
import {
  createAuthenticationPopupWindow,
  type AuthenticationPopupWindow,
} from "./auth-popup-window";
import { artifactResponse } from "./artifact-store";
import { BrowserPolicyStore } from "./browser-policy-store";
import { SpaceStore } from "./space-store";
import { TabSessionStore } from "./tab-session-store";
import {
  TAB_SESSION_VERSION,
  sanitizeTabSession,
  trimTabHistory,
  type DurableTabHistory,
  type DurableTabSession,
} from "@pistachio/shell-contracts/tab-session";
import {
  dayRowUnits,
  groupedTabOrder,
  nextTabGroupColor,
  splitMembersOf,
  tabGroupOf,
  tabGroupTitle,
  withoutTabs,
  type TabGroupColor,
  type TabGroupCommand,
  type TabGroupInfo,
} from "@pistachio/shell-contracts/tab-groups";
import type { ArchivedTab } from "@pistachio/shell-contracts/tab-archive";
import type { TidyGroupCandidate, TidyTabCandidate } from "@pistachio/shell-contracts/tidy";
import { SessionGate } from "./session-gate";
import type { ProxyCredential } from "./egress/egress-service";

/** Ignore brief media starts such as notification pings; the card reveal waits them out. */
const MEDIA_REVEAL_DELAY_MS = 900;

/** Grants that make a tab's live stream a call rather than a player. */
const CAPTURE_PERMISSIONS: ReadonlySet<BrowserPermission> = new Set([
  "camera",
  "microphone",
  "display-capture",
]);
/**
 * How long a modifier click on a JS-navigating control speaks for the
 * window.open that follows. Long enough for a handler that fires an async
 * request first; short enough that an unrelated popup rarely inherits it.
 */
const GLANCE_INTENT_TTL_MS = 1_000;
/** How long a released presentation keeps the page's viewport pinned. */
const PRESENTATION_RELEASE_MS = 400;
/** How long a failed "Read aloud" toast stays before clearing itself. */
const READ_ALOUD_FAILURE_LINGER_MS = 6_000;
const TAB_IDLE_SUSPEND_MS = 60 * 60 * 1_000;
const TAB_LIFECYCLE_SWEEP_MS = 60 * 1_000;
const RECENTLY_CLOSED_LIMIT = 25;
/** How long a closing page gets to answer beforeunload before it is closed regardless. */
const UNLOAD_ANSWER_TIMEOUT_MS = 10_000;
/** How long a capture waits on a page to paint a style change before giving up. */
const FRAME_SETTLE_TIMEOUT_MS = 120;

/** What the browser observed of a relying-party page while its popup was open. */
interface AuthenticationOwnerWatch {
  returnedToOwnerOrigin: boolean;
  lastCookieChangeAt: number | null;
  serverCookieChanged: boolean;
  ownerNavigated: boolean;
}
/**
 * How long a woken tab's pane shows the placeholder before the view is
 * revealed regardless. A document that never reaches dom-ready (a stalled
 * server, a download) still has Chromium's own page to show; the placeholder
 * is for the moment before the first paint, not a substitute for the page.
 */
const WAKE_REVEAL_TIMEOUT_MS = 8_000;
/** How long a whole page read may take, redirects included. */
const PAGE_READ_TIMEOUT_MS = 20_000;

/** How many redirects a page read walks before giving up. */
const MAX_PAGE_REDIRECTS = 5;
const PICTURE_IN_PICTURE_SCRIPT = `(() => {
  const current = document.pictureInPictureElement;
  if (current !== null) return document.exitPictureInPicture();
  const videos = [...document.querySelectorAll("video")];
  const video = videos.find((candidate) => !candidate.paused && !candidate.ended) ?? videos[0];
  if (!video || video.disablePictureInPicture) return false;
  return video.requestPictureInPicture();
})()`;

/**
 * One entry of a tab's back/forward stack as Chromium hands it out. The
 * page state (scroll position, form values) only ever travels in memory —
 * a suspended tab wakes with it, a duplicate starts from it — and is
 * stripped before anything reaches disk (DurableTabHistory).
 */
interface TabHistoryEntry {
  url: string;
  title: string;
  pageState?: string;
}

interface TabHistory {
  entries: TabHistoryEntry[];
  index: number;
}

interface ManagedTab {
  info: BrowserTabInfo;
  view: WebContentsView;
  enforcer: PolicyEnforcer | null;
  partition: string;
  /**
   * The back/forward stack as of the last navigation, addresses and titles
   * only, kept so persistSession never has to ask every live page for its
   * whole stack on each tick.
   */
  history: TabHistory | null;
  /**
   * A first load that was held behind the Space's hydration gate, settled
   * once the page has actually been asked for. Anything that reads or drives
   * the page has to await it, or it reads about:blank.
   */
  pendingLoad: Promise<void> | null;
  /**
   * What the shell named this tab while it draws the page (a note's own
   * title), bound to the address it was given for. The placeholder document
   * behind a shell page carries a static `<title>` that lands whenever it
   * loads, so without this a name the shell set a moment earlier would be
   * written back over. Any other address forgets it.
   */
  shellTitle: { url: string; title: string } | null;
}

interface DormantTab {
  info: BrowserTabInfo;
  /** What the tab wakes with: its stack, and page state when it slept in this process. */
  history: TabHistory | null;
}

/** What #detachTab took out, for #settleClose to choose a successor with. */
interface DetachedTab {
  closingSpaceId: string;
  closingVisibleGroup: boolean;
  survivingPaneIds: string[];
  closingActiveTab: boolean;
}

interface ManagedGlance {
  tab: ManagedTab;
  ownerTabId: string;
  source: ContentBounds;
  backgroundStills: PaneStill[];
  bounds: ContentBounds | null;
  /** The shell has painted the owner's still, so the live owner can hide. */
  ownerRecessed: boolean;
  /** The shell holds the page's last frame; ignore any further placement. */
  preparedForClose: boolean;
  /** The same live preview is expanding toward its full-tab bounds. */
  promotionStaged: boolean;
}

interface HeldPermission {
  tabId: string;
  permission: BrowserPermission;
  permissions: BrowserPermission[];
  callback(allowed: boolean): void;
  timer: NodeJS.Timeout;
  /**
   * An `external-app` request: the app it would open, and the page that
   * asked — the site an "always allow" is remembered for.
   */
  externalApp?: ExternalAppTarget & { pageUrl: string };
}

interface HeldPasskeyRequest {
  tabId: string;
  origin: string;
  relyingPartyId: string;
  accounts: PasskeyAccountOption[];
  credentialIds: Map<string, string>;
  requestedAt: number;
  callback(credentialId?: string | null): void;
  timer: NodeJS.Timeout;
  popup?: AuthenticationPopupWindow;
  isCurrent(): boolean;
  cleanup(): void;
}

export interface AgentNetworkGuard {
  enforcer: PolicyEnforcer;
  onDecision(decision: PolicyDecision): void;
}

export interface CapturedPageContext {
  selectedText: string;
  formState: Array<{ name: string; type: string; value: string }>;
}

/** The emulation and band one sidebar card asks of the page it shows. */
interface InstalledPresentation {
  tabId: string;
  /** The band's height over the kept viewport's width (see MediaPresentation). */
  aspect: number;
  /** How far down the kept viewport is drawn to fit the card. */
  scale: number;
  /** The viewport held for the page, or null when the card is all it has. */
  viewport: { width: number; height: number } | null;
}

interface CapturedForkContext extends CapturedPageContext {
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

/**
 * What the account, sync, and egress services hang on the controller
 * (docs/cloud-sync-design.md §10.2, §10.3). Every hook is optional: without
 * them the controller behaves exactly as before, which is also the whole of
 * the PISTACHIO_E2E behaviour.
 */
export interface BrowserControllerHooks {
  /**
   * A name for a tab group a person just made without one, from its tabs
   * (docs/tab-tidy.md §3.3). Returns NULL AT ONCE when nobody will be asked —
   * signed out, switched off — so the chrome knows to offer the name field
   * instead of waiting; the promise resolves null when the asking failed.
   */
  nameTabGroup?: (tabs: ReadonlyArray<{ title: string; url: string }>, existingTitles: readonly string[]) => Promise<string | null> | null;
  /**
   * The evaluation model a smart find asks (docs/smart-find.md), or null when
   * nobody can be asked — signed out, the model switched off. Read per search.
   */
  findModel?: () => Experimental_EvaluationModel | null;
  onArchiveTab?: (id: string, contents: WebContents) => void;
  archiveResponse?: (url: URL, spaceId: string) => Promise<Response> | null;
  /**
   * Awaited before the first WebContentsView is created on a session (and
   * before a fork child receives cookies, and before a browser import): the
   * egress service applies the Space's proxy rules here, so no request ever
   * leaves before they are in place.
   */
  prepareSpaceSession?: (
    target: Session,
    spaceId: string,
    kind: BrowserTabInfo["kind"],
    partition: string,
  ) => Promise<void>;
  /** The gateway credential an identity Space's page read presents, or null to read direct. */
  proxyCredentialFor?: (spaceId: string) => ProxyCredential | null;
  /** The gateway refused the credential a page read presented: refresh it. */
  onProxyCredentialRejected?: (spaceId: string) => void;
  /** A session was configured for the first time (cookie capture attaches here). */
  onSessionCreated?: (
    target: Session,
    spaceId: string,
    partition: string,
    kind: BrowserTabInfo["kind"],
  ) => void;
  /**
   * Brackets a bulk cookie write into a Space's jar (a fork's cookie copy):
   * cookie capture pauses between the two so the copy is not republished as
   * mutations (§10.2).
   */
  beginBulkCookieWrite?: (spaceId: string) => void;
  endBulkCookieWrite?: (spaceId: string) => void;
  /**
   * Give the keyboard to the shell's own document: the home page is drawn
   * there (@pistachio/shell-contracts/home), as is every overlay, so while
   * either is up no tab view — least of all a hidden one — may keep the
   * keyboard (#handKeyboardToShell).
   */
  focusShell?: () => void;
}

/** How a remote restore point is applied to a Space (§10.2 Pull/Merge). */
export type DurableSessionApplyMode = "replace" | "merge";

/**
 * loadURL rejects with ERR_ABORTED when the page supersedes the initial
 * navigation (e.g. Google's SERP replaces a stale `sei=` URL); the tab still
 * loads, so that rejection is not a failure.
 */
async function loadTabUrl(contents: WebContents, url: string): Promise<void> {
  try {
    await contents.loadURL(url);
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== "ERR_ABORTED") throw error;
  }
}

/**
 * `webContents.loadURL` rejects a load the network could not complete with
 * Chromium's net error (`errno` -102, `code` "ERR_CONNECTION_REFUSED"…).
 */
export function isLoadFailure(error: unknown): boolean {
  const candidate = error as { errno?: unknown; code?: unknown } | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.errno === "number" &&
    typeof candidate.code === "string" &&
    candidate.code.startsWith("ERR_")
  );
}

/**
 * A page's back/forward stack as Chromium reports it. With `pageState` the
 * entries carry scroll positions and form values too — for a tab that will
 * come back in this process (suspend, duplicate), never for disk.
 */
function captureTabHistory(contents: WebContents, withPageState: boolean): TabHistory | null {
  if (contents.isDestroyed()) return null;
  try {
    // Only the restorable window is kept: a dormant or closed tab must not
    // hold page-state blobs for entries nothing will ever load again.
    return trimTabHistory(
      contents.navigationHistory.getAllEntries().map((entry) => ({
        url: entry.url,
        title: entry.title,
        ...(withPageState && entry.pageState !== undefined ? { pageState: entry.pageState } : {}),
      })),
      contents.navigationHistory.getActiveIndex(),
      (entry) => isAllowedNavigation(entry.url),
    );
  } catch {
    return null;
  }
}

/**
 * The part of a stack a fresh page can be given again: web and app
 * addresses only (a blob: or about: entry cannot be rebuilt), trimmed the
 * way the durable file is (@pistachio/shell-contracts/tab-session trimTabHistory).
 */
function restorableTabHistory(history: TabHistory | null): TabHistory | null {
  return history === null ? null : trimTabHistory(history.entries, history.index, (entry) => isAllowedNavigation(entry.url));
}

/**
 * Whether two addresses are the same place, for "has this favorite wandered":
 * the fragment and a trailing slash are not somewhere else.
 */
function sameAddress(left: string, right: string): boolean {
  const place = (value: string): string => {
    try {
      const url = new URL(value);
      url.hash = "";
      return `${url.origin}${url.pathname.replace(/\/+$/u, "")}${url.search}`;
    } catch {
      return value;
    }
  };
  return place(left) === place(right);
}

/**
 * The durable half of a stack: addresses and titles, never page state.
 * Already trimmed; TabSessionStore.save sanitizes the file as a whole.
 */
function durableTabHistory(history: TabHistory | null): DurableTabHistory | null {
  const restorable = restorableTabHistory(history);
  if (restorable === null) return null;
  return { entries: restorable.entries.map(({ url, title }) => ({ url, title })), index: restorable.index };
}

/**
 * Give a fresh page the stack it is meant to continue, and show the entry
 * that was current. A stack Chromium will not take at all falls back to a
 * plain load of the tab's address, so a restore is never worse than the
 * load it replaces; a page that fails to load fails the way loadURL does.
 */
async function loadTabHistory(contents: WebContents, history: TabHistory | null, url: string): Promise<void> {
  const restorable = restorableTabHistory(history);
  if (restorable !== null) {
    try {
      await contents.navigationHistory.restore({ entries: restorable.entries, index: restorable.index });
      return;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "ERR_ABORTED") return;
      // A load error is the page's, and the stack is already in place.
      if (typeof code === "string" || contents.isDestroyed()) throw error;
    }
  }
  await loadTabUrl(contents, url);
}

/** Sub-pixel geometry, rounded so a redundant re-issue compares equal. */
function rounded(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

/**
 * Place a native view only when its box actually changed. #applyLayout runs
 * on every reported layout and from a dozen state changes besides, most of
 * which move nothing; re-issuing identical geometry to the compositor is at
 * best wasted work and at worst a visible re-composite of a live page.
 */
function settleViewBounds(view: WebContentsView, bounds: ContentBounds): void {
  const current = view.getBounds();
  if (
    current.x === bounds.x &&
    current.y === bounds.y &&
    current.width === bounds.width &&
    current.height === bounds.height
  )
    return;
  view.setBounds(bounds);
}

/** Show or hide a native view only on a real transition, as settleViewBounds. */
function settleViewVisible(view: WebContentsView, visible: boolean): void {
  if (view.getVisible() === visible) return;
  view.setVisible(visible);
}

export class BrowserController {
  readonly #window: BrowserWindow;
  readonly #onChange: () => void;
  /** Called after a tab view is added to the window, so overlays can re-raise. */
  readonly #onViewAdded: () => void;
  readonly #tabPreload: string;
  readonly #onGlanceChange: (glance: GlanceState | null) => void;
  readonly #onMediaChange: (media: BrowserMediaInfo[]) => void;
  readonly #readAloud: ReadAloudService;
  readonly #reader: ReaderStore;
  /** Bookmarking an article by its own address; the host supplies it. */
  readonly #bookmarkArticle: (url: string, title: string) => Promise<void>;
  readonly #onReadAloudChange: (jobs: ReadAloudStatus[]) => void;
  readonly #readAloudJobs = new Map<string, { status: ReadAloudStatus; abort: AbortController | null }>();
  /**
   * The player tabs of clips being read: which clip each plays and the tab
   * its text came from (null once that tab has closed), plus whether that
   * tab is lighting the words as they are spoken.
   */
  readonly #readAloudPlayers = new Map<string, { clipId: string; sourceTabId: string | null; follow: boolean }>();
  readonly #policy: BrowserPolicyStore;
  readonly #onBrowserControlsChange: (
    snapshot: BrowserControlsSnapshot,
  ) => void;
  readonly #onFindChange: (state: FindState) => void;
  readonly #touchIdConfigured: boolean;
  readonly #spaceStore: SpaceStore;
  readonly #tabSessionStore: TabSessionStore;
  readonly #settings: () => DesktopSettings;
  /** Whether an anchor is a favorites-grid entry; those tabs never idle out. */
  readonly #isFavoriteAnchor: (spaceId: string, anchorId: string) => boolean;
  readonly #tabs = new Map<string, ManagedTab>();
  readonly #dormantTabs = new Map<string, DormantTab>();
  /**
   * The agent-control glow (@pistachio/shell-contracts/agent-glow) per lit tab: the token of
   * the document it was requested for, and the key insertCSS handed back once
   * it landed. A navigation drops the entry — the stylesheet went with the
   * old document — and the next dom-ready lights the new one.
   */
  readonly #glow = new Map<string, { token: number; key: string | null }>();
  #glowToken = 0;
  /** The tab the agent is driving, if any: its page takes the light. */
  #agentGlowTabId: string | null = null;
  readonly #tabOrder: string[] = [];
  readonly #splitGroups = new Map<string, SplitGroupInfo>();
  /** Tab groups of every Space, by id (@pistachio/shell-contracts/tab-groups); a group lives where its tabs do. */
  readonly #tabGroups = new Map<string, TabGroupInfo>();
  readonly #configuredSessions = new WeakSet<Session>();
  readonly #hooks: BrowserControllerHooks;
  /** Page loads wait on a Space's cookie hydration here; the window never does. */
  readonly #gate = new SessionGate();
  readonly #lastActiveTabBySpace = new Map<string, string>();
  readonly #recentTabIdsBySpace = new Map<string, string[]>();
  /**
   * Claimed by every selection as it begins and bumped by every activation.
   * A selection that had to wait for a view (waking a sleeping tab) compares
   * its claim after the wait: anything newer — a later click, even one whose
   * own wake finished first, or a new tab — means it was overtaken and must
   * not undo what the person did since.
   */
  #activationSerial = 0;
  /** Sleeping tabs whose view is being created: a second request joins the first instead of making another view. */
  readonly #wakeInFlight = new Map<string, Promise<ManagedTab>>();
  /**
   * Woken tabs whose page has not painted yet, each with the timer that
   * reveals it regardless. #applyLayout keeps these views hidden — the pane
   * shows the tab's mark instead (ShellSnapshot.wakingTabIds) — until the
   * document is ready and has drawn a frame (#revealWoken).
   */
  readonly #waking = new Map<string, NodeJS.Timeout>();
  readonly #recentlyClosedTabs: RecentlyClosedTabInfo[] = [];
  /** What each closed tab comes back with; kept out of the renderer's copy of the list. */
  readonly #closedTabHistory = new WeakMap<RecentlyClosedTabInfo, TabHistory>();
  /** Closes under way, so a second ⌘W joins the first instead of asking the page twice. */
  readonly #closing = new Map<string, Promise<void>>();
  readonly #onTabSwitcherInput: (
    event: Electron.Event,
    input: Electron.Input,
  ) => boolean;
  #lifecycleTimer: NodeJS.Timeout | null = null;
  #activeTabId: string | null = null;
  #secondaryTabId: string | null = null;
  #splitMode: SplitMode = "single";
  #layout: BrowserLayout = { views: [] };
  /** While true the tab views stay hidden so the chrome can paint over them. */
  #overlayActive = false;
  /**
   * Which overlay request is latest, and which prepared capture it may commit.
   * A lower can arrive while a raise is capturing or while its still is being
   * painted; stale commits must never hide the views under nothing.
   */
  #overlayRequest = 0;
  #overlayPreparedRequest: number | null = null;
  /**
   * The tab whose page is in element (HTML) fullscreen. Electron takes the
   * window native-fullscreen for it but leaves a child WebContentsView at its
   * old bounds, so #applyLayout stretches this one view over the whole
   * content box until the page leaves fullscreen.
   */
  #fullscreenTabId: string | null = null;
  /**
   * macOS animates the window into fullscreen, and isFullScreen() is already
   * true while it does. A page that leaves fullscreen before the window's
   * enter-full-screen has fired is stranded — the window comes back but the
   * page still believes it is fullscreen — so exits wait out the transition.
   */
  #windowFullScreenSettled = false;
  #fullscreenExitPending = false;
  /**
   * Whether the fullscreen page took the window into native fullscreen (as
   * opposed to finding it already there). Only then does losing the page —
   * its tab closed, suspended, or moved — give the window back; a page that
   * is gone can no longer leave for itself, and Electron does not do it.
   */
  #fullscreenTookWindow = false;
  #windowReleasePending = false;
  #glance: ManagedGlance | null = null;
  /**
   * The last trusted modifier click that no anchor claimed, held briefly so
   * the window.open it causes Glances instead of spawning a tab.
   */
  #glanceIntent: {
    webContentsId: number;
    source: ContentBounds;
    at: number;
  } | null = null;
  readonly #media = new Map<string, BrowserMediaInfo>();
  /** The one live background video currently composed into the sidebar card. */
  #mediaPreview: MediaPreviewPlacement | null = null;
  /**
   * The last pane a live tab was laid out in. A page composed into the
   * sidebar keeps this viewport (see #syncMediaPresentation), so the card's
   * far narrower box never reaches the document.
   */
  readonly #paneSizes = new Map<string, { width: number; height: number }>();
  /** Emulation overrides waiting for their view's own box to land again. */
  readonly #presentationReleases = new Map<string, NodeJS.Timeout>();
  /** The presentation currently installed on a tab, to avoid re-issuing it. */
  #presentation: InstalledPresentation | null = null;
  readonly #pendingMedia = new Map<
    string,
    { tab: ManagedTab; report: TabMediaReport }
  >();
  readonly #mediaRevealTimers = new Map<string, NodeJS.Timeout>();
  readonly #suppressedMedia = new Set<string>();
  readonly #pendingPermissions = new Map<string, HeldPermission>();
  readonly #pendingPasskeys = new Map<string, HeldPasskeyRequest>();
  readonly #authenticationPopups = new Map<
    number,
    { owner: ManagedTab; popup: AuthenticationPopupWindow }
  >();
  readonly #passkeySupport = new Map<string, TabPasskeySupport>();
  /**
   * Tabs whose current document was granted the camera, microphone, or
   * screen: what tells a call's live audio from a player's (see
   * BrowserMediaInfo.call). Cleared with the document.
   */
  readonly #capturingTabs = new Set<string>();
  readonly #downloads = new Map<string, BrowserDownload>();
  readonly #downloadItems = new Map<string, DownloadItem>();
  readonly #policyEvents: BrowserPolicyEvent[] = [];
  #findState: FindState = CLOSED_FIND;
  #findRequestId = 0;
  /**
   * The smart find under way, if any (docs/smart-find.md): one session per
   * document, so a navigation or another tab starts a new one.
   */
  #smartFind: { tabId: string; session: SmartFindSession } | null = null;
  /**
   * The find session Chromium has open, if any. Electron's `findNext` option
   * is inverted from its name: `true` starts a new session for a query and
   * `false` steps through the session's matches. A request that steps a
   * session that does not exist (a fresh query, another tab, a page that
   * navigated since) is dropped without a `found-in-page` reply.
   */
  #findSession: { tabId: string; query: string } | null = null;

  constructor(
    window: BrowserWindow,
    onChange: () => void,
    onViewAdded: () => void = () => {},
    tabPreload = "",
    onGlanceChange: (glance: GlanceState | null) => void = () => {},
    onMediaChange: (media: BrowserMediaInfo[]) => void = () => {},
    policy = new BrowserPolicyStore("."),
    onBrowserControlsChange: (
      snapshot: BrowserControlsSnapshot,
    ) => void = () => {},
    onFindChange: (state: FindState) => void = () => {},
    touchIdConfigured = false,
    spaceStore = new SpaceStore("."),
    tabSessionStore = new TabSessionStore(
      ".",
      () => new Set(spaceStore.all().map((space) => space.id)),
    ),
    settings: () => DesktopSettings = () => DEFAULT_SETTINGS,
    onTabSwitcherInput: (
      event: Electron.Event,
      input: Electron.Input,
    ) => boolean = () => false,
    readAloud = new ReadAloudService(),
    onReadAloudChange: (jobs: ReadAloudStatus[]) => void = () => {},
    isFavoriteAnchor: (spaceId: string, anchorId: string) => boolean = () =>
      false,
    reader = new ReaderStore(),
    bookmarkArticle: (url: string, title: string) => Promise<void> = () =>
      Promise.reject(new Error("Bookmarks are unavailable.")),
    hooks: BrowserControllerHooks = {},
  ) {
    this.#window = window;
    this.#hooks = hooks;
    // Every publish goes through here, so the tab groups are trued up first
    // (#reconcileTabGroups) whichever of a dozen paths closed or moved a tab.
    this.#onChange = () => {
      this.#reconcileTabGroups();
      onChange();
    };
    // Coming back to the window, macOS hands the keyboard to whichever view
    // last held it — a page hidden under the home page or an overlay
    // included. The hand-off runs once that restoration has settled.
    window.on("focus", () => {
      setImmediate(() => {
        if (!window.isDestroyed()) this.#handKeyboardToShell();
      });
    });
    this.#onViewAdded = onViewAdded;
    this.#tabPreload = tabPreload;
    this.#onGlanceChange = onGlanceChange;
    this.#onMediaChange = onMediaChange;
    this.#policy = policy;
    this.#onBrowserControlsChange = onBrowserControlsChange;
    this.#onFindChange = onFindChange;
    this.#touchIdConfigured = touchIdConfigured;
    this.#spaceStore = spaceStore;
    this.#tabSessionStore = tabSessionStore;
    this.#settings = settings;
    this.#isFavoriteAnchor = isFavoriteAnchor;
    this.#onTabSwitcherInput = onTabSwitcherInput;
    this.#readAloud = readAloud;
    this.#readAloud.onProgress((clip) => this.#readAloudProgress(clip));
    this.#reader = reader;
    this.#bookmarkArticle = bookmarkArticle;
    this.#reader.setActions(this.#readerActions());
    this.#onReadAloudChange = onReadAloudChange;
    // The renderer re-reports its panes after a resize, but a fullscreen
    // page is sized from the window itself, so it must follow every step of
    // the native fullscreen transition rather than the shell's next frame.
    window.on("resize", () => {
      if (this.#fullscreenTabId !== null) this.#applyLayout();
    });
    this.#windowFullScreenSettled = window.isFullScreen();
    window.on("enter-full-screen", () => {
      this.#windowFullScreenSettled = true;
      if (this.#windowReleasePending) {
        this.#windowReleasePending = false;
        window.setFullScreen(false);
        return;
      }
      if (!this.#fullscreenExitPending) return;
      this.#fullscreenExitPending = false;
      this.#exitHtmlFullscreen();
    });
    // Leaving native fullscreen by the traffic light (rather than Escape in
    // the page) leaves the page believing it is still fullscreen: fully exit
    // so it goes back into its pane instead of covering the restored window.
    window.on("leave-full-screen", () => {
      this.#windowFullScreenSettled = false;
      this.#fullscreenExitPending = false;
      this.#windowReleasePending = false;
      this.#exitHtmlFullscreen();
    });
  }

  async initialize(): Promise<void> {
    this.#restoreDurableSession();
    const spaceId = this.activeSpaceId();
    const remembered = this.#lastActiveTabBySpace.get(spaceId);
    const fallback = this.#spaceTabIds(spaceId)[0];
    const preferred =
      remembered !== undefined && this.#tabInfo(remembered)?.spaceId === spaceId
        ? remembered
        : fallback;
    if (preferred === undefined) {
      await this.createTab(this.#homeUrl(), { spaceId });
    } else {
      // The window waits on this before it shows; the restored page's own
      // load must not hold it back. The view exists and is laid out at
      // once, and the page fills in when it arrives.
      await this.#hydrateTabAndGroup(preferred, { awaitLoad: false });
      this.#activateTab(preferred);
      this.#onChange();
    }
    this.#lifecycleTimer = setInterval(
      () => this.#suspendIdleTabs(),
      TAB_LIFECYCLE_SWEEP_MS,
    );
    this.#lifecycleTimer.unref();
  }

  shutdown(): void {
    if (this.#lifecycleTimer !== null) clearInterval(this.#lifecycleTimer);
    this.#lifecycleTimer = null;
    this.#gate.dispose();
    this.persistSession();
    this.#tabSessionStore.flush();
  }

  /** Repaint native view properties that cannot be expressed by renderer CSS. */
  refreshAppearance(): void {
    const appearance = this.#settings().appearance;
    const dark =
      appearance.scheme === "dark" ||
      (appearance.scheme === "system" && nativeTheme.shouldUseDarkColors);
    const background = dark ? "#202225" : "#f8f8f3";
    for (const tab of this.#tabs.values()) {
      // A fullscreen page keeps square corners until it leaves fullscreen.
      if (tab.info.id !== this.#fullscreenTabId)
        tab.view.setBorderRadius(appearance.radius);
      tab.view.setBackgroundColor(background);
    }
    if (this.#glance !== null) {
      this.#glance.tab.view.setBorderRadius(appearance.radius);
      this.#glance.tab.view.setBackgroundColor(background);
    }
    // The glow is painted from the same palette and stops at the same corner
    // radius, so a theme change has to relight rather than wait for the run.
    this.#relightAgentGlow();
  }

  /**
   * The tab the agent is driving (@pistachio/shell-contracts/agent-glow `agentDrivenTabId`),
   * or null when it is not driving one here. While it is, the chrome traces
   * a highlight around that tab's pane (renderer/src/styles.css) and the page
   * inside takes that light on its own edges — the ring cannot reach in,
   * because a tab's WebContentsView covers its pane box exactly and nothing
   * the shell paints appears above a native view, so the spill is a
   * stylesheet injected into the page (@pistachio/shell-contracts/agent-glow).
   *
   * The light goes on the driven tab's page only, and only while that pane
   * is on screen: a person looking at another tab, or at the other pane of a
   * split, sees no light, and the page the agent is working in the
   * background is lit the moment they switch to it.
   *
   * Called on every publish, not just on the change: which pane is lit
   * follows the active tab and the split as they change under a running
   * agent.
   */
  setAgentGlow(tabId: string | null): void {
    this.#agentGlowTabId = tabId;
    this.#syncAgentGlow();
  }

  /** Light the driven tab if it is on screen, and darken everything else. */
  #syncAgentGlow(): void {
    const wanted = this.#agentGlowTabId;
    const visible = wanted !== null && this.#visibleTabIds().includes(wanted);
    for (const tabId of [...this.#glow.keys()])
      if (!visible || tabId !== wanted) this.#clearAgentGlow(tabId);
    if (!visible) return;
    const tab = this.#tabs.get(wanted);
    if (tab !== undefined) this.#applyAgentGlow(tab);
  }

  /** Re-inject the stylesheet wherever it is lit; the palette behind it moved. */
  #relightAgentGlow(): void {
    if (this.#agentGlowTabId === null) return;
    for (const tabId of [...this.#glow.keys()]) this.#clearAgentGlow(tabId);
    this.#syncAgentGlow();
  }

  #applyAgentGlow(tab: ManagedTab): void {
    const id = tab.info.id;
    // Already lit, or lighting: insertCSS is a round trip to the page.
    if (this.#glow.has(id) || tab.view.webContents.isDestroyed()) return;
    const token = ++this.#glowToken;
    const state = { token, key: null as string | null };
    this.#glow.set(id, state);
    const appearance = this.#settings().appearance;
    const css = agentGlowCss({
      colors: appearance.colors,
      radius: appearance.radius,
      delayMs: agentRingDelayMs(Date.now()),
    });
    void tab.view.webContents
      .insertCSS(css)
      .then((key) => {
        if (this.#glow.get(id) === state) {
          state.key = key;
          return;
        }
        // The run ended, or the pane went away, while the page was thinking.
        this.#removeInsertedCss(tab, key);
      })
      .catch(() => {
        // A page that will not take a stylesheet (a PDF, a crashed renderer)
        // simply keeps the ring around it and no light inside.
        if (this.#glow.get(id) === state) this.#glow.delete(id);
      });
  }

  #clearAgentGlow(tabId: string): void {
    const state = this.#glow.get(tabId);
    if (state === undefined) return;
    this.#glow.delete(tabId);
    const tab = this.#tabs.get(tabId);
    if (state.key !== null && tab !== undefined)
      this.#removeInsertedCss(tab, state.key);
  }

  /** The document the key belongs to may already be gone; that is not an error. */
  #removeInsertedCss(tab: ManagedTab, key: string): void {
    if (tab.view.webContents.isDestroyed()) return;
    void tab.view.webContents.removeInsertedCSS(key).catch(() => {});
  }

  /**
   * Run `capture` with the glow off. The agent reads the page through
   * `capturePage`, and a lit band around every edge is the app's own chrome
   * bleeding into what the model takes for the page. Suppressing costs one
   * frame; lifting and re-inserting the whole stylesheet would restart its
   * sweep on every screenshot.
   */
  async #withoutAgentGlow<T>(
    tab: ManagedTab,
    capture: () => Promise<T>,
  ): Promise<T> {
    if (!this.#glow.has(tab.info.id)) return capture();
    let key: string | null = null;
    try {
      key = await tab.view.webContents.insertCSS(AGENT_GLOW_SUPPRESS_CSS);
    } catch {
      // Nothing took; the shot keeps its glow rather than failing.
    }
    try {
      if (key !== null) await this.#settleFrame(tab);
      return await capture();
    } finally {
      if (key !== null) this.#removeInsertedCss(tab, key);
    }
  }

  /**
   * Wait for one painted frame. insertCSS resolves when the stylesheet is in
   * the document, which is a frame or two before the compositor has the
   * picture `capturePage` reads. Bounded, so a page that has stopped painting
   * costs the capture a moment rather than the whole call.
   */
  async #settleFrame(tab: ManagedTab): Promise<void> {
    if (tab.view.webContents.isDestroyed()) return;
    const painted = tab.view.webContents
      .executeJavaScript(
        "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => { resolve(null); })))",
      )
      .catch(() => null);
    await Promise.race([
      painted,
      new Promise((resolve) => setTimeout(resolve, FRAME_SETTLE_TIMEOUT_MS)),
    ]);
  }

  watchtowerSources(): { id: string; spaceId: string; contents: WebContents; visible: boolean; agentDriven: boolean }[] {
    return [...this.#tabs.values()].filter((tab) => tab.info.kind === "human" && !tab.view.webContents.isDestroyed()).map((tab) => ({
      id: tab.info.id, spaceId: tab.info.spaceId, contents: tab.view.webContents,
      // Only the tab the agent is driving is not the person's reading; their
      // own tabs beside it still are.
      agentDriven: tab.info.id === this.#agentGlowTabId,
      visible: tab.info.id !== this.#agentGlowTabId && !this.#window.isDestroyed() && this.#window.isVisible() && this.#window.isFocused() && tab.view.getVisible(),
    }));
  }

  snapshot(run: ShellSnapshot["run"], sidebar: SidebarState, threads: ThreadListItem[] = []): ShellSnapshot {
    // While the agent is driving a tab the run belongs to that tab's space;
    // a thread that is paused, waiting, or finished is a conversation, not a
    // tab, and shows wherever the person is (including after its tab closed).
    const runTab = run === null || run.humanTabId === null ? undefined : this.#tabs.get(run.humanTabId);
    const driving = run !== null && run.control === "agent" && run.status === "running";
    const scopedRun =
      run !== null && (!driving || runTab === undefined || runTab.info.spaceId === this.activeSpaceId())
        ? run
        : null;
    return {
      spaces: this.#spaceStore.all(),
      activeSpaceId: this.activeSpaceId(),
      tabs: this.tabs(),
      activeTabId: this.#activeTabId,
      visibleTabIds: this.#visibleTabIds(),
      wakingTabIds: [...this.#waking.keys()].filter(
        (tabId) => this.#tabInfo(tabId)?.spaceId === this.activeSpaceId(),
      ),
      secondaryTabId: this.#secondaryTabId,
      splitMode: this.#splitMode,
      splitGroups: [...this.#splitGroups.values()]
        .filter(
          (group) =>
            this.#tabInfo(group.tabIds[0] ?? "")?.spaceId ===
            this.activeSpaceId(),
        )
        .map((group) => ({ ...group, tabIds: [...group.tabIds] })),
      tabGroups: this.tabGroups(),
      run: scopedRun,
      threads,
      sidebar,
    };
  }

  /** Every tab, in the order the chrome lists them. */
  tabs(): BrowserTabInfo[] {
    const spaceId = this.activeSpaceId();
    return this.#tabOrder.flatMap((tabId) => {
      const info = this.#tabInfo(tabId);
      return info?.spaceId === spaceId ? [{ ...info, forcedFocus: info.forcedFocus === true }] : [];
    });
  }

  allTabs(): BrowserTabInfo[] {
    return this.#tabOrder.flatMap((tabId) => {
      const info = this.#tabInfo(tabId);
      return info === null ? [] : [{ ...info, forcedFocus: info.forcedFocus === true }];
    });
  }

  commandPaletteSnapshot(): CommandPaletteSnapshot {
    return {
      tabs: this.allTabs(),
      recentlyClosedTabs: this.#recentlyClosedTabs.map((tab) => ({ ...tab })),
      clipboardUrl: pasteAndGoUrl(clipboard.readText()),
    };
  }

  /** Capture the current Space's MRU tabs at preview size, never full-page payload size. */
  async tabSwitcherPreviews(): Promise<TabSwitcherPreview[]> {
    const spaceId = this.activeSpaceId();
    const active = this.#activeTabId;
    const currentHistory = this.#recentTabIdsBySpace.get(spaceId) ?? [];
    const history =
      active === null ? currentHistory : recordTabVisit(currentHistory, active);
    this.#recentTabIdsBySpace.set(spaceId, history);
    const ids = history
      .filter((tabId) => this.#tabInfo(tabId)?.spaceId === spaceId)
      .slice(0, TAB_SWITCHER_LIMIT);
    return Promise.all(
      ids.map(async (tabId) => {
        const live = this.#tabs.get(tabId);
        if (live !== undefined) return this.#captureTabSwitcherPreview(live);
        const info = this.#tabInfo(tabId);
        if (info === null)
          throw new Error("tab disappeared while preparing the switcher");
        return { tab: { ...info }, dataUrl: null };
      }),
    );
  }

  activeSpaceId(): string {
    return this.#spaceStore.activeId();
  }

  /**
   * The Space's persistent session, configured (protocol handler, download
   * and permission hooks) whether or not a tab has opened in it yet. The
   * sync service attaches its cookie capture through `onSessionCreated`,
   * which fires the first time a session is configured.
   */
  sessionFor(spaceId: string): Session {
    const partition = spacePartition(spaceId);
    const target = session.fromPartition(partition);
    this.#configureSession(target, "human", spaceId, partition);
    return target;
  }

  /**
   * The Space's session with its proxy rules applied (`prepareSpaceSession`
   * awaited), for bulk cookie writers that run before any view exists: a
   * browser import, a fork's cookie copy.
   */
  async prepareSpaceSession(spaceId: string): Promise<Session> {
    const target = this.sessionFor(spaceId);
    await this.#hooks.prepareSpaceSession?.(
      target,
      spaceId,
      "human",
      spacePartition(spaceId),
    );
    return target;
  }

  /** Hold page loads in the Space until `markSessionReady` (§10.2 hydration gate). */
  markSessionHydrating(spaceId: string): void {
    this.#gate.markHydrating(spaceId);
  }

  /** The Space's jar is settled: every held load and navigation replays in order. */
  markSessionReady(spaceId: string): void {
    this.#gate.markReady(spaceId);
  }

  isSessionHydrating(spaceId: string): boolean {
    return this.#gate.isHydrating(spaceId);
  }

  /** Spaces whose hydration completed at least once. */
  get sessionReadySpaces(): ReadonlySet<string> {
    return this.#gate.readySpaces;
  }

  /** Reload every live human page in the Space, so it picks up a changed jar. */
  reloadSpace(spaceId: string): void {
    for (const tab of this.#tabs.values()) {
      if (tab.info.spaceId !== spaceId || tab.info.kind !== "human") continue;
      const contents = tab.view.webContents;
      this.#gate.run(spaceId, () => {
        if (!contents.isDestroyed()) contents.reload();
      });
    }
  }

  /**
   * Rebuild one Space's human tabs, order, and split groups from a restore
   * point another device published (§10.2 Pull/Merge). `replace` closes the
   * Space's current listed human tabs first; `merge` keeps them and adds
   * what the restore point has that this Space does not. Agent tabs and
   * unlisted working tabs are never touched. Mirrors what
   * #restoreDurableSession does at startup for the saved file.
   */
  async applyDurableSession(
    durable: DurableTabSession,
    spaceId: string,
    mode: DurableSessionApplyMode = "replace",
  ): Promise<void> {
    if (this.#spaceStore.get(spaceId) === null) throw new Error("unknown Space");
    const saved = sanitizeTabSession(durable, new Set([spaceId])).spaces[spaceId] ?? {
      tabs: [],
      activeTabId: null,
      recentTabIds: [],
      splitGroups: [],
    };
    const activeSpace = this.activeSpaceId() === spaceId;
    if (mode === "replace") {
      if (activeSpace && this.#glance !== null) this.#discardGlance();
      for (const tabId of this.#spaceTabIds(spaceId)) {
        const info = this.#tabInfo(tabId);
        if (info === null || info.kind !== "human" || info.unlisted) continue;
        this.#discardTab(tabId);
      }
    }
    const openUrls = new Set(
      this.#spaceTabIds(spaceId).map((tabId) => this.#tabInfo(tabId)?.url ?? ""),
    );
    const added = new Set<string>();
    for (const tab of saved.tabs) {
      if (this.#tabInfo(tab.id) !== null) continue;
      if (mode === "merge" && openUrls.has(tab.url)) continue;
      added.add(tab.id);
      if (tab.resume) this.#pageResume.set(tab.id, tab.resume);
      this.#dormantTabs.set(tab.id, {
        info: {
          id: tab.id,
          spaceId,
          title: tab.title,
          url: tab.url,
          faviconUrl: tab.faviconUrl,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          kind: "human",
          runId: null,
          anchorId: tab.anchorId,
          lifecycle: "suspended",
          lastActiveAt: tab.lastActiveAt,
          unlisted: false,
        },
        history: tab.history ?? null,
      });
      this.#tabOrder.push(tab.id);
    }
    const validIds = new Set(this.#spaceTabIds(spaceId));
    if (mode === "replace") {
      const recents = saved.recentTabIds.filter((tabId) => validIds.has(tabId));
      this.#recentTabIdsBySpace.set(
        spaceId,
        recents.length > 0
          ? recents
          : [...validIds].sort(
              (left, right) =>
                (this.#tabInfo(right)?.lastActiveAt ?? 0) -
                (this.#tabInfo(left)?.lastActiveAt ?? 0),
            ),
      );
      if (saved.activeTabId !== null && validIds.has(saved.activeTabId))
        this.#lastActiveTabBySpace.set(spaceId, saved.activeTabId);
      else this.#lastActiveTabBySpace.delete(spaceId);
    }
    const claimed = new Set(
      [...this.#splitGroups.values()].flatMap((group) => group.tabIds),
    );
    for (const group of saved.splitGroups) {
      if (
        group.tabIds.every((tabId) => validIds.has(tabId) && !claimed.has(tabId)) &&
        (mode === "replace" || group.tabIds.some((tabId) => added.has(tabId)))
      ) {
        for (const tabId of group.tabIds) claimed.add(tabId);
        this.#splitGroups.set(
          group.id,
          splitGroupInfo(group.id, group.tabIds, group.mode, group.gridLayout),
        );
      }
    }
    for (const group of saved.tabGroups ?? []) {
      const tabIds = group.tabIds.filter((tabId) => validIds.has(tabId) && (mode === "replace" || added.has(tabId)));
      if (tabIds.length > 0 && !this.#tabGroups.has(group.id)) this.#tabGroups.set(group.id, { ...group, tabIds });
    }
    if (activeSpace) {
      const current = this.#activeTabId;
      const currentHolds =
        current !== null && this.#tabInfo(current)?.spaceId === spaceId;
      if (!currentHolds) {
        const remembered = this.#lastActiveTabBySpace.get(spaceId);
        const preferred =
          remembered !== undefined && validIds.has(remembered)
            ? remembered
            : this.#lastVisitedTabId(spaceId);
        if (preferred === undefined) {
          await this.createTab(this.#homeUrl(), { spaceId });
        } else {
          await this.#hydrateTabAndGroup(preferred, { awaitLoad: false });
          this.#activateTab(preferred);
        }
      }
      this.#applyLayout();
      this.#emitBrowserControls();
    }
    this.#onChange();
    this.persistSession();
  }

  /** Drop a tab without remembering it or choosing a successor (applyDurableSession). */
  #discardTab(tabId: string): void {
    this.#pageResume.delete(tabId);
    const tab = this.#tabs.get(tabId);
    const info = tab?.info ?? this.#dormantTabs.get(tabId)?.info;
    if (info === undefined) return;
    if (this.#glance?.ownerTabId === tabId) this.#discardGlance();
    if (tab !== undefined) {
      this.#cancelPermissionsForTab(tabId);
      this.#cancelPasskeysForTab(tabId);
      this.#passkeySupport.delete(tabId);
      this.#capturingTabs.delete(tabId);
      this.#forgetWake(tabId);
      this.#paneSizes.delete(tabId);
      this.#cancelPresentationRelease(tabId);
      this.#removeMedia(tabId);
      this.#readAloudTabGone(tabId, "closed");
      this.#releaseFullscreen(tabId);
      this.#window.contentView.removeChildView(tab.view);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
      this.#tabs.delete(tabId);
    } else {
      this.#dormantTabs.delete(tabId);
    }
    const orderIndex = this.#tabOrder.indexOf(tabId);
    if (orderIndex >= 0) this.#tabOrder.splice(orderIndex, 1);
    this.#recentTabIdsBySpace.set(
      info.spaceId,
      (this.#recentTabIdsBySpace.get(info.spaceId) ?? []).filter(
        (candidate) => candidate !== tabId,
      ),
    );
    if (this.#lastActiveTabBySpace.get(info.spaceId) === tabId)
      this.#lastActiveTabBySpace.delete(info.spaceId);
    const group = this.#splitGroupFor(tabId);
    if (group !== undefined) {
      const survivors = group.tabIds.filter((candidate) => candidate !== tabId);
      if (survivors.length >= 2)
        this.#splitGroups.set(
          group.id,
          splitGroupInfo(group.id, survivors, group.mode, group.gridLayout),
        );
      else this.#splitGroups.delete(group.id);
    }
    if (this.#activeTabId === tabId) this.#activeTabId = null;
    if (this.#secondaryTabId === tabId) this.#secondaryTabId = null;
  }

  readonly #pageResume = new Map<string, PageResumeState>();

  clearPageResume(): void {
    this.#pageResume.clear();
    this.persistSession();
  }

  acceptPageResume(contentsId: number, value: unknown): void {
    const tab = [...this.#tabs.values()].find(candidate => candidate.view.webContents.id === contentsId);
    if (!tab || tab.info.kind !== "human" || tab.info.unlisted) return;
    const state = sanitizePageResume(value, tab.view.webContents.getURL());
    if (!state || JSON.stringify(state) === JSON.stringify(this.#pageResume.get(tab.info.id))) return;
    this.#pageResume.set(tab.info.id, state);
    this.persistSession();
  }

  persistSession(): void {
    for (const id of this.#pageResume.keys()) if (this.#tabInfo(id) === null) this.#pageResume.delete(id);
    const spaces: DurableTabSession["spaces"] = {};
    for (const space of this.#spaceStore.all()) {
      const tabs = this.#spaceTabIds(space.id).flatMap((tabId) => {
        const info = this.#tabInfo(tabId);
        if (info === null || info.kind !== "human" || info.unlisted) return [];
        const history = durableTabHistory(
          this.#tabs.get(tabId)?.history ?? this.#dormantTabs.get(tabId)?.history ?? null,
        );
        return [
          {
            id: info.id,
            spaceId: info.spaceId,
            title: info.title,
            url: info.url,
            faviconUrl: info.faviconUrl,
            anchorId: info.anchorId,
            lastActiveAt: info.lastActiveAt,
            ...(history === null ? {} : { history }),
            ...(this.#pageResume.get(info.id)?.url === info.url ? { resume: this.#pageResume.get(info.id)! } : {}),
          },
        ];
      });
      if (tabs.length === 0) continue;
      const ids = new Set(tabs.map((tab) => tab.id));
      spaces[space.id] = {
        tabs,
        activeTabId: ids.has(this.#lastActiveTabBySpace.get(space.id) ?? "")
          ? (this.#lastActiveTabBySpace.get(space.id) ?? null)
          : (tabs[0]?.id ?? null),
        recentTabIds: (this.#recentTabIdsBySpace.get(space.id) ?? []).filter(
          (tabId) => ids.has(tabId),
        ),
        splitGroups: [...this.#splitGroups.values()]
          .filter((group) => group.tabIds.every((tabId) => ids.has(tabId)))
          .map((group) => ({ ...group, tabIds: [...group.tabIds] })),
        tabGroups: this.tabGroups(space.id),
      };
    }
    this.#tabSessionStore.save({ version: TAB_SESSION_VERSION, spaces });
  }

  #restoreDurableSession(): void {
    const durable = this.#tabSessionStore.get();
    const seen = new Set<string>();
    for (const [spaceId, saved] of Object.entries(durable.spaces)) {
      for (const tab of saved.tabs) {
        if (seen.has(tab.id) || this.#spaceStore.get(spaceId) === null)
          continue;
        seen.add(tab.id);
        if (tab.resume) this.#pageResume.set(tab.id, tab.resume);
        const info: BrowserTabInfo = {
          id: tab.id,
          spaceId,
          title: tab.title,
          url: tab.url,
          faviconUrl: tab.faviconUrl,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          kind: "human",
          runId: null,
          anchorId: tab.anchorId,
          lifecycle: "suspended",
          lastActiveAt: tab.lastActiveAt,
          unlisted: false,
        };
        this.#dormantTabs.set(tab.id, { info, history: tab.history ?? null });
        this.#tabOrder.push(tab.id);
      }
      const validIds = new Set(this.#spaceTabIds(spaceId));
      if (saved.activeTabId !== null && validIds.has(saved.activeTabId)) {
        this.#lastActiveTabBySpace.set(spaceId, saved.activeTabId);
      }
      const recents = saved.recentTabIds.filter((tabId) => validIds.has(tabId));
      this.#recentTabIdsBySpace.set(
        spaceId,
        recents.length > 0
          ? recents
          : [...validIds].sort(
              (left, right) =>
                (this.#tabInfo(right)?.lastActiveAt ?? 0) -
                (this.#tabInfo(left)?.lastActiveAt ?? 0),
            ),
      );
      for (const group of saved.splitGroups) {
        if (group.tabIds.every((tabId) => validIds.has(tabId))) {
          this.#splitGroups.set(
            group.id,
            splitGroupInfo(
              group.id,
              group.tabIds,
              group.mode,
              group.gridLayout,
            ),
          );
        }
      }
      for (const group of saved.tabGroups ?? []) {
        if (!this.#tabGroups.has(group.id)) this.#tabGroups.set(group.id, { ...group, tabIds: [...group.tabIds] });
      }
    }
    this.#reconcileTabGroups();
  }

  #tabInfo(tabId: string): BrowserTabInfo | null {
    return (
      this.#tabs.get(tabId)?.info ?? this.#dormantTabs.get(tabId)?.info ?? null
    );
  }

  #spaceTabIds(spaceId: string): string[] {
    return this.#tabOrder.filter(
      (tabId) => this.#tabInfo(tabId)?.spaceId === spaceId,
    );
  }

  /** The Space's most recently visited surviving tab, else its first in sidebar order. */
  #lastVisitedTabId(spaceId: string): string | undefined {
    const recent = (this.#recentTabIdsBySpace.get(spaceId) ?? []).find(
      (tabId) => this.#tabInfo(tabId)?.spaceId === spaceId,
    );
    return recent ?? this.#spaceTabIds(spaceId)[0];
  }

  /**
   * Make sure the tab — and, in a split, every pane beside it — has a live
   * view. A sleeping tab's view is created here; whether the call also waits
   * for its page to LOAD is `awaitLoad` (see #createManagedTab). A switch
   * the person is watching must not: the view is shown at once and the page
   * fills it in, the way a browser shows a reloading tab.
   */
  async #hydrateTabAndGroup(
    tabId: string,
    options: { awaitLoad?: boolean } = {},
  ): Promise<void> {
    const group = this.#splitGroupFor(tabId);
    const ids = group === undefined ? [tabId] : group.tabIds;
    await Promise.all(ids.map((id) => this.#ensureLiveTab(id, options)));
  }

  async #ensureLiveTab(
    tabId: string,
    options: { awaitLoad?: boolean } = {},
  ): Promise<ManagedTab> {
    const live = this.#tabs.get(tabId);
    if (live !== undefined) return live;
    // Two quick presses on one sleeping tab must not build it two views: the
    // dormant entry stays until the view exists, so the second request would
    // otherwise start a wake of its own.
    const waking = this.#wakeInFlight.get(tabId);
    if (waking !== undefined) return waking;
    const dormant = this.#dormantTabs.get(tabId);
    if (dormant === undefined) throw new Error(`unknown tab ${tabId}`);
    const wake = this.#createManagedTab({
      url: dormant.info.url,
      kind: "human",
      runId: null,
      spaceId: dormant.info.spaceId,
      activate: false,
      anchorId: dormant.info.anchorId,
      restoredInfo: dormant.info,
      history: dormant.history,
      awaitLoad: options.awaitLoad,
    }).then(() => this.#requireTab(tabId));
    this.#wakeInFlight.set(tabId, wake);
    try {
      return await wake;
    } finally {
      this.#wakeInFlight.delete(tabId);
    }
  }

  /** The woken view stays hidden behind the pane's placeholder until #endWake. */
  #beginWake(tabId: string): void {
    this.#forgetWake(tabId);
    const timer = setTimeout(() => this.#endWake(tabId), WAKE_REVEAL_TIMEOUT_MS);
    timer.unref?.();
    this.#waking.set(tabId, timer);
  }

  /** Drop the wake without a layout pass: the tab is going away or asleep again. */
  #forgetWake(tabId: string): boolean {
    const timer = this.#waking.get(tabId);
    if (timer === undefined) return false;
    clearTimeout(timer);
    this.#waking.delete(tabId);
    return true;
  }

  /** The page has something to show: reveal the view and take the placeholder down. */
  #endWake(tabId: string): void {
    if (!this.#forgetWake(tabId)) return;
    this.#applyLayout();
    this.#onChange();
  }

  /**
   * The woken document is ready. dom-ready is a frame or two before the
   * compositor has drawn it, so wait for one painted frame (bounded, as the
   * still capture does) before the view replaces the placeholder — swapping
   * on dom-ready itself would show a white flash where the placeholder was.
   */
  async #revealWoken(tab: ManagedTab): Promise<void> {
    if (!this.#waking.has(tab.info.id)) return;
    await this.#settleFrame(tab);
    this.#endWake(tab.info.id);
  }

  /**
   * Forced focus (./forced-focus.ts). A suspended tab keeps the flag and
   * takes it up again when it wakes.
   */
  async setForcedFocus(tabId: string, enabled: boolean): Promise<void> {
    const tab = this.#tabs.get(tabId);
    const info = tab?.info ?? this.#dormantTabs.get(tabId)?.info;
    if (info === undefined) throw new Error("unknown tab");
    if ((info.forcedFocus === true) === enabled) return;
    info.forcedFocus = enabled;
    this.#onChange();
    if (tab !== undefined) await this.#applyForcedFocus(tab);
  }

  async #applyForcedFocus(tab: ManagedTab): Promise<void> {
    const enabled = tab.info.forcedFocus === true;
    try {
      await setFocusEmulation(tab.view.webContents, enabled);
    } catch (error) {
      // Nothing is holding the page up, so the chrome must not say otherwise.
      if (enabled && tab.info.forcedFocus === true) {
        tab.info.forcedFocus = false;
        this.#publishManagedTab(tab);
      }
      throw error;
    }
  }

  async suspendTab(tabId: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (
      tab === undefined ||
      tab.info.kind !== "human" ||
      (this.#visibleTabIds().includes(tabId) || this.#media.has(tabId))
    )
      return;
    this.#cancelPermissionsForTab(tabId);
    this.#cancelPasskeysForTab(tabId);
    this.#passkeySupport.delete(tabId);
    this.#capturingTabs.delete(tabId);
    this.#forgetWake(tabId);
    this.#paneSizes.delete(tabId);
    this.#cancelPresentationRelease(tabId);
    this.#removeMedia(tabId);
    this.#readAloudTabGone(tabId, "suspended");
    this.#releaseFullscreen(tabId);
    const info: BrowserTabInfo = {
      ...tab.info,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      lifecycle: "suspended",
    };
    this.#tabs.delete(tabId);
    // The page goes with its process, its stack and state do not: the tab
    // wakes where it was, scrolled where it was, with what was typed.
    this.#dormantTabs.set(tabId, {
      info,
      history: captureTabHistory(tab.view.webContents, true) ?? tab.history,
    });
    tab.view.setVisible(false);
    this.#window.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    this.#onChange();
  }

  #suspendIdleTabs(now = Date.now()): void {
    for (const tab of this.#tabs.values()) {
      const { kind, lastActiveAt, spaceId, anchorId, forcedFocus } = tab.info;
      if (
        kind !== "human" ||
        // Kept running in the background on purpose.
        forcedFocus === true ||
        now - lastActiveAt < TAB_IDLE_SUSPEND_MS ||
        (anchorId !== null && this.#isFavoriteAnchor(spaceId, anchorId))
      )
        continue;
      void this.suspendTab(tab.info.id);
    }
  }

  async switchSpace(spaceId: string): Promise<void> {
    if (this.#spaceStore.get(spaceId) === null)
      throw new Error("unknown Space");
    const previousSpaceId = this.activeSpaceId();
    if (previousSpaceId === spaceId) return;
    if (this.#activeTabId !== null)
      this.#lastActiveTabBySpace.set(previousSpaceId, this.#activeTabId);
    this.#discardGlance();
    if (this.#findState.open) this.find({ type: "close" });
    this.#layout = { views: [] };
    this.#applyLayout();
    this.#spaceStore.setActive(spaceId);
    const remembered = this.#lastActiveTabBySpace.get(spaceId);
    const fallback = this.#spaceTabIds(spaceId)[0];
    const next =
      remembered !== undefined && this.#tabInfo(remembered)?.spaceId === spaceId
        ? remembered
        : fallback;
    if (next === undefined) {
      await this.createTab(this.#homeUrl(), { spaceId });
      return;
    }
    const serial = ++this.#activationSerial;
    await this.#hydrateTabAndGroup(next, { awaitLoad: false });
    // A tab chosen in the new Space while its last one woke stands.
    if (this.#activationSerial !== serial && this.#activeTabId !== next) return;
    this.#activateTab(next);
    this.#onChange();
  }

  async forkSpace(request: ForkSpaceRequest): Promise<ForkSpaceResult> {
    const parentSpaceId = this.activeSpaceId();
    const activeTabId = this.#activeTabId;
    const activeGroup =
      activeTabId === null ? undefined : this.#splitGroupFor(activeTabId);
    const selectedIds =
      request.tabs === "all"
        ? new Set(
            this.#spaceTabIds(parentSpaceId).filter(
              (tabId) => this.#tabInfo(tabId)?.kind === "human",
            ),
          )
        : new Set(
            activeGroup === undefined
              ? activeTabId === null
                ? []
                : [activeTabId]
              : activeGroup.tabIds,
          );
    const sources = [...selectedIds].flatMap((tabId) => {
      const info = this.#tabInfo(tabId);
      return info !== null &&
        info.spaceId === parentSpaceId &&
        info.kind === "human"
        ? [{ ...info }]
        : [];
    });
    const origins = request.includeSession
      ? [
          ...new Set(
            sources
              .map((tab) => webOrigin(tab.url))
              .filter((origin): origin is string => origin !== null),
          ),
        ]
      : [];
    const contexts = new Map<string, CapturedForkContext>();
    if (request.includeSession) {
      for (const source of sources) {
        const wasDormant = this.#dormantTabs.has(source.id);
        const live = await this.#ensureLiveTab(source.id);
        contexts.set(source.id, await this.#captureForkContext(live));
        if (wasDormant) await this.suspendTab(source.id);
      }
    }

    const child = this.#spaceStore.createFork(
      parentSpaceId,
      request.name,
      request.purpose,
      origins,
    );
    const createdTabIds: string[] = [];
    try {
      // The child's proxy rules go in before any cookie lands in it.
      await this.prepareSpaceSession(child.id);
      if (request.includeSession) {
        this.#hooks.beginBulkCookieWrite?.(child.id);
        try {
          await this.#copyCookies(
            spacePartition(parentSpaceId),
            spacePartition(child.id),
            origins,
          );
        } finally {
          this.#hooks.endBulkCookieWrite?.(child.id);
        }
      }
      const childBySource = new Map<string, string>();
      for (const source of sources) {
        const childTabId = await this.#createManagedTab({
          url: source.url,
          kind: "human",
          runId: null,
          spaceId: child.id,
          activate: false,
          anchorId: request.includeShelf ? source.anchorId : null,
        });
        createdTabIds.push(childTabId);
        childBySource.set(source.id, childTabId);
        const context = contexts.get(source.id);
        if (context !== undefined)
          await this.#applyForkContext(childTabId, context);
      }
      if (createdTabIds.length === 0) {
        createdTabIds.push(
          await this.createTab(this.#homeUrl(), {
            activate: false,
            spaceId: child.id,
          }),
        );
      }
      if (activeGroup !== undefined) {
        const childIds = activeGroup.tabIds.flatMap((sourceId) => {
          const childId = childBySource.get(sourceId);
          return childId === undefined ? [] : [childId];
        });
        if (childIds.length === activeGroup.tabIds.length) {
          this.#formSplit(
            childIds,
            activeGroup.mode,
            childIds[0] ?? "",
            undefined,
            activeGroup.gridLayout,
          );
        }
      }
      const preferred =
        activeTabId === null ? undefined : childBySource.get(activeTabId);
      this.#spaceStore.setActive(child.id);
      this.#activateTab(preferred ?? createdTabIds[0] ?? "");
      this.#layout = { views: [] };
      this.#applyLayout();
      this.#onChange();
      return {
        spaceId: child.id,
        parentSpaceId,
        copiedTabs: sources.length,
        copiedOrigins: origins,
        limitations: request.includeSession
          ? [
              "IndexedDB, service workers, downloads, grants, and run history stay in the parent Space.",
            ]
          : [],
      };
    } catch (error) {
      for (const tabId of createdTabIds) await this.closeTab(tabId, { force: true });
      const target = session.fromPartition(spacePartition(child.id));
      await Promise.allSettled([
        target.clearStorageData(),
        target.clearCache(),
      ]);
      this.#spaceStore.remove(child.id);
      this.#spaceStore.setActive(parentSpaceId);
      throw new Error(
        `The Space was not forked because its context could not be transferred: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #captureForkContext(tab: ManagedTab): Promise<CapturedForkContext> {
    if (tab.view.webContents.isDestroyed())
      throw new Error(`${tab.info.title} is no longer available`);
    const value = await tab.view.webContents.executeJavaScript(`(() => {
      const read = (storage) => {
        const entries = {};
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key !== null) entries[key] = storage.getItem(key) ?? "";
        }
        return entries;
      };
      return {
        selectedText: String(globalThis.getSelection?.()?.toString() ?? "").slice(0, 12000),
        formState: [...document.querySelectorAll("input, textarea, select")]
          .filter((element) => !(element instanceof HTMLInputElement) || !["hidden", "password"].includes(element.type))
          .map((element) => ({
            name: element.getAttribute("name") || element.id || "unnamed",
            type: element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase(),
            value: String(element.value ?? "").slice(0, 8000),
          })),
        localStorage: read(globalThis.localStorage),
        sessionStorage: read(globalThis.sessionStorage),
      };
    })()`);
    return value as CapturedForkContext;
  }

  async #applyForkContext(
    tabId: string,
    context: CapturedForkContext,
  ): Promise<void> {
    const encoded = JSON.stringify(context).replaceAll("<", "\\u003c");
    await this.#requireTab(tabId).view.webContents.executeJavaScript(`(() => {
      const context = ${encoded};
      const write = (storage, entries) => {
        storage.clear();
        for (const [key, value] of Object.entries(entries)) storage.setItem(key, value);
      };
      write(globalThis.localStorage, context.localStorage);
      write(globalThis.sessionStorage, context.sessionStorage);
      for (const item of context.formState) {
        const escaped = CSS.escape(item.name);
        const element = document.querySelector('[name="' + escaped + '"], #' + escaped);
        if (element && "value" in element) {
          element.value = item.value;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    })()`);
  }

  async #copyCookies(
    sourcePartition: string,
    targetPartition: string,
    origins: string[],
  ): Promise<void> {
    const source = session.fromPartition(sourcePartition);
    const target = session.fromPartition(targetPartition);
    const seen = new Set<string>();
    for (const origin of origins) {
      const cookies = await source.cookies.get({ url: origin });
      for (const cookie of cookies) {
        const key = `${cookie.name}\u0000${cookie.domain ?? ""}\u0000${cookie.path ?? "/"}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const domain =
          cookie.domain?.replace(/^\./, "") ?? new URL(origin).hostname;
        const url = `${cookie.secure === true ? "https" : "http"}://${domain}${cookie.path ?? "/"}`;
        await target.cookies.set({
          url,
          name: cookie.name,
          value: cookie.value,
          ...(!cookie.hostOnly && cookie.domain !== undefined
            ? { domain: cookie.domain }
            : {}),
          ...(cookie.path !== undefined ? { path: cookie.path } : {}),
          ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
          ...(cookie.httpOnly !== undefined
            ? { httpOnly: cookie.httpOnly }
            : {}),
          ...(!cookie.session && cookie.expirationDate !== undefined
            ? { expirationDate: cookie.expirationDate }
            : {}),
          sameSite: cookie.sameSite,
        });
      }
    }
    await target.cookies.flushStore();
  }

  /** Newest active media first; the shell removes visible tabs and shows the first three. */
  media(): BrowserMediaInfo[] {
    return [...this.#media.values()]
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .map((item) => ({ ...item }));
  }

  browserControls(): BrowserControlsSnapshot {
    const active =
      this.#activeTabId === null
        ? undefined
        : this.#tabs.get(this.#activeTabId);
    // A tab whose page is already gone (closing, its teardown under way)
    // has no site to describe.
    const contents = active?.view.webContents as WebContents | undefined;
    const tab = contents === undefined || contents.isDestroyed() ? undefined : active;
    if (tab === undefined) {
      return {
        tabId: null,
        tabKind: null,
        origin: "",
        secure: false,
        zoomPercent: 100,
        muted: false,
        permissions: Object.fromEntries(
          BROWSER_PERMISSIONS.map((permission) => [
            permission,
            { decision: "ask", source: "default", reason: "no active site" },
          ]),
        ) as BrowserControlsSnapshot["permissions"],
        externalAppSchemes: [],
        actions: Object.fromEntries(
          GUARDED_BROWSER_ACTIONS.map((action) => [
            action,
            { decision: "allow", source: "default", reason: "no active site" },
          ]),
        ) as BrowserControlsSnapshot["actions"],
        passkeys: {
          webAuthnAvailable: false,
          platformAuthenticatorAvailable: false,
          conditionalMediationAvailable: false,
          touchIdConfigured: this.#touchIdConfigured,
        },
        pendingPermissions: [],
        pendingPasskeyRequests: [],
        downloads: [],
        recentEvents: [],
      };
    }
    const taskVerdict = (allowed: boolean, capability: string) => ({
      decision: allowed ? ("allow" as const) : ("block" as const),
      source: "task" as const,
      reason: allowed
        ? `granted by the active task capsule`
        : `${capability} is not granted to this task`,
    });
    const permissions = Object.fromEntries(
      BROWSER_PERMISSIONS.map((permission) => [
        permission,
        tab.info.kind === "agent"
          ? {
              decision: "block",
              source: "task",
              reason: "site permissions are unavailable to task tabs",
            }
          : this.#policy.permission(tab.info.url, permission),
      ]),
    ) as BrowserControlsSnapshot["permissions"];
    const actions = Object.fromEntries(
      GUARDED_BROWSER_ACTIONS.map((action) => {
        if (tab.info.kind === "human")
          return [action, this.#policy.action(tab.info.url, action)];
        const allowed =
          action === "download"
            ? tab.enforcer?.allowsDownloads() === true
            : action === "upload"
              ? tab.enforcer?.allowsUploads() === true
              : action === "copy" || action === "paste"
                ? tab.enforcer?.allowsClipboard() === true
                : false;
        return [action, taskVerdict(allowed, action)];
      }),
    ) as BrowserControlsSnapshot["actions"];
    const passkeySupport =
      tab.info.kind === "human"
        ? this.#passkeySupport.get(tab.info.id)
        : undefined;
    return {
      tabId: tab.info.id,
      tabKind: tab.info.kind,
      origin: browserOrigin(tab.info.url),
      secure: isSecureBrowserUrl(tab.info.url),
      zoomPercent: Math.round(tab.view.webContents.getZoomFactor() * 100),
      muted: tab.view.webContents.isAudioMuted(),
      permissions,
      externalAppSchemes:
        tab.info.kind === "human"
          ? this.#policy.externalAppSchemes(tab.info.url)
          : [],
      actions,
      passkeys: {
        webAuthnAvailable: passkeySupport?.webAuthnAvailable ?? false,
        platformAuthenticatorAvailable:
          passkeySupport?.platformAuthenticatorAvailable ?? false,
        conditionalMediationAvailable:
          passkeySupport?.conditionalMediationAvailable ?? false,
        touchIdConfigured: this.#touchIdConfigured,
      },
      // A Glance is a page over the active tab rather than a tab of its own:
      // what it asks is answered here too, or nobody would ever see it and
      // the request would sit out its minute and be refused.
      pendingPermissions: [...this.#pendingPermissions.entries()]
        .filter(
          ([, request]) =>
            request.tabId === tab.info.id ||
            (this.#glance?.ownerTabId === tab.info.id &&
              request.tabId === this.#glance.tab.info.id),
        )
        .map(([id, request]) => ({
          id,
          tabId: request.tabId,
          // The page that asked — the Glance's own site, not its owner's.
          origin: browserOrigin(
            (this.#permissionTab(request.tabId) ?? tab).info.url,
          ),
          permission: request.permission,
          permissions: [...request.permissions],
          requestedAt: Number(id.split(":").at(-1)) || Date.now(),
          ...(request.externalApp === undefined
            ? {}
            : {
                externalApp: {
                  scheme: request.externalApp.scheme,
                  appName: request.externalApp.appName,
                },
              }),
        })),
      pendingPasskeyRequests: [...this.#pendingPasskeys.entries()]
        .filter(
          ([, request]) =>
            request.tabId === tab.info.id && request.popup === undefined,
        )
        .map(([id, request]) => ({
          id,
          tabId: request.tabId,
          origin: request.origin,
          relyingPartyId: request.relyingPartyId,
          accounts: request.accounts.map((account) => ({ ...account })),
          requestedAt: request.requestedAt,
        })),
      downloads: [...this.#downloads.values()]
        .filter((download) => download.tabId === tab.info.id)
        .sort((left, right) => right.createdAt - left.createdAt)
        .map((download) => ({ ...download })),
      recentEvents: this.#policyEvents
        .filter((event) => event.tabId === tab.info.id)
        .slice(0, 30)
        .map((event) => ({ ...event })),
    };
  }

  async browserControl(command: BrowserControlCommand): Promise<void> {
    if (command.type === "resolvePermission") {
      this.#resolvePermission(command.requestId, command.decision);
      return;
    }
    if (command.type === "selectPasskey") {
      this.#resolvePasskey(command.requestId, command.accountId);
      return;
    }
    const tab =
      this.#activeTabId === null
        ? undefined
        : this.#tabs.get(this.#activeTabId);
    if (tab === undefined) return;
    if (command.type === "setPermission") {
      if (tab.info.kind === "human")
        this.#policy.setPermission(
          tab.info.url,
          command.permission,
          command.decision,
        );
      this.#sendTabDataPolicy(tab);
      this.#emitBrowserControls();
      return;
    }
    if (command.type === "clearPermissions") {
      if (tab.info.kind === "human")
        this.#policy.clearPermissions(tab.info.url);
      this.#sendTabDataPolicy(tab);
      this.#emitBrowserControls();
      return;
    }
    if (
      command.type === "zoomIn" ||
      command.type === "zoomOut" ||
      command.type === "zoomReset"
    ) {
      const current = tab.view.webContents.getZoomFactor();
      const next =
        command.type === "zoomReset"
          ? 1
          : Math.min(
              3,
              Math.max(0.5, current + (command.type === "zoomIn" ? 0.1 : -0.1)),
            );
      tab.view.webContents.setZoomFactor(next);
      this.#emitBrowserControls();
      return;
    }
    if (command.type === "toggleMute") {
      tab.view.webContents.setAudioMuted(!tab.view.webContents.isAudioMuted());
      this.#emitBrowserControls();
      return;
    }
    if (command.type === "copyUrl") {
      this.#copyPageUrl(tab, command.format);
      return;
    }
    if (command.type === "print") {
      const verdict = this.#actionVerdict(tab, "print");
      this.#recordPolicy(
        tab,
        "print",
        verdict.decision,
        verdict.source,
        verdict.reason,
      );
      if (verdict.decision === "allow") {
        await new Promise<void>((resolve) =>
          tab.view.webContents.print({ printBackground: true }, () =>
            resolve(),
          ),
        );
      }
      return;
    }
    if (command.type === "clearDownloads") {
      // Live downloads keep going and keep their row; everything settled goes.
      for (const [id, download] of this.#downloads) {
        if (download.state === "progress") continue;
        this.#downloads.delete(id);
        this.#downloadItems.delete(id);
      }
      this.#emitBrowserControls();
      this.#emitDownloads();
      return;
    }
    if (
      command.type !== "cancelDownload" &&
      command.type !== "showDownload" &&
      command.type !== "openDownload" &&
      command.type !== "retryDownload" &&
      command.type !== "removeDownload"
    )
      return;
    const download = this.#downloads.get(command.downloadId);
    if (download === undefined) return;
    const item = this.#downloadItems.get(command.downloadId);
    switch (command.type) {
      case "cancelDownload":
        if (download.state === "progress") item?.cancel();
        return;
      case "showDownload":
        if (item !== undefined && item.getSavePath() !== "")
          shell.showItemInFolder(item.getSavePath());
        return;
      case "openDownload":
        if (download.state === "completed" && item !== undefined && item.getSavePath() !== "")
          void shell.openPath(item.getSavePath());
        return;
      case "removeDownload":
        if (download.state === "progress") return;
        this.#downloads.delete(command.downloadId);
        this.#downloadItems.delete(command.downloadId);
        this.#emitBrowserControls();
        this.#emitDownloads();
        return;
      case "retryDownload": {
        if (download.state !== "cancelled" && download.state !== "interrupted") return;
        // From the tab it came from, so the same site policy applies and
        // will-download tracks the new attempt as that tab's; the active
        // tab stands in once the original is gone.
        const origin = this.#tabs.get(download.tabId);
        const tab =
          origin !== undefined && !origin.view.webContents.isDestroyed()
            ? origin
            : this.#activeTabId === null
              ? undefined
              : this.#tabs.get(this.#activeTabId);
        if (tab === undefined || tab.view.webContents.isDestroyed()) return;
        this.#downloads.delete(command.downloadId);
        this.#downloadItems.delete(command.downloadId);
        tab.view.webContents.downloadURL(download.url);
        this.#emitBrowserControls();
        this.#emitDownloads();
        return;
      }
    }
  }

  /**
   * Every download of this session, from every tab, newest first — what the
   * chrome's downloads chip and list show. The per-tab view of the same
   * records is `browserControls().downloads` (Site controls → Transfers).
   */
  downloads(): BrowserDownload[] {
    return [...this.#downloads.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((download) => ({ ...download }));
  }

  /** Told on every download change; the host publishes it to the shell. */
  onDownloadsChange: (downloads: BrowserDownload[]) => void = () => {};

  #emitDownloads(): void {
    this.onDownloadsChange(this.downloads());
  }

  /** Toggle Chromium DevTools for the active webpage rather than the app shell. */
  togglePageDevTools(): void {
    const tab =
      this.#activeTabId === null
        ? undefined
        : this.#tabs.get(this.#activeTabId);
    if (tab === undefined || tab.view.webContents.isDestroyed()) return;
    if (tab.view.webContents.isDevToolsOpened()) {
      tab.view.webContents.closeDevTools();
      return;
    }
    tab.view.webContents.openDevTools({ mode: "detach", activate: true });
  }

  findState(): FindState {
    const smartAvailable = this.#smartFindAvailable();
    return {
      ...this.#findState,
      // Signed out or switched off while the bar is open: it falls back to exact.
      mode: smartAvailable ? this.#findState.mode : "exact",
      smartAvailable,
    };
  }

  openFind(mode: FindMode = "exact"): void {
    this.find({ type: "mode", mode });
  }

  /** Whether a smart find could run now: the setting is on and there is a model to ask. */
  #smartFindAvailable(): boolean {
    return this.#settings().search.smartFind && (this.#hooks.findModel?.() ?? null) !== null;
  }

  #endSmartFind(): void {
    const smart = this.#smartFind;
    this.#smartFind = null;
    if (smart !== null) void smart.session.close();
  }

  /** The smart find session for this tab's current document, made on first use. */
  #smartFindFor(tab: ManagedTab): SmartFindSession {
    if (this.#smartFind?.tabId === tab.info.id) return this.#smartFind.session;
    this.#endSmartFind();
    const session = new SmartFindSession({
      page: smartFindPageFor(tab.view.webContents),
      model: () => (this.#settings().search.smartFind ? (this.#hooks.findModel?.() ?? null) : null),
      onChange: (view) => {
        if (this.#smartFind?.session !== session || this.#findState.mode !== "smart") return;
        this.#findState = {
          ...this.#findState,
          activeMatchOrdinal: view.activeMatchOrdinal,
          matches: view.matches,
          smart: view.smart,
        };
        this.#emitFind();
      },
    });
    this.#smartFind = { tabId: tab.info.id, session };
    return session;
  }

  find(command: FindCommand): void {
    const tab =
      this.#activeTabId === null
        ? undefined
        : this.#tabs.get(this.#activeTabId);
    if (command.type === "close") {
      if (tab !== undefined && !tab.view.webContents.isDestroyed())
        tab.view.webContents.stopFindInPage("clearSelection");
      this.#findSession = null;
      this.#endSmartFind();
      this.#findState = CLOSED_FIND;
      this.#emitFind();
      tab?.view.webContents.focus();
      return;
    }
    const mode: FindMode =
      (command.mode ?? this.#findState.mode) === "smart" && this.#smartFindAvailable()
        ? "smart"
        : "exact";
    if (mode !== this.#findState.mode || !this.#findState.open) {
      // Whatever the other mode had on the page comes down: the two never paint at once.
      if (tab !== undefined && !tab.view.webContents.isDestroyed()) tab.view.webContents.stopFindInPage("clearSelection");
      this.#findSession = null;
      this.#endSmartFind();
      this.#findState = { ...this.#findState, open: true, mode, activeMatchOrdinal: 0, matches: 0, smart: IDLE_SMART_FIND };
      if (command.type === "mode") {
        this.#emitFind();
        // Back in exact mode, the typed text is searched as it would have been.
        if (mode === "exact" && this.#findState.query !== "") this.find({ type: "search", query: this.#findState.query, forward: true, mode });
        return;
      }
    } else if (command.type === "mode") {
      this.#emitFind();
      return;
    }
    if (tab === undefined || tab.view.webContents.isDestroyed()) return;
    if (mode === "smart") {
      this.#findState = { ...this.#findState, open: true, query: command.query };
      const session = this.#smartFindFor(tab);
      if (command.draft === true) session.edit(command.query);
      else session.search(command.query, command.forward);
      this.#emitFind();
      return;
    }
    // Step the open session only when it is this tab's, for this query, and
    // found something; anything else (a new query, a query that found nothing
    // last time and may now) starts afresh.
    const stepSession =
      this.#findSession !== null &&
      this.#findSession.tabId === tab.info.id &&
      this.#findSession.query === command.query &&
      this.#findState.matches > 0;
    this.#findState = { ...this.#findState, open: true, query: command.query };
    if (command.query === "") {
      tab.view.webContents.stopFindInPage("clearSelection");
      this.#findSession = null;
      this.#findState = {
        ...this.#findState,
        activeMatchOrdinal: 0,
        matches: 0,
      };
    } else {
      this.#findRequestId = tab.view.webContents.findInPage(command.query, {
        forward: command.forward,
        findNext: !stepSession,
      });
      // The counts stay until the session's reply replaces them, so the bar
      // does not flash 0 / 0 between keystrokes.
      if (!stepSession)
        this.#findSession = { tabId: tab.info.id, query: command.query };
    }
    this.#emitFind();
  }

  /**
   * Give the keyboard back to the active tab's page, if its view is on
   * screen to take it. False when it is not (no tab, or a shell overlay has
   * the views hidden) — the caller hands the keyboard to the shell instead.
   */
  focusActivePage(): boolean {
    if (this.#overlayActive || this.#activeTabId === null) return false;
    const tab = this.#tabs.get(this.#activeTabId);
    if (tab === undefined || tab.view.webContents.isDestroyed()) return false;
    if (!tab.view.getVisible()) return false;
    tab.view.webContents.focus();
    return true;
  }

  activePaneBounds(): ContentBounds | null {
    const placement = this.#layout.views.find(
      ({ tabId }) => tabId === this.#activeTabId,
    );
    return placement === undefined ? null : { ...placement.bounds };
  }

  /** Accept a report only from the real WebContents of a managed human tab. */
  acceptMediaReport(senderId: number, value: unknown): void {
    const tab = this.#tabForWebContents(senderId);
    // A Glance shares the lookup but is not a managed tab until promoted.
    if (
      tab === undefined ||
      tab.info.kind !== "human" ||
      this.#tabs.get(tab.info.id) !== tab
    )
      return;
    if (value === null) {
      this.#removeMedia(tab.info.id);
      return;
    }
    const report = normalizeTabMediaReport(value);
    if (report === null) return;
    const tabId = tab.info.id;
    if (this.#suppressedMedia.has(tabId)) {
      if (!report.playing) return;
      this.#suppressedMedia.delete(tabId);
    }

    const current = this.#media.get(tabId);
    if (current !== undefined) {
      const next = this.#mediaInfo(tab, report, current);
      // The shell projects the clock from `position`/`updatedAt` itself, so
      // a report whose only news is a position the projection already
      // predicts is not worth a round trip through every renderer.
      if (!mediaInfoChanged(current, next)) return;
      this.#media.set(tabId, next);
      this.#syncFollow(tabId, next);
      if (watchedVideo(next) && !watchedVideo(current)) this.#yieldBackgroundVideos(tabId);
      this.#emitMedia();
      return;
    }
    if (!report.playing) {
      this.#clearPendingMedia(tabId);
      return;
    }

    this.#pendingMedia.set(tabId, { tab, report });
    if (this.#mediaRevealTimers.has(tabId)) return;
    const timer = setTimeout(() => {
      this.#mediaRevealTimers.delete(tabId);
      const pending = this.#pendingMedia.get(tabId);
      this.#pendingMedia.delete(tabId);
      if (
        pending === undefined ||
        !pending.report.playing ||
        this.#tabs.get(tabId) !== pending.tab ||
        pending.tab.view.webContents.isDestroyed()
      ) {
        return;
      }
      const revealed = this.#mediaInfo(pending.tab, pending.report);
      this.#media.set(tabId, revealed);
      this.#syncFollow(tabId, revealed);
      if (watchedVideo(revealed)) this.#yieldBackgroundVideos(tabId);
      this.#emitMedia();
    }, MEDIA_REVEAL_DELAY_MS);
    this.#mediaRevealTimers.set(tabId, timer);
  }

  /** Accept capability booleans only from a managed human tab's isolated preload. */
  acceptPasskeySupport(senderId: number, value: unknown): void {
    const tab = [...this.#tabs.values()].find(
      (candidate) =>
        candidate.info.kind === "human" &&
        candidate.view.webContents.id === senderId,
    );
    const support = normalizeTabPasskeySupport(value);
    if (tab === undefined || support === null) return;
    this.#passkeySupport.set(tab.info.id, support);
    if (tab.info.id === this.#activeTabId) this.#emitBrowserControls();
  }

  async controlMedia(tabId: string, control: MediaControl): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (
      tab === undefined ||
      tab.info.kind !== "human" ||
      tab.view.webContents.isDestroyed()
    )
      return;
    if (control.type === "focus") {
      await this.selectTab(tabId);
      tab.view.webContents.focus();
      return;
    }
    if (control.type === "followText") {
      await this.#setFollowText(tabId, control.enabled);
      return;
    }
    if (control.type === "dismiss") {
      this.#suppressedMedia.add(tabId);
      this.#clearPendingMedia(tabId);
      if (this.#mediaPreview?.tabId === tabId) this.setMediaPreview(null);
      const removed = this.#media.delete(tabId);
      tab.view.webContents.send(IPC.mediaCommand, control);
      if (removed) this.#emitMedia();
      // An unlisted tab exists only to be this card. Dismissing the card is
      // the only way to close it — there is no row to close instead — so the
      // dismissal takes the tab with it rather than stranding it.
      if (tab.info.unlisted) void this.closeTab(tabId, { force: true });
      return;
    }
    const info = this.#media.get(tabId);
    if (control.type === "mute") {
      if (tab.view.webContents.isAudioMuted()) {
        tab.view.webContents.setAudioMuted(false);
      } else if (info?.elementMuted === true) {
        tab.view.webContents.send(IPC.mediaCommand, control);
        return;
      } else {
        tab.view.webContents.setAudioMuted(true);
      }
      if (info !== undefined) {
        const wasWatched = watchedVideo(info);
        info.muted = tab.view.webContents.isAudioMuted() || info.elementMuted;
        if (watchedVideo(info) && !wasWatched) this.#yieldBackgroundVideos(tabId);
        this.#emitMedia();
      }
      return;
    }
    if (control.type === "pictureInPicture") {
      await tab.view.webContents.executeJavaScript(
        PICTURE_IN_PICTURE_SCRIPT,
        true,
      );
      return;
    }
    // A play from a card is a choice of what to watch, whatever the card's
    // mute: the other background videos yield now rather than when (and only
    // if) the page reports the sound on.
    if (control.type === "playPause" && info?.hasVideo === true && !info.playing)
      this.#yieldBackgroundVideos(tabId);
    tab.view.webContents.send(IPC.mediaCommand, control);
  }

  /**
   * Only one video plays in the background at a time. The one in `keepTabId`
   * has just started (or just became the one being watched), so every other
   * playing video whose tab is not on screen pauses; its card stays in the
   * stack, paused, for resuming. A pane's video is left alone — a split can
   * show two on purpose — and so is one presented in PiP or fullscreen,
   * which the stack does not list.
   */
  #yieldBackgroundVideos(keepTabId: string): void {
    const visible = new Set(this.#visibleTabIds());
    for (const info of this.#media.values()) {
      if (
        info.tabId === keepTabId ||
        !info.hasVideo ||
        !info.playing ||
        info.presenting ||
        visible.has(info.tabId)
      )
        continue;
      const tab = this.#tabs.get(info.tabId);
      if (tab === undefined || tab.view.webContents.isDestroyed()) continue;
      tab.view.webContents.send(IPC.mediaCommand, { type: "pause" } satisfies MediaControl);
    }
  }

  /**
   * The foreground changed: a tab that was showing a playing video may have
   * just joined the background while another video was already playing
   * there (a card played while a pane played). The one most recently
   * started with its sound on is the one being watched; the rest yield.
   */
  #settleBackgroundVideos(): void {
    const visible = new Set(this.#visibleTabIds());
    const contenders = [...this.#media.values()]
      .filter((info) => watchedVideo(info) && !info.presenting && !visible.has(info.tabId))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    if (contenders.length > 1) this.#yieldBackgroundVideos(contenders[0]!.tabId);
  }

  /**
   * Re-compose the playing tab's existing WebContentsView into the sidebar.
   * The tab preload presents its selected video as the document surface, so
   * playback, captions, site controls, and MediaSession all remain original.
   */
  setMediaPreview(preview: MediaPreviewPlacement | null): void {
    const previous = this.#mediaPreview;
    const tab = preview === null ? undefined : this.#tabs.get(preview.tabId);
    const media = preview === null ? undefined : this.#media.get(preview.tabId);
    // A card whose tab is still in a pane is a placement waiting to matter,
    // rather than an invalid one, so nothing here tests the layout: the shell
    // reports the card from the same commit that drops the tab from the
    // layout, and the sidebar's effects run before the pane grid's. Rejecting
    // it for that frame left the page hidden between the two messages — long
    // enough for a site to notice its player went off screen. #applyLayout
    // keeps a pane ahead of a card, so holding the placement changes nothing
    // until the pane is gone.
    const valid =
      preview !== null &&
      tab !== undefined &&
      tab.info.kind === "human" &&
      !tab.view.webContents.isDestroyed() &&
      media?.hasVideo === true &&
      !media.presenting &&
      preview.bounds.width >= 1 &&
      preview.bounds.height >= 1;
    const next = valid
      ? { tabId: preview.tabId, bounds: this.#clampWindowBounds(preview.bounds) }
      : null;

    if (previous?.tabId !== next?.tabId) this.#clearMediaPreview();
    this.#mediaPreview = next;
    this.#applyLayout();
  }

  /**
   * Take the sidebar preview down: the tab goes back to presenting its own
   * document, and the shell hears that nothing is hovered. Every path that
   * drops a preview goes through here — a hover that outlives the view it
   * described leaves the card stuck in its hovered state, since the shell
   * only ever learns the hover ended from this message. Lays out nothing;
   * the caller does that once the rest of its change has settled — and the
   * layout pass is what takes the presentation off the page.
   */
  #clearMediaPreview(): void {
    const preview = this.#mediaPreview;
    if (preview === null) return;
    this.#mediaPreview = null;
    if (!this.#window.isDestroyed())
      this.#window.webContents.send(IPC.mediaPreviewHoverChanged, null);
  }

  /** Forward hover only from the tab currently presented in the sidebar. */
  acceptMediaPreviewHover(senderId: number, hovered: boolean): void {
    const preview = this.#mediaPreview;
    if (preview === null) return;
    const tab = this.#tabs.get(preview.tabId);
    if (tab?.view.webContents.id !== senderId) return;
    this.#window.webContents.send(
      IPC.mediaPreviewHoverChanged,
      hovered ? preview.tabId : null,
    );
  }

  /** The live tab bound to a sidebar shelf entry, if the entry is open. */
  /**
   * Whether a tab anchored to `anchorId` should let go of that anchor when
   * it joins a split view. The sidebar answers "yes" for favorites: a page
   * shown in the tab list is a day tab of its own, not the favorite's tile,
   * so its selection and navigation stop reflecting on the tile.
   */
  anchorLeavesOnSplit: (anchorId: string, spaceId: string) => boolean = () => false;

  tabForAnchor(anchorId: string): BrowserTabInfo | null {
    for (const tabId of this.#tabOrder) {
      const info = this.#tabInfo(tabId);
      if (info?.spaceId === this.activeSpaceId() && info.anchorId === anchorId)
        return { ...info };
    }
    return null;
  }

  /** Bind a tab to a shelf entry (or free it with null). One tab per anchor: a prior holder is freed. */
  setAnchor(tabId: string, anchorId: string | null): void {
    const info = this.#tabInfo(tabId);
    if (info === null) return;
    const changed = new Set<ManagedTab>();
    if (anchorId !== null) {
      for (const otherId of this.#tabOrder) {
        const other = this.#tabInfo(otherId);
        if (
          other?.spaceId === info.spaceId &&
          other.anchorId === anchorId &&
          other.id !== tabId
        ) {
          other.anchorId = null;
          const managed = this.#tabs.get(other.id);
          if (managed !== undefined) changed.add(managed);
        }
      }
    }
    info.anchorId = anchorId;
    const managed = this.#tabs.get(info.id);
    if (managed !== undefined) changed.add(managed);
    for (const tab of changed) this.#sendGlanceConfiguration(tab);
    this.#onChange();
  }

  /**
   * Name a shell-drawn page's tab (docs/notes.md §4). The placeholder
   * document main serves at `pistachio://notes/<id>` is static — it cannot
   * know the note's title — so the page that draws the pane says what the
   * strip should read, exactly as `page-title-updated` would have. Only a
   * shell page may: a tab showing somebody's site names itself.
   */
  setShellPageTitle(tabId: string, title: string): void {
    const tab = this.#tabs.get(tabId) ?? (this.#glance?.tab.info.id === tabId ? this.#glance.tab : undefined);
    if (tab === undefined) throw new Error(`no tab ${tabId}`);
    if (!isShellPageUrl(tab.info.url)) throw new Error("only a shell page may name its own tab");
    tab.shellTitle = { url: tab.info.url, title };
    if (tab.info.title === title) return;
    tab.info.title = title;
    const shown = tab.history?.entries[tab.history.index];
    if (shown !== undefined && shown.url === tab.info.url) shown.title = title;
    this.#publishManagedTab(tab);
  }

  activeTab(): BrowserTabInfo | null {
    const tab =
      this.#activeTabId === null
        ? undefined
        : this.#tabs.get(this.#activeTabId);
    return tab === undefined ? null : { ...tab.info };
  }

  glance(): GlanceState | null {
    const glance = this.#glance;
    if (glance === null) return null;
    return {
      tab: { ...glance.tab.info },
      ownerTabId: glance.ownerTabId,
      source: { ...glance.source },
      backgroundStills: glance.backgroundStills.map((still) => ({ ...still })),
    };
  }

  tab(tabId: string): BrowserTabInfo | null {
    const info = this.#tabInfo(tabId);
    return info === null ? null : { ...info };
  }

  sessionForTab(tabId: string): Session {
    return this.#requireTab(tabId).view.webContents.session;
  }

  /**
   * Synthesize `text` and open its player page as a background tab in the
   * source tab's Space, so the media stack shows the ordinary playback card.
   */
  async readAloud(
    text: string,
    source: BrowserTabInfo,
    options: { maxChars?: number } = {},
  ): Promise<void> {
    const id = randomUUID();
    const abort = new AbortController();
    const excerpt = text.replace(/\s+/gu, " ").trim();
    this.#readAloudJobs.set(id, {
      abort,
      status: {
        id,
        phase: "generating",
        sourceTitle: source.title,
        excerpt: excerpt.length > 120 ? `${excerpt.slice(0, 117).trimEnd()}…` : excerpt,
        startedAt: Date.now(),
        message: null,
      },
    });
    this.#emitReadAloud();
    try {
      // Resolves once the first piece is spoken; the rest follows while it plays.
      const { id: clipId, url, settled } = await this.#readAloud.speak(
        {
          text,
          sourceTitle: source.title,
          sourceUrl: source.url,
          faviconUrl: source.faviconUrl,
          ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }),
        },
        abort.signal,
      );
      if (abort.signal.aborted) {
        this.#readAloud.abandon(clipId);
        return;
      }
      const playerTabId = await this.createTab(url, {
        spaceId: source.spaceId,
        activate: false,
        // The player is a page only so the media observer reports it; it is
        // driven entirely from the sidebar's media card.
        unlisted: true,
      });
      this.#readAloudPlayers.set(playerTabId, { clipId, sourceTabId: source.id, follow: false });
      this.#readAloudJobs.delete(id);
      this.#emitReadAloud();
      void settled.then(() => this.#readAloudSettled(clipId, source.title));
    } catch (error) {
      const job = this.#readAloudJobs.get(id);
      if (job === undefined) return;
      console.error("[read-aloud]", error);
      job.abort = null;
      job.status = {
        ...job.status,
        phase: "failed",
        message: error instanceof Error && error.message !== "" ? error.message : "The selection could not be spoken.",
      };
      this.#emitReadAloud();
      setTimeout(() => {
        if (this.#readAloudJobs.get(id) === job) {
          this.#readAloudJobs.delete(id);
          this.#emitReadAloud();
        }
      }, READ_ALOUD_FAILURE_LINGER_MS);
    }
  }

  readAloudJobs(): ReadAloudStatus[] {
    return [...this.#readAloudJobs.values()].map((job) => ({ ...job.status }));
  }

  /** Stop a generating job, or clear a failed one, from the shell's toast. */
  cancelReadAloud(id: string): void {
    const job = this.#readAloudJobs.get(id);
    if (job === undefined) return;
    this.#readAloudJobs.delete(id);
    job.abort?.abort(new Error("Read aloud cancelled."));
    this.#emitReadAloud();
  }

  #emitReadAloud(): void {
    this.#onReadAloudChange(this.readAloudJobs());
  }

  /**
   * A clip that stopped before its last piece — the voice failed twice in a
   * row — says so where the generating toast was; a clip dismissed mid-way
   * has nothing to report.
   */
  #readAloudSettled(clipId: string, sourceTitle: string): void {
    const clip = this.#readAloud.clip(clipId);
    const playing = [...this.#readAloudPlayers.values()].some((player) => player.clipId === clipId);
    if (clip === null || clip.error === null || !playing) return;
    const id = randomUUID();
    const job = {
      abort: null,
      status: {
        id,
        phase: "failed" as const,
        sourceTitle,
        excerpt: "",
        startedAt: Date.now(),
        message: `Stopped early: ${clip.error}`,
      },
    };
    this.#readAloudJobs.set(id, job);
    this.#emitReadAloud();
    setTimeout(() => {
      if (this.#readAloudJobs.get(id) === job) {
        this.#readAloudJobs.delete(id);
        this.#emitReadAloud();
      }
    }, READ_ALOUD_FAILURE_LINGER_MS);
  }

  /* ---- Following the text ------------------------------------------ */

  /** What a player tab's card offers: null unless its source page is still around. */
  #followTextState(playerTabId: string): BrowserMediaInfo["followText"] {
    const player = this.#readAloudPlayers.get(playerTabId);
    if (player === undefined || player.sourceTabId === null) return null;
    if (!this.#tabs.has(player.sourceTabId) && !this.#dormantTabs.has(player.sourceTabId)) return null;
    return player.follow ? "on" : "off";
  }

  /**
   * Start or stop lighting the clip's words on the page they came from.
   * Starting also brings that page forward: following is for watching.
   */
  async #setFollowText(playerTabId: string, enabled: boolean): Promise<void> {
    const player = this.#readAloudPlayers.get(playerTabId);
    if (player === undefined || player.sourceTabId === null) return;
    player.follow = enabled;
    const info = this.#media.get(playerTabId);
    if (info !== undefined) {
      info.followText = this.#followTextState(playerTabId);
      this.#emitMedia();
    }
    if (!enabled) {
      this.#sendFollow(player.sourceTabId, { type: "stop" });
      return;
    }
    await this.selectTab(player.sourceTabId);
    this.#sendFollowScript(playerTabId);
  }

  /** The whole script — text and measured pieces — with where the player is now. */
  #sendFollowScript(playerTabId: string): void {
    const player = this.#readAloudPlayers.get(playerTabId);
    if (player === undefined || !player.follow || player.sourceTabId === null) return;
    const clip = this.#readAloud.clip(player.clipId);
    if (clip === null) return;
    const info = this.#media.get(playerTabId);
    this.#sendFollow(player.sourceTabId, {
      type: "script",
      script: {
        clipId: clip.id,
        text: clip.request.text,
        pieces: clip.pieces.map(({ charStart, charEnd, seconds }) => ({ charStart, charEnd, seconds })),
        done: clip.done,
      },
      sync: info === undefined ? null : followSync(info),
    });
  }

  /** Where the player is, for the page to project between reports. */
  #syncFollow(playerTabId: string, info: BrowserMediaInfo): void {
    const player = this.#readAloudPlayers.get(playerTabId);
    if (player === undefined || !player.follow || player.sourceTabId === null) return;
    this.#sendFollow(player.sourceTabId, { type: "sync", clipId: player.clipId, sync: followSync(info) });
  }

  #sendFollow(sourceTabId: string, message: ReadAloudFollowMessage): void {
    const tab = this.#tabs.get(sourceTabId);
    if (tab === undefined || tab.view.webContents.isDestroyed()) return;
    tab.view.webContents.send(IPC.readAloudFollow, message);
  }

  /** Another piece was measured: the following page gets the longer script. */
  #readAloudProgress(clip: ReadAloudClip): void {
    for (const [playerTabId, player] of this.#readAloudPlayers) {
      if (player.clipId === clip.id && player.follow) this.#sendFollowScript(playerTabId);
    }
  }

  /** A source page has a new document (a navigation, a wake): light it again if it has the words. */
  #resumeFollow(sourceTabId: string): void {
    for (const [playerTabId, player] of this.#readAloudPlayers) {
      if (player.sourceTabId === sourceTabId && player.follow) this.#sendFollowScript(playerTabId);
    }
  }

  /**
   * A tab left: a player's clip stops being spoken and its page stops
   * following; a source page that closed leaves its card without the
   * follow control. A source page that was suspended or moved keeps its
   * place — it comes back with a new document, and `#resumeFollow` lights
   * that one.
   */
  #readAloudTabGone(tabId: string, how: "closed" | "suspended"): void {
    const player = this.#readAloudPlayers.get(tabId);
    if (player !== undefined) {
      this.#readAloudPlayers.delete(tabId);
      this.#readAloud.abandon(player.clipId);
      if (player.follow && player.sourceTabId !== null) this.#sendFollow(player.sourceTabId, { type: "stop" });
    }
    if (how !== "closed") return;
    let changed = false;
    for (const [playerTabId, other] of this.#readAloudPlayers) {
      if (other.sourceTabId !== tabId) continue;
      other.sourceTabId = null;
      other.follow = false;
      const info = this.#media.get(playerTabId);
      if (info !== undefined && info.followText !== null) {
        info.followText = null;
        changed = true;
      }
    }
    if (changed) this.#emitMedia();
  }

  /* ---- Reader view ------------------------------------------------- */

  /**
   * Show the tab's article stripped to its prose, or return to the page it
   * was read from when the tab is already showing one. The tab navigates in
   * place, so Back leaves reader view the way it leaves any other page.
   *
   * Returns false when the page has no article to show — reader view is
   * offered, never forced.
   */
  async toggleReaderView(tabId: string): Promise<boolean> {
    const tab = this.#requireTab(tabId);
    const current = this.#readerEntryForUrl(tab.info.url);
    if (current !== null) {
      await tab.view.webContents.loadURL(current.article.url);
      return true;
    }
    const article = await extractReaderArticle(tab.view.webContents);
    if (article === null) return false;
    // The same piece opened twice keeps one address rather than leaking entries.
    const existing = this.#reader.findByUrl(article.url);
    const { url } = existing === null ? this.#reader.open(article, tabId) : { url: readerUrl(existing.id) };
    await tab.view.webContents.loadURL(url);
    return true;
  }

  /** Whether this tab is currently showing a reader page. */
  isReaderView(tabId: string): boolean {
    const info = this.#tabInfo(tabId);
    return info !== null && this.#readerEntryForUrl(info.url) !== null;
  }

  #readerEntryForUrl(url: string): { id: string; article: ReaderArticle } | null {
    const match = /^pistachio:\/\/reader\/([0-9a-f]{32})$/u.exec(url);
    if (match === null) return null;
    const entry = this.#reader.entry(match[1] ?? "");
    return entry === null ? null : { id: entry.id, article: entry.article };
  }

  /**
   * What the reader page's toolbar can do. Each one runs where the app's
   * policy already applies — the copy verdict for the clipboard, the download
   * verdict for the save dialog — rather than in the page.
   */
  #readerActions(): ReaderActions {
    const tabForArticle = (article: ReaderArticle): ManagedTab | null => {
      for (const tab of this.#tabs.values()) {
        if (tab.info.url === article.url || this.#readerEntryForUrl(tab.info.url)?.article.url === article.url) {
          return tab;
        }
      }
      return null;
    };
    return {
      speak: async (article) => {
        // The reader page asking to be spoken IS a tab; without one there is
        // no Space to open the player in.
        const info = tabForArticle(article)?.info ?? this.activeTab();
        if (info === null) throw new Error("There is no tab to play this in.");
        await this.readAloud(
          readerSpeechText(article),
          { ...info, title: article.title, url: article.url },
          { maxChars: READ_ALOUD_MAX_ARTICLE_CHARS },
        );
      },
      copy: async (article, markdown) => {
        const tab = tabForArticle(article);
        if (tab !== null) {
          const verdict = this.#actionVerdict(tab, "copy");
          this.#recordPolicy(tab, "copy", verdict.decision, verdict.source, verdict.reason);
          if (verdict.decision === "block") throw new Error("Copying is blocked here.");
        }
        clipboard.writeText(markdown);
        await Promise.resolve();
      },
      save: async (article, markdown) => {
        const tab = tabForArticle(article);
        if (tab !== null) {
          const verdict = this.#actionVerdict(tab, "download");
          this.#recordPolicy(tab, "download", verdict.decision, verdict.source, verdict.reason);
          if (verdict.decision === "block") throw new Error("Saving is blocked here.");
        }
        const { canceled, filePath } = await dialog.showSaveDialog(this.#window, {
          defaultPath: `${pageFileName(article.title, article.url)}.md`,
          filters: [
            { name: "Markdown", extensions: ["md", "markdown"] },
            { name: "All Files", extensions: ["*"] },
          ],
        });
        if (canceled || filePath === "") return false;
        await writeFile(filePath, markdown, "utf8");
        return true;
      },
      chat: async (article) => {
        const insert = selectionInsert(readerSpeechText(article), {
          title: article.title,
          url: article.url,
        });
        if (insert === null) throw new Error("There was nothing to send.");
        this.#window.webContents.send(IPC.shellCommand, { type: "attachToChat", insert });
        await Promise.resolve();
      },
      bookmark: async (article) => {
        await this.#bookmarkArticle(article.url, article.title);
      },
    };
  }

  /** The page a tab shows when nothing chose one: Settings → General → Home page. */
  #homeUrl(): string {
    return this.#settings().general.homeUrl;
  }

  async createTab(
    url = this.#homeUrl(),
    options: {
      anchorId?: string | null;
      activate?: boolean;
      spaceId?: string;
      unlisted?: boolean;
    } = {},
  ): Promise<string> {
    const spaceId = options.spaceId ?? this.activeSpaceId();
    if (this.#spaceStore.get(spaceId) === null)
      throw new Error("unknown Space");
    return this.#createManagedTab({
      url,
      kind: "human",
      runId: null,
      activate: options.activate ?? true,
      anchorId: options.anchorId ?? null,
      spaceId,
      unlisted: options.unlisted ?? false,
    });
  }

  /**
   * Open a second human tab on the same page, placed beside the original in
   * the tab order, with a copy of the original's back/forward stack and the
   * page state Chromium last committed for it (scroll position, form
   * values) so it can be browsed on as a branch. The copy is its own tab —
   * no anchor, and its stack diverges from here — so closing either leaves
   * the other untouched.
   */
  async duplicateTab(tabId: string, activate = true): Promise<string> {
    const info = this.#tabInfo(tabId);
    if (info === null) throw new Error("unknown tab");
    if (info.kind !== "human")
      throw new Error("only a person's tabs can be duplicated");
    const source = this.#tabs.get(tabId);
    const history =
      source !== undefined
        ? (captureTabHistory(source.view.webContents, true) ?? source.history)
        : (this.#dormantTabs.get(tabId)?.history ?? null);
    const duplicateId = await this.#createManagedTab({
      url: info.url,
      kind: "human",
      runId: null,
      activate,
      spaceId: info.spaceId,
      history,
    });
    // reorderTab counts the position with the moved tab lifted out, so the
    // slot right after the original is its index plus one.
    const siblings = this.#spaceTabIds(info.spaceId).filter(
      (id) => id !== duplicateId,
    );
    const originalIndex = siblings.indexOf(tabId);
    if (originalIndex >= 0) this.reorderTab(duplicateId, originalIndex + 1);
    this.#onChange();
    return duplicateId;
  }

  async createAgentTab(
    url: string,
    runId: string,
    prepareSession: (target: Session) => Promise<void>,
    guard: AgentNetworkGuard,
  ): Promise<string> {
    const primaryTabId = this.#activeTabId;
    const spaceId =
      primaryTabId === null
        ? this.activeSpaceId()
        : (this.#tabs.get(primaryTabId)?.info.spaceId ?? this.activeSpaceId());
    const tabId = await this.#createManagedTab({
      url,
      kind: "agent",
      runId,
      spaceId,
      activate: false,
      partition: `pistachio-agent-${runId}`,
      prepareSession,
      guard,
    });
    if (primaryTabId !== null && primaryTabId !== tabId) {
      const group = this.#splitGroupFor(primaryTabId);
      if (group !== undefined && group.tabIds.length < MAX_SPLIT_PANES) {
        this.#formSplit(
          [...group.tabIds, tabId],
          group.mode,
          primaryTabId,
          group.id,
          group.gridLayout,
        );
      } else {
        this.#formSplit([primaryTabId, tabId], "vertical");
      }
    }
    this.#onChange();
    return tabId;
  }

  async #createManagedTab(options: {
    url: string;
    kind: BrowserTabInfo["kind"];
    runId: string | null;
    spaceId: string;
    activate: boolean;
    anchorId?: string | null;
    partition?: string;
    prepareSession?: (target: Session) => Promise<void>;
    guard?: AgentNetworkGuard;
    restoredInfo?: BrowserTabInfo;
    unlisted?: boolean;
    /**
     * The back/forward stack the page continues — a woken, restored,
     * duplicated, or reopened tab's — shown at its current entry instead of
     * a plain load of `url`.
     */
    history?: TabHistory | null;
    /**
     * Resolve once the view exists rather than once its page has loaded.
     * Only a restored tab may opt out: its failure is absorbed into the
     * saved title either way, while a fresh tab's failure must reach the
     * caller, which needs the awaited load to happen.
     */
    awaitLoad?: boolean;
  }): Promise<string> {
    const id = options.restoredInfo?.id ?? randomUUID();
    const partition = options.partition ?? spacePartition(options.spaceId);
    const targetSession = session.fromPartition(partition);
    this.#configureSession(targetSession, options.kind, options.spaceId, partition);
    if (options.kind === "agent") {
      if (options.guard === undefined)
        throw new Error("agent tabs require a network guard");
      this.#installAgentEnforcement(targetSession, options.guard);
    }
    await options.prepareSession?.(targetSession);
    // Proxy rules before the first view: nothing leaves the session direct
    // that the Space's policy says must not (§10.3).
    await this.#hooks.prepareSpaceSession?.(
      targetSession,
      options.spaceId,
      options.kind,
      partition,
    );
    const view = new WebContentsView({
      webPreferences: {
        partition,
        ...(options.kind === "human" && this.#tabPreload !== ""
          ? { preload: this.#tabPreload }
          : {}),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        ...(options.kind === "agent"
          ? { disableBlinkFeatures: "WebAuth" }
          : {}),
      },
    });
    const appearance = this.#settings().appearance;
    const dark =
      appearance.scheme === "dark" ||
      (appearance.scheme === "system" && nativeTheme.shouldUseDarkColors);
    view.setBackgroundColor(dark ? "#202225" : "#f8f8f3");
    // The renderer draws each pane as a rounded card (App.tsx `rounded-md`,
    // --radius-md). The native view sits on top of that card with the same
    // bounds, so it must be clipped to the same radius or its square corners
    // paint over the card's rounded border.
    view.setBorderRadius(appearance.radius);
    view.setVisible(false);
    this.#window.contentView.addChildView(view);
    this.#onViewAdded();

    const info: BrowserTabInfo =
      options.restoredInfo === undefined
        ? {
            id,
            spaceId: options.spaceId,
            title: options.kind === "agent" ? "Delegated session" : "New tab",
            url: normalizeNavigation(options.url, this.#settings().search.webProvider),
            faviconUrl: null,
            loading: true,
            canGoBack: false,
            canGoForward: false,
            kind: options.kind,
            runId: options.runId,
            anchorId: options.anchorId ?? null,
            lifecycle: "live",
            lastActiveAt: Date.now(),
            unlisted: options.unlisted ?? false,
          }
        : {
            ...options.restoredInfo,
            loading: true,
            canGoBack: false,
            canGoForward: false,
            lifecycle: "live",
          };
    const tab: ManagedTab = {
      info,
      view,
      enforcer: options.guard?.enforcer ?? null,
      partition,
      // The stack the page starts with stands in until its first navigation
      // reports the real one; page state stays with the restore call.
      history:
        options.history === undefined || options.history === null
          ? null
          : { entries: options.history.entries.map(({ url, title }) => ({ url, title })), index: options.history.index },
      pendingLoad: null,
      shellTitle: null,
    };
    this.#dormantTabs.delete(id);
    this.#tabs.set(id, tab);
    if (options.restoredInfo !== undefined) this.#beginWake(id);
    if (!this.#tabOrder.includes(id)) this.#tabOrder.push(id);
    if (options.activate || this.#activeTabId === null) this.#activateTab(id);
    const refresh = this.#wireManagedTab(tab);
    // A tab waking from suspension takes its forced focus back up.
    if (info.forcedFocus === true) void this.#applyForcedFocus(tab).catch(() => undefined);
    const restored = options.restoredInfo;
    if (
      (restored !== undefined && options.awaitLoad === false) ||
      this.#gate.isHydrating(info.spaceId)
    ) {
      // The view exists and is laid out at once; the page fills in when it
      // arrives — after the Space's jar is settled, if it is being hydrated
      // right now. Neither the window nor the caller waits on it.
      const fallbackTitle = restored?.title ?? info.title;
      tab.pendingLoad = new Promise<void>((resolve) => {
        this.#gate.run(info.spaceId, () => {
          if (view.webContents.isDestroyed()) {
            resolve();
            return;
          }
          void loadTabHistory(view.webContents, options.history ?? null, info.url)
            .catch(() => {
              info.loading = false;
              info.title = fallbackTitle;
            })
            .then(refresh)
            .finally(resolve);
        });
      });
      return id;
    }
    try {
      await loadTabHistory(view.webContents, options.history ?? null, info.url);
    } catch (error) {
      if (restored === undefined) {
        // A load the network refused shows as the tab's error page
        // (did-fail-load → #showNavigationError): the tab is whole, and a
        // fresh tab, a duplicate, a reopened tab all count as opened.
        // Anything else is still the caller's to hear about.
        if (info.kind !== "human" || !isLoadFailure(error)) throw error;
      } else {
        info.loading = false;
        info.title = restored.title;
      }
    }
    refresh();
    return id;
  }

  /**
   * Wire a human/agent page once. The same ManagedTab may begin life as a
   * Glance and later join #tabs, so every callback discovers where it lives
   * when it publishes instead of closing over an ephemeral mode.
   */
  #wireManagedTab(tab: ManagedTab): () => void {
    const { info, view } = tab;
    if (info.kind === "human") this.#hooks.onArchiveTab?.(info.id, view.webContents);
    const publish = (): void => this.#publishManagedTab(tab);
    const refresh = (): void => {
      if (view.webContents.isDestroyed()) return;
      const wasShellPage = shellPageOf(info.url);
      info.url = view.webContents.getURL() || info.url;
      info.loading = view.webContents.isLoading();
      info.canGoBack = view.webContents.navigationHistory.canGoBack();
      info.canGoForward = view.webContents.navigationHistory.canGoForward();
      tab.history = captureTabHistory(view.webContents, false);
      this.#sendTabDataPolicy(tab);
      if (info.id === this.#activeTabId) this.#emitBrowserControls();
      publish();
      // Arriving at a shell-drawn page — the home page, the daily brief —
      // (Back, a link) or leaving one changes who draws the pane — the shell
      // or this view — and the renderer only re-reports geometry when the
      // panes themselves change.
      if (shellPageOf(info.url) !== wasShellPage && this.#tabs.get(info.id) === tab) this.#applyLayout();
    };
    view.webContents.on("did-start-loading", refresh);
    view.webContents.on("did-stop-loading", refresh);
    view.webContents.on("did-navigate", refresh);
    view.webContents.on("did-navigate-in-page", refresh);
    // Preloads are ready at dom-ready. Send the anchor-dependent behavior
    // before a slow image or subresource can hold did-finish-load open.
    view.webContents.on("dom-ready", () => {
      const resume = this.#pageResume.get(info.id);
      if (resume?.url === view.webContents.getURL()) view.webContents.send("pistachio:restore-page-resume", resume);
      void this.#revealWoken(tab);
      this.#sendGlanceConfiguration(tab);
      // Injected CSS does not outlive a document. Forget the key rather than
      // try to lift it off a page that no longer exists, and light this one.
      this.#glow.delete(info.id);
      this.#syncAgentGlow();
      this.#resumeFollow(info.id);
      // The debugger session holding forced focus survives navigations but
      // not a renderer that died under it.
      if (info.forcedFocus === true && !focusEmulationAttached(view.webContents)) {
        void this.#applyForcedFocus(tab).catch(() => undefined);
      }
    });
    view.webContents.on("did-finish-load", () => this.#sendTabDataPolicy(tab));
    // A load that failed has Chromium's error page to show; a wake must not
    // hold the placeholder over it. An ABORTED load is not that: the page
    // itself moved on (a script redirect), and the document it went to will
    // have its own dom-ready.
    view.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || this.#tabs.get(info.id) !== tab) return;
      this.#endWake(info.id);
      this.#showNavigationError(tab, { url, code, description });
    });
    // A dead renderer leaves nothing behind that can clean up after itself:
    // its fullscreen page can no longer exit (and would strand the window in
    // native fullscreen), its injected stylesheet went with the process, and
    // its media is not playing any more. The view stays — Electron reloads it
    // — so this is the same teardown a navigation does, without the tab going.
    view.webContents.on("render-process-gone", () => {
      if (this.#tabs.get(info.id) !== tab) return;
      this.#endWake(info.id);
      this.#releaseFullscreen(info.id);
      this.#glow.delete(info.id);
      this.#removeMedia(info.id);
      this.#cancelPermissionsForTab(info.id);
      this.#cancelPasskeysForTab(info.id);
      this.#passkeySupport.delete(info.id);
      this.#capturingTabs.delete(info.id);
    });
    view.webContents.on("did-start-navigation", (details) => {
      if (
        details.isMainFrame &&
        !details.isSameDocument &&
        this.#tabs.get(info.id) === tab
      ) {
        this.#removeMedia(info.id);
        this.#cancelPermissionsForTab(info.id);
        this.#cancelPasskeysForTab(info.id);
        this.#passkeySupport.delete(info.id);
        this.#capturingTabs.delete(info.id);
        // The document the find session was scoped to is going away.
        if (this.#findSession?.tabId === info.id) this.#findSession = null;
        if (this.#smartFind?.tabId === info.id) {
          this.#endSmartFind();
          if (this.#findState.mode === "smart") {
            this.#findState = { ...this.#findState, activeMatchOrdinal: 0, matches: 0, smart: IDLE_SMART_FIND };
            this.#emitFind();
          }
        }
      }
    });
    view.webContents.on("page-title-updated", (_event, title) => {
      // A shell page's placeholder never outranks the name the shell gave it.
      const named = tab.shellTitle;
      info.title =
        named !== null && named.url === info.url
          ? named.title
          : title || (info.kind === "agent" ? "Delegated session" : "Untitled");
      // The stack was read before the page had its title; the entry being
      // shown is the one this title belongs to.
      const shown = tab.history?.entries[tab.history.index];
      if (shown !== undefined && shown.url === info.url) shown.title = info.title;
      this.#refreshMediaTab(tab);
      publish();
    });
    view.webContents.on("page-favicon-updated", (_event, favicons) => {
      info.faviconUrl = favicons[0] ?? null;
      this.#refreshMediaTab(tab);
      publish();
    });
    view.webContents.on("audio-state-changed", (event) => {
      const media = this.#media.get(info.id);
      if (media === undefined) return;
      const wasWatched = watchedVideo(media);
      media.audible = event.audible;
      media.muted = view.webContents.isAudioMuted() || media.elementMuted;
      // Unmuted from its tab row: the video is being listened to again.
      if (watchedVideo(media) && !wasWatched) this.#yieldBackgroundVideos(info.id);
      this.#emitMedia();
      if (info.id === this.#activeTabId) this.#emitBrowserControls();
    });
    view.webContents.on("found-in-page", (_event, result) => {
      if (
        info.id !== this.#activeTabId ||
        result.requestId !== this.#findRequestId
      )
        return;
      this.#findState = {
        ...this.#findState,
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
      };
      this.#emitFind();
    });
    view.webContents.on("before-input-event", (event, input) =>
      this.#handleTabShortcut(tab, event, input),
    );
    this.#installWindowOpenHandler(tab, view.webContents);
    view.webContents.on("will-navigate", (event, url) => {
      const allowed =
        info.kind === "agent"
          ? tab.enforcer?.isNavigationAllowed(url) === true
          : isAllowedNavigation(url);
      if (allowed) return;
      event.preventDefault();
      // A link meant for another app (a meeting page's `zoommtg:`). The tab
      // never goes there; the link is offered to the system instead. Done
      // here rather than left to Chromium because a navigation that starts
      // cancels the tab's pending prompts — this one included.
      this.#offerExternalApp(tab, url);
    });
    view.webContents.on("context-menu", (_event, params) => {
      if (info.kind !== "human" || this.#tabs.get(info.id) !== tab) return;
      const allows = (action: GuardedBrowserAction): boolean =>
        this.#actionVerdict(tab, action).decision === "allow";
      const template = buildPageContextMenu(
        params,
        {
          canGoBack: info.canGoBack,
          canGoForward: info.canGoForward,
          copyAllowed: allows("copy"),
          pasteAllowed: allows("paste"),
          downloadAllowed: allows("download"),
          printAllowed: allows("print"),
          inReaderView: this.#readerEntryForUrl(info.url) !== null,
          platform: process.platform === "darwin" ? "darwin" : "other",
          shortcuts: this.#settings().shortcuts,
          searchProvider: this.#settings().search.webProvider,
        },
        {
          back: () => void this.goBack(info.id),
          forward: () => void this.goForward(info.id),
          reload: () => void this.reload(info.id),
          openInNewTab: (url) =>
            void this.createTab(url, { spaceId: info.spaceId }),
          openInGlance: (url) =>
            void this.openGlance(view.webContents.id, {
              url,
              source: { x: params.x, y: params.y, width: 1, height: 1 },
              automatic: false,
            }),
          copyText: (text) => clipboard.writeText(text),
          copyImage: () => view.webContents.copyImageAt(params.x, params.y),
          // Goes through the session's will-download hook like any other
          // download, so policy and the downloads shelf both see it.
          save: (url) => view.webContents.downloadURL(url),
          savePage: () => void this.#savePage(tab),
          search: (query) =>
            void this.createTab(searchUrl(query, this.#settings().search.webProvider), { spaceId: info.spaceId }),
          lookUp: () => view.webContents.showDefinitionForSelection(),
          readAloud: (text) => void this.readAloud(text, info),
          readerView: () => void this.toggleReaderView(info.id),
          print: () => void this.browserControl({ type: "print" }),
          inspect: () => view.webContents.inspectElement(params.x, params.y),
          replaceMisspelling: (word) =>
            view.webContents.replaceMisspelling(word),
          addToDictionary: (word) =>
            view.webContents.session.addWordToSpellCheckerDictionary(word),
          showEmojiPanel: () => app.showEmojiPanel(),
          media: (command) =>
            void this.#runContextMediaCommand(view.webContents, params, command),
          addImageToChat: () => void this.#attachImageToChat(tab, params),
          addSelectionToChat: (text) => this.#attachSelectionToChat(tab, text),
        },
      );
      Menu.buildFromTemplate(template).popup({ window: this.#window });
    });
    // A site entering fullscreen from a Glance becomes a regular selected tab:
    // fullscreen is never trapped in the preview.
    view.webContents.on("enter-html-full-screen", () => {
      if (this.#glance?.tab === tab) this.promoteGlance();
      if (!this.#tabs.has(info.id)) return;
      this.#fullscreenTabId = info.id;
      this.#fullscreenTookWindow = !this.#windowFullScreenSettled;
      // The pane card's rounded corners would clip the screen's corners.
      view.setBorderRadius(0);
      this.#applyLayout();
    });
    view.webContents.on("leave-html-full-screen", () => {
      if (this.#fullscreenTabId !== info.id) return;
      this.#fullscreenTabId = null;
      this.#fullscreenExitPending = false;
      view.setBorderRadius(this.#settings().appearance.radius);
      this.#applyLayout();
    });
    return refresh;
  }

  /**
   * "Save Page As…" writes the document and its subresources next to each
   * other, the way Chrome's "Webpage, Complete" does. It never passes through
   * will-download, so the download policy is applied here instead.
   */
  async #savePage(tab: ManagedTab): Promise<void> {
    const verdict = this.#actionVerdict(tab, "download");
    this.#recordPolicy(
      tab,
      "download",
      verdict.decision,
      verdict.source,
      verdict.reason,
    );
    if (verdict.decision === "block") return;
    const { canceled, filePath } = await dialog.showSaveDialog(this.#window, {
      defaultPath: `${pageFileName(tab.info.title, tab.info.url)}.html`,
      filters: [
        { name: "Webpage, Complete", extensions: ["html", "htm"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (canceled || filePath === "") return;
    await tab.view.webContents.savePage(filePath, "HTMLComplete");
  }

  /**
   * Loop / Show Controls / Picture in Picture act on the element the menu
   * was opened over, inside whichever frame holds it. The script runs with a
   * user gesture so Picture in Picture, which requires one, is honored.
   */
  async #runContextMediaCommand(
    contents: WebContents,
    params: ContextMenuParams,
    command: ContextMediaCommand,
  ): Promise<void> {
    const frame = params.frame ?? contents.mainFrame;
    try {
      await frame.executeJavaScript(
        contextMediaScript(params.srcURL, command),
        true,
      );
    } catch {
      // The frame navigated away or refused the script; nothing to apply.
    }
  }

  /**
   * "Add Selection to Chat": the words go straight to the composer, with the
   * page they came from so the message can say so.
   */
  #attachSelectionToChat(tab: ManagedTab, text: string): void {
    const insert = selectionInsert(text, {
      title: tab.info.title,
      url: tab.info.url,
    });
    if (insert === null) return;
    this.#window.webContents.send(IPC.shellCommand, {
      type: "attachToChat",
      insert,
    });
  }

  /**
   * "Add Image to Chat": read the image the menu was opened over and stage
   * it in the composer as if it had been dropped there.
   */
  async #attachImageToChat(
    tab: ManagedTab,
    params: ContextMenuParams,
  ): Promise<void> {
    const result = await this.#chatImageInsert(tab, params);
    if (this.#tabs.get(tab.info.id) !== tab && this.#glance?.tab !== tab)
      return;
    this.#window.webContents.send(
      IPC.shellCommand,
      result.ok
        ? { type: "attachToChat", insert: result.insert }
        : { type: "attachToChatFailed", reason: result.reason },
    );
  }

  /**
   * Three ways to the bytes, in order of fidelity: an inline data: URL is
   * decoded as is; a web address is fetched through the tab's own session,
   * so a picture behind a login comes back exactly as served; and anything
   * else — a format the model cannot take, a blob:, a fetch the site refused
   * — is re-rendered from the page's own `<img>` as a PNG.
   */
  async #chatImageInsert(
    tab: ManagedTab,
    params: ContextMenuParams,
  ): Promise<ChatInsertResult> {
    const src = params.srcURL;
    let attempt: ChatInsertResult | null = null;
    const inline = parseDataUrl(src);
    if (inline !== null) {
      attempt = imageInsertFromBytes(inline.bytes, inline.mediaType, src);
      if (attempt.ok) return attempt;
    } else if (/^https?:/iu.test(src)) {
      try {
        const response = await tab.view.webContents.session.fetch(src, {
          credentials: "include",
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          attempt = imageInsertFromBytes(
            bytes,
            response.headers.get("content-type") ?? "",
            src,
          );
          if (attempt.ok) return attempt;
        }
      } catch {
        // Fall through to the rendered pixels.
      }
    }
    const frame = params.frame ?? tab.view.webContents.mainFrame;
    try {
      const rendered: unknown = await frame.executeJavaScript(
        canvasImageScript(src),
        true,
      );
      const decoded = typeof rendered === "string" ? parseDataUrl(rendered) : null;
      if (decoded !== null) {
        const fromCanvas = imageInsertFromBytes(
          decoded.bytes,
          decoded.mediaType,
          src,
        );
        if (fromCanvas.ok) return fromCanvas;
        attempt ??= fromCanvas;
      }
    } catch {
      // The frame navigated away or refused the script.
    }
    return attempt ?? { ok: false, reason: "Couldn't read that image" };
  }

  /**
   * Keep OAuth in a real Chromium child context. Replacing window.open with an
   * unrelated tab severs window.opener/postMessage, which Google sign-in flows
   * on sites such as X rely on to deliver their authorization result.
   */
  #installWindowOpenHandler(tab: ManagedTab, contents: WebContents): void {
    contents.setWindowOpenHandler((details: HandlerDetails) => {
      if (tab.info.kind === "agent") return { action: "deny" };
      const preservePopup = shouldPreserveAuthenticationPopup(details);
      const safeUrl =
        isAllowedNavigation(details.url) ||
        (preservePopup && details.url === "about:blank");
      if (!safeUrl) {
        // `window.open("zoommtg://…")`: no window, but maybe an app.
        this.#offerExternalApp(tab, details.url);
        return { action: "deny" };
      }
      if (preservePopup) {
        return {
          action: "allow",
          overrideBrowserWindowOptions: this.#authenticationPopupOptions(tab),
          createWindow: (options) => {
            const popup = createAuthenticationPopupWindow(options, {
              dark: this.#popupIsDark(),
              onSelectPasskey: (requestId, accountId) =>
                this.#resolvePasskey(requestId, accountId),
              onOpenInMainApp: (url) => {
                if (
                  url !== "" &&
                  url !== "about:blank" &&
                  isAllowedNavigation(url)
                )
                  void this.createTab(url, { spaceId: tab.info.spaceId });
                if (!popup.window.isDestroyed()) popup.window.close();
              },
            });
            this.#configureAuthenticationPopup(tab, popup);
            return popup.page;
          },
        };
      }
      // A Glance sits above every tab, so a tab opened from inside it would
      // land behind the preview, unseen. A `target="_blank"` link or a
      // window.open follows in place instead; only an explicit background
      // open (a modifier or middle click) still asks for a tab.
      if (
        this.#glance?.tab === tab &&
        details.disposition !== "background-tab"
      ) {
        void contents
          .loadURL(
            details.url,
            details.referrer.url === ""
              ? {}
              : { httpReferrer: details.referrer },
          )
          .catch(() => {
            // Superseded or failed: the page's own load events report it.
          });
        return { action: "deny" };
      }
      // The person modifier-clicked a control that navigates from script;
      // honor that window.open the way an anchor click would, as a Glance.
      // Authentication popups were already preserved above, where they keep
      // their real child-window relationship.
      const intentSource = this.#takeGlanceIntent(contents.id);
      if (intentSource !== null && this.#glance === null) {
        void this.openGlance(contents.id, {
          url: details.url,
          source: intentSource,
          automatic: false,
        });
        return { action: "deny" };
      }
      void this.createTab(details.url, { spaceId: tab.info.spaceId });
      return { action: "deny" };
    });
  }

  /**
   * A trusted modifier click on a JS-navigating control in a tab page. There
   * is no URL until the page reacts, so the click is only remembered; the
   * window-open that follows within the TTL consumes it.
   */
  recordGlanceIntent(senderId: number, source: ContentBounds): void {
    const tab = this.#tabForWebContents(senderId);
    if (tab === undefined || tab.info.kind !== "human") return;
    this.#glanceIntent = { webContentsId: senderId, source, at: Date.now() };
  }

  #takeGlanceIntent(webContentsId: number): ContentBounds | null {
    const intent = this.#glanceIntent;
    if (intent === null) return null;
    if (Date.now() - intent.at > GLANCE_INTENT_TTL_MS) {
      this.#glanceIntent = null;
      return null;
    }
    if (intent.webContentsId !== webContentsId) return null;
    this.#glanceIntent = null;
    return intent.source;
  }

  #authenticationPopupOptions(
    tab: ManagedTab,
  ): BrowserWindowConstructorOptions {
    const dark = this.#popupIsDark();
    return {
      parent: this.#window,
      autoHideMenuBar: true,
      minWidth: 360,
      minHeight: 480,
      backgroundColor: dark ? "#202225" : "#f8f8f3",
      webPreferences: {
        partition: tab.partition,
        ...(this.#tabPreload === "" ? {} : { preload: this.#tabPreload }),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
      },
    };
  }

  #popupIsDark(): boolean {
    const appearance = this.#settings().appearance;
    return (
      appearance.scheme === "dark" ||
      (appearance.scheme === "system" && nativeTheme.shouldUseDarkColors)
    );
  }

  #configureAuthenticationPopup(
    owner: ManagedTab,
    authenticationPopup: AuthenticationPopupWindow,
  ): void {
    const { window: popup, page } = authenticationPopup;
    this.#authenticationPopups.set(page.id, { owner, popup: authenticationPopup });
    page.once("destroyed", () => this.#authenticationPopups.delete(page.id));
    const ownerUrl = owner.info.url;
    const beforeCookies = this.#cookieFingerprint(owner, ownerUrl);
    const ownerHostname = this.#hostname(ownerUrl);
    const ownerContents = owner.view.webContents;
    const cookies = ownerContents.session.cookies;
    const watch: AuthenticationOwnerWatch = {
      returnedToOwnerOrigin: false,
      lastCookieChangeAt: null,
      serverCookieChanged: false,
      ownerNavigated: false,
    };
    const onCookieChanged = (_event: ElectronEvent, cookie: Cookie): void => {
      if (
        ownerHostname === null ||
        !cookieDomainMatchesHostname(cookie.domain, ownerHostname)
      )
        return;
      watch.lastCookieChangeAt = Date.now();
      // Script cannot write an HttpOnly cookie: this one came from a server
      // response, the shape of a session being established or torn down.
      if (cookie.httpOnly) watch.serverCookieChanged = true;
    };
    cookies.on("changed", onCookieChanged);
    // The page moving itself — a script redirect once its credential exchange
    // returns, or an opener reload from the callback page — is the site
    // finishing sign-in on its own. A browser reload issued into that
    // navigation cancels it and strands the stale sign-in document.
    const onOwnerNavigation = (
      details: ElectronEvent<WebContentsDidStartNavigationEventParams>,
    ): void => {
      if (details.isMainFrame && !details.isSameDocument)
        watch.ownerNavigated = true;
    };
    ownerContents.on("did-start-navigation", onOwnerNavigation);
    let leftOwnerOrigin = false;
    popup.setMenuBarVisibility(false);
    this.#installWindowOpenHandler(owner, page);
    page.on("will-navigate", (event, url) => {
      if (url !== "about:blank" && !isAllowedNavigation(url))
        event.preventDefault();
    });
    page.on("did-navigate", (_event, url) => {
      if (url === "about:blank") return;
      if (browserOrigin(url) === browserOrigin(ownerUrl)) {
        if (leftOwnerOrigin) watch.returnedToOwnerOrigin = true;
      } else {
        leftOwnerOrigin = true;
      }
    });
    popup.once("closed", () => {
      void this.#refreshOwnerAfterAuthentication(
        owner,
        ownerUrl,
        beforeCookies,
        watch,
      ).finally(() => {
        cookies.off("changed", onCookieChanged);
        if (!ownerContents.isDestroyed())
          ownerContents.off("did-start-navigation", onOwnerNavigation);
      });
    });
  }

  #hostname(value: string): string | null {
    try {
      return new URL(value).hostname.toLowerCase() || null;
    } catch {
      return null;
    }
  }

  async #cookieFingerprint(
    tab: ManagedTab,
    url: string,
  ): Promise<string | null> {
    try {
      const cookies = await tab.view.webContents.session.cookies.get({ url });
      return cookies
        .map(
          (cookie) =>
            `${cookie.name}\u0000${cookie.domain ?? ""}\u0000${cookie.path ?? "/"}\u0000${cookie.value}`,
        )
        .sort()
        .join("\u0001");
    } catch {
      return null;
    }
  }

  /**
   * Reload the relying-party page once its authentication popup has closed
   * and the session it shares with that popup looks different — unless the
   * page is handling the transition itself, in which case the reload would
   * only race (and cancel) the page's own navigation. The timing lives in
   * `authenticationRefreshPlan`; this loop feeds it the live signals.
   */
  async #refreshOwnerAfterAuthentication(
    owner: ManagedTab,
    ownerUrl: string,
    beforeCookies: Promise<string | null>,
    watch: AuthenticationOwnerWatch,
  ): Promise<void> {
    const closedAt = Date.now();
    const before = await beforeCookies;
    for (;;) {
      const contents = owner.view.webContents;
      if (this.#tabs.get(owner.info.id) !== owner || contents.isDestroyed())
        return;
      const plan = authenticationRefreshPlan({
        closedAt,
        now: Date.now(),
        returnedToOwnerOrigin: watch.returnedToOwnerOrigin,
        lastCookieChangeAt: watch.lastCookieChangeAt,
        serverCookieChanged: watch.serverCookieChanged,
        ownerNavigated: watch.ownerNavigated || contents.isLoading(),
      });
      if (plan.action === "wait") {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(
            resolve,
            Math.max(0, plan.until - Date.now()),
          );
          timer.unref();
        });
        continue;
      }
      if (plan.action === "skip") return;
      if (browserOrigin(owner.info.url) !== browserOrigin(ownerUrl)) return;
      if (plan.action === "compare") {
        const after = await this.#cookieFingerprint(owner, ownerUrl);
        if (before === null || after === null || after === before) return;
        // The fingerprint took a moment; the page may have moved meanwhile.
        if (watch.ownerNavigated || contents.isDestroyed()) return;
      }
      contents.reload();
      return;
    }
  }

  #publishManagedTab(tab: ManagedTab): void {
    if (this.#glance?.tab === tab) {
      this.#emitGlance();
      return;
    }
    if (this.#tabs.get(tab.info.id) === tab) this.#onChange();
  }

  #emitGlance(): void {
    this.#onGlanceChange(this.glance());
  }

  #mediaInfo(
    tab: ManagedTab,
    report: TabMediaReport,
    previous?: BrowserMediaInfo,
  ): BrowserMediaInfo {
    const now = Date.now();
    return {
      ...report,
      tabId: tab.info.id,
      tabTitle: tab.info.title,
      tabUrl: tab.info.url,
      faviconUrl: tab.info.faviconUrl,
      muted: tab.view.webContents.isAudioMuted() || report.elementMuted,
      audible: tab.view.webContents.isCurrentlyAudible(),
      updatedAt: now,
      lastActiveAt:
        previous === undefined || (report.playing && !previous.playing)
          ? now
          : previous.lastActiveAt,
      followText: this.#followTextState(tab.info.id),
      call: report.stream && this.#capturingTabs.has(tab.info.id),
    };
  }

  /** A capture grant turns the tab's live stream, already shown or not, into a call. */
  #grantCapture(tab: ManagedTab, permissions: readonly BrowserPermission[]): void {
    if (!permissions.some((permission) => CAPTURE_PERMISSIONS.has(permission))) return;
    const tabId = tab.info.id;
    this.#capturingTabs.add(tabId);
    const media = this.#media.get(tabId);
    if (media === undefined || media.call || !media.stream) return;
    this.#media.set(tabId, { ...media, call: true });
    this.#emitMedia();
  }

  #refreshMediaTab(tab: ManagedTab): void {
    const media = this.#media.get(tab.info.id);
    if (media === undefined) return;
    media.tabTitle = tab.info.title;
    media.tabUrl = tab.info.url;
    media.faviconUrl = tab.info.faviconUrl;
    this.#emitMedia();
  }

  #emitMedia(): void {
    this.#onMediaChange(this.media());
  }

  #clearPendingMedia(tabId: string): void {
    this.#pendingMedia.delete(tabId);
    const timer = this.#mediaRevealTimers.get(tabId);
    if (timer !== undefined) clearTimeout(timer);
    this.#mediaRevealTimers.delete(tabId);
  }

  #removeMedia(tabId: string): void {
    this.#clearPendingMedia(tabId);
    this.#suppressedMedia.delete(tabId);
    if (this.#mediaPreview?.tabId === tabId) this.setMediaPreview(null);
    if (this.#media.delete(tabId)) this.#emitMedia();
  }

  #configureSession(
    target: Session,
    kind: BrowserTabInfo["kind"],
    spaceId: string,
    partition: string,
  ): void {
    if (this.#configuredSessions.has(target)) return;
    this.#configuredSessions.add(target);
    // Reported once the configuration below has run: the hook may attach
    // its own listeners and never sees a half-configured session.
    queueMicrotask(() => this.#hooks.onSessionCreated?.(target, spaceId, partition, kind));
    // A persisted session outlives the controller: the window closes, the
    // controller goes with it, and the next window's controller meets the
    // same session already carrying the last one's handler — which Electron
    // refuses to layer a second over. The old handler closes over a dead
    // controller, so it is replaced, not kept.
    if (target.protocol.isProtocolHandled("pistachio")) target.protocol.unhandle("pistachio");
    target.protocol.handle("pistachio", (request) => {
      const url = new URL(request.url);
      const archived = kind === "human" ? this.#hooks.archiveResponse?.(url, spaceId) : null;
      if (archived) return archived;
      const spoken = this.#readAloud.respond(url, request.headers);
      if (spoken !== null) return spoken;
      const read = this.#reader.respond(url, request);
      if (read !== null) return read;
      const welcome = welcomePageResponse(url);
      if (welcome !== null) return welcome;
      // The home page and the daily brief are drawn by the shell over this
      // tab's hidden view (#applyLayout); the document only names the tab and
      // gives it an icon.
      const placeholder = shellPagePlaceholderHtml(url.href);
      if (placeholder !== null) {
        return new Response(placeholder, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
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
      if (url.host === "demo" && url.pathname === "/media/test.wav") {
        return new Response(new Blob([demoToneWav()], { type: "audio/wav" }), {
          status: 200,
          headers: {
            "content-type": "audio/wav",
            "cache-control": "public, max-age=3600",
          },
        });
      }
      if (
        url.host === "demo" &&
        url.pathname === "/api/invoices/NS-2048/reconciliation/submit" &&
        request.method === "POST"
      ) {
        return Response.json({
          ok: true,
          submittedAt: new Date().toISOString(),
        });
      }
      return new Response("Not found", { status: 404 });
    });
    if (kind === "agent") {
      target.on("select-webauthn-account", (_event, _details, callback) =>
        callback(null),
      );
      target.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      target.setPermissionCheckHandler(() => false);
      return;
    }
    target.on("select-webauthn-account", (_event, details, callback) => {
      const frame = details.frame;
      const contents =
        frame === null || frame.detached
          ? undefined
          : electronWebContents.fromFrame(frame);
      const authentication =
        contents === undefined
          ? undefined
          : this.#authenticationPopups.get(contents.id);
      const popup = authentication?.popup;
      const tab =
        contents === undefined
          ? undefined
          : authentication?.owner ?? this.#tabForWebContents(contents.id);
      const activeHumanTab =
        tab !== undefined &&
        tab.info.kind === "human" &&
        tab.info.id === this.#activeTabId &&
        this.#tabs.get(tab.info.id) === tab;
      if (
        !activeHumanTab ||
        contents === undefined ||
        frame === null ||
        frame.detached ||
        details.accounts.length === 0 ||
        (popup !== undefined &&
          (popup.window.isDestroyed() || !popup.window.isVisible()))
      ) {
        callback(null);
        return;
      }
      // A newer request from this document replaces any stale account chooser.
      for (const [id, held] of this.#pendingPasskeys) {
        if (held.tabId === tab.info.id && held.popup === popup)
          this.#resolvePasskey(id, null);
      }
      const requestId = randomUUID();
      const origin = browserOrigin(frame.url);
      const credentialIds = new Map<string, string>();
      const accounts = details.accounts.slice(0, 25).map((account, index) => {
        const id = randomUUID();
        credentialIds.set(id, account.credentialId);
        const name = boundedLabel(account.name, `Account ${index + 1}`);
        return {
          id,
          name,
          displayName: boundedLabel(account.displayName, name),
        };
      });
      const timer = setTimeout(
        () =>
          this.#resolvePasskey(requestId, null, "passkey selection timed out"),
        60_000,
      );
      timer.unref();
      const cancel = (): void =>
        this.#resolvePasskey(requestId, null, "passkey document closed or navigated");
      const onNavigation = (
        event: ElectronEvent<WebContentsDidStartNavigationEventParams>,
      ): void => {
        if (!event.isSameDocument && (event.isMainFrame || event.frame === frame))
          cancel();
      };
      contents.on("did-start-navigation", onNavigation);
      contents.on("destroyed", cancel);
      contents.on("render-process-gone", cancel);
      this.#pendingPasskeys.set(requestId, {
        tabId: tab.info.id,
        origin,
        relyingPartyId: boundedLabel(
          details.relyingPartyId,
          origin,
          253,
        ),
        accounts,
        credentialIds,
        requestedAt: Date.now(),
        callback,
        timer,
        ...(popup === undefined ? {} : { popup }),
        isCurrent: () =>
          !contents.isDestroyed() &&
          !frame.detached &&
          browserOrigin(frame.url) === origin &&
          this.#tabs.get(tab.info.id) === tab &&
          this.#activeTabId === tab.info.id &&
          (popup === undefined ||
            (!popup.window.isDestroyed() &&
              this.#authenticationPopups.get(contents.id)?.popup === popup)),
        cleanup: () => {
          contents.off("did-start-navigation", onNavigation);
          contents.off("destroyed", cancel);
          contents.off("render-process-gone", cancel);
          popup?.showPasskeyRequest(null);
        },
      });
      popup?.showPasskeyRequest({
        id: requestId,
        tabId: tab.info.id,
        origin,
        relyingPartyId: boundedLabel(details.relyingPartyId, origin, 253),
        accounts,
        requestedAt: Date.now(),
      });
      this.#recordPolicy(
        tab,
        "passkey",
        "ask",
        "user",
        "site requested a passkey account selection",
        origin,
      );
    });
    target.setPermissionRequestHandler(
      (contents, rawPermission, callback, details) => {
        const tab = this.#tabForWebContents(contents.id);
        // Element fullscreen (a video's ⛶ button) is not a privacy
        // permission: Chromium only asks so the embedder can veto it, and
        // Chrome grants it silently. Without this grant Electron drops the
        // request and the page's requestFullscreen() rejects.
        if (rawPermission === "fullscreen") {
          callback(tab !== undefined);
          return;
        }
        // Chromium reached a link it cannot load itself — from a frame, or
        // at the end of a redirect, where will-navigate never saw it — and
        // asks whether to hand it to the system. Granting makes Electron
        // open it, so the answer IS the launch.
        if (rawPermission === "openExternal") {
          this.#requestExternalApp(
            tab,
            "externalURL" in details ? details.externalURL : undefined,
            callback,
          );
          return;
        }
        const permissions = normalizeElectronPermissions(
          rawPermission,
          "mediaTypes" in details ? details.mediaTypes : undefined,
        );
        if (tab === undefined || permissions.length === 0) {
          callback(false);
          return;
        }
        const permission = permissions[0]!;
        const clipboardAction =
          permission === "clipboard-read"
            ? "paste"
            : permission === "clipboard-write"
              ? "copy"
              : null;
        if (clipboardAction !== null) {
          const actionVerdict = this.#policy.action(
            tab.info.url,
            clipboardAction,
          );
          if (actionVerdict.decision === "block") {
            this.#recordPolicy(
              tab,
              clipboardAction,
              "block",
              actionVerdict.source,
              actionVerdict.reason,
            );
            callback(false);
            return;
          }
        }
        const verdicts = permissions.map((requested) => ({
          permission: requested,
          verdict: this.#policy.permission(tab.info.url, requested),
        }));
        const blocked = verdicts.find(
          ({ verdict }) => verdict.decision === "block",
        );
        if (blocked !== undefined) {
          this.#recordPolicy(
            tab,
            blocked.permission,
            "block",
            blocked.verdict.source,
            blocked.verdict.reason,
          );
          callback(false);
          return;
        }
        if (verdicts.every(({ verdict }) => verdict.decision === "allow")) {
          for (const allowed of verdicts) {
            this.#recordPolicy(
              tab,
              allowed.permission,
              "allow",
              allowed.verdict.source,
              allowed.verdict.reason,
            );
          }
          this.#grantCapture(tab, permissions);
          callback(true);
          return;
        }
        const requestedAt = Date.now();
        const id = `${randomUUID()}:${requestedAt}`;
        const timer = setTimeout(
          () => this.#resolvePermission(id, "block"),
          60_000,
        );
        timer.unref();
        const firstAsk = verdicts.find(
          ({ verdict }) => verdict.decision === "ask",
        )!;
        this.#pendingPermissions.set(id, {
          tabId: tab.info.id,
          permission: firstAsk.permission,
          permissions,
          callback,
          timer,
        });
        this.#recordPolicy(
          tab,
          firstAsk.permission,
          "ask",
          firstAsk.verdict.source,
          firstAsk.verdict.reason,
        );
        this.#emitBrowserControls();
      },
    );
    target.setPermissionCheckHandler((contents, rawPermission) => {
      const tab =
        contents === null ? undefined : this.#tabForWebContents(contents.id);
      const permission = normalizeElectronPermissions(rawPermission)[0] ?? null;
      if (tab === undefined || permission === null) return false;
      const clipboardAction =
        permission === "clipboard-read"
          ? "paste"
          : permission === "clipboard-write"
            ? "copy"
            : null;
      return (
        (clipboardAction === null ||
          this.#policy.action(tab.info.url, clipboardAction).decision ===
            "allow") &&
        this.#policy.permission(tab.info.url, permission).decision === "allow"
      );
    });
    // Only a filesystem file in the body matters here, and only a document
    // form, a fetch/XHR, or a beacon can carry one. Leaving images, scripts,
    // styles, fonts, and media out of the filter spares every one of them a
    // round trip through this process.
    target.webRequest.onBeforeRequest(
      {
        urls: ["http://*/*", "https://*/*", "pistachio://*/*"],
        types: ["mainFrame", "subFrame", "xhr", "ping"],
      },
      (details, callback) => {
        const uploadsFile = hasFileUpload(details.uploadData);
        if (!uploadsFile) {
          callback({});
          return;
        }
        const tab =
          details.webContentsId === undefined
            ? undefined
            : this.#tabForWebContents(details.webContentsId);
        if (tab === undefined) {
          callback({ cancel: true });
          return;
        }
        const verdict = this.#policy.action(tab.info.url, "upload");
        this.#recordPolicy(
          tab,
          "upload",
          verdict.decision,
          verdict.source,
          verdict.reason,
        );
        callback({ cancel: verdict.decision === "block" });
      },
    );
    target.on("will-download", (event, item, contents) => {
      const tab = this.#tabForWebContents(contents.id);
      if (tab === undefined) {
        event.preventDefault();
        return;
      }
      this.#trackDownload(tab, item, event);
    });
  }

  #installAgentEnforcement(target: Session, guard: AgentNetworkGuard): void {
    target.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*", "pistachio://*/*"] },
      (details, callback) => {
        const uploadsFile = hasFileUpload(details.uploadData);
        const decision = guard.enforcer.authorize({
          url: details.url,
          method: details.method,
          resourceType: details.resourceType,
          hasFileUpload: uploadsFile,
        });
        guard.onDecision(decision);
        callback({ cancel: decision.outcome !== "allow" });
      },
    );
    target.on("will-download", (event) => {
      if (!guard.enforcer.allowsDownloads()) event.preventDefault();
    });
  }

  acceptPolicyBlocked(senderId: number, action: GuardedBrowserAction): void {
    if (action !== "copy" && action !== "paste") return;
    const tab = this.#tabForWebContents(senderId);
    if (tab === undefined) return;
    const verdict = this.#actionVerdict(tab, action);
    if (verdict.decision === "block")
      this.#recordPolicy(tab, action, "block", verdict.source, verdict.reason);
  }

  #tabForWebContents(id: number): ManagedTab | undefined {
    for (const tab of this.#tabs.values())
      if (tab.view.webContents.id === id) return tab;
    if (this.#glance?.tab.view.webContents.id === id) return this.#glance.tab;
    return undefined;
  }

  #actionVerdict(
    tab: ManagedTab,
    action: GuardedBrowserAction,
  ): BrowserPolicyVerdict<ActionDecision> {
    if (tab.info.kind === "human")
      return this.#policy.action(tab.info.url, action);
    const allowed =
      action === "download"
        ? tab.enforcer?.allowsDownloads() === true
        : action === "upload"
          ? tab.enforcer?.allowsUploads() === true
          : action === "copy" || action === "paste"
            ? tab.enforcer?.allowsClipboard() === true
            : false;
    return {
      decision: allowed ? "allow" : "block",
      source: "task",
      reason: allowed
        ? "granted by the active task capsule"
        : `${action} is not granted to this task`,
    };
  }

  #sendTabDataPolicy(tab: ManagedTab): void {
    if (tab.info.kind !== "human" || tab.view.webContents.isDestroyed()) return;
    tab.view.webContents.send(IPC.tabDataPolicy, {
      copy: this.#policy.action(tab.info.url, "copy").decision,
      paste: this.#policy.action(tab.info.url, "paste").decision,
    });
  }

  /** Let the isolated page decide synchronously whether a clean click can Glance. */
  #sendGlanceConfiguration(tab: ManagedTab): void {
    if (tab.info.kind !== "human" || tab.view.webContents.isDestroyed()) return;
    tab.view.webContents.send(IPC.glanceConfiguration, {
      automatic:
        this.#tabs.get(tab.info.id) === tab && tab.info.anchorId !== null,
    });
  }

  #recordPolicy(
    tab: ManagedTab,
    capability: BrowserPermission | GuardedBrowserAction | "passkey",
    decision: "allow" | "block" | "ask",
    source: BrowserPolicyEvent["source"],
    reason: string,
    origin = browserOrigin(tab.info.url),
  ): void {
    this.#policyEvents.unshift({
      id: randomUUID(),
      tabId: tab.info.id,
      origin,
      capability,
      decision,
      source,
      reason,
      occurredAt: Date.now(),
    });
    this.#policyEvents.splice(200);
    this.#emitBrowserControls();
  }

  /**
   * A page pointed the tab at a link only another app can open. Ask (or
   * consult what was already answered), then hand the link to the system.
   */
  #offerExternalApp(tab: ManagedTab, url: string): void {
    this.#requestExternalApp(tab, url, (allowed) => {
      if (!allowed) return;
      void shell.openExternal(url).catch(() => {
        this.#notice("That app could not be opened", "warning");
      });
    });
  }

  /**
   * Decide whether `url` may leave the browser for another app, calling
   * `settle` exactly once. Only a person's own tab may ask; a task tab never
   * reaches another app. A scheme nothing on this computer answers is
   * dropped without a prompt — there would be nothing to open.
   */
  #requestExternalApp(
    tab: ManagedTab | undefined,
    url: string | undefined,
    settle: (allowed: boolean) => void,
  ): void {
    const scheme = url === undefined ? null : externalAppScheme(url);
    if (
      tab === undefined ||
      url === undefined ||
      scheme === null ||
      tab.info.kind !== "human"
    ) {
      settle(false);
      return;
    }
    const appName = externalAppName(url);
    if (appName === null) {
      settle(false);
      return;
    }
    const verdict = this.#policy.externalApp(tab.info.url, scheme);
    if (verdict.decision !== "ask") {
      this.#recordPolicy(
        tab,
        "external-app",
        verdict.decision,
        verdict.source,
        verdict.reason,
      );
      settle(verdict.decision === "allow");
      return;
    }
    // One question per tab: a page that asks again (its "Launch" button,
    // after the automatic attempt) replaces its earlier request rather than
    // stacking prompts, and the fresh id raises the prompt again.
    for (const [id, held] of this.#pendingPermissions) {
      if (held.tabId !== tab.info.id || held.externalApp === undefined) continue;
      clearTimeout(held.timer);
      held.callback(false);
      this.#pendingPermissions.delete(id);
    }
    const requestedAt = Date.now();
    const id = `${randomUUID()}:${requestedAt}`;
    const timer = setTimeout(() => this.#resolvePermission(id, "block"), 60_000);
    timer.unref();
    this.#pendingPermissions.set(id, {
      tabId: tab.info.id,
      permission: "external-app",
      permissions: ["external-app"],
      callback: settle,
      timer,
      externalApp: { scheme, appName, pageUrl: tab.info.url },
    });
    this.#recordPolicy(
      tab,
      "external-app",
      "ask",
      verdict.source,
      `asked to open ${appName} (${scheme} link)`,
    );
  }

  #resolvePermission(
    requestId: string,
    decision: "allow-once" | "allow" | "block",
  ): void {
    const held = this.#pendingPermissions.get(requestId);
    if (held === undefined) return;
    this.#pendingPermissions.delete(requestId);
    clearTimeout(held.timer);
    const tab = this.#permissionTab(held.tabId);
    if (held.externalApp !== undefined) {
      // Remembered per scheme, and only a yes: a "no" to one meeting link is
      // not a standing order, and a silent dead button would be the result.
      if (decision === "allow")
        this.#policy.allowExternalApp(
          held.externalApp.pageUrl,
          held.externalApp.scheme,
        );
    } else if (tab !== undefined && decision !== "allow-once") {
      for (const permission of held.permissions) {
        this.#policy.setPermission(
          tab.info.url,
          permission,
          decision as PermissionDecision,
        );
      }
    }
    const allowed = decision === "allow" || decision === "allow-once";
    if (allowed && tab !== undefined && held.externalApp === undefined)
      this.#grantCapture(tab, held.permissions);
    held.callback(allowed);
    if (tab !== undefined) {
      this.#recordPolicy(
        tab,
        held.permission,
        allowed ? "allow" : "block",
        decision === "allow-once" || held.externalApp !== undefined
          ? "user"
          : this.#policy.permission(tab.info.url, held.permission).source,
        held.externalApp !== undefined
          ? externalAppReason(held.externalApp, decision)
          : decision === "allow-once"
            ? "allowed for this request only"
            : "person answered the site request",
      );
    } else {
      this.#emitBrowserControls();
    }
  }

  /**
   * The page's address to the clipboard, bare or as `[title](url)`. A reader
   * view copies the article it is showing, not its own pistachio:// address.
   * It leaves the page the way a copy does, so the copy verdict applies.
   *
   * A copy has no visible result, and the key that asks for it (⌘⇧C) may be
   * pressed with the page, the shell or the menu holding the keyboard — every
   * path ends here, so this is where the chrome is told what happened.
   */
  #copyPageUrl(tab: ManagedTab, format: "plain" | "markdown"): void {
    const reader = this.#readerEntryForUrl(tab.info.url);
    const url = reader?.article.url ?? tab.info.url;
    const title = reader?.article.title ?? tab.info.title;
    if (url === "") return;
    const verdict = this.#actionVerdict(tab, "copy");
    this.#recordPolicy(
      tab,
      "copy",
      verdict.decision,
      verdict.source,
      verdict.reason,
    );
    if (verdict.decision === "block") {
      this.#notice("Copying is blocked on this site", "warning");
      return;
    }
    clipboard.writeText(
      format === "markdown" ? pageLinkMarkdown(title, url) : url,
    );
    this.#notice(copyUrlNotice(format), "success");
  }

  /** A brief word in the shell's notice stack (@pistachio/shell-contracts/notice). */
  #notice(message: string, tone: NoticeTone): void {
    if (this.#window.isDestroyed()) return;
    this.#window.webContents.send(IPC.shellCommand, {
      type: "notice",
      message,
      tone,
    } satisfies ShellCommand);
  }

  /** The page a held request belongs to: a tab, or the Glance over one. */
  #permissionTab(tabId: string): ManagedTab | undefined {
    return (
      this.#tabs.get(tabId) ??
      (this.#glance?.tab.info.id === tabId ? this.#glance.tab : undefined)
    );
  }

  #cancelPermissionsForTab(tabId: string): void {
    for (const [id, held] of this.#pendingPermissions) {
      if (held.tabId !== tabId) continue;
      clearTimeout(held.timer);
      held.callback(false);
      this.#pendingPermissions.delete(id);
    }
    this.#emitBrowserControls();
  }

  #resolvePasskey(
    requestId: string,
    accountId: string | null,
    reason?: string,
  ): void {
    const held = this.#pendingPasskeys.get(requestId);
    if (held === undefined) return;
    this.#pendingPasskeys.delete(requestId);
    clearTimeout(held.timer);
    const credentialId =
      accountId === null || !held.isCurrent()
        ? undefined
        : held.credentialIds.get(accountId);
    held.cleanup();
    held.callback(credentialId ?? null);
    const tab = this.#tabs.get(held.tabId);
    if (tab !== undefined) {
      this.#recordPolicy(
        tab,
        "passkey",
        credentialId === undefined ? "block" : "allow",
        "user",
        reason ??
          (credentialId === undefined
            ? "person cancelled passkey selection"
            : "person selected a passkey account"),
        held.origin,
      );
    } else {
      this.#emitBrowserControls();
    }
  }

  #cancelPasskeysForTab(tabId: string): void {
    for (const [id, held] of this.#pendingPasskeys) {
      if (held.tabId !== tabId) continue;
      clearTimeout(held.timer);
      this.#pendingPasskeys.delete(id);
      held.cleanup();
      held.callback(null);
    }
    this.#emitBrowserControls();
  }

  #trackDownload(
    tab: ManagedTab,
    item: DownloadItem,
    event: Electron.Event,
  ): void {
    const verdict = this.#actionVerdict(tab, "download");
    const id = randomUUID();
    const download: BrowserDownload = {
      id,
      tabId: tab.info.id,
      origin: browserOrigin(tab.info.url),
      url: item.getURL(),
      fileName: item.getFilename(),
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      state: verdict.decision === "block" ? "blocked" : "progress",
      createdAt: Date.now(),
      finishedAt: verdict.decision === "block" ? Date.now() : null,
      reason: verdict.reason,
      source: verdict.source,
    };
    this.#downloads.set(id, download);
    this.#recordPolicy(
      tab,
      "download",
      verdict.decision,
      verdict.source,
      verdict.reason,
    );
    if (verdict.decision === "block") {
      event.preventDefault();
      this.#emitBrowserControls();
      this.#emitDownloads();
      return;
    }
    this.#downloadItems.set(id, item);
    item.on("updated", (_updatedEvent, state) => {
      download.receivedBytes = item.getReceivedBytes();
      download.totalBytes = item.getTotalBytes();
      download.state = state === "interrupted" ? "interrupted" : "progress";
      this.#emitBrowserControls();
      this.#emitDownloads();
    });
    item.once("done", (_doneEvent, state) => {
      download.receivedBytes = item.getReceivedBytes();
      download.totalBytes = item.getTotalBytes();
      download.state = state;
      download.finishedAt = Date.now();
      this.#emitBrowserControls();
      this.#emitDownloads();
    });
    this.#emitBrowserControls();
    this.#emitDownloads();
  }

  #handleTabShortcut(
    tab: ManagedTab,
    event: Electron.Event,
    input: Electron.Input,
  ): void {
    if (this.#onTabSwitcherInput(event, input)) return;
    if (input.type !== "keyDown") return;
    if (
      input.key === "Escape" &&
      this.#fullscreenTabId === tab.info.id &&
      this.#window.isFullScreen() &&
      !this.#windowFullScreenSettled
    ) {
      // Escape while the window is still animating into fullscreen would
      // strand the page (see #windowFullScreenSettled): hold the exit until
      // the transition ends, then leave as the user asked.
      event.preventDefault();
      this.#fullscreenExitPending = true;
      return;
    }
    const platform: ShortcutPlatform =
      process.platform === "darwin" ? "darwin" : "other";
    const action = shortcutActionForEvent(
      this.#settings().shortcuts,
      input,
      platform,
    );
    if (action === null) {
      // Not a binding of ours: the edit keys reach the page, gated by the
      // data policy. A configured binding comes first so that ⌘⇧C can be
      // "copy the URL" rather than a shifted copy; the bare edit keys can
      // never be bound (reservedShortcutReason), so they always land here.
      const command =
        process.platform === "darwin" ? input.meta : input.control;
      const key = input.key.toLowerCase();
      if (command && !input.alt && (key === "c" || key === "x" || key === "v")) {
        const edit = key === "v" ? "paste" : "copy";
        const verdict = this.#actionVerdict(tab, edit);
        if (verdict.decision === "block") {
          event.preventDefault();
          this.#recordPolicy(
            tab,
            edit,
            "block",
            verdict.source,
            verdict.reason,
          );
        }
      }
      return;
    }
    event.preventDefault();
    // The keystroke came from this page, so this page holds the keyboard —
    // and these bindings move the typing that follows into the shell's own
    // document (the address bar; the new tab's home page or address bar).
    // Hand it over now rather than at the next layout pass: letters typed
    // in the meantime would land in the page, not in the field they were
    // meant for.
    if (action === "editAddress" || action === "newTab") this.#hooks.focusShell?.();
    switch (action) {
      case "back":
        void this.goBack(tab.info.id);
        return;
      case "forward":
        void this.goForward(tab.info.id);
        return;
      case "reload":
        void this.reload(tab.info.id);
        return;
      case "editAddress":
        this.#window.webContents.send(IPC.shellCommand, {
          type: "openUrlBar",
          tabId: tab.info.id,
        });
        return;
      case "find":
        this.openFind();
        return;
      case "smartFind":
        this.openFind("smart");
        return;
      case "print":
        void this.browserControl({ type: "print" });
        return;
      case "zoomIn":
        void this.browserControl({ type: "zoomIn" });
        return;
      case "zoomOut":
        void this.browserControl({ type: "zoomOut" });
        return;
      case "zoomReset":
        void this.browserControl({ type: "zoomReset" });
        return;
      case "copyUrl":
        void this.browserControl({ type: "copyUrl", format: "plain" });
        return;
      case "copyUrlMarkdown":
        void this.browserControl({ type: "copyUrl", format: "markdown" });
        return;
      default:
        this.#window.webContents.send(IPC.shellCommand, {
          type: "runShortcut",
          id: action,
          tabId: tab.info.id,
        });
    }
  }

  #emitBrowserControls(): void {
    this.#onBrowserControlsChange(this.browserControls());
  }

  #emitFind(): void {
    this.#onFindChange(this.findState());
  }

  /**
   * A navigation failed before any document arrived: Chromium committed an
   * empty error page at the failed address. Write Pistachio's own into it —
   * what went wrong, Retry (a reload, which retries the address), Back. The
   * tab keeps the failed URL and its history, and a later load replaces the
   * document like any other.
   */
  #showNavigationError(
    tab: ManagedTab,
    failure: { url: string; code: number; description: string },
  ): void {
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    void contents
      .executeJavaScript(
        navigationErrorScript({
          ...failure,
          canGoBack: contents.navigationHistory.canGoBack(),
        }),
        true,
      )
      .catch(() => {
        // The error document was already replaced (a redirect, a retry).
      });
  }

  /** Open a Glance explicitly, or automatically from a pinned/favorited tab. */
  async openGlance(
    senderId: number,
    request: GlanceOpenRequest,
  ): Promise<void> {
    if (this.#glance !== null || !isAllowedNavigation(request.url)) return;
    const owner = [...this.#tabs.values()].find(
      (candidate) =>
        candidate.info.kind === "human" &&
        candidate.view.webContents.id === senderId,
    );
    if (
      owner === undefined ||
      !this.#layout.views.some(({ tabId }) => tabId === owner.info.id) ||
      (request.automatic && owner.info.anchorId === null)
    )
      return;

    const ownerBounds = owner.view.getBounds();
    const localSource = clampSourceBounds(request.source, ownerBounds);
    const source = {
      x: ownerBounds.x + localSource.x,
      y: ownerBounds.y + localSource.y,
      width: localSource.width,
      height: localSource.height,
    };
    const backgroundStills = await this.#captureVisibleStills("jpeg");
    // The owner may have closed or another gesture may have won while the
    // compositor captures were in flight.
    if (this.#glance !== null || this.#tabs.get(owner.info.id) !== owner)
      return;
    this.#spawnGlance(owner, request.url, source, backgroundStills);
  }

  /**
   * Preview a link the shell rendered itself (the agent console) above the
   * page the person is looking at. The owner must be a human tab: agent tabs
   * live in a per-run partition, so a preview there would lack the person's
   * sessions. Returns false when no human tab is on screen to own it.
   */
  async openGlanceFromShell(request: ShellGlanceOpenRequest): Promise<boolean> {
    if (!isAllowedNavigation(request.url)) return false;
    const onScreen = (tab: ManagedTab): boolean =>
      tab.info.kind === "human" &&
      this.#layout.views.some(({ tabId }) => tabId === tab.info.id);
    const active =
      this.#activeTabId === null ? undefined : this.#tabs.get(this.#activeTabId);
    const owner =
      active !== undefined && onScreen(active)
        ? active
        : [...this.#tabs.values()].find(onScreen);
    if (owner === undefined) return false;

    // A second console link replaces the preview already open rather than
    // being swallowed by it.
    this.#discardGlance();
    const source = this.#clampWindowBounds(request.source);
    const backgroundStills = await this.#captureVisibleStills("jpeg");
    if (this.#glance !== null || this.#tabs.get(owner.info.id) !== owner)
      return false;
    this.#spawnGlance(owner, request.url, source, backgroundStills);
    return true;
  }

  #spawnGlance(
    owner: ManagedTab,
    url: string,
    source: ContentBounds,
    backgroundStills: PaneStill[],
  ): void {
    const view = new WebContentsView({
      webPreferences: {
        partition: owner.partition,
        ...(this.#tabPreload === "" ? {} : { preload: this.#tabPreload }),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        disableBlinkFeatures: "WebAuth",
      },
    });
    const appearance = this.#settings().appearance;
    const dark =
      appearance.scheme === "dark" ||
      (appearance.scheme === "system" && nativeTheme.shouldUseDarkColors);
    view.setBackgroundColor(dark ? "#202225" : "#f8f8f3");
    view.setBorderRadius(appearance.radius);
    view.setVisible(false);
    this.#window.contentView.addChildView(view);
    this.#onViewAdded();

    const info: BrowserTabInfo = {
      // A Glance is already outside #tabs, so it is never listed either way.
      unlisted: false,
      id: randomUUID(),
      spaceId: owner.info.spaceId,
      title: "Loading preview…",
      url: normalizeNavigation(url, this.#settings().search.webProvider),
      faviconUrl: null,
      loading: true,
      canGoBack: false,
      canGoForward: false,
      kind: "human",
      runId: null,
      anchorId: null,
      lifecycle: "live",
      lastActiveAt: Date.now(),
    };
    const tab: ManagedTab = {
      info,
      view,
      enforcer: null,
      history: null,
      partition: owner.partition,
      pendingLoad: null,
      shellTitle: null,
    };
    this.#glance = {
      tab,
      ownerTabId: owner.info.id,
      source,
      backgroundStills,
      bounds: null,
      ownerRecessed: false,
      preparedForClose: false,
      promotionStaged: false,
    };
    const refresh = this.#wireManagedTab(tab);
    this.#applyLayout();
    this.#emitGlance();
    void view.webContents
      .loadURL(info.url)
      .then(refresh)
      .catch(() => refresh());
  }

  /** True when Escape came from the preview or its owner page. */
  acceptsGlanceDismiss(senderId: number): boolean {
    const glance = this.#glance;
    if (glance === null) return false;
    if (glance.tab.view.webContents.id === senderId) return true;
    return this.#tabs.get(glance.ownerTabId)?.view.webContents.id === senderId;
  }

  /**
   * The shell has the owner's still painted under the live owner: hiding the
   * owner now swaps two identical pictures. Hiding it any earlier — as the
   * spawn used to — left a blank pane while the still was still decoding.
   */
  recedeGlanceOwner(): void {
    const glance = this.#glance;
    if (glance === null || glance.ownerRecessed) return;
    glance.ownerRecessed = true;
    this.#applyLayout();
  }

  /** Position the live native preview after the shell's opening flight lands. */
  setGlanceBounds(bounds: ContentBounds | null): void {
    const glance = this.#glance;
    if (glance === null) return;
    if (bounds === null) {
      glance.bounds = null;
      glance.tab.view.setVisible(false);
      return;
    }
    if (glance.preparedForClose) return;
    glance.bounds = this.#clampWindowBounds(bounds);
    glance.tab.view.setBounds(glance.bounds);
    glance.tab.view.setVisible(!this.#overlayActive);
  }

  /**
   * Freeze the live page's last frame for a close handoff. The view stays up
   * until the shell has painted the capture underneath, so the native-to-DOM
   * swap changes nothing. From here ordinary placement stops.
   */
  async prepareGlanceClose(): Promise<string | null> {
    const glance = this.#glance;
    if (glance === null || glance.preparedForClose) return null;
    let dataUrl: string | null = null;
    if (
      glance.tab.view.getVisible() &&
      !glance.tab.view.webContents.isDestroyed()
    ) {
      try {
        const image = await glance.tab.view.webContents.capturePage();
        if (!image.isEmpty()) dataUrl = encodeStill(image, "jpeg");
      } catch {
        // The opening animation may be dismissed before the first frame.
      }
    }
    if (this.#glance !== glance) return null;
    glance.preparedForClose = true;
    return dataUrl;
  }

  /** Keep the same native preview live while the shell advances its bounds. */
  stageGlancePromotion(bounds: ContentBounds): void {
    const glance = this.#glance;
    if (glance === null || glance.preparedForClose) return;
    glance.promotionStaged = true;
    glance.bounds = this.#clampWindowBounds(bounds);
    glance.tab.view.setBounds(glance.bounds);
    glance.tab.view.setVisible(!this.#overlayActive);
  }

  closeGlance(): void {
    this.#discardGlance();
  }

  /** Promote the exact live preview WebContentsView to a normal selected tab. */
  promoteGlance(): void {
    const glance = this.#glance;
    if (glance === null) return;
    const { tab } = glance;
    const revealStagedView =
      glance.promotionStaged &&
      glance.bounds !== null &&
      !this.#overlayActive;
    if (!revealStagedView) tab.view.setVisible(false);
    this.#glance = null;
    this.#insertTabAfter(glance.ownerTabId, tab);
    this.#activateTab(tab.info.id);
    // Keep the live view visible across the metadata transition; the shell's
    // now-transparent Glance chrome unmounts underneath the same page.
    if (revealStagedView) tab.view.setVisible(true);
    this.#emitGlance();
    this.#onChange();
  }

  /** Promote the live preview and pair it vertically with the page that opened it. */
  splitGlance(): void {
    const glance = this.#glance;
    if (glance === null) return;
    const { tab } = glance;
    tab.view.setVisible(false);
    this.#glance = null;
    this.#insertTabAfter(glance.ownerTabId, tab);
    if (this.#tabs.has(glance.ownerTabId)) {
      const group = this.#splitGroupFor(glance.ownerTabId);
      if (group !== undefined && group.tabIds.length < MAX_SPLIT_PANES) {
        this.#formSplit(
          [...group.tabIds, tab.info.id],
          group.mode,
          glance.ownerTabId,
          group.id,
          group.gridLayout,
        );
      } else if (group === undefined) {
        this.#formSplit([glance.ownerTabId, tab.info.id], "vertical");
      } else {
        this.#activateTab(tab.info.id);
      }
    } else this.#activateTab(tab.info.id);
    this.#emitGlance();
    this.#onChange();
  }

  #insertTabAfter(ownerTabId: string, tab: ManagedTab): void {
    this.#tabs.set(tab.info.id, tab);
    const ownerIndex = this.#tabOrder.indexOf(ownerTabId);
    this.#tabOrder.splice(
      ownerIndex < 0 ? this.#tabOrder.length : ownerIndex + 1,
      0,
      tab.info.id,
    );
  }

  #discardGlance(): void {
    const glance = this.#glance;
    if (glance === null) return;
    this.#glance = null;
    // Whatever the preview was waiting to be told goes with it.
    this.#cancelPermissionsForTab(glance.tab.info.id);
    glance.tab.view.setVisible(false);
    this.#window.contentView.removeChildView(glance.tab.view);
    if (!glance.tab.view.webContents.isDestroyed())
      glance.tab.view.webContents.close();
    this.#applyLayout();
    this.#emitGlance();
  }

  #clampWindowBounds(bounds: ContentBounds): ContentBounds {
    const content = this.#window.getContentBounds();
    const x = Math.max(
      0,
      Math.min(Math.round(bounds.x), Math.max(0, content.width - 1)),
    );
    const y = Math.max(
      0,
      Math.min(Math.round(bounds.y), Math.max(0, content.height - 1)),
    );
    return {
      x,
      y,
      width: Math.max(1, Math.min(Math.round(bounds.width), content.width - x)),
      height: Math.max(
        1,
        Math.min(Math.round(bounds.height), content.height - y),
      ),
    };
  }

  /**
   * Close a tab. A page with unsaved changes gets to ask the person to stay
   * (its beforeunload handler); `force` skips that for programmatic closes
   * — a fork's rollback, a dismissed media card — where nobody is there to
   * answer and the tab must go. A close already under way for the tab is
   * returned rather than started over.
   */
  closeTab(tabId: string, options: { force?: boolean } = {}): Promise<void> {
    const pending = this.#closing.get(tabId);
    if (pending !== undefined) return pending;
    const run = this.#closeTabNow(tabId, options.force ?? false).finally(() => {
      if (this.#closing.get(tabId) === run) this.#closing.delete(tabId);
    });
    this.#closing.set(tabId, run);
    return run;
  }

  async #closeTabNow(tabId: string, force: boolean): Promise<void> {
    const tab = this.#tabs.get(tabId);
    const dormant = this.#dormantTabs.get(tabId);
    const info = tab?.info ?? dormant?.info;
    if (info === undefined) return;
    // What the tab can come back as (restoreClosedTab), read while its page
    // is still here: the stack, and the state Chromium last committed for
    // the page — an accidental ⌘W should not cost a half-written form.
    const history =
      tab !== undefined
        ? (captureTabHistory(tab.view.webContents, true) ?? tab.history)
        : (dormant?.history ?? null);
    // The page has its say first: one with unsaved changes asks to stay,
    // the way it would in any browser, and the close stops there. When it
    // goes, the tab leaves the window's state in the same tick its page is
    // destroyed — nothing gets to see a listed tab with no page behind it.
    const closing: { detached: DetachedTab | null } = { detached: null };
    const detach = (): void => {
      closing.detached = this.#detachTab(tabId, tab, history);
    };
    if (!force && tab !== undefined && info.kind === "human") {
      if (!(await this.#confirmUnload(tab, detach))) return;
    } else detach();
    // Closed, suspended, or moved by someone else while the page was asked.
    if (closing.detached === null) return;
    await this.#settleClose(closing.detached);
  }

  /**
   * Take a tab out of the window's state — the list, its Space's recents,
   * its split group, its view — remembering it for restoreClosedTab. Null
   * when the tab is no longer the one the caller saw. Synchronous on
   * purpose: it runs inside the page's `destroyed` event (closeTab).
   */
  #detachTab(tabId: string, tab: ManagedTab | undefined, history: TabHistory | null): DetachedTab | null {
    const dormant = this.#dormantTabs.get(tabId);
    if (tab !== undefined ? this.#tabs.get(tabId) !== tab : dormant === undefined) return null;
    const info = tab?.info ?? dormant?.info;
    if (info === undefined) return null;
    const closingSpaceId = info.spaceId;
    if (this.#glance?.ownerTabId === tabId) this.#discardGlance();
    const group = this.#splitGroupFor(tabId);
    const activeGroup =
      this.#activeTabId === null
        ? undefined
        : this.#splitGroupFor(this.#activeTabId);
    const closingVisibleGroup =
      group !== undefined && group.id === activeGroup?.id;
    const survivingPaneIds =
      group?.tabIds.filter((candidate) => candidate !== tabId) ?? [];
    const closingActiveTab = this.#activeTabId === tabId;
    if (info.kind === "human") this.#rememberClosedTab(info, history);
    if (tab !== undefined) {
      this.#cancelPermissionsForTab(tabId);
      this.#cancelPasskeysForTab(tabId);
      this.#passkeySupport.delete(tabId);
      this.#capturingTabs.delete(tabId);
      this.#forgetWake(tabId);
      this.#paneSizes.delete(tabId);
      this.#cancelPresentationRelease(tabId);
      this.#removeMedia(tabId);
      this.#readAloudTabGone(tabId, "closed");
      this.#releaseFullscreen(tabId);
      this.#window.contentView.removeChildView(tab.view);
      // #confirmUnload already took the page down; a view whose page is
      // gone reports no webContents at all.
      const contents = tab.view.webContents as WebContents | undefined;
      if (contents !== undefined && !contents.isDestroyed()) contents.close();
      this.#tabs.delete(tabId);
    } else {
      this.#dormantTabs.delete(tabId);
    }
    const orderIndex = this.#tabOrder.indexOf(tabId);
    if (orderIndex >= 0) this.#tabOrder.splice(orderIndex, 1);
    this.#recentTabIdsBySpace.set(
      closingSpaceId,
      (this.#recentTabIdsBySpace.get(closingSpaceId) ?? []).filter(
        (candidate) => candidate !== tabId,
      ),
    );

    if (group !== undefined) {
      if (survivingPaneIds.length >= 2) {
        this.#splitGroups.set(
          group.id,
          splitGroupInfo(
            group.id,
            survivingPaneIds,
            group.mode,
            group.gridLayout,
          ),
        );
      } else {
        this.#splitGroups.delete(group.id);
      }
    }
    return { closingSpaceId, closingVisibleGroup, survivingPaneIds, closingActiveTab };
  }

  /** Choose what shows in the closed tab's place, and tell everyone. */
  async #settleClose({ closingSpaceId, closingVisibleGroup, survivingPaneIds, closingActiveTab }: DetachedTab): Promise<void> {
    if (closingVisibleGroup) {
      // A multi-pane group contracts in place. A two-pane group still
      // dissolves naturally when only one survivor remains.
      const preferred =
        !closingActiveTab &&
        this.#activeTabId !== null &&
        survivingPaneIds.includes(this.#activeTabId)
          ? this.#activeTabId
          : survivingPaneIds[0];
      const fallback =
        preferred !== undefined && this.#tabInfo(preferred) !== null
          ? preferred
          : this.#lastVisitedTabId(closingSpaceId);
      if (fallback !== undefined) {
        await this.#hydrateTabAndGroup(fallback, { awaitLoad: false });
        this.#activateTab(fallback);
      } else this.#activeTabId = null;
    } else if (closingActiveTab) {
      const fallback = this.#lastVisitedTabId(closingSpaceId);
      if (fallback !== undefined) {
        await this.#hydrateTabAndGroup(fallback, { awaitLoad: false });
        this.#activateTab(fallback);
      } else this.#activeTabId = null;
    }
    if (this.#activeTabId === null && closingSpaceId === this.activeSpaceId())
      await this.createTab(this.#homeUrl(), { spaceId: closingSpaceId });
    if (closingActiveTab && this.#findState.open) this.find({ type: "close" });
    this.#emitBrowserControls();
    this.#onChange();
  }

  /**
   * Let the page object to going away. A page whose beforeunload handler
   * asks to stay gets the person's decision in a dialog; false means they
   * chose to stay and the page is untouched. True means the page is gone
   * (its WebContents destroyed) and the caller can take the view down.
   */
  #confirmUnload(tab: ManagedTab, onGone: () => void): Promise<boolean> {
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) {
      onGone();
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let settled = false;
      let deadline: NodeJS.Timeout | null = null;
      const settle = (gone: boolean): void => {
        if (settled) return;
        settled = true;
        if (deadline !== null) clearTimeout(deadline);
        contents.removeListener("will-prevent-unload", onPrevent);
        contents.removeListener("destroyed", onDestroyed);
        if (gone) {
          // The close must settle even if the teardown trips: a pending
          // closeTab would otherwise hold its caller forever.
          try {
            onGone();
          } catch (error) {
            console.error("[browser] tab teardown failed after its page closed", error);
          }
        }
        resolve(gone);
      };
      // A renderer that never answers its beforeunload (hung, or gone)
      // must not hold the tab open forever: the tab goes, and its teardown
      // closes the page the plain way. Not while the person is being asked:
      // the dialog's nested run loop keeps timers going.
      const arm = (): void => {
        if (deadline !== null) clearTimeout(deadline);
        deadline = setTimeout(() => {
          deadline = null;
          settle(true);
        }, UNLOAD_ANSWER_TIMEOUT_MS);
      };
      const onPrevent = (event: ElectronEvent): void => {
        if (settled) return;
        if (deadline !== null) clearTimeout(deadline);
        deadline = null;
        const choice = dialog.showMessageBoxSync(this.#window, {
          type: "question",
          buttons: ["Leave", "Stay"],
          defaultId: 0,
          cancelId: 1,
          message: "Leave this page?",
          detail: "Changes you made may not be saved.",
        });
        if (settled) return;
        if (choice === 1) {
          // The page's objection stands: it stays, untouched.
          settle(false);
          return;
        }
        // Electron's preventDefault here means "ignore the handler and
        // unload anyway"; `destroyed` follows and takes the tab down.
        event.preventDefault();
        arm();
      };
      const onDestroyed = (): void => settle(true);
      contents.on("will-prevent-unload", onPrevent);
      contents.once("destroyed", onDestroyed);
      arm();
      contents.close({ waitForBeforeUnload: true });
    });
  }

  #rememberClosedTab(info: BrowserTabInfo, history: TabHistory | null): void {
    const closed: RecentlyClosedTabInfo = {
      spaceId: info.spaceId,
      title: info.title,
      url: info.url,
      faviconUrl: info.faviconUrl,
      anchorId: info.anchorId,
      closedAt: Date.now(),
    };
    this.#recentlyClosedTabs.unshift(closed);
    if (history !== null) this.#closedTabHistory.set(closed, history);
    this.#recentlyClosedTabs.splice(RECENTLY_CLOSED_LIMIT);
  }

  /**
   * Move a human tab without crossing Space session boundaries. Its old view
   * is discarded and the tab is rehydrated in the destination partition;
   * any source shelf anchor stays behind as a durable page.
   */
  async moveTabToSpace(tabId: string, targetSpaceId: string): Promise<void> {
    const info = this.#tabInfo(tabId);
    if (info === null) throw new Error("unknown tab");
    if (info.kind !== "human")
      throw new Error("delegated tabs cannot move between Spaces");
    if (this.#spaceStore.get(targetSpaceId) === null)
      throw new Error("unknown Space");
    if (info.spaceId === targetSpaceId) {
      await this.selectTab(tabId);
      return;
    }

    const sourceSpaceId = info.spaceId;
    const movingActiveTab = this.#activeTabId === tabId;
    const group = this.#splitGroupFor(tabId);
    const remainingPaneIds =
      group?.tabIds.filter((candidate) => candidate !== tabId) ?? [];
    if (this.#glance?.ownerTabId === tabId) this.#discardGlance();
    if (movingActiveTab && this.#findState.open) this.find({ type: "close" });

    const live = this.#tabs.get(tabId);
    // The stack crosses with the tab; page state does not, since the page
    // is rebuilt against another Space's partition.
    const history =
      live !== undefined
        ? (captureTabHistory(live.view.webContents, false) ?? live.history)
        : (this.#dormantTabs.get(tabId)?.history ?? null);
    if (live !== undefined) {
      this.#cancelPermissionsForTab(tabId);
      this.#cancelPasskeysForTab(tabId);
      this.#passkeySupport.delete(tabId);
      this.#capturingTabs.delete(tabId);
      this.#forgetWake(tabId);
      this.#paneSizes.delete(tabId);
      this.#cancelPresentationRelease(tabId);
      this.#removeMedia(tabId);
      this.#readAloudTabGone(tabId, "suspended");
      this.#releaseFullscreen(tabId);
      live.view.setVisible(false);
      this.#window.contentView.removeChildView(live.view);
      if (!live.view.webContents.isDestroyed()) live.view.webContents.close();
      this.#tabs.delete(tabId);
    } else {
      this.#dormantTabs.delete(tabId);
    }

    if (group !== undefined) {
      if (remainingPaneIds.length >= 2) {
        this.#splitGroups.set(
          group.id,
          splitGroupInfo(
            group.id,
            remainingPaneIds,
            group.mode,
            group.gridLayout,
          ),
        );
      } else {
        this.#splitGroups.delete(group.id);
      }
    }
    this.#recentTabIdsBySpace.set(
      sourceSpaceId,
      (this.#recentTabIdsBySpace.get(sourceSpaceId) ?? []).filter(
        (candidate) => candidate !== tabId,
      ),
    );
    if (this.#lastActiveTabBySpace.get(sourceSpaceId) === tabId)
      this.#lastActiveTabBySpace.delete(sourceSpaceId);
    // The tab leaves its tab group HERE, while it is still in the group's
    // Space: a group lives where its tabs do, and a first tab that changed
    // Space under it would otherwise carry the group off and strand the rest.
    this.#setTabGroups(withoutTabs([...this.#tabGroups.values()], new Set([tabId])));
    const orderIndex = this.#tabOrder.indexOf(tabId);
    if (orderIndex >= 0) this.#tabOrder.splice(orderIndex, 1);
    this.#tabOrder.push(tabId);
    this.#dormantTabs.set(tabId, {
      info: {
        ...info,
        spaceId: targetSpaceId,
        anchorId: null,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        lifecycle: "suspended",
      },
      history,
    });

    if (movingActiveTab) {
      const sourceFallback = remainingPaneIds[0];
      if (sourceFallback !== undefined)
        this.#lastActiveTabBySpace.set(sourceSpaceId, sourceFallback);
      this.#activeTabId = null;
      this.#secondaryTabId = null;
      this.#splitMode = "single";
      this.#layout = { views: [] };
      this.#applyLayout();
      await this.selectTab(tabId);
      return;
    }
    if (group !== undefined && this.#activeTabId !== null)
      this.#activateTab(this.#activeTabId);
    this.#onChange();
  }

  async restoreClosedTab(): Promise<void> {
    const closed = this.#recentlyClosedTabs[0];
    if (closed === undefined) return;
    const targetSpaceId =
      this.#spaceStore.get(closed.spaceId) === null
        ? this.activeSpaceId()
        : closed.spaceId;
    const anchorInUse =
      closed.anchorId !== null &&
      this.allTabs().some(
        (tab) =>
          tab.spaceId === targetSpaceId && tab.anchorId === closed.anchorId,
      );
    // The record is spent the moment the tab is being built — a second
    // ⌘⇧T while the page loads must reach the next record, not open
    // another copy of this one.
    this.#recentlyClosedTabs.shift();
    const history = this.#closedTabHistory.get(closed) ?? null;
    this.#closedTabHistory.delete(closed);
    // Back in the Space it was closed in (selectTab switches there), with
    // the stack and page state it was closed with.
    const tabId = await this.#createManagedTab({
      url: closed.url,
      kind: "human",
      runId: null,
      spaceId: targetSpaceId,
      anchorId: anchorInUse ? null : closed.anchorId,
      activate: false,
      history,
    });
    await this.selectTab(tabId);
  }

  async clearUnpinnedTabs(): Promise<void> {
    const tabIds = this.#spaceTabIds(this.activeSpaceId()).filter((tabId) => {
      const info = this.#tabInfo(tabId);
      return info?.kind === "human" && info.anchorId === null;
    });
    for (const tabId of tabIds) await this.closeTab(tabId);
  }

  /**
   * Make a tab the one on screen. The switch is immediate whether the tab is
   * awake or asleep: a sleeping tab gets its view and is shown while its page
   * loads into it, rather than the window staying on the old tab until the
   * load settles — with a slow page that read as a click that did nothing.
   *
   * Waking a tab still yields for a moment (the view, the session hooks), and
   * a person switching quickly may have clicked elsewhere by the time it
   * returns. The activation serial says so; then the later click stands and
   * this one only leaves the woken view ready, out of sight.
   */
  async selectTab(tabId: string): Promise<void> {
    const info = this.#tabInfo(tabId);
    if (info === null) return;
    if (info.spaceId !== this.activeSpaceId()) {
      if (this.#activeTabId !== null)
        this.#lastActiveTabBySpace.set(this.activeSpaceId(), this.#activeTabId);
      this.#layout = { views: [] };
      this.#applyLayout();
      this.#spaceStore.setActive(info.spaceId);
    }
    if (this.#glance !== null && this.#glance.ownerTabId !== tabId)
      this.#discardGlance();
    const serial = ++this.#activationSerial;
    await this.#hydrateTabAndGroup(tabId, { awaitLoad: false });
    // Overtaken while waking: a later selection, or another activation —
    // unless that activation was this very tab's (a woken view in an empty
    // window activates itself).
    if (this.#activationSerial !== serial && this.#activeTabId !== tabId) return;
    this.#activateTab(tabId);
    this.#onChange();
  }

  async navigate(tabId: string, rawUrl: string): Promise<void> {
    const tab = await this.#ensureLiveTab(tabId);
    const url = normalizeNavigation(rawUrl, this.#settings().search.webProvider);
    if (tab.enforcer !== null && !tab.enforcer.isNavigationAllowed(url)) {
      throw new Error("navigation is outside the task capsule");
    }
    await this.#whenSessionReady(tab.info.spaceId);
    await loadTabUrl(tab.view.webContents, url);
  }

  async goBack(tabId: string): Promise<void> {
    const tab = await this.#ensureLiveTab(tabId);
    await this.#whenSessionReady(tab.info.spaceId);
    const contents = tab.view.webContents;
    if (contents.navigationHistory.canGoBack())
      contents.navigationHistory.goBack();
  }

  async goForward(tabId: string): Promise<void> {
    const tab = await this.#ensureLiveTab(tabId);
    await this.#whenSessionReady(tab.info.spaceId);
    const contents = tab.view.webContents;
    if (contents.navigationHistory.canGoForward())
      contents.navigationHistory.goForward();
  }

  async reload(tabId: string): Promise<void> {
    const tab = await this.#ensureLiveTab(tabId);
    await this.#whenSessionReady(tab.info.spaceId);
    tab.view.webContents.reload();
  }

  /** Resolves at once unless the Space is being hydrated, then when it is ready. */
  #whenSessionReady(spaceId: string): Promise<void> {
    return new Promise((resolve) => this.#gate.run(spaceId, resolve));
  }

  /**
   * The tab's page is there to be read or driven: the Space's jar is settled
   * and a first load held behind the gate has run. Without this an agent that
   * calls page_inspect straight after tab_open reads about:blank, and
   * click/type fail with 'page control not found'.
   */
  async #whenTabReady(tab: ManagedTab): Promise<void> {
    await this.#whenSessionReady(tab.info.spaceId);
    if (tab.pendingLoad !== null) await tab.pendingLoad;
  }

  async setSplit(mode: SplitMode): Promise<void> {
    const activeTabId = this.#activeTabId;
    if (activeTabId === null) return;
    const activeGroup = this.#splitGroupFor(activeTabId);
    if (mode === "single") {
      if (activeGroup !== undefined) this.#splitGroups.delete(activeGroup.id);
      this.#secondaryTabId = null;
      this.#splitMode = "single";
    } else if (activeGroup !== undefined) {
      this.#splitGroups.set(
        activeGroup.id,
        splitGroupInfo(
          activeGroup.id,
          activeGroup.tabIds,
          mode,
          activeGroup.gridLayout,
        ),
      );
      this.#activateTab(activeTabId);
    } else {
      const spaceId =
        this.#tabInfo(activeTabId)?.spaceId ?? this.activeSpaceId();
      let secondaryTabId = this.#spaceTabIds(spaceId).find(
        (tabId) =>
          tabId !== activeTabId && this.#splitGroupFor(tabId) === undefined,
      );
      if (secondaryTabId === undefined) {
        secondaryTabId = await this.#createManagedTab({
          url: this.#homeUrl(),
          kind: "human",
          runId: null,
          activate: false,
          spaceId,
        });
      }
      await this.#ensureLiveTab(secondaryTabId);
      this.#formSplit([activeTabId, secondaryTabId], mode);
    }
    this.#onChange();
  }

  /**
   * Move a tab to `index` in the tab order, where the index counts positions
   * in the list WITHOUT the moved tab (the same convention as Array.splice
   * after removing it).
   */
  reorderTab(tabId: string, index: number): void {
    const info = this.#tabInfo(tabId);
    if (info === null) return;
    const sameSpace = this.#spaceTabIds(info.spaceId).filter(
      (id) => id !== tabId,
    );
    sameSpace.splice(Math.min(index, sameSpace.length), 0, tabId);
    const otherSpaces = this.#tabOrder.filter(
      (id) => this.#tabInfo(id)?.spaceId !== info.spaceId,
    );
    this.#tabOrder.splice(
      0,
      this.#tabOrder.length,
      ...otherSpaces,
      ...sameSpace,
    );
    this.#regroupAfterMove(tabId);
    this.#onChange();
  }

  /* ------------------------------ tab groups ------------------------------ */
  // docs/tab-tidy.md §3.3 — the model is @pistachio/shell-contracts/tab-groups.

  /** Only a listed human day tab can be grouped: a pinned or favorite tab belongs to its shelf entry. */
  #groupable(info: BrowserTabInfo | null): info is BrowserTabInfo {
    return info !== null && info.kind === "human" && !info.unlisted && info.anchorId === null;
  }

  /**
   * A group lives in the Space its tabs do — the one MOST of them are in (the
   * earliest on a tie), so one tab that strays to another Space leaves the
   * group rather than taking it along.
   */
  #tabGroupSpaceId(group: TabGroupInfo): string | null {
    const counts = new Map<string, number>();
    for (const tabId of group.tabIds) {
      const info = this.#tabInfo(tabId);
      if (info !== null) counts.set(info.spaceId, (counts.get(info.spaceId) ?? 0) + 1);
    }
    let home: string | null = null;
    for (const [spaceId, count] of counts) if (home === null || count > (counts.get(home) ?? 0)) home = spaceId;
    return home;
  }

  tabGroups(spaceId = this.activeSpaceId()): TabGroupInfo[] {
    return [...this.#tabGroups.values()]
      .filter((group) => this.#tabGroupSpaceId(group) === spaceId)
      .map((group) => ({ ...group, tabIds: [...group.tabIds] }));
  }

  #setTabGroups(groups: readonly TabGroupInfo[]): void {
    this.#tabGroups.clear();
    for (const group of groups) this.#tabGroups.set(group.id, group);
  }

  /**
   * Keep the groups true to the tabs, before every publish. A tab leaves its
   * group by closing, being pinned, or moving to another Space — a dozen
   * paths, none of which need to know groups exist — and each group's tabs
   * are held together in the one tab order, which is what makes a group a
   * single row.
   */
  #reconcileTabGroups(): void {
    if (this.#tabGroups.size === 0) return;
    const gone = new Set<string>();
    for (const group of this.#tabGroups.values()) {
      const spaceId = this.#tabGroupSpaceId(group);
      for (const tabId of group.tabIds) {
        const info = this.#tabInfo(tabId);
        if (!this.#groupable(info) || info.spaceId !== spaceId) gone.add(tabId);
      }
    }
    const groups = withoutTabs([...this.#tabGroups.values()], gone);
    if (gone.size > 0) this.#setTabGroups(groups);
    const order = groupedTabOrder(this.#tabOrder, groups);
    if (order.some((tabId, index) => tabId !== this.#tabOrder[index])) this.#tabOrder.splice(0, this.#tabOrder.length, ...order);
  }

  /**
   * Form a group from day tabs of one Space (the first tab's); they leave any
   * group they were in and gather where the first of them sits.
   */
  createTabGroup(options: { id?: string; title?: string; color?: TabGroupColor; tabIds: readonly string[]; origin: TabGroupInfo["origin"] }): TabGroupInfo | null {
    const id = options.id ?? randomUUID();
    if (this.#tabGroups.has(id)) return null;
    const spaceId = this.#tabInfo(options.tabIds[0] ?? "")?.spaceId;
    const position = new Map(this.#tabOrder.map((tabId, index) => [tabId, index]));
    const tabIds = [...new Set(options.tabIds)]
      .filter((tabId) => {
        const info = this.#tabInfo(tabId);
        return this.#groupable(info) && info.spaceId === spaceId;
      })
      .sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
    if (spaceId === undefined || tabIds.length === 0) return null;
    const others = withoutTabs([...this.#tabGroups.values()], new Set(tabIds));
    const group: TabGroupInfo = {
      id,
      title: tabGroupTitle(options.title),
      color: options.color ?? nextTabGroupColor(others.filter((other) => this.#tabGroupSpaceId(other) === spaceId)),
      tabIds,
      origin: options.origin,
      open: false,
      createdAt: Date.now(),
    };
    this.#setTabGroups([...others, group]);
    return group;
  }

  /**
   * Put day tabs into a group at `index` among its tabs, counted WITHOUT the
   * tabs being put — so a tab already in the group is moved within it, the
   * same act as bringing one in. `byPerson` makes the group theirs; Tidy's
   * own additions do not. Returns the tabs that were not in it before.
   */
  addToTabGroup(groupId: string, tabIds: readonly string[], options: { index?: number; byPerson: boolean }): string[] {
    const target = this.#tabGroups.get(groupId);
    if (target === undefined) return [];
    const spaceId = this.#tabGroupSpaceId(target);
    const placed = [...new Set(tabIds)].filter((tabId) => {
      const info = this.#tabInfo(tabId);
      return this.#groupable(info) && info.spaceId === spaceId;
    });
    if (placed.length === 0) return [];
    const moving = new Set(placed);
    const added = placed.filter((tabId) => !target.tabIds.includes(tabId));
    const members = target.tabIds.filter((tabId) => !moving.has(tabId));
    members.splice(Math.min(options.index ?? members.length, members.length), 0, ...placed);
    // The others lose what came from them (and an emptied one dissolves); the
    // target is rebuilt by hand, since it is never emptied by its own tabs.
    const others = withoutTabs([...this.#tabGroups.values()].filter((group) => group.id !== groupId), new Set(added));
    this.#setTabGroups([...others, { ...target, tabIds: members, origin: options.byPerson ? "manual" : target.origin }]);
    return added;
  }

  /** Take tabs out of whatever groups hold them; each stays open, straight after the group it left. */
  removeFromTabGroups(tabIds: readonly string[]): void {
    for (const tabId of tabIds) {
      const group = tabGroupOf([...this.#tabGroups.values()], tabId);
      if (group === null) continue;
      const last = group.tabIds.filter((member) => member !== tabId).at(-1);
      this.#setTabGroups(withoutTabs([...this.#tabGroups.values()], new Set([tabId])));
      if (last === undefined) continue;
      const from = this.#tabOrder.indexOf(tabId);
      if (from >= 0) this.#tabOrder.splice(from, 1);
      this.#tabOrder.splice(this.#tabOrder.indexOf(last) + 1, 0, tabId);
    }
  }

  dissolveTabGroups(groupIds: readonly string[]): void {
    for (const groupId of groupIds) this.#tabGroups.delete(groupId);
  }

  /**
   * After a tab was moved in the row: a member that no longer touches its
   * group has been dragged out of it, and a day tab set down BETWEEN two
   * members of one group has been dragged into it. Dragging is the person's
   * own hand, so a group they drop a tab into becomes theirs.
   */
  #regroupAfterMove(tabId: string): void {
    const info = this.#tabInfo(tabId);
    if (info === null || this.#tabGroups.size === 0) return;
    const order = this.#spaceTabIds(info.spaceId);
    const at = order.indexOf(tabId);
    const groups = [...this.#tabGroups.values()];
    const groupAt = (index: number): TabGroupInfo | null => {
      const neighbour = order[index];
      return neighbour === undefined ? null : tabGroupOf(groups, neighbour);
    };
    const before = groupAt(at - 1);
    const after = groupAt(at + 1);
    const own = tabGroupOf(groups, tabId);
    if (own !== null) {
      if (before?.id === own.id || after?.id === own.id) {
        const position = new Map(order.map((id, index) => [id, index]));
        this.#tabGroups.set(own.id, { ...own, tabIds: [...own.tabIds].sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0)) });
        return;
      }
      this.#setTabGroups(withoutTabs(groups, new Set([tabId])));
    }
    if (before === null || before.id !== after?.id || before.id === own?.id || !this.#groupable(info)) return;
    const next = order[at + 1];
    this.addToTabGroup(before.id, [tabId], { index: next === undefined ? undefined : before.tabIds.indexOf(next), byPerson: true });
  }

  /** Apply one of the chrome's group commands ("close" is the caller's: it files the group in the archive). */
  async tabGroupCommand(command: Exclude<TabGroupCommand, { type: "close" }>): Promise<void> {
    switch (command.type) {
      case "create": {
        const group = this.createTabGroup({ id: command.id, title: command.title, color: command.color, tabIds: command.tabIds, origin: "manual" });
        if (group !== null && command.title === undefined) this.#nameTabGroup(group);
        break;
      }
      case "rename":
      case "recolor":
      case "setOpen": {
        const group = this.#tabGroups.get(command.groupId);
        if (group === undefined) return;
        // Their name stands: one the model is still thinking of is no longer wanted (#nameTabGroup).
        if (command.type === "rename") this.#tabGroups.set(group.id, { ...group, title: tabGroupTitle(command.title), origin: "manual", naming: false });
        else if (command.type === "recolor") this.#tabGroups.set(group.id, { ...group, color: command.color, origin: "manual" });
        else this.#tabGroups.set(group.id, { ...group, open: command.open });
        break;
      }
      case "addTab":
        this.addToTabGroup(command.groupId, [command.tabId], { index: command.index, byPerson: true });
        break;
      case "removeTab":
        this.removeFromTabGroups([command.tabId]);
        break;
      case "ungroup":
        this.dissolveTabGroups([command.groupId]);
        break;
      case "newTab": {
        const group = this.#tabGroups.get(command.groupId);
        const spaceId = group === undefined ? null : this.#tabGroupSpaceId(group);
        if (group === undefined || spaceId === null) return;
        const tabId = await this.createTab(this.#homeUrl(), { spaceId, activate: false });
        // Asked for by the person, like any other addition: the group is theirs now, and Tidy will not archive it.
        this.addToTabGroup(group.id, [tabId], { byPerson: true });
        this.#reconcileTabGroups();
        await this.selectTab(tabId);
        return;
      }
      case "openAsSplit": {
        const group = this.#tabGroups.get(command.groupId);
        if (group === undefined || this.#tabGroupSpaceId(group) !== this.activeSpaceId()) return;
        const members = splitMembersOf(group, (tabId) => this.#tabInfo(tabId)?.lastActiveAt ?? 0, MAX_SPLIT_PANES).filter(
          (tabId) => this.#tabInfo(tabId) !== null,
        );
        if (members.length < 2) return;
        await Promise.all(members.map((tabId) => this.#ensureLiveTab(tabId, { awaitLoad: false })));
        const focused = this.#activeTabId !== null && members.includes(this.#activeTabId) ? this.#activeTabId : (members[0] ?? "");
        this.#formSplit(members, members.length === 2 ? "vertical" : "grid", focused);
        break;
      }
      case "move": {
        const group = this.#tabGroups.get(command.groupId);
        const spaceId = group === undefined ? null : this.#tabGroupSpaceId(group);
        if (group === undefined || spaceId === null) return;
        const members = new Set(group.tabIds);
        const rest = this.#spaceTabIds(spaceId).filter((tabId) => !members.has(tabId));
        const day = rest.filter((tabId) => this.#groupable(this.#tabInfo(tabId)));
        const spaceGroups = this.tabGroups(spaceId).filter((other) => other.id !== group.id);
        const target = dayRowUnits(day, [...this.#splitGroups.values()], spaceGroups)[command.index]?.tabIds[0];
        rest.splice(target === undefined ? rest.length : rest.indexOf(target), 0, ...group.tabIds);
        const others = this.#tabOrder.filter((tabId) => this.#tabInfo(tabId)?.spaceId !== spaceId);
        this.#tabOrder.splice(0, this.#tabOrder.length, ...others, ...rest);
        break;
      }
    }
    this.#onChange();
  }

  /**
   * Ask for a name for a group made without one. The group is marked
   * `naming` while the model thinks — the row says so rather than showing a
   * placeholder — and takes the name only if it is still waiting for it: a
   * person who renamed it meanwhile, or closed it, has had the last word.
   */
  #nameTabGroup(group: TabGroupInfo): void {
    const tabs = group.tabIds.flatMap((tabId) => {
      const info = this.#tabInfo(tabId);
      return info === null || isShellPageUrl(info.url) ? [] : [{ title: info.title, url: info.url }];
    });
    const spaceId = this.#tabGroupSpaceId(group);
    const existing = this.tabGroups(spaceId ?? undefined).filter((other) => other.id !== group.id).map((other) => other.title);
    const asking = tabs.length === 0 ? null : (this.#hooks.nameTabGroup?.(tabs, existing) ?? null);
    if (asking === null) return;
    this.#tabGroups.set(group.id, { ...group, naming: true });
    void asking
      .catch(() => null)
      .then((name) => {
        const current = this.#tabGroups.get(group.id);
        if (current === undefined || current.naming !== true) return;
        this.#tabGroups.set(group.id, { ...current, naming: false, ...(name === null ? {} : { title: tabGroupTitle(name) }) });
        this.#onChange();
      });
  }

  /** What a tab is, as the archive keeps it: what a restart would have kept. */
  #archivedTabOf(tabId: string): ArchivedTab | null {
    const info = this.#tabInfo(tabId);
    if (info === null) return null;
    const live = this.#tabs.get(tabId);
    const history = durableTabHistory(
      live !== undefined ? (captureTabHistory(live.view.webContents, false) ?? live.history) : (this.#dormantTabs.get(tabId)?.history ?? null),
    );
    const resume = this.#pageResume.get(tabId);
    return {
      title: info.title,
      url: info.url,
      faviconUrl: info.faviconUrl,
      lastActiveAt: info.lastActiveAt,
      ...(history === null ? {} : { history }),
      ...(resume?.url === info.url ? { resume } : {}),
    };
  }

  /**
   * Close a whole group and hand back what it was, for the archive (§3.5).
   * Pages out of sight go first and quietly, so the surface changes once.
   */
  async closeTabGroup(groupId: string): Promise<{ group: TabGroupInfo; spaceId: string; tabs: ArchivedTab[] } | null> {
    const group = this.#tabGroups.get(groupId);
    const spaceId = group === undefined ? null : this.#tabGroupSpaceId(group);
    if (group === undefined) return null;
    this.#tabGroups.delete(groupId);
    if (spaceId === null) return null;
    const members = group.tabIds.filter((tabId) => this.#tabInfo(tabId) !== null);
    const tabs = members.flatMap((tabId) => {
      const tab = this.#archivedTabOf(tabId);
      return tab === null || isShellPageUrl(tab.url) ? [] : [tab];
    });
    const visible = new Set(this.#visibleTabIds());
    for (const tabId of members) if (!visible.has(tabId)) this.#discardTab(tabId);
    for (const tabId of members) if (visible.has(tabId)) await this.closeTab(tabId, { force: true });
    this.#onChange();
    return { group, spaceId, tabs };
  }

  /* --------------------------------- tidy --------------------------------- */
  // docs/tab-tidy.md — the run itself is main/tab-tidy.ts; these are the
  // things only the owner of the tabs can do for it.

  /**
   * What Tidy may look at in a Space. A loose tab is a day tab in no tab
   * group and no split; one in view, playing, loading, or never yet seen can
   * be grouped but is never `eligible` to be archived. A stale blank page is
   * not worth a model's attention or a place in the archive: it is reported
   * apart, to be closed.
   */
  tidyCandidates(spaceId: string, now: number, idleMs: number): {
    tabs: TidyTabCandidate[];
    groups: TidyGroupCandidate[];
    idleAutoGroupIds: string[];
    staleHomeTabIds: string[];
  } {
    const visible = new Set(this.activeSpaceId() === spaceId ? this.#visibleTabIds() : []);
    const idle = (info: BrowserTabInfo): boolean =>
      idleMs > 0 && info.lastActiveAt > 0 && now - info.lastActiveAt >= idleMs && !visible.has(info.id) && !this.#media.has(info.id) && !info.loading && info.runId === null;
    const groups = this.tabGroups(spaceId);
    const grouped = new Set(groups.flatMap((group) => group.tabIds));
    const tabs: TidyTabCandidate[] = [];
    const staleHomeTabIds: string[] = [];
    for (const tabId of this.#spaceTabIds(spaceId)) {
      const info = this.#tabInfo(tabId);
      if (!this.#groupable(info) || grouped.has(tabId) || info.runId !== null || this.#splitGroupFor(tabId) !== undefined) continue;
      if (isHomeUrl(info.url)) {
        if (idle(info)) staleHomeTabIds.push(tabId);
        continue;
      }
      // The daily brief is the shell's own page: nothing for the model to
      // sort, and not the person's browsing to describe to it.
      if (isShellPageUrl(info.url)) continue;
      tabs.push({ id: tabId, title: info.title, url: info.url, lastActiveAt: info.lastActiveAt, eligible: idle(info) });
    }
    return {
      tabs,
      groups: groups.map((group) => ({ id: group.id, title: group.title, tabCount: group.tabIds.length })),
      idleAutoGroupIds: groups
        .filter((group) => group.origin === "auto" && group.tabIds.every((tabId) => {
          const info = this.#tabInfo(tabId);
          return info !== null && idle(info) && this.#splitGroupFor(tabId) === undefined;
        }))
        .map((group) => group.id),
      staleHomeTabIds,
    };
  }

  /**
   * Close tabs for the archive and say what each was and where it sat. No
   * "recently closed", no successor to choose: a tab in view, playing, or
   * owned by a run is refused here too, whatever the plan said.
   */
  archiveTabs(tabIds: readonly string[]): Array<{ tabId: string; index: number; tab: ArchivedTab }> {
    const visible = new Set(this.#visibleTabIds());
    const archived: Array<{ tabId: string; index: number; tab: ArchivedTab }> = [];
    for (const tabId of tabIds) {
      const info = this.#tabInfo(tabId);
      if (!this.#groupable(info) || visible.has(tabId) || this.#media.has(tabId) || info.runId !== null) continue;
      const tab = this.#archivedTabOf(tabId);
      if (tab === null) continue;
      archived.push({ tabId, index: this.#spaceTabIds(info.spaceId).indexOf(tabId), tab });
      this.#discardTab(tabId);
    }
    return archived;
  }

  /**
   * Bring archived tabs back as sleeping tabs — instant, and each wakes with
   * its stack and checkpoint when it is next shown. `indexes` puts each where
   * it sat in the Space's row (an Undo); without it they join the end.
   */
  restoreArchivedTabs(spaceId: string, tabs: readonly ArchivedTab[], indexes?: readonly number[]): string[] {
    if (this.#spaceStore.get(spaceId) === null) return [];
    return tabs.map((tab, i) => {
      const id = randomUUID();
      if (tab.resume) this.#pageResume.set(id, tab.resume);
      this.#dormantTabs.set(id, {
        info: {
          id,
          spaceId,
          title: tab.title,
          url: tab.url,
          faviconUrl: tab.faviconUrl,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          kind: "human",
          runId: null,
          anchorId: null,
          lifecycle: "suspended",
          lastActiveAt: Date.now(),
          unlisted: false,
        },
        history: tab.history ?? null,
      });
      const before = indexes === undefined ? undefined : this.#spaceTabIds(spaceId)[indexes[i] ?? Number.MAX_SAFE_INTEGER];
      if (before === undefined) this.#tabOrder.push(id);
      else this.#tabOrder.splice(this.#tabOrder.indexOf(before), 0, id);
      return id;
    });
  }

  /**
   * Send favorites that wandered back to their address (§3.7). The tab is put
   * to sleep and re-addressed rather than navigated: nothing loads until the
   * favorite is next opened, and the page it was on stays one Back away.
   */
  async resetFavoriteTabs(
    spaceId: string,
    homeOf: (anchorId: string) => { url: string; title: string } | null,
    now: number,
    minIdleMs: number,
  ): Promise<Array<{ tabId: string; url: string; title: string; history: TabHistory | null }>> {
    const visible = new Set(this.activeSpaceId() === spaceId ? this.#visibleTabIds() : []);
    const reset: Array<{ tabId: string; url: string; title: string; history: TabHistory | null }> = [];
    for (const tabId of this.#spaceTabIds(spaceId)) {
      const info = this.#tabInfo(tabId);
      if (info === null || info.anchorId === null || info.kind !== "human" || info.runId !== null) continue;
      if (visible.has(tabId) || this.#media.has(tabId) || now - info.lastActiveAt < minIdleMs) continue;
      const home = homeOf(info.anchorId);
      if (home === null || sameAddress(info.url, home.url)) continue;
      if (this.#tabs.has(tabId)) await this.suspendTab(tabId);
      const dormant = this.#dormantTabs.get(tabId);
      if (dormant === undefined) continue;
      reset.push({ tabId, url: dormant.info.url, title: dormant.info.title, history: dormant.history });
      const stack = dormant.history ?? { entries: [{ url: dormant.info.url, title: dormant.info.title }], index: 0 };
      const entries = [...stack.entries.slice(0, stack.index + 1), { url: home.url, title: home.title }];
      dormant.history = { entries, index: entries.length - 1 };
      dormant.info = { ...dormant.info, url: home.url, title: home.title || dormant.info.title };
      this.#pageResume.delete(tabId);
    }
    return reset;
  }

  /** Undo of the above: a favorite still asleep at its home address goes back to where it had been. */
  restoreFavoriteTabs(previous: ReadonlyArray<{ tabId: string; url: string; title: string; history: TabHistory | null }>): void {
    for (const was of previous) {
      const dormant = this.#dormantTabs.get(was.tabId);
      if (dormant === undefined) continue;
      dormant.history = was.history;
      dormant.info = { ...dormant.info, url: was.url, title: was.title };
    }
  }

  /** A Space's tabs in row order — what a Tidy run records before it groups anything. */
  tabOrderOf(spaceId: string): string[] {
    return this.#spaceTabIds(spaceId);
  }

  /**
   * Put a Space's tabs back in a recorded order (Tidy's undo: forming a group
   * gathers its tabs, and dissolving it does not scatter them again). Tabs
   * the record does not know — opened since — follow, as new tabs do; ids it
   * names that are gone are skipped.
   */
  restoreTabOrder(spaceId: string, order: readonly string[]): void {
    const current = this.#spaceTabIds(spaceId);
    const here = new Set(current);
    const known = new Set(order);
    const next = [...new Set(order)].filter((tabId) => here.has(tabId));
    next.push(...current.filter((tabId) => !known.has(tabId)));
    const others = this.#tabOrder.filter((tabId) => !here.has(tabId));
    this.#tabOrder.splice(0, this.#tabOrder.length, ...others, ...next);
  }

  /** Tell everyone after a batch of the primitives above (they do not publish one by one). */
  commitTidy(): void {
    this.#applyLayout();
    this.#onChange();
    this.persistSession();
  }

  /** Add or reposition a tab at one edge of the active 2–4 pane group. */
  async splitWith(tabId: string, side: SplitSide): Promise<void> {
    const info = this.#tabInfo(tabId);
    if (info === null || info.spaceId !== this.activeSpaceId()) return;
    const active = this.#activeTabId;
    const linearMode: SplitOrientation =
      side === "top" || side === "bottom" ? "horizontal" : "vertical";
    if (active === null) {
      await this.setSplit(linearMode);
      return;
    }
    const activeGroup = this.#splitGroupFor(active);
    const atStart = side === "left" || side === "top";
    // The capacity check runs before any duplicate is created, so a full
    // group refuses the drop without leaving an orphan copy behind.
    const addsPane =
      active === tabId ||
      (activeGroup !== undefined && !activeGroup.tabIds.includes(tabId));
    if (
      activeGroup !== undefined &&
      addsPane &&
      activeGroup.tabIds.length >= MAX_SPLIT_PANES
    ) {
      throw new Error("Split views can contain up to four tabs.");
    }
    // The active page dropped onto its own surface splits with a fresh copy
    // of itself rather than pulling in an unrelated tab: the duplicate is
    // the new pane on the dropped edge, and the original keeps its pane.
    const paneTabId =
      active === tabId ? await this.duplicateTab(tabId, false) : tabId;
    await this.#ensureLiveTab(paneTabId);
    const existing = activeGroup?.tabIds.filter(
      (candidate) => candidate !== paneTabId,
    ) ?? [active];
    const tabIds = atStart
      ? [paneTabId, ...existing]
      : [...existing, paneTabId];
    const mode: SplitOrientation =
      tabIds.length === 3 || activeGroup?.mode === "grid" ? "grid" : linearMode;
    const gridLayout =
      tabIds.length === 3
        ? gridLayoutForSide(side)
        : (activeGroup?.gridLayout ?? gridLayoutForSide(side));
    this.#formSplit(
      tabIds,
      mode,
      atStart ? paneTabId : active,
      activeGroup?.id,
      gridLayout,
    );
    this.#onChange();
  }

  /**
   * Take a tab out of its split group without closing it. The page stays
   * open as an ordinary background tab; the remaining pane(s) keep the
   * surface, and a two-pane group dissolves the way it does when a member
   * closes.
   */
  removeFromSplit(tabId: string): void {
    const group = this.#splitGroupFor(tabId);
    if (group === undefined) return;
    const remaining = group.tabIds.filter((candidate) => candidate !== tabId);
    if (remaining.length >= 2) {
      this.#splitGroups.set(
        group.id,
        splitGroupInfo(group.id, remaining, group.mode, group.gridLayout),
      );
    } else {
      this.#splitGroups.delete(group.id);
    }
    if (this.#activeTabId === tabId) {
      // The removed pane held the focus: focus moves to the first surviving
      // pane so the group — not the removed tab — keeps the surface.
      const survivor = remaining[0];
      if (survivor !== undefined) this.#activateTab(survivor);
    } else if (
      this.#activeTabId !== null &&
      group.tabIds.includes(this.#activeTabId)
    ) {
      // Refresh secondary/mode bookkeeping for the shrunken group.
      this.#activateTab(this.#activeTabId);
    }
    this.#onChange();
  }

  /** The saved split group containing a tab, visible or not. */
  #splitGroupFor(tabId: string): SplitGroupInfo | undefined {
    for (const group of this.#splitGroups.values()) {
      if (group.tabIds.includes(tabId)) return group;
    }
    return undefined;
  }

  #visibleTabIds(): string[] {
    if (this.#activeTabId === null) return [];
    const group = this.#splitGroupFor(this.#activeTabId);
    return group === undefined ? [this.#activeTabId] : [...group.tabIds];
  }

  /** Activate a lone tab or restore its entire saved split group. */
  #activateTab(tabId: string): void {
    const target = this.#tabs.get(tabId);
    if (target === undefined) return;
    this.#activationSerial += 1;
    this.#recentTabIdsBySpace.set(
      target.info.spaceId,
      recordTabVisit(
        this.#recentTabIdsBySpace.get(target.info.spaceId) ?? [],
        tabId,
      ),
    );
    const previousActiveTabId = this.#activeTabId;
    target.info.lastActiveAt = Date.now();
    target.info.lifecycle = "live";
    if (previousActiveTabId !== null && previousActiveTabId !== tabId)
      this.#cancelPasskeysForTab(previousActiveTabId);
    // Like Chrome, moving to another tab ends the fullscreen presentation;
    // the page's leave-html-full-screen then reveals the new selection.
    if (this.#fullscreenTabId !== null && this.#fullscreenTabId !== tabId)
      this.#exitHtmlFullscreen();
    const group = this.#splitGroupFor(tabId);
    if (group === undefined) {
      this.#activeTabId = tabId;
      this.#lastActiveTabBySpace.set(target.info.spaceId, tabId);
      this.#secondaryTabId = null;
      this.#splitMode = "single";
    } else {
      // Pane order belongs to the group; focusing any member must not move it.
      this.#activeTabId = tabId;
      this.#lastActiveTabBySpace.set(target.info.spaceId, tabId);
      this.#secondaryTabId =
        group.tabIds.find((candidate) => candidate !== tabId) ?? null;
      this.#splitMode = group.mode;
    }
    if (previousActiveTabId !== tabId) this.#settleBackgroundVideos();
    this.#emitBrowserControls();
  }

  /** Form or replace one split group, preserving unrelated members of source groups. */
  #formSplit(
    requestedTabIds: readonly string[],
    mode: SplitOrientation,
    focusedTabId = requestedTabIds[0] ?? "",
    requestedGroupId?: string,
    gridLayout: SplitGridLayout = "span-bottom",
  ): void {
    const tabIds = [...new Set(requestedTabIds)];
    if (tabIds.length < 2 || tabIds.length > MAX_SPLIT_PANES) return;
    const tabs = tabIds.map((tabId) => this.#tabs.get(tabId));
    const spaceId = tabs[0]?.info.spaceId;
    if (
      spaceId === undefined ||
      tabs.some((tab) => tab === undefined || tab.info.spaceId !== spaceId)
    )
      return;
    const groupId = requestedGroupId ?? randomUUID();
    for (const tabId of tabIds) {
      const oldGroup = this.#splitGroupFor(tabId);
      if (oldGroup === undefined || oldGroup.id === groupId) continue;
      const remaining = oldGroup.tabIds.filter(
        (candidate) => candidate !== tabId,
      );
      if (remaining.length >= 2) {
        this.#splitGroups.set(
          oldGroup.id,
          splitGroupInfo(
            oldGroup.id,
            remaining,
            oldGroup.mode,
            oldGroup.gridLayout,
          ),
        );
      } else {
        this.#splitGroups.delete(oldGroup.id);
      }
    }
    const group = splitGroupInfo(groupId, tabIds, mode, gridLayout);
    this.#splitGroups.set(group.id, group);
    for (const tab of tabs) {
      const anchorId = tab?.info.anchorId ?? null;
      if (tab !== undefined && anchorId !== null && this.anchorLeavesOnSplit(anchorId, spaceId))
        this.setAnchor(tab.info.id, null);
    }
    this.#activateTab(
      tabIds.includes(focusedTabId) ? focusedTabId : tabIds[0]!,
    );
  }

  setLayout(layout: BrowserLayout): void {
    const preview = this.#mediaPreview;
    // A tab back in a pane shows its own page again, not the sidebar's
    // picture of it.
    if (preview !== null && layout.views.some(({ tabId }) => tabId === preview.tabId))
      this.#clearMediaPreview();
    this.#layout = layout;
    this.#applyLayout();
  }

  /**
   * Capture the live panes without hiding them. The shell decodes and paints
   * these frames first, then calls setOverlay(true): the native-to-still swap
   * is between identical composited frames instead of exposing a blank pane.
   */
  async prepareOverlay(): Promise<PaneStill[]> {
    const request = ++this.#overlayRequest;
    if (this.#overlayActive) return [];
    // A modal over a fullscreen video would veil the whole screen; end the
    // presentation the way Chrome does when its own UI comes up.
    this.#exitHtmlFullscreen();
    const stills = await this.#captureVisibleStills("jpeg");
    // A later prepare or lower owns the hand-off now.
    if (request !== this.#overlayRequest) return [];
    this.#overlayPreparedRequest = request;
    return stills;
  }

  /** Commit a prepared raise, or lower immediately and cancel any preparation. */
  setOverlay(active: boolean): void {
    if (!active) {
      ++this.#overlayRequest;
      this.#overlayPreparedRequest = null;
      this.#overlayActive = false;
      this.#applyLayout();
      return;
    }
    if (this.#overlayActive) return;
    if (this.#overlayPreparedRequest !== this.#overlayRequest) return;
    this.#overlayPreparedRequest = null;
    this.#overlayActive = true;
    this.#applyLayout();
  }

  async #captureVisibleStills(
    format: StillFormat = "png",
  ): Promise<PaneStill[]> {
    const captures = this.#layout.views.map(async ({ tabId }): Promise<PaneStill | null> => {
      const tab = this.#tabs.get(tabId);
      if (
        tab === undefined ||
        !tab.view.getVisible() ||
        tab.view.webContents.isDestroyed() ||
        // The shell draws the home page and the brief itself; the view has nothing to show.
        isShellPageUrl(tab.info.url)
      )
        return null;
      try {
        const image = await tab.view.webContents.capturePage();
        if (image.isEmpty()) return null;
        const still = fitStillToView(image, tab.view.getBounds().width);
        return { tabId, dataUrl: encodeStill(still, format) };
      } catch {
        // A pane that cannot be captured simply shows its background.
        return null;
      }
    });
    return (await Promise.all(captures)).filter((still): still is PaneStill => still !== null);
  }

  async #captureTabSwitcherPreview(
    tab: ManagedTab,
  ): Promise<TabSwitcherPreview> {
    let dataUrl: string | null = null;
    if (!tab.view.webContents.isDestroyed()) {
      try {
        const image = await tab.view.webContents.capturePage();
        if (!image.isEmpty()) {
          // Never wider than the switcher's tile, and never wider than the
          // view's CSS box, which a HiDPI capture exceeds by the scale factor.
          const width = Math.min(420, tab.view.getBounds().width || 420);
          const preview = fitStillToView(image, width);
          dataUrl = `data:image/jpeg;base64,${preview.toJPEG(80).toString("base64")}`;
        }
      } catch {
        // A loading, crashed, or GPU-unavailable page gets the designed fallback tile.
      }
    }
    return { tab: { ...tab.info }, dataUrl };
  }

  /** The live tab whose page is in HTML fullscreen. */
  #fullscreenTab(): ManagedTab | null {
    if (this.#fullscreenTabId === null) return null;
    const tab = this.#tabs.get(this.#fullscreenTabId);
    if (tab === undefined || tab.view.webContents.isDestroyed()) return null;
    return tab;
  }

  /**
   * The fullscreen page is being taken down (closed, suspended, or moved to
   * another space) without leaving fullscreen. Forget it, and if it was the
   * page that took the window fullscreen, bring the window back — once any
   * transition still running has ended (see #windowFullScreenSettled).
   */
  #releaseFullscreen(tabId: string): void {
    if (this.#fullscreenTabId !== tabId) return;
    this.#fullscreenTabId = null;
    this.#fullscreenExitPending = false;
    // The page never left fullscreen for itself, so nothing has undone what
    // entering it did: the card's corners are still square, and every other
    // pane is still hidden under the one page that owned the whole content
    // box. Undo both here rather than in each caller — when the page found
    // the window already fullscreen there is no window transition coming,
    // and so no later pass that would put the panes back.
    this.#tabs.get(tabId)?.view.setBorderRadius(this.#settings().appearance.radius);
    if (this.#fullscreenTookWindow && this.#window.isFullScreen()) {
      if (!this.#windowFullScreenSettled) {
        this.#windowReleasePending = true;
        this.#applyLayout();
        return;
      }
      this.#window.setFullScreen(false);
    }
    this.#applyLayout();
  }

  /**
   * Ask the fullscreen page to leave fullscreen. There is no main-process
   * call for this: only the page can exit, and exiting from the top document
   * also ends fullscreen for an embedded player in a frame. The page's
   * leave-html-full-screen then restores the layout.
   */
  #exitHtmlFullscreen(): void {
    const tab = this.#fullscreenTab();
    if (tab === null) return;
    if (this.#window.isFullScreen() && !this.#windowFullScreenSettled) {
      this.#fullscreenExitPending = true;
      return;
    }
    void tab.view.webContents
      .executeJavaScript(
        "document.fullscreenElement !== null && document.exitFullscreen().catch(() => {})",
        true,
      )
      .catch(() => {
        // A crashed or navigating page has nothing left to exit.
      });
  }

  #applyLayout(): void {
    const layout = this.#layout;
    const fullscreen = this.#fullscreenTab();
    if (fullscreen !== null) {
      // One page owns the whole content box, above the pane layout the
      // renderer reports; every other page and the Glance stay out of sight
      // until it leaves fullscreen.
      const { width, height } = this.#window.getContentBounds();
      for (const tab of this.#tabs.values())
        if (tab !== fullscreen) settleViewVisible(tab.view, false);
      if (this.#glance !== null) settleViewVisible(this.#glance.tab.view, false);
      settleViewBounds(fullscreen.view, {
        x: 0,
        y: 0,
        width: Math.max(1, width),
        height: Math.max(1, height),
      });
      settleViewVisible(fullscreen.view, !this.#overlayActive);
      this.#syncMediaPresentation(null);
      return;
    }
    const visible = new Set(layout.views.map(({ tabId }) => tabId));
    let presented: { tab: ManagedTab; bounds: ContentBounds } | null = null;
    for (const [tabId, tab] of this.#tabs) {
      const panePlacement = layout.views.find(
        (candidate) => candidate.tabId === tabId,
      );
      const previewPlacement = this.#mediaPreview?.tabId === tabId ? this.#mediaPreview : null;
      const placement = panePlacement ?? previewPlacement;
      if (
        placement === undefined ||
        placement === null ||
        placement.bounds.width < 1 ||
        placement.bounds.height < 1
      ) {
        settleViewVisible(tab.view, false);
        continue;
      }
      const bounds = {
        x: Math.max(0, Math.round(placement.bounds.x)),
        y: Math.max(0, Math.round(placement.bounds.y)),
        width: Math.max(1, Math.round(placement.bounds.width)),
        height: Math.max(1, Math.round(placement.bounds.height)),
      };
      if (panePlacement !== undefined)
        this.#paneSizes.set(tabId, { width: bounds.width, height: bounds.height });
      settleViewBounds(tab.view, bounds);
      // A pane comes down for a raised overlay (its still is painted under
      // the modal) and while a Glance's owner is recessed — until the shell
      // has its still painted. The sidebar's video card is neither: it sits
      // beside the page, not under what is drawn over it, so the page it
      // presents stays live through a Glance or a settings page. The shell
      // drops the preview itself when something paints over the sidebar
      // (components/MediaStack.tsx).
      // A shell-drawn page (home, the brief) is the shell's drawing in this
      // pane's box: its own view stays down under it
      // (@pistachio/shell-contracts/shell-pages).
      const shown =
        !isShellPageUrl(tab.info.url) &&
        !this.#waking.has(tabId) &&
        (panePlacement !== undefined
          ? !this.#overlayActive &&
            this.#glance?.ownerRecessed !== true &&
            visible.has(tabId)
          : previewPlacement !== null);
      settleViewVisible(tab.view, shown);
      if (shown && panePlacement === undefined && previewPlacement !== null)
        presented = { tab, bounds };
    }
    this.#syncMediaPresentation(presented);
    this.#handKeyboardToShell();
    const glance = this.#glance;
    if (glance !== null) {
      if (glance.bounds !== null) settleViewBounds(glance.tab.view, glance.bounds);
      // Bounds go null when the shell takes the view down for its closing
      // flight; until then a layout pass must not hide a page mid-capture.
      settleViewVisible(
        glance.tab.view,
        !this.#overlayActive && glance.bounds !== null,
      );
    }
  }

  /**
   * The shell's own document takes the keyboard whenever what is on screen
   * is the shell's drawing: a shell-drawn page — the home page, the daily
   * brief — (drawn in the pane, its tab's view kept down under it —
   * @pistachio/shell-contracts/shell-pages) and a raised
   * overlay (the address bar, settings, the tab switcher: the panes under it
   * are stills). A tab view that still holds the keyboard then — the page ⌘L
   * or ⌘T was pressed over, hidden now — would take the typing the shell's
   * focused field is waiting for, into a page nobody can see. And hiding a
   * view can drop its focus on the floor instead, leaving nobody with the
   * keyboard; the shell takes it then too. A hidden view never rightly keeps
   * the keyboard, whatever is showing.
   */
  #handKeyboardToShell(): void {
    const active = this.#activeTabId === null ? undefined : this.#tabs.get(this.#activeTabId);
    const shellOwns = this.#overlayActive || (active !== undefined && isShellPageUrl(active.info.url));
    for (const tab of this.#tabs.values()) {
      const contents = tab.view.webContents;
      if (contents.isDestroyed() || !contents.isFocused()) continue;
      if (shellOwns || !tab.view.getVisible()) this.#hooks.focusShell?.();
      return;
    }
    if (
      shellOwns &&
      this.#window.isFocused() &&
      !this.#window.webContents.isDestroyed() &&
      !this.#window.webContents.isFocused()
    )
      this.#hooks.focusShell?.();
  }

  /**
   * Put the sidebar card's page into — or take it out of — its presentation.
   *
   * The card is a fraction of the pane the page was laid out in, so sizing
   * the view to it would resize the DOCUMENT: a responsive site re-lays out
   * at ~230px, a virtualized feed recycles the rows around the scroll offset
   * (taking the playing element out of the document with them), and the
   * offset the person left behind is gone by the time they come back. So the
   * view shrinks but the page does not: Chromium's own view emulation keeps
   * the pane-sized viewport and draws it scaled into the card, which is the
   * one change a page cannot notice. The page's slice of that viewport is
   * the card-shaped band at its top, and `aspect` is what tells the preload
   * to lay its video into exactly that band.
   */
  #syncMediaPresentation(
    presented: { tab: ManagedTab; bounds: ContentBounds } | null,
  ): void {
    const next = presented === null ? null : this.#presentationFor(presented);
    const previous = this.#presentation;
    if (
      previous?.tabId === next?.tabId &&
      previous?.aspect === next?.aspect &&
      previous?.scale === next?.scale &&
      previous?.viewport?.width === next?.viewport?.width &&
      previous?.viewport?.height === next?.viewport?.height
    ) {
      return;
    }
    if (previous !== null && previous.tabId !== next?.tabId) this.#releasePresentation(previous);
    this.#presentation = next;
    if (next === null || presented === null) return;
    const contents = presented.tab.view.webContents;
    this.#cancelPresentationRelease(next.tabId);
    if (next.viewport !== null) {
      contents.enableDeviceEmulation({
        screenPosition: "desktop",
        screenSize: { width: 0, height: 0 },
        viewPosition: { x: 0, y: 0 },
        deviceScaleFactor: 0,
        viewSize: next.viewport,
        scale: next.scale,
      });
    } else if (previous !== null && previous.viewport !== null) {
      contents.disableDeviceEmulation();
    }
    contents.send(IPC.mediaPresentation, { aspect: next.aspect } satisfies MediaPresentation);
  }

  /**
   * Hand a page back the viewport it keeps while presented.
   *
   * The view's own box has to come back first — the page is leaving the card
   * either for its pane or for no placement at all, and clearing the
   * emulation over a card-sized view is what would finally hand the document
   * the card's size, which is the reflow this whole path exists to avoid.
   * That box travels to the renderer through the compositor while the
   * emulation IPC goes straight there, so it can arrive second: hold the
   * viewport at the pane, one-to-one, and clear the override only once the
   * new box has had time to land.
   */
  #releasePresentation(previous: InstalledPresentation): void {
    const tab = this.#tabs.get(previous.tabId);
    if (tab === undefined || tab.view.webContents.isDestroyed()) return;
    const contents = tab.view.webContents;
    contents.send(IPC.mediaPresentation, null);
    if (previous.viewport === null) return;
    const pane = this.#paneSizes.get(previous.tabId) ?? previous.viewport;
    if (!this.#layout.views.some(({ tabId }) => tabId === previous.tabId)) {
      const { x, y } = tab.view.getBounds();
      tab.view.setBounds({ x, y, width: pane.width, height: pane.height });
    }
    contents.enableDeviceEmulation({
      screenPosition: "desktop",
      screenSize: { width: 0, height: 0 },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize: pane,
      scale: 1,
    });
    this.#cancelPresentationRelease(previous.tabId);
    this.#presentationReleases.set(
      previous.tabId,
      setTimeout(() => {
        this.#presentationReleases.delete(previous.tabId);
        if (!contents.isDestroyed()) contents.disableDeviceEmulation();
      }, PRESENTATION_RELEASE_MS),
    );
  }

  #cancelPresentationRelease(tabId: string): void {
    const timer = this.#presentationReleases.get(tabId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#presentationReleases.delete(tabId);
  }

  /** The emulation and band a card of these bounds asks of its page. */
  #presentationFor({
    tab,
    bounds,
  }: {
    tab: ManagedTab;
    bounds: ContentBounds;
  }): InstalledPresentation {
    const pane = this.#paneSizes.get(tab.info.id);
    const aspect = rounded(bounds.height / bounds.width);
    // A page that has never been laid out in a pane has no viewport worth
    // keeping, so the card simply is its viewport, and the band is all of it.
    if (pane === undefined || pane.width < 1 || pane.height < 1)
      return { tabId: tab.info.id, aspect, scale: 1, viewport: null };
    return {
      tabId: tab.info.id,
      aspect,
      scale: rounded(bounds.width / pane.width),
      viewport: pane,
    };
  }

  async captureContext(tabId: string): Promise<CapturedPageContext> {
    const value = await this.#requireTab(tabId).view.webContents
      .executeJavaScript(`(() => ({
      selectedText: String(globalThis.getSelection?.()?.toString() ?? "").slice(0, 12000),
      formState: [...document.querySelectorAll("input, textarea, select")]
        .filter((element) => !(element instanceof HTMLInputElement) || !["hidden", "password"].includes(element.type))
        .map((element) => ({
        name: element.getAttribute("name") || element.id || "unnamed",
        type: element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase(),
        value: String(element.value ?? "").slice(0, 8000),
        })),
    }))()`);
    return value as CapturedPageContext;
  }

  /**
   * Read a compact, semantic view of a live page for the conversational agent.
   * This deliberately goes through the tab's existing WebContents so the
   * agent sees the same authenticated session and page state as the person.
   */
  async inspectPage(tabId: string): Promise<PageInspection> {
    const tab = this.#requireTab(tabId);
    await this.#whenTabReady(tab);
    return tab.view.webContents.executeJavaScript(INSPECT_PAGE_SCRIPT) as Promise<PageInspection>;
  }

  /**
   * What a page says about itself, for a bookmark (@pistachio/shell-contracts/bookmarks
   * PageSnapshot): its meta tags, JSON-LD, the pictures it shows largest,
   * and an excerpt of its text — read through the tab's own WebContents,
   * so a page behind a sign-in is read as the person sees it.
   */
  async capturePage(tabId: string): Promise<PageSnapshot> {
    const value: unknown = await this.#requireTab(tabId).view.webContents.executeJavaScript(`(() => {
      const absolute = (raw) => {
        if (!raw) return null;
        try {
          const url = new URL(raw, document.baseURI);
          return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
        } catch {
          return null;
        }
      };
      const meta = [...document.querySelectorAll("meta[property], meta[name], meta[itemprop]")]
        .map((tag) => ({
          name: String(tag.getAttribute("property") || tag.getAttribute("name") || tag.getAttribute("itemprop") || "").trim().toLowerCase(),
          content: String(tag.getAttribute("content") || "").replace(/\\s+/g, " ").trim().slice(0, 2000),
        }))
        .filter((tag) => tag.name !== "" && tag.content !== "")
        .slice(0, ${String(MAX_PAGE_META)});
      const links = [...document.querySelectorAll("link[rel][href]")]
        .map((tag) => ({ rel: String(tag.getAttribute("rel") || "").trim().toLowerCase(), href: absolute(tag.getAttribute("href")) }))
        .filter((tag) => tag.rel !== "" && tag.href !== null)
        .slice(0, 40);
      const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')]
        .map((script) => {
          try {
            return JSON.parse(script.textContent || "");
          } catch {
            return null;
          }
        })
        .filter((block) => block !== null)
        .slice(0, ${String(MAX_PAGE_JSON_LD)});
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const pictures = [...document.images]
        .map((image) => {
          const rect = image.getBoundingClientRect();
          const src = absolute(image.currentSrc || image.src);
          const width = rect.width || image.naturalWidth;
          const height = rect.height || image.naturalHeight;
          const onScreen = rect.bottom > 0 && rect.top < viewport.height * 3;
          return { src, area: width * height, onScreen, square: Math.min(width, height) };
        })
        .filter((image) => image.src !== null && image.square >= 120 && !/\\b(sprite|icon|logo|pixel|spacer|tracking|badge|avatar)\\b/i.test(image.src))
        .sort((a, b) => Number(b.onScreen) - Number(a.onScreen) || b.area - a.area);
      const images = [];
      for (const picture of pictures) {
        if (!images.includes(picture.src)) images.push(picture.src);
        if (images.length >= ${String(MAX_PAGE_IMAGES)}) break;
      }
      const headline = String(document.querySelector("h1")?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 300);
      const text = String(document.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, ${String(MAX_PAGE_TEXT)});
      return {
        url: location.href,
        title: document.title,
        lang: document.documentElement.lang || "",
        meta,
        links,
        jsonLd,
        headline,
        images,
        text,
      };
    })()`);
    if (typeof value !== "object" || value === null) throw new Error("the page could not be read");
    return value as PageSnapshot;
  }

  /**
   * A page's HTML fetched over the active Space's session — its cookies,
   * so a listing behind a sign-in reads as the person would see it — for a
   * bookmark of an address that has no tab. Capped: a page is read for its
   * head and an excerpt, not archived.
   *
   * Every address in the chain is cleared before it is asked for, the first
   * and each redirect alike (`assertPublicUrl`). This read carries the
   * person's cookies to an address they did not choose — the agent names it,
   * and the agent may be acting on what some page told it — so an address
   * pointing back at this machine, its network, or a cloud metadata endpoint
   * would otherwise reach a private service with their credentials attached
   * and feed what it says to the model. Each hop is dialled at the address
   * that cleared, not at the name — the one exception being a hop that
   * really leaves through the identity gateway, which resolves and re-vets
   * the target itself and which Chromium never resolves for.
   */
  async fetchPageHtml(url: string, maxBytes = 2_000_000): Promise<string> {
    const spaceId = this.activeSpaceId();
    const partition = session.fromPartition(spacePartition(spaceId));
    const deadline = AbortSignal.timeout(PAGE_READ_TIMEOUT_MS);
    return readPageChain(
      url,
      partition,
      (vetted) => this.#requestPageThroughSession(partition, spaceId, vetted, deadline, maxBytes),
      async (vetted, pinned) =>
        requestPage(vetted, pinned, await pageReadHeaders(partition, vetted), deadline, maxBytes),
    );
  }

  /**
   * One hop through the Space session (§10.3): `net.request` with the
   * session's cookies and proxy rules, a per-request `login` listener that
   * answers ONLY the gateway's proxy challenge with the egress credential, a
   * redirect reported rather than followed (the caller vets the next
   * address), and the body cut at `maxBytes`. A second proxy challenge means
   * the credential was refused: the read fails and the credential is
   * refreshed for the next one.
   */
  #requestPageThroughSession(
    partition: Session,
    spaceId: string,
    url: URL,
    signal: AbortSignal,
    maxBytes: number,
  ): Promise<PageRead> {
    return new Promise<PageRead>((resolve, reject) => {
      const request = net.request({
        session: partition,
        url: url.href,
        method: "GET",
        useSessionCookies: true,
        redirect: "manual",
        headers: {
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "user-agent": partition.getUserAgent(),
        },
      });
      let settled = false;
      const finish = (run: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onDeadline);
        run();
      };
      const onDeadline = (): void => {
        finish(() => reject(new Error("the page took too long to read")));
        request.abort();
      };
      if (signal.aborted) {
        onDeadline();
        return;
      }
      signal.addEventListener("abort", onDeadline, { once: true });
      let challenges = 0;
      request.on("login", (authInfo, callback) => {
        const credential = this.#hooks.proxyCredentialFor?.(spaceId) ?? null;
        const ours =
          credential !== null &&
          authInfo.isProxy &&
          authInfo.host === credential.host &&
          authInfo.port === credential.port;
        if (!ours) {
          // An origin's own challenge, or another proxy: never the egress credential.
          callback();
          return;
        }
        challenges += 1;
        if (challenges > 1) {
          this.#hooks.onProxyCredentialRejected?.(spaceId);
          callback();
          finish(() => reject(new Error("the identity gateway refused this Mac's credential")));
          request.abort();
          return;
        }
        callback(credential.username, credential.password);
      });
      request.on("redirect", (_status, _method, redirectUrl) => {
        finish(() => resolve({ html: "", redirectTo: redirectUrl }));
        request.abort();
      });
      request.on("response", (response) => {
        const status = response.statusCode;
        if (status < 200 || status >= 300) {
          finish(() => reject(new Error(`the page answered ${String(status)}`)));
          request.abort();
          return;
        }
        const rawType = response.headers["content-type"];
        const type = Array.isArray(rawType) ? (rawType[0] ?? "") : String(rawType ?? "");
        if (type !== "" && !/text\/html|application\/xhtml/i.test(type)) {
          finish(() => reject(new Error(`not a web page (${type})`)));
          request.abort();
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        const html = (): string => Buffer.concat(chunks).toString("utf8");
        response.on("data", (chunk: Buffer) => {
          if (received >= maxBytes) return;
          const slice = chunk.length > maxBytes - received ? chunk.subarray(0, maxBytes - received) : chunk;
          chunks.push(slice);
          received += slice.length;
          if (received >= maxBytes) {
            finish(() => resolve({ html: html() }));
            request.abort();
          }
        });
        response.on("end", () => finish(() => resolve({ html: html() })));
        response.on("error", () => finish(() => resolve({ html: html() })));
      });
      request.on("error", (error: Error) => finish(() => reject(error)));
      request.on("abort", () => finish(() => reject(new Error("the page read was aborted"))));
      request.end();
    });
  }

  async clickPage(tabId: string, target: string): Promise<void> {
    const tab = this.#requireTab(tabId);
    await this.#whenTabReady(tab);
    const clicked = await tab.view.webContents.executeJavaScript(clickPageScript(target));
    if (clicked !== true) throw new Error(`page control not found: ${target}`);
  }

  /**
   * Types by striking real keys through the input pipeline, not by setting
   * `.value` and dispatching synthetic events: search typeaheads, mention
   * pickers, and rich composers gate themselves on trusted keystrokes and
   * simply do not react to the synthetic path (a LinkedIn search box takes
   * the synthetic value silently and never opens its dropdown).
   *
   * Returns what the control holds afterwards, read back from the page, so
   * the caller reports ground truth instead of assuming the text landed.
   * When the keystrokes did not land — some widgets re-render mid-type —
   * the old synthetic path runs as a fallback before that read-back.
   */
  async typePage(tabId: string, target: string, value: string): Promise<string> {
    const tab = this.#requireTab(tabId);
    await this.#whenTabReady(tab);
    const contents = tab.view.webContents;
    const prepared = await contents.executeJavaScript(typePrepareScript(target));
    if (prepared !== true) throw new Error(`editable page control not found: ${target}`);
    contents.focus();
    for (const character of value) {
      const keyCode = character === "\n" ? "Return" : character;
      contents.sendInputEvent({ type: "keyDown", keyCode });
      contents.sendInputEvent({ type: "char", keyCode });
      contents.sendInputEvent({ type: "keyUp", keyCode });
    }
    const written = await contents.executeJavaScript(typeReadBackScript(target, value));
    return typeof written === "string" ? written : "";
  }

  /**
   * One real keystroke to whatever holds focus — Enter to submit a search
   * the page offers no button for, arrows and Escape for typeaheads and
   * menus. The same trusted input pipeline as typePage, for the same
   * reason. `keyCode` is the name Chromium's input pipeline knows the key
   * by (DesktopBrowserBackend maps the agent's key names); `char` sends
   * the char event a key that produces input would.
   */
  pressKeyPage(tabId: string, keyCode: string, char: boolean): void {
    const contents = this.#requireTab(tabId).view.webContents;
    contents.focus();
    contents.sendInputEvent({ type: "keyDown", keyCode });
    if (char) contents.sendInputEvent({ type: "char", keyCode });
    contents.sendInputEvent({ type: "keyUp", keyCode });
  }

  async scrollPage(tabId: string, deltaY: number): Promise<void> {
    await this.#requireTab(tabId).view.webContents.executeJavaScript(scrollScript(deltaY));
  }

  async screenshotPage(tabId: string): Promise<string> {
    const tab = this.#requireTab(tabId);
    const image = await this.#withoutAgentGlow(tab, () =>
      tab.view.webContents.capturePage(),
    );
    return image.toDataURL();
  }

  async applyFormState(
    tabId: string,
    state: CapturedPageContext["formState"],
  ): Promise<void> {
    const encoded = JSON.stringify(state);
    await this.#requireTab(tabId).view.webContents.executeJavaScript(`(() => {
      const state = ${encoded};
      for (const item of state) {
        const escaped = CSS.escape(item.name);
        const element = document.querySelector('[name="' + escaped + '"], #' + escaped);
        if (element && "value" in element) {
          element.value = item.value;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    })()`);
  }

  async applyAgentDraft(tabId: string): Promise<void> {
    await this.#requireTab(tabId).view.webContents.executeJavaScript(`(() => {
      const memo = document.querySelector('#memo');
      if (memo) {
        memo.value = 'PO total matched. Documented the $20 freight variance from the vendor invoice.';
        memo.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.body.dataset.agent = 'working';
    })()`);
  }

  async submitAgentAction(
    tabId: string,
  ): Promise<"blocked" | "completed" | "timeout"> {
    const result = await this.#requireTab(tabId).view.webContents
      .executeJavaScript(`(async () => {
      delete document.body.dataset.submitResult;
      const form = document.querySelector('#reconcile-form');
      if (form instanceof HTMLFormElement) form.requestSubmit();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = document.body.dataset.submitResult;
        if (result === 'blocked' || result === 'completed') return result;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return 'timeout';
    })()`);
    return result as "blocked" | "completed" | "timeout";
  }

  async prepareAgentSession(tabId: string): Promise<void> {
    const tab = this.#requireTab(tabId);
    await tab.view.webContents.session.clearStorageData();
    await tab.view.webContents.session.enableNetworkEmulation({
      offline: true,
    });
  }

  #requireTab(tabId: string): ManagedTab {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) throw new Error(`unknown tab ${tabId}`);
    return tab;
  }
}

/**
 * Clear one address, and pin it.
 *
 * The name is checked first — that alone stops the obvious
 * `http://localhost:9200` or `http://169.254.169.254` — and then every
 * address it resolves to, which stops a public name pointed at one of those.
 * The address that comes back is the ONLY one the socket may use: checking a
 * name and then letting the stack resolve it again leaves the name free to
 * answer differently the second time (DNS rebinding), and Chromium keeps its
 * own resolver and cache, so those two answers are genuinely independent.
 *
 * Fails closed throughout: a name that will not resolve is never asked for.
 */
async function vetUrl(value: string): Promise<{ url: URL; pinned: LookupAddress }> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("that is not a web address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`only http(s) pages can be read (${url.protocol})`);
  const refusal = (): Error =>
    new Error(`that address is not on the public web (${url.hostname})`);
  if (isPrivateHost(url.hostname)) throw refusal();
  let resolved: LookupAddress[];
  try {
    resolved = await lookup(url.hostname, { all: true });
  } catch {
    throw new Error(`that address could not be resolved (${url.hostname})`);
  }
  for (const address of resolved) if (isPrivateHost(address.address)) throw refusal();
  const pinned = resolved[0];
  if (pinned === undefined) throw refusal();
  return { url, pinned };
}

/**
 * A page read, hop by hop: every address cleared before it is asked for, and
 * each one dialled the only way that keeps the clearance meaningful.
 *
 * An identity Space's reads go through the gateway like its pages do (D14) —
 * Chromium's stack on the Space session, so the proxy rules and the
 * credential apply, and never Node's, which knows no proxy. But only a hop
 * the session REALLY sends to the gateway may take that path. The Space's
 * policy alone does not say so: a Space switched to identity after launch, a
 * Space browsing direct by override, a signed-out Mac, and every host in the
 * media, checkout, or local bypass all browse direct with
 * `egressPolicy: 'identity'` still set. A direct hop must take the pinned
 * path instead, because `net.request` resolves the name a second time with
 * Chromium's own resolver, and a rebinding answer would then reach a private
 * address carrying the Space's cookies.
 */
export async function readPageChain(
  start: string,
  partition: Session,
  viaGateway: (url: URL) => Promise<PageRead>,
  viaPin: (url: URL, pinned: LookupAddress) => Promise<PageRead>,
): Promise<string> {
  let target = start;
  for (let hop = 0; hop <= MAX_PAGE_REDIRECTS; hop += 1) {
    const { url: vetted, pinned } = await vetUrl(target);
    const read = (await hopLeavesThroughProxy(partition, vetted))
      ? await viaGateway(vetted)
      : await viaPin(vetted, pinned);
    if (read.redirectTo === undefined) return read.html;
    target = read.redirectTo;
  }
  throw new Error("the page redirected too many times");
}

/**
 * Whether this session sends this address through a proxy right now.
 *
 * A Space's egress policy says what it WANTS; `resolveProxy` says what the
 * session was actually configured to do, bypass rules and all, which is what
 * decides whether a page read may hand the name to Chromium (the gateway
 * re-vets and re-resolves it itself) or must be dialled at the vetted
 * address. A proxy list that can fall back to DIRECT is not good enough:
 * that fallback is a direct connection to a name resolved a second time.
 *
 * Fails safe: an answer that cannot be had means the pinned path.
 */
export async function hopLeavesThroughProxy(partition: Session, url: URL): Promise<boolean> {
  let resolved: string;
  try {
    resolved = await partition.resolveProxy(url.href);
  } catch {
    return false;
  }
  const entries = resolved
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return entries.length > 0 && entries.every((entry) => !/^DIRECT\b/i.test(entry));
}

/**
 * What the read sends: the person's cookies for exactly this address, and
 * the browser's own user agent. Rebuilt per hop rather than carried along,
 * so a redirect to another site is answered with that site's cookies and
 * never with the previous one's.
 */
async function pageReadHeaders(partition: Session, url: URL): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
    "accept-encoding": "gzip, deflate, br",
    "user-agent": partition.getUserAgent(),
  };
  try {
    const cookies = await partition.cookies.get({ url: url.href });
    const cookie = cookies
      // Electron matches domain and path; the secure attribute is the rest
      // of it, and a secure cookie belongs to https alone.
      .filter((candidate) => url.protocol === "https:" || candidate.secure !== true)
      .map((candidate) => `${candidate.name}=${candidate.value}`)
      .join("; ");
    if (cookie !== "") headers["cookie"] = cookie;
  } catch {
    // A page read without the sign-in still describes the page.
  }
  return headers;
}

/** Either the page's HTML, or the one address it redirects to. */
interface PageRead {
  html: string;
  redirectTo?: string;
}

/**
 * One hop. Redirects are reported rather than followed, so the caller can
 * put the next address through `vetUrl` before asking for it, and the body
 * stops at `maxBytes` — a page is read for its head and an excerpt, so the
 * rest is never wanted and the connection is dropped instead of drained.
 *
 * Node's stack rather than Chromium's, for the one thing only it offers: a
 * `lookup` the caller supplies, which is what makes the vetted address the
 * address actually dialled. The page's own session still comes along, as the
 * cookies in `headers`; what does not is Chromium's proxy configuration, so
 * a page read behind a system proxy falls back to a direct connection.
 */
function requestPage(
  url: URL,
  pinned: LookupAddress,
  headers: Record<string, string>,
  signal: AbortSignal,
  maxBytes: number,
): Promise<PageRead> {
  return new Promise<PageRead>((resolve, reject) => {
    const secure = url.protocol === "https:";
    const request = (secure ? httpsRequest : httpRequest)({
      hostname: url.hostname,
      ...(url.port === "" ? {} : { port: Number(url.port) }),
      path: `${url.pathname}${url.search}`,
      headers,
      // One connection, kept by nobody. A page read happens now and again,
      // to whatever address the agent named; pooling those sockets holds
      // resources for reuse that never comes.
      agent: false,
      // The name is still what the certificate is checked against and what
      // the Host header carries; only the address dialled is fixed.
      ...(secure ? { servername: url.hostname } : {}),
      lookup: (_hostname, options, callback) => {
        // Asked for every address while the socket is racing families, and
        // for one otherwise. Either way it gets the vetted one and no other.
        if (options.all === true) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      },
    });
    let settled = false;
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onDeadline);
      run();
    };
    // Settling alone would leave a server that has stopped answering holding
    // this socket for as long as it liked; the read is over, so is the
    // connection. Rejecting first keeps the reason from becoming the
    // teardown's own error.
    const onDeadline = (): void => {
      finish(() => reject(new Error("the page took too long to read")));
      request.destroy();
    };
    if (signal.aborted) {
      onDeadline();
      return;
    }
    signal.addEventListener("abort", onDeadline, { once: true });
    request.on("response", (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && typeof location === "string" && location !== "") {
        response.destroy();
        let next: string;
        try {
          next = new URL(location, url).href;
        } catch {
          finish(() => reject(new Error("the page redirected somewhere unreadable")));
          return;
        }
        finish(() => resolve({ html: "", redirectTo: next }));
        return;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        finish(() => reject(new Error(`the page answered ${String(status)}`)));
        return;
      }
      const type = String(response.headers["content-type"] ?? "");
      if (type !== "" && !/text\/html|application\/xhtml/i.test(type)) {
        response.destroy();
        finish(() => reject(new Error(`not a web page (${type})`)));
        return;
      }
      // Chromium decompressed for us; Node hands the bytes over as they came.
      // The cap therefore counts the page as read rather than as sent, which
      // is also what keeps a small compressed body from expanding without
      // bound.
      const encoding = String(response.headers["content-encoding"] ?? "").trim().toLowerCase();
      const body =
        encoding === "gzip"
          ? response.pipe(createGunzip())
          : encoding === "deflate"
            ? response.pipe(createInflate())
            : encoding === "br"
              ? response.pipe(createBrotliDecompress())
              : response;
      const chunks: Buffer[] = [];
      let received = 0;
      const html = (): string => Buffer.concat(chunks).toString("utf8");
      body.on("data", (chunk: Buffer) => {
        if (received >= maxBytes) return;
        const slice = chunk.length > maxBytes - received ? chunk.subarray(0, maxBytes - received) : chunk;
        chunks.push(slice);
        received += slice.length;
        if (received >= maxBytes) {
          response.destroy();
          finish(() => resolve({ html: html() }));
        }
      });
      body.on("end", () => finish(() => resolve({ html: html() })));
      // A truncated or malformed body still describes the page well enough
      // to draft from.
      body.on("error", () => finish(() => resolve({ html: html() })));
    });
    request.on("error", (error: Error) => finish(() => reject(error)));
    request.end();
  });
}

function webOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

type StillFormat = "png" | "jpeg";

/** Playback position may drift this far from the projection before it is republished. */
const MEDIA_POSITION_DRIFT_S = 1;

/**
 * Where playback stands now according to the record the shell holds — the
 * same projection MediaStack.tsx draws from — so a fresh report is compared
 * against what the shell already shows, not against a stale number.
 */
function projectedMediaPosition(media: BrowserMediaInfo, now: number): number {
  const elapsed = media.playing
    ? (Math.max(0, now - media.updatedAt) / 1_000) * media.playbackRate
    : 0;
  return Math.min(
    media.duration ?? Number.POSITIVE_INFINITY,
    Math.max(0, media.position + elapsed),
  );
}

/**
 * A video someone is watching, as far as a report can tell: playing with
 * its sound on. A feed's muted autoplay clip is scenery, not a session, and
 * must not make another video yield.
 */
export function watchedVideo(info: BrowserMediaInfo): boolean {
  return info.hasVideo && info.playing && !info.muted;
}

/**
 * Whether a new media record says anything the published one does not:
 * any field other than the clock, or a clock more than a second off the
 * projection of the published one.
 */
/** The part of a card's state a following page needs. */
function followSync(info: BrowserMediaInfo): ReadAloudFollowSync {
  return { position: info.position, playing: info.playing, playbackRate: info.playbackRate, updatedAt: info.updatedAt };
}

export function mediaInfoChanged(
  previous: BrowserMediaInfo,
  next: BrowserMediaInfo,
): boolean {
  for (const key of Object.keys(next) as (keyof BrowserMediaInfo)[]) {
    if (key === "position" || key === "updatedAt") continue;
    if (previous[key] !== next[key]) return true;
  }
  return (
    Math.abs(next.position - projectedMediaPosition(previous, next.updatedAt)) >
    MEDIA_POSITION_DRIFT_S
  );
}

/**
 * Shrink a compositor capture from device pixels to the CSS pixels the view
 * occupies. Nothing that shows these stills paints them larger than the view,
 * so the extra pixels of a HiDPI capture only cost encode and decode time.
 */
function fitStillToView(image: NativeImage, cssWidth: number): NativeImage {
  const { width } = image.getSize();
  return cssWidth > 0 && width > cssWidth
    ? image.resize({ width: cssWidth, quality: "good" })
    : image;
}

/**
 * A still that stands in for a live page for a moment. JPEG encodes and
 * decodes in a fraction of PNG's time at a fraction of the bytes: for the
 * Glance motions that is the difference between a swap that shows nothing
 * and a blank pane while a multi-megabyte PNG decodes.
 */
function encodeStill(image: NativeImage, format: StillFormat): string {
  return format === "jpeg"
    ? `data:image/jpeg;base64,${image.toJPEG(92).toString("base64")}`
    : image.toDataURL();
}

/** Keep an untrusted page's claimed link rectangle inside its own view. */
function clampSourceBounds(
  source: ContentBounds,
  owner: ContentBounds,
): ContentBounds {
  const finite = (value: number): number =>
    Number.isFinite(value) ? Math.round(value) : 0;
  const x = Math.max(
    0,
    Math.min(finite(source.x), Math.max(0, owner.width - 1)),
  );
  const y = Math.max(
    0,
    Math.min(finite(source.y), Math.max(0, owner.height - 1)),
  );
  return {
    x,
    y,
    width: Math.max(1, Math.min(finite(source.width), owner.width - x)),
    height: Math.max(1, Math.min(finite(source.height), owner.height - y)),
  };
}

/**
 * The app the system would open `url` with, or null when nothing on this
 * computer answers its scheme.
 */
function externalAppName(url: string): string | null {
  try {
    const name = app.getApplicationNameForProtocol(url).trim();
    return name === "" ? null : boundedLabel(name.replace(/\.app$/iu, ""), "an app", 60);
  } catch {
    return null;
  }
}

function externalAppReason(
  target: ExternalAppTarget,
  decision: "allow-once" | "allow" | "block",
): string {
  if (decision === "block") return `did not open ${target.appName}`;
  return decision === "allow"
    ? `always allowed to open ${target.scheme} links`
    : `opened ${target.appName} this once`;
}

function normalizeElectronPermissions(
  permission: string,
  mediaTypes: readonly string[] = [],
): BrowserPermission[] {
  switch (permission) {
    case "media": {
      const requested: BrowserPermission[] = [];
      if (mediaTypes.length === 0 || mediaTypes.includes("video"))
        requested.push("camera");
      if (mediaTypes.includes("audio")) requested.push("microphone");
      return requested;
    }
    case "geolocation":
    case "notifications":
    case "clipboard-read":
    case "display-capture":
    case "idle-detection":
      return [permission];
    case "clipboard-sanitized-write":
      return ["clipboard-write"];
    case "midi":
    case "midiSysex":
      return ["midi"];
    default:
      return [];
  }
}

function boundedLabel(
  value: string | undefined,
  fallback: string,
  maxLength = 160,
): string {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  return (normalized === "" ? fallback : normalized).slice(0, maxLength);
}
