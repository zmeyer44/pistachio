/**
 * The file of spaces that are away (docs/primitives.md §2;
 * @pistachio/shell-contracts/away): each the slice of the session it was.
 * Its own file because an away space is in no session a restart reopens and
 * is nothing the archive may let lapse.
 *
 * Written at once and atomically on every change, never debounced: for as
 * long as a space is away this file is the only copy of its tabs. The order
 * that keeps a crash harmless is the caller's (main/away-spaces.ts): a space
 * is written here BEFORE it leaves the session, and leaves here only AFTER
 * the session holding it again is on disk — so a crash can leave a space in
 * both, never in neither, and launch keeps the one in the session.
 *
 * A space back in a session that could not be written is `kept`: no longer
 * listed — it is back, as far as anyone can tell — and still in the file,
 * through every write of it, until the caller says the session reached the
 * disk (`release`). A restart before then reads it here: away again, and
 * not lost.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AWAY_FILE_VERSION, EMPTY_AWAY_FILE, sanitizeAwayFile, type AwayFile, type AwaySpace } from "@pistachio/shell-contracts/away";

export class AwayStore {
  readonly #path: string;
  #current: AwayFile;
  /** Back in the session, in the file still: written with every write, listed by nothing (`remove` with `keep`). */
  #kept: AwaySpace[] = [];

  constructor(userDataDir: string) {
    this.#path = join(userDataDir, "away-spaces.json");
    this.#current = this.#read();
  }

  /** Every away space, oldest first. */
  all(): AwaySpace[] {
    return this.#current.spaces;
  }

  /** A Profile's (Space's), oldest first. */
  list(spaceId: string): AwaySpace[] {
    return this.#current.spaces.filter((space) => space.spaceId === spaceId);
  }

  get(id: string): AwaySpace | null {
    return this.#current.spaces.find((space) => space.id === id) ?? null;
  }

  /**
   * Keep a space. False — nothing kept — when it could not be written: the
   * caller must then leave the space where it is, since what is not on disk
   * would be lost with the app.
   */
  add(space: AwaySpace): boolean {
    const next: AwayFile = { version: AWAY_FILE_VERSION, spaces: [...this.#current.spaces.filter((other) => other.id !== space.id), space] };
    // (Sent again while its last return was still kept: the file holds it as it is now, once.)
    const kept = this.#kept.filter((other) => other.id !== space.id);
    if (!this.#write(next, kept)) return false;
    this.#current = next;
    this.#kept = kept;
    return true;
  }

  /**
   * Let go of a space: it is back. `keep`: the session holding it again is
   * not on disk yet — it leaves the list and stays in the file, until
   * `release`.
   */
  remove(id: string, options: { keep?: boolean } = {}): AwaySpace | null {
    const space = this.get(id);
    if (space === null) return null;
    const next: AwayFile = { version: AWAY_FILE_VERSION, spaces: this.#current.spaces.filter((other) => other.id !== id) };
    if (options.keep === true) {
      // (Nothing to write: the file has it already, and goes on having it.)
      this.#kept = [...this.#kept.filter((other) => other.id !== id), space];
      this.#current = next;
      return space;
    }
    // (Not written: it stays listed in memory's stead only until the next change or launch, where the session's copy wins.)
    this.#write(next, this.#kept);
    this.#current = next;
    return space;
  }

  /** Whether the file holds a copy for a session not yet on disk. */
  keeping(): boolean {
    return this.#kept.length > 0;
  }

  /**
   * How many spaces of a Profile (Space) the file holds, the copies kept for the session among them: what is read
   * back at a restart is bounded for each Profile (sanitizeAwayFile drops the oldest past the bound), so the file
   * must never be given more. `replacing`: a space about to be added, whose own kept copy the new one takes the place of.
   */
  filed(spaceId: string, replacing?: string): number {
    return this.list(spaceId).length + this.#kept.filter((space) => space.spaceId === spaceId && space.id !== replacing).length;
  }

  /** The session is on disk, with everything that came back in it: the copies kept for it go. */
  release(): void {
    if (this.#kept.length === 0) return;
    this.#kept = [];
    // (Not written: they stay in the file only until the next change or launch, where the session's copy wins.)
    this.#write(this.#current, []);
  }

  #read(): AwayFile {
    try {
      return sanitizeAwayFile(JSON.parse(readFileSync(this.#path, "utf8")));
    } catch {
      return structuredClone(EMPTY_AWAY_FILE);
    }
  }

  /** The file as it will read back: the away spaces, and the copies kept for a session not yet on disk. */
  #write(file: AwayFile, kept: readonly AwaySpace[]): boolean {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      // (Oldest first, as the list is: a kept copy read back at a restart is an away space like the others.)
      const spaces = kept.length === 0 ? file.spaces : [...kept, ...file.spaces].sort((a, b) => a.since - b.since);
      writeFileSync(tmp, JSON.stringify({ ...file, spaces }, null, 2));
      renameSync(tmp, this.#path);
      return true;
    } catch {
      return false;
    }
  }
}
