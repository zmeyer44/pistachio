import { afterEach, describe, expect, it, vi } from "vitest";
import { AppendChunker, Cancelled, ChunkWindow, OpfsStage } from "../src/export/writer.js";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function collecting(size = 4): { window: ChunkWindow; posted: { seq: number; bytes: Uint8Array }[] } {
  const posted: { seq: number; bytes: Uint8Array }[] = [];
  const window = new ChunkWindow((seq, bytes) => posted.push({ seq, bytes: new Uint8Array(bytes) }), size);
  return { window, posted };
}

describe("the chunk window", () => {
  it("posts four chunks, then holds the fifth until the page answers one", async () => {
    const { window, posted } = collecting();
    for (let i = 0; i < 4; i++) await window.push(new Uint8Array([i]).buffer);
    expect(posted.map((chunk) => chunk.seq)).toEqual([0, 1, 2, 3]);
    let fifth = false;
    const pending = window.push(new Uint8Array([4]).buffer).then(() => {
      fifth = true;
    });
    await tick();
    expect(fifth).toBe(false);
    expect(window.unanswered).toBe(4);
    window.written(2);
    await pending;
    expect(fifth).toBe(true);
    expect(posted.map((chunk) => chunk.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(window.bytes).toBe(5);
  });

  it("ignores answers it never asked for, and answers twice", async () => {
    const { window } = collecting(1);
    await window.push(new ArrayBuffer(3));
    window.written(7);
    window.written(-1);
    expect(window.unanswered).toBe(1);
    window.written(0);
    window.written(0);
    expect(window.unanswered).toBe(0);
  });

  it("drains only once every chunk was answered", async () => {
    const { window } = collecting();
    await window.push(new ArrayBuffer(1));
    await window.push(new ArrayBuffer(1));
    let drained = false;
    const draining = window.drain().then(() => {
      drained = true;
    });
    window.written(0);
    await tick();
    expect(drained).toBe(false);
    window.written(1);
    await draining;
    expect(drained).toBe(true);
  });

  it("releases a held producer with the cancel, and refuses later pushes", async () => {
    const { window } = collecting(1);
    await window.push(new ArrayBuffer(1));
    const held = window.push(new ArrayBuffer(1));
    const draining = window.drain();
    window.fail(new Cancelled());
    await expect(held).rejects.toBeInstanceOf(Cancelled);
    await expect(draining).rejects.toBeInstanceOf(Cancelled);
    await expect(window.push(new ArrayBuffer(1))).rejects.toBeInstanceOf(Cancelled);
  });
});

describe("the append chunker", () => {
  const answered = (): { window: ChunkWindow; posted: { seq: number; bytes: Uint8Array }[] } => {
    const posted: { seq: number; bytes: Uint8Array }[] = [];
    const window = new ChunkWindow((seq, bytes) => {
      posted.push({ seq, bytes: new Uint8Array(bytes) });
      queueMicrotask(() => window.written(seq));
    });
    return { window, posted };
  };

  it("gathers writes in file order into whole chunks, the rest at the end", async () => {
    const { window, posted } = answered();
    const chunker = new AppendChunker(window, 8);
    const bytes = Array.from({ length: 21 }, (_, i) => i);
    await chunker.write(new Uint8Array(bytes.slice(0, 3)), 0);
    await chunker.write(new Uint8Array(bytes.slice(3, 17)), 3);
    await chunker.write(new Uint8Array(bytes.slice(17)));
    expect(chunker.length).toBe(21);
    await chunker.end();
    await window.drain();
    expect(posted.map((chunk) => chunk.bytes.length)).toEqual([8, 8, 5]);
    expect(posted.flatMap((chunk) => [...chunk.bytes])).toEqual(bytes);
  });

  it("takes a patch inside the chunk not yet sent", async () => {
    const { window, posted } = answered();
    const chunker = new AppendChunker(window, 8);
    await chunker.write(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 0);
    await chunker.write(new Uint8Array([99]), 9);
    await chunker.end();
    expect(posted.flatMap((chunk) => [...chunk.bytes])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 99]);
  });

  it("throws on a write back into bytes already sent (a muxer mode that seeks)", async () => {
    const { window } = answered();
    const chunker = new AppendChunker(window, 8);
    await chunker.write(new Uint8Array(12), 0);
    await expect(chunker.write(new Uint8Array([1]), 4)).rejects.toThrow(/already sent/);
  });
});

describe("the staging file", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("removes what an export that died left behind before it measures the quota, so an orphan never keeps the next export out", async () => {
    const removed: string[] = [];
    const directory = {
      keys: async function* () {
        yield "recorder-export-dead.part";
        yield "unrelated.bin";
      },
      removeEntry: async (name: string) => void removed.push(name),
      getFileHandle: async () => ({ createSyncAccessHandle: async () => ({ write: () => 0, read: () => 0, flush: () => undefined, close: () => undefined }) }),
    };
    const estimate = vi.fn(async () => ({ quota: 100, usage: 90 }));
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => directory, estimate } });
    // The quota, as measured, will not hold it: no stage — but the orphan is gone, and the next try can stage.
    expect(await OpfsStage.open(50)).toBeNull();
    expect(removed).toEqual(["recorder-export-dead.part"]);
    expect(estimate).toHaveBeenCalledTimes(1);
  });
});
