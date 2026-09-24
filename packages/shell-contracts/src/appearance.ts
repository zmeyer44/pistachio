/**
 * The app-owned window material: a colour scheme, one-to-three gradient
 * colours, a harmony used to generate those colours, and the opacity and
 * texture of the material. Pistachio keeps the material local to this
 * desktop installation.
 */

import { DEFAULT_NOTICE_POSITION, NOTICE_POSITIONS, type NoticePosition } from "./notice.js";

export type DesktopIconStyle = "white" | "green";

export type AppearanceScheme = "system" | "light" | "dark";
export type GradientHarmony =
  | "complementary"
  | "singleAnalogous"
  | "splitComplementary"
  | "analogous"
  | "triadic"
  | "floating";
export type GradientBlend = "mesh" | "linear" | "radial";

export interface AppearanceSettings {
  scheme: AppearanceScheme;
  /** Background of the native desktop app icon. */
  desktopIcon: DesktopIconStyle;
  /** Reveal the operating-system material beneath app-owned chrome. */
  desktopGlass: boolean;
  /** Tint laid over the clear desktop backdrop, 0.25–1. */
  glassTint: number;
  gradientEnabled: boolean;
  /** CSS hex colours, in paint order. One to three. */
  colors: string[];
  harmony: GradientHarmony;
  blend: GradientBlend;
  angle: number;
  /** Strength of the colour wash, 0–1. */
  intensity: number;
  /** Procedural grain over the window, 0–1. */
  texture: number;
  /** Difference between raised and recessed surfaces, 0–1. */
  contrast: number;
  /** Opacity of app-owned chrome surfaces, 0.55–1. */
  surfaceOpacity: number;
  /** The medium corner radius, in CSS pixels. */
  radius: number;
  /** Where the notice stack stands over the page (./notice.ts). */
  toastPosition: NoticePosition;
}

export const APPEARANCE_SCHEMES: readonly AppearanceScheme[] = ["system", "light", "dark"];
export const GRADIENT_HARMONIES: readonly GradientHarmony[] = [
  "complementary",
  "singleAnalogous",
  "splitComplementary",
  "analogous",
  "triadic",
  "floating",
];
export const GRADIENT_BLENDS: readonly GradientBlend[] = ["mesh", "linear", "radial"];

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  scheme: "system",
  desktopIcon: "white",
  desktopGlass: true,
  glassTint: 0.25,
  gradientEnabled: true,
  colors: ["#88C999", "#67BFB4", "#98B9EF"],
  harmony: "floating",
  blend: "mesh",
  angle: 132,
  intensity: 0.36,
  texture: 0.08,
  contrast: 0.52,
  surfaceOpacity: 0.78,
  radius: 8,
  toastPosition: DEFAULT_NOTICE_POSITION,
};

export interface AppearancePreset {
  id: string;
  label: string;
  colors: string[];
  harmony: GradientHarmony;
  blend: GradientBlend;
  angle: number;
  intensity: number;
  texture: number;
}

export const APPEARANCE_PRESETS: readonly AppearancePreset[] = [
  {
    id: "pistachio",
    label: "Pistachio",
    colors: ["#88C999", "#67BFB4", "#98B9EF"],
    harmony: "floating",
    blend: "mesh",
    angle: 132,
    intensity: 0.36,
    texture: 0.08,
  },
  {
    id: "aurora",
    label: "Aurora",
    colors: ["#5CC8A1", "#648CF4", "#B56BDD"],
    harmony: "floating",
    blend: "mesh",
    angle: 148,
    intensity: 0.5,
    texture: 0.06,
  },
  {
    id: "ember",
    label: "Ember",
    colors: ["#F28B62", "#D65276", "#7650C7"],
    harmony: "floating",
    blend: "linear",
    angle: 118,
    intensity: 0.46,
    texture: 0.12,
  },
  {
    id: "tide",
    label: "Tide",
    colors: ["#3F80E8", "#4FC7D4", "#9AD7C0"],
    harmony: "floating",
    blend: "radial",
    angle: 155,
    intensity: 0.43,
    texture: 0.04,
  },
  {
    id: "carbon",
    label: "Carbon",
    colors: ["#55616D", "#8D98A3"],
    harmony: "floating",
    blend: "linear",
    angle: 145,
    intensity: 0.24,
    texture: 0.16,
  },
];

const HEX = /^#[0-9a-f]{6}$/i;

export function normalizeThemeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return `#${trimmed
      .slice(1)
      .split("")
      .map((digit) => `${digit}${digit}`)
      .join("")}`.toUpperCase();
  }
  return HEX.test(trimmed) ? trimmed.toUpperCase() : null;
}

function numberIn(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

export function sanitizeAppearance(value: unknown, fallback: AppearanceSettings = DEFAULT_APPEARANCE): AppearanceSettings {
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const colors = Array.isArray(raw["colors"])
    ? raw["colors"]
        .map(normalizeThemeColor)
        .filter((color): color is string => color !== null)
        .slice(0, 3)
    : [];
  return {
    scheme: oneOf(raw["scheme"], APPEARANCE_SCHEMES, fallback.scheme),
    desktopIcon: oneOf(raw["desktopIcon"], ["white", "green"], fallback.desktopIcon),
    desktopGlass: typeof raw["desktopGlass"] === "boolean" ? raw["desktopGlass"] : fallback.desktopGlass,
    glassTint: numberIn(raw["glassTint"], fallback.glassTint, 0.25, 1),
    gradientEnabled: typeof raw["gradientEnabled"] === "boolean" ? raw["gradientEnabled"] : fallback.gradientEnabled,
    colors: colors.length === 0 ? [...fallback.colors] : colors,
    harmony: oneOf(raw["harmony"], GRADIENT_HARMONIES, fallback.harmony),
    blend: oneOf(raw["blend"], GRADIENT_BLENDS, fallback.blend),
    angle: Math.round(numberIn(raw["angle"], fallback.angle, 0, 359)),
    intensity: numberIn(raw["intensity"], fallback.intensity, 0, 1),
    texture: numberIn(raw["texture"], fallback.texture, 0, 1),
    contrast: numberIn(raw["contrast"], fallback.contrast, 0, 1),
    surfaceOpacity: numberIn(raw["surfaceOpacity"], fallback.surfaceOpacity, 0.55, 1),
    radius: Math.round(numberIn(raw["radius"], fallback.radius, 0, 18)),
    toastPosition: oneOf(raw["toastPosition"], NOTICE_POSITIONS, fallback.toastPosition),
  };
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function hexToHsl(hex: string): Hsl {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
  }
  if (h < 0) h += 360;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return { h, s, l };
}

function hslToHex({ h, s, l }: Hsl): string {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const segment = h / 60;
  const x = chroma * (1 - Math.abs((segment % 2) - 1));
  const [r1, g1, b1] =
    segment < 1
      ? [chroma, x, 0]
      : segment < 2
        ? [x, chroma, 0]
        : segment < 3
          ? [0, chroma, x]
          : segment < 4
            ? [0, x, chroma]
            : segment < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const m = l - chroma / 2;
  return `#${[r1, g1, b1]
    .map((part) => Math.round((part + m) * 255).toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}

const HARMONY_OFFSETS: Exclude<Record<GradientHarmony, readonly number[]>, { floating: never }> & {
  floating: readonly number[];
} = {
  complementary: [0, 180],
  singleAnalogous: [0, 310],
  splitComplementary: [0, 150, 210],
  analogous: [0, 50, 310],
  triadic: [0, 120, 240],
  floating: [],
};

/** Generate the linked colour dots from a new primary colour. */
export function colorsForHarmony(primary: string, harmony: GradientHarmony, current: readonly string[] = []): string[] {
  const normalized = normalizeThemeColor(primary) ?? DEFAULT_APPEARANCE.colors[0]!;
  if (harmony === "floating") {
    const rest = current.slice(1, 3).map(normalizeThemeColor).filter((color): color is string => color !== null);
    return [normalized, ...rest];
  }
  const base = hexToHsl(normalized);
  return HARMONY_OFFSETS[harmony].map((offset) => hslToHex({ ...base, h: (base.h + offset) % 360 }));
}

function translucent(color: string, strength: number): string {
  return `color-mix(in srgb, ${color} ${Math.round(strength * 100)}%, transparent)`;
}

/** The exact CSS paint used by both the live window and Settings' preview. */
export function appearanceGradient(appearance: AppearanceSettings, opacityScale = 1): string {
  if (!appearance.gradientEnabled) return "none";
  const colors = appearance.colors.slice(0, 3);
  const strength = (0.18 + appearance.intensity * 0.72) * Math.min(1, Math.max(0, opacityScale));
  const painted = colors.map((color) => translucent(color, strength));
  if (appearance.blend === "linear") {
    const stops = painted.map((color, index) => `${color} ${Math.round((index / Math.max(1, painted.length - 1)) * 100)}%`);
    return `linear-gradient(${appearance.angle}deg, ${stops.join(", ")})`;
  }
  if (appearance.blend === "radial") {
    return painted
      .map((color, index) => {
        const positions = ["18% 18%", "82% 24%", "48% 88%"];
        return `radial-gradient(circle at ${positions[index]}, ${color} 0%, transparent 68%)`;
      })
      .join(", ");
  }
  const first = painted[0]!;
  const second = painted[1] ?? first;
  const third = painted[2] ?? second;
  return [
    `radial-gradient(circle at 84% 14%, ${third} 0%, transparent 58%)`,
    `radial-gradient(circle at 12% 88%, ${second} 0%, transparent 58%)`,
    `linear-gradient(${appearance.angle}deg, ${first}, ${translucent(second, strength * 0.72)} 55%, ${translucent(third, strength * 0.5)})`,
  ].join(", ");
}
