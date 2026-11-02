/**
 * The notes a person writes (docs/notes.md §3), kept the way the artifact
 * library is: the metadata in `<userData>/notes.json` — read once, rewritten
 * whole on every change — and each body as its own files in
 * `<userData>/notes/<id>.html` (the canonical document, N1) and
 * `<userData>/notes/<id>.md` (the markdown derived from it: what the agent
 * reads, what a person can open in any editor), read per request rather than
 * held in memory, because five hundred notes are a book and the library only
 * ever shows their titles. Images live apart again, in
 * `<userData>/note-blobs/<id>`, raw bytes named by the first 24 hex of their
 * SHA-256 (N3), with their media type in the index: a keystroke re-seals
 * kilobytes of text, never megabytes of picture.
 *
 * A body arrives in one of two forms and leaves in both: the editor writes
 * HTML and the markdown is derived here; the agent (and a web editor) writes
 * markdown and the HTML is derived here. A note written before HTML was
 * canonical has only its `.md`; it is completed the first time it is read.
 *
 * Two audiences, two subscriptions, and the difference matters:
 * `onChange` carries a metadata-only `NoteSnapshot` to the renderer, so a
 * keystroke does not serialise a library; `onRecordChange` names what a LOCAL
 * write touched, for the workspace-sync lane (sync/records.ts), and a record
 * that arrived through `applyRemote` is never reported — that would hand the
 * other device its own note back under our HLC.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyNoteEdit, completeNoteBody, htmlToMarkdown, markdownToHtml, type NoteBody } from "@pistachio/notes";
import {
  isNoteBlobId,
  isNoteId,
  noteSnippet,
  sanitizeNote,
  sanitizeNoteBlob,
  sanitizeNoteInput,
  sanitizeNoteMarkdown,
  sanitizeNotePatch,
  searchNotes,
  summaryOf,
  MAX_NOTE_BLOB_BYTES,
  MAX_NOTE_BLOBS_PER_NOTE,
  MAX_NOTE_HTML_BYTES,
  MAX_NOTE_MARKDOWN_BYTES,
  MAX_NOTES,
  NOTE_SNIPPET_LENGTH,
  type Note,
  type NoteBlob,
  type NoteBlobMediaType,
  type NoteEdit,
  type NoteInput,
  type NotePatch,
  type NoteSnapshot,
  type NoteSource,
  type NoteSummary,
} from "@pistachio/shell-contracts/notes";
import type { NoteBlobRecord, NoteRecord } from "@pistachio/sync-protocol";

/** The two registers a note's life is spread over (`note:`, `note-blob:`). */
export type NoteRecordKind = "note" | "noteBlob";

/** What the index remembers about one stored image; the bytes are its file. */
export interface NoteBlobMeta {
  id: string;
  mediaType: NoteBlobMediaType;
  byteLength: number;
  createdAt: string;
}

/** `<userData>/notes.json`: every note without its body, and every blob without its bytes. */
interface NotesDocument {
  version: 1;
  notes: NoteSummary[];
  blobs: NoteBlobMeta[];
}

const BLOB_MEDIA_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** How long an unreferenced picture is kept before it is collected: a day, well past any undo stack. */
export const DEFAULT_BLOB_SWEEP_MS = 24 * 60 * 60 * 1_000;

/** Every `note-blob:<id>` a body names — uncapped, so the cap can be refused rather than silently obeyed. */
function blobIdsIn(body: string): string[] {
  const ids: string[] = [];
  for (const match of body.matchAll(/note-blob:([a-f0-9]{24})/gu)) {
    const id = match[1] ?? "";
    if (id !== "" && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Field by field rather than by serialising: the hub hands our own docs back
 * at us constantly, and a comparison that depended on key ORDER would make
 * every echo look like a change and republish it.
 */
function sameNote(a: Note, b: Note): boolean {
  return (
    a.id === b.id && a.title === b.title && a.html === b.html && a.markdown === b.markdown && a.icon === b.icon &&
    a.createdAt === b.createdAt && a.updatedAt === b.updatedAt && a.revision === b.revision &&
    a.source.kind === b.source.kind && a.source.runId === b.source.runId &&
    a.blobIds.length === b.blobIds.length && a.blobIds.every((id, index) => id === b.blobIds[index])
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * One index entry: a note's metadata, its snippet, and the blobs its body
 * referenced when it was last written. `sanitizeNote` validates everything a
 * note and a summary share; `blobIds` and `snippet` are read back from the
 * file rather than recomputed, because the body is not in hand here.
 */
function sanitizeSummary(value: unknown): NoteSummary | null {
  const raw = asRecord(value);
  const note = sanitizeNote({ ...raw, html: "", markdown: "" });
  if (note === null) return null;
  const { html: _html, markdown: _markdown, ...rest } = note;
  const blobIds = Array.isArray(raw["blobIds"])
    ? (raw["blobIds"] as unknown[]).filter((id): id is string => typeof id === "string" && isNoteBlobId(id)).slice(0, MAX_NOTE_BLOBS_PER_NOTE)
    : [];
  const snippet = typeof raw["snippet"] === "string" ? raw["snippet"].slice(0, NOTE_SNIPPET_LENGTH) : "";
  return { ...rest, blobIds, snippet };
}

function sanitizeBlobMeta(value: unknown): NoteBlobMeta | null {
  const raw = asRecord(value);
  if (
    typeof raw["id"] !== "string" || !isNoteBlobId(raw["id"]) ||
    typeof raw["mediaType"] !== "string" || !BLOB_MEDIA_TYPES.includes(raw["mediaType"]) ||
    typeof raw["byteLength"] !== "number" || !Number.isInteger(raw["byteLength"]) ||
    raw["byteLength"] < 1 || raw["byteLength"] > MAX_NOTE_BLOB_BYTES ||
    typeof raw["createdAt"] !== "string" || Number.isNaN(Date.parse(raw["createdAt"]))
  ) {
    return null;
  }
  return {
    id: raw["id"],
    mediaType: raw["mediaType"] as NoteBlobMediaType,
    byteLength: raw["byteLength"],
    createdAt: raw["createdAt"],
  };
}

/** The text a body's blob ids and snippet are read off: the HTML when there is one. */
function bodyText(body: NoteBody): string {
  return body.html === "" ? body.markdown : body.html;
}

export class NoteStore {
  readonly #path: string;
  readonly #notesDir: string;
  /**
   * The HTML a note from before N1 would take, when it is more than a note
   * holds (N4): served to this session's readers, never written or synced —
   * every other device could only clamp it, and the person's own markdown
   * is what survives. Keyed by note id; dropped when the note is written.
   */
  readonly #oversized = new Map<string, string>();
  readonly #blobsDir: string;
  readonly #now: () => Date;
  readonly #listeners = new Set<(snapshot: NoteSnapshot) => void>();
  /** Sync-facing; never told about a remote write (§3). */
  readonly #recordListeners = new Set<(kind: NoteRecordKind, id: string) => void>();
  #notes: NoteSummary[];
  #blobs: NoteBlobMeta[];

  constructor(userDataDir: string, options: { now?: () => Date } = {}) {
    this.#path = join(userDataDir, "notes.json");
    this.#notesDir = join(userDataDir, "notes");
    this.#blobsDir = join(userDataDir, "note-blobs");
    this.#now = options.now ?? (() => new Date());
    const document = this.#read();
    this.#notes = document.notes;
    this.#blobs = document.blobs;
  }

  /* ------------------------------ reading ------------------------------ */

  /** Every note without its body, most recently edited first. */
  list(): NoteSummary[] {
    return structuredClone([...this.#notes].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
  }

  snapshot(): NoteSnapshot {
    return { notes: this.list() };
  }

  /** One note, body and all, or null when this Mac does not hold it. */
  get(id: string): Note | null {
    const summary = this.#notes.find((note) => note.id === id);
    if (summary === undefined) return null;
    return this.#noteOf(summary, this.#servedBody(summary.id) ?? { html: "", markdown: "" });
  }

  /**
   * What answers a query, best first (the shared `searchNotes`, so the library
   * and the agent agree on which note "my pie one" is). The bodies are read
   * here — a search is a person asking, not a keystroke.
   */
  search(query: string, limit?: number): NoteSummary[] {
    const options = limit === undefined ? {} : { limit };
    return searchNotes(this.#allNotes(), query, options).map((note) => summaryOf(note));
  }

  /** One image, bytes and all, or null when the id or its file is gone. */
  getBlob(id: string): NoteBlob | null {
    const meta = this.#blobs.find((blob) => blob.id === id);
    if (meta === undefined) return null;
    const bytes = this.#readBlob(id);
    if (bytes === null) return null;
    return { ...meta, data: bytes.toString("base64") };
  }

  /* ------------------------------ writing ------------------------------ */

  create(input: NoteInput, source: NoteSource): Note {
    if (this.#notes.length >= MAX_NOTES) {
      throw new Error(`This library already holds ${String(MAX_NOTES)} notes. Delete one before writing another.`);
    }
    this.#requireBodyFits(asRecord(input));
    const clean = sanitizeNoteInput(input);
    const body = this.#bodyFrom(clean) ?? { html: "", markdown: "" };
    const at = this.#now().toISOString();
    const note: Note = {
      id: this.#freshId(),
      title: clean.title ?? "",
      html: body.html,
      markdown: body.markdown,
      icon: clean.icon ?? null,
      blobIds: this.#blobIdsOf(bodyText(body)),
      createdAt: at,
      updatedAt: at,
      revision: 1,
      source: { ...source },
    };
    this.#writeBody(note.id, body);
    this.#notes.push(summaryOf(note));
    this.#commit(["note", note.id]);
    return structuredClone(note);
  }

  /** Only the fields present are written; every write bumps the revision. */
  update(id: string, patch: NotePatch, source: NoteSource): Note {
    const summary = this.#notes.find((note) => note.id === id);
    if (summary === undefined) throw new Error(`no note ${id}`);
    this.#requireBodyFits(asRecord(patch));
    const clean = sanitizeNotePatch(patch);
    const next = this.#bodyFrom(clean);
    // A write without a body keeps the body as stored; what is answered is
    // the body as served (`#servedBody`), so an editor that adopts the
    // answer is not shown an empty page over a note it could still read.
    const body = next ?? this.#servedBody(id) ?? { html: "", markdown: "" };
    // Everything that can refuse is worked out before anything is written:
    // a body on disk with an index that still describes the old one is a
    // note that lies about itself.
    const blobIds = this.#blobIdsOf(bodyText(body));
    const snippet = noteSnippet(body.markdown);
    if (next !== null) {
      this.#writeBody(id, next);
      this.#oversized.delete(id);
    }
    if (clean.title !== undefined) summary.title = clean.title;
    if (clean.icon !== undefined) summary.icon = clean.icon;
    summary.blobIds = blobIds;
    summary.snippet = snippet;
    summary.updatedAt = this.#now().toISOString();
    summary.revision += 1;
    summary.source = { ...source };
    this.#commit(["note", id]);
    return this.#noteOf(summary, body);
  }

  /**
   * The agent's edit (docs/notes.md §6): one mode applied to the note's
   * blocks, on the canonical document, so a widget or a toggle elsewhere in
   * the note is not flattened through markdown on the way. A heading the
   * note does not have is refused, not appended to.
   */
  edit(id: string, edit: NoteEdit, title: string | null, source: NoteSource): Note {
    const summary = this.#notes.find((note) => note.id === id);
    if (summary === undefined) throw new Error(`no note ${id}`);
    const body = this.#servedBody(id) ?? { html: "", markdown: "" };
    const result = applyNoteEdit(body.html, edit);
    if (!result.ok) throw new Error(result.error);
    return this.update(id, { html: result.html, ...(title === null ? {} : { title }) }, source);
  }

  /**
   * Forget a note — and every picture it was the last to reference. Each
   * orphan is reported on its own so the sync lane publishes its deletion:
   * a blob nobody names is a megabyte in every device's workspace.
   */
  remove(id: string): boolean {
    const summary = this.#notes.find((note) => note.id === id);
    if (summary === undefined) return false;
    this.#notes = this.#notes.filter((note) => note.id !== id);
    this.#removeBody(id);
    this.#oversized.delete(id);
    const changed: Array<[NoteRecordKind, string]> = [["note", id]];
    for (const blobId of summary.blobIds) {
      if (this.#notes.some((note) => note.blobIds.includes(blobId))) continue;
      if (!this.#blobs.some((blob) => blob.id === blobId)) continue;
      this.#blobs = this.#blobs.filter((blob) => blob.id !== blobId);
      this.#removeBlob(blobId);
      changed.push(["noteBlob", blobId]);
    }
    this.#commit(...changed);
    return true;
  }

  /**
   * Collect the pictures nobody names any more — the ones an edit orphaned
   * rather than a deletion, which `remove` already takes with the note.
   *
   * Lazily, and never the recent ones: deleting an image is an edit like any
   * other, and ⌘Z puts the node back. A blob collected the moment its last
   * reference went would come back as a broken box, so a picture is only
   * collected once it has been around longer than `olderThanMs` — long enough
   * that the undo stack it belonged to is gone. Each is committed on its own
   * so the sync lane publishes its deletion; the ids swept are returned.
   */
  sweepOrphanBlobs(options: { olderThanMs?: number } = {}): string[] {
    const olderThanMs = options.olderThanMs ?? DEFAULT_BLOB_SWEEP_MS;
    const before = this.#now().getTime() - olderThanMs;
    const named = new Set(this.#notes.flatMap((note) => note.blobIds));
    const swept = this.#blobs
      .filter((blob) => !named.has(blob.id) && Date.parse(blob.createdAt) <= before)
      .map((blob) => blob.id);
    if (swept.length === 0) return [];
    this.#blobs = this.#blobs.filter((blob) => !swept.includes(blob.id));
    for (const id of swept) this.#removeBlob(id);
    this.#commit(...swept.map((id): [NoteRecordKind, string] => ["noteBlob", id]));
    return swept;
  }

  /**
   * Keep an image. Content-addressed, so the same picture dropped twice is
   * one register and the second drop costs nothing but a hash.
   */
  putBlob(bytes: Uint8Array, mediaType: NoteBlobMediaType): NoteBlob {
    if (bytes.byteLength === 0) throw new Error("an image needs bytes");
    if (bytes.byteLength > MAX_NOTE_BLOB_BYTES) {
      throw new Error(`that image is ${String(bytes.byteLength)} bytes; a note holds images up to ${String(MAX_NOTE_BLOB_BYTES)}`);
    }
    const buffer = Buffer.from(bytes);
    const id = createHash("sha256").update(buffer).digest("hex").slice(0, 24);
    const existing = this.#blobs.find((blob) => blob.id === id);
    if (existing !== undefined) return { ...existing, data: buffer.toString("base64") };
    const meta: NoteBlobMeta = { id, mediaType, byteLength: buffer.byteLength, createdAt: this.#now().toISOString() };
    this.#writeBlob(id, buffer);
    this.#blobs.push(meta);
    this.#commit(["noteBlob", id]);
    return { ...meta, data: buffer.toString("base64") };
  }

  /** Metadata only: the library, never the bodies (§3). */
  onChange(listener: (snapshot: NoteSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Which record a LOCAL write touched, for the workspace-sync lane. */
  onRecordChange(listener: (kind: NoteRecordKind, id: string) => void): () => void {
    this.#recordListeners.add(listener);
    return () => this.#recordListeners.delete(listener);
  }

  /* -------------------------------- sync -------------------------------- */

  /** Every record of one kind, complete: a note carries its body in both forms, a blob its bytes. */
  syncAll(kind: "note"): NoteRecord[];
  syncAll(kind: "noteBlob"): NoteBlobRecord[];
  syncAll(kind: NoteRecordKind): Array<NoteRecord | NoteBlobRecord>;
  syncAll(kind: NoteRecordKind): Array<NoteRecord | NoteBlobRecord> {
    if (kind === "note") {
      // A note whose body file went missing is not published: an empty
      // document would overwrite the good copy another device still holds.
      return this.#notes.flatMap((summary) => {
        const body = this.#readBody(summary.id);
        return body === null ? [] : [this.#noteOf(summary, body)];
      });
    }
    return this.#blobs.flatMap((meta) => {
      const blob = this.getBlob(meta.id);
      return blob === null ? [] : [blob];
    });
  }

  syncGet(kind: "note", id: string): NoteRecord | null;
  syncGet(kind: "noteBlob", id: string): NoteBlobRecord | null;
  syncGet(kind: NoteRecordKind, id: string): NoteRecord | NoteBlobRecord | null;
  syncGet(kind: NoteRecordKind, id: string): NoteRecord | NoteBlobRecord | null {
    if (kind === "noteBlob") return this.getBlob(id);
    const summary = this.#notes.find((note) => note.id === id);
    if (summary === undefined) return null;
    const body = this.#readBody(id);
    return body === null ? null : this.#noteOf(summary, body);
  }

  /**
   * A record as another device knows it. Identical values short-circuit (the
   * hub fans our own docs back at us), nothing here reports a local change,
   * and the caps a person is held to do not apply — this is their own writing
   * arriving, not a new note being made. A note may reference a blob this Mac
   * has not received yet; the picture arrives in its own register. A record
   * from a device that knew markdown alone is completed on the way in.
   */
  applyRemote(kind: "note", value: unknown): NoteRecord | null;
  applyRemote(kind: "noteBlob", value: unknown): NoteBlobRecord | null;
  applyRemote(kind: NoteRecordKind, value: unknown): NoteRecord | NoteBlobRecord | null;
  applyRemote(kind: NoteRecordKind, value: unknown): NoteRecord | NoteBlobRecord | null {
    return kind === "note" ? this.#applyRemoteNote(value) : this.#applyRemoteBlob(value);
  }

  /** Another device deleted it. */
  removeRemote(kind: NoteRecordKind, id: string): boolean {
    if (kind === "noteBlob") {
      const before = this.#blobs.length;
      this.#blobs = this.#blobs.filter((blob) => blob.id !== id);
      if (this.#blobs.length === before) return false;
      this.#removeBlob(id);
      this.#commit();
      return true;
    }
    const before = this.#notes.length;
    this.#notes = this.#notes.filter((note) => note.id !== id);
    if (this.#notes.length === before) return false;
    this.#removeBody(id);
    this.#commit();
    return true;
  }

  /* ------------------------------ internals ----------------------------- */

  #applyRemoteNote(value: unknown): NoteRecord | null {
    const sanitized = sanitizeNote(value);
    if (sanitized === null) return null;
    const { stored, served } = this.#complete(sanitized.id, { html: sanitized.html, markdown: sanitized.markdown });
    const incoming: Note = { ...sanitized, ...stored, blobIds: blobIdsIn(bodyText(served)).slice(0, MAX_NOTE_BLOBS_PER_NOTE) };
    const index = this.#notes.findIndex((note) => note.id === incoming.id);
    const current = index === -1 ? null : this.#notes[index] ?? null;
    if (current !== null) {
      const held = this.#readBody(incoming.id);
      if (held !== null && sameNote(this.#noteOf(current, held), incoming)) return structuredClone(incoming);
    }
    try {
      this.#writeBody(incoming.id, stored);
    } catch {
      return null;
    }
    const summary = summaryOf(incoming);
    if (index === -1) this.#notes.push(summary);
    else this.#notes[index] = summary;
    this.#commit();
    return structuredClone(incoming);
  }

  #applyRemoteBlob(value: unknown): NoteBlobRecord | null {
    const incoming = sanitizeNoteBlob(value);
    if (incoming === null) return null;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(incoming.data, "base64");
    } catch {
      return null;
    }
    // Content addressing is the whole guarantee of these registers: bytes
    // whose hash is not their key are somebody else's, and are not kept.
    if (bytes.byteLength !== incoming.byteLength) return null;
    if (createHash("sha256").update(bytes).digest("hex").slice(0, 24) !== incoming.id) return null;
    const index = this.#blobs.findIndex((blob) => blob.id === incoming.id);
    if (index !== -1 && this.#readBlob(incoming.id) !== null) return structuredClone(incoming);
    try {
      this.#writeBlob(incoming.id, bytes);
    } catch {
      return null;
    }
    const meta: NoteBlobMeta = {
      id: incoming.id,
      mediaType: incoming.mediaType,
      byteLength: incoming.byteLength,
      createdAt: incoming.createdAt,
    };
    if (index === -1) this.#blobs.push(meta);
    else this.#blobs[index] = meta;
    this.#commit();
    return structuredClone(incoming);
  }

  /** Every note with its body, for search. */
  #allNotes(): Note[] {
    return this.#notes.map((summary) => this.#noteOf(summary, this.#servedBody(summary.id) ?? { html: "", markdown: "" }));
  }

  #noteOf(summary: NoteSummary, body: NoteBody): Note {
    return {
      id: summary.id,
      title: summary.title,
      html: body.html,
      markdown: body.markdown,
      icon: summary.icon,
      blobIds: [...summary.blobIds],
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      revision: summary.revision,
      source: { ...summary.source },
    };
  }

  /**
   * The body a write carries, in both forms, or null when it carries none.
   * The editor sends HTML and the markdown is derived from it; the agent and
   * a web editor send markdown and the HTML is derived from that. Both at
   * once means the HTML — the canonical one — and markdown derived afresh.
   */
  #bodyFrom(clean: NoteInput | NotePatch): NoteBody | null {
    if (clean.html !== undefined) {
      return { html: clean.html, markdown: sanitizeNoteMarkdown(htmlToMarkdown(clean.html)) };
    }
    if (clean.markdown !== undefined) {
      // Markdown within its cap can grow past the HTML's as it is converted
      // (`&` is five bytes in HTML), and the canonical half is the one every
      // other device would then clamp on arrival: refused here instead.
      const html = markdownToHtml(clean.markdown);
      this.#requireBodyFits({ html });
      return { html, markdown: clean.markdown };
    }
    return null;
  }

  /**
   * The caps are refused, not obeyed quietly: `sanitizeNoteMarkdown` and
   * `sanitizeNoteHtml` would clamp a too-long body to the budget, and a note
   * silently losing its last paragraph is worse than a save that says why it
   * did not happen.
   */
  #requireBodyFits(raw: Record<string, unknown>): void {
    const html = raw["html"];
    if (typeof html === "string") {
      const bytes = Buffer.byteLength(html, "utf8");
      if (bytes > MAX_NOTE_HTML_BYTES) {
        throw new Error(`that note is ${String(bytes)} bytes; a note holds at most ${String(MAX_NOTE_HTML_BYTES)}`);
      }
    }
    const markdown = raw["markdown"];
    if (typeof markdown === "string") {
      const bytes = Buffer.byteLength(markdown, "utf8");
      if (bytes > MAX_NOTE_MARKDOWN_BYTES) {
        throw new Error(`that note is ${String(bytes)} bytes; a note holds at most ${String(MAX_NOTE_MARKDOWN_BYTES)}`);
      }
    }
  }

  #blobIdsOf(body: string): string[] {
    const ids = blobIdsIn(body);
    if (ids.length > MAX_NOTE_BLOBS_PER_NOTE) {
      throw new Error(`a note holds at most ${String(MAX_NOTE_BLOBS_PER_NOTE)} images; this one references ${String(ids.length)}`);
    }
    return ids;
  }

  #freshId(): string {
    for (;;) {
      const id = randomBytes(6).toString("hex");
      if (!this.#notes.some((note) => note.id === id)) return id;
    }
  }

  #readFile(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }

  /**
   * The body in both forms, or null when neither file is there. A note from
   * before HTML was canonical has only its `.md`: it is completed here, and
   * its `.html` written, the first time it is read.
   */
  /**
   * The body as the files hold it, and as it is synced: the HTML is "" for
   * a note from before N1 that has not been completed yet, or whose HTML
   * would not fit (see `#oversized`).
   */
  #readBody(id: string): NoteBody | null {
    if (!isNoteId(id)) return null;
    const html = this.#readFile(join(this.#notesDir, `${id}.html`));
    const markdown = this.#readFile(join(this.#notesDir, `${id}.md`));
    if (html === null && markdown === null) return null;
    return { html: html ?? "", markdown: markdown ?? "" };
  }

  /**
   * The body a reader gets: whole (N1), the missing half derived the first
   * time — written back when it fits, held in memory for this session when
   * it would not, so the editor shows the note and a save says why it
   * cannot keep it as it is, rather than an empty page over the person's
   * own markdown.
   */
  #servedBody(id: string): NoteBody | null {
    const stored = this.#readBody(id);
    if (stored === null) return null;
    if ((stored.html === "") === (stored.markdown === "")) return stored;
    const held = this.#oversized.get(id);
    if (held !== undefined) return { html: held, markdown: stored.markdown };
    const { stored: next, served } = this.#complete(id, stored);
    if (next.html !== stored.html || next.markdown !== stored.markdown) {
      try {
        this.#writeBody(id, next);
      } catch {
        // Still readable this session; the next write lands both files.
      }
    }
    return served;
  }

  /**
   * A body made whole under the caps: what is stored and synced, and what is
   * served. Markdown derived from HTML is clamped like any derived markdown;
   * HTML derived from markdown that would not fit is not stored at all.
   */
  #complete(id: string, body: NoteBody): { stored: NoteBody; served: NoteBody } {
    const whole = completeNoteBody(body);
    const markdown = sanitizeNoteMarkdown(whole.markdown);
    if (Buffer.byteLength(whole.html, "utf8") <= MAX_NOTE_HTML_BYTES) {
      this.#oversized.delete(id);
      const fitted = { html: whole.html, markdown };
      return { stored: fitted, served: fitted };
    }
    this.#oversized.set(id, whole.html);
    return { stored: { html: "", markdown }, served: { html: whole.html, markdown } };
  }

  #writeBody(id: string, body: NoteBody): void {
    mkdirSync(this.#notesDir, { recursive: true });
    for (const [extension, text] of [["html", body.html], ["md", body.markdown]] as const) {
      const path = join(this.#notesDir, `${id}.${extension}`);
      writeFileSync(`${path}.tmp`, text, "utf8");
      renameSync(`${path}.tmp`, path);
    }
  }

  #removeBody(id: string): void {
    try {
      rmSync(join(this.#notesDir, `${id}.html`), { force: true });
      rmSync(join(this.#notesDir, `${id}.md`), { force: true });
    } catch {
      // The index is authoritative; a stray file is harmless.
    }
  }

  #readBlob(id: string): Buffer | null {
    if (!isNoteBlobId(id)) return null;
    try {
      return readFileSync(join(this.#blobsDir, id));
    } catch {
      return null;
    }
  }

  #writeBlob(id: string, bytes: Buffer): void {
    mkdirSync(this.#blobsDir, { recursive: true });
    const path = join(this.#blobsDir, id);
    writeFileSync(`${path}.tmp`, bytes);
    renameSync(`${path}.tmp`, path);
  }

  #removeBlob(id: string): void {
    try {
      rmSync(join(this.#blobsDir, id), { force: true });
    } catch {
      // As above: the bytes are named by the index, not the other way round.
    }
  }

  #read(): NotesDocument {
    try {
      const raw = asRecord(JSON.parse(readFileSync(this.#path, "utf8")));
      const notes = Array.isArray(raw["notes"]) ? raw["notes"] : [];
      const blobs = Array.isArray(raw["blobs"]) ? raw["blobs"] : [];
      return {
        version: 1,
        notes: (notes as unknown[]).flatMap((entry) => {
          const summary = sanitizeSummary(entry);
          return summary === null ? [] : [summary];
        }),
        blobs: (blobs as unknown[]).flatMap((entry) => {
          const meta = sanitizeBlobMeta(entry);
          return meta === null ? [] : [meta];
        }),
      };
    } catch {
      return { version: 1, notes: [], blobs: [] };
    }
  }

  #write(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const document: NotesDocument = { version: 1, notes: this.#notes, blobs: this.#blobs };
      writeFileSync(`${this.#path}.tmp`, JSON.stringify(document, null, 2), "utf8");
      renameSync(`${this.#path}.tmp`, this.#path);
    } catch {
      // The in-memory library still wins for this session.
    }
  }

  /** Write, tell the renderer, then name what a LOCAL write touched. */
  #commit(...changed: Array<[NoteRecordKind, string]>): void {
    this.#write();
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) {
      try {
        listener(structuredClone(snapshot));
      } catch (error) {
        console.error("[notes] snapshot listener failed", error);
      }
    }
    for (const [kind, id] of changed) {
      for (const listener of this.#recordListeners) {
        try {
          listener(kind, id);
        } catch (error) {
          console.error("[notes] record listener failed", error);
        }
      }
    }
  }
}
