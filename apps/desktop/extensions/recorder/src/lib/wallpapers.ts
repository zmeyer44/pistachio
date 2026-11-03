/**
 * The backgrounds behind the window (docs/recorder.md §2 "Background"): six
 * named wallpapers drawn as gradients and soft shapes (no image assets), and
 * named two-stop gradients. Pure drawing on a 2D context; the renderer caches
 * the result per size.
 */

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface WallpaperPreset {
  id: string;
  name: string;
  /** A CSS colour close to the wallpaper's average, for swatches and fallbacks. */
  swatch: string;
}

export interface GradientPreset {
  id: string;
  name: string;
  /** CSS degrees: 0 points up, 90 right. */
  angle: number;
  stops: [number, string][];
}

export const WALLPAPERS: readonly WallpaperPreset[] = [
  { id: "dawn", name: "Dawn", swatch: "#F2B5C4" },
  { id: "dusk", name: "Dusk", swatch: "#8A3A6A" },
  { id: "ocean", name: "Ocean", swatch: "#1F6F86" },
  { id: "meadow", name: "Meadow", swatch: "#8FC48C" },
  { id: "aurora", name: "Aurora", swatch: "#1C2A4A" },
  { id: "graphite", name: "Graphite", swatch: "#24262B" },
];

export const GRADIENTS: readonly GradientPreset[] = [
  { id: "sunset", name: "Sunset", angle: 135, stops: [[0, "#FF7E5F"], [1, "#FEB47B"]] },
  { id: "sky", name: "Sky", angle: 135, stops: [[0, "#89F7FE"], [1, "#66A6FF"]] },
  { id: "mint", name: "Mint", angle: 135, stops: [[0, "#D4FC79"], [1, "#96E6A1"]] },
  { id: "peach", name: "Peach", angle: 135, stops: [[0, "#FFECD2"], [1, "#FCB69F"]] },
  { id: "violet", name: "Violet", angle: 135, stops: [[0, "#A18CD1"], [1, "#FBC2EB"]] },
  { id: "lagoon", name: "Lagoon", angle: 135, stops: [[0, "#43CEA2"], [1, "#185A9D"]] },
  { id: "candy", name: "Candy", angle: 135, stops: [[0, "#F093FB"], [1, "#F5576C"]] },
  { id: "ink", name: "Ink", angle: 160, stops: [[0, "#434343"], [1, "#0B0B0D"]] },
];

export const DEFAULT_WALLPAPER = "dawn";

/** A linear gradient across the whole rect at a CSS angle. */
function linear(ctx: Ctx2D, w: number, h: number, angle: number, stops: readonly [number, string][]): void {
  const theta = (angle * Math.PI) / 180;
  const dx = Math.sin(theta);
  const dy = -Math.cos(theta);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  const gradient = ctx.createLinearGradient(w / 2 - dx * half, h / 2 - dy * half, w / 2 + dx * half, h / 2 + dy * half);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
}

/** A soft glow: a radial gradient from `color` to transparent, centre and radius as fractions of the rect (radius of the longer side). */
function glow(ctx: Ctx2D, w: number, h: number, fx: number, fy: number, fr: number, color: string, alpha: number): void {
  const x = fx * w;
  const y = fy * h;
  const r = fr * Math.max(w, h);
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
  gradient.addColorStop(0, withAlpha(color, alpha));
  gradient.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
}

/** `#RRGGBB` → `rgba(r, g, b, a)`. */
function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** A filled band under a sine wave, from `fy` (fraction of height) to the bottom. */
function wave(ctx: Ctx2D, w: number, h: number, fy: number, amplitude: number, periods: number, phase: number, color: string, alpha: number): void {
  ctx.beginPath();
  ctx.moveTo(0, h);
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    ctx.lineTo(u * w, fy * h + Math.sin(u * Math.PI * 2 * periods + phase) * amplitude * h);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = withAlpha(color, alpha);
  ctx.fill();
}

/** An ellipse, centre and radii as fractions of the rect. */
function ellipse(ctx: Ctx2D, w: number, h: number, fx: number, fy: number, frx: number, fry: number, color: string, alpha: number): void {
  ctx.beginPath();
  ctx.ellipse(fx * w, fy * h, frx * w, fry * h, 0, 0, Math.PI * 2);
  ctx.fillStyle = withAlpha(color, alpha);
  ctx.fill();
}

/** Draw a wallpaper over `[0, 0, w, h]`; an unknown id draws `dawn`. */
export function drawWallpaper(ctx: Ctx2D, id: string, w: number, h: number): void {
  ctx.save();
  switch (id) {
    case "dusk":
      linear(ctx, w, h, 180, [[0, "#2B1B4E"], [0.55, "#7A2E6E"], [1, "#F0875A"]]);
      glow(ctx, w, h, 0.72, 0.78, 0.42, "#FFB36B", 0.65);
      ellipse(ctx, w, h, 0.72, 0.8, 0.07, 0.07 * (w / h), "#FFD9A0", 0.55);
      wave(ctx, w, h, 0.86, 0.025, 1.2, 0.4, "#3A1846", 0.55);
      break;
    case "ocean":
      linear(ctx, w, h, 165, [[0, "#7FD3C8"], [0.5, "#1B7A8C"], [1, "#0B3D5C"]]);
      glow(ctx, w, h, 0.2, 0.15, 0.5, "#E6FFF8", 0.35);
      wave(ctx, w, h, 0.62, 0.03, 1.5, 0, "#0E5A78", 0.35);
      wave(ctx, w, h, 0.74, 0.025, 2.1, 1.3, "#0B3D5C", 0.45);
      wave(ctx, w, h, 0.86, 0.02, 2.7, 2.2, "#072A42", 0.55);
      break;
    case "meadow":
      linear(ctx, w, h, 180, [[0, "#E9F6C8"], [0.55, "#A9D89A"], [1, "#4F9E7E"]]);
      glow(ctx, w, h, 0.8, 0.12, 0.45, "#FFF4B8", 0.7);
      ellipse(ctx, w, h, 0.2, 1.05, 0.55, 0.3, "#6DB57F", 0.55);
      ellipse(ctx, w, h, 0.85, 1.1, 0.6, 0.32, "#3F8D6E", 0.55);
      break;
    case "aurora":
      linear(ctx, w, h, 180, [[0, "#0B1026"], [1, "#151C3F"]]);
      glow(ctx, w, h, 0.28, 0.35, 0.45, "#2BD9A0", 0.45);
      glow(ctx, w, h, 0.72, 0.28, 0.4, "#7C5CFF", 0.5);
      glow(ctx, w, h, 0.55, 0.85, 0.45, "#1E9BD7", 0.3);
      break;
    case "graphite":
      linear(ctx, w, h, 160, [[0, "#30333A"], [1, "#141518"]]);
      glow(ctx, w, h, 0.15, 0.1, 0.6, "#FFFFFF", 0.08);
      glow(ctx, w, h, 0.9, 0.95, 0.5, "#6B7280", 0.12);
      break;
    default:
      linear(ctx, w, h, 160, [[0, "#FBD3C4"], [0.5, "#F3A6C8"], [1, "#B9A7F0"]]);
      glow(ctx, w, h, 0.15, 0.2, 0.55, "#FFE8B0", 0.7);
      glow(ctx, w, h, 0.85, 0.78, 0.5, "#F7B3D9", 0.55);
      glow(ctx, w, h, 0.5, 0.5, 0.6, "#FFFFFF", 0.12);
      break;
  }
  ctx.restore();
}

/** Draw a named gradient over `[0, 0, w, h]`; an unknown id draws the first. */
export function drawGradient(ctx: Ctx2D, id: string, w: number, h: number): void {
  const preset = GRADIENTS.find((g) => g.id === id) ?? (GRADIENTS[0] as GradientPreset);
  ctx.save();
  linear(ctx, w, h, preset.angle, preset.stops);
  ctx.restore();
}
