import type { CursorPoint } from "@pistachio/shell-contracts/ipc";
import type { LiveRect } from "@pistachio/shell-contracts/live-share";

/**
 * The host's pointer for the room (docs/live-share.md §6.1): the OS pointer
 * read at 60 Hz — only while a guest is there to see it and the host is on
 * the shared space — mapped from the window's content box onto the stage,
 * 0..1 of its width and height, or null off the stage. A page's native view
 * hides the pointer from the shell, so main is the one place that knows it.
 */

export const LIVE_POINTER_MS = 16;

export type StagePoint = { x: number; y: number };

/** A point in the window's content box (DIP) as stage-normalized, or null when it is off the stage. */
export function stagePoint(point: CursorPoint, stage: LiveRect): StagePoint | null {
  if (stage.w <= 0 || stage.h <= 0) return null;
  const x = (point.x - stage.x) / stage.w;
  const y = (point.y - stage.y) / stage.h;
  return x < 0 || y < 0 || x > 1 || y > 1 ? null : { x, y };
}

export class LiveCursorPoll {
  /** The pointer in the window's content box, or null when it cannot be read (under Playwright, a hidden window). */
  readonly #read: () => CursorPoint | null;
  readonly #emit: (at: StagePoint | null) => void;
  #stage: LiveRect | null = null;
  #active = false;
  #last: StagePoint | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(read: () => CursorPoint | null, emit: (at: StagePoint | null) => void) {
    this.#read = read;
    this.#emit = emit;
  }

  /** Where the shared stage lies in the window, or null while the host is away from it. */
  setStage(stage: LiveRect | null): void {
    this.#stage = stage;
    this.#sync();
  }

  /** Someone is there to see the pointer (a guest in the room, the host on the space). */
  setActive(active: boolean): void {
    this.#active = active;
    this.#sync();
  }

  dispose(): void {
    this.#active = false;
    this.#sync();
  }

  #sync(): void {
    const polling = this.#active && this.#stage !== null;
    if (polling && this.#timer === null) {
      this.#timer = setInterval(() => this.#tick(), LIVE_POINTER_MS);
      this.#tick();
    } else if (!polling && this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
      this.#put(null);
    }
  }

  #tick(): void {
    const stage = this.#stage;
    const point = this.#read();
    this.#put(stage === null || point === null ? null : stagePoint(point, stage));
  }

  #put(at: StagePoint | null): void {
    const last = this.#last;
    if (at === last || (at !== null && last !== null && at.x === last.x && at.y === last.y)) return;
    this.#last = at;
    this.#emit(at);
  }
}
