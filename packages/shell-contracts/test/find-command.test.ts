import { describe, expect, it } from "vitest";
import { CLOSED_FIND, isFindCommand } from "../src/browser-controls.js";
import { DEFAULT_SHORTCUTS, sanitizeShortcuts, shortcutActionForEvent } from "../src/shortcuts.js";

/**
 * Main drops a find command this refuses — silently, since it crossed a
 * process boundary — so every shape the bar sends is pinned here
 * (docs/smart-find.md §5).
 */
describe("isFindCommand", () => {
  it("accepts every shape the bar sends, with and without a mode", () => {
    for (const command of [
      { type: "close" },
      { type: "search", query: "", forward: true },
      { type: "search", query: "invoice", forward: false, mode: "exact" },
      { type: "search", query: "how do I get my money back", forward: true, mode: "smart" },
      { type: "search", query: "how do I", forward: true, mode: "smart", draft: true },
      { type: "mode", mode: "smart" },
      { type: "mode", mode: "exact" },
    ])
      expect(isFindCommand(command), JSON.stringify(command)).toBe(true);
  });

  it("refuses anything else", () => {
    for (const command of [
      null,
      "close",
      { type: "open" },
      { type: "mode" },
      { type: "mode", mode: "fuzzy" },
      { type: "search", query: 7, forward: true },
      { type: "search", query: "x" },
      { type: "search", query: "x", forward: true, mode: "fuzzy" },
      { type: "search", query: "x", forward: true, draft: "yes" },
    ])
      expect(isFindCommand(command), JSON.stringify(command)).toBe(false);
  });

  it("a closed bar is an exact find with nothing on it", () => {
    expect(CLOSED_FIND).toMatchObject({ open: false, mode: "exact", matches: 0, smart: { status: "idle" } });
  });
});

describe("the smart find shortcut", () => {
  it("is ⌥⌘F, read off the physical key since Option composes another character", () => {
    expect(DEFAULT_SHORTCUTS.smartFind).toBe("Mod+Alt+F");
    expect(shortcutActionForEvent(DEFAULT_SHORTCUTS, { key: "ƒ", code: "KeyF", metaKey: true, altKey: true }, "darwin")).toBe("smartFind");
    expect(shortcutActionForEvent(DEFAULT_SHORTCUTS, { key: "f", code: "KeyF", metaKey: true }, "darwin")).toBe("find");
  });

  it("arrives on a settings file written before it existed, without taking a binding someone gave another action", () => {
    expect(sanitizeShortcuts({ find: "Mod+F" }).smartFind).toBe("Mod+Alt+F");
    const taken = sanitizeShortcuts({ copyUrl: "Mod+Alt+F" });
    expect(taken.copyUrl).toBe("Mod+Alt+F");
    expect(taken.smartFind).toBeNull();
  });
});
