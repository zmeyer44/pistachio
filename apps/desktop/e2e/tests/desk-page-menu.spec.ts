/**
 * A desk window's frame: its buttons named in tooltips under them, which a
 * live page under them gives way to (a cover, as the Bar's are); and its
 * page on its frame's menu (components/desk/page-entries.tsx):
 * what the pane toolbar offers over a page off the desk — back, forward,
 * reload, reader view, bookmark, pin, and the site's information — from the
 * window's ⋯, a desk having no pane toolbar and its rail no back, forward or
 * reload. Which entries a page gets is the toolbar's rule; this proves they
 * reach the window's tab through the real app, and that the site's card hangs
 * from the ⋯.
 */

import { createServer, type Server } from "node:http";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { isReaderUrl } from "@pistachio/shell-contracts/reader";
import { api, box, center, createGroup, launchDesk, openGroupDesk, openTabs, screenshots, selectTab, settled, snapshot, windowSelector } from "./desk-harness";

const capture = screenshots("desk-page-menu");

const PARAGRAPHS = [
  "The harbour wakes before the town does. By five the first boats are already turning past the breakwater, their lamps still lit against a sky that has not decided what colour it will be, and the gulls follow them out as if the whole arrangement were their idea.",
  "Nobody here talks about the weather as small talk. It decides whether the nets go out, whether the ferry runs, whether the school bus makes it over the causeway before the tide covers the road, and so people read it the way other towns read the news.",
  "The market opens at seven in the old fish hall, a long stone building with a slate roof that has been patched so many times it is more patch than roof. Inside, the stalls are arranged by a logic older than anyone who works them.",
  "In winter the visitors thin out to a handful of walkers and the occasional painter, and the cafe on the quay shortens its hours without telling anyone. The regulars know to come before two; everyone else learns by finding the chairs already up on the tables.",
  "What keeps the place going is not the scenery, though there is plenty of it, but a stubborn habit of showing up. The boats go out, the hall opens, the ferry runs when it can, and the town carries on as it has for three hundred years.",
];

function articleHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Morning on the Harbour</title></head><body>
    <header><nav><a href="/">Home</a></nav></header>
    <main><article><h1>Morning on the Harbour</h1><p class="byline">By A. Writer</p>
    ${PARAGRAPHS.map((text) => `<p>${text}</p>`).join("\n")}
    </article></main></body></html>`;
}

test.describe.serial("a desk window's frame: its buttons' tooltips, and its page from its ⋯", { tag: ["@desk", "@site", "@pages"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let server: Server;
  let first: string;
  let article: string;
  let tabId: string;
  const win = () => shell.locator(windowSelector(tabId));
  const tabUrl = async (): Promise<string> => (await snapshot(shell)).tabs.find((tab) => tab.id === tabId)?.url ?? "";
  /** An entry of the menu that is up. */
  const entry = (testId: string) => shell.locator(`[data-testid="context-menu"] [data-testid="${testId}"]`);
  const openMenu = async (): Promise<void> => {
    await win().getByTestId("desk-window-more").click();
    await expect(shell.getByTestId("context-menu")).toBeVisible();
  };
  const choose = async (testId: string): Promise<void> => {
    await openMenu();
    await entry(testId).click();
    await expect(shell.getByTestId("context-menu")).toHaveCount(0);
  };

  test.beforeAll(async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(request.url === "/article" ? articleHtml() : `<!doctype html><title>Contents</title><h1>Contents</h1>`);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
    first = `${origin}/contents`;
    article = `${origin}/article`;
    ({ app, shell } = await launchDesk({ name: "page-menu" }));
    [tabId] = (await openTabs(shell, [first])) as [string];
    // A page with history: back to the contents from the article.
    await shell.evaluate(({ id, url }) => (window as unknown as { pistachio: PistachioApi }).pistachio.navigate(id, url), { id: tabId, url: article });
    await expect.poll(tabUrl).toBe(article);
    await createGroup(shell, "page-menu", [tabId], "Reading", "blue");
    await selectTab(shell, tabId);
    await openGroupDesk(shell, "page-menu");
    await expect(shell.getByTestId("desk-surface")).toBeVisible();
    await expect(win()).toHaveCount(1);
    await settled(shell, app);
  });

  test.afterAll(async () => {
    await app?.close();
    server?.close();
  });

  test("the frame's buttons name themselves in tooltips under them, the page under one giving way to its still", async () => {
    // (The open one: the last is still fading out as its neighbour's comes up.)
    const tip = shell.locator('[data-testid="desk-window-tip"][data-shown][data-open]');
    const close = win().getByTestId("desk-close");
    const more = win().getByTestId("desk-window-more");
    await expect(win()).not.toHaveAttribute("data-drawn", "");
    await close.hover();
    await expect(tip).toHaveText("Close");
    // Under the button, over the window's own page: the page is its still while the tooltip is up.
    await expect(win()).toHaveAttribute("data-drawn", "");
    const button = await box(shell, `${windowSelector(tabId)} [data-testid="desk-close"]`);
    const placed = await box(shell, '[data-testid="desk-window-tip"][data-shown][data-open]');
    expect(placed.y).toBeGreaterThanOrEqual(button.y + button.height);
    await capture(app, shell, "00-tooltip.png");
    // Its neighbour's, at once.
    await more.hover();
    await expect(tip).toHaveText("More");

    // Pressed, the ⋯'s menu is up, and no tooltip is over it.
    await more.click();
    await expect(shell.getByTestId("context-menu")).toBeVisible();
    await expect(tip).toHaveCount(0);
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("context-menu")).toHaveCount(0);

    // Away from the buttons: the tooltip goes, and the page is live again.
    const page = center(await box(shell, `${windowSelector(tabId)} [data-testid="desk-window-page"]`));
    await shell.mouse.move(page.x, page.y);
    await expect(tip).toHaveCount(0);
    await expect(win()).not.toHaveAttribute("data-drawn", "");
  });

  test("back, forward and reload: the window's page goes where its history says", async () => {
    await openMenu();
    await expect(entry("desk-page-back")).toBeEnabled();
    await expect(entry("desk-page-forward")).toBeDisabled();
    await capture(app, shell, "01-menu.png");
    await entry("desk-page-back").click();
    await expect.poll(tabUrl).toBe(first);

    await openMenu();
    await expect(entry("desk-page-forward")).toBeEnabled();
    await entry("desk-page-forward").click();
    await expect.poll(tabUrl).toBe(article);

    await choose("desk-page-reload");
    await expect.poll(tabUrl).toBe(article);
    await expect(win()).toHaveCount(1);
  });

  test("reader view: the window's article stripped to its prose, and back to the page", async () => {
    await openMenu();
    await expect(entry("desk-page-reader")).toHaveText("Reader view");
    await entry("desk-page-reader").click();
    await expect.poll(async () => isReaderUrl(await tabUrl())).toBe(true);
    // Still the same window, now on the reader page.
    await expect(win()).toHaveCount(1);
    await settled(shell, app);
    await capture(app, shell, "02-reader.png");

    await openMenu();
    await expect(entry("desk-page-reader")).toHaveText("Hide reader");
    // The reader page is the app's: no bookmark of its own.
    await expect(entry("desk-page-bookmark")).toHaveCount(0);
    await entry("desk-page-reader").click();
    await expect.poll(tabUrl).toBe(article);
  });

  test("bookmark: kept from the menu, the menu then offers to let it go", async () => {
    const kept = (): Promise<string[]> => api(shell, async (pistachio) => (await pistachio.getBookmarks()).bookmarks.map((bookmark) => bookmark.url));
    await openMenu();
    await expect(entry("desk-page-bookmark")).toHaveText("Bookmark this page");
    await entry("desk-page-bookmark").click();
    await expect.poll(kept).toEqual([article]);

    // Read as the menu opens: what is true now.
    await openMenu();
    await expect(entry("desk-page-bookmark")).toHaveText("Remove bookmark");
    await entry("desk-page-bookmark").click();
    await expect.poll(kept).toEqual([]);
  });

  test("site information: the site's card hangs from the window's ⋯, and Escape puts it away", async () => {
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(tabId);
    await choose("desk-page-site-info");
    const card = shell.getByTestId("site-info-popover");
    await expect(card).toBeVisible();
    await expect(win().getByTestId("desk-window-more")).toHaveAttribute("aria-pressed", "true");
    // Under the ⋯, its trailing edge by the button's.
    const more = await box(shell, `${windowSelector(tabId)} [data-testid="desk-window-more"]`);
    // Visibility precedes the end of the card's entrance animation.
    await expect.poll(async () => (await box(shell, '[data-testid="site-info-popover"]')).y).toBeGreaterThanOrEqual(more.y + more.height);
    await expect.poll(async () => {
      const placed = await box(shell, '[data-testid="site-info-popover"]');
      return Math.abs(placed.x + placed.width - (more.x + more.width + 4));
    }).toBeLessThan(2);
    await expect(card).toContainText("127.0.0.1");
    await capture(app, shell, "03-site-info.png");

    await shell.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(win().getByTestId("desk-window-more")).toHaveAttribute("aria-pressed", "false");
  });

  test("site information stays on screen for a low frame and scrolls in a short viewport", async () => {
    // Shrink from the top so the frame sits low while the page stays on screen.
    const edge = center(await box(shell, `${windowSelector(tabId)} [data-desk-edge="n"]`));
    await shell.mouse.move(edge.x, edge.y);
    await shell.mouse.down();
    await shell.mouse.move(edge.x, edge.y + 400, { steps: 20 });
    await shell.mouse.up();
    await settled(shell, app);
    const more = await box(shell, `${windowSelector(tabId)} [data-testid="desk-window-more"]`);
    expect(more.y).toBeGreaterThan(450);
    await choose("desk-page-site-info");
    const card = shell.getByTestId("site-info-popover");
    const viewportHeight = await shell.evaluate(() => window.innerHeight);
    await expect.poll(async () => {
      const placed = await box(shell, '[data-testid="site-info-popover"]');
      return placed.y >= 0 && placed.y + placed.height <= viewportHeight;
    }).toBe(true);

    const original = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const size = window.getContentSize();
      const minimum = window.getMinimumSize();
      window.setMinimumSize(400, 300);
      window.setContentSize(1000, 440);
      return { size, minimum };
    });
    try {
      await expect.poll(() => card.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      await card.getByTestId("site-info-site-controls").scrollIntoViewIfNeeded();
      await expect(card.getByTestId("site-info-site-controls")).toBeInViewport({ ratio: 1 });
      await expect.poll(async () => {
        const placed = await box(shell, '[data-testid="site-info-popover"]');
        const height = await shell.evaluate(() => window.innerHeight);
        return placed.y >= 0 && placed.y + placed.height <= height;
      }).toBe(true);
    } finally {
      await shell.keyboard.press("Escape");
      await app.evaluate(({ BrowserWindow }, { size, minimum }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.setMinimumSize(minimum[0]!, minimum[1]!);
        window.setContentSize(size[0]!, size[1]!);
      }, original);
      await settled(shell, app);
    }
  });

  test("pin: the window's tab pinned on the shelf, and unpinned", async () => {
    const anchor = async (): Promise<string | null> => (await snapshot(shell)).tabs.find((tab) => tab.id === tabId)?.anchorId ?? null;
    const pins = async (): Promise<string[]> => (await snapshot(shell)).sidebar.entries.filter((item) => item.kind === "pin").map((item) => item.id);
    await openMenu();
    await expect(entry("desk-page-pin")).toHaveText("Pin tab");
    await entry("desk-page-pin").click();
    await expect.poll(anchor).not.toBeNull();
    expect(await pins()).toContain(await anchor());

    await openMenu();
    await expect(entry("desk-page-pin")).toHaveText("Unpin tab");
    await entry("desk-page-pin").click();
    await expect.poll(pins).toEqual([]);
  });
});
