/**
 * The ink a layer draws (docs/live-share.md §4 Ink): an `InkBoard` that says
 * when it changed, so `InkLayer` redraws on a change and not every frame. Its
 * clock is `performance.now()`, the one the layer fades lasers on.
 *
 * The board also changes with time alone — a laser fades out, an open stroke
 * goes idle — so the store keeps one timer for the next such moment and says
 * so then: whoever counts the strokes hears a faded laser go when it goes,
 * not at the next op.
 */

import { InkBoard, type InkSender } from "../ink.js";
import type { LiveInkOp, LiveStroke } from "../protocol.js";

export class InkStore {
  readonly board: InkBoard;
  readonly #listeners = new Set<() => void>();
  readonly #now: () => number;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(board: InkBoard = new InkBoard(), now: () => number = () => performance.now()) {
    this.board = board;
    this.#now = now;
  }

  apply(op: LiveInkOp, from: InkSender, now: number = this.#now()): boolean {
    const changed = this.board.apply(op, from, now);
    if (changed) this.#changed(now);
    return changed;
  }

  /** A sync's board; `since` is when the guest asked for it (see `InkBoard.load`). */
  load(strokes: readonly LiveStroke[], since: number, now: number = this.#now()): void {
    this.board.load(strokes, now, since);
    this.#changed(now);
  }

  /** `identity` left mid-stroke: finish what they were drawing. */
  release(identity: string, now: number = this.#now()): void {
    const before = this.board.version;
    this.board.release(identity, now);
    if (this.board.version !== before) this.#changed(now);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(now: number): void {
    for (const listener of this.#listeners) listener();
    this.#schedule(now);
  }

  /** Wake at the board's next change by time: drop what faded, and tell the listeners. */
  #schedule(now: number): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const next = this.board.nextChange(now);
    if (next === null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const at = Math.max(next, this.#now());
      this.board.expire(at);
      this.#changed(at);
    }, next - now);
  }
}
