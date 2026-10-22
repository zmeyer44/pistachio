/**
 * A live share guest's keys on a terminal (lib/terminal/guest-keys.ts,
 * docs/live-share.md §6.6): encoded by the pinned xterm.js's own keyboard
 * service, as the host's are — Ctrl's control characters, the cursor keys'
 * mode, the kitty keyboard protocol a program turns on, Option typing its
 * character on a Mac — and a paste bracketed for a program that asks.
 */

import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import type { LiveKeyModifier } from "@pistachio/shell-contracts/live-share";
import { guestKeyDown, guestKeyEvent, guestKeyUp, guestPaste, keyCodeOf } from "../src/lib/terminal/guest-keys";

function terminal(): Terminal {
  // As the shell's (lib/terminal/sessions.ts): the kitty protocol there for a program to turn on, Option typing.
  return new Terminal({ allowProposedApi: true, macOptionIsMeta: false, vtExtensions: { kittyKeyboard: true } });
}

const written = (term: Terminal, data: string): Promise<void> => new Promise((done) => term.write(data, done));

const down = (term: Terminal, key: string, code: string, modifiers: LiveKeyModifier[] = []) => guestKeyDown(term, guestKeyEvent("keydown", { key, code, modifiers }), true);

describe("a guest's keys on a terminal", () => {
  it("knows each key's legacy keyCode by where it is on the keyboard, or by its name where the guest's page sent none", () => {
    expect(keyCodeOf("a", "KeyA")).toBe(65);
    expect(keyCodeOf("A", "KeyA")).toBe(65);
    expect(keyCodeOf("!", "Digit1")).toBe(49);
    expect(keyCodeOf("ArrowUp", "ArrowUp")).toBe(38);
    expect(keyCodeOf("Enter", "NumpadEnter")).toBe(13);
    expect(keyCodeOf("F5", "F5")).toBe(116);
    expect(keyCodeOf("-", "Minus")).toBe(189);
    expect(keyCodeOf("Escape", "")).toBe(27);
    expect(keyCodeOf(" ", "")).toBe(32);
    expect(keyCodeOf("q", "")).toBe(81);
    expect(keyCodeOf("é", "")).toBe(0);
    // A letter by the letter it types, as Chromium's keyCode is: AZERTY's A is on Q's key. A key typing no Latin letter (a
    // Cyrillic layout's с) by where it is.
    expect(keyCodeOf("a", "KeyQ")).toBe(65);
    expect(keyCodeOf("m", "Semicolon")).toBe(77);
    expect(keyCodeOf(";", "Semicolon")).toBe(186);
    expect(keyCodeOf("с", "KeyC")).toBe(67);
  });

  it("says what xterm.js says for the host's: the character, Enter, Backspace, Ctrl's control characters, the arrows", () => {
    const term = terminal();
    expect(down(term, "a", "KeyA")).toEqual({ data: "a" });
    expect(down(term, "A", "KeyA", ["shift"])).toEqual({ data: "A" });
    expect(down(term, "Enter", "Enter")).toEqual({ data: "\r" });
    expect(down(term, "Backspace", "Backspace")).toEqual({ data: "\x7f" });
    expect(down(term, "Tab", "Tab")).toEqual({ data: "\t" });
    expect(down(term, "Escape", "Escape")).toEqual({ data: "\x1b" });
    expect(down(term, "c", "KeyC", ["control"])).toEqual({ data: "\x03" });
    expect(down(term, "d", "KeyD", ["control"])).toEqual({ data: "\x04" });
    // AZERTY's Ctrl+A (on Q's key) is ^A, not ^Q; its Ctrl+M (on the semicolon's) Enter, not nothing.
    expect(down(term, "a", "KeyQ", ["control"])).toEqual({ data: "\x01" });
    expect(down(term, "m", "Semicolon", ["control"])).toEqual({ data: "\r" });
    expect(down(term, "ArrowUp", "ArrowUp")).toEqual({ data: "\x1b[A" });
    expect(down(term, "ArrowLeft", "ArrowLeft")).toEqual({ data: "\x1b[D" });
    // Shift on the page keys pages the scrollback, as it does the host's.
    expect(down(term, "PageUp", "PageUp", ["shift"])).toEqual({ page: -1 });
    expect(down(term, "PageDown", "PageDown", ["shift"])).toEqual({ page: 1 });
  });

  it("follows the modes a program turns on: application cursor keys, then the kitty keyboard protocol", async () => {
    const term = terminal();
    await written(term, "\x1b[?1h");
    expect(down(term, "ArrowUp", "ArrowUp")).toEqual({ data: "\x1bOA" });
    // (CSI > 1 u: disambiguate escape codes, as Claude Code and Neovim ask.)
    await written(term, "\x1b[>1u");
    expect(down(term, "Escape", "Escape")).toEqual({ data: "\x1b[27u" });
    expect(down(term, "c", "KeyC", ["control"])).toEqual({ data: "\x1b[99;5u" });
    expect(down(term, "a", "KeyA")).toEqual({ data: "a" });
    // A release only to a program that asked for them (CSI = 3 u: report event types too).
    expect(guestKeyUp(term, guestKeyEvent("keyup", { key: "a", code: "KeyA", modifiers: [] }))).toBeNull();
    await written(term, "\x1b[=3u");
    expect(guestKeyUp(term, guestKeyEvent("keyup", { key: "a", code: "KeyA", modifiers: [] }))).toBe("\x1b[97;1:3u");
  });

  it("leaves Option's character on a Mac to the guest's char, as xterm.js leaves it to the keypress — not on Backspace", () => {
    const term = terminal();
    expect(down(term, "é", "KeyE", ["alt"])).toBe("typed");
    expect(down(term, "Backspace", "Backspace", ["alt"])).toEqual({ data: "\x1b\x7f" });
    // A key xterm.js has nothing for is the character it types, if any.
    expect(down(term, "Shift", "ShiftLeft", ["shift"])).toBe("typed");
  });

  it("leaves AltGr's character to the guest's char — a Windows guest's Ctrl+Alt — in the kitty protocol too; a letter's Ctrl+Alt stays a chord", async () => {
    const term = terminal();
    // German AltGr+Q: @. AZERTY's AltGr+E: €.
    expect(down(term, "@", "KeyQ", ["control", "alt"])).toBe("typed");
    expect(down(term, "€", "KeyE", ["control", "alt"])).toBe("typed");
    expect(down(term, "x", "KeyX", ["control", "alt"])).toEqual({ data: "\x1b\x18" });
    await written(term, "\x1b[>1u");
    expect(down(term, "@", "KeyQ", ["control", "alt"])).toBe("typed");
    expect(down(term, "x", "KeyX", ["control", "alt"])).toEqual({ data: "\x1b[120;7u" });
  });

  it("makes a PC's Alt Meta where xterm.js on a Mac has no bytes for it (Option not Meta there): ESC and the key's bytes", () => {
    // (Node is no Mac to xterm.js: its keyboard service is stood in for as it is on one — no bytes for Alt in the legacy
    // encoding, which leaves Option to type.)
    const real = terminal();
    const keyboard = (real as unknown as { _core: { _keyboardService: { evaluateKeyDown(event: KeyboardEvent): { type: number; key?: string } } } })._core._keyboardService;
    const onAMac = {
      _core: {
        _keyboardService: {
          evaluateKeyDown: (event: KeyboardEvent) => (event.altKey && !event.metaKey ? { type: 0, key: undefined } : keyboard.evaluateKeyDown(event)),
          evaluateKeyUp: () => undefined,
        },
      },
      options: real.options,
      modes: real.modes,
    } as unknown as Terminal;
    const press = (key: string, code: string, modifiers: LiveKeyModifier[], guestMac?: boolean) => guestKeyDown(onAMac, guestKeyEvent("keydown", { key, code, modifiers }), true, guestMac);
    // A Linux guest's Alt+B (a word back in a shell) and Ctrl+Alt+X (Emacs's C-M-x): ESC b, ESC ^X.
    expect(press("b", "KeyB", ["alt"])).toEqual({ data: "\x1bb" });
    expect(press("x", "KeyX", ["control", "alt"])).toEqual({ data: "\x1b\x18" });
    expect(press(".", "Period", ["alt"])).toEqual({ data: "\x1b." });
    // A Mac guest's Option+B is ∫, and AltGr's @ a Windows guest's: typed.
    expect(press("∫", "KeyB", ["alt"])).toBe("typed");
    expect(press("@", "KeyQ", ["control", "alt"])).toBe("typed");
    // The guest's page says which Alt it is: a Mac's Option types what it makes, ASCII too (German Option+L's @, British
    // Option+3's #); a PC's Alt is Meta whatever it makes.
    expect(press("@", "KeyL", ["alt"], true)).toBe("typed");
    expect(press("#", "Digit3", ["alt"], true)).toBe("typed");
    expect(press("@", "KeyL", ["alt"])).toEqual({ data: "\x1b@" });
    expect(press(".", "Period", ["alt"], false)).toEqual({ data: "\x1b." });
    expect(press("é", "KeyE", ["alt"], false)).toEqual({ data: "\x1bé" });
    // (Named keys are no characters: Option+Backspace stays xterm.js's.)
    expect(press("Backspace", "Backspace", ["alt"], true)).not.toBe("typed");
  });

  it("pastes as xterm.js does: line breaks as Enter, bracketed for a program that asked", async () => {
    const term = terminal();
    expect(guestPaste(term, "echo one\necho two")).toBe("echo one\recho two");
    await written(term, "\x1b[?2004h");
    expect(guestPaste(term, "echo one\r\necho two")).toBe("\x1b[200~echo one\recho two\x1b[201~");
    // No text pasted ends the bracket early: its ESC is shown, as xterm.js shows the host's.
    expect(guestPaste(term, "x\x1b[201~\nrm -rf ~\n")).toBe("\x1b[200~x\u241b[201~\rrm -rf ~\r\x1b[201~");
  });
});
