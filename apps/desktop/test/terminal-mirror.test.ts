import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import { TERMINAL_CLEAR, terminalModesReset } from "@pistachio/shell-contracts/terminal";
import { headlessMirror, kittyRestore, kittyState, unfinishedSequence } from "../src/main/terminal/mirror";

const require = createRequire(import.meta.url);
const { Terminal: Headless } = require("@xterm/headless") as typeof import("@xterm/headless");
const { UnicodeGraphemesAddon } = require("@xterm/addon-unicode-graphemes") as typeof import("@xterm/addon-unicode-graphemes");

/** A terminal as the window has it (lib/terminal/sessions.ts): graphemes, the kitty keyboard protocol on. */
function windowTerminal(cols = 20, rows = 3): HeadlessTerminal {
  const terminal = new Headless({ cols, rows, allowProposedApi: true, vtExtensions: { kittyKeyboard: true } });
  terminal.loadAddon(new UnicodeGraphemesAddon() as unknown as Parameters<HeadlessTerminal["loadAddon"]>[0]);
  return terminal;
}

const drawn = (terminal: { write(data: string, done?: () => void): void }, data: string): Promise<void> =>
  new Promise((done) => terminal.write(data, done));

const line = (terminal: HeadlessTerminal, index: number): string => terminal.buffer.active.getLine(index)?.translateToString(true) ?? "";

/** What a window opening the terminal again gets: the mirror's replay, written into a fresh window terminal. */
async function reopened(output: string, cols = 20, rows = 3): Promise<HeadlessTerminal> {
  const mirror = headlessMirror(cols, rows, { onCwd: () => undefined, onReply: () => undefined, onNotice: () => undefined, onClipboard: () => undefined });
  await drawn(mirror, output);
  const window = windowTerminal(cols, rows);
  await drawn(window, mirror.serialize());
  mirror.dispose();
  return window;
}

describe("a terminal opened again from its mirror", () => {
  it("shows what the window showed: text measured by the same Unicode rules", async () => {
    const output = "☀️ hello\x1b[3G!";
    const live = windowTerminal();
    await drawn(live, output);
    const again = await reopened(output);
    expect(line(again, 0)).toBe(line(live, 0));
    expect(line(again, 0)).toBe("☀️!hello");
  });

  it("keeps the kitty keyboard protocol a program asked for: its flags and the stack it pushed", async () => {
    const again = await reopened("\x1b[>1u\x1b[>3u");
    expect(kittyState(again)).toMatchObject({ flags: 3, mainStack: [0, 1] });
  });

  it("keeps it on the screen the program is using", async () => {
    const again = await reopened("\x1b[?1049h\x1b[>5u");
    expect(again.buffer.active.type).toBe("alternate");
    expect(kittyState(again)).toMatchObject({ flags: 5, altStack: [0] });
  });

  it("keeps flags set without a push, and nothing for a program that never asked", async () => {
    expect(kittyState(await reopened("\x1b[=7;1u"))).toMatchObject({ flags: 7, mainStack: [] });
    expect(kittyState(await reopened("plain"))).toMatchObject({ flags: 0, mainStack: [] });
    expect(kittyRestore({ flags: 0, mainStack: [], altStack: [] }, false)).toBe("");
  });

  it("answers a program's question (where is the cursor?), for the host to hand the shell when no window can", async () => {
    const replies: string[] = [];
    const mirror = headlessMirror(20, 3, { onCwd: () => undefined, onReply: (reply) => replies.push(reply), onNotice: () => undefined, onClipboard: () => undefined });
    await drawn(mirror, "ab\x1b[6n");
    expect(replies).toEqual(["\x1b[1;3R"]);
  });

  it("puts back what a program that ended left on: its screen, its keyboard flags", async () => {
    const mirror = headlessMirror(20, 3, { onCwd: () => undefined, onReply: () => undefined, onNotice: () => undefined, onClipboard: () => undefined });
    await drawn(mirror, "shell\x1b[?1049h\x1b[>8u\x1b[?2004h");
    mirror.resetModes();
    await drawn(mirror, "");
    const window = windowTerminal();
    await drawn(window, mirror.serialize());
    expect(window.buffer.active.type).toBe("normal");
    expect(kittyState(window)).toMatchObject({ flags: 0, mainStack: [], altStack: [] });
    expect(window.modes.bracketedPasteMode).toBe(false);
    expect(line(window, 0)).toBe("shell");
  });

  it("the reset written as a shell ends leaves the next one a whole screen: no margins, no origin mode", async () => {
    const window = windowTerminal(20, 6);
    // A program set a scrolling region and origin mode, and died.
    await drawn(window, "\x1b[2;4r\x1b[?6h");
    await drawn(window, terminalModesReset(false));
    await drawn(window, "\x1b[Htop\x1b[6;1Hbottom");
    expect(line(window, 0)).toBe("top");
    expect(line(window, 5)).toBe("bottom");
  });

  it("the reset leaves a terminal whole even when the program that ended broke off in the middle of a sequence", async () => {
    const window = windowTerminal(20, 3);
    await drawn(window, "\x1b[?1049h\x1b]0;half a ti");
    await drawn(window, `${terminalModesReset(true)}prompt`);
    expect(window.buffer.active.type).toBe("normal");
    expect(line(window, 0)).toBe("prompt");
  });

  it("clears where ⌘K stands in the output: what came before it is gone, the line in use kept", async () => {
    const window = await reopened(`one\r\ntwo\r\nthree${TERMINAL_CLEAR}!`, 20, 4);
    expect([line(window, 0), line(window, 1)]).toEqual(["three!", ""]);
  });

  it("says what a program asked to be noticed for, and a long command's end — as the window would", async () => {
    let clock = 0;
    const notices: string[] = [];
    const mirror = headlessMirror(40, 3, { onCwd: () => undefined, onReply: () => undefined, onNotice: (text) => notices.push(text), onClipboard: () => undefined }, () => clock);
    await drawn(mirror, "\x1b]9;Claude needs your permission\x07\x1b]9;4;1;50\x07\x1b]777;notify;Build;done\x07");
    await drawn(mirror, "\x1b]2;npm test\x07\x1b]133;C\x07");
    clock = 12_000;
    await drawn(mirror, "\x1b]133;D;1\x07\x1b]2;quick\x07\x1b]133;C\x07\x1b]133;D;0\x07");
    expect(notices).toEqual(["Claude needs your permission", "Build: done", "“npm test” failed (exit 1)"]);
  });

  it("puts the cursor back where it was, under scrolling margins and origin mode alike", async () => {
    for (const output of ["\x1b[2;5r\x1b[4;7Hhello", "\x1b[2;5r\x1b[?6h\x1b[2;3Hhi", "plain\r\nlines"]) {
      const live = windowTerminal(20, 6);
      await drawn(live, output);
      const again = await reopened(output, 20, 6);
      const cursor = (terminal: HeadlessTerminal) => [terminal.buffer.active.cursorX, terminal.buffer.active.cursorY];
      expect(cursor(again), JSON.stringify(output)).toEqual(cursor(live));
    }
  });

  it("keeps a pending wrap under scrolling margins: the next character goes to the next row, in the colours the program set", async () => {
    for (const output of ["\x1b[1;3rabcde", "\x1b[1;3r\x1b[31mabcd\x1b[1me\x1b[32m", "\x1b[1;3r\x1b[?6habcde"]) {
      const live = windowTerminal(5, 4);
      await drawn(live, `${output}F`);
      const again = await reopened(output, 5, 4);
      await drawn(again, "F");
      const cells = (terminal: HeadlessTerminal) =>
        [0, 1].map((row) => {
          const line = terminal.buffer.active.getLine(row);
          return Array.from({ length: 5 }, (_, x) => {
            const cell = line?.getCell(x);
            return `${cell?.getChars() ?? ""}:${String(cell?.getFgColor())}:${String(cell?.isBold())}`;
          }).join(" ");
        });
      expect(cells(again), JSON.stringify(output)).toEqual(cells(live));
    }
  });

  it("keeps the cursor a program saved (ESC 7): where, in what look — so its ESC 8 goes back there", async () => {
    for (const [before, after] of [
      ["one\r\ntwo\r\nthree\x1b[3;5H\x1b7\x1b[1;1H", "\x1b8Z"],
      ["\x1b[31m\x1b[2;3H\x1b7\x1b[0m\x1b[1;1Hplain", "\x1b8R"],
      ["\x1b[2;5r\x1b[?6h\x1b[2;2H\x1b7\x1b[?6l\x1b[r\x1b[1;1H", "\x1b8O"],
    ] as const) {
      const live = windowTerminal(20, 6);
      await drawn(live, before + after);
      const again = await reopened(before, 20, 6);
      await drawn(again, after);
      const screen = (terminal: HeadlessTerminal) =>
        Array.from({ length: 6 }, (_, row) => {
          const cells = terminal.buffer.active.getLine(row);
          return Array.from({ length: 20 }, (_, x) => `${cells?.getCell(x)?.getChars() || " "}${String(cells?.getCell(x)?.getFgColor())}`).join("");
        });
      expect(screen(again), JSON.stringify(before)).toEqual(screen(live));
      expect([again.buffer.active.cursorX, again.buffer.active.cursorY]).toEqual([live.buffer.active.cursorX, live.buffer.active.cursorY]);
    }
  });

  it("carries a sequence the output broke off in the middle of, so what follows it completes it", async () => {
    for (const [first, rest] of [
      ["\x1b[31", "mred"],
      ["\x1b]0;a ti", "tle\x07ok"],
      ["\x1b]0;title\x1b", "\\ok"],
    ] as const) {
      const live = windowTerminal();
      await drawn(live, first + rest);
      const again = await reopened(first);
      await drawn(again, rest);
      expect(line(again, 0), JSON.stringify(first)).toBe(line(live, 0));
      expect(again.buffer.active.getLine(0)?.getCell(0)?.getFgColor()).toBe(live.buffer.active.getLine(0)?.getCell(0)?.getFgColor());
    }
  });

  it("finds where the output broke off in a sequence (or that it did not)", () => {
    expect(unfinishedSequence("plain")).toBe("");
    expect(unfinishedSequence("text\x1b[31mred")).toBe("");
    expect(unfinishedSequence("text\x1b[3")).toBe("\x1b[3");
    expect(unfinishedSequence("\x1b]0;title")).toBe("\x1b]0;title");
    expect(unfinishedSequence("\x1b]0;title\x07")).toBe("");
    expect(unfinishedSequence("\x1b]0;title\x1b")).toBe("\x1b]0;title\x1b");
    expect(unfinishedSequence("\x1b]0;title\x1b\\")).toBe("");
    expect(unfinishedSequence("\x1bP1$q")).toBe("\x1bP1$q");
    expect(unfinishedSequence("\x1b(")).toBe("\x1b(");
    expect(unfinishedSequence("\x1b(B")).toBe("");
    expect(unfinishedSequence("\x1b[3\x18rest")).toBe("");
    expect(unfinishedSequence("\x1b")).toBe("\x1b");
  });

  it("keeps the mouse reports' encoding a program asked for (SGR), not only that it reports", async () => {
    const again = await reopened("\x1b[?1002h\x1b[?1006h");
    expect(again.modes.mouseTrackingMode).toBe("drag");
    expect((again as unknown as { _core: { mouseStateService: { activeEncoding: string } } })._core.mouseStateService.activeEncoding).toBe("SGR");
  });

  it("takes a program's clipboard (OSC 52): its copy for the Mac's clipboard, its question answered — empty — as the window answers it", async () => {
    const replies: string[] = [];
    const copies: string[] = [];
    const mirror = headlessMirror(20, 3, { onCwd: () => undefined, onReply: (reply) => replies.push(reply), onNotice: () => undefined, onClipboard: (text) => copies.push(text) });
    await drawn(mirror, `\x1b]52;c;${Buffer.from("yanked in vim").toString("base64")}\x07\x1b]52;c;?\x07\x1b]52;c;!!not-base64\x07`);
    expect(copies).toEqual(["yanked in vim"]);
    expect(replies).toEqual(["\x1b]52;c;\x07"]);
  });

  it("is told where the shell is", async () => {
    const folders: string[] = [];
    const mirror = headlessMirror(20, 3, { onCwd: (cwd) => folders.push(cwd), onReply: () => undefined, onNotice: () => undefined, onClipboard: () => undefined });
    await drawn(mirror, "\x1b]7;file://host/Users/ada/My%20Caf%C3%A9\x07");
    expect(folders).toEqual(["/Users/ada/My Café"]);
  });
});
