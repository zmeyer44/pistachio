import { describe, expect, it } from "vitest";
import { glanceFrame } from "../src/lib/glance";

describe("Glance frame", () => {
  it("centers an 80% preview inside the browser surface gutter", () => {
    const surface = { left: 220, top: 40, width: 1000, height: 700 } as DOMRect;
    const frame = glanceFrame(surface, { x: 450, y: 210, width: 120, height: 24 });

    expect(frame.local).toEqual({ x: 107, y: 8, width: 787, height: 684 });
    expect(frame.window).toEqual({ x: 327, y: 48, width: 787, height: 684 });
    expect(frame.sourceLocal).toEqual({ x: 230, y: 170, width: 120, height: 24 });
  });

  it("keeps clear of the room kept at the trailing side (the chat in its place): centered in what is left", () => {
    const surface = { left: 220, top: 40, width: 1000, height: 700 } as DOMRect;
    const frame = glanceFrame(surface, { x: 450, y: 210, width: 120, height: 24 }, 492);
    // The inner width is 1000 − 16 − 492 = 492: narrower than the 720 at which 80% leaves the actions their 72px, so
    // the card is 492 − 144 = 348 wide, centered in it; its right edge, and the actions' 12 + 36 + 12 beside it, are
    // short of the column that starts at 1000 − 492 = 508.
    expect(frame.local).toEqual({ x: 80, y: 8, width: 348, height: 684 });
    expect(frame.local.x + frame.local.width + 12 + 36 + 12).toBeLessThanOrEqual(508);
    expect(frame.window.x).toBe(300);
    // (Nothing kept: as before.)
    expect(glanceFrame(surface, { x: 450, y: 210, width: 120, height: 24 }, 0).local).toEqual({ x: 107, y: 8, width: 787, height: 684 });
  });
});
