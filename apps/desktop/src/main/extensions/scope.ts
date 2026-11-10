/**
 * ExtensionScope (docs/extensions.md §4, §6): the one choke point every
 * `EXT_METHODS` row reaches the browser through. Per extension, it answers
 *
 * - what it may do: `can(capability)` and `hosts` — the grant the person
 *   approved, narrowed at once by a manifest that asks for less;
 * - where: the Profiles it is on in (`profiles()`, `onIn`), and which of them
 *   a call with no tab acts in (`callProfile`: the Profile of the worker's
 *   invocation in hand, else the Profile in front);
 * - gesture grants: invoking it on a tab grants `pages:read` on that tab
 *   until the tab goes to another site (origin) — and, for `capture:tab` and
 *   `input:events`, the right to record that tab (§5 `capture`); so does the
 *   panel's source list (`capture.sources` from the panel) for every tab it
 *   lists, while the panel stays open; and while it records anything, the
 *   tab in front is its to record too (a recording follows the person);
 * - how often: a token bucket per method from `EXT_RATE_LIMITS`;
 * - and what it sees of the browser: tabs, spaces, the desk, pages — each
 *   filtered to its Profiles, never an agent's hidden tab, never another
 *   extension's page, never one of Pistachio's own addresses to read.
 *
 * One partition and one storage per extension across Profiles in v1: the
 * Profiles filter what it sees, not where it keeps things.
 */

import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { isShellPageUrl } from "@pistachio/shell-contracts/shell-pages";
import { EXTENSION_SCHEME } from "@pistachio/shell-contracts/extensions";
import { EXT_RATE_LIMITS, ExtError, type ExtCaptureSource, type ExtDeskState, type ExtMethod, type ExtSpace, type ExtTab } from "@pistachio/extension-api";
import type { Capability } from "@pistachio/extension-api/capabilities";
import type { PistachioManifest } from "@pistachio/extension-api/manifest";
import { matchesAnyHost, matchesHostPattern, originOf } from "./hosts";
import type { Ledger } from "./ledger";
import type { ExtensionRecord } from "./registry";

/** What main's browser offers an extension's scope (implemented over BrowserController by the service). */
export interface ExtensionBrowserHost {
  /** The Profile (code: Space) in front. */
  activeProfileId(): string;
  /** Every Profile there is (a space named in a call is looked for in each the extension is on in). */
  profileIds(): string[];
  /** Every listed tab of every Profile: never an agent's hidden tab, never an unlisted one. */
  tabs(): BrowserTabInfo[];
  tab(tabId: string): BrowserTabInfo | null;
  activeTabId(): string | null;
  /** A Profile's spaces (tab groups) — drawn, loose and pages' — in the order the sidebar draws them. */
  spaces(profileId: string): TabGroupInfo[];
  currentSpaceId(profileId: string): string | null;
  createTab(url: string, options: { profileId: string; space: "current" | "new" | (string & {}); activate: boolean }): Promise<string>;
  navigate(tabId: string, url: string): Promise<void>;
  showTab(tabId: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  inspect(tabId: string): Promise<{ title: string; url: string; text: string; controls: unknown[] }>;
  /** A PNG of the page as shown. */
  screenshot(tabId: string): Promise<Uint8Array>;
  /** The desk main knows of (docs/extensions.md §5 `desk.state`). */
  desk(profileId: string, spaceId: string | null): ExtDeskState;
}

export interface ScopeDeps {
  record(): ExtensionRecord | null;
  manifest(): PistachioManifest | null;
  browser(): ExtensionBrowserHost | null;
  ledger: Ledger;
  now?: () => number;
}

/** A refusal in the words §5 asks for: what to add, and where. */
export function permissionDenied(method: string, capability: string): ExtError {
  return new ExtError("PERMISSION_DENIED", `${method} needs "${capability}" in pistachio.json → permissions, approved by the person`);
}

/** The addresses an extension may never read, capture or be shown: Pistachio's own, another extension's, a local file. */
export function isPrivateAddress(url: string): boolean {
  return /^(pistachio|pistachio-app|pistachio-ext|file|chrome|chrome-extension|devtools|view-source|about|data|blob|javascript):/i.test(url.trim()) || isShellPageUrl(url);
}

const GESTURE_WINDOW_MS = 5_000;

interface Bucket {
  tokens: number;
  at: number;
}

export class ExtensionScope {
  readonly id: string;
  readonly ledger: Ledger;
  readonly #deps: ScopeDeps;
  readonly #now: () => number;
  /** Tabs the person invoked the extension on, and the origin each was on then. */
  readonly #gestures = new Map<string, string>();
  /** Tabs the panel's source list showed (capture.sources from the panel), granted while the panel is open, with their origins. */
  readonly #listed = new Map<string, string>();
  /** Tabs it captures or watches now: what it already records, it may hold and watch. */
  #live: ReadonlySet<string> = new Set();
  readonly #buckets = new Map<ExtMethod, Bucket>();
  /** The worker's invocations in hand, with the Profile each was made in (newest last). */
  readonly #invocations = new Map<number, string>();
  #lastGestureAt = Number.NEGATIVE_INFINITY;

  constructor(id: string, deps: ScopeDeps) {
    this.id = id;
    this.#deps = deps;
    this.ledger = deps.ledger;
    this.#now = deps.now ?? Date.now;
  }

  /* ------------------------------ grants ------------------------------ */

  /** Granted, and still asked for: a manifest that narrowed applies at once. Writing notes reads them too ("Reads and writes your notes"). */
  can(capability: Capability): boolean {
    const record = this.#deps.record();
    const manifest = this.#deps.manifest();
    if (record === null || manifest === null || record.grants === null) return false;
    const granted = (candidate: Capability): boolean => record.grants!.capabilities.includes(candidate) && (manifest.permissions ?? []).includes(candidate);
    return granted(capability) || (capability === "notes:read" && granted("notes:write"));
  }

  /** The hosts granted and still asked for. */
  get hosts(): string[] {
    const record = this.#deps.record();
    const manifest = this.#deps.manifest();
    if (record === null || manifest === null || record.grants === null) return [];
    const asked = manifest.hosts ?? [];
    return record.grants.hosts.filter((host) => asked.includes(host));
  }

  hostAllowed(url: string): boolean {
    return matchesAnyHost(this.hosts, url);
  }

  /** A declared context-menu item's own hosts, or every page when it names none. */
  static menuHostAllowed(hosts: readonly string[] | undefined, url: string): boolean {
    return hosts === undefined || hosts.length === 0 || hosts.some((pattern) => matchesHostPattern(pattern, url));
  }

  /* ------------------------------ Profiles ------------------------------ */

  profiles(): "all" | string[] {
    return this.#deps.record()?.profiles ?? [];
  }

  onIn(profileId: string): boolean {
    const profiles = this.profiles();
    return profiles === "all" || profiles.includes(profileId);
  }

  /**
   * The Profile a call acts in. A space named (`tabs.create`'s `space`, `ui.openPage`'s, `desk.state`'s) names its
   * Profile. Else the one the worker's pending invocations were made in while they agree; with invocations from two
   * Profiles in flight at once (a handler that outlived a Profile switch) the Profile in front when it is one of
   * them, else the newest's — main cannot tell a handler's calls apart once it has awaited, so a handler that must
   * act where it was invoked names its space (its context's `spaceId`). With none pending, the Profile in front.
   */
  callProfile(space?: string): string {
    const named = space === undefined || space === "current" || space === "new" ? null : this.#profileOfSpace(space);
    const front = this.#browser().activeProfileId();
    const pending = [...this.#invocations.values()];
    const distinct = [...new Set(pending)];
    const profile = named ?? (distinct.length === 0 ? front : distinct.length === 1 ? (distinct[0] as string) : distinct.includes(front) ? front : (pending[pending.length - 1] as string));
    if (!this.onIn(profile)) throw new ExtError("PERMISSION_DENIED", "this extension is off in the Profile in front: turn it on there (Extensions → Profiles)");
    return profile;
  }

  /** The Profile a space is in, among those the extension is on in; null for none (`#space` then says so). */
  #profileOfSpace(space: string): string | null {
    const browser = this.#browser();
    for (const profileId of browser.profileIds()) if (this.onIn(profileId) && browser.spaces(profileId).some((group) => group.id === space)) return profileId;
    return null;
  }

  beginInvocation(id: number, profileId: string): void {
    this.#invocations.set(id, profileId);
  }

  endInvocation(id: number): void {
    this.#invocations.delete(id);
  }

  /* --------------------------- gesture grants --------------------------- */

  /** The person invoked the extension (a Bar command, a menu item, a key, its icon) — on `tabId`, when there is one. */
  grantTab(tabId: string | null): void {
    this.noteGesture();
    if (tabId === null) return;
    const tab = this.#deps.browser()?.tab(tabId) ?? null;
    const origin = tab === null ? null : originOf(tab.url);
    if (origin !== null && !isPrivateAddress(tab!.url)) this.#gestures.set(tabId, origin);
  }

  /** A press or a key in one of the extension's own views, or an invocation: `clipboard.readText` is open for five seconds. */
  noteGesture(): void {
    this.#lastGestureAt = this.#now();
  }

  recentGesture(): boolean {
    return this.#now() - this.#lastGestureAt <= GESTURE_WINDOW_MS;
  }

  hasGesture(tabId: string): boolean {
    return this.#granted(this.#gestures, tabId) || this.#granted(this.#listed, tabId);
  }

  #granted(grants: Map<string, string>, tabId: string): boolean {
    const origin = grants.get(tabId);
    if (origin === undefined) return false;
    const tab = this.#deps.browser()?.tab(tabId) ?? null;
    if (tab === null || originOf(tab.url) !== origin) {
      grants.delete(tabId);
      return false;
    }
    return true;
  }

  /** A tab went somewhere (a publish tick): a grant on it lapses once it is on another site. */
  tabNavigated(tabId: string, url: string | null): void {
    for (const grants of [this.#gestures, this.#listed]) {
      const origin = grants.get(tabId);
      if (origin !== undefined && (url === null || originOf(url) !== origin)) grants.delete(tabId);
    }
  }

  /** The panel listed these tabs as sources (capture.sources): each is the person's to pick while the panel is open. */
  grantListed(tabIds: readonly string[]): void {
    for (const tabId of tabIds) {
      const tab = this.#deps.browser()?.tab(tabId) ?? null;
      const origin = tab === null ? null : originOf(tab.url);
      if (origin !== null && !isPrivateAddress(tab!.url)) this.#listed.set(tabId, origin);
    }
  }

  /** The panel closed: what its list granted goes with it (a capture it started goes on). */
  panelClosed(): void {
    this.#listed.clear();
  }

  /** The tabs it captures or watches now (the service's word, after every change). */
  noteLive(tabIds: Iterable<string>): void {
    this.#live = new Set(tabIds);
  }

  /**
   * Whether `method` (capture.tab, capture.hold, input.subscribe) may record this tab: a web page this extension
   * may see, which the person granted it — an invocation on it, a pick from the panel's list — which it records
   * already, or which is in front while it records something (a recording follows the person: the window they
   * bring in front while the pill is up is theirs to show, and the pill says it is recorded). Null passes (a tab it
   * may not see is NOT_FOUND, the method's to say); a sentence refuses.
   */
  captureRefusal(method: string, tabId: string): string | null {
    let tab: BrowserTabInfo;
    try {
      tab = this.visibleTab(tabId);
    } catch {
      return null;
    }
    if (isPrivateAddress(tab.url) || tab.extensionId !== undefined) return `${method} records web pages only, not ${tab.url.split(":")[0]}: addresses`;
    if (this.#live.has(tabId) || this.hasGesture(tabId)) return null;
    if (this.#live.size > 0 && this.#deps.browser()?.activeTabId() === tabId) return null;
    return `${method} needs the person to choose that window: run it from a command, a menu item, a key or the icon while the window is in use, or from a pick in the panel's list (capture.sources) while the panel is open — or record it while it is in front and a recording of yours already runs`;
  }

  /* ------------------------------ limits ------------------------------ */

  /** Take one call of `method` from its bucket; false when the minute's share is spent. */
  take(method: ExtMethod): boolean {
    const limit = EXT_RATE_LIMITS[method];
    if (limit === undefined) return true;
    const now = this.#now();
    const bucket = this.#buckets.get(method) ?? { tokens: limit, at: now };
    bucket.tokens = Math.min(limit, bucket.tokens + ((now - bucket.at) * limit) / 60_000);
    bucket.at = now;
    this.#buckets.set(method, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /* ------------------------- the browser, scoped ------------------------- */

  #browser(): ExtensionBrowserHost {
    const browser = this.#deps.browser();
    if (browser === null) throw new ExtError("UNAVAILABLE", "the browser window is not open");
    return browser;
  }

  /** A tab this extension may see: in a Profile it is on in, and not another extension's page. */
  #visible(tab: BrowserTabInfo): boolean {
    if (tab.hiddenFor !== undefined || tab.unlisted) return false;
    if (tab.extensionId !== undefined && tab.extensionId !== this.id) return false;
    return this.onIn(tab.spaceId);
  }

  #extTab(tab: BrowserTabInfo, browser: ExtensionBrowserHost, groups: Map<string, string>): ExtTab {
    return {
      id: tab.id,
      spaceId: groups.get(tab.id) ?? null,
      profileId: tab.spaceId,
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.faviconUrl,
      active: tab.id === browser.activeTabId(),
      loading: tab.loading,
      kind: tab.extensionId !== undefined ? "extension" : isShellPageUrl(tab.url) ? "shell" : "page",
    };
  }

  #groupsOf(browser: ExtensionBrowserHost, profileIds: Iterable<string>): Map<string, string> {
    const groups = new Map<string, string>();
    for (const profileId of new Set(profileIds)) for (const group of browser.spaces(profileId)) for (const tabId of group.tabIds) groups.set(tabId, group.id);
    return groups;
  }

  /** A tab by id this extension may see, as main has it; NOT_FOUND otherwise (never "it exists, elsewhere"). */
  visibleTab(tabId: string): BrowserTabInfo {
    const tab = this.#browser().tab(tabId);
    if (tab === null || !this.#visible(tab)) throw new ExtError("NOT_FOUND", `no tab ${tabId}`);
    return tab;
  }

  /** The extension's view of a tab, or null when it may not see it (an event about it is not sent). */
  describeTab(tab: BrowserTabInfo): ExtTab | null {
    if (!this.#visible(tab)) return null;
    const browser = this.#browser();
    return this.#extTab(tab, browser, this.#groupsOf(browser, [tab.spaceId]));
  }

  readonly tabs = {
    query: (query: { spaceId?: string; active?: boolean; url?: string }): ExtTab[] => {
      const browser = this.#browser();
      const tabs = browser.tabs().filter((tab) => this.#visible(tab));
      const groups = this.#groupsOf(browser, tabs.map((tab) => tab.spaceId));
      return tabs
        .map((tab) => this.#extTab(tab, browser, groups))
        .filter((tab) => (query.spaceId === undefined || tab.spaceId === query.spaceId) && (query.active === undefined || tab.active === query.active) && (query.url === undefined || matchesHostPattern(query.url, tab.url)));
    },
    get: (id: string): ExtTab => {
      const browser = this.#browser();
      const tab = this.visibleTab(id);
      return this.#extTab(tab, browser, this.#groupsOf(browser, [tab.spaceId]));
    },
    create: async (options: { url: string; space?: string; show?: boolean }): Promise<ExtTab> => {
      const browser = this.#browser();
      const url = options.url.trim();
      const own = url.startsWith(`${EXTENSION_SCHEME}://${this.id}/`);
      // (Its own pages, or the web: never Pistachio's addresses, another extension's, a file.)
      if (!own && !/^https?:\/\//i.test(url)) throw new ExtError("INVALID_ARGUMENT", "tabs.create opens http(s) addresses and this extension's own pages");
      const profileId = this.callProfile(options.space);
      const space = this.#space(profileId, options.space);
      const tabId = await browser.createTab(url, { profileId, space, activate: options.show !== false });
      return this.tabs.get(tabId);
    },
    navigate: async (id: string, url: string): Promise<void> => {
      const tab = this.visibleTab(id);
      if (tab.extensionId !== undefined) throw new ExtError("INVALID_ARGUMENT", "an extension's own page is navigated by its own links");
      if (!/^https?:\/\//i.test(url.trim())) throw new ExtError("INVALID_ARGUMENT", "tabs.navigate goes to http(s) addresses");
      await this.#browser().navigate(id, url.trim());
    },
    show: async (id: string): Promise<void> => {
      this.visibleTab(id);
      await this.#browser().showTab(id);
    },
    close: async (id: string): Promise<void> => {
      this.visibleTab(id);
      await this.#browser().closeTab(id);
    },
  };

  /** `space` as tabs.create and ui.openPage take it: "current", "new", or a space of the Profile's. */
  #space(profileId: string, space: string | undefined): "current" | "new" | (string & {}) {
    if (space === undefined || space === "current" || space === "new") return space ?? "current";
    if (!this.#browser().spaces(profileId).some((group) => group.id === space)) throw new ExtError("NOT_FOUND", `no space ${space} in the Profile in front`);
    return space;
  }

  /** Where a page of the extension's opens. */
  pagePlace(space: string | undefined): { profileId: string; space: "current" | "new" | (string & {}) } {
    const profileId = this.callProfile(space);
    return { profileId, space: this.#space(profileId, space) };
  }

  readonly spaces = {
    list: (): ExtSpace[] => {
      const browser = this.#browser();
      const profileId = this.callProfile();
      return browser.spaces(profileId).map((group) => this.#extSpace(group, browser));
    },
    current: (): ExtSpace | null => {
      const browser = this.#browser();
      const profileId = this.callProfile();
      const currentId = browser.currentSpaceId(profileId);
      const group = currentId === null ? undefined : browser.spaces(profileId).find((candidate) => candidate.id === currentId);
      return group === undefined ? null : this.#extSpace(group, browser);
    },
  };

  #extSpace(group: TabGroupInfo, browser: ExtensionBrowserHost): ExtSpace {
    // A space with no name of its own (a Home tab's) is called by its tab.
    const first = group.tabIds[0] === undefined ? null : browser.tab(group.tabIds[0]);
    return {
      id: group.id,
      name: group.title.trim() !== "" ? group.title : (first?.title ?? ""),
      color: group.color ?? null,
      tabIds: group.tabIds.filter((tabId) => {
        const tab = browser.tab(tabId);
        return tab !== null && this.#visible(tab);
      }),
    };
  }

  readonly desk = {
    state: (spaceId?: string): ExtDeskState => {
      const browser = this.#browser();
      const profileId = this.callProfile(spaceId);
      if (spaceId !== undefined && !browser.spaces(profileId).some((group) => group.id === spaceId)) throw new ExtError("NOT_FOUND", `no space ${spaceId} in the Profile in front`);
      const state = browser.desk(profileId, spaceId ?? null);
      return {
        ...state,
        windows: state.windows.filter((window) => {
          const tab = browser.tab(window.tabId);
          return tab !== null && this.#visible(tab);
        }),
      };
    },
  };

  /**
   * What capture.sources lists: the windows of the desk in front that are web pages (never a hidden agent tab, a
   * shell page, an extension's page, a Glance), in the desk's order, the one in use first. `still` is the caller's
   * to fill.
   */
  captureSources(): ExtCaptureSource[] {
    const browser = this.#browser();
    const profileId = this.callProfile();
    const active = browser.activeTabId();
    const sources = browser
      .desk(profileId, null)
      .windows.flatMap((window): ExtCaptureSource[] => {
        const tab = browser.tab(window.tabId);
        if (tab === null || !this.#visible(tab) || window.pageKind !== "page" || tab.extensionId !== undefined || isPrivateAddress(tab.url)) return [];
        return [{ tabId: tab.id, title: tab.title, url: tab.url, favIconUrl: tab.faviconUrl, still: null, inUse: tab.id === active }];
      });
    return [...sources.filter((source) => source.inUse), ...sources.filter((source) => !source.inUse)];
  }

  /** Whether `pages.read`/`screenshot` may read this tab: `pages:read` with its host granted, or a gesture grant on it. */
  pageReadRefusal(tabId: string): string | null {
    let tab: BrowserTabInfo;
    try {
      tab = this.visibleTab(tabId);
    } catch {
      return null; // NOT_FOUND is the method's to say.
    }
    if (isPrivateAddress(tab.url) || tab.extensionId !== undefined) return `pages.read reads web pages only, not ${tab.url.split(":")[0]}: addresses`;
    if (this.hasGesture(tabId)) return null;
    if (!this.can("pages:read")) return `pages.read needs "pages:read" in pistachio.json → permissions and a host for the page, or the person invoking the extension on that tab`;
    if (!this.hostAllowed(tab.url)) return `pages.read needs a host matching ${originOf(tab.url) ?? tab.url} in pistachio.json → hosts, or the person invoking the extension on that tab`;
    return null;
  }

  readonly pages = {
    read: async (tabId: string, format: "text" | "markdown" | "elements"): Promise<string> => {
      const tab = this.visibleTab(tabId);
      if (isPrivateAddress(tab.url) || tab.extensionId !== undefined) throw new ExtError("PERMISSION_DENIED", "pages.read reads web pages only");
      const page = await this.#browser().inspect(tabId);
      this.#stillReadable("pages.read", tabId, tab.url, page.url);
      if (format === "elements") return JSON.stringify({ title: page.title, url: page.url, controls: page.controls });
      if (format === "markdown") return `# ${page.title}\n\n${page.text}`;
      return page.text;
    },
    screenshot: async (tabId: string): Promise<Uint8Array> => {
      const tab = this.visibleTab(tabId);
      if (isPrivateAddress(tab.url) || tab.extensionId !== undefined) throw new ExtError("PERMISSION_DENIED", "pages.screenshot pictures web pages only");
      const png = await this.#browser().screenshot(tabId);
      this.#stillReadable("pages.screenshot", tabId, tab.url, null);
      return png;
    },
  };

  /**
   * The read was allowed for the page the tab showed when it was asked (`pageReadRefusal`, before the await); a tab
   * that went to another site meanwhile — a redirect, a link — showed that site to the read, and that site's words
   * are only the extension's if the grant covers it too: checked again, on the tab now and on what was read.
   */
  #stillReadable(method: string, tabId: string, askedUrl: string, readUrl: string | null): void {
    const gone = (): never => {
      throw new ExtError("PERMISSION_DENIED", `${method}: the page went to another site while it was read, one the extension may not read`);
    };
    let now: BrowserTabInfo;
    try {
      now = this.visibleTab(tabId);
    } catch {
      return gone();
    }
    const origin = originOf(askedUrl);
    if (originOf(now.url) !== origin) gone();
    if (readUrl !== null && readUrl !== "" && originOf(readUrl) !== origin) gone();
    if (this.pageReadRefusal(tabId) !== null) gone();
  }
}
