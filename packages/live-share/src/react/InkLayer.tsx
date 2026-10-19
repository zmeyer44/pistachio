/**
 * Ink over the stage (docs/live-share.md §4 Ink, §9): everyone's strokes,
 * and — given a pen — the drawing gesture.
 *
 * Two canvases. Strokes that are finished and stay (pens, highlighters) are
 * drawn on one, again only when that set changes or the stage moves; strokes
 * still being drawn, lasers fading and my own stroke in hand are drawn on
 * the other — when the board or my gesture moves, and every frame only
 * while a laser fades. My stroke is drawn from the recorder's own points, so
 * it follows the pointer without waiting on the 24 ms batches that go to the
 * room.
 *
 * The canvases have pixels (the stage's, at the display's density) only
 * while there is ink to draw or a pen in hand; an empty board costs no
 * backing store — two stage-sized canvases are ~40 MB on a Retina display.
 */

import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { INK_SIZES, INK_STYLE, InkRecorder, strokeOpacity, strokeOutline, strokeSettled, type DrawableStroke } from "../ink.js";
import type { InkTool, LiveInkOp } from "../protocol.js";
import type { InkStore } from "./ink-store.js";
import type { StageBoxSource } from "./stage-box.js";

export interface InkPen {
  tool: InkTool;
  color: string;
  /** A fraction of the stage's width; the tool's default when absent. */
  size?: number;
}

export interface InkLayerProps {
  store: InkStore;
  box: StageBoxSource;
  /** My identity: my stroke ids are `<identity>:<n>`. */
  identity: string;
  /** Draw with this pen. Null lets the pointer through to whatever lies under the layer. */
  pen: InkPen | null;
  /** Each op of my stroke, to apply to the store and send (`useRoomInk().emit`). */
  onOp(op: LiveInkOp): void;
  className?: string;
}

interface Cached {
  key: string;
  path: Path2D;
}

/**
 * The pointer while a pen is in hand: a dot of the ink's colour on a white
 * ring (the highlighter's a wider, softer one), hot-spot at its centre.
 */
export function penCursor(pen: InkPen): string {
  const r = pen.tool === "highlighter" ? 7 : pen.tool === "laser" ? 4.5 : 3.5;
  const fill = pen.tool === "highlighter" ? `${pen.color}99` : pen.color;
  const half = 12;
  const glow = pen.tool === "laser" ? `<circle cx="${half}" cy="${half}" r="${r + 4}" fill="${pen.color}" opacity="0.28"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">${glow}<circle cx="${half}" cy="${half}" r="${r + 1.5}" fill="#fff"/><circle cx="${half}" cy="${half}" r="${r}" fill="${fill}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${half} ${half}, crosshair`;
}

export function InkLayer({ store, box, identity, pen, onOp, className }: InkLayerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const settledRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const penRef = useRef(pen);
  const onOpRef = useRef(onOp);
  const recorderRef = useRef<InkRecorder | null>(null);
  const wakeRef = useRef<() => void>(() => undefined);

  useLayoutEffect(() => {
    penRef.current = pen;
    onOpRef.current = onOp;
  });

  // One recorder per identity; its ops go to whoever renders the layer now.
  useEffect(() => {
    const recorder = new InkRecorder({
      identity,
      emit: (op) => onOpRef.current(op),
      stageSize: () => {
        const stage = box.get();
        return { w: stage.w, h: stage.h };
      },
    });
    recorderRef.current = recorder;
    return () => {
      recorder.end();
      recorder.dispose();
      if (recorderRef.current === recorder) recorderRef.current = null;
    };
  }, [identity, box]);

  // Putting the pen down ends a stroke in hand. (The pen's tool and colour
  // are read as a stroke begins: changing them never cuts one short.) Taking
  // it up or putting it down also gives the canvases their pixels, or takes them.
  const drawing = pen !== null;
  useEffect(() => {
    if (!drawing) recorderRef.current?.end();
    wakeRef.current();
  }, [drawing]);

  useEffect(() => {
    const root = rootRef.current;
    const settled = settledRef.current?.getContext("2d") ?? null;
    const live = liveRef.current?.getContext("2d") ?? null;
    if (root === null || settled === null || live === null) return;
    const cache = new Map<string, Cached>();
    /** The layer's size; the canvases have it (at `dpr`) only while `sized`. */
    let size = { w: 0, h: 0, dpr: 1 };
    let sized = false;
    let settledKey = "";
    let frame = 0;

    /** Give the canvases the layer's pixels, or take them away (a 0×0 canvas holds none). */
    const fit = (needed: boolean): void => {
      const w = needed ? Math.max(1, Math.round(size.w * size.dpr)) : 0;
      const h = needed ? Math.max(1, Math.round(size.h * size.dpr)) : 0;
      if (sized === needed && settled.canvas.width === w && settled.canvas.height === h) return;
      for (const canvas of [settled.canvas, live.canvas]) {
        canvas.width = w;
        canvas.height = h;
      }
      sized = needed;
      settledKey = "";
    };

    const pathOf = (stroke: DrawableStroke & { id: string }, now: number): Path2D => {
      const stage = box.get();
      const key = `${String(stroke.pts.length)}|${String(stroke.done)}|${stage.w.toFixed(1)}x${stage.h.toFixed(1)}`;
      const hit = cache.get(stroke.id);
      if (hit !== undefined && hit.key === key) return hit.path;
      const path = new Path2D(strokeOutline(stroke, { w: stage.w, h: stage.h }, now).path);
      cache.set(stroke.id, { key, path });
      return path;
    };

    const paint = (context: CanvasRenderingContext2D, strokes: Array<DrawableStroke & { id: string; color: string }>, now: number): void => {
      const stage = box.get();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, context.canvas.width, context.canvas.height);
      context.setTransform(size.dpr, 0, 0, size.dpr, stage.x * size.dpr, stage.y * size.dpr);
      for (const stroke of strokes) {
        const opacity = strokeOpacity(stroke, now);
        if (opacity <= 0) continue;
        context.globalAlpha = opacity;
        context.fillStyle = stroke.color;
        context.shadowColor = INK_STYLE[stroke.tool].glow ? stroke.color : "transparent";
        context.shadowBlur = INK_STYLE[stroke.tool].glow ? 10 * size.dpr : 0;
        context.fill(pathOf(stroke, now));
      }
      context.globalAlpha = 1;
      context.shadowBlur = 0;
    };

    const draw = (): void => {
      frame = 0;
      const now = performance.now();
      const visible = store.board.visible(now);
      const mine = recorderRef.current?.current() ?? null;
      const ids = new Set(visible.map((stroke) => stroke.id));
      for (const id of cache.keys()) if (!ids.has(id) && id !== mine?.id) cache.delete(id);
      const needed = visible.length > 0 || mine !== null || penRef.current !== null;
      fit(needed);
      if (!needed) return;

      const done = visible.filter((stroke) => strokeSettled(stroke, now));
      const key = `${done.map((stroke) => `${stroke.id}:${String(stroke.pts.length)}`).join(",")}|${JSON.stringify(box.get())}|${String(size.w)}x${String(size.h)}`;
      if (key !== settledKey) {
        settledKey = key;
        paint(settled, done, now);
      }

      const moving: Array<DrawableStroke & { id: string; color: string }> = visible.filter((stroke) => !strokeSettled(stroke, now) && stroke.id !== mine?.id);
      if (mine !== null) moving.push(mine);
      paint(live, moving, now);
      // Only a fading laser changes with time; anything else is drawn again when the board or the gesture moves.
      if (moving.some((stroke) => stroke.tool === "laser" && stroke.lastAt !== undefined)) frame = requestAnimationFrame(draw);
    };
    const wake = (): void => {
      if (frame === 0) frame = requestAnimationFrame(draw);
    };
    wakeRef.current = wake;

    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const w = root.clientWidth;
      const h = root.clientHeight;
      if (w === size.w && h === size.h && dpr === size.dpr) return;
      size = { w, h, dpr };
      if (sized) fit(true);
      wake();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    resize();
    const offStore = store.subscribe(wake);
    const offBox = box.subscribe(wake);
    wake();
    return () => {
      observer.disconnect();
      offStore();
      offBox();
      cancelAnimationFrame(frame);
      wakeRef.current = () => undefined;
    };
  }, [store, box]);

  // The gesture: only while a pen is in hand.
  useEffect(() => {
    const root = rootRef.current;
    if (root === null || !drawing) return;
    let pointer: number | null = null;
    const pointOf = (event: PointerEvent): { x: number; y: number } => {
      const rect = root.getBoundingClientRect();
      const stage = box.get();
      return {
        x: stage.w > 0 ? (event.clientX - rect.left - stage.x) / stage.w : 0,
        y: stage.h > 0 ? (event.clientY - rect.top - stage.y) / stage.h : 0,
      };
    };
    const down = (event: PointerEvent): void => {
      const current = penRef.current;
      if (event.button !== 0 || current === null || pointer !== null) return;
      event.preventDefault();
      pointer = event.pointerId;
      root.setPointerCapture(event.pointerId);
      recorderRef.current?.begin(current.tool, current.color, current.size ?? INK_SIZES[current.tool], pointOf(event));
      wakeRef.current();
    };
    const move = (event: PointerEvent): void => {
      if (event.pointerId !== pointer) return;
      const events = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
      for (const each of events.length > 0 ? events : [event]) recorderRef.current?.move(pointOf(each));
      wakeRef.current();
    };
    const up = (event: PointerEvent): void => {
      if (event.pointerId !== pointer) return;
      pointer = null;
      recorderRef.current?.end();
      wakeRef.current();
    };
    root.addEventListener("pointerdown", down);
    root.addEventListener("pointermove", move);
    root.addEventListener("pointerup", up);
    root.addEventListener("pointercancel", up);
    root.addEventListener("lostpointercapture", up);
    return () => {
      root.removeEventListener("pointerdown", down);
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerup", up);
      root.removeEventListener("pointercancel", up);
      root.removeEventListener("lostpointercapture", up);
      recorderRef.current?.end();
    };
  }, [drawing, box]);

  return (
    <div
      ref={rootRef}
      className={["lv-layer", "lv-ink", className].filter(Boolean).join(" ")}
      data-drawing={pen === null ? undefined : pen.tool}
      style={pen === null ? undefined : ({ cursor: penCursor(pen) } satisfies CSSProperties)}
    >
      <canvas ref={settledRef} className="lv-ink-canvas" />
      <canvas ref={liveRef} className="lv-ink-canvas" />
    </div>
  );
}
