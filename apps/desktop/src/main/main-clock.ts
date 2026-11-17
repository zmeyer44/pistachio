/**
 * Main's one clock (docs/primitives.md §1, rule 4; §5, stage 6). Everything
 * here that must survive a closed lid is **asked, not fired** — reminders,
 * the daily brief, Tidy's sweep, away spaces, extensions' triggers — and
 * each keeps a short timer of its own to its own next instant. What none of
 * those timers can be trusted across is the Mac sleeping, and what none of
 * them can see is the Mac changing: so there is one list of the moments
 * everything is looked at again, and one place the power monitor is wired
 * to it (index.ts), rather than each service wired to the Mac by hand.
 *
 * A service joins with `onLook`, saying which moments it cares for (waking
 * and unlocking, unless it says more); `look` asks each in the order they
 * joined. One that throws, or whose look rejects, is its own trouble: the
 * rest are asked all the same.
 *
 * Here, apart from index.ts, so it can be tested without Electron.
 */

/** A moment the clock is looked at: the Mac woke, its screen was unlocked or locked, its power or its displays changed. */
export type ClockMoment = "wake" | "unlock" | "lock" | "power" | "display";

export const CLOCK_MOMENTS: readonly ClockMoment[] = ["wake", "unlock", "lock", "power", "display"];
/** What everything that keeps time is asked at: a timer set before a sleep is not one to trust after it. */
export const WAKE_MOMENTS: readonly ClockMoment[] = ["wake", "unlock"];

interface Looker {
  name: string;
  moments: ReadonlySet<ClockMoment>;
  look: (moment: ClockMoment) => unknown;
}

export class MainClock {
  readonly #lookers: Looker[] = [];
  readonly #onError: (name: string, error: unknown) => void;

  constructor(options: { onError?: (name: string, error: unknown) => void } = {}) {
    this.#onError = options.onError ?? (() => undefined);
  }

  /** Be asked at `moments` (waking and unlocking, unless said). Answers the way to leave. */
  onLook(name: string, look: (moment: ClockMoment) => unknown, moments: readonly ClockMoment[] = WAKE_MOMENTS): () => void {
    const looker: Looker = { name, moments: new Set(moments), look };
    this.#lookers.push(looker);
    return () => {
      const index = this.#lookers.indexOf(looker);
      if (index >= 0) this.#lookers.splice(index, 1);
    };
  }

  /** Something happened that a timer could not have known: everyone who cares for it looks, in the order they joined. */
  look(moment: ClockMoment): void {
    for (const looker of [...this.#lookers]) {
      if (!looker.moments.has(moment)) continue;
      try {
        const done = looker.look(moment);
        if (done instanceof Promise) done.catch((error: unknown) => this.#onError(looker.name, error));
      } catch (error) {
        this.#onError(looker.name, error);
      }
    }
  }

  /** Who is asked at a moment, by name, in order (for a test, and for whoever wonders why something ran). */
  lookers(moment: ClockMoment): string[] {
    return this.#lookers.filter((looker) => looker.moments.has(moment)).map((looker) => looker.name);
  }
}
