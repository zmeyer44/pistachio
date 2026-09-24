/**
 * An in-memory host for the shell (docs/web-browser-design.md §3.2), for the
 * landing page's hero.
 *
 * The desktop mounts `@pistachio/shell-ui` over Electron main; the web app
 * mounts it over a socket to a cloud worker. This mounts the same tree over
 * nothing at all: a `ShellApi` whose tabs, shelf, splits and settings are
 * plain objects in this page, so a visitor can click tabs, open favorites,
 * type an address, split a pane and open the console with no account, no
 * worker and no network. Pages are painted by the catalog (./catalog.ts).
 *
 * What it answers, it answers for real — the shelf goes through the same
 * `SidebarController` the desktop and the cloud host use, so a favorite
 * behaves exactly as it does in the app. What it cannot answer (sync, vault,
 * memory, an agent that acts) it refuses the way the cloud host does: with an
 * `unsupported` reply the shell renders as an unavailable affordance and a
 * sentence, never as a dead button or a crash (W12).
 */

import type { AgentToolCall, RunSummary, ThreadListItem } from "@pistachio/protocol";
import type { BrowserMediaInfo, MediaControl, MediaPlaybackKind, ReadAloudStatus } from "@pistachio/shell-contracts/media";
import type { BookmarkSnapshot } from "@pistachio/shell-contracts/bookmarks";
import { HOME_PAGE_FAVICON, HOME_PAGE_TITLE, HOME_PAGE_URL, isHomeUrl } from "@pistachio/shell-contracts/home";
import { BRIEF_PAGE_FAVICON, isShellPageUrl } from "@pistachio/shell-contracts/shell-pages";
import { BRIEF_PAGE_TITLE } from "@pistachio/shell-contracts/reports";
import type {
  AccountState,
  AppInfo,
  BrowserTabInfo,
  CalendarAgenda,
  CommandPaletteSnapshot,
  ContentBounds,
  GlanceState,
  RecentlyClosedTabInfo,
  ShellGlanceOpenRequest,
  ShellApi,
  ShellRunSnapshot,
  ShellSnapshot,
  ShellTabsSnapshot,
  SpaceInfo,
  SplitGroupInfo,
  SplitMode,
  SplitSide,
} from "@pistachio/shell-contracts/ipc";
import { SHELL_EVENT_CHANNELS, SHELL_METHOD_NAMES } from "@pistachio/shell-contracts/ipc";
import {
  BROWSER_PERMISSIONS,
  CLOSED_FIND,
  GUARDED_BROWSER_ACTIONS,
  browserOrigin,
  isSecureBrowserUrl,
  type ActionDecision,
  type BrowserControlsSnapshot,
  type BrowserPermission,
  type BrowserPolicyVerdict,
  type GuardedBrowserAction,
  type PermissionDecision,
} from "@pistachio/shell-contracts/browser-controls";
import { applySettingsPatch, DEFAULT_SETTINGS, type DesktopSettings, type SettingsPatch } from "@pistachio/shell-contracts/settings";
import { isSidebarCommand, type SidebarCommand, type SidebarState } from "@pistachio/shell-contracts/sidebar";
import { SidebarController, type SidebarTabHost } from "@pistachio/shell-contracts/sidebar-controller";
import { SHELL_REPLY_CODE } from "@pistachio/shell-contracts/socket";
import { gridLayoutForSide, MAX_SPLIT_PANES, orientationForSide, splitGroupInfo } from "@pistachio/shell-contracts/split";
import { normalizeNavigation } from "@pistachio/shell-contracts/url";
import { ARTICLE, ARTICLE_READER_URL, catalogSite, describeUrl, READ_ALOUD_URL, YOUTUBE_WATCH_URL } from "./catalog";

/* ------------------------------- refusals -------------------------------- */

const PREVIEW =
  "This is a preview of Pistachio running in your browser. Download the Mac app to use this.";

/**
 * The members this host does not answer, each with the sentence the shell
 * shows in place of the control (W12). Anything listed neither here nor as a
 * real member below is refused with the generic sentence.
 */
const REASONS: Partial<Record<keyof ShellApi, string>> = {
  startCloudRun: PREVIEW,
  openLiveView: "The pane you are looking at is the live view in this preview.",
  forkSpace: PREVIEW,
  submitFeedback: "Write to us from the site instead — this preview has no mailbox.",
  bookmarkTab: PREVIEW,
  addBookmark: PREVIEW,
  watchtower: "Watchtower stores browsing memories on your Mac. It has nothing to search in a preview.",
  tabGroupCommand: "Tab groups are kept by the app. Download Pistachio to group tabs.",
  tabArchive: "The tab archive is kept by the app.",
  tidy: "Tidy runs in the app.",
  reports: "The daily brief is built by the app from what you actually read.",
  getAiUsage: "The model meter belongs to an account; this preview has none.",
  vaultList: "Passwords live in the app's vault, sealed to your Mac.",
  integrationProviders: "Integrations are connected from the app's settings.",
  integrationList: "Integrations are connected from the app's settings.",
  listDevices: "Devices are managed from the app's settings.",
  getSyncStatus: "Sync runs between your devices; a preview has none.",
  getWorkspaceSync: "Sync runs between your devices; a preview has none.",
  getEgressStatus: "Identity egress is set up in the app.",
  getCloudStatus: "The cloud browser is turned on from the app.",
  listChannels: "Channels are created from the app.",
  getIMessageLink: "iMessage is linked from the app.",
  readAloudText: "Read aloud in this preview reads the demo article; select text in the Mac app.",
  getMemory: "Memory is what the app learns from your own errands; a preview has none yet.",
  getReminders: "Reminders are scheduled in the app.",
  clearBrowsingData: "There is no site data in a preview.",
  transcribeSpeech: PREVIEW,
  extractOnboardingIntake: PREVIEW,
  completeOnboarding: PREVIEW,
  signUp: "Sign up from the site — the preview keeps no account.",
  signIn: "Sign in from the site — the preview keeps no account.",
  enroll: PREVIEW,
  signOut: PREVIEW,
  changePassword: PREVIEW,
  recoveryCode: PREVIEW,
};

/** A refusal tagged the way the shell socket tags one, so the store files it under `unavailable`. */
function unsupported(member: keyof ShellApi): Error {
  const error = new Error(REASONS[member] ?? PREVIEW);
  (error as unknown as Record<symbol, unknown>)[SHELL_REPLY_CODE] = "unsupported";
  return error;
}

/* -------------------------------- events --------------------------------- */

class Emitter<T> {
  readonly #listeners = new Set<(value: T) => void>();
  on(listener: (value: T) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  emit(value: T): void {
    for (const listener of [...this.#listeners]) listener(value);
  }
}

/* --------------------------------- seeds --------------------------------- */

const SPACE_ID = "space-preview";

const SPACE: SpaceInfo = {
  id: SPACE_ID,
  name: "Personal",
  color: "#52a862",
  parentSpaceId: null,
  purpose: "",
  createdAt: 0,
  carriedOrigins: [],
  egressPolicy: "direct",
  cloudEnabled: false,
};

/** The chrome as the demo wears it: light, no walkthrough, the console shut. */
export const DEMO_SETTINGS: DesktopSettings = applySettingsPatch(DEFAULT_SETTINGS, {
  appearance: { scheme: "light", desktopGlass: false, surfaceOpacity: 0.72 },
  onboarding: { completed: true, completedAt: new Date(0).toISOString() },
  general: { consoleOpenOnLaunch: false },
  search: { smartSuggestions: false },
});

/** Which catalog sites are favorites, and which are open when the page loads. */
export interface DemoSeed {
  /** Catalog URLs, in grid order. */
  favorites: string[];
  /** Addresses of the open tabs, in strip order; the last is active unless `active` says otherwise. */
  tabs: string[];
  /** Index into `tabs` of the tab in front. */
  active?: number;
}

/** Something playing in a tab, as a scene starts it (see `DemoShellHost.play`). */
export interface DemoMedia {
  title: string;
  artist?: string;
  kind?: MediaPlaybackKind;
  hasVideo: boolean;
  duration: number;
  position?: number;
  artworkUrl?: string | null;
  /** A "Read aloud" clip: whether it lights the words on its page. */
  followText?: "on" | "off" | null;
}

/**
 * A scripted agent turn, for the feature tour: what the console shows the
 * agent saying and doing, and where the person's tab goes as it works. Only
 * the tour's own request runs one — anything a visitor types gets the
 * preview's honest answer.
 */
export type AgentStep =
  | { say: string; wait?: number }
  | { tool: AgentToolCall["name"]; label: string; detail: string; ms: number; navigate?: string; wait?: number }
  | { notes: string };

export interface AgentScript {
  intent: string;
  steps: AgentStep[];
}

export const DEFAULT_SEED: DemoSeed = {
  favorites: [
    "https://x.com/home",
    "https://www.youtube.com/",
    "https://www.google.com/",
    "https://calendar.google.com/calendar/u/0/r/week",
    "https://chatgpt.com/",
    "https://claude.ai/new",
  ],
  tabs: [
    "https://en.wikipedia.org/wiki/Pistachio",
    "https://github.com/",
    YOUTUBE_WATCH_URL,
    HOME_PAGE_URL,
  ],
};

/* ---------------------------------- tabs --------------------------------- */

interface DemoTab extends BrowserTabInfo {
  history: string[];
  historyIndex: number;
}

const MAX_RECENTLY_CLOSED = 25;
/** How long a fake page "loads": long enough for the spinner to read as one. */
const LOAD_MS = 320;

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * An address as a browser would show it after loading: `https://a.b` becomes
 * `https://a.b/`, and a host the real site redirects — `youtube.com` to
 * `www.youtube.com`, `twitter.com` to `x.com` — lands where the site lands.
 */
function canonical(url: string): string {
  try {
    if (!/^https?:/iu.test(url)) return url;
    const parsed = new URL(url);
    const site = catalogSite(url);
    if (site !== null) parsed.hostname = new URL(site.url).hostname;
    return parsed.toString();
  } catch {
    return url;
  }
}

/** The app's own pages the demo paints (reader view, a read-aloud clip): addresses taken as they are. */
function isDemoPage(url: string): boolean {
  return url === ARTICLE_READER_URL || url === READ_ALOUD_URL;
}

/** The short name a favorite tile wears: "Home / X" → "X", "Google Calendar - Week" → "Google Calendar". */
function favoriteTitle(title: string): string {
  const parts = title.split(/\s+[-–/]\s+/u).map((part) => part.trim());
  return parts.length > 1 && /^home$/iu.test(parts[0] ?? "") ? (parts[1] ?? title) : (parts[0] ?? title);
}

function titleFor(url: string): { title: string; faviconUrl: string } {
  if (isHomeUrl(url)) return { title: HOME_PAGE_TITLE, faviconUrl: HOME_PAGE_FAVICON };
  if (isShellPageUrl(url)) return { title: BRIEF_PAGE_TITLE, faviconUrl: BRIEF_PAGE_FAVICON };
  const site = describeUrl(url);
  return { title: site.title, faviconUrl: site.faviconUrl };
}

/** A thread that has not asked a model anything yet. */
const EMPTY_CONTEXT: RunSummary["context"] = {
  tokens: null,
  compactAt: 120_000,
  window: 200_000,
  compactions: 0,
  steps: 0,
  totalSteps: 0,
  usage: { inputTokens: 0, outputTokens: 0 },
};

/** Where a player's playhead is now, from where it was when last reported. */
function projected(media: BrowserMediaInfo, now: number): number {
  const elapsed = media.playing ? ((now - media.updatedAt) / 1_000) * media.playbackRate : 0;
  return Math.min(media.duration ?? Number.POSITIVE_INFINITY, media.position + elapsed);
}

/* ---------------------------------- host --------------------------------- */

export class DemoShellHost {
  readonly #tabs = new Map<string, DemoTab>();
  #order: string[] = [];
  #activeTabId: string | null = null;
  #closed: RecentlyClosedTabInfo[] = [];
  readonly #splitGroups = new Map<string, SplitGroupInfo>();
  #shelf: SidebarState = { favorites: [], entries: [] };
  #settings: DesktopSettings = DEMO_SETTINGS;
  #run: RunSummary | null = null;
  #threads: ThreadListItem[] = [];
  readonly #sidebar: SidebarController;
  readonly #loads = new Map<string, ReturnType<typeof setTimeout>>();
  /** Every other pending timer (agent steps, glance loads, read-aloud jobs): cleared by `reset`. */
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #glance: GlanceState | null = null;
  #media: BrowserMediaInfo[] = [];
  #readAloud: ReadAloudStatus[] = [];
  #script: AgentScript | null = null;

  readonly #snapshotEvents = new Emitter<ShellTabsSnapshot>();
  readonly #runEvents = new Emitter<ShellRunSnapshot>();
  readonly #settingsEvents = new Emitter<DesktopSettings>();
  readonly #controlsEvents = new Emitter<BrowserControlsSnapshot>();
  readonly #glanceEvents = new Emitter<GlanceState | null>();
  readonly #mediaEvents = new Emitter<BrowserMediaInfo[]>();
  readonly #readAloudEvents = new Emitter<ReadAloudStatus[]>();
  #flushScheduled = false;

  constructor(seed: DemoSeed = DEFAULT_SEED) {
    /** The shelf's view of the tabs — the nine members the controller needs. */
    const browser: SidebarTabHost = {
      activeSpaceId: () => SPACE_ID,
      tabs: () => this.#orderedTabs(),
      tab: (tabId) => this.#tabs.get(tabId) ?? null,
      tabForAnchor: (anchorId) => this.#orderedTabs().find((tab) => tab.anchorId === anchorId) ?? null,
      setAnchor: (tabId, anchorId) => {
        const tab = this.#tabs.get(tabId);
        if (tab !== undefined) tab.anchorId = anchorId;
      },
      reorderTab: (tabId, index) => this.#place(tabId, index),
      selectTab: (tabId) => this.selectTab(tabId),
      createTab: (url, options) => Promise.resolve(this.#createTab(url, options ?? {})),
      navigate: (tabId, url) => this.navigate(tabId, url),
      anchorLeavesOnSplit: () => false,
    };
    this.#sidebar = new SidebarController({
      store: { get: () => this.#shelf, set: (_spaceId, state) => void (this.#shelf = state) },
      browser,
      settings: () => this.#settings,
      // A stream surface's rule: there is no native tile to stop following.
      anchorLeavesOnSplit: () => false,
    });

    this.#seed(seed);
  }

  #seed(seed: DemoSeed): void {
    const favorites = seed.favorites.map((url) => {
      const site = describeUrl(url);
      return { id: newId("fav"), url, title: favoriteTitle(site.title), faviconUrl: site.faviconUrl };
    });
    this.#shelf = { favorites, entries: [] };
    const ids = seed.tabs.map((url) => {
      const favorite = favorites.find((entry) => entry.url === url);
      return this.#createTab(url, { anchorId: favorite?.id ?? null, activate: true });
    });
    const active = seed.active === undefined ? undefined : ids[seed.active];
    if (active !== undefined) this.#activeTabId = active;
  }

  /* ------------------------------ the tour -------------------------------- */

  /**
   * Start over from a seed: every tab, split, Glance, player and thread goes,
   * and every pending timer with them. The feature tour calls this at the top
   * of each scene so a scene always opens on the same window.
   */
  reset(seed: DemoSeed = DEFAULT_SEED): void {
    for (const timer of this.#loads.values()) clearTimeout(timer);
    this.#loads.clear();
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#tabs.clear();
    this.#order = [];
    this.#activeTabId = null;
    this.#closed = [];
    this.#splitGroups.clear();
    this.#run = null;
    this.#threads = [];
    this.#script = null;
    this.#seed(seed);
    this.#publish();
    this.#publishRun();
    this.#setGlance(null);
    this.#setMedia([]);
    this.#setReadAloud([]);
  }

  /** The tabs in strip order, for the tour to find the one it means. */
  tabs(): BrowserTabInfo[] {
    return this.#tabInfos();
  }

  activeTabId(): string | null {
    return this.#activeTabId;
  }

  /** Where the open thread stands, for the tour to wait on. */
  runStatus(): RunSummary["status"] | null {
    return this.#run?.status ?? null;
  }

  /** The request the tour's agent answers with a scripted turn. */
  scriptAgent(script: AgentScript | null): void {
    this.#script = script;
  }

  #later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      fn();
    }, ms);
    this.#timers.add(timer);
  }

  /* ------------------------------ publishing ------------------------------ */

  /** One coalesced snapshot per tick, as main and the cloud host publish. */
  #publish(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      const { run: _run, threads: _threads, ...tabs } = this.#snapshot();
      this.#snapshotEvents.emit(tabs);
      this.#controlsEvents.emit(this.#controls());
    });
  }

  #publishRun(): void {
    this.#runEvents.emit({ run: this.#run, threads: this.#threads });
  }

  #orderedTabs(): DemoTab[] {
    return this.#order.map((id) => this.#tabs.get(id)).filter((tab): tab is DemoTab => tab !== undefined);
  }

  #tabInfos(): BrowserTabInfo[] {
    return this.#orderedTabs().map(({ history: _h, historyIndex: _i, ...info }) => ({ ...info }));
  }

  #groupFor(tabId: string): SplitGroupInfo | undefined {
    for (const group of this.#splitGroups.values()) if (group.tabIds.includes(tabId)) return group;
    return undefined;
  }

  #visibleTabIds(): string[] {
    if (this.#activeTabId === null) return [];
    const group = this.#groupFor(this.#activeTabId);
    return group === undefined ? [this.#activeTabId] : [...group.tabIds];
  }

  #snapshot(): ShellSnapshot {
    const visible = this.#visibleTabIds();
    const activeTabId = this.#activeTabId;
    const group = activeTabId === null ? undefined : this.#groupFor(activeTabId);
    return {
      spaces: [SPACE],
      activeSpaceId: SPACE_ID,
      tabs: this.#tabInfos(),
      activeTabId,
      visibleTabIds: visible,
      wakingTabIds: [],
      secondaryTabId: visible.find((id) => id !== activeTabId) ?? null,
      splitMode: group?.mode ?? "single",
      splitGroups: [...this.#splitGroups.values()],
      tabGroups: [],
      run: this.#run,
      threads: this.#threads,
      sidebar: this.#shelf,
    };
  }

  /** Every permission "ask", every guarded action allowed: a page with nothing behind it hides nothing. */
  #controls(): BrowserControlsSnapshot {
    const tab = this.#activeTabId === null ? undefined : this.#tabs.get(this.#activeTabId);
    const url = tab?.url ?? "";
    return {
      tabId: tab?.id ?? null,
      tabKind: tab?.kind ?? null,
      origin: url === "" ? "" : browserOrigin(url),
      secure: url !== "" && isSecureBrowserUrl(url),
      zoomPercent: 100,
      muted: false,
      permissions: Object.fromEntries(
        BROWSER_PERMISSIONS.map((permission) => [permission, { decision: "ask", source: "default", reason: "Sites ask the first time." }]),
      ) as Record<BrowserPermission, BrowserPolicyVerdict<PermissionDecision>>,
      externalAppSchemes: [],
      actions: Object.fromEntries(
        GUARDED_BROWSER_ACTIONS.map((action) => [action, { decision: "allow", source: "default", reason: "Allowed by default." }]),
      ) as Record<GuardedBrowserAction, BrowserPolicyVerdict<ActionDecision>>,
      passkeys: { webAuthnAvailable: false, platformAuthenticatorAvailable: false, conditionalMediationAvailable: false, touchIdConfigured: false },
      pendingPermissions: [],
      pendingPasskeyRequests: [],
      downloads: [],
      recentEvents: [],
    };
  }

  /* ----------------------------- tab plumbing ----------------------------- */

  #createTab(url: string | undefined, options: { anchorId?: string | null; activate?: boolean }): string {
    const target =
      url === undefined || url.trim() === ""
        ? HOME_PAGE_URL
        : isDemoPage(url)
          ? url
          : canonical(normalizeNavigation(url, this.#settings.search.webProvider));
    const id = newId("tab");
    const { title, faviconUrl } = titleFor(target);
    const tab: DemoTab = {
      id,
      spaceId: SPACE_ID,
      title,
      url: target,
      faviconUrl,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      kind: "human",
      runId: null,
      lifecycle: "live",
      lastActiveAt: Date.now(),
      unlisted: false,
      anchorId: options.anchorId ?? null,
      history: [target],
      historyIndex: 0,
    };
    this.#tabs.set(id, tab);
    this.#order.push(id);
    if (options.activate !== false) {
      this.#activeTabId = id;
    }
    this.#publish();
    return id;
  }

  #place(tabId: string, index: number): void {
    if (!this.#tabs.has(tabId)) return;
    const rest = this.#order.filter((id) => id !== tabId);
    const at = Math.min(Math.max(Math.trunc(index), 0), rest.length);
    this.#order = [...rest.slice(0, at), tabId, ...rest.slice(at)];
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

  #forget(tab: DemoTab): void {
    const pending = this.#loads.get(tab.id);
    if (pending !== undefined) clearTimeout(pending);
    this.#loads.delete(tab.id);
    this.#detachFromGroup(tab.id);
    if (this.#media.some((item) => item.tabId === tab.id)) this.#setMedia(this.#media.filter((item) => item.tabId !== tab.id));
    const index = this.#order.indexOf(tab.id);
    this.#tabs.delete(tab.id);
    this.#order = this.#order.filter((id) => id !== tab.id);
    if (this.#activeTabId === tab.id) {
      // The neighbour on the right, else the left, else nothing — the strip's own rule.
      const next = this.#order[index] ?? this.#order[index - 1] ?? null;
      this.#activeTabId = next;
      if (next !== null) {
        const tabNext = this.#tabs.get(next);
        if (tabNext !== undefined) tabNext.lastActiveAt = Date.now();
      }
    }
  }

  /** Land a tab on an address: the title and icon at once, the spinner for a moment. */
  #land(tab: DemoTab, url: string): void {
    const { title, faviconUrl } = titleFor(url);
    tab.url = url;
    tab.title = title;
    tab.faviconUrl = faviconUrl;
    tab.canGoBack = tab.historyIndex > 0;
    tab.canGoForward = tab.historyIndex < tab.history.length - 1;
    tab.loading = !isShellPageUrl(url);
    const pending = this.#loads.get(tab.id);
    if (pending !== undefined) clearTimeout(pending);
    if (tab.loading) {
      this.#loads.set(
        tab.id,
        setTimeout(() => {
          this.#loads.delete(tab.id);
          tab.loading = false;
          this.#publish();
        }, LOAD_MS),
      );
    }
    this.#publish();
  }

  /* --------------------------------- api ---------------------------------- */

  async getSnapshot(): Promise<ShellSnapshot> {
    return this.#snapshot();
  }

  onSnapshot(listener: (snapshot: ShellTabsSnapshot) => void): () => void {
    return this.#snapshotEvents.on(listener);
  }

  onRun(listener: (run: ShellRunSnapshot) => void): () => void {
    return this.#runEvents.on(listener);
  }

  async getCommandPalette(): Promise<CommandPaletteSnapshot> {
    return { tabs: this.#tabInfos(), recentlyClosedTabs: [...this.#closed], clipboardUrl: null };
  }

  async rankAddressIntent(): Promise<null> {
    return null;
  }

  async switchSpace(): Promise<void> {
    // One Space: there is nowhere to switch to.
  }

  async createTab(url?: string): Promise<void> {
    const general = this.#settings.general;
    const target = url ?? (general.newTab === "url" && general.newTabUrl !== "" ? general.newTabUrl : general.homeUrl);
    this.#createTab(target, {});
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) return;
    this.#closed = [
      { spaceId: SPACE_ID, title: tab.title, url: tab.url, faviconUrl: tab.faviconUrl, anchorId: tab.anchorId, closedAt: Date.now() },
      ...this.#closed,
    ].slice(0, MAX_RECENTLY_CLOSED);
    this.#forget(tab);
    this.#publish();
  }

  async selectTab(tabId: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) return;
    this.#activeTabId = tabId;
    tab.lastActiveAt = Date.now();
    this.#publish();
  }

  async setForcedFocus(): Promise<void> {
    // A fake page has no focus to force; the demo never offers it.
  }

  async suspendTab(): Promise<void> {
    // A fake page costs nothing to keep.
  }

  async navigate(tabId: string, url: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) return;
    const target = isDemoPage(url) ? url : canonical(normalizeNavigation(url, this.#settings.search.webProvider));
    tab.history = [...tab.history.slice(0, tab.historyIndex + 1), target];
    tab.historyIndex = tab.history.length - 1;
    this.#land(tab, target);
  }

  async goBack(tabId: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined || tab.historyIndex === 0) return;
    tab.historyIndex -= 1;
    this.#land(tab, tab.history[tab.historyIndex]!);
  }

  async goForward(tabId: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined || tab.historyIndex >= tab.history.length - 1) return;
    tab.historyIndex += 1;
    this.#land(tab, tab.history[tab.historyIndex]!);
  }

  async reload(tabId: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) return;
    this.#land(tab, tab.url);
  }

  async reorderTab(tabId: string, index: number): Promise<void> {
    this.#place(tabId, index);
    this.#publish();
  }

  async duplicateTab(tabId: string): Promise<string> {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) throw new Error(`unknown tab ${tabId}`);
    const created = this.#createTab(tab.url, { anchorId: null });
    this.#place(created, this.#order.indexOf(tabId) + 1);
    this.#publish();
    return created;
  }

  async moveTabToSpace(): Promise<void> {
    // One Space.
  }

  async restoreClosedTab(): Promise<void> {
    const [newest, ...rest] = this.#closed;
    if (newest === undefined) return;
    this.#closed = rest;
    this.#createTab(newest.url, { anchorId: newest.anchorId });
  }

  async clearUnpinnedTabs(): Promise<void> {
    for (const tab of this.#orderedTabs()) {
      if (tab.anchorId === null) this.#forget(tab);
    }
    this.#publish();
  }

  /* ------------------------------- splits --------------------------------- */

  async setSplit(mode: SplitMode): Promise<void> {
    const activeTabId = this.#activeTabId;
    if (activeTabId === null) return;
    const current = this.#groupFor(activeTabId);
    if (mode === "single") {
      if (current !== undefined) this.#splitGroups.delete(current.id);
      this.#publish();
      return;
    }
    if (current !== undefined) {
      this.#splitGroups.set(current.id, splitGroupInfo(current.id, current.tabIds, mode, current.gridLayout));
      this.#publish();
      return;
    }
    const partner = this.#orderedTabs().find((tab) => tab.id !== activeTabId && this.#groupFor(tab.id) === undefined);
    if (partner === undefined) return;
    const id = newId("split");
    this.#splitGroups.set(id, splitGroupInfo(id, [activeTabId, partner.id], mode));
    this.#publish();
  }

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
    const id = group?.id ?? newId("split");
    this.#splitGroups.set(id, splitGroupInfo(id, tabIds, mode, gridLayout));
    this.#publish();
  }

  async removeFromSplit(tabId: string): Promise<void> {
    this.#detachFromGroup(tabId);
    this.#publish();
  }

  /* -------------------------------- shelf --------------------------------- */

  async sidebarCommand(command: SidebarCommand): Promise<void> {
    if (!isSidebarCommand(command)) throw new Error("not a sidebar command");
    await this.#sidebar.run(command);
    this.#publish();
  }

  /* ------------------------------- settings ------------------------------- */

  async getSettings(): Promise<DesktopSettings> {
    return this.#settings;
  }

  async updateSettings(patch: SettingsPatch): Promise<DesktopSettings> {
    this.#settings = applySettingsPatch(this.#settings, patch);
    this.#settingsEvents.emit(this.#settings);
    return this.#settings;
  }

  async resetSettings(): Promise<DesktopSettings> {
    this.#settings = DEMO_SETTINGS;
    this.#settingsEvents.emit(this.#settings);
    return this.#settings;
  }

  onSettings(listener: (settings: DesktopSettings) => void): () => void {
    return this.#settingsEvents.on(listener);
  }

  /* ------------------------------ site state ------------------------------ */

  async getBrowserControls(): Promise<BrowserControlsSnapshot> {
    return this.#controls();
  }

  onBrowserControlsChanged(listener: (snapshot: BrowserControlsSnapshot) => void): () => void {
    return this.#controlsEvents.on(listener);
  }

  async browserControl(): Promise<void> {
    // Nothing to decide: the fake pages ask for nothing.
  }

  async getFindState() {
    return CLOSED_FIND;
  }

  async find(): Promise<void> {
    // The fake pages have no text index; the field opens and finds nothing.
  }

  async getDownloads() {
    return [];
  }

  /* -------------------------------- media --------------------------------- */

  #setMedia(media: BrowserMediaInfo[]): void {
    this.#media = media;
    this.#mediaEvents.emit(media.map((item) => ({ ...item })));
  }

  #updateMedia(tabId: string, patch: (item: BrowserMediaInfo, now: number) => Partial<BrowserMediaInfo>): void {
    const now = Date.now();
    this.#setMedia(this.#media.map((item) => (item.tabId === tabId ? { ...item, position: projected(item, now), updatedAt: now, ...patch(item, now) } : item)));
  }

  /** Something starts playing in a tab — the tour's video, or a read-aloud clip. */
  play(tabId: string, media: DemoMedia): void {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) return;
    const now = Date.now();
    const info: BrowserMediaInfo = {
      tabId,
      tabTitle: tab.title,
      tabUrl: tab.url,
      faviconUrl: tab.faviconUrl,
      title: media.title,
      artist: media.artist ?? "",
      album: "",
      artworkUrl: media.artworkUrl ?? null,
      kind: media.kind ?? (media.hasVideo ? "video" : "audio"),
      hasVideo: media.hasVideo,
      playing: true,
      elementMuted: false,
      muted: false,
      audible: true,
      position: media.position ?? 0,
      duration: media.duration,
      playbackRate: 1,
      seekable: true,
      canPrevious: false,
      canNext: false,
      canPictureInPicture: media.hasVideo,
      canSetRate: true,
      presenting: false,
      stream: false,
      updatedAt: now,
      lastActiveAt: now,
      followText: media.followText ?? null,
      call: false,
    };
    this.#setMedia([...this.#media.filter((item) => item.tabId !== tabId), info]);
  }

  async getMedia(): Promise<BrowserMediaInfo[]> {
    return this.#media.map((item) => ({ ...item }));
  }

  onMediaChanged(listener: (media: BrowserMediaInfo[]) => void): () => void {
    return this.#mediaEvents.on(listener);
  }

  async controlMedia(tabId: string, control: MediaControl): Promise<void> {
    switch (control.type) {
      case "playPause":
        this.#updateMedia(tabId, (item, now) => ({ playing: !item.playing, audible: !item.playing && !item.muted, ...(item.playing ? {} : { lastActiveAt: now }) }));
        return;
      case "pause":
        this.#updateMedia(tabId, () => ({ playing: false, audible: false }));
        return;
      case "seek":
        this.#updateMedia(tabId, () => ({ position: control.position }));
        return;
      case "previous":
        this.#updateMedia(tabId, () => ({ position: 0 }));
        return;
      case "setRate":
        this.#updateMedia(tabId, () => ({ playbackRate: control.rate }));
        return;
      case "mute":
        this.#updateMedia(tabId, (item) => ({ muted: !item.muted, elementMuted: !item.muted, audible: item.playing && item.muted }));
        return;
      case "followText":
        this.#updateMedia(tabId, () => ({ followText: control.enabled ? "on" : "off" }));
        return;
      case "dismiss":
        this.#setMedia(this.#media.filter((item) => item.tabId !== tabId));
        return;
      case "focus":
        await this.selectTab(tabId);
        return;
      default:
        return;
    }
  }

  /* ------------------------------ read aloud ------------------------------ */

  #setReadAloud(jobs: ReadAloudStatus[]): void {
    this.#readAloud = jobs;
    this.#readAloudEvents.emit([...jobs]);
  }

  async getReadAloud(): Promise<ReadAloudStatus[]> {
    return [...this.#readAloud];
  }

  onReadAloudChanged(listener: (jobs: ReadAloudStatus[]) => void): () => void {
    return this.#readAloudEvents.on(listener);
  }

  async cancelReadAloud(id: string): Promise<void> {
    this.#setReadAloud(this.#readAloud.filter((job) => job.id !== id));
  }

  /**
   * "Listen to article" on the reader page: a toast while the clip is made,
   * then the clip's own tab, playing, which the sidebar carries as a card.
   */
  readArticleAloud(): void {
    const id = newId("read");
    this.#setReadAloud([
      ...this.#readAloud,
      { id, phase: "generating", sourceTitle: ARTICLE.title, excerpt: ARTICLE.lead.slice(0, 80), startedAt: Date.now(), message: null },
    ]);
    this.#later(() => {
      if (!this.#readAloud.some((job) => job.id === id)) return;
      this.#setReadAloud(this.#readAloud.filter((job) => job.id !== id));
      const source = this.#activeTabId;
      const clip = this.#orderedTabs().find((tab) => tab.url === READ_ALOUD_URL)?.id ?? this.#createTab(READ_ALOUD_URL, { activate: false });
      if (source !== null) this.#place(clip, this.#order.indexOf(source) + 1);
      this.#publish();
      this.play(clip, { title: ARTICLE.title, hasVideo: false, duration: ARTICLE.minutes * 60 + 12, followText: "off" });
    }, 2_200);
  }

  /* ------------------------------ reader view ----------------------------- */

  /** The demo article has a reader view; nothing else here has an article to read. */
  async toggleReaderView(tabId?: string): Promise<boolean> {
    const tab = this.#tabs.get(tabId ?? this.#activeTabId ?? "");
    if (tab === undefined) return false;
    if (tab.url === ARTICLE_READER_URL) {
      if (tab.history[tab.historyIndex - 1] === ARTICLE.url) await this.goBack(tab.id);
      else await this.navigate(tab.id, ARTICLE.url);
      return true;
    }
    if (tab.url !== ARTICLE.url) return false;
    await this.navigate(tab.id, ARTICLE_READER_URL);
    return true;
  }

  /* -------------------------------- glance -------------------------------- */

  #setGlance(glance: GlanceState | null): void {
    this.#glance = glance;
    this.#glanceEvents.emit(glance === null ? null : { ...glance, tab: { ...glance.tab } });
  }

  /** A link Glanced from the active page: `source` is the link's box, where the card grows from. */
  glance(url: string, source: ContentBounds): boolean {
    const owner = this.#activeTabId;
    if (owner === null) return false;
    const target = canonical(normalizeNavigation(url, this.#settings.search.webProvider));
    const { title, faviconUrl } = titleFor(target);
    const tab: BrowserTabInfo = {
      id: newId("glance"),
      spaceId: SPACE_ID,
      title,
      url: target,
      faviconUrl,
      loading: true,
      canGoBack: false,
      canGoForward: false,
      kind: "human",
      runId: null,
      lifecycle: "live",
      lastActiveAt: Date.now(),
      unlisted: false,
      anchorId: null,
    };
    this.#setGlance({ tab, ownerTabId: owner, source, backgroundStills: [] });
    this.#later(() => {
      if (this.#glance?.tab.id !== tab.id) return;
      this.#setGlance({ ...this.#glance, tab: { ...this.#glance.tab, loading: false } });
    }, LOAD_MS);
    return true;
  }

  async getGlance(): Promise<GlanceState | null> {
    return this.#glance;
  }

  onGlanceChanged(listener: (glance: GlanceState | null) => void): () => void {
    return this.#glanceEvents.on(listener);
  }

  async openGlance(request: ShellGlanceOpenRequest): Promise<boolean> {
    return this.glance(request.url, request.source);
  }

  async closeGlance(): Promise<void> {
    this.#setGlance(null);
  }

  /** The Glance becomes a tab beside its owner, in front. */
  async promoteGlance(): Promise<void> {
    const glance = this.#glance;
    if (glance === null) return;
    const id = this.#createTab(glance.tab.url, {});
    this.#place(id, this.#order.indexOf(glance.ownerTabId) + 1);
    this.#publish();
    // After the snapshot that brings the tab: the card leaves as the page arrives.
    queueMicrotask(() => queueMicrotask(() => this.#setGlance(null)));
  }

  /** The Glance becomes a tab split beside its owner. */
  async splitGlance(): Promise<void> {
    const glance = this.#glance;
    if (glance === null) return;
    const id = this.#createTab(glance.tab.url, { activate: false });
    this.#activeTabId = glance.ownerTabId;
    await this.splitWith(id, "right");
    queueMicrotask(() => queueMicrotask(() => this.#setGlance(null)));
  }

  async getTabSwitcherPreviews() {
    return this.#orderedTabs()
      .slice()
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, 5)
      .map((tab) => ({ tab: { ...tab }, dataUrl: null }));
  }

  async getBookmarks(): Promise<BookmarkSnapshot> {
    return { bookmarks: [] };
  }

  async getBookmarkToast() {
    return null;
  }

  async getEvidence() {
    return [];
  }

  async getAppInfo(): Promise<AppInfo> {
    return { version: "preview", chrome: "", platform: "web" };
  }

  async getUpdateState() {
    return { status: "idle" as const, checkedAt: null };
  }

  async checkForUpdates() {
    return { status: "idle" as const, checkedAt: new Date().toISOString() };
  }

  /** Nobody is signed in to a preview, and it says so rather than refusing. */
  async getAccount(): Promise<AccountState> {
    return {
      state: "unenrolled",
      email: null,
      userId: null,
      deviceId: null,
      deviceName: "This browser",
      controlUrl: "",
      encryptionAvailable: false,
      cloudDevicePin: null,
      revoked: false,
      hubUrl: null,
      cloudBrowserUrl: null,
      error: null,
    };
  }

  async getAiStatus() {
    return { available: false, controlUrl: null };
  }

  /** A calendar with something on it makes the home page's day read as a day. */
  async integrationCalendarEvents(_spaceId: string, from: string): Promise<CalendarAgenda> {
    const day = new Date(from);
    const at = (hours: number, minutes = 0): string => {
      const date = new Date(day);
      date.setHours(hours, minutes, 0, 0);
      return date.toISOString();
    };
    return {
      status: "ok",
      connectable: false,
      accountLabel: "you@hazel.app",
      events: [
        { id: "ev-standup", title: "Team standup", start: at(9, 30), end: at(9, 45), allDay: false, location: "", meetingUrl: "https://cal.hazel.app/meet/standup", webUrl: "https://cal.hazel.app/week" },
        { id: "ev-planning", title: "Q3 planning review", start: at(11), end: at(12), allDay: false, location: "Room 4", meetingUrl: null, webUrl: "https://cal.hazel.app/week" },
        { id: "ev-dentist", title: "Dentist", start: at(15, 30), end: at(16, 15), allDay: false, location: "Mission St", meetingUrl: null, webUrl: "https://cal.hazel.app/week" },
      ],
    };
  }

  /* -------------------------------- console ------------------------------- */

  /**
   * The console answers, so that a visitor who types into it is told what
   * the agent would do and where — not shown an error banner. It never
   * pretends to act: the reply is the same honest sentence every time.
   */
  async startDelegation(intent: string): Promise<void> {
    const now = new Date().toISOString();
    const runId = newId("run");
    const title = intent.trim().slice(0, 60) || "New errand";
    const run: RunSummary = {
      runId,
      taskId: runId,
      status: "running",
      purpose: intent,
      title,
      updatedAt: now,
      turns: 1,
      notes: "",
      context: EMPTY_CONTEXT,
      humanTabId: this.#activeTabId,
      agentTabId: null,
      startedAt: now,
      completedAt: null,
      control: "agent",
      pendingApproval: null,
      pendingQuestion: null,
      pendingTakeover: null,
      messages: [{ id: newId("msg"), at: now, role: "user", content: intent, turn: 1 }],
      toolCalls: [],
      subagents: [],
      activity: [],
      result: null,
    };
    this.#run = run;
    this.#threads = [{ runId, title, status: "running", startedAt: now, updatedAt: now, turns: 1, messageCount: 1 }, ...this.#threads.filter((t) => t.runId !== runId)];
    this.#publishRun();
    const script = this.#script;
    if (script !== null && intent.trim() === script.intent) this.#perform(runId, script.steps);
    else setTimeout(() => this.#reply(runId), 900);
  }

  /** Play a scripted turn into the open thread: each step on its own beat, the person's tab following along. */
  #perform(runId: string, steps: AgentStep[]): void {
    const update = (change: (run: RunSummary) => Partial<RunSummary>) => {
      const run = this.#run;
      if (run === null || run.runId !== runId) return false;
      this.#run = { ...run, ...change(run), updatedAt: new Date().toISOString() };
      this.#publishRun();
      return true;
    };
    let at = 700;
    for (const step of steps) {
      if ("notes" in step) {
        this.#later(() => void update(() => ({ notes: step.notes })), at);
      } else if ("say" in step) {
        this.#later(
          () => void update((run) => ({ messages: [...run.messages, { id: newId("msg"), at: new Date().toISOString(), role: "assistant", content: step.say, turn: run.turns }] })),
          at,
        );
        at += step.wait ?? 900;
      } else {
        const toolId = newId("tool");
        this.#later(
          () =>
            void update((run) => ({
              toolCalls: [
                ...run.toolCalls,
                { id: toolId, name: step.tool, label: step.label, detail: step.detail, status: "running", startedAt: new Date().toISOString(), completedAt: null, tabId: run.humanTabId, turn: run.turns },
              ],
            })),
          at,
        );
        at += step.ms;
        this.#later(() => {
          const run = this.#run;
          if (run === null || run.runId !== runId) return;
          if (step.navigate !== undefined && run.humanTabId !== null) void this.navigate(run.humanTabId, step.navigate);
          update((current) => ({
            toolCalls: current.toolCalls.map((call) => (call.id === toolId ? { ...call, status: "completed", completedAt: new Date().toISOString() } : call)),
          }));
        }, at);
        at += step.wait ?? 250;
      }
    }
    this.#later(() => {
      const now = new Date().toISOString();
      if (!update(() => ({ status: "completed", completedAt: now }))) return;
      this.#threads = this.#threads.map((t) => (t.runId === runId ? { ...t, status: "completed", updatedAt: now, messageCount: this.#run?.messages.length ?? t.messageCount } : t));
      this.#publishRun();
    }, at);
  }

  async sendAgentMessage(content: string): Promise<void> {
    if (this.#run === null) return this.startDelegation(content);
    const now = new Date().toISOString();
    const run = this.#run;
    run.status = "running";
    run.turns += 1;
    run.updatedAt = now;
    run.completedAt = null;
    run.messages = [...run.messages, { id: newId("msg"), at: now, role: "user", content, turn: run.turns }];
    this.#run = { ...run };
    this.#threads = this.#threads.map((t) => (t.runId === run.runId ? { ...t, status: "running", updatedAt: now, turns: run.turns, messageCount: run.messages.length } : t));
    this.#publishRun();
    setTimeout(() => this.#reply(run.runId), 900);
  }

  #reply(runId: string): void {
    const run = this.#run;
    if (run === null || run.runId !== runId) return;
    const now = new Date().toISOString();
    const content =
      "I can look around in this preview, but I can't act on pages here. In the Mac app I'd do this in your own signed-in tabs, pausing before anything that costs money or can't be undone — download Pistachio and ask me again.";
    run.status = "completed";
    run.updatedAt = now;
    run.completedAt = now;
    run.messages = [...run.messages, { id: newId("msg"), at: now, role: "assistant", content, turn: run.turns }];
    this.#run = { ...run };
    this.#threads = this.#threads.map((t) => (t.runId === runId ? { ...t, status: "completed", updatedAt: now, messageCount: run.messages.length } : t));
    this.#publishRun();
  }

  async interruptAgent(): Promise<void> {
    if (this.#run === null) return;
    this.#run = { ...this.#run, status: "interrupted", completedAt: new Date().toISOString() };
    this.#publishRun();
  }

  async answerAgentQuestion(): Promise<void> {}
  async approve(): Promise<void> {}
  async reject(): Promise<void> {}
  async takeControl(): Promise<void> {}
  async releaseControl(): Promise<void> {}

  async revokeRun(): Promise<void> {
    if (this.#run === null) return;
    this.#run = { ...this.#run, status: "revoked", completedAt: new Date().toISOString() };
    this.#publishRun();
  }

  async openThread(runId: string): Promise<void> {
    if (this.#run?.runId === runId) return;
    // Threads other than the open one keep only their list row here.
    const item = this.#threads.find((t) => t.runId === runId);
    if (item === undefined) return;
    this.#run = {
      runId,
      taskId: runId,
      status: item.status,
      purpose: item.title,
      title: item.title,
      updatedAt: item.updatedAt,
      turns: item.turns,
      notes: "",
      context: EMPTY_CONTEXT,
      humanTabId: null,
      agentTabId: null,
      startedAt: item.startedAt,
      completedAt: item.updatedAt,
      control: "agent",
      pendingApproval: null,
      pendingQuestion: null,
      pendingTakeover: null,
      messages: [{ id: newId("msg"), at: item.startedAt, role: "user", content: item.title, turn: 1 }],
      toolCalls: [],
      subagents: [],
      activity: [],
      result: null,
    };
    this.#publishRun();
  }

  async newThread(): Promise<void> {
    this.#run = null;
    this.#publishRun();
  }

  async deleteThread(runId: string): Promise<void> {
    this.#threads = this.#threads.filter((t) => t.runId !== runId);
    if (this.#run?.runId === runId) this.#run = null;
    this.#publishRun();
  }
}

/* -------------------------------- assembly ------------------------------- */

/**
 * The host as a complete `ShellApi`: the real members above, a no-op
 * subscription for every event the host never emits, and a tagged refusal
 * for every method it does not answer. Built from the contract's own lists
 * so a member added to `ShellApi` is refused here rather than missing —
 * the store catches a refusal; a missing member throws.
 */
export function createDemoShellApi(seed?: DemoSeed): { api: ShellApi; host: DemoShellHost } {
  const host = new DemoShellHost(seed);
  const api: Record<string, unknown> = {};
  for (const member of SHELL_METHOD_NAMES) {
    api[member] = () => Promise.reject(unsupported(member));
  }
  for (const { member } of SHELL_EVENT_CHANNELS) {
    api[member] = () => () => {};
  }
  // The one synchronous member: a refusal it cannot report, so it does nothing.
  api["openBookmarksPage"] = () => {};
  const prototype = Object.getPrototypeOf(host) as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === "constructor") continue;
    const value = (host as unknown as Record<string, unknown>)[name];
    if (typeof value === "function") api[name] = value.bind(host);
  }
  return { api: api as unknown as ShellApi, host };
}
