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
 * - space grants: invoking it IN a space — a Bar command, a menu item, a
 *   key, its icon — gives it that space for good (`spaces:write`, ./away):
 *   the one it may send away and bring back, kept on its record because a
 *   schedule acts with no gesture in hand; never from a tool call or a
 *   message, which are not the person's hand in a space;
 * - whether anyone is there: a call made while a trigger's handler runs and
 *   no command of the person's is in hand is **unattended** (`unattended`;
 *   docs/primitives.md §3) — only the methods safe with nobody there are
 *   answered (the dispatch's gate), a space is sent away under stricter
 *   rules, and each such write is written to the journal;
 * - what the shell draws for it (docs/primitives.md §4): a mark on a space
 *   the person gave it, a theme for such a space or for every space — values
 *   handed to main (./shown.ts), never pixels of its own;
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
import {
  EXT_RATE_LIMITS,
  ExtError,
  type ExtAwaySpace,
  type ExtCaptureSource,
  type ExtDeskState,
  type ExtMethod,
  type ExtSiteView,
  type ExtSpace,
  type ExtSpaceMark,
  type ExtTab,
  type ExtTheme,
} from "@pistachio/extension-api";
import { accentRefusal } from "@pistachio/extension-api/theme";
import { SITE_WORDS, siteViewIssues, type Site } from "@pistachio/extension-api/sites";
import { EVERY_SPACE } from "@pistachio/shell-contracts/extensions";
import { AI_UNATTENDED_PER_HOUR, EXT_ATTENDED_KINDS, EXT_HANDLER_TIMEOUTS, EXT_UNATTENDED_METHODS, SPACES_UNATTENDED_PER_HOUR, SPACE_TABS_MAX, type ExtInvokeKind } from "@pistachio/extension-api/wire";
import type { Capability } from "@pistachio/extension-api/capabilities";
import type { PistachioManifest } from "@pistachio/extension-api/manifest";
import { awayError, closeError, extAwaySpace, heldBy, makeError, spaceNotGranted, type ExtensionAwayHost, type ExtensionClosingHost, type ExtensionMakingHost } from "./away";
import { matchesAnyHost, matchesHostPattern, originOf } from "./hosts";
import type { Ledger } from "./ledger";
import type { ExtensionRecord } from "./registry";
import { extSiteView, extTheme, storedBackdrop, storedRow, type ShownHost } from "./shown";

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
  /**
   * Whether a space is the person's (docs/spaces.md §1): made by them or made theirs, holding a Stack or a
   * conversation, or grown from a tab of their own — anything but one Tidy gathered that nobody has touched since.
   * Left out (a host that cannot say), every space is taken as theirs.
   */
  personsSpace?(spaceId: string): boolean;
  currentSpaceId(profileId: string): string | null;
  /** `awaitLoad: false`: answered once the tab stands in its space, its page still loading (a caller with nobody there cannot wait on a page). */
  createTab(url: string, options: { profileId: string; space: "current" | "new" | (string & {}); activate: boolean; awaitLoad?: boolean }): Promise<string>;
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
  /** Main's away spaces (main/away-spaces.ts), which go with the window as the browser does; absent or null, a space cannot be sent away. */
  away?(): ExtensionAwayHost | null;
  /** Main's verb for closing a space into the archive (main/space-closing.ts), which goes with the window; absent or null, a space cannot be closed. */
  closing?(): ExtensionClosingHost | null;
  /** Main's verb for making a space (main/space-making.ts), which goes with the window; absent or null, a space cannot be made. */
  making?(): ExtensionMakingHost | null;
  /** Remember that the person gave the extension this space (ExtensionRecord.spaces; ./away withSpaceGrant). */
  rememberSpace?(spaceId: string): void;
  /** Remember that the extension made this space itself (ExtensionRecord.made): its own, as one the person gave it — and its to close from in front. */
  rememberMade?(spaceId: string): void;
  /** Write down what was done with nobody there — a space sent away, brought back, closed or made, a theme set, a tab opened (./automation: the journal the person undoes from). */
  journal?(entry: { trigger: string | null; verb: "sendAway" | "bringBack" | "setTheme" | "openTab" | "closeSpace" | "makeSpace"; spaceId: string; title: string; tabId?: string; entryId?: string; until?: number }): void;
  /**
   * Whether main can see that nobody is at the Mac (docs/primitives.md §3.6), given the triggers whose handlers are
   * in hand: its screen is locked, or one of them is a signal that says so (idle, the screen) and holds as read now.
   */
  absent?(triggers: readonly string[]): boolean;
  /**
   * Whether the worker running now was started by a trigger and nothing of the person's has run in it since: then
   * everything it does is with nobody there — its module's own top level as it loads, a timer between handlers —
   * whether or not a trigger's handler happens to be in hand at that instant.
   */
  woken?(): boolean;
  /** What extensions have the shell showing (./shown.ts): marks and themes, main's to keep. Absent or null, nothing can be shown. */
  shown?(): ShownHost | null;
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
/** How many tabs an extension may open with nobody there, in any hour: a morning's set, not a flood. */
export const UNATTENDED_TABS_PER_HOUR = 12;
const HOUR_MS = 60 * 60_000;

/** A tab as the journal names it before its page has a title: its address without the scheme, cut short. */
export function journalTabTitle(url: string): string {
  const plain = url.replace(/^[a-z-]+:\/\//i, "").replace(/[?#].*$/, "").replace(/\/$/, "");
  return plain.length > 80 ? `${plain.slice(0, 79)}…` : plain;
}

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
  /** The worker's invocations in hand, with the Profile each was made in, its kind and its name (newest last). */
  readonly #invocations = new Map<number, { profileId: string; kind: ExtInvokeKind; name: string; at: number }>();
  #lastGestureAt = Number.NEGATIVE_INFINITY;
  /** The last press or key in one of the extension's own views (its panel, a page of its): the person at the extension itself. */
  #lastViewGestureAt = Number.NEGATIVE_INFINITY;
  /** When it opened each tab with nobody there, this past hour (UNATTENDED_TABS_PER_HOUR). */
  #unattendedTabs: number[] = [];
  /** When it asked a model with nobody there, this past hour (AI_UNATTENDED_PER_HOUR). */
  #unattendedAsks: number[] = [];
  /** When it made each space with nobody there, this past hour (SPACES_UNATTENDED_PER_HOUR). */
  #unattendedSpaces: number[] = [];

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
    const pending = [...this.#invocations.values()].map((invocation) => invocation.profileId);
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

  /** A handler of the worker's starts: where it was invoked, and what invoked it (`message` when unsaid: nobody's command, nobody's trigger). */
  beginInvocation(id: number, profileId: string, kind: ExtInvokeKind = "message", name = ""): void {
    this.#invocations.set(id, { profileId, kind, name, at: this.#now() });
  }

  endInvocation(id: number): void {
    this.#invocations.delete(id);
  }

  /**
   * How long the handlers in hand have left before main gives up on them (EXT_HANDLER_TIMEOUTS), in ms: the longest
   * of them — main cannot tell one handler's calls from another's — and null with none in hand. What a handler
   * waits on (a model's answer) must come back inside it.
   */
  handlerTimeLeft(): number | null {
    const now = this.#now();
    const left = [...this.#invocations.values()].map((invocation) => invocation.at + EXT_HANDLER_TIMEOUTS[invocation.kind] - now);
    return left.length === 0 ? null : Math.max(...left);
  }

  /* ------------------------------ unattended ------------------------------ */

  /**
   * Whether the worker runs now with nobody there (docs/primitives.md §3): a trigger's handler is in hand, no
   * command of the person's is — their Bar command, menu item, key, click, the agent's turn they asked for — and
   * they have not just pressed something in one of its own views (its panel, a page of its: what a press there
   * asks of the worker arrives as a message, a moment later). Main cannot tell one handler's calls from another's
   * once each has awaited, so the person's hand on the extension makes all of it attended for that moment; a
   * trigger alone is never. A command that has already answered is over: it lends a later trigger nothing.
   */
  unattended(): boolean {
    const kinds = [...this.#invocations.values()].map((invocation) => invocation.kind);
    // (A worker a trigger woke is nobody's hand from its first line to its last, not only between a handler's start
    // and its answer: the service says so for as long as nothing of the person's has run in it.)
    const byTrigger = kinds.includes("trigger") || this.#deps.woken?.() === true;
    return byTrigger && !kinds.some((kind) => EXT_ATTENDED_KINDS.includes(kind)) && this.#now() - this.#lastViewGestureAt > GESTURE_WINDOW_MS;
  }

  /** The trigger whose handler is in hand (the newest), by id — what the journal names; null for none. */
  triggerInHand(): string | null {
    const triggers = this.triggersInHand();
    return triggers[triggers.length - 1] ?? null;
  }

  /** Every trigger whose handler is in hand, by id, oldest first. */
  triggersInHand(): string[] {
    return [...this.#invocations.values()].filter((invocation) => invocation.kind === "trigger").map((invocation) => invocation.name);
  }

  /**
   * Why `method` is refused the worker now, or null: unattended, it may call only what is safe with nobody there
   * (EXT_UNATTENDED_METHODS). A page or the panel is the person's own view of the extension and is never judged here.
   */
  unattendedRefusal(method: ExtMethod, context: "worker" | "panel" | "page"): string | null {
    if (context !== "worker" || EXT_UNATTENDED_METHODS.includes(method) || !this.unattended()) return null;
    return `${method} is not for a trigger's handler: with nobody there an extension may read, keep its own storage and files, tell the person (ui.toast, notifications.show, ui.setBadge, ui.setStatus), reach its hosts, change what Pistachio draws for it, open a tab behind what is in front (tabs.create), make a space behind it (spaces.create), and send away, bring back or close a space the person gave it or it made. For anything else, ask them — a toast with an action runs when they press it`;
  }

  /**
   * Whether one of the extension's own contexts may have the microphone (`audio`) or the camera (`video`) now: as
   * its grants say — and never the worker with nobody there. `getUserMedia` is the page's own call, not one of
   * Pistachio's, so the list of what may be called alone (unattendedRefusal) never sees it: a trigger's handler
   * would otherwise record. A page or the panel is the person's own view of the extension.
   */
  mediaAllowed(context: "worker" | "panel" | "page", types: readonly string[]): boolean {
    if (types.length === 0) return false;
    if (context === "worker" && this.unattended()) return false;
    return types.every((type) => (type === "audio" ? this.can("media:microphone") : type === "video" ? this.can("media:camera") : false));
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

  /**
   * The person invoked the extension IN a space (the Bar command's space, a menu item's window's or the space whose
   * menu it was chosen from, the space in front for a key or its icon): that space is its from now on — to send
   * away (`spaces:write`), to mark (`spaces:mark`), to give a backdrop (`theme`) — if any of those is its at all. Only a
   * space that can be away — drawn, in a Profile it is on in; a Home tab's or a favorite's page's is nobody's to send.
   */
  grantSpace(spaceId: string | null): void {
    if (spaceId === null || !this.#actsOnSpaces() || this.holdsSpace(spaceId)) return;
    const browser = this.#deps.browser();
    const profileId = browser === null ? null : this.#profileOfSpace(spaceId);
    const group = profileId === null ? undefined : browser!.spaces(profileId).find((candidate) => candidate.id === spaceId);
    if (group === undefined || group.loose === true || group.anchorId !== undefined) return;
    this.#deps.rememberSpace?.(spaceId);
  }

  /**
   * Whether anything of it is done to a space: sending one away, marking one, giving one a backdrop — or rows of its
   * own, in a place it declares. Without that a space is not remembered.
   */
  #actsOnSpaces(): boolean {
    return this.can("spaces:write") || this.can("spaces:close") || this.can("spaces:mark") || this.can("theme") || this.declaresSite("band") || this.declaresSite("sidebar");
  }

  /** Whether its manifest declares a place it fills with rows (pistachio.json "band" / "sidebar"). */
  declaresSite(site: Site): boolean {
    return this.#deps.manifest()?.[site] === true;
  }

  /**
   * The person gave it this space (grantSpace), here or away — or, holding `spaces:all`, it is any drawn space of a
   * Profile it is on in, here or away: the one capability that makes a grant for the kind rather than the thing
   * (docs/primitives.md §2.6), on a High line of its own.
   */
  holdsSpace(spaceId: string): boolean {
    if (this.#deps.record()?.spaces?.includes(spaceId) === true) return true;
    if (!this.can("spaces:all")) return false;
    const browser = this.#deps.browser();
    if (browser !== null) {
      for (const profileId of browser.profileIds()) {
        if (!this.onIn(profileId)) continue;
        const group = browser.spaces(profileId).find((candidate) => candidate.id === spaceId);
        if (group !== undefined) return group.loose !== true && group.anchorId === undefined;
      }
    }
    const away = this.#deps.away?.()?.get(spaceId) ?? null;
    return away !== null && this.onIn(away.spaceId);
  }

  /** The extension made this space itself (`spaces.create`): its own, and its to close from in front (docs/primitives.md §2.7). */
  madeSpace(spaceId: string): boolean {
    return this.#deps.record()?.made?.includes(spaceId) === true;
  }

  /**
   * The person used the extension: an invocation of theirs, or — `inView` — a press or a key in one of its own views.
   * Either opens `clipboard.readText` for five seconds; only one in a view makes a trigger's handler attended meanwhile.
   */
  noteGesture(inView = false): void {
    this.#lastGestureAt = this.#now();
    if (inView) this.#lastViewGestureAt = this.#lastGestureAt;
  }

  recentGesture(): boolean {
    return this.#now() - this.#lastGestureAt <= GESTURE_WINDOW_MS;
  }

  /** Whether the person has just pressed something in one of the extension's own views (its panel, a page of its). */
  recentViewGesture(): boolean {
    return this.#now() - this.#lastViewGestureAt <= GESTURE_WINDOW_MS;
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

  /** Whether a tab is one this extension may see (what its signals and events are read from: ./signals, the service's tab tick). */
  sees(tab: BrowserTabInfo): boolean {
    return this.#visible(tab);
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
      lastActiveAt: tab.lastActiveAt,
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
      // (Read before anything is awaited: who is there is a fact of the moment the call was made.)
      const unattended = this.unattended();
      const trigger = this.triggerInHand();
      if (unattended) {
        // With nobody there a tab is a page of the web, opened in a space that is there. Never a page of its own:
        // that is its code running in a view nothing holds to the unattended list — `ui.openPage` by another name.
        if (own) throw new ExtError("PERMISSION_DENIED", "tabs.create: a trigger's handler opens pages of the web, not this extension's own — show a toast with an action, and open it when the person presses");
        // Nor a space grown around it: that is a space with no name, and one this extension could not close again.
        // A space made with nobody there is `spaces.create`'s — named, the extension's own, on its own line of the sheet.
        if (options.space === "new") throw new ExtError("PERMISSION_DENIED", 'tabs.create: a trigger\'s handler opens a tab in a space that is there — leave `space` out for the one in front, or name one. To make a space with nobody there, use spaces.create({ name, tabs }) with "spaces:create": it is named, yours to close later, and written down; "new" is for when the person runs it');
      }
      const profileId = this.callProfile(options.space);
      const space = this.#space(profileId, options.space);
      if (unattended && space !== "current") {
        // (Named, a Home tab's space or a favorite's page's would grow into a space on the rail around the new tab:
        // a space made with nobody there, by another door. Only a drawn space is one to open into.)
        const group = browser.spaces(profileId).find((candidate) => candidate.id === space);
        if (group === undefined || group.loose === true || group.anchorId !== undefined) {
          throw new ExtError("PERMISSION_DENIED", "tabs.create: a trigger's handler opens a tab in a space on the rail, or leaves `space` out — a Home tab's space, or a favorite's page's, would become a new space around it");
        }
      }
      // Behind what is in front — and with nothing in front there is no behind: a space shows the tab it has when it
      // has one, so a tab joining the space in front while nothing is in use there would be put in front, asked to
      // or not. Refused (not counted): the trigger is run again later, when the person is somewhere.
      if (unattended && browser.activeProfileId() === profileId && browser.activeTabId() === null && (space === "current" || space === browser.currentSpaceId(profileId))) {
        throw new ExtError("UNAVAILABLE", "tabs.create: nothing is in use in the space in front, so a tab opened there with nobody there would be put in front of the person — let the handler fail (Pistachio runs the trigger again later), or name another space");
      }
      if (unattended && !this.#takeUnattendedTab()) throw new ExtError("RATE_LIMITED", `tabs.create: with nobody there an extension opens ${String(UNATTENDED_TABS_PER_HOUR)} tabs an hour at most`);
      // With nobody there a tab opens behind what is in front, whatever was asked: nobody is moved by code. And it is
      // not waited on: the handler that asked has ten seconds, and a page slower than that would have main give up on
      // it — its worker stopped, the trigger run again, the page opened a second time.
      const tabId = await browser.createTab(url, { profileId, space, activate: unattended ? false : options.show !== false, ...(unattended ? { awaitLoad: false } : {}) });
      const tab = this.tabs.get(tabId);
      // Written down, with the way back: Undo closes it.
      if (unattended) this.#deps.journal?.({ trigger, verb: "openTab", spaceId: tab.spaceId ?? EVERY_SPACE, title: journalTabTitle(url), tabId });
      return tab;
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
    /**
     * A mark on a tab's row (docs/primitives.md §4.7), or — null — this extension's taken off: any tab it could see.
     * One mark an extension a tab; the shell draws it and says whose it is. Taking one off a tab that has gone is
     * quiet: a handler reconciles, and what is not there needs no mark removed.
     */
    setMark: (id: string, mark: ExtSpaceMark | null): void => {
      const shown = this.#shown();
      if (mark === null) {
        shown.clearTabMark(this.id, id);
        return;
      }
      const tab = this.visibleTab(id);
      // (One line, as the shell will say it: no breaks, no control characters.)
      // eslint-disable-next-line no-control-regex
      const label = mark.label.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
      if (label === "") throw new ExtError("INVALID_ARGUMENT", "tabs.setMark: the label says what the mark means, in a few words");
      shown.setTabMark({ extensionId: this.id, tabId: tab.id, glyph: mark.glyph ?? null, tone: mark.tone ?? "neutral", label });
    },
    close: async (id: string): Promise<void> => {
      this.visibleTab(id);
      await this.#browser().closeTab(id);
    },
  };

  /** One more tab opened with nobody there, if the hour has room for it. */
  #takeUnattendedTab(): boolean {
    const now = this.#now();
    this.#unattendedTabs = this.#unattendedTabs.filter((at) => now - at < HOUR_MS);
    if (this.#unattendedTabs.length >= UNATTENDED_TABS_PER_HOUR) return false;
    this.#unattendedTabs.push(now);
    return true;
  }

  /** One more space made with nobody there, with `tabs` pages in it, if the hour has room for both. */
  #takeUnattendedSpace(tabs: number): boolean {
    const now = this.#now();
    this.#unattendedSpaces = this.#unattendedSpaces.filter((at) => now - at < HOUR_MS);
    this.#unattendedTabs = this.#unattendedTabs.filter((at) => now - at < HOUR_MS);
    if (this.#unattendedSpaces.length >= SPACES_UNATTENDED_PER_HOUR || this.#unattendedTabs.length + tabs > UNATTENDED_TABS_PER_HOUR) return false;
    this.#unattendedSpaces.push(now);
    for (let index = 0; index < tabs; index += 1) this.#unattendedTabs.push(now);
    return true;
  }

  /**
   * A question is about to be put to a model (`ai.complete`): with nobody there, at most a dozen an hour — a
   * trigger that runs every minute does not spend the person's usage every minute.
   */
  aiAsked(): void {
    if (!this.unattended()) return;
    const now = this.#now();
    this.#unattendedAsks = this.#unattendedAsks.filter((at) => now - at < HOUR_MS);
    if (this.#unattendedAsks.length >= AI_UNATTENDED_PER_HOUR) throw new ExtError("RATE_LIMITED", `ai.complete: with nobody there an extension asks a model ${String(AI_UNATTENDED_PER_HOUR)} times an hour at most`);
    this.#unattendedAsks.push(now);
  }

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
    /**
     * Send a space away (docs/primitives.md §2): one the person gave it (grantSpace) — asked first, so a space it
     * was never run in is refused the same whether it is here, away or nowhere — under its own name as the sender,
     * which the shell draws beside the space. The away service's refusal is the call's, in its sentence.
     */
    sendAway: async (spaceId: string, until?: number): Promise<ExtAwaySpace> => {
      if (!this.holdsSpace(spaceId)) throw spaceNotGranted("spaces.sendAway", spaceId);
      // (Read before anything is awaited: who is there is a fact of the moment the call was made.)
      const unattended = this.unattended();
      const trigger = this.triggerInHand();
      // (Nobody at the Mac at all — its screen locked, idle as the trigger in hand says: the space in front may go.)
      const absent = unattended && this.#deps.absent?.(this.triggersInHand()) === true;
      const away = this.#away();
      // Away already (whoever sent it): what was asked for is so. A handler reconciles, and may ask twice.
      const already = away.get(spaceId);
      if (already !== null && this.onIn(already.spaceId)) return extAwaySpace(already, this.id);
      // (A space of a Profile it is off in is not there for it: NOT_FOUND, as a tab there is.)
      if (this.#profileOfSpace(spaceId) === null) throw awayError("spaces.sendAway", "unknown");
      const outcome = await away.send(spaceId, { by: this.#holder(), ...(until === undefined ? {} : { until }), ...(unattended ? { unattended: true } : {}), ...(absent ? { absent: true } : {}) });
      if (!outcome.ok) throw awayError("spaces.sendAway", outcome.refusal);
      if (unattended) this.#deps.journal?.({ trigger, verb: "sendAway", spaceId, title: outcome.space.title });
      return extAwaySpace(outcome.space, this.id);
    },
    /**
     * Bring back a space it sent away itself, or one the person gave it — never in front: nobody but the person
     * moves them. One it holds that is here already asked for nothing, and is answered so.
     */
    bringBack: async (spaceId: string): Promise<void> => {
      const unattended = this.unattended();
      const trigger = this.triggerInHand();
      const away = this.#away();
      const space = away.get(spaceId);
      if (space === null || !this.onIn(space.spaceId)) {
        if (!this.holdsSpace(spaceId)) throw spaceNotGranted("spaces.bringBack", spaceId);
        // Here already: what was asked for is so. Neither here nor away (closed since), it is nowhere to bring back from.
        if (this.#profileOfSpace(spaceId) !== null) return;
        throw awayError("spaces.bringBack", "notAway");
      }
      if (!heldBy(space, this.id) && !this.holdsSpace(spaceId)) throw spaceNotGranted("spaces.bringBack", spaceId);
      const outcome = await away.bringBack(spaceId, { by: this.#holder() });
      if (!outcome.ok) throw awayError("spaces.bringBack", outcome.refusal);
      // (With when it was due, if it had a time: undone, it is away again until then — not for good.)
      if (unattended) this.#deps.journal?.({ trigger, verb: "bringBack", spaceId, title: outcome.space.title, ...(space.until === undefined ? {} : { until: space.until }) });
    },
    /**
     * Close a space into the archive (docs/primitives.md §2.6): what the person's own *Close space* does, by a space
     * the person gave it (or, with `spaces:all`, any drawn one). The closing verb's refusal is the call's, in its
     * sentence; with nobody there it is written down, and Undo restores the archive's entry.
     */
    close: async (spaceId: string): Promise<void> => {
      if (!this.holdsSpace(spaceId)) throw spaceNotGranted("spaces.close", spaceId);
      // (Read before anything is awaited: who is there is a fact of the moment the call was made.)
      const unattended = this.unattended();
      const trigger = this.triggerInHand();
      // (In front of no one — nobody at the Mac — or its own: a space the extension made is its to close whoever is
      // in it. "Chess time closes at six" means six; the desk passes on, and the notice has the way back.)
      const absent = unattended && (this.madeSpace(spaceId) || this.#deps.absent?.(this.triggersInHand()) === true);
      const closing = this.#deps.closing?.() ?? null;
      if (closing === null) throw new ExtError("UNAVAILABLE", "the browser window is not open");
      // (Away, or of a Profile it is off in, it is not here to close: NOT_FOUND, as a tab there is.)
      if (this.#profileOfSpace(spaceId) === null) throw closeError("spaces.close", "unknown");
      const outcome = await closing.close(spaceId, { by: this.#holder(), ...(unattended ? { unattended: true } : {}), ...(absent ? { absent: true } : {}) });
      if (!outcome.ok) throw closeError("spaces.close", outcome.refusal);
      if (unattended) this.#deps.journal?.({ trigger, verb: "closeSpace", spaceId, title: outcome.title, ...(outcome.entryId === null ? {} : { entryId: outcome.entryId }) });
    },
    /**
     * Make a space (docs/primitives.md §2.7): named, a page of the web for each of `tabs`, in the Profile the call
     * acts in — and the extension's from then on (rememberSpace, rememberMade), as one the person gave it. With the
     * person behind the call it is brought in front unless `show` is false; with nobody there it is made behind what
     * is in front whatever was asked, a few an hour at most, and written down: Undo closes it.
     */
    create: async (options: { name: string; tabs?: readonly string[]; show?: boolean }): Promise<ExtSpace> => {
      // eslint-disable-next-line no-control-regex
      const name = options.name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
      if (name === "") throw new ExtError("INVALID_ARGUMENT", "spaces.create: `name` is what the space is called on the rail, in a few words");
      const urls = (options.tabs ?? []).map((url) => url.trim());
      if (urls.length > SPACE_TABS_MAX) throw new ExtError("INVALID_ARGUMENT", `spaces.create: a space is made with ${String(SPACE_TABS_MAX)} pages at most`);
      // (Pages of the web: never Pistachio's addresses, an extension's, a file. Its own pages open in it afterwards — ui.openPage's `space`.)
      const notWeb = urls.find((url) => !/^https?:\/\//i.test(url));
      if (notWeb !== undefined) throw new ExtError("INVALID_ARGUMENT", `spaces.create: \`tabs\` are http(s) addresses, and ${JSON.stringify(notWeb.slice(0, 80))} is not one`);
      // (Read before anything is awaited: who is there is a fact of the moment the call was made.)
      const unattended = this.unattended();
      const trigger = this.triggerInHand();
      const browser = this.#browser();
      const profileId = this.callProfile();
      const making = this.#deps.making?.() ?? null;
      if (making === null) throw new ExtError("UNAVAILABLE", "the browser window is not open");
      if (unattended && !this.#takeUnattendedSpace(urls.length)) {
        throw new ExtError("RATE_LIMITED", `spaces.create: with nobody there an extension makes ${String(SPACES_UNATTENDED_PER_HOUR)} spaces an hour at most, and opens ${String(UNATTENDED_TABS_PER_HOUR)} tabs`);
      }
      // With nobody there it is made behind what is in front, whatever was asked: nobody is moved by code.
      const outcome = await making.make({ profileId, title: name, urls, by: this.#holder(), ...(unattended || options.show === false ? {} : { show: true }) });
      if (!outcome.ok) throw makeError("spaces.create", outcome.refusal);
      // Its own from here on: to close, to send away, to mark — whatever its other capabilities let it do to a space.
      this.#deps.rememberSpace?.(outcome.groupId);
      this.#deps.rememberMade?.(outcome.groupId);
      // Written down, with the way back: Undo closes it.
      if (unattended) this.#deps.journal?.({ trigger, verb: "makeSpace", spaceId: outcome.groupId, title: outcome.title });
      const group = browser.spaces(outcome.profileId).find((candidate) => candidate.id === outcome.groupId);
      // (Gone already — closed in the moment since: what was made is still what is answered.)
      return group === undefined
        ? { id: outcome.groupId, name: outcome.title, color: null, tabIds: outcome.tabIds, lastActiveAt: 0, byPerson: true }
        : this.#extSpace(group, browser);
    },
    /**
     * A mark on a space's tile (docs/primitives.md §4), or — null — this extension's taken off: a space the person
     * gave it, here or away. One mark an extension a space; the shell draws it and says whose it is.
     */
    setMark: (spaceId: string, mark: ExtSpaceMark | null): void => {
      if (!this.holdsSpace(spaceId)) throw spaceNotGranted("spaces.setMark", spaceId);
      const shown = this.#shown();
      if (mark === null) {
        shown.clearMark(this.id, spaceId);
        return;
      }
      // (One line, as the shell will say it: no breaks, no control characters.)
      // eslint-disable-next-line no-control-regex
      const label = mark.label.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
      if (label === "") throw new ExtError("INVALID_ARGUMENT", "spaces.setMark: the label says what the mark means, in a few words");
      shown.setMark({ extensionId: this.id, spaceId, glyph: mark.glyph ?? null, tone: mark.tone ?? "neutral", label });
    },
    /** The spaces away in the Profiles it is on in, oldest first, whoever sent them. */
    away: (): ExtAwaySpace[] => {
      const away = this.#deps.away?.() ?? null;
      return away === null ? [] : away.all().filter((space) => this.onIn(space.spaceId)).map((space) => extAwaySpace(space, this.id));
    },
  };

  /**
   * The theme (docs/primitives.md §4): a backdrop for the desk and an accent, for one space the person gave it or —
   * no space named — for every space. A value main keeps and the shell draws; `set` replaces this extension's
   * theme there whole, and takes the place of another's.
   */
  readonly theme = {
    set: (theme: ExtTheme): void => {
      const spaceId = theme.spaceId ?? null;
      if (spaceId !== null && !this.holdsSpace(spaceId)) throw spaceNotGranted("theme.set", spaceId);
      const accent = theme.colors?.accent?.toLowerCase() ?? null;
      const refusal = accent === null ? null : accentRefusal(accent);
      if (refusal !== null) throw new ExtError("INVALID_ARGUMENT", `theme.set: ${refusal}`);
      // (Read before the picture is copied: who is there is a fact of the moment the call was made.)
      const unattended = this.unattended();
      const trigger = this.triggerInHand();
      const shown = this.#shown();
      const backdrop = theme.backdrop === undefined || theme.backdrop === null ? null : storedBackdrop(theme.backdrop, (path) => shown.adoptImage(this.id, path));
      // Nothing to show is nothing shown: the same as clear.
      if (backdrop === null && accent === null) {
        shown.clearTheme(this.id, spaceId);
        return;
      }
      const changed = shown.setTheme({ extensionId: this.id, spaceId, backdrop, accent });
      // Written down when it changed something with nobody there: a handler that says the same again writes nothing.
      if (changed && unattended) this.#deps.journal?.({ trigger, verb: "setTheme", spaceId: spaceId ?? EVERY_SPACE, title: spaceId === null ? "" : this.#spaceTitle(spaceId) });
    },
    clear: (spaceId?: string): void => {
      if (spaceId !== undefined && !this.holdsSpace(spaceId)) throw spaceNotGranted("theme.clear", spaceId);
      this.#shown().clearTheme(this.id, spaceId ?? null);
    },
    /** What it set there, as it set it; null when it holds none (cleared, removed by the person, another's in its place). */
    get: (spaceId?: string): ExtTheme | null => {
      if (spaceId !== undefined && !this.holdsSpace(spaceId)) throw spaceNotGranted("theme.get", spaceId);
      const held = this.#shown().themeOf(this.id, spaceId ?? null);
      return held === null ? null : extTheme(held);
    },
  };

  /**
   * The places it fills with rows (docs/primitives.md §4.5): the band beside the Bar, a section of the sidebar —
   * each declared in its manifest. For one space the person gave it or — no space named — for every space. A value
   * main keeps and the shell draws, under the extension's mark; `set` replaces its rows there whole.
   */
  readonly sites = {
    set: (site: Site, view: ExtSiteView): void => {
      const method = `ui.${site}.set`;
      this.#requireSite(site, method);
      const spaceId = view.spaceId ?? null;
      if (spaceId !== null && !this.holdsSpace(spaceId)) throw spaceNotGranted(method, spaceId);
      const issue = siteViewIssues(site, view)[0];
      if (issue !== undefined) throw new ExtError("INVALID_ARGUMENT", `${method}: ${issue}`);
      // (A press wakes the worker: rows that can be pressed with no worker to hear it would be buttons that do nothing.)
      if (this.#deps.manifest()?.worker === undefined && view.rows.some((row) => row.id !== undefined || (row.buttons?.length ?? 0) > 0)) {
        throw new ExtError("INVALID_ARGUMENT", `${method}: a row with an id or buttons can be pressed, and a press wakes the worker — add "worker": { "type": "web", "main": "worker.js" } and pistachio.ui.${site}.onPress(…) in it, or leave the ids out`);
      }
      const shown = this.#shown();
      // Nothing to show is nothing shown: the same as clear.
      if (view.rows.length === 0) {
        shown.clearSite(this.id, site, spaceId);
        return;
      }
      const title = view.title?.trim() ?? "";
      shown.setSite({ extensionId: this.id, site, spaceId, title: title === "" ? null : title, rows: view.rows.map(storedRow) });
    },
    clear: (site: Site, spaceId?: string): void => {
      this.#requireSite(site, `ui.${site}.clear`);
      if (spaceId !== undefined && !this.holdsSpace(spaceId)) throw spaceNotGranted(`ui.${site}.clear`, spaceId);
      this.#shown().clearSite(this.id, site, spaceId ?? null);
    },
    /** What it set there, as it set it; null when it has none (cleared, or removed by the person). */
    get: (site: Site, spaceId?: string): ExtSiteView | null => {
      this.#requireSite(site, `ui.${site}.get`);
      if (spaceId !== undefined && !this.holdsSpace(spaceId)) throw spaceNotGranted(`ui.${site}.get`, spaceId);
      const held = this.#shown().siteOf(this.id, site, spaceId ?? null);
      return held === null ? null : extSiteView(held);
    },
  };

  /** A place is the extension's to fill only when its manifest says so: the sheet said it adds one before any of its code ran. */
  #requireSite(site: Site, method: string): void {
    if (!this.declaresSite(site)) throw new ExtError("PERMISSION_DENIED", `${method}: this extension declares no ${SITE_WORDS[site]} — add "${site}": true to pistachio.json`);
  }

  #shown(): ShownHost {
    const shown = this.#deps.shown?.() ?? null;
    if (shown === null) throw new ExtError("UNAVAILABLE", "nothing can be shown for this extension here");
    return shown;
  }

  /** A space's name as the person has it, here or away; empty when it is neither. */
  #spaceTitle(spaceId: string): string {
    const browser = this.#deps.browser();
    for (const profileId of browser?.profileIds() ?? []) {
      const group = browser!.spaces(profileId).find((candidate) => candidate.id === spaceId);
      if (group !== undefined) return group.title;
    }
    return this.#deps.away?.()?.get(spaceId)?.title ?? "";
  }

  /** An away space as this extension would hear of it, or null when it is in a Profile it is off in (the event is not sent). */
  describeAway(space: Parameters<typeof extAwaySpace>[0]): ExtAwaySpace | null {
    return this.onIn(space.spaceId) ? extAwaySpace(space, this.id) : null;
  }

  /** The extension as the sender the shell draws beside a space: by its name on the sheet. */
  #holder(): { kind: "extension"; extensionId: string; name: string } {
    return { kind: "extension", extensionId: this.id, name: (this.#deps.manifest()?.name ?? this.id).slice(0, 80) };
  }

  #away(): ExtensionAwayHost {
    const away = this.#deps.away?.() ?? null;
    if (away === null) throw new ExtError("UNAVAILABLE", "the browser window is not open");
    return away;
  }

  #extSpace(group: TabGroupInfo, browser: ExtensionBrowserHost): ExtSpace {
    // A space with no name of its own (a Home tab's) is called by its tab.
    const first = group.tabIds[0] === undefined ? null : browser.tab(group.tabIds[0]);
    const tabs = group.tabIds.flatMap((tabId) => {
      const tab = browser.tab(tabId);
      return tab !== null && this.#visible(tab) ? [tab] : [];
    });
    return {
      id: group.id,
      name: group.title.trim() !== "" ? group.title : (first?.title ?? ""),
      color: group.color ?? null,
      tabIds: tabs.map((tab) => tab.id),
      lastActiveAt: tabs.reduce((latest, tab) => Math.max(latest, tab.lastActiveAt), 0),
      // (A host that cannot say takes every space as the person's: nothing is filed on a guess.)
      byPerson: group.loose === true || group.anchorId !== undefined || (browser.personsSpace?.(group.id) ?? true),
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
