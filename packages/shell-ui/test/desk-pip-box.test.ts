import { describe, expect, it } from "vitest";
import { DESK_PIP_OUTSET } from "@pistachio/shell-contracts/desk";
import { PIP_EDGE_CURSORS, PIP_H, PIP_MIN_W, PIP_W, clampPipBox, pipHeight, pipWidth, resizedPipBox } from "../src/lib/desk/pip-box";

const WINDOW = { width: 1440, height: 900 };
const START = { x: 400, y: 300, width: PIP_W, height: PIP_H };

describe("the floating player's box", () => {
  it("grows from a corner with its shape kept, the opposite corner holding still", () => {
    expect(resizedPipBox(START, "se", 160, 40, WINDOW)).toEqual({ x: 400, y: 300, width: 480, height: 270 });
    // The corner goes by the way the pointer has moved more.
    expect(resizedPipBox(START, "se", 16, 90, WINDOW)).toEqual({ x: 400, y: 300, width: 480, height: 270 });
    expect(resizedPipBox(START, "nw", -160, 0, WINDOW)).toEqual({ x: 240, y: 210, width: 480, height: 270 });
    expect(resizedPipBox(START, "ne", 160, 0, WINDOW)).toEqual({ x: 400, y: 210, width: 480, height: 270 });
    expect(resizedPipBox(START, "sw", -160, 0, WINDOW)).toEqual({ x: 240, y: 300, width: 480, height: 270 });
  });

  it("resizes from an edge, the opposite edge and the top or left holding still", () => {
    expect(resizedPipBox(START, "e", 160, 999, WINDOW)).toEqual({ x: 400, y: 300, width: 480, height: 270 });
    expect(resizedPipBox(START, "w", -160, 0, WINDOW)).toEqual({ x: 240, y: 300, width: 480, height: 270 });
    expect(resizedPipBox(START, "s", 999, 90, WINDOW)).toEqual({ x: 400, y: 300, width: 480, height: 270 });
    expect(resizedPipBox(START, "n", 0, -90, WINDOW)).toEqual({ x: 400, y: 210, width: 480, height: 270 });
  });

  it("stops at its smallest, where its controls still fit", () => {
    const shrunk = resizedPipBox(START, "w", 300, 0, WINDOW);
    expect(shrunk).toEqual({ x: START.x + START.width - PIP_MIN_W, y: 300, width: PIP_MIN_W, height: pipHeight(PIP_MIN_W) });
  });

  it("stops where the window ends, its edges' ring with it", () => {
    const grown = resizedPipBox(START, "se", 5000, 5000, WINDOW);
    expect(grown.y + grown.height).toBeLessThanOrEqual(WINDOW.height - DESK_PIP_OUTSET);
    expect(grown.x + grown.width).toBeLessThanOrEqual(WINDOW.width - DESK_PIP_OUTSET);
    expect(grown.height).toBe(pipHeight(grown.width));
    const left = resizedPipBox(START, "nw", -5000, -5000, WINDOW);
    expect(left.y).toBeGreaterThanOrEqual(DESK_PIP_OUTSET);
    expect(left.x + left.width).toBe(START.x + START.width);
  });

  it("keeps a width the window has room for, and the player whole in it", () => {
    expect(pipWidth(PIP_W, WINDOW)).toBe(PIP_W);
    expect(pipWidth(100, WINDOW)).toBe(PIP_MIN_W);
    expect(pipWidth(5000, WINDOW)).toBe(WINDOW.width - DESK_PIP_OUTSET * 2);
    expect(pipWidth(5000, { width: 3000, height: 600 })).toBe(Math.round(((600 - DESK_PIP_OUTSET * 2) * PIP_W) / PIP_H));
    // A window smaller than its smallest: as large as fits.
    expect(pipWidth(PIP_W, { width: 200, height: 900 })).toBe(200 - DESK_PIP_OUTSET * 2);
    expect(clampPipBox({ x: -40, y: 2000, width: PIP_W, height: PIP_H }, WINDOW)).toEqual({ x: DESK_PIP_OUTSET, y: WINDOW.height - DESK_PIP_OUTSET - PIP_H, width: PIP_W, height: PIP_H });
  });

  it("has the drag layer's resize cursors for its edges", () => {
    expect(PIP_EDGE_CURSORS.se).toBe("nwse-resize");
    expect(PIP_EDGE_CURSORS.ne).toBe("nesw-resize");
    expect(PIP_EDGE_CURSORS.w).toBe("ew-resize");
    expect(PIP_EDGE_CURSORS.n).toBe("ns-resize");
  });
});
