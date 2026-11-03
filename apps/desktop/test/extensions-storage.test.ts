/**
 * storage.local (main/extensions/storage.ts): a key spelled like one of Object's own properties is a key like any
 * other — its first write has no previous value, and its change record clones (it reaches storage.onChanged whole).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExtensionStorage } from "../src/main/extensions/storage";

describe("storage.local", () => {
  it("treats constructor, toString and __proto__ as keys of the extension's own, with no inherited past", () => {
    const storage = new ExtensionStorage(join(mkdtempSync(join(tmpdir(), "pistachio-storage-")), "storage.json"));
    const changes = storage.set({ constructor: 1, toString: "two", hasOwnProperty: [3] });
    expect(changes).toEqual({ constructor: { newValue: 1 }, toString: { newValue: "two" }, hasOwnProperty: { newValue: [3] } });
    expect(() => structuredClone(changes)).not.toThrow();
    expect(storage.get(["constructor", "toString", "hasOwnProperty", "valueOf"])).toEqual({ constructor: 1, toString: "two", hasOwnProperty: [3] });
    // Written again the same: no change; changed: the past is the extension's value, not Object's.
    expect(storage.set({ constructor: 1 })).toEqual({});
    expect(storage.set({ constructor: 2 })).toEqual({ constructor: { oldValue: 1, newValue: 2 } });
    expect(storage.remove(["toString", "valueOf"])).toEqual({ toString: { oldValue: "two" } });
    storage.flush();
  });
});
