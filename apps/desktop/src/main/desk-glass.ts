/**
 * The window's own glass under the desk's nub over a live page (native/desk-glass; docs/desk-agent.md §1, "The Bar").
 *
 * Over a live page the nub is the notch view (NotchApp), which paints the shell's ground under itself: with the
 * desktop glass on, that ground is AppKit's behind-window material, which no renderer can read, so the view can only
 * paint a stand-in grey, a shade off the gutter round the desk whenever the desktop behind the window is not the one
 * it was tuned on. The native module lays the material itself in the notch view's NSView, and over it the nub again
 * (Chromium composites every view's page into one layer under all their NSViews, so the glass hides the view's page
 * where it lies).
 *
 * The nub on the glass, and the glass's cut, come from one picture: the notch view's page painted offscreen
 * ("notch-picture", NotchApp's `picture`), which paints the nub with no stand-in over its outline alone, at the
 * display's rate; each paint is laid as it comes, the nub over the glass and the glass cut to the outline, in one pass.
 * Until 2026-10-16 the glass was cut to an outline the view said frame by frame and the nub was the view's own page, as
 * main's frame subscription had it — at most 30 frames a second (measured: 90 in 3 s), so through a swell the edge
 * glided while the mark on it stepped and trailed. Offscreen the page paints at the display's rate (measured: 120 a
 * second asked, each in main about 12 ms after it was drawn), and the edge and the nub on it cannot part.
 *
 * Without the module (not a Mac, or not built: scripts/build-native.mjs) or the glass, there is no picture, and the
 * view's stand-in is the nub.
 */

import type { BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeskNotchFrame } from "@pistachio/shell-contracts/desk";
import { IPC, type ContentBounds } from "@pistachio/shell-contracts/ipc";

interface DeskGlassModule {
  attach(windowHandle: Buffer, box: ContentBounds): boolean;
  frame(bitmap: Buffer, width: number, height: number, scale: number): void;
  detach(): void;
}

/**
 * The picture's rate while the notch view is off screen: it keeps up (the acting mark turns in it), so what it last
 * painted can be laid at once when the view comes back, but at a walk.
 */
export const AWAY_FPS = 10;

/** native/desk-glass's binary, from out/main (from inside the app's archive, the unpacked copy beside it). */
function modulePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "../../native/desk-glass/build/desk_glass.node").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
}

function load(): DeskGlassModule | null {
  if (process.platform !== "darwin") return null;
  try {
    const module = { exports: {} as Partial<DeskGlassModule> };
    process.dlopen(module as unknown as NodeJS.Module, modulePath());
    const { attach, frame, detach } = module.exports;
    return typeof attach === "function" && typeof frame === "function" && typeof detach === "function" ? { attach, frame, detach } : null;
  } catch (error) {
    console.warn("desk-glass: the native module did not load; the nub keeps its stand-in grey", error);
    return null;
  }
}

/** A frame's pixel size: its bytes (BGRA) over its shape — whether a NativeImage gives its size in DIPs or in pixels. */
function pixelSize(bytes: number, size: { width: number; height: number }): { width: number; height: number } | null {
  const pixels = bytes / 4;
  if (size.width < 1 || size.height < 1 || !Number.isInteger(pixels)) return null;
  const width = Math.round(Math.sqrt((pixels * size.width) / size.height));
  const height = pixels / width;
  return Number.isInteger(height) ? { width, height } : null;
}

/** The display's refresh rate as the picture's, within what offscreen painting takes. */
export function pictureRate(displayFrequency: number): number {
  return Number.isFinite(displayFrequency) && displayFrequency > 0 ? Math.min(240, Math.max(30, Math.round(displayFrequency))) : 60;
}

/**
 * Where the nub's picture is painted: a page painting offscreen, loading the "notch-picture" chrome page with the notch
 * view's preload — main's to make (in a hidden window of its own, which is what an offscreen page paints at the size of).
 */
export interface DeskGlassPicture {
  readonly webContents: Electron.WebContents;
  /** The page's size, in its CSS pixels. */
  getContentSize(): number[];
  setContentSize(width: number, height: number): void;
  isDestroyed(): boolean;
  destroy(): void;
}

export interface DeskGlassOptions {
  /** The nub's picture, painting offscreen at this device scale. */
  picture(scale: number): DeskGlassPicture;
  /** The display the window is on: its scale and its refresh rate. */
  display(): { scaleFactor: number; displayFrequency: number };
}

interface Paint {
  bitmap: Buffer;
  width: number;
  height: number;
  scale: number;
}

export class DeskGlass {
  readonly #window: BrowserWindow;
  readonly #options: DeskGlassOptions;
  #module: DeskGlassModule | null | undefined;
  #attached = false;
  /** Where the nub's picture is painted, and at what scale: made once the glass is first to lie under the view. */
  #picture: { window: DeskGlassPicture; scale: number } | null = null;
  /** The nub as the notch view was last given it, which the picture paints (and keeps while the view is away). */
  #frame: DeskNotchFrame | null = null;
  /** The picture's last paint: laid at once when the glass comes again. */
  #last: Paint | null = null;

  constructor(window: BrowserWindow, options: DeskGlassOptions) {
    this.#window = window;
    this.#options = options;
  }

  /** The page the nub's picture is painted in, while there is one. */
  get picture(): Electron.WebContents | null {
    const window = this.#picture?.window;
    return window === undefined || window.isDestroyed() ? null : window.webContents;
  }

  /** The nub the picture paints (its own read of it, as it loads). */
  get frame(): DeskNotchFrame | null {
    return this.#frame;
  }

  /** The nub as the notch view is given it: the picture's too. Gone (null), the picture keeps the last, for its return. */
  setFrame(frame: DeskNotchFrame | null): void {
    if (frame === null) return;
    this.#frame = frame;
    this.picture?.send(IPC.deskNotchChanged, frame);
  }

  /**
   * The glass under the notch view as it stands — on screen at `box` — with the window's glass on or off, and whether
   * a view stacked over the notch view lies over it: the glass hides that view's page where it lies, so it steps aside
   * meanwhile (the view's stand-in shows).
   */
  sync(box: ContentBounds | null, onScreen: boolean, windowGlass: boolean, covered: boolean): void {
    if (!windowGlass || this.#window.isDestroyed()) {
      this.dispose();
      return;
    }
    // (Once: a module that will not load is not tried again.)
    if (this.#module === undefined) this.#module = load();
    if (this.#module === null) return;
    // (The picture is made once the view is first on screen.)
    if (this.#picture === null && (!onScreen || box === null)) return;
    const display = this.#options.display();
    const picture = this.#pictureAt(display.scaleFactor);
    picture.webContents.setFrameRate(onScreen ? pictureRate(display.displayFrequency) : AWAY_FPS);
    // The view's box twice over: the nub, and its outline under it.
    if (box !== null) {
      const [width, height] = picture.getContentSize();
      if (width !== box.width || height !== box.height * 2) picture.setContentSize(box.width, box.height * 2);
    }
    if (covered) {
      this.#detach();
      return;
    }
    // (Hidden, it hides with the view it lies in; it is found again only if it was never placed.)
    if (!onScreen || box === null) return;
    const was = this.#attached;
    this.#attached = this.#module.attach(this.#window.getNativeWindowHandle(), box);
    if (this.#attached && !was && this.#last !== null) this.#lay(this.#last);
  }

  dispose(): void {
    this.#detach();
    const window = this.#picture?.window;
    this.#picture = null;
    this.#last = null;
    if (window !== undefined && !window.isDestroyed()) window.destroy();
  }

  /** The picture's window at `scale`: made afresh if it was painting at another (the window moved to another display). */
  #pictureAt(scale: number): DeskGlassPicture {
    const current = this.#picture;
    if (current !== null && current.scale === scale && !current.window.isDestroyed()) return current.window;
    if (current !== null && !current.window.isDestroyed()) current.window.destroy();
    const window = this.#options.picture(scale);
    const picture = { window, scale };
    this.#picture = picture;
    window.webContents.on("paint", (_event, _dirty, image) => {
      if (this.#picture !== picture) return;
      const bitmap = image.toBitmap();
      const size = pixelSize(bitmap.length, image.getSize());
      if (size === null) return;
      this.#last = { bitmap, width: size.width, height: size.height, scale };
      if (this.#attached) this.#lay(this.#last);
    });
    return window;
  }

  #lay(paint: Paint): void {
    this.#module?.frame(paint.bitmap, paint.width, paint.height, paint.scale);
  }

  #detach(): void {
    if (!this.#attached) return;
    this.#attached = false;
    this.#module?.detach();
  }
}
