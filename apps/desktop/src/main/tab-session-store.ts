/** Atomic, debounced persistence for the recoverable human tab graph. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EMPTY_TAB_SESSION, sanitizeTabSession, type DurableTabSession } from "@pistachio/shell-contracts/tab-session";

const WRITE_DELAY_MS = 120;

export class TabSessionStore {
  readonly #path: string;
  readonly #validSpaceIds: () => ReadonlySet<string>;
  readonly #listeners = new Set<() => void>();
  #current: DurableTabSession;
  #timer: NodeJS.Timeout | null = null;
  /** A session file was there to read at launch (existed). */
  #existed = false;

  constructor(userDataDir: string, validSpaceIds: () => ReadonlySet<string>) {
    this.#path = join(userDataDir, "tab-session.json");
    this.#validSpaceIds = validSpaceIds;
    this.#current = this.#read();
  }

  /** This device's session, as it reopens here: its tabs of local files too. */
  get(): DurableTabSession {
    return structuredClone(this.#current);
  }

  /**
   * This device's restore point, as other devices may have it (§10.2): no
   * tab of a local file — its path is this computer's alone, and no other
   * device's session ever opens one here (applyDurableSession reads without).
   */
  restorePoint(): DurableTabSession {
    return sanitizeTabSession(this.#current);
  }

  /**
   * Whether this launch found a session to read — even one with nothing in
   * it. Without one, this is a fresh install, the one launch that opens on
   * a home tab (docs/spaces.md §1, BrowserController.initialize); a file
   * that could not be read counts as none.
   */
  existed(): boolean {
    return this.#existed;
  }

  /**
   * Hear about every save. Workspace sync publishes this device's restore
   * point (restorePoint) shortly after each one (§10.2).
   */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  save(value: DurableTabSession): void {
    const next = sanitizeTabSession(value, this.#validSpaceIds(), { files: true });
    for (const [spaceId, space] of Object.entries(next.spaces)) {
      const previous = this.#current.spaces[spaceId];
      const { updatedAt: _currentTime, ...content } = space;
      const { updatedAt: previousTime, ...previousContent } = previous ?? {};
      space.updatedAt = JSON.stringify(content) === JSON.stringify(previousContent)
        ? (previousTime ?? Date.now()) : Math.max(Date.now(), (previousTime ?? 0) + 1);
    }
    this.#current = next;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        console.error("[tab-session] change listener failed", error);
      }
    }
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#write();
    }, WRITE_DELAY_MS);
    this.#timer.unref();
  }

  /**
   * Write what is held now — a clean quit's last save; the temp+rename also
   * protects crash reads. False when it could not be written (a full disk):
   * the session is then in memory alone, and whoever holds another copy of
   * something in it must keep that copy (main/away-spaces.ts).
   */
  flush(): boolean {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    return this.#write();
  }

  #read(): DurableTabSession {
    try {
      const session = sanitizeTabSession(JSON.parse(readFileSync(this.#path, "utf8")), this.#validSpaceIds(), { files: true });
      this.#existed = true;
      return session;
    } catch {
      return structuredClone(EMPTY_TAB_SESSION);
    }
  }

  #write(): boolean {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#current, null, 2));
      renameSync(tmp, this.#path);
      return true;
    } catch {
      // The in-memory graph remains authoritative for this process.
      return false;
    }
  }
}
