import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_CLEAR, TERMINAL_FLOW, type TerminalEvent } from "@pistachio/shell-contracts/terminal";
import { MIRROR_FLOW, RELEASE_MS, TerminalSessions, type Mirror, type MirrorEars, type Shell, type TerminalPlaces } from "../src/main/terminal/sessions";

const ID = "0a1b2c3d4e5f";

class FakeShell implements Shell {
  readonly pid = 4242;
  readonly written: Array<string | Buffer> = [];
  readonly signals: string[] = [];
  paused = false;
  #data: Array<(data: string) => void> = [];
  #exit: Array<(exit: { exitCode: number; signal?: number }) => void> = [];
  constructor(readonly cwd: string) {}
  onData(listener: (data: string) => void): void {
    this.#data.push(listener);
  }
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): void {
    this.#exit.push(listener);
  }
  write(data: string | Buffer): void {
    this.written.push(data);
  }
  resize(): void {}
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  kill(signal = "SIGHUP"): void {
    this.signals.push(signal);
  }
  /** The shell writes. */
  emit(data: string): void {
    for (const listener of this.#data) listener(data);
  }
  end(exitCode: number, signal?: number): void {
    for (const listener of this.#exit) listener({ exitCode, ...(signal === undefined ? {} : { signal }) });
  }
}

/**
 * A mirror that draws as xterm.js does: what is written is drawn later, in order, each write's callback after it; and it
 * answers a cursor position query (`CSI 6 n`) as it draws it.
 */
class FakeMirror implements Mirror {
  text = "";
  disposed = false;
  resets = 0;
  readonly #queue: Array<() => void> = [];
  #draining = false;
  /** Stalled: what is written waits to be drawn until `drain()` (a mirror slower than its shell). */
  stalled = false;
  drain(): void {
    while (this.#queue.length > 0) this.#queue.shift()!();
  }
  constructor(
    public cols: number,
    public rows: number,
    readonly hear: MirrorEars,
  ) {}
  /** The mirror heard a program ask to be noticed. */
  notice(text: string): void {
    this.hear.onNotice(text);
  }
  /** The mirror heard a program put text on the clipboard (OSC 52). */
  copy(text: string): void {
    this.hear.onClipboard(text);
  }
  onCwd(cwd: string): void {
    this.hear.onCwd(cwd);
  }
  write(data: string, drawn?: () => void): void {
    this.#enqueue(() => {
      // (⌘K, where it stands: what came before it is gone.)
      const cleared = data.lastIndexOf(TERMINAL_CLEAR);
      if (cleared >= 0) this.text = data.slice(cleared + TERMINAL_CLEAR.length);
      else this.text += data;
      for (let count = data.split("\x1b[6n").length - 1; count > 0; count--) this.hear.onReply("\x1b[1;1R");
      drawn?.();
    });
  }
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
  serialize(): string {
    return `<screen:${this.text}>`;
  }
  resetModes(): void {
    this.#enqueue(() => {
      this.resets += 1;
    });
  }
  dispose(): void {
    this.disposed = true;
  }
  #enqueue(step: () => void): void {
    this.#queue.push(step);
    if (this.#draining || this.stalled) return;
    this.#draining = true;
    queueMicrotask(() => {
      while (this.#queue.length > 0) this.#queue.shift()!();
      this.#draining = false;
    });
  }
}

class MemoryPlaces implements TerminalPlaces {
  readonly places = new Map<string, string>();
  get(id: string): string | null {
    return this.places.get(id) ?? null;
  }
  set(id: string, cwd: string): void {
    this.places.set(id, cwd);
  }
  retain(): void {}
}

function harness(options: { ready?: Promise<unknown>; folders?: string[] } = {}) {
  const events: TerminalEvent[] = [];
  const copies: string[] = [];
  const shells: FakeShell[] = [];
  const mirrors: FakeMirror[] = [];
  const places = new MemoryPlaces();
  const folders = new Set(options.folders ?? ["/Users/ada"]);
  const sessions = new TerminalSessions({
    send: (event) => events.push(event),
    spawn: (cwd) => {
      const shell = new FakeShell(cwd);
      shells.push(shell);
      return shell;
    },
    mirror: (cols, rows, hear) => {
      const mirror = new FakeMirror(cols, rows, hear);
      mirrors.push(mirror);
      return mirror;
    },
    places,
    isFolder: (path) => folders.has(path),
    home: "/Users/ada",
    ready: options.ready ?? Promise.resolve(),
    alive: () => true,
    clipboard: (text) => copies.push(text),
  });
  const sent = (type: TerminalEvent["type"]) => events.filter((event) => event.type === type);
  return { sessions, events, shells, mirrors, places, sent, copies };
}

/** Let the open's await, and a mirror's drawn callback, run. */
const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a terminal's shell", () => {
  it("starts where it was asked, sends its output in batches, and is held back while the window is behind", async () => {
    const { sessions, shells, sent } = harness({ folders: ["/Users/ada", "/srv/app"] });
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: "/srv/app" });
    await settle();
    expect(shells[0]?.cwd).toBe("/srv/app");
    // (The window becomes what the mirror holds: for a shell started now, an empty screen.)
    expect(sent("opened")).toEqual([{ type: "opened", id: ID, replay: "<screen:>", cols: 80, rows: 24, fresh: true, cwd: "/srv/app" }]);

    shells[0]!.emit("a");
    shells[0]!.emit("b");
    vi.advanceTimersByTime(10);
    expect(sent("data")).toEqual([{ type: "data", id: ID, data: "ab" }]);

    shells[0]!.emit("x".repeat(TERMINAL_FLOW.high + 1));
    expect(shells[0]!.paused).toBe(true);
    sessions.handle({ type: "ack", id: ID, chars: TERMINAL_FLOW.high });
    expect(shells[0]!.paused).toBe(false);
  });

  it("is replayed from its mirror to a window that opens it again", async () => {
    const { sessions, shells, sent } = harness();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    shells[0]!.emit("hello");
    sessions.detachAll();
    sessions.handle({ type: "open", id: ID, cols: 100, rows: 30, cwd: null });
    await settle();
    expect(shells).toHaveLength(1);
    expect(sent("opened").at(-1)).toMatchObject({ replay: "<screen:hello>", fresh: false, cols: 80, rows: 24 });
  });
});

describe("a shell that ended", () => {
  it("ended while no window had it: opened again, the window gets its screen and then how it ended — no new shell", async () => {
    const { sessions, shells, events } = harness();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    shells[0]!.emit("make: *** [all] Error 2");
    sessions.handle({ type: "release", id: ID });
    shells[0]!.end(2);
    expect(events.filter((event) => event.type === "exit")).toEqual([]);

    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    expect(shells).toHaveLength(1);
    expect(events.slice(-2)).toEqual([
      expect.objectContaining({ type: "opened", fresh: false, replay: "<screen:make: *** [all] Error 2>" }),
      { type: "exit", id: ID, code: 2, signal: null },
    ]);
  });

  it("is started again only when the person asks, its scrollback kept", async () => {
    const { sessions, shells, events } = harness();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    shells[0]!.emit("first shell");
    shells[0]!.end(1);
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null, restart: true });
    await settle();
    expect(shells).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "opened", fresh: true });
    shells[1]!.emit(" second shell");
    sessions.detachAll();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    expect(events.at(-1)).toMatchObject({ type: "opened", replay: "<screen:first shell second shell>" });
  });

  it("ending while its replay is made: the window hears how only after the screen", async () => {
    const { sessions, shells, events } = harness();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    sessions.detachAll();
    const from = events.length;
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    // (The mirror has not drawn yet: the replay is pending.)
    shells[0]!.end(0);
    await settle();
    expect(events.slice(from).map((event) => event.type)).toEqual(["opened", "exit"]);
  });
});

describe("a program's question to the terminal (where is the cursor?)", () => {
  const QUERY = "\x1b[6n";

  it("is the window's while a window has the terminal, the mirror's while none has it", async () => {
    const { sessions, shells } = harness();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    shells[0]!.emit(QUERY);
    vi.advanceTimersByTime(10);
    await settle();
    expect(shells[0]!.written).toEqual([]);
    sessions.handle({ type: "release", id: ID });
    await settle();
    shells[0]!.emit(QUERY);
    await settle();
    expect(shells[0]!.written).toEqual(["\x1b[1;1R"]);
  });

  it("in output sent to the window just before it let go: the window's, not answered twice", async () => {
    const { sessions, shells } = harness();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    shells[0]!.emit(QUERY);
    vi.advanceTimersByTime(10);
    sessions.handle({ type: "release", id: ID });
    await settle();
    expect(shells[0]!.written).toEqual([]);
  });

  it("in output gathered and not yet sent when the window lets go: the mirror's — the window never saw it", async () => {
    const { sessions, shells } = harness();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    shells[0]!.emit(QUERY);
    sessions.handle({ type: "release", id: ID });
    await settle();
    expect(shells[0]!.written).toEqual(["\x1b[1;1R"]);
  });

  it("in output never sent, the window gone and back at once: still the mirror's", async () => {
    const { sessions, shells } = harness();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    shells[0]!.emit(QUERY);
    // The window loads again and opens it anew before the mirror has drawn anything.
    sessions.detachAll();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    expect(shells[0]!.written).toEqual(["\x1b[1;1R"]);
  });

  it("asked just before a window opens it again: the mirror's (the replay is the screen, not the question)", async () => {
    const { sessions, shells } = harness();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    sessions.handle({ type: "release", id: ID });
    await settle();
    shells[0]!.emit(QUERY);
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    expect(shells[0]!.written).toEqual(["\x1b[1;1R"]);
    // Past the replay, the window's.
    shells[0]!.emit(QUERY);
    vi.advanceTimersByTime(10);
    await settle();
    expect(shells[0]!.written).toEqual(["\x1b[1;1R"]);
  });
});

describe("a shell's end", () => {
  it("puts back what its last program left on in the mirror, so a replay does not hand it to the next shell", async () => {
    const { sessions, shells, mirrors } = harness();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    shells[0]!.end(137, 9);
    await settle();
    expect(mirrors[0]!.resets).toBe(1);
  });
});

describe("the window kept up with the host", () => {
  it("restarted under its old scrollback, the window is handed that scrollback: the two hold the same", async () => {
    const { sessions, shells, events } = harness();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    shells[0]!.emit("before");
    vi.advanceTimersByTime(10);
    shells[0]!.end(1);
    await settle();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null, restart: true });
    await settle();
    expect(events.at(-1)).toMatchObject({ type: "opened", fresh: true, replay: "<screen:before>" });
  });

  it("is told when the host closes a terminal, so one whose tab came back can open it anew", async () => {
    const { sessions, events } = harness();
    sessions.retain([ID]);
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    sessions.retain([]);
    vi.advanceTimersByTime(RELEASE_MS);
    expect(events.at(-1)).toEqual({ type: "closed", id: ID });
  });

  it("is told what a program asked to be noticed for while no window had the terminal — and only then", async () => {
    const { sessions, mirrors, sent } = harness();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    mirrors[0]!.notice("Claude is waiting for your input");
    expect(sent("notice")).toEqual([]);
    sessions.handle({ type: "release", id: ID });
    await settle();
    mirrors[0]!.notice("Build finished");
    expect(sent("notice")).toEqual([{ type: "notice", id: ID, text: "Build finished" }]);
  });
});

describe("a program's copy to the clipboard (OSC 52)", () => {
  it("is the Mac's clipboard's, whether a window has the terminal or not (and whether that window has the focus)", async () => {
    const { sessions, mirrors, copies } = harness();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    mirrors[0]!.copy("attached");
    sessions.handle({ type: "release", id: ID });
    await settle();
    mirrors[0]!.copy("detached");
    expect(copies).toEqual(["attached", "detached"]);
  });
});

describe("⌘K in the window", () => {
  it("is put into the output where it stands, for the window and the mirror alike", async () => {
    const { sessions, shells, sent } = harness();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    shells[0]!.emit("queued");
    sessions.handle({ type: "clear", id: ID });
    vi.advanceTimersByTime(10);
    expect(sent("data")).toEqual([{ type: "data", id: ID, data: `queued${TERMINAL_CLEAR}` }]);
  });

  it("clears the host's copy too: a window that opens it again is not shown what was cleared", async () => {
    const { sessions, shells, events } = harness();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    shells[0]!.emit("secret");
    // (Sent and drawn, then cleared.)
    vi.advanceTimersByTime(10);
    sessions.handle({ type: "clear", id: ID });
    shells[0]!.emit("after");
    sessions.detachAll();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    expect(events.at(-1)).toMatchObject({ type: "opened", replay: "<screen:after>" });
  });
});

describe("a mirror slower than its shell", () => {
  it("holds the shell back until it has drawn what it was given, whether a window has the terminal or not", async () => {
    const { sessions, shells, mirrors } = harness();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    sessions.handle({ type: "release", id: ID });
    await settle();
    mirrors[0]!.stalled = true;
    // A program pouring output into a terminal nobody draws: the mirror falls behind, and the shell waits for it.
    for (let index = 0; index < 20; index++) shells[0]!.emit("x".repeat(MIRROR_FLOW.high / 10));
    expect(shells[0]!.paused).toBe(true);
    mirrors[0]!.stalled = false;
    mirrors[0]!.drain();
    expect(shells[0]!.paused).toBe(false);
  });

  it("holds it back while a window has the terminal too — the window's drawing and the mirror's both", async () => {
    const { sessions, shells, mirrors } = harness();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    mirrors[0]!.stalled = true;
    for (let index = 0; index < 20; index++) {
      shells[0]!.emit("y".repeat(MIRROR_FLOW.high / 10));
      vi.advanceTimersByTime(10);
      // (The window keeps up.)
      sessions.handle({ type: "ack", id: ID, chars: MIRROR_FLOW.high / 10 });
    }
    expect(shells[0]!.paused).toBe(true);
    mirrors[0]!.stalled = false;
    mirrors[0]!.drain();
    expect(shells[0]!.paused).toBe(false);
  });
});

describe("a window that lets a terminal go (another Profile in front)", () => {
  it("is owed nothing: the shell is never held back for it, and runs on", async () => {
    const { sessions, shells, sent } = harness();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    shells[0]!.emit("x".repeat(TERMINAL_FLOW.high + 1));
    expect(shells[0]!.paused).toBe(true);

    sessions.handle({ type: "release", id: ID });
    expect(shells[0]!.paused).toBe(false);
    const before = sent("data").length;
    // A build pours out output nobody draws: never paused, nothing sent.
    for (let index = 0; index < 5; index++) shells[0]!.emit("y".repeat(TERMINAL_FLOW.high));
    vi.advanceTimersByTime(10);
    expect(shells[0]!.paused).toBe(false);
    expect(sent("data")).toHaveLength(before);
  });

  it("opened again by a window that loaded while its shell waited to start: that window gets its output", async () => {
    let ready!: () => void;
    const { sessions, shells, sent } = harness({ ready: new Promise<void>((done) => (ready = done)) });
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    // The window loads again (a new port) and opens it anew, before the integration is written.
    sessions.detachAll();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    ready();
    await settle();
    expect(shells).toHaveLength(1);
    shells[0]!.emit("prompt% ");
    vi.advanceTimersByTime(10);
    expect(sent("data")).toEqual([{ type: "data", id: ID, data: "prompt% " }]);
  });

  it("let go while its shell waited to start: it starts with nobody drawing it", async () => {
    let ready!: () => void;
    const { sessions, shells, sent } = harness({ ready: new Promise<void>((done) => (ready = done)) });
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    sessions.handle({ type: "release", id: ID });
    ready();
    await settle();
    shells[0]!.emit("z".repeat(TERMINAL_FLOW.high + 1));
    vi.advanceTimersByTime(10);
    expect(shells[0]!.paused).toBe(false);
    expect(sent("data")).toHaveLength(0);
  });
});

describe("where a terminal was", () => {
  it("is where it started, before its shell says anything — a terminal opened in another's folder reopens there", async () => {
    const { sessions, places } = harness({ folders: ["/Users/ada", "/srv/app"] });
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: "/srv/app" });
    await settle();
    expect(places.get(ID)).toBe("/srv/app");
  });

  it("follows the shell's reports, and opens a fresh shell there", async () => {
    const { sessions, shells, mirrors, places } = harness({ folders: ["/Users/ada", "/tmp"] });
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    mirrors[0]!.onCwd("/tmp");
    expect(places.get(ID)).toBe("/tmp");
    shells[0]!.end(1);
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null, restart: true });
    await settle();
    expect(shells[1]?.cwd).toBe("/tmp");
  });

  it("falls back to home for a folder that is gone", async () => {
    const { sessions, shells, places } = harness();
    places.set(ID, "/gone");
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    expect(shells[0]?.cwd).toBe("/Users/ada");
  });
});

describe("a terminal no tab names", () => {
  it("is closed a moment later, unless a tab names it again meanwhile", async () => {
    const { sessions, shells } = harness();
    sessions.retain([ID]);
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    sessions.retain([]);
    sessions.retain([ID]);
    vi.advanceTimersByTime(RELEASE_MS * 2);
    expect(shells[0]!.signals).toEqual([]);
    sessions.retain([]);
    vi.advanceTimersByTime(RELEASE_MS);
    expect(shells[0]!.signals).toEqual(["SIGHUP"]);
    expect(sessions.running()).toEqual([]);
  });

  it("is not kept by a window opening it again: only a tab naming it keeps it", async () => {
    const { sessions, shells } = harness();
    sessions.retain([ID]);
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    sessions.retain([]);
    sessions.detachAll();
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    vi.advanceTimersByTime(RELEASE_MS);
    expect(shells[0]!.signals).toEqual(["SIGHUP"]);
  });

  it("closed while its shell waited to start: the shell started after is closed too", async () => {
    let ready!: () => void;
    const { sessions, shells } = harness({ ready: new Promise<void>((done) => (ready = done)) });
    sessions.retain([ID]);
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    // Its tab closes before the integration is written.
    sessions.retain([]);
    ready();
    await settle();
    expect(shells).toHaveLength(1);
    vi.advanceTimersByTime(RELEASE_MS);
    expect(shells[0]!.signals).toEqual(["SIGHUP"]);
    expect(sessions.running()).toEqual([]);
  });

  it("opened after main said no tab names it (a window's late open): its shell is closed too", async () => {
    const { sessions, shells } = harness();
    sessions.retain([]);
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    expect(shells).toHaveLength(1);
    vi.advanceTimersByTime(RELEASE_MS);
    expect(shells[0]!.signals).toEqual(["SIGHUP"]);
  });

  it("a shell that shrugs off the hang-up is killed", async () => {
    const { sessions, shells } = harness();
    sessions.retain([ID]);
    sessions.handle({ type: "open", id: ID, cols: 80, rows: 24, cwd: null });
    await settle();
    sessions.retain([]);
    vi.advanceTimersByTime(RELEASE_MS + 3_000);
    expect(shells[0]!.signals).toEqual(["SIGHUP", "SIGKILL"]);
  });
});
