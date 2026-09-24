import type { NoteRequest, NoteResponse, NoteSnapshot } from "./notes.js";
import type { ReportRequest, ReportResponse } from "./reports.js";
import type { WatchtowerRequest, WatchtowerResponse } from "./watchtower.js";
import type { TabArchiveRequest, TabArchiveResponse } from "./tab-archive.js";
import type { TabGroupCommand, TabGroupCommandResult, TabGroupInfo } from "./tab-groups.js";
import type { TidyRequest, TidyResponse } from "./tidy.js";
import type { LiveFrame, LiveInput, LiveTabInfo } from "@pistachio/live-view";
import type { EvidenceEntry } from "@pistachio/evidence";
import type {
  AgentAttachment,
  CredentialCapture,
  CredentialCaptureReply,
  CredentialAutocomplete,
  CredentialFieldType,
  FeedbackInput,
  IntegrationAccess,
  IntegrationConnectionStatus,
  IntegrationProvider,
  RunSummary,
  ThreadListItem,
  TaskStatus,
} from "@pistachio/protocol";
import type {
  MemoryAddInput,
  MemoryEntry,
  MemoryReview,
  MemorySnapshot,
  MemoryUpdateInput,
} from "./memory.js";
import type {
  BrowserImportRequest,
  BrowserImportResult,
  InstalledBrowser,
} from "./browser-import.js";
import type { OnboardingCompletion, OnboardingIntake } from "./onboarding.js";
import type { NoticeEvent, NoticeFrame, NoticeStackState } from "./notice.js";
import type {
  Bookmark,
  BookmarkInput,
  BookmarkPatch,
  BookmarkSnapshot,
  BookmarkToast,
} from "./bookmarks.js";
import type {
  Reminder,
  ReminderInput,
  ReminderPatch,
  ReminderSnapshot,
} from "./reminders.js";
import type { DesktopSettings, SettingsPatch } from "./settings.js";
import type {
  DragCursor,
  DragSample,
  ShellCommand,
  ShellState,
  TabDragVisual,
} from "./chrome.js";
import type { AddressIntentRanking, AddressIntentRequest } from "./address-intent.js";
import type { BrowserMediaInfo, MediaControl, ReadAloudStatus } from "./media.js";
import type {
  BrowserControlCommand,
  BrowserControlsSnapshot,
  BrowserDownload,
  FindCommand,
  FindState,
} from "./browser-controls.js";
import type { SidebarCommand, SidebarState } from "./sidebar.js";
import type { UpdateState } from "./updates.js";
import type {
  ForkSpaceRequest,
  ForkSpaceResult,
  SpaceEgressPolicy,
  SpaceInfo,
} from "./spaces.js";
export type {
  ForkSpaceRequest,
  ForkSpaceResult,
  SpaceEgressPolicy,
  SpaceInfo,
} from "./spaces.js";

export interface ContentBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserTabInfo {
  id: string;
  spaceId: string;
  title: string;
  url: string;
  faviconUrl: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  kind: "human" | "agent";
  runId: string | null;
  /** Live tabs own a WebContentsView; suspended tabs are metadata-only until selected. */
  lifecycle: "live" | "suspended";
  /** Last focus time, used for MRU restore and idle suspension. */
  lastActiveAt: number;
  /**
   * A working tab the chrome does not list: the read-aloud player is a page
   * only so that the tab media observer reports it, but it is not somewhere
   * a person navigates. Main manages it like any other tab; the sidebar, the
   * strip, and the durable session all leave it out.
   */
  unlisted: boolean;
  /**
   * The sidebar shelf entry this tab is the live page of — a pin's or a
   * favorite's id, or `preset:<url>` for an organization link — or null for
   * an ordinary day tab (@pistachio/shell-contracts/sidebar). Closing an anchored tab keeps
   * the entry; opening the entry again binds a fresh tab to it.
   */
  anchorId: string | null;
  /**
   * Forced focus: the page is told it is the visible, focused tab even while
   * it sits in the background (apps/desktop/src/main/forced-focus.ts).
   * Absent where the host cannot do this — the chrome then offers no toggle.
   */
  forcedFocus?: boolean;
}

/** Recoverable metadata for the most recently closed human tab. */
export interface RecentlyClosedTabInfo {
  spaceId: string;
  title: string;
  url: string;
  faviconUrl: string | null;
  anchorId: string | null;
  closedAt: number;
}

/** Main-owned inventory used by the unified address / command palette. */
export interface CommandPaletteSnapshot {
  /** Open tabs from every Space, including suspended tabs. */
  tabs: BrowserTabInfo[];
  /** Newest first. Restore currently consumes the first item. */
  recentlyClosedTabs: RecentlyClosedTabInfo[];
  /**
   * What "Paste and Go" would open: the clipboard's text when it is an
   * address (@pistachio/shell-contracts/url `pasteAndGoUrl`), read as the palette opens.
   * Anything else the clipboard holds stays in main — the renderer never
   * sees it.
   */
  clipboardUrl: string | null;
}

export type SplitMode = "single" | "vertical" | "horizontal" | "grid";
export type SplitOrientation = Exclude<SplitMode, "single">;
export type SplitGridLayout =
  | "span-top"
  | "span-bottom"
  | "span-left"
  | "span-right";

/** A persistent tab-group whose two to four members reopen together when selected. */
export interface SplitGroupInfo {
  id: string;
  /** Pane order, read left-to-right or top-to-bottom for linear layouts. */
  tabIds: string[];
  /** @deprecated Compatibility alias for tabIds[0]. */
  primaryTabId: string;
  /** @deprecated Compatibility alias for tabIds[1]. */
  secondaryTabId: string;
  mode: SplitOrientation;
  /** Which edge the spanning pane occupies when a three-pane group uses grid mode. */
  gridLayout: SplitGridLayout;
}

export interface ShellSnapshot {
  spaces: SpaceInfo[];
  activeSpaceId: string;
  tabs: BrowserTabInfo[];
  /** The focused tab, regardless of which pane it occupies. */
  activeTabId: string | null;
  /** All visible panes in stable split-group order. */
  visibleTabIds: string[];
  /**
   * Tabs woken from sleep whose page has not painted yet: main keeps each
   * one's view hidden until it has, and the pane draws the tab's mark in its
   * place (renderer ContentArea), so the switch lands at once and nothing
   * blank shows while the page arrives.
   */
  wakingTabIds: string[];
  /** The first other visible split member, retained for API compatibility. */
  secondaryTabId: string | null;
  splitMode: SplitMode;
  /** Every saved split group, including groups that are not currently visible. */
  splitGroups: SplitGroupInfo[];
  /** The active Space's tab groups, in no particular order: a group sits where its first tab does (@pistachio/shell-contracts/tab-groups). */
  tabGroups: TabGroupInfo[];
  run: RunSummary | null;
  /** Every saved conversation, newest first, the open one included (main/thread-store.ts). */
  threads: ThreadListItem[];
  /** The shelf — favorites, pins, folders — main keeps for the sidebar (@pistachio/shell-contracts/sidebar). */
  sidebar: SidebarState;
}

/**
 * What a tab event publishes: the snapshot minus the conversation. Tab
 * titles, favicons, and load edges change far more often than the run does,
 * and the run grows for the length of a thread, so the two travel on
 * separate channels; the renderer's store folds them back into one
 * ShellSnapshot (renderer/src/store.ts).
 */
export type ShellTabsSnapshot = Omit<ShellSnapshot, "run" | "threads">;

/** What a run change publishes: the conversation, already scoped to the active Space. */
export interface ShellRunSnapshot {
  run: RunSummary | null;
  threads: ThreadListItem[];
}

export interface BrowserLayout {
  views: Array<{ tabId: string; bounds: ContentBounds }>;
}

/** A background video's live native view, fitted into the sidebar player. */
export interface MediaPreviewPlacement {
  tabId: string;
  bounds: ContentBounds;
}

export type SplitSide = "left" | "right" | "top" | "bottom";

/**
 * A still of a visible pane, taken the moment the chrome is raised above the
 * tab views: the renderer paints it into the pane so the page appears to stay
 * put under a modal veil while the live view is hidden (see BrowserController.setOverlay).
 */
export interface PaneStill {
  tabId: string;
  dataUrl: string;
}

/** A downsized live capture and its trusted, main-owned tab metadata. */
export interface TabSwitcherPreview {
  tab: BrowserTabInfo;
  dataUrl: string | null;
}

/** Native Control–Tab lifecycle relayed to the shell, whichever view had focus. */
export type TabSwitcherInput =
  | { type: "step"; reverse: boolean }
  | { type: "commit" }
  | { type: "cancel" };

/** A link's box in its tab view, captured when the Glance gesture starts. */
export interface GlanceOpenRequest {
  url: string;
  source: ContentBounds;
  /** True for a normal _blank click from an anchored (pinned/favorited) tab. */
  automatic: boolean;
}

/**
 * A trusted modifier click on a control no anchor claims — a button that
 * navigates from script. There is no URL to read at click time; if the page
 * answers with window.open while the intent is fresh, main Glances that
 * window instead of spawning a tab. `source` is the control's box, the spot
 * the Glance grows out of.
 */
export interface GlanceIntentRequest {
  source: ContentBounds;
}

/**
 * A link the shell itself rendered (e.g. in the agent console), to preview
 * above the active page. `source` is the link's box in the shell's viewport,
 * which is the window's content box.
 */
export interface ShellGlanceOpenRequest {
  url: string;
  source: ContentBounds;
}

/** How a feedback send ended, in words the popover can show. */
export type FeedbackOutcome = { ok: true } | { ok: false; error: string };

/**
 * The ephemeral page hovering above its owner tab. It is deliberately not in
 * ShellSnapshot.tabs until the person promotes it to a tab or split pane.
 */
export interface GlanceState {
  tab: BrowserTabInfo;
  ownerTabId: string;
  /** The clicked link's box in window coordinates, used by the arc animation. */
  source: ContentBounds;
  /** The owner pane(s), frozen while their native views are recessed. */
  backgroundStills: PaneStill[];
}

/** The pointer, in the window's content box — the shell page's viewport. */
export interface CursorPoint {
  x: number;
  y: number;
}

// ── Account, devices, sync, egress, cloud (docs/cloud-sync-design.md §10) ──

/** A device's public key, shortened for a person to compare across screens. */
export type KeyFingerprint = string;

/** The hosted cloud browser's identity as this Mac pinned it on first enable (D6). */
export interface CloudDevicePin {
  deviceId: string;
  /** base64 raw X25519 public key. */
  agreementPublicKey: string;
  fingerprint: KeyFingerprint;
}

/**
 * Whether a model can be reached. Every call goes through control's
 * `/v1/ai/*` under this Mac's device token, so this is "holds one": a
 * signed-in account's, or the anonymous account's a Mac nobody signed in on
 * is given (docs/anonymous-accounts.md). No key is involved.
 */
export interface AiProviderStatus {
  available: boolean;
  /** The control plane the calls go to, or null before the account services exist. */
  controlUrl: string | null;
}

/** Where this Mac stands with the account (§10.1). Published on `account:changed`. */
export interface AccountState {
  /**
   * `anonymous`: nobody is signed in, and control has made this Mac an
   * anonymous account (docs/anonymous-accounts.md) so the models work —
   * within a monthly allowance — without one. Everything an account brings
   * beyond the models still waits on `enrolled`. Signing up from here keeps
   * what the anonymous account has; it is the same account, upgraded.
   */
  state: "unenrolled" | "anonymous" | "signed-up" | "enrolled";
  email: string | null;
  userId: string | null;
  /** This device's one id (D24), or null before its keys could be kept. */
  deviceId: string | null;
  deviceName: string;
  controlUrl: string;
  /**
   * False when Electron's safeStorage cannot encrypt on this Mac: sign-in is
   * refused with a clear error rather than keeping keys in the clear (D20).
   */
  encryptionAvailable: boolean;
  cloudDevicePin: CloudDevicePin | null;
  /**
   * Set when `POST /cloud/enable` answered with a device that differs from the
   * pin: nothing was wrapped, and Settings → Devices must confirm the new key
   * (`devices:confirmCloud`) before the cloud browser gets any Space secret.
   */
  cloudDeviceChanged?: CloudDevicePin | null;
  /** Control stopped accepting this device's key: its enrollment was revoked. */
  revoked: boolean;
  /** Plane discovery from `GET /me`, once enrolled. */
  hubUrl: string | null;
  cloudBrowserUrl: string | null;
  /** The last account operation's failure, in words the settings page can show. */
  error: string | null;
}

/** What `account:enroll` answers: the state, and the recovery code shown exactly once. */
export interface AccountEnrollResult {
  state: AccountState;
  recoveryCode: string | null;
}

/**
 * Every kind of device an account can hold, exactly as control names them
 * (services/control DevicePlatform): this app, a browser signed in on the
 * web, and the cloud browser.
 */
export type DevicePlatform = "macos" | "web" | "cloud";

export interface DeviceInfo {
  id: string;
  name: string;
  platform: DevicePlatform;
  /** base64 raw Ed25519 public key. */
  devicePublicKey: string;
  /** base64 raw X25519 public key. */
  agreementPublicKey: string;
  fingerprint: KeyFingerprint;
  createdAt: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
  /** This Mac. */
  isThisDevice: boolean;
  /** The cloud device this Mac has pinned (§10.1); false for an unpinned or replaced one. */
  isPinnedCloudDevice: boolean;
}

/** The cookie sync engine's state (§10.2). Published on `sync:changed`. */
export interface SyncStatus {
  state: "connected" | "connecting" | "paused" | "off";
  /** Records waiting to publish across every Space. */
  queueDepth: number;
  lastConvergedMs: number | null;
  /** Another device changed something this Mac has not pulled yet. */
  remoteChanged: boolean;
  keyMode: "e2ee";
  /** The hub closed this device's socket as revoked (4003); only re-enrolling dials again. */
  revoked: boolean;
}

/** A person's standing choice for one origin, over the corpus policy. */
export type SyncOriginOverride = "sync" | "never";

/** How one origin's cookies are treated in one Space, for the site controls. */
export interface SyncOriginInfo {
  spaceId: string;
  host: string;
  /** 0 = never synced (sensitive), 1 = synced, 2 = synced with rotation. */
  tier: 0 | 1 | 2;
  rotatingAuth: boolean;
  sensitive: boolean;
  override: SyncOriginOverride | null;
  /** The effective answer after the override. */
  synced: boolean;
  /** A remote version is staged behind Pull/Merge rather than applied. */
  staged: boolean;
  /** Local writes are parked because the cloud browser holds this origin's lease. */
  deferred: boolean;
}

/** Another device's saved restore point (`device-workspace:<id>`), offered for Pull/Merge. */
export interface RemoteRestorePoint {
  deviceId: string;
  name: string;
  deviceKind: "desktop" | "cloud";
  savedAtMs: number;
  tabCount: number;
  spaceIds: string[];
}

/** Workspace (Spaces + tab restore points) sync state (§10.2). Published on `workspaceSync:changed`. */
export interface WorkspaceSyncStatus {
  state: "off" | "idle" | "syncing" | "error";
  lastRunMs: number | null;
  /** When this device last published its own restore point. */
  lastPushMs: number | null;
  remoteRestorePoints: RemoteRestorePoint[];
  error: string | null;
}

/** What `workspaceSync:run` does. */
export type WorkspaceSyncAction =
  | { kind: "push" }
  | {
      kind: "pull";
      deviceId: string;
      /** `replace` rebuilds the Space's tabs from the remote point; `merge` adds what is missing. */
      mode: "replace" | "merge";
      /** Every Space in the restore point when omitted. */
      spaceIds?: string[];
    }
  | { kind: "refresh" };

export interface EgressGatewayInfo {
  host: string;
  port: number;
  egressIp: string | null;
  region: string | null;
  state: string | null;
}

export interface SpaceEgressStatus {
  spaceId: string;
  policy: SpaceEgressPolicy;
  /** Identity Space, gateway down, no override: its traffic is blocked (D13). */
  failClosed: boolean;
  /** "Browse direct for now" is in effect until the gateway comes back. */
  temporaryDirectOverride: boolean;
  /** Switched to identity mid-run: QUIC is still on, so it browses direct until relaunch. */
  restartRequired: boolean;
}

/** The egress plane (§10.3). Published on `egress:changed`. */
export interface EgressStatus {
  /** False before enrollment or under PISTACHIO_E2E: nothing is ever proxied. */
  enabled: boolean;
  gateway: EgressGatewayInfo | null;
  /** The health probe's last answer; `unknown` before the first one. */
  health: "up" | "down" | "unknown";
  credentialExpiresAt: string | null;
  quicDisabledAtStartup: boolean;
  spaces: SpaceEgressStatus[];
}

/** A live-view screencast frame (§8.5), relayed on `cloud:frame`. */
/**
 * The live view's wire shapes are `@pistachio/live-view`'s (§8.5) — one
 * definition for the runner, this process, and the web. Main adds the run id
 * on the way through IPC, because a frame arriving in the renderer has to say
 * which conversation it belongs to.
 */
export type CloudFrame = LiveFrame & { runId: string };

/** A tab the cloud browser reports over the live view. */
export type CloudTabInfo = LiveTabInfo;

/** What the live-view overlay sends back while the person holds control (§8.5). */
export type CloudLiveInput = LiveInput;

/** The cloud browser (§10.4). Published on `cloud:changed`. */
export interface CloudStatus {
  /** Enrolled, control reachable, and a cloud browser URL known. */
  available: boolean;
  cloudBrowserUrl: string | null;
  /** The pinned cloud device, or null before any Space enabled it. */
  device: CloudDevicePin | null;
  spaces: Array<{ spaceId: string; enabled: boolean }>;
  /** The run whose live view is open, if any. */
  liveRunId: string | null;
  liveState: "closed" | "connecting" | "open" | "revoked" | "error";
  liveError: string | null;
  /** Who drives the cloud page right now; input is forwarded only under `human`. */
  liveControl: "agent" | "human" | null;
  /** The run's status as the cloud browser last reported it; null until it has. */
  liveStatus: TaskStatus | null;
  liveTabs: CloudTabInfo[];
  liveActiveTabId: string | null;
}

export interface CloudStartRunRequest {
  /** The active Space when omitted. */
  spaceId?: string;
  intent: string;
  attachments?: AgentAttachment[];
  /** The active tab's address when omitted. */
  startUrl?: string;
}

/** An authenticated webhook bound to one Space (§7.3 channels). */
export interface ChannelInfo {
  linkId: string;
  name: string;
  spaceId: string;
  outboundUrl: string | null;
  createdAt: string | null;
  revokedAt: string | null;
}

export interface ChannelCreateRequest {
  name: string;
  spaceId: string;
  outboundUrl?: string;
}

/** The one-time secret rides only on the create answer. */
export interface ChannelCreated extends ChannelInfo {
  secret: string;
}

/* ------------------------------ credential vault ------------------------------ */

/** One field of a vault entry as the renderer sees it: what it is, never what it holds. */
export interface VaultFieldInfo {
  id: string;
  label: string;
  type: CredentialFieldType;
  autocomplete?: CredentialAutocomplete;
}

/** A vault entry without its values. Values cross to the renderer only on an explicit reveal. */
export interface VaultEntryInfo {
  id: string;
  spaceId: string;
  siteOrigin: string;
  siteName: string;
  fields: VaultFieldInfo[];
  source: "capture" | "manual";
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

/** What the renderer sends to add or update an entry; the main process seals it. */
export interface VaultEntryDraft {
  siteOrigin: string;
  siteName: string;
  fields: Array<VaultFieldInfo & { value: string }>;
}

/* ------------------------------ integrations ------------------------------ */

/** A provider from the catalog, and whether this server offers it. */
export interface IntegrationProviderInfo {
  id: IntegrationProvider;
  name: string;
  description: string;
  /** False when control has no OAuth client for it: shown, but not connectable. */
  available: boolean;
  accessLevels: Array<{ id: IntegrationAccess; label: string; note: string }>;
}

/** A connection without its sealed grant; the renderer never holds a token. */
export interface IntegrationConnectionInfo {
  id: string;
  spaceId: string;
  provider: IntegrationProvider;
  accountLabel: string;
  access: IntegrationAccess;
  scopes: string[];
  status: IntegrationConnectionStatus;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

/**
 * One event from a connected calendar, as the home page's schedule shows
 * it. The host reads the calendar with the grant it holds and hands over
 * only this: the renderer never sees a token, a guest list, or a description.
 */
export interface CalendarAgendaEvent {
  id: string;
  title: string;
  /** `YYYY-MM-DD` for an all-day event (the end date is exclusive), else an RFC 3339 instant. */
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  /** The video call's address, when the event has one. */
  meetingUrl: string | null;
  /** Where to open the event in the calendar's own site. */
  webUrl: string;
}

/**
 * A Space's connected calendar over a window. `not_connected` covers every
 * reason there is nothing to read without the person doing something in
 * Settings first (no connection, not enrolled); `reconnect_required` is a
 * grant the provider refused; `unreachable` is a failure worth retrying.
 */
export interface CalendarAgenda {
  status: "ok" | "not_connected" | "reconnect_required" | "unreachable";
  /**
   * With `not_connected`: whether connecting would work right now — this
   * device has an account, the server offers Google Calendar, and no
   * disconnect is still under way. The home page invites the person to
   * connect only then; an invitation that leads to a refusal is worse than none.
   */
  connectable: boolean;
  accountLabel: string | null;
  events: CalendarAgendaEvent[];
}

export interface IMessageLinkStatus {
  available: boolean;
  linked: boolean;
  /** Masked by control; the renderer never receives the full linked number. */
  phone: string | null;
  verifiedAt: string | null;
}

export interface IMessageLinkChallenge {
  challengeId: string;
  phone: string;
  expiresAt: string;
}

/**
 * The account's model meter (control's `GET /v1/ai-usage`): what this
 * account's devices have spent through `/v1/ai/*`. Tokens are what the
 * answers reported; the cost is the gateway's own USD figure, a decimal
 * string so nothing is rounded before it is shown.
 */
export interface AiUsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
}

export interface AiUsageModelTotals extends AiUsageTotals {
  /** `language-model`, `embedding-model`, `speech-model`, `transcription-model`, … */
  kind: string;
  modelId: string | null;
}

export interface AiUsageCap {
  /** USD per calendar month (UTC), as a decimal string; null is no cap. */
  monthlyUsd: string | null;
  /** The month's cost has reached the cap: control is refusing model calls. */
  reached: boolean;
}

export interface AiUsageSummary {
  /** Since 00:00 UTC today. */
  day: AiUsageTotals;
  /** Since the first of the month, UTC. */
  month: AiUsageTotals;
  /** The month by model, most requests first. */
  models: AiUsageModelTotals[];
  since: { day: string; month: string };
  /** The account's own ceiling, set from the web app's Settings → Plan & billing. */
  cap: AiUsageCap;
}

/**
 * How a console turn treats the page in view (docs/console-routing.md §5.1).
 * The composer shows that page above the input with an X: left alone, the
 * page is attached and a question that names nothing else is about it;
 * dismissed, the turn runs as if it were sent from the home page.
 */
export interface AgentTurnOptions {
  /** Whether the web page in view is attached to this message. Default true. */
  page?: boolean;
}

/**
 * The shell's half of the surface: everything a host that does not own native
 * views can answer. The web app (docs/web-browser-design.md W6) implements
 * exactly this interface over one socket, and the shell UI calls it through
 * `shellApi()`.
 */
export interface ShellApi {
  getSnapshot(): Promise<ShellSnapshot>;
  onSnapshot(listener: (snapshot: ShellTabsSnapshot) => void): () => void;
  onRun(listener: (run: ShellRunSnapshot) => void): () => void;
  getCommandPalette(): Promise<CommandPaletteSnapshot>;
  /**
   * What typed prose most likely means, judged by the intent model
   * (./address-intent.ts, docs/smart-suggestions.md). Null — never a throw —
   * when there is nothing to ask or no one to ask: the setting is off, no
   * model is reachable, the request was superseded, or the model was slow.
   */
  rankAddressIntent(request: AddressIntentRequest): Promise<AddressIntentRanking | null>;
  switchSpace(spaceId: string): Promise<void>;
  forkSpace(request: ForkSpaceRequest): Promise<ForkSpaceResult>;
  createTab(url?: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  selectTab(tabId: string): Promise<void>;
  /** Release an inactive human tab's page process while retaining its recoverable state. */
  suspendTab(tabId: string): Promise<void>;
  navigate(tabId: string, url: string): Promise<void>;
  goBack(tabId: string): Promise<void>;
  goForward(tabId: string): Promise<void>;
  reload(tabId: string): Promise<void>;
  setSplit(mode: SplitMode): Promise<void>;
  /** Move a tab to `index` among all tabs (position counted after it is lifted out). */
  reorderTab(tabId: string, index: number): Promise<void>;
  /** Put `tabId` at an edge of the active split group (up to four panes). */
  splitWith(tabId: string, side: SplitSide): Promise<void>;
  /** Take a tab out of its split group without closing it; the rest stay split. */
  removeFromSplit(tabId: string): Promise<void>;
  /** Open a fresh tab on the same page, beside the original; answers the new tab id. */
  duplicateTab(tabId: string): Promise<string>;
  /** Make the page believe it is the visible, focused tab even in the background (BrowserTabInfo.forcedFocus). */
  setForcedFocus(tabId: string, enabled: boolean): Promise<void>;
  /** Recreate a human tab inside the destination Space's isolated partition. */
  moveTabToSpace(tabId: string, spaceId: string): Promise<void>;
  /** Restore and select the newest closed human tab, if one exists. */
  restoreClosedTab(): Promise<void>;
  /** Close ordinary tabs in the active Space while retaining anchored pages. */
  clearUnpinnedTabs(): Promise<void>;
  // ── Sidebar media stack: sandboxed tabs → main → trusted shell ────────
  getMedia(): Promise<BrowserMediaInfo[]>;
  onMediaChanged(listener: (media: BrowserMediaInfo[]) => void): () => void;
  controlMedia(tabId: string, control: MediaControl): Promise<void>;
  /** "Read aloud" jobs still generating (or just failed), shown beside the media stack. */
  getReadAloud(): Promise<ReadAloudStatus[]>;
  onReadAloudChanged(listener: (jobs: ReadAloudStatus[]) => void): () => void;
  cancelReadAloud(id: string): Promise<void>;
  /**
   * Speak text the shell shows — a reply in the console — as a read-aloud
   * job in the current tab's Space: the same player and media card a page
   * selection gets. Resolves once the first piece is playing.
   */
  readAloudText(text: string): Promise<void>;
  // ── Enterprise browser controls and native find ────────────────────────
  getBrowserControls(): Promise<BrowserControlsSnapshot>;
  onBrowserControlsChanged(
    listener: (snapshot: BrowserControlsSnapshot) => void,
  ): () => void;
  browserControl(command: BrowserControlCommand): Promise<void>;
  /** Every download of this session across tabs, newest first (the downloads chip and list). */
  getDownloads(): Promise<BrowserDownload[]>;
  onDownloadsChanged(listener: (downloads: BrowserDownload[]) => void): () => void;
  getFindState(): Promise<FindState>;
  onFindStateChanged(listener: (state: FindState) => void): () => void;
  find(command: FindCommand): Promise<void>;
  /** Change the sidebar shelf (pin, favorite, folder…); the result arrives as a snapshot. */
  sidebarCommand(command: SidebarCommand): Promise<void>;
  /** Change the tab groups (make, rename, close, open as a split…); the result arrives as a snapshot. */
  tabGroupCommand(command: TabGroupCommand): Promise<TabGroupCommandResult>;
  /** Read or manage the archive of tabs Tidy put away and groups that were closed (docs/tab-tidy.md §3.6). */
  tabArchive(request: TabArchiveRequest): Promise<TabArchiveResponse>;
  /** Run Tidy now, take the last run back, or ask what it last did (docs/tab-tidy.md). */
  tidy(request: TidyRequest): Promise<TidyResponse>;
  /** The current Space's five most recently visited tabs, newest first. */
  getTabSwitcherPreviews(): Promise<TabSwitcherPreview[]>;
  onTabSwitcherInput(listener: (input: TabSwitcherInput) => void): () => void;
  // ── Glance: modifier-click or automatic from an anchored tab ──
  getGlance(): Promise<GlanceState | null>;
  onGlanceChanged(listener: (glance: GlanceState | null) => void): () => void;
  /**
   * Shell only: preview a link the shell rendered above the active human tab.
   * Resolves false when no human tab is on screen to own the preview, so the
   * caller can fall back to a normal tab.
   */
  openGlance(request: ShellGlanceOpenRequest): Promise<boolean>;
  /**
   * Shell only: send the console's feedback popover to the API at
   * PISTACHIO_API_URL, with the current conversation attached. Failure is
   * answered, not thrown, so the popover can show it in place.
   */
  submitFeedback(input: FeedbackInput): Promise<FeedbackOutcome>;
  closeGlance(): Promise<void>;
  promoteGlance(): Promise<void>;
  splitGlance(): Promise<void>;
  /** Escape pressed inside a native page asks the shell to run the same close motion. */
  onGlanceDismissRequested(listener: (hasFocused: boolean) => void): () => void;
  /** Shell: receive commands main relays from native pages and utility views. */
  onShellCommand(listener: (command: ShellCommand) => void): () => void;
  startDelegation(
    intent: string,
    attachments?: AgentAttachment[],
    options?: AgentTurnOptions,
  ): Promise<void>;
  sendAgentMessage(
    content: string,
    attachments?: AgentAttachment[],
    options?: AgentTurnOptions,
  ): Promise<void>;
  answerAgentQuestion(questionId: string, answer: string): Promise<void>;
  interruptAgent(): Promise<void>;
  /** Run the thread's last turn again from where it began, discarding what it produced. Only on a settled local thread. */
  retryAgentTurn(): Promise<void>;
  approve(approvalId: string): Promise<void>;
  reject(approvalId: string): Promise<void>;
  takeControl(): Promise<void>;
  releaseControl(): Promise<void>;
  revokeRun(): Promise<void>;
  /** Reopen a saved conversation in the console; refused while the agent is acting. */
  openThread(runId: string): Promise<void>;
  /** Clear the console for a fresh conversation; a task still acting is stopped first. */
  newThread(): Promise<void>;
  /** Forget a saved conversation. */
  deleteThread(runId: string): Promise<void>;
  getEvidence(): Promise<EvidenceEntry[]>;
  getSettings(): Promise<DesktopSettings>;
  /** Whether a model can be reached: this Mac is enrolled in an account. */
  getAiStatus(): Promise<AiProviderStatus>;
  /** The account's model meter; null before this Mac is enrolled. */
  getAiUsage(): Promise<AiUsageSummary | null>;
  /** Merge a partial over the stored settings; resolves with the sanitized whole. */
  updateSettings(patch: SettingsPatch): Promise<DesktopSettings>;
  resetSettings(): Promise<DesktopSettings>;
  onSettings(listener: (settings: DesktopSettings) => void): () => void;
  /** Every memory, every version — the audit view the settings page filters. */
  getMemory(): Promise<MemorySnapshot>;
  /** Written as the person: full confidence, approved. A key versions its slot. */
  addMemory(input: MemoryAddInput): Promise<MemoryEntry>;
  updateMemory(id: string, patch: MemoryUpdateInput): Promise<MemoryEntry>;
  forgetMemory(id: string, reason: string): Promise<MemoryEntry>;
  restoreMemory(id: string): Promise<MemoryEntry>;
  reviewMemory(
    id: string,
    decision: Exclude<MemoryReview, "pending">,
  ): Promise<MemoryEntry>;
  /** Soft-forgets everything active; resolves with how many. */
  forgetAllMemory(): Promise<number>;
  onMemory(listener: (snapshot: MemorySnapshot) => void): () => void;
  // ── Reminders: the schedule and its log (@pistachio/shell-contracts/reminders) ───────────
  getReminders(): Promise<ReminderSnapshot>;
  onReminders(listener: (snapshot: ReminderSnapshot) => void): () => void;
  /** Written as the person. */
  addReminder(input: ReminderInput): Promise<Reminder>;
  updateReminder(id: string, patch: ReminderPatch): Promise<Reminder>;
  cancelReminder(id: string): Promise<Reminder>;
  /** Delete a reminder and its history. */
  deleteReminder(id: string): Promise<void>;
  /** Fire a reminder now, off schedule; a recurring one keeps its schedule. */
  runReminderNow(id: string): Promise<void>;
  /** Dismiss fired reminders from the console; "all" clears the inbox. */
  acknowledgeReminders(ids: string[] | "all"): Promise<number>;
  /** Dismiss one fired reminder and repeat it once, `minutes` from now. */
  snoozeReminder(occurrenceId: string, minutes: number): Promise<Reminder>;
  // ── Bookmarks: the things saved (@pistachio/shell-contracts/bookmarks) ───────────────────
  getBookmarks(): Promise<BookmarkSnapshot>;
  onBookmarks(listener: (snapshot: BookmarkSnapshot) => void): () => void;
  /**
   * Save a tab's page — the active one when omitted — as the person, the
   * way the double tap of shift does. Resolves with the skeleton at once;
   * the finished card follows through onBookmarks.
   */
  /** Show the tab's article as a reader page, or leave one. False when there is no article. */
  toggleReaderView(tabId?: string): Promise<boolean>;
  bookmarkTab(tabId?: string): Promise<Bookmark>;
  /** Save an address the person typed; resolves once the page has been read. */
  addBookmark(input: BookmarkInput): Promise<Bookmark>;
  updateBookmark(id: string, patch: BookmarkPatch): Promise<Bookmark>;
  deleteBookmark(id: string): Promise<void>;
  /** Read the page again and refill what the person has not edited. */
  refreshBookmark(id: string): Promise<Bookmark>;
  /** The card over the page: which bookmark it shows, or null when it is down. */
  getBookmarkToast(): Promise<BookmarkToast | null>;
  onBookmarkToast(listener: (toast: BookmarkToast | null) => void): () => void;
  /** Open the bookmarks page in the shell, landing on one bookmark when given. */
  openBookmarksPage(bookmarkId?: string): void;
  /** Read or manage the active Space's desktop-local browsing archive. */
  watchtower(request: WatchtowerRequest): Promise<WatchtowerResponse>;
  /** Wipe the active Space's site data (cookies, storage, cache). */
  clearBrowsingData(): Promise<void>;
  /** App version, platform, and where settings live. */
  getAppInfo(): Promise<AppInfo>;
  // ── App updates (@pistachio/shell-contracts/updates) ───────────────────────────────────
  /** Where the app stands with respect to a newer release. */
  getUpdateState(): Promise<UpdateState>;
  /** Ask the release feed now, regardless of the schedule. */
  checkForUpdates(): Promise<UpdateState>;
  /** Fetch an available update in the background. */
  downloadUpdate(): Promise<UpdateState>;
  // ── First-run onboarding (@pistachio/shell-contracts/onboarding) ──────
  /**
   * Speech to text for the about step. Rejects with a readable message when
   * no model can transcribe, so the wizard can offer typing instead.
   */
  transcribeSpeech(input: SpeechInput): Promise<string>;
  /** Name, bio, and facts read out of an introduction — by a model, or heuristically without one. */
  extractOnboardingIntake(transcript: string): Promise<OnboardingIntake>;
  /** Everything the wizard gathered, applied at once; resolves when the welcome tabs are open. */
  completeOnboarding(input: OnboardingCompletion): Promise<void>;
  // ── Account (§10.1) — every getter answers before sign-in ────────────────
  getAccount(): Promise<AccountState>;
  onAccount(listener: (state: AccountState) => void): () => void;
  /** Shell only: create the account, then `enroll()` this Mac. */
  signUp(email: string, password: string): Promise<AccountState>;
  /** Shell only: join an existing account; the password also unlocks its Space keys. */
  signIn(email: string, password: string): Promise<AccountState>;
  /** Shell only: enroll this Mac's keys; the recovery code in the answer is shown once. */
  enroll(): Promise<AccountEnrollResult>;
  /** Shell only: forget the account here; Spaces and tabs stay, cookies do not (§10.1). */
  signOut(): Promise<AccountState>;
  changePassword(currentPassword: string, newPassword: string): Promise<AccountState>;
  /** Shell only: mint a fresh recovery code (the previous one stops working); shown once. */
  recoveryCode(): Promise<string>;
  // ── Devices ───────────────────────────────────────────────────────────
  listDevices(): Promise<DeviceInfo[]>;
  onDevices(listener: (devices: DeviceInfo[]) => void): () => void;
  renameDevice(deviceId: string, name: string): Promise<DeviceInfo[]>;
  /** Shell only: revoke a device on control; its sync socket closes and its wrappers go. */
  revokeDevice(deviceId: string): Promise<DeviceInfo[]>;
  /** Shell only: accept the cloud device control introduced after the pin (see AccountState.cloudDeviceChanged). */
  confirmCloudDevice(): Promise<AccountState>;
  // ── Cookie sync (§10.2) ───────────────────────────────────────────────
  getSyncStatus(): Promise<SyncStatus>;
  onSyncStatus(listener: (status: SyncStatus) => void): () => void;
  getSyncOriginInfo(spaceId: string, host: string): Promise<SyncOriginInfo>;
  setSyncOriginOverride(spaceId: string, host: string, override: SyncOriginOverride | null): Promise<SyncOriginInfo>;
  /** Roll one origin's cookies back to the last version before the remote change. */
  rollbackSyncOrigin(spaceId: string, host: string): Promise<void>;
  /** Dial again, and drain what was parked. */
  retrySync(): Promise<SyncStatus>;
  // ── Workspace sync: Spaces and restore points (§10.2) ─────────────────
  getWorkspaceSync(): Promise<WorkspaceSyncStatus>;
  onWorkspaceSync(listener: (status: WorkspaceSyncStatus) => void): () => void;
  runWorkspaceSync(action: WorkspaceSyncAction): Promise<WorkspaceSyncStatus>;
  // ── Identity egress (§10.3) ───────────────────────────────────────────
  getEgressStatus(): Promise<EgressStatus>;
  onEgressStatus(listener: (status: EgressStatus) => void): () => void;
  setSpaceEgressPolicy(spaceId: string, policy: SpaceEgressPolicy): Promise<EgressStatus>;
  /** Shell only: the explicit, logged escape hatch while the gateway is down; resets when it returns. */
  browseDirectForNow(spaceId: string): Promise<EgressStatus>;
  // ── Cloud browser (§10.4) ─────────────────────────────────────────────
  getCloudStatus(): Promise<CloudStatus>;
  onCloudStatus(listener: (status: CloudStatus) => void): () => void;
  /** Shell only: hand the cloud browser this Space's key (wrapped to its pinned device). */
  enableCloud(spaceId: string): Promise<CloudStatus>;
  disableCloud(spaceId: string): Promise<CloudStatus>;
  /** Shell only: start a hosted run in the cloud browser; it appears in the thread list. */
  startCloudRun(request: CloudStartRunRequest): Promise<{ runId: string }>;
  /** Shell only: open the live view of a cloud run; frames arrive on onCloudFrame. */
  openLiveView(runId: string): Promise<CloudStatus>;
  closeLiveView(): Promise<void>;
  /** Shell only: pointer and keyboard input while the person holds control. */
  sendLiveInput(input: CloudLiveInput): void;
  onCloudFrame(listener: (frame: CloudFrame) => void): () => void;
  // ── Channels (§7.3) ───────────────────────────────────────────────────
  listChannels(): Promise<ChannelInfo[]>;
  /** Shell only: the secret in the answer is the only time it is shown. */
  createChannel(request: ChannelCreateRequest): Promise<ChannelCreated>;
  deleteChannel(linkId: string): Promise<ChannelInfo[]>;
  // ── iMessage ─────────────────────────────────────────────────────────
  getIMessageLink(): Promise<IMessageLinkStatus>;
  startIMessageLink(phone: string): Promise<IMessageLinkChallenge>;
  verifyIMessageLink(challengeId: string, code: string): Promise<IMessageLinkStatus>;
  unlinkIMessage(): Promise<IMessageLinkStatus>;
  // ── Credential vault ────────────────────────────────────────────────
  vaultList(spaceId: string): Promise<VaultEntryInfo[]>;
  /** The entry's values, opened with this Mac's Space key, keyed by field id. */
  vaultReveal(spaceId: string, entryId: string): Promise<Record<string, string>>;
  vaultSave(spaceId: string, entryId: string | null, draft: VaultEntryDraft): Promise<VaultEntryInfo>;
  vaultDelete(spaceId: string, entryId: string): Promise<void>;
  // ── Integrations (D29) ──────────────────────────────────────────────
  integrationProviders(): Promise<IntegrationProviderInfo[]>;
  integrationList(spaceId: string): Promise<IntegrationConnectionInfo[]>;
  /** Shell only: opens the provider's consent page as a tab and waits for it. */
  integrationConnect(spaceId: string, provider: IntegrationProvider, access: IntegrationAccess): Promise<IntegrationConnectionInfo>;
  integrationSetAccess(spaceId: string, connectionId: string, access: IntegrationAccess): Promise<IntegrationConnectionInfo>;
  integrationDisconnect(spaceId: string, connectionId: string): Promise<void>;
  /** The Space's connected Google Calendar between two instants (ISO), for the home page's schedule. */
  integrationCalendarEvents(spaceId: string, from: string, to: string): Promise<CalendarAgenda>;

  // ── Reports ─────────────────────────────────────────────────────────
  /**
   * Generated reports — today the daily brief. One member carrying a request
   * union, like `watchtower`: read a stored brief, generate today's, or write
   * back a tick. The answer's `spec` is a json-render spec over the report
   * catalog; the shell validates it again before drawing it.
   */
  reports(request: ReportRequest): Promise<ReportResponse>;

  // ── Notes (@pistachio/shell-contracts/notes) ─────────────────────────
  /**
   * The person's notes — read, written and published through one member
   * carrying a request union, like `watchtower` and `reports`. Bodies travel
   * only on `get`/`update`; the subscription is metadata (docs/notes.md §4).
   */
  notes(request: NoteRequest): Promise<NoteResponse>;
  onNotes(listener: (snapshot: NoteSnapshot) => void): () => void;
  /**
   * Rename a tab from the page drawn inside it: a note's title is known to
   * the shell, not to the static placeholder the host took the tab's name
   * from. Shell pages only — the host refuses it for a tab that is not one,
   * so no web page can rename its own tab.
   */
  setTabTitle(tabId: string, title: string): Promise<void>;
}

/**
 * The other half: members whose implementation needs an Electron window, a
 * WebContentsView, the OS pointer or a native dialog, or that exist only to
 * place native views over holes in the DOM (W6). A stream surface has none of
 * these, so the shell UI reaches them through `nativeApi()`, which is null
 * there, and every caller must go on working without them.
 */
export interface NativeSurfaceApi {
  /** Trusted shell only: relay metadata and encrypted submissions through main. */
  getCredentialCapture(captureId: string): Promise<CredentialCaptureReply<CredentialCapture>>;
  submitCredentialCapture(captureId: string, sealedPayload: string): Promise<CredentialCaptureReply<null>>;

  /** Place the playing tab's live video inside the sidebar, or restore it. */
  setMediaPreview(preview: MediaPreviewPlacement | null): void;
  /** The native video surface entered or left the sidebar card. */
  onMediaPreviewHoverChanged(listener: (tabId: string | null) => void): () => void;
  setLayout(layout: BrowserLayout): void;
  /**
   * Capture the visible panes while their native views remain on screen.
   * The shell paints these stills before it raises an overlay.
   */
  prepareOverlay(): Promise<PaneStill[]>;
  /** Hide or restore the native tab views after the shell has painted their stills. */
  setOverlay(active: boolean): Promise<void>;
  /**
   * The owner's still is painted under its live view: main can now hide the
   * view without a blank frame, and the renderer starts the opening motion.
   */
  recedeGlanceOwner(): void;
  /** Show/move the native preview at the renderer-computed 80% frame; null hides it. */
  setGlanceBounds(bounds: ContentBounds | null): void;
  /**
   * Capture the live preview's last frame. The view stays up until the
   * renderer has painted that frame and hides it with setGlanceBounds(null).
   */
  prepareGlanceClose(): Promise<string | null>;
  /**
   * Mark promotion in progress and synchronously place the same live preview
   * at `bounds`. The renderer advances those bounds with its visual frame.
   */
  stageGlancePromotion(bounds: ContentBounds): Promise<void>;
  // ── Native utility views (@pistachio/shell-contracts/chrome) ────────────────────────────
  /**
   * Shell only: hand the pointer to the drag layer for a pane-resize gesture,
   * or `null` to give it back. While it is up the tab views stay VISIBLE and
   * keep tracking the panes, so the pages reflow as the drag goes — see the
   * drag capture section of @pistachio/shell-contracts/chrome.
   */
  setDragCapture(cursor: DragCursor | null): void;
  /** Drag layer only: which cursor to hold, or null when the gesture is over. */
  onDragCapture(listener: (cursor: DragCursor | null) => void): () => void;
  /** Shell → drag layer: paint or update the tab ghost above live page views. */
  setTabDragVisual(visual: TabDragVisual | null): void;
  /** Drag layer only: receive the shell-computed tab ghost and armed edge. */
  onTabDragVisual(listener: (visual: TabDragVisual | null) => void): () => void;
  /** Drag layer only: relay one pointer sample to the shell. */
  sendDragSample(sample: DragSample): void;
  /** Shell only: the samples the drag layer relays while it holds the pointer. */
  onDragSample(listener: (sample: DragSample) => void): () => void;
  /**
   * Shell only: the compact sidebar's column is up at this box — watch the
   * OS pointer for it and say when the pointer has left (@pistachio/shell-contracts/chrome,
   * "the compact sidebar"). null stops the watch.
   */
  setSidebarWatch(box: ContentBounds | null): void;
  /** Shell only: main saw pointer movement inside the compact reveal target. */
  onSidebarPointerEntered(listener: () => void): () => void;
  /** Shell only: main saw the pointer leave the watched column. */
  onSidebarPointerLeft(listener: () => void): () => void;
  /**
   * Shell only: the pane toolbar's reveal target is at this box (the gap
   * above the page card) — watch the OS pointer for movement inside it
   * (@pistachio/shell-contracts/chrome, "pane toolbar"). null stops the watch.
   */
  setPaneToolbarTrigger(box: ContentBounds | null): void;
  /** Shell only: the pane toolbar is up at this box — say when the pointer has left it. null stops the watch. */
  setPaneToolbarWatch(box: ContentBounds | null): void;
  /** Shell only: main saw pointer movement inside the pane toolbar's reveal target. */
  onPaneToolbarPointerEntered(listener: () => void): () => void;
  /** Shell only: main saw the pointer leave the revealed pane toolbar. */
  onPaneToolbarPointerLeft(listener: () => void): () => void;
  /**
   * Where the OS pointer is right now, in the window's content box — or
   * null when main cannot say (under Playwright, whose synthetic pointer
   * moves nothing the OS reports).
   */
  getCursorPoint(): Promise<CursorPoint | null>;
  /** Shell → main: state needed for native window and utility-view coordination. */
  setShellState(state: ShellState): void;
  dismissBookmarkToast(): void;
  /** Bookmark view only: the card's rendered height, so main can size the view to it. */
  resizeBookmarkToast(height: number): void;
  // ── The notice stack (@pistachio/shell-contracts/notice) ──────────────────────────────
  /** Shell only: the live notices and the browser surface's box, for the native notice view. */
  setNotices(frame: NoticeFrame): void;
  /** Notice view only: what is up right now, for a view that loaded after the first notice. */
  getNotices(): Promise<NoticeStackState>;
  /** Notice view only: every change to the live notices. */
  onNotices(listener: (state: NoticeStackState) => void): () => void;
  /** Notice view only: the height its stack needs, so main can size the view to it. */
  resizeNoticeView(height: number): void;
  /** Notice view only: a click on a card, or the pointer coming and going. */
  sendNoticeEvent(event: NoticeEvent): void;
  /** Shell only: those clicks, relayed by main to the store that owns the notices. */
  onNoticeEvent(listener: (event: NoticeEvent) => void): () => void;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  /** Quit and relaunch into a downloaded update. */
  installUpdate(): void;
  // ── First-run onboarding (@pistachio/shell-contracts/onboarding) ───────────────────────
  /** The browsers on this Mac and their profiles, for the import step. */
  detectBrowsers(): Promise<InstalledBrowser[]>;
  /** Bring the chosen profiles' sessions and bookmarks into the active Space, one result per profile. */
  importBrowserProfiles(
    requests: BrowserImportRequest[],
  ): Promise<BrowserImportResult[]>;
  /** Ask the OS for the microphone before the about step records. */
  requestMicrophone(): Promise<boolean>;
  /**
   * What main already knows when the window opens, answered SYNCHRONOUSLY
   * so the shell's first render can already act on it: whether this
   * install still owes the walkthrough. Without it the shell learns of
   * a first run only when the settings land, and the frames before then
   * show the chrome; with it the first painted frame is already the
   * wizard's. The settings that follow remain the authority.
   */
  launchState(): ShellLaunchState;
}

/**
 * The launch facts a native window can state before anything is rendered
 * (`NativeSurfaceApi.launchState`). A stream surface has no such moment:
 * it learns the same from the settings it loads.
 */
export interface ShellLaunchState {
  /** `!settings.onboarding.completed` as of this load: the wizard stands first. */
  firstRun: boolean;
}

/** The whole bridge the desktop preload exposes on the renderer global. */
export interface PistachioApi extends ShellApi, NativeSurfaceApi {}

/**
 * Why each member above is native-only, in the same spirit as the chrome
 * manifest's hidden-placement rule: a member may not sit here without a
 * reason a reader can check. The `satisfies` makes the keys exactly the
 * members of NativeSurfaceApi — no more, no fewer.
 */
export const NATIVE_SURFACE_MEMBERS = {
  getCredentialCapture: "Loads public capture metadata through the native account client.",
  submitCredentialCapture: "Relays ciphertext through main without browser-origin access.",
  setMediaPreview: "Re-parents a playing tab's native view into the sidebar card.",
  onMediaPreviewHoverChanged: "Reports the OS pointer over that re-parented native video view.",
  setLayout: "Places the native tab views over the panes' holes in the DOM.",
  prepareOverlay: "Captures the native tab views while they are still on screen.",
  setOverlay: "Hides and restores the native tab views under a shell overlay.",
  recedeGlanceOwner: "Coordinates the owner tab's native view with the glance view.",
  setGlanceBounds: "Places the native glance preview view at the shell's frame.",
  prepareGlanceClose: "Captures the native glance view's last frame before it hides.",
  stageGlancePromotion: "Moves the native glance view while the promotion animates.",
  setDragCapture: "Hands the OS pointer to the native drag layer window.",
  onDragCapture: "The native drag layer's own subscription to the held cursor.",
  setTabDragVisual: "Paints the tab ghost in the native drag layer over page views.",
  onTabDragVisual: "The native drag layer's own subscription to that ghost.",
  sendDragSample: "Relays OS pointer samples out of the native drag layer window.",
  onDragSample: "Receives the native drag layer's OS pointer samples.",
  setSidebarWatch: "Asks main to poll the OS cursor over the compact sidebar column.",
  onSidebarPointerEntered: "Fires from main's OS cursor poll over the sidebar reveal target.",
  onSidebarPointerLeft: "Fires from main's OS cursor poll leaving the watched column.",
  setPaneToolbarTrigger: "Asks main to poll the OS cursor over the pane toolbar's gap.",
  setPaneToolbarWatch: "Asks main to poll the OS cursor over the revealed pane toolbar.",
  onPaneToolbarPointerEntered: "Fires from main's OS cursor poll over the pane toolbar trigger.",
  onPaneToolbarPointerLeft: "Fires from main's OS cursor poll leaving the pane toolbar.",
  getCursorPoint: "Reads the OS cursor position, which only a native window knows.",
  setShellState: "Drives the native window chrome and the utility view placement.",
  dismissBookmarkToast: "Takes the native bookmark card view down over the page.",
  resizeBookmarkToast: "Sizes the native bookmark card view to its rendered height.",
  setNotices: "Feeds and places the native notice view; a stream surface draws the stack in its own DOM.",
  getNotices: "The native notice view's own read of the live notices.",
  onNotices: "The native notice view's own subscription to the live notices.",
  resizeNoticeView: "Sizes the native notice view to its rendered stack.",
  sendNoticeEvent: "Relays clicks out of the native notice view.",
  onNoticeEvent: "Receives the native notice view's clicks.",
  onUpdateState: "Electron auto-update progress; W12 declares updates unsupported.",
  installUpdate: "Quits and relaunches this installed Electron application.",
  detectBrowsers: "Reads the browser profiles installed on this Mac (W12).",
  importBrowserProfiles: "Imports sessions from local browsers on this Mac (W12).",
  requestMicrophone: "Asks the OS for the microphone through a native permission dialog.",
  launchState: "A synchronous read over Electron IPC before the first render; a socket cannot answer before it connects.",
} as const satisfies Record<keyof NativeSurfaceApi, string>;

/** A recording from the renderer: base64 audio and what it is. */
export interface SpeechInput {
  data: string;
  mediaType: string;
}

/**
 * What the shell is running in, as its host reports it.
 *
 * `version`, `chrome` and `platform` are answered by every host. The other
 * two are the DESKTOP'S: an Electron build number and a path on a disk. A
 * session host has neither — it is a browser in a fleet, its settings are the
 * account's sealed `shell-settings:default` register, and there is no user
 * data directory to name — so both are optional and it omits them rather than
 * sending an empty string the About page would render as "Electron  ·" and
 * "/settings.json". `lib/about-rows.ts` in the shell decides what each
 * surface shows instead.
 */
export interface AppInfo {
  version: string;
  chrome: string;
  /** "darwin", "win32", "linux" — or "web" from a session host. */
  platform: string;
  /** Electron's own version. Absent where the shell is not in Electron. */
  electron?: string;
  /** Where this installation keeps its files. Absent where there are none. */
  userDataPath?: string;
}

export const IPC = {
  snapshot: "pistachio:snapshot",
  snapshotChanged: "pistachio:snapshot-changed",
  runChanged: "pistachio:run-changed",
  commandPaletteGet: "pistachio:command-palette-get",
  addressIntentRank: "pistachio:address-intent-rank",
  spaceSwitch: "pistachio:space-switch",
  spaceFork: "pistachio:space-fork",
  tabCreate: "pistachio:tab-create",
  tabClose: "pistachio:tab-close",
  tabSelect: "pistachio:tab-select",
  tabSuspend: "pistachio:tab-suspend",
  tabForcedFocus: "pistachio:tab-forced-focus",
  tabNavigate: "pistachio:tab-navigate",
  tabBack: "pistachio:tab-back",
  tabForward: "pistachio:tab-forward",
  tabReload: "pistachio:tab-reload",
  splitSet: "pistachio:split-set",
  tabReorder: "pistachio:tab-reorder",
  tabSplitWith: "pistachio:tab-split-with",
  tabRemoveFromSplit: "pistachio:tab-remove-from-split",
  tabDuplicate: "pistachio:tab-duplicate",
  tabMoveToSpace: "pistachio:tab-move-to-space",
  tabRestoreClosed: "pistachio:tab-restore-closed",
  tabsClearUnpinned: "pistachio:tabs-clear-unpinned",
  mediaGet: "pistachio:media-get",
  mediaChanged: "pistachio:media-changed",
  mediaReport: "pistachio:media-report",
  mediaControl: "pistachio:media-control",
  mediaCommand: "pistachio:media-command",
  mediaPresentation: "pistachio:media-presentation",
  mediaPreviewSet: "pistachio:media-preview-set",
  mediaPreviewHoverReport: "pistachio:media-preview-hover-report",
  mediaPreviewHoverChanged: "pistachio:media-preview-hover-changed",
  readAloudGet: "pistachio:read-aloud-get",
  aiStatusGet: "pistachio:ai-status-get",
  aiUsageGet: "pistachio:ai-usage-get",
  readAloudChanged: "pistachio:read-aloud-changed",
  readAloudCancel: "pistachio:read-aloud-cancel",
  readAloudSpeak: "pistachio:read-aloud-speak",
  /** Main → a tab's isolated preload: follow (or stop following) a clip being read from it. */
  readAloudFollow: "pistachio:read-aloud-follow",
  readerToggle: "pistachio:reader-toggle",
  browserControlsGet: "pistachio:browser-controls-get",
  browserControlsChanged: "pistachio:browser-controls-changed",
  browserControl: "pistachio:browser-control",
  downloadsGet: "pistachio:downloads-get",
  downloadsChanged: "pistachio:downloads-changed",
  tabDataPolicy: "pistachio:tab-data-policy",
  tabPolicyBlocked: "pistachio:tab-policy-blocked",
  tabPasskeySupportReport: "pistachio:tab-passkey-support-report",
  findGet: "pistachio:find-get",
  findChanged: "pistachio:find-changed",
  findCommand: "pistachio:find-command",
  sidebarCommand: "pistachio:sidebar-command",
  tabGroupCommand: "pistachio:tab-group-command",
  tabArchive: "pistachio:tab-archive",
  tidy: "pistachio:tidy",
  layoutSet: "pistachio:layout-set",
  overlayPrepare: "pistachio:overlay-prepare",
  overlaySet: "pistachio:overlay-set",
  tabSwitcherPreviewsGet: "pistachio:tab-switcher-previews-get",
  tabSwitcherInput: "pistachio:tab-switcher-input",
  glanceGet: "pistachio:glance-get",
  glanceChanged: "pistachio:glance-changed",
  glanceOpenRequest: "pistachio:glance-open-request",
  glanceIntent: "pistachio:glance-intent",
  glanceOpenFromShell: "pistachio:glance-open-from-shell",
  feedbackSubmit: "pistachio:feedback-submit",
  glanceConfiguration: "pistachio:glance-configuration",
  glanceDismissRequest: "pistachio:glance-dismiss-request",
  glanceDismissRequested: "pistachio:glance-dismiss-requested",
  glanceOwnerRecede: "pistachio:glance-owner-recede",
  glanceBoundsSet: "pistachio:glance-bounds-set",
  glancePrepareClose: "pistachio:glance-prepare-close",
  glancePromotionStage: "pistachio:glance-promotion-stage",
  glanceClose: "pistachio:glance-close",
  glancePromote: "pistachio:glance-promote",
  glanceSplit: "pistachio:glance-split",
  dragCaptureSet: "pistachio:drag-capture-set",
  dragCaptureChanged: "pistachio:drag-capture-changed",
  tabDragVisualSet: "pistachio:tab-drag-visual-set",
  tabDragVisualChanged: "pistachio:tab-drag-visual-changed",
  dragSample: "pistachio:drag-sample",
  sidebarWatchSet: "pistachio:sidebar-watch-set",
  sidebarPointerEntered: "pistachio:sidebar-pointer-entered",
  sidebarPointerLeft: "pistachio:sidebar-pointer-left",
  paneToolbarTriggerSet: "pistachio:pane-toolbar-trigger-set",
  paneToolbarWatchSet: "pistachio:pane-toolbar-watch-set",
  paneToolbarPointerEntered: "pistachio:pane-toolbar-pointer-entered",
  paneToolbarPointerLeft: "pistachio:pane-toolbar-pointer-left",
  cursorPoint: "pistachio:cursor-point",
  shellStateSet: "pistachio:shell-state-set",
  shellCommand: "pistachio:shell-command",
  runStart: "pistachio:run-start",
  runMessage: "pistachio:run-message",
  runAnswer: "pistachio:run-answer",
  runInterrupt: "pistachio:run-interrupt",
  runRetry: "pistachio:run-retry",
  runApprove: "pistachio:run-approve",
  runReject: "pistachio:run-reject",
  runTakeControl: "pistachio:run-take-control",
  runReleaseControl: "pistachio:run-release-control",
  runRevoke: "pistachio:run-revoke",
  threadOpen: "pistachio:thread-open",
  threadNew: "pistachio:thread-new",
  threadDelete: "pistachio:thread-delete",
  evidenceGet: "pistachio:evidence-get",
  settingsGet: "pistachio:settings-get",
  settingsUpdate: "pistachio:settings-update",
  settingsReset: "pistachio:settings-reset",
  settingsChanged: "pistachio:settings-changed",
  memoryGet: "pistachio:memory-get",
  memoryAdd: "pistachio:memory-add",
  memoryUpdate: "pistachio:memory-update",
  memoryForget: "pistachio:memory-forget",
  memoryRestore: "pistachio:memory-restore",
  memoryReview: "pistachio:memory-review",
  memoryForgetAll: "pistachio:memory-forget-all",
  memoryChanged: "pistachio:memory-changed",
  remindersGet: "pistachio:reminders-get",
  remindersChanged: "pistachio:reminders-changed",
  reminderAdd: "pistachio:reminder-add",
  reminderUpdate: "pistachio:reminder-update",
  reminderCancel: "pistachio:reminder-cancel",
  reminderDelete: "pistachio:reminder-delete",
  reminderRunNow: "pistachio:reminder-run-now",
  reminderAcknowledge: "pistachio:reminder-acknowledge",
  reminderSnooze: "pistachio:reminder-snooze",
  watchtower: "pistachio:watchtower",
  bookmarksGet: "pistachio:bookmarks-get",
  bookmarksChanged: "pistachio:bookmarks-changed",
  bookmarkTab: "pistachio:bookmark-tab",
  bookmarkAdd: "pistachio:bookmark-add",
  bookmarkUpdate: "pistachio:bookmark-update",
  bookmarkDelete: "pistachio:bookmark-delete",
  bookmarkRefresh: "pistachio:bookmark-refresh",
  bookmarkToastGet: "pistachio:bookmark-toast-get",
  bookmarkToastChanged: "pistachio:bookmark-toast-changed",
  bookmarkToastDismiss: "pistachio:bookmark-toast-dismiss",
  bookmarkToastResize: "pistachio:bookmark-toast-resize",
  noticesSet: "pistachio:notices-set",
  noticesGet: "pistachio:notices-get",
  noticesChanged: "pistachio:notices-changed",
  noticeViewResize: "pistachio:notice-view-resize",
  noticeEvent: "pistachio:notice-event",
  bookmarksOpen: "pistachio:bookmarks-open",
  browsingDataClear: "pistachio:browsing-data-clear",
  appInfo: "pistachio:app-info",
  updateGet: "pistachio:update-get",
  updateChanged: "pistachio:update-changed",
  updateCheck: "pistachio:update-check",
  updateDownload: "pistachio:update-download",
  updateInstall: "pistachio:update-install",
  browsersDetect: "pistachio:browsers-detect",
  browserImport: "pistachio:browser-import",
  microphoneRequest: "pistachio:microphone-request",
  speechTranscribe: "pistachio:speech-transcribe",
  onboardingExtract: "pistachio:onboarding-extract",
  onboardingComplete: "pistachio:onboarding-complete",
  /** Synchronous (`ipcRenderer.sendSync`): the preload asks before the page renders. */
  launchState: "pistachio:launch-state",
  // ── docs/cloud-sync-design.md §10.5 ───────────────────────────────────
  accountGet: "pistachio:account-get",
  accountSignUp: "pistachio:account-sign-up",
  accountSignIn: "pistachio:account-sign-in",
  accountSignOut: "pistachio:account-sign-out",
  accountChangePassword: "pistachio:account-change-password",
  accountRecoveryCode: "pistachio:account-recovery-code",
  accountEnroll: "pistachio:account-enroll",
  accountChanged: "pistachio:account-changed",
  devicesList: "pistachio:devices-list",
  devicesRename: "pistachio:devices-rename",
  devicesRevoke: "pistachio:devices-revoke",
  devicesConfirmCloud: "pistachio:devices-confirm-cloud",
  devicesUpdated: "pistachio:devices-updated",
  syncStatus: "pistachio:sync-status",
  syncOriginInfo: "pistachio:sync-origin-info",
  syncSetOriginOverride: "pistachio:sync-set-origin-override",
  syncRollbackOrigin: "pistachio:sync-rollback-origin",
  syncRetry: "pistachio:sync-retry",
  syncChanged: "pistachio:sync-changed",
  workspaceSyncGet: "pistachio:workspace-sync-get",
  workspaceSyncRun: "pistachio:workspace-sync-run",
  workspaceSyncChanged: "pistachio:workspace-sync-changed",
  egressStatus: "pistachio:egress-status",
  egressSetSpacePolicy: "pistachio:egress-set-space-policy",
  egressBrowseDirect: "pistachio:egress-browse-direct",
  egressChanged: "pistachio:egress-changed",
  cloudStatus: "pistachio:cloud-status",
  cloudEnable: "pistachio:cloud-enable",
  cloudDisable: "pistachio:cloud-disable",
  cloudStartRun: "pistachio:cloud-start-run",
  cloudLiveOpen: "pistachio:cloud-live-open",
  cloudLiveClose: "pistachio:cloud-live-close",
  cloudLiveInput: "pistachio:cloud-live-input",
  cloudFrame: "pistachio:cloud-frame",
  cloudChanged: "pistachio:cloud-changed",
  channelsList: "pistachio:channels-list",
  channelsCreate: "pistachio:channels-create",
  channelsDelete: "pistachio:channels-delete",
  imessageGet: "pistachio:imessage-get",
  imessageStart: "pistachio:imessage-start",
  imessageVerify: "pistachio:imessage-verify",
  imessageUnlink: "pistachio:imessage-unlink",
  credentialCaptureGet: "pistachio:credential-capture-get",
  credentialCaptureSubmit: "pistachio:credential-capture-submit",
  vaultList: "pistachio:vault-list",
  vaultReveal: "pistachio:vault-reveal",
  vaultSave: "pistachio:vault-save",
  vaultDelete: "pistachio:vault-delete",
  integrationProviders: "pistachio:integration-providers",
  integrationList: "pistachio:integration-list",
  integrationConnect: "pistachio:integration-connect",
  integrationSetAccess: "pistachio:integration-set-access",
  integrationDisconnect: "pistachio:integration-disconnect",
  integrationCalendarEvents: "pistachio:integration-calendar-events",
  reports: "pistachio:reports",
  notes: "pistachio:notes",
  notesChanged: "pistachio:notes-changed",
  setTabTitle: "pistachio:set-tab-title",
} as const;

/** Every member of ShellApi that is a call rather than a subscription. */
export type ShellMethodName = Exclude<keyof ShellApi, `on${string}`>;

/** Every member of ShellApi that is a subscription. */
export type ShellEventMember = Extract<keyof ShellApi, `on${string}`>;

/** One `on*` member of ShellApi and the channel its payload travels on. */
export interface ShellEventChannel {
  member: ShellEventMember;
  channel: (typeof IPC)[keyof typeof IPC];
}

/**
 * Exhaustiveness at the type level. When the list below misses a member the
 * rest parameter stops being empty, so the call needs an argument nobody can
 * supply and the compiler names what is missing — a transport built from
 * these lists can therefore never silently drop a method or a channel.
 */
function allMethods<const L extends readonly ShellMethodName[]>(
  list: L,
  ...missing: [ShellMethodName] extends [L[number]] ? [] : [missing: Exclude<ShellMethodName, L[number]>]
): L {
  void missing;
  return list;
}

function allEvents<const L extends readonly ShellEventChannel[]>(
  list: L,
  ...missing: [ShellEventMember] extends [L[number]["member"]]
    ? []
    : [missing: Exclude<ShellEventMember, L[number]["member"]>]
): L {
  void missing;
  return list;
}

/**
 * The non-`on*` members of ShellApi as a runtime array, so a transport builds
 * its RPC client from the contract rather than from a hand-kept list
 * (docs/web-browser-design.md §5).
 */
export const SHELL_METHOD_NAMES = allMethods([  "getSnapshot",
  "getCommandPalette",
  "rankAddressIntent",
  "switchSpace",
  "forkSpace",
  "createTab",
  "closeTab",
  "selectTab",
  "suspendTab",
  "navigate",
  "goBack",
  "goForward",
  "reload",
  "setSplit",
  "reorderTab",
  "splitWith",
  "removeFromSplit",
  "duplicateTab",
  "setForcedFocus",
  "moveTabToSpace",
  "restoreClosedTab",
  "clearUnpinnedTabs",
  "getMedia",
  "controlMedia",
  "getReadAloud",
  "cancelReadAloud",
  "readAloudText",
  "getBrowserControls",
  "browserControl",
  "getDownloads",
  "getFindState",
  "find",
  "sidebarCommand",
  "tabGroupCommand",
  "tabArchive",
  "tidy",
  "getTabSwitcherPreviews",
  "getGlance",
  "openGlance",
  "submitFeedback",
  "closeGlance",
  "promoteGlance",
  "splitGlance",
  "startDelegation",
  "sendAgentMessage",
  "answerAgentQuestion",
  "interruptAgent",
  "retryAgentTurn",
  "approve",
  "reject",
  "takeControl",
  "releaseControl",
  "revokeRun",
  "openThread",
  "newThread",
  "deleteThread",
  "getEvidence",
  "getSettings",
  "getAiStatus",
  "getAiUsage",
  "updateSettings",
  "resetSettings",
  "getMemory",
  "addMemory",
  "updateMemory",
  "forgetMemory",
  "restoreMemory",
  "reviewMemory",
  "forgetAllMemory",
  "getReminders",
  "addReminder",
  "updateReminder",
  "cancelReminder",
  "deleteReminder",
  "runReminderNow",
  "acknowledgeReminders",
  "snoozeReminder",
  "getBookmarks",
  "toggleReaderView",
  "bookmarkTab",
  "addBookmark",
  "updateBookmark",
  "deleteBookmark",
  "refreshBookmark",
  "getBookmarkToast",
  "openBookmarksPage",
  "watchtower",
  "clearBrowsingData",
  "getAppInfo",
  "getUpdateState",
  "checkForUpdates",
  "downloadUpdate",
  "transcribeSpeech",
  "extractOnboardingIntake",
  "completeOnboarding",
  "getAccount",
  "signUp",
  "signIn",
  "enroll",
  "signOut",
  "changePassword",
  "recoveryCode",
  "listDevices",
  "renameDevice",
  "revokeDevice",
  "confirmCloudDevice",
  "getSyncStatus",
  "getSyncOriginInfo",
  "setSyncOriginOverride",
  "rollbackSyncOrigin",
  "retrySync",
  "getWorkspaceSync",
  "runWorkspaceSync",
  "getEgressStatus",
  "setSpaceEgressPolicy",
  "browseDirectForNow",
  "getCloudStatus",
  "enableCloud",
  "disableCloud",
  "startCloudRun",
  "openLiveView",
  "closeLiveView",
  "sendLiveInput",
  "listChannels",
  "createChannel",
  "deleteChannel",
  "getIMessageLink",
  "startIMessageLink",
  "verifyIMessageLink",
  "unlinkIMessage",
  "vaultList",
  "vaultReveal",
  "vaultSave",
  "vaultDelete",
  "integrationProviders",
  "integrationList",
  "integrationConnect",
  "integrationSetAccess",
  "integrationDisconnect",
  "integrationCalendarEvents",
  "reports",
  "notes",
  "setTabTitle",
]);

/**
 * The `on*` members of ShellApi paired with the channel each carries, derived
 * from the IPC map above so a generic transport can map them and the two can
 * never drift.
 */
export const SHELL_EVENT_CHANNELS = allEvents([
  { member: "onSnapshot", channel: IPC.snapshotChanged },
  { member: "onRun", channel: IPC.runChanged },
  { member: "onMediaChanged", channel: IPC.mediaChanged },
  { member: "onReadAloudChanged", channel: IPC.readAloudChanged },
  { member: "onBrowserControlsChanged", channel: IPC.browserControlsChanged },
  { member: "onDownloadsChanged", channel: IPC.downloadsChanged },
  { member: "onFindStateChanged", channel: IPC.findChanged },
  { member: "onTabSwitcherInput", channel: IPC.tabSwitcherInput },
  { member: "onGlanceChanged", channel: IPC.glanceChanged },
  { member: "onGlanceDismissRequested", channel: IPC.glanceDismissRequested },
  { member: "onShellCommand", channel: IPC.shellCommand },
  { member: "onSettings", channel: IPC.settingsChanged },
  { member: "onMemory", channel: IPC.memoryChanged },
  { member: "onReminders", channel: IPC.remindersChanged },
  { member: "onBookmarks", channel: IPC.bookmarksChanged },
  { member: "onNotes", channel: IPC.notesChanged },
  { member: "onBookmarkToast", channel: IPC.bookmarkToastChanged },
  { member: "onAccount", channel: IPC.accountChanged },
  { member: "onDevices", channel: IPC.devicesUpdated },
  { member: "onSyncStatus", channel: IPC.syncChanged },
  { member: "onWorkspaceSync", channel: IPC.workspaceSyncChanged },
  { member: "onEgressStatus", channel: IPC.egressChanged },
  { member: "onCloudStatus", channel: IPC.cloudChanged },
  { member: "onCloudFrame", channel: IPC.cloudFrame },
]);
