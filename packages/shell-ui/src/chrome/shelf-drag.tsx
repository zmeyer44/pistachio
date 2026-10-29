/**
 * One drag surface for the whole sidebar shelf: the favorites grid, the
 * pinned tree (folders and pins), and the day's tabs. Any of them can be
 * picked up and dropped in any of the others — a day tab dragged above the
 * "New tab" row becomes a pin, a pin dragged into a folder joins it, a pin
 * dropped on the grid becomes a favorite, a favorite dragged into the list
 * becomes a pin or a day tab — and a row with one live page dragged RIGHT
 * over the page offers a live split preview (chrome/drag-geometry.ts).
 *
 * The grid and the list are separate manifest features rendered into
 * separate regions of the column (chrome/manifest.ts), so neither can own
 * the gesture: the column's host (components/SidebarChrome.tsx, on the
 * desktop components/space-rail/SpaceColumn.tsx) mounts
 * `ShelfDragProvider`, and each feature registers the box it draws into and
 * reads the drag through `useShelfDrag()`.
 *
 * Geometry is lib/sidebar-tree.ts (pure, tested). This file is the gesture
 * over it: the pointer, the per-frame drop, the dragged element's
 * transform, the FLIP of everything else, and the commit — one
 * SidebarCommand (@pistachio/shell-contracts/sidebar) or one tab reorder / split.
 *
 * Two clocks run during a gesture. The POINTER moves every frame: both
 * sources (the window's own pointermove and the drag layer's relayed
 * samples) are coalesced onto one animation frame, and that frame writes the
 * dragged element's transform and the layer's ghost directly — no React. The
 * LAYOUT changes only when the drop, the split zone, or the lifted flag does:
 * that is the `ShelfDrag` the grid and the list render from, and it is the
 * only thing that reaches `setDrag`.
 *
 * While a drag is live the transparent drag layer holds the pointer above the
 * tab views. Those views stay live and reflow into the proposed layout while
 * the layer paints the small tab ghost above them. The layer takes over the
 * drawing the moment the dragged element's box would cross the column's
 * edge — the column clips there and the tab views paint over anything past
 * it — and keeps it for the rest of the gesture, so a row lifted toward the
 * page is never cut off at the column while the pointer is still inside it.
 *
 * Over the double sidebar's rail (since 2026-10-14) what is carried is drawn
 * as what it would be there: a space's tile — the rail's own 38px, its icon
 * on the tint of the space it would go into, the same face a desk window
 * carried over the rail wears (DeskWindow's DockFace, shell.css's
 * `.desk-window-face`) — following the pointer above the rail, grown out of
 * the row or tile it was and shrinking back into it over the card (the
 * token: `RailToken`); its source waits in its slot, dimmed. Let go on an
 * item, the token goes into it and the item bounces. (Until then a row
 * waited in its slot with no token, and a favorite's tile, following the
 * pointer, painted under the rail: "it doesn't look great".)
 */

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ContentBounds } from "@pistachio/shell-contracts/ipc";
import { entryPageOf, type SidebarCommand } from "@pistachio/shell-contracts/sidebar";
import { favoriteDropAt, GROUP_END, listDropAt, spaceDropAt, type ListDrop, type MeasuredRow, type MeasuredTile, type ShelfDragKind } from "../lib/sidebar-tree";
import { useAppStore } from "../store";
import { Favicon } from "../components/Favicon";
import { bounceRailItem } from "../components/space-rail/bounce";
import { grownByDrop } from "../components/space-rail/flights";
import { fullUnitIndex, railTargetAt, roomForSpace } from "../components/space-rail/rail-model";
import { DOCK_TILE } from "../lib/desk/dock-drop";
import { displayHost, prettyUrl } from "../lib/url";
import { splitZoneAt, type PointerLike, type SplitZone } from "./drag-geometry";
import { dayUnitsInHand, unitIndexAfter, type ChromeTab } from "./tabs";
import { nativeApi } from "../api";
import { bringOutJoined, deskAvailable, deskEngine, dropEntryOnDesk, dropTabOnDesk, splitAvailable } from "../lib/desk/open";

/** Anything on the shelf a drag can carry, with what the ghost draws. */
export interface ShelfItem {
  /** The element's data-flip-id, wherever it is drawn (a tile in the grid, a row in the list). */
  flipId: string;
  kind: ShelfDragKind;
  /** The pin's, folder's, or favorite's shelf id; a tab row's item id; a tab group's unit id (`group:<id>`). */
  entityId: string;
  /** A tab group's own id, when that is what is carried. */
  groupId?: string;
  title: string;
  url: string;
  faviconUrl: string | null;
  /** The live tabs it carries: one for a tab or an open pin/favorite, two for a split, none for a closed entry or a folder. */
  tabs: ChromeTab[];
  /** An organization preset: opened, never moved. */
  managed?: boolean;
  /** Carried out over a desk, this tab's window (as a tab's row is): a favorite's or a pin's open page. */
  deskTab?: ChromeTab;
}

/**
 * A row let go on the double sidebar's rail (docs/double-sidebar.md §1): on a
 * space's tile it joins that space (`space`, its id), on Home it leaves its
 * space and is a Home tab, on New space — or on the rail's own ground,
 * anywhere on it that is no item of it (since 2026-10-26) — it makes a space
 * of its own; a favorite or a pin a space of its page (since 2026-10-14).
 * `null`: over the rail, but on nothing that would take it (a space it is in
 * already, Home for a tab that is Home's, a Profile with no room for a
 * space) — let go there it goes nowhere.
 * Meanwhile the row waits in its slot, dimmed (TabList keeps it there,
 * `measureFollow` holds it still), drawn over the rail as a space's tile
 * (`RailToken`), while the rail says where it would go.
 */
export interface RailDrop {
  zone: "rail";
  target: "home" | "new" | "space" | null;
  groupId: string | null;
}

export type ShelfDrop = ListDrop | { zone: "favorites"; index: number } | RailDrop;

/**
 * What the shelf LAYS OUT from while a drag is live. Everything here changes
 * the rows or tiles the grid and the list draw, so a new one means a render;
 * the pointer's position, the grab point, and the source's size do not, and
 * stay inside the gesture (see `beginPress`), written straight onto the
 * dragged element and the layer's ghost every frame.
 */
export interface ShelfDrag {
  item: ShelfItem;
  /** Where a release would put the item — null while it is over the page. */
  drop: ShelfDrop | null;
  /**
   * The pointer has released and the drop is committed, but the shelf has
   * not published it yet: the proposed layout stays up so the rows do not
   * snap back to the old order and then glide forward again. Nothing about
   * the gesture (the grab styling, the follow transform) applies any more.
   */
  settling: boolean;
  /** The pointer is over the page: a release there splits. */
  overContent: boolean;
  /**
   * The drag layer draws the item and the source is transparent: its box
   * has crossed the column's edge, or the pointer is over the page. Sticky
   * for the gesture, so a row hovering at the edge does not flicker between
   * the two drawings.
   */
  lifted: boolean;
  zone: SplitZone | null;
}

interface ShelfDragHost {
  drag: ShelfDrag | null;
  /** Wire to each tile's and row's onPointerDown. */
  beginPress(item: ShelfItem, e: React.PointerEvent<HTMLElement>): void;
  /** True once a press turned into a drag: the click that ends it must not open anything. */
  justDragged(): boolean;
  /** The favorites grid registers its box here (the tiles are its `[data-flip-id]` children). */
  gridRef: React.RefObject<HTMLDivElement | null>;
  /** The double sidebar's rail registers its box here: its Home, its tiles and its New space (`[data-rail-drop]`) take drops. */
  railRef: React.RefObject<HTMLElement | null>;
  /** The list registers its scroller (auto-scroll near the edges) … */
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  /** … and the positioned block inside it that rows are laid out against. */
  listRef: React.RefObject<HTMLDivElement | null>;
}

const ShelfDragContext = createContext<ShelfDragHost | null>(null);

export function useShelfDrag(): ShelfDragHost {
  const host = useContext(ShelfDragContext);
  if (host === null) throw new Error("useShelfDrag() needs a <ShelfDragProvider> above it");
  return host;
}

/** The divider row's flip id — the "New tab" row between the pinned section and the day's tabs. */
export const SHELF_DIVIDER_FLIP_ID = "__new-tab";

const DRAG_START_PX = 5;
const SETTLE_EASING = "cubic-bezier(0.22, 0.9, 0.26, 1)";
/** How long a committed drop's proposed layout may wait for main to publish it before the shelf's own order takes over. */
const SETTLE_TIMEOUT_MS = 1_000;
/** The list's horizontal padding (px-2): PIN_INDENT is measured from inside it. */
const LIST_PAD = 8;
/** On a desk, a tab's row carried this far past the column's edge is over the desk. */
const DESK_EDGE_PX = 2;
/** Within this many px of the scroller's edge the list scrolls under the drag. */
const AUTO_SCROLL_EDGE = 28;
const AUTO_SCROLL_STEP = 8;
/** What is carried, waiting in its slot while it is over the rail (drawn there as the token): dimmed, its place kept. */
const WAIT_OPACITY = "0.4";
/** The token going into the item it was let go on, and when that item bounces (as it takes it). */
const TOKEN_LAND_MS = 200;
const TOKEN_BOUNCE_AT_MS = 130;
const HOUSE_EASING = "cubic-bezier(0.2, 0.8, 0.3, 1)";

/** A box, px from the pointer: where the token's face is drawn. */
interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The token as a rail tile: the rail's 38px, centred on the pointer (lib/desk/dock-drop.ts's DOCK_TILE, a carried window's). */
const TILE_FACE: FaceBox = { x: -DOCK_TILE / 2, y: -DOCK_TILE / 2, w: DOCK_TILE, h: DOCK_TILE };

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function writeFace(face: HTMLElement, box: FaceBox, shape: "row" | "tile"): void {
  face.style.left = `${String(box.x)}px`;
  face.style.top = `${String(box.y)}px`;
  face.style.width = `${String(box.w)}px`;
  face.style.height = `${String(box.h)}px`;
  face.dataset["shape"] = shape;
}
interface FlipPosition {
  parent: Element | null;
  x: number;
  y: number;
}

/** Every flip element's layout position under `root`, by flip id. */
function readFlipPositions(root: HTMLElement): Map<string, FlipPosition> {
  const positions = new Map<string, FlipPosition>();
  for (const el of root.querySelectorAll<HTMLElement>("[data-flip-id]")) {
    const id = el.dataset["flipId"];
    if (id === undefined) continue;
    positions.set(id, { parent: el.offsetParent, x: el.offsetLeft, y: el.offsetTop });
  }
  return positions;
}

/**
 * FLIP for the shelf: whenever rows or tiles move, glide each from its
 * previous layout position to its new one — in BOTH axes, since tiles
 * reflow across the grid. Positions are layout offsets within each
 * element's own offsetParent, so scrolling the list between renders is not
 * a move; an element whose parent changed (a tile that became a row) just
 * appears in place. `skipId` is the dragged element, which the pointer
 * positions.
 *
 * The shelf's layout changes when `layoutKey` does — the proposed drop the
 * grid and the list draw — so that is when positions are re-read and
 * compared, not on every render of the provider. Returns `prime`, which
 * re-reads the positions WITHOUT animating: a drag calls it as it begins, so
 * rows that moved for other reasons since the last drag (a tab closed, a
 * folder folded) do not glide from where they used to be.
 */
function useShelfFlip(rootRef: React.RefObject<HTMLElement | null>, skipId: string | null, layoutKey: string): () => void {
  const positions = useRef(new Map<string, FlipPosition>());
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const prev = positions.current;
    const next = new Map<string, FlipPosition>();
    for (const el of root.querySelectorAll<HTMLElement>("[data-flip-id]")) {
      const id = el.dataset["flipId"];
      if (id === undefined) continue;
      const pos: FlipPosition = { parent: el.offsetParent, x: el.offsetLeft, y: el.offsetTop };
      next.set(id, pos);
      if (id === skipId) continue;
      const p = prev.get(id);
      if (p === undefined || p.parent !== pos.parent) {
        if (prev.size > 0) {
          el.animate(
            [
              { opacity: 0, transform: "scale(0.96)" },
              { opacity: 1, transform: "scale(1)" },
            ],
            { duration: 160, easing: "ease-out" },
          );
        }
        continue;
      }
      const dx = p.x - pos.x;
      const dy = p.y - pos.y;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], {
        duration: skipId === null ? 280 : 190,
        easing: SETTLE_EASING,
      });
    }
    positions.current = next;
  }, [rootRef, skipId, layoutKey]);
  return useCallback(() => {
    const root = rootRef.current;
    if (root !== null) positions.current = readFlipPositions(root);
  }, [rootRef]);
}

/**
 * An element's top within the list. A tab group's rows are laid out against
 * the group's own box, not the list's, so their offsetTop alone is not in the
 * other rows' space; the offsets are summed up the offsetParent chain instead
 * (not read off bounding boxes, which a FLIP glide in flight would skew).
 */
function topWithin(el: HTMLElement, list: HTMLElement): number {
  let top = 0;
  let node: HTMLElement | null = el;
  while (node !== null && node !== list) {
    top += node.offsetTop;
    node = node.offsetParent instanceof HTMLElement ? node.offsetParent : null;
  }
  return top;
}

/** The rows of the list as the drag measures them, minus what it carries. */
function measureRows(list: HTMLElement, item: ShelfItem): MeasuredRow[] {
  const rows: MeasuredRow[] = [];
  for (const el of list.querySelectorAll<HTMLElement>("[data-flip-id][data-row-kind]")) {
    if (el.dataset["flipId"] === item.flipId) continue;
    // A group's tabs folding away (TabGroupRow's exit) are already gone as far as a drop is concerned.
    if (el.closest("[data-exiting]") !== null) continue;
    const kind = el.dataset["rowKind"];
    if (kind !== "folder" && kind !== "pin" && kind !== "divider" && kind !== "tab" && kind !== "group" && kind !== "member") continue;
    const folderId = el.dataset["folderId"] ?? null;
    if (item.kind === "folder" && folderId === item.entityId) continue;
    const groupId = el.dataset["groupId"] ?? null;
    // A group in hand carries its tabs: they are not rows to drop among.
    if (item.kind === "group" && groupId !== null && groupId === item.groupId) continue;
    // A group's row is its HEADER; its open tabs are rows of their own below it.
    const box = kind === "group" ? (el.querySelector<HTMLElement>("[data-group-header]") ?? el) : el;
    rows.push({
      kind,
      entityId: el.dataset["entityId"] ?? "",
      folderId: folderId === "" ? null : folderId,
      groupId,
      collapsed: el.dataset["collapsed"] !== undefined,
      top: topWithin(el, list),
      height: box.offsetHeight,
    });
  }
  return rows;
}

/** The person's own tiles (presets are fixed), minus the dragged one, in the grid's space. */
function measureTiles(grid: HTMLElement, item: ShelfItem): MeasuredTile[] {
  const rect = grid.getBoundingClientRect();
  const tiles: MeasuredTile[] = [];
  for (const el of grid.querySelectorAll<HTMLElement>("[data-flip-id]")) {
    if (el.dataset["flipId"] === item.flipId || el.dataset["managed"] !== undefined) continue;
    const box = el.getBoundingClientRect();
    tiles.push({ id: el.dataset["flipId"] ?? "", left: box.left - rect.left, top: box.top - rect.top, width: box.width, height: box.height });
  }
  return tiles;
}

function sameDrop(a: ShelfDrop | null, b: ShelfDrop | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.zone === "rail") return b.zone === "rail" && a.target === b.target && a.groupId === b.groupId;
  if (b.zone === "rail") return false;
  if (a.zone !== b.zone || a.index !== b.index) return false;
  if (a.zone === "group" && b.zone === "group") return a.groupId === b.groupId;
  return a.zone === "pinned" && b.zone === "pinned" ? a.folderId === b.folderId : true;
}

/** Two drags the shelf would lay out identically. */
function sameShelfDrag(a: ShelfDrag, b: ShelfDrag): boolean {
  return (
    a.item === b.item &&
    sameDrop(a.drop, b.drop) &&
    a.zone === b.zone &&
    a.lifted === b.lifted &&
    a.overContent === b.overContent &&
    a.settling === b.settling
  );
}

/** The drag as the shelf lays it out, as a string: what the FLIP re-measures on. */
function layoutKeyOf(drag: ShelfDrag | null): string {
  if (drag === null) return "";
  const drop = drag.drop;
  const at =
    drop === null
      ? "page"
      : drop.zone === "rail"
        ? `rail:${drop.target ?? ""}:${drop.groupId ?? ""}`
        : `${drop.zone}:${drop.index}:${drop.zone === "pinned" ? (drop.folderId ?? "") : drop.zone === "group" ? drop.groupId : ""}`;
  return `${drag.item.flipId}|${at}|${drag.settling ? "settling" : "live"}`;
}

function queryFlip(root: HTMLElement | null, flipId: string): HTMLElement | null {
  return root?.querySelector<HTMLElement>(`[data-flip-id="${CSS.escape(flipId)}"]`) ?? null;
}

/** Where the dragged element is drawn this frame, measured before anything is written. */
interface FollowPlacement {
  target: HTMLElement;
  transformOrigin: string;
  transform: string;
  opacity: string;
  /** The box it is drawn in, viewport px (its slot, moved by `transform`, unscaled). */
  box: { x: number; y: number; w: number; h: number };
}

/** The live gesture's hooks for the provider's commit-time effect. */
interface LiveGesture {
  /** Re-place the dragged element against the layout the shelf just committed. */
  follow(current: ShelfDrag): void;
}

/**
 * `className` places the provider's box, which is the column as far as the
 * drag is concerned (past its trailing edge is the desk): the single
 * sidebar's favorites and list, or the double sidebar's whole column, its
 * rail and its card (components/space-rail/SpaceColumn.tsx).
 */
export function ShelfDragProvider({ children, className = "flex min-h-0 flex-1 flex-col" }: { children: React.ReactNode; className?: string }) {
  const [drag, setDrag] = useState<ShelfDrag | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const tokenRef = useRef<HTMLDivElement>(null);
  const tokenFaceRef = useRef<HTMLDivElement>(null);
  const draggedRef = useRef(false);
  // The page's box, read per frame by the live gesture. Fed by subscription
  // rather than render: the surface reports it on every layout pass, and
  // the provider has nothing to redraw for it.
  const boundsRef = useRef<ContentBounds | null>(useAppStore.getState().contentBounds);
  // Bumped whenever the shelf's DOM may have changed under a live drag — a
  // layout the provider committed, or a change in what the grid and the list
  // render from — so the gesture re-measures rows and tiles then, not on
  // every pointer frame. Only those slices count: every pointer frame writes
  // the store too (the split drop zone), and a Zustand write notifies
  // subscribers even when it changed nothing.
  const layoutEpochRef = useRef(0);
  useEffect(() => {
    boundsRef.current = useAppStore.getState().contentBounds;
    return useAppStore.subscribe((state, previous) => {
      boundsRef.current = state.contentBounds;
      if (
        state.snapshot !== previous.snapshot ||
        state.contentBounds !== previous.contentBounds ||
        state.sidebarWidth !== previous.sidebarWidth ||
        state.settings !== previous.settings ||
        state.media !== previous.media ||
        state.readAloud !== previous.readAloud
      )
        layoutEpochRef.current += 1;
    });
  }, []);

  // The pointer positions the dragged element only while the gesture is live;
  // once it settles, layout owns it like every other row.
  const primeFlip = useShelfFlip(rootRef, drag !== null && !drag.settling ? drag.item.flipId : null, layoutKeyOf(drag));

  // Set by each beginPress and read only while that drag is live. Never
  // cleared here: a render between the press and the first move (a focus
  // change, a snapshot) would otherwise drop it before the drag begins,
  // leaving the source row sitting in its slot for the whole gesture.
  const gestureRef = useRef<LiveGesture | null>(null);

  const elFor = (flipId: string): HTMLElement | null => queryFlip(rootRef.current, flipId);

  const beginPress = (item: ShelfItem, e: React.PointerEvent<HTMLElement>): void => {
    // Every press starts clean, including one that cannot become a drag (a
    // preset tile, a control): the flag is what its click reads, and a flag
    // left over from the last drag would swallow that click.
    draggedRef.current = false;
    if (e.button !== 0 || !(e.target instanceof Element) || item.managed === true) return;
    // Controls own their gestures; a folder mid-rename is an input.
    const control = e.target.closest("button, input");
    if (control instanceof HTMLElement && control.dataset["dragHandle"] === undefined) return;
    const el = elFor(item.flipId);
    if (el === null) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const rect = el.getBoundingClientRect();
    const grabX = startX - rect.left;
    const grabY = startY - rect.top;
    // On a desk the sidebar is its dock: a tab's row carried out over it is
    // its window (`overDesk`), and nothing splits. (The surface's, not the
    // engine's: the engine is null for the first frames of a cold start.)
    const onDesk = deskAvailable();
    const deskTab = !onDesk ? undefined : (item.deskTab ?? (item.kind === "tab" && item.tabs.length === 1 ? item.tabs[0] : undefined));
    // A favorite or pin with no page open is let go over the desk too: a fresh page of it comes out there (dropEntryOnDesk).
    const toDesk = deskTab !== undefined || (onDesk && (item.kind === "favorite" || item.kind === "pin"));
    const canSplit = splitAvailable() && item.kind !== "group" && item.tabs.length === 1 && (useAppStore.getState().snapshot?.visibleTabIds.length ?? 0) < 4;
    const origin = originDrop(item, listRef.current, gridRef.current);
    /** Today's index among the rows it draws, as one among all the day's units (the double sidebar's Home: the spaces between are the rail's). */
    const todayUnits = (index: number): number => {
      const moving = new Set(item.tabs.map((tab) => tab.id));
      return fullUnitIndex(dayUnitsInHand(useAppStore.getState().snapshot, moving), index, (unit) => unit.kind !== "group");
    };
    // A tile moves freely; a row stays in its slot horizontally unless it
    // is being lifted RIGHT toward the page (see `follow`). The ghost the
    // layer draws is held the same way, so the two never disagree.
    const startedInGrid = gridRef.current?.contains(el) === true;
    const clamp = startedInGrid ? undefined : { minLeft: rect.left };
    /**
     * Over the rail what is carried is drawn as a space's tile (`RailToken`), grown out of the row or tile it was and
     * shrunk back into it on the way off — anything the rail could take (a folder waits in its slot, as it always did).
     * `tokenUp`: it is drawn so now; `tokenFollows`: it has been this gesture, and follows the pointer as it fades.
     */
    const tokenFor = item.kind !== "folder" && item.kind !== "group";
    const tokenShape = startedInGrid ? "tile" : "row";
    let tokenUp = false;
    let tokenFollows = false;
    /** The layer's ghost's box (lifted: what is drawn of the item), viewport px. */
    const ghostBox = (ev: PointerLike): FaceBox => ({
      x: clamp === undefined ? ev.clientX - grabX : Math.max(clamp.minLeft, ev.clientX - grabX),
      y: ev.clientY - grabY,
      w: rect.width,
      h: rect.height,
    });
    /** What the shelf lays out from; `setDrag` sees it only when it changes. */
    let state: ShelfDrag | null = null;
    /** The latest pointer sample: the follow transform and the layer's ghost are drawn from it. */
    let pointer: PointerLike = { clientX: startX, clientY: startY };
    /** The layer is drawing the ghost — the last visual sent was not null. */
    let visualShown = false;
    let finished = false;
    let offSample = (): void => {};

    // Rows and tiles are measured against the shelf's layout, which changes
    // when the drop does (the shelf re-renders) — not per pointer frame.
    let rowsCache: { epoch: number; rows: MeasuredRow[] } | null = null;
    let tilesCache: { epoch: number; tiles: MeasuredTile[] } | null = null;
    const rowsOf = (list: HTMLElement): MeasuredRow[] => {
      const epoch = layoutEpochRef.current;
      if (rowsCache === null || rowsCache.epoch !== epoch) rowsCache = { epoch, rows: measureRows(list, item) };
      return rowsCache.rows;
    };
    const tilesOf = (grid: HTMLElement): MeasuredTile[] => {
      const epoch = layoutEpochRef.current;
      if (tilesCache === null || tilesCache.epoch !== epoch) tilesCache = { epoch, tiles: measureTiles(grid, item) };
      return tilesCache.tiles;
    };

    /**
     * The drop under the pointer. `scrollBy` is how far the list is about to
     * scroll this frame (see `autoScrollDelta`): the rows' viewport positions
     * are read as they will be once it has.
     */
    const dropFor = (ev: PointerLike, scrollBy: number): { drop: ShelfDrop | null; overContent: boolean; zone: SplitZone | null } => {
      // The favorites first. (Until 2026-10-13 the old rail's favorites sheet
      // put their grid out over the desk, which a drop there was for: the
      // double sidebar's rail replaced it, and the grid is in the column.)
      const favorites = overFavorites(ev);
      if (favorites !== null) return { drop: favorites, overContent: false, zone: null };
      // The double sidebar's rail, beside the card: its tiles take a row (and only its tiles: between them, nothing).
      const rail = overRail(ev);
      if (rail !== undefined) return { drop: rail, overContent: false, zone: null };
      if (overDesk(ev)) return { drop: null, overContent: true, zone: null };
      const area = boundsRef.current;
      if (canSplit && area !== null && ev.clientX >= area.x) {
        return { drop: null, overContent: true, zone: splitZoneAt(area, ev) };
      }
      const list = listRef.current;
      if (list === null) return { drop: null, overContent: false, zone: null };
      const box = list.getBoundingClientRect();
      const y = ev.clientY - (box.top - scrollBy);
      // A space's view (the double sidebar's card) is that space's rows alone: a drop there is a place among them.
      if (list.dataset["view"] === "space") {
        const space = list.dataset["spaceId"] ?? null;
        const at = space === null || item.kind === "group" || item.kind === "folder" ? null : spaceDropAt(rowsOf(list), y, space);
        return { drop: at, overContent: false, zone: null };
      }
      const drop = listDropAt(rowsOf(list), item.kind, y, ev.clientX - box.left - LIST_PAD);
      // Today in the double sidebar's Home draws the day's loose rows alone: its index is turned into the day's units'.
      if (drop.zone === "today" && list.dataset["view"] === "home") return { drop: { zone: "today", index: todayUnits(drop.index) }, overContent: false, zone: null };
      return { drop, overContent: false, zone: null };
    };

    /**
     * The double sidebar's rail under the pointer: the drop its target there
     * would take — undefined off the rail; on it, a rail drop: the item under
     * the pointer, or New space anywhere on the rail that is no item of it
     * (its ground — between the tiles, below them, round New space; since
     * 2026-10-26, until then a row let go there went nowhere), its target
     * null over one that cannot take it (a space the row is in already, Home
     * for a tab that is Home's). A live row takes every target; a favorite or
     * a pin a space's (its page coming down into it, still its entry's:
     * @pistachio/shell-contracts/sidebar's bringDown) — not the space its
     * page is in already — and New space (a space of its page; since
     * 2026-10-14), never Home: it is Home's already. New space takes nothing
     * while the Profile holds as many spaces as it may (roomForSpace).
     */
    const overRail = (ev: PointerLike): RailDrop | undefined => {
      const rail = railRef.current;
      if (rail === null) return undefined;
      const box = rail.getBoundingClientRect();
      if (ev.clientX < box.left || ev.clientX > box.right || ev.clientY < box.top || ev.clientY > box.bottom) return undefined;
      const none: RailDrop = { zone: "rail", target: null, groupId: null };
      const live = (item.kind === "tab" || item.kind === "split") && item.tabs.length > 0;
      const entry = item.kind === "favorite" || item.kind === "pin";
      if (!live && !entry) return none;
      // (Each item's box, read as it stands; a space's tile only where its list shows it: railTargetAt.)
      const list = rail.querySelector<HTMLElement>("[data-testid='space-rail-list']");
      const span = list?.getBoundingClientRect() ?? null;
      const targets = [...rail.querySelectorAll<HTMLElement>("[data-rail-drop]")].map((el) => {
        const at = el.getBoundingClientRect();
        return { el, top: at.top, bottom: at.bottom, listed: list?.contains(el) === true };
      });
      const over = railTargetAt(targets, ev.clientY, span === null ? null : { top: span.top, bottom: span.bottom })?.el ?? null;
      const snapshot = useAppStore.getState().snapshot;
      const tabIds = item.tabs.map((tab) => tab.id);
      // (The rail's ground, on none of its items, is New space's.)
      const target = over === null ? "new" : over.dataset["railDrop"];
      if (over !== null && target === "space") {
        const groupId = over.dataset["groupId"] ?? "";
        const members = [...(snapshot?.tabGroups ?? []), ...(snapshot?.anchorGroups ?? [])].find((group) => group.id === groupId)?.tabIds ?? [];
        if (live && tabIds.every((tabId) => members.includes(tabId))) return none;
        // (An entry's page — anchored, leading its page's space, or linked into a space — is there already.)
        const page = entry ? entryPageOf(snapshot?.tabs ?? [], item.entityId) : null;
        if (page !== null && members.includes(page.tab.id)) return none;
        return { zone: "rail", target: "space", groupId };
      }
      // (New space makes none with the Profile full: rail-model's roomForSpace.)
      if (target === "new" && !roomForSpace(snapshot)) return none;
      if (entry) return target === "new" ? { zone: "rail", target: "new", groupId: null } : none;
      if (!live) return none;
      if (target === "home") {
        const loose = new Set((snapshot?.looseGroups ?? []).flatMap((group) => group.tabIds));
        return tabIds.every((tabId) => loose.has(tabId)) ? none : { zone: "rail", target: "home", groupId: null };
      }
      if (target === "new") return { zone: "rail", target: "new", groupId: null };
      return none;
    };

    /** The pointer is past the column's edge, over the desk, with a tab's row in hand. */
    /** The favorites' grid under the pointer (a little past its edges), and where in it a drop would go; null off it, or for what it cannot take. */
    const overFavorites = (ev: PointerLike): ShelfDrop | null => {
      const grid = gridRef.current;
      if (grid === null || item.kind === "folder" || item.kind === "split" || item.kind === "group") return null;
      const box = grid.getBoundingClientRect();
      if (ev.clientX < box.left - 4 || ev.clientX > box.right + 4 || ev.clientY < box.top - 4 || ev.clientY > box.bottom + 4) return null;
      return { zone: "favorites", index: favoriteDropAt(tilesOf(grid), ev.clientX - box.left, ev.clientY - box.top) };
    };
    const overDesk = (ev: PointerLike): boolean => {
      if (!toDesk) return false;
      const column = rootRef.current?.getBoundingClientRect();
      return column !== undefined && ev.clientX > column.right + DESK_EDGE_PX;
    };

    /** How far the list scrolls under a pointer near its edge this frame — measured, not yet written. */
    const autoScrollDelta = (ev: PointerLike): number => {
      const scroller = scrollerRef.current;
      if (scroller === null) return 0;
      const box = scroller.getBoundingClientRect();
      if (ev.clientX < box.left || ev.clientX > box.right) return 0;
      if (ev.clientY < box.top + AUTO_SCROLL_EDGE) return -Math.min(AUTO_SCROLL_STEP, Math.max(0, scroller.scrollTop));
      if (ev.clientY > box.bottom - AUTO_SCROLL_EDGE) {
        // As far as the rows go, not scrollHeight: the dragged row's transform
        // counts toward the scroller's overflow, so a row held at the bottom
        // edge would make room below itself every frame and scroll the list
        // away into the space it made.
        const extent = listRef.current?.offsetHeight ?? scroller.scrollHeight;
        return Math.min(AUTO_SCROLL_STEP, Math.max(0, extent - scroller.clientHeight - scroller.scrollTop));
      }
      return 0;
    };

    // The dragged element follows the pointer: as a tile it moves freely, as
    // a row it stays in the column unless it is being lifted toward the page.
    // Measured against the element's layout slot, so it is re-placed after
    // every layout the shelf commits (the provider's layout effect) as well
    // as on every pointer frame.
    const measureFollow = (current: ShelfDrag, scrollBy: number): FollowPlacement | null => {
      const target = elFor(current.item.flipId);
      if (target === null) return null;
      const parent = target.offsetParent;
      if (!(parent instanceof HTMLElement)) return null;
      const parentBox = parent.getBoundingClientRect();
      // A row in the scroller moves with the scroll the frame is about to write.
      const inList = scrollerRef.current?.contains(target) === true;
      const layoutLeft = parentBox.left + target.offsetLeft;
      const layoutTop = parentBox.top + target.offsetTop - (inList ? scrollBy : 0);
      const inGrid = gridRef.current?.contains(target) === true;
      const px = inGrid
        ? pointer.clientX - grabX - layoutLeft
        : canSplit && boundsRef.current !== null
          ? Math.max(0, pointer.clientX - startX)
          : 0;
      const py = pointer.clientY - grabY - layoutTop;
      const armed = current.zone !== null;
      // Over the double sidebar's rail a row — or a favorite's tile (2026-10-14) — waits in its slot, dimmed, drawn
      // over the rail as a space's tile instead (RailToken), the item under the pointer saying it would take it:
      // carried up to Home or down to New space a row would leave the list's box and be clipped away, and a tile
      // would paint under the rail. (Until 2026-10-13 a row vanished there, nothing following the pointer; until
      // 2026-10-14 it waited with no token, and a tile followed the pointer under the rail.)
      const waiting = current.drop?.zone === "rail";
      return {
        target,
        transformOrigin: `${grabX}px ${grabY}px`,
        transform: waiting ? "" : `translate(${px}px, ${py}px) scale(${armed ? 0.9 : 1})`,
        // Once the item has left the column, the layer's ghost is the visible
        // copy. Keeping the source transparent preserves its layout/FLIP slot
        // without showing a clipped duplicate at the column edge.
        opacity: current.lifted ? "0" : waiting ? WAIT_OPACITY : armed ? "0.9" : "",
        box: { x: layoutLeft + (waiting ? 0 : px), y: layoutTop + (waiting ? 0 : py), w: target.offsetWidth, h: target.offsetHeight },
      };
    };
    const paintFollow = (placement: FollowPlacement | null): void => {
      if (placement === null) return;
      const from = placement.target.style.transform;
      placement.target.style.transformOrigin = placement.transformOrigin;
      placement.target.style.transform = placement.transform;
      placement.target.style.opacity = placement.opacity;
      // Gone over the rail, it glides back into its slot to wait there (the token has its place at the pointer).
      if (from !== "" && placement.transform === "" && !reducedMotion()) {
        placement.target.animate([{ transform: from }, { transform: "none" }], { duration: 170, easing: SETTLE_EASING });
      }
    };

    /**
     * The token, this frame: it follows the pointer (its frame's place in the
     * column); come over the rail it grows out of the item as drawn (`from`,
     * viewport px) into a space's tile; gone off it, it shrinks back into the
     * item as it is drawn from now on (`back`) as it fades, the item itself
     * showing again under it. Its colour and icon are RailToken's (React's:
     * they change with the drop).
     */
    const paintToken = (ev: PointerLike, root: DOMRect | null, over: boolean, from: FaceBox | null, back: FaceBox | null): void => {
      const outer = tokenRef.current;
      const face = tokenFaceRef.current;
      if (outer === null || face === null || root === null || (!over && !tokenFollows)) return;
      tokenFollows = true;
      outer.style.transform = `translate(${String(ev.clientX - root.left)}px, ${String(ev.clientY - root.top)}px)`;
      const near = (box: FaceBox): FaceBox => ({ x: box.x - ev.clientX, y: box.y - ev.clientY, w: box.w, h: box.h });
      if (over && !tokenUp) {
        tokenUp = true;
        for (const animation of face.getAnimations()) animation.cancel();
        face.style.transition = "none";
        writeFace(face, near(from ?? ghostBox(ev)), tokenShape);
        face.dataset["shown"] = "";
        // (Laid out where it starts, so the change below is a transition from there.)
        void face.offsetWidth;
        face.style.transition = "";
        writeFace(face, TILE_FACE, "tile");
      } else if (!over && tokenUp) {
        tokenUp = false;
        writeFace(face, near(back ?? ghostBox(ev)), tokenShape);
        delete face.dataset["shown"];
      }
    };
    /** The gesture is over with the token up but let go on nothing: it fades where it is (the item is back in its slot). */
    const dropToken = (): void => {
      const face = tokenFaceRef.current;
      if (!tokenUp || face === null) return;
      tokenUp = false;
      delete face.dataset["shown"];
    };
    /** Let go on a rail item that takes it: the token goes into that item, shrinking away, and the item bounces. */
    const landToken = (drop: RailDrop): void => {
      const outer = tokenRef.current;
      const face = tokenFaceRef.current;
      const rail = railRef.current;
      const root = rootRef.current;
      if (!tokenUp || outer === null || face === null || rail === null || root === null || drop.target === null) {
        dropToken();
        return;
      }
      tokenUp = false;
      const into = rail.querySelector<HTMLElement>(
        drop.target === "space" ? `[data-rail-drop="space"][data-group-id="${CSS.escape(drop.groupId ?? "")}"]` : `[data-rail-drop="${drop.target}"]`,
      );
      const hide = (): void => {
        face.style.transition = "none";
        delete face.dataset["shown"];
        for (const animation of face.getAnimations()) animation.cancel();
        void face.offsetWidth;
        face.style.transition = "";
      };
      if (into === null || reducedMotion()) {
        hide();
        bounceRailItem(into);
        return;
      }
      const at = root.getBoundingClientRect();
      const box = into.getBoundingClientRect();
      const from = outer.style.transform;
      const to = `translate(${String(box.left + box.width / 2 - at.left)}px, ${String(box.top + box.height / 2 - at.top)}px)`;
      outer.style.transform = to;
      outer.animate([{ transform: from }, { transform: to }], { duration: TOKEN_LAND_MS, easing: HOUSE_EASING });
      const shrink = face.animate([{ scale: "1", opacity: 1 }, { scale: "0.5", opacity: 0 }], { duration: TOKEN_LAND_MS, easing: "cubic-bezier(0.3, 0.7, 0.4, 1)", fill: "forwards" });
      window.setTimeout(() => bounceRailItem(into), TOKEN_BOUNCE_AT_MS);
      shrink.finished.then(hide, () => undefined);
    };

    /**
     * `live` is false for the sample a release is read from: a tab's row of
     * the desk's group carried out over the desk is then let go there
     * (`finish`), not handed on.
     */
    const onMove = (ev: PointerLike, live = true): void => {
      pointer = ev;
      if (state === null) {
        if (Math.abs(ev.clientX - startX) < DRAG_START_PX && Math.abs(ev.clientY - startY) < DRAG_START_PX) return;
        draggedRef.current = true;
        // The FLIP's baseline is the shelf as it stands now, so only what this
        // drag moves glides.
        primeFlip();
        const startStore = useAppStore.getState();
        startStore.setTabDragging(true);
        const dragTab = item.tabs[0];
        startStore.setSplitDragTab({
          title: item.title || dragTab?.title || "",
          url: item.url || dragTab?.url || "",
          faviconUrl: item.faviconUrl ?? dragTab?.faviconUrl ?? null,
        });
        nativeApi()?.setDragCapture("grabbing");
      }
      // Every measurement first, against the layout as it stands; then the
      // writes. Interleaving them would force a layout per read.
      // A row of the desk's group out over the desk becomes its window in
      // hand: the desk takes the gesture on from here, the button still down.
      if (live && deskTab !== undefined && overDesk(ev) && deskEngine()?.hasGroupTab(deskTab.id) === true) {
        finish(false);
        deskEngine()?.pullFromSidebar(deskTab.id, { x: ev.clientX, y: ev.clientY });
        return;
      }
      const scrollBy = autoScrollDelta(ev);
      const { drop, overContent, zone } = dropFor(ev, scrollBy);
      // Where the source's box is drawn, viewport px (as `follow` moves it):
      // past the column's edge it would be clipped, so from there the layer
      // draws it instead.
      const left = startedInGrid
        ? ev.clientX - grabX
        : canSplit && boundsRef.current !== null
          ? Math.max(rect.left, ev.clientX - grabX)
          : rect.left;
      const columnRight = rootRef.current?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY;
      const lifted = (state?.lifted ?? false) || overContent || left + rect.width > columnRight;
      const next: ShelfDrag = { item, drop, settling: false, overContent, lifted, zone };
      const placement = measureFollow(next, scrollBy);
      // Over the rail: the token, grown out of the item as drawn a moment ago (the layer's ghost, lifted), or — off the
      // rail again — shrunk back into the item as it is drawn now.
      const overRailNow = tokenFor && drop?.zone === "rail";
      const rootBox = overRailNow || tokenFollows ? (rootRef.current?.getBoundingClientRect() ?? null) : null;
      const sourceBox = overRailNow && !tokenUp && state?.lifted !== true ? elFor(item.flipId)?.getBoundingClientRect() : undefined;
      const fromBox = overRailNow && !tokenUp ? (sourceBox === undefined ? ghostBox(ev) : { x: sourceBox.left, y: sourceBox.top, w: sourceBox.width, h: sourceBox.height }) : null;
      const backBox = !overRailNow && tokenUp ? (lifted ? ghostBox(ev) : (placement?.box ?? null)) : null;

      if (scrollBy !== 0 && scrollerRef.current !== null) scrollerRef.current.scrollTop += scrollBy;
      paintFollow(placement);
      paintToken(ev, rootBox, overRailNow, fromBox, backBox);
      useAppStore.getState().setSplitDropZone(zone);
      // (Over the rail the token is what is drawn: the layer draws nothing there, lifted or not.)
      if (lifted && !overRailNow) {
        const tab = item.tabs[0];
        nativeApi()?.setTabDragVisual({
          x: ev.clientX,
          y: ev.clientY,
          grabX,
          grabY,
          width: rect.width,
          height: rect.height,
          title: item.title || tab?.title || "",
          url: item.url || tab?.url || "",
          faviconUrl: item.faviconUrl ?? tab?.faviconUrl ?? null,
          zone,
          clamp,
        });
        visualShown = true;
      } else if (visualShown) {
        nativeApi()?.setTabDragVisual(null);
        visualShown = false;
      }
      // The shelf re-renders only for a change it would draw differently.
      const changed = state === null || !sameShelfDrag(state, next);
      state = next;
      if (changed) setDrag(next);
    };

    // Both pointer sources — the window's own moves and the layer's relayed
    // samples — land on one animation frame, so `onMove` runs at most once a
    // frame with the latest sample (lib/pane-drag.ts does the same).
    let frame = 0;
    let pending: PointerLike | null = null;
    const apply = (): void => {
      frame = 0;
      const sample = pending;
      pending = null;
      if (sample !== null && !finished) onMove(sample);
    };
    const schedule = (ev: PointerLike): void => {
      pending = { clientX: ev.clientX, clientY: ev.clientY };
      if (frame === 0) frame = requestAnimationFrame(apply);
    };

    const finish = (commit: boolean): void => {
      if (finished) return;
      // A sample still waiting for its frame is where the pointer let go:
      // the drop is read from it, not from the frame before.
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      if (pending !== null) {
        const last = pending;
        pending = null;
        onMove(last, false);
      }
      finished = true;
      window.removeEventListener("pointermove", onWindowMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      offSample();
      if (visualShown) {
        nativeApi()?.setTabDragVisual(null);
        visualShown = false;
      }
      const done = state;
      // A press that never crossed the drag threshold is a click: it took no
      // capture and raised no flag, so there is nothing to give back — and a
      // round trip to main on every tab click is latency the click can feel.
      if (done === null) return;
      nativeApi()?.setDragCapture(null);
      const store = useAppStore.getState();
      const dragged = elFor(done.item.flipId);
      if (dragged !== null) {
        const from = dragged.style.transform;
        dragged.style.transform = "";
        dragged.animate([{ transform: from || "translate(0, 0)" }, { transform: "translate(0, 0)" }], {
          duration: 170,
          easing: SETTLE_EASING,
        });
      }
      if (!commit) {
        dropToken();
        setDrag(null);
        store.setTabDragging(false);
        return;
      }
      if (done.zone !== null && done.item.tabs.length === 1) {
        dropToken();
        setDrag(null);
        const tab = done.item.tabs[0];
        if (tab !== undefined) {
          void store.splitWith(tab.id, done.zone).finally(() => store.setTabDragging(false));
          return;
        }
        store.setTabDragging(false);
        return;
      }
      store.setTabDragging(false);
      // Let go over the desk: the tab's window comes out there (joining the group, if it was not the group's; a
      // favorite's or pin's page coming down into it).
      if (overDesk(pointer) && overRail(pointer) === undefined) {
        dropToken();
        setDrag(null);
        const at = { x: pointer.clientX, y: pointer.clientY };
        void (deskTab !== undefined ? dropTabOnDesk(deskTab.id, at) : dropEntryOnDesk(item.entityId, at));
        return;
      }
      if (done.drop === null || (done.drop.zone === "rail" && done.drop.target === null) || sameDrop(done.drop, origin)) {
        dropToken();
        setDrag(null);
        return;
      }
      if (done.drop.zone === "rail") landToken(done.drop);
      else dropToken();
      // The proposed layout stays up while the commit is in flight. Dropping
      // the drag here would draw the shelf's CURRENT order for a frame — every
      // row snapping back — and FLIP them forward again once main publishes
      // the drop. Main sends the new snapshot before it answers the command,
      // so by the time this resolves the shelf already draws the same layout.
      const settling: ShelfDrag = { ...done, settling: true };
      setDrag(settling);
      const settle = (): void => setDrag((current) => (current === settling ? null : current));
      const timeout = window.setTimeout(settle, SETTLE_TIMEOUT_MS);
      void commitDrop(done.item, done.drop).finally(() => {
        window.clearTimeout(timeout);
        settle();
      });
    };
    const onWindowMove = (ev: PointerEvent): void => schedule(ev);
    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);

    window.addEventListener("pointermove", onWindowMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    offSample = nativeApi()?.onDragSample((sample) => {
      if (sample.phase !== "cancel") schedule({ clientX: sample.x, clientY: sample.y });
      if (sample.phase === "up") finish(true);
      else if (sample.phase === "cancel") finish(false);
      // On a stream surface nothing relays OS samples: the pointer events the
      // window already gets carry the whole gesture (§10).
    }) ?? offSample;

    gestureRef.current = { follow: (current) => paintFollow(measureFollow(current, 0)) };
  };

  // After every layout the shelf commits for the drag, the dragged element's
  // slot may have moved (the rows reflowed around the new drop, a tile became
  // a row): place it against the new slot. The pointer-only frames between
  // commits are the gesture's own (`onMove`).
  useLayoutEffect(() => {
    layoutEpochRef.current += 1;
    if (drag === null) return;
    if (drag.settling) {
      // Let go on the rail: it waits in its slot, dimmed, as it did over the rail, until main has moved it (a row) — or
      // it stays (a favorite's tile, a pin's row: its page went) — rather than coming up whole for the moment between.
      const waiting = drag.drop?.zone === "rail" ? queryFlip(rootRef.current, drag.item.flipId) : null;
      if (waiting === null) return;
      waiting.style.opacity = WAIT_OPACITY;
      return () => {
        waiting.style.opacity = "";
      };
    }
    gestureRef.current?.follow(drag);
    const el = queryFlip(rootRef.current, drag.item.flipId);
    return () => {
      if (el === null) return;
      el.style.transformOrigin = "";
      el.style.opacity = "";
    };
  }, [drag]);

  const host = useMemo<ShelfDragHost>(
    () => ({ drag, beginPress, justDragged: () => draggedRef.current, gridRef, railRef, scrollerRef, listRef }),
    // beginPress closes over refs only; a new identity per drag state is what consumers re-render on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drag],
  );

  return (
    <ShelfDragContext.Provider value={host}>
      <div ref={rootRef} className={className}>
        {children}
        <RailToken drag={drag} outerRef={tokenRef} faceRef={tokenFaceRef} />
      </div>
    </ShelfDragContext.Provider>
  );
}

/**
 * What a card item carried over the rail is drawn as (docs/double-sidebar.md
 * §1, "Dragging"; 2026-10-14): a space's tile — the face a desk window
 * carried over the rail wears (DeskWindow's DockFace; shell.css's
 * `.desk-window-face`, shared, not forked) — its icon on the tint of the
 * space it would go into, the rail's own neutral over Home, New space or
 * nothing. Above the rail and the card both (the column's own layer), never
 * clipped by the list it came from. React draws what it shows (the icon, the
 * colour: they change with the drop); the gesture places it and changes its
 * shape every frame (`paintToken`, `landToken`). It keeps the last thing it
 * carried while it fades or goes into an item.
 */
function RailToken({ drag, outerRef, faceRef }: { drag: ShelfDrag | null; outerRef: React.RefObject<HTMLDivElement | null>; faceRef: React.RefObject<HTMLDivElement | null> }) {
  const last = useRef<{ item: ShelfItem; groupId: string | null } | null>(null);
  if (drag !== null) last.current = { item: drag.item, groupId: drag.drop?.zone === "rail" && drag.drop.target === "space" ? drag.drop.groupId : null };
  const shown = last.current;
  const groupId = drag === null ? (shown?.groupId ?? null) : drag.drop?.zone === "rail" && drag.drop.target === "space" ? drag.drop.groupId : null;
  const color = useAppStore((state) =>
    groupId === null ? null : ([...(state.snapshot?.tabGroups ?? []), ...(state.snapshot?.anchorGroups ?? [])].find((group) => group.id === groupId)?.color ?? null),
  );
  const item = shown?.item ?? null;
  const tab = item?.tabs[0];
  const title = item?.title || tab?.title || "";
  const url = item?.url || tab?.url || "";
  return (
    <div ref={outerRef} aria-hidden="true" className="shelf-rail-token" data-testid="shelf-rail-token">
      <div ref={faceRef} className="desk-window-face shelf-rail-token-face tab-group-tone" data-testid="shelf-rail-token-face" data-group-color={color ?? undefined}>
        {/* (Its icon as its row or tile draws it: a live tab's, else the entry's own.) */}
        {item === null ? null : (
          <Favicon src={tab?.faviconUrl ?? item.faviconUrl ?? null} seed={tab === undefined ? prettyUrl(url) : displayHost(tab.url) || tab.title} className="desk-window-face-icon" />
        )}
        <span className="desk-window-face-title">{title}</span>
      </div>
    </div>
  );
}

/** Where an item sits before it moves, so a drop back on it is a no-op. */
function originDrop(item: ShelfItem, list: HTMLElement | null, grid: HTMLElement | null): ShelfDrop | null {
  if (item.kind === "favorite") {
    if (grid === null) return null;
    const own = [...grid.querySelectorAll<HTMLElement>("[data-flip-id]")].filter((el) => el.dataset["managed"] === undefined);
    const index = own.findIndex((el) => el.dataset["flipId"] === item.flipId);
    return index < 0 ? null : { zone: "favorites", index };
  }
  if (list === null) return null;
  const rows = [...list.querySelectorAll<HTMLElement>("[data-flip-id][data-row-kind]")];
  const at = rows.findIndex((el) => el.dataset["flipId"] === item.flipId);
  // (A row under a favorite or pin — its page's group's, its desk up — is no slot among the rows: every drop moves it.)
  if (at < 0 || rows[at]?.dataset["rowKind"] === "entry") return null;
  const before = rows.slice(0, at);
  if (item.kind === "tab" || item.kind === "split" || item.kind === "group") {
    // A tab inside a group sits at its place among the group's tabs…
    const ownGroup = rows[at]?.dataset["rowKind"] === "member" ? (rows[at]?.dataset["groupId"] ?? "") : "";
    if (ownGroup !== "") {
      return { zone: "group", groupId: ownGroup, index: before.filter((el) => el.dataset["rowKind"] === "member" && el.dataset["groupId"] === ownGroup).length };
    }
    // …and everything else at its place among the day's UNITS, which a group's tabs are not.
    const divider = rows.findIndex((el) => el.dataset["rowKind"] === "divider");
    const units = before.slice(divider + 1).filter((el) => el.dataset["rowKind"] === "tab" || el.dataset["rowKind"] === "group");
    // (The double sidebar's Home draws the loose rows alone: its place among them is one among all the day's units, as a drop's is.)
    if (list.dataset["view"] === "home") {
      const moving = new Set(item.tabs.map((tab) => tab.id));
      return { zone: "today", index: fullUnitIndex(dayUnitsInHand(useAppStore.getState().snapshot, moving), units.length, (unit) => unit.kind !== "group") };
    }
    return { zone: "today", index: units.length };
  }
  if (item.kind === "folder") {
    const index = before.filter((el) => el.dataset["rowKind"] === "folder" || (el.dataset["rowKind"] === "pin" && (el.dataset["folderId"] ?? "") === "")).length;
    return { zone: "pinned", folderId: null, index };
  }
  const folderId = rows[at]?.dataset["folderId"] ?? "";
  const index =
    folderId === ""
      ? before.filter((el) => el.dataset["rowKind"] === "folder" || (el.dataset["rowKind"] === "pin" && (el.dataset["folderId"] ?? "") === "")).length
      : before.filter((el) => el.dataset["rowKind"] === "pin" && el.dataset["folderId"] === folderId).length;
  return { zone: "pinned", folderId: folderId === "" ? null : folderId, index };
}

/** The one command (or tab reorder) a drop means; resolves once main has answered it. */
function commitDrop(item: ShelfItem, drop: ShelfDrop): Promise<void> {
  const store = useAppStore.getState();
  const send = (command: SidebarCommand): Promise<void> => store.sidebarCommand(command);
  if (drop.zone === "rail") return railDrop(item, drop);
  switch (item.kind) {
    case "tab": {
      const tab = item.tabs[0];
      if (tab === undefined) return Promise.resolve();
      if (drop.zone === "pinned") return send({ type: "pinTab", tabId: tab.id, folderId: drop.folderId, index: drop.index });
      if (drop.zone === "today") return reorderDayTabs(item.tabs.map((t) => t.id), drop.index);
      if (drop.zone === "group") {
        // Onto an empty space's header: it joins, and — the current space — its window comes out on the desk.
        const empty = store.snapshot?.tabGroups.find((group) => group.id === drop.groupId)?.tabIds.length === 0;
        return joinGroup(item.tabs.map((t) => t.id), drop.groupId, drop.index).then(() => (empty ? bringOutJoined(tab.id, drop.groupId) : undefined));
      }
      return send({ type: "addFavorite", source: { tabId: tab.id }, index: drop.index });
    }
    case "split":
      if (drop.zone === "group") return joinGroup(item.tabs.map((t) => t.id), drop.groupId, drop.index);
      return drop.zone === "today" ? reorderDayTabs(item.tabs.map((t) => t.id), drop.index) : Promise.resolve();
    case "group":
      return drop.zone === "today" && item.groupId !== undefined
        ? store.tabGroupCommand({ type: "move", groupId: item.groupId, index: drop.index }).then(() => undefined)
        : Promise.resolve();
    case "pin":
      if (drop.zone === "pinned") return send({ type: "movePin", pinId: item.entityId, folderId: drop.folderId, index: drop.index });
      // Down into the day's tabs or a group, its page (and its page's group) a day tab's from then on; the pin stays, closed.
      if (drop.zone === "today") return send({ type: "bringDown", anchorId: item.entityId, index: drop.index });
      if (drop.zone === "group") return bringDownInto(item, drop.groupId, drop.index);
      return send({ type: "addFavorite", source: { pinId: item.entityId }, index: drop.index });
    case "folder":
      return drop.zone === "pinned" && drop.folderId === null
        ? send({ type: "moveFolder", folderId: item.entityId, index: drop.index })
        : Promise.resolve();
    case "favorite":
      if (item.managed === true) return Promise.resolve();
      if (drop.zone === "favorites") return send({ type: "moveFavorite", favoriteId: item.entityId, index: drop.index });
      if (drop.zone === "pinned") return send({ type: "favoriteToPin", favoriteId: item.entityId, folderId: drop.folderId, index: drop.index });
      // Down into the day's tabs or a group, its page (and its page's group) a day tab's from then on; the favorite stays, closed.
      if (drop.zone === "group") return bringDownInto(item, drop.groupId, drop.index);
      return send({ type: "bringDown", anchorId: item.entityId, index: drop.index });
  }
}

/**
 * A row let go on the double sidebar's rail (docs/double-sidebar.md §1): on a
 * space's tile its tabs join the space, at its end (a favorite's or pin's
 * page coming down into it); on Home each leaves its space and is a Home tab
 * (a loose one of its own: main's removeTab); on New space they make a
 * space of their own — a favorite or a pin a space of its page (bringDown's
 * `newGroupId`, since 2026-10-14) — which main names (not chosen: the desk
 * stays where it is).
 */
async function railDrop(item: ShelfItem, drop: RailDrop): Promise<void> {
  const store = useAppStore.getState();
  const tabIds = item.tabs.map((tab) => tab.id);
  const entry = item.kind === "favorite" || item.kind === "pin";
  if (drop.target === null) return;
  if (drop.target === "space" && drop.groupId !== null) {
    if (entry) return bringDownInto(item, drop.groupId, GROUP_END);
    return joinGroup(tabIds, drop.groupId, GROUP_END);
  }
  if (drop.target === "new") {
    // (Its tile grows in on the rail where it stands: what was let go went into New space already, as the token did.)
    const id = crypto.randomUUID();
    grownByDrop(id);
    // A favorite or pin: a space of its page — opened, closed as it was — still its entry's (2026-10-14).
    if (entry) await store.sidebarCommand({ type: "bringDown", anchorId: item.entityId, newGroupId: id });
    else if (tabIds.length > 0) await store.tabGroupCommand({ type: "create", id, tabIds });
    return;
  }
  if (tabIds.length === 0 || entry) return;
  if (drop.target === "home") {
    for (const tabId of tabIds) await store.tabGroupCommand({ type: "removeTab", tabId });
  }
}

/**
 * A favorite's or pin's page set down inside a space (bringDown: its page's
 * group with it, the entry staying, closed). Let go on the header of a space
 * with no tabs that is the current one, its window comes out on the desk
 * too, in use, as a tab's row let go there does (docs/spaces.md §1) — once
 * its tab has reached the space, which the drop knows only when a page of
 * it was open (bringOutJoined; 2026-10-09).
 */
function bringDownInto(item: ShelfItem, groupId: string, index: number): Promise<void> {
  const store = useAppStore.getState();
  const tabIds = item.tabs.map((t) => t.id);
  const empty = store.snapshot?.tabGroups.find((group) => group.id === groupId)?.tabIds.length === 0;
  return store
    .sidebarCommand({ type: "bringDown", anchorId: item.entityId, groupId, index: groupTabIndex(tabIds, groupId, index) })
    .then(() => (empty ? bringOutJoined(tabIds[0] ?? null, groupId) : undefined));
}

/**
 * Set live tabs down inside a tab group at `index` among its tabs — counted
 * without them, as the drop was, so moving a tab within its own group is the
 * same act as bringing one in. A split's panes go in side by side.
 */
async function joinGroup(tabIds: string[], groupId: string, index: number): Promise<void> {
  const store = useAppStore.getState();
  const at = groupTabIndex(tabIds, groupId, index);
  for (const [offset, tabId] of tabIds.entries()) {
    await store.tabGroupCommand({ type: "addTab", groupId, tabId, index: at + offset });
  }
}

/** A drop's place inside a tab group, `index` among its ROWS, as main counts it: among its tabs, without `tabIds` (those in hand). */
function groupTabIndex(tabIds: readonly string[], groupId: string, index: number): number {
  const store = useAppStore.getState();
  // The drop counted ROWS, and a split inside the group is one row of several
  // tabs; main counts tabs. The rows are the group's tabs without the ones in
  // hand, a split being one row when all of it is there (chrome/tabs.ts).
  const moving = new Set(tabIds);
  // (A page's space too — a favorite's or pin's page with tabs beside it, a rail space since 2026-10-13: a row let go on
  // its tile goes to its end, not before its page.)
  const groups = [...(store.snapshot?.tabGroups ?? []), ...(store.snapshot?.anchorGroups ?? [])];
  const members = (groups.find((group) => group.id === groupId)?.tabIds ?? []).filter((tabId) => !moving.has(tabId));
  const here = new Set(members);
  const seen = new Set<string>();
  let rows = 0;
  let at = 0;
  for (const tabId of members) {
    if (rows === index) break;
    at += 1;
    const split = store.snapshot?.splitGroups.find((candidate) => candidate.tabIds.includes(tabId) && candidate.tabIds.every((id) => here.has(id)));
    if (split === undefined) rows += 1;
    else if (!seen.has(split.id)) {
      seen.add(split.id);
      rows += 1;
    }
  }
  // A split's first pane opened its row; the row is whole only once its last pane is passed.
  while (at < members.length) {
    const tabId = members[at];
    const split = tabId === undefined ? undefined : store.snapshot?.splitGroups.find((candidate) => candidate.tabIds.includes(tabId) && candidate.tabIds.every((id) => here.has(id)));
    const previous = members[at - 1];
    if (split === undefined || previous === undefined || !split.tabIds.includes(previous)) break;
    at += 1;
  }
  return at;
}

/**
 * Put a run of live tabs at `index` among the day's ROW UNITS — lone tabs,
 * splits, tab groups and EMPTY spaces, each one slot, which is what the drop
 * counted (@pistachio/shell-contracts/tab-groups `dayRowUnits`; a group's
 * hidden tabs are not slots) — read off the units as the list drew them for
 * the drop, before anything changes (dayUnitsInHand): the rows in hand
 * lifted out, every empty space where it stands, a space the lift emptied
 * still where it stood. Main takes a tab out of its group when it is set
 * down away from it (said outright first, below), and the drop is then
 * counted again among the units as they are (unitIndexAfter): the space it
 * emptied may have gone with it.
 *
 * On the desktop main places the tab by that unit index itself
 * (`reorderTab(…, "units")`, placeAmongUnits), so a row dropped beside an
 * empty space lands on the side of it it was dropped on, and an empty space
 * standing before the tab stays where it is drawn (2026-10-09; until then
 * the shell turned the unit into its first tab's place in the one tab
 * order, which no empty space is in: a row dropped just below one went
 * above it, and one standing before the tab went wherever the tab did). The
 * web's hosts count tabs: there the unit is still turned into its first
 * tab's place — counted with the moved tab lifted out, reorderTab's
 * convention. A split's second tab is then placed straight after the first,
 * re-read from the live order.
 */
export async function reorderDayTabs(tabIds: string[], index: number): Promise<void> {
  const [head, ...tail] = tabIds;
  if (head === undefined) return;
  const store = useAppStore.getState();
  const liveTabs = () => useAppStore.getState().snapshot?.tabs ?? [];
  const moving = new Set(tabIds);
  const snapshot = store.snapshot;
  const drawn = dayUnitsInHand(snapshot, moving);
  // In the list a group is ONE slot, so a member set down among the day's
  // rows has left it — said outright, because in the browser's flat order
  // "last in the group" and "just below the group" are the same place. (So has
  // a tab of a page's group, drawn under its favorite or pin.)
  for (const group of [...(snapshot?.tabGroups ?? []), ...(snapshot?.anchorGroups ?? [])]) {
    for (const tabId of group.tabIds) if (moving.has(tabId)) await store.tabGroupCommand({ type: "removeTab", tabId });
  }
  if (deskAvailable()) {
    // (Main's snapshot precedes its reply: the units read now are the ones it counts.)
    await store.reorderTab(head, unitIndexAfter(drawn, index, dayUnitsInHand(useAppStore.getState().snapshot, moving)), "units");
  } else {
    // An index at an empty space's unit names no tab: the first unit after it that has one does.
    const target = drawn.slice(index).find((unit) => unit.tabIds.length > 0)?.tabIds[0];
    const withoutHead = liveTabs().filter((t) => t.id !== head);
    const at = target === undefined ? withoutHead.length : withoutHead.findIndex((t) => t.id === target);
    await store.reorderTab(head, at);
  }
  let prev = head;
  for (const id of tail) {
    const without = liveTabs().filter((t) => t.id !== id);
    const after = without.findIndex((t) => t.id === prev);
    if (after < 0) break;
    await store.reorderTab(id, after + 1);
    prev = id;
  }
}
