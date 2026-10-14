/**
 * The shelf controller, shared by Electron main and the cloud host
 * (docs/web-browser-design.md §6.3). Both of the guarantees here were broken
 * by the lift into this package: one by assuming a browser context that
 * `crypto.randomUUID` exists in, the other by the controller overwriting a
 * rule its host had already decided.
 */

import { describe, expect, it } from "vitest";
import { SidebarController, type SidebarShelfStore, type SidebarTabHost } from "../src/sidebar-controller.js";
import { DEFAULT_SIDEBAR_STATE, type SidebarState } from "../src/sidebar.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import type { BrowserTabInfo } from "../src/ipc.js";

function harness(options: { anchorLeavesOnSplit?: (anchorId: string, spaceId: string) => boolean } = {}): {
  controller: SidebarController;
  browser: SidebarTabHost;
  state: () => SidebarState;
} {
  let state: SidebarState = DEFAULT_SIDEBAR_STATE;
  const store: SidebarShelfStore = {
    get: () => state,
    set: (_spaceId, next) => {
      state = next;
    },
  };
  const browser: SidebarTabHost = {
    anchorLeavesOnSplit: () => false,
    activeSpaceId: () => "work",
    tabs: () => [],
    tab: () => null,
    tabForAnchor: () => null,
    setAnchor: () => undefined,
    reorderTab: () => undefined,
    selectTab: async () => undefined,
    createTab: async () => "tab-1",
    navigate: async () => undefined,
  };
  const controller = new SidebarController({
    store,
    browser,
    settings: () => DEFAULT_SETTINGS,
    ...(options.anchorLeavesOnSplit === undefined ? {} : { anchorLeavesOnSplit: options.anchorLeavesOnSplit }),
  });
  return { controller, browser, state: () => state };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe("the shelf controller", () => {
  it("makes shelf ids in a browser with no secure context", async () => {
    // `crypto.randomUUID` is secure-context only: on `http://` it is simply
    // not there, and the shelf silently stopped being able to add anything.
    const original = crypto.randomUUID;
    Reflect.deleteProperty(crypto as unknown as Record<string, unknown>, "randomUUID");
    try {
      const { controller, state } = harness();
      await controller.run({ type: "addFavorite", source: { url: "https://example.com/", title: "Example" } });
      const [favorite] = state().favorites;
      expect(favorite).toBeDefined();
      expect(favorite?.id).toMatch(UUID);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true, writable: true });
    }
  });

  it("a stream surface keeps its own split rule instead of having it overwritten", () => {
    // §10: there is no native tile for a pane to stop following, so a
    // favorite's anchor survives the split. The host said so; the controller
    // used to assign over it on the very next line.
    const stream = harness({ anchorLeavesOnSplit: () => false });
    expect(stream.browser.anchorLeavesOnSplit("preset:https://example.com/", "work")).toBe(false);
    // The desktop, which passes no override, still gets the desktop rule.
    const native = harness();
    expect(native.browser.anchorLeavesOnSplit("preset:https://example.com/", "work")).toBe(true);
  });

  it("styles a folder: a colour and an emoji, each set, kept, or put back alone", async () => {
    const { controller, state } = harness();
    await controller.run({ type: "createFolder", name: "Work", id: "f" });
    const folder = (): unknown => state().entries.find((entry) => entry.id === "f");
    expect(folder()).toMatchObject({ color: null, emoji: null });

    await controller.run({ type: "styleFolder", folderId: "f", color: "purple" });
    await controller.run({ type: "styleFolder", folderId: "f", emoji: " 🚀 to the moon" });
    // Only the first grapheme is kept, and the colour was left alone.
    expect(folder()).toMatchObject({ color: "purple", emoji: "🚀" });

    // Words are not an icon: the emoji it had stays.
    await controller.run({ type: "styleFolder", folderId: "f", emoji: "work" });
    expect(folder()).toMatchObject({ color: "purple", emoji: "🚀" });

    await controller.run({ type: "styleFolder", folderId: "f", color: null, emoji: null });
    expect(folder()).toMatchObject({ color: null, emoji: null });

    // A folder that is gone is a no-op, never an error.
    await controller.run({ type: "styleFolder", folderId: "gone", color: "red" });
  });

  it("brings an entry's page down into the day's tabs, or into a group, and keeps the entry — closed", async () => {
    const { controller, browser, state } = harness();
    const anchors = new Map<string, string | null>([["page", "fav"]]);
    const placed: Array<[string, unknown]> = [];
    const opened: string[] = [];
    browser.tabForAnchor = (anchorId) => {
      const tabId = [...anchors].find(([, anchor]) => anchor === anchorId)?.[0];
      return tabId === undefined ? null : ({ id: tabId, anchorId } as ReturnType<SidebarTabHost["tabForAnchor"]>);
    };
    browser.setAnchor = (tabId, anchorId) => void anchors.set(tabId, anchorId);
    browser.createTab = async (url) => {
      opened.push(url);
      return "fresh";
    };
    browser.placeDayTab = (tabId, place) => void placed.push([tabId, place]);
    await controller.run({ type: "addFavorite", source: { url: "https://example.com/", title: "Example" } });
    const favorite = state().favorites[0]!;
    anchors.set("page", favorite.id);

    await controller.run({ type: "bringDown", anchorId: favorite.id, index: 2 });
    expect(anchors.get("page")).toBe(null);
    expect(placed).toEqual([["page", { index: 2 }]]);
    expect(state().favorites.map((kept) => kept.id)).toEqual([favorite.id]);

    // Closed, it brings down a fresh page at its address — here into a group.
    await controller.run({ type: "bringDown", anchorId: favorite.id, groupId: "g", index: 1 });
    expect(opened).toEqual(["https://example.com/"]);
    expect(placed.at(-1)).toEqual(["fresh", { groupId: "g", index: 1 }]);
    expect(state().favorites).toHaveLength(1);

    // An entry that is not there, open or not, is a no-op.
    await controller.run({ type: "bringDown", anchorId: "gone", index: 0 });
    expect(placed).toHaveLength(2);
  });
});

/** A tab as the port hands it over; only what the shelf reads matters. */
function tabInfo(id: string, anchorId: string | null, linkedAnchorId?: string): BrowserTabInfo {
  return {
    id,
    spaceId: "work",
    title: id,
    url: `https://${id}.example/`,
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    kind: "human",
    runId: null,
    lifecycle: "live",
    lastActiveAt: 1,
    unlisted: false,
    anchorId,
    ...(linkedAnchorId === undefined ? {} : { linkedAnchorId }),
  };
}

/**
 * A host with spaces, as desktop main is (2026-10-14): it links an entry's page brought into a space (setLink) and
 * brings a page down in one step of its own (bringDownPage); the controller only says which page and where.
 */
function spacesHarness(tabs: BrowserTabInfo[]) {
  const made = harness();
  const calls: unknown[][] = [];
  const live = (): BrowserTabInfo[] => tabs;
  made.browser.tabs = live;
  made.browser.tab = (tabId) => live().find((tab) => tab.id === tabId) ?? null;
  made.browser.tabForAnchor = (anchorId) => live().find((tab) => tab.anchorId === anchorId) ?? null;
  made.browser.setAnchor = (tabId, anchorId) => void calls.push(["setAnchor", tabId, anchorId]);
  made.browser.setLink = (tabId, anchorId) => {
    calls.push(["setLink", tabId, anchorId]);
    const tab = live().find((candidate) => candidate.id === tabId);
    if (tab === undefined) return;
    if (anchorId === null) delete tab.linkedAnchorId;
    else tab.linkedAnchorId = anchorId;
  };
  made.browser.bringDownPage = async (anchorId, page, place) => void calls.push(["bringDownPage", anchorId, page, place]);
  made.browser.selectTab = async (tabId) => void calls.push(["selectTab", tabId]);
  made.browser.createTab = async (url, options) => {
    calls.push(["createTab", url, options]);
    return "fresh";
  };
  made.browser.placeDayTab = (tabId, place) => void calls.push(["placeDayTab", tabId, place]);
  made.browser.navigate = async (tabId, url) => void calls.push(["navigate", tabId, url]);
  return { ...made, calls };
}

describe("the shelf with spaces: an entry's page in a space stays its entry's (2026-10-14)", () => {
  it("hands a bring-down to the host whole — its page, anchored or linked, or the entry's address and title — and where it goes", async () => {
    const tabs = [tabInfo("own", null), tabInfo("linked", null)];
    const { controller, state, calls } = spacesHarness(tabs);
    await controller.run({ type: "addFavorite", source: { url: "https://mail.example/", title: "Mail" } });
    await controller.run({ type: "addFavorite", source: { url: "https://docs.example/", title: "Docs" } });
    const [mail, docs] = state().favorites as unknown as [{ id: string }, { id: string }];
    tabs[0]!.anchorId = mail.id;
    tabs[1]!.linkedAnchorId = docs.id;

    await controller.run({ type: "bringDown", anchorId: mail.id, groupId: "trip", index: 1 });
    await controller.run({ type: "bringDown", anchorId: mail.id, newGroupId: "space-new" });
    await controller.run({ type: "bringDown", anchorId: mail.id, index: 3 });
    await controller.run({ type: "bringDown", anchorId: mail.id });
    // Its page already in a space: that tab is the one brought — never a second page.
    await controller.run({ type: "bringDown", anchorId: docs.id, groupId: "work" });
    tabs[0]!.anchorId = null;
    // Closed: the address to open a fresh page at, called by the entry until it names itself.
    await controller.run({ type: "bringDown", anchorId: mail.id, newGroupId: "space-2" });
    expect(calls).toEqual([
      ["bringDownPage", mail.id, { tabId: "own" }, { groupId: "trip", index: 1 }],
      ["bringDownPage", mail.id, { tabId: "own" }, { newGroupId: "space-new" }],
      ["bringDownPage", mail.id, { tabId: "own" }, { index: 3 }],
      ["bringDownPage", mail.id, { tabId: "own" }, null],
      ["bringDownPage", docs.id, { tabId: "linked" }, { groupId: "work" }],
      ["bringDownPage", mail.id, { url: "https://mail.example/", title: "Mail" }, { newGroupId: "space-2" }],
    ]);
    // The controller itself lets go of nothing and places nothing: the host does it in one step.
    expect(calls.some(([name]) => name === "setAnchor" || name === "placeDayTab" || name === "createTab")).toBe(false);
    // An entry that is not there, open or not, is a no-op.
    await controller.run({ type: "bringDown", anchorId: "gone", newGroupId: "space-3" });
    expect(calls).toHaveLength(6);
  });

  it("opens an entry on its page: its own, else the tab linked to it in a space — never a fresh one beside it", async () => {
    const tabs = [tabInfo("in-space", null, "fav-a"), tabInfo("own", "fav-b"), tabInfo("other", null, "fav-b")];
    const { controller, calls } = spacesHarness(tabs);
    await controller.run({ type: "open", anchorId: "fav-a" });
    await controller.run({ type: "open", anchorId: "fav-b" });
    expect(calls).toEqual([
      ["selectTab", "in-space"],
      ["selectTab", "own"],
    ]);
  });

  it("carries the link with its entry made into another, and ends it — the page staying in its space — with the entry gone", async () => {
    const tabs = [tabInfo("page", null)];
    const { controller, state, calls } = spacesHarness(tabs);
    await controller.run({ type: "addFavorite", source: { url: "https://mail.example/", title: "Mail" } });
    const favorite = state().favorites[0]!;
    tabs[0]!.linkedAnchorId = favorite.id;

    // A favorite made a pin: its page in a space is the pin's now; and back.
    await controller.run({ type: "favoriteToPin", favoriteId: favorite.id, folderId: null, index: 0 });
    const pin = state().entries[0]!;
    expect(tabs[0]!.linkedAnchorId).toBe(pin.id);
    await controller.run({ type: "returnToPinned", pinId: pin.id });
    expect(calls.at(-1)).toEqual(["navigate", "page", "https://mail.example/"]);
    await controller.run({ type: "addFavorite", source: { pinId: pin.id } });
    const again = state().favorites[0]!;
    expect(tabs[0]!.linkedAnchorId).toBe(again.id);
    expect(calls.filter(([name]) => name === "setAnchor")).toEqual([]);

    // Removed — even dropped at a place among the day's tabs — the entry ends the link; the page is not moved or opened.
    await controller.run({ type: "removeFavorite", favoriteId: again.id, index: 2 });
    expect(tabs[0]!.linkedAnchorId).toBeUndefined();
    expect(calls.some(([name]) => name === "placeDayTab" || name === "createTab")).toBe(false);

    // A pin removed, and a folder deleted with its pins, do the same.
    await controller.run({ type: "addFavorite", source: { url: "https://x.example/", title: "X" } });
    await controller.run({ type: "favoriteToPin", favoriteId: state().favorites[0]!.id, folderId: null, index: 0 });
    const second = state().entries[0]!;
    tabs[0]!.linkedAnchorId = second.id;
    await controller.run({ type: "unpin", pinId: second.id });
    expect(tabs[0]!.linkedAnchorId).toBeUndefined();
    await controller.run({ type: "createFolder", name: "Work", id: "folder" });
    await controller.run({ type: "addFavorite", source: { url: "https://y.example/", title: "Y" } });
    await controller.run({ type: "favoriteToPin", favoriteId: state().favorites[0]!.id, folderId: "folder", index: 0 });
    const third = state().entries.find((entry) => entry.kind === "pin")!;
    tabs[0]!.linkedAnchorId = third.id;
    await controller.run({ type: "deleteFolder", folderId: "folder", includePins: true });
    expect(tabs[0]!.linkedAnchorId).toBeUndefined();
    expect(calls.some(([name]) => name === "placeDayTab" || name === "createTab")).toBe(false);
  });

  it("on a host without spaces, nothing is linked: a link is not a page there", async () => {
    const { controller, browser, state } = harness();
    const opened: string[] = [];
    browser.tabs = () => [tabInfo("stray", null, "fav")];
    browser.createTab = async (url) => {
      opened.push(url);
      return "fresh";
    };
    await controller.run({ type: "addFavorite", source: { url: "https://mail.example/", title: "Mail" } });
    browser.tabs = () => [tabInfo("stray", null, state().favorites[0]!.id)];
    await controller.run({ type: "open", anchorId: state().favorites[0]!.id });
    expect(opened).toEqual(["https://mail.example/"]);
  });
});
