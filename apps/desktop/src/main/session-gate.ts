/**
 * The hydration gate (docs/cloud-sync-design.md §10.2): while a Space's
 * cookie session is being hydrated from the hub, page loads in that Space
 * wait so a page never starts against a jar that is about to change under
 * it. The window itself never waits — views are created and laid out at
 * once; only the navigation is held — and every held action replays in
 * order the moment the Space is ready.
 *
 * Nothing waits forever: a hydration that has not finished within
 * `maxWaitMs` is released with a warning, so a hub that never answers can
 * never strand a tab. Pure, so the tests cover the rules directly.
 */

export const SESSION_GATE_MAX_WAIT_MS = 15_000;

export class SessionGate {
  readonly #maxWaitMs: number;
  readonly #hydrating = new Set<string>();
  readonly #ready = new Set<string>();
  readonly #pending = new Map<string, Array<() => void>>();
  readonly #timers = new Map<string, NodeJS.Timeout>();

  constructor(maxWaitMs = SESSION_GATE_MAX_WAIT_MS) {
    this.#maxWaitMs = maxWaitMs;
  }

  /** Spaces whose hydration has completed at least once. */
  get readySpaces(): ReadonlySet<string> {
    return this.#ready;
  }

  isHydrating(spaceId: string): boolean {
    return this.#hydrating.has(spaceId);
  }

  pendingCount(spaceId: string): number {
    return this.#pending.get(spaceId)?.length ?? 0;
  }

  /** Hold loads in the Space until `markReady`, or until the safety timeout. */
  markHydrating(spaceId: string): void {
    if (this.#hydrating.has(spaceId)) return;
    this.#hydrating.add(spaceId);
    this.#ready.delete(spaceId);
    if (this.#maxWaitMs > 0) {
      const timer = setTimeout(() => {
        this.#timers.delete(spaceId);
        if (!this.#hydrating.has(spaceId)) return;
        console.warn(`[sync] hydration of Space ${spaceId} did not finish in time; releasing its pages`);
        this.markReady(spaceId);
      }, this.#maxWaitMs);
      timer.unref?.();
      this.#timers.set(spaceId, timer);
    }
  }

  /** The Space's jar is settled: replay every held action, in order. */
  markReady(spaceId: string): void {
    const timer = this.#timers.get(spaceId);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(spaceId);
    this.#hydrating.delete(spaceId);
    this.#ready.add(spaceId);
    const pending = this.#pending.get(spaceId) ?? [];
    this.#pending.delete(spaceId);
    for (const action of pending) {
      try {
        action();
      } catch (error) {
        console.error(`[sync] replayed load failed in Space ${spaceId}`, error);
      }
    }
  }

  /** Run now, or once the Space is ready. */
  run(spaceId: string, action: () => void): void {
    if (!this.#hydrating.has(spaceId)) {
      action();
      return;
    }
    const queue = this.#pending.get(spaceId);
    if (queue === undefined) this.#pending.set(spaceId, [action]);
    else queue.push(action);
  }

  dispose(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#hydrating.clear();
    this.#pending.clear();
  }
}
