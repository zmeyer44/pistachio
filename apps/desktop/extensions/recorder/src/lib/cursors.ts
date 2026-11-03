/**
 * The vector cursor set the renderer draws (docs/recorder.md R5, §4
 * `cursor.ts`): one shape per kind of `cursor` event, drawn with plain path
 * calls (no Path2D, no images) in design units of one CSS px at size 1, the
 * hotspot at the origin. At `size ≥ 1` the arrow covers Chromium's own cursor
 * baked into the capture.
 */
import type { Ctx2D } from "./wallpapers.js";

export type CursorShape = "arrow" | "pointer" | "text" | "grab" | "grabbing" | "crosshair" | "notAllowed" | "wait" | "move" | "ewResize" | "nsResize" | "neswResize" | "nwseResize" | "colResize" | "rowResize";

export const CURSOR_SHAPES: readonly CursorShape[] = ["arrow", "pointer", "text", "grab", "grabbing", "crosshair", "notAllowed", "wait", "move", "ewResize", "nsResize", "neswResize", "nwseResize", "colResize", "rowResize"];

const BY_TYPE: Record<string, CursorShape> = {
  default: "arrow", arrow: "arrow", auto: "arrow", "context-menu": "arrow", alias: "arrow", copy: "arrow", help: "arrow", custom: "arrow", "zoom-in": "arrow", "zoom-out": "arrow",
  pointer: "pointer", hand: "pointer",
  text: "text", "vertical-text": "text", ibeam: "text",
  grab: "grab", grabbing: "grabbing",
  crosshair: "crosshair", cell: "crosshair",
  "not-allowed": "notAllowed", "no-drop": "notAllowed", nodrop: "notAllowed",
  wait: "wait", progress: "wait",
  move: "move", "all-scroll": "move",
  "e-resize": "ewResize", "w-resize": "ewResize", "ew-resize": "ewResize",
  "n-resize": "nsResize", "s-resize": "nsResize", "ns-resize": "nsResize",
  "ne-resize": "neswResize", "sw-resize": "neswResize", "nesw-resize": "neswResize",
  "nw-resize": "nwseResize", "se-resize": "nwseResize", "nwse-resize": "nwseResize",
  "col-resize": "colResize", "row-resize": "rowResize",
};

/** The shape for a `cursor` event's type (Electron's `cursor-changed` names, CSS names); null for `none`; the arrow for anything unknown (panning cursors draw `move`). */
export function cursorShapeFor(type: string): CursorShape | null {
  if (type === "none") return null;
  const shape = BY_TYPE[type];
  if (shape) return shape;
  if (type.endsWith("-panning")) return "move";
  return "arrow";
}

const BLACK = "#111111";
const WHITE = "#FFFFFF";
const SHADOW = "rgba(0, 0, 0, 0.22)";

type Pt = [number, number];

function polygon(ctx: Ctx2D, points: readonly Pt[]): void {
  points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
}

function roundedRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** A filled black shape with a white rim and a soft drop. */
function rimmed(ctx: Ctx2D, path: () => void, rim = 2.6): void {
  ctx.save();
  ctx.translate(0.6, 1.1);
  ctx.beginPath();
  path();
  ctx.fillStyle = SHADOW;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  path();
  ctx.lineJoin = "round";
  ctx.lineWidth = rim;
  ctx.strokeStyle = WHITE;
  ctx.stroke();
  ctx.fillStyle = BLACK;
  ctx.fill();
}

/** Lines drawn black over a wider white stroke. */
function stroked(ctx: Ctx2D, path: () => void, width = 1.3, rim = 3.4): void {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  path();
  ctx.lineWidth = rim;
  ctx.strokeStyle = WHITE;
  ctx.stroke();
  ctx.lineWidth = width;
  ctx.strokeStyle = BLACK;
  ctx.stroke();
}

/** A white glove of rounded rects and a thumb line, with a black outline (the hand cursors). */
function glove(ctx: Ctx2D, rects: readonly [number, number, number, number, number][], thumb: [Pt, Pt] | null, creases: readonly [Pt, Pt][]): void {
  const body = () => {
    for (const [x, y, w, h, r] of rects) roundedRect(ctx, x, y, w, h, r);
  };
  ctx.save();
  ctx.translate(0.6, 1.1);
  ctx.beginPath();
  body();
  ctx.fillStyle = SHADOW;
  ctx.fill();
  ctx.restore();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  body();
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = BLACK;
  ctx.stroke();
  if (thumb) {
    ctx.beginPath();
    ctx.moveTo(thumb[0][0], thumb[0][1]);
    ctx.lineTo(thumb[1][0], thumb[1][1]);
    ctx.lineWidth = 5.2;
    ctx.stroke();
  }
  ctx.beginPath();
  body();
  ctx.fillStyle = WHITE;
  ctx.fill();
  if (thumb) {
    ctx.beginPath();
    ctx.moveTo(thumb[0][0], thumb[0][1]);
    ctx.lineTo(thumb[1][0], thumb[1][1]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = WHITE;
    ctx.stroke();
  }
  ctx.beginPath();
  for (const [a, b] of creases) {
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
  }
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = BLACK;
  ctx.stroke();
}

const ARROW: Pt[] = [[0, 0], [0, 16.5], [4, 12.7], [6.6, 18.6], [9.3, 17.4], [6.8, 11.7], [12.2, 11.7]];
const DOUBLE_ARROW: Pt[] = [[-9, 0], [-5, -4], [-5, -1.5], [5, -1.5], [5, -4], [9, 0], [5, 4], [5, 1.5], [-5, 1.5], [-5, 4]];

function doubleArrow(ctx: Ctx2D, angle: number, bar: boolean): void {
  ctx.save();
  ctx.rotate(angle);
  rimmed(ctx, () => {
    polygon(ctx, DOUBLE_ARROW);
    if (bar) roundedRect(ctx, -1.2, -8, 2.4, 16, 0.6);
  }, 2.4);
  ctx.restore();
}

/**
 * Draw a cursor shape with its hotspot at (x, y); `scale` is output px per
 * design unit (one CSS px at size 1). The caller sets `globalAlpha`.
 */
export function drawCursor(ctx: Ctx2D, shape: CursorShape, x: number, y: number, scale: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  switch (shape) {
    case "arrow":
      rimmed(ctx, () => polygon(ctx, ARROW));
      break;
    case "pointer":
      glove(ctx, [[-1.6, 0, 3.2, 11, 1.6], [1.4, 5, 3, 7, 1.5], [4.2, 5.8, 3, 6.6, 1.5], [7, 7, 2.8, 6, 1.4], [-1.6, 9.5, 11.4, 9, 3.5]], [[-4.6, 9.6], [-1, 13.8]], [[[1.5, 8.6], [1.5, 11]], [[4.3, 9], [4.3, 11.6]], [[7.1, 9.6], [7.1, 12.2]]]);
      break;
    case "grab":
      glove(ctx, [[-5.4, -9, 2.6, 9, 1.3], [-2.6, -10, 2.6, 10, 1.3], [0.2, -9.4, 2.6, 9.4, 1.3], [3, -7.6, 2.4, 8, 1.2], [-5.6, -3, 11.2, 10, 3.5]], [[-5, 1], [-8.5, -2.5]], []);
      break;
    case "grabbing":
      glove(ctx, [[-5.4, -5.5, 2.6, 5, 1.3], [-2.6, -6, 2.6, 5.5, 1.3], [0.2, -5.7, 2.6, 5.2, 1.3], [3, -5, 2.4, 4.6, 1.2], [-5.6, -3, 11.2, 10, 3.5]], [[-5, 2], [-7, -0.5]], [[[-2.7, -2.4], [-2.7, -0.6]], [[0.1, -2.6], [0.1, -0.6]], [[2.9, -2.2], [2.9, -0.6]]]);
      break;
    case "text":
      stroked(ctx, () => {
        ctx.moveTo(-3, -8.5);
        ctx.quadraticCurveTo(0, -8.5, 0, -6.5);
        ctx.quadraticCurveTo(0, -8.5, 3, -8.5);
        ctx.moveTo(0, -6.5);
        ctx.lineTo(0, 6.5);
        ctx.moveTo(-3, 8.5);
        ctx.quadraticCurveTo(0, 8.5, 0, 6.5);
        ctx.quadraticCurveTo(0, 8.5, 3, 8.5);
      });
      break;
    case "crosshair":
      stroked(ctx, () => {
        ctx.moveTo(-8, 0);
        ctx.lineTo(8, 0);
        ctx.moveTo(0, -8);
        ctx.lineTo(0, 8);
      }, 1.2, 3.2);
      break;
    case "notAllowed":
      stroked(ctx, () => {
        ctx.moveTo(7.5, 0);
        ctx.arc(0, 0, 7.5, 0, Math.PI * 2);
        ctx.moveTo(-5.3, -5.3);
        ctx.lineTo(5.3, 5.3);
      }, 2.2, 4.4);
      break;
    case "wait": {
      const colors = ["#3DA5F4", "#47C266", "#F4C23D", "#F44C3D"];
      colors.forEach((color, i) => {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, 8, (i * Math.PI) / 2 - Math.PI / 4, ((i + 1) * Math.PI) / 2 - Math.PI / 4);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      });
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = WHITE;
      ctx.stroke();
      break;
    }
    case "move":
      doubleArrow(ctx, 0, false);
      doubleArrow(ctx, Math.PI / 2, false);
      break;
    case "ewResize":
      doubleArrow(ctx, 0, false);
      break;
    case "nsResize":
      doubleArrow(ctx, Math.PI / 2, false);
      break;
    case "nwseResize":
      doubleArrow(ctx, Math.PI / 4, false);
      break;
    case "neswResize":
      doubleArrow(ctx, -Math.PI / 4, false);
      break;
    case "colResize":
      doubleArrow(ctx, 0, true);
      break;
    case "rowResize":
      doubleArrow(ctx, Math.PI / 2, true);
      break;
  }
  ctx.restore();
}
