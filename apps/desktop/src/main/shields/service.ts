/**
 * Shields (docs/shields.md): ad, tracker, and privacy protection for every
 * Space session and every human tab.
 *
 * - The engine: Ghostery's filter engine (MPL-2.0), built from the lists in
 *   the cache by a utility process and deserialized here (~10 ms). Main never
 *   parses a list. Until the first engine is ready, requests pass — Shields
 *   fails open, never closed.
 * - Requests: one set of handlers per session on the RequestHub — tracking
 *   parameters, bounce pages, HTTPS upgrades, dangerous pages, the blocking
 *   engine; then headers: Global Privacy Control, referrer trimming,
 *   cross-site cookies, `<a ping>`, `$csp`.
 * - Pages: the tab preload asks (synchronously, at document start) for the
 *   page's hiding CSS, scriptlets, and protections, and later for the generic
 *   CSS its DOM calls for.
 * - Per site: an exception lowers everything here for that site and its
 *   subdomains. Global Privacy Control is not a Shields knob there, as in
 *   Brave: it is a statement about the person, not a protection of the page.
 */

import { randomBytes, createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  utilityProcess,
  type CallbackResponse,
  type OnBeforeRequestListenerDetails,
  type OnBeforeSendHeadersListenerDetails,
  type OnHeadersReceivedListenerDetails,
  type Session,
  type WebContents,
  type WebFrameMain,
} from "electron";
import { ENGINE_VERSION, FiltersEngine, Request, type RequestType } from "@ghostery/adblocker";
import { parse as parseUrl } from "tldts";
import {
  dangerFilterLists,
  effectiveFilterLists,
  FILTER_LIST_IDS,
  filterList,
  shieldsExceptionFor,
  shieldsSiteKey,
  type FilterListId,
  type ShieldsRequest,
  type ShieldsSettings,
  type ShieldsSiteState,
  type ShieldsStatus,
  type ShieldsWebRtc,
} from "@pistachio/shell-contracts/shields";
import { MAX_DOM_FEATURES, type ShieldsDomFeatures, type ShieldsFrameBootstrap } from "@pistachio/shell-contracts/shields-page";
import { checksum, engineEnv } from "./compile";
import type { CompileJob, CompileReply } from "./compile-worker";
import { interstitialHtml, proceedHtml, type InterstitialPage } from "./interstitial";
import { ListStore, RESOURCES_ID, type FetchLike } from "./lists";
import { HUB_PRIORITY, RequestHub } from "./request-hub";
import { ShieldsSiteStore } from "./site-store";
import { bounceDestination, chromeUserAgent, httpsUpgradeFor, isCrossSite, referrerFor, siteOf, stripTrackingParams } from "./url-rules";

/** How often lists are checked for staleness while the app runs. */
const CHECK_EVERY_MS = 60 * 60_000;
/** The first check waits this long after launch, so startup is not competing with it. */
const FIRST_CHECK_MS = 5_000;
const COMPILE_TIMEOUT_MS = 120_000;
/** Bumped when compile.ts changes what it builds from the same lists. */
const COMPILER_REVISION = 2;
const MAX_BLOCKED_HOSTS = 200;
/** Net errors after which an upgraded page falls back to HTTP: the site, not the network, failed. */
const NO_FALLBACK = new Set([-3, -20, -21, -105, -106, -137]);

/** What the header handlers act on: pages and their requests, and WebSocket handshakes (which carry cookies too). */
const WEB_OR_SOCKET = /^(https?|wss?):/;

const WEBRTC_RANK: Record<ShieldsWebRtc, number> = { default: 0, public: 1, proxied: 2 };
const WEBRTC_POLICY = {
  default: "default",
  public: "default_public_interface_only",
  proxied: "disable_non_proxied_udp",
} as const;

export interface ShieldsServiceOptions {
  /** `<userData>/shields`. */
  directory: string;
  settings: () => ShieldsSettings;
  fetch: FetchLike;
  workerPath: string;
  /** Under E2E nothing is fetched: only the person's own filters compile. */
  offline: boolean;
  /** The page a tab's webContents shows — the top-level address requests are judged against. */
  topUrlFor: (webContentsId: number) => string | null;
  /** A tab's Shields picture changed (its counts, its upgrade): its site popover should redraw. */
  onPageChanged: (webContentsId: number) => void;
  /** The engine or the lists changed: an open settings page should ask again. */
  onStatusChanged?: () => void;
  /** The least WebRTC may be held to whatever Shields says (identity egress needs `proxied`). */
  webRtcFloor: () => ShieldsWebRtc;
}

interface PageStats {
  blocked: number;
  hosts: Map<string, number>;
  cleaned: number;
  upgraded: boolean;
}

interface EngineMeta {
  key: string;
  networkFilters: number;
  cosmeticFilters: number;
  dangerFilters: number;
  compiledAt: number;
  customErrors: string[];
}

export class ShieldsService {
  readonly #options: ShieldsServiceOptions;
  readonly #lists: ListStore;
  readonly #sites: ShieldsSiteStore;
  readonly #enginePath: string;
  readonly #dangerPath: string;
  readonly #metaPath: string;
  #settings: ShieldsSettings;
  #engine: FiltersEngine | null = null;
  #danger: FiltersEngine | null = null;
  #meta: EngineMeta | null = null;
  #engineState: ShieldsStatus["engine"]["state"] = "loading";
  #engineError: string | null = null;
  #compiling: Promise<void> | null = null;
  #recompileQueued = false;
  #timer: NodeJS.Timeout | null = null;
  #lastCheckedAt: number | null = null;
  /** This run's fingerprinting key: seeds differ per site, and per run. */
  readonly #fingerprintKey = randomBytes(32);
  readonly #seeds = new Map<string, number>();
  readonly #sessions = new Set<Session>();
  readonly #userAgents = new WeakMap<Session, string>();
  readonly #contents = new Map<number, WebContents>();
  readonly #pages = new Map<number, PageStats>();
  /** A main-frame redirect Shields made, so the page it lands on keeps the count. */
  readonly #redirecting = new Map<number, { target: string; cleaned: number; upgraded: boolean }>();
  /** Upgraded navigations not yet answered: contents → the http address it came from. */
  readonly #upgrades = new Map<number, { host: string; httpUrl: string }>();
  /** Under HTTPS-Only, a site's redirect back to http:// — warned about, not followed. */
  readonly #downgrades = new Map<number, string>();
  /** Hosts that fell back to HTTP on their own this run (Upgrade: failed over HTTPS, or redirected back). */
  readonly #httpFallbacks = new Set<string>();
  /** Hosts the person let through to HTTP from the warning this run. HTTPS-Only honors only these. */
  readonly #httpApproved = new Set<string>();
  /** Hosts let through the dangerous-site warning this run. */
  readonly #allowedDanger = new Set<string>();
  readonly #tokens = new Map<string, InterstitialPage & { expires: number }>();
  readonly #notifyTimers = new Map<number, NodeJS.Timeout>();

  constructor(options: ShieldsServiceOptions) {
    this.#options = options;
    mkdirSync(options.directory, { recursive: true });
    this.#lists = new ListStore(options.directory, options.fetch);
    this.#sites = new ShieldsSiteStore(options.directory);
    this.#enginePath = join(options.directory, "engine.bin");
    this.#dangerPath = join(options.directory, "danger.bin");
    this.#metaPath = join(options.directory, "engine.json");
    this.#settings = options.settings();
  }

  /* ------------------------------- lifecycle ------------------------------- */

  /**
   * Load the cached engine (or build one from the cached lists), then keep
   * the lists fresh. A cached build loads in milliseconds and is awaited, so
   * the first page is covered; a fresh compile is not — the window does not
   * wait on the worker, and pages load unprotected for the second it takes.
   */
  async start(): Promise<void> {
    const ready = this.#ensureEngine();
    await Promise.race([ready, new Promise<void>((resolve) => setTimeout(resolve, 400).unref())]);
    if (this.#options.offline) return;
    const first = setTimeout(() => void this.#check(false), FIRST_CHECK_MS);
    first.unref();
    this.#timer = setInterval(() => void this.#check(false), CHECK_EVERY_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#sites.flush();
  }

  flush(): void {
    this.#sites.flush();
  }

  /** The settings changed: rebuild what depends on them. */
  applySettings(next: ShieldsSettings): void {
    const previous = this.#settings;
    this.#settings = next;
    // A list switched on that was never fetched does not change the engine's
    // key (only cached lists are in it): it is fetched now, not at the next
    // hourly check.
    const wanted = this.#sources(next).filter((id) => !this.#sources(previous).includes(id));
    if (this.#engineKey(previous) !== this.#engineKey(next)) {
      void this.#ensureEngine().then(() => {
        if (!this.#options.offline) void this.#check(false);
      });
    } else if (wanted.length > 0 && !this.#options.offline) {
      void this.#check(false);
    }
    if (previous.webRtc !== next.webRtc || previous.enabled !== next.enabled) {
      for (const contents of this.#contents.values()) this.#applyWebRtc(contents);
    }
    if (previous.fingerprinting !== next.fingerprinting || previous.enabled !== next.enabled) {
      for (const session of this.#sessions) this.#applyUserAgent(session);
      // A session's user agent reaches only pages created after it is set;
      // the tabs already open take it one by one.
      for (const contents of this.#contents.values()) {
        const original = contents.isDestroyed() ? undefined : this.#userAgents.get(contents.session);
        if (original !== undefined) contents.setUserAgent(this.#userAgentFor(original));
      }
    }
    if (previous.enabled !== next.enabled) for (const session of this.#sessions) this.#wire(session);
    this.#notifyAll();
    this.#options.onStatusChanged?.();
  }

  /** Every open page's site controls show the settings and exceptions as they now are. */
  #notifyAll(): void {
    for (const contentsId of this.#contents.keys()) this.#notify(contentsId);
  }

  /* --------------------------- sessions and tabs --------------------------- */

  /** Whether a session is one Shields protect (a Space's): its pages may ask for their bootstrap. */
  covers(session: Session): boolean {
    return this.#sessions.has(session);
  }

  /** Protect a Space session: its request handlers, and its user agent. */
  attachSession(session: Session): void {
    this.#sessions.add(session);
    if (!this.#userAgents.has(session)) this.#userAgents.set(session, session.getUserAgent());
    this.#applyUserAgent(session);
    this.#wire(session);
  }

  /**
   * The session's request handlers — registered only while Shields are on,
   * so that off, no request takes the extra trips through this process.
   */
  #wire(session: Session): void {
    const hub = RequestHub.for(session);
    if (!this.#settings.enabled) {
      hub.onBeforeRequest("shields", null);
      hub.onBeforeSendHeaders("shields", null);
      hub.onHeadersReceived("shields", null);
      hub.onBeforeRedirect("shields", null);
      return;
    }
    hub.onBeforeRequest("shields", { priority: HUB_PRIORITY.shields, handler: (details) => this.#beforeRequest(details) });
    hub.onBeforeSendHeaders("shields", {
      priority: HUB_PRIORITY.shields,
      handler: (details, headers) => this.#sendHeaders(details, headers),
    });
    hub.onHeadersReceived("shields", {
      priority: HUB_PRIORITY.shields,
      handler: (details, headers) => this.#headersReceived(details, headers),
    });
    hub.onBeforeRedirect("shields", {
      priority: HUB_PRIORITY.shields,
      types: ["mainFrame"],
      handler: (details) => this.#beforeRedirect(details.url, details.redirectURL, details.webContentsId),
    });
  }

  /** A human tab's page: WebRTC policy, and its counts. */
  attachContents(contents: WebContents): void {
    const id = contents.id;
    if (this.#contents.has(id)) return;
    this.#contents.set(id, contents);
    this.#applyWebRtc(contents);
    contents.once("destroyed", () => {
      this.#contents.delete(id);
      this.#pages.delete(id);
      this.#redirecting.delete(id);
      this.#upgrades.delete(id);
      this.#downgrades.delete(id);
      const timer = this.#notifyTimers.get(id);
      if (timer !== undefined) clearTimeout(timer);
      this.#notifyTimers.delete(id);
    });
  }

  /** Re-apply WebRTC policy to every tab (identity egress turned on or off). */
  refreshWebRtc(): void {
    for (const contents of this.#contents.values()) this.#applyWebRtc(contents);
  }

  /** The page's WebRTC policy: Shields' setting, unless they are down for the page's site; never below the egress floor. */
  #applyWebRtc(contents: WebContents, url = contents.isDestroyed() ? "" : contents.getURL()): void {
    if (contents.isDestroyed()) return;
    const down = /^https?:/.test(url) && this.#exceptionFor(url) !== null;
    const wanted: ShieldsWebRtc = this.#settings.enabled && !down ? this.#settings.webRtc : "default";
    const floor = this.#options.webRtcFloor();
    const policy = WEBRTC_RANK[floor] > WEBRTC_RANK[wanted] ? floor : wanted;
    contents.setWebRTCIPHandlingPolicy(WEBRTC_POLICY[policy]);
  }

  /**
   * Electron's user agent names the app and Electron (`Pistachio/0.0.29 …
   * Electron/43.4.1`): a rare string any site can read, and one some sites
   * refuse. With fingerprinting protection on, the session reports what
   * Chrome of the same version reports.
   */
  #applyUserAgent(session: Session): void {
    const original = this.#userAgents.get(session);
    if (original !== undefined) session.setUserAgent(this.#userAgentFor(original));
  }

  #userAgentFor(original: string): string {
    const reduce = this.#settings.enabled && this.#settings.fingerprinting !== "off";
    return reduce ? chromeUserAgent(original) : original;
  }

  /* -------------------------------- requests ------------------------------- */

  #beforeRequest(details: OnBeforeRequestListenerDetails): CallbackResponse | undefined {
    const settings = this.#settings;
    if (!settings.enabled) return undefined;
    const { url, resourceType } = details;
    if (!url.startsWith("http") && !url.startsWith("ws")) return undefined;
    const contentsId = details.webContentsId;
    const isMain = resourceType === "mainFrame";
    if (isMain && contentsId !== undefined) this.#beginPage(contentsId, url);
    const topUrl = isMain ? url : this.#topUrl(details);
    if (topUrl !== null && this.#exceptionFor(topUrl) !== null) return undefined;

    if (isMain || resourceType === "subFrame") {
      const redirect = this.#documentRedirect(details, isMain, settings);
      if (redirect !== undefined) return redirect;
    }
    if (settings.blocking === "off" || this.#engine === null) return undefined;
    // A page is never blocked by the ad and tracker lists — only by the
    // Security ones, above — but its address is cleaned by their $removeparam.
    if (isMain) {
      if (details.method !== "GET") return undefined;
      const rewrite = this.#engine.match(shieldsRequest(url, url, "main_frame")).rewrite?.url;
      if (rewrite === undefined || rewrite === url) return undefined;
      if (contentsId !== undefined) this.#carry(contentsId, rewrite, { cleaned: 1 });
      this.#sites.count("cleaned");
      return { redirectURL: rewrite };
    }

    const frameUrl = frameUrlOf(details) ?? topUrl ?? details.referrer;
    const request = shieldsRequest(url, frameUrl, resourceType, { requestId: String(details.id), tabId: contentsId ?? -1 });
    if (request.type === "other") request.guessTypeOfRequest();
    const result = this.#engine.match(request);
    if (result.match && result.filter !== undefined) {
      // Standard: a request to the site being visited goes through unless the
      // filter insists — $important, or written for first parties only. The
      // site is the top-level page's: a third-party frame's requests to its
      // own host are still third-party to the person.
      const filter = result.filter;
      const lenient =
        settings.blocking === "standard" &&
        !isCrossSite(url, topUrl ?? frameUrl) &&
        !filter.isImportant() &&
        !(filter.firstParty() && !filter.thirdParty());
      if (!lenient) {
        this.#countBlocked(contentsId, request.hostname);
        if (result.redirect !== undefined) return { redirectURL: result.redirect.dataUrl };
        return { cancel: true };
      }
    }
    if (result.rewrite?.url !== undefined && result.rewrite.url !== url && resourceType !== "webSocket") {
      return { redirectURL: result.rewrite.url };
    }
    return undefined;
  }

  /** Bounce pages, tracking parameters, the HTTPS upgrade, and dangerous pages — for documents. */
  #documentRedirect(details: OnBeforeRequestListenerDetails, isMain: boolean, settings: ShieldsSettings): CallbackResponse | undefined {
    const { url } = details;
    const contentsId = details.webContentsId;
    if (isMain && contentsId !== undefined) {
      const refused = this.#downgrades.get(contentsId);
      this.#downgrades.delete(contentsId);
      if (refused === url && settings.https === "strict") {
        const token = this.#token({ kind: "insecure", url, list: null });
        return { redirectURL: `pistachio://shields/insecure?t=${token}` };
      }
    }
    if (details.method === "GET") {
      const bounce = isMain && settings.bounceTracking ? bounceDestination(url) : null;
      const target = bounce ?? stripTrackingParams(url, settings.trackingParams);
      if (target !== null) {
        if (isMain && contentsId !== undefined) this.#carry(contentsId, target, { cleaned: 1 });
        this.#sites.count("cleaned");
        return { redirectURL: target };
      }
    }
    // GET only: a fallback reloads the http:// address, which would turn a
    // form POST into a GET and lose what was submitted.
    if (isMain && settings.https !== "off" && details.method === "GET") {
      const exempt = { has: (host: string) => this.#httpApproved.has(host) || (settings.https === "upgrade" && this.#httpFallbacks.has(host)) };
      const upgraded = httpsUpgradeFor(url, exempt);
      if (upgraded !== null) {
        if (contentsId !== undefined) {
          this.#upgrades.set(contentsId, { host: new URL(url).hostname, httpUrl: url });
          this.#carry(contentsId, upgraded, { upgraded: true });
        }
        return { redirectURL: upgraded };
      }
    }
    if (this.#danger !== null) {
      const host = hostnameOf(url);
      if (host !== "" && !this.#allowedDanger.has(host)) {
        const result = this.#danger.match(shieldsRequest(url, url, isMain ? "main_frame" : "sub_frame"));
        if (result.match) {
          this.#countBlocked(contentsId, host);
          if (!isMain) return { cancel: true };
          const token = this.#token({ kind: "danger", url, list: this.#dangerListName() });
          return { redirectURL: `pistachio://shields/blocked?t=${token}` };
        }
      }
    }
    return undefined;
  }

  #sendHeaders(details: OnBeforeSendHeadersListenerDetails, headers: Record<string, string>): "cancel" | void {
    const settings = this.#settings;
    const { url, resourceType } = details;
    const contentsId = details.webContentsId;
    if (!settings.enabled || !WEB_OR_SOCKET.test(url)) return;
    // GPC speaks for the person, not for the page: it is sent where Shields are down too.
    if (settings.globalPrivacyControl) headers["Sec-GPC"] = "1";
    const isMain = resourceType === "mainFrame";
    const topUrl = isMain ? url : (this.#topUrl(details) ?? details.referrer);
    if (topUrl !== "" && this.#exceptionFor(topUrl) !== null) return;
    if (settings.blockPings && resourceType === "ping" && headerKey(headers, "ping-to") !== null) {
      this.#countBlocked(contentsId, hostnameOf(url));
      return "cancel";
    }
    const refererKey = headerKey(headers, "referer");
    if (refererKey !== null) {
      const next = referrerFor(headers[refererKey] ?? "", url, settings.referrer);
      if (next === null) delete headers[refererKey];
      else if (next !== undefined) headers[refererKey] = next;
    }
    if (settings.crossSiteCookies !== "allow" && !isMain && topUrl !== "") {
      const cookieKey = headerKey(headers, "cookie");
      if (cookieKey !== null && isCrossSite(url, topUrl) && (settings.crossSiteCookies === "all" || this.#isTracker(url, resourceType, topUrl))) {
        delete headers[cookieKey];
      }
    }
  }

  #headersReceived(details: OnHeadersReceivedListenerDetails, headers: Record<string, string[]>): "cancel" | void {
    const settings = this.#settings;
    const { url, resourceType } = details;
    const contentsId = details.webContentsId;
    if (!settings.enabled || !WEB_OR_SOCKET.test(url)) return;
    const isMain = resourceType === "mainFrame";
    if (isMain && contentsId !== undefined) {
      const upgrade = this.#upgrades.get(contentsId);
      // The site answered over HTTPS with a page: the upgrade held. A redirect
      // is not an answer yet — onBeforeRedirect (which Electron fires after
      // this) still has to see whether it sends the browser back to http://.
      const redirect = details.statusCode >= 300 && details.statusCode < 400;
      if (upgrade !== undefined && !redirect && url.startsWith("https:") && hostnameOf(url) === upgrade.host) {
        this.#upgrades.delete(contentsId);
        this.#sites.count("upgraded");
      }
    }
    const topUrl = isMain ? url : this.#topUrl(details);
    if (topUrl !== null && this.#exceptionFor(topUrl) !== null) return;
    if ((isMain || resourceType === "subFrame") && settings.blocking !== "off" && this.#engine !== null) {
      // Asked as a document: Ghostery answers $csp for main frames only, and
      // a framed document takes a policy just as a page does (uBO applies it
      // to both). Judged from the page that embeds it.
      const csp = this.#engine.getCSPDirectives(shieldsRequest(url, topUrl ?? url, "main_frame"));
      if (csp !== undefined && csp !== "") headers["Content-Security-Policy"] = [...(headers["Content-Security-Policy"] ?? []), csp];
    }
    if (settings.crossSiteCookies !== "allow" && !isMain && topUrl !== null && isCrossSite(url, topUrl)) {
      const key = Object.keys(headers).find((name) => name.toLowerCase() === "set-cookie");
      if (key !== undefined && (settings.crossSiteCookies === "all" || this.#isTracker(url, resourceType, topUrl))) delete headers[key];
    }
  }

  /**
   * A page's server redirect. The page it lands on keeps this one's counts.
   * And a site that answered the upgrade by sending the browser back to
   * http:// does not want HTTPS: it is not upgraded again this run (else the
   * two would bounce until Chromium gave up) — under HTTPS-Only, only once
   * the person continues from the warning. An upgrade that redirects to
   * another https:// host is watched there instead.
   */
  #beforeRedirect(from: string, to: string, contentsId: number | undefined): void {
    if (contentsId === undefined) return;
    const page = this.#pages.get(contentsId);
    if (page !== undefined) this.#carry(contentsId, to, {});
    const upgrade = this.#upgrades.get(contentsId);
    if (upgrade === undefined || !from.startsWith("https:") || hostnameOf(from) !== upgrade.host) return;
    if (to.startsWith("http:")) {
      this.#upgrades.delete(contentsId);
      // HTTPS-Only asks first: the http:// page it was sent to gets the warning.
      if (this.#settings.https === "strict") {
        this.#downgrades.set(contentsId, to);
        return;
      }
      this.#httpFallbacks.add(upgrade.host);
      this.#httpFallbacks.add(hostnameOf(to));
    } else if (to.startsWith("https:")) {
      this.#upgrades.set(contentsId, { host: hostnameOf(to), httpUrl: `http:${to.slice("https:".length)}` });
    }
  }

  /** Whether a filter names this request as a tracker — even one an exception let through. */
  #isTracker(url: string, resourceType: string, topUrl: string): boolean {
    if (this.#engine === null) return false;
    const result = this.#engine.match(shieldsRequest(url, topUrl, resourceType));
    return result.filter !== undefined && !result.filter.isRedirect();
  }

  /**
   * A main-frame load failed. When it was an HTTPS upgrade the site could not
   * answer, fall back to HTTP — or, under HTTPS-Only, warn first. True when
   * Shields took over the tab (the controller shows no error page then).
   */
  navigationFailed(contents: WebContents, url: string, code: number): boolean {
    const upgrade = this.#upgrades.get(contents.id);
    if (upgrade === undefined || NO_FALLBACK.has(code) || !url.startsWith("https:") || hostnameOf(url) !== upgrade.host) return false;
    this.#upgrades.delete(contents.id);
    const httpUrl = `http:${url.slice("https:".length)}`;
    if (this.#settings.https === "strict") {
      const token = this.#token({ kind: "insecure", url: httpUrl, list: null });
      void contents.loadURL(`pistachio://shields/insecure?t=${token}`).catch(() => undefined);
    } else {
      this.#httpFallbacks.add(upgrade.host);
      void contents.loadURL(httpUrl).catch(() => undefined);
    }
    return true;
  }

  /* ------------------------------ page content ----------------------------- */

  /**
   * What the tab preload runs at a frame's document start, or null when
   * Shields leave the frame alone. `topUrl` is the site being visited: its
   * exception lowers Shields in every frame of the page, and its seed is the
   * whole page's, so a frame cannot read different noise than its page. An
   * about:, blob:, or data: frame gets the protections and nothing else.
   */
  frameBootstrap(url: string, topUrl: string = url): ShieldsFrameBootstrap | null {
    const settings = this.#settings;
    const web = /^https?:/.test(url);
    if (!settings.enabled || !/^https?:/.test(topUrl) || !(web || /^(about|blob|data):/.test(url))) return null;
    const exception = this.#exceptionFor(topUrl) !== null;
    const protections = {
      globalPrivacyControl: settings.globalPrivacyControl,
      fingerprinting: exception ? ("off" as const) : settings.fingerprinting,
      seed: this.#seedFor(topUrl),
    };
    if (exception || !web) return { styles: "", scripts: [], watchDom: false, protections };
    let styles = "";
    let scripts: string[] = [];
    let watchDom = false;
    if (settings.blocking !== "off" && this.#engine !== null) {
      const { hostname, domain } = parseUrl(url);
      const cosmetics = this.#engine.getCosmeticsFilters({
        url,
        hostname: hostname ?? "",
        domain: domain ?? "",
        getBaseRules: true,
        getInjectionRules: true,
        getExtendedRules: false,
        getRulesFromHostname: true,
        getRulesFromDOM: false,
      });
      if (cosmetics.active) {
        styles = cosmetics.styles;
        scripts = cosmetics.scripts;
        watchDom = true;
      }
    }
    return { styles, scripts, watchDom, protections };
  }

  /** The generic hiding CSS for classes, ids, and links a frame's DOM grew. */
  cosmetics(url: string, features: ShieldsDomFeatures, topUrl: string = url): string {
    const settings = this.#settings;
    if (!settings.enabled || settings.blocking === "off" || this.#engine === null || !/^https?:/.test(url)) return "";
    if (this.#exceptionFor(topUrl) !== null) return "";
    const clip = (values: unknown): string[] =>
      Array.isArray(values) ? values.filter((value): value is string => typeof value === "string" && value.length <= 1_000).slice(0, MAX_DOM_FEATURES) : [];
    const { hostname, domain } = parseUrl(url);
    const result = this.#engine.getCosmeticsFilters({
      url,
      hostname: hostname ?? "",
      domain: domain ?? "",
      classes: clip(features.classes),
      ids: clip(features.ids),
      hrefs: clip(features.hrefs),
      getBaseRules: false,
      getInjectionRules: false,
      getExtendedRules: false,
      getRulesFromHostname: false,
      getRulesFromDOM: true,
    });
    return result.active ? result.styles : "";
  }

  /** Per site as the cookie rules count sites — private suffixes included, so alice.github.io and bob.github.io differ. */
  #seedFor(url: string): number {
    const site = siteOf(hostnameOf(url));
    let seed = this.#seeds.get(site);
    if (seed === undefined) {
      seed = createHmac("sha256", this.#fingerprintKey).update(site).digest().readUInt32LE(0);
      this.#seeds.set(site, seed);
    }
    return seed;
  }

  /* ------------------------------- per page -------------------------------- */

  #beginPage(contentsId: number, url: string): void {
    const carried = this.#redirecting.get(contentsId);
    this.#redirecting.delete(contentsId);
    const keep = carried !== undefined && carried.target === url;
    this.#pages.set(contentsId, {
      blocked: 0,
      hosts: new Map(),
      cleaned: keep ? carried.cleaned : 0,
      upgraded: keep ? carried.upgraded : false,
    });
    const contents = this.#contents.get(contentsId);
    if (contents !== undefined) this.#applyWebRtc(contents, url);
    // A new navigation that is not the upgrade's own landing ends the upgrade's watch.
    const upgrade = this.#upgrades.get(contentsId);
    if (upgrade !== undefined && !(keep && url.startsWith("https:") && hostnameOf(url) === upgrade.host)) this.#upgrades.delete(contentsId);
    this.#notify(contentsId);
  }

  #carry(contentsId: number, target: string, add: { cleaned?: number; upgraded?: boolean }): void {
    const page = this.#pages.get(contentsId);
    const previous = this.#redirecting.get(contentsId);
    this.#redirecting.set(contentsId, {
      target,
      cleaned: (page?.cleaned ?? 0) + (add.cleaned ?? 0),
      upgraded: (page?.upgraded ?? false) || (add.upgraded ?? false) || (previous?.upgraded ?? false),
    });
  }

  #countBlocked(contentsId: number | undefined, host: string): void {
    this.#sites.count("blocked");
    if (contentsId === undefined) return;
    const page = this.#pages.get(contentsId);
    if (page === undefined) return;
    page.blocked += 1;
    if (page.hosts.has(host) || page.hosts.size < MAX_BLOCKED_HOSTS) page.hosts.set(host, (page.hosts.get(host) ?? 0) + 1);
    this.#notify(contentsId);
  }

  #notify(contentsId: number): void {
    if (this.#notifyTimers.has(contentsId)) return;
    const timer = setTimeout(() => {
      this.#notifyTimers.delete(contentsId);
      this.#options.onPageChanged(contentsId);
    }, 250);
    timer.unref();
    this.#notifyTimers.set(contentsId, timer);
  }

  /** The site popover's picture of a tab. */
  siteState(contentsId: number, url: string): ShieldsSiteState {
    const settings = this.#settings;
    const page = this.#pages.get(contentsId);
    const web = /^https?:/.test(url);
    const exception = web ? this.#exceptionFor(url) : null;
    return {
      active: settings.enabled && web && exception === null,
      globallyOff: !settings.enabled,
      exception,
      siteKey: web ? shieldsSiteKey(url) : "",
      level: settings.level,
      blocked: page?.blocked ?? 0,
      blockedHosts: [...(page?.hosts.entries() ?? [])]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([host, count]) => ({ host, count })),
      cleaned: page?.cleaned ?? 0,
      upgraded: page?.upgraded ?? false,
    };
  }

  /* ------------------------------ exceptions ------------------------------- */

  #exceptionFor(url: string): string | null {
    const host = hostnameOf(url);
    return host === "" ? null : shieldsExceptionFor(host, this.#sites.exceptionKeys());
  }

  /**
   * Lower or raise Shields on a site. Raising takes away every exception
   * that covers the site — a key of its own, or one for a parent domain —
   * so the switch always ends where it was flipped.
   */
  setSite(site: string, enabled: boolean): void {
    if (enabled) {
      const host = site.includes("://") ? hostnameOf(site) : site;
      for (let exception = shieldsExceptionFor(host, this.#sites.exceptionKeys()); exception !== null; exception = shieldsExceptionFor(host, this.#sites.exceptionKeys())) {
        this.#sites.setSite(exception, true);
      }
      this.#sites.setSite(site, true);
    } else {
      this.#sites.setSite(site, false);
    }
    for (const contents of this.#contents.values()) this.#applyWebRtc(contents);
    this.#notifyAll();
    this.#options.onStatusChanged?.();
  }

  /* ------------------------------ interstitials ---------------------------- */

  #token(page: InterstitialPage): string {
    const now = Date.now();
    for (const [key, entry] of this.#tokens) if (entry.expires < now) this.#tokens.delete(key);
    const token = randomUUID();
    this.#tokens.set(token, { ...page, expires: now + 60 * 60_000 });
    return token;
  }

  /** The Security lists that could have named the page, for the warning's wording. */
  #dangerListName(): string {
    const names = dangerFilterLists(this.#settings).map((id) => filterList(id)?.name ?? id);
    return names.length === 0 ? "a security list" : names.join(" or ");
  }

  /** `pistachio://shields/*`: the warning pages, and the way through them. */
  respond(url: URL): Response | null {
    if (url.host !== "shields") return null;
    const entry = this.#tokens.get(url.searchParams.get("t") ?? "");
    if (entry === undefined) return new Response("This warning has expired. Go back and open the page again.", { status: 410 });
    const html = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (url.pathname === "/proceed") {
      const host = hostnameOf(entry.url);
      if (entry.kind === "danger") this.#allowedDanger.add(host);
      else this.#httpApproved.add(host);
      this.#tokens.delete(url.searchParams.get("t") ?? "");
      return html(proceedHtml(entry.url));
    }
    if ((url.pathname === "/blocked" && entry.kind === "danger") || (url.pathname === "/insecure" && entry.kind === "insecure")) {
      return html(interstitialHtml(entry, `pistachio://shields/proceed?t=${url.searchParams.get("t") ?? ""}`));
    }
    return new Response("Not found", { status: 404 });
  }

  /* ------------------------------ settings page ---------------------------- */

  async request(request: ShieldsRequest): Promise<ShieldsStatus> {
    switch (request.type) {
      case "status":
        break;
      case "updateLists":
        if (!this.#options.offline) await this.#check(true);
        break;
      case "setSite":
        this.setSite(request.site, request.enabled);
        break;
      case "resetStats":
        this.#sites.resetStats();
        break;
    }
    return this.status();
  }

  status(): ShieldsStatus {
    const active = new Set<FilterListId>([...effectiveFilterLists(this.#settings), ...dangerFilterLists(this.#settings)]);
    return {
      engine: {
        state: this.#settings.enabled ? this.#engineState : "off",
        networkFilters: this.#meta?.networkFilters ?? 0,
        cosmeticFilters: this.#meta?.cosmeticFilters ?? 0,
        compiledAt: this.#meta?.compiledAt ?? null,
        error: this.#engineError,
        customErrors: this.#meta?.customErrors ?? [],
      },
      lists: FILTER_LIST_IDS.map((id) => this.#lists.status(id, active.has(id))),
      updating: this.#lists.fetching,
      lastCheckedAt: this.#lastCheckedAt,
      exceptions: this.#sites.exceptions(),
      stats: this.#sites.stats(),
    };
  }

  /* --------------------------------- engine -------------------------------- */

  /** The person's own filters, while the blocking engine runs. */
  #customFilters(settings: ShieldsSettings): string {
    return settings.enabled && settings.blocking !== "off" ? settings.customFilters : "";
  }

  /** Whether the blocking engine needs uBO's resources: any list, or filters of the person's own (their scriptlets and redirects). */
  #needsResources(settings: ShieldsSettings): boolean {
    return effectiveFilterLists(settings).length > 0 || this.#customFilters(settings).trim() !== "";
  }

  /** Every list either engine needs, and the resources. */
  #sources(settings: ShieldsSettings): (FilterListId | typeof RESOURCES_ID)[] {
    const lists = [...new Set<FilterListId>([...effectiveFilterLists(settings), ...dangerFilterLists(settings)])];
    return this.#needsResources(settings) ? [...lists, RESOURCES_ID] : lists;
  }

  /** What the compiled engine is a function of. Two equal keys build the same engines. */
  #engineKey(settings: ShieldsSettings): string {
    const lists = effectiveFilterLists(settings).filter((id) => this.#lists.has(id));
    const danger = dangerFilterLists(settings).filter((id) => this.#lists.has(id));
    return JSON.stringify({
      engine: ENGINE_VERSION,
      compiler: COMPILER_REVISION,
      lists: lists.map((id) => `${id}@${this.#lists.version(id)}`),
      danger: danger.map((id) => `${id}@${this.#lists.version(id)}`),
      custom: checksum(this.#customFilters(settings)),
      resources: this.#needsResources(settings) ? this.#lists.version(RESOURCES_ID) : "",
    });
  }

  /** Fetch what is due (everything, when forced), and rebuild if any of it changed. */
  async #check(force: boolean): Promise<void> {
    const sources = this.#sources(this.#settings);
    this.#lastCheckedAt = Date.now();
    const due = force ? sources : this.#lists.due(sources);
    if (due.length === 0) return;
    this.#options.onStatusChanged?.();
    const changed = await this.#lists.refresh(due);
    if (changed.length > 0) await this.#ensureEngine();
    this.#options.onStatusChanged?.();
  }

  /** Make the running engines match the current key: load the cached build, or compile one. */
  async #ensureEngine(): Promise<void> {
    if (this.#compiling !== null) {
      this.#recompileQueued = true;
      return this.#compiling;
    }
    this.#compiling = this.#build().finally(() => {
      this.#compiling = null;
    });
    await this.#compiling;
    if (this.#recompileQueued) {
      this.#recompileQueued = false;
      await this.#ensureEngine();
    }
  }

  async #build(): Promise<void> {
    const settings = this.#settings;
    const key = this.#engineKey(settings);
    if (this.#meta?.key === key && this.#engine !== null) return;
    const lists = effectiveFilterLists(settings).filter((id) => this.#lists.has(id));
    const danger = dangerFilterLists(settings).filter((id) => this.#lists.has(id));
    const custom = this.#customFilters(settings);
    if (lists.length === 0 && danger.length === 0 && custom.trim() === "") {
      this.#engine = null;
      this.#danger = null;
      this.#meta = { key, networkFilters: 0, cosmeticFilters: 0, dangerFilters: 0, compiledAt: Date.now(), customErrors: [] };
      this.#engineState = this.#lists.fetching || this.#sources(settings).length > 0 ? "loading" : "ready";
      this.#options.onStatusChanged?.();
      return;
    }
    // A build of this exact key from an earlier run is on disk: deserialize it.
    const cached = this.#readMeta();
    if (cached?.key === key && existsSync(this.#enginePath)) {
      try {
        await this.#load(cached);
        return;
      } catch {
        // Corrupt, or from another engine version: rebuild below.
      }
    }
    this.#engineState = "compiling";
    this.#options.onStatusChanged?.();
    const job: CompileJob = {
      lists: lists.map((id) => ({ id, path: this.#lists.pathFor(id), trusted: filterList(id)?.trusted ?? false })),
      dangerLists: danger.map((id) => ({ id, path: this.#lists.pathFor(id), trusted: filterList(id)?.trusted ?? false })),
      customFilters: custom,
      resourcesPath: this.#needsResources(settings) && this.#lists.has(RESOURCES_ID) ? this.#lists.pathFor(RESOURCES_ID) : null,
      enginePath: this.#enginePath,
      dangerPath: this.#dangerPath,
    };
    try {
      const reply = await this.#compile(job);
      if (!reply.ok) throw new Error(reply.error);
      const meta: EngineMeta = {
        key,
        networkFilters: reply.networkFilters,
        cosmeticFilters: reply.cosmeticFilters,
        dangerFilters: reply.dangerFilters,
        compiledAt: Date.now(),
        customErrors: reply.customErrors,
      };
      writeFileSync(this.#metaPath, JSON.stringify(meta, null, 2));
      await this.#load(meta);
    } catch (error) {
      this.#engineState = this.#engine === null ? "failed" : "ready";
      this.#engineError = error instanceof Error ? error.message : String(error);
      console.error("[shields] compile failed", error);
      this.#options.onStatusChanged?.();
    }
  }

  async #load(meta: EngineMeta): Promise<void> {
    const engine = FiltersEngine.deserialize(new Uint8Array(await readFile(this.#enginePath)));
    engine.updateEnv(engineEnv());
    let danger: FiltersEngine | null = null;
    if (meta.dangerFilters > 0 && existsSync(this.#dangerPath)) {
      danger = FiltersEngine.deserialize(new Uint8Array(await readFile(this.#dangerPath)));
      danger.updateEnv(engineEnv());
    }
    this.#engine = engine;
    this.#danger = danger;
    this.#meta = meta;
    this.#engineState = "ready";
    this.#engineError = null;
    this.#options.onStatusChanged?.();
  }

  #compile(job: CompileJob): Promise<CompileReply> {
    return new Promise((resolve) => {
      const child = utilityProcess.fork(this.#options.workerPath, [], { serviceName: "Shields compiler", stdio: "pipe" });
      let settled = false;
      const finish = (reply: CompileReply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        resolve(reply);
      };
      const timer = setTimeout(() => finish({ ok: false, error: "the compile took too long" }), COMPILE_TIMEOUT_MS);
      child.stderr?.on("data", (chunk: Buffer) => console.error("[shields worker]", chunk.toString().trim()));
      child.on("message", (reply: CompileReply) => finish(reply));
      child.on("exit", (code) => finish({ ok: false, error: `the compiler exited (${String(code)})` }));
      child.postMessage(job);
    });
  }

  #readMeta(): EngineMeta | null {
    try {
      const raw = JSON.parse(readFileSync(this.#metaPath, "utf8")) as EngineMeta;
      return typeof raw.key === "string" ? raw : null;
    } catch {
      return null;
    }
  }

  /**
   * The site a request is made for. A service worker's requests carry no
   * frame and no page: its own script (the referrer) is on the site it
   * serves, so its exception reaches them too.
   */
  #topUrl(details: { frame?: WebFrameMain | null; webContentsId?: number; referrer?: string }): string | null {
    try {
      const top = details.frame?.top?.url;
      if (top !== undefined && top !== "") return top;
    } catch {
      // The frame went away while the request was in flight.
    }
    if (details.webContentsId !== undefined) return this.#options.topUrlFor(details.webContentsId);
    return details.referrer !== undefined && /^https?:/.test(details.referrer) ? details.referrer : null;
  }
}

/**
 * The address of the document that made the request — or, for an about:blank
 * or about:srcdoc frame, of the nearest ancestor it inherits its origin from,
 * so `$domain=` rules match in it as they do in its page.
 */
function frameUrlOf(details: OnBeforeRequestListenerDetails): string | null {
  try {
    let frame = details.frame ?? null;
    for (let depth = 0; frame !== null && depth < 16; depth += 1) {
      const url = frame.url;
      if (/^https?:/.test(url)) return url;
      if (!url.startsWith("about:") && url !== "") return null;
      frame = frame.parent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A request as the engine judges it, with its own and its source's domains
 * worked out the way the cookie rules count sites — private suffixes
 * included — so a rule's `$third-party` agrees with Shields on what a
 * different site is (alice.github.io and bob.github.io are two).
 */
function shieldsRequest(url: string, sourceUrl: string, type: string, extra: { requestId?: string; tabId?: number } = {}): Request {
  const hostname = hostnameOf(url);
  const sourceHostname = hostnameOf(sourceUrl);
  return Request.fromRawDetails({
    ...extra,
    url,
    hostname,
    domain: hostname === "" ? "" : siteOf(hostname),
    sourceUrl,
    sourceHostname,
    sourceDomain: sourceHostname === "" ? "" : siteOf(sourceHostname),
    type: type as RequestType,
  });
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** The header's key as the request spells it, or null. */
function headerKey(headers: Record<string, string>, name: string): string | null {
  for (const key of Object.keys(headers)) if (key.toLowerCase() === name) return key;
  return null;
}
