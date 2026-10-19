/**
 * A share that ends while its room stays up (docs/live-share.md §7). A guest
 * learns the share ended from LiveKit, which disconnects everyone as control
 * deletes the room — but a room can outlive its share for a while: LiveKit
 * did not answer control (it closes the room on a later sweep), or the host's
 * app went away without a word (control ends the share once it falls
 * silent). The guests are left in a room with each other and nobody's desk.
 *
 * So a guest whose host has been gone from the room for `HOST_ABSENT_GRACE_MS`
 * asks control where its request stands — the call a reload makes — and
 * again every `HOST_ABSENT_POLL_MS` until the host is back, waiting
 * (`waiting()`) meanwhile. An answer that the share ended, or that this
 * guest was removed or let go, ends the page as LiveKit's own word would. A
 * host gone a moment (their app joining the room again) costs nothing.
 */

import type { LiveRequestStatus } from "./guest-flow.js";

/** How long the host may be gone from the room before control is asked. */
export const HOST_ABSENT_GRACE_MS = 15_000;
/** How often control is asked while the host stays gone. */
export const HOST_ABSENT_POLL_MS = 30_000;

/** What control can answer that ends the page. */
export type HostAbsenceEnd = Extract<LiveRequestStatus, "ended" | "removed" | "left">;

export interface HostAbsenceOptions {
  /** Where this guest's request stands; a rejection is a try that did not get through. */
  check(): Promise<LiveRequestStatus>;
  /** Control says the share is over for this guest. */
  over(reason: HostAbsenceEnd): void;
}

export class HostAbsence {
  readonly #check: HostAbsenceOptions["check"];
  readonly #over: HostAbsenceOptions["over"];
  readonly #listeners = new Set<() => void>();
  /** Each absence, counted: an answer that lands after it ended is let go. */
  #absence = 0;
  #gone = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #waiting = false;

  constructor(options: HostAbsenceOptions) {
    this.#check = options.check;
    this.#over = options.over;
  }

  /** Control is being asked whether the share stands: the host has been gone a while. */
  readonly waiting = (): boolean => this.#waiting;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** The host is gone from the room. */
  start(): void {
    if (this.#gone) return;
    this.#gone = true;
    const absence = (this.#absence += 1);
    this.#timer = setTimeout(() => {
      this.#setWaiting(true);
      void this.#ask(absence);
    }, HOST_ABSENT_GRACE_MS);
  }

  /** The host is back, or the page is done with the room: nothing more is asked. */
  stop(): void {
    if (!this.#gone) return;
    this.#gone = false;
    this.#absence += 1;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#setWaiting(false);
  }

  async #ask(absence: number): Promise<void> {
    this.#timer = null;
    let status: LiveRequestStatus | null = null;
    try {
      status = await this.#check();
    } catch {
      // Not through (offline, control busy): asked again at the next turn.
    }
    if (absence !== this.#absence) return;
    if (status === "ended" || status === "removed" || status === "left") {
      this.stop();
      this.#over(status);
      return;
    }
    this.#timer = setTimeout(() => void this.#ask(absence), HOST_ABSENT_POLL_MS);
  }

  #setWaiting(waiting: boolean): void {
    if (this.#waiting === waiting) return;
    this.#waiting = waiting;
    for (const listener of this.#listeners) listener();
  }
}
