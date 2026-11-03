/**
 * The extension data folder's writes (main/extensions/data-files.ts): a chunk goes whole however the handle takes it,
 * and a view's open writes close with it.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Handles whose writes take half of what they are given: what a short write looks like.
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      return new Proxy(handle, {
        get(target, key) {
          if (key === "write") {
            return (buffer: Uint8Array, offset = 0, length = buffer.length - offset) => target.write(buffer, offset, Math.max(1, Math.ceil(length / 2)));
          }
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? (value as (...rest: unknown[]) => unknown).bind(target) : value;
        },
      });
    },
  };
});

import { DataFiles } from "../src/main/extensions/data-files";

const folder = (): string => mkdtempSync(join(tmpdir(), "pistachio-data-files-"));

describe("data files", () => {
  it("writes a chunk whole when the handle takes it in parts", async () => {
    const dir = folder();
    const files = new DataFiles(dir);
    const handle = await files.open("a/log.bin", false, 7);
    await files.write(handle, null, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    await files.close(handle, false);
    expect([...readFileSync(join(dir, "a/log.bin"))]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("holds the limit on open writes against opens made at once, not only ones made in turn", async () => {
    const files = new DataFiles(folder());
    const results = await Promise.allSettled(Array.from({ length: 32 }, (_, i) => files.open(`many/${String(i)}.bin`, false, 1)));
    const opened = results.filter((result) => result.status === "fulfilled");
    expect(opened).toHaveLength(16);
    expect(results.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason)).toEqual(Array.from({ length: 16 }, () => expect.objectContaining({ code: "RATE_LIMITED" })));
    // Closed, the room is back.
    await files.closeOwned(1);
    await expect(files.open("one-more.bin", false, 1)).resolves.toBeTypeOf("number");
    await files.closeAll();
  });

  it("an open under way for a view that goes meanwhile is closed as it completes, and holds no slot after", async () => {
    const dir = folder();
    const files = new DataFiles(dir);
    // 15 opens of the departing view's under way (none awaited yet), one of another's: the limit's 16.
    const opens = Array.from({ length: 15 }, (_, n) => files.open(`pending-${String(n)}.bin`, false, 7));
    const theirs = files.open("theirs.bin", false, 8);
    await files.closeOwned(7);
    // Each of the view's opens ends refused — nobody is left to write — and its handle is closed.
    const settled = await Promise.allSettled(opens);
    expect(settled.map((entry) => (entry.status === "rejected" ? (entry.reason as { code: string }).code : "fulfilled"))).toEqual(Array<string>(15).fill("UNAVAILABLE"));
    // The other view's open stands, and the room is back: another open is not one too many.
    const other = await theirs;
    await files.write(other, null, new Uint8Array([2]));
    const more = await files.open("more.bin", false, 9);
    await files.close(more, false);
    await files.close(other, false);
    expect([...readFileSync(join(dir, "theirs.bin"))]).toEqual([2]);
    // closeAll the same: an open under way completes closed.
    const late = files.open("late.bin", false, 7);
    await files.closeAll();
    await expect(late).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await files.open("after.bin", false, 7)).toBeGreaterThan(0);
    await files.closeAll();
  });

  it("closes a view's open writes with it, and no other's", async () => {
    const dir = folder();
    const files = new DataFiles(dir);
    const mine = await files.open("mine.bin", false, 7);
    const theirs = await files.open("theirs.bin", false, 8);
    await files.closeOwned(7);
    await expect(files.write(mine, null, new Uint8Array([1]))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await files.write(theirs, null, new Uint8Array([2]));
    await files.close(theirs, false);
    expect([...readFileSync(join(dir, "theirs.bin"))]).toEqual([2]);
  });
});
