/**
 * The Bar's answer, floating (docs/desk-agent.md, "The answer, detached"):
 * where a card taken off the Bar may go and rest, the zone that takes it
 * back, the tiles it snaps into as a window does and the chat's own place
 * (the desk's trailing side, its whole height, the message field in the
 * card), and its box kept on this device. The motion itself — the lift, the
 * tear, the morph, the throw — is components/desk/answer-motion.ts; this is
 * the geometry it asks, pure so vitest pins it under node.
 *
 * Coordinates are the Bar's lane's (the desk less its gutters), in px.
 */

import { clamp, type SpringConfig } from "./motion";
import { DESK_GAP, SNAP_EDGE, edgeZone, tileRect, type Point, type Rect, type TileZone } from "./geometry";

/** How far from the lane's edges a floating card rests, and the anchors stand. */
export const FLOAT_EDGE = 12;
/** The docked card's gap above the pill (it is as wide as the pill, on it). */
export const DOCK_GAP = 8;
/** Pulled this far from where it was pressed, a docked card tears off. */
export const TEAR_PX = 42;
/** The card's foot within this of its docked slot's foot (over the Bar) is the zone that takes it back. */
export const DOCK_ZONE_PX = 36;
/** As small as a floating card may be made: its header still whole, a few lines of the thread, and its message field. */
export const FLOAT_MIN = { w: 320, h: 260 } as const;
/** A floating card's message field and the room round it, at its foot (the pill's row, moved into it). */
export const FIELD_H = 60;
/** The width a card torn off takes, when it has none of its own yet: the pill's at its widest, so it keeps its width. */
export const FLOAT_W = 480;
/** Corner radii: docked, the Bar's card; floating, a window's. */
export const RADIUS_DOCKED = 18;
export const RADIUS_FLOATING = 14;
/** A throw whose landing is this near an anchor glides into it; a gentle release, this near. */
export const ANCHOR_THROW_PX = 240;
export const ANCHOR_SETTLE_PX = 80;
/** Resting this close to an edge, it goes flush. */
export const EDGE_MAGNET_PX = 28;
/** The chat's own place: the desk's whole height at its trailing side, this wide until it is resized (from its leading edge). */
export const CHAT_W = FLOAT_W;
/** …no narrower than a floating card may be, and no wider than this share of the desk. */
export const CHAT_MAX_SHARE = 0.6;
/** The pointer this far in from the trailing edge, short of the edge itself (where the right half lights), lights the chat's place. */
export const CHAT_BAND_PX = 120;
/** And from this far in, the chat's place is hinted, brighter as the pointer comes nearer. */
export const CHAT_HINT_PX = 360;

/** Springs as the desk tunes them (lib/desk/motion.ts): one swing (s), and damping (1 = no overshoot). */
export const ANSWER_SPRINGS = {
  /** Docked → window, under the pointer. */
  tear: { response: 0.32, damping: 0.92 },
  /** A short pull let go: back into the slot. */
  back: { response: 0.28, damping: 0.9 },
  /** Window → slot: a confident landing with a small settle. */
  dock: { response: 0.4, damping: 0.8 },
  /** Thrown into an anchor: glides in and stops on it. */
  anchor: { response: 0.34, damping: 1 },
  /** Magnets, kept inside. */
  settle: { response: 0.3, damping: 1 },
  /** A coast that met an edge. */
  rebound: { response: 0.3, damping: 0.7 },
  /** The press's lift, the zone's preview, the Bar's call. */
  lift: { response: 0.16, damping: 1 },
  preview: { response: 0.24, damping: 1 },
  pulse: { response: 0.3, damping: 0.5 },
} as const satisfies Record<string, SpringConfig>;

/** What the lane holds that a floating card must reckon with. */
export interface FloatArea {
  /** The lane's size. */
  w: number;
  h: number;
  /** The pill's span across the lane, and its top. */
  barX: number;
  barW: number;
  barTop: number;
  /** The desk itself (the lane's stage, its gutters too), whose tiles a card snaps into as a window does: the lane's box if not given. */
  stage?: Rect;
}

/** Where a card in hand lands if let go: a tile of the desk, as a window's, or the chat's own place. */
export type AnswerZone = TileZone | "chat";

const ZONES: ReadonlySet<string> = new Set<AnswerZone>(["left", "right", "top-left", "top-right", "bottom-left", "bottom-right", "maximize", "center", "chat"]);

/** The desk, in the lane's coordinates. */
export function stageOf(area: FloatArea): Rect {
  return area.stage ?? { x: 0, y: 0, w: area.w, h: area.h };
}

/** The docked card's slot: the pill's span, `height` tall, its foot DOCK_GAP above the pill. */
export function dockSlot(area: FloatArea, height: number): Rect {
  const h = Math.max(1, Math.min(height, area.barTop - DOCK_GAP - FLOAT_EDGE));
  return { x: area.barX, y: area.barTop - DOCK_GAP - h, w: area.barW, h };
}

/** Whether a box of this x and width lies over the Bar's span (a hair past its ends). */
export function overBar(area: FloatArea, x: number, w: number): boolean {
  return x < area.barX + area.barW + 6 && x + w > area.barX - 6;
}

/** The lowest a resting card of this box may sit: clear of the Bar over its span, else the lane's foot. */
export function bottomLimit(area: FloatArea, x: number, w: number, h: number): number {
  let bottom = area.h - h - FLOAT_EDGE;
  if (overBar(area, x, w) && area.barTop - FLOAT_EDGE - h >= FLOAT_EDGE) bottom = area.barTop - FLOAT_EDGE - h;
  return Math.max(FLOAT_EDGE, bottom);
}

/**
 * The lowest a card in hand may go: over the Bar, no lower than its docked
 * slot (it sits on the Bar, never slides under it); beside it, the lane's
 * foot. Eased over the first 40px of overlap, so moving onto the Bar's span
 * lifts it smoothly rather than in a step.
 */
export function dragFloor(area: FloatArea, x: number, w: number, h: number): number {
  const overlap = Math.min(x + w, area.barX + area.barW + 10) - Math.max(x, area.barX - 10);
  const k = clamp(overlap / 40, 0, 1);
  const t = k * k * (3 - 2 * k);
  return area.h - h + (area.barTop - DOCK_GAP - h - (area.h - h)) * t;
}

/** Where a card of this box comes to rest: whole in the lane, clear of the Bar, and (`magnet`) flush with an edge it is near. */
export function restFor(area: FloatArea, box: Rect, magnet = true): { x: number; y: number } {
  let x = clamp(box.x, FLOAT_EDGE, Math.max(FLOAT_EDGE, area.w - box.w - FLOAT_EDGE));
  if (magnet) {
    if (x - FLOAT_EDGE < EDGE_MAGNET_PX) x = FLOAT_EDGE;
    else if (area.w - box.w - FLOAT_EDGE - x < EDGE_MAGNET_PX) x = Math.max(FLOAT_EDGE, area.w - box.w - FLOAT_EDGE);
  }
  const maxY = bottomLimit(area, x, box.w, box.h);
  let y = clamp(box.y, FLOAT_EDGE, maxY);
  if (magnet) {
    if (y - FLOAT_EDGE < EDGE_MAGNET_PX) y = FLOAT_EDGE;
    else if (maxY - y < EDGE_MAGNET_PX) y = maxY;
  }
  return { x, y };
}

/** The places a floating card settles into, as the floating player's do: each side's top, middle and foot. */
export function anchors(area: FloatArea, w: number, h: number): Array<{ x: number; y: number }> {
  const spots: Array<{ x: number; y: number }> = [];
  for (const x of [FLOAT_EDGE, Math.max(FLOAT_EDGE, area.w - w - FLOAT_EDGE)]) {
    const top = FLOAT_EDGE;
    const bottom = bottomLimit(area, x, w, h);
    const middle = clamp((area.h - h) / 2, top, bottom);
    spots.push({ x, y: top });
    if (middle - top > 48 && bottom - middle > 48) spots.push({ x, y: middle });
    if (bottom - top > 48) spots.push({ x, y: bottom });
  }
  return spots;
}

/** The anchor whose card's centre is nearest a point, and how near. */
export function nearestAnchor(area: FloatArea, cx: number, cy: number, w: number, h: number): { spot: { x: number; y: number }; distance: number } | null {
  let best: { spot: { x: number; y: number }; distance: number } | null = null;
  for (const spot of anchors(area, w, h)) {
    const distance = Math.hypot(spot.x + w / 2 - cx, spot.y + h / 2 - cy);
    if (best === null || distance < best.distance) best = { spot, distance };
  }
  return best;
}

/**
 * Whether a card of this box, held at `pointer`, is over the zone that docks
 * it: its foot down at the slot over the Bar's span, or the pointer on the
 * Bar itself. `approach` (0–1) is how near it has come, for the slot's ghost
 * to fade in by.
 */
export function dockZone(area: FloatArea, slot: Rect, box: Rect, pointer: { x: number; y: number }): { inZone: boolean; approach: number } {
  const dx = Math.abs(box.x + box.w / 2 - (slot.x + slot.w / 2));
  const bottom = box.y + box.h;
  const slotBottom = slot.y + slot.h;
  const inZone = (dx < slot.w / 2 + 8 && bottom > slotBottom - DOCK_ZONE_PX) || pointerOnBar(area, pointer);
  const above = Math.max(0, slotBottom - DOCK_ZONE_PX - bottom);
  const outX = Math.max(0, dx - slot.w / 2);
  const near = clamp(1 - above / 260, 0, 1);
  return { inZone, approach: near * near * clamp(1 - outX / 200, 0, 1) };
}

/** Whether the pointer is on the Bar (a hair past its ends): a card held there goes home, whatever else it is over. */
export function pointerOnBar(area: FloatArea, pointer: Point): boolean {
  return pointer.y > area.barTop - 6 && Math.abs(pointer.x - (area.barX + area.barW / 2)) < area.barW / 2 + 10;
}

/**
 * The zone a card in hand arms, as a window carried there does
 * (edgeZone): pushed into a side, that half; into the top, the whole desk;
 * the ends of an edge, the quarters in that corner. And one a window has
 * not: brought toward the trailing side, short of its edge, the chat's own
 * place. Past an edge counts as at it.
 */
export function snapZone(area: FloatArea, pointer: Point): AnswerZone | null {
  const stage = stageOf(area);
  const edge = edgeZone(pointer, stage);
  if (edge !== null) return edge;
  return pointer.x >= stage.x + stage.w - SNAP_EDGE - CHAT_BAND_PX ? "chat" : null;
}

/** How near the pointer has come to the chat's place (0 from CHAT_HINT_PX in, 1 at its band): its hint brightens by it. */
export function chatApproach(area: FloatArea, pointer: Point): number {
  const stage = stageOf(area);
  const band = stage.x + stage.w - SNAP_EDGE - CHAT_BAND_PX;
  const k = clamp(1 - (band - pointer.x) / (CHAT_HINT_PX - CHAT_BAND_PX), 0, 1);
  return k * k;
}

/**
 * The chat's place at this width (kept within CHAT_MAX_SHARE of the desk):
 * the desk's whole height at its trailing side, the nub a hole in its foot
 * corner (as in a window there) and its message field beside the nub, where
 * the pill lies. The windows keep out of it (DeskEngine.setReserve).
 */
export function chatBox(area: FloatArea, width: number): Rect {
  const stage = stageOf(area);
  const w = clamp(width, Math.min(FLOAT_MIN.w, stage.w), Math.max(Math.min(FLOAT_MIN.w, stage.w), stage.w * CHAT_MAX_SHARE));
  return { x: stage.x + stage.w - w, y: stage.y, w, h: stage.h };
}

/**
 * Where a card snapped into `zone` lies. A tile is a window's (tileRect),
 * but over the Bar's span it stops a gap above the Bar's line, as a
 * resting card keeps clear of it; the middle tile is the card at its own
 * size, centred. `chatW` is the chat's width, `size` the card's own.
 */
export function zoneBox(area: FloatArea, zone: AnswerZone, chatW: number, size: { w: number; h: number }): Rect {
  if (zone === "chat") return chatBox(area, chatW);
  const stage = stageOf(area);
  const foot = area.barTop - DESK_GAP;
  if (zone === "center") {
    const fit = fitFloatSize(area, size.w, size.h);
    const x = stage.x + (stage.w - fit.w) / 2;
    const bottom = overBar(area, x, fit.w) ? foot : stage.y + stage.h;
    return { x, y: Math.max(stage.y, Math.min(stage.y + (stage.h - fit.h) / 2, bottom - fit.h)), w: fit.w, h: fit.h };
  }
  const tile = tileRect(zone, stage);
  if (!overBar(area, tile.x, tile.w) || tile.y + tile.h <= foot) return tile;
  return { ...tile, h: Math.max(Math.min(FLOAT_MIN.h, tile.h), foot - tile.y) };
}

/** The chat's place resized from its leading edge, `dx` from where the press began: its trailing edge holds on the desk's. */
export function chatResized(area: FloatArea, from: Rect, dx: number): Rect {
  return chatBox(area, from.w - dx);
}

/** Where a card that was in a tile comes to rest once resized out of it: whole on the desk (flush with its edges, as the tile was) and clear of the Bar. */
export function restInStage(area: FloatArea, box: Rect): { x: number; y: number } {
  const stage = stageOf(area);
  const x = clamp(box.x, stage.x, Math.max(stage.x, stage.x + stage.w - box.w));
  let bottom = stage.y + stage.h - box.h;
  if (overBar(area, x, box.w)) bottom = Math.min(bottom, area.barTop - DESK_GAP - box.h);
  return { x, y: clamp(box.y, stage.y, Math.max(stage.y, bottom)) };
}

/** A floating card's size, whole in the lane and no smaller than it may be (unless the lane is). */
export function fitFloatSize(area: FloatArea, w: number, h: number): { w: number; h: number } {
  const maxW = Math.max(1, area.w - 2 * FLOAT_EDGE);
  const maxH = Math.max(1, area.h - 2 * FLOAT_EDGE);
  return { w: clamp(w, Math.min(FLOAT_MIN.w, maxW), maxW), h: clamp(h, Math.min(FLOAT_MIN.h, maxH), maxH) };
}

/**
 * A floating card's box under an edge or corner in hand: that edge follows
 * the pointer (`dx`, `dy` from where the press began), the opposite one
 * holds still, and it stays whole in `bounds` (the lane, FLOAT_EDGE in; a
 * card in a tile, the desk) at its smallest size or more.
 */
export function resizedBox(
  area: FloatArea,
  from: Rect,
  edges: { l: boolean; r: boolean; t: boolean; b: boolean },
  dx: number,
  dy: number,
  bounds: Rect = { x: FLOAT_EDGE, y: FLOAT_EDGE, w: area.w - 2 * FLOAT_EDGE, h: area.h - 2 * FLOAT_EDGE },
): Rect {
  const minW = Math.min(FLOAT_MIN.w, bounds.w);
  const minH = Math.min(FLOAT_MIN.h, bounds.h);
  let left = from.x;
  let top = from.y;
  let right = from.x + from.w;
  let bottom = from.y + from.h;
  if (edges.l) left = clamp(from.x + dx, Math.min(bounds.x, right - minW), right - minW);
  if (edges.r) right = clamp(right + dx, left + minW, Math.max(left + minW, bounds.x + bounds.w));
  if (edges.t) top = clamp(from.y + dy, Math.min(bounds.y, bottom - minH), bottom - minH);
  if (edges.b) bottom = clamp(bottom + dy, top + minH, Math.max(top + minH, bounds.y + bounds.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * A value past [min, max] given way to with diminishing returns, as a held
 * window pressed past an edge: never more than `give` px past min, nor
 * `giveMax` past max.
 */
export function rubber(value: number, min: number, max: number, give = 80, giveMax = give): number {
  const past = (over: number, limit: number): number => (1 - 1 / ((over * 0.55) / limit + 1)) * limit;
  const hi = Math.max(min, max);
  if (value < min) return min - past(min - value, give);
  if (value > hi) return hi + past(value - hi, giveMax);
  return value;
}

/* ------------------------------ kept on this device ------------------------------ */

/**
 * Whether the answer floats, and where: its place as a share of the lane,
 * its own size in px, and the zone it is snapped in (its place and size
 * then the zone's; its own size what it takes back once taken out). `cw`:
 * the chat's place's width, as it was last resized.
 */
export interface FloatSpot {
  floating: boolean;
  fx: number;
  fy: number;
  w: number;
  h: number;
  zone?: AnswerZone;
  cw?: number;
  /** Out of a tile by a resize: in the desk's frame, flush where it stood (AnswerMotion's #inStage) — kept so it comes back there, not moved in to the lane's corner (2026-10-10). */
  inStage?: boolean;
}

const SPOT_KEY = "pistachio.desk.answer.v1";

export function readFloatSpot(): FloatSpot | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SPOT_KEY) ?? "null");
    if (typeof raw !== "object" || raw === null) return null;
    const { floating, fx, fy, w, h, zone, cw, inStage } = raw as Record<string, unknown>;
    if (typeof floating !== "boolean") return null;
    for (const n of [fx, fy, w, h]) if (typeof n !== "number" || !Number.isFinite(n)) return null;
    const spot: FloatSpot = { floating, fx: fx as number, fy: fy as number, w: w as number, h: h as number };
    if (typeof zone === "string" && ZONES.has(zone)) spot.zone = zone as AnswerZone;
    if (typeof cw === "number" && Number.isFinite(cw) && cw > 0) spot.cw = cw;
    if (inStage === true && spot.zone === undefined) spot.inStage = true;
    return spot;
  } catch {
    return null;
  }
}

export function writeFloatSpot(spot: FloatSpot): void {
  try {
    localStorage.setItem(SPOT_KEY, JSON.stringify(spot));
  } catch {
    // (Kept for this session only.)
  }
}

/** A kept spot as a box in a lane of this size: its zone's, or its size fitted and its place clamped to rest. */
export function boxFromSpot(area: FloatArea, spot: FloatSpot): Rect {
  if (spot.zone !== undefined) return zoneBox(area, spot.zone, spot.cw ?? CHAT_W, { w: spot.w, h: spot.h });
  if (spot.inStage === true) {
    // In the desk's frame: its size within the desk, its place flush where it stood.
    const stage = stageOf(area);
    const size = { w: clamp(spot.w, Math.min(FLOAT_MIN.w, stage.w), stage.w), h: clamp(spot.h, Math.min(FLOAT_MIN.h, stage.h), stage.h) };
    return { ...restInStage(area, { x: spot.fx * area.w, y: spot.fy * area.h, ...size }), ...size };
  }
  const size = fitFloatSize(area, spot.w, spot.h);
  const place = restFor(area, { x: spot.fx * area.w, y: spot.fy * area.h, ...size }, false);
  return { ...place, ...size };
}

/** A box as the spot it is kept as. */
export function spotFromBox(area: FloatArea, box: Rect, floating: boolean): FloatSpot {
  return { floating, fx: area.w > 0 ? box.x / area.w : 0, fy: area.h > 0 ? box.y / area.h : 0, w: Math.round(box.w), h: Math.round(box.h) };
}
