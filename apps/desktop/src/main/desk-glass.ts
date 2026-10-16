/**
 * The window's own glass under the desk's nub over a live page (native/desk-glass; docs/desk-agent.md §1, "The Bar").
 *
 * Over a live page the nub is the notch view (NotchApp), which paints the shell's ground under itself: with the
 * desktop glass on, that ground is AppKit's behind-window material, which no renderer can read, so the view could only
 * paint a stand-in grey, a shade off the gutter round the desk whenever the desktop behind the window was not the one
 * it was tuned on. The native module lays the material itself in the notch view's NSView, cut to the nub's outline as
 * the view draws it, and over it the view's own page, frame by frame (Chromium composites every view's page into one
 * layer under all their NSViews, so the glass hides the view's page where it lies: it is drawn again over it). The
 * view then paints only what the shell lays over the glass, and its mark (DeskNotchFrame.nativeGlass).
 *
 * Without the module (not a Mac, or not built: scripts/build-native.mjs) or the glass, the view keeps its stand-in.
 */

import type { BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentBounds } from "@pistachio/shell-contracts/ipc";

interface DeskGlassModule {
  attach(windowHandle: Buffer, box: ContentBounds): boolean;
  outline(points: readonly number[]): void;
  frame(bitmap: Buffer, width: number, height: number): void;
  detach(): void;
}

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
    const { attach, outline, frame, detach } = module.exports;
    return typeof attach === "function" && typeof outline === "function" && typeof frame === "function" && typeof detach === "function"
      ? { attach, outline, frame, detach }
      : null;
  } catch (error) {
    console.warn("desk-glass: the native module did not load; the nub keeps its stand-in grey", error);
    return null;
  }
}

/** A frame's pixel size: its bytes (BGRA) over its shape — a NativeImage gives its size in DIPs, its bitmap in pixels. */
function pixelSize(bytes: number, dip: { width: number; height: number }): { width: number; height: number } | null {
  const pixels = bytes / 4;
  if (dip.width < 1 || dip.height < 1 || !Number.isInteger(pixels)) return null;
  const width = Math.round(Math.sqrt((pixels * dip.width) / dip.height));
  const height = pixels / width;
  return Number.isInteger(height) ? { width, height } : null;
}

export class DeskGlass {
  readonly #window: BrowserWindow;
  /** The notch view's page, drawn again over the glass. */
  readonly #page: Electron.WebContents;
  #module: DeskGlassModule | null | undefined;
  #attached = false;
  #subscribed = false;

  constructor(window: BrowserWindow, page: Electron.WebContents) {
    this.#window = window;
    this.#page = page;
  }

  /**
   * The glass under the notch view as it stands — on screen at `box` with the window's glass on — or taken out.
   * Whether it lies there: the view paints no stand-in then.
   */
  sync(box: ContentBounds | null, onScreen: boolean, windowGlass: boolean): boolean {
    if (!windowGlass || this.#window.isDestroyed()) {
      this.#detach();
      return false;
    }
    // (Hidden, it hides with the view it lies in; it is found again only if it was never placed.)
    if (!onScreen || box === null) return this.#attached;
    // (Once: a module that will not load is not tried again.)
    if (this.#module === undefined) this.#module = load();
    if (this.#module === null) return false;
    this.#attached = this.#module.attach(this.#window.getNativeWindowHandle(), box);
    if (this.#attached) this.#subscribe(this.#module);
    return this.#attached;
  }

  /** Cut to the nub's outline as the view draws it. */
  outline(points: readonly number[]): void {
    if (this.#attached) this.#module?.outline(points);
  }

  dispose(): void {
    this.#detach();
  }

  #subscribe(module: DeskGlassModule): void {
    if (this.#subscribed || this.#page.isDestroyed()) return;
    this.#subscribed = true;
    this.#page.beginFrameSubscription(false, (image) => {
      const scale = Math.max(...image.getScaleFactors(), 1);
      const bitmap = image.toBitmap({ scaleFactor: scale });
      const size = pixelSize(bitmap.length, image.getSize());
      if (size !== null) module.frame(bitmap, size.width, size.height);
    });
    // (A frame now: the subscription hears only what is painted from here on.)
    this.#page.invalidate();
  }

  #detach(): void {
    if (this.#subscribed && !this.#page.isDestroyed()) this.#page.endFrameSubscription();
    this.#subscribed = false;
    if (!this.#attached) return;
    this.#attached = false;
    this.#module?.detach();
  }
}
