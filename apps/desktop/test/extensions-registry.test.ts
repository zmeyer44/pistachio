import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExtensionRegistry, REGISTRY_FILE, sanitizeRegistry, onInAnyProfile } from "../src/main/extensions/registry";

const dir = (): string => mkdtempSync(join(tmpdir(), "pistachio-ext-registry-"));

describe("the extension registry", () => {
  it("is on in some Profile with 'all' or any one named — and off everywhere with none, whatever enabled says", () => {
    expect(onInAnyProfile({ profiles: "all" })).toBe(true);
    expect(onInAnyProfile({ profiles: ["work"] })).toBe(true);
    expect(onInAnyProfile({ profiles: [] })).toBe(false);
  });

  it("writes a record and reads it back in a new registry", () => {
    const root = dir();
    const registry = new ExtensionRegistry(root);
    const record = registry.fresh("dev.zach.inbox", "pistachio", { type: "dev", path: "/Users/z/Pistachio/Extensions/inbox" }, 1000);
    record.pending = { manifestHash: "abc", widened: ["tabs:read"], hosts: ["https://api.github.com/*"] };
    registry.upsert(record);
    registry.update("dev.zach.inbox", { grants: { capabilities: ["tabs:read"], hosts: [], manifestHash: "abc", at: 2000 }, pending: null, enabled: true }, 3000);
    registry.setSetting("dev.zach.inbox", "greeting", "Hi");

    const again = new ExtensionRegistry(root);
    expect(again.get("dev.zach.inbox")).toEqual({
      ...record,
      grants: { capabilities: ["tabs:read"], hosts: [], manifestHash: "abc", at: 2000 },
      pending: null,
      enabled: true,
      updatedAt: 3000,
    });
    expect(again.settingsOf("dev.zach.inbox")).toEqual({ greeting: "Hi" });
    expect(again.findByPath("/Users/z/Pistachio/Extensions/inbox")?.id).toBe("dev.zach.inbox");
    // Atomic: the file is whole JSON, no temp file left behind as the registry.
    expect(() => JSON.parse(readFileSync(join(root, REGISTRY_FILE), "utf8"))).not.toThrow();
  });

  it("reads a missing or broken file as empty, and drops malformed records", () => {
    const root = dir();
    writeFileSync(join(root, REGISTRY_FILE), "{ not json");
    expect(new ExtensionRegistry(root).list()).toEqual([]);
    const sanitized = sanitizeRegistry({
      version: 1,
      records: [{ id: "x.y", kind: "pistachio", source: { type: "bundled" } }, { id: 7 }, { id: "a.b", kind: "other", source: { type: "bundled" } }],
      settings: { "x.y": { a: 1 }, "gone.id": { b: 2 } },
    });
    expect(sanitized.records.map((record) => record.id)).toEqual(["x.y"]);
    expect(sanitized.settings).toEqual({ "x.y": { a: 1 } });
    expect(sanitized.records[0]).toMatchObject({ enabled: false, profiles: "all", grants: null, pending: null, pinned: true });
  });

  it("binds a record to its source: another folder declaring the id is refused, and com.pistachio.* is the bundled set's", () => {
    const registry = new ExtensionRegistry(dir());
    registry.upsert(registry.fresh("dev.zach.inbox", "pistachio", { type: "dev", path: "/a" }));
    expect(registry.claim("dev.zach.inbox", { type: "dev", path: "/a" })).toMatchObject({ ok: true, record: { id: "dev.zach.inbox" } });
    expect(registry.claim("dev.zach.inbox", { type: "dev", path: "/b" })).toMatchObject({ ok: false });
    expect(registry.claim("dev.zach.other", { type: "dev", path: "/b" })).toEqual({ ok: true, record: null });
    const reserved = registry.claim("com.pistachio.recorder", { type: "dev", path: "/c" });
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) expect(reserved.reason).toMatch(/reserved/);
    expect(registry.claim("com.pistachio.recorder", { type: "bundled" })).toEqual({ ok: true, record: null });
  });

  it("reorders among the pinned ones, as the Ledge counts them", () => {
    const registry = new ExtensionRegistry(dir());
    for (const id of ["a.a", "b.b", "c.c", "d.d"]) registry.upsert(registry.fresh(id, "pistachio", { type: "dev", path: `/${id}` }));
    registry.update("b.b", { pinned: false });
    // Pinned in order: a, c, d. Move d to the Ledge's first place.
    registry.reorder("d.d", 0, (record) => record.pinned);
    expect(registry.list().map((record) => record.id)).toEqual(["d.d", "a.a", "b.b", "c.c"]);
    // Past the end: after the last pinned one.
    registry.reorder("d.d", 9, (record) => record.pinned);
    expect(registry.list().filter((record) => record.pinned).map((record) => record.id)).toEqual(["a.a", "c.c", "d.d"]);
  });

  it("writes nothing when the codec refuses to seal — never a secret in the clear — and clears without it", () => {
    const root = mkdtempSync(join(tmpdir(), "pistachio-registry-"));
    const codec = {
      seal: (): string => {
        throw new Error("no keychain");
      },
      open: (): string => {
        throw new Error("no keychain");
      },
    };
    const registry = new ExtensionRegistry(root, { codec });
    expect(() => registry.setSetting("dev.x", "token", "hunter2", true)).toThrow("no keychain");
    expect(registry.settingsOf("dev.x", new Set(["token"]))).toEqual({});
    expect(() => registry.setSetting("dev.x", "token", undefined, true)).not.toThrow();
    const files = readdirSync(root).filter((name) => name.endsWith(".json"));
    for (const name of files) expect(readFileSync(join(root, name), "utf8")).not.toContain("hunter2");
  });

  it("seals secret settings with its codec and opens them for the worker", () => {
    const root = dir();
    const codec = { seal: (value: string) => `sealed:${value}`, open: (sealed: string) => sealed.replace(/^sealed:/, "") };
    const registry = new ExtensionRegistry(root, { codec });
    registry.upsert(registry.fresh("x.y", "pistachio", { type: "bundled" }));
    registry.setSetting("x.y", "token", "s3cret", true);
    expect(readFileSync(join(root, REGISTRY_FILE), "utf8")).toContain("sealed:s3cret");
    expect(registry.settingsOf("x.y", new Set(["token"]))).toEqual({ token: "s3cret" });
    registry.setSetting("x.y", "token", undefined, true);
    expect(registry.settingsOf("x.y", new Set(["token"]))).toEqual({});
  });

  it("removes a record and its settings", () => {
    const registry = new ExtensionRegistry(dir());
    registry.upsert(registry.fresh("x.y", "pistachio", { type: "bundled" }));
    registry.setSetting("x.y", "a", 1);
    expect(registry.remove("x.y")).toBe(true);
    expect(registry.get("x.y")).toBeNull();
    expect(registry.settingsOf("x.y")).toEqual({});
  });
});
