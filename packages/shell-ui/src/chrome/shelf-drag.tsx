/**
 * One drag surface for the whole sidebar shelf: the favorites grid, the
 * pinned tree (folders and pins), and the day's tabs. Any of them can be
 * picked up and dropped in any of the others — a day tab dragged above the
 * "New tab" row becomes a pin, a pin dragged into a folder joins it, a pin
 * dropped on the grid becomes a favorite, a favorite dragged into the list
 * becomes a pin or a day tab — and a row with one live page dragged RIGHT
 * over the page offers the same live split preview the strip has
 * (chrome/tab-drag.ts is the strip's own, single-row version of this).
 *
 * The grid and the list are separate manifest features rendered into
 * separate regions of the column (chrome/manifest.ts), so neither can own
 * the gesture: the column's host (components/SidebarChrome.tsx) mounts
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
 */

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ContentBounds } from "@pistachio/shell-contracts/ipc";
import type { SidebarCommand } from "@pistachio/shell-contracts/sidebar";
import { dayRowUnits } from "@pistachio/shell-contracts/tab-groups";
import { favoriteDropAt, listDropAt, type ListDrop, type MeasuredRow, type MeasuredTile, type ShelfDragKind } from "../lib/sidebar-tree";
import { useAppStore } from "../store";
import { splitZoneAt, type PointerLike, type SplitZone } from "./drag-geometry";
import type { ChromeTab } from "./tabs";
import { nativeApi } from "../api";

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
}

export type ShelfDrop = ListDrop | { zone: "favorites"; index: number };

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
/** Within this many px of the scroller's edge the list scrolls under the drag. */
const AUTO_SCROLL_EDGE = 28;
const AUTO_SCROLL_STEP = 8;

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
  const at = drop === null ? "page" : `${drop.zone}:${drop.index}:${drop.zone === "pinned" ? (drop.folderId ?? "") : drop.zone === "group" ? drop.groupId : ""}`;
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
}

/** The live gesture's hooks for the provider's commit-time effect. */
interface LiveGesture {
  /** Re-place the dragged element against the layout the shelf just committed. */
  follow(current: ShelfDrag): void;
}

export function ShelfDragProvider({ children }: { children: React.ReactNode }) {
  const [drag, setDrag] = useState<ShelfDrag | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
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
    const canSplit = item.kind !== "group" && item.tabs.length === 1 && (useAppStore.getState().snapshot?.visibleTabIds.length ?? 0) < 4;
    const origin = originDrop(item, listRef.current, gridRef.current);
    // A tile moves freely; a row stays in its slot horizontally unless it
    // is being lifted RIGHT toward the page (see `follow`). The ghost the
    // layer draws is held the same way, so the two never disagree.
    const startedInGrid = gridRef.current?.contains(el) === true;
    const clamp = startedInGrid ? undefined : { minLeft: rect.left };
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
      const area = boundsRef.current;
      if (canSplit && area !== null && ev.clientX >= area.x) {
        return { drop: null, overContent: true, zone: splitZoneAt("y", area, ev) };
      }
      const grid = gridRef.current;
      if (grid !== null && item.kind !== "folder" && item.kind !== "split" && item.kind !== "group") {
        const box = grid.getBoundingClientRect();
        if (ev.clientX >= box.left - 4 && ev.clientX <= box.right + 4 && ev.clientY >= box.top - 4 && ev.clientY <= box.bottom + 4) {
          return {
            drop: { zone: "favorites", index: favoriteDropAt(tilesOf(grid), ev.clientX - box.left, ev.clientY - box.top) },
            overContent: false,
            zone: null,
          };
        }
      }
      const list = listRef.current;
      if (list === null) return { drop: null, overContent: false, zone: null };
      const box = list.getBoundingClientRect();
      const drop = listDropAt(rowsOf(list), item.kind, ev.clientY - (box.top - scrollBy), ev.clientX - box.left - LIST_PAD);
      return { drop, overContent: false, zone: null };
    };

    /** How far the list scrolls under a pointer near its edge this frame — measured, not yet written. */
    const autoScrollDelta = (ev: PointerLike): number => {
      const scroller = scrollerRef.current;
      if (scroller === null) return 0;
      const box = scroller.getBoundingClientRect();
      if (ev.clientX < box.left || ev.clientX > box.right) return 0;
      if (ev.clientY < box.top + AUTO_SCROLL_EDGE) return -Math.min(AUTO_SCROLL_STEP, Math.max(0, scroller.scrollTop));
      if (ev.clientY > box.bottom - AUTO_SCROLL_EDGE) {
        return Math.min(AUTO_SCROLL_STEP, Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop));
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
      return {
        target,
        transformOrigin: `${grabX}px ${grabY}px`,
        transform: `translate(${px}px, ${py}px) scale(${armed ? 0.9 : 1})`,
        // Once the item has left the column, the layer's ghost is the visible
        // copy. Keeping the source transparent preserves its layout/FLIP slot
        // without showing a clipped duplicate at the column edge.
        opacity: current.lifted ? "0" : armed ? "0.9" : "",
      };
    };
    const paintFollow = (placement: FollowPlacement | null): void => {
      if (placement === null) return;
      placement.target.style.transformOrigin = placement.transformOrigin;
      placement.target.style.transform = placement.transform;
      placement.target.style.opacity = placement.opacity;
    };

    const onMove = (ev: PointerLike): void => {
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

      if (scrollBy !== 0 && scrollerRef.current !== null) scrollerRef.current.scrollTop += scrollBy;
      paintFollow(placement);
      useAppStore.getState().setSplitDropZone(zone);
      if (lifted) {
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
        onMove(last);
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
        setDrag(null);
        store.setTabDragging(false);
        return;
      }
      if (done.zone !== null && done.item.tabs.length === 1) {
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
      if (done.drop === null || sameDrop(done.drop, origin)) {
        setDrag(null);
        return;
      }
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
    if (drag === null || drag.settling) return;
    gestureRef.current?.follow(drag);
    const el = queryFlip(rootRef.current, drag.item.flipId);
    return () => {
      if (el === null) return;
      el.style.transformOrigin = "";
      el.style.opacity = "";
    };
  }, [drag]);

  const host = useMemo<ShelfDragHost>(
    () => ({ drag, beginPress, justDragged: () => draggedRef.current, gridRef, scrollerRef, listRef }),
    // beginPress closes over refs only; a new identity per drag state is what consumers re-render on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drag],
  );

  return (
    <ShelfDragContext.Provider value={host}>
      <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </ShelfDragContext.Provider>
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
  if (at < 0) return null;
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
  switch (item.kind) {
    case "tab": {
      const tab = item.tabs[0];
      if (tab === undefined) return Promise.resolve();
      if (drop.zone === "pinned") return send({ type: "pinTab", tabId: tab.id, folderId: drop.folderId, index: drop.index });
      if (drop.zone === "today") return reorderDayTabs(item.tabs.map((t) => t.id), drop.index);
      if (drop.zone === "group") return joinGroup(item.tabs.map((t) => t.id), drop.groupId, drop.index);
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
      if (drop.zone === "today") return send({ type: "unpin", pinId: item.entityId, index: drop.index });
      if (drop.zone === "group") return Promise.resolve();
      return send({ type: "addFavorite", source: { pinId: item.entityId }, index: drop.index });
    case "folder":
      return drop.zone === "pinned" && drop.folderId === null
        ? send({ type: "moveFolder", folderId: item.entityId, index: drop.index })
        : Promise.resolve();
    case "favorite":
      if (item.managed === true) return Promise.resolve();
      if (drop.zone === "favorites") return send({ type: "moveFavorite", favoriteId: item.entityId, index: drop.index });
      if (drop.zone === "group") return Promise.resolve();
      if (drop.zone === "pinned") return send({ type: "favoriteToPin", favoriteId: item.entityId, folderId: drop.folderId, index: drop.index });
      return send({ type: "removeFavorite", favoriteId: item.entityId, index: drop.index });
  }
}

/**
 * Set live tabs down inside a tab group at `index` among its tabs — counted
 * without them, as the drop was, so moving a tab within its own group is the
 * same act as bringing one in. A split's panes go in side by side.
 */
async function joinGroup(tabIds: string[], groupId: string, index: number): Promise<void> {
  const store = useAppStore.getState();
  // The drop counted ROWS, and a split inside the group is one row of several
  // tabs; main counts tabs. The rows are the group's tabs without the ones in
  // hand, a split being one row when all of it is there (chrome/tabs.ts).
  const moving = new Set(tabIds);
  const members = (store.snapshot?.tabGroups.find((group) => group.id === groupId)?.tabIds ?? []).filter((tabId) => !moving.has(tabId));
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
  for (const [offset, tabId] of tabIds.entries()) {
    await store.tabGroupCommand({ type: "addTab", groupId, tabId, index: at + offset });
  }
}

/**
 * Put a run of live tabs at `index` among the day's ROW UNITS — lone tabs,
 * splits, and tab groups, each one slot, which is what the drop counted
 * (@pistachio/shell-contracts/tab-groups `dayRowUnits`; a group's hidden
 * tabs are not slots). The browser keeps ONE order with the anchored tabs in
 * it, so the unit is translated to its first tab's place in that order —
 * counted with the moved tab lifted out, reorderTab's convention — and a
 * split's second tab is then placed straight after the first, re-read from
 * the live order (the strip does the same). Main takes a tab out of its
 * group when it is set down away from it.
 */
async function reorderDayTabs(tabIds: string[], index: number): Promise<void> {
  const [head, ...tail] = tabIds;
  if (head === undefined) return;
  const store = useAppStore.getState();
  const liveTabs = () => useAppStore.getState().snapshot?.tabs ?? [];
  const moving = new Set(tabIds);
  // In the list a group is ONE slot, so a member set down among the day's
  // rows has left it — said outright, because in the browser's flat order
  // "last in the group" and "just below the group" are the same place.
  for (const group of store.snapshot?.tabGroups ?? []) {
    for (const tabId of group.tabIds) if (moving.has(tabId)) await store.tabGroupCommand({ type: "removeTab", tabId });
  }
  const snapshot = useAppStore.getState().snapshot;
  const day = liveTabs().filter((t) => t.anchorId === null && !moving.has(t.id)).map((t) => t.id);
  const splits = (snapshot?.splitGroups ?? []).filter((split) => !split.tabIds.some((id) => moving.has(id)));
  const groups = (snapshot?.tabGroups ?? [])
    .map((group) => ({ ...group, tabIds: group.tabIds.filter((id) => !moving.has(id)) }))
    .filter((group) => group.tabIds.length > 0);
  const target = dayRowUnits(day, splits, groups)[index]?.tabIds[0];
  const withoutHead = liveTabs().filter((t) => t.id !== head);
  const at = target === undefined ? withoutHead.length : withoutHead.findIndex((t) => t.id === target);
  await store.reorderTab(head, at);
  let prev = head;
  for (const id of tail) {
    const without = liveTabs().filter((t) => t.id !== id);
    const after = without.findIndex((t) => t.id === prev);
    if (after < 0) break;
    await store.reorderTab(id, after + 1);
    prev = id;
  }
}
