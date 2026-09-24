/**
 * The colours a favorite tile wears when its page is active: the brand's
 * own, not the theme's. For an app in the onboarding catalog they are known
 * (FAVORITE_APPS.colors); for any other page they are read off its favicon —
 * the renderer decodes the image and hands the pixels to `paletteOf`.
 *
 * Pure on purpose — no DOM, no Electron — so vitest pins it under node.
 */

import { FAVORITE_APPS } from "./onboarding.js";

/** The most colours a tile's wash and border carry. */
export const MAX_BRAND_COLORS = 5;

/** The catalog's hosts, parsed once: this runs per tile per render. */
const CATALOG_HOSTS: ReadonlyArray<{ host: string; colors: readonly string[] }> = FAVORITE_APPS.map((app) => ({
  host: new URL(app.url).host.replace(/^www\./, ""),
  colors: app.colors,
}));

/** The catalog app whose site `url` is on, if any. */
export function catalogColorsFor(url: string): readonly string[] | null {
  let host: string;
  try {
    host = new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
  for (const app of CATALOG_HOSTS) {
    if (host === app.host || host.endsWith(`.${app.host}`)) return app.colors;
  }
  return null;
}

/**
 * The brand colours in an icon's RGBA bytes, strongest first: the hues that
 * cover the most of it, ignoring what is transparent, white, black, or grey
 * — a favicon's paper, not its mark. Empty when the icon has no colour to
 * speak of (a black-on-white glyph), so the caller can fall back to ink.
 */
export function paletteOf(
  rgba: Uint8ClampedArray | readonly number[],
  max = MAX_BRAND_COLORS,
): string[] {
  const BUCKETS = 24;
  const weight = new Float64Array(BUCKETS);
  const sumR = new Float64Array(BUCKETS);
  const sumG = new Float64Array(BUCKETS);
  const sumB = new Float64Array(BUCKETS);
  let opaque = 0;
  for (let at = 0; at + 3 < rgba.length; at += 4) {
    const a = rgba[at + 3] ?? 0;
    if (a < 128) continue;
    opaque += 1;
    const r = rgba[at] ?? 0;
    const g = rgba[at + 1] ?? 0;
    const b = rgba[at + 2] ?? 0;
    const { h, s, l } = hsl(r, g, b);
    // Paper and ink: too pale, too dark, or too grey to be a brand colour.
    if (s < 0.25 || l < 0.12 || l > 0.92) continue;
    const bucket = Math.floor((h / 360) * BUCKETS) % BUCKETS;
    // Vivid pixels count for more, so a saturated mark beats an anti-aliased fringe.
    const w = s;
    weight[bucket] = (weight[bucket] ?? 0) + w;
    sumR[bucket] = (sumR[bucket] ?? 0) + r * w;
    sumG[bucket] = (sumG[bucket] ?? 0) + g * w;
    sumB[bucket] = (sumB[bucket] ?? 0) + b * w;
  }
  if (opaque === 0) return [];
  const ranked = Array.from({ length: BUCKETS }, (_, bucket) => bucket)
    .filter((bucket) => (weight[bucket] ?? 0) > 0)
    .sort((a, b) => (weight[b] ?? 0) - (weight[a] ?? 0));
  const top = weight[ranked[0] ?? 0] ?? 0;
  // A hue must colour a real share of the icon, and matter next to the strongest.
  const kept = ranked
    .filter(
      (bucket) => (weight[bucket] ?? 0) >= Math.max(opaque * 0.03, top * 0.18),
    )
    .slice(0, max);
  return kept.map((bucket) => {
    const w = weight[bucket] ?? 1;
    return hex(
      (sumR[bucket] ?? 0) / w,
      (sumG[bucket] ?? 0) / w,
      (sumB[bucket] ?? 0) / w,
    );
  });
}

/** `colors` as the gradient a tile paints, in order; one colour is flat. */
export function brandGradient(colors: readonly string[]): string {
  const stops =
    colors.length === 0
      ? ["#888888", "#888888"]
      : colors.length === 1
        ? [colors[0], colors[0]]
        : colors;
  return `linear-gradient(135deg, ${stops.join(", ")})`;
}

function hsl(
  r: number,
  g: number,
  b: number,
): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h = h * 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

function hex(r: number, g: number, b: number): string {
  const part = (v: number) =>
    Math.round(Math.max(0, Math.min(255, v)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}
