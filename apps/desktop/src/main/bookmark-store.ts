/**
 * The bookmarks file: `<userData>/bookmarks.json`, the single source of
 * truth for what the person has saved. Read once at startup, rewritten
 * whole on every change, the way settings, memory, and reminders are.
 *
 * The store knows nothing of pages or models. A bookmark is added at once
 * — as `extracting`, with the tab's title standing in — so the card can
 * show the instant the person taps; whoever is reading the page then
 * calls `complete` with what it found. Every field the person edits is
 * recorded with the bookmark, and a completion — then, or on a later
 * "read again" — leaves those alone and fills the rest.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BOOKMARK_EDITABLE_FIELDS,
  bookmarkHost,
  bookmarkUrlKey,
  cleanBookmarkUrl,
  MAX_BOOKMARKS,
  sanitizeBookmark,
  sanitizeBookmarkDocument,
  searchBookmarks,
  type Bookmark,
  type BookmarkDocument,
  type BookmarkFields,
  type BookmarkInput,
  type BookmarkPatch,
  type BookmarkProvenance,
  type BookmarkSearchOptions,
  type BookmarkSnapshot,
  type BookmarkSource,
} from "@pistachio/shell-contracts/bookmarks";

/** What extraction hands back: the fields, and the address the page named for itself. */
export interface BookmarkCompletion extends Partial<BookmarkFields> {
  url?: string;
  faviconUrl?: string | null;
  provenance: BookmarkProvenance;
}

export class BookmarkStore {
  readonly #path: string;
  readonly #listeners = new Set<(snapshot: BookmarkSnapshot) => void>();
  /** Per-bookmark listeners (workspace sync); never told about a remote write. */
  readonly #recordListeners = new Set<(id: string) => void>();
  readonly #now: () => Date;
  #bookmarks: Bookmark[];

  constructor(userDataDir: string, options: { now?: () => Date } = {}) {
    this.#path = join(userDataDir, "bookmarks.json");
    this.#now = options.now ?? (() => new Date());
    this.#bookmarks = this.#read().bookmarks;
  }

  /* ------------------------------ reading ------------------------------ */

  /** Every bookmark, newest first. */
  all(): Bookmark[] {
    return structuredClone([...this.#bookmarks].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
  }

  get(id: string): Bookmark | null {
    const bookmark = this.#bookmarks.find((candidate) => candidate.id === id);
    return bookmark === undefined ? null : structuredClone(bookmark);
  }

  /** The bookmark of a page, whichever of its addresses is asked about. */
  byUrl(url: string): Bookmark | null {
    const key = bookmarkUrlKey(url);
    if (key === "") return null;
    const bookmark = this.#bookmarks.find((candidate) => bookmarkUrlKey(candidate.url) === key);
    return bookmark === undefined ? null : structuredClone(bookmark);
  }

  snapshot(): BookmarkSnapshot {
    return { bookmarks: this.all() };
  }

  search(query: string, options: BookmarkSearchOptions = {}): Bookmark[] {
    return searchBookmarks(this.all(), query, options);
  }

  /* ------------------------------ writing ------------------------------ */

  /**
   * Save a page. Everything the caller already knows lands now; what it
   * does not is filled by `complete` — or stands as the host's name when
   * nothing else is known and the status is `ready`.
   */
  add(
    input: BookmarkInput,
    source: BookmarkSource,
    options: { status?: Bookmark["status"]; provenance?: BookmarkProvenance } = {},
  ): Bookmark {
    if (this.#bookmarks.length >= MAX_BOOKMARKS) {
      throw new Error(`No more than ${String(MAX_BOOKMARKS)} bookmarks can be kept. Delete some first.`);
    }
    const url = cleanBookmarkUrl(input.url);
    const now = this.#now().toISOString();
    const bookmark: Bookmark = {
      id: randomUUID(),
      url,
      kind: input.kind ?? "website",
      title: input.title ?? (bookmarkHost(url) || url),
      description: input.description ?? "",
      imageUrl: input.imageUrl ?? null,
      faviconUrl: input.faviconUrl ?? null,
      siteName: input.siteName ?? "",
      keywords: [...(input.keywords ?? [])],
      details: structuredClone(input.details ?? []),
      note: input.note ?? "",
      status: options.status ?? "ready",
      provenance: options.provenance ?? "none",
      editedFields: [],
      source,
      createdAt: now,
      updatedAt: now,
    };
    this.#bookmarks.push(bookmark);
    this.#commit(bookmark.id);
    return structuredClone(bookmark);
  }

  /** Change what the person (or the agent) chose to; each field changed is kept as edited. */
  update(id: string, patch: BookmarkPatch, source?: BookmarkSource): Bookmark {
    const bookmark = this.#require(id);
    const touched = new Set(bookmark.editedFields);
    for (const key of Object.keys(patch) as Array<keyof BookmarkPatch>) if (patch[key] !== undefined) touched.add(key);
    bookmark.editedFields = BOOKMARK_EDITABLE_FIELDS.filter((field) => touched.has(field));
    if (patch.url !== undefined) bookmark.url = cleanBookmarkUrl(patch.url);
    if (patch.title !== undefined) bookmark.title = patch.title;
    if (patch.kind !== undefined) bookmark.kind = patch.kind;
    if (patch.description !== undefined) bookmark.description = patch.description;
    if (patch.imageUrl !== undefined) bookmark.imageUrl = patch.imageUrl;
    if (patch.siteName !== undefined) bookmark.siteName = patch.siteName;
    if (patch.keywords !== undefined) bookmark.keywords = [...patch.keywords];
    if (patch.details !== undefined) bookmark.details = structuredClone(patch.details);
    if (patch.note !== undefined) bookmark.note = patch.note;
    if (source !== undefined) bookmark.source = source;
    bookmark.updatedAt = this.#now().toISOString();
    this.#commit(bookmark.id);
    return structuredClone(bookmark);
  }

  /** Mark a bookmark as being read again: the card goes back to its skeleton. */
  beginExtraction(id: string): Bookmark {
    const bookmark = this.#require(id);
    bookmark.status = "extracting";
    bookmark.updatedAt = this.#now().toISOString();
    this.#commit(bookmark.id);
    return structuredClone(bookmark);
  }

  /**
   * What reading the page found. Every field the person has not edited
   * takes it; a title typed while the model was thinking is never
   * overwritten, a note typed meanwhile does not freeze the rest, and an
   * edit made last week survives a "read again" today.
   */
  complete(id: string, completion: BookmarkCompletion): Bookmark {
    const bookmark = this.#require(id);
    const touched = new Set<keyof BookmarkPatch>(bookmark.editedFields);
    const take = <K extends keyof BookmarkPatch>(key: K, next: Bookmark[K] | undefined): Bookmark[K] =>
      next === undefined || touched.has(key) ? bookmark[key] : next;
    if (completion.url !== undefined && !touched.has("url")) bookmark.url = cleanBookmarkUrl(completion.url);
    bookmark.kind = take("kind", completion.kind);
    bookmark.title = take("title", completion.title);
    bookmark.description = take("description", completion.description);
    bookmark.imageUrl = take("imageUrl", completion.imageUrl);
    bookmark.faviconUrl = completion.faviconUrl === undefined ? bookmark.faviconUrl : (completion.faviconUrl ?? bookmark.faviconUrl);
    bookmark.siteName = take("siteName", completion.siteName);
    bookmark.keywords = take("keywords", completion.keywords === undefined ? undefined : [...completion.keywords]);
    bookmark.details = take("details", completion.details === undefined ? undefined : structuredClone(completion.details));
    bookmark.status = "ready";
    bookmark.provenance = completion.provenance;
    bookmark.updatedAt = this.#now().toISOString();
    this.#commit(bookmark.id);
    return structuredClone(bookmark);
  }

  remove(id: string): boolean {
    return this.#remove(id, false);
  }

  onChange(listener: (snapshot: BookmarkSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Hear which bookmark changed, for the mirror that publishes it to the
   * account (sync/records.ts). Only LOCAL writes are reported: a bookmark
   * that arrived through `applyRemote` must not be sent straight back out.
   */
  onRecordChange(listener: (id: string) => void): () => void {
    this.#recordListeners.add(listener);
    return () => this.#recordListeners.delete(listener);
  }

  /* ------------------------- from another device ------------------------ */

  /**
   * A bookmark as another device knows it. Replaces the local record
   * wholesale, or creates one; the cap does not apply, because this is the
   * person's own shelf arriving rather than a new page being saved. Returns
   * null when the value is not a bookmark.
   */
  applyRemote(value: unknown): Bookmark | null {
    const incoming = sanitizeBookmark(value);
    if (incoming === null) return null;
    const index = this.#bookmarks.findIndex((candidate) => candidate.id === incoming.id);
    if (index !== -1 && JSON.stringify(this.#bookmarks[index]) === JSON.stringify(incoming)) return incoming;
    if (index === -1) this.#bookmarks.push(incoming);
    else this.#bookmarks[index] = incoming;
    this.#commit();
    return structuredClone(incoming);
  }

  /** Another device deleted it. */
  removeRemote(id: string): boolean {
    return this.#remove(id, true);
  }

  /* ------------------------------ internals ----------------------------- */

  #require(id: string): Bookmark {
    const bookmark = this.#bookmarks.find((candidate) => candidate.id === id);
    if (bookmark === undefined) throw new Error("bookmark not found");
    return bookmark;
  }

  #remove(id: string, remote: boolean): boolean {
    const before = this.#bookmarks.length;
    this.#bookmarks = this.#bookmarks.filter((bookmark) => bookmark.id !== id);
    if (this.#bookmarks.length === before) return false;
    if (remote) this.#commit();
    else this.#commit(id);
    return true;
  }

  /** Write, then tell the renderer; `changed` names what a local write touched. */
  #commit(...changed: string[]): void {
    this.#write();
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(structuredClone(snapshot));
    for (const id of changed) {
      for (const listener of this.#recordListeners) {
        try {
          listener(id);
        } catch (error) {
          console.error("[bookmarks] record listener failed", error);
        }
      }
    }
  }

  #read(): BookmarkDocument {
    try {
      return sanitizeBookmarkDocument(JSON.parse(readFileSync(this.#path, "utf8")));
    } catch {
      return { version: 1, bookmarks: [] };
    }
  }

  #write(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const file: BookmarkDocument = { version: 1, bookmarks: this.#bookmarks };
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(file, null, 2));
      renameSync(tmp, this.#path);
    } catch {
      // The in-memory value still wins for this session.
    }
  }
}
