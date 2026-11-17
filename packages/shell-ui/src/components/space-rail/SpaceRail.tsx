import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { House, MoonStar, Plus } from "lucide-react";
import { canMergeSpaces, tabGroupTitle } from "@pistachio/shell-contracts/tab-groups";
import { ChromeRegion } from "../../chrome/manifest-renderers";
import { useShelfDrag } from "../../chrome/shelf-drag";
import { awayTileCount, awayTileLabel } from "../../lib/away-spaces";
import { anchorOf, useDeskChrome, type DeskAnchor } from "../../lib/desk/chrome";
import { useGroupContexts } from "../../lib/desk/group-context";
import { NEW_SPACE_EVENT, newSpace, selectSpace } from "../../lib/desk/open";
import { groupPageOf } from "../../lib/desk/store";
import { markLine, marksFor, marksLabel } from "../../lib/extensions/shown";
import { useExtensionsState } from "../../lib/extensions/use-extensions";
import { sharedSpace } from "../../lib/live/entries";
import { useLiveShare } from "../../lib/live/store";
import { useAppStore } from "../../store";
import { useContextMenu } from "../ContextMenu";
import { RailNowPlaying } from "../desk/DeskNowPlaying";
import { LiveMark, liveMarkLabel } from "../live/LiveMark";
import { DeskMoreButton, DeskRailToggle } from "../desk/DeskSidebarControls";
import { Ledge } from "../extensions/Ledge";
import { SidebarRailContext } from "../sidebar-rail";
import { FaviconCluster, type ClusterTab } from "../TabGroupRow";
import { SPACE_AGENT_LABELS, type SpaceAgentState } from "@pistachio/shell-contracts/desk-agent";
import type { ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { chooseHome } from "./actions";
import { bounceRailItem, railTileOf } from "./bounce";
import { renameSpace } from "./column-state";
import {
  dayUnitsOf,
  HOME_VIEW,
  isHomeSpace,
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
import { RAIL_CARD_DELAY_MS, RailSpaceCard } from "./RailSpaceCard";
import { useSpaceMenu } from "./space-menu";

/** A press this far along the rail is a tile carried, not a click. */
const MOVE_START_PX = 5;

/** A space's window count, as its tile and its card say it. */
function windowsLabel(count: number): string {
  return count === 0 ? "No windows" : `${String(count)} ${count === 1 ? "window" : "windows"}`;
}

/**
 * The double sidebar's rail (docs/double-sidebar.md §1): 56px on the
 * window's own ground, top to bottom Home, a hairline, every rail space as a
 * tile — its mark (TabGroupRow's FaviconCluster, a size up, on its colour)
 * with its count on the corner past four tabs — scrolling without a scrollbar when they
 * outgrow it, and at the foot — while any space is away — the Away tile
 * (docs/primitives.md §2), then New space and the Profile's menu. On the rail
 * alone (SidebarMode "rail") its head holds the button that brings the card
 * back and the desk's ⋯, where the traffic lights were (main hides them),
 * and background media is the desk's now playing.
 *
 * It decides nothing about the card: the chosen item (`view`) sits on the
 * card's tab, which the column draws round whatever box the tile has here
 * (`data-rail-key`), so the rail only lays its items out and says when
 * they move (`onLayout`). Its tiles, Home and New space take a row, a
 * favorite or a pin let go on them (`data-rail-drop`, chrome/shelf-drag.tsx,
 * which draws what it carries as a tile over the rail) — and so does its
 * ground, anywhere on it that is no item of it, as New space does (since
 * 2026-10-26; New space lights for it) — and a tile carried onto another
 * merges the two spaces (useRailMove).
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
  // The space shared live wears the live mark (docs/live-share.md §1): its tile, or Home for a Home tab's.
  const shared = useLiveShare(sharedSpace);
  const guests = useLiveShare((state) => state.participants.length);
  const homeShared = useAppStore((state) => shared !== null && isHomeSpace(shared, state.snapshot));
  // What the agent has going in the spaces nobody is looking at (docs/desk-agent.md §3, "Conversations stay in their
  // space"): the space in front says it at its nub, so its own tile says nothing.
  const agents = useAppStore((state) => state.snapshot?.spaceAgents);
  const homeAgent = useAppStore((state) => homeAgentOf(state.snapshot));
  const liveNote = ` · ${liveMarkLabel(guests)}`;
  // The spaces that are away: none of them a tile here — one mark for them all, at the foot, while there are any.
  const awayCount = useAppStore((state) => state.snapshot?.awaySpaces?.length ?? 0);
  // The marks extensions put on spaces' tiles (docs/primitives.md §4), and the order the extensions stand in: a tile
  // draws the first of its marks, and says every one.
  const spaceMarks = useExtensionsState((state) => state.snapshot.spaceMarks);
  const extensions = useExtensionsState((state) => state.snapshot.extensions);
  const mergingInto = moving.carry?.kind === "merge" ? moving.carry.into : null;
  /** A carried tile's own place: following the pointer (a hair larger, or shrunk over a tile it would merge into), or on its way where it was let go. */
  const carriedStyle = (): CSSProperties =>
    moving.settling === "merge"
      ? { translate: `0 ${String(moving.settleDy)}px`, scale: "0.4", opacity: 0 }
      : moving.settling === "move"
        ? { translate: `0 ${String(moving.settleDy)}px` }
        : { translate: `0 ${String(moving.dy)}px`, scale: mergingInto !== null ? "0.72" : "1.06" };

  // The tile the pointer rests on: its card (RailSpaceCard) comes up beside it a moment later, and goes as the pointer
  // leaves, presses or opens its menu. (It took the place of the tile's tooltip, 2026-10-21.)
  const [card, setCard] = useState<{ groupId: string; anchor: DeskAnchor } | null>(null);
  const cardTimer = useRef<number | null>(null);
  const restOn = (groupId: string, el: HTMLElement): void => {
    if (cardTimer.current !== null) window.clearTimeout(cardTimer.current);
    cardTimer.current = window.setTimeout(() => {
      cardTimer.current = null;
      setCard({ groupId, anchor: anchorOf(el) });
    }, RAIL_CARD_DELAY_MS);
  };
  const leaveCard = (): void => {
    if (cardTimer.current !== null) window.clearTimeout(cardTimer.current);
    cardTimer.current = null;
    setCard(null);
  };
  useEffect(
    () => () => {
      if (cardTimer.current !== null) window.clearTimeout(cardTimer.current);
    },
    [],
  );
  // (None while a tile is carried, or anything is dragged over the rail.)
  const cardSpace = card === null || moving.id !== null || drag !== null ? null : (spaces.find((space) => space.group.id === card.groupId) ?? null);

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
        aria-label={`Home${homeShared ? liveNote : ""}${view !== HOME_VIEW && homeAgent !== null ? `, ${SPACE_AGENT_LABELS[homeAgent]}` : ""}`}
        aria-current={view === HOME_VIEW ? "true" : undefined}
        title={homeShared ? `Home${liveNote}` : "Home"}
        data-live={homeShared ? "" : undefined}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void chooseHome()}
        className="space-rail-home no-drag"
      >
        <House aria-hidden="true" />
        {homeShared ? <LiveMark /> : null}
        {view !== HOME_VIEW && homeAgent !== null ? <AgentMark state={homeAgent} /> : null}
      </button>
      <span className="space-rail-rule" aria-hidden="true" />
      {/* (Out of the window's drag region, as the single sidebar's list was: a press between its tiles is the list's.) */}
      <div ref={listRef} data-testid="space-rail-list" className="space-rail-list no-drag" onScroll={onLayout}>
        {spaces.map((space) => {
          const members = tabsOf(space);
          const name = nameOf(space, members);
          const count = members.length;
          const windows = windowsLabel(count);
          const stack = count === 0 ? (contexts.find((context) => context.groupId === space.group.id)?.items.length ?? 0) : 0;
          const live = shared === space.group.id;
          const marks = marksFor(spaceMarks, extensions, space.group.id);
          const mark = marks[0];
          const agent = view === space.group.id ? undefined : agents?.[space.group.id];
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
              data-live={live ? "" : undefined}
              data-agent={agent}
              aria-label={`${name}, ${windows}${live ? liveNote : ""}${agent === undefined ? "" : `, ${SPACE_AGENT_LABELS[agent]}`}${marksLabel(marks)}`}
              aria-current={view === space.group.id ? "true" : undefined}
              style={
                moving.id === space.group.id
                  ? carriedStyle()
                  : moving.shifts.has(space.group.id)
                    ? { transform: `translateY(${String(moving.shifts.get(space.group.id))}px)` }
                    : undefined
              }
              onMouseDown={(event) => event.preventDefault()}
              onPointerEnter={(event) => {
                if (event.buttons === 0) restOn(space.group.id, event.currentTarget);
              }}
              onPointerLeave={leaveCard}
              onPointerDown={(event) => {
                leaveCard();
                if (!space.page) moving.press(space.group.id, event);
              }}
              onClick={() => {
                if (moving.justMoved(space.group.id)) return;
                selectSpace(space.group.id);
              }}
              onDoubleClick={() => renameSpace(space.group.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                leaveCard();
                menu.open(event, spaceMenu(space));
              }}
              className="space-rail-tile tab-group-tone no-drag"
            >
              <FaviconCluster tabs={members} stack={stack} />
              {live ? <LiveMark /> : null}
              {agent === undefined ? null : <AgentMark state={agent} />}
              {/* An extension's mark, drawn by the shell at the corner the live mark is not in: a glyph, or a dot, in its
                  tone. What it means is the tile's name and its card's line — the extension's words inside the shell's. */}
              {mark === undefined ? null : (
                <span
                  aria-hidden="true"
                  data-testid="rail-space-mark"
                  data-extension-id={mark.extensionId}
                  data-tone={mark.tone}
                  data-dot={mark.glyph === null ? "" : undefined}
                  className="space-rail-mark"
                >
                  {mark.glyph}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="space-rail-foot">
        {railOnly ? <RailNowPlaying /> : null}
        {/* The Ledge on the rail alone (docs/extensions.md X9): a short column of the first pinned extensions and its ⋯,
            above New space. Beside the card, the card's foot holds it. */}
        {railOnly ? <Ledge variant="rail" /> : null}
        {awayCount > 0 ? <AwayTile count={awayCount} /> : null}
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
      {cardSpace !== null && card !== null ? (
        <RailSpaceCard
          key={cardSpace.group.id}
          group={cardSpace.group}
          name={nameOf(cardSpace, tabsOf(cardSpace))}
          windows={windowsLabel(tabsOf(cardSpace).length)}
          marks={marksFor(spaceMarks, extensions, cardSpace.group.id).map(markLine)}
          anchor={card.anchor}
        />
      ) : null}
    </nav>
  );
}

/**
 * The rail's Away tile (docs/primitives.md §2): there only while a space is
 * away, a quiet mark with how many are — never a space's tile, so nothing is
 * carried onto it and the card's tab never sits on it. A press opens the
 * card that lists them, beside it over the desk (AwayCard, a desk side card:
 * lib/desk/chrome.ts), and another puts it away; from the keyboard the
 * card's first Bring back takes it.
 */
/** What the agent has going in Home's spaces (each Home tab's own, a favorite's or a pin's page's): the most pressing of them. */
function homeAgentOf(snapshot: ShellSnapshot | null): SpaceAgentState | null {
  const agents = snapshot?.spaceAgents;
  if (agents === undefined) return null;
  let found: SpaceAgentState | null = null;
  for (const [groupId, state] of Object.entries(agents)) {
    if (!isHomeSpace(groupId, snapshot)) continue;
    if (state === "asking") return state;
    if (state === "working" || found === null) found = state;
  }
  return found;
}

/**
 * The agent's mark on a space's tile, while the person is in another: a ring
 * turning while a turn runs there, a dot once it waits on them (amber) or has
 * answered (green). What it means is the tile's name.
 */
function AgentMark({ state }: { state: SpaceAgentState }) {
  return <span aria-hidden="true" data-testid="rail-space-agent" data-state={state} className="space-rail-agent" />;
}

function AwayTile({ count }: { count: number }) {
  const open = useDeskChrome((state) => state.card?.kind === "away");
  const ref = useRef<HTMLButtonElement>(null);
  const label = awayTileLabel(count);
  return (
    <button
      ref={ref}
      type="button"
      data-testid="rail-away"
      data-count={count}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={label}
      // A press leaves the keyboard where it was (a window's page).
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        const el = ref.current;
        if (el === null) return;
        const chrome = useDeskChrome.getState();
        if (chrome.card?.kind === "away") chrome.closeCard("away");
        else chrome.openCard({ kind: "away", anchor: anchorOf(el), pinned: true });
      }}
      className="space-rail-away no-drag"
    >
      <MoonStar aria-hidden="true" />
      <span className="space-rail-away-count" aria-hidden="true">
        {awayTileCount(count)}
      </span>
    </button>
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
