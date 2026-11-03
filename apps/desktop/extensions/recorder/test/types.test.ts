import { describe, expect, it } from "vitest";
import { ZOOM_DEFAULTS } from "../src/lib/zoom.js";

describe("the recorder's skeleton", () => {
  it("has its tuning", () => {
    expect(ZOOM_DEFAULTS.defZoom).toBe(2);
  });
});
