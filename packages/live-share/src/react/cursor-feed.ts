/**
 * The pointers a layer draws: a `CursorSmoother` plus a wake-up, so the
 * layer's frame loop runs only while a pointer moves or fades and starts
 * again the moment a sample arrives (docs/live-share.md §9).
 */

import { CursorSmoother } from "../cursor.js";
import type { LiveCursor } from "../protocol.js";

export class CursorFeed {
  readonly smoother = new CursorSmoother();
  readonly #wake = new Set<() => void>();
  /** Pointers put away: not drawn, their samples dropped until let go. */
  readonly #held = new Set<string>();

  /** A sample from `identity`, at `at` ms on the layer's clock (`performance.now()`). */
  push(identity: string, cursor: LiveCursor, at: number = performance.now()): void {
    if (this.#held.has(identity)) return;
    this.smoother.push(identity, cursor, at);
    this.#notify();
  }

  /** Forget a pointer at once (its participant left). */
  remove(identity: string): void {
    this.smoother.remove(identity);
    this.#notify();
  }

  /**
   * Put a pointer away at once and keep it away while `held` — the host's,
   * while they are in another space: it belongs to the shared desk, so it
   * goes now rather than fading after 5 s still, and a sample still on its
   * way is not drawn. Let go, it shows again with its next sample.
   */
  hold(identity: string, held: boolean): void {
    if (held === this.#held.has(identity)) return;
    if (!held) {
      this.#held.delete(identity);
      return;
    }
    this.#held.add(identity);
    this.remove(identity);
  }

  onWake(listener: () => void): () => void {
    this.#wake.add(listener);
    return () => this.#wake.delete(listener);
  }

  #notify(): void {
    for (const listener of this.#wake) listener();
  }
}
