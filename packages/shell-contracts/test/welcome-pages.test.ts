/**
 * The welcome pages as pure builders (docs/web-browser-design.md §14). What
 * matters here is the three parameters that let two very different hosts draw
 * the same documents: the desktop, which serves them from `pistachio://` with
 * its own font and assets, and the cloud-browser host, which has none of that
 * and renders them into `data:` tabs.
 *
 * The desktop's own output is pinned byte for byte against pre-lift fixtures
 * in `apps/desktop/test/welcome-pages.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE } from "../src/appearance.js";
import { WELCOME_TABS } from "../src/onboarding.js";
import { DEFAULT_SHORTCUTS } from "../src/shortcuts.js";
import {
  DESKTOP_WELCOME_FONT_SRC,
  welcomeDocumentHtml,
  welcomeLessonHtml,
  welcomeLessons,
  welcomeLink,
  welcomeOverviewHtml,
  welcomeTabFor,
  WELCOME_VIDEOS,
  type WelcomePageContext,
} from "../src/welcome-pages.js";

const desktop: WelcomePageContext = {
  name: "Claudius Meyer",
  appearance: DEFAULT_APPEARANCE,
  shortcuts: DEFAULT_SHORTCUTS,
  platform: "darwin",
  systemDark: false,
};

/** What the cloud-browser host passes: no protocol, so no font and no assets. */
const hosted: WelcomePageContext = { ...desktop, platform: "other", assetBase: null, fontSrc: null };

describe("welcome pages", () => {
  it("greets the person by their first name, and neutrally when there is none", () => {
    expect(welcomeOverviewHtml(desktop)).toContain("Let's settle in, Claudius.");
    expect(welcomeOverviewHtml({ ...desktop, name: "" })).toContain(">Let's settle in.<br>");
  });

  it("writes the person's own shortcut bindings into the lessons", () => {
    const mac = welcomeLessons(desktop);
    const other = welcomeLessons({ ...desktop, platform: "other" });
    expect(mac[0]?.tryIt).toContain("⌘");
    expect(other[0]?.tryIt).toContain("Ctrl");
  });

  it("links the lessons at their own addresses, and at another base when a host serves them elsewhere", () => {
    const overview = welcomeOverviewHtml(desktop);
    for (const tab of WELCOME_TABS.slice(1)) expect(overview).toContain(`href="${tab.url}"`);
    expect(welcomeLink(WELCOME_TABS[1]!, "https://app.example/")).toBe("https://app.example/learn/agent");
    expect(welcomeOverviewHtml({ ...desktop, linkBase: "https://app.example/" })).toContain(
      'href="https://app.example/learn/agent"',
    );
  });

  it("resolves an address back to the tab it names", () => {
    expect(welcomeTabFor("pistachio://welcome/")?.id).toBe("overview");
    expect(welcomeTabFor("pistachio://welcome")?.id).toBe("overview");
    expect(welcomeTabFor(" pistachio://learn/memory ")?.id).toBe("memory");
    expect(welcomeTabFor("pistachio://learn/nothing")).toBeNull();
    expect(welcomeTabFor("https://app.example/learn/agent", "https://app.example/")?.id).toBe("agent");
  });

  it("drops the @font-face and names a system stack where there is nothing to serve a font from", () => {
    const served = welcomeOverviewHtml(desktop);
    expect(served).toContain(`src: url("${DESKTOP_WELCOME_FONT_SRC}")`);
    expect(served).toContain('font: 15px/1.55 "Geist Welcome"');
    const bare = welcomeOverviewHtml(hosted);
    expect(bare).not.toContain("@font-face");
    expect(bare).not.toContain("Geist Welcome");
    expect(bare).toContain("font: 15px/1.55 -apple-system,");
  });

  it("plays a hosted clip on both surfaces and draws the placeholder where there is no source", () => {
    // The landing page's clips are absolute, so they play wherever the page
    // is drawn; `assetBase` is only what a bare file name resolves against.
    expect(welcomeOverviewHtml(desktop)).toContain('src="https://www.pistachio.run/video/usecase-appearance.mp4"');
    expect(welcomeOverviewHtml(hosted)).toContain('src="https://www.pistachio.run/video/usecase-appearance.mp4"');
    // The memory lesson has no clip yet: the "coming soon" card, on both.
    expect(WELCOME_VIDEOS.memory.src).toBeNull();
    expect(welcomeLessonHtml(WELCOME_TABS[3]!, hosted)).toContain('data-testid="welcome-video-slot"');
    expect(welcomeLessonHtml(WELCOME_TABS[3]!, desktop)).toContain('data-testid="welcome-video-slot"');
  });

  it("renders each welcome tab's own document, titled as the tab is", () => {
    for (const tab of WELCOME_TABS) {
      const html = welcomeDocumentHtml(tab.id, hosted);
      // Escaped, of course: "Spaces, favorites & split view".
      expect(html).toContain(`<title>${tab.title.replace(/&/gu, "&amp;")}</title>`);
      expect(html).toContain("<!doctype html>");
    }
  });

  it("emits both palettes for a system scheme and one for a chosen scheme", () => {
    const system = welcomeOverviewHtml({ ...desktop, appearance: { ...DEFAULT_APPEARANCE, scheme: "system" } });
    expect(system).toContain("@media (prefers-color-scheme: dark)");
    const dark = welcomeOverviewHtml({ ...desktop, appearance: { ...DEFAULT_APPEARANCE, scheme: "dark" } });
    expect(dark).not.toContain("prefers-color-scheme: dark");
    expect(dark).toContain("color-scheme: dark");
  });
});
