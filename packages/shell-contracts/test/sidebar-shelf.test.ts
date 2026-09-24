import { describe, expect, it } from "vitest";
import {
  childrenOf,
  folderEmoji,
  isSidebarCommand,
  placeEntry,
  placeFavorite,
  presetAnchorId,
  removeEntry,
  sanitizeSidebarState,
  topLevelOf,
  type SidebarEntry,
  type SidebarPin,
} from "../src/sidebar.js";

const pin = (id: string, folderId: string | null = null): SidebarPin => ({
  kind: "pin",
  id,
  url: `https://${id}.example/`,
  title: id,
  faviconUrl: null,
  folderId,
});
const folder = (id: string, collapsed = false): SidebarEntry => ({ kind: "folder", id, name: id, collapsed, color: null, emoji: null });

const ids = (entries: readonly SidebarEntry[]): string[] => entries.map((e) => e.id);

describe("sanitizeSidebarState", () => {
  it("returns an empty shelf for garbage", () => {
    expect(sanitizeSidebarState(null)).toEqual({ favorites: [], entries: [] });
    expect(sanitizeSidebarState("x")).toEqual({ favorites: [], entries: [] });
    expect(sanitizeSidebarState({ favorites: 3, entries: "no" })).toEqual({ favorites: [], entries: [] });
  });

  it("drops bad items, never the whole file", () => {
    const state = sanitizeSidebarState({
      favorites: [
        { id: "a", url: "https://a.example/", title: "A" },
        { id: "b", url: "javascript:alert(1)", title: "B" },
        { id: "a", url: "https://dup.example/" },
        { url: "https://noid.example/" },
      ],
      entries: [
        folder("f"),
        pin("p1", "f"),
        { kind: "pin", id: "p2", url: "ftp://nope", folderId: null },
        { kind: "what", id: "x" },
        pin("p3", "gone"),
      ],
    });
    expect(state.favorites.map((f) => f.id)).toEqual(["a"]);
    expect(state.favorites[0]?.faviconUrl).toBeNull();
    expect(ids(state.entries)).toEqual(["f", "p1", "p3"]);
    // A pin whose folder is gone comes back at the top level.
    expect(childrenOf(state.entries, null).map((p) => p.id)).toEqual(["p3"]);
  });

  it("accepts the app's own scheme, as a tab does", () => {
    const state = sanitizeSidebarState({ entries: [{ kind: "pin", id: "d", url: "pistachio://demo/invoices", folderId: null }] });
    expect(ids(state.entries)).toEqual(["d"]);
  });
});

describe("folderEmoji", () => {
  it("keeps one emoji — the first grapheme, whole", () => {
    expect(folderEmoji("🚀")).toBe("🚀");
    expect(folderEmoji("  ❤️ ")).toBe("❤️");
    expect(folderEmoji("👨‍👩‍👧‍👦 family")).toBe("👨‍👩‍👧‍👦");
    expect(folderEmoji("👍🏽👍")).toBe("👍🏽");
    expect(folderEmoji("🇯🇵")).toBe("🇯🇵");
    expect(folderEmoji("1️⃣")).toBe("1️⃣");
  });

  it("refuses what is not an emoji, so the icon slot never holds a word", () => {
    for (const value of ["", "   ", "work", "1", "w🚀", 7, null, undefined]) expect(folderEmoji(value), String(value)).toBeNull();
  });
});

describe("a folder's style on disk", () => {
  it("reads a file from before folders had one, and drops a style it does not know", () => {
    const state = sanitizeSidebarState({
      entries: [
        { kind: "folder", id: "old", name: "Old", collapsed: false },
        { kind: "folder", id: "styled", name: "Styled", collapsed: true, color: "green", emoji: "🌱" },
        { kind: "folder", id: "odd", name: "Odd", collapsed: false, color: "teal", emoji: "plant" },
      ],
    });
    expect(state.entries).toEqual([
      { kind: "folder", id: "old", name: "Old", collapsed: false, color: null, emoji: null },
      { kind: "folder", id: "styled", name: "Styled", collapsed: true, color: "green", emoji: "🌱" },
      { kind: "folder", id: "odd", name: "Odd", collapsed: false, color: null, emoji: null },
    ]);
  });
});

describe("placeEntry", () => {
  const base: SidebarEntry[] = [pin("a"), folder("f"), pin("f1", "f"), pin("f2", "f"), pin("b")];

  it("puts a pin at an index among the top level", () => {
    expect(ids(placeEntry(base, pin("n"), { folderId: null, index: 0 }))).toEqual(["n", "a", "f", "f1", "f2", "b"]);
    expect(ids(placeEntry(base, pin("n"), { folderId: null, index: 2 }))).toEqual(["a", "f", "f1", "f2", "n", "b"]);
    expect(ids(placeEntry(base, pin("n"), { folderId: null, index: 99 }))).toEqual(["a", "f", "f1", "f2", "b", "n"]);
  });

  it("puts a pin inside a folder, keeping the folder's run contiguous", () => {
    const first = placeEntry(base, pin("n"), { folderId: "f", index: 0 });
    expect(ids(first)).toEqual(["a", "f", "n", "f1", "f2", "b"]);
    expect(childrenOf(first, "f").map((p) => p.id)).toEqual(["n", "f1", "f2"]);
    const last = placeEntry(base, pin("n"), { folderId: "f", index: 5 });
    expect(ids(last)).toEqual(["a", "f", "f1", "f2", "n", "b"]);
    expect(childrenOf(last, "f").map((p) => p.id)).toEqual(["f1", "f2", "n"]);
  });

  it("puts the first pin of an empty folder right after its header", () => {
    const entries: SidebarEntry[] = [folder("e"), pin("z")];
    expect(ids(placeEntry(entries, pin("n"), { folderId: "e", index: 0 }))).toEqual(["e", "n", "z"]);
    expect(childrenOf(placeEntry(entries, pin("n"), { folderId: "e", index: 0 }), "e").map((p) => p.id)).toEqual(["n"]);
  });

  it("moves an existing entry rather than duplicating it", () => {
    const moved = placeEntry(base, pin("b"), { folderId: "f", index: 1 });
    expect(ids(moved)).toEqual(["a", "f", "f1", "b", "f2"]);
    expect(moved.filter((e) => e.id === "b")).toHaveLength(1);
    expect(childrenOf(moved, "f").map((p) => p.id)).toEqual(["f1", "b", "f2"]);
  });

  it("never nests a folder, and lands a pin aimed at an unknown folder at the top level", () => {
    expect(ids(placeEntry(base, folder("g"), { folderId: "f", index: 0 }))).toEqual(["g", "a", "f", "f1", "f2", "b"]);
    const stray = placeEntry(base, pin("n"), { folderId: "nope", index: 1 });
    expect(childrenOf(stray, null).map((p) => p.id)).toContain("n");
    expect(topLevelOf(stray).map((e) => e.id)).toEqual(["a", "n", "f", "b"]);
  });
});

describe("removeEntry", () => {
  it("drops a pin, and a folder's pins come out at the folder's place", () => {
    const base: SidebarEntry[] = [pin("a"), folder("f"), pin("f1", "f"), pin("f2", "f"), pin("b")];
    expect(ids(removeEntry(base, "f1"))).toEqual(["a", "f", "f2", "b"]);
    const without = removeEntry(base, "f");
    expect(ids(without)).toEqual(["a", "f1", "f2", "b"]);
    expect(without.every((e) => e.kind === "pin" && e.folderId === null)).toBe(true);
  });
});

describe("placeFavorite", () => {
  it("inserts, clamps, and moves", () => {
    const fav = (id: string) => ({ id, url: `https://${id}.example/`, title: id, faviconUrl: null });
    const base = [fav("a"), fav("b")];
    expect(placeFavorite(base, fav("n"), 1).map((f) => f.id)).toEqual(["a", "n", "b"]);
    expect(placeFavorite(base, fav("n"), 9).map((f) => f.id)).toEqual(["a", "b", "n"]);
    expect(placeFavorite(base, fav("b"), 0).map((f) => f.id)).toEqual(["b", "a"]);
  });
});

describe("isSidebarCommand", () => {
  it("accepts every variant with well-formed fields", () => {
    const ok = [
      { type: "open", anchorId: presetAnchorId("https://a.example/") },
      { type: "pinTab", tabId: "t", folderId: null, index: 0 },
      { type: "pinTab", tabId: "t", folderId: "f", index: 3 },
      { type: "unpin", pinId: "p" },
      { type: "unpin", pinId: "p", index: 2 },
      { type: "movePin", pinId: "p", folderId: null, index: 1 },
      { type: "returnToPinned", pinId: "p" },
      { type: "createFolder", name: "Work" },
      { type: "createFolder", name: "Work", id: "id", index: 1, pinIds: ["p"] },
      { type: "renameFolder", folderId: "f", name: "Ops" },
      { type: "styleFolder", folderId: "f" },
      { type: "styleFolder", folderId: "f", color: "blue" },
      { type: "styleFolder", folderId: "f", color: null, emoji: null },
      { type: "styleFolder", folderId: "f", emoji: "🚀" },
      { type: "deleteFolder", folderId: "f" },
      { type: "deleteFolder", folderId: "f", includePins: true },
      { type: "toggleFolder", folderId: "f" },
      { type: "moveFolder", folderId: "f", index: 0 },
      { type: "addFavorite", source: { tabId: "t" } },
      { type: "addFavorite", source: { pinId: "p" }, index: 0 },
      { type: "addFavorite", source: { url: "https://a.example/", title: "A" } },
      { type: "removeFavorite", favoriteId: "x" },
      { type: "moveFavorite", favoriteId: "x", index: 2 },
      { type: "favoriteToPin", favoriteId: "x", folderId: null, index: 0 },
    ];
    for (const command of ok) expect(isSidebarCommand(command), JSON.stringify(command)).toBe(true);
  });

  it("refuses malformed fields — this guards values from another process", () => {
    const bad = [
      null,
      { type: "open" },
      { type: "pinTab", tabId: "t", folderId: 3, index: 0 },
      { type: "pinTab", tabId: "t", folderId: null, index: -1 },
      { type: "pinTab", tabId: "t", folderId: null, index: 1.5 },
      { type: "unpin", pinId: "" },
      { type: "createFolder", name: "x".repeat(61) },
      { type: "createFolder", name: "ok", pinIds: [1] },
      { type: "deleteFolder", folderId: "f", includePins: "yes" },
      { type: "styleFolder", folderId: "f", color: "teal" },
      { type: "styleFolder", folderId: "f", emoji: 7 },
      { type: "styleFolder", folderId: "f", emoji: "x".repeat(33) },
      { type: "styleFolder", folderId: "", color: "blue" },
      { type: "addFavorite", source: { url: "javascript:1", title: "A" } },
      { type: "addFavorite", source: {} },
      { type: "moveFavorite", favoriteId: "x" },
      { type: "nope" },
    ];
    for (const command of bad) expect(isSidebarCommand(command), JSON.stringify(command)).toBe(false);
  });
});
