import { describe, expect, it } from "vitest";
import { commandFor, keyBelongsToField, nextShuttleRate, type KeyLike } from "../src/editor/keys.js";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

describe("the editor's keys", () => {
  it("maps the transport", () => {
    expect(commandFor(key(" "))).toEqual({ type: "togglePlay" });
    expect(commandFor(key("ArrowLeft"))).toEqual({ type: "stepFrames", frames: -1 });
    expect(commandFor(key("ArrowRight", { shiftKey: true }))).toEqual({ type: "stepSeconds", seconds: 1 });
    expect(commandFor(key("j"))).toEqual({ type: "shuttle", direction: -1 });
    expect(commandFor(key("K"))).toEqual({ type: "shuttle", direction: 0 });
    expect(commandFor(key("l"))).toEqual({ type: "shuttle", direction: 1 });
    expect(commandFor(key("Home"))).toEqual({ type: "home" });
  });

  it("maps the edits", () => {
    expect(commandFor(key("s"))).toEqual({ type: "split" });
    expect(commandFor(key("Backspace"))).toEqual({ type: "delete" });
    expect(commandFor(key("Delete"))).toEqual({ type: "delete" });
    expect(commandFor(key("z"))).toEqual({ type: "addZoom" });
    expect(commandFor(key("x"))).toEqual({ type: "addSpeed" });
    expect(commandFor(key("Escape"))).toEqual({ type: "deselect" });
  });

  it("keeps ⌘Z for undo and ⌘⇧Z for redo, apart from Z", () => {
    expect(commandFor(key("z", { metaKey: true }))).toEqual({ type: "undo" });
    expect(commandFor(key("Z", { metaKey: true, shiftKey: true }))).toEqual({ type: "redo" });
    expect(commandFor(key("z", { ctrlKey: true }))).toEqual({ type: "undo" });
    expect(commandFor(key("s", { metaKey: true }))).toBeNull();
    expect(commandFor(key("z", { altKey: true }))).toBeNull();
    expect(commandFor(key("q"))).toBeNull();
  });

  it("leaves a focused control the keys it uses, and the editor the rest", () => {
    expect(keyBelongsToField("INPUT", "text", "s")).toBe(true);
    expect(keyBelongsToField("SELECT", undefined, "z")).toBe(true);
    // A slider keeps its arrows; Space and the letters still play and edit after a drag.
    expect(keyBelongsToField("INPUT", "range", "ArrowLeft")).toBe(true);
    expect(keyBelongsToField("INPUT", "range", " ")).toBe(false);
    expect(keyBelongsToField("INPUT", "range", "s")).toBe(false);
    // A switch keeps Space.
    expect(keyBelongsToField("INPUT", "checkbox", " ")).toBe(true);
    expect(keyBelongsToField("INPUT", "checkbox", "z")).toBe(false);
    expect(keyBelongsToField("CANVAS", undefined, " ")).toBe(false);
    expect(keyBelongsToField(undefined)).toBe(false);
  });

  it("runs J/L faster when pressed again", () => {
    expect(nextShuttleRate(1, true)).toBe(2);
    expect(nextShuttleRate(8, true)).toBe(8);
    expect(nextShuttleRate(4, false)).toBe(1);
  });
});
