/**
 * The address bar's tray of local apps (docs/local-apps.md §1): what a pill
 * is called, which apps a query reaches, how several ports of one project sit
 * together, and the line that tells one apart once it is chosen. Pure, so
 * vitest pins it (test/local-tray.test.ts); components/LocalTray.tsx draws it.
 */

import type { LocalApp } from "@pistachio/shell-contracts/local-apps";

/** This Mac's own names, as an address would be typed at them. */
const LOCAL_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];

/**
 * The name a pill leads with: the project, which is what a developer calls
 * the thing ("marius", not the page's "Marius" four times over, nor a
 * template's "Vite + React + TS"); else the page's title; else what serves it.
 */
export function localAppName(app: LocalApp): string {
  return app.project ?? app.title ?? app.server ?? "localhost";
}

/**
 * Whether what was typed is an address at this Mac, and if so whether it
 * reaches `port`; null when it is not an address at all (then it is words).
 * ":3000", "localhost:30", "http://127.0.0.1:3000/signin" name a port by its
 * first digits; "localhost" (or "loc", on its way there) names every one.
 */
function addressReaches(typed: string, port: string): boolean | null {
  const bare = /^:(\d*)$/u.exec(typed);
  if (bare !== null) return port.startsWith(bare[1] ?? "");
  // Digits alone are a port being typed: "51" is 5173's start, not a word.
  if (/^\d+$/u.test(typed)) return port.startsWith(typed);
  const address = /^(\[[^\]\s]*\]?|[^\s/:[\]]+)(?::(\d*))?(?:\/\S*)?$/u.exec(typed);
  if (address === null) return null;
  const host = address[1] ?? "";
  const typedPort = address[2];
  if (typedPort === undefined) {
    // Fewer letters than "loc" are the start of too many other words to mean this Mac.
    return host.length >= 3 && LOCAL_HOSTS.some((name) => name.startsWith(host)) ? true : null;
  }
  if (!LOCAL_HOSTS.includes(host) && !host.endsWith(".localhost")) return false;
  return port.startsWith(typedPort);
}

/** An app's words, for a query's words to begin: its name, title and server whole and word by word, and its port. */
function wordsOf(app: LocalApp): string[] {
  const words = new Set<string>([String(app.port)]);
  for (const text of [app.project, app.title, app.server]) {
    if (text === null) continue;
    const lower = text.toLowerCase();
    words.add(lower);
    for (const word of lower.split(/[^\p{L}\p{N}]+/u)) if (word !== "") words.add(word);
  }
  return [...words];
}

/**
 * Whether what was typed reaches `app`: an address of this Mac, with or
 * without a port (addressReaches), a port's first digits, or words that each
 * begin one of its words — "story", "acme web", "marius 52", "sign in".
 */
export function localAppMatches(app: LocalApp, query: string): boolean {
  const typed = query.trim().toLowerCase().replace(/^https?:\/\//u, "");
  if (typed === "") return true;
  const asAddress = addressReaches(typed, String(app.port));
  if (asAddress !== null) return asAddress;
  const words = wordsOf(app);
  return typed.split(/\s+/u).every((part) => words.some((word) => word.startsWith(part)));
}

/** One pill of the tray: a project's name said once, then each of its ports. */
export interface TrayGroup {
  key: string;
  name: string;
  /** Its apps, lowest port first: 5173 5231 5242 5243 reads as a list, newest-first does not. */
  apps: LocalApp[];
}

/**
 * The tray's pills: the apps of one project together under its name (four
 * Vite servers of one repository are one pill with four ports), each pill
 * where its newest app falls in the newest-first list. Apps with neither a
 * project nor a title have nothing to share, so each stands alone.
 */
export function trayGroups(apps: readonly LocalApp[]): TrayGroup[] {
  const groups = new Map<string, TrayGroup>();
  for (const app of apps) {
    const key = app.project !== null ? `project:${app.project}` : app.title !== null ? `title:${app.title}` : `port:${app.port}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { key, name: localAppName(app), apps: [app] });
    else group.apps.push(app);
  }
  for (const group of groups.values()) group.apps.sort((a, b) => a.port - b.port);
  return [...groups.values()];
}

/** How long a server has been up, in as few characters as say it: "just started", "up 12 min", "up 3 h", "up 2 d". */
export function uptime(startedAt: number | null, now: number): string | null {
  if (startedAt === null) return null;
  const minutes = Math.floor(Math.max(0, now - startedAt) / 60_000);
  if (minutes < 1) return "just started";
  if (minutes < 60) return `up ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `up ${hours} h` : `up ${Math.floor(hours / 24)} d`;
}

/**
 * What the pill does not say, for the field's line once it is chosen: what
 * serves it, unless its title says so already ("Vite + React + TS"), the
 * title when it is not just the name again, and how long it has been up —
 * which is what tells four "marius" ports apart.
 */
export function localAppDetail(app: LocalApp, now: number): string {
  const name = localAppName(app).toLowerCase();
  const title = app.title !== null && app.title.toLowerCase() !== name ? app.title : null;
  const server = app.server?.toLowerCase();
  const parts: string[] = [];
  if (app.server !== null && server !== name && (title === null || !title.toLowerCase().includes(server ?? ""))) parts.push(app.server);
  if (title !== null) parts.push(title);
  const up = uptime(app.startedAt, now);
  if (up !== null) parts.push(up);
  return parts.join(" · ");
}
