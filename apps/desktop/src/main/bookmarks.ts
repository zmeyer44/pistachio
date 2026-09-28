/**
 * Saving a page: what happens between the double tap and the finished card.
 *
 * On the desktop a save is ONE thing in two places: the saved record — the
 * card, which syncs to the person's other devices and the web — and
 * Watchtower, which keeps the page's full text on this Mac and files it
 * under everything it is about. The tap starts both at once: the card's
 * skeleton goes up while the page's text goes into the archive; then one
 * reading by the model fills the card AND names the people, companies and
 * products the page covers, which are filed in Watchtower's index (a new
 * entry, or more for an existing one). A page saved before is saved again:
 * a new version if it changed, and its card and entries brought up to date.
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
import type {
  WatchtowerEntityRef,
  WatchtowerKeepStatus,
  WatchtowerSavedEntity,
} from "@pistachio/shell-contracts/watchtower";
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

/** A page kept in Watchtower by a save: the version now in the archive. */
export interface ArchiveKept {
  observationId: string;
  snapshotId: number;
  pageId: number;
  spaceId: string;
  /** Watchtower's policy epoch at the save: a reading that outlives a forget is not filed. */
  epoch: number;
}

/** What the service needs from Watchtower (main/watchtower/service.ts). */
export interface BookmarkArchive {
  /** Keep the tab's page in the archive now, under the saved record's address key. */
  keep(tabId: string, keptKey: string): Promise<ArchiveKept | { skipped: string }>;
  /** File what the page is about under the kept version; the entries it is now filed under. */
  file(kept: ArchiveKept, entities: WatchtowerSavedEntity[]): Promise<WatchtowerEntityRef[]>;
  /** What the archive already holds for the page, when there was nothing new to file. */
  about(spaceId: string, url: string): Promise<{ observationId: string; entities: WatchtowerEntityRef[] } | null | undefined>;
  /** The saved record settled on another address: follow it. */
  rekeep(kept: ArchiveKept, keptKey: string): void;
}

export interface BookmarkServiceOptions {
  store: BookmarkStore;
  /** Watchtower, on the desktop; absent where there is no archive. */
  archive?: () => BookmarkArchive | null;
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
  readonly #archive: () => BookmarkArchive | null;
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
    this.#archive = options.archive ?? (() => null);
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
  showToast(id: string, existed: boolean, watchtower?: WatchtowerKeepStatus): void {
    this.#toast = { id, existed, shownAt: this.#now().toISOString(), ...(watchtower === undefined ? {} : { watchtower }) };
    this.#onToast({ ...this.#toast });
  }

  /** Where the save stands in Watchtower, if its card is still the one showing. */
  #showArchive(id: string, watchtower: WatchtowerKeepStatus): void {
    if (this.#toast?.id !== id) return;
    this.#toast = { ...this.#toast, watchtower };
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
    const bookmark =
      existing ??
      this.#store.add(
        { url: tab.url, title: tab.title.trim() || undefined, faviconUrl: tab.faviconUrl },
        source,
        { status: "extracting" },
      );
    // The page goes into Watchtower while the model reads it for the card.
    const archive = this.#archive();
    const keeping = archive === null ? null : archive.keep(tab.id, bookmarkUrlKey(bookmark.url)).catch((): { skipped: string } => ({ skipped: "Watchtower could not save this page." }));
    this.showToast(bookmark.id, existing !== null, keeping === null ? undefined : { state: "saving", entities: [] });
    // Nobody awaits this: an undo from the card while the page is still
    // being read simply ends it, and a reading that fails has already
    // left the bookmark standing on the tab's title. A page saved before is
    // read again — a save is also an update.
    void this.#enrich(bookmark.id, { tabId: tab.id, url: tab.url, keeping }).catch(() => undefined);
    return existing ?? bookmark;
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
    const tab = this.#reader()?.allTabs().find((candidate) => bookmarkUrlKey(candidate.url) === bookmarkUrlKey(input.url)) ?? null;
    // Open in one of the person's tabs, the page is kept in Watchtower as a
    // tap would keep it; an address with no tab is read over the network
    // for the card alone.
    const archive = tab === null || tab.kind !== "human" ? null : this.#archive();
    const keeping = archive === null || tab === null ? null : archive.keep(tab.id, bookmarkUrlKey(input.url)).catch((): { skipped: string } => ({ skipped: "Watchtower could not save this page." }));
    this.showToast(bookmark.id, false, keeping === null ? undefined : { state: "saving", entities: [] });
    const completed = await this.#enrich(bookmark.id, { tabId: tab?.id ?? null, url: input.url, hint: input.note, keeping });
    if (completed === null) throw new Error("The bookmark was removed while its page was being read.");
    if (Object.keys(overrides).length === 0) return completed;
    return this.#store.update(bookmark.id, overrides, source);
  }

  /** Read the page again — after a bad extraction, or once a key is configured. */
  async refresh(id: string): Promise<Bookmark> {
    const bookmark = this.#store.get(id);
    if (bookmark === null) throw new Error("bookmark not found");
    const tab = this.#reader()?.allTabs().find((candidate) => bookmarkUrlKey(candidate.url) === bookmarkUrlKey(bookmark.url)) ?? null;
    // With the page open, reading it again keeps its current text too.
    const archive = tab === null || tab.kind !== "human" ? null : this.#archive();
    const keeping = archive === null || tab === null ? null : archive.keep(tab.id, bookmarkUrlKey(bookmark.url)).catch((): { skipped: string } => ({ skipped: "Watchtower could not save this page." }));
    const completed = await this.#enrich(id, { tabId: tab?.id ?? null, url: bookmark.url, hint: bookmark.note, keeping });
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
  #enrich(
    id: string,
    page: { tabId: string | null; url: string; hint?: string | undefined; keeping?: Promise<ArchiveKept | { skipped: string }> | null },
  ): Promise<Bookmark | null> {
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
      if (snapshot === null) {
        const completed = this.#store.complete(id, { provenance: "none" });
        await this.#file(id, completed.url, page.keeping, []);
        return completed;
      }
      const extraction = await this.#extract(snapshot, { useModel: this.#useModel(), ...(page.hint === undefined ? {} : { hint: page.hint }) });
      if (this.#store.get(id) === null) return null;
      const favicon = page.tabId === null ? undefined : this.#reader()?.tab(page.tabId)?.faviconUrl;
      const completed = this.#store.complete(id, {
        ...extraction.fields,
        url: extraction.url,
        ...(favicon === undefined ? {} : { faviconUrl: favicon }),
        provenance: extraction.provenance,
      });
      await this.#file(id, completed.url, page.keeping, extraction.entities ?? []);
      return completed;
    })().finally(() => this.#inFlight.delete(id));
    this.#inFlight.set(id, work);
    return work;
  }

  /**
   * The Watchtower half of a save, once the reading is done: what the page
   * is about filed under the version kept. Never fails the save — the card
   * says what happened instead.
   */
  async #file(
    id: string,
    url: string,
    keeping: Promise<ArchiveKept | { skipped: string }> | null | undefined,
    entities: WatchtowerSavedEntity[],
  ): Promise<void> {
    const archive = this.#archive();
    if (keeping === null || keeping === undefined || archive === null) return;
    const kept = await keeping;
    if ("skipped" in kept) {
      this.#showArchive(id, { state: "skipped", reason: kept.skipped, entities: [] });
      return;
    }
    // The record may have settled on the page's canonical address.
    archive.rekeep(kept, bookmarkUrlKey(url));
    let filed: WatchtowerEntityRef[] | null = null;
    try {
      // With nothing read by the model, the page's passive indexing stands.
      filed = entities.length > 0 ? await archive.file(kept, entities) : ((await archive.about(kept.spaceId, url))?.entities ?? []);
    } catch {
      filed = [];
    }
    this.#showArchive(id, { state: "saved", observationId: kept.observationId, entities: filed.slice(0, 8) });
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
