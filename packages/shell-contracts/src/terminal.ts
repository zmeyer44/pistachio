/**
 * Terminals (docs/terminal.md): a tab whose page is a shell on this Mac.
 *
 * A terminal is a shell-drawn page (./shell-pages.ts) at
 * `pistachio://terminal/<id>`: the host keeps the TAB — its row, its title,
 * its place on a desk, its session restore — and the shell draws the
 * terminal in its pane. The shell process itself lives in main's terminal
 * host, a utility process, keyed by the id in the address; the shell talks
 * to it over a MessagePort main hands it, so a flood of output never passes
 * through main.
 */

/** A terminal of its own is `pistachio://terminal/<id>`; there is no library page. */
export const TERMINAL_PAGE_URL = "pistachio://terminal/";
export const TERMINAL_PAGE_TITLE = "Terminal";

/** A prompt on a dark tile, in the brand's green: a terminal tab's favicon. */
export const TERMINAL_PAGE_FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='18' fill='%231f2124'/%3E%3Cpath d='M18 22l10 10-10 10' fill='none' stroke='%2352a862' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M32 43h14' stroke='white' stroke-width='5' stroke-linecap='round'/%3E%3C/svg%3E";

const TERMINAL_ID = /^[a-f0-9]{12}$/u;

export function isTerminalId(value: unknown): value is string {
  return typeof value === "string" && TERMINAL_ID.test(value);
}

/** A fresh terminal's id: twelve hex digits, as a note's are. */
export function newTerminalId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The terminal an address opens, or null when it is not a terminal's. */
export function terminalUrlId(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "pistachio:" || url.hostname !== "terminal" || url.search !== "" || url.hash !== "") return null;
  const path = url.pathname.replace(/^\/+|\/+$/gu, "");
  return isTerminalId(path) ? path : null;
}

export function isTerminalUrl(value: string): boolean {
  return terminalUrlId(value) !== null;
}

export function terminalUrl(id: string): string {
  return `${TERMINAL_PAGE_URL}${id}`;
}

/* ------------------------------ the port ------------------------------ */

/** Columns and rows a shell may be given: what fits a window, and no more. */
export const TERMINAL_MAX_COLS = 1_000;
export const TERMINAL_MAX_ROWS = 500;

/**
 * The shell → the terminal host, over the port main hands the shell.
 *
 * - `open`: the terminal's shell, started if it was never started (in
 *   `cwd`, else where it last was, else the home folder), at this size.
 *   Answered by `opened`, with what its screen holds when it was started
 *   already — and, for a shell that ended while no window had it open, by
 *   its `exit` after that, so the window says how it ended (or closes its
 *   tab) rather than starting another. `restart` starts a fresh shell in
 *   place of one that ended (the person pressed Enter).
 * - `input`: typed or pasted text. `binary` for a mouse report in the
 *   legacy encoding, whose bytes are not UTF-8.
 * - `ack`: how much of its output the shell has drawn. The host stops
 *   reading from a shell whose output runs too far ahead of the drawing
 *   (`TERMINAL_FLOW`), so a runaway `cat` cannot fill the shell's memory and
 *   ⌃C still lands at once.
 * - `clear`: the person cleared the screen and its scrollback (⌘K). The
 *   host puts `TERMINAL_CLEAR` into the shell's output where it stands, so
 *   the window and the host's copy clear the same lines — a clear done in
 *   the window alone would act on what it has drawn, its copy on what it
 *   has, and a reload would bring back the difference.
 * - `release`: the window let the terminal go (its tab left the shell's
 *   snapshot: another Profile). The shell runs on; nothing more is sent, and
 *   nothing is held back for want of drawing. Opened again, it is replayed.
 */
export type TerminalRequest =
  | { type: "open"; id: string; cols: number; rows: number; cwd: string | null; restart?: true }
  | { type: "input"; id: string; data: string; binary?: true }
  | { type: "resize"; id: string; cols: number; rows: number }
  | { type: "ack"; id: string; chars: number }
  | { type: "clear"; id: string }
  | { type: "release"; id: string };

/**
 * The terminal host → the shell. `hostGone` is the preload's own word: main
 * said the host stopped (its port is closed), and every shell with it.
 *
 * - `opened`: the terminal is open; `replay` is what the host's copy of its
 *   screen holds, and the window's terminal becomes exactly that — for a
 *   shell found running, one restarted under its old scrollback, and one
 *   started now ("": an empty screen) alike, so the two never differ.
 * - `closed`: the host closed it (no tab named it): a window that still has
 *   it — its tab back from the closed — opens it anew.
 * - `notice`: a program asked to be noticed, or a long command ended, while
 *   no window had the terminal (another Profile in front): the host's copy
 *   saw it, and says so.
 */
export type TerminalEvent =
  | {
      type: "opened";
      id: string;
      /** What the host's copy of the screen and its scrollback holds, as the escape sequences that draw it. */
      replay: string;
      /** The size `replay` was drawn at. */
      cols: number;
      rows: number;
      /** Started now (rather than found running). */
      fresh: boolean;
      /** Where the shell is, as far as anyone knows. */
      cwd: string | null;
    }
  | { type: "data"; id: string; data: string }
  | { type: "exit"; id: string; code: number; signal: number | null }
  | { type: "failed"; id: string; message: string }
  | { type: "closed"; id: string }
  | { type: "notice"; id: string; text: string }
  | { type: "hostGone" };

/** The private OSC that clears a terminal's screen and scrollback where it stands in the output (⌘K): `TERMINAL_CLEAR`. */
export const TERMINAL_CLEAR_OSC = 7775;
export const TERMINAL_CLEAR = `\x1b]${String(TERMINAL_CLEAR_OSC)};clear\x07`;

/** A command running at least this long is said to have finished when it ends out of sight. */
export const TERMINAL_LONG_COMMAND_MS = 10_000;

/**
 * What a terminal's program asks to be noticed for, from an OSC it wrote:
 * OSC 9 (iTerm's: its text) or OSC 777 (rxvt's `notify;title;body`); null
 * for anything else — OSC 9;4 is a progress report, not a notice.
 */
export function terminalNotice(osc: 9 | 777, data: string): string | null {
  let text: string;
  if (osc === 9) {
    if (/^\d;/u.test(data)) return null;
    text = data;
  } else {
    const [kind, title = "", body = ""] = data.split(";");
    if (kind !== "notify") return null;
    text = body === "" ? title : `${title}: ${body}`;
  }
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\x00-\x1f\x7f]/gu, "").trim().slice(0, 200);
  return clean === "" ? null : clean;
}

/** What a long command's end says: “npm test” finished, or failed (exit 1). */
export function commandFinishedNotice(command: string, status: string | undefined): string {
  const failed = status !== undefined && status !== "" && status !== "0";
  const name = command.trim() === "" ? "A command" : `“${command.trim().slice(0, 60)}”`;
  return failed ? `${name} failed (exit ${status})` : `${name} finished`;
}

/**
 * What a program that ended may have left on, put back. Written into a
 * terminal — the window's and the host's mirror alike — when its shell
 * ends, so the next shell starts clean:
 *
 * - any sequence it broke off in the middle of, abandoned (CAN): else the
 *   reset would be read as the rest of it;
 * - its own screen, left (only when it is the one in use: leaving it
 *   otherwise would move the cursor);
 * - synchronized output ended (a frozen screen);
 * - a soft reset (DECSTR, `CSI ! p`), which in xterm.js puts back the
 *   scrolling margins, origin mode, every private mode — the cursor and
 *   keypad keys, bracketed paste, focus reports, wraparound, the cursor's
 *   style and its being shown — the kitty keyboard flags of both screens
 *   (with report-all-keys, Enter is not Enter), and plain colours;
 * - mouse reports, which a soft reset leaves on.
 */
export function terminalModesReset(alternate: boolean): string {
  return `\x18${alternate ? "\x1b[?1049l" : ""}\x1b[?2026l\x1b[!p\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l`;
}

/** When the host stops reading a shell's output (unacknowledged characters), and when it reads on. */
export const TERMINAL_FLOW = { high: 100_000, low: 5_000, ackEvery: 5_000 } as const;

export function isTerminalRequest(value: unknown): value is TerminalRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  if (!isTerminalId(request["id"])) return false;
  const size = (): boolean =>
    Number.isInteger(request["cols"]) &&
    Number.isInteger(request["rows"]) &&
    (request["cols"] as number) >= 1 &&
    (request["cols"] as number) <= TERMINAL_MAX_COLS &&
    (request["rows"] as number) >= 1 &&
    (request["rows"] as number) <= TERMINAL_MAX_ROWS;
  switch (request["type"]) {
    case "open":
      return (
        size() &&
        (request["cwd"] === null || (typeof request["cwd"] === "string" && request["cwd"].startsWith("/") && request["cwd"].length <= 4_096)) &&
        (request["restart"] === undefined || request["restart"] === true)
      );
    case "input":
      return typeof request["data"] === "string" && (request["binary"] === undefined || request["binary"] === true);
    case "resize":
      return size();
    case "ack":
      return Number.isInteger(request["chars"]) && (request["chars"] as number) >= 0;
    case "clear":
    case "release":
      return true;
    default:
      return false;
  }
}

/**
 * The folder an OSC 7 report names (`file://host/path`, percent-encoded),
 * or null when it is not one. The host part is not checked: a shell over
 * ssh reports the far machine's, and is still where it says.
 */
export function cwdFromOsc7(data: string): string | null {
  let url: URL;
  try {
    url = new URL(data.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "file:" && url.protocol !== "kitty-shell-cwd:") return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  return path.startsWith("/") ? path : null;
}
