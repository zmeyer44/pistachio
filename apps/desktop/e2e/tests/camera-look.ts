import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Page } from "@playwright/test";

/**
 * How a camera's picture looks, sampled from a `<video>` in its page (or a
 * canvas one of its frames was drawn on) — for the live share's camera
 * backgrounds (docs/live-share.md §1), proven on Chromium's fake camera:
 * a green field with a bright, hard-edged disc turning in it and a counter
 * in the corner. No person is in it, so the segmenter takes all of it for
 * background: Blur softens every edge (the colours stay the camera's), and a
 * scene replaces the picture outright (the colours become the scene's).
 */
export interface Look {
  width: number;
  height: number;
  /** The mean colour, 0–255 a channel. */
  r: number;
  g: number;
  b: number;
  /**
   * The hard edges: the brightness step (0–255) between neighbouring pixels
   * of a row that only the sharpest 0.1% of steps reach. The fake camera's
   * disc gives tens; blurred, a few.
   */
  edge: number;
}

export type Colour = Pick<Look, "r" | "g" | "b">;

/** Sampled at this size: enough for the disc's edge, cheap to read back. */
const SAMPLE = { width: 640, height: 360 } as const;

/**
 * The current frame of the first video matching `selector` (or the picture on
 * the first canvas: a frame drawn on it), or null while it has none.
 */
export function lookOf(page: Page, selector: string): Promise<Look | null> {
  return page.evaluate(
    ([query, size]) => {
      const source = document.querySelector<HTMLVideoElement | HTMLCanvasElement>(query);
      if (source === null) return null;
      const [width, height] = source instanceof HTMLCanvasElement ? [source.width, source.height] : source.readyState < 2 ? [0, 0] : [source.videoWidth, source.videoHeight];
      if (width === 0 || height === 0) return null;
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(source, 0, 0, size.width, size.height);
      const pixels = context.getImageData(0, 0, size.width, size.height).data;
      let r = 0;
      let g = 0;
      let b = 0;
      const steps = new Uint32Array(256);
      const luma = (at: number): number => 0.299 * pixels[at]! + 0.587 * pixels[at + 1]! + 0.114 * pixels[at + 2]!;
      for (let y = 0; y < size.height; y += 1) {
        for (let x = 0; x < size.width; x += 1) {
          const at = (y * size.width + x) * 4;
          r += pixels[at]!;
          g += pixels[at + 1]!;
          b += pixels[at + 2]!;
          if (x + 1 < size.width) steps[Math.min(255, Math.round(Math.abs(luma(at + 4) - luma(at))))]! += 1;
        }
      }
      // The step only the sharpest 0.1% reach.
      let left = Math.ceil(size.height * (size.width - 1) * 0.001);
      let edge = 255;
      while (edge > 0 && left > steps[edge]!) left -= steps[edge--]!;
      const count = size.width * size.height;
      return { width, height, r: r / count, g: g / count, b: b / count, edge };
    },
    [selector, SAMPLE] as const,
  );
}

/** The mean colour of an image (a scene's URL) filling a camera-shaped frame, as the background would. */
export function imageColour(page: Page, url: string): Promise<Colour> {
  return page.evaluate(
    async ([src, size]) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(image, 0, 0, size.width, size.height);
      const pixels = context.getImageData(0, 0, size.width, size.height).data;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let at = 0; at < pixels.length; at += 4) {
        r += pixels[at]!;
        g += pixels[at + 1]!;
        b += pixels[at + 2]!;
      }
      const count = pixels.length / 4;
      return { r: r / count, g: g / count, b: b / count };
    },
    [url, SAMPLE] as const,
  );
}

/** How far apart two colours are (0 the same, ~441 black to white). */
export function colourDistance(a: Colour, b: Colour): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

/** The fake camera as it comes: green, its disc hard-edged. */
export function isPlainCamera(look: Look): boolean {
  return look.g > look.r + 60 && look.g > look.b + 60 && look.edge >= 30;
}

/** The same camera blurred: still its colours (`plain`'s, near enough), but no hard edge left. */
export function isBlurred(look: Look, plain: Look): boolean {
  return colourDistance(look, plain) < 40 && look.edge <= Math.max(8, plain.edge / 3);
}

/** The picture replaced by a scene: the scene's colours, nothing like the camera's. */
export function showsScene(look: Look, scene: Colour, plain: Look): boolean {
  return colourDistance(look, scene) < 30 && colourDistance(look, plain) > 100;
}

/** The current frame of the first video (or the picture on the first canvas) matching `selector`, saved as a PNG at `path` (for people reviewing a change). */
export async function savePicture(page: Page, selector: string, path: string): Promise<void> {
  const url = await page.evaluate((query) => {
    const source = document.querySelector<HTMLVideoElement | HTMLCanvasElement>(query)!;
    if (source instanceof HTMLCanvasElement) return source.toDataURL("image/png");
    const canvas = document.createElement("canvas");
    canvas.width = source.videoWidth;
    canvas.height = source.videoHeight;
    canvas.getContext("2d")!.drawImage(source, 0, 0);
    return canvas.toDataURL("image/png");
  }, selector);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
}
