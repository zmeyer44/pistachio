import { describe, expect, it } from "vitest";
import {
  ClickCounter,
  clipboardChord,
  decodeMessage,
  electronKeyCode,
  encodeMessage,
  keyToLive,
  pointerToLive,
  textToLive,
  toElectronInputEvents,
  wheelToLive,
  type ElectronInputStep,
  type KeyLike,
  type LiveInputEvent,
  type LiveModifier,
  type PointerLike,
} from "../src/index.js";

const page = { left: 100, top: 50, width: 400, height: 300 };
const view = { width: 1200, height: 900 };
const none = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };

function pointer(clientX: number, clientY: number, extra: Partial<PointerLike> = {}): PointerLike {
  return { clientX, clientY, button: 0, buttons: 0, ...none, ...extra };
}

function key(keyName: string, code: string, extra: Partial<KeyLike> = {}): KeyLike {
  return { key: keyName, code, repeat: false, ...none, ...extra };
}

/** Through the wire, as main receives it: encode, decode as from a guest, map to Electron. */
function toElectron(events: LiveInputEvent[]): ElectronInputStep[] {
  return events.flatMap((e) => {
    const decoded = decodeMessage("lv.input", encodeMessage("lv.input", { w: "tab", e }), "guest");
    if (decoded === null) throw new Error(`dropped ${JSON.stringify(e)}`);
    return toElectronInputEvents(decoded.e, view);
  });
}

describe("pointer", () => {
  it("clicks at the same place on the host's page", () => {
    const down = pointerToLive(pointer(300, 200, { buttons: 1 }), page, "mouseDown", 1);
    const up = pointerToLive(pointer(300, 200), page, "mouseUp", 1);
    expect(down).toEqual({ type: "mouseDown", x: 0.5, y: 0.5, button: "left", buttons: 1, clickCount: 1, modifiers: [] });
    expect(toElectron([down!, up!])).toEqual([
      { type: "mouseDown", x: 600, y: 450, button: "left", clickCount: 1, modifiers: ["leftbuttondown"] },
      { type: "mouseUp", x: 600, y: 450, button: "left", clickCount: 1, modifiers: [] },
    ]);
  });

  it("double-clicks: the second press counts 2, the release reports its press", () => {
    const clicks = new ClickCounter();
    const at = pointer(300, 200);
    expect(clicks.press(at, 1000)).toBe(1);
    expect(clicks.release()).toBe(1);
    const second = clicks.press(pointer(302, 201), 1250);
    expect(second).toBe(2);
    expect(clicks.release()).toBe(2);
    expect(clicks.press(at, 1400)).toBe(3);
    expect(clicks.press(at, 1500)).toBe(3);
    expect(clicks.press(at, 2500)).toBe(1);
    expect(clicks.press(pointer(320, 200), 2600)).toBe(1);
    expect(clicks.press(pointer(320, 200, { button: 2 }), 2700)).toBe(1);
    const events = [pointerToLive(at, page, "mouseDown", second), pointerToLive(at, page, "mouseUp", second)];
    expect(toElectron(events as LiveInputEvent[]).map((e) => "clickCount" in e && e.clickCount)).toEqual([2, 2]);
  });

  it("drags with the button held on every move", () => {
    const move = pointerToLive(pointer(200, 100, { buttons: 1, shiftKey: true }), page, "mouseMove");
    expect(move).toMatchObject({ type: "mouseMove", button: "left", buttons: 1, clickCount: 0, modifiers: ["shift"] });
    expect(toElectron([move!])).toEqual([{ type: "mouseMove", x: 300, y: 150, button: "left", modifiers: ["shift", "leftbuttondown"] }]);
    const hover = pointerToLive(pointer(200, 100), page, "mouseMove");
    expect(toElectron([hover!])).toEqual([{ type: "mouseMove", x: 300, y: 150, modifiers: [] }]);
  });

  it("maps the right button, and refuses back and forward", () => {
    expect(pointerToLive(pointer(300, 200, { button: 2, buttons: 2 }), page, "mouseDown", 1)).toMatchObject({ button: "right" });
    expect(pointerToLive(pointer(300, 200, { button: 3 }), page, "mouseDown", 1)).toBeNull();
  });

  it("clamps to the page and to the view", () => {
    const outside = pointerToLive(pointer(-50, 9999), page, "mouseMove");
    expect(outside).toMatchObject({ x: 0, y: 1 });
    expect(toElectron([outside!])).toEqual([{ type: "mouseMove", x: 0, y: 899, modifiers: [] }]);
    // A hostile event straight into the mapper is clamped there too.
    const wild = toElectronInputEvents({ type: "mouseDown", x: 7, y: -3, button: "left", buttons: 1, clickCount: 9, modifiers: [] }, view);
    expect(wild).toEqual([{ type: "mouseDown", x: 1199, y: 0, button: "left", clickCount: 3, modifiers: ["leftbuttondown"] }]);
  });
});

describe("wheel", () => {
  it("scrolls down for a DOM delta down: Chromium's sign is the opposite", () => {
    const wheel = wheelToLive({ clientX: 300, clientY: 200, deltaX: 10, deltaY: 120, deltaMode: 0, ...none }, page);
    expect(wheel).toEqual({ type: "wheel", x: 0.5, y: 0.5, dx: 10, dy: 120, modifiers: [] });
    expect(toElectron([wheel])).toEqual([
      { type: "mouseWheel", x: 600, y: 450, deltaX: -10, deltaY: -120, hasPreciseScrollingDeltas: true, canScroll: true, modifiers: [] },
    ]);
  });

  it("turns lines and pages into pixels and clamps to ±2000", () => {
    expect(wheelToLive({ clientX: 0, clientY: 0, deltaX: 0, deltaY: 3, deltaMode: 1, ...none }, page)).toMatchObject({ dy: 120 });
    expect(wheelToLive({ clientX: 0, clientY: 0, deltaX: 0, deltaY: -1, deltaMode: 2, ...none }, page)).toMatchObject({ dy: -300 });
    expect(wheelToLive({ clientX: 0, clientY: 0, deltaX: -9000, deltaY: 9000, deltaMode: 0, ...none }, page)).toMatchObject({ dx: -2000, dy: 2000 });
  });
});

describe("keys", () => {
  it("types a letter with one keyDown, one char and one keyUp", () => {
    const events = [...keyToLive(key("h", "KeyH"), "keyDown"), ...keyToLive(key("h", "KeyH"), "keyUp")];
    expect(toElectron(events)).toEqual([
      { type: "keyDown", keyCode: "h", modifiers: [] },
      { type: "char", keyCode: "h", modifiers: [] },
      { type: "keyUp", keyCode: "h", modifiers: [] },
    ]);
  });

  it("types a capital with Shift held, on its char too (a keypress reads it), naming the key in lower case", () => {
    expect(toElectron(keyToLive(key("H", "KeyH", { shiftKey: true }), "keyDown"))).toEqual([
      { type: "keyDown", keyCode: "h", modifiers: ["shift"] },
      { type: "char", keyCode: "H", modifiers: ["shift"] },
    ]);
  });

  it("sends Enter's char as a carriage return, so a form submits and a textarea breaks the line", () => {
    expect(toElectron(keyToLive(key("Enter", "Enter"), "keyDown"))).toEqual([
      { type: "keyDown", keyCode: "Enter", modifiers: [] },
      { type: "char", keyCode: "\r", modifiers: [] },
    ]);
  });

  it("keeps Shift on Shift+Enter's char: Chromium breaks the line there, where Enter alone starts a paragraph", () => {
    expect(toElectron(keyToLive(key("Enter", "Enter", { shiftKey: true }), "keyDown"))).toEqual([
      { type: "keyDown", keyCode: "Enter", modifiers: ["shift"] },
      { type: "char", keyCode: "\r", modifiers: ["shift"] },
    ]);
  });

  it("puts no ⌥, ⌘ or Ctrl on a char, whatever the key down holds", () => {
    const chars = (ev: KeyLike) => toElectron(keyToLive(ev, "keyDown")).filter((step) => step.type === "char");
    // ⌥ on a char eats ⌥↵'s line break and makes a form submit a download of the host's (probed, Electron 43).
    expect(chars(key("Enter", "Enter", { altKey: true }))).toEqual([{ type: "char", keyCode: "\r", modifiers: [] }]);
    expect(chars(key("Enter", "Enter", { metaKey: true }))).toEqual([{ type: "char", keyCode: "\r", modifiers: [] }]);
    expect(chars(key("Enter", "Enter", { ctrlKey: true, shiftKey: true }))).toEqual([{ type: "char", keyCode: "\r", modifiers: ["shift"] }]);
    expect(chars(key("Æ", "Quote", { altKey: true, shiftKey: true }))).toEqual([{ type: "char", keyCode: "Æ", modifiers: ["shift"] }]);
    expect(chars(key("@", "KeyQ", { ctrlKey: true, altKey: true }))).toEqual([{ type: "char", keyCode: "@", modifiers: [] }]);
  });

  it("sends editing and navigation keys as key downs alone", () => {
    for (const [domKey, code, electron] of [
      ["Backspace", "Backspace", "Backspace"],
      ["Delete", "Delete", "Delete"],
      ["Tab", "Tab", "Tab"],
      ["Escape", "Escape", "Escape"],
      ["ArrowUp", "ArrowUp", "Up"],
      ["ArrowDown", "ArrowDown", "Down"],
      ["ArrowLeft", "ArrowLeft", "Left"],
      ["ArrowRight", "ArrowRight", "Right"],
      ["PageDown", "PageDown", "PageDown"],
      ["F5", "F5", "F5"],
    ] as const) {
      expect(toElectron(keyToLive(key(domKey, code), "keyDown"))).toEqual([{ type: "keyDown", keyCode: electron, modifiers: [] }]);
    }
  });

  it("says, with Alt held, whether the keyboard is a Mac's (Option types there, a PC's Alt is Meta) — and only then", () => {
    expect(keyToLive(key("@", "KeyL", { altKey: true }), "keyDown", { mac: true })[0]).toEqual({ type: "keyDown", key: "@", code: "KeyL", modifiers: ["alt"], mac: true });
    expect(keyToLive(key("b", "KeyB", { altKey: true }), "keyDown", { mac: false })[0]).toEqual({ type: "keyDown", key: "b", code: "KeyB", modifiers: ["alt"], mac: false });
    expect(keyToLive(key("b", "KeyB"), "keyDown", { mac: true })[0]).toEqual({ type: "keyDown", key: "b", code: "KeyB", modifiers: [] });
    expect(keyToLive(key("b", "KeyB", { altKey: true }), "keyDown")[0]).toEqual({ type: "keyDown", key: "b", code: "KeyB", modifiers: ["alt"] });
    // A page's key down is the same to Chromium whatever it says.
    expect(toElectron(keyToLive(key("@", "KeyL", { altKey: true }), "keyDown", { mac: true }))[0]).toEqual({ type: "keyDown", keyCode: "@", modifiers: ["alt"] });
  });

  it("sends a ⌘ shortcut without typing it", () => {
    expect(toElectron(keyToLive(key("a", "KeyA", { metaKey: true }), "keyDown"))).toEqual([{ type: "keyDown", keyCode: "a", modifiers: ["meta"] }]);
    expect(toElectron(keyToLive(key("k", "KeyK", { ctrlKey: true }), "keyDown"))).toEqual([{ type: "keyDown", keyCode: "k", modifiers: ["control"] }]);
  });

  it("types AltGr and Option characters", () => {
    expect(keyToLive(key("@", "KeyQ", { ctrlKey: true, altKey: true }), "keyDown").map((e) => e.type)).toEqual(["keyDown", "char"]);
    expect(toElectron(keyToLive(key("å", "KeyA", { altKey: true }), "keyDown"))).toEqual([
      { type: "keyDown", keyCode: "a", modifiers: ["alt"] },
      { type: "char", keyCode: "å", modifiers: [] },
    ]);
  });

  it("names space and plus as Electron does, and marks auto-repeat", () => {
    expect(toElectron(keyToLive(key(" ", "Space", { repeat: true }), "keyDown"))).toEqual([
      { type: "keyDown", keyCode: "Space", modifiers: ["isautorepeat"] },
      { type: "char", keyCode: " ", modifiers: [] },
    ]);
    expect(electronKeyCode("+", "Equal")).toBe("Plus");
  });

  it("falls back to the physical key for a character Electron cannot name, and skips what it cannot place", () => {
    expect(electronKeyCode("é", "Digit2")).toBe("2");
    expect(electronKeyCode("ß", "Minus")).toBe("-");
    expect(electronKeyCode("1", "Numpad1")).toBe("1");
    expect(electronKeyCode("ä", "Numpad1")).toBe("num1");
    expect(electronKeyCode("ж", "IntlRo")).toBeNull();
    expect(toElectron(keyToLive(key("ж", "IntlRo"), "keyDown"))).toEqual([{ type: "char", keyCode: "ж", modifiers: [] }]);
  });

  it("names no key after what every object inherits: a guest's '__proto__' or 'toString' is no key, and main never gets a keyCode that is not a string", () => {
    // Electron's sendInputEvent throws "Invalid event object" for a keyCode
    // that is not a string — uncaught, in main's IPC handler.
    for (const name of Object.getOwnPropertyNames(Object.prototype)) {
      expect(electronKeyCode(name, "")).toBeNull();
      expect(electronKeyCode("ж", name)).toBeNull();
      for (const type of ["keyDown", "keyUp"] as const) {
        expect(toElectron([{ type, key: name, code: "", modifiers: [] }])).toEqual([]);
        expect(toElectron([{ type, key: "ж", code: name, modifiers: [] }])).toEqual([]);
      }
    }
  });

  it("sends nothing while an IME composes", () => {
    expect(keyToLive(key("Process", "KeyA"), "keyDown")).toEqual([]);
    expect(keyToLive(key("a", "KeyA", { isComposing: true }), "keyDown")).toEqual([]);
    expect(keyToLive(key("Dead", "Quote"), "keyDown")).toEqual([]);
  });

  it("inserts an emoji as text: a char event carries one UTF-16 unit", () => {
    expect(toElectron(keyToLive(key("👍", ""), "keyDown"))).toEqual([{ type: "insertText", text: "👍" }]);
  });
});

describe("the host's clipboard", () => {
  /**
   * A step Chromium could turn into copy, cut or paste on some platform:
   * Blink's editing key table (Ctrl+C/X/V, Ctrl+Insert, Shift+Insert,
   * Shift+Delete — the last three on macOS too) or the app menu's ⌘C/X/V.
   */
  function clipboardCapable(step: ElectronInputStep): boolean {
    if (step.type !== "keyDown" && step.type !== "keyUp") return false;
    const name = step.keyCode.toLowerCase();
    const held = (modifier: string) => (step.modifiers as string[]).includes(modifier);
    if (name === "insert") return held("shift") || held("control");
    if (name === "delete") return held("shift");
    return ["c", "x", "v"].includes(name) && (held("control") || held("meta"));
  }

  /** A key event as a hostile guest might send it: straight onto the wire, both edges, any modifiers. */
  const pressed = (domKey: string, code: string, modifiers: LiveModifier[]): LiveInputEvent[] => [
    { type: "keyDown", key: domKey, code, modifiers },
    { type: "keyUp", key: domKey, code, modifiers },
  ];

  const chords: Array<[string, LiveInputEvent[]]> = [];
  for (const modifier of ["meta", "control"] as const) {
    for (const letter of ["c", "x", "v", "a"]) {
      chords.push([`${modifier}+${letter}`, pressed(letter, `Key${letter.toUpperCase()}`, [modifier])]);
      chords.push([`${modifier}+shift+${letter}`, pressed(letter.toUpperCase(), `Key${letter.toUpperCase()}`, [modifier, "shift"])]);
    }
  }
  chords.push(
    ["shift+Insert", pressed("Insert", "Insert", ["shift"])],
    ["control+Insert", pressed("Insert", "Insert", ["control"])],
    ["shift+Delete", pressed("Delete", "Delete", ["shift"])],
    ["control+shift+Delete", pressed("Delete", "Delete", ["control", "shift"])],
    // Named oddly, the same keys: a capital, a character on KeyC, Insert on the keypad with Num Lock off.
    ["meta+C", pressed("C", "KeyC", ["meta"])],
    ["control+ç", pressed("ç", "KeyC", ["control", "alt"])],
    ["shift+Insert on the keypad", pressed("Insert", "Numpad0", ["shift"])],
  );

  it.each(chords)("%s gives main no step that copies, cuts or pastes", (_name, events) => {
    expect(toElectron(events).filter(clipboardCapable)).toEqual([]);
  });

  it("still selects all and deletes; plain Insert (overtype) goes nowhere", () => {
    expect(toElectron(pressed("a", "KeyA", ["meta"]))).toEqual([
      { type: "keyDown", keyCode: "a", modifiers: ["meta"] },
      { type: "keyUp", keyCode: "a", modifiers: ["meta"] },
    ]);
    expect(toElectron(keyToLive(key("Delete", "Delete"), "keyDown"))).toEqual([{ type: "keyDown", keyCode: "Delete", modifiers: [] }]);
    expect(toElectron(keyToLive(key("Delete", "Delete", { altKey: true }), "keyDown"))).toEqual([{ type: "keyDown", keyCode: "Delete", modifiers: ["alt"] }]);
    expect(toElectron(pressed("Insert", "Insert", []))).toEqual([]);
  });

  it("names the chords the guest page leaves to its own browser or swallows", () => {
    expect(clipboardChord(key("Insert", "Insert", { shiftKey: true }))).toBe("paste");
    expect(clipboardChord(key("v", "KeyV", { metaKey: true }))).toBe("paste");
    expect(clipboardChord(key("V", "KeyV", { ctrlKey: true, shiftKey: true }))).toBe("paste");
    expect(clipboardChord(key("Insert", "Insert", { ctrlKey: true }))).toBe("copy");
    expect(clipboardChord(key("c", "KeyC", { metaKey: true }))).toBe("copy");
    expect(clipboardChord(key("Delete", "Delete", { shiftKey: true }))).toBe("cut");
    expect(clipboardChord(key("x", "KeyX", { ctrlKey: true }))).toBe("cut");
    for (const plain of [key("a", "KeyA", { metaKey: true }), key("Delete", "Delete"), key("Insert", "Insert"), key("c", "KeyC")]) expect(clipboardChord(plain)).toBeNull();
  });
});

describe("text", () => {
  it("pastes as insertText in pieces of at most 2000, never splitting a character", () => {
    const text = `${"a".repeat(1999)}🦊${"b".repeat(10)}`;
    const events = textToLive(text);
    expect(events.map((e) => e.type === "insertText" && e.text.length)).toEqual([1999, 12]);
    expect(events.map((e) => (e.type === "insertText" ? e.text : "")).join("")).toBe(text);
    expect(toElectron(events)).toEqual(events);
    expect(textToLive("")).toEqual([]);
  });

  it("never splits a CRLF: one line break, which a terminal's paste would make two", () => {
    const text = `${"a".repeat(1999)}\r\nnext`;
    const events = textToLive(text);
    expect(events.map((e) => (e.type === "insertText" ? e.text : ""))).toEqual(["a".repeat(1999), "\r\nnext"]);
  });
});
