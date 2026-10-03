import { TRAFFIC_LIGHTS_H, TRAFFIC_LIGHTS_W } from "@pistachio/shell-contracts/chrome";
import { ChromeRegion } from "../chrome/manifest-renderers";
import { ShelfDragProvider } from "../chrome/shelf-drag";
import { RailNowPlaying } from "./desk/DeskNowPlaying";
import { DeskMoreButton, DeskRailToggle } from "./desk/DeskSidebarControls";
import { SidebarRailContext } from "./sidebar-rail";

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
 * lights' own centre line. (`lights` false — the top layout's column, under
 * its strip, or a desk's rail, which hides them — and there is nothing to
 * clear.)
 *
 * As a RAIL (a desk's dock, `rail`) it is the same column and the same
 * regions drawn narrow, its icons alone (sidebar-rail.ts): the toolbar gives
 * way to the desk's own two buttons — the whole sidebar back, and the desk's
 * card — at its head, where the window's buttons were (main hides them while
 * the rail is up: ShellState.sidebarRail), and background media is the desk's
 * now playing (desk/DeskNowPlaying.tsx) instead of the stack's cards.
 */
export function SidebarChrome({ rail = false, lights = true }: { rail?: boolean; lights?: boolean }) {
  return (
    <SidebarRailContext.Provider value={rail}>
      <div data-testid="sidebar-chrome" data-rail={rail ? "" : undefined} className="chrome-sidebar drag-region flex h-full w-full min-w-0 flex-col">
        {rail ? (
          <div className="flex shrink-0 flex-col items-center gap-0.5 pb-1" style={{ paddingTop: lights ? TRAFFIC_LIGHTS_H : 6 }}>
            <DeskRailToggle />
            <DeskMoreButton />
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1 pr-2" style={{ height: TRAFFIC_LIGHTS_H, paddingLeft: lights ? TRAFFIC_LIGHTS_W : 8 }}>
            <ChromeRegion layout="sidebar" region="toolbar" />
          </div>
        )}
        <div className="sidebar-address-row flex shrink-0 px-2 pb-2">
          <ChromeRegion layout="sidebar" region="address" />
        </div>
        {/* The dock — the media stack, then a screen share's card — floats over the bottom of the tab list rather than taking a slot of its own. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ShelfDragProvider>
            <ChromeRegion layout="sidebar" region="favorites" />
            <ChromeRegion layout="sidebar" region="tabs" />
          </ShelfDragProvider>
          {rail ? null : (
            <div className="sidebar-media-dock">
              <ChromeRegion layout="sidebar" region="media" />
            </div>
          )}
        </div>
        {/* On the rail, background media is the desk's now playing: a floating player for a video, a button here for the rest. */}
        {rail ? <RailNowPlaying /> : null}
        {/* The footer: the menu (the Space avatar) at its start, then any pills. All are buttons, so the row opts out as one. */}
        <div className="sidebar-footer no-drag flex h-10 shrink-0 items-center gap-1.5 border-t border-alpha-400 px-2">
          <ChromeRegion layout="sidebar" region="footer" />
        </div>
      </div>
    </SidebarRailContext.Provider>
  );
}
