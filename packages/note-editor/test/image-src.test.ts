/**
 * What the Image prompt takes (docs/notes.md §5): a web address, as typed
 * or with its scheme supplied, and nothing that is not one.
 */

import { describe, expect, it } from "vitest";
import { safeImageSrc } from "../src/image-src";
import { normalizeHref } from "../src/LinkPopover";

describe("safeImageSrc", () => {
  it("takes http and https addresses as they are", () => {
    expect(safeImageSrc("https://example.com/a.png")).toBe("https://example.com/a.png");
    expect(safeImageSrc("http://example.com/a.png?size=2")).toBe("http://example.com/a.png?size=2");
    expect(safeImageSrc("  https://example.com/a%20b.png  ")).toBe("https://example.com/a%20b.png");
  });

  it("supplies https to a bare domain", () => {
    expect(safeImageSrc("example.com/a.png")).toBe("https://example.com/a.png");
    expect(safeImageSrc("//cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
  });

  it("refuses what is not a picture on the web", () => {
    expect(safeImageSrc("")).toBeNull();
    expect(safeImageSrc("   ")).toBeNull();
    expect(safeImageSrc("data:image/png;base64,AAAA")).toBeNull();
    expect(safeImageSrc("file:///Users/me/a.png")).toBeNull();
    expect(safeImageSrc("javascript:alert(1)")).toBeNull();
    expect(safeImageSrc("note-blob:0123456789abcdef01234567")).toBeNull();
    expect(safeImageSrc("just words")).toBeNull();
  });
});

describe("normalizeHref", () => {
  it("adds https:// to a bare domain and leaves other schemes, anchors and paths alone", () => {
    expect(normalizeHref("example.com")).toBe("https://example.com");
    expect(normalizeHref("https://example.com/x")).toBe("https://example.com/x");
    expect(normalizeHref("mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(normalizeHref("#top")).toBe("#top");
    expect(normalizeHref("/docs")).toBe("/docs");
    expect(normalizeHref("  ")).toBe("");
  });
});
