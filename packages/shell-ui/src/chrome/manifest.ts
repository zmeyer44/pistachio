/**
 * The chrome manifest: every feature the browser chrome contains, declared
 * ONCE with a placement in BOTH layouts (top tabs and the sidebar).
 *
 * The point is that a feature can never ship to one layout only. The type
 * forces a row per id and both placements per row, and a feature that
 * genuinely has no home in a layout says so with a `hidden` reason —
 * greppable, reviewable, and asserted by test/chrome-manifest.test.ts.
 * Layouts never list features themselves: they place REGIONS (`ChromeRegion`
 * in manifest-renderers.tsx), and the region renders whatever this table
 * puts there, in order.
 *
 * Pure on purpose — no React, no DOM — so vitest imports it under node.
 * The renderers keyed by these ids live in manifest-renderers.tsx (a
 * sibling `manifest.tsx` would be unreachable: an extensionless import
 * resolves to this .ts first).
 */

import type { ChromeLayoutMode } from "@pistachio/shell-contracts/settings";

/** The top layout's regions: one 40px strip, left to right. */
export type TopRegion = "leading" | "tabs" | "trailing";
/** The sidebar's regions: one column, top to bottom. */
export type SidebarRegion = "toolbar" | "address" | "favorites" | "tabs" | "media" | "footer";

export const TOP_REGIONS: readonly TopRegion[] = ["leading", "tabs", "trailing"];
export const SIDEBAR_REGIONS: readonly SidebarRegion[] = ["toolbar", "address", "favorites", "tabs", "media", "footer"];

/**
 * Where a feature goes in one layout: a region and its order within it
 * (spaced by 10 so a feature can be slotted between two without renumbering),
 * or `hidden` with the reason it has no place there.
 */
export type Placement<R extends string> = { region: R; order: number } | { hidden: string };

export type ChromeFeatureId =
  | "navigation"
  | "address"
  | "siteInfo"
  | "favorites"
  | "tabs"
  | "media"
  | "sidebarPin"
  | "menu"
  | "policy"
  | "split"
  | "console"
  | "reminders"
  | "bookmarks"
  | "watchtower"
  | "downloads"
  | "spaces"
  | "sync"
  | "update"
  | "settings";

/** A feature's placement in each layout — both, always. */
export interface ChromeFeaturePlacements {
  top: Placement<TopRegion>;
  sidebar: Placement<SidebarRegion>;
}

export interface ChromeFeature extends ChromeFeaturePlacements {
  id: ChromeFeatureId;
}

/**
 * The sidebar footer folds its buttons into one menu (components/SidebarMenu.tsx);
 * a feature the strip lays out as its own button is hidden there for this
 * reason, and the menu lists it instead.
 */
export const SIDEBAR_MENU_FOLD = "Folded into the sidebar footer's menu (SidebarMenu), which lists it as a row";

/**
 * Every feature, keyed by id. A Record over the id union, not a list: an id
 * added to `ChromeFeatureId` without a row here does not compile, so a
 * feature cannot be declared and then placed nowhere. Orders are spaced by
 * 10; declaration order is the order the rows are listed in.
 */
export const CHROME_MANIFEST = {
  navigation: {
    top: { hidden: "Back, forward, and reload unfold from the active tab's favicon (TabNavCluster)" },
    sidebar: { region: "toolbar", order: 10 },
  },
  sidebarPin: {
    top: { hidden: "There is no sidebar to pin in the top layout" },
    sidebar: { region: "toolbar", order: 90 },
  },
  address: {
    top: { hidden: "The active tab is the omnibox: its title cross-fades to its address on hover (ActiveTabLabel)" },
    sidebar: { region: "address", order: 10 },
  },
  // Chrome's "view site information": the quick permissions popover. Neither
  // layout lays it out as a region feature — it rides with the active page's
  // own controls: the active tab in the strip (the strip's omnibox), and the
  // pane toolbar over the page card in the sidebar layout, beside bookmark.
  siteInfo: {
    top: { hidden: "Sits at the active tab's leading edge, since the active tab is the omnibox (SiteInfoButton in TabStrip)" },
    sidebar: { hidden: "Sits in the pane toolbar over the page card, beside the bookmark button (SiteInfoButton in PaneToolbar)" },
  },
  favorites: {
    top: { hidden: "The strip has no shelf; favorites, presets, and pins open from the address bar's browse mode (UrlBar)" },
    sidebar: { region: "favorites", order: 10 },
  },
  tabs: { top: { region: "tabs", order: 10 }, sidebar: { region: "tabs", order: 10 } },
  media: {
    top: { hidden: "Background playback controls need the sidebar's vertical space for the expanding card stack" },
    sidebar: { region: "media", order: 10 },
  },
  menu: {
    top: { hidden: "The strip's trailing cluster has room for each control as its own button" },
    sidebar: { region: "footer", order: 10 },
  },
  policy: {
    top: { region: "trailing", order: 10 },
    sidebar: { hidden: "Site controls ride with the page card (SiteInfoButton in PaneToolbar); the footer menu keeps to the account and its tools" },
  },
  split: { top: { region: "trailing", order: 20 }, sidebar: { hidden: "Reached by its shortcut and the command palette; the footer menu leaves it out" } },
  console: { top: { region: "trailing", order: 30 }, sidebar: { hidden: SIDEBAR_MENU_FOLD } },
  reminders: { top: { region: "trailing", order: 35 }, sidebar: { hidden: SIDEBAR_MENU_FOLD } },
  watchtower: { top: { region: "trailing", order: 37 }, sidebar: { hidden: "Reached by its shortcut and the command palette; the footer menu leaves it out" } },
  bookmarks: { top: { region: "trailing", order: 36 }, sidebar: { hidden: SIDEBAR_MENU_FOLD } },
  // Empty until this session downloads something, then a chip that shows the
  // transfer's progress and, once done, that it finished — and opens the list
  // (DownloadsChip). The sidebar footer's menu also lists "Downloads" as a
  // row, so the list is reachable there before anything has been downloaded.
  downloads: { top: { region: "trailing", order: 38 }, sidebar: { region: "footer", order: 25 } },
  spaces: { top: { region: "trailing", order: 40 }, sidebar: { hidden: "The footer menu's button is the active Space's avatar, and its panel lists the others (SidebarMenu)" } },
  // Empty while session sync is doing its job; a pill when it is stuck,
  // revoked, or a run is working in the cloud browser (SyncPill).
  sync: { top: { region: "trailing", order: 44 }, sidebar: { region: "footer", order: 20 } },
  // Empty until a newer release exists, then a pill that carries the next step.
  update: { top: { region: "trailing", order: 45 }, sidebar: { region: "footer", order: 30 } },
  settings: { top: { region: "trailing", order: 50 }, sidebar: { hidden: SIDEBAR_MENU_FOLD } },
} satisfies Record<ChromeFeatureId, ChromeFeaturePlacements>;

/** Every id, in declaration order. */
export const CHROME_FEATURE_IDS = Object.keys(CHROME_MANIFEST) as ChromeFeatureId[];

/** The manifest as rows, each id exactly once, in declaration order. */
export const CHROME_FEATURES: readonly ChromeFeature[] = CHROME_FEATURE_IDS.map((id) => ({
  id,
  ...CHROME_MANIFEST[id],
}));

export function isPlaced<R extends string>(placement: Placement<R>): placement is { region: R; order: number } {
  return "region" in placement;
}

export function placementOf(feature: ChromeFeature, layout: "top"): Placement<TopRegion>;
export function placementOf(feature: ChromeFeature, layout: "sidebar"): Placement<SidebarRegion>;
export function placementOf(feature: ChromeFeature, layout: ChromeLayoutMode): Placement<TopRegion | SidebarRegion>;
export function placementOf(feature: ChromeFeature, layout: ChromeLayoutMode): Placement<TopRegion | SidebarRegion> {
  return layout === "top" ? feature.top : feature.sidebar;
}

/** The features a region holds, in order. */
export function featuresIn(layout: "top", region: TopRegion): ChromeFeature[];
export function featuresIn(layout: "sidebar", region: SidebarRegion): ChromeFeature[];
export function featuresIn(layout: ChromeLayoutMode, region: TopRegion | SidebarRegion): ChromeFeature[] {
  return CHROME_FEATURES.map((feature) => ({ feature, placement: placementOf(feature, layout) }))
    .filter(
      (entry): entry is { feature: ChromeFeature; placement: { region: TopRegion | SidebarRegion; order: number } } =>
        isPlaced(entry.placement) && entry.placement.region === region,
    )
    .sort((a, b) => a.placement.order - b.placement.order)
    .map((entry) => entry.feature);
}
