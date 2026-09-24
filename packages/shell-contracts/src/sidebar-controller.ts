/**
 * Every SidebarCommand (./sidebar.ts), applied against the shelf AND the live
 * tabs together. The two are coupled through anchors: pinning a tab writes a
 * pin and binds the tab to it; unpinning drops the pin and frees the tab;
 * opening a pin selects its tab or creates one bound to it. Only a host sees
 * both sides, so this is where each command lands.
 *
 * Nothing here publishes: the store's listener does, and a command that only
 * touched tabs goes through the host's tab controller, which does too.
 *
 * It lives in the contracts package rather than in Electron main because it
 * is arithmetic over two data structures and nothing else — no window, no
 * view, no file. Desktop main and the cloud `ShellHost`
 * (docs/web-browser-design.md §6.3) drive it through the two narrow ports
 * below, so a shelf gesture means exactly the same thing in the app and in a
 * browser tab.
 */

import type { BrowserTabInfo } from "./ipc.js";
import type { DesktopSettings } from "./settings.js";
import {
  childrenOf,
  favoriteOf,
  folderEmoji,
  folderOf,
  isPresetAnchorId,
  MAX_FAVORITES,
  MAX_FOLDER_NAME,
  pinOf,
  placeEntry,
  placeFavorite,
  PRESET_ANCHOR_PREFIX,
  removeEntry,
  topLevelOf,
  type SidebarCommand,
  type SidebarFavorite,
  type SidebarPin,
  type SidebarState,
} from "./sidebar.js";

/**
 * The shelf as it is kept per Space. Desktop main's `SidebarStore` and the
 * host's in-memory shelf both satisfy it.
 */
export interface SidebarShelfStore {
  get(spaceId: string): SidebarState;
  set(spaceId: string, state: SidebarState): void;
}

/**
 * The live tabs, as the shelf needs to see them. Every member is one desktop
 * main's `BrowserController` already has, so it satisfies this port as it
 * stands; the cloud host implements the same nine.
 */
export interface SidebarTabHost {
  activeSpaceId(): string;
  tabs(): readonly BrowserTabInfo[];
  tab(tabId: string): BrowserTabInfo | null;
  tabForAnchor(anchorId: string): BrowserTabInfo | null;
  setAnchor(tabId: string, anchorId: string | null): void;
  reorderTab(tabId: string, index: number): void;
  selectTab(tabId: string): Promise<void>;
  createTab(url: string, options?: { anchorId?: string; activate?: boolean }): Promise<string>;
  navigate(tabId: string, url: string): Promise<void>;
  /**
   * Set by the controller: whether a tab pulled into a split view stops
   * following its shelf entry. A favorite becomes an independent tab; a pin
   * paired with a day tab is still that pin.
   */
  anchorLeavesOnSplit: (anchorId: string, spaceId: string) => boolean;
}

/**
 * Ids are generated with the platform's own `crypto`. `randomUUID` is
 * SECURE-CONTEXT ONLY in a browser — `undefined` on `http://` — and this
 * module runs in a web page as well as in Electron main, so the fallback is
 * a v4 built from `getRandomValues`, which every context has.
 */
function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class SidebarController {
  readonly #store: SidebarShelfStore;
  readonly #browser: SidebarTabHost;
  readonly #settings: () => DesktopSettings;

  constructor(options: {
    store: SidebarShelfStore;
    browser: SidebarTabHost;
    settings: () => DesktopSettings;
    /**
     * Overrides the split rule below. A STREAM surface passes one: there is
     * no native tile for a favorite's pane to stop following (§10), so an
     * anchor survives the split there. Without it the desktop rule stands —
     * and the host that wants the other rule has to be able to say so, or its
     * own value is silently overwritten here.
     */
    anchorLeavesOnSplit?: (anchorId: string, spaceId: string) => boolean;
  }) {
    this.#store = options.store;
    this.#browser = options.browser;
    this.#settings = options.settings;
    // A favorite pulled into a split view becomes an independent tab: the tile
    // no longer lights up with it or follows where it navigates. Pins stay
    // anchored — a pinned page paired with a day tab is still that pin.
    this.#browser.anchorLeavesOnSplit =
      options.anchorLeavesOnSplit ??
      ((anchorId, spaceId) => isPresetAnchorId(anchorId) || favoriteOf(this.#store.get(spaceId), anchorId) !== null);
  }

  #state(): SidebarState {
    return this.#store.get(this.#browser.activeSpaceId());
  }

  #set(state: SidebarState): void {
    this.#store.set(this.#browser.activeSpaceId(), state);
  }

  async run(command: SidebarCommand): Promise<void> {
    switch (command.type) {
      case "open":
        return this.#open(command.anchorId);
      case "pinTab":
        return this.#pinTab(command.tabId, command.folderId, command.index);
      case "unpin":
        return this.#unpin(command.pinId, command.index);
      case "movePin": {
        const state = this.#state();
        const pin = pinOf(state, command.pinId);
        if (pin === null) return;
        this.#set({ ...state, entries: placeEntry(state.entries, pin, { folderId: command.folderId, index: command.index }) });
        return;
      }
      case "returnToPinned": {
        const pin = pinOf(this.#state(), command.pinId);
        const tab = pin === null ? null : this.#browser.tabForAnchor(pin.id);
        if (pin === null || tab === null) return;
        await this.#browser.navigate(tab.id, pin.url);
        return;
      }
      case "createFolder":
        return this.#createFolder(command.name, command.id, command.index, command.pinIds ?? []);
      case "renameFolder": {
        const state = this.#state();
        const folder = folderOf(state, command.folderId);
        if (folder === null) return;
        const name = command.name.trim().slice(0, MAX_FOLDER_NAME);
        folder.name = name === "" ? folder.name : name;
        this.#set(state);
        return;
      }
      case "styleFolder": {
        const state = this.#state();
        const folder = folderOf(state, command.folderId);
        if (folder === null) return;
        if (command.color !== undefined) folder.color = command.color;
        // An emoji that is not one leaves the icon as it was, the way an empty name leaves the name.
        if (command.emoji !== undefined) folder.emoji = command.emoji === null ? null : (folderEmoji(command.emoji) ?? folder.emoji);
        this.#set(state);
        return;
      }
      case "deleteFolder": {
        const state = this.#state();
        if (folderOf(state, command.folderId) === null) return;
        if (command.includePins === true) {
          const pins = childrenOf(state.entries, command.folderId);
          const pinIds = new Set(pins.map((pin) => pin.id));
          this.#set({
            ...state,
            entries: state.entries.filter(
              (entry) => entry.id !== command.folderId && !pinIds.has(entry.id),
            ),
          });
          // Removing a saved pin never closes its open page; it becomes a
          // regular day tab, matching the standalone Unpin action.
          for (const pin of pins) {
            const live = this.#browser.tabForAnchor(pin.id);
            if (live !== null) this.#browser.setAnchor(live.id, null);
          }
          return;
        }
        this.#set({ ...state, entries: removeEntry(state.entries, command.folderId) });
        return;
      }
      case "toggleFolder": {
        const state = this.#state();
        const folder = folderOf(state, command.folderId);
        if (folder === null) return;
        folder.collapsed = !folder.collapsed;
        this.#set(state);
        return;
      }
      case "moveFolder": {
        const state = this.#state();
        const folder = folderOf(state, command.folderId);
        if (folder === null) return;
        // The folder's pins travel with it: lift the run out, place the
        // header, then put the pins straight back behind it.
        const children = childrenOf(state.entries, folder.id);
        let entries = placeEntry(removeEntry(state.entries, folder.id), folder, { folderId: null, index: command.index });
        // removeEntry orphaned the children to the top level; take them out again.
        entries = entries.filter((e) => !children.some((c) => c.id === e.id));
        children.forEach((pin, i) => {
          entries = placeEntry(entries, { ...pin, folderId: folder.id }, { folderId: folder.id, index: i });
        });
        this.#set({ ...state, entries });
        return;
      }
      case "addFavorite":
        return this.#addFavorite(command);
      case "removeFavorite":
        return this.#removeFavorite(command.favoriteId, command.index);
      case "moveFavorite": {
        const state = this.#state();
        const favorite = favoriteOf(state, command.favoriteId);
        if (favorite === null) return;
        this.#set({ ...state, favorites: placeFavorite(state.favorites, favorite, command.index) });
        return;
      }
      case "favoriteToPin": {
        const state = this.#state();
        const favorite = favoriteOf(state, command.favoriteId);
        if (favorite === null) return;
        const pin: SidebarPin = { kind: "pin", id: newId(), url: favorite.url, title: favorite.title, faviconUrl: favorite.faviconUrl, folderId: null };
        // The live tab follows its page from the grid to the list.
        const tab = this.#browser.tabForAnchor(favorite.id);
        if (tab !== null) this.#browser.setAnchor(tab.id, pin.id);
        this.#set({
          favorites: state.favorites.filter((f) => f.id !== favorite.id),
          entries: placeEntry(state.entries, pin, { folderId: command.folderId, index: command.index }),
        });
        return;
      }
    }
  }

  /** The address behind an anchor, wherever it lives. */
  #urlOf(state: SidebarState, anchorId: string): string | null {
    if (isPresetAnchorId(anchorId)) {
      const url = anchorId.slice(PRESET_ANCHOR_PREFIX.length);
      return this.#settings().organization.presetLinks.some((link) => link.url === url) ? url : null;
    }
    return favoriteOf(state, anchorId)?.url ?? pinOf(state, anchorId)?.url ?? null;
  }

  async #open(anchorId: string): Promise<void> {
    const live = this.#browser.tabForAnchor(anchorId);
    if (live !== null) {
      await this.#browser.selectTab(live.id);
      return;
    }
    const url = this.#urlOf(this.#state(), anchorId);
    if (url === null) return;
    await this.#browser.createTab(url, { anchorId });
  }

  async #pinTab(tabId: string, folderId: string | null, index: number): Promise<void> {
    const tab = this.#browser.tab(tabId);
    // Agent tabs are a run's, not a page to keep; an anchored tab is already kept.
    if (tab === null || tab.kind !== "human" || tab.anchorId !== null) return;
    const state = this.#state();
    const pin: SidebarPin = { kind: "pin", id: newId(), url: tab.url, title: tab.title, faviconUrl: tab.faviconUrl, folderId: null };
    this.#browser.setAnchor(tab.id, pin.id);
    this.#set({ ...state, entries: placeEntry(state.entries, pin, { folderId, index }) });
  }

  /**
   * A pin's page joins the day's tabs at `index` among them — its live tab
   * moved there, or a fresh tab opened there when the pin was unloaded and a
   * place was named (a drop into the list). With no place named (the context
   * menu's "Unpin"), the live tab stays where the list has it.
   */
  async #unpin(pinId: string, index: number | undefined): Promise<void> {
    const state = this.#state();
    const pin = pinOf(state, pinId);
    if (pin === null) return;
    this.#set({ ...state, entries: removeEntry(state.entries, pin.id) });
    await this.#releaseAnchor(pin.id, pin.url, index);
  }

  async #releaseAnchor(anchorId: string, url: string, index: number | undefined): Promise<void> {
    const live = this.#browser.tabForAnchor(anchorId);
    if (live !== null) {
      this.#browser.setAnchor(live.id, null);
      if (index !== undefined) this.#browser.reorderTab(live.id, this.#dayIndexToGlobal(index, live.id));
      return;
    }
    if (index === undefined) return;
    const tabId = await this.#browser.createTab(url, { activate: false });
    this.#browser.reorderTab(tabId, this.#dayIndexToGlobal(index, tabId));
  }

  /**
   * "The `index`th day tab" as a position in the whole tab order (the order
   * the browser keeps, anchored tabs included), counted with `movingId`
   * lifted out — reorderTab's convention.
   */
  #dayIndexToGlobal(index: number, movingId: string): number {
    const rest = this.#browser.tabs().filter((t) => t.id !== movingId);
    const day = rest.filter((t) => t.anchorId === null);
    const target = day[index];
    return target === undefined ? rest.length : rest.findIndex((t) => t.id === target.id);
  }

  async #createFolder(rawName: string, requestedId: string | undefined, index: number | undefined, pinIds: string[]): Promise<void> {
    const state = this.#state();
    const name = rawName.trim().slice(0, MAX_FOLDER_NAME) || "New folder";
    if (requestedId !== undefined && state.entries.some((e) => e.id === requestedId)) return;
    const id = requestedId ?? newId();
    let entries = placeEntry(state.entries, { kind: "folder", id, name, collapsed: false, color: null, emoji: null }, {
      folderId: null,
      index: index ?? topLevelOf(state.entries).length,
    });
    pinIds.forEach((pinId, i) => {
      const pin = pinOf({ favorites: [], entries }, pinId);
      if (pin !== null) entries = placeEntry(entries, pin, { folderId: id, index: i });
    });
    this.#set({ ...state, entries });
  }

  async #addFavorite(command: Extract<SidebarCommand, { type: "addFavorite" }>): Promise<void> {
    const state = this.#state();
    if (state.favorites.length >= MAX_FAVORITES) return;
    const source = command.source;
    const favorite: SidebarFavorite = { id: newId(), url: "", title: "", faviconUrl: null };
    let entries = state.entries;
    let bind: BrowserTabInfo | null = null;
    if ("tabId" in source) {
      const tab = this.#browser.tab(source.tabId);
      if (tab === null || tab.kind !== "human") return;
      favorite.url = tab.url;
      favorite.title = tab.title;
      favorite.faviconUrl = tab.faviconUrl;
      // A day tab follows its page into the grid; a pinned one stays a pin
      // and the grid gets its own copy of the page.
      if (tab.anchorId === null) bind = tab;
    } else if ("pinId" in source) {
      const pin = pinOf(state, source.pinId);
      if (pin === null) return;
      favorite.url = pin.url;
      favorite.title = pin.title;
      favorite.faviconUrl = pin.faviconUrl;
      bind = this.#browser.tabForAnchor(pin.id);
      entries = removeEntry(entries, pin.id);
    } else {
      favorite.url = source.url;
      favorite.title = source.title;
    }
    if (bind !== null) this.#browser.setAnchor(bind.id, favorite.id);
    this.#set({ entries, favorites: placeFavorite(state.favorites, favorite, command.index ?? state.favorites.length) });
  }

  async #removeFavorite(favoriteId: string, index: number | undefined): Promise<void> {
    const state = this.#state();
    const favorite = favoriteOf(state, favoriteId);
    if (favorite === null) return;
    this.#set({ ...state, favorites: state.favorites.filter((f) => f.id !== favorite.id) });
    await this.#releaseAnchor(favorite.id, favorite.url, index);
  }
}
