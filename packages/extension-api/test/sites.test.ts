/**
 * The rows an extension hands the shell for the band and the sidebar (../src/sites.ts; docs/primitives.md §4.5): a
 * value main can check without the extension running — never markup, never more than a place holds.
 */

import { describe, expect, it } from "vitest";
import { validateManifest, manifestSites } from "../src/manifest.js";
import { ROW_ID_PATTERN, SITES, SITE_ADDS, SITE_ROWS_MAX, isSite, rowSchema, siteViewIssues, siteViewSchema } from "../src/sites.js";

const ok = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean => schema.safeParse(value).success;

describe("a row", () => {
  it("is what it says, with a mark, a detail, a value and two buttons at most", () => {
    expect(ok(rowSchema, { text: "KC 21 – BUF 17" })).toBe(true);
    expect(ok(rowSchema, { id: "game:401", mark: { glyph: "🏈", tone: "green" }, text: "KC 21 – BUF 17", detail: "3rd quarter", value: "4:12", buttons: [{ id: "open", title: "Open" }, { id: "mute", title: "Mute" }] })).toBe(true);
    // A mark with nothing said is a dot in the quiet tone.
    expect(ok(rowSchema, { mark: {}, text: "Build" })).toBe(true);
    expect(ok(rowSchema, { text: "Build", detail: "", value: "" })).toBe(true);
  });

  it("is one line of the extension's words and nothing else", () => {
    for (const bad of [
      {},
      { text: "" },
      { text: "   " },
      { text: "two\nlines" },
      { text: "ok", detail: "tab\there" },
      { text: "x".repeat(81) },
      { text: "ok", value: "x".repeat(25) },
      { text: "ok", html: "<b>bold</b>" },
      { text: "ok", icon: "https://example.com/a.png" },
      { text: "ok", mark: { glyph: "abc" } },
      { text: "ok", mark: { tone: "purple" } },
      { text: "ok", mark: { glyph: "A", color: "#ff0000" } },
      { text: "ok", buttons: [{ id: "a", title: "" }] },
      { text: "ok", buttons: [{ id: "a", title: "x".repeat(25) }] },
      { text: "ok", buttons: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }] },
      { text: "ok", buttons: [{ id: "a", title: "A", url: "https://example.com" }] },
    ]) {
      expect(ok(rowSchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("is named by an id a press can carry", () => {
    for (const id of ["a", "game:401", "pr.12_3-x", "A1"]) expect(ROW_ID_PATTERN.test(id), id).toBe(true);
    for (const id of ["", " a", "a b", ":a", "a/b", "x".repeat(65), "a\nb"]) expect(ROW_ID_PATTERN.test(id), id).toBe(false);
    expect(ok(rowSchema, { id: "has space", text: "ok" })).toBe(false);
  });
});

describe("what a place is handed", () => {
  it("is rows, a title for a section, and a space when it is for one", () => {
    expect(ok(siteViewSchema, { rows: [] })).toBe(true);
    expect(ok(siteViewSchema, { title: "Today’s games", rows: [{ text: "KC 21 – BUF 17" }], spaceId: "football" })).toBe(true);
    for (const bad of [{}, { rows: "none" }, { rows: [{ text: "ok" }], title: "" }, { rows: [{ text: "ok" }], title: "x".repeat(41) }, { rows: [{ text: "ok" }], spaceId: "" }, { rows: [{ text: "ok" }], site: "band" }, { rows: [{ text: "ok" }], view: "<div/>" }]) {
      expect(ok(siteViewSchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("holds no more rows than its place has room for, and no id twice", () => {
    const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `r${String(index)}`, text: `Row ${String(index)}` }));
    expect(siteViewIssues("band", { rows: rows(SITE_ROWS_MAX.band) })).toEqual([]);
    expect(siteViewIssues("band", { rows: rows(SITE_ROWS_MAX.band + 1) })[0]).toContain("the band holds 6 rows at most (7 given)");
    expect(siteViewIssues("sidebar", { rows: rows(SITE_ROWS_MAX.sidebar) })).toEqual([]);
    expect(siteViewIssues("sidebar", { rows: rows(SITE_ROWS_MAX.sidebar + 1) })[0]).toContain("a sidebar section holds 12 rows at most");
    // (The schema itself stops at the largest place's bound.)
    expect(ok(siteViewSchema, { rows: rows(13) })).toBe(false);
    expect(siteViewIssues("sidebar", { rows: [{ id: "a", text: "One" }, { id: "a", text: "Two" }] })).toEqual(['the row id "a" is used twice: a press could not say which row it was']);
    // The same button id in two rows is two buttons: the row says which.
    expect(siteViewIssues("sidebar", { rows: [{ id: "a", text: "One", buttons: [{ id: "open", title: "Open" }] }, { id: "b", text: "Two", buttons: [{ id: "open", title: "Open" }] }] })).toEqual([]);
    expect(siteViewIssues("band", { rows: [{ text: "One", buttons: [{ id: "x", title: "X" }, { id: "x", title: "Y" }] }] })).toEqual(['the button id "x" is used twice in one row']);
    // Rows with no id are all "no row" to a press: a button id in two of them is one press that could mean either.
    const open = [{ id: "open", title: "Open" }];
    expect(siteViewIssues("sidebar", { rows: [{ text: "One", buttons: open }, { text: "Two", buttons: open }] })).toEqual(['the button id "open" is used in two rows that have no id: give those rows ids, or a press could not say which row it was']);
    // One of them named, or the buttons named apart, a press says which.
    expect(siteViewIssues("sidebar", { rows: [{ id: "a", text: "One", buttons: open }, { text: "Two", buttons: open }] })).toEqual([]);
    expect(siteViewIssues("sidebar", { rows: [{ text: "One", buttons: open }, { text: "Two", buttons: [{ id: "close", title: "Close" }] }, { text: "Three" }] })).toEqual([]);
  });
});

describe("the places", () => {
  it("are two, each with the sheet's words", () => {
    expect([...SITES]).toEqual(["band", "sidebar"]);
    expect(isSite("band")).toBe(true);
    expect(isSite("toolbar")).toBe(false);
    expect(SITE_ADDS).toEqual({ band: "a strip beside the Bar", sidebar: "a section in the sidebar" });
  });

  it("are declared in pistachio.json, as true or not at all", () => {
    const base = { api: 1, id: "dev.me.scores", name: "Scores", version: "1.0.0" };
    const parsed = validateManifest({ ...base, band: true, sidebar: true });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? manifestSites(parsed.manifest) : null).toEqual(["band", "sidebar"]);
    const none = validateManifest(base);
    expect(none.ok ? manifestSites(none.manifest) : null).toEqual([]);
    for (const bad of [{ band: false }, { band: "yes" }, { sidebar: { title: "Games" } }, { toolbar: true }]) expect(validateManifest({ ...base, ...bad }).ok, JSON.stringify(bad)).toBe(false);
  });

  it("offers a menu item in a tab's own menu", () => {
    const base = { api: 1, id: "dev.me.scores", name: "Scores", version: "1.0.0", worker: { type: "web", main: "worker.js" } };
    expect(validateManifest({ ...base, contextMenus: [{ id: "save", title: "Save for later", contexts: ["tab"] }] }).ok).toBe(true);
    expect(validateManifest({ ...base, contextMenus: [{ id: "save", title: "Save for later", contexts: ["row"] }] }).ok).toBe(false);
  });
});
