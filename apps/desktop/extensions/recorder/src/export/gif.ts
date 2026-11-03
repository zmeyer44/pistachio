/**
 * GIF export (docs/recorder.md §2, §5) with gifenc 1.0.3: one global palette
 * quantized from twelve frames spread over the clip (text-heavy UI reads
 * cleaner with one palette and no dither, measured 3.2 ms a frame at 960×540),
 * every frame mapped to it, written in order and sent in 4 MiB chunks.
 */
import { GIFEncoder, applyPalette, quantize, type Encoder, type Palette } from "gifenc";
import type { Size } from "../lib/types.js";
import { CHUNK_BYTES, type ChunkWindow } from "./writer.js";

export const PALETTE_FRAMES = 12;
/** Every `PALETTE_STRIDE`-th pixel of the sample frames feeds the quantizer: the histogram barely changes, the pass runs 4× faster. */
export const PALETTE_STRIDE = 4;

/** The output frames the palette is sampled from: twelve spread evenly, centred in their twelfths. */
export function paletteFrameIndices(count: number, samples = PALETTE_FRAMES): number[] {
  const picked = new Set<number>();
  for (let k = 0; k < samples; k++) picked.add(Math.min(count - 1, Math.floor(((k + 0.5) * count) / samples)));
  return [...picked].sort((a, b) => a - b);
}

/** One palette (≤ 256 colours, rgb565 histogram) from the sample frames' RGBA. */
export function buildPalette(frames: (Uint8Array | Uint8ClampedArray)[], stride = PALETTE_STRIDE): Palette {
  let pixels = 0;
  for (const frame of frames) pixels += Math.ceil(frame.length / 4 / stride);
  const rgba = new Uint8Array(pixels * 4);
  let o = 0;
  for (const frame of frames) {
    for (let p = 0; p < frame.length; p += 4 * stride) {
      rgba[o++] = frame[p] as number;
      rgba[o++] = frame[p + 1] as number;
      rgba[o++] = frame[p + 2] as number;
      rgba[o++] = 255;
    }
  }
  return quantize(rgba, 256, { format: "rgb565" });
}

/**
 * Frame delays in milliseconds whose centiseconds (what GIF stores) add up to
 * the clip's true length: 15 fps alternates 70 and 60 ms instead of drifting
 * to 14.3 fps with a constant 70.
 */
export function gifDelay(index: number, fps: number): number {
  return (Math.round(((index + 1) * 100) / fps) - Math.round((index * 100) / fps)) * 10;
}

/** Writes frames in order, sending the bytes as they pass a chunk's size. */
export class GifWriter {
  readonly #gif: Encoder;
  #frames = 0;
  readonly window: ChunkWindow;
  readonly size: Size;
  readonly fps: number;
  readonly palette: Palette;

  constructor(window: ChunkWindow, size: Size, fps: number, palette: Palette) {
    this.window = window;
    this.size = size;
    this.fps = fps;
    this.palette = palette;
    this.#gif = GIFEncoder({ auto: false, initialCapacity: CHUNK_BYTES + (1 << 20) });
    this.#gif.writeHeader();
  }

  get frames(): number {
    return this.#frames;
  }

  /** One frame of RGBA at the GIF's size. */
  async frame(rgba: Uint8Array | Uint8ClampedArray): Promise<void> {
    const index = applyPalette(rgba, this.palette, "rgb565");
    const first = this.#frames === 0;
    this.#gif.writeFrame(index, this.size.w, this.size.h, first ? { first: true, palette: this.palette, repeat: 0, delay: gifDelay(0, this.fps) } : { delay: gifDelay(this.#frames, this.fps) });
    this.#frames++;
    if (this.#gif.bytesView().length >= CHUNK_BYTES) await this.#send();
  }

  async end(): Promise<void> {
    this.#gif.finish();
    await this.#send();
  }

  async #send(): Promise<void> {
    const bytes = this.#gif.bytes();
    this.#gif.reset();
    if (bytes.length > 0) await this.window.push(bytes.buffer);
  }
}
