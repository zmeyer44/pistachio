/**
 * The notice stack's bookkeeping, kept pure so it can be tested without a
 * DOM: what saying something does to the live notices (the store), what a
 * change to them does to the cards on screen, and where each card stands
 * (components/NoticeStack.tsx draws exactly what `cardPose` answers).
 *
 * The look is a Sonner-style stack. The newest card is in front; older ones
 * are pushed back behind it — smaller, fainter, a sliver showing — and the
 * pointer spreads them into a column. A fourth card pushes the oldest off
 * the back. Every move is one transition of transform, opacity and blur.
 */

import {
  NOTICE_LIMIT,
  NOTICE_PEEK,
  noticeSpreadLift,
  type NoticeEdge,
  type NoticeItem,
  type NoticeTone,
} from "@pistachio/shell-contracts/notice";

/** A notice as the store holds it: the wire item, and the action's code, which never leaves the shell. */
export interface ShellNotice {
  id: number;
  message: string;
  tone: NoticeTone;
  action: { label: string; run(): void } | null;
  bumps: number;
}

export interface NoticeOptions {
  tone?: NoticeTone;
  action?: { label: string; run(): void };
}

export function noticeItem(notice: ShellNotice): NoticeItem {
  return {
    id: notice.id,
    message: notice.message,
    tone: notice.tone,
    actionLabel: notice.action?.label ?? null,
    bumps: notice.bumps,
  };
}

/**
 * Say something. The same words again, while they are still the newest
 * thing said, nudge that card rather than stack a copy of it — ⌘⇧C pressed
 * three times is one "URL copied" that acknowledges each press. Anything
 * else joins the front, and past the limit the oldest goes.
 */
export function pushNotice(notices: readonly ShellNotice[], id: number, message: string, options: NoticeOptions = {}): ShellNotice[] {
  const tone = options.tone ?? "neutral";
  const action = options.action ?? null;
  const newest = notices[notices.length - 1];
  if (newest !== undefined && newest.message === message && newest.tone === tone && newest.action === null && action === null) {
    return [...notices.slice(0, -1), { ...newest, bumps: newest.bumps + 1 }];
  }
  return [...notices, { id, message, tone, action, bumps: 0 }].slice(-NOTICE_LIMIT);
}

/* ---------------------------------- cards -------------------------------- */

/**
 * - `enter`: mounted this frame, held closed with no transition; promoted
 *   to `live` — opened — before the frame is painted.
 * - `out`: dismissed or timed out — closes again, back the way it came.
 * - `back`: pushed off the back of a full stack by a new arrival.
 */
export type CardPhase = "enter" | "live" | "out" | "back";

export interface StackCard {
  item: NoticeItem;
  phase: CardPhase;
  /** 0 is the front. A leaving card keeps the depth it left from (`back`: one further). */
  depth: number;
}

export function isLeaving(card: StackCard): boolean {
  return card.phase === "out" || card.phase === "back";
}

/** The cards after the live notices (oldest first) changed. Oldest first, leaving cards kept until pruned. */
export function reconcileCards(cards: readonly StackCard[], items: readonly NoticeItem[]): StackCard[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const known = new Set(cards.map((card) => card.item.id));
  const arrived = items.some((item) => !known.has(item.id));
  const liveBefore = cards.filter((card) => !isLeaving(card));
  const deepest = liveBefore.reduce((max, card) => Math.max(max, card.depth), -1);
  const depthOf = (id: number): number => items.length - 1 - items.findIndex((item) => item.id === id);

  const next: StackCard[] = [];
  for (const card of cards) {
    if (isLeaving(card)) {
      next.push(card);
      continue;
    }
    const item = byId.get(card.item.id);
    if (item !== undefined) {
      next.push({ item, phase: card.phase, depth: depthOf(item.id) });
      continue;
    }
    // Gone from the list. Off the back if an arrival is what pushed it out
    // of a full stack; otherwise it was dismissed or ran out of time.
    const pushed = arrived && liveBefore.length >= NOTICE_LIMIT && card.depth === deepest;
    next.push(pushed ? { item: card.item, phase: "back", depth: card.depth + 1 } : { item: card.item, phase: "out", depth: card.depth });
  }
  for (const item of items) {
    if (!known.has(item.id)) next.push({ item, phase: "enter", depth: depthOf(item.id) });
  }
  return next;
}

export function promoteCards(cards: readonly StackCard[]): StackCard[] {
  return cards.some((card) => card.phase === "enter")
    ? cards.map((card) => (card.phase === "enter" ? { ...card, phase: "live" as const } : card))
    : [...cards];
}

export function pruneCard(cards: readonly StackCard[], id: number): StackCard[] {
  return cards.filter((card) => !(card.item.id === id && isLeaving(card)));
}

/** The live cards' heights, front first — what the spread is measured in. */
export function liveHeights(cards: readonly StackCard[], heights: ReadonlyMap<number, number>): number[] {
  return cards
    .filter((card) => !isLeaving(card))
    .sort((a, b) => a.depth - b.depth)
    .map((card) => heights.get(card.item.id) ?? 0);
}

/* ---------------------------------- poses -------------------------------- */

/**
 * Two transitions.dev recipes, value for value (the clocks and the curve are
 * shell.css's --notice-open, --notice-close and --notice-ease).
 *
 * "Toast open / close" is how a card comes and goes: closed is 16px toward
 * the edge, 0.97 of its size, 2px of blur and unseen; open is at rest. It
 * opens on the slower clock and closes on the faster one, back to the very
 * pose it opened from — one closed state, not an entrance and a separate
 * exit.
 *
 * "Banner stacking" is how the cards stand together: each step back is 12px
 * further from the edge (NOTICE_PEEK), 6% smaller, and fainter — 0.6, then
 * 0.36 — behind 1px, then 2px of blur.
 */
export const NOTICE_DISTANCE = 16;
const CLOSED_SCALE = 0.97;
const DEPTH_SCALE = 0.06;
const DEPTH_FADE = 0.4;
const EDGE_BLUR = 2;

export interface CardPose {
  /** px; negative is up. Stated for a stack at the foot, and mirrored for one at the top. */
  y: number;
  scale: number;
  opacity: number;
  /** px */
  blur: number;
  z: number;
}

function restingPose(depth: number, spread: boolean, heights: readonly number[]): CardPose {
  if (spread) return { y: -noticeSpreadLift(heights, depth), scale: 1, opacity: 1, blur: 0, z: NOTICE_LIMIT - depth };
  return {
    y: -NOTICE_PEEK * depth,
    scale: 1 - DEPTH_SCALE * depth,
    opacity: depth === 0 ? 1 : Math.max(0, 1 - DEPTH_FADE * (depth === 1 ? 1 : 1.6)),
    blur: Math.min(EDGE_BLUR, depth),
    z: NOTICE_LIMIT - depth,
  };
}

/**
 * Where a card stands. `heights` are the live cards', front first
 * (`liveHeights`). A stack at the top is the one at the foot upside down:
 * a card drops in from above, and the older ones go down behind it.
 */
export function cardPose(card: StackCard, spread: boolean, heights: readonly number[], edge: NoticeEdge = "bottom"): CardPose {
  const pose = footPose(card, spread, heights);
  // `|| 0`: the front card's offset is computed as -0, which is not a CSS length anyone should read.
  return { ...pose, y: (edge === "bottom" ? pose.y : -pose.y) || 0 };
}

/** The closed state of a card that rests at `rest`: the recipe's offsets, applied to wherever it stands. */
function closedPose(rest: CardPose, z: number): CardPose {
  return { y: rest.y + NOTICE_DISTANCE, scale: rest.scale * CLOSED_SCALE, opacity: 0, blur: EDGE_BLUR, z };
}

function footPose(card: StackCard, spread: boolean, heights: readonly number[]): CardPose {
  switch (card.phase) {
    case "enter":
      return closedPose(restingPose(card.depth, spread, heights), NOTICE_LIMIT + 1);
    case "live":
      return restingPose(card.depth, spread, heights);
    case "back":
      return { ...restingPose(card.depth, spread, heights), opacity: 0, blur: EDGE_BLUR, z: 0 };
    case "out":
      // The front card closes over the one coming forward; one further back closes under the rest.
      return closedPose(restingPose(card.depth, spread, heights), card.depth === 0 ? NOTICE_LIMIT + 1 : 0);
  }
}
