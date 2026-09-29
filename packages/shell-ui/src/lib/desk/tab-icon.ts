/**
 * Which picture stands for a tab in the desk's dock (components/desk
 * DeskDock's AppIcon): its app icon, else its favicon on a tile, else its
 * initial — passing over any address that has failed to load. The failures
 * are all remembered, so the app icon and the favicon failing in turn never
 * bring each other back.
 *
 * Pure on purpose — no DOM — so vitest pins it under node.
 */

export type TabIcon = { kind: "app"; src: string } | { kind: "favicon"; src: string } | { kind: "letter" };

export function tabIcon(appIconUrl: string | null | undefined, faviconUrl: string | null, failed: ReadonlySet<string>): TabIcon {
  if (appIconUrl !== null && appIconUrl !== undefined && appIconUrl.length > 0 && !failed.has(appIconUrl)) return { kind: "app", src: appIconUrl };
  if (faviconUrl !== null && faviconUrl.length > 0 && !failed.has(faviconUrl)) return { kind: "favicon", src: faviconUrl };
  return { kind: "letter" };
}
