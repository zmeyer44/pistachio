import { describe, expect, it } from "vitest";
import {
  PANE_TOOLBAR_H,
  PANE_TOOLBAR_POINTER_SLACK_Y,
  PANE_TOOLBAR_TRIGGER_H,
  pointerHitsPaneToolbarTrigger,
  pointerHoldsPaneToolbar,
  SIDEBAR_POINTER_SLACK,
  SURFACE_GUTTER,
  TRAFFIC_LIGHTS_H,
} from "@pistachio/shell-contracts/chrome";
import { toolbarClusters } from "../src/lib/pane-toolbar";

// The page surface beside a 248px sidebar, in a 1200px-wide window.
const trigger = { x: 248, y: 0, width: 952, height: PANE_TOOLBAR_TRIGGER_H };
const row = { x: 248, y: 0, width: 952, height: PANE_TOOLBAR_H };

describe("pane toolbar geometry", () => {
  it("shares the sidebar toolbar's row, so its buttons sit on the traffic lights' line", () => {
    expect(PANE_TOOLBAR_H).toBe(TRAFFIC_LIGHTS_H);
    expect(PANE_TOOLBAR_TRIGGER_H).toBeGreaterThanOrEqual(SURFACE_GUTTER);
  });
});

describe("pointerHitsPaneToolbarTrigger", () => {
  it("is the gap above the card, over the surface's width only", () => {
    expect(pointerHitsPaneToolbarTrigger({ x: 600, y: 0 }, trigger)).toBe(true);
    expect(pointerHitsPaneToolbarTrigger({ x: 600, y: PANE_TOOLBAR_TRIGGER_H - 1 }, trigger)).toBe(true);
    expect(pointerHitsPaneToolbarTrigger({ x: 600, y: PANE_TOOLBAR_TRIGGER_H }, trigger)).toBe(false);
    // The sidebar's toolbar is the sidebar's.
    expect(pointerHitsPaneToolbarTrigger({ x: 100, y: 4 }, trigger)).toBe(false);
    expect(pointerHitsPaneToolbarTrigger({ x: 1200, y: 4 }, trigger)).toBe(false);
  });
});

describe("pointerHoldsPaneToolbar", () => {
  it("holds on the row, with a little slack below it", () => {
    expect(pointerHoldsPaneToolbar({ x: 600, y: 20 }, row)).toBe(true);
    expect(pointerHoldsPaneToolbar({ x: 600, y: PANE_TOOLBAR_H + SIDEBAR_POINTER_SLACK - 1 }, row)).toBe(true);
    expect(pointerHoldsPaneToolbar({ x: 600, y: PANE_TOOLBAR_H + SIDEBAR_POINTER_SLACK }, row)).toBe(false);
  });

  it("keeps a pointer that overshot the window's top edge into the menu bar", () => {
    expect(pointerHoldsPaneToolbar({ x: 600, y: -1 }, row)).toBe(true);
    expect(pointerHoldsPaneToolbar({ x: 600, y: -PANE_TOOLBAR_POINTER_SLACK_Y }, row)).toBe(true);
    expect(pointerHoldsPaneToolbar({ x: 600, y: -PANE_TOOLBAR_POINTER_SLACK_Y - 1 }, row)).toBe(false);
  });

  it("loses a pointer that left the row's horizontal span, sidebar side or console side", () => {
    expect(pointerHoldsPaneToolbar({ x: 248 - SIDEBAR_POINTER_SLACK - 1, y: 20 }, row)).toBe(false);
    expect(pointerHoldsPaneToolbar({ x: 1200 + SIDEBAR_POINTER_SLACK, y: 20 }, row)).toBe(false);
  });
});

describe("toolbarClusters", () => {
  it("gives a lone pane the whole row", () => {
    expect(toolbarClusters([{ tabId: "a", left: 0, right: 900 }])).toEqual([{ tabId: "a", left: 0, width: 900 }]);
  });

  it("puts a side-by-side split's clusters over their own panes, at the panes' own widths", () => {
    expect(toolbarClusters([
      { tabId: "a", left: 0, right: 600 },
      { tabId: "b", left: 608, right: 900 },
    ])).toEqual([
      { tabId: "a", left: 0, width: 600 },
      { tabId: "b", left: 608, width: 292 },
    ]);
  });

  it("shares a column between stacked panes, in pane order", () => {
    expect(toolbarClusters([
      { tabId: "a", left: 0, right: 900 },
      { tabId: "b", left: 0, right: 900 },
    ])).toEqual([
      { tabId: "a", left: 0, width: 450 },
      { tabId: "b", left: 450, width: 450 },
    ]);
  });

  it("keeps the 2×2 grid's columns apart and pairs each column's panes", () => {
    expect(toolbarClusters([
      { tabId: "a", left: 0, right: 400 },
      { tabId: "b", left: 0, right: 400 },
      { tabId: "c", left: 408, right: 900 },
      { tabId: "d", left: 408, right: 900 },
    ])).toEqual([
      { tabId: "a", left: 0, width: 200 },
      { tabId: "b", left: 200, width: 200 },
      { tabId: "c", left: 408, width: 246 },
      { tabId: "d", left: 654, width: 246 },
    ]);
  });

  it("lets a pane spanning both columns pull the mosaic into one shared run", () => {
    expect(toolbarClusters([
      { tabId: "a", left: 0, right: 400 },
      { tabId: "b", left: 408, right: 900 },
      { tabId: "c", left: 0, right: 900 },
    ])).toEqual([
      { tabId: "a", left: 0, width: 300 },
      { tabId: "b", left: 300, width: 300 },
      { tabId: "c", left: 600, width: 300 },
    ]);
  });
});
