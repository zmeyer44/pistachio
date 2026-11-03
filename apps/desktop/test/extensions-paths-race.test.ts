/**
 * writableInside (main/extensions/paths.ts) when a folder appears between its two looks — another open's mkdir
 * finishing meanwhile: the path is checked for where it really lies, not refused for having appeared.
 */
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({ failOnce: new Set<string>() }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const realpathSync = ((path: Parameters<typeof real.realpathSync>[0], ...rest: unknown[]) => {
    const key = String(path);
    if (race.failOnce.has(key)) {
      race.failOnce.delete(key);
      throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
    }
    return (real.realpathSync as (...args: unknown[]) => string)(path, ...rest);
  }) as typeof real.realpathSync;
  Object.assign(realpathSync, { native: real.realpathSync.native });
  return { ...real, realpathSync };
});

import { writableInside } from "../src/main/extensions/paths";

describe("a path that appears between the looks", () => {
  it("is written when it lies under the root, and still refused when it is a link out", () => {
    const root = mkdtempSync(join(tmpdir(), "pistachio-paths-race-"));
    const folder = join(root, "appearing");
    mkdirSync(folder);
    // The first look at the folder finds nothing (as before the other open's mkdir); the second finds it.
    race.failOnce.add(folder);
    expect(writableInside(root, "appearing/file.bin")).toBe(join(folder, "file.bin"));
    // A link out that appears the same way is still a link out.
    const outside = mkdtempSync(join(tmpdir(), "pistachio-paths-outside-"));
    symlinkSync(outside, join(root, "away"));
    race.failOnce.add(join(root, "away"));
    expect(writableInside(root, "away/file.bin")).toBeNull();
  });
});
