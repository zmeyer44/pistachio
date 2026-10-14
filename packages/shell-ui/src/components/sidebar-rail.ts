import { createContext, useContext } from "react";

/**
 * The sidebar stands as its RAIL ALONE (SidebarMode "rail", the desktop's
 * alone: docs/double-sidebar.md §1), no card beside it: what is drawn in the
 * rail's foot reads it here. The double sidebar's rail provides it around its
 * Profile region (SpaceRail), so the Profile's menu, which then has no card
 * to fit in, hangs out past the rail over the desk, its live pages giving way
 * to their stills (SidebarMenu's useMenuOverPages); beside the card it is
 * false, and the menu fits the column.
 *
 * (Until 2026-10-13 the single sidebar provided it when drawn narrow as the
 * desk's rail, its icons alone, and the address, the favorites and a
 * section's header drew themselves otherwise there: the double sidebar's
 * rail replaced it.)
 */
export const SidebarRailContext = createContext(false);

export function useSidebarRail(): boolean {
  return useContext(SidebarRailContext);
}
