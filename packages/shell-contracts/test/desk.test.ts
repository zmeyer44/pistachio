import { describe, expect, it } from "vitest";
import { DESK_PIP_OUTSET, deskMaskKey, deskPipSlot, holdsDeskModifier, inDeskBox, isDeskGrab, isDeskMask, isDeskNotchFrame, isDeskPageInput, isDeskPipInput, isDeskState, isDockCloseKey, MAX_DESK_WINDOWS } from "../src/desk.js";
import { isDragCursor, isDragSample } from "../src/chrome.js";

describe("the desk's contract", () => {
  it("takes the notch view's frame only with the box the shell's ground is painted over", () => {
    const frame = { bounds: { x: 653, y: 860, width: 174, height: 32 }, label: "Ask about Research", shortcut: "⌘I", color: "blue", radius: 14, flare: 10, ground: { x: 0, y: 0, width: 1440, height: 900 } };
    expect(isDeskNotchFrame(frame)).toBe(true);
    expect(isDeskNotchFrame({ ...frame, ground: undefined })).toBe(false);
    expect(isDeskNotchFrame({ ...frame, ground: { x: 0, y: 0, width: 0, height: 900 } })).toBe(false);
    expect(isDeskNotchFrame({ ...frame, ground: { x: Number.NaN, y: 0, width: 1440, height: 900 } })).toBe(false);
  });

  it("accepts a desk state and refuses anything else", () => {
    expect(isDeskState({ tabIds: ["a", "b"], grab: "shift" })).toBe(true);
    expect(isDeskState({ tabIds: [], grab: null })).toBe(true);
    expect(isDeskState({ tabIds: ["a"], grab: "ctrl" })).toBe(false);
    expect(isDeskState({ tabIds: [1], grab: null })).toBe(false);
    expect(isDeskState({ tabIds: Array.from({ length: MAX_DESK_WINDOWS + 1 }, (_, i) => `t${i}`), grab: null })).toBe(false);
    expect(isDeskState(null)).toBe(false);
  });

  it("takes where the dock stands aside only as a finite box, or none", () => {
    const dock = { x: 0, y: 300, width: 68, height: 400 };
    expect(isDeskState({ tabIds: ["a"], grab: null, dock })).toBe(true);
    expect(isDeskState({ tabIds: ["a"], grab: null, dock: null })).toBe(true);
    expect(isDeskState({ tabIds: ["a"], grab: null, dock: { ...dock, width: Number.POSITIVE_INFINITY } })).toBe(false);
    expect(isDeskState({ tabIds: ["a"], grab: null, dock: { ...dock, height: -1 } })).toBe(false);
    expect(isDeskState({ tabIds: ["a"], grab: null, dock: "left" })).toBe(false);
    expect(inDeskBox(dock, 0, 300)).toBe(true);
    expect(inDeskBox(dock, 67.5, 699)).toBe(true);
    expect(inDeskBox(dock, 68, 500)).toBe(false);
    expect(inDeskBox(dock, 30, 700)).toBe(false);
  });

  it("takes a mask only as a region inside its page, and the pages masked with the size they show at", () => {
    const mask = { x: 300, y: 200, width: 400, height: 300, pageWidth: 1200, pageHeight: 800 };
    expect(isDeskMask(mask)).toBe(true);
    expect(isDeskMask({ ...mask, x: 900 })).toBe(false);
    expect(isDeskMask({ ...mask, width: 4 })).toBe(false);
    expect(isDeskMask({ ...mask, pageHeight: Number.NaN })).toBe(false);
    expect(isDeskMask({ ...mask, y: -1 })).toBe(false);
    expect(deskMaskKey({ ...mask, x: 300.4 })).toBe("300,200,400,300,1200,800");
    expect(isDeskState({ tabIds: ["a"], grab: null, masks: [{ tabId: "a", mask, width: 800, height: 600 }] })).toBe(true);
    expect(isDeskState({ tabIds: ["a"], grab: null, masks: [{ tabId: "a", mask, width: 0, height: 600 }] })).toBe(false);
    expect(isDeskState({ tabIds: ["a"], grab: null, masks: [{ tabId: "a", mask: { ...mask, width: 0 }, width: 8, height: 6 }] })).toBe(false);
  });

  it("accepts a grab only with a finite point", () => {
    expect(isDeskGrab({ tabId: "a", x: 10, y: 20 })).toBe(true);
    expect(isDeskGrab({ tabId: "a", x: Number.NaN, y: 20 })).toBe(false);
    expect(isDeskGrab({ x: 1, y: 2 })).toBe(false);
  });

  it("takes whether a tab's icon in the dock is under the pointer only as a boolean, or its absence", () => {
    expect(isDeskState({ tabIds: ["a"], grab: null, dockHover: true })).toBe(true);
    expect(isDeskState({ tabIds: ["a"], grab: null, dockHover: false })).toBe(true);
    expect(isDeskState({ tabIds: ["a"], grab: null, dockHover: "a" })).toBe(false);
  });

  it("closes a hovered dock icon's tab on ⇧⌫ going down, and on no other key", () => {
    const key = { type: "keyDown", key: "Backspace", shift: true, control: false, alt: false, meta: false };
    expect(isDockCloseKey(key)).toBe(true);
    expect(isDockCloseKey({ ...key, type: "keyUp" })).toBe(false);
    expect(isDockCloseKey({ ...key, shift: false })).toBe(false);
    expect(isDockCloseKey({ ...key, meta: true })).toBe(false);
    expect(isDockCloseKey({ ...key, alt: true })).toBe(false);
    expect(isDockCloseKey({ ...key, control: true })).toBe(false);
    expect(isDockCloseKey({ ...key, key: "Delete" })).toBe(false);
  });

  it("relays a desk page's press, Escape, the pointer coming to the dock, or ⇧⌫ on a dock icon, and nothing else", () => {
    expect(isDeskPageInput("press")).toBe(true);
    expect(isDeskPageInput("escape")).toBe(true);
    expect(isDeskPageInput("dock")).toBe(true);
    expect(isDeskPageInput("close")).toBe(true);
    expect(isDeskPageInput("keyDown")).toBe(false);
    expect(isDeskPageInput(null)).toBe(false);
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

  it("takes a drag sample's Shift reading (the desk's snap key) only as a boolean, and its absence", () => {
    expect(isDragSample({ x: 1, y: 2, phase: "move" })).toBe(true);
    expect(isDragSample({ x: 1, y: 2, phase: "move", shift: true })).toBe(true);
    expect(isDragSample({ x: 1, y: 2, phase: "up", shift: false })).toBe(true);
    expect(isDragSample({ x: 1, y: 2, phase: "move", shift: "yes" })).toBe(false);
  });

  it("takes a press from the floating player's view on its picture or one of its edges, and its view stands out from the picture all round", () => {
    expect(isDeskPipInput({ type: "grab", x: 1, y: 2 })).toBe(true);
    expect(isDeskPipInput({ type: "grab", x: 1, y: 2, edge: "se" })).toBe(true);
    expect(isDeskPipInput({ type: "grab", x: 1, y: 2, edge: "middle" })).toBe(false);
    expect(isDeskPipInput({ type: "grab", x: 1, y: 2, edge: 3 })).toBe(false);
    expect(isDeskPipInput({ type: "grab", x: Number.NaN, y: 2 })).toBe(false);
    expect(deskPipSlot({ x: 100, y: 50, width: 320, height: 180 })).toEqual({
      x: 100 - DESK_PIP_OUTSET,
      y: 50 - DESK_PIP_OUTSET,
      width: 320 + DESK_PIP_OUTSET * 2,
      height: 180 + DESK_PIP_OUTSET * 2,
    });
  });

  it("lets the drag layer hold the resize cursors a window's corners need", () => {
    for (const cursor of ["nwse-resize", "nesw-resize", "ew-resize", "ns-resize", "grabbing", "col-resize"]) expect(isDragCursor(cursor)).toBe(true);
    expect(isDragCursor("pointer")).toBe(false);
  });
});
