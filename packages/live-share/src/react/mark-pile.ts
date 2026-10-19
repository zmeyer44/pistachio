/**
 * The marks a layer has up — pings, reactions — each a node of its own,
 * taken down when its life is over (docs/live-share.md §9). Past `max` at
 * once the oldest is taken down early: however many people send them, and
 * however fast (each sender is metered, `MARK_RATE`, but a room of them is
 * not), a layer holds a bounded number of nodes and timers.
 */

/** Marks one layer has up at once: a room's worth of bursts, well past what anyone reads. */
export const MAX_MARKS_UP = 48;

export class MarkPile<T extends { remove(): void }> {
  readonly #lifeMs: number;
  readonly #max: number;
  /** In the order they went up: the first is the oldest. */
  readonly #up = new Map<T, ReturnType<typeof setTimeout>>();

  constructor(lifeMs: number, max: number = MAX_MARKS_UP) {
    this.#lifeMs = lifeMs;
    this.#max = Math.max(1, max);
  }

  get size(): number {
    return this.#up.size;
  }

  /** `node` is up: taken down after its life, or sooner when the pile is full and it is the oldest. */
  add(node: T): void {
    for (const oldest of this.#up.keys()) {
      if (this.#up.size < this.#max) break;
      this.#takeDown(oldest);
    }
    this.#up.set(node, setTimeout(() => this.#takeDown(node), this.#lifeMs));
  }

  /** Take every mark down (the layer is going). */
  clear(): void {
    for (const node of this.#up.keys()) this.#takeDown(node);
  }

  #takeDown(node: T): void {
    clearTimeout(this.#up.get(node));
    this.#up.delete(node);
    node.remove();
  }
}
