/**
 * ⌘Z / ⌘⇧Z: a plain history of project snapshots. A run of edits under one key
 * (a slider being dragged, a segment being moved) within `coalesceMs` is one step.
 */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private lastKey: string | null = null;
  private lastAt = -Infinity;
  private readonly limit: number;
  private readonly coalesceMs: number;

  constructor(limit = 200, coalesceMs = 1000) {
    this.limit = limit;
    this.coalesceMs = coalesceMs;
  }

  /** Before an edit: keep the state it starts from. */
  record(before: T, key: string | null = null, now = Date.now()): void {
    const coalesce = key !== null && key === this.lastKey && now - this.lastAt < this.coalesceMs;
    this.lastKey = key;
    this.lastAt = now;
    if (coalesce) return;
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  /** End a run, so the next edit under the same key is its own step. */
  seal(): void {
    this.lastKey = null;
  }

  undo(current: T): T | null {
    const previous = this.past.pop();
    if (previous === undefined) return null;
    this.future.push(current);
    this.seal();
    return previous;
  }

  redo(current: T): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(current);
    this.seal();
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
