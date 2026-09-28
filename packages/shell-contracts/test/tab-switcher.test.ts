import { describe, expect, it } from "vitest";
import {
  menuKeepsKey,
  passedKeystroke,
  recordTabVisit,
  tabSwitcherIndex,
  tabSwitcherMove,
  TabSwitcherGesture,
  type SwitcherKey,
} from "../src/tab-switcher.js";

describe("Control–Tab history", () => {
  it("keeps unique tabs in most-recently-visited order", () => {
    expect(recordTabVisit(recordTabVisit(["current", "older"], "older"), "newest")).toEqual([
      "newest",
      "older",
      "current",
    ]);
  });

  it("wraps forward and reverse cycling around the MRU list", () => {
    expect(tabSwitcherIndex(1, 5)).toBe(1);
    expect(tabSwitcherIndex(6, 5)).toBe(1);
    expect(tabSwitcherIndex(-1, 5)).toBe(4);
    expect(tabSwitcherIndex(-6, 5)).toBe(4);
    expect(tabSwitcherIndex(4, 0)).toBe(0);
  });
});

describe("tabSwitcherMove", () => {
  // Nine cards, five to a row: 0–4 above, 5–8 below.
  it("walks left and right through the whole list, wrapping", () => {
    expect(tabSwitcherMove(4, "right", 9, 5)).toBe(5);
    expect(tabSwitcherMove(8, "right", 9, 5)).toBe(0);
    expect(tabSwitcherMove(0, "left", 9, 5)).toBe(8);
  });

  it("changes rows with up and down and stops at the edges", () => {
    expect(tabSwitcherMove(1, "down", 9, 5)).toBe(6);
    expect(tabSwitcherMove(4, "down", 9, 5)).toBe(8);
    expect(tabSwitcherMove(6, "down", 9, 5)).toBe(6);
    expect(tabSwitcherMove(6, "up", 9, 5)).toBe(1);
    expect(tabSwitcherMove(2, "up", 9, 5)).toBe(2);
  });
});

const NONE = { control: false, meta: false, alt: false, shift: false };

function down(key: string, flags: Partial<SwitcherKey> = {}): SwitcherKey {
  return { ...NONE, type: "keyDown", key, ...flags };
}

function up(key: string, flags: Partial<SwitcherKey> = {}): SwitcherKey {
  return { ...NONE, type: "keyUp", key, ...flags };
}

const CONTROL = { control: true };
const META = { meta: true };

describe("TabSwitcherGesture", () => {
  it("opens one step along on ⌃Tab and commits on the release", () => {
    const gesture = new TabSwitcherGesture();
    expect(gesture.key(down("Control", CONTROL))).toEqual({ consume: false, input: null });
    expect(gesture.armed).toBe(true);
    expect(gesture.key(down("Tab", CONTROL))).toEqual({
      consume: true,
      input: { type: "open", modifier: "control", step: 1 },
    });
    expect(gesture.key(down("Tab", CONTROL))).toEqual({ consume: true, input: { type: "step", reverse: false } });
    expect(gesture.key(down("Tab", { control: true, shift: true }))).toEqual({
      consume: true,
      input: { type: "step", reverse: true },
    });
    expect(gesture.key(up("Tab", CONTROL))).toEqual({ consume: false, input: null });
    expect(gesture.key(up("Control"))).toEqual({ consume: true, input: { type: "commit" } });
    expect(gesture.open).toBe(false);
  });

  it("opens backwards on ⌃⇧Tab", () => {
    const gesture = new TabSwitcherGesture();
    gesture.key(down("Control", CONTROL));
    gesture.key(down("Shift", { control: true, shift: true }));
    expect(gesture.key(down("Tab", { control: true, shift: true })).input).toEqual({
      type: "open",
      modifier: "control",
      step: -1,
    });
  });

  it("opens on the active tab when ⌃ or ⌘ is held alone", () => {
    for (const [key, flags, modifier] of [
      ["Control", CONTROL, "control"],
      ["Meta", META, "meta"],
    ] as const) {
      const gesture = new TabSwitcherGesture();
      gesture.key(down(key, flags));
      expect(gesture.armed).toBe(true);
      expect(gesture.holdElapsed()).toEqual({ type: "open", modifier, step: 0 });
      expect(gesture.open).toBe(true);
      expect(gesture.key(up(key))).toEqual({ consume: true, input: { type: "commit" } });
    }
  });

  it("walks the open switcher with arrows, commits on Return and cancels on Escape", () => {
    const gesture = new TabSwitcherGesture();
    gesture.key(down("Meta", META));
    gesture.holdElapsed();
    expect(gesture.key(down("ArrowRight", META))).toEqual({ consume: true, input: { type: "move", direction: "right" } });
    expect(gesture.key(down("ArrowDown", META))).toEqual({ consume: true, input: { type: "move", direction: "down" } });
    expect(gesture.key(down("Enter", META))).toEqual({ consume: true, input: { type: "commit" } });
    expect(gesture.open).toBe(false);

    gesture.key(down("Meta", META));
    gesture.holdElapsed();
    expect(gesture.key(down("Escape", META))).toEqual({ consume: true, input: { type: "cancel" } });
    expect(gesture.open).toBe(false);
  });

  it("lets a shortcut pressed with the modifier through, cancelling", () => {
    const gesture = new TabSwitcherGesture();
    gesture.key(down("Meta", META));
    // Pressed before the hold ran out: a shortcut, and never a switcher.
    expect(gesture.key(down("t", META))).toEqual({ consume: false, input: null });
    expect(gesture.armed).toBe(false);
    expect(gesture.holdElapsed()).toBeNull();

    gesture.key(down("Meta", META));
    gesture.holdElapsed();
    // Pressed once it is up: the switcher goes, the shortcut still runs.
    expect(gesture.key(down("t", META))).toEqual({ consume: false, input: { type: "cancel" } });
    expect(gesture.open).toBe(false);
  });

  it("does not arm for a modifier held with another", () => {
    const gesture = new TabSwitcherGesture();
    gesture.key(down("Meta", { meta: true, shift: true }));
    expect(gesture.armed).toBe(false);
    gesture.key(down("Control", { control: true, alt: true }));
    expect(gesture.armed).toBe(false);
  });

  it("disarms when the modifier is released before the hold, or the pointer is used", () => {
    const gesture = new TabSwitcherGesture();
    gesture.key(down("Control", CONTROL));
    gesture.key(up("Control"));
    expect(gesture.holdElapsed()).toBeNull();

    gesture.key(down("Meta", META));
    gesture.disarm();
    expect(gesture.holdElapsed()).toBeNull();
  });

  it("reads a release it never saw from the next key's modifier flags", () => {
    const gesture = new TabSwitcherGesture();
    gesture.key(down("Control", CONTROL));
    gesture.key(down("Tab", CONTROL));
    // The Control keyUp was swallowed; the next key arrives without the flag.
    expect(gesture.key(down("a"))).toEqual({ consume: false, input: { type: "commit" } });
    expect(gesture.open).toBe(false);
  });

  it("stays shut when there is nothing to switch to", () => {
    const gesture = new TabSwitcherGesture(() => false);
    gesture.key(down("Control", CONTROL));
    expect(gesture.key(down("Tab", CONTROL))).toEqual({ consume: true, input: null });
    expect(gesture.open).toBe(false);
    gesture.key(down("Meta", META));
    expect(gesture.holdElapsed()).toBeNull();
    expect(gesture.armed).toBe(false);
  });

  it("ignores the modifier's auto-repeat while armed", () => {
    const gesture = new TabSwitcherGesture();
    gesture.key(down("Control", CONTROL));
    gesture.key(down("Control", { control: true, isAutoRepeat: true }));
    expect(gesture.armed).toBe(true);
  });
});

describe("passedKeystroke", () => {
  it("sends a page shortcut on as it was typed", () => {
    expect(passedKeystroke(down("b", META))).toEqual({ keyCode: "b", modifiers: ["meta"], char: false, edit: null });
    expect(passedKeystroke(down("T", { meta: true, shift: true }))).toMatchObject({ keyCode: "T", modifiers: ["shift", "meta"] });
    expect(passedKeystroke(down("a", CONTROL))).toMatchObject({ keyCode: "a", modifiers: ["control"], char: false });
  });

  it("names an Option shortcut by its physical key, not the composed character", () => {
    expect(passedKeystroke(down("∫", { meta: true, alt: true, code: "KeyB" }))).toMatchObject({
      keyCode: "b",
      modifiers: ["alt", "meta"],
    });
  });

  it("types a plain key, and maps DOM names to the ones sendInputEvent knows", () => {
    expect(passedKeystroke(down("h"))).toMatchObject({ keyCode: "h", char: true });
    expect(passedKeystroke(down(" "))).toMatchObject({ keyCode: "Space", char: true });
    expect(passedKeystroke(down("Backspace", META))).toMatchObject({ keyCode: "Backspace", char: false });
    expect(passedKeystroke(down("PageDown"))).toMatchObject({ keyCode: "PageDown", char: false });
    expect(passedKeystroke(down("F5"))).toMatchObject({ keyCode: "F5", char: false });
    expect(passedKeystroke(down("Dead", META))).toBeNull();
    expect(passedKeystroke(down("MediaPlayPause"))).toBeNull();
  });

  it("knows the Edit menu's keys, which the menu never sees sent", () => {
    expect(passedKeystroke(down("c", META))?.edit).toBe("copy");
    expect(passedKeystroke(down("x", META))?.edit).toBe("cut");
    expect(passedKeystroke(down("v", META))?.edit).toBe("paste");
    expect(passedKeystroke(down("a", META))?.edit).toBe("selectAll");
    expect(passedKeystroke(down("z", META))?.edit).toBe("undo");
    expect(passedKeystroke(down("z", { meta: true, shift: true }))?.edit).toBe("redo");
    expect(passedKeystroke(down("◊", { meta: true, alt: true, shift: true, code: "KeyV" }))?.edit).toBe("pasteAndMatchStyle");
    expect(passedKeystroke(down("c", CONTROL))?.edit).toBeNull();
    expect(passedKeystroke(down("b", META))?.edit).toBeNull();
  });
});

describe("menuKeepsKey", () => {
  it("keeps the keys only the macOS menu answers", () => {
    expect(menuKeepsKey(down("q", META))).toBe(true);
    expect(menuKeepsKey(down("h", META))).toBe(true);
    expect(menuKeepsKey(down("˙", { meta: true, alt: true, code: "KeyH" }))).toBe(true);
    expect(menuKeepsKey(down("m", META))).toBe(true);
    expect(menuKeepsKey(down("ˆ", { meta: true, alt: true, code: "KeyI" }))).toBe(true);
    expect(menuKeepsKey(down("f", { meta: true, control: true }))).toBe(true);
  });

  it("lets page and app shortcuts go on to the page", () => {
    expect(menuKeepsKey(down("b", META))).toBe(false);
    expect(menuKeepsKey(down("c", META))).toBe(false);
    expect(menuKeepsKey(down("t", META))).toBe(false);
    expect(menuKeepsKey(down("Q", { meta: true, shift: true }))).toBe(false);
    expect(menuKeepsKey(down("a", CONTROL))).toBe(false);
  });
});
