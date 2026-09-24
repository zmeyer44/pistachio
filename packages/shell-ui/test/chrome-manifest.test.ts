import { describe, expect, it } from "vitest";
import {
  CHROME_FEATURE_IDS,
  CHROME_FEATURES,
  CHROME_MANIFEST,
  featuresIn,
  isPlaced,
  placementOf,
  SIDEBAR_MENU_FOLD,
  SIDEBAR_REGIONS,
  TOP_REGIONS,
} from "../src/chrome/manifest";

const LAYOUTS = ["top", "sidebar"] as const;

describe("chrome manifest", () => {
  // Completeness is the type's (CHROME_MANIFEST is a Record over the id
  // union); this pins the rows derived from it, so a feature can neither
  // vanish nor double on the way to the layouts.
  it("lists every feature exactly once, in declaration order", () => {
    const ids = CHROME_FEATURES.map((feature) => feature.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(CHROME_FEATURE_IDS);
    expect(ids).toEqual(Object.keys(CHROME_MANIFEST));
    for (const feature of CHROME_FEATURES) expect(CHROME_MANIFEST[feature.id]).toMatchObject({ top: feature.top, sidebar: feature.sidebar });
  });

  it("places every feature in both layouts, or hides it with a real reason", () => {
    for (const feature of CHROME_FEATURES) {
      for (const layout of LAYOUTS) {
        const placement = placementOf(feature, layout);
        if (isPlaced(placement)) {
          expect(Number.isInteger(placement.order)).toBe(true);
          continue;
        }
        expect(placement.hidden.trim().length, `${feature.id} hidden in ${layout} needs a reason`).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it("puts the tabs in both layouts — the one feature no layout may hide", () => {
    const tabs = CHROME_FEATURES.find((feature) => feature.id === "tabs");
    expect(tabs).toBeDefined();
    expect(isPlaced(tabs!.top)).toBe(true);
    expect(isPlaced(tabs!.sidebar)).toBe(true);
  });

  it("puts settings at the end of the top strip, and the strip's buttons in the sidebar footer's menu", () => {
    expect(featuresIn("top", "trailing").map((feature) => feature.id)).toEqual([
      "policy",
      "split",
      "console",
      "reminders",
      "bookmarks",
      "watchtower",
      "downloads",
      "spaces",
      "sync",
      "update",
      "settings",
    ]);
    expect(featuresIn("sidebar", "address").map((feature) => feature.id)).toEqual(["address"]);
    // Site info rides with the active page's own controls in both layouts.
    expect(isPlaced(CHROME_MANIFEST.siteInfo.top)).toBe(false);
    expect(isPlaced(CHROME_MANIFEST.siteInfo.sidebar)).toBe(false);
    // The footer: the menu (the Space avatar) at its start, then the pills —
    // the sync pill (empty unless sync is stuck or a cloud run is on), the
    // downloads chip (empty until something is downloaded), then the update
    // pill (empty until a release is available).
    expect(featuresIn("sidebar", "footer").map((feature) => feature.id)).toEqual(["menu", "sync", "downloads", "update"]);
    expect(isPlaced(CHROME_MANIFEST.spaces.sidebar)).toBe(false);
    // The trailing buttons the menu lists are folded into it, and say so.
    for (const id of ["console", "reminders", "bookmarks", "settings"] as const) {
      expect(CHROME_MANIFEST[id].sidebar).toEqual({ hidden: SIDEBAR_MENU_FOLD });
    }
    // The rest are left out of the sidebar, with their own reasons.
    for (const id of ["policy", "split", "watchtower"] as const) {
      expect(isPlaced(CHROME_MANIFEST[id].sidebar)).toBe(false);
    }
    expect(SIDEBAR_MENU_FOLD).toContain("SidebarMenu");
    expect(isPlaced(CHROME_MANIFEST.menu.top)).toBe(false);
  });

  it("only references regions the layouts have", () => {
    for (const feature of CHROME_FEATURES) {
      if (isPlaced(feature.top)) expect(TOP_REGIONS).toContain(feature.top.region);
      if (isPlaced(feature.sidebar)) expect(SIDEBAR_REGIONS).toContain(feature.sidebar.region);
    }
  });

  it("lists a region's features in order, each order unique within the region", () => {
    const check = (features: ReturnType<typeof featuresIn>, layout: (typeof LAYOUTS)[number]) => {
      const orders = features.map((feature) => {
        const placement = placementOf(feature, layout);
        return isPlaced(placement) ? placement.order : Number.NaN;
      });
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
      expect(new Set(orders).size).toBe(orders.length);
    };
    for (const region of TOP_REGIONS) check(featuresIn("top", region), "top");
    for (const region of SIDEBAR_REGIONS) check(featuresIn("sidebar", region), "sidebar");
  });

  it("covers every placed feature with some region", () => {
    for (const layout of LAYOUTS) {
      const placed = CHROME_FEATURES.filter((feature) => isPlaced(placementOf(feature, layout))).map((f) => f.id);
      const rendered =
        layout === "top"
          ? TOP_REGIONS.flatMap((region) => featuresIn("top", region))
          : SIDEBAR_REGIONS.flatMap((region) => featuresIn("sidebar", region));
      expect(rendered.map((f) => f.id).sort()).toEqual([...placed].sort());
    }
  });
});
