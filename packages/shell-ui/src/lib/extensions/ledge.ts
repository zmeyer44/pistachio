/**
 * What the shell says about extensions, pure (docs/extensions.md §2): which
 * of them stand on the Ledge and in what order, how many fit, the dot an
 * icon carries, the monogram one without an icon wears, where one came from
 * and where it runs, and what the extensions page's field finds. No React,
 * no DOM, so vitest pins them under node (test/extensions-ledge.test.ts).
 *
 * Everything here reads the snapshot alone (`ExtensionsSnapshot`): the shell
 * draws extensions from what main publishes, never from their own code.
 */

import {
  LEDGE_GAP,
  LEDGE_SLOT,
  type ExtensionInfo,
  type ExtensionSheet,
  type ExtensionSheetLine,
  type ExtensionSource,
  type ExtensionTier,
} from "@pistachio/shell-contracts/extensions";

/**
 * The Ledge's icons, in the person's order: the pinned ones that are on —
 * or that wait on the person (a never-approved folder main pinned, a widened
 * manifest), which carry the amber dot instead of running. Order is per
 * Profile and main's (`order`); a tie keeps the names' order, so two
 * extensions pinned in one tick never swap places between publishes.
 */
export function ledgeExtensionsOf(extensions: readonly ExtensionInfo[]): ExtensionInfo[] {
  return extensions
    .filter((extension) => extension.pinned && (extension.enabled || extension.pending !== null))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * How many icons stand on a Ledge `width` px wide before the rest flow into
 * its ⋯ (which always ends the strip, a slot of its own). Six at the card's
 * default width (224 less its padding).
 */
export function ledgeCapacity(width: number, count: number): number {
  const step = LEDGE_SLOT + LEDGE_GAP;
  // (The ⋯ is a slot too: n icons and the ⋯ take n·step + SLOT.)
  const room = Math.floor((Math.max(0, width) - LEDGE_SLOT) / step);
  return Math.max(0, Math.min(count, room));
}

/** The dot an icon carries: amber when it needs the person, red when one of their own is broken (a store extension's noise is never surfaced). */
export type LedgeDot = "amber" | "red" | null;

export function ledgeDotOf(extension: Pick<ExtensionInfo, "status" | "pending" | "source">): LedgeDot {
  if (extension.pending !== null || extension.status === "needs-approval" || extension.status === "paused") return "amber";
  if (extension.status === "error" && isOwnSource(extension.source)) return "red";
  return null;
}

/** One the person wrote or loaded themselves: a dev folder, or an unpacked one. */
export function isOwnSource(source: ExtensionSource): boolean {
  return source.type === "dev" || source.type === "unpacked";
}

/** The letter (or two) an extension with no icon wears: its name's first letter, a second word's too. */
export function monogramOf(name: string): string {
  const words = name
    .trim()
    .split(/[\s\-_.]+/u)
    .filter((word) => /\p{L}|\p{N}/u.test(word));
  const first = [...(words[0] ?? "?")].find((char) => /\p{L}|\p{N}/u.test(char)) ?? "?";
  const second = words.length > 1 ? ([...(words[1] ?? "")].find((char) => /\p{L}|\p{N}/u.test(char)) ?? "") : "";
  return `${first}${second}`.toUpperCase();
}

/** A hue from an id, the same every time (FNV-1a): a monogram's ground. */
export function hueOf(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 360;
}

/** A path under a home folder with the home as `~` (the renderer is not told the home folder: any `/Users/<name>/`). */
export function tildePath(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/u, "~").replace(/^\/home\/[^/]+(?=\/|$)/u, "~");
}

/** Where it came from, as the sheet's second line says it. */
export function sourceLine(source: ExtensionSource): string {
  switch (source.type) {
    case "bundled":
      return "Made by Pistachio";
    case "webstore":
      return "Chrome Web Store";
    case "dev":
      return `Yours · ${tildePath(source.path)}`;
    case "unpacked":
      return `Loaded from ${tildePath(source.path)}`;
  }
}

/** Its state in words, for a tooltip, a row, Settings. */
export function statusLabel(extension: Pick<ExtensionInfo, "status" | "enabled" | "enabledHere" | "pending" | "error">): string {
  if (extension.pending?.changedByAgent === true) return "Paused: Pistachio changed it";
  if (extension.pending !== null && extension.status !== "paused") return "Waiting for your approval";
  switch (extension.status) {
    case "needs-approval":
      return "Waiting for your approval";
    case "paused":
      return "Paused: it asks for more";
    case "error":
      return extension.error === null ? "Broken" : `Broken: ${extension.error.message}`;
    case "incompatible":
      return "Won't work in Pistachio";
    case "off":
      return extension.enabled && !extension.enabledHere ? "Off in this Profile" : "Off";
    case "running":
      return "Running";
    case "idle":
      return "On";
  }
}

/** Where it runs: every Profile, this one only, or none. */
export function whereItRuns(extension: Pick<ExtensionInfo, "enabled" | "enabledHere">): string {
  if (!extension.enabled) return "Off";
  return extension.enabledHere ? "On in this Profile" : "Off in this Profile";
}

/** An icon's hover title: its name, and what is the matter with it if anything is. */
export function ledgeTitle(extension: ExtensionInfo): string {
  const dot = ledgeDotOf(extension);
  if (dot !== null) return `${extension.name} · ${statusLabel(extension)}`;
  if (!extension.enabledHere) return `${extension.name} · Off in this Profile`;
  return extension.badge === null || extension.badge === "" ? extension.name : `${extension.name} · ${extension.badge}`;
}

/** The error's place in the person's own code, `file:line`, when main knows it. */
export function errorPlace(error: ExtensionInfo["error"]): string | null {
  if (error === null || error.file === undefined) return null;
  return error.line === undefined ? error.file : `${error.file}:${String(error.line)}`;
}

const TIER_RANK: Record<ExtensionTier, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * The sheet's *Can* lines: at most four, broadest first (main sends them so;
 * a stable sort keeps its order within a tier), and how many more there are
 * — those are under *See everything it declares*.
 */
export function sheetLines(sheet: Pick<ExtensionSheet, "can">, max = 4): { shown: ExtensionSheetLine[]; more: number } {
  const ordered = sheet.can.map((line, index) => ({ line, index })).sort((a, b) => TIER_RANK[a.line.tier] - TIER_RANK[b.line.tier] || a.index - b.index);
  return { shown: ordered.slice(0, max).map((entry) => entry.line), more: Math.max(0, ordered.length - max) };
}

/** Whether turning it on asks for a second confirm: a Critical line on the sheet. */
export function sheetIsCritical(sheet: Pick<ExtensionSheet, "can">): boolean {
  return sheet.can.some((line) => line.tier === "critical");
}

/** What the extensions page's field finds: each typed word begins a word of the name, the description or an id's part. */
export function extensionMatches(entry: { name: string; description: string; id?: string }, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return true;
  const words = [entry.name, entry.description, entry.id ?? ""].flatMap((text) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter(Boolean);
  return tokens.every((token) => words.some((word) => word.startsWith(token)));
}

/**
 * Whether a page's address is one a declared menu item's `hosts` take
 * (Chrome's match patterns: `<all_urls>`, `*://*.github.com/*`,
 * `https://example.com/path*`). None declared: every page.
 */
export function urlMatchesHosts(url: string, hosts: readonly string[]): boolean {
  if (hosts.length === 0) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return hosts.some((pattern) => {
    if (pattern === "<all_urls>") return /^(https?|file|ftp):$/u.test(parsed.protocol);
    const match = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/u.exec(pattern);
    if (match === null) return false;
    const [, scheme = "", host = "", path = "/*"] = match;
    const protocol = parsed.protocol.slice(0, -1);
    if (scheme === "*" ? protocol !== "http" && protocol !== "https" : scheme !== protocol) return false;
    if (host !== "*") {
      if (host.startsWith("*.")) {
        const base = host.slice(2);
        if (parsed.hostname !== base && !parsed.hostname.endsWith(`.${base}`)) return false;
      } else if (parsed.hostname !== host) return false;
    }
    const glob = new RegExp(`^${path.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "u");
    return glob.test(`${parsed.pathname}${parsed.search}`);
  });
}

/** The Chrome Web Store's search for what was typed. */
export function chromeWebStoreSearchUrl(query: string): string {
  return `https://chromewebstore.google.com/search/${encodeURIComponent(query.trim())}`;
}

export const CHROME_WEB_STORE_URL = "https://chromewebstore.google.com";

/**
 * Where a Ledge item goes when the one carried along it is let go at `x`:
 * among the others (the carried one taken out), the number whose middle is
 * left of the pointer. `centers` are the items' middles in order.
 */
export function ledgeDropIndex(centers: readonly number[], from: number, x: number): number {
  return centers.filter((center, index) => index !== from && center < x).length;
}
