import { describe, expect, it } from "vitest";
import { DEFAULT_FACE_DOCK, FACE_INSET, dockPlacement, nearestDock } from "../src/components/live-host/face-dock";

const STAGE = { x: 100, y: 50, w: 1000, h: 600 };

describe("the faces' dock", () => {
  it("starts at the top trailing corner, hanging inside it", () => {
    expect(DEFAULT_FACE_DOCK).toEqual({ edge: "right", t: 0 });
    expect(dockPlacement(STAGE, DEFAULT_FACE_DOCK)).toEqual({ x: 1100 - FACE_INSET, y: 50 + FACE_INSET, shiftX: -1, shiftY: -0, direction: "column" });
  });

  it("settles on the edge it was let go nearest, as far along it as it was", () => {
    expect(nearestDock(STAGE, 130, 350)).toEqual({ edge: "left", t: 0.5 });
    expect(nearestDock(STAGE, 600, 630)).toEqual({ edge: "bottom", t: 0.5 });
    expect(nearestDock(STAGE, 350, 60)).toEqual({ edge: "top", t: 0.25 });
    // Let go past the stage's corner, it comes back to the nearer edge, clamped to its end.
    expect(nearestDock(STAGE, 1300, -40)).toEqual({ edge: "top", t: 1 });
    expect(nearestDock(STAGE, 1150, -200)).toEqual({ edge: "right", t: 0 });
  });

  it("runs across on the top and bottom edges and keeps inside the stage at either end", () => {
    const bottomEnd = dockPlacement(STAGE, { edge: "bottom", t: 1 });
    expect(bottomEnd).toEqual({ x: 1100 - FACE_INSET, y: 650 - FACE_INSET, shiftX: -1, shiftY: -1, direction: "row" });
    const leftMiddle = dockPlacement(STAGE, { edge: "left", t: 0.5 });
    expect(leftMiddle).toEqual({ x: 100 + FACE_INSET, y: 350, shiftX: 0, shiftY: -0.5, direction: "column" });
  });
});
