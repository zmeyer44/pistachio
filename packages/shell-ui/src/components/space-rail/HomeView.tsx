import { ChromeRegion } from "../../chrome/manifest-renderers";
import { FavoritesGrid } from "../FavoritesGrid";
import { TabList } from "../TabList";

/**
 * Home in the double sidebar's card (docs/double-sidebar.md §1): an ordinary
 * browser's sidebar, every row a full-desk tab. The favorites three to a row
 * (a favorite whose page has tabs beside it carries their count, and is a
 * space of the rail's), then TabList's "home" view: Pinned, the New tab row
 * (New folder and New space on its hover), and Today — the day's loose tabs,
 * each with + (a window beside it) and × on hover, the one in use raised and
 * its Context row under it. The media stack floats over the list's foot.
 */
export function HomeView() {
  return (
    <div data-testid="home-view" className="home-view">
      <FavoritesGrid />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <TabList view="home" />
        <div className="sidebar-media-dock">
          <ChromeRegion region="media" />
        </div>
      </div>
    </div>
  );
}
