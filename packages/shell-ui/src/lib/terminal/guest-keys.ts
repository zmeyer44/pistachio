/**
 * A live share guest's keys on a terminal the host let them use
 * (docs/live-share.md §6.6), said to its program as the host's own are: each
 * encoded by xterm.js's keyboard service — the cursor keys' mode, the kitty
 * keyboard protocol a program turned on, Ctrl's control characters — fed a
 * key made from the guest's (the fields it reads of a KeyboardEvent). Never
 * an event sent through the shell's page: its key handlers there (a menu's
 * Escape, the desk's Shift, the Bar's) are the host's.
 */

import type { Terminal } from "@xterm/xterm";
import type { LiveKeyModifier } from "@pistachio/shell-contracts/live-share";

/** xterm.js's keyboard service: its core's, which no public API exposes (xterm.js is pinned, docs/terminal.md §2). */
interface XtermKeyboard {
  evaluateKeyDown(event: KeyboardEvent): { type: number; key?: string | undefined };
  evaluateKeyUp(event: KeyboardEvent): { key?: string | undefined } | undefined;
}

/** xterm.js's KeyboardResultType PAGE_UP and PAGE_DOWN (common/Types.ts): Shift+PageUp and Shift+PageDown page through the scrollback. */
const PAGE_UP = 2;
const PAGE_DOWN = 3;

function keyboardOf(term: Terminal): XtermKeyboard | null {
  const service = (term as unknown as { _core?: { _keyboardService?: Partial<XtermKeyboard> } })._core?._keyboardService;
  return typeof service?.evaluateKeyDown === "function" && typeof service.evaluateKeyUp === "function" ? (service as XtermKeyboard) : null;
}

/** The legacy keyCode of a key by its physical key, as Chromium gives it on a US layout: xterm.js reads it for all but the kitty protocol's keys. */
const KEY_CODES: Readonly<Record<string, number>> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  NumpadEnter: 13,
  ShiftLeft: 16,
  ShiftRight: 16,
  ControlLeft: 17,
  ControlRight: 17,
  AltLeft: 18,
  AltRight: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  MetaLeft: 91,
  MetaRight: 93,
  NumpadMultiply: 106,
  NumpadAdd: 107,
  NumpadSubtract: 109,
  NumpadDecimal: 110,
  NumpadDivide: 111,
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
};

/** The same, for a key a guest's page sent without its physical key: by the key's name. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  Shift: "ShiftLeft",
  Control: "ControlLeft",
  Alt: "AltLeft",
  Meta: "MetaLeft",
  " ": "Space",
};

export function keyCodeOf(key: string, code: string): number {
  // A letter by the letter it types, wherever it is, as Chromium's keyCode is: AZERTY's A is on Q's key and its M on the
  // semicolon's, and Ctrl+A is still ^A, Ctrl+M Enter.
  if (/^[a-z]$/iu.test(key)) return key.toUpperCase().charCodeAt(0);
  const known = KEY_CODES[code] ?? KEY_CODES[NAMED_KEYS[key] ?? key];
  if (known !== undefined) return known;
  // A key that types none of the Latin letters (a Cyrillic layout's) by where it is.
  const letter = /^Key([A-Z])$/u.exec(code)?.[1];
  if (letter !== undefined) return letter.charCodeAt(0);
  const digit = /^(?:Digit|Numpad)([0-9])$/u.exec(code);
  if (digit !== null) return (code.startsWith("Numpad") ? 96 : 48) + Number(digit[1]);
  if (code === "" && /^[0-9]$/u.test(key)) return 48 + Number(key);
  const fn = /^F([0-9]{1,2})$/u.exec(code) ?? /^F([0-9]{1,2})$/u.exec(key);
  if (fn !== null && Number(fn[1]) >= 1 && Number(fn[1]) <= 24) return 111 + Number(fn[1]);
  return 0;
}

/** A guest's key as xterm.js reads a KeyboardEvent: what it is, where it is on the keyboard, what is held. */
export function guestKeyEvent(type: "keydown" | "keyup", key: { key: string; code: string; modifiers: readonly LiveKeyModifier[]; repeat?: boolean }): KeyboardEvent {
  const keyCode = keyCodeOf(key.key, key.code);
  const held = { shiftKey: key.modifiers.includes("shift"), ctrlKey: key.modifiers.includes("control"), altKey: key.modifiers.includes("alt"), metaKey: key.modifiers.includes("meta") };
  const modifier: Readonly<Record<string, boolean>> = { Shift: held.shiftKey, Control: held.ctrlKey, Alt: held.altKey, Meta: held.metaKey };
  const event = {
    type,
    key: key.key,
    code: key.code,
    keyCode,
    which: keyCode,
    charCode: 0,
    location: 0,
    repeat: key.repeat === true,
    isComposing: false,
    ...held,
    defaultPrevented: false,
    getModifierState: (name: string): boolean => modifier[name] ?? false,
    preventDefault(): void {
      event.defaultPrevented = true;
    },
    stopPropagation: (): void => undefined,
  };
  return event as unknown as KeyboardEvent;
}

/**
 * What a guest's key down says to the terminal's program: its bytes, as
 * xterm.js encodes the host's; a page of the scrollback (Shift+PageUp, -1, or
 * Shift+PageDown, 1); or `"typed"` — what it says is the character it types
 * (the guest's char brings it), as xterm.js takes it from the key's keypress:
 * Option's character on a Mac (Option types, not Meta, docs/terminal.md §1),
 * AltGr's on a Windows guest's keyboard, or a key it has no bytes for.
 *
 * Alt that made no character of its own — a Linux or Windows guest's Alt+B,
 * Ctrl+Alt+X — is Meta, as it is to xterm.js off a Mac: where xterm.js on
 * this Mac has no bytes for it (Option is not Meta here), ESC and the key's
 * bytes without Alt (ESC b, ESC ^X). Which Alt it is the guest's page says
 * (`guestMac`, a keyDown's `mac`): a Mac's Option types whatever it makes,
 * ASCII or not (German Option+L's @, British Option+3's #), a PC's Alt never
 * does; a page that does not say is taken at its character — past ASCII,
 * Option's.
 */
export function guestKeyDown(term: Terminal, event: KeyboardEvent, mac: boolean, guestMac?: boolean): { data: string } | { page: -1 | 1 } | "typed" {
  const keyboard = keyboardOf(term);
  if (keyboard === null) return "typed";
  const result = keyboard.evaluateKeyDown(event);
  if (result.type === PAGE_UP || result.type === PAGE_DOWN) return { page: result.type === PAGE_UP ? -1 : 1 };
  if (event.altKey && !event.metaKey) {
    // A character of Alt's own types it, as xterm.js's third-level shift takes it, whichever protocol is on: Option's on a
    // Mac guest's keyboard (Option types here, as on this Mac), AltGr's (a Windows guest's browser says Ctrl+Alt: German
    // AltGr+Q's @, AZERTY's AltGr+E €) — never a letter's or a digit's under AltGr, nor a named key's (the arrows, Backspace).
    const optionTypes = mac && term.options.macOptionIsMeta !== true && guestMac !== false;
    const own = event.ctrlKey ? altGraphText(event.key) : optionTypes && (guestMac === true ? printableText(event.key) : optionText(event.key));
    if (own) return "typed";
    if (result.key === undefined || result.key === "") {
      const bare = keyboard.evaluateKeyDown(withoutAlt(event)).key;
      if (bare !== undefined && bare !== "") return { data: `\x1b${bare}` };
    }
  }
  return result.key === undefined || result.key === "" ? "typed" : { data: result.key };
}

/** A character AltGr types: one, printable, not a space, and not a Latin letter or a digit (which Ctrl+Alt keeps as the key's). */
function altGraphText(key: string): boolean {
  return printableText(key) && !/^[a-z0-9]$/iu.test(key);
}

/** One character, printable, not a space: what a key types, not a named key's name (ArrowLeft, Backspace). */
function printableText(key: string): boolean {
  return [...key].length === 1 && !/[\p{Cc}\s]/u.test(key);
}

/** A character Option types on a Mac's keyboard, as far as it shows: past ASCII (Alt that leaves an ASCII one is taken for a PC's, Meta). */
function optionText(key: string): boolean {
  return printableText(key) && key.codePointAt(0)! > 0x7e;
}

/** The same key with Alt let go. */
function withoutAlt(event: KeyboardEvent): KeyboardEvent {
  const modifiers: LiveKeyModifier[] = [];
  if (event.shiftKey) modifiers.push("shift");
  if (event.ctrlKey) modifiers.push("control");
  if (event.metaKey) modifiers.push("meta");
  return guestKeyEvent("keydown", { key: event.key, code: event.code, modifiers, repeat: event.repeat });
}

/** What a guest's key up says: a release, to a program that asked the kitty protocol for them; else nothing. */
export function guestKeyUp(term: Terminal, event: KeyboardEvent): string | null {
  const key = keyboardOf(term)?.evaluateKeyUp(event)?.key;
  return key === undefined || key === "" ? null : key;
}

/**
 * A guest's paste as xterm.js pastes the host's (browser/Clipboard.ts): its
 * line breaks as Enter, and bracketed for a program that asked — every ESC in
 * it shown as ␛, so no text pasted can end the bracket early (a shell then
 * runs none of it before Enter).
 */
export function guestPaste(term: Terminal, text: string): string {
  const typed = text.replace(/\r?\n/gu, "\r");
  return term.modes.bracketedPasteMode ? `\x1b[200~${typed.replaceAll("\x1b", "\u241b")}\x1b[201~` : typed;
}
