import { describe, expect, it } from "vitest";
import {
  pointerHitsSidebarTrigger,
  pointerHoldsSidebar,
  SIDEBAR_POINTER_SLACK,
  SIDEBAR_POINTER_SLACK_X,
  SIDEBAR_TRIGGER_W,
} from "../src/chrome.js";

// The compact sidebar's column, flush with the window's left edge.
const box = { x: 0, y: 0, width: 248, height: 880 };

describe("pointerHitsSidebarTrigger", () => {
  it("uses the wider interaction target without including the page beyond it", () => {
    expect(pointerHitsSidebarTrigger({ x: SIDEBAR_TRIGGER_W - 1, y: 400 }, box.height)).toBe(true);
    expect(pointerHitsSidebarTrigger({ x: SIDEBAR_TRIGGER_W, y: 400 }, box.height)).toBe(false);
    expect(pointerHitsSidebarTrigger({ x: 5, y: box.height }, box.height)).toBe(false);
  });
});

describe("pointerHoldsSidebar", () => {
  it("holds while the pointer is on the column, with a little slack past its far edge", () => {
    expect(pointerHoldsSidebar({ x: 10, y: 400 }, box)).toBe(true);
    expect(pointerHoldsSidebar({ x: 247, y: 400 }, box)).toBe(true);
    expect(pointerHoldsSidebar({ x: 248 + SIDEBAR_POINTER_SLACK - 1, y: 400 }, box)).toBe(true);
    expect(pointerHoldsSidebar({ x: 248 + SIDEBAR_POINTER_SLACK, y: 400 }, box)).toBe(false);
  });

  it("holds over the traffic lights, which sit on the column", () => {
    expect(pointerHoldsSidebar({ x: 30, y: 20 }, box)).toBe(true);
  });

  it("keeps a pointer that left the window through the column's own edge, up to the outside offset", () => {
    expect(pointerHoldsSidebar({ x: -1, y: 400 }, box)).toBe(true);
    expect(pointerHoldsSidebar({ x: -SIDEBAR_POINTER_SLACK_X, y: 400 }, box)).toBe(true);
    expect(pointerHoldsSidebar({ x: -SIDEBAR_POINTER_SLACK_X - 1, y: 400 }, box)).toBe(false);
  });

  it("loses a pointer that left the column's vertical span, inside the window or out", () => {
    expect(pointerHoldsSidebar({ x: 10, y: -SIDEBAR_POINTER_SLACK - 1 }, box)).toBe(false);
    expect(pointerHoldsSidebar({ x: 10, y: 880 + SIDEBAR_POINTER_SLACK }, box)).toBe(false);
    expect(pointerHoldsSidebar({ x: -50, y: 900 }, box)).toBe(false);
  });

  it("loses a pointer on the page", () => {
    expect(pointerHoldsSidebar({ x: 600, y: 400 }, box)).toBe(false);
  });
});
