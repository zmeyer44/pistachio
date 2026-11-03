/**
 * `pistachio.files.data` (docs/extensions.md §5): the extension's own files
 * under `<userData>/ExtensionData/<id>/data/`. Every path is relative and
 * resolved by spelling and by real path (./paths.ts): `..`, an absolute path,
 * or a symlink out of the folder is INVALID_ARGUMENT. An open write is a
 * handle with a queue: chunks are written in the order they came, one at a
 * time, and the call that sent a chunk resolves once it is on disk — the
 * backpressure the writer in the extension waits on.
 */

import { createReadStream, mkdirSync, readdirSync, statSync, statfsSync } from "node:fs";
import { mkdir, open, readFile, rm, stat, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { ExtError, type ExtDataFile } from "@pistachio/extension-api";
import { writableInside, realInside, resolveInside } from "./paths";

/** At most this many writes open at once per extension. */
export const MAX_OPEN_WRITES = 16;
/** One `files.data.read` answers at most this many bytes (larger reads take ranges). */
export const MAX_READ_BYTES = 64 * 1024 * 1024;

/** A data path is relative: one that starts at a root (`/…`, `C:\…`) is refused, not read as the folder's. */
function relativeOnly(path: string): boolean {
  return !path.startsWith("/") && !path.startsWith("\\") && !isAbsolute(path);
}

interface OpenWrite {
  path: string;
  handle: FileHandle;
  /** The view that opened it (a worker's are closed with it), or null for a whole-file write.*/
  owner: number | null;
  queue: Promise<void>;
  failed: Error | null;
}

/** An open under way: whose it is, and whether that view went meanwhile (its handle then closes as it comes). */
interface PendingOpen {
  owner: number | null;
  gone: boolean;
}

export class DataFiles {
  readonly root: string;
  readonly #writes = new Map<number, OpenWrite>();
  /** Opens under way, counted against the limit with the writes open. */
  readonly #opening = new Set<PendingOpen>();
  #nextHandle = 1;

  constructor(root: string) {
    this.root = root;
  }

  /** The real file `path` names, for reading; INVALID_ARGUMENT or NOT_FOUND otherwise. */
  existing(path: string): string {
    this.#ensureRoot();
    const spelled = relativeOnly(path) ? resolveInside(this.root, path) : null;
    if (spelled === null) throw new ExtError("INVALID_ARGUMENT", `"${path}" is not a path inside the extension's data folder (no "..", nothing absolute)`);
    const real = realInside(this.root, spelled);
    if (real === null) throw new ExtError("NOT_FOUND", `no data file "${path}"`);
    return real;
  }

  /** Where `path` may be written; INVALID_ARGUMENT when it lies outside. */
  writable(path: string): string {
    this.#ensureRoot();
    const target = relativeOnly(path) ? writableInside(this.root, path) : null;
    if (target === null) throw new ExtError("INVALID_ARGUMENT", `"${path}" is not a path inside the extension's data folder (no "..", nothing absolute, no links out)`);
    return target;
  }

  async open(path: string, append: boolean, owner: number | null = null): Promise<number> {
    // (A slot taken before anything is awaited: opens made at once would each see the room the others are taking.)
    if (this.#writes.size + this.#opening.size >= MAX_OPEN_WRITES) throw new ExtError("RATE_LIMITED", `at most ${String(MAX_OPEN_WRITES)} files.data writes may be open at once: close one first`);
    const pending: PendingOpen = { owner, gone: false };
    this.#opening.add(pending);
    try {
      const target = this.writable(path);
      await mkdir(dirname(target), { recursive: true });
      // (Checked again once the folders exist: one of them may be a link made meanwhile.)
      const checked = this.writable(path);
      const handle = await open(checked, append ? "a" : "w");
      if (pending.gone) {
        // (Its view went while the open was under way: nobody is left to write, and an unowned handle would keep a slot.)
        await handle.close().catch(() => undefined);
        throw new ExtError("UNAVAILABLE", "the view that opened the write is gone");
      }
      const id = this.#nextHandle++;
      this.#writes.set(id, { path, handle, queue: Promise.resolve(), failed: null, owner });
      return id;
    } finally {
      this.#opening.delete(pending);
    }
  }

  /** One chunk to an open handle, or a whole file to `path` (handle null). Resolves once written. */
  async write(handle: number | null, path: string | null, chunk: Uint8Array): Promise<void> {
    if (handle === null) {
      if (path === null) throw new ExtError("INVALID_ARGUMENT", "files.data.write needs a handle or a path");
      const id = await this.open(path, false);
      try {
        await this.write(id, null, chunk);
      } finally {
        await this.close(id, false);
      }
      return;
    }
    const write = this.#writes.get(handle);
    if (write === undefined) throw new ExtError("NOT_FOUND", `no open write ${String(handle)}`);
    const step = write.queue.then(async () => {
      if (write.failed !== null) throw write.failed;
      try {
        // (A write may take fewer bytes than given: the rest goes after it; one that takes none is a failure.)
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await write.handle.write(chunk, offset, chunk.length - offset);
          if (bytesWritten <= 0) throw new Error("the write made no progress");
          offset += bytesWritten;
        }
      } catch (error) {
        write.failed = error instanceof Error ? error : new Error(String(error));
        throw write.failed;
      }
    });
    write.queue = step.catch(() => undefined);
    await step;
  }

  /** Every open write of one view's closed, its queue drained first (an open of its under way closes as it comes): a worker's go with it when it stops. */
  async closeOwned(owner: number): Promise<void> {
    for (const pending of this.#opening) if (pending.owner === owner) pending.gone = true;
    await Promise.all([...this.#writes].filter(([, write]) => write.owner === owner).map(([id]) => this.close(id, false)));
  }

  async close(handle: number, abort: boolean): Promise<void> {
    const write = this.#writes.get(handle);
    if (write === undefined) return;
    this.#writes.delete(handle);
    await write.queue;
    await write.handle.close().catch(() => undefined);
    if (abort) await rm(this.writable(write.path), { force: true }).catch(() => undefined);
  }

  async read(path: string, start?: number, end?: number): Promise<Uint8Array> {
    const real = this.existing(path);
    const size = (await stat(real)).size;
    const from = Math.max(0, Math.floor(start ?? 0));
    const to = Math.min(size, end === undefined ? size : Math.max(from, Math.floor(end)));
    if (to - from > MAX_READ_BYTES) throw new ExtError("INVALID_ARGUMENT", `read at most 64 MB at a time: pass a range`);
    if (from === 0 && to === size) return new Uint8Array(await readFile(real));
    const chunks: Buffer[] = [];
    if (to > from) {
      await new Promise<void>((resolve, reject) => {
        createReadStream(real, { start: from, end: to - 1 })
          .on("data", (chunk) => chunks.push(chunk as Buffer))
          .on("end", resolve)
          .on("error", reject);
      });
    }
    return new Uint8Array(Buffer.concat(chunks));
  }

  list(dir: string): ExtDataFile[] {
    this.#ensureRoot();
    const spelled = relativeOnly(dir) ? resolveInside(this.root, dir === "" || dir === "." ? "" : dir) : null;
    if (spelled === null) throw new ExtError("INVALID_ARGUMENT", `"${dir}" is not a folder inside the extension's data folder`);
    const real = realInside(this.root, spelled);
    if (real === null) return [];
    const files: ExtDataFile[] = [];
    for (const entry of readdirSync(real, { withFileTypes: true })) {
      const full = join(real, entry.name);
      // (A link is listed as what it is only when it stays inside.)
      const inside = realInside(this.root, full);
      if (inside === null) continue;
      const info = statSync(inside);
      files.push({
        path: relative(realInside(this.root, this.root) ?? this.root, inside).split("\\").join("/"),
        size: info.isFile() ? info.size : 0,
        modifiedAt: info.mtimeMs,
        kind: info.isDirectory() ? "dir" : "file",
      });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async remove(path: string): Promise<void> {
    const spelled = relativeOnly(path) ? resolveInside(this.root, path) : null;
    if (spelled === null || spelled === this.root) throw new ExtError("INVALID_ARGUMENT", `"${path}" is not a path inside the extension's data folder`);
    const real = realInside(this.root, spelled);
    if (real === null) return;
    await rm(real, { recursive: true, force: true });
  }

  freeSpace(): number {
    this.#ensureRoot();
    const info = statfsSync(this.root);
    return Number(info.bavail) * Number(info.bsize);
  }

  /** Every open write closed, opens under way with them (the worker went, the extension was turned off). */
  async closeAll(): Promise<void> {
    for (const pending of this.#opening) pending.gone = true;
    await Promise.all([...this.#writes.keys()].map((handle) => this.close(handle, false)));
  }

  #ensureRoot(): void {
    mkdirSync(this.root, { recursive: true });
  }
}
