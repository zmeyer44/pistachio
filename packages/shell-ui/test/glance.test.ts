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
});
