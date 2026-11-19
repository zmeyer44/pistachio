/**
 * Making a space (docs/primitives.md §2.7): one verb — a space of the
 * person's on the rail, named, with a page of the web for each address it is
 * made with — for whoever makes one without the person's own press: an
 * extension's `pistachio.spaces.create`, at a time main's clock keeps.
 * (The person's own *New space* is the shell's `create` group command, which
 * names nothing and opens its name field.)
 *
 * It is made behind what is in front. Nobody is moved by code: only a maker
 * with the person's hand on it (`show`) brings it in front. What it holds is
 * the person's from the first moment — a named space, as theirs as one they
 * made — so Tidy leaves it be, and it outlives its last tab.
 *
 * Here, apart from index.ts, so it can be tested without Electron.
 */

import type { AwayHolder } from "@pistachio/shell-contracts/away";
import { tabGroupTitle } from "@pistachio/shell-contracts/tab-groups";
import { NO_ROOM_FOR_SPACE } from "./archive-restore";
import type { BrowserController } from "./browser-controller";

/** Why a space was not made. */
export const MAKE_REFUSALS = {
  /** The Profile holds as many spaces as it may (MAX_TAB_GROUPS_PER_SPACE). */
  full: NO_ROOM_FOR_SPACE,
  /** No page it was asked for could be opened: an empty space nobody asked for is not left on the rail. */
  noPages: "None of its pages could be opened, so the space was not made.",
  failed: "That space could not be made.",
} as const;

export type MakeRefusal = keyof typeof MAKE_REFUSALS;

/** A space that was made: what the notice and the journal are made from. */
export interface SpaceMade {
  groupId: string;
  /** The Profile (code: Space) it is in. */
  profileId: string;
  title: string;
  tabIds: string[];
  /** Brought in front as it was made (the maker had the person's hand on it). */
  shown: boolean;
  by: AwayHolder;
}

export type MakeOutcome = ({ ok: true } & SpaceMade) | { ok: false; refusal: MakeRefusal; reason: string };

export function makeRefused(refusal: MakeRefusal): { ok: false; refusal: MakeRefusal; reason: string } {
  return { ok: false, refusal, reason: MAKE_REFUSALS[refusal] };
}

export type MakeHost = Pick<BrowserController, "hasRoomForSpace" | "createTabGroup" | "createTab" | "refreshSpaces" | "hasTabGroup" | "selectGroup" | "closeTabGroup">;

export class SpaceMaking {
  readonly #host: MakeHost;
  readonly #listeners = new Set<(made: SpaceMade) => void>();
  #queue: Promise<unknown> = Promise.resolve();
  /** The window has closed (stop), its controller with it: nothing queued is begun. */
  #stopped = false;

  constructor(options: { host: MakeHost }) {
    this.#host = options.host;
  }

  /** The window is closing, and this with it (the next window has its own): what waited its turn is not begun. */
  stop(): void {
    this.#stopped = true;
  }

  /** Hear of every space made: main's notice for one the person did not make themselves is made from this. */
  onChange(listener: (made: SpaceMade) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Make a space in `profileId`: named `title`, a tab for each of `urls` in their order, each opened behind what is
   * in front. `show` brings the space in front once it is made — for a maker the person is behind; left out, nobody
   * is moved. A space asked for with pages of which none could be opened is not left standing empty.
   */
  make(options: { profileId: string; title: string; urls: readonly string[]; by: AwayHolder; show?: boolean }): Promise<MakeOutcome> {
    return this.#serial(async () => {
      if (this.#stopped) return makeRefused("failed");
      const host = this.#host;
      if (!host.hasRoomForSpace(options.profileId)) return makeRefused("full");
      // (The person's from the start — `manual`: a space with a name somebody chose, which outlives its last tab and
      // which Tidy does not file for having stood idle.)
      const group = host.createTabGroup({ title: tabGroupTitle(options.title), tabIds: [], origin: "manual", spaceId: options.profileId });
      if (group === null) return makeRefused("failed");
      const tabIds: string[] = [];
      for (const url of options.urls) {
        try {
          // (Answered as each tab stands in the space, not as its page finishes loading: whoever asked — a trigger's
          // handler, which has ten seconds — must hear the space's id before a slow site would let it. Kept waiting, it
          // is given up on, and the space it made is one nobody holds: made again at the retry.)
          tabIds.push(await host.createTab(url, { spaceId: options.profileId, group: group.id, activate: false, awaitLoad: false }));
        } catch {
          // (A page that could not be opened is left out; the rest of the space is made.)
        }
      }
      if (options.urls.length > 0 && tabIds.length === 0) {
        await host.closeTabGroup(group.id);
        host.refreshSpaces();
        return makeRefused("noPages");
      }
      // (Said to the shell whole: the space and its tabs, in one publish after the last of them.)
      host.refreshSpaces();
      let shown = false;
      if (options.show === true && host.hasTabGroup(group.id)) {
        await host.selectGroup(group.id);
        shown = true;
      }
      const made: SpaceMade = { groupId: group.id, profileId: options.profileId, title: group.title, tabIds, shown, by: options.by };
      for (const listener of this.#listeners) {
        try {
          listener(made);
        } catch {
          // (A listener's own trouble is not the making's.)
        }
      }
      return { ok: true, ...made };
    });
  }

  /** One at a time: two makings never interleave across an await. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}
