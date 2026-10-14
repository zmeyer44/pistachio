import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { House, Plus } from "lucide-react";
import { canMergeSpaces, tabGroupTitle } from "@pistachio/shell-contracts/tab-groups";
import { ChromeRegion } from "../../chrome/manifest-renderers";
import { useShelfDrag } from "../../chrome/shelf-drag";
import { useDeskChrome } from "../../lib/desk/chrome";
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
import { bounceRailItem, railTileOf } from "./bounce";
import { renameSpace } from "./column-state";
import {
  dayUnitsOf,
  HOME_VIEW,
  railCarryAt,
  railCarryHome,
  railCarryShifts,
  railCarryTarget,
  railMoveIndex,
  type ColumnView,
  type RailCarry,
  type RailCarryTile,
  type RailSpace,
} from "./rail-model";
import { useSpaceMenu } from "./space-menu";

/** A press this far along the rail is a tile carried, not a click. */
const MOVE_START_PX = 5;

/**
 * The double sidebar's rail (docs/double-sidebar.md §1): 56px on the
 * window's own ground, top to bottom Home, a hairline, every rail space as a
 * tile — its mark (TabGroupRow's FaviconCluster, a size up, on its colour)
 * with its count on the corner past four tabs — scrolling without a scrollbar when they
 * outgrow it, and at the foot New space and the Profile's menu. On the rail
 * alone (SidebarMode "rail") its head holds the button that brings the card
 * back and the desk's ⋯, where the traffic lights were (main hides them),
 * and background media is the desk's now playing.
 *
 * It decides nothing about the card: the chosen item (`view`) sits on the
 * card's tab, which the column draws round whatever box the tile has here
 * (`data-rail-key`), so the rail only lays its items out and says when
 * they move (`onLayout`). Its tiles, Home and New space take a row, a
 * favorite or a pin let go on them (`data-rail-drop`, chrome/shelf-drag.tsx,
 * which draws what it carries as a tile over the rail), and a tile carried
 * onto another merges the two spaces (useRailMove).
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
  // A desk window carried over the rail lights what it would go into, as a row does (lib/desk/chrome.ts: the drag
  // layer holds the pointer then, and the rail hears no hover of its own).
  const deskDrop = useDeskChrome((state) => (state.dockDrop !== null && state.dockDrop.item !== "card" ? state.dockDrop : null));
  const moving = useRailMove(spaces.map((space) => space.group.id).join(" "));
  const mergingInto = moving.carry?.kind === "merge" ? moving.carry.into : null;
  /** A carried tile's own place: following the pointer (a hair larger, or shrunk over a tile it would merge into), or on its way where it was let go. */
  const carriedStyle = (): CSSProperties =>
    moving.settling === "merge"
      ? { translate: `0 ${String(moving.settleDy)}px`, scale: "0.4", opacity: 0 }
      : moving.settling === "move"
        ? { translate: `0 ${String(moving.settleDy)}px` }
        : { translate: `0 ${String(moving.dy)}px`, scale: mergingInto !== null ? "0.72" : "1.06" };

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
        data-dropping={railDrop?.target === "home" || deskDrop?.item === "home" ? "" : undefined}
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
              data-dropping={
                (railDrop?.target === "space" && railDrop.groupId === space.group.id) ||
                (deskDrop?.item === "space" && deskDrop.groupId === space.group.id) ||
                mergingInto === space.group.id
                  ? ""
                  : undefined
              }
              data-merging={mergingInto === space.group.id ? "" : undefined}
              data-moving={moving.id === space.group.id && moving.settling === null ? "" : undefined}
              data-settling={moving.id === space.group.id && moving.settling !== null ? moving.settling : undefined}
              aria-label={`${name}, ${windows}`}
              aria-current={view === space.group.id ? "true" : undefined}
              title={`${name} · ${windows}`}
              style={
                moving.id === space.group.id
                  ? carriedStyle()
                  : moving.shifts.has(space.group.id)
                    ? { transform: `translateY(${String(moving.shifts.get(space.group.id))}px)` }
                    : undefined
              }
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
          data-dropping={railDrop?.target === "new" || deskDrop?.item === "new" ? "" : undefined}
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

/** What a carry of a space's tile says to draw: the tile carried and where, the gap it would land in, the tile it would merge into. */
interface RailCarryView {
  /** The tile carried, or settling where it was let go. */
  id: string | null;
  /** How far the pointer has carried it, px down. */
  dy: number;
  /** What a release would do. */
  carry: RailCarry;
  /** The drawn tiles drawn out of their places, the gap opened (railCarryShifts), px down. */
  shifts: ReadonlyMap<string, number>;
  /**
   * Let go: on its way to its new place while main moves it ("move": held
   * there, the gap kept, until the rail's order changes), or settling onto
   * the tile it merges into ("merge": shrunk into it, until it is gone).
   */
  settling: "move" | "merge" | null;
  /** The settling tile's way to where it goes, px down from its place. */
  settleDy: number;
}

const IDLE: RailCarryView = { id: null, dy: 0, carry: null, shifts: new Map(), settling: null, settleDy: 0 };

/** A carry let go waits this long for main's new order (or the merge) before the rail lets go of it. */
const CARRY_SETTLE_MS = 1_200;
/** How long a tile settles onto the one it merges into before the merge is asked for (the shrink's length). */
const MERGE_SETTLE_MS = 180;
/** How far left or right of the rail the pointer may stray with a tile and still be carrying it somewhere. */
const CARRY_SIDE_SLACK = 20;

/**
 * A space's tile carried along the rail (2026-10-14; until then only
 * moved): it follows the pointer up and down, a hair larger, over the others.
 * Over another tile's middle (railCarryAt) that tile lights as the space it
 * would merge into, and the carried tile shrinks to go into it; let go there,
 * it settles onto it (shrinking away) and the two spaces are one — main's
 * `merge`: every tab of the carried space joins the other at its end, its
 * Stack with them, and the other keeps its name and colour; a page's space
 * takes a merge too. Between tiles (or over a tile's top or foot) the drawn
 * tiles part to open the gap it would land in (railCarryShifts), and let go
 * there it moves its space to that place among the day's units (main's
 * `move`), gliding into the gap while main moves it. Anywhere else — far
 * from the tiles, off the rail — it goes back. A page's space has no place
 * in the row to move to, and its tile is not carried.
 *
 * Each press is its own gesture: the click its release makes on the tile it
 * carried chooses nothing (`justMoved`, for that tile and only until that
 * click — a task later it is forgotten), and its window listeners go with the
 * rail if it goes mid-carry. (Until 2026-10-13 one flag served every tile, and
 * a page's tile, never pressed, never cleared it: its next click was lost.)
 */
function useRailMove(order: string): RailCarryView & {
  press(groupId: string, event: React.PointerEvent<HTMLElement>): void;
  justMoved(groupId: string): boolean;
} {
  const [view, setView] = useState<RailCarryView>(IDLE);
  /** The tile a carry has just been let go on. */
  const carried = useRef<string | null>(null);
  /** The live carry's listeners, to take away. */
  const live = useRef<(() => void) | null>(null);
  /** A carry let go: the rail's order it was let go on, and its timers. */
  const settle = useRef<{ order: string; timers: number[]; list: HTMLElement | null; into: string | null } | null>(null);
  const clearSettle = (): void => {
    for (const timer of settle.current?.timers ?? []) window.clearTimeout(timer);
    settle.current = null;
  };
  useEffect(
    () => () => {
      live.current?.();
      for (const timer of settle.current?.timers ?? []) window.clearTimeout(timer);
    },
    [],
  );
  // Main's new order (or the merged space gone) is in: the tiles stand in their new places with no shift, at once —
  // their transitions held for the frame (`data-snap`), or they would glide from the gap to where they already are.
  useLayoutEffect(() => {
    const done = settle.current;
    if (done === null || done.order === order) return;
    clearSettle();
    const tiles = done.list === null ? [] : [...done.list.querySelectorAll<HTMLElement>("[data-testid='rail-space']")];
    for (const tile of tiles) tile.dataset["snap"] = "";
    setView(IDLE);
    requestAnimationFrame(() => {
      for (const tile of tiles) delete tile.dataset["snap"];
    });
    if (done.into !== null) bounceRailItem(railTileOf(done.into));
  }, [order]);

  const press = (groupId: string, event: React.PointerEvent<HTMLElement>): void => {
    live.current?.();
    if (event.button !== 0 || settle.current !== null) return;
    const tile = event.currentTarget;
    const list = tile.parentElement;
    if (list === null) return;
    const startY = event.clientY;
    const rail = list.closest<HTMLElement>("[data-testid='space-rail']");
    // The tiles at rest, in the list's own coordinates (its content's: a scroll mid-carry moves them all alike).
    const listTop = list.getBoundingClientRect().top;
    const startScroll = list.scrollTop;
    const tiles: RailCarryTile[] = [...list.querySelectorAll<HTMLElement>("[data-testid='rail-space']")].map((el) => {
      const box = el.getBoundingClientRect();
      return { id: el.dataset["groupId"] ?? "", top: box.top - listTop + startScroll, bottom: box.bottom - listTop + startScroll, page: el.dataset["page"] !== undefined };
    });
    const own = tiles.find((candidate) => candidate.id === groupId);
    if (own === undefined) return;
    const home = railCarryHome(tiles, groupId);
    let moving = false;
    const carryAt = (ev: PointerEvent): RailCarryView => {
      const scroll = list.scrollTop;
      const span = list.getBoundingClientRect();
      const side = rail?.getBoundingClientRect() ?? span;
      const off = ev.clientX < side.left - CARRY_SIDE_SLACK || ev.clientX > side.right + CARRY_SIDE_SLACK;
      const y = ev.clientY - span.top + scroll;
      let carry = off ? null : railCarryAt(tiles, groupId, y, { top: scroll, bottom: scroll + list.clientHeight });
      // (Its own place is no move; a merge only where main would take it.)
      if (carry?.kind === "move" && carry.slot === home) carry = null;
      if (carry?.kind === "merge" && !mergeable(groupId, carry.into)) carry = null;
      return { id: groupId, dy: ev.clientY - startY + (scroll - startScroll), carry, shifts: railCarryShifts(tiles, groupId, carry), settling: null, settleDy: 0 };
    };
    const onMove = (ev: PointerEvent): void => {
      if (!moving && Math.abs(ev.clientY - startY) < MOVE_START_PX) return;
      moving = true;
      setView(carryAt(ev));
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (live.current === stop) live.current = null;
    };
    const finish = (ev: PointerEvent | null): void => {
      stop();
      if (!moving || ev === null) {
        setView(IDLE);
        return;
      }
      // The click this release makes comes in this same task: it is the carry's, not a choice.
      carried.current = groupId;
      window.setTimeout(() => {
        if (carried.current === groupId) carried.current = null;
      }, 0);
      const at = carryAt(ev);
      const carry = at.carry;
      const snapshot = useAppStore.getState().snapshot;
      if (carry === null || snapshot === null) {
        // Back to its place (the tile's own transition takes it there).
        setView(IDLE);
        return;
      }
      const timers: number[] = [];
      settle.current = { order, timers, list, into: null };
      // Nothing came of it in time (refused, or an order that came back the same): the rail lets go, the tiles glide home.
      timers.push(
        window.setTimeout(() => {
          if (settle.current?.timers !== timers) return;
          clearSettle();
          setView(IDLE);
        }, CARRY_SETTLE_MS),
      );
      if (carry.kind === "merge") {
        const into = tiles.find((candidate) => candidate.id === carry.into);
        settle.current.into = carry.into;
        setView({ ...at, carry, shifts: new Map(), settling: "merge", settleDy: into === undefined ? 0 : into.top - own.top });
        const merge = (): void => void useAppStore.getState().tabGroupCommand({ type: "merge", groupId, into: carry.into });
        if (reducedMotion()) merge();
        else timers.push(window.setTimeout(merge, MERGE_SETTLE_MS));
        return;
      }
      const target = railCarryTarget(tiles, groupId, carry.slot);
      const index = target === null ? null : railMoveIndex(dayUnitsOf(snapshot), groupId, target.targetId, target.after);
      if (index === null) {
        clearSettle();
        setView(IDLE);
        return;
      }
      setView({ ...at, settling: "move", settleDy: at.shifts.get(groupId) ?? 0 });
      void useAppStore.getState().tabGroupCommand({ type: "move", groupId, index });
    };
    const onUp = (ev: PointerEvent): void => finish(ev);
    const onCancel = (): void => finish(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    live.current = stop;
  };
  return { ...view, press, justMoved: (groupId) => carried.current === groupId };
}

/** Whether main would merge the space `groupId` into `into` (canMergeSpaces, over the snapshot's spaces). */
function mergeable(groupId: string, into: string): boolean {
  const snapshot = useAppStore.getState().snapshot;
  const groups = [...(snapshot?.tabGroups ?? []), ...(snapshot?.anchorGroups ?? [])];
  return canMergeSpaces(snapshot?.tabGroups.find((group) => group.id === groupId), groups.find((group) => group.id === into));
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
