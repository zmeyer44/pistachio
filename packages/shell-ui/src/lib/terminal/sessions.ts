/**
 * The shell window's terminals (docs/terminal.md §2–3): one xterm.js
 * terminal per terminal tab, kept for as long as the tab is in the shell's
 * snapshot — not for as long as a window shows it. A window going home into
 * its row, the desk passing to another space and back, a minimized window:
 * each takes the terminal's element away and gives it back, and the
 * terminal runs on meanwhile, its scrollback and selection as they were.
 * A terminal whose tab leaves the snapshot (closed, or in another Profile)
 * is let go; opened again, the host replays what its screen held.
 *
 * The shell itself runs in main's terminal host; this talks to it through
 * `nativeApi().terminalSend` / `onTerminalEvent` (a MessagePort, main off
 * the path). Output is acknowledged as it is drawn, so the host stops
 * reading a shell that pours out faster than the window can draw.
 */

import { Terminal, type IDisposable, type IMarker, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import {
  TERMINAL_CLEAR_OSC,
  TERMINAL_FLOW,
  TERMINAL_LONG_COMMAND_MS,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  commandFinishedNotice,
  cwdFromOsc7,
  terminalModesReset,
  terminalNotice,
  terminalUrlId,
  type TerminalEvent,
  type TerminalRequest,
} from "@pistachio/shell-contracts/terminal";
import type { LiveTerminalEvent } from "@pistachio/shell-contracts/live-share";
import { nativeApi, shellApi } from "../../api";
import { useAppStore } from "../../store";
import { guestKeyDown, guestKeyEvent, guestKeyUp, guestPaste } from "./guest-keys";
import { forgetTerminal, rememberTerminalFolder, takeTerminalStart } from "./places";
import { terminalTheme } from "./theme";

export type TerminalStatus = "starting" | "running" | "exited" | "failed" | "gone";

export interface TerminalState {
  status: TerminalStatus;
  /** Why it stopped, said over it. */
  note: string | null;
  /** Its scrollback search: the bar is out, and what it found. */
  search: { open: boolean; index: number; count: number };
}

/** Ghostty's own default size, and the bounds ⌘+ and ⌘− keep to. */
export const TERMINAL_FONT_SIZE = { initial: 13, min: 8, max: 32 } as const;
const FONT_SIZE_KEY = "pistachio.terminal.fontSize";
const FONT_FAMILY = '"Geist Mono Variable", "Geist Mono", "SF Mono", Menlo, "Symbols Nerd Font Mono", monospace';
/** A terminal whose tab left the snapshot is let go after this long (a snapshot mid-change is not a close). */
const RELEASE_MS = 2_000;
/** Title changes are passed to the tab at most this often: some programs animate theirs. */
const TITLE_MS = 250;
/** Option types its character on a Mac (macOptionIsMeta off): a guest's Option key, too (guest-keys.ts). */
const IS_MAC = typeof navigator !== "undefined" && /Mac/u.test(navigator.platform);

function storedFontSize(): number {
  try {
    const stored = Number(globalThis.localStorage?.getItem(FONT_SIZE_KEY));
    return Number.isFinite(stored) && stored >= TERMINAL_FONT_SIZE.min && stored <= TERMINAL_FONT_SIZE.max ? stored : TERMINAL_FONT_SIZE.initial;
  } catch {
    return TERMINAL_FONT_SIZE.initial;
  }
}

function storeFontSize(size: number): void {
  try {
    globalThis.localStorage?.setItem(FONT_SIZE_KEY, String(size));
  } catch {
    // (A private window: the size lasts as long as the shell.)
  }
}

function send(request: TerminalRequest): void {
  nativeApi()?.terminalSend(request);
}

export class TerminalSession {
  readonly id: string;
  /** The tab that shows it (a duplicated tab shows the same terminal; the last to ask holds it). */
  tabId: string;
  readonly term: Terminal;
  readonly element: HTMLDivElement;
  readonly #fit = new FitAddon();
  readonly #search = new SearchAddon({ highlightLimit: 1_000 });
  #webgl: WebglAddon | null = null;
  /** Where its element is shown now, and those that asked before and are still mounted. */
  #hosts: HTMLElement[] = [];
  #opened = false;
  /** Waiting for its font before it opens. */
  #opening = false;
  /** The host closed it (no tab named it for a moment): opened anew if its tab is back. */
  #closed = false;
  /** Asked for the keyboard before it was opened: it takes it as it opens. */
  #wantsFocus = false;
  /** Its window is minimized, flying or closing: its box is not its size, and the shell keeps the one it has. */
  #frozen = false;
  #disposed = false;
  #state: TerminalState = { status: "starting", note: null, search: { open: false, index: -1, count: 0 } };
  readonly #listeners = new Set<() => void>();
  /** Typed before the shell was there: sent once it is. */
  #early = "";
  #unacked = 0;
  /** The size last told to the host. */
  #size = { cols: 0, rows: 0 };
  #cwd: string | null = null;
  /** The command running (from its shell integration), and when it started. */
  #command: { text: string; at: number } | null = null;
  /** Where each prompt began (OSC 133 A): ⌘↑ and ⌘↓ go between them. */
  #prompts: IMarker[] = [];
  #title = "";
  #titleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The live share guests whose last key down said nothing itself: the character it types (their char, next) says it. */
  readonly #guestTyped = new Set<string>();
  /** A guest's wheel, short of a whole line yet. */
  #guestWheel = 0;
  readonly #disposables: IDisposable[] = [];

  constructor(id: string, tabId: string) {
    this.id = id;
    this.tabId = tabId;
    this.element = document.createElement("div");
    this.element.className = "terminal-surface";
    this.element.dataset["terminalId"] = id;
    this.term = new Terminal({
      allowProposedApi: true,
      fontFamily: FONT_FAMILY,
      fontSize: storedFontSize(),
      lineHeight: 1.15,
      fontWeightBold: "600",
      cursorBlink: true,
      cursorStyle: "block",
      cursorInactiveStyle: "outline",
      scrollback: 10_000,
      // Option types the characters a Mac keyboard puts on it (# £ € on many layouts, @ on a German one), as in
      // Ghostty and Terminal; a word jump on ⌥← ⌥→ is the terminal's either way.
      macOptionIsMeta: false,
      macOptionClickForcesSelection: true,
      altClickMovesCursor: true,
      rightClickSelectsWord: true,
      drawBoldTextInBrightColors: false,
      rescaleOverlappingGlyphs: true,
      minimumContrastRatio: 1,
      theme: terminalTheme(),
      // Shift+Enter, Ctrl+Enter and the rest as programs that ask for them can tell apart (Claude Code, Neovim).
      vtExtensions: { kittyKeyboard: true },
      // OSC 8 links: opened in a tab of their own, with ⌘ held, as plain URLs are.
      linkHandler: {
        activate: (event, uri) => openLink(event, uri),
        allowNonHttpProtocols: false,
      },
    });
    this.term.loadAddon(this.#fit);
    this.term.loadAddon(this.#search);
    this.term.loadAddon(new WebLinksAddon((event, uri) => openLink(event, uri)));
    this.term.loadAddon(new UnicodeGraphemesAddon());
    // (No inline pictures — Kitty's, iTerm's, SIXEL: a picture moves the cursor by its size in pixels, which the host's copy of
    // the screen cannot know, and the two would disagree on where the text after it is — docs/terminal.md §7.)
    // OSC 52: a program may put text on the clipboard (vim over ssh yanking), never read it. The copy is the host's to make
    // (its copy of the screen sees every byte once, drawn here or not, this window focused or not — a page's clipboard
    // refuses an unfocused one); here, a question is answered empty.
    this.term.loadAddon(
      new ClipboardAddon(undefined, {
        readText: () => "",
        writeText: () => undefined,
      }),
    );
    this.#disposables.push(
      this.term.onData((data) => this.#input(data, false)),
      this.term.onBinary((data) => this.#input(data, true)),
      this.term.onResize(({ cols, rows }) => this.#tellSize(cols, rows)),
      this.term.onTitleChange((title) => this.#setTitle(title)),
      this.#search.onDidChangeResults(({ resultIndex, resultCount }) => this.#update({ search: { ...this.#state.search, index: resultIndex, count: resultCount } })),
      // OSC 7: where the shell is.
      this.term.parser.registerOscHandler(7, (data) => {
        this.#cwd = cwdFromOsc7(data) ?? this.#cwd;
        if (this.#cwd !== null) rememberTerminalFolder(this.id, this.#cwd);
        return false;
      }),
      // OSC 133 (shell integration): A a prompt begins, C a command starts, D it ended (with its status).
      this.term.parser.registerOscHandler(133, (data) => {
        this.#shellMark(data);
        return false;
      }),
      // OSC 9 (iTerm's) and OSC 777 (rxvt's `notify`): a program asks to be noticed. OSC 9;4 is a progress report, not that.
      ...([9, 777] as const).map((osc) =>
        this.term.parser.registerOscHandler(osc, (data) => {
          const text = terminalNotice(osc, data);
          if (text !== null) this.#notify(text);
          return text !== null;
        }),
      ),
      // ⌘K, put into the output by the host where it stands (TERMINAL_CLEAR): the host's copy clears at the same place.
      this.term.parser.registerOscHandler(TERMINAL_CLEAR_OSC, () => {
        this.term.clear();
        return true;
      }),
    );
    this.term.attachCustomKeyEventHandler((event) => this.#key(event));
  }

  // ── What React reads ────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getState = (): TerminalState => this.#state;

  #update(patch: Partial<TerminalState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  // ── Shown, and put away ─────────────────────────────────────────────────

  /** Show it in `host` (the latest to ask holds it), opening it the first time. */
  async attach(host: HTMLElement): Promise<void> {
    this.#hosts = [...this.#hosts.filter((candidate) => candidate !== host), host];
    host.append(this.element);
    if (!this.#opened) {
      if (this.#opening) return;
      this.#opening = true;
      // Measured once, in its own face: wait for the bundled font, or the cells are measured in the fallback's.
      await document.fonts.load(`${String(this.term.options.fontSize ?? TERMINAL_FONT_SIZE.initial)}px "Geist Mono Variable"`).catch(() => undefined);
      this.#opening = false;
      // (Put away meanwhile: opened by the next page to show it — measured in a detached element, its cells would be nothing.)
      if (this.#disposed || !this.element.isConnected) return;
      this.#opened = true;
      this.term.open(this.element);
      // (Frozen — minimized, flying in — it opens at xterm's own size, and is fitted as it thaws.)
      this.fit();
      this.#start(false);
      if (this.#wantsFocus) this.term.focus();
    }
    const shown = this.#hosts.at(-1);
    if (shown !== undefined && this.element.parentElement === shown) this.#gpu(true);
  }

  /** `host` no longer shows it: its element goes back to the one that asked before, if any is still there. */
  detach(host: HTMLElement): void {
    const was = this.#hosts.at(-1);
    this.#hosts = this.#hosts.filter((candidate) => candidate !== host && candidate.isConnected);
    if (was !== host) return;
    const previous = this.#hosts.at(-1);
    if (previous !== undefined) previous.append(this.element);
    else {
      this.element.remove();
      // A WebGL context is a scarce thing (a page has some sixteen): a terminal nobody sees draws without one.
      this.#gpu(false);
    }
  }

  #gpu(on: boolean): void {
    if (!on) {
      this.#webgl?.dispose();
      this.#webgl = null;
      return;
    }
    if (this.#webgl !== null || this.#disposed) return;
    try {
      // (Box drawing and Powerline's separators drawn by the renderer, cell for cell, rather than from the font.)
      const webgl = new WebglAddon({ customGlyphs: true });
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (this.#webgl === webgl) this.#webgl = null;
      });
      this.term.loadAddon(webgl);
      this.#webgl = webgl;
    } catch {
      // No WebGL here: the terminal draws in the DOM instead.
      this.#webgl = null;
    }
  }

  /** Fit the terminal to its element: the shell is told the new size. Not while frozen (minimized, flying, closing). */
  fit(): void {
    if (this.#frozen || !this.#opened || this.element.parentElement === null) return;
    this.#fitNow();
  }

  /** Its window's box stops being its size (minimized, flying, closing), or is again — when it is fitted to it. */
  setFrozen(frozen: boolean): void {
    if (this.#frozen === frozen) return;
    this.#frozen = frozen;
    this.fit();
  }

  #fitNow(): void {
    const box = this.element.getBoundingClientRect();
    if (box.width < 40 || box.height < 20) return;
    const proposed = this.#fit.proposeDimensions();
    if (proposed === undefined || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return;
    const cols = Math.max(2, Math.min(TERMINAL_MAX_COLS, proposed.cols));
    const rows = Math.max(1, Math.min(TERMINAL_MAX_ROWS, proposed.rows));
    if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows);
  }

  focus(): void {
    if (this.term.element === undefined) this.#wantsFocus = true;
    else this.term.focus();
  }

  // ── The shell ───────────────────────────────────────────────────────────

  /** Open its shell (`restart`: a new one, in place of one that ended — the person pressed Enter). */
  #start(restart: boolean): void {
    this.#update({ status: "starting", note: null });
    const cwd = takeTerminalStart(this.id) ?? this.#cwd;
    this.#size = { cols: this.term.cols, rows: this.term.rows };
    send({ type: "open", id: this.id, cols: this.term.cols, rows: this.term.rows, cwd, ...(restart ? { restart: true as const } : {}) });
  }

  /** The host's word about this terminal. */
  receive(event: Exclude<TerminalEvent, { type: "hostGone" }>): void {
    switch (event.type) {
      case "opened": {
        this.#unacked = 0;
        this.#closed = false;
        // Exactly what the host's copy holds — nothing, for a shell new to it — at the size it holds it at; then the size
        // this window has.
        this.term.reset();
        if (event.cols !== this.term.cols || event.rows !== this.term.rows) this.term.resize(event.cols, event.rows);
        if (event.replay !== "") this.term.write(event.replay);
        if (event.cwd !== null) {
          this.#cwd = event.cwd;
          rememberTerminalFolder(this.id, event.cwd);
        }
        this.#update({ status: "running", note: null });
        this.#size = { cols: event.cols, rows: event.rows };
        // (Frozen, it keeps the size it was replayed at until it thaws.)
        this.fit();
        if (this.term.cols !== this.#size.cols || this.term.rows !== this.#size.rows) this.#tellSize(this.term.cols, this.term.rows);
        if (this.#early !== "") {
          send({ type: "input", id: this.id, data: this.#early });
          this.#early = "";
        }
        return;
      }
      case "data":
        this.#write(event.data);
        return;
      case "exit": {
        this.#command = null;
        // `exit` (or ⌃D) at a prompt: the tab goes with its shell, as a terminal's window does. Anything else stays to be read.
        if (event.code === 0 && event.signal === null) {
          void useAppStore.getState().closeTab(this.tabId);
          this.#update({ status: "exited", note: null });
          return;
        }
        const how = event.signal !== null && event.signal !== 0 ? `ended by signal ${String(event.signal)}` : `exited with code ${String(event.code)}`;
        this.#stopped("exited", `The shell ${how}.`);
        return;
      }
      case "closed":
        // The host closed it (its tab was gone long enough). Back meanwhile, it opens anew; gone, it waits to be let go.
        this.#closed = true;
        this.#command = null;
        this.revive();
        return;
      case "notice":
        this.#notify(event.text);
        return;
      case "failed":
        this.#stopped("failed", `The shell could not start: ${event.message}`);
        return;
    }
  }

  /** Its tab is (back) in the snapshot: a terminal the host closed meanwhile opens anew there. */
  revive(): void {
    if (!this.#closed || !this.#opened) return;
    // (By its address: a tab brought back from the closed — ⌘⇧T — is a new tab.)
    const tab = useAppStore.getState().snapshot?.tabs.find((candidate) => terminalUrlId(candidate.url) === this.id);
    if (tab === undefined) return;
    this.tabId = tab.id;
    this.#closed = false;
    this.#start(false);
  }

  /** The terminal host stopped, and the shell with it. */
  hostGone(): void {
    if (this.#state.status === "running" || this.#state.status === "starting") this.#stopped("gone", "The terminal stopped.");
  }

  /**
   * Its shell stopped: why is said beside the text (the page's note), never in it — the text is the host's, and a line
   * the window wrote itself would put the next shell's output elsewhere here than in the host's copy a reload replays.
   */
  #stopped(status: TerminalStatus, note: string): void {
    this.#update({ status, note });
    // The program that ended took its terminal modes with it: they are not the next shell's (nor may they keep Enter from
    // being Enter — kitty's report-all-keys, a frozen synchronized update, mouse reports, its own screen). The host's
    // copy is reset the same way at the same point (after everything the shell said). (Which screen is in use is known
    // once all of that is drawn: the reset follows it.)
    this.term.write("", () => this.term.write(terminalModesReset(this.term.buffer.active.type === "alternate")));
  }

  #write(data: string): void {
    this.term.write(data, () => {
      this.#unacked += data.length;
      if (this.#unacked < TERMINAL_FLOW.ackEvery) return;
      send({ type: "ack", id: this.id, chars: this.#unacked });
      this.#unacked = 0;
    });
  }

  #input(data: string, binary: boolean): void {
    const status = this.#state.status;
    if (status === "running") {
      send(binary ? { type: "input", id: this.id, data, binary: true } : { type: "input", id: this.id, data });
      return;
    }
    // (Stopped, nothing typed goes anywhere: Enter, read from the key itself, starts a new shell — #key.)
    if (status === "starting" && !binary) this.#early += data;
  }

  /** The shell stopped: whatever the keyboard mode, Enter starts a new one where the last one was. */
  #stoppedKey(event: KeyboardEvent): boolean {
    const status = this.#state.status;
    if (status === "running" || status === "starting") return true;
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey && event.type === "keydown") {
      event.preventDefault();
      this.#start(true);
    }
    // (⌘ keys are still the app's: #key.)
    return event.metaKey;
  }

  #tellSize(cols: number, rows: number): void {
    if (this.#state.status !== "running" || (cols === this.#size.cols && rows === this.#size.rows)) return;
    this.#size = { cols, rows };
    send({ type: "resize", id: this.id, cols, rows });
  }

  #setTitle(title: string): void {
    this.#title = title;
    if (this.#titleTimer !== null) return;
    this.#titleTimer = setTimeout(() => {
      this.#titleTimer = null;
      if (this.#disposed) return;
      void shellApi()
        .setTabTitle(this.tabId, this.#title)
        .catch(() => undefined);
    }, TITLE_MS);
  }

  #shellMark(data: string): void {
    const [kind, status] = data.split(";");
    if (kind === "A") {
      const marker = this.term.registerMarker(0);
      if (marker !== undefined) {
        this.#prompts = [...this.#prompts.filter((candidate) => !candidate.isDisposed), marker];
        marker.onDispose(() => (this.#prompts = this.#prompts.filter((candidate) => candidate !== marker)));
      }
    } else if (kind === "C") {
      this.#command = { text: this.#title, at: Date.now() };
    } else if (kind === "D") {
      const command = this.#command;
      this.#command = null;
      if (command === null || Date.now() - command.at < TERMINAL_LONG_COMMAND_MS || this.#inSight()) return;
      this.#notify(commandFinishedNotice(command.text, status), true);
    }
  }

  /** In use, in a window in front: what it says needs no notice. */
  #inSight(): boolean {
    return useAppStore.getState().snapshot?.activeTabId === this.tabId && document.hasFocus() && document.visibilityState === "visible";
  }

  #notify(text: string, quietInSight = false): void {
    if (quietInSight && this.#inSight()) return;
    noticeFor(this.tabId, text);
  }

  // ── Keys the terminal keeps for itself ──────────────────────────────────

  /**
   * ⌘ is the app's, as in Ghostty: a ⌘ key never reaches the program (with
   * the kitty keyboard protocol on, xterm would send ⌘T to it as Super+T),
   * and Pistachio's shortcuts — ⌘T, ⌘W, ⌘L — work over a terminal. A few
   * are the terminal's own: find (⌘F), clear (⌘K), select all (⌘A), the
   * prompts (⌘↑ ⌘↓), the type size (⌘+ ⌘− ⌘0), and copy (⌘C, which copies
   * the selection — and with none, nothing: not the tab's address).
   */
  #key(event: KeyboardEvent): boolean {
    if (!this.#stoppedKey(event)) return false;
    // ⌥← ⌥→: a word back or on, as Ghostty binds them on a Mac (ESC b, ESC f: what zsh, bash and fish read as a word
    // jump; xterm's own CSI 1;3D they do not). ⌥⌫ is xterm's ESC DEL already: the word before goes.
    if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      if (event.type === "keydown") {
        this.term.input(event.key === "ArrowLeft" ? "\x1bb" : "\x1bf");
        event.preventDefault();
        event.stopPropagation();
      }
      return false;
    }
    if (!event.metaKey) return true;
    if (event.type !== "keydown") return false;
    const own = (): false => {
      event.preventDefault();
      event.stopPropagation();
      return false;
    };
    const plain = !event.altKey && !event.ctrlKey;
    const key = event.key.toLowerCase();
    if (plain && !event.shiftKey && key === "f") {
      this.openSearch();
      return own();
    }
    if (plain && !event.shiftKey && key === "k") {
      // Cleared where it stands in the output: the host puts the clear there (TERMINAL_CLEAR), for this window and its
      // copy alike — a window that opens it again is not shown what was cleared, nor anything cleared here only.
      send({ type: "clear", id: this.id });
      return own();
    }
    if (plain && !event.shiftKey && key === "a") {
      this.term.selectAll();
      return own();
    }
    if (plain && !event.shiftKey && key === "c" && !this.term.hasSelection()) return own();
    if (plain && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      this.#jumpToPrompt(event.key === "ArrowUp" ? -1 : 1);
      return own();
    }
    if (plain && (event.key === "=" || event.key === "+")) {
      this.setFontSize((this.term.options.fontSize ?? TERMINAL_FONT_SIZE.initial) + 1);
      return own();
    }
    if (plain && !event.shiftKey && event.key === "-") {
      this.setFontSize((this.term.options.fontSize ?? TERMINAL_FONT_SIZE.initial) - 1);
      return own();
    }
    if (plain && !event.shiftKey && event.key === "0") {
      this.setFontSize(TERMINAL_FONT_SIZE.initial);
      return own();
    }
    return false;
  }

  #jumpToPrompt(direction: -1 | 1): void {
    const buffer = this.term.buffer.active;
    const top = buffer.viewportY;
    const lines = this.#prompts.filter((marker) => !marker.isDisposed).map((marker) => marker.line);
    const target = direction < 0 ? lines.filter((line) => line < top).at(-1) : lines.find((line) => line > top);
    if (target !== undefined) this.term.scrollToLine(target);
    else if (direction > 0) this.term.scrollToBottom();
    else this.term.scrollToTop();
  }

  /** The type size for every terminal (kept for the next): ⌘+ ⌘− ⌘0. */
  setFontSize(size: number): void {
    const next = Math.max(TERMINAL_FONT_SIZE.min, Math.min(TERMINAL_FONT_SIZE.max, Math.round(size)));
    storeFontSize(next);
    for (const session of sessions.values()) {
      if (session.term.options.fontSize === next) continue;
      session.term.options.fontSize = next;
      // (A frozen one takes the type at the size it keeps; fitted as it thaws.)
      session.fit();
    }
  }

  // ── A live share guest's hands (docs/live-share.md §6.6) ─────────────────

  /**
   * A live share guest's events on this terminal, each passed by main's
   * input gate, said to the shell as the host's own keys would be: each key
   * encoded by xterm.js (guest-keys.ts) — never sent through the page, whose
   * key handlers are the host's — and the terminal's own keys (⌥← ⌥→, Enter
   * once the shell stopped) theirs as they are the host's; but no ⌘ key: ⌘
   * is the app's, and the app is the host's (find, ⌘K, the type size are
   * not a guest's). A paste goes bracketed, for programs that ask; the wheel
   * scrolls the scrollback.
   */
  guestInput(from: string, events: readonly LiveTerminalEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case "keyDown":
        case "keyUp":
          this.#guestKey(from, event);
          break;
        case "char":
          // (Each guest's own: two typing at once, one's keys come between the other's key down and its char.)
          if (this.#guestTyped.delete(from)) this.term.input(event.text, true);
          break;
        case "insertText":
          this.term.input(guestPaste(this.term, event.text), true);
          break;
        case "wheel":
          this.#guestScroll(event.dy);
          break;
      }
    }
  }

  #guestKey(from: string, key: Extract<LiveTerminalEvent, { type: "keyDown" | "keyUp" }>): void {
    const down = key.type === "keyDown";
    if (down) this.#guestTyped.delete(from);
    const event = guestKeyEvent(down ? "keydown" : "keyup", key);
    if (event.metaKey || !this.#key(event)) return;
    if (!down) {
      const release = guestKeyUp(this.term, event);
      if (release !== null) this.term.input(release, true);
      return;
    }
    const said = guestKeyDown(this.term, event, IS_MAC, key.type === "keyDown" ? key.mac : undefined);
    if (said === "typed") this.#guestTyped.add(from);
    else if ("page" in said) this.term.scrollLines(said.page * Math.max(1, this.term.rows - 1));
    else this.term.input(said.data, true);
  }

  /** A guest's wheel: the scrollback, a line for each line's height it went (dy in CSS px, down positive). */
  #guestScroll(dy: number): void {
    const line = (this.term.options.fontSize ?? TERMINAL_FONT_SIZE.initial) * (this.term.options.lineHeight ?? 1);
    this.#guestWheel += dy / line;
    const lines = Math.trunc(this.#guestWheel);
    this.#guestWheel -= lines;
    if (lines !== 0) this.term.scrollLines(lines);
  }

  // ── Find ────────────────────────────────────────────────────────────────

  openSearch(): void {
    this.#update({ search: { ...this.#state.search, open: true } });
  }

  closeSearch(): void {
    this.#search.clearDecorations();
    this.#update({ search: { open: false, index: -1, count: 0 } });
    this.focus();
  }

  find(text: string, direction: "next" | "previous", incremental = false): void {
    if (text === "") {
      this.#search.clearDecorations();
      this.#update({ search: { ...this.#state.search, index: -1, count: 0 } });
      return;
    }
    const theme = this.term.options.theme ?? {};
    const options: ISearchOptions = {
      incremental,
      decorations: {
        matchBackground: `${(theme.yellow ?? "#d29922").slice(0, 7)}55`,
        matchOverviewRuler: theme.yellow ?? "#d29922",
        activeMatchBackground: `${(theme.yellow ?? "#d29922").slice(0, 7)}aa`,
        activeMatchColorOverviewRuler: theme.foreground ?? "#ffffff",
      },
    };
    if (direction === "next") this.#search.findNext(text, options);
    else this.#search.findPrevious(text, options);
  }

  /** The text on its screen and in its scrollback, as the lines the shell wrote (a row wrapped onto the next is one line; the e2e reads it). */
  text(): string {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index);
      if (line === undefined) continue;
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += line.translateToString(true);
      else lines.push(line.translateToString(true));
    }
    return lines.join("\n").replace(/\n+$/u, "");
  }

  /** Where its shell is, as far as its integration has said. */
  cwd(): string | null {
    return this.#cwd;
  }

  restyle(theme: ITheme): void {
    this.term.options.theme = theme;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#titleTimer !== null) clearTimeout(this.#titleTimer);
    for (const disposable of this.#disposables) disposable.dispose();
    this.#webgl?.dispose();
    this.term.dispose();
    this.element.remove();
    this.#listeners.clear();
  }
}

/** A link in a terminal opens in a tab of its own, only with ⌘ held (a click alone is a click in the terminal). */
function openLink(event: MouseEvent, uri: string): void {
  if (!event.metaKey) return;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  void useAppStore.getState().createTab(url.href);
}

// ── The registry ──────────────────────────────────────────────────────────

const sessions = new Map<string, TerminalSession>();
const releases = new Map<string, ReturnType<typeof setTimeout>>();
let wired = false;

/** Each terminal's tab, kept after the terminal is let go here: a notice from the host names it. */
const tabOfTerminal = new Map<string, string>();

/**
 * Say what a terminal's program asked to be noticed for (or that a long command ended): a notice in the window — with
 * Show, its tab being one of this Profile's — and, the app in the background, the Mac's own notification too.
 */
function noticeFor(tabId: string | null, text: string): void {
  const store = useAppStore.getState();
  const tab = tabId === null ? undefined : store.snapshot?.tabs.find((candidate) => candidate.id === tabId);
  const name = tab?.title ?? "Terminal";
  const show = tab === undefined ? null : () => void useAppStore.getState().selectTab(tab.id);
  store.showNotice(`${name}: ${text}`, show === null ? {} : { action: { label: "Show", run: show } });
  if (!document.hasFocus() && typeof Notification === "function") {
    try {
      const notice = new Notification(name, { body: text, silent: false });
      notice.onclick = () => {
        window.focus();
        show?.();
      };
    } catch {
      // (Notifications refused: the notice in the window stays.)
    }
  }
}

/** The terminal `id` (shown in tab `tabId`), made the first time it is asked for. */
export function terminalSession(id: string, tabId: string): TerminalSession {
  wire();
  tabOfTerminal.set(id, tabId);
  clearTimeout(releases.get(id));
  releases.delete(id);
  let session = sessions.get(id);
  if (session === undefined) {
    session = new TerminalSession(id, tabId);
    sessions.set(id, session);
  }
  session.tabId = tabId;
  return session;
}

/** Every terminal the shell holds now, by id (the e2e reads them). */
export function terminalSessions(): ReadonlyMap<string, TerminalSession> {
  return sessions;
}

/** The terminal shown in `tabId`, if it has one now. */
export function terminalOfTab(tabId: string): TerminalSession | null {
  for (const session of sessions.values()) if (session.tabId === tabId) return session;
  return null;
}

function wire(): void {
  if (wired) return;
  wired = true;
  nativeApi()?.onTerminalEvent((event) => {
    if (event.type === "hostGone") {
      for (const session of sessions.values()) session.hostGone();
      return;
    }
    const session = sessions.get(event.id);
    if (session !== undefined) session.receive(event);
    // A terminal let go here (its Profile not in front) still says what its program asked to be noticed for.
    else if (event.type === "notice") noticeFor(tabOfTerminal.get(event.id) ?? null, event.text);
  });
  // A live share guest's keys on a terminal the host let them use, each passed by main's input gate: the tab's terminal,
  // by its address (a duplicated tab shows the same one).
  nativeApi()?.onLiveTerminalInput((input) => {
    const tab = useAppStore.getState().snapshot?.tabs.find((candidate) => candidate.id === input.tabId);
    const id = tab === undefined ? null : terminalUrlId(tab.url);
    if (id !== null) sessions.get(id)?.guestInput(input.from, input.events);
  });
  // A terminal whose tab left the snapshot is let go (its shell runs on in the host until no tab names it).
  useAppStore.subscribe((state, previous) => {
    if (state.snapshot?.tabs === previous.snapshot?.tabs) return;
    const named = new Set((state.snapshot?.tabs ?? []).flatMap((tab) => terminalUrlId(tab.url) ?? []));
    for (const [id, session] of sessions) {
      if (named.has(id)) {
        clearTimeout(releases.get(id));
        releases.delete(id);
        session.revive();
      } else if (!releases.has(id)) {
        releases.set(
          id,
          setTimeout(() => {
            releases.delete(id);
            if (sessions.get(id) !== session) return;
            sessions.delete(id);
            forgetTerminal(id);
            session.dispose();
            // Nothing more is drawn here: the host stops sending, and never holds the shell back for want of drawing.
            send({ type: "release", id });
          }, RELEASE_MS),
        );
      }
    }
  });
  // Appearance changed (light or dark, the tint): every terminal takes the new colours. (The root's style changes for
  // other reasons too; a terminal is restyled — its glyphs drawn anew — only when its colours did.)
  let colors = JSON.stringify(terminalTheme());
  const observer = new MutationObserver(() => {
    if (sessions.size === 0) return;
    const theme = terminalTheme();
    const next = JSON.stringify(theme);
    if (next === colors) return;
    colors = next;
    for (const session of sessions.values()) session.restyle(theme);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-scheme", "style"] });
  // (For the e2e: a terminal's text, read from its buffer — the WebGL renderer leaves none in the DOM.)
  (globalThis as { __pistachioTerminals?: unknown }).__pistachioTerminals = {
    text: (id: string) => sessions.get(id)?.text() ?? null,
    status: (id: string) => sessions.get(id)?.getState().status ?? null,
    cwd: (id: string) => sessions.get(id)?.cwd() ?? null,
    fontSize: (id: string) => sessions.get(id)?.term.options.fontSize ?? null,
    terminal: (id: string) => sessions.get(id)?.term ?? null,
  };
}
