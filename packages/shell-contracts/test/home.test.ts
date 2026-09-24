import { describe, expect, it } from "vitest";
import { HOME_PAGE_FAVICON, HOME_PAGE_TITLE, HOME_PAGE_URL, homePlaceholderHtml, isHomeUrl } from "../src/home.js";
import { isAllowedNavigation, normalizeNavigation } from "../src/url.js";

describe("the home page address", () => {
  it("is an address a tab may hold, and the one an empty address lands on", () => {
    expect(isAllowedNavigation(HOME_PAGE_URL)).toBe(true);
    expect(normalizeNavigation("")).toBe(HOME_PAGE_URL);
  });

  it("answers for both spellings a person or a standard scheme writes", () => {
    expect(isHomeUrl("pistachio://home/")).toBe(true);
    expect(isHomeUrl("pistachio://home")).toBe(true);
    expect(isHomeUrl("  PISTACHIO://home/ ")).toBe(true);
  });

  it("names nothing else — not another app page, not a lookalike on the web", () => {
    for (const other of [
      "pistachio://welcome/",
      "pistachio://home/settings",
      "pistachio://home/?q=1",
      "pistachio://home/#top",
      "https://home/",
      "https://example.com/pistachio://home/",
      "about:blank",
      "",
    ]) {
      expect(isHomeUrl(other), other).toBe(false);
    }
  });

  it("serves a placeholder that names the tab and loads nothing", () => {
    const html = homePlaceholderHtml();
    expect(html).toContain(`<title>${HOME_PAGE_TITLE}</title>`);
    expect(html).toContain(HOME_PAGE_FAVICON);
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script/iu);
  });
});
