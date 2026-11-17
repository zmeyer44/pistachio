/**
 * What extensions have the shell showing (docs/primitives.md §4): the store main keeps marks and themes in
 * (../src/main/extensions/shown.ts), the picture of a backdrop taken into main's keeping, and the scope's rules for
 * who may show what where (scope.ts `theme`, `spaces.setMark`).
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatch } from "../src/main/extensions/methods";
import {
  adoptThemeImage,
  backdropValue,
  extTheme,
  serveThemeRequest,
  SHOWN_FILE,
  ShownStore,
  sniffPicture,
  themeDetail,
  themeImageUrl,
  type ShownHost,
  type StoredTheme,
} from "../src/main/extensions/shown";
import { EXTENSION_ID, harness, manifestOf, recordOf, tabOf } from "./extensions-harness";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9" fill="#1f8a4c"/></svg>`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const dir = (): string => mkdtempSync(join(tmpdir(), "pistachio-shown-"));
const theme = (extra: Partial<Omit<StoredTheme, "at">> = {}): Omit<StoredTheme, "at"> => ({ extensionId: "dev.a.one", spaceId: "football", backdrop: { kind: "color", color: "#1f8a4c" }, accent: null, ...extra });

describe("what main keeps of what extensions show", () => {
  it("keeps one mark an extension a space, replaced whole, and reads it back", () => {
    const at = dir();
    const store = new ShownStore(at);
    expect(store.setMark({ extensionId: "dev.a.one", spaceId: "football", glyph: "🏈", tone: "green", label: "Games on" }, 1)).toBe(true);
    // The same again changes nothing.
    expect(store.setMark({ extensionId: "dev.a.one", spaceId: "football", glyph: "🏈", tone: "green", label: "Games on" }, 2)).toBe(false);
    expect(store.setMark({ extensionId: "dev.a.one", spaceId: "football", glyph: null, tone: "amber", label: "Kickoff soon" }, 3)).toBe(true);
    // Another extension's on the same space stands beside it.
    store.setMark({ extensionId: "dev.b.two", spaceId: "football", glyph: "3", tone: "blue", label: "3 unread" }, 4);
    expect(new ShownStore(at).marks()).toEqual([
      { extensionId: "dev.a.one", spaceId: "football", glyph: null, tone: "amber", label: "Kickoff soon", at: 3 },
      { extensionId: "dev.b.two", spaceId: "football", glyph: "3", tone: "blue", label: "3 unread", at: 4 },
    ]);
    expect(store.clearMark("dev.a.one", "football")).toBe(true);
    expect(store.clearMark("dev.a.one", "football")).toBe(false);
    expect(store.marks().map((mark) => mark.extensionId)).toEqual(["dev.b.two"]);
  });

  it("has one holder for each scope: a theme set there takes the place of whoever's was", () => {
    const store = new ShownStore(dir());
    expect(store.setTheme(theme(), 1)).toBe(true);
    expect(store.setTheme(theme(), 2)).toBe(false);
    expect(store.setTheme(theme({ spaceId: null, accent: "#1f8a4c", backdrop: null }), 3)).toBe(true);
    // Another's for the same space: the first's is gone, and says so when asked.
    expect(store.setTheme(theme({ extensionId: "dev.b.two", backdrop: { kind: "gradient", colors: ["#000000", "#ffffff"], angle: 90 } }), 4)).toBe(true);
    expect(store.themeOf("dev.a.one", "football")).toBeNull();
    expect(store.themeAt("football")?.extensionId).toBe("dev.b.two");
    // Its every-space one is its still.
    expect(store.themeOf("dev.a.one", null)?.accent).toBe("#1f8a4c");
    // Clearing what it does not hold takes nothing of another's.
    expect(store.clearTheme("dev.a.one", "football")).toBe(false);
    expect(store.themeAt("football")?.extensionId).toBe("dev.b.two");
  });

  it("forgets everything of an extension with it, and the pictures nothing names any more", () => {
    const at = dir();
    const store = new ShownStore(at);
    const root = dir();
    writeFileSync(join(root, "field.svg"), SVG);
    const file = adoptThemeImage(root, "field.svg", store.themeDir);
    store.setTheme(theme({ backdrop: { kind: "image", file, source: "field.svg", fit: "cover", dim: 0.2 } }), 1);
    store.setMark({ extensionId: "dev.a.one", spaceId: "football", glyph: null, tone: "neutral", label: "x" }, 1);
    expect(readdirSync(store.themeDir)).toEqual([file]);
    expect(store.forget("dev.a.one")).toBe(true);
    expect(store.forget("dev.a.one")).toBe(false);
    expect(store.marks()).toEqual([]);
    expect(store.themes()).toEqual([]);
    expect(readdirSync(store.themeDir)).toEqual([]);
  });

  it("reads a file it cannot make sense of as nothing, entry by entry", () => {
    const at = dir();
    writeFileSync(
      join(at, SHOWN_FILE),
      JSON.stringify({
        version: 1,
        marks: [{ extensionId: "a.b", spaceId: "s", label: "ok", tone: "plaid" }, { extensionId: "a.b", spaceId: "s", label: "twice" }, { spaceId: "s", label: "nobody's" }, "junk"],
        themes: [
          { extensionId: "a.b", spaceId: "s", backdrop: { kind: "color", color: "red" }, accent: null },
          { extensionId: "a.b", spaceId: null, backdrop: { kind: "image", file: "../../etc/passwd", fit: "cover" }, accent: "#1F8A4C" },
          { extensionId: "c.d", spaceId: null, backdrop: null, accent: "#000000" },
        ],
      }),
    );
    const store = new ShownStore(at);
    expect(store.marks()).toEqual([{ extensionId: "a.b", spaceId: "s", glyph: null, tone: "neutral", label: "ok", at: 0 }]);
    // A backdrop that is none and a picture that is no file of main's are dropped; the accent beside one is kept, and the scope has one holder.
    expect(store.themes()).toEqual([{ extensionId: "a.b", spaceId: null, backdrop: null, accent: "#1f8a4c", at: 0 }]);
  });

  it("says a theme as its extension set it, as the shell paints it, and as the page lists it", () => {
    const image: StoredTheme = { extensionId: "a.b", spaceId: "football", backdrop: { kind: "image", file: `${"a".repeat(32)}.svg`, source: "art/field.svg", fit: "tile", dim: 0.3 }, accent: "#1f8a4c", at: 1 };
    expect(extTheme(image)).toEqual({ backdrop: { image: "art/field.svg", fit: "tile", dim: 0.3 }, colors: { accent: "#1f8a4c" }, spaceId: "football" });
    expect(backdropValue(image.backdrop!)).toEqual({ value: { kind: "image", url: `pistachio-ext://theme/${"a".repeat(32)}.svg`, fit: "tile" }, dim: 0.3 });
    expect(backdropValue({ kind: "gradient", colors: ["#000000", "#ffffff"], angle: 45 })).toEqual({ value: { kind: "gradient", colors: ["#000000", "#ffffff"], angle: 45 }, dim: 0 });
    expect(extTheme({ extensionId: "a.b", spaceId: null, backdrop: null, accent: "#1f8a4c", at: 1 })).toEqual({ colors: { accent: "#1f8a4c" } });
    expect(themeDetail(image)).toBe("Backdrop and accent");
    expect(themeDetail({ backdrop: image.backdrop, accent: null })).toBe("Backdrop");
    expect(themeDetail({ backdrop: null, accent: "#1f8a4c" })).toBe("Accent");
  });
});

describe("a backdrop's picture, taken into main's keeping", () => {
  it("copies a picture of the folder under its hash, once, whatever it was called", () => {
    const root = dir();
    const kept = join(dir(), "theme");
    mkdirSync(join(root, "art"));
    writeFileSync(join(root, "art", "field.svg"), SVG);
    writeFileSync(join(root, "same.svg"), SVG);
    writeFileSync(join(root, "dot.png"), PNG);
    const file = adoptThemeImage(root, "art/field.svg", kept);
    expect(file).toMatch(/^[0-9a-f]{32}\.svg$/);
    expect(adoptThemeImage(root, "same.svg", kept)).toBe(file);
    expect(adoptThemeImage(root, "dot.png", kept)).toMatch(/\.png$/);
    expect(readdirSync(kept).sort()).toHaveLength(2);
    expect(themeImageUrl(file)).toBe(`pistachio-ext://theme/${file}`);
  });

  it("refuses what is not there, not a picture, not what its name says, too large, or outside the folder — in words", () => {
    const root = dir();
    const kept = join(dir(), "theme");
    const outside = dir();
    writeFileSync(join(outside, "secret.svg"), SVG);
    writeFileSync(join(root, "notes.svg"), "just some words");
    writeFileSync(join(root, "really.png"), SVG);
    writeFileSync(join(root, "huge.svg"), `${SVG}${" ".repeat(600 * 1024)}`);
    writeFileSync(join(root, "page.html"), "<html></html>");
    symlinkSync(join(outside, "secret.svg"), join(root, "link.svg"));
    const refusal = (path: string): string => {
      try {
        adoptThemeImage(root, path, kept);
      } catch (error) {
        expect((error as { code?: string }).code).toBe("INVALID_ARGUMENT");
        return (error as Error).message;
      }
      throw new Error(`${path} was taken`);
    };
    expect(refusal("missing.svg")).toContain('there is no "missing.svg"');
    expect(refusal("../secret.svg")).toContain("there is no");
    expect(refusal("link.svg")).toContain("there is no");
    expect(refusal("page.html")).toContain("not a picture a backdrop can be");
    expect(refusal("notes.svg")).toContain("not a .svg picture");
    expect(refusal("really.png")).toContain("a .svg");
    expect(refusal("huge.svg")).toContain("512 KB at most");
    expect(existsSync(kept)).toBe(false);
  });

  it("tells a picture by its first bytes", () => {
    expect(sniffPicture(PNG)).toBe("png");
    expect(sniffPicture(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(sniffPicture(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(sniffPicture(new TextEncoder().encode(`<?xml version="1.0"?>\n<!-- a field -->\n${SVG}`))).toBe("svg");
    expect(sniffPicture(new TextEncoder().encode("<html><svg></svg></html>"))).toBeNull();
    expect(sniffPicture(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull();
  });

  it("is served to the shell by its hashed name and nothing else", async () => {
    const root = dir();
    const kept = join(dir(), "theme");
    writeFileSync(join(root, "field.svg"), SVG);
    const file = adoptThemeImage(root, "field.svg", kept);
    const served = serveThemeRequest(new Request(`pistachio-ext://theme/${file}`), kept)!;
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/svg+xml");
    expect(served.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await served.text()).toBe(SVG);
    expect(serveThemeRequest(new Request("pistachio-ext://theme/../extension-shown.json"), kept)?.status).toBe(404);
    expect(serveThemeRequest(new Request(`pistachio-ext://theme/${"b".repeat(32)}.svg`), kept)?.status).toBe(404);
    // Any other host is an extension's own: not this handler's to answer.
    expect(serveThemeRequest(new Request("pistachio-ext://dev.a.one/icon.png"), kept)).toBeNull();
  });
});

/* ------------------------------- who may show what ------------------------------- */

const SPACE = "space-profile-a";

function setup(options: { capabilities?: string[]; spaces?: string[] } = {}) {
  const capabilities = options.capabilities ?? ["theme", "spaces:mark"];
  const store = new ShownStore(dir());
  const root = dir();
  writeFileSync(join(root, "field.svg"), SVG);
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
    adoptImage: (_extensionId, path) => adoptThemeImage(root, path, store.themeDir),
  };
  const h = harness({
    manifest: manifestOf({ permissions: capabilities, worker: { type: "web", main: "worker.js" }, triggers: [{ id: "sunday", during: { days: ["sun"], from: "08:00", to: "23:00" } }] }),
    record: recordOf({ capabilities }, { spaces: options.spaces ?? [SPACE] }),
    tabs: [tabOf("t1", "https://espn.com/")],
    shown,
  });
  const call = (method: string, args: unknown = {}) => dispatch(method, args, h.scope, h.ctx(), h.runtime);
  return { h, store, call };
}

describe("an extension's theme and marks", () => {
  it("needs the capability on the sheet", async () => {
    const { call, store } = setup({ capabilities: ["tabs:read"] });
    for (const [method, args, capability] of [
      ["theme.set", { backdrop: { color: "#1f8a4c" } }, "theme"],
      ["theme.clear", {}, "theme"],
      ["spaces.setMark", { spaceId: SPACE, mark: { label: "Games on" } }, "spaces:mark"],
    ] as const) {
      const reply = await call(method, args);
      expect(reply, method).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
      if (!reply.ok) expect(reply.message).toContain(`"${capability}"`);
    }
    expect(store.themes()).toEqual([]);
  });

  it("sets a theme for a space the person gave it, or for every space — never for a space it was not given", async () => {
    const { call, store } = setup();
    expect(await call("theme.set", { spaceId: SPACE, backdrop: { image: "field.svg", dim: 0.2 }, colors: { accent: "#1F8A4C" } })).toEqual({ ok: true, v: null });
    const [held] = store.themes();
    expect(held).toMatchObject({ extensionId: EXTENSION_ID, spaceId: SPACE, accent: "#1f8a4c", backdrop: { kind: "image", source: "field.svg", fit: "cover", dim: 0.2 } });
    expect(await call("theme.get", { spaceId: SPACE })).toEqual({ ok: true, v: { backdrop: { image: "field.svg", fit: "cover", dim: 0.2 }, colors: { accent: "#1f8a4c" }, spaceId: SPACE } });
    // Every space: the capability alone.
    expect(await call("theme.set", { backdrop: { gradient: { colors: ["#0b3d2e", "#145c43"] } } })).toEqual({ ok: true, v: null });
    expect(store.themeAt(null)?.backdrop).toEqual({ kind: "gradient", colors: ["#0b3d2e", "#145c43"], angle: 180 });
    const reply = await call("theme.set", { spaceId: "someone-elses", backdrop: { color: "#1f8a4c" } });
    expect(reply).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    if (!reply.ok) expect(reply.message).toContain('"space" context');
    expect(store.themeAt("someone-elses")).toBeNull();
  });

  it("refuses an accent that would not show, a picture that is none, and a shape the API has not", async () => {
    const { call, store } = setup();
    const light = await call("theme.set", { colors: { accent: "#ffff66" } });
    expect(light).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    if (!light.ok) expect(light.message).toContain("too light");
    const missing = await call("theme.set", { backdrop: { image: "stadium.jpg" } });
    expect(missing).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    if (!missing.ok) expect(missing.message).toContain('there is no "stadium.jpg"');
    for (const bad of [{ backdrop: { color: "green" } }, { backdrop: { image: "../field.svg" } }, { backdrop: { gradient: { colors: ["#000000"] } } }, { backdrop: { url: "https://example.com/a.png" } }, { colors: { ink: "#000000" } }]) {
      expect(await call("theme.set", bad), JSON.stringify(bad)).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    }
    expect(store.themes()).toEqual([]);
  });

  it("clears with a theme of nothing, and answers null once it holds none", async () => {
    const { call, store } = setup();
    await call("theme.set", { spaceId: SPACE, backdrop: { color: "#1f8a4c" } });
    expect(await call("theme.set", { spaceId: SPACE, backdrop: null })).toEqual({ ok: true, v: null });
    expect(store.themes()).toEqual([]);
    expect(await call("theme.get", { spaceId: SPACE })).toEqual({ ok: true, v: null });
    // Quiet when there is nothing to clear.
    expect(await call("theme.clear", { spaceId: SPACE })).toEqual({ ok: true, v: null });
    // Another's in its place: its own is gone, as far as it can tell.
    await call("theme.set", { backdrop: { color: "#1f8a4c" } });
    store.setTheme({ extensionId: "dev.other.one", spaceId: null, backdrop: { kind: "color", color: "#333333" }, accent: null }, 99);
    expect(await call("theme.get", {})).toEqual({ ok: true, v: null });
    await call("theme.clear", {});
    expect(store.themeAt(null)?.extensionId).toBe("dev.other.one");
  });

  it("writes a theme set with nobody there in the journal — once, when it changed something", async () => {
    const { h, call } = setup();
    // The person's own command: nothing written.
    h.scope.beginInvocation(1, "profile-a", "menu", "here");
    await call("theme.set", { spaceId: SPACE, backdrop: { color: "#1f8a4c" } });
    h.scope.endInvocation(1);
    expect(h.journal).toEqual([]);
    h.setNow(2_000_000);
    h.scope.beginInvocation(2, "profile-a", "trigger", "sunday");
    // The same again, from the trigger: nothing changed, nothing written.
    expect(await call("theme.set", { spaceId: SPACE, backdrop: { color: "#1f8a4c" } })).toEqual({ ok: true, v: null });
    expect(h.journal).toEqual([]);
    await call("theme.set", { spaceId: SPACE, backdrop: { image: "field.svg" } });
    await call("theme.set", { backdrop: { color: "#0b3d2e" } });
    expect(h.journal).toEqual([
      { trigger: "sunday", verb: "setTheme", spaceId: SPACE, title: "Work" },
      { trigger: "sunday", verb: "setTheme", spaceId: "*", title: "" },
    ]);
    // Clearing and marking are not written: each is its own way back, and says whose it is where it is.
    await call("theme.clear", { spaceId: SPACE });
    await call("spaces.setMark", { spaceId: SPACE, mark: { glyph: "🏈", tone: "green", label: "Games on" } });
    expect(h.journal).toHaveLength(2);
  });

  it("marks a space the person gave it, one mark, and takes it off with null", async () => {
    const { call, store } = setup();
    expect(await call("spaces.setMark", { spaceId: SPACE, mark: { glyph: "🏈", tone: "green", label: "  Games\non " } })).toEqual({ ok: true, v: null });
    expect(store.marks()).toEqual([{ extensionId: EXTENSION_ID, spaceId: SPACE, glyph: "🏈", tone: "green", label: "Games on", at: 1 }]);
    expect(await call("spaces.setMark", { spaceId: SPACE, mark: { label: "Kickoff soon" } })).toEqual({ ok: true, v: null });
    expect(store.marks()).toMatchObject([{ glyph: null, tone: "neutral", label: "Kickoff soon" }]);
    expect(await call("spaces.setMark", { spaceId: "someone-elses", mark: { label: "x" } })).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    for (const bad of [{ glyph: "abc", label: "x" }, { label: "" }, { tone: "plaid", label: "x" }, { label: "x".repeat(61) }]) {
      expect(await call("spaces.setMark", { spaceId: SPACE, mark: bad }), JSON.stringify(bad)).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    }
    expect(await call("spaces.setMark", { spaceId: SPACE, mark: null })).toEqual({ ok: true, v: null });
    expect(store.marks()).toEqual([]);
  });

  it("is given a space for a mark or a backdrop alone: no need of the power to send it away", () => {
    const { h } = setup({ capabilities: ["spaces:mark"], spaces: [] });
    h.scope.grantSpace(SPACE);
    expect(h.scope.holdsSpace(SPACE)).toBe(true);
    const none = setup({ capabilities: ["tabs:read"], spaces: [] });
    none.h.scope.grantSpace(SPACE);
    expect(none.h.scope.holdsSpace(SPACE)).toBe(false);
  });
});
