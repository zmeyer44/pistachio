/**
 * What an extension hands the shell to draw (docs/primitives.md §4): a
 * **theme** — a backdrop for the desk and an accent colour, for every space
 * or for one — and a **mark** on a space's tile. Both are values, never
 * views: the extension names a place the shell offers and says what goes
 * there; main keeps it, the shell draws it, labelled as the extension's, and
 * the person removes it. Nothing of the extension's runs to keep it there.
 *
 * Pure — the shapes, their checks and the contrast rule — so the runtime,
 * main and the tests share them.
 */

import { z } from "zod";

/** `#0b6e4f`: six hex digits. */
export const THEME_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const color = z.string().regex(THEME_COLOR_PATTERN, "a colour like #0b6e4f (six hex digits)");

/** The picture files a backdrop may be: a file of the extension's own folder, drawn as an image (an SVG's scripts never run). */
export const THEME_IMAGE_TYPES = [".png", ".jpg", ".jpeg", ".webp", ".svg"] as const;
/** The largest picture a backdrop may be, and the largest SVG. */
export const THEME_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const THEME_SVG_MAX_BYTES = 512 * 1024;
/** How far the shell's own ground may be laid over a picture (`dim`): never so far that it is gone. */
export const THEME_DIM_MAX = 0.8;

const imagePath = z
  .string()
  .min(1)
  .max(200)
  .refine((path) => !path.startsWith("/") && !path.split(/[\\/]/).includes("..") && !path.includes("\0"), { message: "a path inside the extension's folder, like art/field.svg" })
  .refine((path) => (THEME_IMAGE_TYPES as readonly string[]).some((type) => path.toLowerCase().endsWith(type)), { message: `a picture: ${THEME_IMAGE_TYPES.join(", ")}` });

/**
 * What lies behind a space's windows. A flat colour; a gradient of two to four colours at an angle (degrees, 0 from
 * the bottom up, as CSS has it; 180 when left out); or a picture from the extension's folder — `fit` it to `cover`
 * the desk (the default), `contain` in it, or `tile`, and `dim` it toward the shell's own ground (0–0.8) so windows
 * stand out on it in light and dark alike.
 */
export const backdropSchema = z.union([
  z.object({ color }).strict(),
  z.object({ gradient: z.object({ colors: z.array(color).min(2).max(4), angle: z.number().min(0).max(360).optional() }).strict() }).strict(),
  z.object({ image: imagePath, fit: z.enum(["cover", "contain", "tile"]).optional(), dim: z.number().min(0).max(THEME_DIM_MAX).optional() }).strict(),
]);

/** The colour tokens an extension may set. One for now: the accent the shell's own surfaces are tinted with and its focus ring drawn in. */
export const themeColorsSchema = z.object({ accent: color.optional() }).strict();

/**
 * A theme, whole: `set` replaces what the extension had there. `spaceId` names one space the person gave it; left
 * out, every space. A space's own theme is the one drawn there, over one for every space.
 */
export const themeSchema = z.object({ backdrop: backdropSchema.nullable().optional(), colors: themeColorsSchema.optional(), spaceId: z.string().min(1).max(128).optional() }).strict();

export type ThemeBackdrop = z.infer<typeof backdropSchema>;
export type ThemeInput = z.infer<typeof themeSchema>;

export const MARK_TONES = ["neutral", "green", "amber", "red", "blue"] as const;
export type MarkTone = (typeof MARK_TONES)[number];

/** A glyph is one or two characters as a person counts them: a letter, a digit, an emoji. */
export function isMarkGlyph(value: string): boolean {
  if (value.length === 0 || value.length > 16 || /\s/.test(value)) return false;
  try {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length <= 2;
  } catch {
    return [...value].length <= 2;
  }
}

/**
 * A small mark on a space's tile: a `glyph` (one or two characters; a dot when left out) in a `tone`, and a `label`
 * that says what it means — the tile's tooltip reads "<extension>: <label>", and a screen reader says it.
 */
export const markSchema = z
  .object({
    glyph: z.string().refine(isMarkGlyph, { message: "one or two characters: a letter, a digit, an emoji" }).optional(),
    tone: z.enum(MARK_TONES).optional(),
    label: z.string().min(1).max(60),
  })
  .strict();

export type SpaceMarkInput = z.infer<typeof markSchema>;

/* ------------------------------- contrast ------------------------------- */

/** WCAG relative luminance of `#rrggbb`, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const channel = (at: number): number => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast of two colours, 1 (the same) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** The shell's two grounds, near enough: what an accent has to show against whichever scheme the person is in. */
export const THEME_LIGHT_GROUND = "#fafaf7";
export const THEME_DARK_GROUND = "#212325";
/** The least an accent may stand out from each ground. */
export const THEME_ACCENT_CONTRAST = 2;

/**
 * Why an accent is refused, or null: the shell draws its focus ring and its marks in the accent, on a light ground
 * or a dark one as the person has it — so it must show on both. A sentence the author can act on.
 */
export function accentRefusal(accent: string): string | null {
  const onLight = contrastRatio(accent, THEME_LIGHT_GROUND);
  const onDark = contrastRatio(accent, THEME_DARK_GROUND);
  const said = (ratio: number): string => ratio.toFixed(1);
  if (onLight < THEME_ACCENT_CONTRAST) return `the accent ${accent} is too light: ${said(onLight)}:1 against Pistachio's light ground, and it needs ${String(THEME_ACCENT_CONTRAST)}:1 against both the light and the dark one — choose a deeper colour`;
  if (onDark < THEME_ACCENT_CONTRAST) return `the accent ${accent} is too dark: ${said(onDark)}:1 against Pistachio's dark ground, and it needs ${String(THEME_ACCENT_CONTRAST)}:1 against both the light and the dark one — choose a brighter colour`;
  return null;
}
