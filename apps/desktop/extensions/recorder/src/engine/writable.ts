/**
 * Data files as mediabunny's and the events writer's sinks. mediabunny's
 * `StreamTarget` takes a `WritableStream` of `{ type: "write", data, position }`
 * chunks; a fragmented MP4 is written monotonically (mediabunny says so), so
 * each chunk lands at the end of what was written, and the file is a plain
 * append through `files.data.open(path).write(chunk)` — whose answer, once
 * the bytes are on disk, is the backpressure the encoders wait on.
 */
import type { AppendSink } from "./events-writer.js";

/** What `pistachio.files.data.open` answers. */
export interface DataWritableLike {
  write(chunk: ArrayBuffer | Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface PositionedChunk {
  type: "write";
  data: Uint8Array;
  position: number;
}

/** Bytes written through each stream, for the free-space estimate and the probe. */
export interface WriteCounter {
  bytes: number;
  chunks: number;
}

/** A `WritableStream` over a data file, refusing a chunk that is not at the end (a seek the file cannot do). */
export function dataWritableStream(open: () => Promise<DataWritableLike>, counter: WriteCounter = { bytes: 0, chunks: 0 }): WritableStream<PositionedChunk> {
  let file: DataWritableLike | null = null;
  let position = 0;
  return new WritableStream<PositionedChunk>({
    async start() {
      file = await open();
    },
    async write(chunk) {
      if (file === null) throw new Error("the data file is not open");
      if (chunk.position !== position) throw new Error(`a write at byte ${String(chunk.position)} where the file ends at ${String(position)}: only appends are possible`);
      await file.write(chunk.data);
      position += chunk.data.byteLength;
      counter.bytes += chunk.data.byteLength;
      counter.chunks += 1;
    },
    async close() {
      await file?.close();
    },
    async abort() {
      await file?.abort();
    },
  });
}

/** The events writer's sink over an append-mode data file. */
export function appendSink(file: DataWritableLike): AppendSink {
  return {
    write: (chunk) => file.write(chunk),
    close: () => file.close(),
  };
}
