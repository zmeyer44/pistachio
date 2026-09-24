import { describe, expect, it } from "vitest";
import { splitZoneAt } from "../src/chrome/drag-geometry";
import type { ContentBounds } from "@pistachio/shell-contracts/ipc";

/** The page's box in a pinned-sidebar window: sidebar to its left and console to its right. */
const page: ContentBounds = { x: 240, y: 40, width: 660, height: 800 };

describe("splitZoneAt", () => {
  it("names all four nearest-edge zones once the pointer is armed inside the box", () => {
    expect(splitZoneAt("y", page, { clientX: page.x + 30, clientY: 300 })).toBe("left");
    expect(splitZoneAt("y", page, { clientX: page.x + page.width - 30, clientY: 300 })).toBe("right");
    expect(splitZoneAt("y", page, { clientX: page.x + 300, clientY: page.y + 30 })).toBe("top");
    expect(splitZoneAt("y", page, { clientX: page.x + 300, clientY: page.y + page.height - 30 })).toBe("bottom");
  });

  it("is null short of the arming distance and off the box along the row", () => {
    expect(splitZoneAt("y", page, { clientX: page.x + 10, clientY: 300 })).toBeNull();
    expect(splitZoneAt("y", page, { clientX: page.x + 300, clientY: page.y - 1 })).toBeNull();
    expect(splitZoneAt("y", page, { clientX: page.x + 300, clientY: page.y + page.height + 1 })).toBeNull();
  });

  it("is null past the box's far edge — over the console beside the page", () => {
    // A lone row dragged across the page and onto the console is not over a
    // drop target; the pinned layout puts several hundred px of console there.
    expect(splitZoneAt("y", page, { clientX: page.x + page.width + 50, clientY: 300 })).toBeNull();
    expect(splitZoneAt("y", page, { clientX: page.x + page.width, clientY: 300 })).toBe("right");
  });

  it("reads the strip's geometry the same way (axis x): below the page is the footer, not a zone", () => {
    expect(splitZoneAt("x", page, { clientX: page.x + 300, clientY: page.y + 30 })).toBe("top");
    expect(splitZoneAt("x", page, { clientX: 300, clientY: page.y + page.height + 10 })).toBeNull();
  });
});
