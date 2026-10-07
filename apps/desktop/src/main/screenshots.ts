import { execFile } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, clipboard, nativeImage, screen, shell, type BrowserWindow, type NativeImage } from "electron";
import type { ScreenshotBox, ScreenshotHold, ScreenshotRequest, ScreenshotResult } from "@pistachio/shell-contracts/screenshot";
import { cropPixels, drawLayer, groundPixels, parseGround, type Pixels } from "./window-compose";

export interface ScreenshotHost {
  window(): BrowserWindow | null;
  /** The corner radius main gave a native view (setBorderRadius has no getter): a page's, or 0. */
  radiusOf(contents: Electron.WebContents): number;
  /** A view left out of every screenshot: the notices (one saying the last screenshot was taken, say). */
  leftOut(contents: Electron.WebContents): boolean;
  /** Where a page in HTML fullscreen lies — over the layout the shell measured — or null. */
  fullscreenPage(): ScreenshotBox | null;
  /**
   * The view that has the keyboard, if not the shell: a page (a tab's, a
   * Glance's) or a utility view's field (the find bar, the bookmark card) —
   * where the area's key was pressed.
   */
  keyboardHolder(): Electron.WebContents | null;
  /** Give that view the keyboard back once it is on screen again (the selector took it, and hid or covered it). */
  giveKeyboardBack(contents: Electron.WebContents): void;
}

/** A capture of the window, in device pixels, `scale` of them to a CSS px. */
interface Picture {
  pixels: Pixels;
  scale: number;
}

/**
 * Screenshots of the window (@pistachio/shell-contracts/screenshot). macOS
 * captures the screen only for an app the person has let record it, so this
 * never asks the OS: it captures each layer of its own window — the shell
 * page, then every visible native view over it, in their stacking order — and
 * lays them up as the window's compositor does, each page cut to its rounded
 * corners. The shell page is partly see-through where the window's glass
 * shows; the shell names the colour to stand in for it.
 */
export class Screenshots {
  readonly #host: ScreenshotHost;
  /** The whole window, captured as an area screenshot began: the area is cut from it. */
  #held: Picture | null = null;
  /** The view that had the keyboard as the window was held: it has it back once the area is chosen (the selector took it). */
  #keyboardHolder: Electron.WebContents | null = null;
  /** What this session saved: the only files `reveal` will show. */
  readonly #saved = new Set<string>();

  constructor(host: ScreenshotHost) {
    this.#host = host;
  }

  /** The window is held while an area of it is chosen (from `hold` to `finish`): the selector has every key. */
  get selecting(): boolean {
    return this.#held !== null;
  }

  /** The shell reloaded: an area being chosen there is gone, and so is the hold. */
  reset(): void {
    this.#held = null;
    this.#keyboardHolder = null;
  }

  async request(request: ScreenshotRequest): Promise<ScreenshotResult | ScreenshotHold | null> {
    switch (request.type) {
      case "page": {
        const picture = await this.#capture(this.#host.fullscreenPage() ?? request.box, request.ground);
        return picture === null ? null : this.#keep(picture.pixels, picture.scale);
      }
      case "hold": {
        const window = this.#host.window();
        this.#held = null;
        this.#keyboardHolder = this.#host.keyboardHolder();
        if (window === null) return null;
        const [width = 0, height = 0] = window.getContentSize();
        const held = await this.#capture({ x: 0, y: 0, width, height }, request.ground);
        if (held === null) return null;
        this.#held = held;
        // Drawn under the area being chosen, pixel for pixel (marked 1×: a JPEG is written from the 1× representation).
        const { data, width: w, height: h } = held.pixels;
        const shown = nativeImage.createFromBitmap(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { width: w, height: h });
        return { picture: `data:image/jpeg;base64,${shown.toJPEG(92).toString("base64")}` };
      }
      case "finish": {
        const held = this.#held;
        this.#held = null;
        if (this.#keyboardHolder !== null) this.#host.giveKeyboardBack(this.#keyboardHolder);
        this.#keyboardHolder = null;
        if (held === null || request.box === null) return null;
        const { box } = request;
        const pixels = cropPixels(held.pixels, box.x * held.scale, box.y * held.scale, box.width * held.scale, box.height * held.scale);
        return pixels === null ? null : this.#keep(pixels, held.scale);
      }
      case "reveal":
        if (this.#saved.has(request.path)) shell.showItemInFolder(request.path);
        return null;
    }
  }

  async #capture(box: ScreenshotBox, ground: string): Promise<Picture | null> {
    const window = this.#host.window();
    if (window === null || window.isDestroyed()) return null;
    const [contentWidth = 0, contentHeight = 0] = window.getContentSize();
    const target = intersect(
      { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.x + box.width) - Math.floor(box.x), height: Math.ceil(box.y + box.height) - Math.floor(box.y) },
      { x: 0, y: 0, width: contentWidth, height: contentHeight },
    );
    if (target === null) return null;
    const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor;
    const layers: Array<{ contents: Electron.WebContents; bounds: ScreenshotBox; radius: number }> = [
      { contents: window.webContents, bounds: { x: 0, y: 0, width: contentWidth, height: contentHeight }, radius: 0 },
    ];
    // Children stack in order: each over the ones before it.
    for (const child of window.contentView.children) {
      if (!("webContents" in child) || !child.getVisible()) continue;
      const contents = (child as Electron.WebContentsView).webContents;
      if (contents === window.webContents || contents.isDestroyed() || this.#host.leftOut(contents)) continue;
      layers.push({ contents, bounds: child.getBounds(), radius: this.#host.radiusOf(contents) });
    }
    const shots = await Promise.all(
      layers.map(async (layer) => {
        const part = intersect(layer.bounds, target);
        if (part === null) return null;
        try {
          const image = await layer.contents.capturePage({ x: part.x - layer.bounds.x, y: part.y - layer.bounds.y, width: part.width, height: part.height });
          return image.isEmpty() ? null : { image, part, layer };
        } catch {
          // A view with no frame yet (capturePage throws until its compositor has one) shows nothing.
          return null;
        }
      }),
    );
    const out = groundPixels(Math.round(target.width * scale), Math.round(target.height * scale), parseGround(ground));
    for (const shot of shots) {
      if (shot === null) continue;
      const { part, layer } = shot;
      const width = Math.round(part.width * scale);
      const height = Math.round(part.height * scale);
      let image: NativeImage = shot.image;
      const size = image.getSize();
      // A view caught mid-resize hands back last frame's size: stretched to its box, as the compositor would.
      if (Math.abs(size.width - width) > 1 || Math.abs(size.height - height) > 1) image = image.resize({ width, height, quality: "best" });
      const { width: w, height: h } = image.getSize();
      drawLayer(
        out,
        { data: clamped(image.toBitmap()), width: w, height: h },
        Math.round((part.x - target.x) * scale),
        Math.round((part.y - target.y) * scale),
        layer.radius > 0
          ? {
              x: (layer.bounds.x - target.x) * scale,
              y: (layer.bounds.y - target.y) * scale,
              width: layer.bounds.width * scale,
              height: layer.bounds.height * scale,
              radius: layer.radius * scale,
            }
          : null,
      );
    }
    return { pixels: out, scale };
  }

  /** Copy the picture and save it as a PNG where the Mac saves screenshots. */
  async #keep(pixels: Pixels, scale: number): Promise<ScreenshotResult> {
    // Marked at the display's scale, so it pastes at the size it was on screen (a Retina screenshot's 2× pixels in 1× points).
    const image = nativeImage.createFromBitmap(Buffer.from(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength), {
      width: pixels.width,
      height: pixels.height,
      scaleFactor: scale,
    });
    let copied = false;
    try {
      clipboard.writeImage(image);
      copied = true;
    } catch (error: unknown) {
      console.error("[screenshot] could not copy", error);
    }
    const png = image.toPNG({ scaleFactor: scale });
    try {
      const folder = await screenshotFolder();
      const base = screenshotName(new Date());
      for (let attempt = 1; attempt < 100; attempt += 1) {
        const name = attempt === 1 ? `${base}.png` : `${base} (${String(attempt)}).png`;
        const path = join(folder, name);
        try {
          await writeFile(path, png, { flag: "wx" });
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw error;
        }
        this.#saved.add(path);
        return { path, name, copied };
      }
    } catch (error: unknown) {
      console.error("[screenshot] could not save", error);
    }
    return { path: null, name: null, copied };
  }
}

/** The same bytes, read as clamped (the blend writes fractions). */
function clamped(bytes: Buffer): Uint8ClampedArray {
  return new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function intersect(a: ScreenshotBox, b: ScreenshotBox): ScreenshotBox | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right - x < 1 || bottom - y < 1 ? null : { x, y, width: right - x, height: bottom - y };
}

/** "Screenshot 2026-10-06 at 3.04.12 PM", as the Mac names its own (with a plain space before the PM). */
export function screenshotName(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const hour = at.getHours() % 12 === 0 ? 12 : at.getHours() % 12;
  return `Screenshot ${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} at ${String(hour)}.${pad(at.getMinutes())}.${pad(at.getSeconds())} ${at.getHours() < 12 ? "AM" : "PM"}`;
}

/**
 * Where the Mac saves screenshots (Screenshot's Options › Save to, kept as
 * `com.apple.screencapture location`), or the Desktop, its default. A spec
 * points PISTACHIO_SCREENSHOT_DIR at its own folder.
 */
async function screenshotFolder(): Promise<string> {
  const override = process.env["PISTACHIO_SCREENSHOT_DIR"];
  if (override !== undefined && override !== "") return override;
  if (process.platform === "darwin") {
    const location = await new Promise<string | null>((done) =>
      execFile("defaults", ["read", "com.apple.screencapture", "location"], { timeout: 2_000 }, (error, stdout) => done(error === null ? stdout.trim() : null)),
    );
    if (location !== null && location !== "") {
      const folder = location.replace(/^~(?=$|\/)/, homedir());
      if (await isDirectory(folder)) return folder;
    }
  }
  return app.getPath("desktop");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
