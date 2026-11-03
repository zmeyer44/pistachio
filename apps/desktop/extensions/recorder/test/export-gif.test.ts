import { describe, expect, it } from "vitest";
import { GifWriter, buildPalette, gifDelay, paletteFrameIndices } from "../src/export/gif.js";
import { ChunkWindow } from "../src/export/writer.js";

/** Synthetic UI frames: a white page, grey text bars, a blue square moving across. */
function frame(w: number, h: number, i: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const text = y > 6 && y % 6 < 2 && x > 4 && x < w - 4;
      const square = x >= i * 2 && x < i * 2 + 8 && y >= 10 && y < 18;
      data[o] = square ? 30 : text ? 90 : 255;
      data[o + 1] = square ? 90 : text ? 90 : 255;
      data[o + 2] = square ? 220 : text ? 90 : 255;
      data[o + 3] = 255;
    }
  }
  return data;
}

/** Walks a GIF's blocks: its size, global palette, frames and their delays (centiseconds). */
function readGif(bytes: Uint8Array): { header: string; w: number; h: number; paletteSize: number; frames: number; delays: number[]; localPalettes: number; trailer: boolean } {
  const header = String.fromCharCode(...bytes.subarray(0, 6));
  const w = (bytes[6] as number) | ((bytes[7] as number) << 8);
  const h = (bytes[8] as number) | ((bytes[9] as number) << 8);
  const packed = bytes[10] as number;
  let at = 13;
  const paletteSize = packed & 0x80 ? 2 << (packed & 7) : 0;
  at += paletteSize * 3;
  let frames = 0;
  let localPalettes = 0;
  const delays: number[] = [];
  const skipSubBlocks = (): void => {
    while ((bytes[at] as number) !== 0) at += (bytes[at] as number) + 1;
    at++;
  };
  while (at < bytes.length) {
    const kind = bytes[at] as number;
    if (kind === 0x3b) return { header, w, h, paletteSize, frames, delays, localPalettes, trailer: true };
    if (kind === 0x21) {
      const label = bytes[at + 1] as number;
      if (label === 0xf9) delays.push((bytes[at + 4] as number) | ((bytes[at + 5] as number) << 8));
      at += 2;
      skipSubBlocks();
    } else if (kind === 0x2c) {
      frames++;
      const flags = bytes[at + 9] as number;
      at += 10;
      if (flags & 0x80) {
        localPalettes++;
        at += (2 << (flags & 7)) * 3;
      }
      at++; // LZW minimum code size
      skipSubBlocks();
    } else throw new Error(`unexpected block 0x${kind.toString(16)} at ${String(at)}`);
  }
  return { header, w, h, paletteSize, frames, delays, localPalettes, trailer: false };
}

describe("the GIF palette", () => {
  it("samples twelve frames spread across the clip", () => {
    expect(paletteFrameIndices(300)).toEqual([12, 37, 62, 87, 112, 137, 162, 187, 212, 237, 262, 287]);
    expect(paletteFrameIndices(5)).toEqual([0, 1, 2, 3, 4]);
    expect(paletteFrameIndices(1)).toEqual([0]);
  });

  it("holds the frames' few colours (rgb565 rounding aside)", () => {
    const palette = buildPalette([frame(64, 36, 0), frame(64, 36, 10)]);
    expect(palette.length).toBeLessThanOrEqual(256);
    const near = (r: number, g: number, b: number): boolean => palette.some(([pr, pg, pb]) => Math.abs((pr as number) - r) <= 8 && Math.abs((pg as number) - g) <= 4 && Math.abs((pb as number) - b) <= 8);
    expect(near(255, 255, 255)).toBe(true);
    expect(near(90, 90, 90)).toBe(true);
    expect(near(30, 90, 220)).toBe(true);
  });
});

describe("GIF frame delays", () => {
  it("alternate so 15 fps lasts exactly a second per 15 frames", () => {
    const delays = Array.from({ length: 15 }, (_, i) => gifDelay(i, 15));
    expect(new Set(delays)).toEqual(new Set([60, 70]));
    expect(delays.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(Array.from({ length: 10 }, (_, i) => gifDelay(i, 10))).toEqual(Array(10).fill(100));
  });
});

describe("the GIF writer", () => {
  it("writes one global palette, every frame and its delay, in chunks the window answers", async () => {
    const posted: Uint8Array[] = [];
    const window = new ChunkWindow((seq, bytes) => {
      posted.push(new Uint8Array(bytes));
      queueMicrotask(() => window.written(seq));
    });
    const w = 64;
    const h = 36;
    const frames = Array.from({ length: 30 }, (_, i) => frame(w, h, i));
    const writer = new GifWriter(window, { w, h }, 15, buildPalette(frames.filter((_, i) => i % 5 === 0)));
    for (const rgba of frames) await writer.frame(rgba);
    await writer.end();
    await window.drain();
    const bytes = new Uint8Array(posted.reduce((n, chunk) => n + chunk.length, 0));
    let offset = 0;
    for (const chunk of posted) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const gif = readGif(bytes);
    expect(gif.header).toBe("GIF89a");
    expect({ w: gif.w, h: gif.h }).toEqual({ w, h });
    expect(gif.paletteSize).toBeGreaterThan(0);
    expect(gif.frames).toBe(30);
    expect(gif.localPalettes).toBe(0);
    expect(gif.delays.reduce((a, b) => a + b, 0)).toBe(200); // 30 frames at 15 fps: two seconds
    expect(gif.trailer).toBe(true);
  });
});
