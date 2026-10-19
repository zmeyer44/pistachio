/**
 * A guest's hands on a host's window (docs/live-share.md §4 Input, §6.1, §7).
 *
 * Two halves, both pure. The guest turns DOM events on a window's page box
 * into `LiveInputEvent`s (page-normalized, clamped); main turns each one into
 * the plain objects `webContents.sendInputEvent` takes, in the tab view's
 * DIPs. The Electron shapes are declared here, not imported, so the package
 * stays free of Electron.
 *
 * Typing has one path. `keyToLive` sends a `keyDown`, then — exactly when
 * the DOM would fire `keypress` (a printable character, or Enter) — a `char`
 * with the text (and Shift, if held), then on release a `keyUp`.
 * `toElectronInputEvents` maps each event to its Electron twin one for one
 * and never makes a `char` up: an Electron `keyDown` is Chromium's raw key
 * down (key handlers, editing commands like Backspace and the arrows), and
 * only a `char` inserts text or submits a form, so the guest's char is the
 * only thing that types.
 */

import type { ClientBox } from "./geometry.js";
import {
  MAX_INSERT_TEXT_LENGTH,
  MAX_WHEEL_DELTA,
  isOneGrapheme,
  type LiveInputEvent,
  type LiveModifier,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// DOM → live (the guest)
// ---------------------------------------------------------------------------

/** What the helpers read from a DOM event; real events fit, tests pass plain objects. */
export interface ModifierLike {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface PointerLike extends ModifierLike {
  clientX: number;
  clientY: number;
  /** DOM `button`: 0 left, 1 middle, 2 right. */
  button: number;
  /** DOM `buttons`: 1 left, 2 right, 4 middle. */
  buttons: number;
}

export interface WheelLike extends ModifierLike {
  clientX: number;
  clientY: number;
  deltaX: number;
  deltaY: number;
  /** 0 pixels, 1 lines, 2 pages. */
  deltaMode: number;
}

export interface KeyLike extends ModifierLike {
  key: string;
  code: string;
  repeat: boolean;
  isComposing?: boolean;
}

export type LivePointerType = "mouseDown" | "mouseUp" | "mouseMove";

/** Chromium scrolls 40 px per wheel line. */
const PIXELS_PER_LINE = 40;

const DOM_BUTTONS = ["left", "middle", "right"] as const;

const clampUnit = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
const clamp = (value: number, limit: number): number => (value < -limit ? -limit : value > limit ? limit : value);

/** The held modifiers of a DOM event. */
export function modifiersOf(ev: ModifierLike): LiveModifier[] {
  const out: LiveModifier[] = [];
  if (ev.shiftKey) out.push("shift");
  if (ev.ctrlKey) out.push("control");
  if (ev.altKey) out.push("alt");
  if (ev.metaKey) out.push("meta");
  return out;
}

function pagePoint(box: ClientBox, clientX: number, clientY: number): { x: number; y: number } {
  if (box.width <= 0 || box.height <= 0) return { x: 0, y: 0 };
  return { x: clampUnit((clientX - box.left) / box.width), y: clampUnit((clientY - box.top) / box.height) };
}

/**
 * A pointer event over a window's page element as a live mouse event. A press
 * or release of a button other than left, middle or right (back, forward) is
 * null. Pointer events carry no click count (`detail` is 0 on pointerdown),
 * so the caller passes the one its `ClickCounter` gave the press.
 */
export function pointerToLive(ev: PointerLike, pageBox: ClientBox, type: LivePointerType, clickCount = 0): LiveInputEvent | null {
  const { x, y } = pagePoint(pageBox, ev.clientX, ev.clientY);
  const buttons = ev.buttons & 7;
  let button: (typeof DOM_BUTTONS)[number] | undefined;
  if (type === "mouseMove") {
    button = buttons & 1 ? "left" : buttons & 2 ? "right" : buttons & 4 ? "middle" : undefined;
  } else {
    button = DOM_BUTTONS[ev.button];
    if (button === undefined) return null;
  }
  return {
    type,
    x,
    y,
    ...(button === undefined ? {} : { button }),
    buttons,
    clickCount: type === "mouseMove" ? 0 : Math.max(1, Math.min(3, Math.round(clickCount))),
    modifiers: modifiersOf(ev),
  };
}

/** A wheel event over a window's page element; deltas in CSS px, clamped. */
export function wheelToLive(ev: WheelLike, pageBox: ClientBox): LiveInputEvent {
  const { x, y } = pagePoint(pageBox, ev.clientX, ev.clientY);
  const unit = ev.deltaMode === 1 ? PIXELS_PER_LINE : ev.deltaMode === 2 ? Math.max(1, pageBox.height) : 1;
  return {
    type: "wheel",
    x,
    y,
    dx: clamp(ev.deltaX * unit, MAX_WHEEL_DELTA),
    dy: clamp(ev.deltaY * unit, MAX_WHEEL_DELTA),
    modifiers: modifiersOf(ev),
  };
}

/**
 * Whether a key press types its `key`: what fires `keypress` in a browser.
 * A printable grapheme without ⌘ or Ctrl (Ctrl+Alt is AltGr on Windows and
 * types), or Enter.
 */
function typedText(ev: KeyLike): string | null {
  if (ev.key === "Enter") return "\r";
  if (ev.metaKey || (ev.ctrlKey && !ev.altKey)) return null;
  if (!isOneGrapheme(ev.key) || /\p{Cc}/u.test(ev.key)) return null;
  return ev.key;
}

/**
 * A key event as live events: a press is `keyDown` (+ `char` when it types),
 * a release `keyUp`. Nothing while an IME composes — its result arrives as
 * `insertText` from the composition's end. The char keeps Shift alone of
 * what is held (§4): Chromium breaks a line on Shift+Enter's char, where
 * Enter's starts a paragraph; ⌥, ⌘ and Ctrl stay on the key down.
 */
export function keyToLive(ev: KeyLike, type: "keyDown" | "keyUp"): LiveInputEvent[] {
  if (ev.isComposing === true || ev.key === "Process" || ev.key === "Dead" || ev.key === "Unidentified") return [];
  const key = ev.key.slice(0, 32);
  const code = ev.code.slice(0, 32);
  const modifiers = modifiersOf(ev);
  if (type === "keyUp") return [{ type: "keyUp", key, code, modifiers }];
  const events: LiveInputEvent[] = [{ type: "keyDown", key, code, modifiers, ...(ev.repeat ? { repeat: true } : {}) }];
  const text = typedText(ev);
  if (text !== null) events.push(ev.shiftKey ? { type: "char", text, modifiers: ["shift"] } : { type: "char", text });
  return events;
}

/** Pasted or composed text as `insertText` events of at most 2000 characters, never splitting a character. */
export function textToLive(text: string): LiveInputEvent[] {
  const events: LiveInputEvent[] = [];
  let chunk = "";
  for (const point of text) {
    if (chunk.length + point.length > MAX_INSERT_TEXT_LENGTH) {
      events.push({ type: "insertText", text: chunk });
      chunk = "";
    }
    chunk += point;
  }
  if (chunk.length > 0) events.push({ type: "insertText", text: chunk });
  return events;
}

/**
 * Click counts for pointer events (which carry none): a press within 500 ms
 * and 4 px of the last one, with the same button, counts up to 3 (a triple
 * click selects a paragraph); the release reports its press's count.
 */
export class ClickCounter {
  readonly #intervalMs: number;
  readonly #slopPx: number;
  #last: { x: number; y: number; button: number; at: number; count: number } | null = null;

  constructor(intervalMs = 500, slopPx = 4) {
    this.#intervalMs = intervalMs;
    this.#slopPx = slopPx;
  }

  /** The count for a press at `at` (ms, e.g. `event.timeStamp`). */
  press(ev: { clientX: number; clientY: number; button: number }, at: number): number {
    const last = this.#last;
    const near =
      last !== null &&
      last.button === ev.button &&
      at - last.at <= this.#intervalMs &&
      Math.abs(ev.clientX - last.x) <= this.#slopPx &&
      Math.abs(ev.clientY - last.y) <= this.#slopPx;
    const count = near ? Math.min(3, last.count + 1) : 1;
    this.#last = { x: ev.clientX, y: ev.clientY, button: ev.button, at, count };
    return count;
  }

  /** The count the last press had (for its release). */
  release(): number {
    return this.#last?.count ?? 1;
  }
}

// ---------------------------------------------------------------------------
// live → Electron (main)
// ---------------------------------------------------------------------------

/** Electron's `InputEvent.modifiers` names (lower case, as its typings spell them). */
export type ElectronModifier =
  | "shift"
  | "control"
  | "alt"
  | "meta"
  | "isautorepeat"
  | "leftbuttondown"
  | "middlebuttondown"
  | "rightbuttondown";

/** Electron's `MouseInputEvent`, as far as live share uses it. */
export interface ElectronMouseInputEvent {
  type: "mouseDown" | "mouseUp" | "mouseMove";
  x: number;
  y: number;
  button?: "left" | "middle" | "right";
  clickCount?: number;
  modifiers: ElectronModifier[];
}

/** Electron's `MouseWheelInputEvent`, as far as live share uses it. */
export interface ElectronMouseWheelInputEvent {
  type: "mouseWheel";
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  hasPreciseScrollingDeltas: boolean;
  canScroll: boolean;
  modifiers: ElectronModifier[];
}

/** Electron's `KeyboardInputEvent`: `keyCode` is an accelerator key name or the character. */
export interface ElectronKeyboardInputEvent {
  type: "keyDown" | "keyUp" | "char";
  keyCode: string;
  modifiers: ElectronModifier[];
}

/** Not an input event: text for `webContents.insertText` (a paste, an IME commit, a character a `char` cannot carry). */
export interface ElectronInsertText {
  type: "insertText";
  text: string;
}

export type ElectronInputEvent = ElectronMouseInputEvent | ElectronMouseWheelInputEvent | ElectronKeyboardInputEvent;

/**
 * One step for main: `sendInputEvent(step)` for an input event,
 * `insertText(step.text)` for `insertText`.
 */
export type ElectronInputStep = ElectronInputEvent | ElectronInsertText;

/** DOM `key` → Electron key name, for keys that are not their own character. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Enter: "Enter",
  Backspace: "Backspace",
  Tab: "Tab",
  Escape: "Escape",
  " ": "Space",
  "+": "Plus",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  CapsLock: "Capslock",
  NumLock: "Numlock",
  ScrollLock: "Scrolllock",
  PrintScreen: "PrintScreen",
  Shift: "Shift",
  Control: "Control",
  Alt: "Alt",
  Meta: "Meta",
  AudioVolumeUp: "VolumeUp",
  AudioVolumeDown: "VolumeDown",
  AudioVolumeMute: "VolumeMute",
  MediaPlayPause: "MediaPlayPause",
  MediaTrackNext: "MediaNextTrack",
  MediaTrackPrevious: "MediaPreviousTrack",
  MediaStop: "MediaStop",
};

/** DOM `code` → Electron key name, for a key whose `key` Electron cannot name (é on a French layout is KeyE's). */
const CODE_KEYS: Readonly<Record<string, string>> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: "Space",
  NumpadDecimal: "numdec",
  NumpadAdd: "numadd",
  NumpadSubtract: "numsub",
  NumpadMultiply: "nummult",
  NumpadDivide: "numdiv",
  NumpadEnter: "Enter",
};

/**
 * A table's own entry for a name a guest sent. A guest's "__proto__" or
 * "toString" would find what every object inherits, and a keyCode that is
 * not a string makes `sendInputEvent` throw in main.
 */
function entry(table: Readonly<Record<string, string>>, name: string): string | null {
  return Object.hasOwn(table, name) ? (table[name] ?? null) : null;
}

/**
 * The Electron key name for a DOM key, or null when there is none (the key
 * down is then not sent; a `char` still types the character).
 */
export function electronKeyCode(key: string, code: string): string | null {
  const named = entry(NAMED_KEYS, key);
  if (named !== null) return named;
  if (/^F([1-9]|1\d|2[0-4])$/.test(key)) return key;
  // One printable ASCII character is its own name. Letters go lower case:
  // Electron reads an upper-case letter as Shift held, and our modifiers
  // already say whether it is (Caps Lock types "A" without Shift).
  if (/^[\x21-\x7e]$/.test(key)) return /[A-Z]/.test(key) ? key.toLowerCase() : key;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter?.[1] !== undefined) return letter[1].toLowerCase();
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code);
  if (digit?.[1] !== undefined) return code.startsWith("Numpad") ? `num${digit[1]}` : digit[1];
  return entry(CODE_KEYS, code);
}

/**
 * What a key chord does to a clipboard in a browser, if anything: ⌘ or Ctrl
 * with C, X or V, and the old IBM chords — Shift+Insert pastes, Ctrl+Insert
 * copies, Shift+Delete cuts. Blink runs those three on every platform, macOS
 * included, even for `sendInputEvent`'s key downs (probed, Electron 43:
 * Shift+Insert typed the host's clipboard into a page), so no guest's key
 * may be one of them on the host.
 */
export function clipboardChord(ev: Pick<KeyLike, "key" | "shiftKey" | "ctrlKey" | "metaKey">): "copy" | "cut" | "paste" | null {
  if (ev.key === "Insert") return ev.shiftKey ? "paste" : ev.ctrlKey ? "copy" : null;
  if (ev.key === "Delete") return ev.shiftKey ? "cut" : null;
  if (!ev.metaKey && !ev.ctrlKey) return null;
  switch (ev.key.toLowerCase()) {
    case "c":
      return "copy";
    case "x":
      return "cut";
    case "v":
      return "paste";
    default:
      return null;
  }
}

/**
 * Whether main refuses a key event outright: Insert with any modifiers
 * (nothing on a Mac keyboard has it, and every chord with it is a clipboard
 * command or overtype), Delete with Shift (cut), and C, X or V with ⌘ or
 * Ctrl. Judged on the Electron key name, so a key the guest names oddly
 * ("C", or "ç" on KeyC) is caught all the same. Plain Delete still deletes.
 */
function refusedKey(keyCode: string, modifiers: readonly ElectronModifier[]): boolean {
  if (keyCode === "Insert") return true;
  if (keyCode === "Delete") return modifiers.includes("shift");
  return (keyCode === "c" || keyCode === "x" || keyCode === "v") && (modifiers.includes("meta") || modifiers.includes("control"));
}

/** At most `max` UTF-16 units, never ending on half a surrogate pair. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

const MODIFIER_NAMES: Readonly<Record<LiveModifier, ElectronModifier>> = {
  shift: "shift",
  control: "control",
  alt: "alt",
  meta: "meta",
};

function electronModifiers(modifiers: readonly LiveModifier[]): ElectronModifier[] {
  return [...new Set(modifiers)].map((modifier) => MODIFIER_NAMES[modifier]);
}

function buttonModifiers(buttons: number): ElectronModifier[] {
  const out: ElectronModifier[] = [];
  if (buttons & 1) out.push("leftbuttondown");
  if (buttons & 2) out.push("rightbuttondown");
  if (buttons & 4) out.push("middlebuttondown");
  return out;
}

/** A page-normalized point in the view's DIPs, inside the view. */
function viewPoint(x: number, y: number, viewSize: { width: number; height: number }): { x: number; y: number } {
  const width = Math.max(1, Math.floor(viewSize.width));
  const height = Math.max(1, Math.floor(viewSize.height));
  return {
    x: Math.min(width - 1, Math.max(0, Math.round(clampUnit(x) * width))),
    y: Math.min(height - 1, Math.max(0, Math.round(clampUnit(y) * height))),
  };
}

/**
 * One live event as what main hands Electron, in the tab view's DIPs
 * (`viewSize` is the view's bounds; under desk zoom Chromium maps DIPs to the
 * emulated page itself). Pure, so main imports it with Electron nowhere in
 * this package; everything is clamped again here — the guest is not trusted —
 * and a clipboard chord becomes nothing (`clipboardChord`).
 */
export function toElectronInputEvents(ev: LiveInputEvent, viewSize: { width: number; height: number }): ElectronInputStep[] {
  switch (ev.type) {
    case "mouseMove":
    case "mouseDown":
    case "mouseUp": {
      const point = viewPoint(ev.x, ev.y, viewSize);
      const out: ElectronMouseInputEvent = {
        type: ev.type,
        ...point,
        modifiers: [...electronModifiers(ev.modifiers), ...buttonModifiers(ev.buttons)],
      };
      if (ev.button !== undefined) out.button = ev.button;
      if (ev.type !== "mouseMove") out.clickCount = Math.max(1, Math.min(3, ev.clickCount));
      return [out];
    }
    case "wheel": {
      // Chromium's wheel deltas point the other way from the DOM's: a positive
      // DOM deltaY scrolls the page down, a positive Chromium deltaY scrolls it
      // up (the content follows the fingers). So both deltas are negated.
      return [
        {
          type: "mouseWheel",
          ...viewPoint(ev.x, ev.y, viewSize),
          deltaX: -clamp(ev.dx, MAX_WHEEL_DELTA),
          deltaY: -clamp(ev.dy, MAX_WHEEL_DELTA),
          hasPreciseScrollingDeltas: true,
          canScroll: true,
          modifiers: electronModifiers(ev.modifiers),
        },
      ];
    }
    case "keyDown":
    case "keyUp": {
      const keyCode = electronKeyCode(ev.key, ev.code);
      if (keyCode === null) return [];
      const modifiers = electronModifiers(ev.modifiers);
      // The host's clipboard is never read or written for a guest (§10).
      if (refusedKey(keyCode, modifiers)) return [];
      if (ev.type === "keyDown" && ev.repeat === true) modifiers.push("isautorepeat");
      return [{ type: ev.type, keyCode, modifiers }];
    }
    case "char": {
      // A char event carries one UTF-16 unit; a character outside the basic
      // plane (most emoji) or a cluster of several is inserted as text.
      if (ev.text.length === 1) return [{ type: "char", keyCode: ev.text, modifiers: electronModifiers(ev.modifiers ?? []) }];
      return [{ type: "insertText", text: ev.text }];
    }
    case "insertText":
      return [{ type: "insertText", text: truncate(ev.text, MAX_INSERT_TEXT_LENGTH) }];
  }
}
