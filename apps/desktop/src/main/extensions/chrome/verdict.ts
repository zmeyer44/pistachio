/**
 * A Chrome extension's verdict and approval sheet, read from its **downloaded** manifest before anything loads
 * (docs/extensions.md §6.4, X11) — never from the manifest the store's page sent. Pure (no Electron), so the tests
 * read real manifests straight into it; the curated index (curated.ts) overrides it where something was measured.
 *
 * What Electron 43.4.1 gives an MV3 extension under the patched electron-chrome-extensions was measured on
 * 2026-10-30 (the probe in the branch's scratchpad): present — action, alarms (an alarm is kept; firing unwatched),
 * commands (getAll only: no shortcut fires), contextMenus, cookies, declarativeNetRequest (a dynamic block rule
 * blocked the request), i18n, idle, management, notifications, offscreen (`createDocument` worked), permissions,
 * power, runtime, scripting, storage, system, tabs, webNavigation, webRequest, windows; stubs that do nothing —
 * downloads, topSites, privacy; absent — bookmarks, debugger, declarativeContent, desktopCapture, fontSettings,
 * history, identity, omnibox, pageCapture, readingList, search, sessions, sidePanel, tabCapture, tabGroups, tts,
 * userScripts. Manifest V2 still loads. `runtime.onInstalled` never fired on load — no manifest can say who
 * depends on it, so no verdict does.
 *
 * Where §6.4's list meets real manifests and the measurements: `offscreen` and `declarativeNetRequest` work, and are
 * declared by many extensions whose core is elsewhere (Google Translate, ColorZilla, Zotero, 1Password, Todoist), so
 * neither costs a note; a blocker built on DNR is still refused with Shields' sentence (X11: two blockers would fight
 * over the same pages); `identity` refuses only with an `oauth2` block (Chrome's Google sign-in, `getAuthToken`) and
 * is a note for a web sign-in flow; `alarms` works.
 */

import { createHash } from "node:crypto";
import { hostsInWords } from "@pistachio/extension-api/sheet";
import { isEverySite } from "@pistachio/extension-api/capabilities";
import type { ChromeVerdict, ExtensionSheet, ExtensionSheetLine, ExtensionTier } from "@pistachio/shell-contracts/extensions";

interface ChromeActionKey {
  default_popup?: string;
  default_title?: string;
  default_icon?: string | Record<string, string>;
}

/** The part of a Chrome `manifest.json` the verdict and the sheet read. */
export interface ChromeManifest {
  manifest_version?: number;
  name?: string;
  short_name?: string;
  description?: string;
  version?: string;
  default_locale?: string;
  icons?: Record<string, string>;
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  action?: ChromeActionKey;
  browser_action?: ChromeActionKey;
  page_action?: ChromeActionKey;
  background?: { service_worker?: string; scripts?: string[]; page?: string; persistent?: boolean; type?: string };
  content_scripts?: { matches?: string[]; exclude_matches?: string[]; js?: string[]; css?: string[]; all_frames?: boolean }[];
  side_panel?: { default_path?: string };
  commands?: Record<string, { suggested_key?: unknown; description?: string }>;
  omnibox?: { keyword?: string };
  chrome_url_overrides?: { newtab?: string; history?: string; bookmarks?: string };
  options_ui?: { page?: string; open_in_tab?: boolean };
  options_page?: string;
  devtools_page?: string;
  declarative_net_request?: { rule_resources?: { id?: string; enabled?: boolean; path?: string }[] };
  oauth2?: { client_id?: string; scopes?: string[] };
  minimum_chrome_version?: string;
  key?: string;
  update_url?: string;
}

const DNR_PERMISSIONS = ["declarativeNetRequest", "declarativeNetRequestWithHostAccess", "declarativeNetRequestFeedback"];
const HOST_SCHEMES = /^(\*|https?|wss?|ftp):\/\//;
/** Command names Chrome reserves for opening the action; every other command is a shortcut of the extension's own. */
const ACTION_COMMANDS = new Set(["_execute_action", "_execute_browser_action", "_execute_page_action"]);

const SHIELDS_SENTENCE = "Shields already blocks ads and trackers here.";

/** Notes for permissions whose API is missing or a stub in Pistachio, said in words (§6.4 ◐). */
const PARTLY_NOTES: Record<string, string> = {
  bookmarks: "It can't read or change your bookmarks here.",
  history: "It can't see your browsing history here.",
  downloads: "It can't see or manage your downloads here.",
  tabGroups: "It can't see or arrange tab groups here.",
  sessions: "It can't see recently closed tabs here.",
  topSites: "It can't see your most visited sites here.",
  readingList: "It can't use a reading list here.",
  fontSettings: "It can't read your font settings here.",
  tts: "It can't read text aloud with Chrome's voices here.",
  search: "It can't run searches through your search engine here.",
  pageCapture: "It can't save whole pages (MHTML) here.",
  declarativeContent: "It can't change its button by the page you're on.",
  printerProvider: "It can't add printers here.",
  nativeMessaging: "Connecting to its app on this Mac isn't available in Pistachio yet.",
};

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Permissions that name APIs (not hosts). */
export function chromeApiPermissions(manifest: ChromeManifest): string[] {
  return list(manifest.permissions).filter((p) => !isHostPattern(p));
}

function isHostPattern(value: string): boolean {
  return value === "<all_urls>" || value.includes("://");
}

/**
 * The sites an extension reaches: `host_permissions` (MV3), the patterns MV2 lists among `permissions`, and its
 * content scripts' `matches` — Chrome warns for all three. Only web schemes: Pistachio never gives an extension
 * local files or `chrome://` pages.
 */
export function chromeHostPatterns(manifest: ChromeManifest): string[] {
  const patterns = [
    ...list(manifest.host_permissions),
    ...list(manifest.permissions).filter(isHostPattern),
    ...(Array.isArray(manifest.content_scripts) ? manifest.content_scripts.flatMap((script) => list(script?.matches)) : []),
  ];
  return [...new Set(patterns.filter((p) => p === "<all_urls>" || HOST_SCHEMES.test(p)))].sort();
}

const PATTERN = /^(\*|https?|wss?|ftp):\/\/(\*|\*\.[^/*:]+|[^/*:]+)(?::(?:\*|\d+))?\/.*$/;

/**
 * Whether a declared match pattern covers a requested one (`permissions.request({ origins })`: Chrome grants only
 * origins its manifest declared, required or optional). Scheme and host only — Chrome ignores paths for host
 * permissions; a pattern it can't read covers nothing.
 */
export function chromePatternCovers(declared: string, requested: string): boolean {
  if (declared === requested) return true;
  if (declared === "<all_urls>") return requested === "<all_urls>" || PATTERN.test(requested);
  const want = PATTERN.exec(requested);
  const have = PATTERN.exec(declared);
  if (want === null || have === null) return false;
  const [, wantScheme, wantHost] = want as unknown as [string, string, string];
  const [, haveScheme, haveHost] = have as unknown as [string, string, string];
  const schemeOk = haveScheme === wantScheme || (haveScheme === "*" && (wantScheme === "http" || wantScheme === "https"));
  if (!schemeOk) return false;
  const host = wantHost.toLowerCase();
  const base = haveHost.toLowerCase();
  if (base === "*") return true;
  if (base.startsWith("*.")) {
    const domain = base.slice(2);
    const bare = host.startsWith("*.") ? host.slice(2) : host;
    return bare === domain || bare.endsWith(`.${domain}`);
  }
  return host === base;
}

function hasAction(manifest: ChromeManifest): boolean {
  return [manifest.action, manifest.browser_action, manifest.page_action].some((key) => key !== undefined && key !== null);
}

function hasContentScripts(manifest: ChromeManifest): boolean {
  return Array.isArray(manifest.content_scripts) && manifest.content_scripts.some((script) => list(script?.js).length > 0 || list(script?.css).length > 0);
}

function hasBackground(manifest: ChromeManifest): boolean {
  const background = manifest.background;
  return background !== undefined && (typeof background.service_worker === "string" || list(background.scripts).length > 0 || typeof background.page === "string");
}

function declaresSidePanel(manifest: ChromeManifest, permissions: string[]): boolean {
  return permissions.includes("sidePanel") || typeof manifest.side_panel?.default_path === "string";
}

/**
 * An ad or tracker blocker by its own account — its names, or the filter lists it ships — or one whose core is its
 * rule sets (two or more static ones). One rule set (1Password's, Zotero's) is an aside.
 */
function looksLikeBlocker(manifest: ChromeManifest, displayName: string | undefined): boolean {
  const names = [manifest.name, manifest.short_name, displayName].filter((n): n is string => typeof n === "string" && !n.startsWith("__MSG_"));
  if (names.some((name) => /\b(ad[\s-]?block\w*|ads|adguard|ublock|ubo|ghostery|tracker\w*|anti[\s-]?track\w*)\b/i.test(name))) return true;
  const rulesets = Array.isArray(manifest.declarative_net_request?.rule_resources) ? manifest.declarative_net_request.rule_resources : [];
  if (rulesets.some((rules) => typeof rules?.id === "string" && /easylist|ublock|adguard|\bads?\b|tracker|annoyance/i.test(rules.id))) return true;
  return rulesets.length >= 2;
}

function majorOf(version: string | undefined): number | null {
  const major = typeof version === "string" ? Number.parseInt(version.split(".")[0] ?? "", 10) : Number.NaN;
  return Number.isFinite(major) ? major : null;
}

export interface ChromeVerdictOptions {
  /** The extension's name in words when the manifest says `__MSG_extName__` (resolved from its `_locales`). */
  displayName?: string;
  /** The Chromium Pistachio runs (`process.versions.chrome`), for `minimum_chrome_version`. */
  chromeVersion?: string;
}

/** ✓ / ◐ / ✕ for a Chrome extension, from its downloaded manifest (§6.4). */
export function chromeVerdict(manifest: ChromeManifest, options: ChromeVerdictOptions = {}): ChromeVerdict {
  const permissions = chromeApiPermissions(manifest);
  const has = (name: string): boolean => permissions.includes(name);
  const dnr = DNR_PERMISSIONS.some(has);
  const blocker = looksLikeBlocker(manifest, options.displayName);
  const mv2 = manifest.manifest_version === 2;

  // ✕ — its core is something Pistachio doesn't run.
  const needs = majorOf(manifest.minimum_chrome_version);
  const runs = majorOf(options.chromeVersion);
  if (needs !== null && runs !== null && needs > runs) {
    return { kind: "wont", reason: `It needs a newer Chrome (${needs}) than the one inside this Pistachio (${runs}). It may work after Pistachio updates.` };
  }
  if (mv2 && has("webRequestBlocking")) {
    return blocker
      ? { kind: "wont", reason: SHIELDS_SENTENCE, alternative: "Shields" }
      : { kind: "wont", reason: "It changes web requests as they happen (blocking webRequest), which Pistachio doesn't let extensions do." };
  }
  if (dnr && blocker) return { kind: "wont", reason: SHIELDS_SENTENCE, alternative: "Shields" };
  if (has("tabCapture") || has("desktopCapture")) {
    return { kind: "wont", reason: "It records your screen or tabs through Chrome's capture APIs, which Pistachio doesn't give extensions.", alternative: "Recorder" };
  }
  if (has("debugger")) return { kind: "wont", reason: "It drives pages through Chrome's debugger, which Pistachio doesn't give extensions." };
  if (has("identity") && manifest.oauth2 !== undefined) {
    return { kind: "wont", reason: "It signs in with the Google account inside Chrome, which Pistachio doesn't have." };
  }
  if (has("userScripts")) return { kind: "wont", reason: "It runs your user scripts through Chrome's userScripts API, which Pistachio doesn't have yet." };
  const sidePanel = declaresSidePanel(manifest, permissions);
  if (sidePanel && !hasAction(manifest) && !hasContentScripts(manifest) && !hasBackground(manifest)) {
    return { kind: "wont", reason: "It lives in Chrome's side panel, which Pistachio doesn't have yet." };
  }

  // ◐ — something it uses is missing, not its core.
  const notes: string[] = [];
  if (mv2) notes.push("It's built for Chrome's older extension system (Manifest V2); parts of it may not work.");
  if (has("identity")) notes.push("Signing in through its own pop-up isn't available yet; signing in on its website works.");
  if (sidePanel) notes.push("Its side panel doesn't open here yet; the rest of it works.");
  if (typeof manifest.omnibox?.keyword === "string") notes.push(`Its address-bar keyword (“${manifest.omnibox.keyword}”) doesn't work here.`);
  for (const permission of permissions) {
    const note = PARTLY_NOTES[permission];
    if (note !== undefined && !notes.includes(note)) notes.push(note);
  }
  const shortcuts = Object.keys(manifest.commands ?? {}).filter((name) => !ACTION_COMMANDS.has(name));
  if (shortcuts.length > 0) notes.push(shortcuts.length === 1 ? "Its keyboard shortcut isn't available yet." : "Its keyboard shortcuts aren't available yet.");
  if (typeof manifest.chrome_url_overrides?.newtab === "string") notes.push("New tabs keep opening Pistachio's home page.");
  if (notes.length === 0) return { kind: "works" };
  // storage.sync can't be read from a manifest; said only where the differences are already being listed.
  if (has("storage")) notes.push("If it syncs its settings, they stay on this Mac.");
  return { kind: "partly", notes };
}

// ———————————————————————————— the sheet ————————————————————————————

export type ChromeSheetBucket = "pages" | "you" | "mac";

export interface ChromeWarning extends ExtensionSheetLine {
  /** *Pages*, *You* or *This Mac* — the sheet's three plain buckets (§2). */
  bucket: ChromeSheetBucket;
}

const TIER_RANK: Record<ExtensionTier, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const BUCKET_RANK: Record<ChromeSheetBucket, number> = { pages: 0, you: 1, mac: 2 };

/** Fixed sentences for API permissions, in Chrome's spirit and never the extension's own words. */
const PERMISSION_WARNINGS: Record<string, { bucket: ChromeSheetBucket; tier: ExtensionTier; text: string }> = {
  tabs: { bucket: "you", tier: "medium", text: "See the titles and addresses of your tabs" },
  history: { bucket: "you", tier: "medium", text: "Read and change your browsing history" },
  bookmarks: { bucket: "you", tier: "medium", text: "Read and change your bookmarks" },
  downloads: { bucket: "you", tier: "medium", text: "Manage your downloads" },
  webNavigation: { bucket: "you", tier: "medium", text: "See every page you go to" },
  topSites: { bucket: "you", tier: "medium", text: "See your most visited sites" },
  sessions: { bucket: "you", tier: "medium", text: "See tabs you closed recently" },
  readingList: { bucket: "you", tier: "medium", text: "Read and change your reading list" },
  identity: { bucket: "you", tier: "medium", text: "Know your Google account" },
  "identity.email": { bucket: "you", tier: "medium", text: "Know your email address" },
  clipboardRead: { bucket: "you", tier: "high", text: "Read what you copy" },
  clipboardWrite: { bucket: "you", tier: "low", text: "Change what you copy" },
  geolocation: { bucket: "you", tier: "high", text: "Know where you are" },
  contentSettings: { bucket: "you", tier: "high", text: "Change what sites may do, like run scripts or use your camera" },
  privacy: { bucket: "you", tier: "medium", text: "Change your privacy settings" },
  proxy: { bucket: "you", tier: "high", text: "Send your traffic through a proxy" },
  tabCapture: { bucket: "you", tier: "high", text: "Record your tabs" },
  desktopCapture: { bucket: "you", tier: "high", text: "Record your screen" },
  pageCapture: { bucket: "you", tier: "medium", text: "Save whole pages" },
  notifications: { bucket: "you", tier: "low", text: "Show notifications" },
  storage: { bucket: "you", tier: "low", text: "Keep data of its own" },
  unlimitedStorage: { bucket: "you", tier: "low", text: "Keep as much data of its own as it likes" },
  idle: { bucket: "you", tier: "low", text: "Know when you're away" },
  tabGroups: { bucket: "you", tier: "low", text: "See and arrange your tab groups" },
  tts: { bucket: "you", tier: "low", text: "Read text aloud" },
  declarativeNetRequest: { bucket: "pages", tier: "medium", text: "Block or change what pages load" },
  declarativeNetRequestWithHostAccess: { bucket: "pages", tier: "medium", text: "Block or change what pages load on the sites above" },
  webRequestBlocking: { bucket: "pages", tier: "high", text: "Block or change your web requests as they happen" },
  debugger: { bucket: "pages", tier: "critical", text: "See and change everything on any page it debugs" },
  userScripts: { bucket: "pages", tier: "high", text: "Run scripts you add on the pages they name" },
  nativeMessaging: { bucket: "mac", tier: "high", text: "Talks to an app on this Mac" },
  management: { bucket: "mac", tier: "high", text: "Sees and manages your other extensions" },
  "system.cpu": { bucket: "mac", tier: "low", text: "Sees this Mac's processor" },
  "system.memory": { bucket: "mac", tier: "low", text: "Sees this Mac's memory" },
  "system.display": { bucket: "mac", tier: "low", text: "Sees this Mac's displays" },
  "system.storage": { bucket: "mac", tier: "low", text: "Sees this Mac's disks" },
  power: { bucket: "mac", tier: "low", text: "Keeps this Mac awake" },
};

function siteWords(patterns: string[]): string {
  return hostsInWords(patterns);
}

/** Chrome's permission warnings in three plain buckets (*Pages*, *You*, *This Mac*), broadest first. */
export function chromeWarnings(manifest: ChromeManifest): ChromeWarning[] {
  const permissions = chromeApiPermissions(manifest);
  const hosts = chromeHostPatterns(manifest);
  const everySite = hosts.some(isEverySite);
  const warnings: ChromeWarning[] = [];
  if (hosts.length > 0) {
    warnings.push({ bucket: "pages", tier: everySite ? "critical" : "high", text: `Read and change pages on ${siteWords(hosts)}` });
  } else if (permissions.includes("activeTab")) {
    warnings.push({ bucket: "pages", tier: "low", text: "Read and change the page you're on when you click it" });
  }
  if (permissions.includes("cookies")) {
    warnings.push({ bucket: "you", tier: "high", text: hosts.length > 0 ? `Read and change your cookies on ${siteWords(hosts)}` : "Read and change your cookies" });
  }
  for (const permission of permissions) {
    const warning = PERMISSION_WARNINGS[permission];
    if (warning !== undefined && !warnings.some((w) => w.text === warning.text)) warnings.push({ ...warning });
  }
  return warnings.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket]);
}

/** What it adds to the window, in words. */
function chromeAdds(manifest: ChromeManifest, permissions: string[]): string[] {
  const adds: string[] = [];
  const action = manifest.action ?? manifest.browser_action ?? manifest.page_action;
  if (action !== undefined) adds.push(typeof action.default_popup === "string" && action.default_popup !== "" ? "a button on the Ledge with a popup" : "a button on the Ledge");
  if (declaresSidePanel(manifest, permissions)) adds.push("a side panel (not in Pistachio yet)");
  if (permissions.includes("contextMenus")) adds.push("items in the right-click menu");
  const shortcuts = Object.keys(manifest.commands ?? {}).filter((name) => !ACTION_COMMANDS.has(name)).length;
  if (shortcuts === 1) adds.push("a keyboard shortcut");
  else if (shortcuts > 1) adds.push(`${shortcuts} keyboard shortcuts`);
  if (typeof (manifest.options_ui?.page ?? manifest.options_page) === "string") adds.push("an options page");
  if (typeof manifest.omnibox?.keyword === "string") adds.push(`the address-bar keyword “${manifest.omnibox.keyword}”`);
  if (typeof manifest.devtools_page === "string") adds.push("a panel in the developer tools");
  if (typeof manifest.chrome_url_overrides?.newtab === "string") adds.push("a new tab page (Pistachio keeps its own)");
  return adds;
}

/**
 * The hash an approval names: the sorted permissions, hosts (host permissions, MV2 host permissions and content
 * script matches) and the version. A new version is a new hash; whether an update widened what it may do is the
 * registry's comparison of these sets, not of the hash.
 */
export function chromeManifestHash(manifest: ChromeManifest): string {
  const canonical = JSON.stringify({
    manifest_version: manifest.manifest_version ?? null,
    version: manifest.version ?? null,
    permissions: [...new Set(list(manifest.permissions))].sort(),
    host_permissions: [...new Set(list(manifest.host_permissions))].sort(),
    content_scripts: chromeHostPatterns({ content_scripts: manifest.content_scripts }),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** The approval sheet for a Chrome extension (§2): Chrome's warnings as lines, what it adds, everything it declares. */
export function chromeSheet(manifest: ChromeManifest): ExtensionSheet {
  const permissions = chromeApiPermissions(manifest);
  const declares = [
    ...permissions.map((p) => `permission ${p}`),
    ...list(manifest.host_permissions).map((h) => `host ${h}`),
    ...list(manifest.permissions).filter(isHostPattern).map((h) => `host ${h}`),
    ...[...new Set((manifest.content_scripts ?? []).flatMap((script) => list(script?.matches)))].map((m) => `content scripts on ${m}`),
    ...list(manifest.optional_permissions).map((p) => `optional permission ${p}`),
    ...list(manifest.optional_host_permissions).map((h) => `optional host ${h}`),
  ];
  return {
    adds: chromeAdds(manifest, permissions),
    can: chromeWarnings(manifest).map(({ tier, text }) => ({ tier, text })),
    declares,
    manifestHash: chromeManifestHash(manifest),
  };
}
