/**
 * The shell's mark (docs/live-share.md §6.6): which desk report a frame of the
 * shell's picture was painted under, painted into the picture itself.
 *
 * The live-host app cuts shell-drawn windows out of a capture of the shell's
 * page, and may cut a window only while nothing of the shell's lies over it.
 * The word of what lies where (the report) reaches it through main, a frame
 * of the capture straight from the GPU: a word late by any stall would let a
 * frame painted under a menu be cut by a report from before the menu. So the
 * shell paints each report's number (`LiveDeskReport.mark`) into its own
 * pixels in the same task as it sends the report — the same task that
 * noticed what covers what, before it is painted — and the live-host app
 * reads the number off every frame and cuts it only by that report's word:
 * a frame and its word can no longer race.
 *
 * Where: the window's top-left corner, which macOS rounds away (probed,
 * macOS 26: the window server draws nothing of the first ten points of the
 * top row, nor of the corner's quarter circle under it; the capture of the
 * page has every pixel). Ten cells of a CSS px each, in the part a corner
 * of radius 10 pt clips too. In full screen the corner is square, and the
 * cells are a speck there in greys near the theme's corner.
 *
 * What: each cell an opaque grey, one of eight levels a band apart — the
 * first cell the band's foot and the second its top, so a reader measures
 * the levels off the frame itself (probed, Electron 43, I420 at 1× and 2×:
 * every grey came through to the same luma in every frame, 0 → 16 … 255 →
 * 235, BT.709's limited range) — then the number's 16 bits and an 8-bit CRC
 * of them, three bits a cell. A reading that is not every pixel of every
 * cell squarely on a level, or whose CRC is wrong, is no mark at all.
 *
 * Fresh or stale: the shell paints a report's number as it sends it
 * (fresh: what it draws is where that report says), and paints it stale in
 * the task that first draws a window somewhere the report did not put it
 * before the next report goes (desk-report.ts's pacer) — so a frame of a
 * window on the move is never cut where it was. A stale mark's CRC is the
 * fresh one with every bit turned.
 *
 * Pure but for `ShellMarkPainter`, which the shell mounts; the live-host app
 * reads with `readMark`.
 */

import { LIVE_SHELL_MARKS } from "@pistachio/shell-contracts/live-share";

/** Each cell's place: CSS px from the window's top-left corner, a CSS px square. */
export const MARK_CELLS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 2, y: 0 },
  { x: 3, y: 0 },
  { x: 4, y: 0 },
  { x: 0, y: 1 },
  { x: 1, y: 1 },
  { x: 2, y: 1 },
  { x: 0, y: 2 },
  { x: 1, y: 2 },
];

/** The box the cells lie in, CSS px: nothing of a window is ever cut from it. */
export const MARK_BOX = { x: 0, y: 0, w: 5, h: 3 };

/** The painted mark's element (the shell keeps it in `<body>`, beside the app's root). */
export const MARK_ELEMENT_ID = "live-mark";

const LEVELS = 8;
/** Three bits a cell. */
const BITS = 3;
/** The band: LEVELS greys this far apart (sRGB), from a foot near the theme's corner. */
const LEVEL_STEP = 20;
const BAND_FOOT: Record<"light" | "dark", number> = { light: 100, dark: 20 };
/** The band's levels, read off a frame, are at least this far apart (luma): a flat patch is no mark. */
const MIN_STEP = 8;
/** A stale mark's CRC: the fresh one's, every bit turned. */
const STALE_CRC = 0xff;

/** A mark read off a frame: the report it was painted under, and whether the shell had drawn a window elsewhere since (stale). */
export interface MarkReading {
  mark: number;
  stale: boolean;
}

/** CRC-8 (polynomial 0x07) of the mark's two bytes. */
export function markCrc(mark: number): number {
  let crc = 0;
  for (const byte of [(mark >> 8) & 0xff, mark & 0xff]) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

/** Each cell's level (0 … 7) for `mark`, fresh or stale: the band's foot and top, then the mark and its CRC (turned, stale), three bits a cell, high first. */
export function encodeMark(mark: number, stale = false): number[] {
  if (!Number.isInteger(mark) || mark < 0 || mark >= LIVE_SHELL_MARKS) throw new RangeError(`no mark ${String(mark)}`);
  const word = (mark << 8) | (markCrc(mark) ^ (stale ? STALE_CRC : 0));
  const data = MARK_CELLS.length - 2;
  return [0, LEVELS - 1, ...Array.from({ length: data }, (_, index) => (word >> (BITS * (data - 1 - index))) & (LEVELS - 1))];
}

/**
 * The mark in a frame: `cells[i]` is the luma of every pixel of cell i. Null
 * unless the first two cells are the band's foot and top far enough apart,
 * every pixel of every cell lies squarely on one of the levels between (a
 * quarter of a level's step), each cell all one level, and the CRC holds —
 * as it is (fresh) or turned (stale).
 */
export function decodeMark(cells: ReadonlyArray<ReadonlyArray<number>>): MarkReading | null {
  if (cells.length !== MARK_CELLS.length || cells.some((pixels) => pixels.length === 0)) return null;
  const mean = (pixels: ReadonlyArray<number>): number => pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
  const foot = mean(cells[0]!);
  const step = (mean(cells[1]!) - foot) / (LEVELS - 1);
  if (!(step >= MIN_STEP)) return null;
  const levels: number[] = [];
  for (const pixels of cells) {
    let level: number | null = null;
    for (const value of pixels) {
      const at = Math.round((value - foot) / step);
      if (at < 0 || at >= LEVELS || Math.abs(value - (foot + at * step)) > step / 4) return null;
      if (level !== null && level !== at) return null;
      level = at;
    }
    levels.push(level!);
  }
  if (levels[0] !== 0 || levels[1] !== LEVELS - 1) return null;
  let word = 0;
  for (const level of levels.slice(2)) word = (word << BITS) | level;
  const mark = word >> 8;
  if (mark >= LIVE_SHELL_MARKS) return null;
  const crc = word & 0xff;
  if (crc === markCrc(mark)) return { mark, stale: false };
  return crc === (markCrc(mark) ^ STALE_CRC) ? { mark, stale: true } : null;
}

/**
 * The mark in a frame of the shell's picture whose content's top-left corner
 * lies at `origin` (frame px) at `scale` frame px a CSS px — a whole number:
 * the page is captured at its own device pixels — each cell the scale ×
 * scale block of pixels at its place, read through `luma(x, y)`. Null when
 * the scale or the origin is not whole.
 */
export function readMark(luma: (x: number, y: number) => number, origin: { x: number; y: number }, scale: number): MarkReading | null {
  const whole = Math.round(scale);
  if (whole < 1 || Math.abs(scale - whole) > 1e-6 || !Number.isInteger(origin.x) || !Number.isInteger(origin.y)) return null;
  const cells = MARK_CELLS.map((cell) => {
    const pixels: number[] = [];
    for (let y = 0; y < whole; y += 1) for (let x = 0; x < whole; x += 1) pixels.push(luma(origin.x + cell.x * whole + x, origin.y + cell.y * whole + y));
    return pixels;
  });
  return decodeMark(cells);
}

/** A mark's newness against another: the one that came after it, counting round the wrap (half the numbers either way). */
export function markAfter(mark: number, than: number): boolean {
  const ahead = (mark - than + LIVE_SHELL_MARKS) % LIVE_SHELL_MARKS;
  return ahead !== 0 && ahead < LIVE_SHELL_MARKS / 2;
}

/** The grey (sRGB) a cell of `level` is painted in, in the band for the scheme. */
export function markGrey(level: number, scheme: "light" | "dark"): number {
  return BAND_FOOT[scheme] + level * LEVEL_STEP;
}

/**
 * The mark as the shell paints it: an element of its own in `<body>`, over
 * everything (a portal's layer too), taking no pointer, its cells opaque.
 * `show` repaints it in the task it is called from: the frame that paints
 * what the report says (or the first that no longer shows every window
 * where it says, stale) is the frame that paints its number so.
 */
export class ShellMarkPainter {
  readonly #root: HTMLElement;
  readonly #cells: HTMLElement[];
  #painted: string | null = null;

  constructor(doc: Document) {
    const root = doc.createElement("div");
    root.id = MARK_ELEMENT_ID;
    root.setAttribute("aria-hidden", "true");
    root.style.cssText = `position:fixed;left:${String(MARK_BOX.x)}px;top:${String(MARK_BOX.y)}px;width:${String(MARK_BOX.w)}px;height:${String(MARK_BOX.h)}px;z-index:2147483647;pointer-events:none;contain:strict;`;
    this.#cells = MARK_CELLS.map((cell) => {
      const el = doc.createElement("div");
      el.style.cssText = `position:absolute;left:${String(cell.x - MARK_BOX.x)}px;top:${String(cell.y - MARK_BOX.y)}px;width:1px;height:1px;`;
      root.appendChild(el);
      return el;
    });
    doc.body.appendChild(root);
    this.#root = root;
  }

  show(mark: number, stale: boolean, scheme: "light" | "dark"): void {
    const levels = encodeMark(mark, stale);
    const key = `${scheme}:${levels.join("")}`;
    if (key === this.#painted) return;
    this.#painted = key;
    levels.forEach((level, index) => {
      const grey = String(markGrey(level, scheme));
      this.#cells[index]!.style.background = `rgb(${grey},${grey},${grey})`;
    });
  }

  remove(): void {
    this.#root.remove();
  }
}
