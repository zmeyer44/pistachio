import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { DeskGlass } from "../src/main/desk-glass";

const BOX = { x: 0, y: 0, width: 120, height: 80 };

describe("the window's glass under the desk's nub", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a native module that will not load is tried once: the nub keeps its stand-in, quietly, from then on", () => {
    const dlopen = vi.spyOn(process, "dlopen").mockImplementation(() => {
      throw new Error("no such module");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const window = { isDestroyed: () => false, getNativeWindowHandle: () => Buffer.alloc(8) } as unknown as BrowserWindow;
    const page = { isDestroyed: () => false } as unknown as Electron.WebContents;
    const glass = new DeskGlass(window, page);
    for (let sync = 0; sync < 5; sync += 1) expect(glass.sync(BOX, true, true)).toBe(false);
    expect(dlopen.mock.calls.length).toBe(process.platform === "darwin" ? 1 : 0);
  });
});
