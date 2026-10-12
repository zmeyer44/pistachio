/**
 * Where a modified ↵ in the address bar opens its choice
 * (components/address-palette.tsx `enterDestination`): ⌥↵ a new tab of this
 * space, ⌘⇧↵ (Ctrl+Shift+↵ off the Mac) a new space where one can be made;
 * a plain ↵ leaves it to what the bar was opened for.
 */

import { describe, expect, it } from "vitest";
import { enterDestination } from "../src/components/address-palette";

const keys = (held: Partial<Record<"altKey" | "metaKey" | "ctrlKey" | "shiftKey", boolean>>) => ({
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...held,
});

describe("enterDestination", () => {
  it("sends ⌥↵ to a new tab and ⌘⇧↵ to a new space", () => {
    expect(enterDestination(keys({ altKey: true }), "darwin", true)).toBe("tab");
    expect(enterDestination(keys({ altKey: true, shiftKey: true }), "darwin", true)).toBe("tab");
    expect(enterDestination(keys({ metaKey: true, shiftKey: true }), "darwin", true)).toBe("space");
  });

  it("leaves a plain ↵, and chords it has no meaning for, to the bar", () => {
    expect(enterDestination(keys({}), "darwin", true)).toBeUndefined();
    expect(enterDestination(keys({ shiftKey: true }), "darwin", true)).toBeUndefined();
    expect(enterDestination(keys({ metaKey: true }), "darwin", true)).toBeUndefined();
    expect(enterDestination(keys({ metaKey: true, altKey: true }), "darwin", true)).toBeUndefined();
    expect(enterDestination(keys({ metaKey: true, shiftKey: true, altKey: true }), "darwin", true)).toBeUndefined();
  });

  it("leaves ⌘⇧↵ a plain ↵ where no space can be made (the web)", () => {
    expect(enterDestination(keys({ metaKey: true, shiftKey: true }), "darwin", false)).toBeUndefined();
    expect(enterDestination(keys({ altKey: true }), "darwin", false)).toBe("tab");
  });

  it("reads Ctrl as the command key off the Mac", () => {
    expect(enterDestination(keys({ ctrlKey: true, shiftKey: true }), "other", true)).toBe("space");
    expect(enterDestination(keys({ altKey: true }), "other", true)).toBe("tab");
    expect(enterDestination(keys({ ctrlKey: true, shiftKey: true }), "darwin", true)).toBeUndefined();
  });
});
