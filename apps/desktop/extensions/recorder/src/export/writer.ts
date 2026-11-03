/**
 * The export's write side (docs/recorder.md §5; protocol.ts). The Worker can
 * only append: its bytes go to the page as numbered chunks, which the page
 * appends through `files.data.open` — a writer with no seek. So:
 *
 * - `ChunkWindow` posts the chunks, at most four unanswered (the page answers
 *   `written`), and holds the producer back meanwhile.
 * - `AppendChunker` gathers writes that arrive in file order (a fragmented MP4,
 *   an append-only WebM, a GIF) into 4 MiB chunks.
 * - `OpfsStage` takes the writes of a muxer that seeks back (a fast-start MP4
 *   whose moov is written into reserved space at the end, a WebM whose cues,
 *   duration and sizes are filled in last) in a temporary file in the origin's
 *   private file system, and sends the finished file in order afterwards.
 */
import type { StreamTargetChunk } from "mediabunny";

export const CHUNK_BYTES = 4 << 20;
export const CHUNK_WINDOW = 4;

/** Thrown through the pipeline when the page sends `cancel`. */
export class Cancelled extends Error {
  constructor() {
    super("The export was cancelled.");
    this.name = "Cancelled";
  }
}

/** The protocol's write side: numbered chunks posted to the page, at most `size` unanswered. */
export class ChunkWindow {
  #next = 0;
  readonly #pending = new Set<number>();
  #waiters: (() => void)[] = [];
  #failure: Error | null = null;
  /** Bytes posted so far. */
  bytes = 0;
  readonly post: (seq: number, bytes: ArrayBuffer) => void;
  readonly size: number;

  constructor(post: (seq: number, bytes: ArrayBuffer) => void, size = CHUNK_WINDOW) {
    this.post = post;
    this.size = size;
  }

  get unanswered(): number {
    return this.#pending.size;
  }

  get posted(): number {
    return this.#next;
  }

  /** Posts the next chunk (its buffer is transferred), first waiting for room in the window. */
  async push(bytes: ArrayBuffer): Promise<void> {
    while (this.#failure === null && this.#pending.size >= this.size) await this.#wait();
    if (this.#failure !== null) throw this.#failure;
    const seq = this.#next++;
    this.#pending.add(seq);
    this.bytes += bytes.byteLength; // before the post: a transfer detaches the buffer
    this.post(seq, bytes);
  }

  /** The page wrote chunk `seq`. Unknown or repeated answers are ignored. */
  written(seq: number): void {
    if (this.#pending.delete(seq)) this.#wake();
  }

  /** Resolves once every posted chunk was answered. */
  async drain(): Promise<void> {
    while (this.#failure === null && this.#pending.size > 0) await this.#wait();
    if (this.#failure !== null) throw this.#failure;
  }

  /** Releases every waiter with `error` (a cancel); later pushes throw it too. */
  fail(error: Error): void {
    if (this.#failure === null) this.#failure = error;
    this.#wake();
  }

  #wait(): Promise<void> {
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }
}

/**
 * Writes in file order gathered into chunks. A write may also land back
 * inside the chunk not yet sent (a small patch); one before it is a bug in the
 * muxer's mode choice and throws.
 */
export class AppendChunker {
  #buffer: Uint8Array<ArrayBuffer>;
  #fill = 0;
  #sent = 0;
  readonly window: ChunkWindow;
  readonly chunkBytes: number;

  constructor(window: ChunkWindow, chunkBytes = CHUNK_BYTES) {
    this.window = window;
    this.chunkBytes = chunkBytes;
    this.#buffer = new Uint8Array(chunkBytes);
  }

  /** The file's length so far. */
  get length(): number {
    return this.#sent + this.#fill;
  }

  async write(data: Uint8Array, position = this.length): Promise<void> {
    if (position < this.#sent) throw new Error(`The output wrote back to byte ${String(position)}, which was already sent.`);
    let at = position - this.#sent;
    let read = 0;
    while (read < data.length) {
      if (at >= this.chunkBytes) {
        await this.#sendFull();
        at -= this.chunkBytes;
        continue;
      }
      const n = Math.min(data.length - read, this.chunkBytes - at);
      this.#buffer.set(data.subarray(read, read + n), at);
      at += n;
      read += n;
      if (at > this.#fill) this.#fill = at;
    }
  }

  /** Sends what is left. */
  async end(): Promise<void> {
    if (this.#fill === 0) return;
    const rest = this.#buffer.slice(0, this.#fill).buffer;
    this.#sent += this.#fill;
    this.#fill = 0;
    await this.window.push(rest);
  }

  /** A target for mediabunny's `StreamTarget`. */
  writable(): WritableStream<StreamTargetChunk> {
    return new WritableStream<StreamTargetChunk>({ write: (chunk) => this.write(chunk.data, chunk.position) });
  }

  async #sendFull(): Promise<void> {
    // A gap (never expected) is sent as the zeros a fresh buffer holds.
    const full = this.#buffer.buffer;
    this.#buffer = new Uint8Array(this.chunkBytes);
    this.#sent += this.chunkBytes;
    this.#fill = 0;
    await this.window.push(full);
  }
}

const STAGE_PREFIX = "recorder-export-";

interface SyncAccessHandle {
  write(buffer: BufferSource, options?: { at?: number }): number;
  read(buffer: BufferSource, options?: { at?: number }): number;
  flush(): void;
  close(): void;
}

/**
 * A temporary file in the origin private file system that takes positioned
 * writes (a dedicated Worker's synchronous access handle), then sends itself
 * in order. Null where OPFS is missing or its quota would not hold `estimate`
 * bytes: the caller then picks a muxer mode that writes in order.
 */
export class OpfsStage {
  #size = 0;
  #closed = false;
  readonly directory: FileSystemDirectoryHandle;
  readonly name: string;
  readonly handle: SyncAccessHandle;

  private constructor(directory: FileSystemDirectoryHandle, name: string, handle: SyncAccessHandle) {
    this.directory = directory;
    this.name = name;
    this.handle = handle;
  }

  static async open(estimate: number): Promise<OpfsStage | null> {
    try {
      const storage = (globalThis as { navigator?: Navigator }).navigator?.storage;
      if (storage === undefined || typeof storage.getDirectory !== "function") return null;
      // What an export that died left behind goes first: a large one would otherwise fill the quota measured next.
      const directory = await storage.getDirectory();
      await OpfsStage.#sweep(directory);
      const { quota, usage } = await storage.estimate();
      if (quota !== undefined && quota - (usage ?? 0) < estimate) return null;
      const name = `${STAGE_PREFIX}${crypto.randomUUID()}.part`;
      const file = await directory.getFileHandle(name, { create: true });
      const open = (file as unknown as { createSyncAccessHandle?: () => Promise<SyncAccessHandle> }).createSyncAccessHandle;
      if (typeof open !== "function") {
        await directory.removeEntry(name).catch(() => undefined);
        return null;
      }
      return new OpfsStage(directory, name, await open.call(file));
    } catch {
      return null;
    }
  }

  /** Removes what an export that died left behind; a file another export holds open refuses and is kept. */
  static async #sweep(directory: FileSystemDirectoryHandle): Promise<void> {
    const keys = (directory as unknown as { keys(): AsyncIterable<string> }).keys();
    const stale: string[] = [];
    for await (const key of keys) if (key.startsWith(STAGE_PREFIX)) stale.push(key);
    for (const key of stale) await directory.removeEntry(key).catch(() => undefined);
  }

  get size(): number {
    return this.#size;
  }

  writable(): WritableStream<StreamTargetChunk> {
    return new WritableStream<StreamTargetChunk>({
      write: (chunk) => {
        let done = 0;
        while (done < chunk.data.length) done += this.handle.write(chunk.data.subarray(done), { at: chunk.position + done });
        this.#size = Math.max(this.#size, chunk.position + chunk.data.length);
      },
    });
  }

  /** Sends the staged file in order, `onChunk` after each chunk with the bytes sent so far. */
  async send(window: ChunkWindow, onChunk: (sent: number) => void, chunkBytes = CHUNK_BYTES): Promise<void> {
    this.handle.flush();
    for (let at = 0; at < this.#size; at += chunkBytes) {
      const piece = new Uint8Array(Math.min(chunkBytes, this.#size - at));
      let read = 0;
      while (read < piece.length) {
        const n = this.handle.read(piece.subarray(read), { at: at + read });
        if (n <= 0) throw new Error("The staged export ended early.");
        read += n;
      }
      await window.push(piece.buffer);
      onChunk(at + piece.length);
    }
  }

  async dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.handle.close();
    } catch {
      // already closed
    }
    await this.directory.removeEntry(this.name).catch(() => undefined);
  }
}
