/** gifenc 1.0.3 (MIT) ships no types: the part the export uses. */
declare module "gifenc" {
  export type Palette = number[][];
  export type PaletteFormat = "rgb565" | "rgb444" | "rgba4444";

  export interface FrameOptions {
    palette?: Palette;
    /** Manual mode: the first frame writes the screen descriptor and the global palette. */
    first?: boolean;
    transparent?: boolean;
    transparentIndex?: number;
    /** Milliseconds; stored in centiseconds, rounded. */
    delay?: number;
    /** -1 once, 0 forever, n times. */
    repeat?: number;
    colorDepth?: number;
    dispose?: number;
  }

  export interface Encoder {
    writeHeader(): void;
    writeFrame(index: Uint8Array, width: number, height: number, options?: FrameOptions): void;
    finish(): void;
    /** A copy of the bytes written since the last reset. */
    bytes(): Uint8Array<ArrayBuffer>;
    bytesView(): Uint8Array;
    reset(): void;
  }

  export function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): Encoder;
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, options?: { format?: PaletteFormat; oneBitAlpha?: boolean | number; clearAlpha?: boolean; clearAlphaThreshold?: number; clearAlphaColor?: number }): Palette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: PaletteFormat): Uint8Array;
}
