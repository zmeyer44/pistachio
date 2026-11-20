/**
 * The Bar's pill out of the nub where it is drawn by a view of its own over
 * the pages (components/desk/nub-motion.ts, PillParts' `reach`; lib/desk/
 * prompt-view.ts): what its glass comes out of — a droplet, the nub — is
 * brought inside what that view can draw, since nothing of the glass is drawn
 * past the view's box.
 */

import { describe, expect, it } from "vitest";
import { within } from "../src/components/desk/nub-motion";
import { NUB_DROP_R, NUB_IDLE, nubDrops, nubFace } from "../src/lib/desk/geometry";

/** The pill where it rests, from the desk's trailing foot corner (480 wide, 52 tall, 54 from the edge and 8 above the foot). */
const HOME = { x: -534, y: -60, w: 480, h: 52 };
/** The room the prompt's view keeps round the pill (DeskBar's OVER_SIDE, OVER_ABOVE, OVER_BELOW). */
const REACH = { side: 16, above: 10, below: 16 };

const dropBox = (index: number) => {
  const at = nubDrops()[index]!;
  return { x: at.x - NUB_DROP_R, y: at.y - NUB_DROP_R, w: NUB_DROP_R * 2, h: NUB_DROP_R * 2 };
};

describe("what the pill's glass comes out of, in a view of its own", () => {
  it("is left where it is when the pill is the shell's own: no view to stay inside", () => {
    const face = nubFace(NUB_IDLE);
    const box = { x: face.x - 14, y: face.y - 14, w: 28, h: 28 };
    expect(within(box, HOME, undefined)).toBe(box);
  });

  it("the nub's own face is brought to the view's edge beside the nub, at the nub's height: the glass leaves the nub's side", () => {
    const face = nubFace(NUB_IDLE);
    const box = { x: face.x - 14, y: face.y - 14, w: 28, h: 28 };
    const inside = within(box, HOME, REACH);
    // Its size kept, its trailing edge a hair inside the view's (the pill's edge and the room beside it).
    expect(inside.w).toBe(28);
    expect(inside.h).toBe(28);
    expect(inside.x + inside.w).toBe(HOME.x + HOME.w + REACH.side - 2);
    // Beside the nub, not under it: left of where the nub's face lies, and as high as it.
    expect(inside.x + inside.w).toBeLessThan(box.x + box.w);
    expect(inside.y).toBe(box.y);
    // And wholly in the view.
    expect(inside.y).toBeGreaterThanOrEqual(HOME.y - REACH.above);
    expect(inside.y + inside.h).toBeLessThanOrEqual(HOME.y + HOME.h + REACH.below);
  });

  it("the prompt's droplet rests across the pill's end, inside the view: the glass starts exactly where the droplet is", () => {
    const box = dropBox(0);
    expect(within(box, HOME, REACH)).toEqual(box);
  });

  it("the microphone's droplet stands above the view: brought down into it, no further", () => {
    const box = dropBox(1);
    const inside = within(box, HOME, REACH);
    expect(box.y).toBeLessThan(HOME.y - REACH.above);
    expect(inside.y).toBe(HOME.y - REACH.above + 2);
    expect(inside.x).toBe(box.x);
    expect(inside.w).toBe(box.w);
    expect(inside.h).toBe(box.h);
  });

  it("a view too small for it keeps it at the view's leading edge rather than turning it inside out", () => {
    const inside = within({ x: 0, y: 0, w: 600, h: 200 }, HOME, REACH);
    expect(inside.x).toBe(HOME.x - REACH.side + 2);
    expect(inside.y).toBe(HOME.y - REACH.above + 2);
  });
});
