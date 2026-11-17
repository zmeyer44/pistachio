/**
 * Closing a space (docs/primitives.md §2.6; docs/tab-tidy.md §3.5): one verb
 * — the space's tabs closed, the space filed in the archive as one entry
 * under its own id, one Restore away — reached the same way by the space's
 * menu (index.ts, the `close` group command) and by an extension's
 * `pistachio.spaces.close`. Whoever asks, the same archive keeps the space
 * and the same entry brings it back as itself.
 *
 * The person's own press is theirs to make and is refused nothing. Code is
 * refused what sending a space away is: a space shared live, recorded, the
 * agent at work in it, one with more tabs than the archive keeps of a space
 * or a tab it would not keep at all — and, asking with nobody there, the space in front, one that is playing
 * and one whose terminal would end with it.
 *
 * Here, apart from index.ts, so it can be tested without Electron.
 */

import { AWAY_REFUSALS, type AwayHolder, type AwayRefusal } from "@pistachio/shell-contracts/away";
import { restoreArchiveEntry, type ArchiveRestoreHost } from "./archive-restore";
import type { BrowserController } from "./browser-controller";
import type { TabArchiveStore } from "./tab-archive-store";

/** Why code was not let close a space: what `awayBlock` refuses a space that would go away, said for one that would close. */
export const CLOSE_REFUSALS = {
  unknown: AWAY_REFUSALS.unknown,
  notASpace: "Only a space can be closed this way: a Home tab or a favorite's page is not one.",
  live: "This space is being shared live. End the share, then close it.",
  sharing: "A page in this space is sharing the screen. End the share, then close it.",
  recording: "A page in this space is being recorded. Stop the recording, then close it.",
  working: "Pistachio is working in this space. Wait for it to finish, then close it.",
  tooMany: "That space has more tabs than the archive keeps of one space. Close some of them first.",
  unkept: "A page in that space cannot be kept in the archive. Close that tab, then close the space.",
  inFront: "That space is in front. It can be closed once another is.",
  playing: AWAY_REFUSALS.playing,
  terminal: "A terminal is open in that space, and closing the space would end it.",
  failed: "That space could not be closed. It is still here.",
} as const;

export type CloseRefusal = keyof typeof CLOSE_REFUSALS;

/** A space that was closed: what the notice and the journal are made from. */
export interface SpaceClosed {
  groupId: string;
  /** The Profile (code: Space) it was in. */
  profileId: string;
  title: string;
  tabCount: number;
  /** The archive's entry of it; null when there was nothing worth filing (main's own fresh space, closed empty). */
  entryId: string | null;
  by: AwayHolder;
}

export type CloseOutcome = ({ ok: true } & SpaceClosed) | { ok: false; refusal: CloseRefusal; reason: string };

export function closeRefused(refusal: CloseRefusal): { ok: false; refusal: CloseRefusal; reason: string } {
  return { ok: false, refusal, reason: CLOSE_REFUSALS[refusal] };
}

/** A close refused for a tab the archive would not keep (`unkept`), naming the tab when it has a name. */
export function closeUnkeptRefusal(title: string): { ok: false; refusal: CloseRefusal; reason: string } {
  const name = title.trim().slice(0, 80);
  return name === "" ? closeRefused("unkept") : { ok: false, refusal: "unkept", reason: `“${name}” cannot be kept in the archive. Close that tab, then close the space.` };
}

export type CloseHost = Pick<BrowserController, "awayBlock" | "closeUnkept" | "closeTabGroup"> & ArchiveRestoreHost;

export interface SpaceClosingOptions {
  host: CloseHost;
  archive: Pick<TabArchiveStore, "add" | "get" | "remove" | "removeGroupTab">;
  /** A Profile (Space) still exists: an entry of one that is gone is restored in the Profile in front. */
  profileExists: (spaceId: string) => boolean;
}

/** What `awayBlock` can say of a space that is here, as a close's refusal (the rest are the away file's own). */
function refusalOf(block: AwayRefusal): CloseRefusal {
  return block in CLOSE_REFUSALS ? (block as CloseRefusal) : "failed";
}

export class SpaceClosing {
  readonly #options: SpaceClosingOptions;
  readonly #listeners = new Set<(closed: SpaceClosed) => void>();
  #queue: Promise<unknown> = Promise.resolve();
  /** The window has closed (stop), its controller with it: nothing queued is begun. */
  #stopped = false;

  constructor(options: SpaceClosingOptions) {
    this.#options = options;
  }

  /**
   * The window is closing, and this with it (the next window has its own). A close under way finishes — its space is
   * filed; what was queued behind it is not begun: the controller has written its session for the last time, and a
   * space restored into it now would be in no file, its entry spent.
   */
  stop(): void {
    this.#stopped = true;
  }

  /** Hear of every space closed: main's notice for one the person did not close themselves is made from this. */
  onChange(listener: (closed: SpaceClosed) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Close a space into the archive. `by` the person, nothing refuses it. Anyone else is refused a space that is
   * busy; `unattended` (an extension's trigger, nobody there) also the space in front, one playing and one with a
   * terminal — unless `absent`: main can see nobody is at the Mac, and the space in front is in front of no one.
   * `ownTurn`: the agent asking from a turn at work in that very space, whose own hold is not what refuses it.
   */
  close(groupId: string, options: { by: AwayHolder; unattended?: boolean; absent?: boolean; ownTurn?: boolean }): Promise<CloseOutcome> {
    return this.#serial(async () => {
      if (this.#stopped) return closeRefused("failed");
      const { host, archive } = this.#options;
      // What a close nobody pressed is asked — here, before anything moves, and again by the host as it closes
      // (the space in front passes the desk on first, and that takes a moment: closeTabGroup's `guard`).
      const guard =
        options.by.kind === "person"
          ? null
          : {
              ...(options.ownTurn === true ? { ownTurn: true } : {}),
              ...(options.unattended === true ? { unattended: true } : {}),
              ...(options.absent === true ? { absent: true } : {}),
            };
      /** Why it may not be closed now, or null: busy (awayBlock), or a tab of it the archive would not keep. */
      const refusal = (): { ok: false; refusal: CloseRefusal; reason: string } | null => {
        if (guard === null) return null;
        const block = host.awayBlock(groupId, guard);
        if (block !== null) return closeRefused(refusalOf(block));
        // Every tab of it, or the space stays: closed, a tab's page is gone, and Undo could not return what the
        // archive's file does not hold.
        const unkept = host.closeUnkept(groupId);
        return unkept === null ? null : closeUnkeptRefusal(unkept);
      };
      const refused = refusal();
      if (refused !== null) return refused;
      const closed = await (guard === null ? host.closeTabGroup(groupId) : host.closeTabGroup(groupId, guard));
      // (Not closed: gone meanwhile — or refused by the host at the last moment, for what refuses it now.)
      if (closed === null) return refusal() ?? closeRefused("unknown");
      // Nothing to bring back — no page, no Stack, no conversation (main's own fresh space, closed empty): no entry,
      // which would only restore an empty "New space".
      let entryId: string | null = null;
      if (closed.tabs.length > 0 || closed.persons) {
        const { id, title, color, origin, windows } = closed.group;
        // (A space of windows comes back one: docs/space-tabs.md.)
        const group = { title, color, origin, ...(windows === true ? { windows } : {}) };
        const [entry] = archive.add([{ kind: "group", spaceId: closed.spaceId, reason: "closed", runId: null, groupId: id, group, tabs: closed.tabs }]);
        entryId = entry?.id ?? null;
      }
      const done: SpaceClosed = { groupId, profileId: closed.spaceId, title: closed.group.title, tabCount: closed.tabs.length, entryId, by: options.by };
      for (const listener of this.#listeners) {
        try {
          listener(done);
        } catch {
          // (A listener's own trouble is not the close's.)
        }
      }
      return { ok: true, ...done };
    });
  }

  /**
   * Take a close back: the archive's entry restored as the space it was — its id when that is free, so its Stack and
   * conversation come with it — and not brought in front. An entry that is gone (restored already, removed, lapsed)
   * is nothing to undo.
   */
  reopen(entryId: string): Promise<{ ok: boolean; reason?: string }> {
    return this.#serial(async () => {
      if (this.#stopped) return { ok: false, reason: "That could not be restored." };
      const { host, archive, profileExists } = this.#options;
      if (archive.get(entryId) === null) return { ok: true };
      return restoreArchiveEntry(archive, host, { entryId, quiet: true }, profileExists);
    });
  }

  /** Whether the archive still holds an entry a close filed: not restored, removed or lapsed since. */
  filed(entryId: string): boolean {
    return this.#options.archive.get(entryId) !== null;
  }

  /** One at a time: a close and a reopen never interleave across an await. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}
