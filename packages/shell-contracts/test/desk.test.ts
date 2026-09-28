import { describe, expect, it } from "vitest";
import { holdsDeskModifier, isDeskGrab, isDeskState, MAX_DESK_WINDOWS } from "../src/desk.js";
import { isDragCursor } from "../src/chrome.js";

describe("the desk's contract", () => {
  it("accepts a desk state and refuses anything else", () => {
    expect(isDeskState({ tabIds: ["a", "b"], grab: "shift" })).toBe(true);
    expect(isDeskState({ tabIds: [], grab: null })).toBe(true);
    expect(isDeskState({ tabIds: ["a"], grab: "ctrl" })).toBe(false);
    expect(isDeskState({ tabIds: [1], grab: null })).toBe(false);
    expect(isDeskState({ tabIds: Array.from({ length: MAX_DESK_WINDOWS + 1 }, (_, i) => `t${i}`), grab: null })).toBe(false);
    expect(isDeskState(null)).toBe(false);
  });

  it("accepts a grab only with a finite point", () => {
    expect(isDeskGrab({ tabId: "a", x: 10, y: 20 })).toBe(true);
    expect(isDeskGrab({ tabId: "a", x: Number.NaN, y: 20 })).toBe(false);
    expect(isDeskGrab({ x: 1, y: 2 })).toBe(false);
  });

  it("reads the grab key from an input event's modifiers, whatever Electron calls ⌘", () => {
    expect(holdsDeskModifier(["shift", "leftbuttondown"], "shift")).toBe(true);
    expect(holdsDeskModifier(["leftbuttondown"], "shift")).toBe(false);
    expect(holdsDeskModifier(["cmd"], "meta")).toBe(true);
    expect(holdsDeskModifier(["command"], "meta")).toBe(true);
    expect(holdsDeskModifier(["alt"], "alt")).toBe(true);
    expect(holdsDeskModifier(["shift"], null)).toBe(false);
    expect(holdsDeskModifier(undefined, "shift")).toBe(false);
  });

  it("lets the drag layer hold the resize cursors a window's corners need", () => {
    for (const cursor of ["nwse-resize", "nesw-resize", "ew-resize", "ns-resize", "grabbing", "col-resize"]) expect(isDragCursor(cursor)).toBe(true);
    expect(isDragCursor("pointer")).toBe(false);
  });
});
