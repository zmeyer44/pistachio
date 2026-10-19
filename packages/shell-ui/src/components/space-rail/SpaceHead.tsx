import { Ellipsis } from "lucide-react";
import { tabGroupTitle, type TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { openLiveCard } from "../../lib/live/actions";
import { sidebarOverlays, useSidebarColumn, useSidebarMode } from "../../lib/sidebar-mode";
import { useAppStore } from "../../store";
import { useContextMenu } from "../ContextMenu";
import { LiveMark, liveMarkLabel, useLiveMarkFor } from "../live/LiveMark";
import { GroupTitleInput } from "../TabGroupRow";
import { renameSpace, useSpaceRename } from "./column-state";
import { useSpaceMenu } from "./space-menu";

/**
 * A space's head in the double sidebar's card (docs/double-sidebar.md §1):
 * its name in its colour (a double-click renames it, in place, with the
 * list's own field), how many windows it holds, and its ⋯ — the space's own
 * menu (rename, colour, new tab in space, release the tabs, close space; a
 * page's space's own: space-menu.tsx).
 * A space being named by the host says so, shimmering, until its name comes.
 * Shared live, it wears the live mark after its name, which opens the Live card.
 * A page's space goes by its page's title, and has no name of its own to edit.
 */
export function SpaceHead({ group, page, count }: { group: TabGroupInfo; page: boolean; count: number }) {
  const editing = useSpaceRename((state) => state.spaceId === group.id);
  // The hidden column takes no focus while it is away: the field opens once it is out (useSpaceRename brings it).
  const away = useHidden();
  const menu = useContextMenu();
  const spaceMenu = useSpaceMenu();
  const pageTitle = useAppStore((state) => {
    if (!page) return null;
    const own = state.snapshot?.tabs.find((tab) => group.tabIds.includes(tab.id) && tab.anchorId === group.anchorId);
    return tabGroupTitle(own?.title ?? "");
  });
  const naming = group.naming === true;
  const live = useLiveMarkFor(group.id);
  const title = pageTitle ?? group.title;
  const windows = count === 0 ? "" : `${String(count)} ${count === 1 ? "window" : "windows"}`;
  const finish = (value: string | null): void => {
    useSpaceRename.getState().done();
    if (value !== null && value.trim() !== "" && value !== group.title) void useAppStore.getState().tabGroupCommand({ type: "rename", groupId: group.id, title: value });
  };
  return (
    <div data-testid="space-head" className="space-head">
      {editing && !away && !page ? (
        <span className="space-name-field">
          <GroupTitleInput title={naming ? "" : group.title} onDone={finish} />
        </span>
      ) : (
        <span
          data-testid="space-name"
          data-naming={naming ? "" : undefined}
          data-page={page ? "" : undefined}
          title={page || naming ? title : `${title}\nDouble-click to rename`}
          onDoubleClick={() => {
            if (!page && !naming) renameSpace(group.id);
          }}
          className="space-name"
        >
          {naming ? "Naming…" : title}
        </span>
      )}
      {live.live ? (
        <button
          type="button"
          data-live-opener=""
          data-testid="space-live"
          aria-label={`${liveMarkLabel(live.guests)}: show the Live card`}
          title={liveMarkLabel(live.guests)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => openLiveCard("live")}
          className="space-live no-drag"
        >
          <LiveMark />
        </button>
      ) : null}
      {windows === "" ? null : (
        <span className="space-count" aria-label={windows} title={windows}>
          {count}
        </span>
      )}
      <button
        type="button"
        aria-label="Space options"
        title="Space options"
        aria-haspopup="menu"
        aria-expanded={menu.isOpen}
        data-testid="space-more"
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          menu.open({ clientX: box.left, clientY: box.bottom + 4 }, spaceMenu({ group, page }));
        }}
        className="space-more no-drag"
      >
        <Ellipsis aria-hidden="true" />
      </button>
      {menu.menu}
    </div>
  );
}

/** The hidden column brought out over the desk is not out yet (or has gone): nothing in it can take focus. */
function useHidden(): boolean {
  const overlay = sidebarOverlays(useSidebarMode());
  const out = useSidebarColumn((state) => state.out);
  return overlay && !out;
}
