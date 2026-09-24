import { create } from "zustand";
import type { EvidenceEntry } from "@pistachio/evidence";
import type { MemoryAddInput, MemoryReview, MemorySnapshot, MemoryUpdateInput } from "@pistachio/shell-contracts/memory";
import type { ReminderInput, ReminderPatch, ReminderSnapshot } from "@pistachio/shell-contracts/reminders";
import type { BookmarkInput, BookmarkPatch, BookmarkSnapshot, BookmarkToast } from "@pistachio/shell-contracts/bookmarks";
import { isTerminalStatus, type AgentAttachment, type FeedbackInput } from "@pistachio/protocol";
import type { ChatInsert } from "@pistachio/shell-contracts/chat-insert";
import type {
  AccountEnrollResult,
  AccountState,
  AgentTurnOptions,
  BrowserTabInfo,
  ChannelCreated,
  ChannelCreateRequest,
  ChannelInfo,
  CloudLiveInput,
  CloudStartRunRequest,
  CloudStatus,
  ContentBounds,
  DeviceInfo,
  EgressStatus,
  FeedbackOutcome,
  GlanceState,
  PaneStill,
  ShellRunSnapshot,
  ShellSnapshot,
  ShellTabsSnapshot,
  SplitMode,
  SplitSide,
  SyncOriginInfo,
  SyncOriginOverride,
  SyncStatus,
  TabSwitcherPreview,
  WorkspaceSyncAction,
  WorkspaceSyncStatus,
} from "@pistachio/shell-contracts/ipc";
import { DEFAULT_SETTINGS, type DesktopSettings, type SettingsPatch, type SettingsSection } from "@pistachio/shell-contracts/settings";
import type { SidebarCommand } from "@pistachio/shell-contracts/sidebar";
import type { TabGroupCommand, TabGroupCommandResult } from "@pistachio/shell-contracts/tab-groups";
import { tidyDidSomething, tidySummaryText, type TidySummary } from "@pistachio/shell-contracts/tidy";
import type { BrowserMediaInfo, MediaControl, ReadAloudStatus } from "@pistachio/shell-contracts/media";
import {
  BROWSER_PERMISSIONS,
  GUARDED_BROWSER_ACTIONS,
  type ActionDecision,
  type BrowserControlCommand,
  type BrowserControlsSnapshot,
  type BrowserDownload,
  type BrowserPermission,
  type BrowserPolicyVerdict,
  type GuardedBrowserAction,
  type PermissionDecision,
} from "@pistachio/shell-contracts/browser-controls";
import { isShellUnsupported } from "@pistachio/shell-contracts/socket";

/**
 * What the site-controls surface shows when the host cannot say: no site, no
 * decisions, nothing playing. It is the shape of "we do not know", not a
 * claim that a site was allowed anything.
 */
const NEUTRAL_BROWSER_CONTROLS: BrowserControlsSnapshot = {
  tabId: null,
  tabKind: null,
  origin: "",
  secure: false,
  zoomPercent: 100,
  muted: false,
  permissions: Object.fromEntries(
    BROWSER_PERMISSIONS.map((permission) => [
      permission,
      { decision: "ask", source: "default", reason: "This host does not report site permissions." },
    ]),
  ) as Record<BrowserPermission, BrowserPolicyVerdict<PermissionDecision>>,
  externalAppSchemes: [],
  // FAIL CLOSED. A guarded action's verdict is the answer to "may this leave
  // the page", and "we could not ask" is not a yes: a `getBrowserControls`
  // that refused or timed out on a managed browser must not leave the shell
  // offering copy, paste, download and print as allowed. `ActionDecision` has
  // no third value, so the shape of "we do not know" is `block` with a reason
  // that says so, and the surfaces pair it with the load failure the store
  // recorded (`failed`) so the person sees why rather than a silent denial.
  actions: Object.fromEntries(
    GUARDED_BROWSER_ACTIONS.map((action) => [
      action,
      { decision: "block", source: "default", reason: "Site controls could not be loaded, so this is held back." },
    ]),
  ) as Record<GuardedBrowserAction, BrowserPolicyVerdict<ActionDecision>>,
  passkeys: {
    webAuthnAvailable: false,
    platformAuthenticatorAvailable: false,
    conditionalMediationAvailable: false,
    touchIdConfigured: false,
  },
  pendingPermissions: [],
  pendingPasskeyRequests: [],
  downloads: [],
  recentEvents: [],
};
import type { ForkSpaceRequest, ForkSpaceResult, SpaceEgressPolicy } from "@pistachio/shell-contracts/spaces";
import type { OnboardingCompletion } from "@pistachio/shell-contracts/onboarding";
import { DEFAULT_ACCOUNT } from "./lib/account";
import {
  DEFAULT_CLOUD_STATUS,
  DEFAULT_EGRESS_STATUS,
  DEFAULT_SYNC_STATUS,
  DEFAULT_WORKSPACE_SYNC,
} from "./lib/sync";
import { hostOf, displayHost } from "./lib/url";
import { clearRecents, dismissRecent, loadRecents, recordVisit, refaviconVisit, retitleVisit, type RecentSite } from "./lib/recents";
import { share } from "./lib/share";
import { clampPanelWidth, getStoredPanelWidth, storePanelWidth } from "./lib/panel";
import { permissionPromptOverlay } from "./lib/permission-prompt";
import { pushNotice, type NoticeOptions, type ShellNotice } from "./lib/notices";
import { clampSidebarWidth, getStoredSidebarWidth, storeSidebarWidth } from "./lib/sidebar";
import { tabSwitcherIndex } from "@pistachio/shell-contracts/tab-switcher";
import { noteUrl } from "@pistachio/shell-contracts/notes";
import { BRIEF_PAGE_URL } from "@pistachio/shell-contracts/reports";
import { isShellPageUrl } from "@pistachio/shell-contracts/shell-pages";
import { updateVersion, type UpdateState } from "@pistachio/shell-contracts/updates";
import { nativeApi, shellApi } from "./api";

/** The one raised shell surface at a time, including the chrome status card. */
export type Overlay =
  | "none"
  | "url"
  | "settings"
  | "reminders"
  | "bookmarks"
  | "watchtower"
  /** The archive of tabs Tidy put away and groups that were closed (components/archive/ArchivePage.tsx). */
  | "archive"
  | "site"
  /** The quick site-info popover under the active tab (components/SiteInfoPopover.tsx). */
  | "site-info"
  /**
   * A site's permission or passkey request, as a compact dialog over the
   * page (components/PermissionPromptDialog.tsx; lib/permission-prompt.ts).
   */
  | "permission"
  | "space-fork"
  | "tab-switcher"
  | "liveView"
  | "status"
  | "context-menu"
  | "image-preview"
  /** The downloads list under its chip (components/DownloadsPopover.tsx). */
  | "downloads";

/** The overlays that are a full-window page over the content hole (components/ContentArea.tsx). */
export function isPageOverlay(overlay: Overlay): boolean {
  return overlay === "settings" || overlay === "reminders" || overlay === "bookmarks" || overlay === "watchtower" || overlay === "archive";
}

export type { NoticeOptions, ShellNotice } from "./lib/notices";

/** Notice ids: only ever compared, so a counter — two said in one millisecond must still differ. */
let noticeSerial = 0;

/**
 * Statuses that leave nothing in flight. Opening the console over one of
 * these means the person wants a fresh conversation, not the old transcript.
 */

/** What a page's right-click menu sent the composer, until the composer takes it. */
export interface ChatInbox {
  inserts: ChatInsert[];
  rejection: string | null;
}

const EMPTY_CHAT_INBOX: ChatInbox = { inserts: [], rejection: null };

/** The tab a strip/shelf drag is carrying, shown large in the split drop preview. */
export interface SplitDragTab {
  title: string;
  url: string;
  faviconUrl: string | null;
}

export interface AppState {
  snapshot: ShellSnapshot | null;
  /** The agent console (the right-hand delegation panel) is open. */
  consoleOpen: boolean;
  /**
   * "Add … to Chat" from a page, waiting for the composer. It is kept here
   * rather than in the console because the console may be closed — or
   * showing evidence — at the moment the menu item is chosen.
   */
  chatInbox: ChatInbox;
  /** The agent console's width in px — clamped and persisted on every set. */
  consoleWidth: number;
  /** The sidebar's width in px, pinned or compact — clamped and persisted on every set. */
  sidebarWidth: number;
  /**
   * The compact sidebar's column is in the layout: the pointer brought it
   * out at the window's edge and has not left it (layouts/SidebarLayout.tsx).
   * Meaningless while the sidebar is pinned or the layout is top tabs.
   */
  sidebarRevealed: boolean;
  /**
   * How many of the sidebar footer's menus (components/SidebarMenu.tsx) are
   * open. Their panels open upward over the media stack, whose video is a
   * native view above this page, so the stack drops that view while one is
   * up (components/MediaStack.tsx).
   */
  footerMenusOpen: number;
  /**
   * The pane toolbar is over the page card: the pointer brought it out in
   * the gap above the card and has not left it (components/PaneToolbar.tsx).
   * Sidebar layout only.
   */
  paneToolbarRevealed: boolean;
  evidence: EvidenceEntry[] | null;
  error: string | null;
  /**
   * Members this host answered `unsupported` for, and the reason it gave
   * (docs/web-browser-design.md §11, W12). A settings section reads its own
   * member here and shows the reason instead of controls that would refuse —
   * an affordance that is visibly unavailable, never one that silently does
   * nothing.
   */
  unavailable: Record<string, string>;
  /**
   * Members whose last call FAILED — a refusal that is not `unsupported`: a
   * control plane that 500'd, a socket that dropped, a getter that timed out.
   * It is deliberately a different map from `unavailable`, because the two
   * mean opposite things to a reader: "this host will never answer that" is a
   * fact to show in place of the controls, while "that did not load" is a
   * fault to report as one. Folding the second into the first (or into a
   * neutral default) turns an outage into a confident lie — a cloud status
   * that failed would read as "the cloud browser is off", with a button that
   * would work.
   */
  failed: Record<string, string>;
  /**
   * Record how a member REFUSED, from anywhere: `unsupported` lands in
   * `unavailable` (and clears any earlier failure for it), anything else in
   * `failed`. The initial load does this for every getter it probes; an
   * action does it for a member that is only knowable at first use — a
   * `vaultList` the host will never answer, an `openLiveView` there is no
   * overlay for. Both maps are rebuilt from scratch by the next load, so a
   * host that starts answering is not held to an old refusal.
   */
  noteRefusal(member: string, cause: unknown): void;
  /**
   * Re-read everything the initial load read, without re-subscribing. A
   * transport that reconnected missed every event in between, and the
   * snapshot is only part of what the shell holds: devices, sync, egress,
   * cloud, channels, the account and the refusal maps would otherwise keep
   * whatever the first load got, for the life of the page.
   */
  resync(): Promise<void>;
  overlay: Overlay;
  /**
   * Whether Watchtower is saving what the person reads right now. The
   * chrome shows it wherever the Watchtower button is: a recorder must never
   * be running out of sight.
   */
  watchtowerCapture: "off" | "recording" | "paused";
  setWatchtowerCapture(state: "off" | "recording" | "paused"): void;
  /** The picture the console's lightbox is showing, if it is up. */
  imagePreview: { src: string; alt: string } | null;
  /** The tab the address bar edits; null means the active tab. */
  urlBarTabId: string | null;
  /** The address bar is composing a NEW tab rather than editing one. */
  urlBarNew: boolean;
  /**
   * A pane-resize drag is live — the split divider, a panel's edge. It tints
   * the handle and nothing else: the pointer is held by the drag layer, not
   * by raising the chrome (lib/pane-drag.ts).
   */
  paneResizing: boolean;
  /** A tab is being dragged from the strip or sidebar shelf. */
  tabDragging: boolean;
  /** Proposed edge while a tab drag is armed over the page. Drives the live pane preview. */
  splitDropZone: SplitSide | null;
  /** The tab being dragged, for the drop preview's centered icon. */
  splitDragTab: SplitDragTab | null;
  /**
   * Whether the shell wants the chrome raised above the tab views, and the
   * stills that BrowserSurface paints before main hides those views.
   */
  overlayActive: boolean;
  /** The stills are painted and main has hidden the native views. */
  overlayReady: boolean;
  paneStills: PaneStill[];
  tabSwitcherPreviews: TabSwitcherPreview[];
  /** Signed MRU steps from the current tab: +1 is the previous tab. */
  tabSwitcherOffset: number;
  tabSwitcherLoading: boolean;
  tabSwitcherCommitPending: boolean;
  /** Ephemeral link preview, owned by main but composed by this shell. */
  glance: GlanceState | null;
  /** Background playback cards; updated on a narrow channel outside ShellSnapshot. */
  media: BrowserMediaInfo[];
  readAloud: ReadAloudStatus[];
  /** Main-owned enforcement state for the selected site. */
  browserControls: BrowserControlsSnapshot | null;
  /** This session's downloads from every tab, newest first (components/DownloadsPopover.tsx). */
  downloads: BrowserDownload[];
  /**
   * A short word from the chrome about something that just happened — "Tab
   * pinned" — with at most one thing to do about it. Drawn like the error
   * banner (App.tsx) and gone on its own after a moment.
   */
  /** The live notices, oldest first (lib/notices.ts); components/NoticeHost.tsx gets them drawn. */
  notices: ShellNotice[];
  /** The live view is frozen while its final frame flies back to the clicked link. */
  glanceClosing: boolean;
  /**
   * The owner's still is painted and its live view told to recede: the
   * opening motion (the card's flight, the owner dimming) may begin.
   */
  glanceStaged: boolean;
  /** Viewport box of the content area — drag geometry names its nearest edge. */
  contentBounds: ContentBounds | null;
  recents: RecentSite[];
  /**
   * Main's copy of the settings file. DEFAULT_SETTINGS until the first read
   * lands, so a control never renders against null — it renders the default
   * and corrects itself a frame later, which is what a stored default IS.
   */
  settings: DesktopSettings;
  settingsLoaded: boolean;
  settingsSection: SettingsSection;
  /**
   * Main's memory file, every version. Empty until the first read lands;
   * main pushes a fresh copy after every write, its own or the agent's.
   */
  memory: MemorySnapshot;
  memoryLoaded: boolean;
  /**
   * Main's reminders file: the schedule and its log. Empty until the first
   * read lands; main pushes a fresh copy after every write and every fire.
   */
  reminders: ReminderSnapshot;
  remindersLoaded: boolean;
  /** The occurrence the reminders page should land on, when opened from a card. */
  remindersFocus: string | null;
  /**
   * Main's bookmarks file. Empty until the first read lands; main pushes a
   * fresh copy after every write, every capture, and every extraction.
   */
  bookmarks: BookmarkSnapshot;
  bookmarksLoaded: boolean;
  /** The bookmark the bookmarks page should open on, when opened from the card. */
  bookmarksFocus: string | null;
  /** The card main has over the page, if any (drawn by the bookmark chrome view). */
  bookmarkToast: BookmarkToast | null;
  /**
   * The first-run wizard is in front of the chrome (components/onboarding).
   * Up on a fresh install until `settings.onboarding.completed`; up again
   * when Settings → About replays it, in which case it can be dismissed.
   * False until the first snapshot lands; before that, App asks the native
   * bridge (`NativeSurfaceApi.launchState`) whether a first run is coming
   * and shows a curtain in the wizard's colour instead of the chrome.
   */
  onboardingOpen: boolean;
  onboardingReplay: boolean;
  /** Where the app stands with respect to a newer release (main owns it). */
  update: UpdateState;
  /** The version whose corner card the person waved away; it stays in Settings → About. */
  updateDismissed: string | null;
  /**
   * The account, the devices holding its keys, and the three planes that
   * only exist once this Mac is enrolled (docs/cloud-sync-design.md §10).
   * Every one of these is DEFAULT_* until main's first answer lands, and
   * stays there when it fails: an unreachable control plane must never keep
   * the shell on "Opening secure Space…".
   */
  account: AccountState;
  devices: DeviceInfo[];
  syncStatus: SyncStatus;
  workspaceSync: WorkspaceSyncStatus;
  egress: EgressStatus;
  cloud: CloudStatus;
  channels: ChannelInfo[];
  /** Load the shell snapshot and settings, then follow their changes. */
  initialize(): Promise<() => void>;
  openOnboarding(): void;
  closeOnboarding(): void;
  /** Hand main what the wizard gathered; resolves with the error to show, or null. */
  completeOnboarding(input: OnboardingCompletion): Promise<string | null>;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): void;
  dismissUpdate(): void;
  openSettings(section?: SettingsSection): void;
  closeSettings(): void;
  openReminders(occurrenceId?: string): void;
  /** Today's daily brief: the tab already showing it, else a new one. */
  openBrief(): void;
  /**
   * The notes library, or one note: the tab already showing it, else a new
   * one (docs/notes.md §4).
   */
  openNotes(noteId?: string): void;
  /** A blank note in a tab. There is nothing to save, so there is nothing to confirm. */
  newNote(): Promise<void>;
  /** The same note, beside whatever is open now. */
  openNoteInSplit(noteId: string): Promise<void>;
  closeReminders(): void;
  toggleReminders(): void;
  openBookmarks(bookmarkId?: string): void;
  closeBookmarks(): void;
  /**
   * Dismiss whichever full-window page (settings, reminders, bookmarks) is
   * covering the content hole, so a tab the user just picked is what shows.
   */
  closePage(): void;
  toggleBookmarks(): void;
  openDownloads(): void;
  closeDownloads(): void;
  toggleDownloads(): void;
  /** Say something briefly in the notice stack (@pistachio/shell-contracts/notice). */
  showNotice(message: string, options?: NoticeOptions): void;
  dismissNotice(id: number): void;
  /** The card's button: the notice goes, then its action runs. */
  runNoticeAction(id: number): void;
  openSiteControls(): void;
  closeSiteControls(): void;
  /** Put the request prompt back down without answering; the request stays pending. */
  closePermissionPrompt(): void;
  openSiteInfo(): void;
  closeSiteInfo(): void;
  toggleSiteInfo(): void;
  openStatusCard(): void;
  closeStatusCard(): void;
  openSpaceFork(): void;
  closeSpaceFork(): void;
  switchSpace(spaceId: string): Promise<void>;
  forkSpace(request: ForkSpaceRequest): Promise<ForkSpaceResult | null>;
  browserControl(command: BrowserControlCommand): Promise<void>;
  updateSettings(patch: SettingsPatch): Promise<void>;
  resetSettings(): Promise<void>;
  addMemory(input: MemoryAddInput): Promise<void>;
  updateMemory(id: string, patch: MemoryUpdateInput): Promise<void>;
  forgetMemory(id: string, reason: string): Promise<void>;
  restoreMemory(id: string): Promise<void>;
  reviewMemory(id: string, decision: Exclude<MemoryReview, "pending">): Promise<void>;
  forgetAllMemory(): Promise<void>;
  // Reminder writes resolve with the error to show in the form, or null:
  // "that time has already passed" belongs beside the field, not in the
  // shell's error banner.
  addReminder(input: ReminderInput): Promise<string | null>;
  updateReminder(id: string, patch: ReminderPatch): Promise<string | null>;
  cancelReminder(id: string): Promise<void>;
  deleteReminder(id: string): Promise<void>;
  runReminderNow(id: string): Promise<void>;
  acknowledgeReminders(ids: string[] | "all"): Promise<void>;
  snoozeReminder(occurrenceId: string, minutes: number): Promise<void>;
  /** Save a tab's page (the active one when omitted): what the double tap of shift does. */
  toggleReaderView(tabId?: string): Promise<boolean>;
  bookmarkTab(tabId?: string): Promise<void>;
  // Bookmark writes from a form resolve with the error to show beside it, or null.
  addBookmark(input: BookmarkInput): Promise<string | null>;
  updateBookmark(id: string, patch: BookmarkPatch): Promise<string | null>;
  deleteBookmark(id: string): Promise<void>;
  refreshBookmark(id: string): Promise<void>;
  dismissBookmarkToast(): void;
  clearRecents(): void;
  toggleConsole(): void;
  setConsoleOpen(open: boolean): void;
  /** Queue an insert for the composer and bring the composer into view. */
  receiveChatInsert(insert: ChatInsert): void;
  /** The page's menu offered an insert that could not be read; the composer says so. */
  rejectChatInsert(reason: string): void;
  /** The composer draining what it was sent. */
  takeChatInbox(): ChatInbox;
  setConsoleWidth(px: number): void;
  setSidebarWidth(px: number): void;
  setSidebarRevealed(revealed: boolean): void;
  setFooterMenuOpen(open: boolean): void;
  setPaneToolbarRevealed(revealed: boolean): void;
  setOverlay(overlay: Overlay): void;
  setContextMenuOpen(open: boolean): void;
  openUrlBar(tabId?: string): void;
  openNewTabBar(): void;
  setPaneResizing(resizing: boolean): void;
  setTabDragging(dragging: boolean): void;
  setSplitDropZone(zone: SplitSide | null): void;
  setSplitDragTab(tab: SplitDragTab | null): void;
  setContentBounds(bounds: ContentBounds | null): void;
  reportOverlayActive(active: boolean): Promise<void>;
  stepTabSwitcher(reverse: boolean): Promise<void>;
  finishTabSwitcher(commit: boolean, tabId?: string): Promise<void>;
  setTabSwitcherIndex(index: number): void;
  setGlanceClosing(closing: boolean): void;
  setGlanceStaged(staged: boolean): void;
  prepareGlanceClose(): Promise<string | null>;
  /**
   * Open a link the shell rendered (console messages): a Glance above the live
   * page, or a real tab when asked for one or when no page can own a preview.
   */
  openLink(url: string, source: ContentBounds, inNewTab: boolean): Promise<void>;
  /** The console's feedback popover; the outcome is the popover's to show. */
  submitFeedback(input: FeedbackInput): Promise<FeedbackOutcome>;
  closeGlance(): Promise<void>;
  promoteGlance(): Promise<void>;
  splitGlance(): Promise<void>;
  dismissRecent(host: string): void;
  createTab(url?: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  selectTab(tabId: string): Promise<void>;
  suspendTab(tabId: string): Promise<void>;
  /** Tell the page it is the visible, focused tab even in the background. */
  setForcedFocus(tabId: string, enabled: boolean): Promise<void>;
  navigate(tabId: string, url: string): Promise<void>;
  goBack(tabId: string): Promise<void>;
  goForward(tabId: string): Promise<void>;
  reload(tabId: string): Promise<void>;
  setSplit(mode: SplitMode): Promise<void>;
  reorderTab(tabId: string, index: number): Promise<void>;
  splitWith(tabId: string, side: SplitSide): Promise<void>;
  /** Take a tab out of its split group without closing it. */
  removeFromSplit(tabId: string): Promise<void>;
  /** Open a fresh tab on the same page, beside the original. */
  duplicateTab(tabId: string): Promise<void>;
  moveTabToSpace(tabId: string, spaceId: string): Promise<void>;
  restoreClosedTab(): Promise<void>;
  clearUnpinnedTabs(): Promise<void>;
  controlMedia(tabId: string, control: MediaControl): Promise<void>;
  cancelReadAloud(id: string): Promise<void>;
  /** Speak a reply shown in the console; resolves once it is playing (or throws, as a toast). */
  readAloudText(text: string): Promise<void>;
  /** Change the sidebar shelf (@pistachio/shell-contracts/sidebar); main answers with a snapshot. */
  sidebarCommand(command: SidebarCommand): Promise<void>;
  /** Change the tab groups (@pistachio/shell-contracts/tab-groups); main answers with a snapshot. Null when it failed. */
  tabGroupCommand(command: TabGroupCommand): Promise<TabGroupCommandResult | null>;
  /** Tidy is asking the model right now: the "Tidy tabs" control spins (docs/tab-tidy.md §3.2). */
  tidyRunning: boolean;
  /** Run Tidy for the active Space and say what it did. */
  tidyTabs(): Promise<void>;
  /** Take the last Tidy run back. */
  undoTidy(): Promise<void>;
  /** Say what a Tidy run did, with Undo — main's own runs arrive here too. */
  announceTidy(summary: TidySummary): void;
  startDelegation(intent: string, attachments?: AgentAttachment[], options?: AgentTurnOptions): Promise<void>;
  sendAgentMessage(content: string, attachments?: AgentAttachment[], options?: AgentTurnOptions): Promise<void>;
  openImagePreview(preview: { src: string; alt: string }): void;
  closeImagePreview(): void;
  answerAgentQuestion(questionId: string, answer: string): Promise<void>;
  interruptAgent(): Promise<void>;
  /** Run the thread's last turn again, discarding its reply. */
  retryAgentTurn(): Promise<void>;
  approve(approvalId: string): Promise<void>;
  reject(approvalId: string): Promise<void>;
  takeControl(): Promise<void>;
  releaseControl(): Promise<void>;
  revokeRun(): Promise<void>;
  /** Reopen a saved conversation in the console (refused while a task is acting). */
  openThread(runId: string): Promise<void>;
  /** Clear the console for a fresh conversation; a task still acting is ended first. */
  newThread(): Promise<void>;
  /** Forget a saved conversation. */
  deleteThread(runId: string): Promise<void>;
  loadEvidence(): Promise<void>;
  closeEvidence(): void;
  // ── Account and devices (§10.1) ────────────────────────────────────────
  // Everything here answers with the failure rather than raising it: these
  // are typed into a form, and a bad password belongs beside the field, not
  // in the shell's error banner.
  signUp(email: string, password: string): Promise<Attempt<AccountState>>;
  signIn(email: string, password: string): Promise<Attempt<AccountState>>;
  /** Enroll this Mac's keys; the recovery code in the answer is shown once. */
  enrollDevice(): Promise<Attempt<AccountEnrollResult>>;
  signOut(): Promise<string | null>;
  changePassword(currentPassword: string, newPassword: string): Promise<string | null>;
  /** Mint a fresh recovery code — the previous one stops working. Shown once. */
  generateRecoveryCode(): Promise<Attempt<string>>;
  renameDevice(deviceId: string, name: string): Promise<string | null>;
  revokeDevice(deviceId: string): Promise<string | null>;
  /** Adopt the cloud device key control introduced after the pin (§10.1, D6). */
  confirmCloudDevice(): Promise<string | null>;
  // ── Cookie sync (§10.2) ───────────────────────────────────────────────
  retrySync(): Promise<void>;
  lookupSyncOrigin(spaceId: string, host: string): Promise<Attempt<SyncOriginInfo>>;
  setSyncOriginOverride(spaceId: string, host: string, override: SyncOriginOverride | null): Promise<Attempt<SyncOriginInfo>>;
  /** Put an origin's cookies back to the last converged version. */
  rollbackSyncOrigin(spaceId: string, host: string): Promise<string | null>;
  runWorkspaceSync(action: WorkspaceSyncAction): Promise<string | null>;
  // ── Identity egress (§10.3) ───────────────────────────────────────────
  setSpaceEgressPolicy(spaceId: string, policy: SpaceEgressPolicy): Promise<string | null>;
  browseDirectForNow(spaceId: string): Promise<string | null>;
  // ── Cloud browser (§10.4) ─────────────────────────────────────────────
  enableCloud(spaceId: string): Promise<string | null>;
  disableCloud(spaceId: string): Promise<string | null>;
  startCloudRun(request: CloudStartRunRequest): Promise<Attempt<{ runId: string }>>;
  /** Open a cloud run's live view over the content hole (`overlay: "liveView"`). */
  openLiveView(runId: string): Promise<string | null>;
  closeLiveView(): Promise<void>;
  /**
   * Fire-and-forget: input frames are traffic, not state. Main drops them
   * unless the run is under human control (§8.5).
   */
  sendLiveInput(input: CloudLiveInput): void;
  refreshChannels(): Promise<void>;
  /** The secret rides only on this answer; the page shows it once. */
  createChannel(request: ChannelCreateRequest): Promise<Attempt<ChannelCreated>>;
  deleteChannel(linkId: string): Promise<string | null>;
}

/** A call whose value the caller needs and whose failure the caller shows. */
export type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };

/** Two addresses for the same shell page: a trailing slash is not a difference. */
function sameAddress(left: string, right: string): boolean {
  return left.trim().replace(/\/$/u, "") === right.replace(/\/$/u, "");
}

/**
 * Wait for the next snapshots to bring something into being — a tab main has
 * just made, whose id only arrives with the publish that follows. It gives up
 * rather than waiting forever: nothing here is worth a hung promise.
 */
function waitFor<T>(read: () => T | null, timeoutMs = 2_000): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: T | null) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      off();
      resolve(value);
    };
    const off = useAppStore.subscribe(() => {
      const value = read();
      if (value !== null) finish(value);
    });
    const timer = window.setTimeout(() => finish(null), timeoutMs);
  });
}

function safeAction(operation: () => Promise<void>, set: (value: Partial<AppState>) => void): Promise<void> {
  set({ error: null });
  return operation().catch((error: unknown) => {
    set({ error: error instanceof Error ? error.message : String(error) });
  });
}

/** Like safeAction, but the failure is the caller's to show. */
async function attempt(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** attempt for a call whose ANSWER the caller needs, not only its outcome. */
async function attemptValue<T>(operation: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function mergePatch(current: DesktopSettings, patch: SettingsPatch): DesktopSettings {
  const next = { ...current };
  for (const key of Object.keys(patch) as Array<keyof DesktopSettings>) {
    const section = patch[key];
    if (section !== undefined) next[key] = { ...current[key], ...section } as never;
  }
  return next;
}

let overlayReportRequest = 0;
let tabSwitcherLoadRequest = 0;

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

/** Wait until the newly mounted, decoded pane stills have reached the compositor. */
async function afterPaneStillsPaint(): Promise<void> {
  // Let React commit the images produced by the preceding store update.
  await nextAnimationFrame();
  const stills = [...document.querySelectorAll<HTMLImageElement>("img.pane-still")];
  await Promise.all(stills.map((still) => still.decode().catch(() => undefined)));
  // The first frame submits the decoded images; the second confirms a paint.
  await nextAnimationFrame();
  await nextAnimationFrame();
}

/**
 * Fold a snapshot's settled page loads into the recents list. A visit is
 * recorded when a tab's load SETTLES (or the tab is new to the list); a tab
 * whose title merely ticked afterwards — an unread count, a timer in the
 * title — refreshes its entry in place and never reorders the list.
 */
function recordSnapshot(
  recents: RecentSite[],
  snapshot: Pick<ShellSnapshot, "tabs">,
  previous: Pick<ShellSnapshot, "tabs"> | null,
  settings: DesktopSettings,
): RecentSite[] {
  if (!settings.privacy.rememberRecents) return recents;
  if (previous !== null && previous.tabs === snapshot.tabs) return recents;
  const before = previous === null ? null : new Map(previous.tabs.map((tab) => [tab.id, tab]));
  let next = recents;
  for (const tab of snapshot.tabs) {
    // The home page is where a visit starts, not a place visited; the brief is the shell's own page.
    if (tab.loading || tab.kind !== "human" || isShellPageUrl(tab.url)) continue;
    const was = before?.get(tab.id);
    if (was === tab) continue;
    const host = tab.url.startsWith("pistachio:") ? displayHost(tab.url) : hostOf(tab.url);
    if (host === "") continue;
    const settled = was === undefined || was.loading || was.url !== tab.url;
    if (settled) {
      const seen = next.find((item) => item.host === host);
      if (seen !== undefined && seen.url === tab.url && seen.title === tab.title) {
        next = refaviconVisit(next, tab.url, tab.faviconUrl ?? seen.faviconUrl);
        continue;
      }
      next = recordVisit(next, { host, url: tab.url, title: tab.title, faviconUrl: tab.faviconUrl }, Date.now());
    } else {
      if (was.title !== tab.title) next = retitleVisit(next, tab.url, tab.title);
      // The favicon lands on a later tick than the load; a page that drops its
      // icon (null) keeps the one already recorded rather than losing it.
      if (was.faviconUrl !== tab.faviconUrl && tab.faviconUrl !== null) next = refaviconVisit(next, tab.url, tab.faviconUrl);
    }
  }
  return next;
}

/** Fold a tab-side publish into the snapshot, keeping the run side and every unchanged reference. */
function mergeTabs(current: ShellSnapshot | null, tabs: ShellTabsSnapshot): ShellSnapshot {
  const next: ShellSnapshot = { ...tabs, run: current?.run ?? null, threads: current?.threads ?? [] };
  return current === null ? next : share(current, next);
}

/** Fold a run-side publish into the snapshot, keeping the tab side and every unchanged message. */
function mergeRun(current: ShellSnapshot, run: ShellRunSnapshot): ShellSnapshot {
  return share(current, { ...current, run: run.run, threads: run.threads });
}

type SetState = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;

/**
 * Read everything the shell holds that is not pushed to it, and record how
 * each member answered.
 *
 * EVERY getter here carries its own .catch with a sane default. One rejection
 * in this Promise.all would leave the shell on "Opening secure Space…"
 * forever, and a host is allowed not to answer: the account plane may be
 * unreachable (§10.5), and a cloud host answers `unsupported` for the members
 * the web app's own settings pages own (docs/web-browser-design.md §11).
 * `getSnapshot` is the exception on purpose — with no snapshot there is
 * nothing to render, and saying so is right.
 *
 * A refusal is REMEMBERED, not swallowed, and the two kinds are kept apart:
 * `unsupported` means this host will never answer and lands in `unavailable`,
 * where the settings sections show the host's own reason in place of controls
 * that would refuse (W12); anything else is a FAILURE and lands in `failed`,
 * because a getter that broke must not be rendered as a fact — "the cloud
 * browser is off" beside a button that would work is a lie about an outage.
 *
 * `first` is the only difference between the initial load and a resync after
 * a reconnect: the console's launch state, the walkthrough and the recents
 * seed are first-run decisions, and re-applying them to a live shell would
 * reopen the wizard and undo what the person did with the console.
 */
async function load(set: SetState, get: () => AppState, first: boolean): Promise<void> {
  const unavailable: Record<string, string> = {};
  const failed: Record<string, string> = {};
  // `Promise.resolve().then(run)` rather than `run().catch(...)`: a bridge
  // that is missing the member throws synchronously, and a whole shell that
  // never renders because one getter was not installed is the failure this
  // function exists to prevent.
  const spare = <T>(member: string, run: () => Promise<T>, fallback: T): Promise<T> =>
    Promise.resolve()
      .then(run)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (isShellUnsupported(error)) unavailable[member] = message;
        else failed[member] = message;
        return fallback;
      });
  const [
    snapshot,
    settings,
    glance,
    media,
    browserControls,
    downloads,
    memory,
    reminders,
    readAloud,
    bookmarks,
    bookmarkToast,
    update,
    account,
    devices,
    syncStatus,
    workspaceSync,
    egress,
    cloud,
    channels,
  ] = await Promise.all([
    shellApi().getSnapshot(),
    spare("getSettings", () => shellApi().getSettings(), DEFAULT_SETTINGS),
    spare("getGlance", () => shellApi().getGlance(), null as GlanceState | null),
    spare("getMedia", () => shellApi().getMedia(), [] as BrowserMediaInfo[]),
    spare("getBrowserControls", () => shellApi().getBrowserControls(), NEUTRAL_BROWSER_CONTROLS),
    spare("getDownloads", () => shellApi().getDownloads(), [] as BrowserDownload[]),
    spare("getMemory", () => shellApi().getMemory(), { entries: [] } as MemorySnapshot),
    spare("getReminders", () => shellApi().getReminders(), { reminders: [], occurrences: [] } as ReminderSnapshot),
    spare("getReadAloud", () => shellApi().getReadAloud(), [] as ReadAloudStatus[]),
    spare("getBookmarks", () => shellApi().getBookmarks(), { bookmarks: [] } as BookmarkSnapshot),
    spare("getBookmarkToast", () => shellApi().getBookmarkToast(), null as BookmarkToast | null),
    spare("getUpdateState", () => shellApi().getUpdateState(), { status: "idle", checkedAt: null } as UpdateState),
    spare("getAccount", () => shellApi().getAccount(), DEFAULT_ACCOUNT),
    spare("listDevices", () => shellApi().listDevices(), [] as DeviceInfo[]),
    spare("getSyncStatus", () => shellApi().getSyncStatus(), DEFAULT_SYNC_STATUS),
    spare("getWorkspaceSync", () => shellApi().getWorkspaceSync(), DEFAULT_WORKSPACE_SYNC),
    spare("getEgressStatus", () => shellApi().getEgressStatus(), DEFAULT_EGRESS_STATUS),
    spare("getCloudStatus", () => shellApi().getCloudStatus(), DEFAULT_CLOUD_STATUS),
    spare("listChannels", () => shellApi().listChannels(), [] as ChannelInfo[]),
  ]);
  set({
    unavailable,
    failed,
    update,
    account,
    devices,
    syncStatus,
    workspaceSync,
    egress,
    cloud,
    channels,
    snapshot,
    settings,
    settingsLoaded: true,
    memory,
    memoryLoaded: true,
    reminders,
    remindersLoaded: true,
    bookmarks,
    bookmarksLoaded: true,
    bookmarkToast,
    glance,
    media,
    readAloud,
    browserControls,
    downloads,
    ...(first
      ? {
          consoleOpen: settings.general.consoleOpenOnLaunch,
          recents: recordSnapshot(get().recents, snapshot, null, settings),
          onboardingOpen: !settings.onboarding.completed,
          onboardingReplay: false,
        }
      : { recents: recordSnapshot(get().recents, snapshot, get().snapshot, settings) }),
  });
}

export const useAppStore = create<AppState>((set, get) => ({
  snapshot: null,
  consoleOpen: false,
  chatInbox: EMPTY_CHAT_INBOX,
  consoleWidth: getStoredPanelWidth(),
  sidebarWidth: getStoredSidebarWidth(),
  sidebarRevealed: false,
  footerMenusOpen: 0,
  paneToolbarRevealed: false,
  evidence: null,
  error: null,
  unavailable: {},
  failed: {},
  overlay: "none",
  imagePreview: null,
  urlBarTabId: null,
  urlBarNew: false,
  paneResizing: false,
  tabDragging: false,
  splitDropZone: null,
  splitDragTab: null,
  overlayActive: false,
  overlayReady: false,
  paneStills: [],
  tabSwitcherPreviews: [],
  tabSwitcherOffset: 0,
  tabSwitcherLoading: false,
  tabSwitcherCommitPending: false,
  glance: null,
  media: [],
  readAloud: [],
  browserControls: null,
  downloads: [],
  notices: [],
  glanceClosing: false,
  glanceStaged: false,
  contentBounds: null,
  recents: loadRecents(),
  settings: DEFAULT_SETTINGS,
  settingsLoaded: false,
  settingsSection: "",
  memory: { entries: [] },
  memoryLoaded: false,
  reminders: { reminders: [], occurrences: [] },
  remindersLoaded: false,
  remindersFocus: null,
  bookmarks: { bookmarks: [] },
  bookmarksLoaded: false,
  bookmarksFocus: null,
  bookmarkToast: null,
  onboardingOpen: false,
  onboardingReplay: false,
  update: { status: "idle", checkedAt: null },
  updateDismissed: null,
  account: DEFAULT_ACCOUNT,
  devices: [],
  syncStatus: DEFAULT_SYNC_STATUS,
  workspaceSync: DEFAULT_WORKSPACE_SYNC,
  egress: DEFAULT_EGRESS_STATUS,
  cloud: DEFAULT_CLOUD_STATUS,
  channels: [],
  noteRefusal(member, cause) {
    set((state) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (isShellUnsupported(cause)) {
        if (state.unavailable[member] === message) return {};
        const failed = { ...state.failed };
        delete failed[member];
        return { unavailable: { ...state.unavailable, [member]: message }, failed };
      }
      if (state.failed[member] === message) return {};
      return { failed: { ...state.failed, [member]: message } };
    });
  },
  resync: () => load(set, get, false),
  async initialize() {
    await load(set, get, true);
    const offSnapshot = shellApi().onSnapshot((tabs) =>
      set((state) => {
        const snapshot = mergeTabs(state.snapshot, tabs);
        if (snapshot === state.snapshot) return {};
        return { snapshot, recents: recordSnapshot(state.recents, snapshot, state.snapshot, state.settings) };
      }),
    );
    const offRun = shellApi().onRun((run) =>
      set((state) => {
        if (state.snapshot === null) return {};
        const snapshot = mergeRun(state.snapshot, run);
        return snapshot === state.snapshot ? {} : { snapshot };
      }),
    );
    const offSettings = shellApi().onSettings((next) => set({ settings: next }));
    const offMemory = shellApi().onMemory((next) => set({ memory: next, memoryLoaded: true }));
    const offReminders = shellApi().onReminders((next) => set({ reminders: next, remindersLoaded: true }));
    const offBookmarks = shellApi().onBookmarks((next) => set({ bookmarks: next, bookmarksLoaded: true }));
    const offBookmarkToast = shellApi().onBookmarkToast((next) => set({ bookmarkToast: next }));
    const offUpdate = nativeApi()?.onUpdateState((next) => set({ update: next }));
    const offGlance = shellApi().onGlanceChanged((next) =>
      set((state) => {
        const same = next !== null && next.tab.id === state.glance?.tab.id;
        return {
          glance: next,
          glanceClosing: same ? state.glanceClosing : false,
          glanceStaged: same ? state.glanceStaged : false,
        };
      }),
    );
    const offMedia = shellApi().onMediaChanged((next) => set({ media: next }));
    const offReadAloud = shellApi().onReadAloudChanged((next) => set({ readAloud: next }));
    const offAccount = shellApi().onAccount((next) => set({ account: next }));
    const offDevices = shellApi().onDevices((next) => set({ devices: next }));
    const offSyncStatus = shellApi().onSyncStatus((next) => set({ syncStatus: next }));
    const offWorkspaceSync = shellApi().onWorkspaceSync((next) => set({ workspaceSync: next }));
    const offEgress = shellApi().onEgressStatus((next) => set({ egress: next }));
    const offCloud = shellApi().onCloudStatus((next) => set({ cloud: next }));
    // Deliberately NOT onCloudFrame: a screencast frame is per-frame traffic
    // and would push a base64 JPEG through every store subscriber. The live
    // view subscribes to it in component state instead (§10.6).
    const offBrowserControls = shellApi().onBrowserControlsChanged((next) =>
      set((state) => {
        const overlay = permissionPromptOverlay(state.browserControls, next, state.overlay);
        return {
          browserControls: next,
          ...(overlay === null ? {} : { overlay, urlBarTabId: null, urlBarNew: false }),
        };
      }),
    );
    const offDownloads = shellApi().onDownloadsChanged((next) => set({ downloads: next }));
    return () => {
      offSnapshot();
      offRun();
      offSettings();
      offMemory();
      offReminders();
      offBookmarks();
      offBookmarkToast();
      offUpdate?.();
      offGlance();
      offMedia();
      offReadAloud();
      offBrowserControls();
      offDownloads();
      offAccount();
      offDevices();
      offSyncStatus();
      offWorkspaceSync();
      offEgress();
      offCloud();
    };
  },
  openOnboarding: () => set({ onboardingOpen: true, onboardingReplay: true, overlay: "none", urlBarTabId: null, urlBarNew: false }),
  closeOnboarding: () => set({ onboardingOpen: false, onboardingReplay: false }),
  completeOnboarding: (input) => attempt(() => shellApi().completeOnboarding(input)),
  checkForUpdates: async () => {
    set({ update: await shellApi().checkForUpdates() });
  },
  downloadUpdate: async () => {
    set({ update: await shellApi().downloadUpdate() });
  },
  installUpdate: () => nativeApi()?.installUpdate(),
  dismissUpdate: () => set((state) => ({ updateDismissed: updateVersion(state.update) })),
  openSettings: (section) =>
    set((state) => ({
      overlay: "settings",
      settingsSection: section ?? state.settingsSection,
      urlBarTabId: null,
      urlBarNew: false,
    })),
  closeSettings: () => set((state) => (state.overlay === "settings" ? { overlay: "none" } : {})),
  openReminders: (occurrenceId) =>
    set({ overlay: "reminders", remindersFocus: occurrenceId ?? null, urlBarTabId: null, urlBarNew: false }),
  openBrief: () => {
    const state = get();
    state.closePage();
    const open = state.snapshot?.tabs.find((tab) => sameAddress(tab.url, BRIEF_PAGE_URL));
    if (open !== undefined) void state.selectTab(open.id);
    else void state.createTab(BRIEF_PAGE_URL);
  },
  openNotes: (noteId) => {
    const state = get();
    state.closePage();
    const url = noteUrl(noteId);
    const open = state.snapshot?.tabs.find((tab) => sameAddress(tab.url, url));
    if (open !== undefined) void state.selectTab(open.id);
    else void state.createTab(url);
  },
  newNote: async () => {
    // The one door to the host's notes is the notes store (components/notes/
    // use-notes.ts), and it reads this one — so it is asked for at the moment
    // a note is wanted rather than imported into the cycle. It is in the
    // editor's chunk either way (ContentArea loads it lazily).
    const { useNotes } = await import("./components/notes/use-notes");
    const note = await useNotes.getState().create();
    // A refusal is already recorded by the notes store; there is nothing to
    // open and nothing to say twice.
    if (note !== null) get().openNotes(note.id);
  },
  openNoteInSplit: async (noteId) => {
    const url = noteUrl(noteId);
    const openTab = () => get().snapshot?.tabs.find((tab) => sameAddress(tab.url, url)) ?? null;
    const existing = openTab();
    if (existing !== null) {
      await get().splitWith(existing.id, "right");
      return;
    }
    await get().createTab(url);
    // `createTab` resolves when main has made it; this window learns the tab's
    // id on the snapshot that follows, which is what there is to split with.
    const tab = openTab() ?? (await waitFor(openTab));
    if (tab !== null) await get().splitWith(tab.id, "right");
  },
  closeReminders: () => set((state) => (state.overlay === "reminders" ? { overlay: "none", remindersFocus: null } : {})),
  toggleReminders: () =>
    set((state) =>
      state.overlay === "reminders"
        ? { overlay: "none", remindersFocus: null }
        : { overlay: "reminders", remindersFocus: null, urlBarTabId: null, urlBarNew: false },
    ),
  openBookmarks: (bookmarkId) =>
    set({ overlay: "bookmarks", bookmarksFocus: bookmarkId ?? null, urlBarTabId: null, urlBarNew: false }),
  closeBookmarks: () => set((state) => (state.overlay === "bookmarks" ? { overlay: "none", bookmarksFocus: null } : {})),
  closePage: () =>
    set((state) => (isPageOverlay(state.overlay) ? { overlay: "none", remindersFocus: null, bookmarksFocus: null } : {})),
  toggleBookmarks: () =>
    set((state) =>
      state.overlay === "bookmarks"
        ? { overlay: "none", bookmarksFocus: null }
        : { overlay: "bookmarks", bookmarksFocus: null, urlBarTabId: null, urlBarNew: false },
    ),
  openDownloads: () => set({ overlay: "downloads", urlBarTabId: null, urlBarNew: false }),
  closeDownloads: () => set((state) => (state.overlay === "downloads" ? { overlay: "none" } : {})),
  toggleDownloads: () =>
    set((state) =>
      state.overlay === "downloads" ? { overlay: "none" } : { overlay: "downloads", urlBarTabId: null, urlBarNew: false },
    ),
  showNotice: (message, options) =>
    set((state) => {
      noticeSerial += 1;
      return { notices: pushNotice(state.notices, noticeSerial, message, options) };
    }),
  dismissNotice: (id) => set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) })),
  runNoticeAction: (id) => {
    const notice = get().notices.find((candidate) => candidate.id === id);
    if (notice === undefined) return;
    get().dismissNotice(id);
    notice.action?.run();
  },
  openSiteControls: () => set({ overlay: "site", urlBarTabId: null, urlBarNew: false }),
  closeSiteControls: () => set((state) => (state.overlay === "site" ? { overlay: "none" } : {})),
  closePermissionPrompt: () => set((state) => (state.overlay === "permission" ? { overlay: "none" } : {})),
  openSiteInfo: () => set({ overlay: "site-info", urlBarTabId: null, urlBarNew: false }),
  closeSiteInfo: () => set((state) => (state.overlay === "site-info" ? { overlay: "none" } : {})),
  toggleSiteInfo: () =>
    set((state) =>
      state.overlay === "site-info" ? { overlay: "none" } : { overlay: "site-info", urlBarTabId: null, urlBarNew: false },
    ),
  openStatusCard: () => set((state) => (state.overlay === "none" ? { overlay: "status" } : {})),
  closeStatusCard: () => set((state) => (state.overlay === "status" ? { overlay: "none" } : {})),
  openSpaceFork: () => set({ overlay: "space-fork", urlBarTabId: null, urlBarNew: false }),
  closeSpaceFork: () => set((state) => (state.overlay === "space-fork" ? { overlay: "none" } : {})),
  switchSpace: (spaceId) => safeAction(() => shellApi().switchSpace(spaceId), set),
  async forkSpace(request) {
    set({ error: null });
    try {
      return await shellApi().forkSpace(request);
    } catch (error: unknown) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  },
  browserControl: (command) => safeAction(() => shellApi().browserControl(command), set),
  async updateSettings(patch) {
    // Optimistic: the switch flips now; main's sanitized answer replaces it.
    set((state) => ({ settings: mergePatch(state.settings, patch) }));
    await safeAction(async () => {
      const settings = await shellApi().updateSettings(patch);
      set({ settings });
    }, set);
  },
  resetSettings: () =>
    safeAction(async () => {
      const settings = await shellApi().resetSettings();
      set({ settings });
    }, set),
  // Memory writes are not optimistic: main answers with the whole file
  // after each one (onMemory), and a versioned fact has an id the renderer
  // cannot guess.
  addMemory: (input) => safeAction(async () => void (await shellApi().addMemory(input)), set),
  updateMemory: (id, patch) => safeAction(async () => void (await shellApi().updateMemory(id, patch)), set),
  forgetMemory: (id, reason) => safeAction(async () => void (await shellApi().forgetMemory(id, reason)), set),
  restoreMemory: (id) => safeAction(async () => void (await shellApi().restoreMemory(id)), set),
  reviewMemory: (id, decision) => safeAction(async () => void (await shellApi().reviewMemory(id, decision)), set),
  forgetAllMemory: () => safeAction(async () => void (await shellApi().forgetAllMemory()), set),
  addReminder: (input) => attempt(() => shellApi().addReminder(input)),
  updateReminder: (id, patch) => attempt(() => shellApi().updateReminder(id, patch)),
  cancelReminder: (id) => safeAction(async () => void (await shellApi().cancelReminder(id)), set),
  deleteReminder: (id) => safeAction(() => shellApi().deleteReminder(id), set),
  runReminderNow: (id) => safeAction(() => shellApi().runReminderNow(id), set),
  acknowledgeReminders: (ids) => safeAction(async () => void (await shellApi().acknowledgeReminders(ids)), set),
  snoozeReminder: (occurrenceId, minutes) => safeAction(async () => void (await shellApi().snoozeReminder(occurrenceId, minutes)), set),
  toggleReaderView: async (tabId) => {
    set({ error: null });
    try {
      const shown = await shellApi().toggleReaderView(tabId);
      // Main answers false for a page it found no article on. The button is
      // offered on any web page, so say why nothing happened.
      if (!shown) set({ error: "There is no article to read on this page." });
      return shown;
    } catch (error: unknown) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },
  bookmarkTab: (tabId) => safeAction(async () => void (await shellApi().bookmarkTab(tabId)), set),
  addBookmark: (input) => attempt(() => shellApi().addBookmark(input)),
  updateBookmark: (id, patch) => attempt(() => shellApi().updateBookmark(id, patch)),
  deleteBookmark: (id) => safeAction(() => shellApi().deleteBookmark(id), set),
  refreshBookmark: (id) => safeAction(async () => void (await shellApi().refreshBookmark(id)), set),
  dismissBookmarkToast: () => {
    nativeApi()?.dismissBookmarkToast();
    set({ bookmarkToast: null });
  },
  clearRecents: () => set({ recents: clearRecents() }),
  toggleConsole: () => {
    const state = get();
    const opening = !state.consoleOpen;
    // Opening the panel reads as starting something new: a settled
    // conversation is set aside to the thread list rather than shown again.
    // A run still in flight — or paused waiting on the user — stays put.
    const run = state.snapshot?.run ?? null;
    if (opening && run !== null && isTerminalStatus(run.status)) void state.newThread();
    set({ consoleOpen: opening });
  },
  setConsoleOpen: (open) => set({ consoleOpen: open }),
  receiveChatInsert: (insert) =>
    set((state) => ({
      consoleOpen: true,
      evidence: null,
      chatInbox: { inserts: [...state.chatInbox.inserts, insert], rejection: state.chatInbox.rejection },
    })),
  rejectChatInsert: (reason) =>
    set((state) => ({ consoleOpen: true, evidence: null, chatInbox: { inserts: state.chatInbox.inserts, rejection: reason } })),
  takeChatInbox: () => {
    const inbox = get().chatInbox;
    if (inbox !== EMPTY_CHAT_INBOX) set({ chatInbox: EMPTY_CHAT_INBOX });
    return inbox;
  },
  setConsoleWidth: (px) => {
    const consoleWidth = clampPanelWidth(px);
    storePanelWidth(consoleWidth);
    set({ consoleWidth });
  },
  setSidebarWidth: (px) => {
    const sidebarWidth = clampSidebarWidth(px);
    storeSidebarWidth(sidebarWidth);
    set({ sidebarWidth });
  },
  setSidebarRevealed: (sidebarRevealed) => set((state) => (state.sidebarRevealed === sidebarRevealed ? {} : { sidebarRevealed })),
  setFooterMenuOpen: (open) => set((state) => ({ footerMenusOpen: Math.max(0, state.footerMenusOpen + (open ? 1 : -1)) })),
  setPaneToolbarRevealed: (paneToolbarRevealed) =>
    set((state) => (state.paneToolbarRevealed === paneToolbarRevealed ? {} : { paneToolbarRevealed })),
  watchtowerCapture: "off",
  setWatchtowerCapture: (watchtowerCapture) => set({ watchtowerCapture }),
  setOverlay: (overlay) => set(overlay === "url" ? { overlay } : { overlay, urlBarTabId: null, urlBarNew: false }),
  setContextMenuOpen: (open) => set((state) => {
    if (open) return { overlay: "context-menu", urlBarTabId: null, urlBarNew: false };
    return state.overlay === "context-menu" ? { overlay: "none" } : {};
  }),
  openUrlBar: (tabId) => set({ overlay: "url", urlBarTabId: tabId ?? null, urlBarNew: false }),
  openNewTabBar: () => set({ overlay: "url", urlBarTabId: null, urlBarNew: true }),
  setPaneResizing: (paneResizing) => set({ paneResizing }),
  setTabDragging: (tabDragging) => set(tabDragging ? { tabDragging } : { tabDragging, splitDropZone: null, splitDragTab: null }),
  setSplitDropZone: (splitDropZone) => set((state) => state.splitDropZone === splitDropZone ? {} : { splitDropZone }),
  setSplitDragTab: (splitDragTab) => set({ splitDragTab }),
  // Reported on every surface layout pass; only a real change is worth
  // waking the subscribers (tab-drag edge geometry) for.
  setContentBounds: (contentBounds) => set((state) => {
    const current = state.contentBounds;
    if (
      current !== null &&
      contentBounds !== null &&
      current.x === contentBounds.x &&
      current.y === contentBounds.y &&
      current.width === contentBounds.width &&
      current.height === contentBounds.height
    )
      return {};
    if (current === null && contentBounds === null) return {};
    return { contentBounds };
  }),
  async reportOverlayActive(active) {
    if (get().overlayActive === active) return;
    const request = ++overlayReportRequest;
    set({ overlayActive: active, overlayReady: false });
    try {
      if (!active) {
        await nativeApi()?.setOverlay(false);
        if (request === overlayReportRequest && !get().overlayActive) set({ paneStills: [] });
        return;
      }
      // No native views to capture on a stream surface: the overlay goes up
      // over panes that keep painting themselves (§10).
      const stills = (await nativeApi()?.prepareOverlay()) ?? [];
      if (request !== overlayReportRequest || !get().overlayActive) return;
      set({ paneStills: stills });
      await afterPaneStillsPaint();
      if (request !== overlayReportRequest || !get().overlayActive) return;
      await nativeApi()?.setOverlay(true);
      if (request === overlayReportRequest && get().overlayActive) set({ overlayReady: true });
    } catch (error: unknown) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },
  async stepTabSwitcher(reverse) {
    const delta = reverse ? -1 : 1;
    if (get().overlay === "tab-switcher") {
      set((state) => ({ tabSwitcherOffset: state.tabSwitcherOffset + delta }));
      return;
    }
    const request = ++tabSwitcherLoadRequest;
    set({
      overlay: "tab-switcher",
      urlBarTabId: null,
      urlBarNew: false,
      tabSwitcherPreviews: [],
      tabSwitcherOffset: delta,
      tabSwitcherLoading: true,
      tabSwitcherCommitPending: false,
    });
    try {
      const previews = await shellApi().getTabSwitcherPreviews();
      if (request !== tabSwitcherLoadRequest || get().overlay !== "tab-switcher") return;
      if (previews.length < 2) {
        set({
          overlay: "none",
          tabSwitcherPreviews: [],
          tabSwitcherOffset: 0,
          tabSwitcherLoading: false,
          tabSwitcherCommitPending: false,
        });
        return;
      }
      const commitPending = get().tabSwitcherCommitPending;
      set({ tabSwitcherPreviews: previews, tabSwitcherLoading: false });
      if (commitPending) void get().finishTabSwitcher(true);
    } catch (error: unknown) {
      if (request !== tabSwitcherLoadRequest) return;
      set({
        overlay: "none",
        tabSwitcherPreviews: [],
        tabSwitcherLoading: false,
        tabSwitcherCommitPending: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
  async finishTabSwitcher(commit, tabId) {
    const state = get();
    if (state.overlay !== "tab-switcher") return;
    if (commit && state.tabSwitcherLoading) {
      set({ tabSwitcherCommitPending: true });
      return;
    }
    const selected = state.tabSwitcherPreviews[tabSwitcherIndex(state.tabSwitcherOffset, state.tabSwitcherPreviews.length)];
    const targetId = tabId ?? selected?.tab.id ?? null;
    ++tabSwitcherLoadRequest;
    if (commit && targetId !== null) {
      try {
        // Keep the still and switcher up until main has selected the page;
        // lowering then reveals the destination without one frame of the old tab.
        await shellApi().selectTab(targetId);
      } catch (error: unknown) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (get().overlay === "tab-switcher") {
      set({
        overlay: "none",
        tabSwitcherPreviews: [],
        tabSwitcherOffset: 0,
        tabSwitcherLoading: false,
        tabSwitcherCommitPending: false,
      });
    }
  },
  setTabSwitcherIndex: (tabSwitcherOffset) => set({ tabSwitcherOffset }),
  setGlanceClosing: (glanceClosing) => set({ glanceClosing }),
  setGlanceStaged: (glanceStaged) => set({ glanceStaged }),
  async prepareGlanceClose() {
    try {
      return (await nativeApi()?.prepareGlanceClose()) ?? null;
    } catch (error: unknown) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  },
  openLink: (url, source, inNewTab) =>
    safeAction(async () => {
      const opened = inNewTab ? false : await shellApi().openGlance({ url, source });
      if (opened) return;
      await shellApi().createTab(url);
      // A full-window page would hide the tab it just opened.
      get().closePage();
    }, set),
  submitFeedback: (input) => shellApi().submitFeedback(input),
  closeGlance: () => safeAction(() => shellApi().closeGlance(), set),
  promoteGlance: () => safeAction(() => shellApi().promoteGlance(), set),
  splitGlance: () => safeAction(() => shellApi().splitGlance(), set),
  dismissRecent: (host) => set((state) => ({ recents: dismissRecent(state.recents, host) })),
  // Picking or opening a tab is a request to see it: a full-window page
  // (settings, reminders, bookmarks) over the content hole steps aside
  // rather than waiting for its own close button.
  createTab: (url) => {
    get().closePage();
    return safeAction(() => shellApi().createTab(url), set);
  },
  closeTab: (tabId) => {
    const state = get();
    const run = state.snapshot?.run ?? null;
    const live = run !== null && !isTerminalStatus(run.status);
    const ownsRun = run !== null && (tabId === run.humanTabId || tabId === run.agentTabId);
    if (live && ownsRun && state.settings.general.confirmCloseWithRun) {
      const ok = window.confirm("The agent is using this tab. Closing it will end the browser task. Close anyway?");
      if (!ok) return Promise.resolve();
    }
    return safeAction(() => shellApi().closeTab(tabId), set);
  },
  selectTab: (tabId) => {
    get().closePage();
    return safeAction(() => shellApi().selectTab(tabId), set);
  },
  suspendTab: (tabId) => safeAction(() => shellApi().suspendTab(tabId), set),
  setForcedFocus: (tabId, enabled) => safeAction(() => shellApi().setForcedFocus(tabId, enabled), set),
  navigate: (tabId, url) => safeAction(() => shellApi().navigate(tabId, url), set),
  goBack: (tabId) => safeAction(() => shellApi().goBack(tabId), set),
  goForward: (tabId) => safeAction(() => shellApi().goForward(tabId), set),
  reload: (tabId) => safeAction(() => shellApi().reload(tabId), set),
  setSplit: (mode) => safeAction(() => shellApi().setSplit(mode), set),
  reorderTab: (tabId, index) => safeAction(() => shellApi().reorderTab(tabId, index), set),
  splitWith: (tabId, side) => safeAction(() => shellApi().splitWith(tabId, side), set),
  removeFromSplit: (tabId) => safeAction(() => shellApi().removeFromSplit(tabId), set),
  duplicateTab: (tabId) =>
    safeAction(async () => {
      await shellApi().duplicateTab(tabId);
    }, set),
  moveTabToSpace: (tabId, spaceId) => safeAction(() => shellApi().moveTabToSpace(tabId, spaceId), set),
  restoreClosedTab: () => safeAction(() => shellApi().restoreClosedTab(), set),
  clearUnpinnedTabs: () => {
    const state = get();
    const unpinnedIds = new Set(
      (state.snapshot?.tabs ?? [])
        .filter((tab) => tab.kind === "human" && tab.anchorId === null)
        .map((tab) => tab.id),
    );
    const run = state.snapshot?.run ?? null;
    const live = run !== null && !isTerminalStatus(run.status);
    const ownsRun = run !== null && (
      (run.humanTabId !== null && unpinnedIds.has(run.humanTabId)) ||
      (run.agentTabId !== null && unpinnedIds.has(run.agentTabId))
    );
    if (live && ownsRun && state.settings.general.confirmCloseWithRun) {
      const ok = window.confirm("The agent is using an unpinned tab. Clearing tabs will end the browser task. Continue?");
      if (!ok) return Promise.resolve();
    }
    return safeAction(() => shellApi().clearUnpinnedTabs(), set);
  },
  controlMedia: (tabId, control) => safeAction(() => shellApi().controlMedia(tabId, control), set),
  cancelReadAloud: (id) => safeAction(() => shellApi().cancelReadAloud(id), set),
  readAloudText: (text) => safeAction(() => shellApi().readAloudText(text), set),
  sidebarCommand: (command) => safeAction(() => shellApi().sidebarCommand(command), set),
  tabGroupCommand: async (command) => {
    const result = await attemptValue(() => shellApi().tabGroupCommand(command));
    if (result.ok) return result.value;
    get().showNotice(result.error, { tone: "warning" });
    return null;
  },
  tidyRunning: false,
  tidyTabs: async () => {
    if (get().tidyRunning) return;
    set({ tidyRunning: true });
    const result = await attemptValue(() => shellApi().tidy({ type: "run" }));
    set({ tidyRunning: false });
    if (!result.ok) get().showNotice(result.error, { tone: "warning" });
    else if (result.value.type === "ran") get().announceTidy(result.value.summary);
  },
  undoTidy: async () => {
    const result = await attemptValue(() => shellApi().tidy({ type: "undo" }));
    if (!result.ok) get().showNotice(result.error, { tone: "warning" });
    else if (result.value.type === "undone") get().showNotice(result.value.ok ? "Tabs are back where they were" : "Nothing to undo");
  },
  announceTidy: (summary) => {
    if (!tidyDidSomething(summary)) {
      if (summary.trigger === "manual") get().showNotice(tidySummaryText(summary));
      return;
    }
    const said = tidySummaryText(summary);
    // The first run a profile sees explains itself: tabs have just left the sidebar on their own.
    const hours = get().settings.tabs.archiveAfterHours;
    const message = summary.firstRun && summary.trigger === "auto" && hours > 0
      ? `${said} — idle tabs are archived after ${hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`}`
      : said;
    get().showNotice(message, { tone: "success", action: { label: "Undo", run: () => void get().undoTidy() } });
  },
  startDelegation: (intent, attachments, options) =>
    safeAction(() => shellApi().startDelegation(intent, attachments, options), set),
  sendAgentMessage: (content, attachments, options) =>
    safeAction(() => shellApi().sendAgentMessage(content, attachments, options), set),
  // A lightbox over the content hole is an overlay like any other: without
  // the raise, main leaves the native tab views on top and it opens unseen.
  openImagePreview: (preview) => set({ imagePreview: preview, overlay: "image-preview" }),
  closeImagePreview: () =>
    set((state) => (state.overlay === "image-preview" ? { imagePreview: null, overlay: "none" } : { imagePreview: null })),
  answerAgentQuestion: (questionId, answer) =>
    safeAction(() => shellApi().answerAgentQuestion(questionId, answer), set),
  interruptAgent: () => safeAction(() => shellApi().interruptAgent(), set),
  retryAgentTurn: () => safeAction(() => shellApi().retryAgentTurn(), set),
  approve: (approvalId) => safeAction(() => shellApi().approve(approvalId), set),
  reject: (approvalId) => safeAction(() => shellApi().reject(approvalId), set),
  takeControl: () => safeAction(() => shellApi().takeControl(), set),
  releaseControl: () => safeAction(() => shellApi().releaseControl(), set),
  revokeRun: () => safeAction(() => shellApi().revokeRun(), set),
  openThread: (runId) => safeAction(() => shellApi().openThread(runId), set),
  newThread: () => safeAction(() => shellApi().newThread(), set),
  deleteThread: (runId) => safeAction(() => shellApi().deleteThread(runId), set),
  loadEvidence: async () => {
    const evidence = await shellApi().getEvidence();
    set({ evidence, consoleOpen: true });
  },
  closeEvidence: () => set({ evidence: null }),

  // ── Account and devices ───────────────────────────────────────────────
  // Main publishes account:changed and devices:updated after every one of
  // these, but the answer is folded in here too: the settings page must
  // show the result of the button it just ran without waiting for a round
  // trip through the subscription.
  async signUp(email, password) {
    const result = await attemptValue(() => shellApi().signUp(email, password));
    if (result.ok) set({ account: result.value });
    return result;
  },
  async signIn(email, password) {
    const result = await attemptValue(() => shellApi().signIn(email, password));
    if (result.ok) set({ account: result.value });
    return result;
  },
  async enrollDevice() {
    const result = await attemptValue(() => shellApi().enroll());
    if (result.ok) set({ account: result.value.state });
    return result;
  },
  async signOut() {
    const result = await attemptValue(() => shellApi().signOut());
    // Devices and channels belong to the account that just left this Mac.
    // `refreshChannels` only ever sets the list when the answer arrives, so a
    // list kept here would still be on screen — and, if the next account's
    // listing fails, would stay there under someone else's name.
    if (result.ok) set({ account: result.value, devices: [], channels: [] });
    return result.ok ? null : result.error;
  },
  async changePassword(currentPassword, newPassword) {
    const result = await attemptValue(() => shellApi().changePassword(currentPassword, newPassword));
    if (result.ok) set({ account: result.value });
    return result.ok ? null : result.error;
  },
  generateRecoveryCode: () => attemptValue(() => shellApi().recoveryCode()),
  async renameDevice(deviceId, name) {
    const result = await attemptValue(() => shellApi().renameDevice(deviceId, name));
    if (result.ok) set({ devices: result.value });
    return result.ok ? null : result.error;
  },
  async revokeDevice(deviceId) {
    const result = await attemptValue(() => shellApi().revokeDevice(deviceId));
    if (result.ok) set({ devices: result.value });
    return result.ok ? null : result.error;
  },
  async confirmCloudDevice() {
    const result = await attemptValue(() => shellApi().confirmCloudDevice());
    if (result.ok) set({ account: result.value });
    return result.ok ? null : result.error;
  },

  // ── Cookie sync ───────────────────────────────────────────────────────
  retrySync: () =>
    safeAction(async () => {
      set({ syncStatus: await shellApi().retrySync() });
    }, set),
  lookupSyncOrigin: (spaceId, host) => attemptValue(() => shellApi().getSyncOriginInfo(spaceId, host)),
  setSyncOriginOverride: (spaceId, host, override) =>
    attemptValue(() => shellApi().setSyncOriginOverride(spaceId, host, override)),
  rollbackSyncOrigin: (spaceId, host) => attempt(() => shellApi().rollbackSyncOrigin(spaceId, host)),
  async runWorkspaceSync(action) {
    const result = await attemptValue(() => shellApi().runWorkspaceSync(action));
    if (result.ok) set({ workspaceSync: result.value });
    return result.ok ? null : result.error;
  },

  // ── Identity egress ───────────────────────────────────────────────────
  async setSpaceEgressPolicy(spaceId, policy) {
    const result = await attemptValue(() => shellApi().setSpaceEgressPolicy(spaceId, policy));
    if (result.ok) set({ egress: result.value });
    return result.ok ? null : result.error;
  },
  async browseDirectForNow(spaceId) {
    const result = await attemptValue(() => shellApi().browseDirectForNow(spaceId));
    if (result.ok) set({ egress: result.value });
    return result.ok ? null : result.error;
  },

  // ── Cloud browser ─────────────────────────────────────────────────────
  async enableCloud(spaceId) {
    const result = await attemptValue(() => shellApi().enableCloud(spaceId));
    if (result.ok) set({ cloud: result.value });
    return result.ok ? null : result.error;
  },
  async disableCloud(spaceId) {
    const result = await attemptValue(() => shellApi().disableCloud(spaceId));
    if (result.ok) set({ cloud: result.value });
    return result.ok ? null : result.error;
  },
  startCloudRun: (request) => attemptValue(() => shellApi().startCloudRun(request)),
  async openLiveView(runId) {
    // The overlay goes up only once main has the socket: a live view raised
    // over a connection that was refused would paint an empty rectangle over
    // the page and call it a browser. A host that cannot open one AT ALL is
    // remembered as well as refused (§11): on a streamed surface the pane IS
    // the live view, the host answers `unsupported`, and the Monitor button
    // that would raise a dead overlay goes away instead of failing again.
    try {
      const cloud = await shellApi().openLiveView(runId);
      set({ cloud, overlay: "liveView", urlBarTabId: null, urlBarNew: false });
      return null;
    } catch (error: unknown) {
      get().noteRefusal("openLiveView", error);
      return error instanceof Error ? error.message : String(error);
    }
  },
  closeLiveView: () => {
    // The overlay closes first and unconditionally: whatever main answers,
    // the person asked for the page back.
    set((state) => (state.overlay === "liveView" ? { overlay: "none" } : {}));
    return safeAction(() => shellApi().closeLiveView(), set);
  },
  sendLiveInput: (input) => shellApi().sendLiveInput(input),
  async refreshChannels() {
    const result = await attemptValue(() => shellApi().listChannels());
    if (result.ok) set({ channels: result.value });
  },
  async createChannel(request) {
    const result = await attemptValue(() => shellApi().createChannel(request));
    if (result.ok) set((state) => ({ channels: [...state.channels, stripSecret(result.value)] }));
    return result;
  },
  async deleteChannel(linkId) {
    const result = await attemptValue(() => shellApi().deleteChannel(linkId));
    if (result.ok) set({ channels: result.value });
    return result.ok ? null : result.error;
  },
}));

/**
 * The one-time channel secret rides on the create answer alone. It is shown
 * once by the page that asked for it and never enters the store, where a
 * devtools snapshot — or the next render of any subscriber — would keep it.
 */
function stripSecret(created: ChannelCreated): ChannelInfo {
  const { secret: _secret, ...channel } = created;
  return channel;
}

export function selectActiveTab(state: AppState): BrowserTabInfo | null {
  const snapshot = state.snapshot;
  if (snapshot === null) return null;
  return snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId) ?? null;
}

export function selectSecondaryTab(state: AppState): BrowserTabInfo | null {
  const snapshot = state.snapshot;
  if (snapshot === null || snapshot.splitMode === "single" || snapshot.secondaryTabId === null) return null;
  return snapshot.tabs.find((tab) => tab.id === snapshot.secondaryTabId) ?? null;
}
