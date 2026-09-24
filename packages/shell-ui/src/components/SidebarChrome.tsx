import { TRAFFIC_LIGHTS_H, TRAFFIC_LIGHTS_W } from "@pistachio/shell-contracts/chrome";
import { ChromeRegion } from "../chrome/manifest-renderers";
import { ShelfDragProvider } from "../chrome/shelf-drag";

/**
 * The sidebar column, pinned or compact (layouts/SidebarLayout.tsx places
 * it; compact only adds the auto-hide). Top to bottom: the toolbar row, the
 * address row, the favorites grid, the scrolling tab list, background media,
 * and the footer
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
 */
export function SidebarChrome() {
  return (
    <div data-testid="sidebar-chrome" className="chrome-sidebar drag-region flex h-full w-full min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 pr-2" style={{ height: TRAFFIC_LIGHTS_H, paddingLeft: TRAFFIC_LIGHTS_W }}>
        <ChromeRegion layout="sidebar" region="toolbar" />
      </div>
      <div className="flex shrink-0 px-2 pb-2">
        <ChromeRegion layout="sidebar" region="address" />
      </div>
      {/* The media stack floats over the bottom of the tab list rather than taking a slot of its own. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ShelfDragProvider>
          <ChromeRegion layout="sidebar" region="favorites" />
          <ChromeRegion layout="sidebar" region="tabs" />
        </ShelfDragProvider>
        <ChromeRegion layout="sidebar" region="media" />
      </div>
      {/* The footer: the menu (the Space avatar) at its start, then any pills. All are buttons, so the row opts out as one. */}
      <div className="no-drag flex h-10 shrink-0 items-center gap-1.5 border-t border-alpha-400 px-2">
        <ChromeRegion layout="sidebar" region="footer" />
      </div>
    </div>
  );
}
