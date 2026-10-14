import { TRAFFIC_LIGHTS_H, TRAFFIC_LIGHTS_W } from "@pistachio/shell-contracts/chrome";
import { ChromeRegion } from "../chrome/manifest-renderers";
import { ShelfDragProvider } from "../chrome/shelf-drag";

/**
 * The single sidebar column, whole (layouts/SidebarLayout.tsx places it;
 * hidden only adds the auto-hide): the web's and the cloud browser's. On the
 * desktop the column is the double sidebar (components/space-rail) since
 * 2026-10-13. Top to bottom: the toolbar row, the address row, the
 * favorites grid, the scrolling tab list, background media, and the footer
 * row; each is a REGION the manifest fills (chrome/manifest.ts), never a
 * list of features. The grid and the list are one drag surface — a row can
 * be dropped on the grid and a tile in the list — so the column hosts the
 * drag they share (chrome/shelf-drag.tsx) around both regions.
 *
 * The column is a window drag region, so the window drags from any empty
 * sidebar space — the toolbar is the titlebar here — and every control
 * inside opts out. The toolbar shares the titlebar with the traffic lights:
 * its leading pad clears them, and its height centres its buttons on the
 * lights' own centre line.
 *
 * (Until 2026-10-13 it was also the desk's RAIL — the same column and
 * regions drawn narrow, its icons alone, the favorites one folder: the
 * double sidebar's rail replaced it.)
 */
export function SidebarChrome() {
  return (
    <div data-testid="sidebar-chrome" className="chrome-sidebar drag-region flex h-full w-full min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 pr-2" style={{ height: TRAFFIC_LIGHTS_H, paddingLeft: TRAFFIC_LIGHTS_W }}>
        <ChromeRegion region="toolbar" />
      </div>
      <div className="sidebar-address-row flex shrink-0 px-2 pb-2">
        <ChromeRegion region="address" />
      </div>
      {/* The dock — the media stack, then a screen share's card — floats over the bottom of the tab list rather than taking a slot of its own. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ShelfDragProvider>
          <ChromeRegion region="favorites" />
          <ChromeRegion region="tabs" />
        </ShelfDragProvider>
        <div className="sidebar-media-dock">
          <ChromeRegion region="media" />
        </div>
      </div>
      {/* The footer: the menu (the Profile's avatar) at its start, then any pills. All are buttons, so the row opts out as one. */}
      <div className="sidebar-footer no-drag flex h-10 shrink-0 items-center gap-1.5 border-t border-alpha-400 px-2">
        <ChromeRegion region="profile" />
        <ChromeRegion region="footer" />
      </div>
    </div>
  );
}
