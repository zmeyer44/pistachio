/**
 * Reading the browser a person already uses, so their first Space starts
 * signed in and their bookmarks come along (@pistachio/shell-contracts/browser-import has
 * the shapes and the pure parsers).
 *
 * WHAT IS READ, AND HOW
 *
 * - Chromium family (Chrome, Arc, Brave, Edge, Chromium, Vivaldi, Opera):
 *   `Local State` for profiles and accounts; each profile's `Bookmarks`
 *   (JSON); its `Cookies` SQLite database, whose values are encrypted with
 *   a key kept in the login keychain under "<Browser> Safe Storage". On
 *   macOS that key is read through `security find-generic-password`, which
 *   is what makes the OS ask the person to allow it. Values are
 *   AES-128-CBC under a PBKDF2 of that
 *   password (Chromium's os_crypt), and since cookie schema 24 the
 *   plaintext starts with a 32-byte hash of the host, dropped here.
 * - Firefox: `profiles.ini`; `places.sqlite` for bookmarks;
 *   `cookies.sqlite`, unencrypted.
 * - Safari: `Bookmarks.plist` through `plutil`, which needs Full Disk
 *   Access; its cookies are the OS's and are not read.
 *
 * Every database is COPIED to a temp directory before it is opened — the
 * browser may hold a lock, and nothing here may ever write to it — and
 * opened read-only through `node:sqlite`. Nothing leaves the machine.
 */

import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2Sync, randomUUID } from "node:crypto";
import { accessSync, constants, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Session } from "electron";
import type { DatabaseSync } from "node:sqlite";
import {
  bookmarksToEntries,
  BROWSER_BRANDS,
  chromiumSameSite,
  chromiumTimeToUnixSeconds,
  cookieDetails,
  cookieOrigins,
  countBookmarks,
  firefoxSameSite,
  parseChromiumBookmarks,
  parseLocalState,
  parseProfilesIni,
  parseSafariBookmarks,
  type BrowserImportRequest,
  type BrowserImportResult,
  type BrowserKind,
  type BrowserProfile,
  type ImportedBookmark,
  type ImportedBookmarkFolder,
  type ImportedBookmarkLink,
  type ImportedCookie,
  type InstalledBrowser,
} from "@pistachio/shell-contracts/browser-import";
import type { SidebarEntry } from "@pistachio/shell-contracts/sidebar";

const run = promisify(execFile);

/** `node:sqlite` is resolved at runtime: the bundler need not know the builtin. */
function sqlite(): { DatabaseSync: typeof DatabaseSync } {
  const require = createRequire(import.meta.url);
  return require("node:sqlite") as { DatabaseSync: typeof DatabaseSync };
}

/* ------------------------------ locations ------------------------------- */

interface ChromiumLocation {
  kind: BrowserKind;
  root: string;
  keychainService: string;
}

const CHROMIUM_KEYCHAIN: Record<Exclude<BrowserKind, "firefox" | "safari">, string> = {
  chrome: "Chrome Safe Storage",
  arc: "Arc Safe Storage",
  brave: "Brave Safe Storage",
  edge: "Microsoft Edge Safe Storage",
  chromium: "Chromium Safe Storage",
  vivaldi: "Vivaldi Safe Storage",
  opera: "Opera Safe Storage",
};

function chromiumLocations(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ChromiumLocation[] {
  const at = (kind: keyof typeof CHROMIUM_KEYCHAIN, root: string): ChromiumLocation => ({
    kind,
    root,
    keychainService: CHROMIUM_KEYCHAIN[kind],
  });
  if (platform === "darwin") {
    const base = join(home, "Library", "Application Support");
    return [
      at("chrome", join(base, "Google", "Chrome")),
      at("arc", join(base, "Arc", "User Data")),
      at("brave", join(base, "BraveSoftware", "Brave-Browser")),
      at("edge", join(base, "Microsoft Edge")),
      at("chromium", join(base, "Chromium")),
      at("vivaldi", join(base, "Vivaldi")),
      at("opera", join(base, "com.operasoftware.Opera")),
    ];
  }
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
    const roaming = env["APPDATA"] ?? join(home, "AppData", "Roaming");
    return [
      at("chrome", join(local, "Google", "Chrome", "User Data")),
      at("brave", join(local, "BraveSoftware", "Brave-Browser", "User Data")),
      at("edge", join(local, "Microsoft", "Edge", "User Data")),
      at("chromium", join(local, "Chromium", "User Data")),
      at("vivaldi", join(local, "Vivaldi", "User Data")),
      at("opera", join(roaming, "Opera Software", "Opera Stable")),
    ];
  }
  const config = env["XDG_CONFIG_HOME"] ?? join(home, ".config");
  return [
    at("chrome", join(config, "google-chrome")),
    at("brave", join(config, "BraveSoftware", "Brave-Browser")),
    at("edge", join(config, "microsoft-edge")),
    at("chromium", join(config, "chromium")),
    at("vivaldi", join(config, "vivaldi")),
    at("opera", join(config, "opera")),
  ];
}

function firefoxRoot(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Firefox");
  if (platform === "win32") return join(env["APPDATA"] ?? join(home, "AppData", "Roaming"), "Mozilla", "Firefox");
  return join(home, ".mozilla", "firefox");
}

function safariBookmarksPath(home: string): string {
  return join(home, "Library", "Safari", "Bookmarks.plist");
}

/**
 * A Chromium profile directory. Most browsers keep profiles under the user
 * data root (`Default`, `Profile 3`); Opera's user data root IS its only
 * profile, so a "Default" that does not exist as a folder means the root.
 */
function chromiumProfileDir(root: string, profileId: string): string {
  const nested = join(root, profileId);
  if (existsSync(nested)) return nested;
  return profileId === "Default" ? root : nested;
}

function readable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export interface DetectOptions {
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/* ------------------------------- detection ------------------------------ */

/** The browsers installed for this person, each with its profiles. Never throws. */
export async function detectBrowsers(options: DetectOptions = {}): Promise<InstalledBrowser[]> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const out: InstalledBrowser[] = [];
  const sessions = platform === "darwin";
  const sessionNote = sessions ? null : "Signed-in sessions can be brought over on macOS only; bookmarks still come along.";

  for (const location of chromiumLocations(home, platform, env)) {
    const localState = join(location.root, "Local State");
    if (!existsSync(localState)) continue;
    let listed: ReturnType<typeof parseLocalState> = [];
    try {
      listed = parseLocalState(JSON.parse(readFileSync(localState, "utf8")));
    } catch {
      listed = [];
    }
    if (listed.length === 0 && (existsSync(join(location.root, "Default")) || existsSync(join(location.root, "Cookies")))) {
      listed = [{ id: "Default", name: BROWSER_BRANDS[location.kind].name, account: null, lastUsed: true }];
    }
    const profiles: BrowserProfile[] = [];
    for (const profile of listed) {
      const dir = chromiumProfileDir(location.root, profile.id);
      if (!existsSync(dir)) continue;
      profiles.push({ ...profile, bookmarkCount: countChromiumBookmarks(dir) });
    }
    if (profiles.length === 0) continue;
    out.push({ kind: location.kind, profiles, supports: { sessions, bookmarks: true }, note: sessionNote });
  }

  const firefox = firefoxRoot(home, platform, env);
  const ini = join(firefox, "profiles.ini");
  if (existsSync(ini)) {
    const profiles: BrowserProfile[] = [];
    try {
      for (const profile of parseProfilesIni(readFileSync(ini, "utf8"))) {
        const dir = profile.isRelative ? join(firefox, profile.path) : profile.path;
        if (!existsSync(dir)) continue;
        profiles.push({
          id: profile.id,
          name: profile.name,
          account: firefoxAccount(dir),
          bookmarkCount: null,
          lastUsed: profile.isDefault,
        });
      }
    } catch {
      // An unreadable profiles.ini is no Firefox.
    }
    if (profiles.length > 0) {
      out.push({ kind: "firefox", profiles, supports: { sessions: true, bookmarks: true }, note: null });
    }
  }

  if (platform === "darwin" && existsSync("/Applications/Safari.app")) {
    const plist = safariBookmarksPath(home);
    const canRead = readable(plist);
    out.push({
      kind: "safari",
      profiles: [{ id: "Default", name: "Safari", account: null, bookmarkCount: null, lastUsed: true }],
      supports: { sessions: false, bookmarks: canRead },
      note: canRead
        ? "Safari keeps its sessions inside macOS; bookmarks come over."
        : "Reading Safari's bookmarks needs Full Disk Access for Pistachio (System Settings → Privacy & Security).",
    });
  }
  return out;
}

function countChromiumBookmarks(profileDir: string): number | null {
  const path = join(profileDir, "Bookmarks");
  if (!existsSync(path)) return 0;
  try {
    return countBookmarks(parseChromiumBookmarks(JSON.parse(readFileSync(path, "utf8"))));
  } catch {
    return null;
  }
}

/** The Firefox account a profile is signed into, from `signedInUser.json`. */
function firefoxAccount(profileDir: string): BrowserProfile["account"] {
  const path = join(profileDir, "signedInUser.json");
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { accountData?: { email?: unknown; displayName?: unknown } };
    const email = typeof raw.accountData?.email === "string" ? raw.accountData.email : null;
    const displayName = typeof raw.accountData?.displayName === "string" ? raw.accountData.displayName : null;
    return email === null && displayName === null ? null : { email, displayName };
  } catch {
    return null;
  }
}

/* -------------------------------- import -------------------------------- */

export interface ImportOptions extends DetectOptions {
  /** The Space's session the cookies land in. */
  session: Pick<Session, "cookies">;
  newId?: () => string;
  now?: () => number;
  /** How the keychain password is fetched — swapped out under test. */
  keychain?: (service: string) => Promise<string>;
}

export interface ImportOutcome {
  result: BrowserImportResult;
  /** Shelf entries to add — the bookmarks as pins in folders. */
  entries: SidebarEntry[];
}

/** Bring one profile over. Every failure becomes a `skipped` line, never a throw, unless the profile itself is missing. */
export async function importBrowserProfile(request: BrowserImportRequest, options: ImportOptions): Promise<ImportOutcome> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const newId = options.newId ?? randomUUID;
  const brand = BROWSER_BRANDS[request.browser];
  const result: BrowserImportResult = {
    browser: request.browser,
    profileId: request.profileId,
    cookies: 0,
    origins: [],
    bookmarks: 0,
    folders: 0,
    skipped: [],
  };
  let entries: SidebarEntry[] = [];
  let tree: ImportedBookmark[] = [];
  let cookies: ImportedCookie[] = [];

  if (request.browser === "safari") {
    if (request.bookmarks) {
      try {
        tree = await readSafariBookmarks(safariBookmarksPath(home));
      } catch (error) {
        result.skipped.push(`Bookmarks: ${describe(error)} Grant Pistachio Full Disk Access in System Settings to read them.`);
      }
    }
    if (request.sessions) result.skipped.push("Signed-in sessions: Safari keeps them inside macOS, so they cannot be copied.");
  } else if (request.browser === "firefox") {
    const root = firefoxRoot(home, platform, env);
    const profile = parseProfilesIni(readFileSync(join(root, "profiles.ini"), "utf8")).find((p) => p.id === request.profileId);
    if (profile === undefined) throw new Error("That Firefox profile is no longer there.");
    const dir = profile.isRelative ? join(root, profile.path) : profile.path;
    if (request.bookmarks) {
      try {
        tree = readFirefoxBookmarks(dir);
      } catch (error) {
        result.skipped.push(`Bookmarks: ${describe(error)}`);
      }
    }
    if (request.sessions) {
      try {
        cookies = readFirefoxCookies(dir);
      } catch (error) {
        result.skipped.push(`Signed-in sessions: ${describe(error)}`);
      }
    }
  } else {
    const location = chromiumLocations(home, platform, env).find((l) => l.kind === request.browser);
    if (location === undefined) throw new Error(`${brand.name} is not installed here.`);
    const dir = chromiumProfileDir(location.root, request.profileId);
    if (!existsSync(dir)) throw new Error(`That ${brand.name} profile is no longer there.`);
    if (request.bookmarks) {
      try {
        tree = readChromiumBookmarks(dir);
      } catch (error) {
        result.skipped.push(`Bookmarks: ${describe(error)}`);
      }
    }
    if (request.sessions) {
      if (platform !== "darwin") {
        result.skipped.push("Signed-in sessions: bringing them over is supported on macOS only.");
      } else {
        try {
          const password = await (options.keychain ?? keychainPassword)(location.keychainService);
          cookies = readChromiumCookies(dir, deriveChromiumKey(password));
        } catch (error) {
          result.skipped.push(
            `Signed-in sessions: Pistachio could not read ${brand.name}'s keychain entry (${describe(error)}). Allow it in the macOS prompt to bring sessions over.`,
          );
        }
      }
    }
  }

  if (tree.length > 0) {
    const built = bookmarksToEntries(tree, `${brand.name} bookmarks`, newId);
    entries = built.entries;
    result.bookmarks = built.pins;
    result.folders = built.folders;
    const total = countBookmarks(tree);
    if (total > built.pins) result.skipped.push(`Bookmarks: ${String(total - built.pins)} beyond the sidebar's limit were left behind.`);
  } else if (request.bookmarks && result.skipped.every((line) => !line.startsWith("Bookmarks"))) {
    result.skipped.push("Bookmarks: none found in that profile.");
  }

  if (cookies.length > 0) {
    const now = (options.now ?? Date.now)() / 1000;
    const pairs = cookies.flatMap((cookie) => {
      const details = cookieDetails(cookie, now);
      return details === null ? [] : [{ cookie, details }];
    });
    let failed = 0;
    const kept: ImportedCookie[] = [];
    // Chunked: a busy profile holds thousands, and the session takes them concurrently.
    for (let index = 0; index < pairs.length; index += 64) {
      const chunk = pairs.slice(index, index + 64);
      const outcomes = await Promise.allSettled(chunk.map((pair) => options.session.cookies.set(pair.details)));
      outcomes.forEach((outcome, offset) => {
        if (outcome.status === "fulfilled") {
          result.cookies += 1;
          kept.push(chunk[offset]!.cookie);
        } else failed += 1;
      });
    }
    result.origins = cookieOrigins(kept);
    if (failed > 0) result.skipped.push(`Signed-in sessions: ${String(failed)} cookies could not be stored.`);
    try {
      await options.session.cookies.flushStore();
    } catch {
      // The cookies are in memory either way; the store catches up on its own.
    }
  } else if (request.sessions && result.skipped.every((line) => !line.startsWith("Signed-in sessions"))) {
    result.skipped.push("Signed-in sessions: no cookies found in that profile.");
  }

  return { result, entries };
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.endsWith(".") ? message : `${message}.`;
}

/* ------------------------------- chromium ------------------------------- */

function readChromiumBookmarks(profileDir: string): ImportedBookmark[] {
  const path = join(profileDir, "Bookmarks");
  if (!existsSync(path)) return [];
  return parseChromiumBookmarks(JSON.parse(readFileSync(path, "utf8")));
}

/** The login keychain's password for a browser's cookie key. macOS asks the person first. */
export async function keychainPassword(service: string): Promise<string> {
  const { stdout } = await run("security", ["find-generic-password", "-w", "-s", service], { timeout: 180_000 });
  const password = stdout.trim();
  if (password === "") throw new Error("the keychain returned nothing");
  return password;
}

/** Chromium's os_crypt on macOS: PBKDF2-SHA1, salt "saltysalt", 1003 rounds, 128-bit key. */
export function deriveChromiumKey(password: string): Buffer {
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

/** The IV os_crypt uses: sixteen spaces. */
const CHROMIUM_IV = Buffer.alloc(16, 0x20);
/** Cookie schema version from which the plaintext starts with SHA-256(host_key). */
const CHROMIUM_DOMAIN_HASH_VERSION = 24;

/**
 * One `encrypted_value`: "v10" then AES-128-CBC ciphertext. Null when the
 * prefix is something else (Linux's "v11", or a value this key cannot
 * open), so the caller can count it and move on.
 */
export function decryptChromiumCookieValue(encrypted: Uint8Array, key: Buffer, schemaVersion: number): string | null {
  if (encrypted.length < 3) return "";
  const prefix = Buffer.from(encrypted.subarray(0, 3)).toString("latin1");
  if (prefix !== "v10") return null;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, CHROMIUM_IV);
    let plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    if (schemaVersion >= CHROMIUM_DOMAIN_HASH_VERSION) plain = plain.subarray(32);
    return plain.toString("utf8");
  } catch {
    return null;
  }
}

interface ChromiumCookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array | null;
  path: string;
  expires_utc: bigint;
  is_secure: bigint;
  is_httponly: bigint;
  samesite: bigint;
  has_expires: bigint;
}

/** Every cookie a Chromium profile holds, decrypted. Copies the database first. */
export function readChromiumCookies(profileDir: string, key: Buffer): ImportedCookie[] {
  // Chrome 96 moved the file under Network/; older profiles keep it at the root.
  const candidates = [join(profileDir, "Network", "Cookies"), join(profileDir, "Cookies")];
  const source = candidates.find((path) => existsSync(path));
  if (source === undefined) throw new Error("no cookie database in that profile");
  return withCopiedDatabase(source, (db) => {
    const schemaVersion = Number(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.["value"] ?? 0);
    const statement = db.prepare(
      "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, has_expires FROM cookies",
    );
    statement.setReadBigInts(true);
    const rows = statement.all() as unknown as ChromiumCookieRow[];
    const out: ImportedCookie[] = [];
    for (const row of rows) {
      const value =
        row.value !== "" || row.encrypted_value === null || row.encrypted_value.length === 0
          ? row.value
          : decryptChromiumCookieValue(row.encrypted_value, key, schemaVersion);
      if (value === null) continue;
      out.push({
        host: row.host_key,
        name: row.name,
        value,
        path: row.path,
        secure: row.is_secure !== 0n,
        httpOnly: row.is_httponly !== 0n,
        sameSite: chromiumSameSite(row.samesite),
        expires: row.has_expires === 0n ? null : chromiumTimeToUnixSeconds(row.expires_utc),
      });
    }
    return out;
  });
}

/* -------------------------------- firefox ------------------------------- */

interface FirefoxCookieRow {
  host: string;
  name: string;
  value: string;
  path: string;
  expiry: bigint;
  isSecure: bigint;
  isHttpOnly: bigint;
  sameSite: bigint;
}

export function readFirefoxCookies(profileDir: string): ImportedCookie[] {
  const source = join(profileDir, "cookies.sqlite");
  if (!existsSync(source)) throw new Error("no cookie database in that profile");
  return withCopiedDatabase(source, (db) => {
    const statement = db.prepare("SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies");
    statement.setReadBigInts(true);
    return (statement.all() as unknown as FirefoxCookieRow[]).map((row) => ({
      host: row.host,
      name: row.name,
      value: row.value,
      path: row.path,
      secure: row.isSecure !== 0n,
      httpOnly: row.isHttpOnly !== 0n,
      sameSite: firefoxSameSite(row.sameSite),
      expires: row.expiry === 0n ? null : Number(row.expiry),
    }));
  });
}

interface FirefoxBookmarkRow {
  id: bigint;
  parent: bigint;
  type: bigint;
  title: string | null;
  url: string | null;
  guid: string;
}

const FIREFOX_ROOTS: Record<string, string | null> = {
  toolbar_____: null,
  menu________: "Bookmarks Menu",
  unfiled_____: "Other Bookmarks",
  mobile______: "Mobile Bookmarks",
};

/** Firefox's `moz_bookmarks` tree: type 1 is a link (through `moz_places`), 2 a folder. */
export function readFirefoxBookmarks(profileDir: string): ImportedBookmark[] {
  const source = join(profileDir, "places.sqlite");
  if (!existsSync(source)) return [];
  return withCopiedDatabase(source, (db) => {
    const statement = db.prepare(
      "SELECT b.id, b.parent, b.type, b.title, b.guid, p.url FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.parent, b.position",
    );
    statement.setReadBigInts(true);
    const rows = statement.all() as unknown as FirefoxBookmarkRow[];
    return firefoxRowsToTree(rows);
  });
}

/** Pure, so the tree-building is testable without a database. */
export function firefoxRowsToTree(rows: readonly FirefoxBookmarkRow[]): ImportedBookmark[] {
  const children = new Map<bigint, FirefoxBookmarkRow[]>();
  for (const row of rows) {
    const list = children.get(row.parent) ?? [];
    list.push(row);
    children.set(row.parent, list);
  }
  const build = (parentId: bigint): ImportedBookmark[] => {
    const out: ImportedBookmark[] = [];
    for (const row of children.get(parentId) ?? []) {
      if (row.type === 2n) {
        const folder: ImportedBookmarkFolder = { kind: "folder", name: row.title ?? "", children: build(row.id) };
        out.push(folder);
      } else if (row.type === 1n && row.url !== null && /^https?:/.test(row.url)) {
        const link: ImportedBookmarkLink = { kind: "link", title: row.title ?? "", url: row.url };
        out.push(link);
      }
    }
    return out;
  };
  const out: ImportedBookmark[] = [];
  for (const [guid, label] of Object.entries(FIREFOX_ROOTS)) {
    const root = rows.find((row) => row.guid === guid);
    if (root === undefined) continue;
    const built = build(root.id);
    if (label === null) out.push(...built);
    else if (built.length > 0) out.push({ kind: "folder", name: label, children: built });
  }
  return out;
}

/* -------------------------------- safari -------------------------------- */

async function readSafariBookmarks(plist: string): Promise<ImportedBookmark[]> {
  const { stdout } = await run("plutil", ["-convert", "json", "-o", "-", plist], { maxBuffer: 64 * 1024 * 1024 });
  return parseSafariBookmarks(JSON.parse(stdout));
}

/* -------------------------------- sqlite -------------------------------- */

/**
 * Copy a browser database (and its journal) somewhere private, open that
 * copy read-only, hand it to `read`, and clean up — the browser's own file
 * is never opened, let alone written.
 */
function withCopiedDatabase<T>(source: string, read: (db: DatabaseSync) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pistachio-import-"));
  const copy = join(dir, "db.sqlite");
  try {
    copyFileSync(source, copy);
    for (const suffix of ["-wal", "-journal", "-shm"]) {
      if (existsSync(`${source}${suffix}`)) copyFileSync(`${source}${suffix}`, `${copy}${suffix}`);
    }
    const { DatabaseSync } = sqlite();
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
