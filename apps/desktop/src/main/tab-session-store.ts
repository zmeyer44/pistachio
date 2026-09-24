/** Atomic, debounced persistence for the recoverable human tab graph. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EMPTY_TAB_SESSION, sanitizeTabSession, type DurableTabSession } from "@pistachio/shell-contracts/tab-session";

const WRITE_DELAY_MS = 120;

export class TabSessionStore {
  readonly #path: string;
  readonly #validSpaceIds: () => ReadonlySet<string>;
  readonly #listeners = new Set<(session: DurableTabSession) => void>();
  #current: DurableTabSession;
  #timer: NodeJS.Timeout | null = null;

  constructor(userDataDir: string, validSpaceIds: () => ReadonlySet<string>) {
    this.#path = join(userDataDir, "tab-session.json");
    this.#validSpaceIds = validSpaceIds;
    this.#current = this.#read();
  }

  get(): DurableTabSession {
    return structuredClone(this.#current);
  }

  /**
   * Hear about every save (the sanitized graph). Workspace sync publishes
   * this device's restore point shortly after each one (§10.2).
   */
  onChange(listener: (session: DurableTabSession) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  save(value: DurableTabSession): void {
    const next = sanitizeTabSession(value, this.#validSpaceIds());
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
        listener(this.get());
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

  /** Flush pending state during a clean quit; the temp+rename also protects crash reads. */
  flush(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#write();
  }

  #read(): DurableTabSession {
    try {
      return sanitizeTabSession(JSON.parse(readFileSync(this.#path, "utf8")), this.#validSpaceIds());
    } catch {
      return structuredClone(EMPTY_TAB_SESSION);
    }
  }

  #write(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#current, null, 2));
      renameSync(tmp, this.#path);
    } catch {
      // The in-memory graph remains authoritative for this process.
    }
  }
}
