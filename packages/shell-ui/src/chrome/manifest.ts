/**
 * The chrome manifest: every feature the sidebar's column lays out, declared
 * ONCE with its region and its order there.
 *
 * The sidebar never lists features itself: it places REGIONS (`ChromeRegion`
 * in manifest-renderers.tsx), and the region renders whatever this table
 * puts there, in order. Controls the column does not lay out as their own
 * buttons — the agent console, reminders, bookmarks, settings — are rows in
 * the footer's menu (components/SidebarMenu.tsx); split and Watchtower are
 * reached by their shortcuts and the command palette.
 *
 * Pure on purpose — no React, no DOM — so vitest imports it under node.
 * The renderers keyed by these ids live in manifest-renderers.tsx (a
 * sibling `manifest.tsx` would be unreachable: an extensionless import
 * resolves to this .ts first).
 */

/** The sidebar's regions: one column, top to bottom. */
export type SidebarRegion = "toolbar" | "address" | "favorites" | "tabs" | "media" | "footer";

export const SIDEBAR_REGIONS: readonly SidebarRegion[] = ["toolbar", "address", "favorites", "tabs", "media", "footer"];

/**
 * Where a feature goes: a region and its order within it (spaced by 10 so a
 * feature can be slotted between two without renumbering).
 */
export interface Placement {
  region: SidebarRegion;
  order: number;
}

export type ChromeFeatureId =
  | "navigation"
  | "address"
  | "favorites"
  | "tabs"
  | "media"
  | "screenShare"
  | "sidebarPin"
  | "menu"
  | "downloads"
  | "sync"
  | "update";

export interface ChromeFeature extends Placement {
  id: ChromeFeatureId;
}

/**
 * Every feature, keyed by id. A Record over the id union, not a list: an id
 * added to `ChromeFeatureId` without a row here does not compile, so a
 * feature cannot be declared and then placed nowhere. Orders are spaced by
 * 10; declaration order is the order the rows are listed in.
 */
export const CHROME_MANIFEST = {
  navigation: { region: "toolbar", order: 10 },
  sidebarPin: { region: "toolbar", order: 90 },
  address: { region: "address", order: 10 },
  favorites: { region: "favorites", order: 10 },
  tabs: { region: "tabs", order: 10 },
  media: { region: "media", order: 10 },
  // Empty unless a tab is sharing the screen, then that share's card with a
  // Stop, at the foot of the dock below the media stack, where the stack's
  // fan-out never covers it (ScreenShareIndicator).
  screenShare: { region: "media", order: 20 },
  menu: { region: "footer", order: 10 },
  // Empty while session sync is doing its job; a pill when it is stuck,
  // revoked, or a run is working in the cloud browser (SyncPill).
  sync: { region: "footer", order: 20 },
  // Empty until this session downloads something, then a chip that shows the
  // transfer's progress and, once done, that it finished — and opens the list
  // (DownloadsChip). The footer's menu also lists "Downloads" as a row, so
  // the list is reachable there before anything has been downloaded.
  downloads: { region: "footer", order: 25 },
  // Empty until a newer release exists, then a pill that carries the next step.
  update: { region: "footer", order: 30 },
} satisfies Record<ChromeFeatureId, Placement>;

/** Every id, in declaration order. */
export const CHROME_FEATURE_IDS = Object.keys(CHROME_MANIFEST) as ChromeFeatureId[];

/** The manifest as rows, each id exactly once, in declaration order. */
export const CHROME_FEATURES: readonly ChromeFeature[] = CHROME_FEATURE_IDS.map((id) => ({
  id,
  ...CHROME_MANIFEST[id],
}));

/** The features a region holds, in order. */
export function featuresIn(region: SidebarRegion): ChromeFeature[] {
  return CHROME_FEATURES.filter((feature) => feature.region === region).sort((a, b) => a.order - b.order);
}
