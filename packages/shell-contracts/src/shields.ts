/**
 * Shields (docs/shields.md): the browser's own ad, tracker, and privacy
 * protection — request blocking from community filter lists, element hiding,
 * scriptlets, and the protections around them (tracking parameters, bounce
 * tracking, cross-site cookies, fingerprinting, HTTPS, referrers, WebRTC,
 * Global Privacy Control).
 *
 * Shared by main, which enforces it in every Space session and every human
 * tab's page, and the shell, which only edits a copy (Settings → Privacy &
 * security → Ads & trackers, and the site popover's switch). The settings
 * live in `DesktopSettings.shields`; which sites have Shields down lives in
 * main's own file (main/shields/site-store.ts), the same split the site
 * permissions have.
 *
 * Pure on purpose — no Electron, no DOM — so vitest pins it under node.
 */

/* ------------------------------- the knobs ------------------------------- */

/**
 * A preset, the way Firefox's Enhanced Tracking Protection (which Zen ships
 * as-is) offers one: `standard` protects without breaking sites, `strict`
 * protects more and may break some, `custom` is whatever the person set. A
 * preset OWNS its knobs — a file that says `standard` gets the standard
 * values whatever else it holds, so a release that improves the preset
 * reaches everyone on it.
 */
export type ShieldsLevel = "standard" | "strict" | "custom";
export const SHIELDS_LEVELS: readonly ShieldsLevel[] = ["standard", "strict", "custom"];

/**
 * Ads and trackers, by request and by element. `standard` is Brave's
 * standard: a filter that matches a request to the page's own site is let
 * through unless the filter insists (`$important`, `$1p`), because that is
 * where nearly all breakage comes from. `aggressive` applies every filter as
 * written, the way uBlock Origin does.
 */
export type ShieldsBlocking = "off" | "standard" | "aggressive";
export const SHIELDS_BLOCKING: readonly ShieldsBlocking[] = ["off", "standard", "aggressive"];

/** Consent pop-ups: left alone, or hidden by the cookie-notice lists. */
export type ShieldsCookieBanners = "off" | "hide";
export const SHIELDS_COOKIE_BANNERS: readonly ShieldsCookieBanners[] = ["off", "hide"];

/**
 * Click identifiers in addresses (`fbclid`, `gclid`, …). `standard` removes
 * the ones that exist only to track; `strict` also removes campaign tags
 * (`utm_*`) and applies AdGuard's URL tracking list.
 */
export type ShieldsTrackingParams = "off" | "standard" | "strict";
export const SHIELDS_TRACKING_PARAMS: readonly ShieldsTrackingParams[] = ["off", "standard", "strict"];

/**
 * Cookies on requests to another site than the page's. `trackers` keeps
 * them from requests a filter list names as tracking (the ones an exception
 * let through); `all` keeps them from every cross-site request.
 */
export type ShieldsCrossSiteCookies = "allow" | "trackers" | "all";
export const SHIELDS_CROSS_SITE_COOKIES: readonly ShieldsCrossSiteCookies[] = ["allow", "trackers", "all"];

/**
 * Fingerprinting. `standard` adds per-site noise to what canvas, WebGL, and
 * audio read back and rounds the hardware the page can see, the way Brave
 * does; `strict` also removes the APIs that are mostly fingerprint (battery,
 * network information, voices) and reports the screen as the window.
 */
export type ShieldsFingerprinting = "off" | "standard" | "strict";
export const SHIELDS_FINGERPRINTING: readonly ShieldsFingerprinting[] = ["off", "standard", "strict"];

/**
 * `upgrade` loads http:// pages over HTTPS and quietly falls back when the
 * site has no HTTPS (Chrome's HTTPS-Upgrades); `strict` asks first instead
 * of falling back (HTTPS-Only).
 */
export type ShieldsHttps = "off" | "upgrade" | "strict";
export const SHIELDS_HTTPS: readonly ShieldsHttps[] = ["off", "upgrade", "strict"];

/**
 * The Referer header on requests to another site. Chromium already sends
 * only the origin cross-site unless the page asks for more; `trim` holds
 * every page to that, `strip` sends none.
 */
export type ShieldsReferrer = "default" | "trim" | "strip";
export const SHIELDS_REFERRER: readonly ShieldsReferrer[] = ["default", "trim", "strip"];

/**
 * Which network interfaces WebRTC may use (webContents.setWebRTCIPHandlingPolicy).
 * Chromium already hides local addresses behind mDNS names; `public` keeps
 * calls off every interface but the default route, `proxied` keeps WebRTC
 * off UDP unless a proxy carries it (calls without a TURN server fail).
 */
export type ShieldsWebRtc = "default" | "public" | "proxied";
export const SHIELDS_WEBRTC: readonly ShieldsWebRtc[] = ["default", "public", "proxied"];

/* ------------------------------ filter lists ----------------------------- */

export type FilterListCategory = "ads" | "privacy" | "security" | "annoyances";

interface FilterListEntry {
  id: string;
  name: string;
  category: FilterListCategory;
  description: string;
  /** Tried in order; the rest are mirrors of the first. */
  urls: readonly string[];
  homepage: string;
  /**
   * Maintained by uBlock Origin's own team: its `trusted-*` scriptlets run.
   * Every other list's are dropped at compile time, which is uBO's rule.
   */
  trusted: boolean;
  /** Refetched after this long unless the list's `! Expires:` says otherwise. */
  expiresHours: number;
}

export interface FilterListDefinition extends FilterListEntry {
  id: FilterListId;
}

const UBO = "https://ublockorigin.github.io/uAssets/filters";
const UBO_CDN = "https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssetsCDN@main/filters";

/**
 * Every list Shields can load. The defaults are uBlock Origin's defaults
 * (its own five lists, EasyList, EasyPrivacy, Peter Lowe's, and the
 * Malicious URL Blocklist); the rest are what uBO and Brave offer one switch
 * away. Lists are fetched from their maintainers at run time — never bundled
 * — and kept under userData (main/shields/lists.ts).
 */
export const FILTER_LISTS = [
  {
    id: "ubo-filters",
    name: "uBlock filters",
    category: "ads",
    description: "uBlock Origin's own list: ads EasyList misses, anti-adblock, and the scriptlets that defuse video ads.",
    urls: [`${UBO}/filters.min.txt`, `${UBO_CDN}/filters.min.txt`],
    homepage: "https://github.com/uBlockOrigin/uAssets",
    trusted: true,
    expiresHours: 120,
  },
  {
    id: "easylist",
    name: "EasyList",
    category: "ads",
    description: "The primary ad-blocking list, maintained since 2005 and used by nearly every blocker.",
    urls: ["https://easylist.to/easylist/easylist.txt", "https://ublockorigin.github.io/uAssets/thirdparties/easylist.txt"],
    homepage: "https://easylist.to/",
    trusted: false,
    expiresHours: 96,
  },
  {
    id: "ubo-quick-fixes",
    name: "uBlock filters – Quick fixes",
    category: "ads",
    description: "Short-lived fixes for sites that changed this week.",
    urls: [`${UBO}/quick-fixes.min.txt`, `${UBO_CDN}/quick-fixes.min.txt`],
    homepage: "https://github.com/uBlockOrigin/uAssets",
    trusted: true,
    expiresHours: 24,
  },
  {
    id: "ubo-unbreak",
    name: "uBlock filters – Unbreak",
    category: "ads",
    description: "Exceptions that undo what the other lists break. Leave on.",
    urls: [`${UBO}/unbreak.min.txt`, `${UBO_CDN}/unbreak.min.txt`],
    homepage: "https://github.com/uBlockOrigin/uAssets",
    trusted: true,
    expiresHours: 120,
  },
  {
    id: "adguard-base",
    name: "AdGuard Base",
    category: "ads",
    description: "AdGuard's ad list without its EasyList half. Overlaps the defaults; more coverage, more to load.",
    urls: ["https://filters.adtidy.org/extension/ublock/filters/2_without_easylist.txt"],
    homepage: "https://github.com/AdguardTeam/AdguardFilters",
    trusted: false,
    expiresHours: 96,
  },
  {
    id: "easyprivacy",
    name: "EasyPrivacy",
    category: "privacy",
    description: "Analytics, tracking pixels, and data collectors — EasyList's companion for tracking.",
    urls: ["https://easylist.to/easylist/easyprivacy.txt", "https://ublockorigin.github.io/uAssets/thirdparties/easyprivacy.txt"],
    homepage: "https://easylist.to/",
    trusted: false,
    expiresHours: 96,
  },
  {
    id: "ubo-privacy",
    name: "uBlock filters – Privacy",
    category: "privacy",
    description: "Trackers EasyPrivacy misses, and fixes for the ones it breaks.",
    urls: [`${UBO}/privacy.min.txt`, `${UBO_CDN}/privacy.min.txt`],
    homepage: "https://github.com/uBlockOrigin/uAssets",
    trusted: true,
    expiresHours: 120,
  },
  {
    id: "peter-lowe",
    name: "Peter Lowe's Ad and tracking server list",
    category: "privacy",
    description: "A small, conservative list of ad and tracking servers by hostname.",
    urls: ["https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext"],
    homepage: "https://pgl.yoyo.org/adservers/",
    trusted: false,
    expiresHours: 96,
  },
  {
    id: "adguard-tracking",
    name: "AdGuard Tracking Protection",
    category: "privacy",
    description: "AdGuard's large tracking list. Thorough, and slower to load than the rest together.",
    urls: ["https://filters.adtidy.org/extension/ublock/filters/3.txt"],
    homepage: "https://github.com/AdguardTeam/AdguardFilters",
    trusted: false,
    expiresHours: 96,
  },
  {
    id: "adguard-url-tracking",
    name: "AdGuard URL Tracking Protection",
    category: "privacy",
    description: "Removes tracking parameters from addresses, site by site. Strict tracking-parameter removal turns it on.",
    urls: ["https://filters.adtidy.org/extension/ublock/filters/17.txt"],
    homepage: "https://github.com/AdguardTeam/AdguardFilters",
    trusted: false,
    expiresHours: 96,
  },
  {
    id: "ubo-badware",
    name: "uBlock filters – Badware risks",
    category: "security",
    description: "Scam, fake-download, and malvertising sites. Blocks the page itself, with a way through.",
    urls: [`${UBO}/badware.min.txt`, `${UBO_CDN}/badware.min.txt`],
    homepage: "https://github.com/uBlockOrigin/uAssets",
    trusted: true,
    expiresHours: 120,
  },
  {
    id: "urlhaus",
    name: "Malicious URL Blocklist",
    category: "security",
    description: "Addresses abuse.ch's URLhaus has seen serving malware, updated daily.",
    urls: [
      "https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-ag-online.txt",
      "https://curbengh.github.io/malware-filter/urlhaus-filter-ag-online.txt",
    ],
    homepage: "https://gitlab.com/malware-filter/urlhaus-filter",
    trusted: false,
    expiresHours: 24,
  },
  {
    id: "easylist-cookie",
    name: "EasyList Cookie List",
    category: "annoyances",
    description: "Hides cookie-consent banners and overlays. Cookie banners: Hide turns it on.",
    urls: ["https://secure.fanboy.co.nz/fanboy-cookiemonster_ubo.txt"],
    homepage: "https://easylist.to/",
    trusted: false,
    expiresHours: 96,
  },
  {
    id: "ubo-cookie-annoyances",
    name: "uBlock filters – Cookie notices",
    category: "annoyances",
    description: "uBlock Origin's cookie-notice list, which EasyList's misses. Cookie banners: Hide turns it on.",
    urls: [`${UBO}/annoyances-cookies.txt`],
    homepage: "https://github.com/uBlockOrigin/uAssets",
    trusted: true,
    expiresHours: 120,
  },
  {
    id: "ubo-annoyances",
    name: "uBlock filters – Other annoyances",
    category: "annoyances",
    description: "Newsletter pop-ups, app nags, and sticky overlays.",
    urls: [`${UBO}/annoyances-others.txt`],
    homepage: "https://github.com/uBlockOrigin/uAssets",
    trusted: true,
    expiresHours: 120,
  },
  {
    id: "fanboy-social",
    name: "EasyList Social Widgets",
    category: "annoyances",
    description: "Share buttons and social embeds, which track whether or not you use them.",
    urls: ["https://easylist.to/easylist/fanboy-social.txt"],
    homepage: "https://easylist.to/",
    trusted: false,
    expiresHours: 96,
  },
] as const satisfies readonly FilterListEntry[];

export type FilterListId = (typeof FILTER_LISTS)[number]["id"];
export const FILTER_LIST_IDS: readonly FilterListId[] = FILTER_LISTS.map((list) => list.id);

export const FILTER_LIST_CATEGORIES: readonly { id: FilterListCategory; label: string }[] = [
  { id: "ads", label: "Ads" },
  { id: "privacy", label: "Privacy" },
  { id: "security", label: "Security" },
  { id: "annoyances", label: "Annoyances" },
];

export function filterList(id: string): FilterListDefinition | null {
  return (FILTER_LISTS as readonly FilterListDefinition[]).find((list) => list.id === id) ?? null;
}

/** What a list switch says, list by list. Every id is present. */
export type FilterListToggles = Record<FilterListId, boolean>;

/** Turned on by `cookieBanners: "hide"`, whatever their own switches say. */
export const COOKIE_NOTICE_LISTS: readonly FilterListId[] = ["easylist-cookie", "ubo-cookie-annoyances"];
/** Turned on by `trackingParams: "strict"`. */
export const URL_TRACKING_LISTS: readonly FilterListId[] = ["adguard-url-tracking"];
/** The lists whose matches block a PAGE (the interstitial), not only its requests. */
export const SECURITY_LISTS: readonly FilterListId[] = FILTER_LISTS.filter((list) => list.category === "security").map((list) => list.id);

const UBO_DEFAULT_LISTS: readonly FilterListId[] = [
  "ubo-filters",
  "easylist",
  "ubo-quick-fixes",
  "ubo-unbreak",
  "easyprivacy",
  "ubo-privacy",
  "peter-lowe",
  "ubo-badware",
  "urlhaus",
];

function toggles(on: readonly FilterListId[]): FilterListToggles {
  return Object.fromEntries(FILTER_LIST_IDS.map((id) => [id, on.includes(id)])) as FilterListToggles;
}

/* ------------------------------ the settings ----------------------------- */

/** The person's own filters, in uBlock Origin syntax. */
export const MAX_CUSTOM_FILTERS = 100_000;

export interface ShieldsSettings {
  /** The master switch: off, no page is touched and no list is fetched. */
  enabled: boolean;
  level: ShieldsLevel;
  blocking: ShieldsBlocking;
  /**
   * Which lists are on. A patch replaces the whole map (settings merge one
   * level deep), so the shell always sends every id.
   */
  lists: FilterListToggles;
  cookieBanners: ShieldsCookieBanners;
  trackingParams: ShieldsTrackingParams;
  /** Skip the redirect pages that only exist to log a click (google.com/url, l.facebook.com, …). */
  bounceTracking: boolean;
  crossSiteCookies: ShieldsCrossSiteCookies;
  fingerprinting: ShieldsFingerprinting;
  https: ShieldsHttps;
  /** Tell every site not to sell or share (Sec-GPC: 1, navigator.globalPrivacyControl). */
  globalPrivacyControl: boolean;
  referrer: ShieldsReferrer;
  webRtc: ShieldsWebRtc;
  /** Refuse `<a ping>` hyperlink-auditing requests. */
  blockPings: boolean;
  /** A page on a Security list is stopped before it loads, behind a warning with a way through. */
  dangerousSites: boolean;
  /** The person's own filters. Not part of any preset; kept across them. */
  customFilters: string;
}

type PresetKnobs = Omit<ShieldsSettings, "enabled" | "level" | "customFilters">;

export const SHIELDS_PRESETS: Record<Exclude<ShieldsLevel, "custom">, PresetKnobs> = {
  standard: {
    blocking: "standard",
    lists: toggles(UBO_DEFAULT_LISTS),
    cookieBanners: "off",
    trackingParams: "standard",
    bounceTracking: true,
    crossSiteCookies: "trackers",
    fingerprinting: "standard",
    https: "upgrade",
    globalPrivacyControl: true,
    referrer: "trim",
    webRtc: "default",
    blockPings: true,
    dangerousSites: true,
  },
  strict: {
    blocking: "aggressive",
    lists: toggles([...UBO_DEFAULT_LISTS, "ubo-annoyances", "fanboy-social"]),
    cookieBanners: "hide",
    trackingParams: "strict",
    bounceTracking: true,
    crossSiteCookies: "all",
    fingerprinting: "strict",
    https: "strict",
    globalPrivacyControl: true,
    referrer: "trim",
    webRtc: "public",
    blockPings: true,
    dangerousSites: true,
  },
};

export const DEFAULT_SHIELDS: ShieldsSettings = {
  enabled: true,
  level: "standard",
  ...SHIELDS_PRESETS.standard,
  customFilters: "",
};

/** The settings `level` stands for: a preset's knobs, or the stored ones under `custom`. */
export function applyShieldsLevel(settings: ShieldsSettings, level: ShieldsLevel): ShieldsSettings {
  if (level === "custom") return { ...settings, level };
  return { ...settings, ...structuredClone(SHIELDS_PRESETS[level]), level };
}

/** The preset these knobs are exactly, or "custom". */
export function matchingShieldsLevel(settings: ShieldsSettings): ShieldsLevel {
  for (const level of ["standard", "strict"] as const) {
    const preset = SHIELDS_PRESETS[level];
    const same = (Object.keys(preset) as (keyof PresetKnobs)[]).every((key) =>
      key === "lists"
        ? FILTER_LIST_IDS.every((id) => preset.lists[id] === settings.lists[id])
        : preset[key] === settings[key],
    );
    if (same) return level;
  }
  return "custom";
}

/**
 * The lists the blocking engine loads: the switched-on ones, plus what the
 * cookie-banner and tracking-parameter knobs bring with them. In catalog
 * order, so the compiled engine's key does not depend on click order.
 */
export function effectiveFilterLists(settings: ShieldsSettings): FilterListId[] {
  if (!settings.enabled || settings.blocking === "off") return [];
  const on = new Set<FilterListId>(FILTER_LIST_IDS.filter((id) => settings.lists[id]));
  if (settings.cookieBanners === "hide") for (const id of COOKIE_NOTICE_LISTS) on.add(id);
  if (settings.trackingParams === "strict") for (const id of URL_TRACKING_LISTS) on.add(id);
  return FILTER_LIST_IDS.filter((id) => on.has(id));
}

/**
 * The lists that stop a dangerous PAGE: the switched-on Security lists, while
 * that switch is on — whether or not ads are blocked.
 */
export function dangerFilterLists(settings: ShieldsSettings): FilterListId[] {
  if (!settings.enabled || !settings.dangerousSites) return [];
  return SECURITY_LISTS.filter((id) => settings.lists[id]);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Fold unknown JSON into valid Shields settings. Each knob falls back to the
 * default on its own; a preset level then overwrites the knobs it owns.
 */
export function sanitizeShields(input: unknown): ShieldsSettings {
  const raw = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const d = DEFAULT_SHIELDS;
  const rawLists = typeof raw["lists"] === "object" && raw["lists"] !== null ? (raw["lists"] as Record<string, unknown>) : {};
  const lists = Object.fromEntries(FILTER_LIST_IDS.map((id) => [id, bool(rawLists[id], d.lists[id])])) as FilterListToggles;
  const custom = raw["customFilters"];
  const settings: ShieldsSettings = {
    enabled: bool(raw["enabled"], d.enabled),
    level: oneOf(raw["level"], SHIELDS_LEVELS, d.level),
    blocking: oneOf(raw["blocking"], SHIELDS_BLOCKING, d.blocking),
    lists,
    cookieBanners: oneOf(raw["cookieBanners"], SHIELDS_COOKIE_BANNERS, d.cookieBanners),
    trackingParams: oneOf(raw["trackingParams"], SHIELDS_TRACKING_PARAMS, d.trackingParams),
    bounceTracking: bool(raw["bounceTracking"], d.bounceTracking),
    crossSiteCookies: oneOf(raw["crossSiteCookies"], SHIELDS_CROSS_SITE_COOKIES, d.crossSiteCookies),
    fingerprinting: oneOf(raw["fingerprinting"], SHIELDS_FINGERPRINTING, d.fingerprinting),
    https: oneOf(raw["https"], SHIELDS_HTTPS, d.https),
    globalPrivacyControl: bool(raw["globalPrivacyControl"], d.globalPrivacyControl),
    referrer: oneOf(raw["referrer"], SHIELDS_REFERRER, d.referrer),
    webRtc: oneOf(raw["webRtc"], SHIELDS_WEBRTC, d.webRtc),
    blockPings: bool(raw["blockPings"], d.blockPings),
    dangerousSites: bool(raw["dangerousSites"], d.dangerousSites),
    customFilters: typeof custom === "string" && custom.length <= MAX_CUSTOM_FILTERS ? custom : d.customFilters,
  };
  return applyShieldsLevel(settings, settings.level);
}

/* ------------------------------- per site -------------------------------- */

/**
 * The key a site's Shields-down is kept under: its hostname, lowercased,
 * without a leading `www.` — a dotted name, a single-label intranet name, or
 * a bracketed IPv6 literal. A key covers its subdomains, so turning Shields
 * down on example.com also lowers them on shop.example.com.
 */
export function shieldsSiteKey(urlOrHost: string): string {
  let host = urlOrHost.trim().toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return "";
    }
  }
  host = host.replace(/\.$/, "").replace(/^www\./, "");
  // A typed entry is a host, not an address: nothing past it. Names with
  // dots, single-label intranet names, and IPv6 literals (URL keeps their
  // brackets) are all sites a page can be on.
  if (/^\[[0-9a-f:.]+\]$/.test(host)) return host;
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) ? host : "";
}

/** Whether `host` is under a key in `exceptions` (the key itself or a subdomain of it). */
export function shieldsExceptionFor(host: string, exceptions: Iterable<string>): string | null {
  const key = shieldsSiteKey(host);
  if (key === "") return null;
  for (const exception of exceptions) {
    if (key === exception || key.endsWith(`.${exception}`)) return exception;
  }
  return null;
}

/** What the site popover shows for the active tab (BrowserControlsSnapshot.shields). */
export interface ShieldsSiteState {
  /** Shields are on and this page is one they act on (http/https). */
  active: boolean;
  /** Shields are off everywhere (the master switch). */
  globallyOff: boolean;
  /** The exception that lowers Shields here, when one does. */
  exception: string | null;
  /** The key the popover's switch writes: this page's site. */
  siteKey: string;
  level: ShieldsLevel;
  /** Requests blocked since the page was loaded. */
  blocked: number;
  /** The hosts those requests were for, most-blocked first. */
  blockedHosts: { host: string; count: number }[];
  /** Tracking parameters removed and redirect pages skipped on the way to this page. */
  cleaned: number;
  /** The page was loaded over HTTPS because Shields upgraded it. */
  upgraded: boolean;
}

/* ---------------------------- settings page wire ---------------------------- */

export type FilterListState = "idle" | "fetching" | "ready" | "failed";

export interface FilterListStatus {
  id: FilterListId;
  /** Loaded into the running engine. */
  enabled: boolean;
  state: FilterListState;
  /** When the cached copy was fetched, or null when there is none. */
  fetchedAt: number | null;
  /** Lines of rules in the cached copy (comments excluded). */
  rules: number;
  error: string | null;
}

export type ShieldsEngineState = "off" | "loading" | "compiling" | "ready" | "failed";

export interface ShieldsStats {
  /** Requests blocked (ads, trackers, dangerous pages). */
  blocked: number;
  /** Addresses cleaned: tracking parameters removed and redirect pages skipped. */
  cleaned: number;
  /** Pages loaded over HTTPS that were asked for over HTTP. */
  upgraded: number;
  /** Since when, ms. */
  since: number;
}

export interface ShieldsStatus {
  engine: {
    state: ShieldsEngineState;
    networkFilters: number;
    cosmeticFilters: number;
    /** When the running engine was built, ms. */
    compiledAt: number | null;
    error: string | null;
    /** Filters of the person's own that did not parse. */
    customErrors: string[];
  };
  lists: FilterListStatus[];
  /** A list fetch is under way. */
  updating: boolean;
  lastCheckedAt: number | null;
  exceptions: { key: string; addedAt: number }[];
  stats: ShieldsStats;
}

export type ShieldsRequest =
  | { type: "status" }
  /** Fetch every enabled list now, whatever its expiry says. */
  | { type: "updateLists" }
  /** Lower (`enabled: false`) or raise Shields on a site. */
  | { type: "setSite"; site: string; enabled: boolean }
  | { type: "resetStats" };

export function isShieldsRequest(value: unknown): value is ShieldsRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  switch (request["type"]) {
    case "status":
    case "updateLists":
    case "resetStats":
      return true;
    case "setSite":
      return typeof request["site"] === "string" && request["site"].length <= 253 && typeof request["enabled"] === "boolean";
    default:
      return false;
  }
}

/**
 * A settings patch's `shields` half, merged over the current value the way
 * the settings page means it: naming a preset takes the preset; changing any
 * knob without naming one is a custom choice — unless the knobs that result
 * are exactly a preset's, which then reads as that preset again.
 */
export function mergeShieldsPatch(current: ShieldsSettings, patch: Record<string, unknown>): ShieldsSettings {
  const merged = sanitizeShields({ ...current, ...patch, level: "custom" });
  if ("level" in patch) {
    const level = oneOf(patch["level"], SHIELDS_LEVELS, current.level);
    return level === "custom" ? merged : applyShieldsLevel(merged, level);
  }
  const touchesKnobs = Object.keys(patch).some((key) => key in SHIELDS_PRESETS.standard);
  if (!touchesKnobs) return { ...merged, level: current.level };
  return { ...merged, level: matchingShieldsLevel(merged) };
}
