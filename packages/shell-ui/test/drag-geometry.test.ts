import { describe, expect, it } from "vitest";
import { splitZoneAt } from "../src/chrome/drag-geometry";
import type { ContentBounds } from "@pistachio/shell-contracts/ipc";

/** The page's box in a pinned-sidebar window: sidebar to its left and console to its right. */
const page: ContentBounds = { x: 240, y: 40, width: 660, height: 800 };

describe("splitZoneAt", () => {
  it("names all four nearest-edge zones once the pointer is armed inside the box", () => {
    expect(splitZoneAt(page, { clientX: page.x + 30, clientY: 300 })).toBe("left");
    expect(splitZoneAt(page, { clientX: page.x + page.width - 30, clientY: 300 })).toBe("right");
    expect(splitZoneAt(page, { clientX: page.x + 300, clientY: page.y + 30 })).toBe("top");
    expect(splitZoneAt(page, { clientX: page.x + 300, clientY: page.y + page.height - 30 })).toBe("bottom");
  });

  it("is null short of the arming distance and above or below the box", () => {
    expect(splitZoneAt(page, { clientX: page.x + 10, clientY: 300 })).toBeNull();
    expect(splitZoneAt(page, { clientX: page.x + 300, clientY: page.y - 1 })).toBeNull();
    expect(splitZoneAt(page, { clientX: page.x + 300, clientY: page.y + page.height + 1 })).toBeNull();
  });

  it("is null past the box's far edge — over the console beside the page", () => {
    // A lone row dragged across the page and onto the console is not over a
    // drop target; the pinned layout puts several hundred px of console there.
    expect(splitZoneAt(page, { clientX: page.x + page.width + 50, clientY: 300 })).toBeNull();
    expect(splitZoneAt(page, { clientX: page.x + page.width, clientY: 300 })).toBe("right");
  });
});
