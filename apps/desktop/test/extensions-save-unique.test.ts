/**
 * files.save into a folder (main/extensions/save-unique.ts): the next free name, taken exclusively — two saves of
 * one name at once take two files, and a name taken between a look and a write is never written over.
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyUnique, saveBytesUnique, saveUnique } from "../src/main/extensions/save-unique";

const folder = (): string => mkdtempSync(join(tmpdir(), "pistachio-save-unique-"));

describe("saving under a unique name", () => {
  it("takes the name, then numbers it before the extension, and never writes over a file", async () => {
    const dir = folder();
    writeFileSync(join(dir, "clip.mp4"), "theirs");
    expect(basename(await saveBytesUnique(dir, "clip.mp4", new Uint8Array([1])))).toBe("clip 2.mp4");
    expect(basename(await saveBytesUnique(dir, "clip.mp4", new Uint8Array([2])))).toBe("clip 3.mp4");
    expect(readFileSync(join(dir, "clip.mp4"), "utf8")).toBe("theirs");
    expect([...readFileSync(join(dir, "clip 2.mp4"))]).toEqual([1]);
    expect([...readFileSync(join(dir, "clip 3.mp4"))]).toEqual([2]);
  });

  it("gives two saves of one name made at once two files, each whole", async () => {
    const dir = folder();
    const [a, b, c] = await Promise.all([
      saveBytesUnique(dir, "export.mp4", new Uint8Array([1, 1])),
      saveBytesUnique(dir, "export.mp4", new Uint8Array([2, 2])),
      saveBytesUnique(dir, "export.mp4", new Uint8Array([3, 3])),
    ]);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(readdirSync(dir).sort()).toEqual(["export 2.mp4", "export 3.mp4", "export.mp4"]);
    expect([...readFileSync(a)]).toEqual([1, 1]);
    expect([...readFileSync(b)]).toEqual([2, 2]);
    expect([...readFileSync(c)]).toEqual([3, 3]);
  });

  it("copies a file the same way, and a name taken between the look and the write is skipped, not written over", async () => {
    const dir = folder();
    const source = join(folder(), "recording.mp4");
    writeFileSync(source, "frames");
    expect(basename(await copyUnique(dir, "recording.mp4", source))).toBe("recording.mp4");
    expect(readFileSync(join(dir, "recording.mp4"), "utf8")).toBe("frames");
    // A writer that finds its first name taken under it (EEXIST) moves on; any other failure is the save's.
    let tries = 0;
    const path = await saveUnique(dir, "late.txt", async (target) => {
      tries += 1;
      if (tries === 1) {
        writeFileSync(target, "taken meanwhile");
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      }
      writeFileSync(target, "mine", { flag: "wx" });
    });
    expect(basename(path)).toBe("late 2.txt");
    expect(readFileSync(join(dir, "late.txt"), "utf8")).toBe("taken meanwhile");
    await expect(saveUnique(dir, "bad.txt", async () => Promise.reject(Object.assign(new Error("disk full"), { code: "ENOSPC" })))).rejects.toThrow("disk full");
  });
});
