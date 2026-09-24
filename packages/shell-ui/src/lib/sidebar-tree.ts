/**
 * The sidebar shelf as rows, and where a drag over them would drop. Pure —
 * no React, no DOM — so vitest pins the drop geometry under node
 * (test/sidebar-tree.test.ts).
 *
 * The sidebar's tab area is one column of rows: the pinned section (folder
 * headers and pins, a folder's pins indented under it while it is open),
 * the "New tab" row as the divider, then the day's tabs. A drag of any row
 * — or of a favorite tile from the grid above — names a slot in that column
 * by pointer position; `listDropAt` turns the slot into a placement the
 * shelf understands (@pistachio/shell-contracts/sidebar Placement) or an index among the
 * day's tabs. The favorites grid is its own zone (`favoriteDropAt`).
 */

import { childrenOf, type SidebarEntry, type SidebarFolder, type SidebarPin } from "@pistachio/shell-contracts/sidebar";

/** What is being dragged. A split group, like a tab group, is one item that cannot be pinned: it moves among the day's tabs only. */
export type ShelfDragKind = "tab" | "split" | "group" | "pin" | "folder" | "favorite";

/** The kinds that live only among the day's tabs. */
const dayOnly = (kind: ShelfDragKind): boolean => kind === "split" || kind === "group";

/** A row of the pinned section as drawn: a folder header, or a pin at its depth. */
export type PinnedRow = { kind: "folder"; folder: SidebarFolder; count: number } | { kind: "pin"; pin: SidebarPin; depth: 0 | 1 };

/** The pinned section's rows in display order; a collapsed folder's pins are not rows. */
export function pinnedRows(entries: readonly SidebarEntry[], options: { openFolderId?: string | null } = {}): PinnedRow[] {
  const rows: PinnedRow[] = [];
  for (const entry of entries) {
    if (entry.kind === "pin") {
      if (entry.folderId === null) rows.push({ kind: "pin", pin: entry, depth: 0 });
      continue;
    }
    const children = childrenOf(entries, entry.id);
    rows.push({ kind: "folder", folder: entry, count: children.length });
    // A folder a drag is about to drop into shows its pins even while collapsed.
    if (entry.collapsed && options.openFolderId !== entry.id) continue;
    for (const pin of children) rows.push({ kind: "pin", pin, depth: 1 });
  }
  return rows;
}

/* ------------------------------ drop slots ------------------------------ */

/**
 * One measured row of the column, as the drag sees it. Among the day's tabs a
 * tab group is a `group` row — its HEADER's box — followed, while it is open,
 * by a `member` row for each of its tabs (docs/tab-tidy.md §3.3).
 */
export interface MeasuredRow {
  kind: "folder" | "pin" | "divider" | "tab" | "group" | "member";
  /** The folder's or pin's shelf id, the tab row's item id, a group's unit id. */
  entityId: string;
  /** A pin's folder (null at the top level); null for every other kind. */
  folderId: string | null;
  /** A group header's own tab group, a member's group; absent for every other kind. */
  groupId?: string | null;
  /** A folder or a group whose children are not rows right now. */
  collapsed?: boolean;
  /** Layout box along the column, in the same space as the pointer's y. */
  top: number;
  height: number;
}

export type ListDrop =
  | { zone: "pinned"; folderId: string | null; index: number }
  /** Among the day's ROW UNITS: lone tabs, splits, and tab groups, each one slot. */
  | { zone: "today"; index: number }
  /** Into a tab group, at `index` among its tabs (counted without what is dragged). */
  | { zone: "group"; groupId: string; index: number };

/**
 * Dragging a pin left of this x at the end of a folder's run leaves the
 * folder; at or right of it, the pin stays inside. The one ambiguous slot in
 * the tree — below a folder's last pin — is resolved by the pointer's x, the
 * way an outliner does it.
 */
export const PIN_INDENT = 18;

/** The same rule for the slot below a tab group's last tab: at or right of this x stays in the group. */
export const GROUP_INDENT = 18;

/**
 * "At the end of the group", said without counting: a CLOSED group has no
 * rows to count, and it opens under the pointer only after the drop naming
 * it is made — so a count taken then would be stale the moment it was used.
 * Every consumer clamps an index to the group's length.
 */
export const GROUP_END = 10_000;

/**
 * Where a drop lands, from the rows the drag is NOT carrying (the dragged
 * row and, for a folder, its pins are left out) and the pointer in the rows'
 * coordinate space. `kind` bounds it: a folder only ever lands at the top
 * level of the pinned section, a split group only among the day's tabs.
 *
 * Hovering the middle of a folder's header drops INTO it (at the end), so a
 * collapsed folder can still take a pin; every other position is a slot
 * between rows, read off the rows' centres.
 */
export function listDropAt(measured: readonly MeasuredRow[], kind: ShelfDragKind, y: number, x: number): ListDrop {
  // Only a live row — a tab, a split — can be set down inside a tab group.
  // For everything else a group is the one slot its header is, and its open
  // tabs are not rows at all.
  const canJoin = kind === "tab" || kind === "split";
  const rows = canJoin ? measured : measured.filter((row) => row.kind !== "member");
  const dividerAt = rows.findIndex((row) => row.kind === "divider");
  const divider = dividerAt < 0 ? rows.length : dividerAt;
  const topLevelBefore = (i: number): number =>
    rows.slice(0, i).filter((row) => row.kind === "folder" || (row.kind === "pin" && row.folderId === null)).length;
  const childrenBefore = (folderId: string, i: number): number =>
    rows.slice(0, i).filter((row) => row.kind === "pin" && row.folderId === folderId).length;
  const childCount = (folderId: string): number => rows.filter((row) => row.kind === "pin" && row.folderId === folderId).length;
  /** The day's index counts UNITS — a group's tabs are not slots among the day's rows. */
  const unitsBefore = (i: number): number => rows.slice(divider + 1, i).filter((row) => row.kind === "tab" || row.kind === "group").length;
  const membersBefore = (groupId: string, i: number): number => rows.slice(0, i).filter((row) => row.kind === "member" && row.groupId === groupId).length;

  if (kind !== "folder" && !dayOnly(kind)) {
    const over = rows.find((row) => y >= row.top && y < row.top + row.height);
    if (over !== undefined && over.kind === "folder" && y >= over.top + over.height * 0.25 && y < over.top + over.height * 0.75) {
      return { zone: "pinned", folderId: over.entityId, index: childCount(over.entityId) };
    }
  }

  if (canJoin) {
    // The middle of a group's header drops INTO it (at the end), so a closed group can take a tab.
    const over = rows.find((row) => y >= row.top && y < row.top + row.height);
    if (over !== undefined && over.kind === "group" && typeof over.groupId === "string" && y >= over.top + over.height * 0.25 && y < over.top + over.height * 0.75) {
      return { zone: "group", groupId: over.groupId, index: GROUP_END };
    }
  }

  let i = 0;
  while (i < rows.length && (rows[i]?.top ?? 0) + (rows[i]?.height ?? 0) / 2 < y) i += 1;

  if (canJoin && i > divider) {
    const above = rows[i - 1];
    const below = rows[i];
    // Just under an open group's header: its head.
    if (above?.kind === "group" && typeof above.groupId === "string" && below?.kind === "member" && below.groupId === above.groupId) {
      return { zone: "group", groupId: above.groupId, index: 0 };
    }
    // Between two of its tabs — or under its last, where the pointer's x decides, as it does for a folder.
    if (above?.kind === "member" && typeof above.groupId === "string") {
      const between = below?.kind === "member" && below.groupId === above.groupId;
      if (between || x >= GROUP_INDENT) return { zone: "group", groupId: above.groupId, index: membersBefore(above.groupId, i) };
    }
  }

  if (kind === "folder") {
    i = Math.min(i, divider);
    // Never inside another folder's run: step past it.
    while (i < divider && rows[i]?.kind === "pin" && rows[i]?.folderId !== null) i += 1;
    return { zone: "pinned", folderId: null, index: topLevelBefore(i) };
  }
  if (dayOnly(kind) || i > divider) return { zone: "today", index: unitsBefore(i) };

  const prev = i > 0 ? rows[i - 1] : undefined;
  const next = rows[i];
  if (prev !== undefined && prev.kind === "folder" && prev.collapsed !== true) {
    return { zone: "pinned", folderId: prev.entityId, index: 0 };
  }
  if (prev !== undefined && prev.kind === "pin" && prev.folderId !== null) {
    const folderId = prev.folderId;
    const nextInside = next !== undefined && next.kind === "pin" && next.folderId === folderId;
    if (nextInside || x >= PIN_INDENT) return { zone: "pinned", folderId, index: childrenBefore(folderId, i) };
  }
  return { zone: "pinned", folderId: null, index: topLevelBefore(i) };
}

/** One measured favorite tile, in reading order, in the pointer's coordinate space. */
export interface MeasuredTile {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The index among the tiles a drop would take: the tiles in rows above the
 * pointer, plus those in the pointer's row whose centre is left of it. The
 * tiles passed exclude the dragged one, so the index is the position among
 * the rest — placeFavorite's convention.
 */
export function favoriteDropAt(tiles: readonly MeasuredTile[], x: number, y: number): number {
  let index = 0;
  for (const tile of tiles) {
    const centerX = tile.left + tile.width / 2;
    const centerY = tile.top + tile.height / 2;
    const rowAbove = centerY < y - tile.height / 2;
    const sameRow = Math.abs(centerY - y) <= tile.height / 2;
    if (rowAbove || (sameRow && centerX < x)) index += 1;
  }
  return index;
}
