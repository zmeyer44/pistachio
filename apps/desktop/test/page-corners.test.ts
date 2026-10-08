import { describe, expect, it } from "vitest";
import { pageCorners, pageCornersScript } from "../src/main/page-corners";

describe("a desk page's top corners", () => {
  it("takes two CSS colours, in any colour function, and nothing else", () => {
    expect(pageCorners({ left: "rgb(255, 255, 255)", right: "oklch(0.3 0.02 250 / 0.9)" })).toEqual({ left: "rgb(255, 255, 255)", right: "oklch(0.3 0.02 250 / 0.9)" });
    expect(pageCorners({ left: "color(display-p3 1 0 0)", right: "rgba(0, 0, 0, 0.5)" })).not.toBeNull();
    expect(pageCorners({ left: "red; background: url(x)", right: "rgb(1, 2, 3)" })).toBeNull();
    expect(pageCorners({ left: "rgb(1, 2, 3)", right: "url(https://example.com/x.png)" })).toBeNull();
    expect(pageCorners({ left: "rgb(1, 2, 3)" })).toBeNull();
    expect(pageCorners(null)).toBeNull();
  });

  it("reads each corner as far in as the round reaches", () => {
    const script = pageCornersScript(10.4);
    expect(script).toContain("left: at(10)");
    expect(script).toContain("innerWidth - 1 - 10");
  });
});
