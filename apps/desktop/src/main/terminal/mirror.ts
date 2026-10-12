/**
 * A shell's mirror (docs/terminal.md §3): a headless xterm.js drawing the
 * shell's output as the window's terminal draws it, so a window that opens
 * the terminal again is handed exactly what its screen held.
 *
 * "As the window draws it" is the point: the mirror measures text by the
 * same Unicode rules (graphemes — an emoji with a variation selector is two
 * cells, not one, and a cursor placed after it lands where the window
 * would put it), and keeps the kitty keyboard protocol's state as the
 * window does. The serialize addon draws the screen, its scrollback and
 * its modes, but leaves three things out, which the replay's tail puts
 * back (`replayTail`):
 *
 * - the kitty keyboard protocol's state — the flags a program asked for,
 *   and the stack it pushed, on the screen in use — or a program that asked
 *   for Shift+Enter to be told apart from Enter is sent plain keys after a
 *   reload;
 * - the mouse reports' encoding (SGR): it says a program wants reports,
 *   not in which form, and a program reading SGR would be sent the old one;
 * - the cursor, where the addon's last sequences leave it: setting origin
 *   mode and the scrolling margins both send it home.
 */

import { createRequire } from "node:module";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import {
  TERMINAL_CLEAR_OSC,
  TERMINAL_LONG_COMMAND_MS,
  commandFinishedNotice,
  cwdFromOsc7,
  terminalModesReset,
  terminalNotice,
} from "@pistachio/shell-contracts/terminal";
import type { Mirror, MirrorEars } from "./sessions";

// (CommonJS packages, whose named exports an ES module cannot always see.)
const require = createRequire(import.meta.url);
const { Terminal: Headless } = require("@xterm/headless") as typeof import("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");
const { UnicodeGraphemesAddon } = require("@xterm/addon-unicode-graphemes") as typeof import("@xterm/addon-unicode-graphemes");

/** Lines of scrollback the mirror keeps for a window that opens it again. */
export const MIRROR_SCROLLBACK = 5_000;

/** The kitty keyboard protocol's state, as xterm.js keeps it (its core service's; no public API reads it). */
interface KittyState {
  flags: number;
  mainStack: number[];
  altStack: number[];
}

export function kittyState(terminal: HeadlessTerminal): KittyState | null {
  const state = (terminal as unknown as { _core?: { coreService?: { kittyKeyboard?: KittyState } } })._core?.coreService?.kittyKeyboard;
  return state !== undefined && typeof state.flags === "number" && Array.isArray(state.mainStack) && Array.isArray(state.altStack) ? state : null;
}

/**
 * The sequences that put a fresh terminal's kitty keyboard state — on the
 * screen in use, the replay having left it there — where `state` has it:
 * the bottom of the stack set (`CSI = f ; 1 u`), each entry above it
 * pushed, the flags in force pushed last. Nothing for a terminal that
 * never asked.
 */
export function kittyRestore(state: KittyState, alternate: boolean): string {
  const stack = alternate ? state.altStack : state.mainStack;
  if (stack.length === 0) return state.flags === 0 ? "" : `\x1b[=${String(state.flags)};1u`;
  const [bottom = 0, ...rest] = stack;
  return [`\x1b[=${String(bottom)};1u`, ...rest.map((flags) => `\x1b[>${String(flags)}u`), `\x1b[>${String(state.flags)}u`].join("");
}

/** xterm.js's mouse report encoding (its core's mouse state; no public API reads it). */
function mouseEncoding(terminal: HeadlessTerminal): string | null {
  const encoding = (terminal as unknown as { _core?: { mouseStateService?: { activeEncoding?: unknown } } })._core?.mouseStateService?.activeEncoding;
  return typeof encoding === "string" ? encoding : null;
}

/** The scrolling margins (0-based rows; the addon reads them from the core too), or null when they are the whole screen. */
function margins(terminal: HeadlessTerminal): { top: number; bottom: number } | null {
  const buffer = (terminal as unknown as { _core?: { buffer?: { scrollTop?: unknown; scrollBottom?: unknown } } })._core?.buffer;
  const top = typeof buffer?.scrollTop === "number" ? buffer.scrollTop : 0;
  const bottom = typeof buffer?.scrollBottom === "number" ? buffer.scrollBottom : terminal.rows - 1;
  return top === 0 && bottom === terminal.rows - 1 ? null : { top, bottom };
}

/** The colours and look a cell (or the pen) has, as SGR parameters from plain: what xterm.js's attribute API says of it. */
interface Look {
  isBold(): number | boolean;
  isItalic(): number | boolean;
  isDim(): number | boolean;
  isUnderline(): number | boolean;
  isBlink(): number | boolean;
  isInverse(): number | boolean;
  isInvisible(): number | boolean;
  isStrikethrough(): number | boolean;
  isOverline(): number | boolean;
  isFgRGB(): number | boolean;
  isFgPalette(): number | boolean;
  getFgColor(): number;
  isBgRGB(): number | boolean;
  isBgPalette(): number | boolean;
  getBgColor(): number;
}

function sgr(look: Look): string {
  const parts = ["0"];
  if (look.isBold()) parts.push("1");
  if (look.isDim()) parts.push("2");
  if (look.isItalic()) parts.push("3");
  if (look.isUnderline()) parts.push("4");
  if (look.isBlink()) parts.push("5");
  if (look.isInverse()) parts.push("7");
  if (look.isInvisible()) parts.push("8");
  if (look.isStrikethrough()) parts.push("9");
  if (look.isOverline()) parts.push("53");
  const color = (rgb: boolean, palette: boolean, value: number, base: 38 | 48): void => {
    if (rgb) parts.push(`${String(base)};2;${String((value >> 16) & 255)};${String((value >> 8) & 255)};${String(value & 255)}`);
    else if (palette) parts.push(`${String(base)};5;${String(value)}`);
  };
  color(Boolean(look.isFgRGB()), Boolean(look.isFgPalette()), look.getFgColor(), 38);
  color(Boolean(look.isBgRGB()), Boolean(look.isBgPalette()), look.getBgColor(), 48);
  return `\x1b[${parts.join(";")}m`;
}

/** The modes a replay sets, as the serialize addon writes them — but origin mode apart: it sends the cursor home. */
function modes(terminal: HeadlessTerminal): string {
  const mode = terminal.modes;
  let content = "";
  if (mode.applicationCursorKeysMode) content += "\x1b[?1h";
  if (mode.applicationKeypadMode) content += "\x1b[?66h";
  if (mode.bracketedPasteMode) content += "\x1b[?2004h";
  if (mode.insertMode) content += "\x1b[4h";
  if (mode.reverseWraparoundMode) content += "\x1b[?45h";
  if (mode.sendFocusMode) content += "\x1b[?1004h";
  if (!mode.wraparoundMode) content += "\x1b[?7l";
  const tracking = { none: "", x10: "\x1b[?9h", vt200: "\x1b[?1000h", drag: "\x1b[?1002h", any: "\x1b[?1003h" }[mode.mouseTrackingMode];
  content += tracking;
  // (The addon says a program wants reports, not in which form.)
  const encoding = mouseEncoding(terminal);
  if (encoding === "SGR") content += "\x1b[?1006h";
  else if (encoding === "SGR_PIXELS") content += "\x1b[?1016h";
  if (!mode.showCursor) content += "\x1b[?25l";
  return content;
}

/** The cursor a program saved (DECSC, ESC 7) on the screen in use, as xterm.js keeps it (its core's buffer; no public API). */
interface SavedCursor {
  savedX: number;
  savedY: number;
  savedCurAttrData: Look;
  savedOriginMode: boolean;
  savedWraparoundMode: boolean;
}

function savedCursor(terminal: HeadlessTerminal): SavedCursor | null {
  const buffer = (terminal as unknown as { _core?: { buffer?: Partial<SavedCursor> } })._core?.buffer;
  if (buffer === undefined || typeof buffer.savedX !== "number" || typeof buffer.savedY !== "number" || buffer.savedCurAttrData === undefined) return null;
  return buffer as SavedCursor;
}

/**
 * The sequences that save, in a fresh terminal, the cursor a program saved here (ESC 7): its place (from the screen's top
 * — a row scrolled off is the top, as ESC 8 would take it), its look, its origin and wraparound modes. "" when it never
 * saved one (the place and the look a fresh terminal's own). They move the cursor and set the pen: whoever writes them
 * puts both back after.
 */
function savedCursorSequence(terminal: HeadlessTerminal): string {
  const saved = savedCursor(terminal);
  if (saved === null) return "";
  const look = sgr(saved.savedCurAttrData);
  const row = Math.max(0, saved.savedY - terminal.buffer.active.baseY);
  const plain = saved.savedX === 0 && row === 0 && look === "\x1b[0m" && !saved.savedOriginMode && saved.savedWraparoundMode !== false;
  if (plain) return "";
  return [
    // (Origin mode first: setting it sends the cursor home. With no margins yet, its rows are the screen's.)
    saved.savedOriginMode ? "\x1b[?6h" : "\x1b[?6l",
    saved.savedWraparoundMode === false ? "\x1b[?7l" : "\x1b[?7h",
    `\x1b[${String(row + 1)};${String(Math.min(saved.savedX, terminal.cols - 1) + 1)}H`,
    look,
    "\x1b7",
  ].join("");
}

/**
 * What a replay's screen (the serialize addon's, modes left out) is followed by: the cursor a program saved (ESC 7),
 * saved again; the margins and origin mode, which send the cursor home — so the cursor is put back after them (and after
 * the saved cursor's sequences, which move it), and a pending wrap (the cursor past the last column, the next character
 * to go to the next row) made again by printing that column's character again, in its own look; the pen; then the
 * other modes, which move nothing, and the kitty keyboard state.
 */
export function replayTail(terminal: HeadlessTerminal): string {
  const buffer = terminal.buffer.active;
  const region = margins(terminal);
  const origin = terminal.modes.originMode;
  const saved = savedCursorSequence(terminal);
  // The pen (the look the next character is printed in), as the serialize addon leaves it at the screen's end.
  const pen = (terminal as unknown as { _core?: { _inputHandler?: { _curAttrData?: Look } } })._core?._inputHandler?._curAttrData;
  let tail = saved;
  if (region !== null || origin || saved !== "") {
    if (region !== null) tail += `\x1b[${String(region.top + 1)};${String(region.bottom + 1)}r`;
    if (origin) tail += "\x1b[?6h";
    else if (saved !== "") tail += "\x1b[?6l";
    // (The saved cursor's sequences may have turned wraparound off; the addon's modes say so only when it is off now.)
    if (saved !== "" && terminal.modes.wraparoundMode) tail += "\x1b[?7h";
    // (In origin mode a row is counted from the margins' top.)
    const row = (y: number): number => (origin ? Math.max(1, y - (region?.top ?? 0) + 1) : y + 1);
    if (buffer.cursorX >= terminal.cols) {
      const line = buffer.getLine(buffer.baseY + buffer.cursorY);
      // (The last column may hold the second half of a wide character: its first half is the one to print.)
      const last = line?.getCell(terminal.cols - 1);
      const x = last !== undefined && last.getWidth() === 0 ? terminal.cols - 2 : terminal.cols - 1;
      const cell = line?.getCell(x);
      tail += `\x1b[${String(row(buffer.cursorY))};${String(x + 1)}H`;
      tail += cell === undefined ? " " : `${sgr(cell)}${cell.getChars() || " "}`;
      if (pen !== undefined) tail += sgr(pen);
    } else {
      tail += `\x1b[${String(row(buffer.cursorY))};${String(buffer.cursorX + 1)}H`;
      // (The saved cursor's look was set to save it: the pen goes back.)
      if (saved !== "" && pen !== undefined) tail += sgr(pen);
    }
  }
  tail += modes(terminal);
  const kitty = kittyState(terminal);
  if (kitty !== null) tail += kittyRestore(kitty, buffer.type === "alternate");
  return tail;
}

/**
 * Where `text` broke off inside an escape sequence, that sequence so far (from its ESC); "" when it ended between
 * sequences. A replay ends with it, so the window's parser is where the mirror's is, and what follows completes it —
 * the empty write a replay waits on means everything before it was read, not that the reading ended between sequences.
 * Follows VT parsing: CSI to its final byte, OSC to BEL or ST, DCS/APC/PM/SOS to ST, an escape with intermediates to
 * its final; CAN and SUB abandon a sequence.
 */
export function unfinishedSequence(text: string): string {
  type State = "ground" | "escape" | "intermediate" | "csi" | "osc" | "string" | "string-escape";
  let state: State = "ground";
  let start = -1;
  let osc = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x18 || code === 0x1a) {
      state = "ground";
      continue;
    }
    if (code === 0x1b) {
      // (Inside a string, ESC may begin its terminator, ST.)
      if (state === "osc" || state === "string") state = "string-escape";
      else {
        state = "escape";
        start = index;
      }
      continue;
    }
    switch (state) {
      case "ground":
        break;
      case "escape":
        if (code === 0x5b) state = "csi";
        else if (code === 0x5d) {
          state = "osc";
          osc = true;
        } else if (code === 0x50 || code === 0x5f || code === 0x5e || code === 0x58) {
          state = "string";
          osc = false;
        } else if (code >= 0x20 && code <= 0x2f) state = "intermediate";
        else state = "ground";
        break;
      case "intermediate":
        if (code >= 0x30 && code <= 0x7e) state = "ground";
        break;
      case "csi":
        if (code >= 0x40 && code <= 0x7e) state = "ground";
        break;
      case "osc":
      case "string":
        if (code === 0x07 && osc) state = "ground";
        break;
      case "string-escape":
        if (code === 0x5c) state = "ground";
        else {
          // Not ST: the ESC began another sequence.
          start = index - 1;
          state = "escape";
          index -= 1;
        }
        break;
    }
  }
  return state === "ground" || start < 0 ? "" : text.slice(start);
}

/** The most of an unfinished sequence carried into a replay (a longer one — a picture — is let go). */
const MAX_CARRY = 1_000_000;

/**
 * A mirror at this size: its OSC 7 reports, its answers to programs' questions, and what it should say if nobody else
 * does (a program's OSC 9 or 777, a long command's end — as the window says them, lib/terminal/sessions.ts) heard.
 * `now` is the clock a command is timed by.
 */
export function headlessMirror(cols: number, rows: number, hear: MirrorEars, now: () => number = Date.now): Mirror {
  const terminal = new Headless({ cols, rows, scrollback: MIRROR_SCROLLBACK, allowProposedApi: true, vtExtensions: { kittyKeyboard: true } });
  const serialize = new SerializeAddon();
  // (Typed against @xterm/xterm's Terminal; they read only what the headless one has too.)
  terminal.loadAddon(serialize as unknown as Parameters<HeadlessTerminal["loadAddon"]>[0]);
  terminal.loadAddon(new UnicodeGraphemesAddon() as unknown as Parameters<HeadlessTerminal["loadAddon"]>[0]);
  // The shell's reports of where it is (its integration's, or its own).
  terminal.parser.registerOscHandler(7, (data) => {
    const folder = cwdFromOsc7(data);
    if (folder !== null) hear.onCwd(folder);
    return false;
  });
  // (The answers a terminal gives: a cursor position report, device attributes, the kitty flags.)
  terminal.onData((reply) => hear.onReply(reply));
  // ⌘K, where it stands in the output (TERMINAL_CLEAR): the window clears at the same place.
  terminal.parser.registerOscHandler(TERMINAL_CLEAR_OSC, () => {
    terminal.clear();
    return true;
  });
  // A program asking to be noticed.
  for (const osc of [9, 777] as const) {
    terminal.parser.registerOscHandler(osc, (data) => {
      const text = terminalNotice(osc, data);
      if (text !== null) hear.onNotice(text);
      return text !== null;
    });
  }
  // The clipboard (OSC 52: `selection;data`). A copy goes to the Mac's clipboard — from here, for every terminal: the
  // mirror sees each byte of output once, whether a window draws it or not, focused or not. A question ("?") is answered
  // empty, as the window answers it (a program never reads the person's clipboard), by whichever side answers now.
  terminal.parser.registerOscHandler(52, (data) => {
    const [selection = "", payload] = data.split(";");
    if (payload === undefined) return true;
    if (payload === "?") {
      hear.onReply(`\x1b]52;${selection};\x07`);
      return true;
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(payload)) return true;
    hear.onClipboard(Buffer.from(payload, "base64").toString("utf8"));
    return true;
  });
  // A long command's end (its integration's OSC 133: C, a command starts; D, it ended), named by the title it set.
  let title = "";
  let command: { text: string; at: number } | null = null;
  terminal.onTitleChange((next) => {
    title = next;
  });
  terminal.parser.registerOscHandler(133, (data) => {
    const [kind, status] = data.split(";");
    if (kind === "C") command = { text: title, at: now() };
    else if (kind === "D") {
      const ended = command;
      command = null;
      if (ended !== null && now() - ended.at >= TERMINAL_LONG_COMMAND_MS) hear.onNotice(commandFinishedNotice(ended.text, status));
    }
    return false;
  });
  // Where the output so far broke off inside a sequence (unfinishedSequence), for a replay to end with.
  let carry = "";
  const write = (data: string, drawn?: () => void): void => {
    if (data !== "") {
      const next = unfinishedSequence(carry + data);
      carry = next.length > MAX_CARRY ? "" : next;
    }
    try {
      terminal.write(data, drawn);
    } catch (error) {
      // (xterm.js throws when it is too far behind — 50 MB — which the host's flow control keeps it from; were it to,
      // the output is lost from the copy, not every shell with the host.)
      console.error("[terminal] the mirror dropped output", error);
      drawn?.();
    }
  };
  return {
    get cols() {
      return terminal.cols;
    },
    get rows() {
      return terminal.rows;
    },
    write,
    resize: (nextCols, nextRows) => terminal.resize(nextCols, nextRows),
    serialize: () => serialize.serialize({ excludeModes: true }) + replayTail(terminal) + carry,
    // (Which screen is in use is known once everything written before is drawn: the reset follows it.)
    resetModes: () => terminal.write("", () => write(terminalModesReset(terminal.buffer.active.type === "alternate"))),
    dispose: () => terminal.dispose(),
  };
}
