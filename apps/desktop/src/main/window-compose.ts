/**
 * The pixel work of a window screenshot (screenshots.ts), apart from Electron
 * so it can be tested. A picture is laid up from the window's layers — the
 * shell page, then each native view over it — on an opaque ground, as the
 * window's compositor lays them on screen. Pixels are what
 * NativeImage.toBitmap hands back and createFromBitmap takes: four bytes
 * each, B G R A, the colour premultiplied by the alpha, rows packed.
 */

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** A rounded rectangle a layer is cut to (a native view's corner radius), in the picture's pixels. */
export interface LayerClip {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}

/** `#rrggbb` as [r, g, b]. */
export function parseGround(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** An opaque picture of one colour. */
export function groundPixels(width: number, height: number, [r, g, b]: readonly [number, number, number]): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let at = 0; at < data.length; at += 4) {
    data[at] = b;
    data[at + 1] = g;
    data[at + 2] = r;
    data[at + 3] = 255;
  }
  return { data, width, height };
}

/**
 * How much of the pixel centred at (px, py) lies inside `clip`: 1 inside, 0
 * outside, and the share of the pixel along its edges and round its corners,
 * so a rounded corner is smoothed as the compositor smooths it.
 */
export function clipCoverage(clip: LayerClip, px: number, py: number): number {
  const { x, y, width, height } = clip;
  const r = Math.max(0, Math.min(clip.radius, width / 2, height / 2));
  const dx = px < x + r ? x + r - px : px > x + width - r ? px - (x + width - r) : 0;
  const dy = py < y + r ? y + r - py : py > y + height - r ? py - (y + height - r) : 0;
  const cover = dx > 0 && dy > 0 ? r - Math.hypot(dx, dy) + 0.5 : Math.min(px - x, x + width - px, py - y, y + height - py) + 0.5;
  return cover <= 0 ? 0 : cover >= 1 ? 1 : cover;
}

/**
 * Lay `layer` over `out` with its top-left pixel at (left, top), cut to
 * `clip` when it has one and to `out`'s edges. Source-over, premultiplied.
 */
export function drawLayer(out: Pixels, layer: Pixels, left: number, top: number, clip: LayerClip | null): void {
  let x0 = Math.max(0, left);
  let y0 = Math.max(0, top);
  let x1 = Math.min(out.width, left + layer.width);
  let y1 = Math.min(out.height, top + layer.height);
  if (clip !== null) {
    x0 = Math.max(x0, Math.floor(clip.x));
    y0 = Math.max(y0, Math.floor(clip.y));
    x1 = Math.min(x1, Math.ceil(clip.x + clip.width));
    y1 = Math.min(y1, Math.ceil(clip.y + clip.height));
  }
  const src = layer.data;
  const dst = out.data;
  for (let py = y0; py < y1; py += 1) {
    let s = ((py - top) * layer.width + (x0 - left)) * 4;
    let d = (py * out.width + x0) * 4;
    for (let px = x0; px < x1; px += 1, s += 4, d += 4) {
      const cover = clip === null ? 1 : clipCoverage(clip, px + 0.5, py + 0.5);
      const alpha = src[s + 3]! * cover;
      if (alpha <= 0) continue;
      if (alpha >= 255) {
        dst[d] = src[s]!;
        dst[d + 1] = src[s + 1]!;
        dst[d + 2] = src[s + 2]!;
        dst[d + 3] = 255;
        continue;
      }
      const keep = 1 - alpha / 255;
      dst[d] = src[s]! * cover + dst[d]! * keep;
      dst[d + 1] = src[s + 1]! * cover + dst[d + 1]! * keep;
      dst[d + 2] = src[s + 2]! * cover + dst[d + 2]! * keep;
      dst[d + 3] = alpha + dst[d + 3]! * keep;
    }
  }
}

/** The part of `pixels` in this box (clamped to it), or null when none is. */
export function cropPixels(pixels: Pixels, left: number, top: number, width: number, height: number): Pixels | null {
  const x0 = Math.max(0, Math.round(left));
  const y0 = Math.max(0, Math.round(top));
  const x1 = Math.min(pixels.width, Math.round(left + width));
  const y1 = Math.min(pixels.height, Math.round(top + height));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  const w = x1 - x0;
  const data = new Uint8ClampedArray(w * (y1 - y0) * 4);
  for (let row = y0; row < y1; row += 1) {
    const from = (row * pixels.width + x0) * 4;
    data.set(pixels.data.subarray(from, from + w * 4), (row - y0) * w * 4);
  }
  return { data, width: w, height: y1 - y0 };
}
