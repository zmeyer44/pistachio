import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatch } from "../src/main/extensions/methods";
import { STORAGE_MAX_BYTES } from "../src/main/extensions/storage";
import { harness, manifestOf, recordOf } from "./extensions-harness";

const SETTINGS = [
  { key: "greeting", title: "Greeting", type: "string", default: "Hello" },
  { key: "fps", title: "Frame rate", type: "enum", options: ["30", "60"], default: "60" },
  { key: "token", title: "Token", type: "secret" },
];

describe("storage", () => {
  it("sets, gets and removes, and says what changed", async () => {
    const h = harness();
    expect(await dispatch("storage.set", { items: { a: 1, b: { c: [true, null] } } }, h.scope, h.ctx(), h.runtime)).toEqual({ ok: true, v: null });
    expect(h.runtime.storageChanged).toHaveBeenCalledWith({ a: { newValue: 1 }, b: { newValue: { c: [true, null] } } });
    expect(await dispatch("storage.get", { keys: ["a", "zz"] }, h.scope, h.ctx("page"), h.runtime)).toEqual({ ok: true, v: { a: 1 } });
    expect(await dispatch("storage.get", { keys: null }, h.scope, h.ctx("panel"), h.runtime)).toEqual({ ok: true, v: { a: 1, b: { c: [true, null] } } });
    await dispatch("storage.remove", { keys: ["a"] }, h.scope, h.ctx(), h.runtime);
    expect(h.runtime.storageChanged).toHaveBeenLastCalledWith({ a: { oldValue: 1 } });
    expect(await dispatch("storage.get", { keys: null }, h.scope, h.ctx(), h.runtime)).toEqual({ ok: true, v: { b: { c: [true, null] } } });
  });

  it("refuses a write past 5 MB, whole", async () => {
    const h = harness();
    const reply = await dispatch("storage.set", { items: { big: "x".repeat(STORAGE_MAX_BYTES), small: 1 } }, h.scope, h.ctx(), h.runtime);
    expect(reply).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    expect(await dispatch("storage.get", { keys: null }, h.scope, h.ctx(), h.runtime)).toEqual({ ok: true, v: {} });
  });

  it("takes JSON only", async () => {
    const h = harness();
    expect(await dispatch("storage.set", { items: { f: () => 1 } }, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
  });
});

describe("settings.get", () => {
  const manifest = manifestOf({ settings: SETTINGS });

  it("answers declared values over their defaults, and a secret in the worker alone", async () => {
    const h = harness({ manifest, stored: { greeting: "Hi", token: "s3cret", undeclared: 1 } });
    expect(await dispatch("settings.get", { key: null }, h.scope, h.ctx("worker"), h.runtime)).toEqual({ ok: true, v: { greeting: "Hi", fps: "60", token: "s3cret" } });
    expect(await dispatch("settings.get", { key: null }, h.scope, h.ctx("panel"), h.runtime)).toEqual({ ok: true, v: { greeting: "Hi", fps: "60" } });
    expect(await dispatch("settings.get", { key: "token" }, h.scope, h.ctx("page"), h.runtime)).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(await dispatch("settings.get", { key: "token" }, h.scope, h.ctx("worker"), h.runtime)).toEqual({ ok: true, v: { token: "s3cret" } });
    expect(await dispatch("settings.get", { key: "nope" }, h.scope, h.ctx("worker"), h.runtime)).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("files.data", () => {
  const granted = () => harness({ manifest: manifestOf({ permissions: ["files:data"] }), record: recordOf({ capabilities: ["files:data"] }) });

  it("refuses paths out of the data folder: .., absolute, a link out", async () => {
    const h = granted();
    for (const path of ["../storage.json", "a/../../x", "/etc/passwd"]) {
      expect(await dispatch("files.data.read", { path }, h.scope, h.ctx(), h.runtime), path).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
      expect(await dispatch("files.data.write", { handle: null, path, chunk: new Uint8Array([1]) }, h.scope, h.ctx(), h.runtime), path).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    }
    // A link inside the folder to a file and a folder outside it.
    const outside = mkdtempSync(join(tmpdir(), "pistachio-ext-outside-"));
    writeFileSync(join(outside, "secret.txt"), "not yours");
    mkdirSync(h.dataRoot, { recursive: true });
    symlinkSync(join(outside, "secret.txt"), join(h.dataRoot, "link.txt"));
    symlinkSync(outside, join(h.dataRoot, "dir"));
    expect(await dispatch("files.data.read", { path: "link.txt" }, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await dispatch("files.data.write", { handle: null, path: "dir/new.txt", chunk: new Uint8Array([1]) }, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    expect(await dispatch("files.data.write", { handle: null, path: "link.txt", chunk: new Uint8Array([1]) }, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
  });

  it("writes through a handle in order, and reads a range back", async () => {
    const h = granted();
    const opened = await dispatch("files.data.open", { path: "rec/one/screen.bin", append: false }, h.scope, h.ctx(), h.runtime);
    expect(opened).toMatchObject({ ok: true });
    const handle = (opened as { v: { handle: number } }).v.handle;
    await Promise.all([
      dispatch("files.data.write", { handle, path: null, chunk: new Uint8Array([1, 2, 3]).buffer }, h.scope, h.ctx(), h.runtime),
      dispatch("files.data.write", { handle, path: null, chunk: new Uint8Array([4, 5]) }, h.scope, h.ctx(), h.runtime),
    ]);
    await dispatch("files.data.close", { handle, abort: false }, h.scope, h.ctx(), h.runtime);
    const whole = await dispatch("files.data.read", { path: "rec/one/screen.bin" }, h.scope, h.ctx(), h.runtime);
    expect(whole.ok && [...new Uint8Array((whole.v as { bytes: ArrayBuffer }).bytes)]).toEqual([1, 2, 3, 4, 5]);
    const part = await dispatch("files.data.read", { path: "rec/one/screen.bin", start: 1, end: 3 }, h.scope, h.ctx(), h.runtime);
    expect(part.ok && [...new Uint8Array((part.v as { bytes: ArrayBuffer }).bytes)]).toEqual([2, 3]);
    const listed = await dispatch("files.data.list", { dir: "rec/one" }, h.scope, h.ctx(), h.runtime);
    expect(listed).toMatchObject({ ok: true, v: [{ path: "rec/one/screen.bin", size: 5, kind: "file" }] });
  });
});

describe("net.fetch", () => {
  const github = () =>
    harness({ manifest: manifestOf({ hosts: ["https://api.github.com/*"] }), record: recordOf({ capabilities: [], hosts: ["https://api.github.com/*"] }) });

  it("fetches a granted host, base64 body, and writes the ledger without the query", async () => {
    const h = github();
    const reply = await dispatch("net.fetch", { url: "https://api.github.com/user?token=abc", method: "post", body: "{}" }, h.scope, h.ctx(), h.runtime);
    expect(reply).toEqual({ ok: true, v: { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("hi").toString("base64") } });
    expect(h.runtime.fetch).toHaveBeenCalledWith("https://api.github.com/user?token=abc", { method: "POST", headers: {}, body: "{}" });
    expect(h.ledger.lines()).toEqual([expect.objectContaining({ method: "POST", host: "api.github.com", path: "/user", status: 200, sent: 2, received: 2 })]);
    expect(JSON.stringify(h.ledger.lines())).not.toContain("token=abc");
  });

  it("refuses a host it was not granted, never fetching it, and says which host to add", async () => {
    const h = github();
    const reply = await dispatch("net.fetch", { url: "https://evil.example.com/steal" }, h.scope, h.ctx(), h.runtime);
    expect(reply).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    if (!reply.ok) expect(reply.message).toContain("evil.example.com");
    expect(h.runtime.fetch).not.toHaveBeenCalled();
    expect(h.ledger.lines()).toEqual([expect.objectContaining({ host: "evil.example.com", refused: "host" })]);
    expect(await dispatch("net.fetch", { url: "file:///etc/passwd" }, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
  });

  it("refuses a host asked for but not approved (the grant is what counts)", async () => {
    const h = harness({ manifest: manifestOf({ hosts: ["https://api.github.com/*"] }), record: recordOf({ capabilities: [], hosts: [] }) });
    expect(await dispatch("net.fetch", { url: "https://api.github.com/" }, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
  });
});

describe("notes", () => {
  it("updates through the structural edit, a section by its heading", async () => {
    const h = harness({ manifest: manifestOf({ permissions: ["notes:write"] }), record: recordOf({ capabilities: ["notes:write"] }) });
    expect(await dispatch("notes.update", { id: "n1", mode: "section", markdown: "new", section: "Plan" }, h.scope, h.ctx(), h.runtime)).toEqual({ ok: true, v: null });
    expect(h.notes.edit).toHaveBeenCalledWith("n1", { mode: "replace_section", markdown: "new", section: "Plan" });
    expect(await dispatch("notes.update", { id: "n1", mode: "section", markdown: "new" }, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    expect(await dispatch("notes.update", { id: "zz", mode: "append", markdown: "x" }, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    // Writing reads too.
    expect(await dispatch("notes.list", {}, h.scope, h.ctx(), h.runtime)).toEqual({ ok: true, v: [{ id: "n1", title: "One", updatedAt: Date.parse("2026-10-30T00:00:00.000Z") }] });
  });
});

describe("ui", () => {
  it("opens only a declared page, in the Profile in front", async () => {
    const h = harness({ manifest: manifestOf({ pages: { editor: { file: "editor.html", title: "Editor" } } }) });
    expect(await dispatch("ui.openPage", { name: "editor", query: "rec=1" }, h.scope, h.ctx(), h.runtime)).toEqual({ ok: true, v: { tabId: "page-tab" } });
    expect(h.runtime.openPage).toHaveBeenCalledWith(expect.anything(), "editor", "rec=1", { profileId: "profile-a", space: "current" });
    expect(await dispatch("ui.openPage", { name: "nope" }, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await dispatch("ui.openPanel", {}, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});
