/**
 * Spaces that are away (docs/primitives.md §2): the two verbs — send a space
 * away, bring one back — and the clock that brings a space back when it is
 * due. One table, reached the same way by the space's menu (index.ts, the
 * `sendAway` and `bringBack` group commands), by the agent's tools and by an
 * extension's `pistachio.spaces.*`: whoever asks, the same rules refuse, the
 * same file keeps the space, the same notice says where it went.
 *
 * Away is main's state, not the sender's: an extension that crashes, is
 * turned off or is removed strands nothing — the space is here, listed, due
 * back when it said, and one press brings it back.
 *
 * The clock is level-triggered, as everything that must survive a closed lid
 * is: nothing fires AT `until`; every tick asks which spaces are due — at
 * launch, on wake, on unlock, and at most thirty seconds apart — so a Mac
 * asleep across the instant shows the space the moment it is opened.
 *
 * Here, apart from index.ts, so it can be tested without Electron.
 */

import {
  MAX_AWAY_SPACES_PER_PROFILE,
  MAX_TABS_KEPT_OF_A_SPACE,
  awayRefused,
  awaySpaceInfo,
  awayUnkeptRefusal,
  firstUnkept,
  heldSpace,
  isAwayInstant,
  type AwayHolder,
  type AwayOutcome,
  type AwaySpace,
  type AwaySpaceInfo,
} from "@pistachio/shell-contracts/away";
import type { AwayStore } from "./away-store";
import type { BrowserController } from "./browser-controller";

export type AwayHost = Pick<
  BrowserController,
  "activeSpaceId" | "hasTabGroup" | "profileOfTabGroup" | "awayBlock" | "awayUnkept" | "takeGroupAway" | "putGroupBack" | "sessionWritten" | "hasRoomForSpace" | "hasRoomForTabs" | "selectGroup" | "refreshSpaces"
>;

/** A space went, or came back: what the shell's notice and an extension's event are made from. */
export interface AwayChange {
  event: "sent" | "returned";
  space: AwaySpaceInfo;
  /** For a return: what brought it back — the clock (`until` came), or someone asking. */
  cause?: "clock" | "asked";
  /** For a return someone asked for: who, when it was not the person at their own press. */
  by?: AwayHolder;
}

export interface AwayTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AwaySpacesOptions {
  store: Pick<AwayStore, "all" | "list" | "get" | "add" | "remove" | "keeping" | "filed" | "release">;
  host: AwayHost;
  /** A Profile (Space) still exists: an away space of one that is gone comes back in the Profile in front. */
  profileExists: (spaceId: string) => boolean;
  now?: () => number;
  timers?: AwayTimers;
}

/** The longest the clock sleeps between looks: a timer set across a night's sleep is not one to trust. */
export const AWAY_TICK_MS = 30_000;

export class AwaySpaces {
  readonly #store: AwaySpacesOptions["store"];
  readonly #host: AwayHost;
  readonly #profileExists: (spaceId: string) => boolean;
  readonly #now: () => number;
  readonly #timers: AwayTimers;
  readonly #listeners = new Set<(change: AwayChange) => void>();
  /** Due back and refused for want of room: tried again on every tick, said so on its row. */
  readonly #waiting = new Set<string>();
  /** On its way out or back this moment: its tabs leave the session before the file has it, and return before the file lets go (`moving`). */
  readonly #moving = new Set<string>();
  /** How many times a space has gone or come back, and the count at which each last did (`movedSince`). */
  #moves = 0;
  readonly #movedAt = new Map<string, number>();
  #queue: Promise<unknown> = Promise.resolve();
  #timer: unknown = null;
  #started = false;
  /** The window has closed (stop), its controller with it: nothing queued is begun, and nothing more is asked of it. */
  #stopped = false;

  constructor(options: AwaySpacesOptions) {
    this.#store = options.store;
    this.#host = options.host;
    this.#profileExists = options.profileExists;
    this.#now = options.now ?? Date.now;
    this.#timers = options.timers ?? { setTimeout: (callback, ms) => setTimeout(callback, ms).unref(), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) };
  }

  /**
   * Once the session is restored: a space in the file that is ALSO in the
   * session — a crash between the two writes — is the session's (the file's
   * copy goes: AwayStore), and whatever came due while the app was closed
   * comes back.
   */
  start(): Promise<void> {
    this.#started = true;
    for (const space of [...this.#store.all()]) if (this.#host.hasTabGroup(space.id)) this.#store.remove(space.id);
    return this.tick();
  }

  /**
   * The window is closing, and this with it (the next window has its own). What is under way finishes — a space is
   * never left between the session and the file — and what was queued behind it is not begun: the controller it
   * would put a space into has written its session for the last time.
   */
  stop(): void {
    this.#started = false;
    this.#stopped = true;
    // (The window's last save reached the disk: a copy the file kept for it has nothing left to stand in for.)
    if (this.#store.keeping() && this.#host.sessionWritten()) this.#store.release();
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Hear of every space sent and every space back. */
  onChange(listener: (change: AwayChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * A Profile's (Space's) away spaces as the snapshot lists them, oldest first. One whose Profile is gone — removed
   * here, or on another device — is the Profile in front's, wherever the person is: it is listed there, timed or
   * not, and comes back there (#homeOf). Nothing of the person's is left where nothing lists it.
   */
  list(spaceId: string): AwaySpaceInfo[] {
    return this.#store.all().flatMap((space) => (this.#homeOf(space) === spaceId ? [this.#info(space)] : []));
  }

  /** Every Profile's. */
  all(): AwaySpaceInfo[] {
    return this.#store.all().map((space) => this.#info(space));
  }

  get(id: string): AwaySpaceInfo | null {
    const space = this.#store.get(id);
    return space === null ? null : this.#info(space);
  }

  /** Whether a tab is away now: held in the file with a space — the one it was in when that space went, wherever it was opened. */
  holdsTab(tabId: string): boolean {
    return this.#store.all().some((space) => space.held.tabs.some((tab) => tab.id === tabId));
  }

  /**
   * Whether a space is on its way out or back right now. Its tabs are gone from the session a moment before the file
   * holds it, and are in the session again a moment before the file lets go: whoever watches the tabs meanwhile (an
   * extension's "a tab closed") asks this, so a space that moved is not taken for tabs closed or opened.
   */
  moving(id: string): boolean {
    return this.#moving.has(id);
  }

  /** How many times a space has gone or come back so far: read it, and ask `movedSince` later. */
  moves(): number {
    return this.#moves;
  }

  /**
   * Whether a space went or came back after `moves` was read. Whoever watches the tabs reads the count at each look:
   * a space that moved between two looks took its tabs with it, whichever side of the file's own writing either
   * look fell on — and at a launch, where a space due back returns before anything has seen it away.
   */
  movedSince(id: string, moves: number): boolean {
    return (this.#movedAt.get(id) ?? 0) > moves;
  }

  /** A space has just gone, come back, or been put straight back: counted, once it is where it will stay. */
  #moved(id: string): void {
    this.#moves += 1;
    this.#movedAt.set(id, this.#moves);
  }

  /**
   * Send a space away, to come back at `until` or when asked. `ownTurn`: the
   * agent asking from a turn at work in that very space. The file is written
   * before the session forgets the space (takeGroupAway only schedules the
   * session's save), and a space that could not be written is put straight
   * back: it is never in neither. `unattended`: code asking with nobody there (an extension's trigger): the space
   * in front, one playing something and one holding a terminal are not taken from under the person. `absent`: main
   * can see that nobody is at the Mac (its screen locked, or idle as the trigger in hand says): the space in front
   * is in front of no one, and may go.
   */
  send(groupId: string, options: { by: AwayHolder; until?: number; ownTurn?: boolean; unattended?: boolean; absent?: boolean }): Promise<AwayOutcome> {
    return this.#serial(async () => {
      if (this.#stopped) return awayRefused("failed");
      const now = this.#now();
      if (options.until !== undefined && (!isAwayInstant(options.until) || options.until <= now)) return awayRefused("past");
      const turn = { ...(options.ownTurn === true ? { ownTurn: true } : {}), ...(options.unattended === true ? { unattended: true } : {}), ...(options.absent === true ? { absent: true } : {}) };
      const block = this.#host.awayBlock(groupId, turn);
      if (block !== null) return awayRefused(block);
      // Every tab of it, or the space stays: a page the file would not read back is said, before anything moves.
      const unkept = this.#host.awayUnkept(groupId);
      if (unkept !== null) return awayUnkeptRefusal(unkept);
      const profile = this.#host.profileOfTabGroup(groupId);
      // (Counted as the file holds them — a copy kept for a session not yet on disk too, but for this very space's, which
      // the new one replaces: a file read back at a restart keeps no more than the bound for a Profile.)
      if (profile !== null && this.#store.filed(profile, groupId) >= MAX_AWAY_SPACES_PER_PROFILE) return awayRefused("full");
      this.#moving.add(groupId);
      try {
        return await this.#take(groupId, options, turn, now);
      } finally {
        // (Counted whatever came of it: taken and filed, or taken and put straight back, its tabs left the session.)
        this.#moved(groupId);
        this.#moving.delete(groupId);
      }
    });
  }

  /** The going itself, while the space is `moving`: out of the session, into the file — or straight back. */
  async #take(groupId: string, options: { by: AwayHolder; until?: number }, turn: { ownTurn?: boolean; unattended?: boolean; absent?: boolean }, now: number): Promise<AwayOutcome> {
    const taken = await this.#host.takeGroupAway(groupId, turn);
    if (taken === null) {
      // (Not taken: for what refuses it now — or for a page that, since it was asked, became one that is not kept.)
      const block = this.#host.awayBlock(groupId, turn);
      const unkept = block === null ? this.#host.awayUnkept(groupId) : null;
      return unkept !== null ? awayUnkeptRefusal(unkept) : awayRefused(block ?? "unknown");
    }
    // More tabs than are read back of one space (the host refuses it before anything moves — awayBlock; this is for
    // one that grew on its way out): what the file would drop is put straight back with the rest.
    if (taken.held.tabs.length > MAX_TABS_KEPT_OF_A_SPACE) {
      this.#host.putGroupBack(taken.spaceId, taken.held);
      this.#host.sessionWritten();
      return awayRefused("tooMany");
    }
    // Kept as the file will read it back (./away heldSpace) — and that must be all of it: a tab the reading drops
    // (the host asks before it takes; this is for whatever it did not see) puts the whole space straight back.
    const held = heldSpace(taken.held, taken.spaceId, groupId);
    const lost = firstUnkept(taken.held, held);
    if (held !== null && lost !== null) {
      this.#host.putGroupBack(taken.spaceId, taken.held);
      this.#host.sessionWritten();
      return awayUnkeptRefusal(lost.title);
    }
    const space: AwaySpace | null =
      held === null ? null : { id: groupId, spaceId: taken.spaceId, by: options.by, since: now, ...(options.until === undefined ? {} : { until: options.until }), held };
    if (space === null || !this.#store.add(space)) {
      this.#host.putGroupBack(taken.spaceId, taken.held);
      // (Written at once if it can be: the session is the only copy again.)
      this.#host.sessionWritten();
      return awayRefused("failed");
    }
    this.#waiting.delete(groupId);
    this.#host.refreshSpaces();
    this.#arm();
    const info = this.#info(space);
    this.#tell({ event: "sent", space: info });
    return { ok: true, space: info };
  }

  /** Bring an away space back. `select`: in front too — the person asked for it by name; nobody else moves them. `by`: who asked, when not the person. */
  bringBack(id: string, options: { select?: boolean; by?: AwayHolder } = {}): Promise<AwayOutcome> {
    return this.#serial(async () =>
      this.#stopped ? awayRefused("failed") : this.#back(id, { select: options.select === true, cause: "asked", ...(options.by === undefined ? {} : { by: options.by }) }),
    );
  }

  /** Look at the clock: every space due is brought back, in the order they were sent. Launch, wake, unlock and the timer call it. */
  tick(): Promise<void> {
    return this.#serial(async () => {
      if (this.#stopped) return;
      const now = this.#now();
      const before = this.#waiting.size;
      // A space back in a session that could not be written then (#back): the file lets go once the session is on disk.
      if (this.#store.keeping() && this.#host.sessionWritten()) this.#store.release();
      for (const space of [...this.#store.all()]) {
        if (space.until === undefined || space.until > now) continue;
        // (The window closed while an earlier one came back: the rest are the next window's clock's.)
        if (this.#stopped) break;
        const outcome = await this.#back(space.id, { select: false, cause: "clock" });
        if (!outcome.ok && (outcome.refusal === "room" || outcome.refusal === "tabsFull")) this.#waiting.add(space.id);
      }
      // (A row that now says it waits for room is news to the shell.)
      if (this.#waiting.size !== before) this.#host.refreshSpaces();
      this.#arm();
    });
  }

  async #back(id: string, options: { select: boolean; cause: "clock" | "asked"; by?: AwayHolder }): Promise<AwayOutcome> {
    const space = this.#store.get(id);
    if (space === null) return awayRefused("notAway");
    const info = this.#info(space);
    // (Here already, under its id — the session's copy, which wins: the file's goes, and the space is back as far as anyone can tell.)
    if (!this.#host.hasTabGroup(id)) {
      const spaceId = this.#homeOf(space);
      if (!this.#host.hasRoomForSpace(spaceId)) return awayRefused("room");
      // The session keeps so many of a Profile's tabs and no more: a space whose tabs it would not all keep stays
      // in the file, where they are, until there is room (said on its row as any room is).
      if (!this.#host.hasRoomForTabs(spaceId, space.held.tabs.length)) return awayRefused("tabsFull");
      // (`moving` meanwhile: its tabs are in the session again before the file has let go of it.)
      this.#moving.add(id);
      try {
        if (this.#host.putGroupBack(spaceId, space.held) === null) return awayRefused("room");
      } finally {
        this.#moved(id);
        this.#moving.delete(id);
      }
    }
    // The file lets go only once the session holding the space again is on disk. One that could not be written (a
    // full disk) is in memory alone, and a restart would read the session without the space: the file keeps its copy,
    // unlisted — the space is back, as far as anyone can tell — until a later look finds the session written (tick).
    this.#store.remove(id, { keep: !this.#host.sessionWritten() });
    this.#waiting.delete(id);
    if (options.select) await this.#host.selectGroup(id);
    this.#host.refreshSpaces();
    this.#arm();
    const { waiting: _waiting, ...back } = info;
    this.#tell({ event: "returned", space: back, cause: options.cause, ...(options.by === undefined ? {} : { by: options.by }) });
    return { ok: true, space: back };
  }

  /** The Profile (Space) an away space is listed in and comes back to: its own, or — that one gone — the one in front. */
  #homeOf(space: AwaySpace): string {
    return this.#profileExists(space.spaceId) ? space.spaceId : this.#host.activeSpaceId();
  }

  #info(space: AwaySpace): AwaySpaceInfo {
    const home = this.#homeOf(space);
    return awaySpaceInfo(home === space.spaceId ? space : { ...space, spaceId: home }, this.#waiting.has(space.id) ? "room" : undefined);
  }

  #tell(change: AwayChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch (error) {
        console.error("[away] a listener failed", error);
      }
    }
  }

  /** One thing at a time: a send, a return and a tick never interleave across their awaits. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Sleep until the next space is due, never longer than AWAY_TICK_MS; not at all while none has a time. */
  #arm(): void {
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#started) return;
    // (One waiting for room is looked at again a whole tick on, not at once: nothing has changed for it yet.)
    const now = this.#now();
    const due = this.#store.all().flatMap((space) => (space.until === undefined ? [] : [this.#waiting.has(space.id) ? now + AWAY_TICK_MS : space.until]));
    // (A copy kept for a session not yet on disk is looked at again a tick on, as one waiting for room is.)
    if (this.#store.keeping()) due.push(now + AWAY_TICK_MS);
    if (due.length === 0) return;
    const delay = Math.min(AWAY_TICK_MS, Math.max(250, Math.min(...due) - now));
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = null;
      void this.tick();
    }, delay);
  }
}
