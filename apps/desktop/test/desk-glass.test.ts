import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { DeskNotchFrame } from "@pistachio/shell-contracts/desk";
import { IPC } from "@pistachio/shell-contracts/ipc";
import { AWAY_FPS, DeskGlass, pictureRate, type DeskGlassPicture } from "../src/main/desk-glass";

const BOX = { x: 0, y: 0, width: 120, height: 80 };
const WINDOW = { isDestroyed: () => false, getNativeWindowHandle: () => Buffer.alloc(8) } as unknown as BrowserWindow;

/** The nub's picture as main makes it (an offscreen page in a hidden window), its paints sent by hand. */
function pictureWindow(scale: number) {
  let paint: ((event: unknown, dirty: unknown, image: Electron.NativeImage) => void) | null = null;
  let size = [1, 1];
  const window = {
    scale,
    destroyed: false,
    isDestroyed: () => window.destroyed,
    destroy: vi.fn(() => {
      window.destroyed = true;
    }),
    getContentSize: () => size,
    setContentSize: vi.fn((width: number, height: number) => {
      size = [width, height];
    }),
    webContents: {
      id: 7,
      on: (event: string, listener: typeof paint) => {
        if (event === "paint") paint = listener;
      },
      setFrameRate: vi.fn(),
      send: vi.fn(),
    },
    /** A paint of `width` × `height` device pixels (premultiplied BGRA; offscreen, its size is given in pixels). */
    paint(width: number, height: number): Buffer {
      const bitmap = Buffer.alloc(width * height * 4, 9);
      paint?.({}, {}, { toBitmap: () => bitmap, getSize: () => ({ width, height }) } as unknown as Electron.NativeImage);
      return bitmap;
    },
  };
  return window;
}

describe("the window's glass under the desk's nub", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a native module that will not load is tried once, and no picture is made: the nub keeps its stand-in", () => {
    const dlopen = vi.spyOn(process, "dlopen").mockImplementation(() => {
      throw new Error("no such module");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const picture = vi.fn();
    const glass = new DeskGlass(WINDOW, { picture, display: () => ({ scaleFactor: 2, displayFrequency: 60 }) });
    for (let sync = 0; sync < 5; sync += 1) glass.sync(BOX, true, true, false);
    expect(dlopen.mock.calls.length).toBe(process.platform === "darwin" ? 1 : 0);
    expect(picture).not.toHaveBeenCalled();
    expect(glass.picture).toBeNull();
  });

  it.runIf(process.platform === "darwin")(
    "lays each paint of the nub's picture over the glass as it comes, at the display's rate — the last at once when the glass comes again",
    () => {
      const module = { attach: vi.fn(() => true), frame: vi.fn(), detach: vi.fn() };
      vi.spyOn(process, "dlopen").mockImplementation((target) => {
        (target as { exports: unknown }).exports = module;
      });
      const made: ReturnType<typeof pictureWindow>[] = [];
      let display = { scaleFactor: 2, displayFrequency: 74.99 };
      const glass = new DeskGlass(WINDOW, {
        picture: (scale) => {
          const window = pictureWindow(scale);
          made.push(window);
          return window as unknown as DeskGlassPicture;
        },
        display: () => display,
      });

      // Not until the view is first on screen.
      glass.sync(BOX, false, true, false);
      expect(made).toHaveLength(0);
      glass.sync(BOX, true, true, false);
      expect(made).toHaveLength(1);
      const [picture] = made as [ReturnType<typeof pictureWindow>];
      expect(picture.scale).toBe(2);
      // The view's box twice over (the nub over its outline), painted as often as the display draws.
      expect(picture.setContentSize).toHaveBeenLastCalledWith(120, 160);
      expect(picture.webContents.setFrameRate).toHaveBeenLastCalledWith(75);
      expect(module.attach).toHaveBeenCalledTimes(1);
      const first = picture.paint(240, 320);
      expect(module.frame).toHaveBeenLastCalledWith(first, 240, 320, 2);

      // The view away: the picture keeps up at a walk, its paints still laid in the hidden glass.
      glass.sync(BOX, false, true, false);
      expect(picture.webContents.setFrameRate).toHaveBeenLastCalledWith(AWAY_FPS);
      picture.paint(240, 320);
      expect(module.frame).toHaveBeenCalledTimes(2);

      // A view stacked over it: the glass steps aside, and back, the last paint laid at once (none came meanwhile).
      glass.sync(BOX, true, true, true);
      expect(module.detach).toHaveBeenCalledTimes(1);
      const meanwhile = picture.paint(240, 320);
      expect(module.frame).toHaveBeenCalledTimes(2);
      glass.sync(BOX, true, true, false);
      expect(module.frame).toHaveBeenCalledTimes(3);
      expect(module.frame).toHaveBeenLastCalledWith(meanwhile, 240, 320, 2);

      // The nub the picture paints: the view's, and the last one while the view has none.
      const frame = { label: "Ask about Bar" } as DeskNotchFrame;
      glass.setFrame(frame);
      glass.setFrame(null);
      expect(glass.frame).toBe(frame);
      expect(picture.webContents.send).toHaveBeenCalledTimes(1);
      expect(picture.webContents.send).toHaveBeenLastCalledWith(IPC.deskNotchChanged, frame);

      // Moved to a display of another scale: painted afresh at that one.
      display = { scaleFactor: 1, displayFrequency: 60 };
      glass.sync(BOX, true, true, false);
      expect(picture.destroy).toHaveBeenCalledTimes(1);
      expect(made).toHaveLength(2);
      expect(made[1]!.scale).toBe(1);
      expect(made[1]!.webContents.setFrameRate).toHaveBeenLastCalledWith(60);
      // (The old one's paints are no longer laid.)
      picture.paint(240, 320);
      expect(module.frame).toHaveBeenCalledTimes(3);

      // The desktop glass off: the glass out, and the picture with it.
      glass.sync(BOX, true, false, false);
      expect(module.detach).toHaveBeenCalledTimes(2);
      expect(made[1]!.destroy).toHaveBeenCalledTimes(1);
      expect(glass.picture).toBeNull();
    },
  );

  it("paints the picture at the display's rate, within what offscreen painting takes", () => {
    expect(pictureRate(74.99)).toBe(75);
    expect(pictureRate(120)).toBe(120);
    expect(pictureRate(500)).toBe(240);
    expect(pictureRate(24)).toBe(30);
    expect(pictureRate(0)).toBe(60);
    expect(pictureRate(Number.NaN)).toBe(60);
  });
});
