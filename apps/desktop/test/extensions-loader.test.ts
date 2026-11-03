import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundledExtensionsDir, extensionIconUrl, listExtensionFolders, loadExtensionFolder } from "../src/main/extensions/loader";
import { extensionDataDir, writableInside } from "../src/main/extensions/paths";

const FIXTURE = fileURLToPath(new URL("./fixtures/extensions/minimal", import.meta.url));

/** A copy of the fixture to break. */
function copy(): string {
  const root = join(mkdtempSync(join(tmpdir(), "pistachio-ext-loader-")), "minimal");
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

describe("loading an extension's folder", () => {
  it("loads the fixture: manifest, sheet, icon address", () => {
    const result = loadExtensionFolder(FIXTURE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.id).toBe("dev.test.minimal");
    expect(result.iconUrl).toBe("pistachio-ext://dev.test.minimal/icon.svg");
    expect(result.sheet.adds).toContain("/hello in the Bar");
    expect(result.sheet.can.map((line) => line.text)).toEqual(expect.arrayContaining(["Sees the titles and addresses of your tabs.", "Talks to api.example.com."]));
    expect(result.sheet.manifestHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("says what is wrong, in words, with the id when it can read one", () => {
    const missing = copy();
    rmSync(join(missing, "panel.html"));
    const noPanel = loadExtensionFolder(missing);
    expect(noPanel).toMatchObject({ ok: false, id: "dev.test.minimal" });
    if (!noPanel.ok) expect(noPanel.error).toMatch(/"panel.html" is named in pistachio.json but is not a file/);

    const broken = copy();
    writeFileSync(join(broken, "pistachio.json"), "{ nope");
    const notJson = loadExtensionFolder(broken);
    expect(notJson).toMatchObject({ ok: false, id: null });
    if (!notJson.ok) expect(notJson.error).toMatch(/not valid JSON/);

    const later = copy();
    writeFileSync(join(later, "pistachio.json"), JSON.stringify({ api: 3, id: "dev.test.later", name: "Later", version: "1.0.0" }));
    const api = loadExtensionFolder(later);
    if (!api.ok) expect(api.error).toMatch(/api 1, and this one says api 3/);

    const empty = mkdtempSync(join(tmpdir(), "pistachio-ext-empty-"));
    const none = loadExtensionFolder(empty);
    if (!none.ok) expect(none.error).toMatch(/no pistachio.json/);
  });

  it("keeps no id from a manifest whose id is not one: '..' would name a folder that is not the extension's", () => {
    const root = mkdtempSync(join(tmpdir(), "pistachio-loader-"));
    writeFileSync(join(root, "pistachio.json"), JSON.stringify({ api: 1, id: "..", name: "Up", version: "1.0.0" }));
    const result = loadExtensionFolder(root);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.id).toBeNull();
    writeFileSync(join(root, "pistachio.json"), JSON.stringify({ api: 1, id: "dev.me.up", name: 7 }));
    const named = loadExtensionFolder(root);
    expect(named.ok ? null : named.id).toBe("dev.me.up");
    expect(() => extensionDataDir("/u", "..")).toThrow(/not an extension's id/);
    expect(() => extensionDataDir("/u", "dev/../../x")).toThrow();
    expect(extensionDataDir("/u", "dev.me.up")).toBe("/u/ExtensionData/dev.me.up");
  });

  it("refuses a write through a link to nowhere, as through a link out, and allows a file not yet there", () => {
    const root = mkdtempSync(join(tmpdir(), "pistachio-paths-"));
    symlinkSync("/nowhere/at/all/outside.bin", join(root, "dangling.bin"));
    expect(writableInside(root, "dangling.bin")).toBeNull();
    mkdirSync(join(root, "sub"));
    symlinkSync("/nowhere/at/all/dir", join(root, "sub", "away"));
    expect(writableInside(root, "sub/away/file.bin")).toBeNull();
    expect(writableInside(root, "fresh.bin")).toBe(join(root, "fresh.bin"));
    expect(writableInside(root, "deep/er/fresh.bin")).toBe(join(root, "deep/er/fresh.bin"));
  });

  it("refuses a named file that is a link out of the folder", () => {
    const root = copy();
    const outside = join(mkdtempSync(join(tmpdir(), "pistachio-ext-outside-")), "secret.html");
    writeFileSync(outside, "<p>not yours</p>");
    rmSync(join(root, "panel.html"));
    symlinkSync(outside, join(root, "panel.html"));
    const result = loadExtensionFolder(root);
    expect(result.ok).toBe(false);
  });

  it("finds the bundled set where the app keeps it, and an absent folder is an empty set", () => {
    // In dev the build step writes out/extensions (scripts/build-extensions.mjs).
    expect(bundledExtensionsDir({ isPackaged: false, appPath: "/repo/apps/desktop", resourcesPath: "/x" })).toBe("/repo/apps/desktop/out/extensions");
    expect(bundledExtensionsDir({ isPackaged: true, appPath: "/x", resourcesPath: "/App/Contents/Resources" })).toBe("/App/Contents/Resources/extensions");
    expect(listExtensionFolders("/no/such/folder")).toEqual([]);
    const parent = mkdtempSync(join(tmpdir(), "pistachio-ext-bundled-"));
    cpSync(FIXTURE, join(parent, "minimal"), { recursive: true });
    mkdirSync(join(parent, "not-one"));
    mkdirSync(join(parent, ".hidden"));
    expect(listExtensionFolders(parent)).toEqual([join(parent, "minimal")]);
  });

  it("spells an icon's address per path segment", () => {
    expect(extensionIconUrl({ id: "a.b", icon: "icons/my icon.svg" })).toBe("pistachio-ext://a.b/icons/my%20icon.svg");
    expect(extensionIconUrl({ id: "a.b" })).toBeNull();
  });
});
