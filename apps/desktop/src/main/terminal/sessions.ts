/**
 * The terminal host's sessions (docs/terminal.md §3): each terminal's shell,
 * its mirror, what is owed to the window that shows it, and when it goes.
 * Apart from the utility process's wiring (./host.ts) — node-pty, the
 * headless terminal, the port, the disk — so it is tested with stand-ins.
 *
 * A session is **attached** while a window has it open over the current
 * port: its output is sent there, and held back (the shell not read) while
 * the window is too far behind in drawing it. A window that lets a terminal
 * go (`release`: its tab left the shell's snapshot — another Profile), a new
 * port (the window loaded again) or a closed one detaches every session it
 * had: nothing is owed to a window that is not drawing, and a shell is never
 * left paused for one — a build or a server in a terminal out of sight runs
 * on, its output kept by the mirror.
 *
 * Which terminals live is main's to say (`retain`: the ids tabs name). A
 * terminal no tab names is closed a moment later — whether it was running
 * when main said so, or started after (an `open` that waited for the shell
 * integration while its tab closed).
 */

import { TERMINAL_CLEAR, TERMINAL_FLOW, type TerminalEvent, type TerminalRequest } from "@pistachio/shell-contracts/terminal";

/** A shell on a pseudo-terminal: what is used of node-pty's IPty. */
export interface Shell {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
}

/** A headless terminal drawing a shell's output, for a window that opens it later. */
export interface Mirror {
  readonly cols: number;
  readonly rows: number;
  /** `drawn` runs once everything written before it is drawn, and before anything written after it. */
  write(data: string, drawn?: () => void): void;
  resize(cols: number, rows: number): void;
  /** The screen, its scrollback and its modes, as the escape sequences that draw them. */
  serialize(): string;
  /** Every mode the shell's last program left on, put back (`terminalModesReset`): its shell ended. */
  resetModes(): void;
  dispose(): void;
}

export interface MirrorEars {
  onCwd(cwd: string): void;
  onReply(reply: string): void;
  onNotice(text: string): void;
  /** A program put text on the clipboard (OSC 52): heard once, here, for every terminal, drawn or not. */
  onClipboard(text: string): void;
}

/** Where each terminal was, kept across restarts. */
export interface TerminalPlaces {
  get(id: string): string | null;
  set(id: string, cwd: string): void;
  /** The ids tabs name now: theirs are kept fresh, a long-unnamed one forgotten. */
  retain(ids: ReadonlySet<string>): void;
}

export interface TerminalSessionsDeps {
  send(event: TerminalEvent): void;
  /** Start a shell in `cwd` at this size (throws when it cannot). */
  spawn(cwd: string, cols: number, rows: number): Shell;
  /**
   * A mirror at this size. `onCwd` hears each folder the shell reports (OSC 7); `onReply`, the mirror's answer to a
   * program's question (where the cursor is, what the terminal is) — sent to the shell while no window is there to;
   * `onNotice`, what a program asked to be noticed for, or a long command's end — said while no window is there to.
   */
  mirror(cols: number, rows: number, hear: MirrorEars): Mirror;
  places: TerminalPlaces;
  isFolder(path: string): boolean;
  home: string;
  /** Settles once the shell integration is written: no shell starts before. */
  ready: Promise<unknown>;
  /** Whether process `pid` is still there. */
  alive(pid: number): boolean;
  /** Put text on the Mac's clipboard (main does: it needs no window, nor the focus a page's clipboard does). */
  clipboard(text: string): void;
}

/** Output is gathered this long before it is sent: a flood is a few large messages, not thousands of small ones. */
export const BATCH_MS = 5;
/** A terminal no tab names any more is closed this long after (a tab passing between spaces is never without one). */
export const RELEASE_MS = 1_500;
/** A shell that does not end on SIGHUP is killed this long after. */
export const KILL_MS = 3_000;
/**
 * When a shell is held back for its mirror (characters written to it and not yet drawn), and when it reads on. The
 * mirror draws asynchronously, and a headless terminal more than 50 MB behind throws — in the host every shell runs in.
 */
export const MIRROR_FLOW = { high: 2_000_000, low: 200_000 } as const;

interface Session {
  id: string;
  shell: Shell | null;
  /** How its shell ended, once it has: told to a window that opens it after. */
  exit: { code: number; signal: number | null } | null;
  mirror: Mirror;
  cwd: string | null;
  /** A window has it open over the current port: its output is sent there. */
  attached: boolean;
  /**
   * The mirror answers the program's questions (where the cursor is): the window does not have the output they came in.
   * It changes hands where the output does — at the replay's boundary as a window opens it, at the release's as one
   * lets it go — not at the request: the mirror draws behind, and a question it is still drawing belongs to whichever
   * side the output it came in was meant for.
   */
  mirrorAnswers: boolean;
  /** Counts attachments: a replay made for one is not sent to the next. */
  serial: number;
  /** Its replay is being made: output waits behind it. */
  holding: boolean;
  /**
   * Output gathered for the next send to the window. It reaches the mirror only as it is sent (or, never sent, as the
   * window lets go — the mirror's to draw and answer then): who answers a question in it is decided by where it went.
   */
  pending: string;
  /** Output sent and not yet drawn, as the window acknowledges it. */
  unacked: number;
  /** Output written to the mirror and not yet drawn there. */
  mirrorBehind: number;
  /** The shell is not read: the window, or the mirror, is too far behind (#holdBack, #ease). */
  paused: boolean;
}

export class TerminalSessions {
  readonly #deps: TerminalSessionsDeps;
  readonly #sessions = new Map<string, Session>();
  /** Terminals being started (waiting for the integration), and whether their window let go of them meanwhile. */
  readonly #starting = new Map<string, { detached: boolean }>();
  readonly #releases = new Map<string, ReturnType<typeof setTimeout>>();
  /** What main last said tabs name; null until it has said. */
  #retained: ReadonlySet<string> | null = null;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: TerminalSessionsDeps) {
    this.#deps = deps;
  }

  handle(request: TerminalRequest): void {
    switch (request.type) {
      case "open":
        void this.#open(request);
        return;
      case "input": {
        const shell = this.#sessions.get(request.id)?.shell ?? null;
        if (shell === null) return;
        // (A mouse report in the legacy encoding is bytes, not text.)
        shell.write(request.binary === true ? Buffer.from(request.data, "binary") : request.data);
        return;
      }
      case "resize": {
        const session = this.#sessions.get(request.id);
        if (session === undefined) return;
        session.mirror.resize(request.cols, request.rows);
        try {
          session.shell?.resize(request.cols, request.rows);
        } catch {
          // (Its shell just ended.)
        }
        return;
      }
      case "ack": {
        const session = this.#sessions.get(request.id);
        if (session === undefined || !session.attached) return;
        session.unacked = Math.max(0, session.unacked - request.chars);
        this.#ease(session);
        return;
      }
      case "clear": {
        // Into the output where it stands: the window and the mirror clear the same lines.
        const session = this.#sessions.get(request.id);
        if (session === undefined) return;
        if (!session.attached) this.#toMirror(session, TERMINAL_CLEAR);
        else {
          session.pending += TERMINAL_CLEAR;
          session.unacked += TERMINAL_CLEAR.length;
          this.#scheduleFlush();
        }
        return;
      }
      case "release": {
        const session = this.#sessions.get(request.id);
        if (session !== undefined) this.#detach(session);
        const starting = this.#starting.get(request.id);
        if (starting !== undefined) starting.detached = true;
        return;
      }
    }
  }

  /** The window's port changed, or closed: it opens its terminals anew, and owes nothing meanwhile. */
  detachAll(): void {
    for (const session of this.#sessions.values()) this.#detach(session);
    for (const starting of this.#starting.values()) starting.detached = true;
  }

  /** The terminals tabs name now: any other is closed a moment later (unless named again meanwhile). */
  retain(ids: readonly string[]): void {
    const kept = new Set(ids);
    this.#retained = kept;
    for (const id of new Set([...this.#sessions.keys(), ...this.#starting.keys()])) this.#reconcile(id);
    this.#deps.places.retain(kept);
  }

  /** The ids of the shells running now (tests, and a look from main). */
  running(): string[] {
    return [...this.#sessions.values()].filter((session) => session.shell !== null).map((session) => session.id);
  }

  // ── Opening ─────────────────────────────────────────────────────────────

  async #open(request: Extract<TerminalRequest, { type: "open" }>): Promise<void> {
    const { id, cols, rows } = request;
    const found = this.#sessions.get(id);
    // Running, or ended while no window had it (a Profile away, a reload): what its screen held — and how it ended.
    if (found !== undefined && (found.shell !== null || (found.exit !== null && request.restart !== true))) {
      this.#replay(found);
      return;
    }
    // Never started, or ended and the person asked for another: a fresh shell, where it was asked to be or where it last was.
    // (Being started for a window that has since loaded again: the window asking now is the one it starts for.)
    const pending = this.#starting.get(id);
    if (pending !== undefined) {
      pending.detached = false;
      return;
    }
    const starting = { detached: false };
    this.#starting.set(id, starting);
    try {
      await this.#deps.ready;
    } finally {
      this.#starting.delete(id);
    }
    const again = this.#sessions.get(id);
    if (again !== undefined && (again.shell !== null || (again.exit !== null && request.restart !== true))) {
      this.#replay(again);
      return;
    }
    const remembered = this.#deps.places.get(id);
    const cwd = [request.cwd, remembered, this.#deps.home].find((candidate): candidate is string => candidate !== null && this.#deps.isFolder(candidate)) ?? "/";
    // (Its window let go of it while it waited: it starts with nobody drawing it.)
    const attached = !starting.detached;
    let session: Session;
    if (again === undefined) {
      const made: Session = {
        id,
        shell: null,
        exit: null,
        mirror: this.#deps.mirror(cols, rows, {
          onCwd: (folder) => this.#moved(made, folder),
          onReply: (reply) => this.#reply(made, reply),
          onNotice: (text) => this.#notice(made, text),
          // (A copy is the mirror's to make, never the window's too: it sees every byte once, drawn or not.)
          onClipboard: (text) => this.#deps.clipboard(text),
        }),
        cwd,
        attached,
        mirrorAnswers: !attached,
        serial: 1,
        holding: false,
        pending: "",
        unacked: 0,
        mirrorBehind: 0,
        paused: false,
      };
      session = made;
      this.#sessions.set(id, session);
    } else {
      // A restart: the same terminal, its mirror going on — scrollback and all — under a new shell.
      session = again;
      Object.assign(session, { exit: null, cwd, attached, mirrorAnswers: !attached, serial: session.serial + 1, holding: false, pending: "", unacked: 0, paused: false });
      session.mirror.resize(cols, rows);
    }
    try {
      this.#start(session, cols, rows);
    } catch (error) {
      if (again === undefined) {
        this.#sessions.delete(id);
        session.mirror.dispose();
      }
      this.#deps.send({ type: "failed", id, message: error instanceof Error ? error.message : String(error) });
      return;
    }
    // Where it starts is where it is, until it says otherwise: a terminal opened in another's folder reopens there.
    this.#deps.places.set(id, cwd);
    // The window becomes what the mirror holds: nothing, for a terminal new here (a host started again, a tab reopened); its
    // old scrollback, for a shell restarted under it.
    if (session.attached) this.#replay(session, true);
    // (Its tab may have closed while it waited: main said so before there was a shell to close.)
    this.#reconcile(id);
  }

  /**
   * The window opens it: what its screen holds now — the window's terminal becomes exactly the mirror — then what it
   * says after (or how it ended, if it has). `fresh`: its shell was started for this opening.
   */
  #replay(session: Session, fresh = false): void {
    session.attached = true;
    session.serial += 1;
    const serial = session.serial;
    session.holding = true;
    session.pending = "";
    session.unacked = 0;
    this.#ease(session);
    session.mirror.write("", () => {
      // (Let go, or opened again, meanwhile: this replay is nobody's.)
      if (session.serial !== serial || this.#sessions.get(session.id) !== session) return;
      // Everything before here the mirror drew (and answered); everything after goes to the window, which answers it.
      session.mirrorAnswers = false;
      this.#deps.send({ type: "opened", id: session.id, replay: session.mirror.serialize(), cols: session.mirror.cols, rows: session.mirror.rows, fresh, cwd: session.cwd });
      session.holding = false;
      // What it said while the replay was made, after the replay; and, ended (while nobody had it open, or just now), how.
      this.#flushSession(session);
      if (session.shell === null && session.exit !== null) this.#ended(session);
    });
  }

  #start(session: Session, cols: number, rows: number): void {
    const shell = this.#deps.spawn(session.cwd ?? this.#deps.home, cols, rows);
    session.shell = shell;
    shell.onData((data) => {
      if (session.shell !== shell) return;
      // Nobody drawing it: the mirror's, to draw and to answer, at once.
      if (!session.attached) {
        this.#toMirror(session, data);
        return;
      }
      session.pending += data;
      session.unacked += data.length;
      this.#holdBack(session);
      this.#scheduleFlush();
    });
    shell.onExit(({ exitCode, signal }) => {
      if (session.shell !== shell) return;
      session.shell = null;
      session.paused = false;
      // (node-pty says 0 for "no signal".)
      session.exit = { code: exitCode, signal: signal === undefined || signal === 0 ? null : signal };
      // (A replay being made ends it after the screen and what came while it was made: see #replay.)
      if (session.holding) return;
      this.#flushSession(session);
      this.#ended(session);
    });
  }

  /**
   * Its shell ended, and everything it said is where it goes: what its last program left on (the kitty flags, its own
   * screen) is put back in the mirror — not the next shell's, nor a replay's — and the window, if one has it, is told.
   */
  #ended(session: Session): void {
    session.mirror.resetModes();
    if (session.attached && session.exit !== null) this.#deps.send({ type: "exit", id: session.id, ...session.exit });
  }

  /**
   * The mirror answered a program's question (a cursor position report, the terminal's name): the shell gets the answer
   * while no window has it — one that has it answers itself, and two answers would be one too many.
   */
  #reply(session: Session, reply: string): void {
    if (!session.mirrorAnswers || session.shell === null) return;
    session.shell.write(reply);
  }

  /** A program asked to be noticed, or a long command ended: said from here only while no window has the terminal. */
  #notice(session: Session, text: string): void {
    if (session.mirrorAnswers) this.#deps.send({ type: "notice", id: session.id, text });
  }

  #moved(session: Session, folder: string): void {
    if (folder === session.cwd) return;
    session.cwd = folder;
    this.#deps.places.set(session.id, folder);
  }

  // ── Output ──────────────────────────────────────────────────────────────

  #scheduleFlush(): void {
    if (this.#flushTimer !== null) return;
    this.#flushTimer = setTimeout(() => this.#flush(), BATCH_MS);
  }

  #flush(): void {
    if (this.#flushTimer !== null) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    for (const session of this.#sessions.values()) this.#flushSession(session);
  }

  /** Its gathered output to the window — and, as it goes, to the mirror (the window answers what is in it). */
  #flushSession(session: Session): void {
    if (session.pending === "" || session.holding || !session.attached) return;
    this.#toMirror(session, session.pending);
    this.#deps.send({ type: "data", id: session.id, data: session.pending });
    session.pending = "";
  }

  /** Output into the mirror, counted until it is drawn: a mirror too far behind holds the shell back too. */
  #toMirror(session: Session, data: string): void {
    session.mirrorBehind += data.length;
    session.mirror.write(data, () => {
      session.mirrorBehind -= data.length;
      this.#ease(session);
    });
    this.#holdBack(session);
  }

  /** The shell stops being read while the window (if one has it) or the mirror is too far behind. */
  #holdBack(session: Session): void {
    if (session.paused || session.shell === null) return;
    if (session.mirrorBehind <= MIRROR_FLOW.high && !(session.attached && session.unacked > TERMINAL_FLOW.high)) return;
    session.paused = true;
    session.shell.pause();
  }

  /** …and is read again once both have caught up. */
  #ease(session: Session): void {
    if (!session.paused) return;
    if (session.mirrorBehind >= MIRROR_FLOW.low || (session.attached && session.unacked >= TERMINAL_FLOW.low)) return;
    session.paused = false;
    session.shell?.resume();
  }

  #detach(session: Session): void {
    session.attached = false;
    session.serial += 1;
    session.holding = false;
    session.unacked = 0;
    this.#ease(session);
    // What the window was sent before letting go is the window's to answer; what the mirror draws after is the mirror's —
    // the output gathered and never sent first: the window never saw the questions in it. (Always: the hand-overs are
    // drawn in the order they were made, and a window opening it again at once hands back only at its replay's boundary.)
    session.mirror.write("", () => {
      session.mirrorAnswers = true;
    });
    if (session.pending !== "") this.#toMirror(session, session.pending);
    session.pending = "";
    // (Ended while its replay was being made, which was let go: what it left on goes after what it said.)
    if (session.shell === null && session.exit !== null) session.mirror.resetModes();
  }

  // ── Going ───────────────────────────────────────────────────────────────

  /** Closed a moment from now if no tab names it, kept if one does. */
  #reconcile(id: string): void {
    if (this.#retained === null || this.#retained.has(id)) {
      clearTimeout(this.#releases.get(id));
      this.#releases.delete(id);
      return;
    }
    if (this.#releases.has(id)) return;
    this.#releases.set(
      id,
      setTimeout(() => {
        this.#releases.delete(id);
        this.#close(id);
      }, RELEASE_MS),
    );
  }

  #close(id: string): void {
    const session = this.#sessions.get(id);
    if (session === undefined) return;
    this.#sessions.delete(id);
    // (A window that still has it — its tab back from the closed, too late to keep it — opens it anew.)
    this.#deps.send({ type: "closed", id });
    const shell = session.shell;
    session.shell = null;
    session.mirror.dispose();
    if (shell === null) return;
    try {
      shell.kill("SIGHUP");
    } catch {
      return;
    }
    // (A shell that shrugs off the hang-up — a `nohup`ed foreground job — goes anyway.)
    const timer = setTimeout(() => {
      if (this.#deps.alive(shell.pid)) shell.kill("SIGKILL");
    }, KILL_MS);
    (timer as { unref?: () => void }).unref?.();
  }
}
