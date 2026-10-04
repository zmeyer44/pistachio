import { describe, expect, it } from "vitest";
import { CHROME_FEATURE_IDS, CHROME_FEATURES, CHROME_MANIFEST, featuresIn, SIDEBAR_REGIONS } from "../src/chrome/manifest";

describe("chrome manifest", () => {
  // Completeness is the type's (CHROME_MANIFEST is a Record over the id
  // union); this pins the rows derived from it, so a feature can neither
  // vanish nor double on the way to the sidebar.
  it("lists every feature exactly once, in declaration order", () => {
    const ids = CHROME_FEATURES.map((feature) => feature.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(CHROME_FEATURE_IDS);
    expect(ids).toEqual(Object.keys(CHROME_MANIFEST));
    for (const feature of CHROME_FEATURES) expect(CHROME_MANIFEST[feature.id]).toEqual({ region: feature.region, order: feature.order });
  });

  it("puts each region's features where the sidebar draws them", () => {
    expect(featuresIn("toolbar").map((feature) => feature.id)).toEqual(["navigation", "sidebarPin"]);
    expect(featuresIn("address").map((feature) => feature.id)).toEqual(["address"]);
    expect(featuresIn("favorites").map((feature) => feature.id)).toEqual(["favorites"]);
    expect(featuresIn("tabs").map((feature) => feature.id)).toEqual(["tabs"]);
    // A screen share's card sits at the foot of the dock, under the media
    // stack, so the stack's fan-out never covers it.
    expect(featuresIn("media").map((feature) => feature.id)).toEqual(["media", "screenShare"]);
    // The footer: the menu (the Space avatar) at its start, then the pills —
    // the sync pill (empty unless sync is stuck or a cloud run is on), the
    // downloads chip (empty until something is downloaded), then the update
    // pill (empty until a release is available).
    expect(featuresIn("footer").map((feature) => feature.id)).toEqual(["menu", "sync", "downloads", "update"]);
  });

  it("only references regions the sidebar has", () => {
    for (const feature of CHROME_FEATURES) expect(SIDEBAR_REGIONS).toContain(feature.region);
  });

  it("lists a region's features in order, each order unique within the region", () => {
    for (const region of SIDEBAR_REGIONS) {
      const orders = featuresIn(region).map((feature) => feature.order);
      expect(orders.every(Number.isInteger)).toBe(true);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
      expect(new Set(orders).size).toBe(orders.length);
    }
  });

  it("covers every feature with some region", () => {
    const rendered = SIDEBAR_REGIONS.flatMap((region) => featuresIn(region)).map((feature) => feature.id);
    expect(rendered.sort()).toEqual([...CHROME_FEATURE_IDS].sort());
  });
});
