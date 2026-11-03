/**
 * The background presets the inspector shows as swatches: the renderer's own
 * list (src/lib/wallpapers.ts), so every id the editor writes is one the
 * renderer and the export draw. A wallpaper's swatch is the wallpaper itself,
 * drawn small once; a gradient's is its CSS likeness.
 */
import { GRADIENTS, WALLPAPERS, drawWallpaper, type Ctx2D } from "../lib/wallpapers.js";
import type { BackgroundSpec } from "../lib/types.js";

export interface Swatch {
  id: string;
  name: string;
  kind: "wallpaper" | "gradient";
  /** A CSS colour close to the picture's average: the fallback while it is drawn. */
  colour: string;
}

export const SWATCHES: readonly Swatch[] = [
  ...WALLPAPERS.map((w): Swatch => ({ id: w.id, name: w.name, kind: "wallpaper", colour: w.swatch })),
  ...GRADIENTS.map((g): Swatch => ({ id: g.id, name: g.name, kind: "gradient", colour: g.stops[0]?.[1] ?? "#888" })),
];

const drawn = new Map<string, string>();

/** A wallpaper drawn at swatch size as a data URL (cached), or null where there is no canvas. */
function wallpaperImage(id: string): string | null {
  const cached = drawn.get(id);
  if (cached !== undefined) return cached;
  if (typeof document === "undefined") return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 64;
    const ctx = canvas.getContext("2d") as Ctx2D | null;
    if (ctx === null) return null;
    drawWallpaper(ctx, id, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/png");
    drawn.set(id, url);
    return url;
  } catch {
    return null;
  }
}

/** The swatch's CSS `background`. */
export function swatchCss(swatch: Swatch): string {
  if (swatch.kind === "gradient") {
    const gradient = GRADIENTS.find((g) => g.id === swatch.id);
    if (gradient === undefined) return swatch.colour;
    return `linear-gradient(${String(gradient.angle)}deg, ${gradient.stops.map(([at, colour]) => `${colour} ${String(Math.round(at * 100))}%`).join(", ")})`;
  }
  const image = wallpaperImage(swatch.id);
  return image === null ? swatch.colour : `url("${image}") center / cover no-repeat, ${swatch.colour}`;
}

export function swatchFor(spec: BackgroundSpec): Swatch | null {
  if (spec.type !== "wallpaper" && spec.type !== "gradient") return null;
  return SWATCHES.find((swatch) => swatch.kind === spec.type && swatch.id === spec.id) ?? null;
}

export function backgroundOf(swatch: Swatch): BackgroundSpec {
  return { type: swatch.kind, id: swatch.id };
}
