/**
 * Notices kept until somebody is there to read them (docs/primitives.md §2.6,
 * §3.6). What was done with nobody at the Mac — a space an extension sent
 * away from in front of a locked screen, one it closed overnight — is not
 * said into an empty room for the eight seconds a notice stays: it waits
 * until the window is in front **and** a key or the pointer has been touched
 * lately and the screen is not locked.
 *
 * One queue, one look at a time. A notice held under a key replaces the one
 * already held under it (a space sent, returned and sent again is said once);
 * only the newest few are kept (a weekend of an interval's work is not a
 * burst on Monday — the journal has all of it); and each is said only if it
 * is still so when its turn comes.
 *
 * Here, apart from index.ts, so it can be tested without Electron.
 */

export interface HeldNoticesOptions {
  /** Whether the window is in front now. */
  focused(): boolean;
  /** Be told, once, when the window next comes in front. With no window up there is nothing to tell: `windowChanged` is called when one is. */
  onceFocused(listener: () => void): void;
  /** Whether somebody is at the Mac: its screen not locked, a key or the pointer touched lately. */
  someoneThere(): boolean;
  timers?: { setTimeout(callback: () => void, ms: number): unknown };
  /** How long between looks for somebody, once the window is in front. */
  pollMs?: number;
  /** How many are kept: the newest. */
  max?: number;
}

/** How long between looks for somebody at a Mac that sits idle or locked with the window in front. */
export const HELD_POLL_MS = 1_500;
/** How many notices wait at most: the newest. What the rest said is in the journal. */
export const HELD_MAX = 3;

interface Held {
  say: () => void;
  still: () => boolean;
}

export class HeldNotices {
  readonly #options: HeldNoticesOptions;
  readonly #timers: NonNullable<HeldNoticesOptions["timers"]>;
  readonly #pollMs: number;
  readonly #max: number;
  /** By key, oldest first. */
  readonly #held = new Map<string, Held>();
  #waitingForFocus = false;
  /** Which wait for the window is the one in force: a window that closed never says it came in front, and its wait is let go (windowChanged). */
  #wait = 0;
  #polling = false;

  constructor(options: HeldNoticesOptions) {
    this.#options = options;
    this.#timers = options.timers ?? { setTimeout: (callback, ms) => setTimeout(callback, ms).unref() };
    this.#pollMs = options.pollMs ?? HELD_POLL_MS;
    this.#max = options.max ?? HELD_MAX;
  }

  /** How many are waiting (for a test, and for whoever wonders). */
  get size(): number {
    return this.#held.size;
  }

  /**
   * Say `say` once somebody is there — at once, if they are. `key`: what it is about (a space's coming and going, a
   * space closed): a later one under the same key takes its place. `still`: whether it is still so when its turn
   * comes; one that is not is dropped unsaid.
   */
  hold(key: string, say: () => void, still: () => boolean = () => true): void {
    this.#held.delete(key);
    this.#held.set(key, { say, still });
    while (this.#held.size > this.#max) this.#held.delete(this.#held.keys().next().value as string);
    this.#look(false);
  }

  /**
   * The window is another one now — the one waited on closed, a new one is up and its shell can hear. A wait on the
   * old window's coming in front would never end, and would keep every later notice waiting behind it: it is let
   * go, and what is held looks for somebody at the window there is.
   */
  windowChanged(): void {
    this.#wait += 1;
    this.#waitingForFocus = false;
    this.#look(false);
  }

  /**
   * Look for somebody. `byFocus`: the window has just said it came in front — taken at its word, not asked again
   * (a spec on a locked Mac says so in the OS's place). Otherwise the window is asked each time: somebody back at
   * the Mac and gone straight to another app is not somebody looking at this one.
   */
  #look(byFocus: boolean): void {
    if (this.#held.size === 0) return;
    if (!byFocus && !this.#options.focused()) {
      if (this.#waitingForFocus) return;
      this.#waitingForFocus = true;
      const wait = ++this.#wait;
      this.#options.onceFocused(() => {
        // (A window that was replaced since: its word is no longer the one waited for.)
        if (wait !== this.#wait) return;
        this.#waitingForFocus = false;
        this.#look(true);
      });
      return;
    }
    if (!this.#options.someoneThere()) {
      if (this.#polling) return;
      this.#polling = true;
      this.#timers.setTimeout(() => {
        this.#polling = false;
        this.#look(false);
      }, this.#pollMs);
      return;
    }
    const held = [...this.#held.values()];
    this.#held.clear();
    for (const notice of held) {
      try {
        if (notice.still()) notice.say();
      } catch {
        // (One notice's trouble is not the next one's.)
      }
    }
  }
}
