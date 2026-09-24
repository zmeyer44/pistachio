/**
 * Bringing a person's existing browser with them: which browsers are on
 * this Mac, which profiles (and signed-in accounts) each has, and what an
 * import of each chosen profile yields. The wizard imports any number of
 * profiles at once, each with everything its browser can hand over. Main does the reading
 * (main/browser-import.ts); the wizard only ever sees these shapes.
 *
 * The pure half lives here — the parsers for a Chromium `Local State`, a
 * Firefox `profiles.ini`, a Chromium `Bookmarks` file — so vitest pins
 * them under node without a browser installed.
 */

import type { SidebarEntry } from "./sidebar.js";
import { isAllowedNavigation } from "./url.js";

export type BrowserKind =
  | "chrome"
  | "arc"
  | "brave"
  | "edge"
  | "chromium"
  | "vivaldi"
  | "opera"
  | "firefox"
  | "safari";

export const BROWSER_KINDS: readonly BrowserKind[] = [
  "chrome",
  "arc",
  "brave",
  "edge",
  "chromium",
  "vivaldi",
  "opera",
  "firefox",
  "safari",
];

/** The brand as the import step draws it: a name, the card's colour, its engine. */
export interface BrowserBrand {
  name: string;
  /** The tinted end of the card — Chrome-yellow, Firefox-pink, Safari-blue. */
  color: string;
  engine: "chromium" | "gecko" | "webkit";
}

export const BROWSER_BRANDS: Record<BrowserKind, BrowserBrand> = {
  chrome: { name: "Chrome", color: "#F4D35E", engine: "chromium" },
  arc: { name: "Arc", color: "#C9B8FF", engine: "chromium" },
  brave: { name: "Brave", color: "#FFB48A", engine: "chromium" },
  edge: { name: "Microsoft Edge", color: "#8FD8CF", engine: "chromium" },
  chromium: { name: "Chromium", color: "#A9C7F5", engine: "chromium" },
  vivaldi: { name: "Vivaldi", color: "#F5A3A3", engine: "chromium" },
  opera: { name: "Opera", color: "#FF9EA8", engine: "chromium" },
  firefox: { name: "Firefox", color: "#F5A9C4", engine: "gecko" },
  safari: { name: "Safari", color: "#A9D5F5", engine: "webkit" },
};

/** The signed-in account a profile belongs to, when the browser says. */
export interface BrowserAccount {
  email: string | null;
  displayName: string | null;
}

export interface BrowserProfile {
  /** The profile's directory name (`Default`, `Profile 3`, `abc123.default-release`). */
  id: string;
  /** What the browser calls it: "Work", "Person 1", "default-release". */
  name: string;
  account: BrowserAccount | null;
  /** Bookmarks the profile keeps, or null when that could not be read cheaply. */
  bookmarkCount: number | null;
  /** The profile the browser opened last, so the dropdown can lead with it. */
  lastUsed: boolean;
}

export interface InstalledBrowser {
  kind: BrowserKind;
  profiles: BrowserProfile[];
  /** What this browser can hand over on this platform. */
  supports: { sessions: boolean; bookmarks: boolean };
  /** Why something is unsupported, in words the card can show. */
  note: string | null;
}

export interface BrowserImportRequest {
  browser: BrowserKind;
  profileId: string;
  /** Signed-in sessions: the profile's cookies, into the active Space. */
  sessions: boolean;
  /** Bookmarks: into the sidebar as pins under a folder named for the browser. */
  bookmarks: boolean;
}

export interface BrowserImportResult {
  browser: BrowserKind;
  profileId: string;
  /** Cookies that landed in the Space. */
  cookies: number;
  /** Sites those cookies sign in to, for the summary. */
  origins: string[];
  /** Pins and folders added to the shelf. */
  bookmarks: number;
  folders: number;
  /** What could not be brought, each with its reason. */
  skipped: string[];
}

/* ------------------------------ sanitizing ------------------------------ */

export function isBrowserKind(value: unknown): value is BrowserKind {
  return (
    typeof value === "string" &&
    (BROWSER_KINDS as readonly string[]).includes(value)
  );
}

/** A profile id names a directory: one path segment, nothing that climbs. */
export function isProfileId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    value !== "." &&
    value !== ".." &&
    !/[/\\\0]/.test(value)
  );
}

/** The most profiles one import brings over at once. */
export const MAX_IMPORT_PROFILES = 16;

/**
 * The wizard's import: one request per chosen profile, any browser, each
 * once. Null when nothing usable was asked for.
 */
export function sanitizeBrowserImportRequests(
  value: unknown,
): BrowserImportRequest[] | null {
  if (!Array.isArray(value)) return null;
  const out: BrowserImportRequest[] = [];
  const seen = new Set<string>();
  for (const raw of value as unknown[]) {
    const request = sanitizeBrowserImportRequest(raw);
    if (request === null) continue;
    const key = `${request.browser}\0${request.profileId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(request);
    if (out.length >= MAX_IMPORT_PROFILES) break;
  }
  return out.length === 0 ? null : out;
}

export function sanitizeBrowserImportRequest(
  value: unknown,
): BrowserImportRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!isBrowserKind(raw["browser"]) || !isProfileId(raw["profileId"]))
    return null;
  return {
    browser: raw["browser"],
    profileId: raw["profileId"],
    sessions: raw["sessions"] === true,
    bookmarks: raw["bookmarks"] === true,
  };
}

/* ------------------------------- parsers -------------------------------- */

/** One profile as a Chromium `Local State` describes it under `profile.info_cache`. */
export interface LocalStateProfile {
  id: string;
  name: string;
  account: BrowserAccount | null;
  lastUsed: boolean;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Chromium keeps every profile's display name and signed-in account in the
 * user-data directory's `Local State` (JSON): `profile.info_cache` keyed by
 * directory, `profile.last_used` naming the current one. A browser that
 * signs in with Google fills `user_name` (the email) and `gaia_name`; one
 * that does not (Arc, Chromium) leaves them empty and the profile is
 * anonymous but still importable.
 */
export function parseLocalState(json: unknown): LocalStateProfile[] {
  if (typeof json !== "object" || json === null) return [];
  const profile = (json as Record<string, unknown>)["profile"];
  if (typeof profile !== "object" || profile === null) return [];
  const cache = (profile as Record<string, unknown>)["info_cache"];
  const lastUsed = text((profile as Record<string, unknown>)["last_used"]);
  if (typeof cache !== "object" || cache === null) return [];
  const out: LocalStateProfile[] = [];
  for (const [id, raw] of Object.entries(cache as Record<string, unknown>)) {
    if (!isProfileId(id) || typeof raw !== "object" || raw === null) continue;
    const info = raw as Record<string, unknown>;
    const email = text(info["user_name"]);
    const displayName =
      text(info["gaia_name"]) || text(info["gaia_given_name"]);
    const name = text(info["name"]) || (email === "" ? id : email);
    out.push({
      id,
      name,
      account:
        email === "" && displayName === ""
          ? null
          : { email: email || null, displayName: displayName || null },
      lastUsed: id === lastUsed,
    });
  }
  // The current profile first, then the rest as the file lists them.
  return out.sort((a, b) => Number(b.lastUsed) - Number(a.lastUsed));
}

export interface FirefoxProfileIni {
  id: string;
  name: string;
  /** Relative to the Firefox directory unless `IsRelative=0`. */
  path: string;
  isRelative: boolean;
  isDefault: boolean;
}

/**
 * Firefox lists profiles in `profiles.ini`: `[ProfileN]` sections with a
 * Name and Path, and `[Install…]` sections whose Default names the path
 * the last-used install opens — the one that counts as current, ahead of
 * the older `Default=1` flag.
 */
export function parseProfilesIni(ini: string): FirefoxProfileIni[] {
  const sections = new Map<string, Record<string, string>>();
  let current: Record<string, string> | null = null;
  for (const rawLine of ini.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith(";") || line.startsWith("#")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header !== null) {
      current = {};
      sections.set(header[1] ?? "", current);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0 || current === null) continue;
    current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  const installDefaults = new Set<string>();
  for (const [name, values] of sections) {
    if (name.startsWith("Install") && values["Default"] !== undefined)
      installDefaults.add(values["Default"]);
  }
  const out: FirefoxProfileIni[] = [];
  for (const [name, values] of sections) {
    if (!name.startsWith("Profile")) continue;
    const path = values["Path"] ?? "";
    if (path === "") continue;
    const id = path.split("/").at(-1) ?? path;
    if (!isProfileId(id)) continue;
    out.push({
      id,
      name: values["Name"] ?? id,
      path,
      isRelative: values["IsRelative"] !== "0",
      isDefault:
        installDefaults.size > 0
          ? installDefaults.has(path)
          : values["Default"] === "1",
    });
  }
  return out.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

/* ------------------------------ bookmarks ------------------------------- */

/** A bookmark tree as any browser exports it, before it becomes shelf entries. */
export interface ImportedBookmarkFolder {
  kind: "folder";
  name: string;
  children: ImportedBookmark[];
}

export interface ImportedBookmarkLink {
  kind: "link";
  title: string;
  url: string;
}

export type ImportedBookmark = ImportedBookmarkFolder | ImportedBookmarkLink;

/**
 * Chromium's `Bookmarks` file: JSON with `roots.bookmark_bar`, `roots.other`,
 * `roots.synced`, each a folder node (`type: "folder"`, `children`) or a
 * link (`type: "url"`, `url`, `name`). The bar's own links come back as
 * top-level links; the other roots come back as folders named for them.
 */
export function parseChromiumBookmarks(json: unknown): ImportedBookmark[] {
  if (typeof json !== "object" || json === null) return [];
  const roots = (json as Record<string, unknown>)["roots"];
  if (typeof roots !== "object" || roots === null) return [];
  const record = roots as Record<string, unknown>;
  const node = (value: unknown): ImportedBookmark | null => {
    if (typeof value !== "object" || value === null) return null;
    const item = value as Record<string, unknown>;
    if (item["type"] === "url") {
      const url = text(item["url"]);
      if (!isAllowedNavigation(url)) return null;
      return { kind: "link", title: text(item["name"]), url };
    }
    if (item["type"] === "folder") {
      const children = Array.isArray(item["children"])
        ? (item["children"] as unknown[])
            .map(node)
            .filter((child): child is ImportedBookmark => child !== null)
        : [];
      return { kind: "folder", name: text(item["name"]), children };
    }
    return null;
  };
  const out: ImportedBookmark[] = [];
  const bar = node(record["bookmark_bar"]);
  if (bar !== null && bar.kind === "folder") out.push(...bar.children);
  for (const [key, label] of [
    ["other", "Other bookmarks"],
    ["synced", "Mobile bookmarks"],
  ] as const) {
    const folder = node(record[key]);
    if (
      folder !== null &&
      folder.kind === "folder" &&
      folder.children.length > 0
    ) {
      out.push({
        kind: "folder",
        name: folder.name || label,
        children: folder.children,
      });
    }
  }
  return out;
}

/**
 * Safari's `Bookmarks.plist` (read through `plutil -convert json`): nested
 * `Children` whose `WebBookmarkType` is a list or a leaf, the leaf's
 * address in `URLString` and its title in `URIDictionary.title`. The
 * top-level "BookmarksBar" and "BookmarksMenu" lists are unwrapped.
 */
export function parseSafariBookmarks(json: unknown): ImportedBookmark[] {
  const node = (value: unknown): ImportedBookmark | null => {
    if (typeof value !== "object" || value === null) return null;
    const item = value as Record<string, unknown>;
    if (item["WebBookmarkType"] === "WebBookmarkTypeLeaf") {
      const url = text(item["URLString"]);
      if (!isAllowedNavigation(url)) return null;
      const dictionary = item["URIDictionary"];
      const title =
        typeof dictionary === "object" && dictionary !== null
          ? text((dictionary as Record<string, unknown>)["title"])
          : "";
      return { kind: "link", title, url };
    }
    if (item["WebBookmarkType"] === "WebBookmarkTypeList") {
      const children = Array.isArray(item["Children"])
        ? (item["Children"] as unknown[])
            .map(node)
            .filter((child): child is ImportedBookmark => child !== null)
        : [];
      return { kind: "folder", name: text(item["Title"]), children };
    }
    return null;
  };
  const root = node(json);
  if (root === null || root.kind !== "folder") return [];
  const out: ImportedBookmark[] = [];
  for (const child of root.children) {
    if (
      child.kind === "folder" &&
      (child.name === "BookmarksBar" || child.name === "BookmarksMenu")
    ) {
      out.push(...child.children);
    } else if (
      child.kind === "folder" &&
      child.name === "com.apple.ReadingList"
    ) {
      if (child.children.length > 0)
        out.push({
          kind: "folder",
          name: "Reading List",
          children: child.children,
        });
    } else {
      out.push(child);
    }
  }
  return out;
}

/** How many links a tree holds, at any depth. */
export function countBookmarks(tree: readonly ImportedBookmark[]): number {
  let total = 0;
  for (const node of tree)
    total += node.kind === "link" ? 1 : countBookmarks(node.children);
  return total;
}

/** The shelf's caps, applied to an import so a large collection cannot flood it. */
export const MAX_IMPORTED_PINS = 200;
export const MAX_IMPORTED_FOLDERS = 40;

/**
 * A bookmark tree as shelf entries: one folder named for the browser
 * holding its top-level links, and every folder — at any depth — as its
 * own top-level folder (the shelf is one level deep), named
 * with its path ("Recipes · Weeknight"). Order is the browser's. `newId`
 * mints entry ids so the result is deterministic under test.
 */
export function bookmarksToEntries(
  tree: readonly ImportedBookmark[],
  rootFolderName: string,
  newId: () => string,
): { entries: SidebarEntry[]; pins: number; folders: number } {
  const entries: SidebarEntry[] = [];
  let pins = 0;
  let folders = 0;
  const seen = new Set<string>();
  const addFolder = (name: string, links: ImportedBookmarkLink[]): void => {
    const kept = links.filter((link) => !seen.has(link.url));
    if (kept.length === 0 || folders >= MAX_IMPORTED_FOLDERS) return;
    const folderId = newId();
    entries.push({
      kind: "folder",
      id: folderId,
      name: name.slice(0, 60),
      collapsed: true,
      color: null,
      emoji: null,
    });
    folders += 1;
    for (const link of kept) {
      if (pins >= MAX_IMPORTED_PINS) break;
      seen.add(link.url);
      entries.push({
        kind: "pin",
        id: newId(),
        url: link.url,
        title: link.title || hostOf(link.url),
        faviconUrl: null,
        folderId,
      });
      pins += 1;
    }
  };
  const walk = (nodes: readonly ImportedBookmark[], path: string[]): void => {
    const links = nodes.filter(
      (node): node is ImportedBookmarkLink => node.kind === "link",
    );
    addFolder(path.join(" · "), links);
    for (const node of nodes) {
      if (node.kind === "folder")
        walk(node.children, [...path, node.name || "Folder"]);
    }
  };
  walk(tree, [rootFolderName]);
  return { entries, pins, folders };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/* -------------------------------- cookies ------------------------------- */

/** Chromium's epoch is 1601-01-01; its clock counts microseconds. */
const CHROMIUM_EPOCH_OFFSET_SECONDS = 11_644_473_600;

/** A Chromium `expires_utc` as seconds since 1970, or null for a session cookie (0). */
export function chromiumTimeToUnixSeconds(
  value: number | bigint,
): number | null {
  const micros = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(micros) || micros <= 0) return null;
  return micros / 1_000_000 - CHROMIUM_EPOCH_OFFSET_SECONDS;
}

export type CookieSameSite =
  | "unspecified"
  | "no_restriction"
  | "lax"
  | "strict";

/** Chromium's `samesite` column: -1 unspecified, 0 none, 1 lax, 2 strict. */
export function chromiumSameSite(value: number | bigint): CookieSameSite {
  switch (Number(value)) {
    case 0:
      return "no_restriction";
    case 1:
      return "lax";
    case 2:
      return "strict";
    default:
      return "unspecified";
  }
}

/** Firefox's `sameSite` column: 0 none, 1 lax, 2 strict. */
export function firefoxSameSite(value: number | bigint): CookieSameSite {
  switch (Number(value)) {
    case 1:
      return "lax";
    case 2:
      return "strict";
    default:
      return "no_restriction";
  }
}

/** One cookie as every browser yields it, before it is set into a Space. */
export interface ImportedCookie {
  /** The `host_key`: a leading dot marks a domain cookie. */
  host: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: CookieSameSite;
  /** Unix seconds, or null for a session cookie. */
  expires: number | null;
}

/** What Electron's `session.cookies.set` takes for an imported cookie, or null when it cannot be set. */
export interface CookieDetails {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: CookieSameSite;
  expirationDate?: number;
}

/**
 * Electron sets a cookie against a URL and refuses a few combinations
 * Chromium itself will not store: `SameSite=None` without Secure, and an
 * expiry already past. Those come back null and are counted as skipped.
 */
export function cookieDetails(
  cookie: ImportedCookie,
  now = Date.now() / 1000,
): CookieDetails | null {
  const host = cookie.host.replace(/^\./, "");
  if (host === "" || cookie.name === "" || /[\s;]/.test(cookie.name))
    return null;
  if (cookie.expires !== null && cookie.expires <= now) return null;
  const domainCookie = cookie.host.startsWith(".");
  const details: CookieDetails = {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path.startsWith("/") ? cookie.path : "/"}`,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path.startsWith("/") ? cookie.path : "/",
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite:
      cookie.sameSite === "no_restriction" && !cookie.secure
        ? "unspecified"
        : cookie.sameSite,
  };
  if (domainCookie) details.domain = cookie.host;
  if (cookie.expires !== null) details.expirationDate = cookie.expires;
  return details;
}

/** The sites a set of cookies signs in to, most cookies first, for the summary. */
export function cookieOrigins(
  cookies: readonly ImportedCookie[],
  limit = 12,
): string[] {
  const counts = new Map<string, number>();
  for (const cookie of cookies) {
    const host = registrableHost(cookie.host.replace(/^\./, ""));
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([host]) => host);
}

/** `mail.google.com` → `google.com`, roughly: the last two labels, three for `co.uk`-style suffixes. */
export function registrableHost(host: string): string {
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const secondLevel = labels.at(-2) ?? "";
  const keep =
    ["co", "com", "org", "net", "ac", "gov", "edu"].includes(secondLevel) &&
    (labels.at(-1) ?? "").length === 2
      ? 3
      : 2;
  return labels.slice(-keep).join(".");
}
