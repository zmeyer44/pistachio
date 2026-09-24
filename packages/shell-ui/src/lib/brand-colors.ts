import { useEffect, useState } from "react";
import {
  brandGradient,
  catalogColorsFor,
  paletteOf,
} from "@pistachio/shell-contracts/brand-colors";

/**
 * The brand colours for a favorite's tile (@pistachio/shell-contracts/brand-colors), from
 * the renderer: the catalog answers at once; anything else is read off the
 * favicon, drawn to a canvas. That needs the image served with CORS — most
 * are not, and then the read fails cleanly and the tile falls back to ink.
 * Results are kept per favicon so a grid of tiles decodes each once.
 */

const cache = new Map<string, Promise<readonly string[]>>();

/** What a tile with no readable brand wears: the theme's own ink. */
export const INK_COLORS: readonly string[] = ["var(--color-gray-1000)"];

export function useBrandColors(
  url: string,
  faviconUrl: string | null,
): readonly string[] {
  const catalog = catalogColorsFor(url);
  const [read, setRead] = useState<readonly string[] | null>(null);
  useEffect(() => {
    if (catalog !== null || faviconUrl === null || faviconUrl.length === 0)
      return;
    let live = true;
    void colorsOfImage(faviconUrl).then((colors) => {
      if (live) setRead(colors);
    });
    return () => {
      live = false;
    };
  }, [catalog, faviconUrl]);
  if (catalog !== null) return catalog;
  return read === null || read.length === 0 ? INK_COLORS : read;
}

export { brandGradient };

function colorsOfImage(src: string): Promise<readonly string[]> {
  const pending = cache.get(src);
  if (pending !== undefined) return pending;
  const promise = new Promise<readonly string[]>((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      try {
        const size = 32;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (context === null) return resolve([]);
        context.drawImage(image, 0, 0, size, size);
        resolve(paletteOf(context.getImageData(0, 0, size, size).data));
      } catch {
        resolve([]);
      }
    };
    image.onerror = () => resolve([]);
    image.src = src;
  });
  cache.set(src, promise);
  return promise;
}
