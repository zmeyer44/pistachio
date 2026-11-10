/**
 * A recording follows the person (docs/recorder.md §2 "While recording"):
 * whichever page they bring in front is the one recorded from then on, so the
 * clip shows every tab they visited. Pure of the capture itself: the session
 * opens a *feed* (the tab's capture, its input, its hold) through `open`, and
 * this keeps one feed current and switches it as the wanted tab changes —
 * one switch at a time, the new feed opened before the old one is closed (so
 * the picture never goes black and main always sees a recording of ours,
 * which is what lets it capture the tab in front), a few retries when a feed
 * will not open (a capture of the same tab still ending in main, a renderer
 * mid-navigation), and a feed that ends under it (its tab closed, its page
 * woke as another) opened again while that tab is still the wanted one.
 */

export interface FollowTarget {
  id: string;
  title: string;
  url: string;
}

export interface FollowHooks<F> {
  /** Open the tab's feed; resolves once it shows (its first frame came), rejects when it cannot. */
  open(target: FollowTarget): Promise<F>;
  /** A feed let go: its tracks stopped, its input and hold released. Idempotent. */
  close(feed: F): void;
  /** The current feed changed (`previous`, if any, is closed already). */
  switched(feed: F, previous: F | null): void;
  /** A target could not be opened after the retries (it is no longer wanted). */
  failed(target: FollowTarget, error: unknown): void;
  /** The wait between retries (a test's stand-in). */
  sleep?(ms: number): Promise<void>;
}

/** How many times a feed is tried before giving up on that target. */
export const FOLLOW_TRIES = 3;
/** The wait between two tries (main's ending capture of the same tab clears at its next check). */
export const FOLLOW_RETRY_MS = 300;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class Follow<F extends { tab: FollowTarget }> {
  readonly #hooks: FollowHooks<F>;
  #current: F | null = null;
  #wanted: FollowTarget | null = null;
  #running: Promise<void> | null = null;
  #stopped = false;

  constructor(hooks: FollowHooks<F>) {
    this.#hooks = hooks;
  }

  /** The feed in front: the one recorded (its events written, its title in the pill). */
  get current(): F | null {
    return this.#current;
  }

  /** The tab the person is on (as far as this was told), or null for none to follow. */
  get wanted(): FollowTarget | null {
    return this.#wanted;
  }

  /** Whether a switch is under way. */
  get switching(): boolean {
    return this.#running !== null;
  }

  /** The first feed, opened by the session itself: current from here, and the wanted tab until told otherwise. */
  adopt(feed: F): void {
    if (this.#stopped) {
      this.#hooks.close(feed);
      return;
    }
    const previous = this.#current;
    this.#current = feed;
    this.#wanted = feed.tab;
    if (previous !== null && previous !== feed) this.#hooks.close(previous);
  }

  /** The tab in front changed: `null` says no page is (the current feed stays, its picture holds). */
  want(target: FollowTarget | null): void {
    if (this.#stopped) return;
    this.#wanted = target;
    this.#kick();
  }

  /** A feed's capture ended under it. The current one gone is opened again while its tab is still wanted. */
  lost(feed: F): void {
    if (this.#stopped || feed !== this.#current) return;
    this.#current = null;
    this.#hooks.close(feed);
    this.#kick();
  }

  /** Done: the current feed closed, nothing opened again. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#wanted = null;
    const current = this.#current;
    this.#current = null;
    if (current !== null) this.#hooks.close(current);
  }

  #kick(): void {
    if (this.#running !== null) return;
    this.#running = this.#run().finally(() => {
      this.#running = null;
    });
  }

  async #run(): Promise<void> {
    const sleep = this.#hooks.sleep ?? defaultSleep;
    for (;;) {
      const target = this.#wanted;
      if (this.#stopped || target === null || target.id === this.#current?.tab.id) return;
      let feed: F | null = null;
      let error: unknown = null;
      for (let attempt = 0; attempt < FOLLOW_TRIES && feed === null; attempt += 1) {
        if (attempt > 0) await sleep(FOLLOW_RETRY_MS);
        // (Superseded meanwhile — another tab wanted, or none: that one next.)
        if (this.#stopped || this.#wanted?.id !== target.id) break;
        try {
          feed = await this.#hooks.open(target);
        } catch (caught) {
          error = caught;
        }
      }
      if (feed === null) {
        if (!this.#stopped && this.#wanted?.id === target.id) {
          this.#wanted = null;
          this.#hooks.failed(target, error);
        }
        continue;
      }
      if (this.#stopped) {
        this.#hooks.close(feed);
        return;
      }
      const previous = this.#current;
      this.#current = feed;
      if (previous !== null) this.#hooks.close(previous);
      this.#hooks.switched(feed, previous);
    }
  }
}
