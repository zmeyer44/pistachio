/**
 * Which of a page's icon links is its app icon (src/main/app-icon.ts), for
 * the desk's dock.
 */

import { describe, expect, it } from "vitest";
import { iconSide, pickAppIcon, safeIconUrl } from "../src/main/app-icon";

const link = (rel: string, href: string, sizes = "", type = "") => ({ rel, href, sizes, type });

describe("a page's app icon", () => {
  it("prefers an apple-touch-icon, the largest of them, over any other icon", () => {
    expect(
      pickAppIcon([
        link("icon", "https://example.com/icon-512.png", "512x512", "image/png"),
        link("apple-touch-icon", "https://example.com/touch-120.png", "120x120"),
        link("apple-touch-icon", "https://example.com/touch-180.png", "180x180"),
      ]),
    ).toBe("https://example.com/touch-180.png");
    expect(pickAppIcon([link("apple-touch-icon-precomposed", "https://example.com/touch.png")])).toBe("https://example.com/touch.png");
  });

  it("falls back to the largest declared icon of 96px or more, an SVG counting as any size", () => {
    expect(
      pickAppIcon([
        link("icon", "https://example.com/favicon-32.png", "32x32"),
        link("icon", "https://example.com/icon-192.png", "192x192"),
        link("shortcut icon", "https://example.com/favicon.ico"),
      ]),
    ).toBe("https://example.com/icon-192.png");
    expect(pickAppIcon([link("icon", "https://example.com/mark.svg", "", "image/svg+xml")])).toBe("https://example.com/mark.svg");
  });

  it("has none when the page declares only favicons, or nothing it can load", () => {
    expect(pickAppIcon([link("icon", "https://example.com/favicon-32.png", "32x32"), link("stylesheet", "https://example.com/a.css")])).toBeNull();
    expect(pickAppIcon([link("apple-touch-icon", "javascript:alert(1)")])).toBeNull();
    expect(pickAppIcon([link("apple-touch-icon", `data:image/png;base64,${"A".repeat(10)}`)])).toBeNull();
    expect(pickAppIcon("not a list")).toBeNull();
    expect(pickAppIcon([null, 3, { rel: 1 }])).toBeNull();
  });

  it("reads a declared size, and keeps only http(s) addresses", () => {
    expect(iconSide("16x16 32x32 180x180")).toBe(180);
    expect(iconSide("any")).toBe(Number.POSITIVE_INFINITY);
    expect(iconSide("")).toBe(0);
    expect(safeIconUrl("https://example.com/a.png")).toBe("https://example.com/a.png");
    expect(safeIconUrl("file:///etc/passwd")).toBeNull();
    expect(safeIconUrl(`https://example.com/${"a".repeat(3000)}`)).toBeNull();
  });
});
