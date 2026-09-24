import type { CursorPoint } from "@pistachio/shell-contracts/ipc";

/**
 * A watch on the OS pointer for one zone of the shell: an ENTRY test that
 * fires once when the pointer MOVES inside it (never on a pointer that
 * merely rests there — a synthesized enter is exactly the launch nobody can
 * predict), and a HOLD test that fires once when the pointer no longer
 * satisfies it. Each is armed and disarmed independently; the poll runs
 * only while one is armed. Off under Playwright, whose pointer the OS never
 * sees: there the shell's own events are all there is, and the point reader
 * says so by answering null.
 *
 * The pointer is read from the screen (`screen.getCursorScreenPoint()`),
 * which knows nothing about which window is under it. So the ENTRY test
 * runs only while the window is the active one: with another app's window
 * over ours, a pointer moving across it still lands inside our content box,
 * and would otherwise reveal the sidebar or the pane toolbar through that
 * window. The HOLD test keeps running unfocused, so a column that is out
 * still retreats — a leave is always safe to believe.
 *
 * Pure of Electron: the window is the narrow interface below and the point
 * reader is injected, so test/pointer-zone-watch.test.ts drives it with a
 * fake window and fake timers.
 */

export const POINTER_WATCH_MS = 100;
/** The poll while the window is not the active one: nothing can reveal, but an open column can still leave. */
export const POINTER_WATCH_IDLE_MS = 250;

export type PointerTest = (point: CursorPoint) => boolean;

/** What the watch needs of a BrowserWindow. */
export interface PointerWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
  on(event: "blur" | "focus" | "hide" | "minimize" | "show" | "restore", listener: () => void): unknown;
  webContents: { send(channel: string): void };
}

export class PointerZoneWatch {
  readonly #window: PointerWindow;
  readonly #readPoint: () => CursorPoint | null;
  readonly #enteredChannel: string;
  readonly #leftChannel: string;
  readonly #enabled: boolean;
  #entry: PointerTest | null = null;
  #hold: PointerTest | null = null;
  #lastPoint: CursorPoint | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(
    window: PointerWindow,
    channels: { entered: string; left: string },
    /** The pointer in the window's content box, or null when it cannot be read. */
    readPoint: () => CursorPoint | null,
    /** Off (under Playwright): never polls, so the shell's own events are all there is. */
    options: { enabled?: boolean } = {},
  ) {
    this.#window = window;
    this.#readPoint = readPoint;
    this.#enabled = options.enabled ?? true;
    this.#enteredChannel = channels.entered;
    this.#leftChannel = channels.left;
    // The window deactivating is a leave whatever the pointer says: the
    // person went to another app. The poll then slows down, and stops
    // altogether while the window cannot be pointed at.
    window.on("blur", () => {
      this.#leave();
      this.#restartTimer();
    });
    window.on("focus", () => this.#restartTimer());
    window.on("hide", () => this.#restartTimer());
    window.on("minimize", () => this.#restartTimer());
    window.on("show", () => this.#restartTimer());
    window.on("restore", () => this.#restartTimer());
  }

  /** Arm (or, with null, disarm) the entry test. Arming reads the pointer's resting place so only a move counts. */
  setEntry(test: PointerTest | null): void {
    this.#entry = test;
    this.#lastPoint = test === null ? null : this.#readPoint();
    this.#syncTimer();
  }

  /** Arm (or, with null, disarm) the hold test. */
  setHold(test: PointerTest | null): void {
    this.#hold = test;
    this.#syncTimer();
  }

  dispose(): void {
    this.#entry = null;
    this.#hold = null;
    this.#lastPoint = null;
    this.#stop();
  }

  #tick(): void {
    const point = this.#readPoint();
    if (point === null) return;
    const entry = this.#entry;
    if (entry !== null) {
      const previous = this.#lastPoint;
      // Tracked whether or not the window is active, so a move made while
      // another app was in front does not count as one the moment focus
      // returns: only a move made on OUR window reveals.
      this.#lastPoint = point;
      const moved =
        this.#window.isFocused() &&
        previous !== null &&
        (previous.x !== point.x || previous.y !== point.y);
      if (moved && entry(point)) {
        this.#entry = null;
        this.#lastPoint = null;
        this.#syncTimer();
        if (!this.#window.isDestroyed())
          this.#window.webContents.send(this.#enteredChannel);
        return;
      }
    }
    const hold = this.#hold;
    if (hold !== null && !hold(point)) this.#leave();
  }

  #leave(): void {
    if (this.#hold === null) return;
    this.#hold = null;
    this.#syncTimer();
    if (!this.#window.isDestroyed())
      this.#window.webContents.send(this.#leftChannel);
  }

  #syncTimer(): void {
    const window = this.#window;
    const pointable =
      !window.isDestroyed() && window.isVisible() && !window.isMinimized();
    if (!this.#enabled || !pointable || (this.#entry === null && this.#hold === null)) {
      this.#stop();
      return;
    }
    const period = window.isFocused() ? POINTER_WATCH_MS : POINTER_WATCH_IDLE_MS;
    this.#timer ??= setInterval(() => this.#tick(), period);
  }

  /** The window's state changed: pick the cadence (or the stop) that fits it now. */
  #restartTimer(): void {
    this.#stop();
    this.#syncTimer();
  }

  #stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}
