/**
 * The shell's mark (docs/live-share.md §6.6, src/lib/live/marker.ts): the
 * number of the desk report a frame of the shell's picture was painted
 * under, fresh or stale, painted in its corner and read back off a frame.
 * Every number comes back from its cells as a capture converts them
 * (BT.709's limited range, as probed), at 1× and 2×, in either scheme's
 * band, fresh as fresh and stale as stale; nothing else reads as a mark — a
 * flat patch, a pixel off its level, a cell of two levels, a broken CRC, a
 * scale or corner that is not whole; the cells lie where a corner of radius
 * 10 pt is rounded away; numbers wrap.
 */

import { describe, expect, it } from "vitest";
import { LIVE_SHELL_MARKS } from "@pistachio/shell-contracts/live-share";
import { decodeMark, encodeMark, MARK_BOX, MARK_CELLS, markAfter, markCrc, markGrey, readMark, ShellMarkPainter } from "../src/lib/live/marker";

/** The luma a capture gives an sRGB grey (BT.709, limited range: 0 → 16, 255 → 235 — probed, Electron 43). */
const lumaOf = (grey: number): number => Math.round(16 + (219 * grey) / 255);

/** A frame whose corner holds `mark`'s cells (stale or not) at `scale` px a CSS px, the rest of it `ground`; read as luma(x, y). */
function frameWith(mark: number, scheme: "light" | "dark", scale: number, ground = 120, stale = false): (x: number, y: number) => number {
  const levels = encodeMark(mark, stale);
  return (x, y) => {
    const index = MARK_CELLS.findIndex((cell) => Math.floor(x / scale) === cell.x && Math.floor(y / scale) === cell.y);
    return index < 0 ? ground : lumaOf(markGrey(levels[index]!, scheme));
  };
}

describe("the mark", () => {
  it("comes back off a frame as the number painted, fresh or stale, at 1× and 2×, in either scheme", () => {
    for (const mark of [0, 1, 2, 255, 256, 4_097, 32_767, 32_768, 65_535])
      for (const scheme of ["light", "dark"] as const)
        for (const scale of [1, 2])
          for (const stale of [false, true]) expect(readMark(frameWith(mark, scheme, scale, 120, stale), { x: 0, y: 0 }, scale)).toEqual({ mark, stale });
  });

  it("is read where the page's corner lies in the frame", () => {
    const at = frameWith(12_345, "light", 2);
    expect(readMark((x, y) => at(x - 4, y - 6), { x: 4, y: 6 }, 2)).toEqual({ mark: 12_345, stale: false });
  });

  it("says stale with its CRC turned: every bit of it, so no reading is both", () => {
    for (const mark of [0, 7, 0x1234, 65_535]) {
      const fresh = encodeMark(mark).slice(2).reduce((value, level) => (value << 3) | level, 0);
      const stale = encodeMark(mark, true).slice(2).reduce((value, level) => (value << 3) | level, 0);
      expect(fresh >> 8).toBe(mark);
      expect(stale >> 8).toBe(mark);
      expect((fresh ^ stale) & 0xff).toBe(0xff);
    }
  });

  it("is the band's foot and top, then the number and its CRC, three bits a cell", () => {
    const levels = encodeMark(0x1234);
    expect(levels).toHaveLength(MARK_CELLS.length);
    expect(levels.slice(0, 2)).toEqual([0, 7]);
    const word = levels.slice(2).reduce((value, level) => (value << 3) | level, 0);
    expect(word).toBe((0x1234 << 8) | markCrc(0x1234));
    expect(() => encodeMark(LIVE_SHELL_MARKS)).toThrow(RangeError);
    expect(() => encodeMark(-1)).toThrow(RangeError);
  });

  it("is nothing on a page with no mark: a flat corner, or one of anything else", () => {
    expect(readMark(() => 207, { x: 0, y: 0 }, 1)).toBeNull();
    // (A pattern of text-like extremes: the band's top and foot, then whatever.)
    expect(readMark((x, y) => ((x * 7 + y * 13) % 5 === 0 ? 16 : 235), { x: 0, y: 0 }, 1)).toBeNull();
  });

  it("is nothing when a pixel lies off its level, a cell is of two levels, or the CRC is broken", () => {
    const cells = (mark: number, scale = 2): number[][] => {
      const levels = encodeMark(mark);
      return levels.map((level) => new Array<number>(scale * scale).fill(lumaOf(markGrey(level, "light"))));
    };
    expect(decodeMark(cells(777))).toEqual({ mark: 777, stale: false });
    const off = cells(777);
    off[4]![0] = off[4]![0]! + 6;
    expect(decodeMark(off)).toBeNull();
    const mixed = cells(777);
    mixed[5]![3] = mixed[5]![3]! + 17;
    expect(decodeMark(mixed)).toBeNull();
    // A cell of the CRC's one level up: the number no longer checks.
    const broken = cells(777);
    const last = broken.at(-1)!;
    const step = (broken[1]![0]! - broken[0]![0]!) / 7;
    const up = last[0]! + step <= broken[1]![0]! + 0.5 ? step : -step;
    broken[broken.length - 1] = last.map((value) => value + up);
    expect(decodeMark(broken)).toBeNull();
    expect(decodeMark(cells(777).slice(1))).toBeNull();
  });

  it("is not read off a frame scaled from the page, nor from a corner between pixels", () => {
    const at = frameWith(4_242, "dark", 2);
    expect(readMark(at, { x: 0, y: 0 }, 1.6)).toBeNull();
    expect(readMark(at, { x: 0.5, y: 0 }, 2)).toBeNull();
  });

  it("lies where a window's corner of radius 10 pt is rounded away, and in its box", () => {
    const radius = 10;
    for (const cell of MARK_CELLS) {
      // The cell's corner nearest the window's inside is still outside the quarter circle.
      const inner = { x: cell.x + 1, y: cell.y + 1 };
      expect((radius - inner.x) ** 2 + (radius - inner.y) ** 2).toBeGreaterThan(radius ** 2);
      expect(cell.x >= MARK_BOX.x && cell.y >= MARK_BOX.y && cell.x + 1 <= MARK_BOX.x + MARK_BOX.w && cell.y + 1 <= MARK_BOX.y + MARK_BOX.h).toBe(true);
    }
  });

  it("counts on round the wrap: a number is after the half of them behind it", () => {
    expect(markAfter(5, 4)).toBe(true);
    expect(markAfter(4, 5)).toBe(false);
    expect(markAfter(5, 5)).toBe(false);
    expect(markAfter(0, LIVE_SHELL_MARKS - 1)).toBe(true);
    expect(markAfter(LIVE_SHELL_MARKS - 1, 0)).toBe(false);
  });
});

describe("the mark as the shell paints it", () => {
  /** A document of just enough DOM: elements keep their style and children. */
  function fakeDocument() {
    type El = { id: string; style: Record<string, string> & { cssText: string }; children: El[]; appendChild(child: El): void; setAttribute(): void; remove(): void; removed: boolean };
    const make = (): El => {
      const el: El = {
        id: "",
        style: { cssText: "" },
        children: [],
        removed: false,
        appendChild: (child) => void el.children.push(child),
        setAttribute: () => undefined,
        remove: () => void (el.removed = true),
      };
      return el;
    };
    const body = make();
    return { doc: { createElement: make, body } as unknown as Document, body: body as unknown as { children: El[] } };
  }

  it("is an element of its own in <body>, its cells painted in the grey of each level, read back as the number, fresh or stale", () => {
    const { doc, body } = fakeDocument();
    const painter = new ShellMarkPainter(doc);
    const root = body.children[0]!;
    expect(root.id).toBe("live-mark");
    expect(root.style.cssText).toContain("position:fixed");
    expect(root.style.cssText).toContain("pointer-events:none");
    const read = (): ReturnType<typeof decodeMark> => decodeMark(root.children.map((cell) => [lumaOf(Number(/rgb\((\d+),/u.exec(cell.style["background"]!)![1]))]));
    painter.show(31_337, false, "dark");
    expect(read()).toEqual({ mark: 31_337, stale: false });
    painter.show(31_337, true, "dark");
    expect(read()).toEqual({ mark: 31_337, stale: true });
    painter.remove();
    expect((root as unknown as { removed: boolean }).removed).toBe(true);
  });
});
