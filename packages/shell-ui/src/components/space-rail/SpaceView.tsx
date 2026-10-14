import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { ChromeRegion } from "../../chrome/manifest-renderers";
import { DeskContextRow } from "../desk/DeskSidebarControls";
import { LayoutControl } from "../desk/LayoutControl";
import { TabList } from "../TabList";
import { SpaceHead } from "./SpaceHead";

/**
 * A space in the double sidebar's card (docs/double-sidebar.md §1): a small
 * control room for its desk. Its head (name, count, ⋯), its layouts
 * (LayoutControl, components/desk — drawn once the desk's half lands), a
 * hairline, its tabs as rows (TabList's "space" view: the one in use a card
 * of its colour, the desk's window marks) and its New tab, and at the
 * card's foot its Context row, the Stack. An empty space says so quietly; its
 * layouts are there while its desk has windows (documents) to lay out. The wash of its colour at the card's top is the column's
 * (painted on the card's own outline: SpaceColumn).
 */
export function SpaceView({ group, page }: { group: TabGroupInfo; page: boolean }) {
  const count = group.tabIds.length;
  return (
    <div data-testid="space-view" data-group-id={group.id} data-group-color={group.color} className="space-view tab-group-tone">
      <SpaceHead group={group} page={page} count={count} />
      {/* (Whatever the space holds: the control hides itself with nothing on the desk to lay out — an empty space's
          documents are windows it can lay out. Until 2026-10-13 it waited for a tab.) */}
      <LayoutControl groupId={group.id} />
      <span className="space-view-rule" aria-hidden="true" />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <TabList view="space" />
        {/* The media stack and a screen share's card float over the list's foot, as in the single sidebar. */}
        <div className="sidebar-media-dock">
          <ChromeRegion region="media" />
        </div>
      </div>
      <div className="space-view-foot">
        <DeskContextRow group={group} />
      </div>
    </div>
  );
}
