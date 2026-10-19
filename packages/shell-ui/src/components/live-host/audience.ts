/**
 * Who the host's room is for (docs/live-share.md §6.1, §6.3): the guests
 * main says may receive it (`admitted`: in the room, let in as control says,
 * and not removed since) and nobody else. Someone new is in the room before
 * control answers for them, and a removed guest back with a token LiveKit
 * refreshed until main shows them out again; meanwhile they are sent
 * nothing, synced never, and nothing of theirs is drawn.
 *
 * It decides three things, pure of the room and of the clock's source, so
 * test/live-host-audience.test.ts drives it with its own:
 *
 * - whom everything the host sends goes to (`receivers`, in main's order),
 *   which is also the list each of them is told (`lv.guests`): whom a
 *   guest lets see and hear it, and hears;
 * - whom to send the room (`lv.sync`): a guest who said hello — they are
 *   listening then, which a guest who has only just joined is not yet — as
 *   soon as main lets them in, at most once every SYNC_GAP_MS (a guest who
 *   missed the answer says hello again, 2.5 s on); and a guest let in
 *   beside others, once more CATCH_UP_MS after their first: each guest
 *   sends only to the guests the host has listed to it (§4 `lv.guests`),
 *   so what the others said in the hop before the list naming the
 *   newcomer reached them went to the host and not to the newcomer, and
 *   may be missing from a sync taken before it reached the host — a stroke
 *   begun then would be missing from the newcomer's board for good;
 * - whether the shared windows are captured: while anyone is let in, and
 *   for STREAM_GRACE_MS after the last one leaves (main holds the tabs awake
 *   as long), so a guest who reloads finds them streaming.
 */

/** A guest is sent the room at most this often. */
export const SYNC_GAP_MS = 2_000;
/**
 * A guest let in beside others is sent the room again this long after
 * their first sync: past a list's hop to the others, their word's hop back
 * to the host, and main's round trip for chat, on any network worth sharing over.
 */
export const CATCH_UP_MS = 2_000;
/** The windows are captured this long after the last guest left. */
export const STREAM_GRACE_MS = 30_000;

export interface AudienceDeps {
  /** Send this guest the room. */
  sync(identity: string): void;
  /** Whether the windows should be captured changed. */
  streaming(on: boolean): void;
  now(): number;
  /** Run `run` in `ms`; the returned function cancels it. */
  later(run: () => void, ms: number): () => void;
}

export class RoomAudience {
  readonly #deps: AudienceDeps;
  #admitted: readonly string[] = [];
  #let = new Set<string>();
  /** Guests in the room who said hello before main let them in. */
  readonly #waiting = new Set<string>();
  /** When each guest was last sent the room since main let them in. */
  readonly #syncedAt = new Map<string, number>();
  /** Catch-up syncs waiting, by guest (their cancels). */
  readonly #catchUps = new Map<string, () => void>();
  #streaming = false;
  #cancelGrace: (() => void) | null = null;

  /** `admitted`: who main lets in as the app starts (streaming from the first `start` if anyone is). */
  constructor(deps: AudienceDeps, admitted: readonly string[] = []) {
    this.#deps = deps;
    this.#admitted = [...admitted];
    this.#let = new Set(admitted);
    this.#streaming = admitted.length > 0;
  }

  /** Everyone the host's data goes to and who may subscribe to its tracks; empty while nobody is let in. */
  receivers(): readonly string[] {
    return this.#admitted;
  }

  /** Whether this identity is a guest the host lets in (their pointer, ink and marks are drawn). */
  has(identity: string): boolean {
    return this.#let.has(identity);
  }

  /** Whether the shared windows are captured now. */
  streaming(): boolean {
    return this.#streaming;
  }

  /** Main's word on who may receive the room. */
  setAdmitted(identities: readonly string[]): void {
    this.#admitted = [...identities];
    this.#let = new Set(identities);
    // Someone let out and in again is synced afresh.
    for (const identity of [...this.#syncedAt.keys()]) if (!this.#let.has(identity)) this.#syncedAt.delete(identity);
    for (const [identity, cancel] of [...this.#catchUps]) {
      if (this.#let.has(identity)) continue;
      cancel();
      this.#catchUps.delete(identity);
    }
    for (const identity of [...this.#waiting]) {
      if (!this.#let.has(identity)) continue;
      this.#waiting.delete(identity);
      this.#sync(identity);
    }
    this.#follow();
  }

  /** The room's roster: a hello waiting from someone gone is forgotten. */
  setRoom(identities: ReadonlySet<string>): void {
    for (const identity of [...this.#waiting]) if (!identities.has(identity)) this.#waiting.delete(identity);
  }

  /** A guest said hello: sent the room now if let in, else as soon as they are. */
  hello(identity: string): void {
    if (this.#let.has(identity)) this.#sync(identity);
    else this.#waiting.add(identity);
  }

  /** Nothing more is decided (the share is over). */
  dispose(): void {
    this.#cancelGrace?.();
    this.#cancelGrace = null;
    this.#waiting.clear();
    for (const cancel of this.#catchUps.values()) cancel();
    this.#catchUps.clear();
  }

  #sync(identity: string): void {
    const now = this.#deps.now();
    const last = this.#syncedAt.get(identity);
    if (last !== undefined && now - last < SYNC_GAP_MS) return;
    this.#syncedAt.set(identity, now);
    this.#deps.sync(identity);
    if (last === undefined && this.#admitted.some((other) => other !== identity)) this.#catchUp(identity);
  }

  /** The room once more for a newcomer, CATCH_UP_MS on, if they are still let in. */
  #catchUp(identity: string): void {
    if (this.#catchUps.has(identity)) return;
    const cancel = this.#deps.later(() => {
      this.#catchUps.delete(identity);
      if (!this.#let.has(identity)) return;
      this.#syncedAt.set(identity, this.#deps.now());
      this.#deps.sync(identity);
    }, CATCH_UP_MS);
    this.#catchUps.set(identity, cancel);
  }

  /** Capture while anyone is let in; stop a grace period after the last one left. */
  #follow(): void {
    if (this.#admitted.length > 0) {
      this.#cancelGrace?.();
      this.#cancelGrace = null;
      if (!this.#streaming) {
        this.#streaming = true;
        this.#deps.streaming(true);
      }
      return;
    }
    if (!this.#streaming || this.#cancelGrace !== null) return;
    this.#cancelGrace = this.#deps.later(() => {
      this.#cancelGrace = null;
      this.#streaming = false;
      this.#deps.streaming(false);
    }, STREAM_GRACE_MS);
  }
}
