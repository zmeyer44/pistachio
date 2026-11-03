/**
 * One `render(tOut)` for preview and export (docs/recorder.md R3, §4
 * `render.ts`). Canvas2D in v1.
 *
 * A frame, in order: the time map (output → source seconds) → the background
 * (`look.background`: a wallpaper, a gradient, a solid, or the content itself
 * blurred) → under the camera transform: the window's shadow (a pre-rendered
 * 9-slice), the window (browser chrome with the chapter's address, mac chrome
 * with its title, or none) with rounded corners and the screen frame in its
 * content quad, the cursor sprite (clipped to the content) with its press and
 * ripple → the camera bubble → the keystroke chip.
 *
 * Layout: the window is fitted inside the output less `padding × min(W, H)`
 * on every side, keeping the view's shape (its chrome scales with the
 * content); the corner radius is `radius` px at 1080p. The camera maps its
 * viewport (`1/z` of the content around (cx, cy)) onto the content quad's
 * zoom-1 box, and the whole window moves with it (the background stays). A
 * `null` screen draws a neutral placeholder, so the editor works before media
 * decodes; a `null` camera source draws no bubble.
 */
import type { CameraSample, LookSpec, Project, Rect, RenderSources, RenderState, Size, TimeMap } from "./types.js";
import type { Recording } from "./events.js";
import { chapterAt, chaptersOf, chordTrack, eventsDuration, pointerAt } from "./events.js";
import { cameraAt, cameraPath, omegaFor, viewportOf } from "./camera.js";
import { cursorPath } from "./cursor.js";
import { cursorShapeFor, drawCursor } from "./cursors.js";
import { type Ctx2D, DEFAULT_WALLPAPER, drawGradient, drawWallpaper, WALLPAPERS } from "./wallpapers.js";
import { clamp, easeOutCubic, smoothstep } from "./util.js";

export interface Renderer {
  /** Draw the frame at an output time into `ctx` (its canvas is `state.output` pixels). */
  render(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, tOut: number, sources: RenderSources): void;
  /** The content quad's box inside the output, for the editor's zoom-rectangle handles. */
  contentBox(): { x: number; y: number; w: number; h: number };
}

/** A scratch canvas the renderer may draw into and then draw from. */
export type ScratchCanvas = OffscreenCanvas | HTMLCanvasElement;

export interface RendererOptions {
  /** Makes the scratch canvases (the shadow sprite, the cached background, the blur). Default: `OffscreenCanvas`, else a DOM canvas, else none (each drawn directly, slower). */
  createCanvas?: (w: number, h: number) => ScratchCanvas | null;
}

/** Chrome bar heights in view CSS px. */
export const FRAME_BAR: Record<LookSpec["frame"], number> = { browser: 40, mac: 28, none: 0 };

const FONT = `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Helvetica Neue", Arial, sans-serif`;

export interface SceneLayout {
  /** Output px per view CSS px at zoom 1. */
  scale: number;
  /** The window: chrome and content. */
  window: Rect;
  /** The content quad (the page) at zoom 1. */
  content: Rect;
  /** The chrome bar's height (output px). */
  bar: number;
  /** The window's corner radius (output px). */
  radius: number;
  /** min(W, H) / 1080: output px per "1080p px", for UI sized like the spec's numbers. */
  unit: number;
}

/** Where the window and its content sit in an output of `output` px. */
export function sceneLayout(look: LookSpec, view: Size, output: Size): SceneLayout {
  const W = Math.max(1, output.w);
  const H = Math.max(1, output.h);
  const shorter = Math.min(W, H);
  const pad = clamp(Number.isFinite(look.padding) ? look.padding : 0, 0, 0.45) * shorter;
  const barCss = FRAME_BAR[look.frame] ?? 0;
  const vw = Math.max(1, view.w);
  const vh = Math.max(1, view.h);
  const scale = Math.max(1e-6, Math.min((W - 2 * pad) / vw, (H - 2 * pad) / (vh + barCss)));
  const ww = vw * scale;
  const wh = (vh + barCss) * scale;
  const window = { x: (W - ww) / 2, y: (H - wh) / 2, w: ww, h: wh };
  const bar = barCss * scale;
  const unit = shorter / 1080;
  return { scale, window, content: { x: window.x, y: window.y + bar, w: ww, h: vh * scale }, bar, radius: clamp(Number.isFinite(look.radius) ? look.radius : 0, 0, 200) * unit, unit };
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * The output's pixel size for an aspect and an export height. `height` names
 * the shorter side ("1080p" 9:16 is 1080×1920); `fit` takes the window's own
 * shape plus the padding. Always even (H.264 wants it).
 */
export function outputSize(look: LookSpec, view: Size, height: number): Size {
  const short = Math.max(2, height);
  switch (look.aspect) {
    case "9:16":
      return { w: even(short), h: even((short * 16) / 9) };
    case "1:1":
      return { w: even(short), h: even(short) };
    case "4:3":
      return { w: even((short * 4) / 3), h: even(short) };
    case "fit": {
      const pad = clamp(look.padding, 0, 0.45);
      const ratio = Math.max(1, view.w) / (Math.max(1, view.h) + (FRAME_BAR[look.frame] ?? 0));
      if (ratio >= 1) {
        const s = (short * (1 - 2 * pad)) / (Math.max(1, view.h) + (FRAME_BAR[look.frame] ?? 0));
        return { w: even(view.w * s + 2 * pad * short), h: even(short) };
      }
      const s = (short * (1 - 2 * pad)) / Math.max(1, view.w);
      return { w: even(short), h: even((view.h + (FRAME_BAR[look.frame] ?? 0)) * s + 2 * pad * short) };
    }
    default:
      return { w: even((short * 16) / 9), h: even(short) };
  }
}

function defaultCanvas(w: number, h: number): ScratchCanvas | null {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }
  return null;
}

function context(canvas: ScratchCanvas | null): Ctx2D | null {
  if (canvas === null) return null;
  try {
    return (canvas.getContext("2d") as Ctx2D | null) ?? null;
  } catch {
    return null;
  }
}

/** A drawable's pixel size, whatever it is (VideoFrame, video, image, canvas, bitmap); 0×0 when unknown or not ready. */
export function sourceSize(source: CanvasImageSource | null): Size {
  if (source === null || typeof source !== "object") return { w: 0, h: 0 };
  const s = source as unknown as Record<string, unknown>;
  const pick = (a: string, b: string) => (typeof s[a] === "number" && typeof s[b] === "number" ? { w: s[a] as number, h: s[b] as number } : null);
  const size = pick("displayWidth", "displayHeight") ?? pick("videoWidth", "videoHeight") ?? pick("naturalWidth", "naturalHeight") ?? pick("width", "height") ?? { w: 0, h: 0 };
  return size.w > 0 && size.h > 0 ? size : { w: 0, h: 0 };
}

function roundRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** `text` cut with an ellipsis to fit `max` px in the current font. */
function fitText(ctx: Ctx2D, text: string, max: number): string {
  const width = (s: string) => {
    const m = ctx.measureText(s) as TextMetrics | undefined;
    return m && Number.isFinite(m.width) ? m.width : 0;
  };
  if (width(text) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (width(text.slice(0, mid) + "…") <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "" : text.slice(0, lo) + "…";
}

/** An address as a browser's pill shows it: no scheme, no `www.`, no trailing slash. */
export function displayUrl(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

function sane(sample: CameraSample): CameraSample {
  const z = Number.isFinite(sample.z) ? Math.max(1, sample.z) : 1;
  const half = 0.5 / z;
  return { cx: clamp(Number.isFinite(sample.cx) ? sample.cx : 0.5, half, 1 - half), cy: clamp(Number.isFinite(sample.cy) ? sample.cy : 0.5, half, 1 - half), z };
}

export function createRenderer(state: RenderState, timeMap: TimeMap, options: RendererOptions = {}): Renderer {
  const makeCanvas = options.createCanvas ?? defaultCanvas;
  const scratch = (w: number, h: number): { canvas: ScratchCanvas; ctx: Ctx2D } | null => {
    let canvas: ScratchCanvas | null = null;
    try {
      canvas = makeCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
    } catch {
      canvas = null;
    }
    const ctx = context(canvas);
    return canvas !== null && ctx !== null ? { canvas, ctx } : null;
  };

  // Caches: the background (one), the shadow sprite (one), the blur (one).
  let backgroundKey = "";
  let backgroundCanvas: ScratchCanvas | null = null;
  let shadowKey = "";
  let shadowSprite: { canvas: ScratchCanvas; edge: number; margin: number; size: number } | null = null;
  let blur: { canvas: ScratchCanvas; ctx: Ctx2D; w: number; h: number; cam: CameraSample; tSrc: number } | null = null;

  const layout = () => sceneLayout(state.project.look, state.meta.view, state.output);

  function drawBackground(ctx: Ctx2D, W: number, H: number, screen: CanvasImageSource | null, cam: CameraSample, tSrc: number): void {
    const background = state.project.look.background;
    if (background.type === "solid") {
      ctx.fillStyle = typeof background.color === "string" && background.color !== "" ? background.color : "#1E1F23";
      ctx.fillRect(0, 0, W, H);
      return;
    }
    if (background.type === "blur") {
      if (drawBlur(ctx, W, H, screen, cam, tSrc)) return;
      drawCached(ctx, "wallpaper", "graphite", W, H);
      return;
    }
    drawCached(ctx, background.type, background.id, W, H);
  }

  function drawCached(ctx: Ctx2D, type: "wallpaper" | "gradient", id: string, W: number, H: number): void {
    const known = type === "wallpaper" ? (WALLPAPERS.some((w) => w.id === id) ? id : DEFAULT_WALLPAPER) : id;
    const key = `${type}:${known}:${W}x${H}`;
    if (key !== backgroundKey) {
      backgroundKey = key;
      const made = scratch(W, H);
      backgroundCanvas = made ? made.canvas : null;
      if (made) (type === "wallpaper" ? drawWallpaper : drawGradient)(made.ctx, known, W, H);
    }
    if (backgroundCanvas !== null) ctx.drawImage(backgroundCanvas, 0, 0, W, H);
    else (type === "wallpaper" ? drawWallpaper : drawGradient)(ctx, known, W, H);
  }

  /** The content behind the window, blurred: what the camera shows, cover-fit; recomputed when the camera moves or every 0.25 s of source. */
  function drawBlur(ctx: Ctx2D, W: number, H: number, screen: CanvasImageSource | null, cam: CameraSample, tSrc: number): boolean {
    const size = sourceSize(screen);
    if (screen === null || size.w === 0) return false;
    const qw = Math.max(8, Math.round(W / 4));
    const qh = Math.max(8, Math.round(H / 4));
    const drawInto = (target: Ctx2D, tw: number, th: number, radius: number) => {
      const v = viewportOf(cam);
      const sw = v.w * size.w;
      const sh = v.h * size.h;
      const k = Math.max(tw / sw, th / sh) * 1.12;
      target.save();
      target.filter = `blur(${radius}px)`;
      target.drawImage(screen, v.x * size.w, v.y * size.h, sw, sh, (tw - sw * k) / 2, (th - sh * k) / 2, sw * k, sh * k);
      target.restore();
    };
    const still = blur !== null && blur.w === qw && blur.h === qh && Math.abs(blur.cam.cx - cam.cx) < 1e-3 && Math.abs(blur.cam.cy - cam.cy) < 1e-3 && Math.abs(blur.cam.z / cam.z - 1) < 1e-3 && tSrc >= blur.tSrc && tSrc - blur.tSrc < 0.25;
    if (!still) {
      if (blur === null || blur.w !== qw || blur.h !== qh) {
        const made = scratch(qw, qh);
        blur = made ? { canvas: made.canvas, ctx: made.ctx, w: qw, h: qh, cam, tSrc } : null;
      }
      if (blur !== null) {
        blur.ctx.clearRect(0, 0, qw, qh);
        drawInto(blur.ctx, qw, qh, Math.max(2, qw / 48));
        blur.cam = cam;
        blur.tSrc = tSrc;
      }
    }
    if (blur !== null) ctx.drawImage(blur.canvas, 0, 0, W, H);
    else drawInto(ctx, W, H, Math.max(8, W / 48));
    ctx.fillStyle = "rgba(0, 0, 0, 0.14)";
    ctx.fillRect(0, 0, W, H);
    return true;
  }

  function drawShadow(ctx: Ctx2D, L: SceneLayout): void {
    const strength = clamp(Number.isFinite(state.project.look.shadow) ? state.project.look.shadow : 0, 0, 1);
    if (strength <= 0.001) return;
    const blurPx = (10 + 50 * strength) * L.unit;
    const offset = (4 + 18 * strength) * L.unit;
    const alpha = 0.18 + 0.4 * strength;
    const win = L.window;
    const key = `${blurPx.toFixed(2)}:${L.radius.toFixed(2)}:${alpha.toFixed(3)}`;
    if (key !== shadowKey) {
      shadowKey = key;
      shadowSprite = null;
      const margin = Math.ceil(blurPx * 1.6);
      const core = Math.max(4, Math.ceil(L.radius) + 2);
      const edge = margin + core;
      const size = 2 * edge + 1;
      const made = scratch(size, size);
      if (made) {
        const away = size + 64;
        made.ctx.save();
        made.ctx.shadowColor = `rgba(0, 0, 0, ${alpha})`;
        made.ctx.shadowBlur = blurPx;
        made.ctx.shadowOffsetX = away;
        made.ctx.fillStyle = "#000";
        roundRectPath(made.ctx, margin - away, margin, 2 * core + 1, 2 * core + 1, L.radius);
        made.ctx.fill();
        made.ctx.restore();
        shadowSprite = { canvas: made.canvas, edge, margin, size };
      }
    }
    if (shadowSprite === null) {
      ctx.save();
      ctx.shadowColor = `rgba(0, 0, 0, ${alpha})`;
      ctx.shadowBlur = blurPx;
      ctx.shadowOffsetY = offset;
      ctx.fillStyle = "#000";
      roundRectPath(ctx, win.x, win.y, win.w, win.h, L.radius);
      ctx.fill();
      ctx.restore();
      return;
    }
    // Nine slices: corners as they are, edges and the middle stretched.
    const { canvas, edge, margin, size } = shadowSprite;
    const dx = win.x - margin;
    const dy = win.y - margin + offset;
    const dw = win.w + 2 * margin;
    const dh = win.h + 2 * margin;
    const e = Math.min(edge, dw / 2, dh / 2);
    const mid = size - 2 * edge;
    const cols: [number, number, number, number][] = [[0, edge, dx, e], [edge, mid, dx + e, dw - 2 * e], [size - edge, edge, dx + dw - e, e]];
    const rows: [number, number, number, number][] = [[0, edge, dy, e], [edge, mid, dy + e, dh - 2 * e], [size - edge, edge, dy + dh - e, e]];
    for (const [sx, sw, x, w] of cols) for (const [sy, sh, y, h] of rows) if (w > 0 && h > 0) ctx.drawImage(canvas, sx, sy, sw, sh, x, y, w, h);
  }

  function drawChrome(ctx: Ctx2D, L: SceneLayout, tSrc: number): void {
    const frame = state.project.look.frame;
    if (frame === "none" || L.bar <= 0) return;
    const win = L.window;
    const k = L.scale;
    const mid = win.y + L.bar / 2;
    ctx.fillStyle = frame === "browser" ? "#ECECEF" : "#E6E6E8";
    ctx.fillRect(win.x, win.y, win.w, L.bar);
    ctx.fillStyle = "rgba(0, 0, 0, 0.09)";
    ctx.fillRect(win.x, win.y + L.bar - Math.max(0.5, k), win.w, Math.max(0.5, k));
    const dots = ["#FF5F57", "#FEBC2E", "#28C840"];
    const first = frame === "browser" ? 18 : 14;
    dots.forEach((color, i) => {
      ctx.beginPath();
      ctx.arc(win.x + (first + i * 20) * k, mid, 6 * k, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 0.6 * k;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.12)";
      ctx.stroke();
    });
    const chapter = state.chapter(tSrc);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (frame === "browser") {
      const pillW = Math.min(win.w * 0.52, 620 * k);
      const pillH = 26 * k;
      const pillX = win.x + (win.w - pillW) / 2;
      roundRectPath(ctx, pillX, mid - pillH / 2, pillW, pillH, pillH / 2);
      ctx.fillStyle = "#FFFFFF";
      ctx.fill();
      ctx.lineWidth = 0.6 * k;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.07)";
      ctx.stroke();
      ctx.font = `400 ${12.5 * k}px ${FONT}`;
      ctx.fillStyle = "#5F6368";
      const url = displayUrl(chapter?.url || state.meta.source.url || "");
      ctx.fillText(fitText(ctx, url, pillW - 28 * k), pillX + pillW / 2, mid);
    } else {
      ctx.font = `600 ${13 * k}px ${FONT}`;
      ctx.fillStyle = "#4D4D4D";
      const title = chapter?.title || state.meta.source.title || "";
      ctx.fillText(fitText(ctx, title, win.w - 180 * k), win.x + win.w / 2, mid);
    }
  }

  function drawPlaceholder(ctx: Ctx2D, B: Rect, k: number): void {
    ctx.fillStyle = "#F1F2F4";
    ctx.fillRect(B.x, B.y, B.w, B.h);
    ctx.fillStyle = "#E1E3E8";
    const left = B.x + B.w * 0.08;
    const bars: [number, number, number][] = [[0.1, 0.42, 22], [0.18, 0.7, 12], [0.23, 0.62, 12], [0.28, 0.66, 12], [0.4, 0.84, 120]];
    for (const [fy, fw, h] of bars) {
      roundRectPath(ctx, left, B.y + B.h * fy, B.w * 0.84 * fw, h * k, 4 * k);
      ctx.fill();
    }
  }

  function drawWindow(ctx: Ctx2D, L: SceneLayout, screen: CanvasImageSource | null, tSrc: number): void {
    const win = L.window;
    const B = L.content;
    ctx.save();
    roundRectPath(ctx, win.x, win.y, win.w, win.h, L.radius);
    ctx.clip();
    drawChrome(ctx, L, tSrc);
    if (screen !== null && sourceSize(screen).w > 0) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(screen, B.x, B.y, B.w, B.h);
    } else {
      drawPlaceholder(ctx, B, L.scale);
    }
    ctx.restore();
  }

  function drawCursorLayer(ctx: Ctx2D, L: SceneLayout, tSrc: number): void {
    const spec = state.project.cursor;
    if (spec.mode === "hidden") return;
    const c = state.cursor(tSrc);
    if (c === null || !c.visible || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return;
    const shape = cursorShapeFor(c.type);
    if (shape === null) return;
    const B = L.content;
    const view = state.meta.view;
    const x = B.x + (c.x / Math.max(1, view.w)) * B.w;
    const y = B.y + (c.y / Math.max(1, view.h)) * B.h;
    const size = Number.isFinite(spec.size) && spec.size > 0 ? spec.size : 1;
    const fade = clamp(c.fade ?? 1, 0, 1);
    ctx.save();
    ctx.beginPath();
    ctx.rect(B.x, B.y, B.w, B.h);
    ctx.clip();
    if (spec.click === "ripple" && c.ripple > 0 && c.ripple < 1) {
      const radius = 28 * size * L.scale * easeOutCubic(c.ripple);
      const alpha = 0.45 * (1 - c.ripple) * fade;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, radius), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.5})`;
      ctx.fill();
      ctx.lineWidth = 2 * L.scale;
      ctx.strokeStyle = `rgba(20, 20, 24, ${alpha})`;
      ctx.stroke();
    }
    ctx.globalAlpha = fade;
    drawCursor(ctx, shape, x, y, L.scale * size * (1 - 0.15 * clamp(c.press, 0, 1)));
    ctx.restore();
  }

  function drawBubble(ctx: Ctx2D, W: number, H: number, camera: CanvasImageSource | null, cam: CameraSample): void {
    const size = sourceSize(camera);
    if (camera === null || size.w === 0) return;
    const spec = state.project.camera;
    const shorter = Math.min(W, H);
    let d = clamp(Number.isFinite(spec.size) ? spec.size : 0.18, 0.05, 0.6) * shorter;
    if (spec.shrinkOnZoom) d *= 1 - 0.4 * smoothstep((cam.z - 1.4) / 0.6);
    const margin = Math.max(12, 0.035 * shorter);
    const x = spec.corner === "tl" || spec.corner === "bl" ? margin : W - margin - d;
    const y = spec.corner === "tl" || spec.corner === "tr" ? margin : H - margin - d;
    const path = () => {
      if (spec.shape === "rounded") roundRectPath(ctx, x, y, d, d, d * 0.22);
      else {
        ctx.beginPath();
        ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
      }
    };
    const side = Math.min(size.w, size.h);
    ctx.save();
    path();
    ctx.clip();
    ctx.drawImage(camera, (size.w - side) / 2, (size.h - side) / 2, side, side, x, y, d, d);
    ctx.restore();
    path();
    ctx.lineWidth = Math.max(1.5, 3 * (shorter / 1080));
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.stroke();
  }

  function drawChord(ctx: Ctx2D, W: number, H: number, text: string | null): void {
    if (!text) return;
    const unit = Math.min(W, H) / 1080;
    const h = 56 * unit;
    ctx.font = `600 ${28 * unit}px ${FONT}`;
    const measured = ctx.measureText(text) as TextMetrics | undefined;
    const tw = measured && Number.isFinite(measured.width) ? measured.width : text.length * 16 * unit;
    const w = Math.min(W * 0.8, tw + 40 * unit);
    const x = (W - w) / 2;
    const y = H - 44 * unit - h;
    roundRectPath(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = "rgba(18, 18, 22, 0.8)";
    ctx.fill();
    ctx.fillStyle = "#FFFFFF";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(fitText(ctx, text, w - 32 * unit), W / 2, y + h / 2 + unit);
  }

  return {
    render(ctx, tOut, sources) {
      const W = state.output.w;
      const H = state.output.h;
      const tSrc = timeMap.toSource(Number.isFinite(tOut) ? tOut : 0);
      const cam = sane(state.camera(tSrc));
      const L = layout();
      const screen = sources.screen ?? null;
      ctx.save();
      drawBackground(ctx, W, H, screen, cam, tSrc);
      const B = L.content;
      const ox = B.x + (cam.cx - 0.5 / cam.z) * B.w;
      const oy = B.y + (cam.cy - 0.5 / cam.z) * B.h;
      ctx.save();
      ctx.translate(B.x, B.y);
      ctx.scale(cam.z, cam.z);
      ctx.translate(-ox, -oy);
      drawShadow(ctx, L);
      drawWindow(ctx, L, screen, tSrc);
      drawCursorLayer(ctx, L, tSrc);
      ctx.restore();
      drawBubble(ctx, W, H, sources.camera ?? null, cam);
      drawChord(ctx, W, H, state.chord(tSrc));
      ctx.restore();
    },
    contentBox() {
      const B = layout().content;
      return { x: B.x, y: B.y, w: B.w, h: B.h };
    },
  };
}

export interface RenderStateOptions {
  /** The source's length in seconds (default: the longest of the events and the cuts). */
  duration?: number;
  /** The camera path's sample rate (default `CAMERA_FPS`). */
  fps?: number;
}

/** The camera path's sample rate: fixed, so the preview and an export at any fps follow one path. */
export const CAMERA_FPS = 60;

/**
 * Everything `render` needs, solved from a project and its recording — the
 * one render state the editor's preview and the export both draw from: the
 * camera path over `project.zooms` (ω from the zoom feel, following the raw
 * pointer; with automatic zoom off, the solver's untouched segments are left
 * out), the cursor path, the chapters (the source's own title and address
 * before the first `nav`), and the keystroke chips. Rebuild it when the zooms,
 * the zoom settings, the cursor settings or the duration change; the rest of
 * the project (the look) is read from `state.project` as it is drawn.
 */
export function renderStateFor(project: Project, recording: Recording, output: Size, options: RenderStateOptions = {}): RenderState {
  const { meta, events } = recording;
  const view = meta.view;
  const fps = options.fps !== undefined && options.fps > 0 ? options.fps : CAMERA_FPS;
  const duration = options.duration ?? Math.max(eventsDuration(events), ...project.cuts.map((c) => c.out).filter(Number.isFinite), 0);
  const zooms = project.zoom.auto ? project.zooms : project.zooms.filter((zoom) => !zoom.auto);
  const path = cameraPath(zooms, duration, {
    omega: omegaFor(project.zoom.feel),
    fps,
    aspect: view.w / Math.max(1, view.h),
    cursor: (t) => {
      const p = pointerAt(events, t);
      return p === null ? null : { x: p.x / Math.max(1, view.w), y: p.y / Math.max(1, view.h) };
    },
  });
  const cursor = cursorPath(events, project.cursor);
  const chapters = chaptersOf(events);
  const fallback = meta.source.url !== "" || meta.source.title !== "" ? { url: meta.source.url, title: meta.source.title } : null;
  return {
    project,
    meta,
    output,
    camera: (t) => cameraAt(path, fps, t),
    cursor: (t) => cursor.at(t),
    chapter: (t) => {
      const chapter = chapterAt(chapters, t);
      return chapter === null ? fallback : { url: chapter.url, title: chapter.title };
    },
    chord: chordTrack(events),
  };
}
