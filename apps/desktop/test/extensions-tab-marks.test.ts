/**
 * A mark on a tab's row (docs/primitives.md §4.7, stage 4b): a value main
 * keeps by the tab's id and the shell draws — one an extension a tab, on any
 * tab the extension could see, gone when the tab closes and when the person
 * says so.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CAPABILITY_INFO } from "@pistachio/extension-api/capabilities";
import { runsLimit } from "@pistachio/extension-api/sheet";
import { EXT_METHOD_NAMES, EXT_RATE_LIMITS, EXT_UNATTENDED_METHODS } from "@pistachio/extension-api/wire";
import { dispatch } from "../src/main/extensions/methods";
import { MAX_TAB_MARKS_PER_EXTENSION, SHOWN_FILE, ShownStore, type ShownHost } from "../src/main/extensions/shown";
import { EXTENSION_ID, harness, manifestOf, recordOf, tabOf } from "./extensions-harness";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function dir(): string {
  const made = mkdtempSync(join(tmpdir(), "pistachio-tab-marks-"));
  dirs.push(made);
  return made;
}

const UNREAD = { extensionId: EXTENSION_ID, tabId: "t1", glyph: null, tone: "blue" as const, label: "Not read yet" };

describe("the marks main keeps on tabs", () => {
  it("keeps one an extension a tab, replaced whole, and says whether anything changed", () => {
    const store = new ShownStore(dir());
    expect(store.hasTabMarks).toBe(false);
    expect(store.setTabMark(UNREAD, 1)).toBe(true);
    expect(store.setTabMark(UNREAD, 2)).toBe(false);
    expect(store.setTabMark({ ...UNREAD, label: "Read later" }, 3)).toBe(true);
    expect(store.setTabMark({ ...UNREAD, extensionId: "dev.other" }, 4)).toBe(true);
    expect(store.tabMarks().map((mark) => [mark.extensionId, mark.tabId, mark.label])).toEqual([[EXTENSION_ID, "t1", "Read later"], ["dev.other", "t1", "Not read yet"]]);
    expect(store.hasTabMarks).toBe(true);
  });

  it("is there after a restart, read back through the same bounds", () => {
    const folder = dir();
    new ShownStore(folder).setTabMark({ ...UNREAD, glyph: "•" }, 1);
    expect(new ShownStore(folder).tabMarks()).toEqual([{ ...UNREAD, glyph: "•", at: 1 }]);
    const raw = JSON.parse(readFileSync(join(folder, SHOWN_FILE), "utf8")) as { tabMarks: unknown[] };
    raw.tabMarks.push({ ...UNREAD, tabId: "t2", tone: "sparkly" }, { ...UNREAD, tabId: "t3", label: "" }, { ...UNREAD }, "junk");
    writeFileSync(join(folder, SHOWN_FILE), JSON.stringify(raw));
    // A tone it does not know is neutral; a mark with no label, a second for the same tab and junk are dropped.
    expect(new ShownStore(folder).tabMarks().map((mark) => [mark.tabId, mark.tone])).toEqual([["t1", "blue"], ["t2", "neutral"]]);
  });

  it("takes one off, takes all of an extension's off, and forgets them with the extension", () => {
    const store = new ShownStore(dir());
    for (const tabId of ["t1", "t2", "t3"]) store.setTabMark({ ...UNREAD, tabId }, 1);
    store.setTabMark({ ...UNREAD, extensionId: "dev.other" }, 1);
    expect(store.clearTabMark(EXTENSION_ID, "t2")).toBe(true);
    expect(store.clearTabMark(EXTENSION_ID, "t2")).toBe(false);
    expect(store.clearTabMark(EXTENSION_ID, null)).toBe(true);
    expect(store.tabMarks().map((mark) => mark.extensionId)).toEqual(["dev.other"]);
    expect(store.forget("dev.other")).toBe(true);
    expect(store.tabMarks()).toEqual([]);
  });

  it("drops the marks of tabs that closed, whoever made them, and nothing else", () => {
    const store = new ShownStore(dir());
    for (const tabId of ["t1", "t2"]) store.setTabMark({ ...UNREAD, tabId }, 1);
    store.setTabMark({ ...UNREAD, extensionId: "dev.other", tabId: "t1" }, 1);
    expect(store.dropTabs(["t1", "never-marked"])).toBe(true);
    expect(store.tabMarks().map((mark) => mark.tabId)).toEqual(["t2"]);
    expect(store.dropTabs(["t1"])).toBe(false);
    expect(store.dropTabs([])).toBe(false);
  });

  it("keeps an extension's newest two hundred: the oldest goes", () => {
    const store = new ShownStore(dir());
    for (let index = 0; index <= MAX_TAB_MARKS_PER_EXTENSION; index += 1) store.setTabMark({ ...UNREAD, tabId: `t${String(index)}` }, index + 1);
    const kept = store.tabMarks();
    expect(kept).toHaveLength(MAX_TAB_MARKS_PER_EXTENSION);
    expect(kept.some((mark) => mark.tabId === "t0")).toBe(false);
    expect(kept.some((mark) => mark.tabId === `t${String(MAX_TAB_MARKS_PER_EXTENSION)}`)).toBe(true);
  });
});

function setup(options: { capabilities?: string[]; profiles?: "all" | string[] } = {}) {
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
    setSite: (view) => store.setSite(view, clock++),
    clearSite: (extensionId, site, spaceId) => store.clearSite(extensionId, site, spaceId),
    siteOf: (extensionId, site, spaceId) => store.siteOf(extensionId, site, spaceId),
    adoptImage: () => {
      throw new Error("no pictures here");
    },
  };
  const capabilities = options.capabilities ?? ["tabs:mark"];
  const h = harness({
    manifest: manifestOf({ permissions: capabilities, worker: { type: "web", main: "worker.js" }, triggers: [{ id: "opened", on: { tab: "opened" } }] }),
    record: recordOf({ capabilities }, options.profiles === undefined ? {} : { profiles: options.profiles }),
    tabs: [tabOf("t1", "https://espn.com/"), tabOf("t2", "https://example.com/", "profile-b"), tabOf("hidden", "https://agent.example/", "profile-a", { hiddenFor: "run-1" })],
    shown,
  });
  const call = (method: string, args: unknown = {}) => dispatch(method, args, h.scope, h.ctx("worker"), h.runtime);
  return { h, store, call };
}

describe("marking a tab, from an extension", () => {
  it("needs its own capability, on a Low line", async () => {
    const { call, store } = setup({ capabilities: ["tabs:read"] });
    const reply = await call("tabs.setMark", { tabId: "t1", mark: { label: "Not read yet" } });
    expect(reply).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    if (!reply.ok) expect(reply.message).toContain("tabs:mark");
    expect(store.tabMarks()).toEqual([]);
    expect(CAPABILITY_INFO["tabs:mark"]).toEqual({ tier: "low", line: "Puts a small mark on your tabs." });
  });

  it("marks any tab it could see — nobody had to run it there — as a dot or a glyph in a tone", async () => {
    const { call, store } = setup();
    expect(await call("tabs.setMark", { tabId: "t1", mark: { label: "Not read yet", tone: "blue" } })).toEqual({ ok: true, v: null });
    expect(store.tabMarks()).toEqual([{ extensionId: EXTENSION_ID, tabId: "t1", glyph: null, tone: "blue", label: "Not read yet", at: 1 }]);
    expect(await call("tabs.setMark", { tabId: "t1", mark: { glyph: "3", label: " Three new\nreplies " } })).toEqual({ ok: true, v: null });
    expect(store.tabMarks()[0]).toMatchObject({ glyph: "3", tone: "neutral", label: "Three new replies" });
  });

  it("is refused a tab it could not see: an agent's hidden one, one in a Profile it is off in, one that is not there", async () => {
    const { call, store } = setup({ profiles: ["profile-a"] });
    for (const tabId of ["hidden", "t2", "nowhere"]) {
      expect(await call("tabs.setMark", { tabId, mark: { label: "Not read yet" } }), tabId).toMatchObject({ ok: false, code: "NOT_FOUND" });
    }
    expect(store.tabMarks()).toEqual([]);
  });

  it("refuses a mark that says nothing, or more than a mark can", async () => {
    const { call } = setup();
    for (const mark of [{ label: "   " }, { label: "" }, { label: "x".repeat(61) }, { label: "ok", glyph: "three" }, { label: "ok", tone: "sparkly" }, { label: "ok", url: "https://x" }]) {
      expect(await call("tabs.setMark", { tabId: "t1", mark }), JSON.stringify(mark).slice(0, 30)).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    }
  });

  it("takes its mark off quietly — even off a tab that has gone: a handler says what should be so", async () => {
    const { call, store } = setup();
    await call("tabs.setMark", { tabId: "t1", mark: { label: "Not read yet" } });
    expect(await call("tabs.setMark", { tabId: "t1", mark: null })).toEqual({ ok: true, v: null });
    expect(await call("tabs.setMark", { tabId: "t1", mark: null })).toEqual({ ok: true, v: null });
    expect(await call("tabs.setMark", { tabId: "closed-long-ago", mark: null })).toEqual({ ok: true, v: null });
    expect(store.tabMarks()).toEqual([]);
  });

  it("is allowed with nobody there, and not written down: it says whose it is where it is", async () => {
    const { h, call } = setup();
    expect(EXT_METHOD_NAMES).toContain("tabs.setMark");
    expect(EXT_UNATTENDED_METHODS).toContain("tabs.setMark");
    expect(EXT_RATE_LIMITS["tabs.setMark"]).toBe(240);
    h.scope.beginInvocation(1, "profile-a", "trigger", "opened");
    expect(await call("tabs.setMark", { tabId: "t1", mark: { label: "Not read yet" } })).toEqual({ ok: true, v: null });
    expect(h.journal).toEqual([]);
    expect(runsLimit({ permissions: ["tabs:mark"] })).toBe("With nobody there it can only update what it shows.");
  });
});
