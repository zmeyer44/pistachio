import { describe, expect, it } from "vitest";
import { HOME_PAGE_TITLE, HOME_PAGE_URL, homePlaceholderHtml } from "../src/home.js";
import { NOTES_PAGE_FAVICON, NOTES_PAGE_TITLE, NOTES_PAGE_URL, noteUrl } from "../src/notes.js";
import { BRIEF_PAGE_TITLE, BRIEF_PAGE_URL, briefUrl } from "../src/reports.js";
import { BRIEF_PAGE_FAVICON, isShellPageUrl, shellPageOf, shellPagePlaceholderHtml } from "../src/shell-pages.js";
import { isAllowedNavigation } from "../src/url.js";

describe("shell-drawn pages", () => {
  it("names the home page and the daily brief, today's and a dated one", () => {
    expect(shellPageOf(HOME_PAGE_URL)).toBe("home");
    expect(shellPageOf("pistachio://home")).toBe("home");
    expect(shellPageOf(BRIEF_PAGE_URL)).toBe("brief");
    expect(shellPageOf("pistachio://brief")).toBe("brief");
    expect(shellPageOf("  PISTACHIO://brief/ ")).toBe("brief");
    expect(shellPageOf(briefUrl("2026-09-21"))).toBe("brief");
  });

  it("names the notes library and one note", () => {
    expect(shellPageOf(NOTES_PAGE_URL)).toBe("notes");
    expect(shellPageOf("pistachio://notes")).toBe("notes");
    expect(shellPageOf("  PISTACHIO://notes/ ")).toBe("notes");
    expect(shellPageOf(noteUrl("0a1b2c3d4e5f"))).toBe("notes");
  });

  it("are addresses a tab may hold", () => {
    expect(isAllowedNavigation(BRIEF_PAGE_URL)).toBe(true);
    expect(isAllowedNavigation(briefUrl("2026-09-21"))).toBe(true);
    expect(isAllowedNavigation(NOTES_PAGE_URL)).toBe(true);
    expect(isAllowedNavigation(noteUrl("0a1b2c3d4e5f"))).toBe(true);
  });

  it("names nothing a host draws — other app pages, malformed briefs, the web", () => {
    for (const other of [
      "pistachio://welcome/",
      "pistachio://artifacts",
      "pistachio://brief/yesterday",
      "pistachio://brief/2026-09-21/extra",
      "pistachio://brief/?date=2026-09-21",
      "pistachio://brief/#top",
      "pistachio://notes/not-an-id",
      "pistachio://notes/0A1B2C3D4E5F",
      "pistachio://notes/0a1b2c3d4e5f/extra",
      "pistachio://notes/?q=pie",
      "https://brief/",
      "https://example.com/pistachio://brief/",
      "about:blank",
      "",
    ]) {
      expect(shellPageOf(other), other).toBeNull();
      expect(isShellPageUrl(other), other).toBe(false);
      expect(shellPagePlaceholderHtml(other), other).toBeNull();
    }
  });

  it("serves home its own placeholder, unchanged", () => {
    expect(shellPagePlaceholderHtml(HOME_PAGE_URL)).toBe(homePlaceholderHtml());
    expect(shellPagePlaceholderHtml(HOME_PAGE_URL)).toContain(`<title>${HOME_PAGE_TITLE}</title>`);
  });

  it("serves the brief a placeholder that names the tab and loads nothing", () => {
    for (const url of [BRIEF_PAGE_URL, briefUrl("2026-09-21")]) {
      const html = shellPagePlaceholderHtml(url) ?? "";
      expect(html).toContain(`<title>${BRIEF_PAGE_TITLE}</title>`);
      expect(html).toContain(BRIEF_PAGE_FAVICON);
      expect(html).toContain("default-src 'none'");
      expect(html).not.toMatch(/<script/iu);
    }
  });

  it("serves notes the same placeholder, with its own title and glyph", () => {
    for (const url of [NOTES_PAGE_URL, noteUrl("0a1b2c3d4e5f")]) {
      const html = shellPagePlaceholderHtml(url) ?? "";
      // The tab is renamed to the note's own title through `setTabTitle`
      // once the editor has it; the placeholder only has to name the page.
      expect(html).toContain(`<title>${NOTES_PAGE_TITLE}</title>`);
      expect(html).toContain(NOTES_PAGE_FAVICON);
      expect(html).toContain("default-src 'none'");
      expect(html).not.toMatch(/<script/iu);
    }
  });
});
