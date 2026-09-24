/**
 * The notice stack: the shell's brief word on something that just happened
 * — "URL copied", "Pinned to the sidebar" with the one thing to do about it.
 *
 * The shell's store owns the notices and how long each lives. What draws
 * them differs by surface: on the desktop the tab views sit ABOVE the shell
 * page, so the stack is a utility view of its own (chrome view "notice",
 * main/chrome-view.ts) that main parks at the foot of the browser surface —
 * seen whatever the chrome is doing, a hidden compact sidebar included, and
 * without raising a shell overlay, which would still every pane for a toast.
 * On a stream surface the panes are DOM, so the shell draws the same stack
 * itself. Both render `NoticeStack` from these items.
 *
 * This file is the wire shape between the three (shell → main → view, and
 * the view's clicks back) and the stack's pure arithmetic, so the geometry
 * can be tested without a DOM.
 */

import type { ContentBounds } from "./ipc.js";

/** What a notice is about, which picks its icon. */
export type NoticeTone = "neutral" | "success" | "warning";

export const NOTICE_TONES: readonly NoticeTone[] = ["neutral", "success", "warning"];

export function isNoticeTone(value: unknown): value is NoticeTone {
  return typeof value === "string" && (NOTICE_TONES as readonly string[]).includes(value);
}

/**
 * Where the stack stands in the browser surface (Settings → Appearance).
 * The edge decides the motion as well as the place: a stack at the foot
 * rises in and pushes older cards up behind it; one at the top drops in and
 * pushes them down.
 */
export type NoticePosition = "top-left" | "top" | "top-right" | "bottom-left" | "bottom" | "bottom-right";

/** Reading order, as the settings picker lays them out: the top row, then the bottom. */
export const NOTICE_POSITIONS: readonly NoticePosition[] = ["top-left", "top", "top-right", "bottom-left", "bottom", "bottom-right"];
export const DEFAULT_NOTICE_POSITION: NoticePosition = "bottom";

export function isNoticePosition(value: unknown): value is NoticePosition {
  return typeof value === "string" && (NOTICE_POSITIONS as readonly string[]).includes(value);
}

export type NoticeEdge = "top" | "bottom";
export type NoticeAlign = "left" | "center" | "right";

export function noticeEdge(position: NoticePosition): NoticeEdge {
  return position.startsWith("top") ? "top" : "bottom";
}

export function noticeAlign(position: NoticePosition): NoticeAlign {
  if (position.endsWith("left")) return "left";
  return position.endsWith("right") ? "right" : "center";
}

/** One notice as the stack draws it. The action's code stays in the shell; only its label travels. */
export interface NoticeItem {
  id: number;
  message: string;
  tone: NoticeTone;
  actionLabel: string | null;
  /** How many times the same words were said again while it was up; each one nudges the card. */
  bumps: number;
}

/** What the stack draws from: the live notices, oldest first, and where it stands. */
export interface NoticeStackState {
  items: NoticeItem[];
  position: NoticePosition;
}

export const EMPTY_NOTICE_STACK: NoticeStackState = { items: [], position: DEFAULT_NOTICE_POSITION };

/** What the shell publishes: that, and the box to stand the stack in. */
export interface NoticeFrame extends NoticeStackState {
  /** The browser surface in the window's content box; null when there is none to measure. */
  anchor: ContentBounds | null;
}

/** What the stack tells the shell: a click, or the pointer coming and going. */
export type NoticeEvent =
  | { type: "dismiss"; id: number }
  | { type: "action"; id: number }
  | { type: "hover"; hovering: boolean };

/** At most this many are up at once; a fourth pushes the oldest off the back. */
export const NOTICE_LIMIT = 3;
export const NOTICE_MESSAGE_MAX = 256;

/** How long a notice stays, and how long one that offers an action does. */
export const NOTICE_MS = 4_500;
export const NOTICE_ACTION_MS = 8_000;
/** The least a notice is given once the pointer leaves a stack it was reading. */
export const NOTICE_RESUME_MS = 1_500;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isNoticeItem(value: unknown): value is NoticeItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    isFiniteNumber(item["id"]) &&
    typeof item["message"] === "string" &&
    item["message"].length > 0 &&
    item["message"].length <= NOTICE_MESSAGE_MAX &&
    isNoticeTone(item["tone"]) &&
    (item["actionLabel"] === null ||
      (typeof item["actionLabel"] === "string" && item["actionLabel"].length > 0 && item["actionLabel"].length <= 64)) &&
    isFiniteNumber(item["bumps"])
  );
}

function isAnchor(value: unknown): value is ContentBounds {
  if (typeof value !== "object" || value === null) return false;
  const box = value as Record<string, unknown>;
  return (["x", "y", "width", "height"] as const).every((key) => isFiniteNumber(box[key]));
}

export function isNoticeFrame(value: unknown): value is NoticeFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Record<string, unknown>;
  const items = frame["items"];
  return (
    Array.isArray(items) &&
    items.length <= NOTICE_LIMIT &&
    items.every(isNoticeItem) &&
    isNoticePosition(frame["position"]) &&
    (frame["anchor"] === null || isAnchor(frame["anchor"]))
  );
}

export function isNoticeEvent(value: unknown): value is NoticeEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  switch (event["type"]) {
    case "dismiss":
    case "action":
      return isFiniteNumber(event["id"]);
    case "hover":
      return typeof event["hovering"] === "boolean";
    default:
      return false;
  }
}

/* -------------------------------- geometry ------------------------------- */

/** The stack's width, and the room the view leaves around it for shadows and the rise. */
export const NOTICE_WIDTH = 356;
export const NOTICE_PAD_X = 24;
export const NOTICE_PAD_TOP = 24;
/** How far the newest card rests from the edge of the browser surface it stands at. */
export const NOTICE_FOOT = 24;
/** Collapsed: how much of each older card shows above the one in front. */
export const NOTICE_PEEK = 12;
/** Spread: the gap between cards. */
export const NOTICE_GAP = 8;
/** The native view is never asked to be shorter or taller than this. */
export const NOTICE_VIEW_MIN_H = 64;
export const NOTICE_VIEW_MAX_H = 420;

/**
 * How tall the stack's box must be for cards of these heights (newest
 * first) spread out — which is also all the room the collapsed stack ever
 * needs, so a view sized to it never resizes under the pointer.
 */
export function noticeSpreadHeight(heights: readonly number[]): number {
  if (heights.length === 0) return 0;
  return heights.reduce((sum, height) => sum + height, 0) + NOTICE_GAP * (heights.length - 1);
}

/** How far the card at `depth` climbs when spread: past every newer card and the gaps between. */
export function noticeSpreadLift(heights: readonly number[], depth: number): number {
  let lift = 0;
  for (let index = 0; index < depth && index < heights.length; index += 1) lift += (heights[index] ?? 0) + NOTICE_GAP;
  return lift;
}

/** The native view's height for a stack this tall. */
export function noticeViewHeight(stackHeight: number): number {
  const wanted = Math.ceil(stackHeight) + NOTICE_PAD_TOP + NOTICE_FOOT;
  return Math.min(NOTICE_VIEW_MAX_H, Math.max(NOTICE_VIEW_MIN_H, wanted));
}

/**
 * Where main parks the notice view: against the anchor's top or foot, in
 * its left corner, its right, or centred, and no wider than the anchor.
 * Null when there is no room.
 */
export function noticeViewSlot(anchor: ContentBounds, viewHeight: number, position: NoticePosition = DEFAULT_NOTICE_POSITION): ContentBounds | null {
  const width = Math.min(NOTICE_WIDTH + 2 * NOTICE_PAD_X, Math.floor(anchor.width));
  const height = Math.min(viewHeight, Math.floor(anchor.height));
  if (width < 120 || height < NOTICE_VIEW_MIN_H) return null;
  const align = noticeAlign(position);
  const x = align === "left" ? anchor.x : align === "right" ? anchor.x + anchor.width - width : anchor.x + (anchor.width - width) / 2;
  const y = noticeEdge(position) === "top" ? anchor.y : anchor.y + anchor.height - height;
  return { x: Math.round(x), y: Math.round(y), width, height };
}
