import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadExtensionFolder } from "../src/main/extensions/loader";
import { contentTypeFor, EXTENSION_CSP, fileInside, parseRange, serveExtensionRequest, serveIconRequest, workerHtml, type ExtensionFolders } from "../src/main/extensions/protocol";
import { resolveInside } from "../src/main/extensions/paths";

const FIXTURE = fileURLToPath(new URL("./fixtures/extensions/minimal", import.meta.url));
const ID = "dev.test.minimal";

describe("Range", () => {
  it("reads the ranges a <video> asks for", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=90-200", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=20-10", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
  });
});

describe("paths in a folder", () => {
  it("refuses .. and absolute paths by their spelling", () => {
    expect(resolveInside("/ext", "a/b.js")).toBe("/ext/a/b.js");
    expect(resolveInside("/ext", "/a/b.js")).toBe("/ext/a/b.js");
    expect(resolveInside("/ext", "../etc/passwd")).toBeNull();
    expect(resolveInside("/ext", "a/../../x")).toBeNull();
    expect(resolveInside("/ext", "a\0b")).toBeNull();
  });

  it("serves files inside, never a link out, a folder, or .pistachio/", () => {
    const root = mkdtempSync(join(tmpdir(), "pistachio-ext-protocol-"));
    writeFileSync(join(root, "panel.html"), "<p>hi</p>");
    mkdirSync(join(root, ".pistachio"));
    writeFileSync(join(root, ".pistachio", "status.json"), "{}");
    const outside = join(mkdtempSync(join(tmpdir(), "pistachio-ext-outside-")), "secret.txt");
    writeFileSync(outside, "not yours");
    symlinkSync(outside, join(root, "secret.txt"));
    expect(fileInside(root, "/panel.html")?.size).toBe(9);
    expect(fileInside(root, "/secret.txt")).toBeNull();
    expect(fileInside(root, "/..%2F..%2Fetc%2Fpasswd")).toBeNull();
    expect(fileInside(root, "/.pistachio/status.json")).toBeNull();
    expect(fileInside(root, "/")).toBeNull();
    expect(fileInside(root, "/%E0%A4%A")).toBeNull();
  });
});

describe("serving an extension", () => {
  const loaded = loadExtensionFolder(FIXTURE);
  if (!loaded.ok) throw new Error(loaded.error);
  const data = mkdtempSync(join(tmpdir(), "pistachio-ext-data-"));
  writeFileSync(join(data, "clip.mp4"), Buffer.alloc(1000, 7));
  const folders = (state: "on" | "off" = "on"): ExtensionFolders => ({
    folder: (id) => (id !== ID ? null : state === "off" ? { off: "Minimal" } : { root: FIXTURE, manifest: loaded.manifest, name: "Minimal" }),
    dataFolder: (id) => (id === ID ? data : null),
  });
  const get = (path: string, init: RequestInit = {}, state: "on" | "off" = "on") => serveExtensionRequest(new Request(`pistachio-ext://${ID}${path}`, init), ID, folders(state));

  it("serves the folder with the extension CSP", async () => {
    const response = get("/panel.html");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(EXTENSION_CSP);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toContain("Minimal's panel");
  });

  it("serves .ts as JavaScript with its types stripped", async () => {
    const response = get("/page.ts");
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const code = await response.text();
    expect(code).toContain("export function greet(name");
    expect(code).not.toContain(": string");
  });

  it("answers the worker page and nothing of another extension", async () => {
    expect(await get("/__pistachio__/worker.html").text()).toBe(workerHtml("worker.js"));
    expect(workerHtml("src/my worker.ts")).toContain('src="/src/my%20worker.ts"');
    expect(serveExtensionRequest(new Request("pistachio-ext://dev.other.ext/panel.html"), ID, folders()).status).toBe(404);
    expect(get("/pistachio.json/../../etc/passwd").status).toBe(404);
    expect(get("/panel.html", { method: "POST", body: "x" }).status).toBe(405);
  });

  it("serves data with Range: 206 and the bytes asked for", async () => {
    const whole = get("/__data__/clip.mp4");
    expect(whole.status).toBe(200);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect((await whole.arrayBuffer()).byteLength).toBe(1000);
    const part = get("/__data__/clip.mp4", { headers: { range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect(part.headers.get("content-type")).toBe("video/mp4");
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    expect(get("/__data__/clip.mp4", { headers: { range: "bytes=5000-" } }).status).toBe(416);
    expect(get("/__data__/../storage.json").status).toBe(404);
  });

  it("shows an off extension's page as off, running none of it", async () => {
    const response = get("/page.html", {}, "off");
    expect(await response.text()).toContain("This extension is off.");
    expect(get("/worker.js", {}, "off").status).toBe(404);
  });

  it("answers the default session's icons only", async () => {
    const icon = (path: string) => serveIconRequest(new Request(`pistachio-ext://${ID}${path}`), (id) => (id === ID ? { root: FIXTURE, icon: "icon.svg" } : null));
    expect(icon("/icon.svg").status).toBe(200);
    expect(icon("/icon.svg").headers.get("content-type")).toBe("image/svg+xml");
    expect(icon("/panel.html").status).toBe(404);
    expect(icon("/worker.js").status).toBe(404);
  });

  it("names content types", () => {
    expect(contentTypeFor("a.wasm")).toBe("application/wasm");
    expect(contentTypeFor("a.unknown")).toBe("application/octet-stream");
  });
});
