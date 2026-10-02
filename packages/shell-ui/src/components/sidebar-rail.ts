import { createContext, useContext } from "react";

/**
 * The sidebar is drawn as a RAIL of its icons (a desk's dock, docs/desk.md):
 * the same chrome and the same rows, narrow. Most of it is the stylesheet's
 * (`.chrome-sidebar[data-rail]`); the few parts that draw something else
 * there — the address as a button, the favorites in one column, a section's
 * header as a hairline — read it here.
 */
export const SidebarRailContext = createContext(false);

export function useSidebarRail(): boolean {
  return useContext(SidebarRailContext);
}
