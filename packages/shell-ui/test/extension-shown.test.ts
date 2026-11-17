/**
 * What extensions have the shell showing, as the shell reads it
 * (src/lib/extensions/shown.ts; docs/primitives.md §4): which backdrop is in
 * force for a space, what it is in CSS — and that nothing of an extension's
 * reaches a style unchecked — which marks a tile carries, and the words the
 * page, the menu and the tile say.
 */

import { tabMarksFor } from "../src/lib/extensions/shown";
import { describe, expect, it } from "vitest";
import type { ExtensionBackdrop, ExtensionRow, ExtensionShown, ExtensionSiteView, ExtensionSpaceMark } from "@pistachio/shell-contracts/extensions";
import {
  backdropFor,
  backdropKey,
  backdropScrim,
  backdropStyle,
  bandPills,
  markLine,
  marksFor,
  marksLabel,
  removeBackdropLabel,
  removeRowsLabel,
  rowLabel,
  rowTone,
  scopeOf,
  sectionTitle,
  shownLine,
  siteViewsFor,
  themeJournalLine,
} from "../src/lib/extensions/shown";

const backdrop = (over: Partial<ExtensionBackdrop> = {}): ExtensionBackdrop => ({
  extensionId: "dev.me.game-day",
  extensionName: "Game day",
  spaceId: "football",
  value: { kind: "color", color: "#0b3d2e" },
  dim: 0,
  ...over,
});

const mark = (over: Partial<ExtensionSpaceMark> = {}): ExtensionSpaceMark => ({
  extensionId: "dev.me.game-day",
  extensionName: "Game day",
  spaceId: "football",
  glyph: "🏈",
  tone: "green",
  label: "Games on",
  ...over,
});

describe("the backdrop in force for a space", () => {
  const own = backdrop();
  const every = backdrop({ extensionId: "dev.me.paper", extensionName: "Paper", spaceId: null, value: { kind: "color", color: "#f4efe6" } });

  it("is the space's own, else the one for every space, else none", () => {
    expect(backdropFor([every, own], "football")).toBe(own);
    expect(backdropFor([every, own], "taxes")).toBe(every);
    expect(backdropFor([own], "taxes")).toBeNull();
    // (No space named yet, or a Home tab's: only the one for every space.)
    expect(backdropFor([every, own], null)).toBe(every);
    expect(backdropFor(undefined, "football")).toBeNull();
  });

  it("is the same picture under two spaces when it is the one for every space", () => {
    expect(backdropKey(backdropFor([every], "football"))).toBe(backdropKey(backdropFor([every], "taxes")));
    expect(backdropKey(own)).not.toBe(backdropKey(backdrop({ dim: 0.4 })));
    expect(backdropKey(null)).toBe("");
  });

  it("says its scope by the space's id, `*` for every space", () => {
    expect(scopeOf("football")).toBe("football");
    expect(scopeOf(null)).toBe("*");
  });
});

describe("a backdrop's value in CSS", () => {
  it("fills with a colour", () => {
    expect(backdropStyle({ kind: "color", color: "#0b3d2e" })).toEqual({ backgroundColor: "#0b3d2e" });
  });

  it("runs a gradient at its angle", () => {
    expect(backdropStyle({ kind: "gradient", colors: ["#0b3d2e", "#145c43", "#1f7a59"], angle: 135 })).toEqual({ backgroundImage: "linear-gradient(135deg, #0b3d2e, #145c43, #1f7a59)" });
  });

  it("covers the well with a picture, sits it whole in the middle, or repeats it", () => {
    const url = "pistachio-ext://theme/3f9a0c.svg";
    expect(backdropStyle({ kind: "image", url, fit: "cover" })).toEqual({ backgroundImage: `url("${url}")`, backgroundRepeat: "no-repeat", backgroundSize: "cover", backgroundPosition: "center" });
    expect(backdropStyle({ kind: "image", url, fit: "contain" })).toMatchObject({ backgroundRepeat: "no-repeat", backgroundSize: "contain", backgroundPosition: "center" });
    expect(backdropStyle({ kind: "image", url, fit: "tile" })).toMatchObject({ backgroundRepeat: "repeat", backgroundSize: "auto" });
  });

  it("paints nothing for what does not read as a value: no string reaches a style as it is", () => {
    expect(backdropStyle({ kind: "color", color: "red; background: url(https://evil.example/x)" })).toEqual({});
    expect(backdropStyle({ kind: "gradient", colors: ["#0b3d2e", "url(x)"], angle: 0 })).toEqual({});
    expect(backdropStyle({ kind: "gradient", colors: ["#0b3d2e"], angle: 0 })).toEqual({});
    // Only main's own theme store, never an extension's page, the web, or an address that closes the url().
    expect(backdropStyle({ kind: "image", url: "https://example.com/stadium.jpg", fit: "cover" })).toEqual({});
    expect(backdropStyle({ kind: "image", url: "pistachio-ext://dev.me.game-day/field.svg", fit: "cover" })).toEqual({});
    expect(backdropStyle({ kind: "image", url: 'pistachio-ext://theme/a.svg"); color: red; (', fit: "cover" })).toEqual({});
  });

  it("lays the shell's ground over it as far as dim says, never past the bound", () => {
    expect(backdropScrim(0)).toBeNull();
    expect(backdropScrim(0.35)).toBe("color-mix(in oklch, var(--color-background-200) 35%, transparent)");
    expect(backdropScrim(5)).toBe("color-mix(in oklch, var(--color-background-200) 80%, transparent)");
    expect(backdropScrim(Number.NaN)).toBeNull();
  });
});

describe("marks on a space's tile", () => {
  const other = mark({ extensionId: "dev.me.mail", extensionName: "Mail", glyph: "3", tone: "red", label: "3 unread" });
  const elsewhere = mark({ spaceId: "taxes", label: "Due Friday" });
  const order = [{ id: "dev.me.mail" }, { id: "dev.me.game-day" }];

  it("are the space's own, in the order the extensions stand in", () => {
    expect(marksFor([mark(), other, elsewhere], order, "football").map((entry) => entry.extensionId)).toEqual(["dev.me.mail", "dev.me.game-day"]);
    expect(marksFor([mark(), other, elsewhere], [], "football").map((entry) => entry.extensionId)).toEqual(["dev.me.game-day", "dev.me.mail"]);
    expect(marksFor(undefined, order, "football")).toEqual([]);
  });

  it("are said as the extension's, inside the shell's words", () => {
    expect(markLine(mark())).toBe("Game day: Games on");
    expect(marksLabel([other, mark()])).toBe(", Mail: 3 unread, Game day: Games on");
    expect(marksLabel([])).toBe("");
  });
});

describe("the rows a place shows", () => {
  const row = (over: Partial<ExtensionRow> = {}): ExtensionRow => ({ id: null, mark: null, text: "KC 21 – BUF 17", detail: "", value: "", buttons: [], ...over });
  const view = (over: Partial<ExtensionSiteView> = {}): ExtensionSiteView => ({ extensionId: "dev.me.game-day", extensionName: "Game day", site: "band", spaceId: null, title: null, rows: [row()], ...over });

  it("are an extension's own for the space, else the ones it set for every space — never both", () => {
    const every = view();
    const own = view({ spaceId: "football", rows: [row({ text: "Kickoff 1:00" })] });
    const mail = view({ extensionId: "dev.me.mail", extensionName: "Mail", rows: [row({ text: "3 unread" })] });
    expect(siteViewsFor([every, own, mail], "band", "football").map((kept) => kept.rows[0]?.text)).toEqual(["Kickoff 1:00", "3 unread"]);
    // (Whichever main listed first.)
    expect(siteViewsFor([own, every, mail], "band", "football").map((kept) => kept.rows[0]?.text)).toEqual(["Kickoff 1:00", "3 unread"]);
    expect(siteViewsFor([every, own, mail], "band", "taxes").map((kept) => kept.rows[0]?.text)).toEqual(["KC 21 – BUF 17", "3 unread"]);
    // Home has no space: only what was set for every space.
    expect(siteViewsFor([own, mail], "band", null).map((kept) => kept.extensionId)).toEqual(["dev.me.mail"]);
    // Each place its own.
    expect(siteViewsFor([every, own, mail], "sidebar", "football")).toEqual([]);
    expect(siteViewsFor(undefined, "band", "football")).toEqual([]);
  });

  it("are never more than a place has room for", () => {
    const many = Array.from({ length: 20 }, (_, index) => row({ text: `Row ${String(index)}` }));
    expect(siteViewsFor([view({ rows: many })], "band", null)[0]?.rows).toHaveLength(6);
    expect(siteViewsFor([view({ site: "sidebar", rows: many })], "sidebar", null)[0]?.rows).toHaveLength(12);
    const sections = Array.from({ length: 7 }, (_, index) => view({ site: "sidebar", extensionId: `dev.me.e${String(index)}` }));
    expect(siteViewsFor(sections, "sidebar", null).map((kept) => kept.extensionId)).toEqual(["dev.me.e0", "dev.me.e1", "dev.me.e2", "dev.me.e3"]);
    // A view with no rows is not one.
    expect(siteViewsFor([view({ rows: [] })], "band", null)).toEqual([]);
  });

  it("are said as the extension's, inside the shell's words", () => {
    expect(rowLabel("Game day", row({ detail: "3rd quarter", value: "4:12" }))).toBe("Game day: KC 21 – BUF 17, 3rd quarter, 4:12");
    expect(rowLabel("Game day", row({ detail: " " }))).toBe("Game day: KC 21 – BUF 17");
    expect(sectionTitle(view({ title: "Today’s games" }))).toBe("Today’s games");
    expect(sectionTitle(view())).toBe("Game day");
    expect(removeRowsLabel("band", "Game day")).toBe("Remove Game day’s strip");
    expect(removeRowsLabel("sidebar", "Game day")).toBe("Remove Game day’s section");
  });

  it("take only a tone the shell has a colour for", () => {
    expect(rowTone("red")).toBe("red");
    expect(rowTone("puce")).toBe("neutral");
    expect(rowTone(undefined)).toBe("neutral");
  });

  it("lie in the Bar's lane as chips, an extension's one after another", () => {
    const games = view({
      spaceId: "football",
      rows: [row({ id: "game:1", mark: { glyph: "🏈", tone: "green" }, detail: "3rd quarter", value: "4:12", buttons: [{ id: "open", title: "Open" }] }), row({ text: "DAL 3 – PHI 10" })],
    });
    const mail = view({ extensionId: "dev.me.mail", extensionName: "Mail", rows: [row({ text: "3 unread" })] });
    const pills = bandPills([games, mail], [{ id: "dev.me.game-day", iconUrl: "pistachio-ext://dev.me.game-day/icon.png" }]);
    expect(pills).toEqual([
      {
        id: "dev.me.game-day",
        name: "Game day",
        iconUrl: "pistachio-ext://dev.me.game-day/icon.png",
        text: "KC 21 – BUF 17",
        actions: [{ id: "open", title: "Open" }],
        row: { index: 0, scope: "football", id: "game:1", mark: { glyph: "🏈", tone: "green" }, detail: "3rd quarter", value: "4:12" },
      },
      { id: "dev.me.game-day", name: "Game day", iconUrl: "pistachio-ext://dev.me.game-day/icon.png", text: "DAL 3 – PHI 10", actions: [], row: { index: 1, scope: "football", id: null, mark: null, detail: "", value: "" } },
      { id: "dev.me.mail", name: "Mail", iconUrl: null, text: "3 unread", actions: [], row: { index: 0, scope: null, id: null, mark: null, detail: "", value: "" } },
    ]);
  });
});

describe("what the page and the menu say", () => {
  const shown = (over: Partial<ExtensionShown>): ExtensionShown => ({ what: "theme", spaceId: "football", space: "Football", detail: "Backdrop", ...over });

  it("lists a mark by its space and what it was called", () => {
    expect(shownLine(shown({ what: "mark", detail: "Games on" }))).toBe("Mark on “Football” · Games on");
    expect(shownLine(shown({ what: "mark", space: "", detail: "Games on" }))).toBe("Mark on a space · Games on");
  });

  it("lists a theme by what it is made of and where", () => {
    expect(shownLine(shown({}))).toBe("Backdrop on “Football”");
    expect(shownLine(shown({ detail: "Backdrop and accent", spaceId: null, space: "" }))).toBe("Backdrop and accent on every space");
    expect(shownLine(shown({ detail: "Accent", space: " " }))).toBe("Accent on a space");
  });

  it("lists rows by their place, where, and what they are by", () => {
    expect(shownLine(shown({ what: "band", spaceId: null, space: "", detail: "KC 21 – BUF 17" }))).toBe("Strip beside the Bar on every space · KC 21 – BUF 17");
    expect(shownLine(shown({ what: "sidebar", detail: "Today’s games" }))).toBe("Sidebar section on “Football” · Today’s games");
    expect(shownLine(shown({ what: "sidebar", detail: "" }))).toBe("Sidebar section on “Football”");
  });

  it("names whose backdrop the menu takes off", () => {
    expect(removeBackdropLabel(backdrop())).toBe("Remove backdrop · Game day");
  });

  it("says a theme set with nobody there", () => {
    expect(themeJournalLine({ spaceId: "football", title: "Football" })).toBe("Set a backdrop on “Football”");
    expect(themeJournalLine({ spaceId: "*", title: "" })).toBe("Set a backdrop on every space");
  });
});

describe("the marks on a tab's row", () => {
  const mark = (extensionId: string, tabId: string, label: string) => ({ extensionId, extensionName: extensionId === "dev.a" ? "Unread" : "Later", tabId, glyph: null, tone: "blue" as const, label });
  const marks = [mark("dev.b", "t1", "Read later"), mark("dev.a", "t1", "Not read yet"), mark("dev.a", "t2", "Not read yet")];

  it("are that tab's alone, in the order the person keeps their extensions: the row draws the first", () => {
    expect(tabMarksFor(marks, [{ id: "dev.a" }, { id: "dev.b" }], "t1").map((kept) => kept.label)).toEqual(["Not read yet", "Read later"]);
    expect(tabMarksFor(marks, [{ id: "dev.b" }, { id: "dev.a" }], "t1").map((kept) => kept.label)).toEqual(["Read later", "Not read yet"]);
    expect(tabMarksFor(marks, [], "t2").map((kept) => kept.label)).toEqual(["Not read yet"]);
    expect(tabMarksFor(marks, [], "t3")).toEqual([]);
    expect(tabMarksFor(undefined, [], "t1")).toEqual([]);
  });

  it("are listed on the Extensions page together, as main counted them", () => {
    expect(shownLine({ what: "tabMarks", spaceId: null, space: "", detail: "3 tabs · Not read yet" })).toBe("Marks on 3 tabs · Not read yet");
  });
});
