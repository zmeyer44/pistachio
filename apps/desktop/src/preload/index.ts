import type { WatchtowerResponse } from "@pistachio/shell-contracts/watchtower";
import type { TabArchiveResponse } from "@pistachio/shell-contracts/tab-archive";
import type { TabGroupCommandResult } from "@pistachio/shell-contracts/tab-groups";
import type { TidyResponse } from "@pistachio/shell-contracts/tidy";
import { contextBridge, ipcRenderer } from "electron";
import type {
  CredentialCapture,
  CredentialCaptureReply,
  IntegrationAccess,
  IntegrationProvider, FeedbackInput } from "@pistachio/protocol";
import type {
  BrowserImportRequest,
  BrowserImportResult,
  InstalledBrowser,
} from "@pistachio/shell-contracts/browser-import";
import type {
  OnboardingCompletion,
  OnboardingIntake,
} from "@pistachio/shell-contracts/onboarding";
import type {
  MemoryAddInput,
  MemoryEntry,
  MemoryReview,
  MemorySnapshot,
  MemoryUpdateInput,
} from "@pistachio/shell-contracts/memory";
import type {
  Bookmark,
  BookmarkInput,
  BookmarkPatch,
  BookmarkSnapshot,
  BookmarkToast,
} from "@pistachio/shell-contracts/bookmarks";
import type {
  Reminder,
  ReminderInput,
  ReminderPatch,
  ReminderSnapshot,
} from "@pistachio/shell-contracts/reminders";
import type {
  AddressIntentRanking,
} from "@pistachio/shell-contracts/address-intent";
import type { DesktopSettings, SettingsPatch } from "@pistachio/shell-contracts/settings";
import type { UpdateState } from "@pistachio/shell-contracts/updates";
import type {
  DragCursor,
  DragSample,
  ShellCommand,
  ShellState,
  TabDragVisual,
} from "@pistachio/shell-contracts/chrome";
import type { SidebarCommand } from "@pistachio/shell-contracts/sidebar";
import type { NoticeEvent, NoticeFrame, NoticeStackState } from "@pistachio/shell-contracts/notice";
import type {
  BrowserMediaInfo,
  MediaControl,
  ReadAloudStatus,
} from "@pistachio/shell-contracts/media";
import type {
  BrowserControlCommand,
  BrowserControlsSnapshot,
  BrowserDownload,
  FindCommand,
  FindState,
} from "@pistachio/shell-contracts/browser-controls";
import {
  IPC,
  type AccountEnrollResult,
  type AccountState,
  type AiProviderStatus,
  type AiUsageSummary,
  type AppInfo,
  type BrowserLayout,
  type ChannelCreateRequest,
  type ChannelCreated,
  type ChannelInfo,
  type CloudFrame,
  type CloudLiveInput,
  type CloudStartRunRequest,
  type CloudStatus,
  type DeviceInfo,
  type EgressStatus,
  type MediaPreviewPlacement,
  type CommandPaletteSnapshot,
  type ContentBounds,
  type CursorPoint,
  type FeedbackOutcome,
  type GlanceState,
  type IMessageLinkChallenge,
  type IMessageLinkStatus,
  type VaultEntryDraft,
  type VaultEntryInfo,
  type CalendarAgenda,
  type IntegrationConnectionInfo,
  type IntegrationProviderInfo,
  type ShellGlanceOpenRequest,
  type PaneStill,
  type PistachioApi,
  type ShellLaunchState,
  type ShellRunSnapshot,
  type ShellSnapshot,
  type ShellTabsSnapshot,
  type SpaceEgressPolicy,
  type SplitMode,
  type SpeechInput,
  type SplitSide,
  type SyncOriginInfo,
  type SyncOriginOverride,
  type SyncStatus,
  type TabSwitcherInput,
  type TabSwitcherPreview,
  type WorkspaceSyncAction,
  type WorkspaceSyncStatus,
} from "@pistachio/shell-contracts/ipc";
import type { NoteResponse, NoteSnapshot } from "@pistachio/shell-contracts/notes";
import type { ReportResponse } from "@pistachio/shell-contracts/reports";

/** Subscribe to one main → renderer channel; the returned function unsubscribes. */
function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: T): void => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: PistachioApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshot) as Promise<ShellSnapshot>,
  onSnapshot(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: ShellTabsSnapshot,
    ): void => listener(snapshot);
    ipcRenderer.on(IPC.snapshotChanged, handler);
    return () => ipcRenderer.removeListener(IPC.snapshotChanged, handler);
  },
  onRun(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      run: ShellRunSnapshot,
    ): void => listener(run);
    ipcRenderer.on(IPC.runChanged, handler);
    return () => ipcRenderer.removeListener(IPC.runChanged, handler);
  },
  getCommandPalette: () =>
    ipcRenderer.invoke(
      IPC.commandPaletteGet,
    ) as Promise<CommandPaletteSnapshot>,
  rankAddressIntent: (request) =>
    ipcRenderer.invoke(
      IPC.addressIntentRank,
      request,
    ) as Promise<AddressIntentRanking | null>,
  switchSpace: (spaceId) =>
    ipcRenderer.invoke(IPC.spaceSwitch, spaceId) as Promise<void>,
  forkSpace: (request) => ipcRenderer.invoke(IPC.spaceFork, request),
  createTab: (url) => ipcRenderer.invoke(IPC.tabCreate, url) as Promise<void>,
  closeTab: (tabId) => ipcRenderer.invoke(IPC.tabClose, tabId) as Promise<void>,
  selectTab: (tabId) =>
    ipcRenderer.invoke(IPC.tabSelect, tabId) as Promise<void>,
  suspendTab: (tabId) =>
    ipcRenderer.invoke(IPC.tabSuspend, tabId) as Promise<void>,
  navigate: (tabId, url) =>
    ipcRenderer.invoke(IPC.tabNavigate, tabId, url) as Promise<void>,
  goBack: (tabId) => ipcRenderer.invoke(IPC.tabBack, tabId) as Promise<void>,
  goForward: (tabId) =>
    ipcRenderer.invoke(IPC.tabForward, tabId) as Promise<void>,
  reload: (tabId) => ipcRenderer.invoke(IPC.tabReload, tabId) as Promise<void>,
  setSplit: (mode: SplitMode) =>
    ipcRenderer.invoke(IPC.splitSet, mode) as Promise<void>,
  reorderTab: (tabId, index) =>
    ipcRenderer.invoke(IPC.tabReorder, tabId, index) as Promise<void>,
  splitWith: (tabId, side: SplitSide) =>
    ipcRenderer.invoke(IPC.tabSplitWith, tabId, side) as Promise<void>,
  removeFromSplit: (tabId) =>
    ipcRenderer.invoke(IPC.tabRemoveFromSplit, tabId) as Promise<void>,
  duplicateTab: (tabId) =>
    ipcRenderer.invoke(IPC.tabDuplicate, tabId) as Promise<string>,
  setForcedFocus: (tabId, enabled) =>
    ipcRenderer.invoke(IPC.tabForcedFocus, tabId, enabled) as Promise<void>,
  moveTabToSpace: (tabId, spaceId) =>
    ipcRenderer.invoke(IPC.tabMoveToSpace, tabId, spaceId) as Promise<void>,
  restoreClosedTab: () =>
    ipcRenderer.invoke(IPC.tabRestoreClosed) as Promise<void>,
  clearUnpinnedTabs: () =>
    ipcRenderer.invoke(IPC.tabsClearUnpinned) as Promise<void>,
  getMedia: () =>
    ipcRenderer.invoke(IPC.mediaGet) as Promise<BrowserMediaInfo[]>,
  onMediaChanged(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      media: BrowserMediaInfo[],
    ): void => listener(media);
    ipcRenderer.on(IPC.mediaChanged, handler);
    return () => ipcRenderer.removeListener(IPC.mediaChanged, handler);
  },
  controlMedia: (tabId: string, control: MediaControl) =>
    ipcRenderer.invoke(IPC.mediaControl, tabId, control) as Promise<void>,
  setMediaPreview: (preview: MediaPreviewPlacement | null) =>
    ipcRenderer.send(IPC.mediaPreviewSet, preview),
  onMediaPreviewHoverChanged(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      tabId: string | null,
    ): void => listener(tabId);
    ipcRenderer.on(IPC.mediaPreviewHoverChanged, handler);
    return () => ipcRenderer.removeListener(IPC.mediaPreviewHoverChanged, handler);
  },
  getReadAloud: () =>
    ipcRenderer.invoke(IPC.readAloudGet) as Promise<ReadAloudStatus[]>,
  onReadAloudChanged(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      jobs: ReadAloudStatus[],
    ): void => listener(jobs);
    ipcRenderer.on(IPC.readAloudChanged, handler);
    return () => ipcRenderer.removeListener(IPC.readAloudChanged, handler);
  },
  cancelReadAloud: (id: string) =>
    ipcRenderer.invoke(IPC.readAloudCancel, id) as Promise<void>,
  readAloudText: (text: string) =>
    ipcRenderer.invoke(IPC.readAloudSpeak, text) as Promise<void>,
  getBrowserControls: () =>
    ipcRenderer.invoke(
      IPC.browserControlsGet,
    ) as Promise<BrowserControlsSnapshot>,
  onBrowserControlsChanged(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: BrowserControlsSnapshot,
    ): void => listener(snapshot);
    ipcRenderer.on(IPC.browserControlsChanged, handler);
    return () =>
      ipcRenderer.removeListener(IPC.browserControlsChanged, handler);
  },
  browserControl: (command: BrowserControlCommand) =>
    ipcRenderer.invoke(IPC.browserControl, command) as Promise<void>,
  getDownloads: () =>
    ipcRenderer.invoke(IPC.downloadsGet) as Promise<BrowserDownload[]>,
  onDownloadsChanged(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      downloads: BrowserDownload[],
    ): void => listener(downloads);
    ipcRenderer.on(IPC.downloadsChanged, handler);
    return () => ipcRenderer.removeListener(IPC.downloadsChanged, handler);
  },
  getFindState: () => ipcRenderer.invoke(IPC.findGet) as Promise<FindState>,
  onFindStateChanged(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: FindState,
    ): void => listener(state);
    ipcRenderer.on(IPC.findChanged, handler);
    return () => ipcRenderer.removeListener(IPC.findChanged, handler);
  },
  find: (command: FindCommand) =>
    ipcRenderer.invoke(IPC.findCommand, command) as Promise<void>,
  sidebarCommand: (command: SidebarCommand) =>
    ipcRenderer.invoke(IPC.sidebarCommand, command) as Promise<void>,
  tabGroupCommand: (command) => ipcRenderer.invoke(IPC.tabGroupCommand, command) as Promise<TabGroupCommandResult>,
  tabArchive: (request) => ipcRenderer.invoke(IPC.tabArchive, request) as Promise<TabArchiveResponse>,
  tidy: (request) => ipcRenderer.invoke(IPC.tidy, request) as Promise<TidyResponse>,
  setLayout: (layout: BrowserLayout) => ipcRenderer.send(IPC.layoutSet, layout),
  prepareOverlay: () =>
    ipcRenderer.invoke(IPC.overlayPrepare) as Promise<PaneStill[]>,
  setOverlay: (active) =>
    ipcRenderer.invoke(IPC.overlaySet, active) as Promise<void>,
  getTabSwitcherPreviews: () =>
    ipcRenderer.invoke(IPC.tabSwitcherPreviewsGet) as Promise<
      TabSwitcherPreview[]
    >,
  onTabSwitcherInput(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      input: TabSwitcherInput,
    ): void => listener(input);
    ipcRenderer.on(IPC.tabSwitcherInput, handler);
    return () => ipcRenderer.removeListener(IPC.tabSwitcherInput, handler);
  },
  getGlance: () =>
    ipcRenderer.invoke(IPC.glanceGet) as Promise<GlanceState | null>,
  onGlanceChanged(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      glance: GlanceState | null,
    ): void => listener(glance);
    ipcRenderer.on(IPC.glanceChanged, handler);
    return () => ipcRenderer.removeListener(IPC.glanceChanged, handler);
  },
  openGlance: (request: ShellGlanceOpenRequest) =>
    ipcRenderer.invoke(IPC.glanceOpenFromShell, request) as Promise<boolean>,
  submitFeedback: (input: FeedbackInput) =>
    ipcRenderer.invoke(IPC.feedbackSubmit, input) as Promise<FeedbackOutcome>,
  recedeGlanceOwner: () => ipcRenderer.send(IPC.glanceOwnerRecede),
  setGlanceBounds: (bounds: ContentBounds | null) =>
    ipcRenderer.send(IPC.glanceBoundsSet, bounds),
  prepareGlanceClose: () =>
    ipcRenderer.invoke(IPC.glancePrepareClose) as Promise<string | null>,
  stageGlancePromotion: (bounds: ContentBounds) =>
    ipcRenderer.invoke(IPC.glancePromotionStage, bounds) as Promise<void>,
  closeGlance: () => ipcRenderer.invoke(IPC.glanceClose) as Promise<void>,
  promoteGlance: () => ipcRenderer.invoke(IPC.glancePromote) as Promise<void>,
  splitGlance: () => ipcRenderer.invoke(IPC.glanceSplit) as Promise<void>,
  onGlanceDismissRequested(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      hasFocused: boolean,
    ): void => listener(hasFocused === true);
    ipcRenderer.on(IPC.glanceDismissRequested, handler);
    return () =>
      ipcRenderer.removeListener(IPC.glanceDismissRequested, handler);
  },
  setDragCapture: (cursor: DragCursor | null) =>
    ipcRenderer.send(IPC.dragCaptureSet, cursor),
  onDragCapture(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      cursor: DragCursor | null,
    ): void => listener(cursor);
    ipcRenderer.on(IPC.dragCaptureChanged, handler);
    return () => ipcRenderer.removeListener(IPC.dragCaptureChanged, handler);
  },
  setTabDragVisual: (visual: TabDragVisual | null) =>
    ipcRenderer.send(IPC.tabDragVisualSet, visual),
  onTabDragVisual(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      visual: TabDragVisual | null,
    ): void => listener(visual);
    ipcRenderer.on(IPC.tabDragVisualChanged, handler);
    return () => ipcRenderer.removeListener(IPC.tabDragVisualChanged, handler);
  },
  sendDragSample: (sample: DragSample) =>
    ipcRenderer.send(IPC.dragSample, sample),
  onDragSample(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      sample: DragSample,
    ): void => listener(sample);
    ipcRenderer.on(IPC.dragSample, handler);
    return () => ipcRenderer.removeListener(IPC.dragSample, handler);
  },
  setSidebarWatch: (box: ContentBounds | null) =>
    ipcRenderer.send(IPC.sidebarWatchSet, box),
  onSidebarPointerEntered(listener) {
    const handler = (): void => listener();
    ipcRenderer.on(IPC.sidebarPointerEntered, handler);
    return () => ipcRenderer.removeListener(IPC.sidebarPointerEntered, handler);
  },
  onSidebarPointerLeft(listener) {
    const handler = (): void => listener();
    ipcRenderer.on(IPC.sidebarPointerLeft, handler);
    return () => ipcRenderer.removeListener(IPC.sidebarPointerLeft, handler);
  },
  setPaneToolbarTrigger: (box: ContentBounds | null) =>
    ipcRenderer.send(IPC.paneToolbarTriggerSet, box),
  setPaneToolbarWatch: (box: ContentBounds | null) =>
    ipcRenderer.send(IPC.paneToolbarWatchSet, box),
  onPaneToolbarPointerEntered(listener) {
    const handler = (): void => listener();
    ipcRenderer.on(IPC.paneToolbarPointerEntered, handler);
    return () => ipcRenderer.removeListener(IPC.paneToolbarPointerEntered, handler);
  },
  onPaneToolbarPointerLeft(listener) {
    const handler = (): void => listener();
    ipcRenderer.on(IPC.paneToolbarPointerLeft, handler);
    return () => ipcRenderer.removeListener(IPC.paneToolbarPointerLeft, handler);
  },
  getCursorPoint: () =>
    ipcRenderer.invoke(IPC.cursorPoint) as Promise<CursorPoint | null>,
  setShellState: (state: ShellState) =>
    ipcRenderer.send(IPC.shellStateSet, state),
  onShellCommand(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      command: ShellCommand,
    ): void => listener(command);
    ipcRenderer.on(IPC.shellCommand, handler);
    return () => ipcRenderer.removeListener(IPC.shellCommand, handler);
  },
  startDelegation: (intent, attachments, options) =>
    ipcRenderer.invoke(IPC.runStart, intent, attachments, options) as Promise<void>,
  sendAgentMessage: (content, attachments, options) =>
    ipcRenderer.invoke(IPC.runMessage, content, attachments, options) as Promise<void>,
  answerAgentQuestion: (questionId, answer) =>
    ipcRenderer.invoke(IPC.runAnswer, questionId, answer) as Promise<void>,
  interruptAgent: () => ipcRenderer.invoke(IPC.runInterrupt) as Promise<void>,
  retryAgentTurn: () => ipcRenderer.invoke(IPC.runRetry) as Promise<void>,
  approve: (approvalId) =>
    ipcRenderer.invoke(IPC.runApprove, approvalId) as Promise<void>,
  reject: (approvalId) =>
    ipcRenderer.invoke(IPC.runReject, approvalId) as Promise<void>,
  takeControl: () => ipcRenderer.invoke(IPC.runTakeControl) as Promise<void>,
  releaseControl: () =>
    ipcRenderer.invoke(IPC.runReleaseControl) as Promise<void>,
  revokeRun: () => ipcRenderer.invoke(IPC.runRevoke) as Promise<void>,
  openThread: (runId) => ipcRenderer.invoke(IPC.threadOpen, runId) as Promise<void>,
  newThread: () => ipcRenderer.invoke(IPC.threadNew) as Promise<void>,
  deleteThread: (runId) => ipcRenderer.invoke(IPC.threadDelete, runId) as Promise<void>,
  getEvidence: () => ipcRenderer.invoke(IPC.evidenceGet),
  getSettings: () =>
    ipcRenderer.invoke(IPC.settingsGet) as Promise<DesktopSettings>,
  getAiStatus: () =>
    ipcRenderer.invoke(IPC.aiStatusGet) as Promise<AiProviderStatus>,
  getAiUsage: () =>
    ipcRenderer.invoke(IPC.aiUsageGet) as Promise<AiUsageSummary | null>,
  updateSettings: (patch: SettingsPatch) =>
    ipcRenderer.invoke(IPC.settingsUpdate, patch) as Promise<DesktopSettings>,
  resetSettings: () =>
    ipcRenderer.invoke(IPC.settingsReset) as Promise<DesktopSettings>,
  onSettings(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      settings: DesktopSettings,
    ): void => listener(settings);
    ipcRenderer.on(IPC.settingsChanged, handler);
    return () => ipcRenderer.removeListener(IPC.settingsChanged, handler);
  },
  getMemory: () => ipcRenderer.invoke(IPC.memoryGet) as Promise<MemorySnapshot>,
  addMemory: (input: MemoryAddInput) =>
    ipcRenderer.invoke(IPC.memoryAdd, input) as Promise<MemoryEntry>,
  updateMemory: (id: string, patch: MemoryUpdateInput) =>
    ipcRenderer.invoke(IPC.memoryUpdate, id, patch) as Promise<MemoryEntry>,
  forgetMemory: (id: string, reason: string) =>
    ipcRenderer.invoke(IPC.memoryForget, id, reason) as Promise<MemoryEntry>,
  restoreMemory: (id: string) =>
    ipcRenderer.invoke(IPC.memoryRestore, id) as Promise<MemoryEntry>,
  reviewMemory: (id: string, decision: Exclude<MemoryReview, "pending">) =>
    ipcRenderer.invoke(IPC.memoryReview, id, decision) as Promise<MemoryEntry>,
  forgetAllMemory: () =>
    ipcRenderer.invoke(IPC.memoryForgetAll) as Promise<number>,
  onMemory(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: MemorySnapshot,
    ): void => listener(snapshot);
    ipcRenderer.on(IPC.memoryChanged, handler);
    return () => ipcRenderer.removeListener(IPC.memoryChanged, handler);
  },
  getReminders: () =>
    ipcRenderer.invoke(IPC.remindersGet) as Promise<ReminderSnapshot>,
  onReminders(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: ReminderSnapshot,
    ): void => listener(snapshot);
    ipcRenderer.on(IPC.remindersChanged, handler);
    return () => ipcRenderer.removeListener(IPC.remindersChanged, handler);
  },
  addReminder: (input: ReminderInput) =>
    ipcRenderer.invoke(IPC.reminderAdd, input) as Promise<Reminder>,
  updateReminder: (id: string, patch: ReminderPatch) =>
    ipcRenderer.invoke(IPC.reminderUpdate, id, patch) as Promise<Reminder>,
  cancelReminder: (id: string) =>
    ipcRenderer.invoke(IPC.reminderCancel, id) as Promise<Reminder>,
  deleteReminder: (id: string) =>
    ipcRenderer.invoke(IPC.reminderDelete, id) as Promise<void>,
  runReminderNow: (id: string) =>
    ipcRenderer.invoke(IPC.reminderRunNow, id) as Promise<void>,
  acknowledgeReminders: (ids: string[] | "all") =>
    ipcRenderer.invoke(IPC.reminderAcknowledge, ids) as Promise<number>,
  snoozeReminder: (occurrenceId: string, minutes: number) =>
    ipcRenderer.invoke(
      IPC.reminderSnooze,
      occurrenceId,
      minutes,
    ) as Promise<Reminder>,
  getBookmarks: () =>
    ipcRenderer.invoke(IPC.bookmarksGet) as Promise<BookmarkSnapshot>,
  onBookmarks(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: BookmarkSnapshot,
    ): void => listener(snapshot);
    ipcRenderer.on(IPC.bookmarksChanged, handler);
    return () => ipcRenderer.removeListener(IPC.bookmarksChanged, handler);
  },
  toggleReaderView: (tabId?: string) =>
    ipcRenderer.invoke(IPC.readerToggle, tabId) as Promise<boolean>,
  bookmarkTab: (tabId?: string) =>
    ipcRenderer.invoke(IPC.bookmarkTab, tabId) as Promise<Bookmark>,
  addBookmark: (input: BookmarkInput) =>
    ipcRenderer.invoke(IPC.bookmarkAdd, input) as Promise<Bookmark>,
  updateBookmark: (id: string, patch: BookmarkPatch) =>
    ipcRenderer.invoke(IPC.bookmarkUpdate, id, patch) as Promise<Bookmark>,
  deleteBookmark: (id: string) =>
    ipcRenderer.invoke(IPC.bookmarkDelete, id) as Promise<void>,
  refreshBookmark: (id: string) =>
    ipcRenderer.invoke(IPC.bookmarkRefresh, id) as Promise<Bookmark>,
  getBookmarkToast: () =>
    ipcRenderer.invoke(IPC.bookmarkToastGet) as Promise<BookmarkToast | null>,
  onBookmarkToast(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      toast: BookmarkToast | null,
    ): void => listener(toast);
    ipcRenderer.on(IPC.bookmarkToastChanged, handler);
    return () => ipcRenderer.removeListener(IPC.bookmarkToastChanged, handler);
  },
  dismissBookmarkToast: () => ipcRenderer.send(IPC.bookmarkToastDismiss),
  resizeBookmarkToast: (height: number) =>
    ipcRenderer.send(IPC.bookmarkToastResize, height),
  setNotices: (frame: NoticeFrame) => ipcRenderer.send(IPC.noticesSet, frame),
  getNotices: () => ipcRenderer.invoke(IPC.noticesGet) as Promise<NoticeStackState>,
  onNotices(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: NoticeStackState,
    ): void => listener(state);
    ipcRenderer.on(IPC.noticesChanged, handler);
    return () => ipcRenderer.removeListener(IPC.noticesChanged, handler);
  },
  resizeNoticeView: (height: number) =>
    ipcRenderer.send(IPC.noticeViewResize, height),
  sendNoticeEvent: (event: NoticeEvent) =>
    ipcRenderer.send(IPC.noticeEvent, event),
  onNoticeEvent(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      noticeEvent: NoticeEvent,
    ): void => listener(noticeEvent);
    ipcRenderer.on(IPC.noticeEvent, handler);
    return () => ipcRenderer.removeListener(IPC.noticeEvent, handler);
  },
  openBookmarksPage: (bookmarkId?: string) =>
    ipcRenderer.send(IPC.bookmarksOpen, bookmarkId),
  watchtower: (request) => ipcRenderer.invoke(IPC.watchtower, request) as Promise<WatchtowerResponse>,
  clearBrowsingData: () =>
    ipcRenderer.invoke(IPC.browsingDataClear) as Promise<void>,
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,
  getUpdateState: () =>
    ipcRenderer.invoke(IPC.updateGet) as Promise<UpdateState>,
  onUpdateState(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: UpdateState,
    ): void => listener(state);
    ipcRenderer.on(IPC.updateChanged, handler);
    return () => ipcRenderer.removeListener(IPC.updateChanged, handler);
  },
  checkForUpdates: () =>
    ipcRenderer.invoke(IPC.updateCheck) as Promise<UpdateState>,
  downloadUpdate: () =>
    ipcRenderer.invoke(IPC.updateDownload) as Promise<UpdateState>,
  installUpdate: () => ipcRenderer.send(IPC.updateInstall),
  detectBrowsers: () =>
    ipcRenderer.invoke(IPC.browsersDetect) as Promise<InstalledBrowser[]>,
  importBrowserProfiles: (requests: BrowserImportRequest[]) =>
    ipcRenderer.invoke(IPC.browserImport, requests) as Promise<
      BrowserImportResult[]
    >,
  requestMicrophone: () =>
    ipcRenderer.invoke(IPC.microphoneRequest) as Promise<boolean>,
  transcribeSpeech: (input: SpeechInput) =>
    ipcRenderer.invoke(IPC.speechTranscribe, input) as Promise<string>,
  extractOnboardingIntake: (transcript: string) =>
    ipcRenderer.invoke(
      IPC.onboardingExtract,
      transcript,
    ) as Promise<OnboardingIntake>,
  completeOnboarding: (input: OnboardingCompletion) =>
    ipcRenderer.invoke(IPC.onboardingComplete, input) as Promise<void>,
  // Synchronous on purpose: the shell reads it once, during its first
  // render, so a fresh install never paints the chrome before the wizard.
  // One round trip, in the shell window only.
  launchState: () => ipcRenderer.sendSync(IPC.launchState) as ShellLaunchState,
  // ── Account (§10.1) ──────────────────────────────────────────────────
  getAccount: () => ipcRenderer.invoke(IPC.accountGet) as Promise<AccountState>,
  onAccount: (listener) => subscribe<AccountState>(IPC.accountChanged, listener),
  signUp: (email: string, password: string) =>
    ipcRenderer.invoke(IPC.accountSignUp, email, password) as Promise<AccountState>,
  signIn: (email: string, password: string) =>
    ipcRenderer.invoke(IPC.accountSignIn, email, password) as Promise<AccountState>,
  enroll: () => ipcRenderer.invoke(IPC.accountEnroll) as Promise<AccountEnrollResult>,
  signOut: () => ipcRenderer.invoke(IPC.accountSignOut) as Promise<AccountState>,
  changePassword: (currentPassword: string, newPassword: string) =>
    ipcRenderer.invoke(
      IPC.accountChangePassword,
      currentPassword,
      newPassword,
    ) as Promise<AccountState>,
  recoveryCode: () => ipcRenderer.invoke(IPC.accountRecoveryCode) as Promise<string>,
  // ── Devices ───────────────────────────────────────────────────────────
  listDevices: () => ipcRenderer.invoke(IPC.devicesList) as Promise<DeviceInfo[]>,
  onDevices: (listener) => subscribe<DeviceInfo[]>(IPC.devicesUpdated, listener),
  renameDevice: (deviceId: string, name: string) =>
    ipcRenderer.invoke(IPC.devicesRename, deviceId, name) as Promise<DeviceInfo[]>,
  revokeDevice: (deviceId: string) =>
    ipcRenderer.invoke(IPC.devicesRevoke, deviceId) as Promise<DeviceInfo[]>,
  confirmCloudDevice: () =>
    ipcRenderer.invoke(IPC.devicesConfirmCloud) as Promise<AccountState>,
  // ── Cookie sync (§10.2) ───────────────────────────────────────────────
  getSyncStatus: () => ipcRenderer.invoke(IPC.syncStatus) as Promise<SyncStatus>,
  onSyncStatus: (listener) => subscribe<SyncStatus>(IPC.syncChanged, listener),
  getSyncOriginInfo: (spaceId: string, host: string) =>
    ipcRenderer.invoke(IPC.syncOriginInfo, spaceId, host) as Promise<SyncOriginInfo>,
  setSyncOriginOverride: (
    spaceId: string,
    host: string,
    override: SyncOriginOverride | null,
  ) =>
    ipcRenderer.invoke(
      IPC.syncSetOriginOverride,
      spaceId,
      host,
      override,
    ) as Promise<SyncOriginInfo>,
  rollbackSyncOrigin: (spaceId: string, host: string) =>
    ipcRenderer.invoke(IPC.syncRollbackOrigin, spaceId, host) as Promise<void>,
  retrySync: () => ipcRenderer.invoke(IPC.syncRetry) as Promise<SyncStatus>,
  // ── Workspace sync (§10.2) ────────────────────────────────────────────
  getWorkspaceSync: () =>
    ipcRenderer.invoke(IPC.workspaceSyncGet) as Promise<WorkspaceSyncStatus>,
  onWorkspaceSync: (listener) =>
    subscribe<WorkspaceSyncStatus>(IPC.workspaceSyncChanged, listener),
  runWorkspaceSync: (action: WorkspaceSyncAction) =>
    ipcRenderer.invoke(IPC.workspaceSyncRun, action) as Promise<WorkspaceSyncStatus>,
  // ── Identity egress (§10.3) ───────────────────────────────────────────
  getEgressStatus: () => ipcRenderer.invoke(IPC.egressStatus) as Promise<EgressStatus>,
  onEgressStatus: (listener) => subscribe<EgressStatus>(IPC.egressChanged, listener),
  setSpaceEgressPolicy: (spaceId: string, policy: SpaceEgressPolicy) =>
    ipcRenderer.invoke(IPC.egressSetSpacePolicy, spaceId, policy) as Promise<EgressStatus>,
  browseDirectForNow: (spaceId: string) =>
    ipcRenderer.invoke(IPC.egressBrowseDirect, spaceId) as Promise<EgressStatus>,
  // ── Cloud browser (§10.4) ─────────────────────────────────────────────
  getCloudStatus: () => ipcRenderer.invoke(IPC.cloudStatus) as Promise<CloudStatus>,
  onCloudStatus: (listener) => subscribe<CloudStatus>(IPC.cloudChanged, listener),
  enableCloud: (spaceId: string) =>
    ipcRenderer.invoke(IPC.cloudEnable, spaceId) as Promise<CloudStatus>,
  disableCloud: (spaceId: string) =>
    ipcRenderer.invoke(IPC.cloudDisable, spaceId) as Promise<CloudStatus>,
  startCloudRun: (request: CloudStartRunRequest) =>
    ipcRenderer.invoke(IPC.cloudStartRun, request) as Promise<{ runId: string }>,
  openLiveView: (runId: string) =>
    ipcRenderer.invoke(IPC.cloudLiveOpen, runId) as Promise<CloudStatus>,
  closeLiveView: () => ipcRenderer.invoke(IPC.cloudLiveClose) as Promise<void>,
  sendLiveInput: (input: CloudLiveInput) => ipcRenderer.send(IPC.cloudLiveInput, input),
  onCloudFrame: (listener) => subscribe<CloudFrame>(IPC.cloudFrame, listener),
  // ── Channels (§7.3) ───────────────────────────────────────────────────
  listChannels: () => ipcRenderer.invoke(IPC.channelsList) as Promise<ChannelInfo[]>,
  createChannel: (request: ChannelCreateRequest) =>
    ipcRenderer.invoke(IPC.channelsCreate, request) as Promise<ChannelCreated>,
  deleteChannel: (linkId: string) =>
    ipcRenderer.invoke(IPC.channelsDelete, linkId) as Promise<ChannelInfo[]>,
  // ── iMessage ─────────────────────────────────────────────────────────
  getIMessageLink: () => ipcRenderer.invoke(IPC.imessageGet) as Promise<IMessageLinkStatus>,
  startIMessageLink: (phone: string) =>
    ipcRenderer.invoke(IPC.imessageStart, phone) as Promise<IMessageLinkChallenge>,
  verifyIMessageLink: (challengeId: string, code: string) =>
    ipcRenderer.invoke(IPC.imessageVerify, challengeId, code) as Promise<IMessageLinkStatus>,
  unlinkIMessage: () => ipcRenderer.invoke(IPC.imessageUnlink) as Promise<IMessageLinkStatus>,
  // ── Credential vault ────────────────────────────────────────────────
  getCredentialCapture: (captureId: string) =>
    ipcRenderer.invoke(IPC.credentialCaptureGet, captureId) as Promise<CredentialCaptureReply<CredentialCapture>>,
  submitCredentialCapture: (captureId: string, sealedPayload: string) =>
    ipcRenderer.invoke(IPC.credentialCaptureSubmit, captureId, sealedPayload) as Promise<CredentialCaptureReply<null>>,
  vaultList: (spaceId: string) => ipcRenderer.invoke(IPC.vaultList, spaceId) as Promise<VaultEntryInfo[]>,
  vaultReveal: (spaceId: string, entryId: string) =>
    ipcRenderer.invoke(IPC.vaultReveal, spaceId, entryId) as Promise<Record<string, string>>,
  vaultSave: (spaceId: string, entryId: string | null, draft: VaultEntryDraft) =>
    ipcRenderer.invoke(IPC.vaultSave, spaceId, entryId, draft) as Promise<VaultEntryInfo>,
  vaultDelete: (spaceId: string, entryId: string) =>
    ipcRenderer.invoke(IPC.vaultDelete, spaceId, entryId) as Promise<void>,
  // ── Integrations (D29) ──────────────────────────────────────────────
  integrationProviders: () => ipcRenderer.invoke(IPC.integrationProviders) as Promise<IntegrationProviderInfo[]>,
  integrationList: (spaceId: string) => ipcRenderer.invoke(IPC.integrationList, spaceId) as Promise<IntegrationConnectionInfo[]>,
  integrationConnect: (spaceId: string, provider: IntegrationProvider, access: IntegrationAccess) =>
    ipcRenderer.invoke(IPC.integrationConnect, spaceId, provider, access) as Promise<IntegrationConnectionInfo>,
  integrationSetAccess: (spaceId: string, connectionId: string, access: IntegrationAccess) =>
    ipcRenderer.invoke(IPC.integrationSetAccess, spaceId, connectionId, access) as Promise<IntegrationConnectionInfo>,
  integrationDisconnect: (spaceId: string, connectionId: string) =>
    ipcRenderer.invoke(IPC.integrationDisconnect, spaceId, connectionId) as Promise<void>,
  integrationCalendarEvents: (spaceId: string, from: string, to: string) =>
    ipcRenderer.invoke(IPC.integrationCalendarEvents, spaceId, from, to) as Promise<CalendarAgenda>,
  reports: (request) => ipcRenderer.invoke(IPC.reports, request) as Promise<ReportResponse>,
  notes: (request) => ipcRenderer.invoke(IPC.notes, request) as Promise<NoteResponse>,
  onNotes(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: NoteSnapshot,
    ): void => listener(snapshot);
    ipcRenderer.on(IPC.notesChanged, handler);
    return () => ipcRenderer.removeListener(IPC.notesChanged, handler);
  },
  setTabTitle: (tabId: string, title: string) =>
    ipcRenderer.invoke(IPC.setTabTitle, tabId, title) as Promise<void>,
};

contextBridge.exposeInMainWorld("pistachio", api);
