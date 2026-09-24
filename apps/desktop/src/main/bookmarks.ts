/**
 * Saving a page: what happens between the double tap and the finished card.
 *
 * The bookmark lands in the store at once — `extracting`, wearing the
 * tab's title — and the toast goes up over the page as a skeleton. Then
 * the page is read (through its own tab when it has one, so the person's
 * session and the rendered DOM are what is read; by fetching its HTML when
 * the agent names an address that is not open), the reader and the model
 * settle the fields (bookmark-extractor.ts), and the store's `complete`
 * turns the skeleton into the card. A page already saved shows its
 * existing card instead of gaining a twin.
 *
 * The browser is reached through a narrow interface so the flow is
 * testable without Electron.
 */

import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import {
  isBookmarkableUrl,
  pageSnapshotFromHtml,
  bookmarkUrlKey,
  type Bookmark,
  type BookmarkInput,
  type BookmarkPatch,
  type BookmarkSource,
  type BookmarkToast,
  type PageSnapshot,
} from "@pistachio/shell-contracts/bookmarks";
import { extractBookmark, type BookmarkExtraction, type ExtractOptions } from "./bookmark-extractor";
import type { BookmarkStore } from "./bookmark-store";

/** What the service needs from the browser: the tabs, their pages, and the network. */
export interface BookmarkPageReader {
  activeTab(): BrowserTabInfo | null;
  tab(tabId: string): BrowserTabInfo | null;
  allTabs(): BrowserTabInfo[];
  /** The page as its tab shows it right now. */
  capturePage(tabId: string): Promise<PageSnapshot>;
  /** The page's HTML over the active Space's session, for an address with no tab. */
  fetchHtml(url: string): Promise<string>;
}

export interface BookmarkServiceOptions {
  store: BookmarkStore;
  /** Null while there is no window. */
  reader: () => BookmarkPageReader | null;
  /** Whether the model is consulted (Settings → Bookmarks). */
  useModel: () => boolean;
  onToast: (toast: BookmarkToast | null) => void;
  extract?: (snapshot: PageSnapshot, options: ExtractOptions) => Promise<BookmarkExtraction>;
  now?: () => Date;
}

export const USER_BOOKMARK_SOURCE: BookmarkSource = { kind: "user", runId: null };

/** The fields a creation request carries beyond its address: the caller's own words. */
function overridesOf(input: BookmarkInput): BookmarkPatch {
  const patch: BookmarkPatch = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.description !== undefined) patch.description = input.description;
  if (input.imageUrl !== undefined) patch.imageUrl = input.imageUrl;
  if (input.siteName !== undefined) patch.siteName = input.siteName;
  if (input.keywords !== undefined) patch.keywords = input.keywords;
  if (input.details !== undefined) patch.details = input.details;
  if (input.note !== undefined) patch.note = input.note;
  return patch;
}

export class BookmarkService {
  readonly #store: BookmarkStore;
  readonly #reader: () => BookmarkPageReader | null;
  readonly #useModel: () => boolean;
  readonly #onToast: (toast: BookmarkToast | null) => void;
  readonly #extract: (snapshot: PageSnapshot, options: ExtractOptions) => Promise<BookmarkExtraction>;
  readonly #now: () => Date;
  /** Extractions in flight, so a refresh during one waits its turn rather than racing it. */
  readonly #inFlight = new Map<string, Promise<Bookmark | null>>();
  #toast: BookmarkToast | null = null;

  constructor(options: BookmarkServiceOptions) {
    this.#store = options.store;
    this.#reader = options.reader;
    this.#useModel = options.useModel;
    this.#onToast = options.onToast;
    this.#extract = options.extract ?? extractBookmark;
    this.#now = options.now ?? (() => new Date());
  }

  toast(): BookmarkToast | null {
    return this.#toast === null ? null : { ...this.#toast };
  }

  dismissToast(): void {
    if (this.#toast === null) return;
    this.#toast = null;
    this.#onToast(null);
  }

  /** Bring the card up for a bookmark: after a capture, or when a page was already saved. */
  showToast(id: string, existed: boolean): void {
    this.#toast = { id, existed, shownAt: this.#now().toISOString() };
    this.#onToast({ ...this.#toast });
  }

  /**
   * The double tap: save the tab's page. Resolves as soon as the skeleton
   * is up; the reading finishes in the background and the card follows.
   */
  captureTab(tabId?: string, source: BookmarkSource = USER_BOOKMARK_SOURCE): Bookmark {
    const reader = this.#reader();
    if (reader === null) throw new Error("There is no window to bookmark from.");
    const tab = tabId === undefined ? reader.activeTab() : reader.tab(tabId);
    if (tab === null) throw new Error("There is no page to bookmark.");
    if (!isBookmarkableUrl(tab.url)) throw new Error("Only web pages can be bookmarked.");
    const existing = this.#store.byUrl(tab.url);
    if (existing !== null) {
      this.showToast(existing.id, true);
      return existing;
    }
    const bookmark = this.#store.add(
      { url: tab.url, title: tab.title.trim() || undefined, faviconUrl: tab.faviconUrl },
      source,
      { status: "extracting" },
    );
    this.showToast(bookmark.id, false);
    // Nobody awaits this: an undo from the card while the page is still
    // being read simply ends it, and a reading that fails has already
    // left the bookmark standing on the tab's title.
    void this.#enrich(bookmark.id, { tabId: tab.id, url: tab.url }).catch(() => undefined);
    return bookmark;
  }

  /**
   * The agent's path: an address, and whatever it knows. Resolves once the
   * page has been read, so the tool's answer is the finished card. Fields
   * the agent supplied win over what the page says — it was there for the
   * conversation.
   */
  async create(input: BookmarkInput, source: BookmarkSource): Promise<Bookmark> {
    if (!isBookmarkableUrl(input.url)) throw new Error("Only http(s) pages can be bookmarked.");
    const overrides = overridesOf(input);
    const existing = this.#store.byUrl(input.url);
    if (existing !== null) {
      const bookmark = Object.keys(overrides).length > 0 ? this.#store.update(existing.id, overrides, source) : existing;
      this.showToast(bookmark.id, true);
      return bookmark;
    }
    const bookmark = this.#store.add({ url: input.url, faviconUrl: input.faviconUrl ?? null }, source, { status: "extracting" });
    this.showToast(bookmark.id, false);
    const tab = this.#reader()?.allTabs().find((candidate) => bookmarkUrlKey(candidate.url) === bookmarkUrlKey(input.url)) ?? null;
    const completed = await this.#enrich(bookmark.id, { tabId: tab?.id ?? null, url: input.url, hint: input.note });
    if (completed === null) throw new Error("The bookmark was removed while its page was being read.");
    if (Object.keys(overrides).length === 0) return completed;
    return this.#store.update(bookmark.id, overrides, source);
  }

  /** Read the page again — after a bad extraction, or once a key is configured. */
  async refresh(id: string): Promise<Bookmark> {
    const bookmark = this.#store.get(id);
    if (bookmark === null) throw new Error("bookmark not found");
    const tab = this.#reader()?.allTabs().find((candidate) => bookmarkUrlKey(candidate.url) === bookmarkUrlKey(bookmark.url)) ?? null;
    const completed = await this.#enrich(id, { tabId: tab?.id ?? null, url: bookmark.url, hint: bookmark.note });
    if (completed === null) throw new Error("bookmark not found");
    return completed;
  }

  /**
   * Read the page and complete the bookmark. A failure to read at all (the
   * tab closed mid-capture, the fetch refused) still completes it — with
   * what it had — so no card is left a skeleton forever. Resolves null when
   * the bookmark was removed meanwhile: an undo from the card is the
   * reading's cancellation, not an error.
   */
  #enrich(id: string, page: { tabId: string | null; url: string; hint?: string | undefined }): Promise<Bookmark | null> {
    const pending = this.#inFlight.get(id);
    if (pending !== undefined) return pending;
    const work = (async (): Promise<Bookmark | null> => {
      const current = this.#store.get(id);
      if (current === null) return null;
      if (current.status !== "extracting") this.#store.beginExtraction(id);
      let snapshot: PageSnapshot | null = null;
      try {
        snapshot = await this.#read(page);
      } catch {
        snapshot = null;
      }
      if (this.#store.get(id) === null) return null;
      if (snapshot === null) return this.#store.complete(id, { provenance: "none" });
      const extraction = await this.#extract(snapshot, { useModel: this.#useModel(), ...(page.hint === undefined ? {} : { hint: page.hint }) });
      if (this.#store.get(id) === null) return null;
      const favicon = page.tabId === null ? undefined : this.#reader()?.tab(page.tabId)?.faviconUrl;
      return this.#store.complete(id, {
        ...extraction.fields,
        url: extraction.url,
        ...(favicon === undefined ? {} : { faviconUrl: favicon }),
        provenance: extraction.provenance,
      });
    })().finally(() => this.#inFlight.delete(id));
    this.#inFlight.set(id, work);
    return work;
  }

  async #read(page: { tabId: string | null; url: string }): Promise<PageSnapshot> {
    const reader = this.#reader();
    if (reader === null) throw new Error("no window");
    if (page.tabId !== null && reader.tab(page.tabId) !== null) {
      try {
        return await reader.capturePage(page.tabId);
      } catch {
        // The tab may have navigated or closed: read the address instead.
      }
    }
    const html = await reader.fetchHtml(page.url);
    return pageSnapshotFromHtml(html, page.url);
  }
}
