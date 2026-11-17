/**
 * What an extension hands the shell to draw (../src/theme.ts; docs/primitives.md §4): a backdrop, a theme and a
 * mark as values main can check without the extension running, and the contrast rule an accent is held to.
 */

import { describe, expect, it } from "vitest";
import {
  MARK_TONES,
  THEME_ACCENT_CONTRAST,
  THEME_DARK_GROUND,
  THEME_DIM_MAX,
  THEME_IMAGE_TYPES,
  THEME_LIGHT_GROUND,
  accentRefusal,
  backdropSchema,
  contrastRatio,
  isMarkGlyph,
  markSchema,
  relativeLuminance,
  themeSchema,
} from "../src/theme.js";

const ok = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean => schema.safeParse(value).success;

describe("a backdrop", () => {
  it("is a colour, a gradient of two to four, or a picture of the extension's own folder", () => {
    expect(ok(backdropSchema, { color: "#0b3d2e" })).toBe(true);
    expect(ok(backdropSchema, { color: "#0B3D2E" })).toBe(true);
    expect(ok(backdropSchema, { gradient: { colors: ["#0b3d2e", "#145c43"] } })).toBe(true);
    expect(ok(backdropSchema, { gradient: { colors: ["#0b3d2e", "#145c43", "#1f8a4c", "#2aa860"], angle: 160 } })).toBe(true);
    expect(ok(backdropSchema, { image: "field.svg" })).toBe(true);
    expect(ok(backdropSchema, { image: "art/Field.PNG", fit: "contain", dim: 0.2 })).toBe(true);
    for (const type of THEME_IMAGE_TYPES) expect(ok(backdropSchema, { image: `art/field${type}`, fit: "tile", dim: THEME_DIM_MAX }), type).toBe(true);
  });

  it("refuses a colour that is not six hex digits", () => {
    for (const color of ["green", "#0b3", "#0b3d2e80", "0b3d2e", "rgb(11, 61, 46)", "#0b3d2g", ""]) expect(ok(backdropSchema, { color }), color).toBe(false);
    expect(ok(backdropSchema, { gradient: { colors: ["#0b3d2e", "turf"] } })).toBe(false);
  });

  it("refuses a gradient of one colour, or of five, and an angle off the circle", () => {
    expect(ok(backdropSchema, { gradient: { colors: ["#0b3d2e"] } })).toBe(false);
    expect(ok(backdropSchema, { gradient: { colors: ["#000000", "#111111", "#222222", "#333333", "#444444"] } })).toBe(false);
    expect(ok(backdropSchema, { gradient: { colors: ["#0b3d2e", "#145c43"], angle: 361 } })).toBe(false);
    expect(ok(backdropSchema, { gradient: { colors: ["#0b3d2e", "#145c43"], angle: -1 } })).toBe(false);
  });

  it("refuses a picture that is not in the folder, or not a picture", () => {
    for (const image of ["../field.svg", "art/../../field.svg", "/Users/me/field.svg", "art\\..\\field.svg", "field.gif", "field", "field.svg.exe", "", "a\0.svg"]) {
      expect(ok(backdropSchema, { image }), JSON.stringify(image)).toBe(false);
    }
    expect(ok(backdropSchema, { image: `${"a".repeat(200)}.svg` })).toBe(false);
  });

  it("refuses a picture dimmed past what leaves it there, a fit it does not know, and keys it does not know", () => {
    expect(ok(backdropSchema, { image: "field.svg", dim: THEME_DIM_MAX + 0.01 })).toBe(false);
    expect(ok(backdropSchema, { image: "field.svg", dim: -0.1 })).toBe(false);
    expect(ok(backdropSchema, { image: "field.svg", fit: "stretch" })).toBe(false);
    expect(ok(backdropSchema, { image: "field.svg", blur: 4 })).toBe(false);
    expect(ok(backdropSchema, { color: "#0b3d2e", dim: 0.2 })).toBe(false);
    expect(ok(backdropSchema, { color: "#0b3d2e", image: "field.svg" })).toBe(false);
    expect(ok(backdropSchema, { gradient: { colors: ["#0b3d2e", "#145c43"], stops: [0, 1] } })).toBe(false);
    expect(ok(backdropSchema, {})).toBe(false);
    expect(ok(backdropSchema, { url: "https://example.com/field.jpg" })).toBe(false);
  });
});

describe("a theme", () => {
  it("is a backdrop, an accent, or both — for every space, or for one", () => {
    expect(ok(themeSchema, { spaceId: "football", backdrop: { image: "field.svg", dim: 0.2 }, colors: { accent: "#1f8a4c" } })).toBe(true);
    expect(ok(themeSchema, { backdrop: { color: "#0b3d2e" } })).toBe(true);
    expect(ok(themeSchema, { colors: { accent: "#1f8a4c" } })).toBe(true);
    // No backdrop, said either way; and nothing at all, which main takes as a clear.
    expect(ok(themeSchema, { backdrop: null })).toBe(true);
    expect(ok(themeSchema, { colors: {} })).toBe(true);
    expect(ok(themeSchema, {})).toBe(true);
  });

  it("refuses a token it does not have, a space that is no id, and keys it does not know", () => {
    expect(ok(themeSchema, { colors: { accent: "green" } })).toBe(false);
    expect(ok(themeSchema, { colors: { accent: "#1f8a4c", ground: "#000000" } })).toBe(false);
    expect(ok(themeSchema, { spaceId: "" })).toBe(false);
    expect(ok(themeSchema, { spaceId: "s".repeat(129) })).toBe(false);
    expect(ok(themeSchema, { backdrop: { color: "#0b3d2e" }, scope: "all" })).toBe(false);
    expect(ok(themeSchema, { accent: "#1f8a4c" })).toBe(false);
  });
});

describe("a mark", () => {
  it("counts a glyph as a person does: one or two characters, whatever they are made of", () => {
    for (const glyph of ["A", "12", "🏈", "🇺🇸", "👨‍👩‍👧‍👦", "é", "3+"]) expect(isMarkGlyph(glyph), glyph).toBe(true);
    for (const glyph of ["abc", "", " ", "a b", "🏈🏈🏈", "\n"]) expect(isMarkGlyph(glyph), JSON.stringify(glyph)).toBe(false);
  });

  it("is a label, with a glyph and a tone when it wants them", () => {
    expect(ok(markSchema, { label: "Games on" })).toBe(true);
    expect(ok(markSchema, { glyph: "🏈", tone: "green", label: "Games on" })).toBe(true);
    for (const tone of MARK_TONES) expect(ok(markSchema, { tone, label: "x" }), tone).toBe(true);
  });

  it("refuses one that says nothing, says too much, or is drawn its own way", () => {
    expect(ok(markSchema, { glyph: "🏈" })).toBe(false);
    expect(ok(markSchema, { label: "" })).toBe(false);
    expect(ok(markSchema, { label: "x".repeat(61) })).toBe(false);
    expect(ok(markSchema, { glyph: "GAME", label: "Games on" })).toBe(false);
    expect(ok(markSchema, { tone: "purple", label: "Games on" })).toBe(false);
    expect(ok(markSchema, { label: "Games on", color: "#1f8a4c" })).toBe(false);
    expect(ok(markSchema, { label: "Games on", icon: "ball.svg" })).toBe(false);
  });
});

describe("the contrast rule", () => {
  it("measures as WCAG does", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 10);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 10);
    // The same either way round, and 1 for a colour against itself.
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 10);
    expect(contrastRatio("#1f8a4c", "#1f8a4c")).toBe(1);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  it("passes an accent that shows on the light ground and on the dark one", () => {
    for (const accent of ["#1f8a4c", "#2563eb", "#d9480f", "#8b5cf6", "#808080"]) expect(accentRefusal(accent), accent).toBeNull();
    expect(contrastRatio("#1f8a4c", THEME_LIGHT_GROUND)).toBeGreaterThanOrEqual(THEME_ACCENT_CONTRAST);
    expect(contrastRatio("#1f8a4c", THEME_DARK_GROUND)).toBeGreaterThanOrEqual(THEME_ACCENT_CONTRAST);
  });

  it("refuses one too light, in a sentence with the ratio and which way to go", () => {
    const said = accentRefusal("#ffff66");
    expect(said).toContain("#ffff66");
    expect(said).toContain("too light");
    expect(said).toMatch(/\d\.\d:1 against Pistachio's light ground/);
    expect(said).toContain("2:1 against both");
    expect(said).toContain("deeper");
    expect(accentRefusal("#ffffff")).toContain("too light");
  });

  it("refuses one too dark, the same way", () => {
    const said = accentRefusal("#0a0a14");
    expect(said).toContain("#0a0a14");
    expect(said).toContain("too dark");
    expect(said).toMatch(/\d\.\d:1 against Pistachio's dark ground/);
    expect(said).toContain("brighter");
    expect(accentRefusal("#000000")).toContain("too dark");
  });
});
