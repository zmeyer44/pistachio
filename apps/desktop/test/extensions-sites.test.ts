/**
 * The places an extension fills with rows (docs/primitives.md §4.5): what main keeps of the band and the sidebar
 * sections (../src/main/extensions/shown.ts), and the scope's rules for who may show rows where (scope.ts `sites`).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatch } from "../src/main/extensions/methods";
import { extSiteView, offersPress, sanitizeShown, SHOWN_FILE, ShownStore, shownRow, siteDetail, storedRow, type ShownHost, type StoredRow, type StoredSite } from "../src/main/extensions/shown";
import { EXTENSION_ID, harness, manifestOf, recordOf, tabOf } from "./extensions-harness";

const dir = (): string => mkdtempSync(join(tmpdir(), "pistachio-sites-"));
const row = (extra: Partial<StoredRow> = {}): StoredRow => ({ id: null, mark: null, text: "KC 21 – BUF 17", detail: "", value: "", buttons: [], ...extra });
const view = (extra: Partial<Omit<StoredSite, "at">> = {}): Omit<StoredSite, "at"> => ({ extensionId: "dev.a.one", site: "band", spaceId: null, title: null, rows: [row()], ...extra });

describe("what main keeps of the rows extensions show", () => {
  it("keeps one view an extension, a place and a scope, replaced whole, and reads it back", () => {
    const at = dir();
    const store = new ShownStore(at);
    expect(store.setSite(view(), 1)).toBe(true);
    // The same again changes nothing: a handler that says what should be so writes once.
    expect(store.setSite(view(), 2)).toBe(false);
    expect(store.setSite(view({ rows: [row({ value: "Q3" })] }), 3)).toBe(true);
    // Its section, its band for one space, and another extension's band all stand beside it.
    store.setSite(view({ site: "sidebar", title: "Today’s games" }), 4);
    store.setSite(view({ spaceId: "football", rows: [row({ text: "Kickoff 1:00" })] }), 5);
    store.setSite(view({ extensionId: "dev.b.two", rows: [row({ text: "Build green" })] }), 6);
    const read = new ShownStore(at);
    expect(read.sites().map((kept) => [kept.extensionId, kept.site, kept.spaceId, kept.rows[0]?.text])).toEqual([
      ["dev.a.one", "band", null, "KC 21 – BUF 17"],
      ["dev.a.one", "sidebar", null, "KC 21 – BUF 17"],
      ["dev.a.one", "band", "football", "Kickoff 1:00"],
      ["dev.b.two", "band", null, "Build green"],
    ]);
    expect(read.siteOf("dev.a.one", "band", null)?.rows[0]?.value).toBe("Q3");
    expect(read.siteOf("dev.a.one", "sidebar", "football")).toBeNull();
    expect(store.clearSite("dev.a.one", "band", null)).toBe(true);
    expect(store.clearSite("dev.a.one", "band", null)).toBe(false);
    // Gone with its extension: everything it showed.
    expect(store.forget("dev.a.one")).toBe(true);
    expect(store.sites().map((kept) => kept.extensionId)).toEqual(["dev.b.two"]);
  });

  it("reads a file back as rows it could have written: no markup, no breaks, nothing a press could not name", () => {
    const doc = sanitizeShown({
      version: 1,
      marks: [],
      themes: [],
      sites: [
        {
          extensionId: "dev.a.one",
          site: "sidebar",
          spaceId: null,
          title: "  Today\n ",
          rows: [
            { id: "game:1", text: "KC 21\n– BUF 17", detail: 7, value: "x".repeat(60), mark: { glyph: "🏈", tone: "puce" }, buttons: [{ id: "open", title: "Open" }, { id: "open", title: "Again" }, { id: "bad id", title: "No" }] },
            { id: "game:1", text: "A second row under the same id" },
            { text: "   " },
            "not a row",
          ],
        },
        // The same extension, place and scope again; a place there is none of; a scope that is no id.
        { extensionId: "dev.a.one", site: "sidebar", spaceId: null, rows: [{ text: "Twice" }] },
        { extensionId: "dev.a.one", site: "toolbar", spaceId: null, rows: [{ text: "Nowhere" }] },
        { extensionId: "dev.a.one", site: "band", spaceId: 7, rows: [{ text: "No scope" }] },
        { extensionId: "dev.a.one", site: "band", spaceId: null, rows: [] },
      ],
    });
    expect(doc.sites).toHaveLength(1);
    expect(doc.sites[0]).toMatchObject({ title: "Today", rows: [{ id: "game:1", text: "KC 21 – BUF 17", detail: "", value: "x".repeat(24), mark: { glyph: "🏈", tone: "neutral" }, buttons: [{ id: "open", title: "Open" }] }, { id: null, text: "A second row under the same id" }] });
    // A file from before there were rows reads as one with none.
    expect(sanitizeShown({ version: 1, marks: [], themes: [] }).sites).toEqual([]);
  });

  it("holds no more rows than a place has room for, however the file came by them", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ text: `Row ${String(index)}` }));
    const doc = sanitizeShown({ version: 1, marks: [], themes: [], sites: [{ extensionId: "dev.a.one", site: "band", spaceId: null, rows: many }, { extensionId: "dev.a.one", site: "sidebar", spaceId: null, rows: many }] });
    expect(doc.sites.map((kept) => kept.rows.length)).toEqual([6, 12]);
  });

  it("turns a row to main's and back, and to what the shell draws", () => {
    const given = { id: "game:1", mark: { tone: "red" as const }, text: "KC 21 – BUF 17", value: "Q3", buttons: [{ id: "open", title: "Open" }] };
    const kept = storedRow(given);
    expect(kept).toEqual({ id: "game:1", mark: { glyph: null, tone: "red" }, text: "KC 21 – BUF 17", detail: "", value: "Q3", buttons: [{ id: "open", title: "Open" }] });
    expect(shownRow(kept)).toEqual(kept);
    expect(extSiteView({ extensionId: "dev.a.one", site: "sidebar", spaceId: "football", title: "Games", rows: [kept, row()], at: 1 })).toEqual({ title: "Games", rows: [given, { text: "KC 21 – BUF 17" }], spaceId: "football" });
    expect(siteDetail({ title: "Games", rows: [kept] })).toBe("Games");
    expect(siteDetail({ title: null, rows: [kept] })).toBe("KC 21 – BUF 17");
  });

  it("answers a press only for what the kept rows offer", () => {
    const rows = [row({ id: "game:1", buttons: [{ id: "open", title: "Open" }] }), row({ buttons: [{ id: "refresh", title: "Refresh" }] }), row()];
    expect(offersPress({ rows }, "game:1", null)).toBe(true);
    expect(offersPress({ rows }, "game:1", "open")).toBe(true);
    // A button of a row with no id is named with a null row.
    expect(offersPress({ rows }, null, "refresh")).toBe(true);
    expect(offersPress({ rows }, "game:2", null)).toBe(false);
    expect(offersPress({ rows }, "game:1", "refresh")).toBe(false);
    expect(offersPress({ rows }, null, "open")).toBe(false);
    // A row with no id is not pressed.
    expect(offersPress({ rows }, null, null)).toBe(false);
  });

  it("writes its file whole", () => {
    const at = dir();
    new ShownStore(at).setSite(view(), 1);
    writeFileSync(join(at, `${SHOWN_FILE}.tmp`), "{");
    expect(new ShownStore(at).sites()).toHaveLength(1);
  });
});

/* ------------------------------- who may show rows where ------------------------------- */

const SPACE = "space-profile-a";

function setup(options: { manifest?: Record<string, unknown>; spaces?: string[] } = {}) {
  const store = new ShownStore(dir());
  let clock = 1;
  const shown: ShownHost = {
    setMark: (mark) => store.setMark(mark, clock++),
    clearMark: (extensionId, spaceId) => store.clearMark(extensionId, spaceId),
    setTabMark: (mark) => store.setTabMark(mark, clock++),
    clearTabMark: (extensionId, tabId) => store.clearTabMark(extensionId, tabId),
    setTheme: (next) => store.setTheme(next, clock++),
    clearTheme: (extensionId, spaceId) => store.clearTheme(extensionId, spaceId),
    themeOf: (extensionId, spaceId) => store.themeOf(extensionId, spaceId),
    setSite: (next) => store.setSite(next, clock++),
    clearSite: (extensionId, site, spaceId) => store.clearSite(extensionId, site, spaceId),
    siteOf: (extensionId, site, spaceId) => store.siteOf(extensionId, site, spaceId),
    adoptImage: () => {
      throw new Error("no pictures here");
    },
  };
  const h = harness({
    manifest: manifestOf(options.manifest ?? { band: true, sidebar: true, worker: { type: "web", main: "worker.js" }, triggers: [{ id: "sunday", during: { days: ["sun"], from: "08:00", to: "23:00" } }] }),
    record: recordOf({ capabilities: [] }, { spaces: options.spaces ?? [SPACE] }),
    tabs: [tabOf("t1", "https://espn.com/")],
    shown,
  });
  const call = (method: string, args: unknown = {}) => dispatch(method, args, h.scope, h.ctx(), h.runtime);
  return { h, store, call };
}

describe("an extension's rows in the band and the sidebar", () => {
  it("needs the place declared in the manifest, and says how", async () => {
    const { call, store } = setup({ manifest: { band: true, worker: { type: "web", main: "worker.js" } } });
    expect(await call("sites.set", { site: "band", rows: [{ text: "KC 21 – BUF 17" }] })).toEqual({ ok: true, v: null });
    for (const method of ["sites.set", "sites.clear", "sites.get"]) {
      const reply = await call(method, method === "sites.set" ? { site: "sidebar", rows: [{ text: "KC 21 – BUF 17" }] } : { site: "sidebar" });
      expect(reply, method).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
      if (!reply.ok) expect(reply.message).toContain('"sidebar": true');
    }
    expect(store.sites().map((kept) => kept.site)).toEqual(["band"]);
  });

  it("sets rows for every space, or for a space the person gave it — never one it was not given", async () => {
    const { call, store } = setup();
    const rows = [{ id: "game:1", mark: { glyph: "🏈", tone: "green" }, text: "KC 21 – BUF 17", detail: "3rd quarter", value: "4:12", buttons: [{ id: "open", title: "Open" }] }];
    expect(await call("sites.set", { site: "sidebar", title: " Today’s games ", rows, spaceId: SPACE })).toEqual({ ok: true, v: null });
    expect(store.siteOf(EXTENSION_ID, "sidebar", SPACE)).toMatchObject({ title: "Today’s games", rows: [{ id: "game:1", mark: { glyph: "🏈", tone: "green" }, detail: "3rd quarter", value: "4:12" }] });
    expect(await call("sites.get", { site: "sidebar", spaceId: SPACE })).toEqual({ ok: true, v: { title: "Today’s games", rows, spaceId: SPACE } });
    expect(await call("sites.set", { site: "band", rows: [{ text: "3 games on" }] })).toEqual({ ok: true, v: null });
    expect(store.siteOf(EXTENSION_ID, "band", null)?.rows[0]?.text).toBe("3 games on");
    for (const method of ["sites.set", "sites.clear", "sites.get"]) {
      const reply = await call(method, method === "sites.set" ? { site: "band", rows: [{ text: "Hi" }], spaceId: "someone-elses" } : { site: "band", spaceId: "someone-elses" });
      expect(reply, method).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
      if (!reply.ok) expect(reply.message).toContain("has not given this extension the space");
    }
    expect(store.siteOf(EXTENSION_ID, "band", "someone-elses")).toBeNull();
  });

  it("remembers a space the person ran it in, for an extension that only shows rows", () => {
    const { h } = setup({ spaces: [] });
    expect(h.scope.holdsSpace(SPACE)).toBe(false);
    h.scope.grantSpace(SPACE);
    expect(h.scope.holdsSpace(SPACE)).toBe(true);
    // One that declares no place and asks for nothing of a space is given none.
    const plain = setup({ manifest: {}, spaces: [] });
    plain.h.scope.grantSpace(SPACE);
    expect(plain.h.scope.holdsSpace(SPACE)).toBe(false);
  });

  it("refuses what the shell could not draw as a row, in words that say what to change", async () => {
    const { call, store } = setup();
    const refused = async (args: unknown, says: string): Promise<void> => {
      const reply = await call("sites.set", args);
      expect(reply, JSON.stringify(args)).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
      if (!reply.ok) expect(reply.message).toContain(says);
    };
    await refused({ site: "band", rows: Array.from({ length: 7 }, (_, index) => ({ text: `Game ${String(index)}` })) }, "the band holds 6 rows at most");
    await refused({ site: "sidebar", rows: [{ id: "a", text: "One" }, { id: "a", text: "Two" }] }, 'the row id "a" is used twice');
    await refused({ site: "band", rows: [{ text: "One", buttons: [{ id: "x", title: "X" }, { id: "x", title: "Y" }] }] }, 'the button id "x" is used twice');
    for (const bad of [
      { site: "band", rows: [{ text: "" }] },
      { site: "band", rows: [{ text: "a\nb" }] },
      { site: "band", rows: [{ text: "ok", html: "<b>no</b>" }] },
      { site: "band", rows: [{ text: "ok", id: "has space" }] },
      { site: "band", rows: [{ text: "ok", mark: { glyph: "abc" } }] },
      { site: "band", rows: [{ text: "ok", buttons: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }] }] },
      { site: "toolbar", rows: [{ text: "ok" }] },
      { site: "band", rows: [{ text: "x".repeat(81) }] },
    ]) {
      expect(await call("sites.set", bad), JSON.stringify(bad)).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    }
    expect(store.sites()).toEqual([]);
  });

  it("refuses rows that can be pressed in an extension with no worker to hear the press", async () => {
    const { call, store } = setup({ manifest: { band: true } });
    const reply = await call("sites.set", { site: "band", rows: [{ id: "game:1", text: "KC 21 – BUF 17" }] });
    expect(reply).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    if (!reply.ok) expect(reply.message).toContain("a press wakes the worker");
    // Rows that only say something need none.
    expect(await call("sites.set", { site: "band", rows: [{ text: "KC 21 – BUF 17" }] })).toEqual({ ok: true, v: null });
    expect(store.sites()).toHaveLength(1);
  });

  it("clears with no rows, and answers null once it holds none", async () => {
    const { call, store } = setup();
    await call("sites.set", { site: "band", rows: [{ text: "KC 21 – BUF 17" }] });
    expect(await call("sites.set", { site: "band", rows: [] })).toEqual({ ok: true, v: null });
    expect(store.sites()).toEqual([]);
    expect(await call("sites.get", { site: "band" })).toEqual({ ok: true, v: null });
    // Quiet when there is nothing to clear.
    expect(await call("sites.clear", { site: "band" })).toEqual({ ok: true, v: null });
  });

  it("is allowed with nobody there, and written in no journal: the rows say whose they are where they are", async () => {
    const { h, call, store } = setup();
    h.setNow(2_000_000);
    h.scope.beginInvocation(1, "profile-a", "trigger", "sunday");
    expect(h.scope.unattended()).toBe(true);
    expect(await call("sites.set", { site: "band", rows: [{ id: "game:1", text: "KC 21 – BUF 17" }] })).toEqual({ ok: true, v: null });
    expect(await call("sites.set", { site: "sidebar", rows: [{ text: "KC 21 – BUF 17" }], spaceId: SPACE })).toEqual({ ok: true, v: null });
    expect(await call("sites.get", { site: "band" })).toMatchObject({ ok: true });
    expect(await call("sites.clear", { site: "sidebar", spaceId: SPACE })).toEqual({ ok: true, v: null });
    expect(store.sites()).toHaveLength(1);
    expect(h.journal).toEqual([]);
    h.scope.endInvocation(1);
  });

  it("counts a press as the person's: what a trigger's handler may not do, its handler may", async () => {
    const { h, call } = setup({ manifest: { band: true, permissions: ["tabs:write"], worker: { type: "web", main: "worker.js" }, triggers: [{ id: "sunday", during: { days: ["sun"], from: "08:00", to: "23:00" } }] } });
    h.setNow(2_000_000);
    h.scope.beginInvocation(1, "profile-a", "trigger", "sunday");
    expect(h.scope.unattendedRefusal("tabs.close", "worker")).toContain("not for a trigger's handler");
    h.scope.beginInvocation(2, "profile-a", "press", "band");
    expect(h.scope.unattended()).toBe(false);
    expect(h.scope.unattendedRefusal("tabs.close", "worker")).toBeNull();
    h.scope.endInvocation(2);
    expect(h.scope.unattended()).toBe(true);
    void call;
  });
});
