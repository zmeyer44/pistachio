/**
 * A desk window carried over the sidebar's column (docs/desk.md, "Over the
 * sidebar"; docs/double-sidebar.md): what a release there does, and the shape
 * the window takes meanwhile — the thing it would be dropped as. Chosen on
 * 2026-10-14 ("a window dragged on top of the sidebar moves to another space,
 * a new space of its own, or collapses into its row, and morphs into what it
 * would be there").
 *
 * - On the RAIL: another space's tile, its tab joins that space ("space");
 *   New space — or the rail's own ground, anywhere on it that is no item of
 *   it: between the tiles, below them, round New space (since 2026-10-26;
 *   until then nothing there took it) — a space of its own ("new"), New
 *   space lit; Home, a Home tab ("home"); the desk's own space's tile — or
 *   Home, for a space of Home's — it is put away into its row ("collapse").
 *   Meanwhile it is a space's tile: 38px, rounded as the rail's are, its
 *   icon on the tint of the space it would go to.
 * - On the CARD while the card shows the desk's own space: put away into its
 *   row ("collapse"). Meanwhile it is one of the card's rows: as wide as its
 *   list's rows, a row's height, following the pointer up and down. The card
 *   showing Home (a Home tab's desk, or another view) takes nothing.
 * - Anywhere else — the gap beside the card, the card showing another view,
 *   the column hidden — nothing: the desk's own leading edge has the window,
 *   as before (the left half lights), and it is a window. Over the rail it
 *   is a tile everywhere, so it does not swell into a window and back on its
 *   way from one item to the next; where the rail takes nothing of it (the
 *   Profile full) it is a neutral tile, nothing lit — and let go there, it
 *   too lands in the left half.
 *
 * Only a tab's window goes to another space; a document's (the shell's own
 * window, docs/desk-documents.md) is put away into the Stack from over the
 * card, and the rail takes nothing of it. Nor does New space take anything
 * while the Profile holds as many spaces as it may (`spacesFull`): it would
 * make none, and the window would be gone with its tab left where it was.
 *
 * The desk's engine hears the pointer through the drag layer, which holds it
 * for the length of a carry: the sidebar's DOM sees no hover then, so its
 * targets are measured once (DeskHost.dockTargets) and hit-tested here by
 * geometry, in the window's coordinates. Pure on purpose — no DOM — so vitest
 * pins it under node (test/desk-dock-drop.test.ts).
 */

import { railTargetAt } from "../../components/space-rail/rail-model";
import type { Point, Rect } from "./geometry";

/** What a release over the column does: the tab moves to a space, becomes a space of its own or a Home tab, or the window is put away. */
export type DockDropKind = "space" | "new" | "home" | "collapse";

/** The rail item or card a drop goes into. */
export type DockItem = "home" | "new" | "space" | "card";

/** One of the rail's items as measured: Home, New space, or a space's tile (in the rail's scrolling list). */
export interface DockRailItem {
  item: "home" | "new" | "space";
  /** A space's id. */
  groupId: string | null;
  /** A space's colour (its TabGroupColor's name). */
  color: string | null;
  box: Rect;
  /** In the rail's scrolling list: it takes a drop only where the list shows it (railTargetAt). */
  listed: boolean;
}

/** The column beside the desk as a carried window reads it, in the window's coordinates. */
export interface DockTargets {
  /** The rail: its box, its scrolling list's visible span, and its items. */
  rail: { box: Rect; list: { top: number; bottom: number } | null; items: readonly DockRailItem[] } | null;
  /** The card (null on the rail alone): its box, the space it shows (null for Home's), and its rows' list. */
  card: { box: Rect; groupId: string | null; list: Rect | null } | null;
  /**
   * Home on the rail is the window's own tile: the desk's space is one of Home's (a loose tab's, a page's alone), or
   * the window's tab is a favorite's or pin's page, which is Home's already (the engine says so per window).
   */
  homeSpace: boolean;
  /**
   * The Profile holds as many drawn spaces as it may (MAX_TAB_GROUPS_PER_SPACE): New space makes none, so it takes
   * nothing — over it, and over the rail's ground, the window is a tile with nothing lit (2026-10-14).
   */
  spacesFull?: boolean;
}

/** A drop over the column: what it does, what it goes into, and that item's box and colour. */
export interface DockDrop {
  kind: DockDropKind;
  item: DockItem;
  groupId: string | null;
  color: string | null;
  box: Rect;
}

/** The shape a window takes over the column: one of the card's rows, or one of the rail's tiles. */
export type DockShape = "row" | "tile";

/** A rail tile (SpaceRail's `.space-rail-tile`) and its corner. */
export const DOCK_TILE = 38;
export const DOCK_TILE_RADIUS = 11;
/** A row of the card's lists (TabList's ROW_H), its corner (rounded-md), and the list's inset on either side (px-2). */
export const DOCK_ROW_H = 32;
export const DOCK_ROW_RADIUS = 8;
export const DOCK_ROW_INSET = 8;

function inside(box: Rect, point: Point): boolean {
  return point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;
}

/** A window over the column: the shape it takes there, and the drop a release would make (null: nothing there takes it). */
export interface DockOver {
  shape: DockShape;
  drop: DockDrop | null;
}

/**
 * What a window carried to `point` is over in the column, or null over
 * nothing of it that it would change shape for. `ownGroupId` is the desk's
 * space; `kind` the window's ("tab", or a document's "file").
 */
export function dockOverAt(point: Point, targets: DockTargets | null, ownGroupId: string | null, kind: "tab" | "file"): DockOver | null {
  if (targets === null) return null;
  const rail = targets.rail;
  if (rail !== null && inside(rail.box, point)) {
    if (kind !== "tab") return null;
    const found = railTargetAt(
      rail.items.map((item) => ({ ...item, top: item.box.y, bottom: item.box.y + item.box.h })),
      point.y,
      rail.list,
    );
    if (found !== null && found.item === "space") {
      if (found.groupId === null) return { shape: "tile", drop: null };
      const { groupId, color, box } = found;
      return { shape: "tile", drop: { kind: groupId === ownGroupId ? "collapse" : "space", item: "space", groupId, color, box } };
    }
    if (found !== null && found.item === "home") return { shape: "tile", drop: { kind: targets.homeSpace ? "collapse" : "home", item: "home", groupId: null, color: null, box: found.box } };
    // New space — or the rail's own ground, on none of its items (2026-10-26): a space of its own, going into New space.
    const plus = found ?? rail.items.find((item) => item.item === "new") ?? null;
    if (plus === null || targets.spacesFull === true) return { shape: "tile", drop: null };
    return { shape: "tile", drop: { kind: "new", item: "new", groupId: null, color: null, box: plus.box } };
  }
  const card = targets.card;
  if (card !== null && inside(card.box, point) && card.groupId !== null && card.groupId === ownGroupId) {
    return { shape: "row", drop: { kind: "collapse", item: "card", groupId: card.groupId, color: null, box: card.box } };
  }
  return null;
}

/** The drop a window carried to `point` would make, or null (dockOverAt's). */
export function dockDropAt(point: Point, targets: DockTargets | null, ownGroupId: string | null, kind: "tab" | "file"): DockDrop | null {
  return dockOverAt(point, targets, ownGroupId, kind)?.drop ?? null;
}

/**
 * Where the window is drawn while it is over the column as `shape`, the
 * pointer at `point` (the window's coordinates): a row of the card's list —
 * the list's rows' x and width, a row's height, its middle at the pointer,
 * kept within the list (or the card, with no list); or a tile centred on the
 * pointer.
 */
export function dockShapeRect(shape: DockShape, point: Point, targets: DockTargets): Rect {
  if (shape === "tile" || targets.card === null) return { x: point.x - DOCK_TILE / 2, y: point.y - DOCK_TILE / 2, w: DOCK_TILE, h: DOCK_TILE };
  const card = targets.card.box;
  const list = targets.card.list ?? { x: card.x + 2, y: card.y, w: card.w - 4, h: card.h };
  const span = list.h >= DOCK_ROW_H ? list : card;
  const y = Math.min(Math.max(point.y - DOCK_ROW_H / 2, span.y), span.y + Math.max(0, span.h - DOCK_ROW_H));
  return { x: list.x + DOCK_ROW_INSET, y, w: Math.max(DOCK_ROW_H, list.w - DOCK_ROW_INSET * 2), h: DOCK_ROW_H };
}

/** Two drops the same: what they do and go into (a pointer moving within one target changes nothing). */
export function sameDockDrop(a: DockDrop | null, b: DockDrop | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.item === b.item && a.groupId === b.groupId;
}
