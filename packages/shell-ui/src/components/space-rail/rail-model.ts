/**
 * The double sidebar's rules, kept pure — no React, no DOM — so vitest pins
 * them under node (test/double-sidebar.test.ts): which spaces stand on the
 * rail, which view the card shows (and when its turn is a Home tab grown into
 * a space), which rail item a row is let go on, where a drop among Today's
 * rows lands in the day's full row of units, where a tile dragged along the
 * rail puts its space, and the card's outline (docs/double-sidebar.md).
 */

import { SIDEBAR_CARD_INSET, SIDEBAR_RAIL_W } from "@pistachio/shell-contracts/chrome";
import type { SidebarMode } from "@pistachio/shell-contracts/settings";
import { dayRowUnits, type DayRowUnit, type TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";

/** The card's view: Home's, or a space's (its id). */
export type ColumnView = "home" | (string & {});

export const HOME_VIEW = "home";

/** A space on the rail: a drawn one (snapshot.tabGroups), or a page's group of two or more (snapshot.anchorGroups). */
export interface RailSpace {
  group: TabGroupInfo;
  /** A favorite's or pin's page with tabs opened beside it: named after its page, ordered by its entry. */
  page: boolean;
}

/** What the rail reads of the snapshot. */
export interface RailSnapshot {
  tabs: ReadonlyArray<{ id: string; anchorId: string | null }>;
  tabGroups: readonly TabGroupInfo[];
  splitGroups: ReadonlyArray<{ id: string; tabIds: readonly string[] }>;
  anchorGroups?: readonly TabGroupInfo[];
  looseGroups?: readonly TabGroupInfo[];
}

/**
 * The desktop column's width in each mode (layouts/SidebarLayout.tsx's slot):
 * the rail alone, or — whole, or brought out from hidden — the rail, the
 * card (the sidebar's width setting) and the gap to the desk's well.
 */
export function spaceColumnWidth(mode: SidebarMode, cardWidth: number): number {
  return mode === "rail" ? SIDEBAR_RAIL_W : SIDEBAR_RAIL_W + cardWidth + SIDEBAR_CARD_INSET;
}

/** The tabs of the pages' groups: drawn under their entries, never among the day's (as chrome/tabs.ts counts them). */
function pageTabIds(snapshot: RailSnapshot): Set<string> {
  return new Set((snapshot.anchorGroups ?? []).flatMap((group) => group.tabIds));
}

/**
 * The day's row units, as main and the sidebar's drop count them
 * (@pistachio/shell-contracts/tab-groups dayRowUnits): lone tabs, splits,
 * drawn spaces (empty ones where they stand). What Today and the rail are
 * both cut from.
 */
export function dayUnitsOf(snapshot: RailSnapshot): DayRowUnit[] {
  const underEntries = pageTabIds(snapshot);
  const day = snapshot.tabs.filter((tab) => tab.anchorId === null && !underEntries.has(tab.id)).map((tab) => tab.id);
  return dayRowUnits(day, snapshot.splitGroups, snapshot.tabGroups);
}

/**
 * The rail's spaces, top to bottom (docs/double-sidebar.md §1): every drawn
 * space in the row's order — where it stands among the day's units, an empty
 * one where it was left — then every page's group of two or more tabs in its
 * entry's order (`entryOrder`: the favorites', then the pins'). A space the
 * row does not place (none should be) goes after the row's.
 */
export function railSpacesOf(snapshot: RailSnapshot | null, entryOrder: readonly string[] = []): RailSpace[] {
  if (snapshot === null) return [];
  const byUnit = new Map(snapshot.tabGroups.map((group) => [`group:${group.id}`, group]));
  const drawn: RailSpace[] = [];
  const placed = new Set<string>();
  for (const unit of dayUnitsOf(snapshot)) {
    const group = unit.kind === "group" ? byUnit.get(unit.id) : undefined;
    if (group === undefined || placed.has(group.id)) continue;
    placed.add(group.id);
    drawn.push({ group, page: false });
  }
  for (const group of snapshot.tabGroups) if (!placed.has(group.id)) drawn.push({ group, page: false });
  const rank = (group: TabGroupInfo): number => {
    const at = entryOrder.indexOf(group.anchorId ?? "");
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  const pages = (snapshot.anchorGroups ?? [])
    .filter((group) => group.tabIds.length >= 2)
    .map((group, index) => ({ group, index }))
    .sort((a, b) => rank(a.group) - rank(b.group) || a.index - b.index)
    .map(({ group }): RailSpace => ({ group, page: true }));
  return [...drawn, ...pages];
}

/**
 * The card's view for the current space (docs/double-sidebar.md §2): Home's
 * while the space in use is one of Home's — a loose tab's, or a favorite's
 * or pin's page alone — and before main has named one; else the space's id.
 */
export function columnViewOf(currentGroupId: string | null, snapshot: RailSnapshot | null): ColumnView {
  if (currentGroupId === null || snapshot === null) return HOME_VIEW;
  if (snapshot.tabGroups.some((group) => group.id === currentGroupId)) return currentGroupId;
  const page = snapshot.anchorGroups?.find((group) => group.id === currentGroupId);
  if (page !== undefined && page.tabIds.length >= 2) return currentGroupId;
  return HOME_VIEW;
}

/** Whether a space is one of Home's: a loose tab's, or a page's alone. */
export function isHomeSpace(groupId: string, snapshot: RailSnapshot | null): boolean {
  if (snapshot === null) return false;
  if (snapshot.looseGroups?.some((group) => group.id === groupId) === true) return true;
  const page = snapshot.anchorGroups?.find((group) => group.id === groupId);
  return page !== undefined && page.tabIds.length < 2;
}

/** The Home tabs: every loose tab, and every favorite's or pin's page alone (what Today and the favorites draw as tabs). */
export function homeTabIdsOf(snapshot: Pick<RailSnapshot, "looseGroups" | "anchorGroups"> | null): Set<string> {
  if (snapshot === null) return new Set();
  return new Set([...(snapshot.looseGroups ?? []), ...(snapshot.anchorGroups ?? []).filter((group) => group.tabIds.length < 2)].flatMap((group) => group.tabIds));
}

/**
 * Whether the card's turn to `view` is a Home tab GROWN into a space
 * (docs/double-sidebar.md §1): Home was shown, the space chosen now is new on
 * the rail, and it holds a tab that was a Home tab a moment ago — its row
 * flying up to the new tile (SpaceFlights), which the card's turn and the
 * tab's slide wait for. Not a new space chosen while Home showed that holds
 * no Home tab of before (⌘N's, New space's, a space made of a space's tabs):
 * that one turns at once.
 */
export function grewInto(
  before: { view: ColumnView; rail: readonly RailSpace[]; homeTabIds: ReadonlySet<string> },
  view: ColumnView,
  rail: readonly RailSpace[],
): boolean {
  if (before.view !== HOME_VIEW || view === HOME_VIEW) return false;
  if (before.rail.some((space) => space.group.id === view)) return false;
  const space = rail.find((candidate) => candidate.group.id === view);
  return space !== undefined && space.group.tabIds.some((tabId) => before.homeTabIds.has(tabId));
}

/** A rail item a row can be let go on, as measured (viewport px): Home, New space, or a space's tile in the rail's scrolling list (`listed`). */
export interface RailTarget {
  top: number;
  bottom: number;
  listed: boolean;
}

/** How far past a rail item's edge a row let go still lands on it: half the 10px between two tiles. */
export const RAIL_DROP_SLACK = 5;

/**
 * The rail item a row held at `y` is over (chrome/shelf-drag.tsx's rail
 * drop), or null: the first whose box, `slack` taller at each edge, holds the
 * pointer. A space's tile counts only where it can be seen: within the
 * rail's list (`list`, its visible span), which it may be scrolled partly or
 * wholly out of — a tile scrolled under Home or the foot is not there to drop
 * on, and the pointer over the list's edge is never a tile beyond it.
 */
export function railTargetAt<T extends RailTarget>(targets: readonly T[], y: number, list: { top: number; bottom: number } | null, slack = RAIL_DROP_SLACK): T | null {
  for (const target of targets) {
    let top = target.top - slack;
    let bottom = target.bottom + slack;
    if (target.listed && list !== null) {
      top = Math.max(top, list.top);
      bottom = Math.min(bottom, list.bottom);
    }
    if (top < bottom && y >= top && y <= bottom) return target;
  }
  return null;
}

/**
 * A drop among Today's rows, at `visibleIndex` among the units Today DRAWS
 * (its loose rows: `visible`), as an index among ALL the day's units, which
 * main counts (reorderTab's "units"): the rail's spaces stand among the
 * same units, undrawn here. The row goes just after the drawn unit before
 * it — or, at the top, just before the first drawn one — so the spaces
 * between keep their places relative to it as the person saw them. With
 * no drawn unit at all, after every unit.
 */
export function fullUnitIndex<T>(units: readonly T[], visibleIndex: number, visible: (unit: T) => boolean): number {
  const shown: number[] = [];
  units.forEach((unit, index) => {
    if (visible(unit)) shown.push(index);
  });
  if (shown.length === 0) return units.length;
  if (visibleIndex <= 0) return shown[0] ?? units.length;
  const before = shown[Math.min(visibleIndex, shown.length) - 1];
  return before === undefined ? units.length : before + 1;
}

/** The inverse, for a row's own place before it moves (a drop back on it is no move): how many drawn units stand before `fullIndex`. */
export function visibleUnitIndex<T>(units: readonly T[], fullIndex: number, visible: (unit: T) => boolean): number {
  return units.slice(0, Math.max(0, fullIndex)).filter(visible).length;
}

/**
 * A space moved along the rail: its place among the day's units (main's
 * `move`, counted without the space itself, as a group row dropped among
 * the day's is), just before or after the space `target` it was let go on.
 * Null when either is no unit of the row (a page's space has no place there).
 */
export function railMoveIndex(units: ReadonlyArray<{ id: string }>, movingId: string, targetId: string, after: boolean): number | null {
  const moving = `group:${movingId}`;
  const rest = units.filter((unit) => unit.id !== moving);
  if (rest.length === units.length) return null;
  const at = rest.findIndex((unit) => unit.id === `group:${targetId}`);
  if (at < 0) return null;
  return after ? at + 1 : at;
}

/* ------------------------------- the outline ------------------------------- */

/**
 * The card's geometry, in the column's own coordinates (the window's: the
 * column starts at its left edge): its box, the shoulder's inner corner (the
 * pocket the traffic lights sit in), and the tab's leading edge.
 */
export interface CardFrame {
  /** The card's leading and trailing edges. */
  x0: number;
  x1: number;
  /** Its top and bottom. */
  y0: number;
  y1: number;
  /** The shoulder's inner corner: the card's top edge begins at `bx`, its leading edge below `by`. */
  bx: number;
  by: number;
  /** The tab's leading edge, out over the rail. */
  tabLeft: number;
}

/** Two decimals: a path redrawn every frame of a slide stays short. */
function f2(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

/**
 * The card's outline as one path (docs/double-sidebar.md §1; the lab's
 * variant B): an orthogonal polygon walked clockwise — the card's top from
 * the shoulder, its trailing edge, its foot, its leading edge up to the tab,
 * out round the tab and back, on up to the shoulder, and in round the
 * traffic lights' pocket — every corner rounded convex or concave by its
 * turn, and the radii shrunk where two corners share an edge too short for
 * both, so the tab can pass close to the shoulder and the foot. `tab` is the
 * tab's span along the leading edge (clamped below the shoulder and above
 * the foot), or null for none: a straight leading edge.
 */
export function cardOutline(frame: CardFrame, tab: { top: number; bottom: number } | null): string {
  const { x0, x1, y0, y1, bx, by, tabLeft } = frame;
  const points: Array<[number, number, number]> = [[bx, y0, 10], [x1, y0, 12], [x1, y1, 12], [x0, y1, 12]];
  if (tab !== null) {
    const top = Math.min(Math.max(by + 4, tab.top), y1 - 16);
    const bottom = Math.max(Math.min(tab.bottom, y1 - 2), top + 12);
    points.push([x0, bottom, 8], [tabLeft, bottom, 10], [tabLeft, top, 10], [x0, top, 8]);
  }
  points.push([x0, by, 10], [bx, by, 8]);
  const n = points.length;
  const radii = points.map((point) => point[2]);
  const shrunk = radii.slice();
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const j = (i + 1) % n;
    const b = points[j]!;
    const length = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
    const need = radii[i]! + radii[j]!;
    if (need > length) {
      const f = length / need;
      shrunk[i] = Math.min(shrunk[i]!, radii[i]! * f);
      shrunk[j] = Math.min(shrunk[j]!, radii[j]! * f);
    }
  }
  let d = "";
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const prev = points[(i + n - 1) % n]!;
    const next = points[(i + 1) % n]!;
    const ix = Math.sign(p[0] - prev[0]);
    const iy = Math.sign(p[1] - prev[1]);
    const ox = Math.sign(next[0] - p[0]);
    const oy = Math.sign(next[1] - p[1]);
    const r = shrunk[i]!;
    const sweep = ix * oy - iy * ox > 0 ? 1 : 0;
    d += `${i === 0 ? "M" : "L"}${f2(p[0] - ix * r)} ${f2(p[1] - iy * r)}A${f2(r)} ${f2(r)} 0 0 ${sweep} ${f2(p[0] + ox * r)} ${f2(p[1] + oy * r)}`;
  }
  return `${d}Z`;
}

/** On the rail alone, the chosen tile's backing: the tab without its card, a rounded box `left`..`right` by `top`..`bottom`. */
export function backingOutline(left: number, right: number, top: number, bottom: number, radius = 11): string {
  const r = Math.min(radius, (right - left) / 2, (bottom - top) / 2);
  return `M${f2(left + r)} ${f2(top)}H${f2(right - r)}A${f2(r)} ${f2(r)} 0 0 1 ${f2(right)} ${f2(top + r)}V${f2(bottom - r)}A${f2(r)} ${f2(r)} 0 0 1 ${f2(right - r)} ${f2(bottom)}H${f2(left + r)}A${f2(r)} ${f2(r)} 0 0 1 ${f2(left)} ${f2(bottom - r)}V${f2(top + r)}A${f2(r)} ${f2(r)} 0 0 1 ${f2(left + r)} ${f2(top)}Z`;
}

/**
 * cubic-bezier(x1, y1, x2, y2) as a function of progress — the house curve
 * (`cubic-bezier(0.2, 0.8, 0.3, 1)`) for the tab's slide, which is drawn
 * frame by frame and so cannot ride a CSS transition.
 */
export function cubicBezier(p1x: number, p1y: number, p2x: number, p2y: number): (x: number) => number {
  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number): number => ((ay * t + by) * t + cy) * t;
  const dx = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-5) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 30; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-5) break;
      if (x > v) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

/** The house ease. */
export const HOUSE_EASE = cubicBezier(0.2, 0.8, 0.3, 1);
