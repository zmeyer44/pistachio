import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { House, Plus } from "lucide-react";
import { tabGroupTitle } from "@pistachio/shell-contracts/tab-groups";
import { ChromeRegion } from "../../chrome/manifest-renderers";
import { useShelfDrag } from "../../chrome/shelf-drag";
import { useGroupContexts } from "../../lib/desk/group-context";
import { NEW_SPACE_EVENT, newSpace, selectSpace } from "../../lib/desk/open";
import { groupPageOf } from "../../lib/desk/store";
import { useAppStore } from "../../store";
import { useContextMenu } from "../ContextMenu";
import { RailNowPlaying } from "../desk/DeskNowPlaying";
import { DeskMoreButton, DeskRailToggle } from "../desk/DeskSidebarControls";
import { SidebarRailContext } from "../sidebar-rail";
import { FaviconCluster, type ClusterTab } from "../TabGroupRow";
import { chooseHome } from "./actions";
import { renameSpace } from "./column-state";
import { dayUnitsOf, HOME_VIEW, railMoveIndex, type ColumnView, type RailSpace } from "./rail-model";
import { useSpaceMenu } from "./space-menu";

/** A press this far along the rail is a tile carried, not a click. */
const MOVE_START_PX = 5;

/**
 * The double sidebar's rail (docs/double-sidebar.md §1): 56px on the
 * window's own ground, top to bottom Home, a hairline, every rail space as a
 * tile — its mark (TabGroupRow's FaviconCluster, a size up, on its colour)
 * with its count on the corner — scrolling without a scrollbar when they
 * outgrow it, and at the foot New space and the Profile's menu. On the rail
 * alone (SidebarMode "rail") its head holds the button that brings the card
 * back and the desk's ⋯, where the traffic lights were (main hides them),
 * and background media is the desk's now playing.
 *
 * It decides nothing about the card: the chosen item (`view`) sits on the
 * card's tab, which the column draws round whatever box the tile has here
 * (`data-rail-key`), so the rail only lays its items out and says when
 * they move (`onLayout`). Its tiles and Home take a row let go on them
 * (`data-rail-drop`, chrome/shelf-drag.tsx).
 */
export function SpaceRail({
  spaces,
  view,
  railOnly,
  listRef,
  onLayout,
}: {
  spaces: readonly RailSpace[];
  /** The view the card shows: its item is on the tab. */
  view: ColumnView;
  /** The rail alone (no card beside it). */
  railOnly: boolean;
  listRef: RefObject<HTMLDivElement | null>;
  /** The rail's items moved under the tab (a scroll). */
  onLayout: () => void;
}) {
  const { railRef, drag } = useShelfDrag();
  const tabs = useAppStore((state) => state.snapshot?.tabs);
  const tabsById = useMemo(() => new Map((tabs ?? []).map((tab) => [tab.id, tab])), [tabs]);
  const contexts = useGroupContexts();
  const menu = useContextMenu();
  const spaceMenu = useSpaceMenu();
  const railDrop = drag !== null && !drag.settling && drag.drop?.zone === "rail" ? drag.drop : null;
  const moving = useRailMove();

  const tabsOf = (space: RailSpace): ClusterTab[] => {
    const all = space.group.tabIds.flatMap((tabId) => tabsById.get(tabId) ?? []);
    if (!space.page) return all;
    // A page's space: its page first.
    const page = groupPageOf(space.group, all);
    return page === null ? all : [...all.filter((tab) => tab.id === page), ...all.filter((tab) => tab.id !== page)];
  };
  const nameOf = (space: RailSpace, members: readonly ClusterTab[]): string => {
    if (space.group.naming === true) return "Naming…";
    if (!space.page) return space.group.title;
    return tabGroupTitle(members[0]?.title ?? "");
  };

  return (
    <nav
      ref={railRef}
      aria-label="Spaces"
      data-testid="space-rail"
      data-rail-only={railOnly ? "" : undefined}
      className="space-rail"
    >
      {railOnly ? (
        <div className="space-rail-head">
          <DeskRailToggle />
          <DeskMoreButton />
        </div>
      ) : (
        // (The traffic lights' pocket: the card's shoulder steps round it.)
        <div className="space-rail-lights" aria-hidden="true" />
      )}
      <button
        type="button"
        data-testid="rail-home"
        data-rail-key={HOME_VIEW}
        data-rail-drop="home"
        data-dropping={railDrop?.target === "home" ? "" : undefined}
        aria-label="Home"
        aria-current={view === HOME_VIEW ? "true" : undefined}
        title="Home"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void chooseHome()}
        className="space-rail-home no-drag"
      >
        <House aria-hidden="true" />
      </button>
      <span className="space-rail-rule" aria-hidden="true" />
      {/* (Out of the window's drag region, as the single sidebar's list was: a press between its tiles is the list's.) */}
      <div ref={listRef} data-testid="space-rail-list" className="space-rail-list no-drag" onScroll={onLayout}>
        {spaces.map((space) => {
          const members = tabsOf(space);
          const name = nameOf(space, members);
          const count = members.length;
          const windows = count === 0 ? "No windows" : `${String(count)} ${count === 1 ? "window" : "windows"}`;
          const stack = count === 0 ? (contexts.find((context) => context.groupId === space.group.id)?.items.length ?? 0) : 0;
          return (
            <button
              key={space.group.id}
              type="button"
              data-testid="rail-space"
              data-group-id={space.group.id}
              data-group-color={space.group.color}
              data-rail-key={space.group.id}
              data-rail-drop="space"
              data-page={space.page ? "" : undefined}
              data-naming={space.group.naming === true ? "" : undefined}
              data-dropping={railDrop?.target === "space" && railDrop.groupId === space.group.id ? "" : undefined}
              data-moving={moving.id === space.group.id ? "" : undefined}
              aria-label={`${name}, ${windows}`}
              aria-current={view === space.group.id ? "true" : undefined}
              title={`${name} · ${windows}`}
              style={moving.id === space.group.id ? { transform: `translateY(${String(moving.dy)}px)` } : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onPointerDown={(event) => {
                if (!space.page) moving.press(space.group.id, event);
              }}
              onClick={() => {
                if (moving.justMoved(space.group.id)) return;
                selectSpace(space.group.id);
              }}
              onDoubleClick={() => renameSpace(space.group.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                menu.open(event, spaceMenu(space));
              }}
              className="space-rail-tile tab-group-tone no-drag"
            >
              <FaviconCluster tabs={members} stack={stack} />
            </button>
          );
        })}
      </div>
      <div className="space-rail-foot">
        {railOnly ? <RailNowPlaying /> : null}
        <button
          type="button"
          data-testid="rail-new-space"
          data-rail-drop="new"
          data-dropping={railDrop?.target === "new" ? "" : undefined}
          aria-label="New space"
          title="New space"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            void newSpace().then((id) => {
              // (Named in the card's head, as ⌘N's is: SpaceColumn hears it.)
              if (id !== null) window.dispatchEvent(new CustomEvent(NEW_SPACE_EVENT, { detail: id }));
            });
          }}
          className="space-rail-new no-drag"
        >
          <Plus aria-hidden="true" />
        </button>
        {/* On the rail alone its menu hangs out past it, over the desk: the pages under it give way to their stills
            (SidebarMenu's useMenuOverPages, the shell's context-menu overlay). Beside the card it fits the column, and
            raises nothing — so a page over the desk (Settings, the library) stays up under it, and the menu's own row can
            close it. (Until 2026-10-13 it raised always, and opening it closed that page.) */}
        <SidebarRailContext.Provider value={railOnly}>
          <div className="space-rail-profile">
            <ChromeRegion region="profile" />
          </div>
        </SidebarRailContext.Provider>
      </div>
      {menu.menu}
    </nav>
  );
}

/**
 * A space's tile carried along the rail: it follows the pointer up and down,
 * and let go on another drawn space's tile it moves the space to just before
 * or after it among the day's units (main's `move`, as a group's row
 * dropped among the day's did). A page's space has no place in the row to
 * move to, and its tile is not carried.
 *
 * Each press is its own gesture: the click its release makes on the tile it
 * carried chooses nothing (`justMoved`, for that tile and only until that
 * click — a task later it is forgotten), and its window listeners go with the
 * rail if it goes mid-carry. (Until 2026-10-13 one flag served every tile, and
 * a page's tile, never pressed, never cleared it: its next click was lost.)
 */
function useRailMove(): {
  id: string | null;
  dy: number;
  press(groupId: string, event: React.PointerEvent<HTMLElement>): void;
  justMoved(groupId: string): boolean;
} {
  const [state, setState] = useState<{ id: string | null; dy: number }>({ id: null, dy: 0 });
  /** The tile a carry has just been let go on. */
  const carried = useRef<string | null>(null);
  /** The live carry's listeners, to take away. */
  const live = useRef<(() => void) | null>(null);
  useEffect(() => () => live.current?.(), []);
  const press = (groupId: string, event: React.PointerEvent<HTMLElement>): void => {
    live.current?.();
    if (event.button !== 0) return;
    const tile = event.currentTarget;
    const startY = event.clientY;
    let moving = false;
    const onMove = (ev: PointerEvent): void => {
      const dy = ev.clientY - startY;
      if (!moving && Math.abs(dy) < MOVE_START_PX) return;
      moving = true;
      setState({ id: groupId, dy });
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (live.current === stop) live.current = null;
    };
    const finish = (ev: PointerEvent | null): void => {
      stop();
      setState({ id: null, dy: 0 });
      if (!moving || ev === null) return;
      // The click this release makes comes in this same task: it is the carry's, not a choice.
      carried.current = groupId;
      window.setTimeout(() => {
        if (carried.current === groupId) carried.current = null;
      }, 0);
      // The drawn tile nearest the pointer, and which side of its middle it was let go on.
      const rail = tile.parentElement;
      if (rail === null) return;
      let target: { id: string; after: boolean; distance: number } | null = null;
      for (const other of rail.querySelectorAll<HTMLElement>("[data-testid='rail-space']:not([data-page])")) {
        const id = other.dataset["groupId"];
        if (id === undefined || id === groupId) continue;
        const box = other.getBoundingClientRect();
        const middle = box.top + box.height / 2;
        const distance = Math.abs(ev.clientY - middle);
        if (target === null || distance < target.distance) target = { id, after: ev.clientY > middle, distance };
      }
      if (target === null) return;
      const snapshot = useAppStore.getState().snapshot;
      if (snapshot === null) return;
      const index = railMoveIndex(dayUnitsOf(snapshot), groupId, target.id, target.after);
      if (index !== null) void useAppStore.getState().tabGroupCommand({ type: "move", groupId, index });
    };
    const onUp = (ev: PointerEvent): void => finish(ev);
    const onCancel = (): void => finish(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    live.current = stop;
  };
  return { ...state, press, justMoved: (groupId) => carried.current === groupId };
}
