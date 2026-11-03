/**
 * The timeline (docs/recorder.md §2 "Edit"): a ruler in output time and the lanes —
 * chapters, clip, zoom, speed, events, mic — drawn on one canvas the width of the
 * view, over a native horizontal scroller. `lanes.ts` holds the geometry and the
 * hit-testing; this file draws and routes the pointer.
 */
import type { TimeMap } from "../lib/types.js";
import { levelAt, levelText } from "./derive.js";
import { h } from "./dom.js";
import type { Editor } from "./editor.js";
import {
  INSET,
  LANES,
  RULER_HEIGHT,
  clipBars,
  contentWidth,
  fitPps,
  hitTest,
  laneBox,
  lanesHeight,
  outOfX,
  rulerStep,
  speedBars,
  srcOfX,
  xOfOut,
  xOfSrc,
  zoomBars,
  type Hit,
  type Scale,
} from "./lanes.js";
import { MIN_SPEED, MIN_ZOOM, clamp, dragSpan, roomFor, type SpanPart } from "./model.js";

/** Canvas text cannot read CSS variables: the editor's stack, spelled out. */
const FONT = '-apple-system, BlinkMacSystemFont, "Geist", "Inter", system-ui, sans-serif';

type Drag =
  | { kind: "scrub" }
  | { kind: "pending"; hit: Hit; x: number; y: number }
  | { kind: "range"; anchor: number }
  | { kind: "segment"; lane: "zoom" | "speed"; id: string; part: SpanPart; grab: number; room: { min: number; max: number }; span: { start: number; end: number }; moved: boolean };

interface Palette {
  text: string;
  text2: string;
  text3: string;
  hairline: string;
  track: string;
  clip: string;
  clipText: string;
  zoom: string;
  zoomFill: string;
  speed: string;
  speedFill: string;
  accent: string;
  selection: string;
  playhead: string;
  mic: string;
}

export class Timeline {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly scroller: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private pps = 10;
  private fit = true;
  private drag: Drag | null = null;
  /** The time map held still while a speed segment is dragged, so the bar stays under the pointer. */
  private heldMap: TimeMap | null = null;
  private palette: Palette | null = null;
  private scheduled = 0;

  constructor(editor: Editor) {
    this.editor = editor;
    this.canvas = h("canvas", { class: "timeline-canvas" });
    this.ctx = this.canvas.getContext("2d");
    this.spacer = h("div", { class: "timeline-spacer" });
    this.scroller = h("div", { class: "timeline-scroll" }, this.canvas, this.spacer);
    const labels = h(
      "div",
      { class: "timeline-labels" },
      h("div", { class: "timeline-label ruler-label", style: `height:${String(RULER_HEIGHT)}px` }),
      ...LANES.map((lane) => h("div", { class: "timeline-label", style: `top:${String(laneBox(lane.id).top)}px;height:${String(lane.height)}px` }, lane.label)),
    );
    this.el = h("section", { class: "timeline", "aria-label": "Timeline" }, labels, this.scroller);
    this.el.style.setProperty("--lanes-height", `${String(lanesHeight())}px`);

    this.scroller.addEventListener("scroll", () => this.invalidate());
    this.scroller.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
    this.canvas.addEventListener("pointerdown", (event) => this.onDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.onMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.onUp(event));
    this.canvas.addEventListener("pointercancel", (event) => this.onUp(event));
    this.canvas.addEventListener("dblclick", () => {
      this.fit = true;
      this.layout();
    });
    new ResizeObserver(() => this.layout()).observe(this.scroller);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      this.palette = null;
      this.invalidate();
    });

    editor.on((change) => {
      if (change === "playhead") {
        this.followPlayhead();
        this.draw();
      } else if (change === "derived" || change === "project") {
        this.layout();
      } else if (change !== "saved") {
        this.invalidate();
      }
    });
  }

  private scale(): Scale {
    return { pps: this.pps, map: this.heldMap ?? this.editor.map };
  }

  layout(): void {
    const width = this.scroller.clientWidth;
    if (width === 0) return;
    const duration = (this.heldMap ?? this.editor.map).duration;
    const fitted = fitPps(width, duration);
    if (this.fit || this.pps < fitted) {
      this.pps = fitted;
      this.fit = true;
    }
    this.spacer.style.width = `${String(contentWidth(this.scale()))}px`;
    const dpr = window.devicePixelRatio || 1;
    const height = lanesHeight();
    this.canvas.style.width = `${String(width)}px`;
    this.canvas.style.height = `${String(height)}px`;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.invalidate();
  }

  invalidate(): void {
    if (this.scheduled !== 0) return;
    this.scheduled = requestAnimationFrame(() => {
      this.scheduled = 0;
      this.draw();
    });
  }

  /** Keep the playhead in view while playing. */
  private followPlayhead(): void {
    if (this.fit) return;
    const x = xOfOut(this.scale(), this.editor.playhead);
    const left = this.scroller.scrollLeft;
    const width = this.scroller.clientWidth;
    if (x > left + width - 40 || x < left) this.scroller.scrollLeft = x - 40;
  }

  // ── The pointer ─────────────────────────────────────────────────────────

  private local(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const bounds = this.canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left + this.scroller.scrollLeft, y: event.clientY - bounds.top };
  }

  private onWheel(event: WheelEvent): void {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const { x } = this.local(event);
      const tOut = outOfX(this.scale(), x);
      const before = x - this.scroller.scrollLeft;
      this.pps = clamp(this.pps * Math.exp(-event.deltaY * 0.01), fitPps(this.scroller.clientWidth, this.editor.map.duration), 600);
      this.fit = false;
      this.layout();
      this.scroller.scrollLeft = xOfOut(this.scale(), tOut) - before;
      return;
    }
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && !event.shiftKey) {
      event.preventDefault();
      this.scroller.scrollLeft += event.deltaY;
    }
  }

  private onDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const { x, y } = this.local(event);
    const editor = this.editor;
    const hit = hitTest(editor.project, this.scale(), x, y, editor.playhead);
    if (hit === null) return;
    this.canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    if (hit.kind === "playhead" || hit.kind === "ruler") {
      this.drag = { kind: "scrub" };
      if (hit.kind === "ruler") editor.seek(hit.tOut);
      return;
    }
    if (hit.kind === "segment") {
      const items = hit.lane === "zoom" ? editor.project.zooms : editor.project.speed;
      const item = items.find((s) => s.id === hit.id);
      if (item === undefined) return;
      editor.select({ kind: hit.lane, id: hit.id });
      if (hit.lane === "speed") this.heldMap = editor.map;
      const pointer = srcOfX(this.scale(), x);
      this.drag = { kind: "segment", lane: hit.lane, id: hit.id, part: hit.part, grab: pointer - item.start, room: roomFor(items, hit.id, editor.duration), span: { start: item.start, end: item.end }, moved: false };
      return;
    }
    if (hit.kind === "gap") {
      editor.select({ kind: "gap", index: hit.index });
      this.drag = null;
      return;
    }
    this.drag = { kind: "pending", hit, x, y };
  }

  private onMove(event: PointerEvent): void {
    const { x, y } = this.local(event);
    const drag = this.drag;
    const editor = this.editor;
    if (drag === null) {
      this.hover(x, y);
      return;
    }
    const scale = this.scale();
    switch (drag.kind) {
      case "scrub":
        editor.seek(outOfX(scale, x));
        break;
      case "pending":
        if (Math.abs(x - drag.x) > 3) {
          const anchor = srcOfX(scale, drag.x);
          this.drag = { kind: "range", anchor };
          editor.select({ kind: "range", start: Math.min(anchor, srcOfX(scale, x)), end: Math.max(anchor, srcOfX(scale, x)) });
        }
        break;
      case "range": {
        const at = srcOfX(scale, x);
        editor.select({ kind: "range", start: Math.min(drag.anchor, at), end: Math.max(drag.anchor, at) });
        break;
      }
      case "segment": {
        const pointer = srcOfX(scale, x);
        const span = dragSpan(drag.span, drag.part, pointer, drag.grab, drag.room, drag.lane === "zoom" ? MIN_ZOOM : MIN_SPEED);
        if (!drag.moved && Math.abs(span.start - drag.span.start) < 1e-3 && Math.abs(span.end - drag.span.end) < 1e-3) break;
        drag.moved = true;
        editor.edit(
          (draft) => {
            if (drag.lane === "zoom") {
              const index = draft.zooms.findIndex((z) => z.id === drag.id);
              const zoom = draft.zooms[index];
              if (zoom !== undefined) draft.zooms[index] = { ...zoom, start: span.start, end: span.end, auto: false };
            } else {
              const index = draft.speed.findIndex((s) => s.id === drag.id);
              const speed = draft.speed[index];
              if (speed !== undefined) draft.speed[index] = { ...speed, start: span.start, end: span.end };
            }
          },
          { key: `drag:${drag.id}` },
        );
        break;
      }
    }
  }

  private onUp(event: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    const editor = this.editor;
    if (drag?.kind === "pending") {
      const hit = drag.hit;
      if (hit.kind === "clip") {
        editor.select({ kind: "clip", index: hit.index });
        editor.seek(hit.tOut);
      } else if (hit.kind === "lane") {
        if (hit.lane === "zoom" || hit.lane === "speed" || hit.lane === "clip") editor.select({ kind: "none" });
        editor.seek(hit.tOut);
      }
    } else if (drag?.kind === "segment") {
      editor.seal();
      if (!drag.moved && drag.lane === "zoom") {
        // A click on a zoom brings the playhead into it, so its rectangle shows.
        const zoom = editor.project.zooms.find((z) => z.id === drag.id);
        if (zoom !== undefined) {
          const t = editor.playheadSource;
          if (t < zoom.start || t >= zoom.end) editor.seek(editor.map.toOutput((zoom.start + zoom.end) / 2));
        }
      }
    }
    if (this.heldMap !== null) {
      this.heldMap = null;
      this.layout();
    }
  }

  private hover(x: number, y: number): void {
    const hit = hitTest(this.editor.project, this.scale(), x, y, this.editor.playhead);
    let cursor = "default";
    if (hit?.kind === "segment") cursor = hit.part === "body" ? "grab" : "ew-resize";
    else if (hit?.kind === "playhead") cursor = "ew-resize";
    else if (hit?.kind === "gap" || hit?.kind === "ruler") cursor = "pointer";
    else if (hit?.kind === "clip" || hit?.kind === "lane") cursor = "text";
    this.canvas.style.cursor = cursor;
  }

  // ── Drawing ─────────────────────────────────────────────────────────────

  private colours(): Palette {
    if (this.palette !== null) return this.palette;
    const style = getComputedStyle(this.el);
    const v = (name: string) => style.getPropertyValue(name).trim() || "#888";
    this.palette = {
      text: v("--text"),
      text2: v("--text-2"),
      text3: v("--text-3"),
      hairline: v("--hairline"),
      track: v("--track"),
      clip: v("--clip"),
      clipText: v("--clip-text"),
      zoom: v("--zoom"),
      zoomFill: v("--zoom-fill"),
      speed: v("--speed"),
      speedFill: v("--speed-fill"),
      accent: v("--accent"),
      selection: v("--selection"),
      playhead: v("--playhead"),
      mic: v("--mic"),
    };
    return this.palette;
  }

  draw(): void {
    const ctx = this.ctx;
    if (ctx === null || this.canvas.width === 0) return;
    const editor = this.editor;
    const project = editor.project;
    const scale = this.scale();
    const c = this.colours();
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    const width = this.canvas.clientWidth;
    const left = this.scroller.scrollLeft;
    const right = left + width;
    const endX = xOfOut(scale, scale.map.duration);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, this.canvas.clientHeight);
    ctx.translate(-left, 0);
    ctx.font = `500 11px ${FONT}`;
    ctx.textBaseline = "middle";

    // Lane tracks.
    for (const lane of LANES) {
      const box = laneBox(lane.id);
      ctx.fillStyle = c.track;
      roundRect(ctx, INSET, box.top, Math.max(0, endX - INSET), box.height, 5);
      ctx.fill();
    }

    this.drawRuler(ctx, scale, c, left, right);

    // The selected range, across every lane.
    const selection = editor.selection;
    if (selection.kind === "range") {
      const x0 = xOfSrc(scale, selection.start);
      const x1 = xOfSrc(scale, selection.end);
      ctx.fillStyle = c.selection;
      ctx.fillRect(x0, RULER_HEIGHT, Math.max(1, x1 - x0), lanesHeight() - RULER_HEIGHT);
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0 + 0.5, RULER_HEIGHT);
      ctx.lineTo(x0 + 0.5, lanesHeight());
      ctx.moveTo(x1 - 0.5, RULER_HEIGHT);
      ctx.lineTo(x1 - 0.5, lanesHeight());
      ctx.stroke();
    }

    // Chapters.
    {
      const box = laneBox("chapters");
      const chapters = editor.rec.chapters;
      const starts = [{ tSrc: 0, title: chapters[0] !== undefined && chapters[0].tSrc <= 0.5 ? chapters[0].title : editor.rec.meta.source.title }, ...chapters.filter((ch) => ch.tSrc > 0.5)];
      for (let i = 0; i < starts.length; i++) {
        const x0 = xOfSrc(scale, starts[i]!.tSrc);
        const x1 = i + 1 < starts.length ? xOfSrc(scale, starts[i + 1]!.tSrc) : endX;
        if (x1 < left || x0 > right) continue;
        ctx.fillStyle = c.text3;
        ctx.fillRect(x0, box.top + 4, 1, box.height - 8);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0 + 4, box.top, Math.max(0, x1 - x0 - 8), box.height);
        ctx.clip();
        ctx.fillStyle = c.text2;
        ctx.fillText(starts[i]!.title || "Untitled", x0 + 6, box.top + box.height / 2);
        ctx.restore();
      }
    }

    // Clip: the kept pieces and the scissors between them.
    {
      const box = laneBox("clip");
      const { pieces, gaps } = clipBars(project, scale);
      for (const piece of pieces) {
        if (piece.x1 < left || piece.x0 > right) continue;
        const selected = selection.kind === "clip" && selection.index === piece.item;
        ctx.fillStyle = c.clip;
        roundRect(ctx, piece.x0 + 1, box.top, Math.max(1, piece.x1 - piece.x0 - 2), box.height, 5);
        ctx.fill();
        if (selected) {
          ctx.strokeStyle = c.accent;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
      for (const gap of gaps) {
        if (gap.x < left - 20 || gap.x > right + 20) continue;
        const selected = selection.kind === "gap" && selection.index === gap.index;
        drawScissors(ctx, gap.x, box.top + box.height / 2, selected ? c.accent : c.text, selected ? c.accent : c.track);
      }
    }

    // Zoom segments: purple, auto ones dashed until touched.
    {
      const box = laneBox("zoom");
      for (const bar of zoomBars(project, scale)) {
        if (bar.x1 < left || bar.x0 > right) continue;
        const selected = selection.kind === "zoom" && selection.id === bar.item.id;
        const w = Math.max(2, bar.x1 - bar.x0);
        roundRect(ctx, bar.x0, box.top + 1, w, box.height - 2, 6);
        ctx.fillStyle = c.zoomFill;
        ctx.fill();
        ctx.lineWidth = selected ? 2 : 1;
        ctx.strokeStyle = c.zoom;
        ctx.setLineDash(bar.item.auto && !selected ? [3, 3] : []);
        ctx.stroke();
        ctx.setLineDash([]);
        if (selected) drawGrips(ctx, bar.x0, bar.x1, box.top, box.height, c.zoom);
        if (w > 34) {
          ctx.fillStyle = c.zoom;
          ctx.fillText(levelText(bar.item.level), bar.x0 + 8, box.top + box.height / 2);
        }
      }
    }

    // Speed segments: amber, "4× idle"; a cut in the speed plan as a marker.
    {
      const box = laneBox("speed");
      for (const bar of speedBars(project, scale)) {
        if (bar.x1 < left - 10 || bar.x0 > right + 10) continue;
        const selected = selection.kind === "speed" && selection.id === bar.item.id;
        const label = speedLabel(bar.item.rate, bar.item.auto);
        if (!Number.isFinite(bar.item.rate) || bar.x1 - bar.x0 < 2) {
          drawScissors(ctx, bar.x0, box.top + box.height / 2, selected ? c.accent : c.speed, c.track);
          continue;
        }
        const w = bar.x1 - bar.x0;
        roundRect(ctx, bar.x0, box.top + 1, w, box.height - 2, 6);
        ctx.fillStyle = c.speedFill;
        ctx.fill();
        ctx.lineWidth = selected ? 2 : 1;
        ctx.strokeStyle = c.speed;
        ctx.stroke();
        if (selected) drawGrips(ctx, bar.x0, bar.x1, box.top, box.height, c.speed);
        if (w > 30) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(bar.x0 + 4, box.top, w - 8, box.height);
          ctx.clip();
          ctx.fillStyle = c.speed;
          ctx.fillText(label, bar.x0 + 8, box.top + box.height / 2);
          ctx.restore();
        }
      }
    }

    // Events: click dots, ⌨ bursts, ↕ scroll runs, navigations, chords.
    {
      const box = laneBox("events");
      const mid = box.top + box.height / 2;
      for (const mark of editor.marks) {
        const x = xOfSrc(scale, mark.t);
        if (x < left - 30 || x > right + 30) continue;
        switch (mark.kind) {
          case "click":
            ctx.fillStyle = mark.button === "left" ? c.text : c.text3;
            ctx.beginPath();
            ctx.arc(x, mid, 2.5, 0, Math.PI * 2);
            ctx.fill();
            break;
          case "typing": {
            const x1 = xOfSrc(scale, mark.end);
            ctx.fillStyle = c.text3;
            ctx.fillRect(x, mid + 5, Math.max(1, x1 - x), 1.5);
            ctx.fillStyle = c.text2;
            ctx.fillText("⌨", x - 1, mid - 1);
            break;
          }
          case "scroll": {
            const x1 = xOfSrc(scale, mark.end);
            ctx.fillStyle = c.text3;
            ctx.fillRect(x, mid + 5, Math.max(1, x1 - x), 1.5);
            ctx.fillStyle = c.text2;
            ctx.fillText("↕", x - 1, mid - 1);
            break;
          }
          case "nav":
            ctx.fillStyle = c.accent;
            ctx.beginPath();
            ctx.moveTo(x, mid - 5);
            ctx.lineTo(x + 4, mid);
            ctx.lineTo(x, mid + 5);
            ctx.lineTo(x - 4, mid);
            ctx.closePath();
            ctx.fill();
            break;
          case "chord":
            ctx.fillStyle = c.text2;
            ctx.font = `500 10px ${FONT}`;
            ctx.fillText(mark.chord, x - 2, mid);
            ctx.font = `500 11px ${FONT}`;
            break;
        }
      }
    }

    // Mic: the waveform from mic.levels (50 Hz RMS), one column a pixel.
    {
      const box = laneBox("mic");
      const levels = editor.rec.micLevels;
      const mid = box.top + box.height / 2;
      if (levels === null) {
        ctx.fillStyle = c.text3;
        ctx.fillText("No microphone", Math.max(left, INSET) + 8, mid);
      } else {
        ctx.fillStyle = c.mic;
        const x0 = Math.max(INSET, Math.floor(left));
        const x1 = Math.min(endX, Math.ceil(right));
        for (let x = x0; x < x1; x += 2) {
          const a = srcOfX(scale, x);
          const b = srcOfX(scale, x + 2);
          const level = levelAt(levels, 50, Math.min(a, b), Math.max(a, b));
          const db = level > 0 ? 20 * Math.log10(level) : -90;
          const amp = clamp((db + 54) / 54, 0, 1) * (box.height / 2 - 2);
          if (amp < 0.5) continue;
          ctx.fillRect(x, mid - amp, 1.4, amp * 2);
        }
      }
    }

    // The playhead.
    {
      const x = Math.round(xOfOut(scale, editor.playhead)) + 0.5;
      ctx.strokeStyle = c.playhead;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 6);
      ctx.lineTo(x, lanesHeight());
      ctx.stroke();
      ctx.fillStyle = c.playhead;
      roundRect(ctx, x - 5, 3, 10, 12, 3);
      ctx.fill();
    }
  }

  private drawRuler(ctx: CanvasRenderingContext2D, scale: Scale, c: Palette, left: number, right: number): void {
    const { major, minor } = rulerStep(scale.pps);
    const duration = scale.map.duration;
    const first = Math.max(0, Math.floor(outOfX(scale, left) / minor) * minor);
    ctx.fillStyle = c.hairline;
    ctx.fillRect(left, RULER_HEIGHT - 0.5, right - left, 0.5);
    for (let t = first; t <= duration + 1e-6; t += minor) {
      const x = Math.round(xOfOut(scale, t)) + 0.5;
      if (x > right + 40) break;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.fillStyle = isMajor ? c.text3 : c.hairline;
      ctx.fillRect(x - 0.5, isMajor ? RULER_HEIGHT - 8 : RULER_HEIGHT - 4, 1, isMajor ? 8 : 4);
      if (isMajor) {
        ctx.fillStyle = c.text3;
        ctx.font = `500 10px ${FONT}`;
        ctx.fillText(rulerLabel(t, major), x + 4, RULER_HEIGHT - 12);
        ctx.font = `500 11px ${FONT}`;
      }
    }
  }
}

export function speedLabel(rate: number, auto: string | null): string {
  const value = Number.isFinite(rate) ? `${Number.isInteger(rate) ? String(rate) : rate.toFixed(1)}×` : "Cut";
  return auto === null ? value : `${value} ${auto}`;
}

function rulerLabel(t: number, step: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const sText = step < 1 ? s.toFixed(step < 0.5 ? 2 : 1).padStart(step < 0.5 ? 5 : 4, "0") : String(Math.round(s)).padStart(2, "0");
  return `${String(m)}:${sText}`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, hgt: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(0, w), Math.max(0, hgt), Math.min(r, w / 2, hgt / 2));
}

function drawGrips(ctx: CanvasRenderingContext2D, x0: number, x1: number, top: number, height: number, colour: string): void {
  ctx.fillStyle = colour;
  for (const x of [x0 + 3, x1 - 5]) {
    roundRect(ctx, x, top + height / 2 - 5, 2, 10, 1);
    ctx.fill();
  }
}

/** ✂ on a small disc, centred at (x, y). */
function drawScissors(ctx: CanvasRenderingContext2D, x: number, y: number, ink: string, ground: string): void {
  ctx.fillStyle = ground;
  ctx.beginPath();
  ctx.arc(x, y, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(x - 3, y - 3.2, 1.7, 0, Math.PI * 2);
  ctx.moveTo(x - 3 + 1.7, y + 3.2);
  ctx.arc(x - 3, y + 3.2, 1.7, 0, Math.PI * 2);
  ctx.moveTo(x - 1.6, y - 2.2);
  ctx.lineTo(x + 4, y + 2.6);
  ctx.moveTo(x - 1.6, y + 2.2);
  ctx.lineTo(x + 4, y - 2.6);
  ctx.stroke();
}
