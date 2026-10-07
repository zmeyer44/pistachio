import { describe, expect, it } from "vitest";
import { clipCoverage, cropPixels, drawLayer, groundPixels, parseGround, type Pixels } from "../src/main/window-compose";

/** One colour, B G R A premultiplied, as NativeImage.toBitmap hands it back. */
function solid(width: number, height: number, [r, g, b]: [number, number, number], alpha = 255): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let at = 0; at < data.length; at += 4) {
    data[at] = (b * alpha) / 255;
    data[at + 1] = (g * alpha) / 255;
    data[at + 2] = (r * alpha) / 255;
    data[at + 3] = alpha;
  }
  return { data, width, height };
}

/** [r, g, b, a] at (x, y). */
function at(pixels: Pixels, x: number, y: number): number[] {
  const i = (y * pixels.width + x) * 4;
  return [pixels.data[i + 2]!, pixels.data[i + 1]!, pixels.data[i]!, pixels.data[i + 3]!];
}

describe("window screenshots' compositing", () => {
  it("starts from the opaque ground, in BGRA", () => {
    expect(parseGround("#1a2b3c")).toEqual([0x1a, 0x2b, 0x3c]);
    const out = groundPixels(2, 1, parseGround("#1a2b3c"));
    expect([...out.data]).toEqual([0x3c, 0x2b, 0x1a, 255, 0x3c, 0x2b, 0x1a, 255]);
  });

  it("lays an opaque layer over at its offset, cut to the picture", () => {
    const out = groundPixels(4, 4, [255, 255, 255]);
    drawLayer(out, solid(3, 3, [255, 0, 0]), 2, 2, null);
    expect(at(out, 1, 1)).toEqual([255, 255, 255, 255]);
    expect(at(out, 2, 2)).toEqual([255, 0, 0, 255]);
    expect(at(out, 3, 3)).toEqual([255, 0, 0, 255]);
  });

  it("blends a see-through layer over what is under it, and the picture stays opaque", () => {
    // The shell page where the glass shows: half-transparent black over a white stand-in.
    const out = groundPixels(1, 1, [255, 255, 255]);
    drawLayer(out, solid(1, 1, [0, 0, 0], 128), 0, 0, null);
    const [r, g, b, a] = at(out, 0, 0);
    expect(a).toBe(255);
    for (const channel of [r!, g!, b!]) expect(channel).toBeCloseTo(127, -1);
  });

  it("cuts a page to its rounded corners, smoothing the edge", () => {
    const clip = { x: 0, y: 0, width: 20, height: 20, radius: 8 };
    expect(clipCoverage(clip, 0.5, 0.5)).toBe(0);
    expect(clipCoverage(clip, 10.5, 10.5)).toBe(1);
    // Along a straight edge, whole.
    expect(clipCoverage(clip, 10.5, 0.5)).toBe(1);
    const edge = clipCoverage(clip, 2.5, 2.5);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(1);

    const out = groundPixels(20, 20, [255, 255, 255]);
    drawLayer(out, solid(20, 20, [0, 0, 255]), 0, 0, clip);
    expect(at(out, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(at(out, 19, 19)).toEqual([255, 255, 255, 255]);
    expect(at(out, 10, 10)).toEqual([0, 0, 255, 255]);
    expect(at(out, 10, 0)).toEqual([0, 0, 255, 255]);
  });

  it("crops a held picture to an area, clamped to it", () => {
    const out = groundPixels(4, 4, [255, 255, 255]);
    drawLayer(out, solid(2, 2, [0, 255, 0]), 2, 0, null);
    const crop = cropPixels(out, 1, 0, 10, 2);
    expect(crop?.width).toBe(3);
    expect(crop?.height).toBe(2);
    expect(at(crop!, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(at(crop!, 1, 1)).toEqual([0, 255, 0, 255]);
    expect(cropPixels(out, 5, 5, 2, 2)).toBeNull();
  });
});
