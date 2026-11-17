/**
 * What extensions have the shell showing (docs/primitives.md §4): the marks
 * on spaces' tiles, the themes — a backdrop, an accent — and the rows of the
 * band and the sidebar, kept by main in
 * `<userData>/extension-shown.json`, so they are there after the worker that
 * asked has stopped and after a restart, and gone the moment the person
 * removes them or the extension is. An extension hands over a value; the
 * shell draws it; nothing of the extension's runs to keep it up.
 *
 * A backdrop's picture is main's own copy: read once from the extension's
 * folder, checked to be the picture its name says, and kept by its hash in
 * `<userData>/ExtensionTheme/`, served to the shell at
 * `pistachio-ext://theme/<file>` — never from the extension's own address,
 * and unchanged by anything the folder does afterwards.
 *
 * One holder for each scope: a theme set for a space (or for every space)
 * takes the place of whoever's was there. Rows are each extension's own:
 * every extension's band and section are drawn, one beside or under another.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { ExtError, type ExtBackdrop, type ExtRow, type ExtSiteView, type ExtTheme } from "@pistachio/extension-api";
import { ROW_BUTTONS_MAX, ROW_BUTTON_TITLE_MAX, ROW_ID_PATTERN, ROW_TEXT_MAX, ROW_VALUE_MAX, SITE_ROWS_MAX, SITE_TITLE_MAX, isSite, type Site } from "@pistachio/extension-api/sites";
import { MARK_TONES, THEME_COLOR_PATTERN, THEME_DIM_MAX, THEME_IMAGE_MAX_BYTES, THEME_IMAGE_TYPES, THEME_SVG_MAX_BYTES, type MarkTone } from "@pistachio/extension-api/theme";
import { EXTENSION_SCHEME, type ExtensionBackdropValue, type ExtensionRow } from "@pistachio/shell-contracts/extensions";
import { fileInside } from "./protocol";

export const SHOWN_FILE = "extension-shown.json";
export const SHOWN_VERSION = 1;
export const THEME_DIR = "ExtensionTheme";
/** The host main's own pictures are served under: no extension's id (an id has a dot). */
export const THEME_HOST = "theme";
/** How many marks, and how many themes, one extension may have kept (the newest): one for each space it may hold, and one for all. */
export const MAX_SHOWN_PER_EXTENSION = 51;

const THEME_FILE_PATTERN = /^[0-9a-f]{32}\.(png|jpg|webp|svg)$/;

export interface StoredMark {
  extensionId: string;
  spaceId: string;
  glyph: string | null;
  tone: MarkTone;
  label: string;
  at: number;
}

/** How many marks on tabs one extension may have kept (the newest): a tab that closed while nobody was looking leaves one behind, and this bounds them. */
export const MAX_TAB_MARKS_PER_EXTENSION = 200;

/** An extension's mark on a tab's row (docs/primitives.md §4.7): a space's mark, by a tab's id. */
export interface StoredTabMark {
  extensionId: string;
  tabId: string;
  glyph: string | null;
  tone: MarkTone;
  label: string;
  at: number;
}

export type StoredBackdrop =
  | { kind: "color"; color: string }
  | { kind: "gradient"; colors: string[]; angle: number }
  /** `file`: main's copy, by its hash. `source`: the path the extension named, for `theme.get`. */
  | { kind: "image"; file: string; source: string; fit: "cover" | "contain" | "tile"; dim: number };

export interface StoredTheme {
  extensionId: string;
  /** The space it is for; null for every space. */
  spaceId: string | null;
  backdrop: StoredBackdrop | null;
  accent: string | null;
  at: number;
}

/** One row as main keeps it: every field there, so the shell draws what is kept and nothing is left to guess. */
export interface StoredRow {
  id: string | null;
  mark: { glyph: string | null; tone: MarkTone } | null;
  text: string;
  detail: string;
  value: string;
  buttons: { id: string; title: string }[];
}

/** What one extension has one place showing, for one scope. */
export interface StoredSite {
  extensionId: string;
  site: Site;
  /** The space it is for; null for every space. */
  spaceId: string | null;
  /** A sidebar section's heading; null for the extension's name. */
  title: string | null;
  rows: StoredRow[];
  at: number;
}

interface ShownDocument {
  version: typeof SHOWN_VERSION;
  marks: StoredMark[];
  tabMarks: StoredTabMark[];
  themes: StoredTheme[];
  sites: StoredSite[];
}

const empty = (): ShownDocument => ({ version: SHOWN_VERSION, marks: [], tabMarks: [], themes: [], sites: [] });
const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.length > 0 && value.length <= max ? value : null);
const colorOf = (value: unknown): string | null => (typeof value === "string" && THEME_COLOR_PATTERN.test(value) ? value.toLowerCase() : null);
const instant = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

function sanitizeBackdrop(value: unknown): StoredBackdrop | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw["kind"] === "color") {
    const color = colorOf(raw["color"]);
    return color === null ? null : { kind: "color", color };
  }
  if (raw["kind"] === "gradient") {
    const colors = (Array.isArray(raw["colors"]) ? raw["colors"] : []).flatMap((color) => colorOf(color) ?? []);
    const angle = typeof raw["angle"] === "number" && Number.isFinite(raw["angle"]) ? Math.min(360, Math.max(0, raw["angle"])) : 180;
    return colors.length < 2 || colors.length > 4 ? null : { kind: "gradient", colors, angle };
  }
  if (raw["kind"] === "image") {
    const file = text(raw["file"], 64);
    if (file === null || !THEME_FILE_PATTERN.test(file)) return null;
    const fit = raw["fit"] === "contain" || raw["fit"] === "tile" ? raw["fit"] : "cover";
    const dim = typeof raw["dim"] === "number" && Number.isFinite(raw["dim"]) ? Math.min(THEME_DIM_MAX, Math.max(0, raw["dim"])) : 0;
    return { kind: "image", file, source: text(raw["source"], 200) ?? "", fit, dim };
  }
  return null;
}

/** One line of an extension's words: no breaks, no control characters, no longer than its place allows. */
// eslint-disable-next-line no-control-regex
const lineOf = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, max) : "");
const rowId = (value: unknown): string | null => (typeof value === "string" && ROW_ID_PATTERN.test(value) ? value : null);

function sanitizeRow(value: unknown): StoredRow | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const said = lineOf(raw["text"], ROW_TEXT_MAX);
  if (said.trim() === "") return null;
  const rawMark = raw["mark"];
  const mark =
    typeof rawMark === "object" && rawMark !== null
      ? {
          glyph: text((rawMark as Record<string, unknown>)["glyph"], 16),
          tone: (MARK_TONES as readonly unknown[]).includes((rawMark as Record<string, unknown>)["tone"]) ? ((rawMark as Record<string, unknown>)["tone"] as MarkTone) : ("neutral" as const),
        }
      : null;
  const buttons: { id: string; title: string }[] = [];
  for (const entry of Array.isArray(raw["buttons"]) ? raw["buttons"] : []) {
    if (typeof entry !== "object" || entry === null || buttons.length >= ROW_BUTTONS_MAX) continue;
    const id = rowId((entry as Record<string, unknown>)["id"]);
    const title = lineOf((entry as Record<string, unknown>)["title"], ROW_BUTTON_TITLE_MAX);
    if (id !== null && title.trim() !== "" && !buttons.some((kept) => kept.id === id)) buttons.push({ id, title });
  }
  return { id: rowId(raw["id"]), mark, text: said, detail: lineOf(raw["detail"], ROW_TEXT_MAX), value: lineOf(raw["value"], ROW_VALUE_MAX), buttons };
}

function sanitizeSites(value: unknown): StoredSite[] {
  const sites: StoredSite[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const extensionId = text(raw["extensionId"], 200);
    const site = raw["site"];
    const spaceId = raw["spaceId"] === null ? null : text(raw["spaceId"], 128);
    if (extensionId === null || !isSite(site) || (raw["spaceId"] !== null && spaceId === null)) continue;
    // (One for each extension, place and scope: the first read is the one kept.)
    if (sites.some((kept) => kept.extensionId === extensionId && kept.site === site && kept.spaceId === spaceId)) continue;
    const rows: StoredRow[] = [];
    for (const row of Array.isArray(raw["rows"]) ? raw["rows"] : []) {
      const kept = rows.length >= SITE_ROWS_MAX[site] ? null : sanitizeRow(row);
      // (An id twice could not say which row was pressed: the second row is kept, unpressable.)
      if (kept !== null) rows.push(kept.id !== null && rows.some((other) => other.id === kept.id) ? { ...kept, id: null } : kept);
    }
    if (rows.length === 0) continue;
    const title = lineOf(raw["title"], SITE_TITLE_MAX).trim();
    sites.push({ extensionId, site, spaceId, title: title === "" ? null : title, rows, at: instant(raw["at"]) });
  }
  return sites;
}

export function sanitizeShown(value: unknown): ShownDocument {
  if (typeof value !== "object" || value === null) return empty();
  const raw = value as Record<string, unknown>;
  if (raw["version"] !== SHOWN_VERSION) return empty();
  const marks: StoredMark[] = [];
  for (const entry of Array.isArray(raw["marks"]) ? raw["marks"] : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const mark = entry as Record<string, unknown>;
    const extensionId = text(mark["extensionId"], 200);
    const spaceId = text(mark["spaceId"], 128);
    const label = text(mark["label"], 60);
    if (extensionId === null || spaceId === null || label === null) continue;
    if (marks.some((kept) => kept.extensionId === extensionId && kept.spaceId === spaceId)) continue;
    marks.push({
      extensionId,
      spaceId,
      glyph: text(mark["glyph"], 16),
      tone: (MARK_TONES as readonly unknown[]).includes(mark["tone"]) ? (mark["tone"] as MarkTone) : "neutral",
      label,
      at: instant(mark["at"]),
    });
  }
  const tabMarks: StoredTabMark[] = [];
  for (const entry of Array.isArray(raw["tabMarks"]) ? raw["tabMarks"] : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const mark = entry as Record<string, unknown>;
    const extensionId = text(mark["extensionId"], 200);
    const tabId = text(mark["tabId"], 128);
    const label = text(mark["label"], 60);
    if (extensionId === null || tabId === null || label === null) continue;
    if (tabMarks.some((kept) => kept.extensionId === extensionId && kept.tabId === tabId)) continue;
    if (tabMarks.filter((kept) => kept.extensionId === extensionId).length >= MAX_TAB_MARKS_PER_EXTENSION) continue;
    tabMarks.push({
      extensionId,
      tabId,
      glyph: text(mark["glyph"], 16),
      tone: (MARK_TONES as readonly unknown[]).includes(mark["tone"]) ? (mark["tone"] as MarkTone) : "neutral",
      label,
      at: instant(mark["at"]),
    });
  }
  const themes: StoredTheme[] = [];
  for (const entry of Array.isArray(raw["themes"]) ? raw["themes"] : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const theme = entry as Record<string, unknown>;
    const extensionId = text(theme["extensionId"], 200);
    const spaceId = theme["spaceId"] === null ? null : text(theme["spaceId"], 128);
    if (extensionId === null || (theme["spaceId"] !== null && spaceId === null)) continue;
    const backdrop = sanitizeBackdrop(theme["backdrop"]);
    const accent = colorOf(theme["accent"]);
    if (backdrop === null && accent === null) continue;
    // (One holder for each scope: the first read is the one kept.)
    if (themes.some((kept) => kept.spaceId === spaceId)) continue;
    themes.push({ extensionId, spaceId, backdrop, accent, at: instant(theme["at"]) });
  }
  return { version: SHOWN_VERSION, marks, tabMarks, themes, sites: sanitizeSites(raw["sites"]) };
}

export class ShownStore {
  readonly #path: string;
  readonly #themeDir: string;
  #document: ShownDocument;

  constructor(userDataDir: string) {
    this.#path = join(userDataDir, SHOWN_FILE);
    this.#themeDir = join(userDataDir, THEME_DIR);
    this.#document = this.#read();
  }

  /** Where main keeps backdrops' pictures. */
  get themeDir(): string {
    return this.#themeDir;
  }

  /* --------------------------------- marks --------------------------------- */

  marks(): StoredMark[] {
    return structuredClone(this.#document.marks);
  }

  /** An extension's mark on a space: one, replaced whole. False when it is what was there already. */
  setMark(mark: Omit<StoredMark, "at">, at: number): boolean {
    const held = this.#document.marks.find((kept) => kept.extensionId === mark.extensionId && kept.spaceId === mark.spaceId);
    if (held !== undefined && held.glyph === mark.glyph && held.tone === mark.tone && held.label === mark.label) return false;
    const others = this.#document.marks.filter((kept) => kept !== held);
    const mine = others.filter((kept) => kept.extensionId === mark.extensionId);
    // (Past the bound the oldest of its own goes.)
    const dropped = mine.length >= MAX_SHOWN_PER_EXTENSION ? mine.sort((a, b) => a.at - b.at)[0] : undefined;
    this.#document.marks = [...others.filter((kept) => kept !== dropped), { ...mark, at }];
    this.#write();
    return true;
  }

  clearMark(extensionId: string, spaceId: string): boolean {
    const before = this.#document.marks.length;
    this.#document.marks = this.#document.marks.filter((kept) => !(kept.extensionId === extensionId && kept.spaceId === spaceId));
    if (this.#document.marks.length === before) return false;
    this.#write();
    return true;
  }

  /* ------------------------------ marks on tabs ----------------------------- */

  tabMarks(): StoredTabMark[] {
    return structuredClone(this.#document.tabMarks);
  }

  /** Whether any tab is marked: whoever watches the tabs close asks, before walking them. */
  get hasTabMarks(): boolean {
    return this.#document.tabMarks.length > 0;
  }

  /** An extension's mark on a tab: one, replaced whole. False when it is what was there already. */
  setTabMark(mark: Omit<StoredTabMark, "at">, at: number): boolean {
    const held = this.#document.tabMarks.find((kept) => kept.extensionId === mark.extensionId && kept.tabId === mark.tabId);
    if (held !== undefined && held.glyph === mark.glyph && held.tone === mark.tone && held.label === mark.label) return false;
    const others = this.#document.tabMarks.filter((kept) => kept !== held);
    const mine = others.filter((kept) => kept.extensionId === mark.extensionId);
    // (Past the bound the oldest of its own goes.)
    const dropped = mine.length >= MAX_TAB_MARKS_PER_EXTENSION ? mine.sort((a, b) => a.at - b.at)[0] : undefined;
    this.#document.tabMarks = [...others.filter((kept) => kept !== dropped), { ...mark, at }];
    this.#write();
    return true;
  }

  /** An extension's mark off one tab — or, `tabId` null, off every tab (the person's Remove). */
  clearTabMark(extensionId: string, tabId: string | null): boolean {
    const before = this.#document.tabMarks.length;
    this.#document.tabMarks = this.#document.tabMarks.filter((kept) => !(kept.extensionId === extensionId && (tabId === null || kept.tabId === tabId)));
    if (this.#document.tabMarks.length === before) return false;
    this.#write();
    return true;
  }

  /** These tabs closed: whatever marked them has nothing left to mark. */
  dropTabs(tabIds: readonly string[]): boolean {
    if (tabIds.length === 0 || this.#document.tabMarks.length === 0) return false;
    const gone = new Set(tabIds);
    const before = this.#document.tabMarks.length;
    this.#document.tabMarks = this.#document.tabMarks.filter((kept) => !gone.has(kept.tabId));
    if (this.#document.tabMarks.length === before) return false;
    this.#write();
    return true;
  }

  /* --------------------------------- themes -------------------------------- */

  themes(): StoredTheme[] {
    return structuredClone(this.#document.themes);
  }

  /** The theme held for a scope (a space, or null for every space), whoever's. */
  themeAt(spaceId: string | null): StoredTheme | null {
    const held = this.#document.themes.find((kept) => kept.spaceId === spaceId);
    return held === undefined ? null : structuredClone(held);
  }

  /** An extension's own theme for a scope; null when it holds none there (another's took its place, or the person removed it). */
  themeOf(extensionId: string, spaceId: string | null): StoredTheme | null {
    const held = this.themeAt(spaceId);
    return held !== null && held.extensionId === extensionId ? held : null;
  }

  /** Set the theme for its scope, in place of whoever's was there. False when it is what was there already. */
  setTheme(theme: Omit<StoredTheme, "at">, at: number): boolean {
    const held = this.#document.themes.find((kept) => kept.spaceId === theme.spaceId);
    if (held !== undefined && held.extensionId === theme.extensionId && held.accent === theme.accent && JSON.stringify(held.backdrop) === JSON.stringify(theme.backdrop)) return false;
    const others = this.#document.themes.filter((kept) => kept !== held);
    const mine = others.filter((kept) => kept.extensionId === theme.extensionId);
    const dropped = mine.length >= MAX_SHOWN_PER_EXTENSION ? mine.sort((a, b) => a.at - b.at)[0] : undefined;
    this.#document.themes = [...others.filter((kept) => kept !== dropped), { ...structuredClone(theme), at }];
    this.#write();
    this.sweep();
    return true;
  }

  clearTheme(extensionId: string, spaceId: string | null): boolean {
    const before = this.#document.themes.length;
    this.#document.themes = this.#document.themes.filter((kept) => !(kept.extensionId === extensionId && kept.spaceId === spaceId));
    if (this.#document.themes.length === before) return false;
    this.#write();
    this.sweep();
    return true;
  }

  /* ---------------------------------- rows --------------------------------- */

  sites(): StoredSite[] {
    return structuredClone(this.#document.sites);
  }

  /** What an extension has a place showing for a scope (a space, or null for every space); null for nothing. */
  siteOf(extensionId: string, site: Site, spaceId: string | null): StoredSite | null {
    const held = this.#document.sites.find((kept) => kept.extensionId === extensionId && kept.site === site && kept.spaceId === spaceId);
    return held === undefined ? null : structuredClone(held);
  }

  /** An extension's rows for a place and a scope, replaced whole. False when they are what was there already. */
  setSite(view: Omit<StoredSite, "at">, at: number): boolean {
    const held = this.#document.sites.find((kept) => kept.extensionId === view.extensionId && kept.site === view.site && kept.spaceId === view.spaceId);
    if (held !== undefined && held.title === view.title && JSON.stringify(held.rows) === JSON.stringify(view.rows)) return false;
    const others = this.#document.sites.filter((kept) => kept !== held);
    const mine = others.filter((kept) => kept.extensionId === view.extensionId && kept.site === view.site);
    const dropped = mine.length >= MAX_SHOWN_PER_EXTENSION ? mine.sort((a, b) => a.at - b.at)[0] : undefined;
    this.#document.sites = [...others.filter((kept) => kept !== dropped), { ...structuredClone(view), at }];
    this.#write();
    return true;
  }

  clearSite(extensionId: string, site: Site, spaceId: string | null): boolean {
    const before = this.#document.sites.length;
    this.#document.sites = this.#document.sites.filter((kept) => !(kept.extensionId === extensionId && kept.site === site && kept.spaceId === spaceId));
    if (this.#document.sites.length === before) return false;
    this.#write();
    return true;
  }

  /** The extension is gone, or off: everything it had the shell showing goes with it. */
  forget(extensionId: string): boolean {
    const had =
      this.#document.marks.some((kept) => kept.extensionId === extensionId) ||
      this.#document.tabMarks.some((kept) => kept.extensionId === extensionId) ||
      this.#document.themes.some((kept) => kept.extensionId === extensionId) ||
      this.#document.sites.some((kept) => kept.extensionId === extensionId);
    if (!had) return false;
    this.#document.marks = this.#document.marks.filter((kept) => kept.extensionId !== extensionId);
    this.#document.tabMarks = this.#document.tabMarks.filter((kept) => kept.extensionId !== extensionId);
    this.#document.themes = this.#document.themes.filter((kept) => kept.extensionId !== extensionId);
    this.#document.sites = this.#document.sites.filter((kept) => kept.extensionId !== extensionId);
    this.#write();
    this.sweep();
    return true;
  }

  /* -------------------------------- pictures ------------------------------- */

  /** The pictures no theme names any more are removed. */
  sweep(): void {
    const named = new Set(this.#document.themes.flatMap((theme) => (theme.backdrop?.kind === "image" ? [theme.backdrop.file] : [])));
    let files: string[];
    try {
      files = readdirSync(this.#themeDir);
    } catch {
      return;
    }
    for (const file of files) if (!named.has(file)) rmSync(join(this.#themeDir, file), { force: true });
  }

  #read(): ShownDocument {
    try {
      return sanitizeShown(JSON.parse(readFileSync(this.#path, "utf8")));
    } catch {
      return empty();
    }
  }

  #write(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#document, null, 2));
      renameSync(tmp, this.#path);
    } catch (error) {
      console.error("[extensions] could not write what extensions show", error);
    }
  }
}

/* --------------------------------- pictures --------------------------------- */

const refuse = (message: string): never => {
  throw new ExtError("INVALID_ARGUMENT", `theme.set: ${message}`);
};

/** What a file's first bytes say it is, among the pictures a backdrop may be; null for anything else. */
export function sniffPicture(bytes: Uint8Array): "png" | "jpg" | "webp" | "svg" | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  const ascii = (from: number, to: number): string => String.fromCharCode(...bytes.slice(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  // (An SVG is text: an `<svg` element near its start, after at most a declaration, a doctype, comments.)
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 4096));
  if (/^\uFEFF?\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return "svg";
  return null;
}

/**
 * Take a picture of an extension's folder into main's keeping: inside the folder (never through a link out of it),
 * of a kind a backdrop may be, no larger than it may be, and really the picture its name says. Answers the file's
 * name in `dir` — its hash, so the same picture is kept once. Throws INVALID_ARGUMENT in words the author can act on.
 */
export function adoptThemeImage(root: string, path: string, dir: string): string {
  const type = extname(path).toLowerCase();
  if (!(THEME_IMAGE_TYPES as readonly string[]).includes(type)) refuse(`"${path}" is not a picture a backdrop can be: ${THEME_IMAGE_TYPES.join(", ")}`);
  const file = fileInside(root, path.replace(/\\/g, "/"));
  if (file === null) return refuse(`there is no "${path}" in the extension's folder (a path relative to pistachio.json, like art/field.svg)`);
  const max = type === ".svg" ? THEME_SVG_MAX_BYTES : THEME_IMAGE_MAX_BYTES;
  if (file.size > max) refuse(`"${path}" is ${String(Math.ceil(file.size / 1024))} KB: ${type === ".svg" ? "an SVG" : "a picture"} may be ${String(Math.round(max / 1024))} KB at most`);
  const bytes = readFileSync(file.path);
  const kind = sniffPicture(bytes);
  const named = type === ".jpeg" ? "jpg" : type.slice(1);
  if (kind === null || kind !== named) refuse(`"${path}" is not a ${type} picture: its contents are ${kind === null ? "not a picture Pistachio draws" : `a .${kind}`}`);
  const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.${named}`;
  mkdirSync(dir, { recursive: true });
  const target = join(dir, name);
  try {
    writeFileSync(target, bytes, { flag: "wx" });
  } catch (error) {
    // (There already: the same picture, kept once.)
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return name;
}

/** The address the shell draws one of main's pictures from. */
export function themeImageUrl(file: string): string {
  return `${EXTENSION_SCHEME}://${THEME_HOST}/${file}`;
}

const PICTURE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };

/**
 * The default session's answer for `pistachio-ext://theme/<file>`: one of main's own pictures, by its hashed name
 * and nothing else. Null for any other host (the caller's to answer). An SVG is served to be drawn as an image, and
 * told so: no scripts, nothing fetched.
 */
export function serveThemeRequest(request: Request, dir: string): Response | null {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (url.hostname !== THEME_HOST) return null;
  const file = url.pathname.replace(/^\/+/, "");
  const missing = (): Response => new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
  if (!THEME_FILE_PATTERN.test(file)) return missing();
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(dir, file));
  } catch {
    return missing();
  }
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": PICTURE_TYPES[file.split(".").pop() ?? ""] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
      // (Named by its hash: the same name is always the same picture.)
      "cache-control": "public, max-age=31536000, immutable",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

/* ------------------------------ as the wire has it ------------------------------ */

/** A backdrop as the extension handed it over, made main's: a picture is copied in (`adopt`), colours lowered, defaults filled. */
export function storedBackdrop(backdrop: ExtBackdrop, adopt: (path: string) => string): StoredBackdrop {
  if ("color" in backdrop) return { kind: "color", color: backdrop.color.toLowerCase() };
  if ("gradient" in backdrop) return { kind: "gradient", colors: backdrop.gradient.colors.map((color) => color.toLowerCase()), angle: backdrop.gradient.angle ?? 180 };
  return { kind: "image", file: adopt(backdrop.image), source: backdrop.image, fit: backdrop.fit ?? "cover", dim: backdrop.dim ?? 0 };
}

/** A kept theme as its extension set it (`theme.get`). */
export function extTheme(theme: StoredTheme): ExtTheme {
  const backdrop = theme.backdrop;
  return {
    ...(backdrop === null
      ? {}
      : {
          backdrop:
            backdrop.kind === "color"
              ? { color: backdrop.color }
              : backdrop.kind === "gradient"
                ? { gradient: { colors: [...backdrop.colors], angle: backdrop.angle } }
                : { image: backdrop.source, fit: backdrop.fit, dim: backdrop.dim },
        }),
    ...(theme.accent === null ? {} : { colors: { accent: theme.accent } }),
    ...(theme.spaceId === null ? {} : { spaceId: theme.spaceId }),
  };
}

/** A kept backdrop as the shell paints it. */
export function backdropValue(backdrop: StoredBackdrop): { value: ExtensionBackdropValue; dim: number } {
  if (backdrop.kind === "image") return { value: { kind: "image", url: themeImageUrl(backdrop.file), fit: backdrop.fit }, dim: backdrop.dim };
  return { value: backdrop.kind === "color" ? { kind: "color", color: backdrop.color } : { kind: "gradient", colors: [...backdrop.colors], angle: backdrop.angle }, dim: 0 };
}

/** What a theme is made of, in the words the extensions page lists it by. */
export function themeDetail(theme: Pick<StoredTheme, "backdrop" | "accent">): string {
  if (theme.backdrop !== null && theme.accent !== null) return "Backdrop and accent";
  return theme.backdrop !== null ? "Backdrop" : "Accent";
}

/* ----------------------------------- rows ----------------------------------- */

/** A row as the extension handed it over (main's schema has checked it), made main's: every field there. */
export function storedRow(row: ExtRow): StoredRow {
  return {
    id: row.id ?? null,
    mark: row.mark === undefined ? null : { glyph: row.mark.glyph ?? null, tone: row.mark.tone ?? "neutral" },
    text: row.text,
    detail: row.detail ?? "",
    value: row.value ?? "",
    buttons: (row.buttons ?? []).map((button) => ({ id: button.id, title: button.title })),
  };
}

/** Kept rows as their extension set them (`ui.band.get`). */
export function extSiteView(view: StoredSite): ExtSiteView {
  return {
    ...(view.title === null ? {} : { title: view.title }),
    rows: view.rows.map((row) => ({
      ...(row.id === null ? {} : { id: row.id }),
      ...(row.mark === null ? {} : { mark: { ...(row.mark.glyph === null ? {} : { glyph: row.mark.glyph }), tone: row.mark.tone } }),
      text: row.text,
      ...(row.detail === "" ? {} : { detail: row.detail }),
      ...(row.value === "" ? {} : { value: row.value }),
      ...(row.buttons.length === 0 ? {} : { buttons: row.buttons.map((button) => ({ ...button })) }),
    })),
    ...(view.spaceId === null ? {} : { spaceId: view.spaceId }),
  };
}

/** A kept row as the shell draws it. */
export function shownRow(row: StoredRow): ExtensionRow {
  return { id: row.id, mark: row.mark === null ? null : { ...row.mark }, text: row.text, detail: row.detail, value: row.value, buttons: row.buttons.map((button) => ({ ...button })) };
}

/** What rows are, in the words the extensions page lists them by: the section's title, else what the first row says. */
export function siteDetail(view: Pick<StoredSite, "title" | "rows">): string {
  return view.title ?? view.rows[0]?.text ?? "";
}

/** Whether a press names something the kept rows offer: a row by its id (`button` null), or a button of a row (the row's id, or null for a row with none). */
export function offersPress(view: Pick<StoredSite, "rows">, row: string | null, button: string | null): boolean {
  if (button === null) return row !== null && view.rows.some((kept) => kept.id === row);
  return view.rows.some((kept) => kept.id === row && kept.buttons.some((offered) => offered.id === button));
}

/** What the scope reaches of the store (the service's, which publishes after each change). */
export interface ShownHost {
  setMark(mark: Omit<StoredMark, "at">): boolean;
  clearMark(extensionId: string, spaceId: string): boolean;
  setTabMark(mark: Omit<StoredTabMark, "at">): boolean;
  clearTabMark(extensionId: string, tabId: string): boolean;
  /** True when it changed what was held. */
  setTheme(theme: Omit<StoredTheme, "at">): boolean;
  clearTheme(extensionId: string, spaceId: string | null): boolean;
  themeOf(extensionId: string, spaceId: string | null): StoredTheme | null;
  /** True when it changed what was held. */
  setSite(view: Omit<StoredSite, "at">): boolean;
  clearSite(extensionId: string, site: Site, spaceId: string | null): boolean;
  siteOf(extensionId: string, site: Site, spaceId: string | null): StoredSite | null;
  /** Copy a picture of the extension's own folder into main's keeping (adoptThemeImage); throws when it cannot be one. */
  adoptImage(extensionId: string, path: string): string;
}
