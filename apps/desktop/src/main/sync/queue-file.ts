/**
 * Per-Space engine persistence (D16, §3): `<userData>/sync/<spaceId>.queue.json`
 * holds both queue lanes and the HLC clock in the engine's `QueueFile` shape.
 * The file is written whole and atomically (temp + rename), coalesced so a
 * burst of appends lands as one write, and flushed synchronously at quit.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MemoryQueueStorage, parseQueueFile, type QueueFile } from "@pistachio/sync-engine";

export const SYNC_DIR = "sync";
const WRITE_DELAY_MS = 50;

export function syncDir(userDataDir: string): string {
  return join(userDataDir, SYNC_DIR);
}

export function queueFilePath(userDataDir: string, spaceId: string): string {
  return join(syncDir(userDataDir), `${spaceId}.queue.json`);
}

/** Write JSON whole via temp + rename; a torn write can never be read. */
export function atomicWriteJsonSync(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

export function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** A `QueueStorage` over the Space's file, with coalesced atomic writes. */
export class FileQueueStorage extends MemoryQueueStorage {
  readonly #path: string;
  #timer: NodeJS.Timeout | null = null;
  #pending: QueueFile | null = null;
  /** Set by `remove()`: sign-out is final for this file. */
  #removed = false;

  constructor(path: string) {
    // A corrupt or unknown file degrades to an empty queue instead of
    // refusing to start the engine (parseQueueFile answers null).
    super(parseQueueFile(readJsonFile(path)), (snapshot) => this.#schedule(snapshot));
    this.#path = path;
  }

  /** Write what is pending now — the process is about to exit. */
  flush(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#removed) return;
    const pending = this.#pending;
    this.#pending = null;
    if (pending === null) return;
    try {
      atomicWriteJsonSync(this.#path, pending);
    } catch (error) {
      console.error(`[sync] could not write ${this.#path}`, error);
    }
  }

  /** Forget the file: sign-out. */
  remove(): void {
    this.#removed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#pending = null;
    try {
      rmSync(this.#path, { force: true });
      rmSync(`${this.#path}.tmp`, { force: true });
    } catch {
      // Already gone.
    }
  }

  #schedule(snapshot: QueueFile): void {
    // A write that lands after sign-out must not recreate the file: the
    // engine can still be draining when `remove()` runs, and the queue holds
    // the signed-out account's sealed records.
    if (this.#removed) return;
    this.#pending = snapshot;
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, WRITE_DELAY_MS);
    this.#timer.unref();
  }
}
