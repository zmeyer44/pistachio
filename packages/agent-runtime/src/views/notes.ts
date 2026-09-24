/**
 * Notes: the markdown documents a person writes in Pistachio (docs/notes.md).
 *
 * A note is one record — its metadata AND its body — and its images are
 * sibling records referenced from the markdown as `note-blob:<id>`, so a
 * keystroke re-seals kilobytes of text rather than megabytes of picture (N2,
 * N3). This module is the pure half both hosts share: the shapes, the caps,
 * the sanitizers, the snippet, the search, the one markdown edit the agent is
 * allowed to make blind, and what the model sees. The desktop store
 * (main/note-store.ts) owns the files; `@pistachio/notes` owns rendering a
 * note to HTML; the renderer only ever reads a snapshot and asks for a change.
 */

/* --------------------------------- types -------------------------------- */

/** Who wrote the current revision: the person at the keyboard, or a run. */
export interface NoteSource {
  kind: "user" | "agent";
  runId: string | null;
}

/** The same shape `NoteRecord` travels in (shell-contracts/test/record-docs.test.ts). */
export interface Note {
  /** Twelve lowercase hex characters, like an artifact's id (N6). */
  id: string;
  /** "" is allowed; the library shows `NOTE_UNTITLED`. */
  title: string;
  /** The canonical body. Never includes the title. */
  markdown: string;
  /** One emoji, or null. */
  icon: string | null;
  /** Every note-blob the markdown references, for cleanup and the caps. */
  blobIds: string[];
  createdAt: string;
  updatedAt: string;
  /** Monotone; bumped on every local write. */
  revision: number;
  source: NoteSource;
}

/**
 * A note without its body — what the library lists and what `onNotes` carries,
 * so five hundred notes never serialise their markdown on a keystroke (§3).
 */
export interface NoteSummary extends Omit<Note, "markdown"> {
  snippet: string;
}

export const NOTE_BLOB_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type NoteBlobMediaType = (typeof NOTE_BLOB_MEDIA_TYPES)[number];

/** One image a note references: immutable, content-addressed, base64 (N3). */
export interface NoteBlob {
  /** Twenty-four lowercase hex characters: the SHA-256 prefix of the bytes. */
  id: string;
  mediaType: NoteBlobMediaType;
  byteLength: number;
  data: string;
  createdAt: string;
}

/** A new note. Everything is optional: ⌘⌥N opens an empty one. */
export interface NoteInput {
  title?: string;
  markdown?: string;
  icon?: string | null;
}

/** A change to a note. Only the fields present are written. */
export interface NotePatch {
  title?: string;
  markdown?: string;
  icon?: string | null;
}

/** What `onNotes` carries: metadata only. */
export interface NoteSnapshot {
  notes: NoteSummary[];
}

/* --------------------------------- caps --------------------------------- */

export const MAX_NOTES = 500;
export const MAX_NOTE_TITLE = 200;
export const MAX_NOTE_MARKDOWN_BYTES = 262_144;
/** After base64 this is ~2 MB, which stays under `FRAME_BUDGET_BYTES` (N4). */
export const MAX_NOTE_BLOB_BYTES = 1_500_000;
export const MAX_NOTE_BLOBS_PER_NOTE = 40;
/** An emoji and its modifiers; anything longer is not an icon. */
export const MAX_NOTE_ICON = 16;
/** Plain-text characters a summary's snippet carries. */
export const NOTE_SNIPPET_LENGTH = 160;

/** What the library shows for a note whose title is still empty. */
export const NOTE_UNTITLED = "Untitled";

const NOTE_ID_RE = /^[a-f0-9]{12}$/;
const NOTE_BLOB_ID_RE = /^[a-f0-9]{24}$/;

export function isNoteId(value: string): boolean {
  return NOTE_ID_RE.test(value);
}

export function isNoteBlobId(value: string): boolean {
  return NOTE_BLOB_ID_RE.test(value);
}

/* ------------------------------ sanitizing ------------------------------ */

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function line(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, max) : "";
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Cut a string to a BYTE budget without splitting a code point. */
function clampBytes(value: string, max: number): string {
  let text = value;
  while (text !== "" && byteLength(text) > max) {
    text = text.slice(0, Math.max(0, Math.floor(text.length * (max / byteLength(text))) - 1));
  }
  return text;
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** One emoji, or null — a letter or a word is not an icon. */
export function sanitizeNoteIcon(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const icon = value.trim();
  if (icon === "" || icon.length > MAX_NOTE_ICON) return null;
  return /\p{Extended_Pictographic}/u.test(icon) ? icon : null;
}

export function sanitizeNoteSource(value: unknown): NoteSource {
  const raw = record(value);
  const runId = typeof raw["runId"] === "string" && RUN_ID.test(raw["runId"]) ? raw["runId"] : null;
  return { kind: raw["kind"] === "agent" ? "agent" : "user", runId };
}

/** A note's markdown, bounded and with its line endings normalized. */
export function sanitizeNoteMarkdown(value: unknown): string {
  if (typeof value !== "string") return "";
  return clampBytes(value.replace(/\r\n?/gu, "\n"), MAX_NOTE_MARKDOWN_BYTES);
}

/**
 * One note off disk or off the wire, or null when it is not one. Entries that
 * do not parse are dropped rather than crashing the store, the way the other
 * views read their files.
 */
export function sanitizeNote(value: unknown): Note | null {
  const raw = record(value);
  if (
    typeof raw["id"] !== "string" || !isNoteId(raw["id"]) ||
    typeof raw["title"] !== "string" ||
    typeof raw["markdown"] !== "string" ||
    !isIsoInstant(raw["createdAt"]) || !isIsoInstant(raw["updatedAt"]) ||
    typeof raw["revision"] !== "number" || !Number.isInteger(raw["revision"]) || raw["revision"] < 1
  ) {
    return null;
  }
  const markdown = sanitizeNoteMarkdown(raw["markdown"]);
  return {
    id: raw["id"],
    title: line(raw["title"], MAX_NOTE_TITLE),
    markdown,
    icon: sanitizeNoteIcon(raw["icon"]),
    blobIds: noteBlobIdsIn(markdown),
    createdAt: raw["createdAt"],
    updatedAt: raw["updatedAt"],
    revision: raw["revision"],
    source: sanitizeNoteSource(raw["source"]),
  };
}

export function sanitizeNoteInput(value: unknown): NoteInput {
  const raw = record(value);
  const input: NoteInput = {};
  if (raw["title"] !== undefined) input.title = line(raw["title"], MAX_NOTE_TITLE);
  if (raw["markdown"] !== undefined) input.markdown = sanitizeNoteMarkdown(raw["markdown"]);
  if (raw["icon"] !== undefined) input.icon = sanitizeNoteIcon(raw["icon"]);
  return input;
}

export function sanitizeNotePatch(value: unknown): NotePatch {
  const raw = record(value);
  const patch: NotePatch = {};
  if (raw["title"] !== undefined) patch.title = line(raw["title"], MAX_NOTE_TITLE);
  if (raw["markdown"] !== undefined) patch.markdown = sanitizeNoteMarkdown(raw["markdown"]);
  if (raw["icon"] !== undefined) patch.icon = sanitizeNoteIcon(raw["icon"]);
  return patch;
}

/** One image record, or null — a blob whose id is not its hash prefix is not one. */
export function sanitizeNoteBlob(value: unknown): NoteBlob | null {
  const raw = record(value);
  if (
    typeof raw["id"] !== "string" || !isNoteBlobId(raw["id"]) ||
    !(NOTE_BLOB_MEDIA_TYPES as readonly unknown[]).includes(raw["mediaType"]) ||
    typeof raw["byteLength"] !== "number" || !Number.isInteger(raw["byteLength"]) ||
    raw["byteLength"] < 1 || raw["byteLength"] > MAX_NOTE_BLOB_BYTES ||
    typeof raw["data"] !== "string" || raw["data"] === "" ||
    !isIsoInstant(raw["createdAt"])
  ) {
    return null;
  }
  return {
    id: raw["id"],
    mediaType: raw["mediaType"] as NoteBlobMediaType,
    byteLength: raw["byteLength"],
    data: raw["data"],
    createdAt: raw["createdAt"],
  };
}

/* --------------------------- markdown as prose --------------------------- */

/**
 * A note's markdown as the words in it: the syntax dropped, links and images
 * left as their text, whitespace collapsed. Both the snippet and the search
 * read this, so "the recipe I wrote" matches what a person would say it says.
 */
export function notePlainText(markdown: string): string {
  return markdown
    .replace(/^ {0,3}(?:```|~~~)[^\n]*$/gmu, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/^ {0,3}#{1,6}\s+/gmu, "")
    .replace(/^ {0,3}>\s?/gmu, "")
    .replace(/^ {0,3}(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gmu, "")
    .replace(/^ {0,3}(?:[-*_] *){3,}$/gmu, " ")
    .replace(/[*_~`]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** The first ~160 characters of a note's prose, cut on a word boundary. */
export function noteSnippet(markdown: string): string {
  const text = notePlainText(markdown);
  if (text.length <= NOTE_SNIPPET_LENGTH) return text;
  const cut = text.slice(0, NOTE_SNIPPET_LENGTH);
  const space = cut.lastIndexOf(" ");
  return (space > NOTE_SNIPPET_LENGTH / 2 ? cut.slice(0, space) : cut).trimEnd();
}

/**
 * Every `note-blob:<id>` the markdown names, in the order they appear and
 * without repeats — what a note's `blobIds` is recomputed from on every write,
 * so a picture nobody references any more can be collected.
 */
export function noteBlobIdsIn(markdown: string): string[] {
  const ids: string[] = [];
  for (const match of markdown.matchAll(/note-blob:([a-f0-9]{24})/gu)) {
    const id = match[1]!;
    if (!ids.includes(id)) ids.push(id);
    if (ids.length === MAX_NOTE_BLOBS_PER_NOTE) break;
  }
  return ids;
}

export function summaryOf(note: Note): NoteSummary {
  const { markdown, ...rest } = note;
  return { ...rest, snippet: noteSnippet(markdown) };
}

/** The title as a reader sees it: what was typed, or "Untitled". */
export function noteTitle(note: Pick<Note, "title">): string {
  return note.title.trim() === "" ? NOTE_UNTITLED : note.title;
}

/* -------------------------------- search -------------------------------- */

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

function fieldScore(field: string, token: string, weight: number): number {
  if (field === "") return 0;
  if (field === token) return weight * 3;
  if (field.startsWith(token)) return weight * 2;
  const at = field.indexOf(token);
  if (at < 0) return 0;
  const boundary = at === 0 || !/[\p{L}\p{N}]/u.test(field[at - 1] ?? "");
  return boundary ? weight * 1.5 : weight;
}

/** How well a note answers a query; 0 when some word of it matches nothing. */
export function noteScore(note: Note, query: string): number {
  const tokens = normalize(query).split(" ").filter((token) => token !== "");
  if (tokens.length === 0) return 0;
  const fields: Array<[string, number]> = [
    [normalize(note.title), 10],
    [normalize(notePlainText(note.markdown)), 3],
  ];
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (const [field, weight] of fields) best = Math.max(best, fieldScore(field, token, weight));
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

export interface NoteSearchOptions {
  limit?: number;
}

/**
 * Notes answering a query, best first — a title match always above a body
 * match — and most recently edited first when the query is empty. One search
 * for the library and the agent, so "my pie note" finds the same note either
 * way.
 */
export function searchNotes(notes: Note[], query: string, options: NoteSearchOptions = {}): Note[] {
  const limit = options.limit ?? MAX_NOTES;
  const byRecency = (a: Note, b: Note): number => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  if (normalize(query) === "") return [...notes].sort(byRecency).slice(0, limit);
  return notes
    .map((note) => ({ note, score: noteScore(note, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || byRecency(a.note, b.note))
    .slice(0, limit)
    .map((entry) => entry.note);
}

/* ------------------------------ editing blind ---------------------------- */

export type NoteEditMode = "replace" | "append" | "prepend" | "replace_section";

export interface NoteEdit {
  mode: NoteEditMode;
  markdown: string;
  /** The heading `replace_section` writes under, matched case-insensitively. */
  section?: string;
}

export type NoteEditResult = { ok: true; markdown: string } | { ok: false; error: string };

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u;

function headingOf(fileLine: string): { level: number; text: string } | null {
  const match = HEADING.exec(fileLine);
  return match === null ? null : { level: match[1]!.length, text: match[2]!.trim() };
}

/**
 * The one edit the agent may make without holding the whole document: it
 * names a mode and, for `replace_section`, the heading to write under. Never
 * rewriting a note to change a line is the rule the prompt states; this is
 * what makes obeying it possible (§6).
 */
export function applyNoteEdit(markdown: string, edit: NoteEdit): NoteEditResult {
  const body = edit.markdown.replace(/\r\n?/gu, "\n");
  const current = markdown.replace(/\r\n?/gu, "\n");
  switch (edit.mode) {
    case "replace":
      return { ok: true, markdown: body };
    case "append":
      return { ok: true, markdown: current.trimEnd() === "" ? body : `${current.trimEnd()}\n\n${body}` };
    case "prepend":
      return { ok: true, markdown: current.trim() === "" ? body : `${body.trimEnd()}\n\n${current.replace(/^\n+/u, "")}` };
    case "replace_section": {
      const section = (edit.section ?? "").trim();
      if (section === "") return { ok: false, error: "replace_section needs the heading to write under" };
      const lines = current.split("\n");
      const wanted = section.toLowerCase();
      const start = lines.findIndex((entry) => headingOf(entry)?.text.toLowerCase() === wanted);
      if (start === -1) return { ok: false, error: `no section titled "${section}" in this note` };
      const level = headingOf(lines[start]!)!.level;
      let end = start + 1;
      while (end < lines.length) {
        const heading = headingOf(lines[end]!);
        if (heading !== null && heading.level <= level) break;
        end += 1;
      }
      const replacement = body.trim() === "" ? [] : ["", ...body.trim().split("\n"), ""];
      return { ok: true, markdown: [...lines.slice(0, start + 1), ...replacement, ...lines.slice(end)].join("\n").trimEnd() };
    }
  }
}

/* ------------------------------ the tool shape --------------------------- */

/** The note as the agent sees it: enough to cite and change, listed or read. */
export interface NoteToolView {
  id: string;
  title: string;
  updatedAt: string;
  /** Present on a listing. */
  snippet?: string;
  /** Present when the note was read whole. */
  markdown?: string;
}

export function noteToolView(note: Note, options: { full: boolean }): NoteToolView {
  const view: NoteToolView = { id: note.id, title: noteTitle(note), updatedAt: note.updatedAt };
  if (options.full) view.markdown = note.markdown;
  else view.snippet = noteSnippet(note.markdown);
  return view;
}

/** "Sunday pie — note, edited 2026-01-02: Sour cherries, a lattice top." */
export function describeNote(note: Note | NoteSummary): string {
  const snippet = "snippet" in note ? note.snippet : noteSnippet(note.markdown);
  return `${noteTitle(note)} — note, edited ${note.updatedAt.slice(0, 10)}${snippet === "" ? "" : `: ${snippet}`}`;
}
