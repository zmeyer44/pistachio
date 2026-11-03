import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SHORTCUTS } from "@pistachio/shell-contracts/shortcuts";
import { sanitizeTabSession } from "@pistachio/shell-contracts/tab-session";
import {
  buildPageContextMenu,
  extensionMenuContexts,
  type ContextMenuTemplateItem,
  type PageContextMenuActions,
  type PageContextMenuExtensionItem,
  type PageContextMenuParams,
  type PageContextMenuState,
} from "../src/main/page-context-menu";

const FLAGS = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canDelete: false, canSelectAll: false };
const MEDIA = { isLooping: false, canLoop: false, isControlsVisible: false, canToggleControls: false, isShowingPictureInPicture: false, canShowPictureInPicture: false, canSave: false };

function params(overrides: Partial<PageContextMenuParams> = {}): PageContextMenuParams {
  return { linkURL: "", pageURL: "https://example.com/", srcURL: "", selectionText: "", misspelledWord: "", dictionarySuggestions: [], hasImageContents: false, isEditable: false, mediaType: "none", editFlags: FLAGS, mediaFlags: MEDIA, ...overrides };
}

function state(extensions: PageContextMenuExtensionItem[]): PageContextMenuState {
  return { canGoBack: false, canGoForward: false, copyAllowed: true, pasteAllowed: true, downloadAllowed: true, printAllowed: true, inReaderView: false, platform: "darwin", shortcuts: DEFAULT_SHORTCUTS, searchProvider: "google", extensions };
}

function actions(): PageContextMenuActions & { extensionItem: ReturnType<typeof vi.fn> } {
  const noop = vi.fn();
  return {
    back: noop, forward: noop, reload: noop, openInNewTab: noop, openInGlance: noop, copyText: noop, copyImage: noop, save: noop, savePage: noop, search: noop, lookUp: noop,
    readAloud: noop, readerView: noop, print: noop, inspect: noop, replaceMisspelling: noop, addToDictionary: noop, showEmojiPanel: noop, media: noop, addImageToChat: noop, addSelectionToChat: noop,
    extensionItem: vi.fn(),
  };
}

const item = (extensionId: string, itemId: string, contexts: PageContextMenuExtensionItem["contexts"]): PageContextMenuExtensionItem => ({ extensionId, extensionName: extensionId.toUpperCase(), itemId, title: `${itemId} title`, contexts });
const labels = (template: ContextMenuTemplateItem[]): string[] => template.map((entry) => (entry.type === "separator" ? "---" : (entry.label ?? entry.role ?? "?")));

describe("extensions in the page's menu", () => {
  it("reads what the pointer is over as Chrome's contexts", () => {
    expect([...extensionMenuContexts(params())]).toEqual(["page"]);
    expect([...extensionMenuContexts(params({ linkURL: "https://a.com/" }))]).toEqual(["link"]);
    expect([...extensionMenuContexts(params({ selectionText: " words " }))]).toEqual(["selection"]);
    expect([...extensionMenuContexts(params({ mediaType: "image", srcURL: "https://a.com/i.png" }))]).toEqual(["image"]);
    expect([...extensionMenuContexts(params({ isEditable: true }))]).toEqual([]);
  });

  it("shows one extension's one item as itself, before Inspect, and its click carries the item", () => {
    const acts = actions();
    const template = buildPageContextMenu(params(), state([item("a.a", "save", ["page"]), item("b.b", "only-links", ["link"]), item("c.c", "window-only", ["window"])]), acts);
    expect(labels(template)).toContain("save title");
    expect(labels(template)).not.toContain("only-links title");
    expect(labels(template)).not.toContain("window-only title");
    expect(labels(template).indexOf("save title")).toBeLessThan(labels(template).indexOf("Inspect"));
    template.find((entry) => entry.label === "save title")!.click!();
    expect(acts.extensionItem).toHaveBeenCalledWith(expect.objectContaining({ extensionId: "a.a", itemId: "save" }));
  });

  it("groups several of one extension's items under its name", () => {
    const template = buildPageContextMenu(params({ selectionText: "hello" }), state([item("a.a", "one", ["selection"]), item("a.a", "two", ["selection", "page"])]), actions());
    const group = template.find((entry) => entry.label === "A.A");
    expect(group?.submenu?.map((entry) => entry.label)).toEqual(["one title", "two title"]);
  });

  it("has no section without items, or on a host that offers none", () => {
    const withNone = buildPageContextMenu(params(), state([]), actions());
    const { extensionItem: _unused, ...webActions } = actions();
    const web = buildPageContextMenu(params(), state([item("a.a", "x", ["page"])]), webActions);
    expect(labels(withNone)).toEqual(labels(web));
  });
});

describe("an extension's page in the session file", () => {
  const session = {
    version: 1,
    spaces: {
      work: {
        tabs: [
          { id: "page", url: "pistachio-ext://dev.zach.inbox/editor.html?rec=1", title: "Inbox", extensionId: "dev.zach.inbox", history: { index: 1, entries: [{ url: "pistachio-ext://dev.zach.inbox/a.html", title: "a" }, { url: "pistachio-ext://dev.zach.inbox/editor.html?rec=1", title: "b" }, { url: "https://evil.example/", title: "c" }] } },
          { id: "forged", url: "pistachio-ext://dev.other.ext/x.html", title: "Forged", extensionId: "dev.zach.inbox" },
          { id: "web", url: "https://example.com/", title: "Web" },
        ],
        activeTabId: "web",
        recentTabIds: [],
        splitGroups: [],
      },
    },
  };

  it("is kept on this Mac, at its own address, its stack held to its origin", () => {
    const read = sanitizeTabSession(session, new Set(["work"]), { files: true });
    const tabs = read.spaces.work!.tabs;
    expect(tabs.map((tab) => tab.id)).toEqual(["page", "web"]);
    expect(tabs[0]).toMatchObject({ url: "pistachio-ext://dev.zach.inbox/editor.html?rec=1", extensionId: "dev.zach.inbox", history: { index: 1, entries: [{ url: "pistachio-ext://dev.zach.inbox/a.html" }, { url: "pistachio-ext://dev.zach.inbox/editor.html?rec=1" }] } });
  });

  it("is never in another device's restore point", () => {
    const read = sanitizeTabSession(session, new Set(["work"]));
    expect(read.spaces.work!.tabs.map((tab) => tab.id)).toEqual(["web"]);
  });
});
