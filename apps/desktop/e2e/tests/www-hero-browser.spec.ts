import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test, expect, type FrameLocator, type Page } from "@playwright/test";
import { availablePort, stopProcess, waitForHttp } from "./web-harness";

/**
 * The landing page's hero is the browser itself: the shell mounted over an
 * in-memory host inside a frame (apps/www/app/hero-browser,
 * apps/www/components/live-browser.tsx). Nothing behind it — no control, no
 * worker — so this spec boots `www` alone and walks what a visitor can do in
 * the window: switch tabs, open a favorite, type an address, follow a link
 * and come back, open the console and get an answer.
 *
 * Every assertion reads the shell's own chrome (the tab list, the address
 * field) or the demo pane's `data-url`, so a host that stopped publishing,
 * or a pane that stopped painting, fails here rather than in a screenshot.
 */

const SCREENSHOTS = "e2e/screenshots/www-hero-browser";

interface Site {
  url: string;
  child: ChildProcess;
  close(): Promise<void>;
}

/** `www` alone, as `next dev` on a port of its own with a private dist directory. */
async function startWww(): Promise<Site> {
  const port = await availablePort();
  const url = `http://localhost:${String(port)}`;
  const distDir = `.next-e2e-${randomUUID()}`;
  const dir = fileURLToPath(new URL("../../../www/", import.meta.url));
  const child = spawn("pnpm", ["--filter", "www", "exec", "next", "dev", "--webpack", "--port", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, PISTACHIO_NEXT_DIST_DIR: distDir },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    log += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    log += chunk.toString("utf8");
  });
  try {
    await waitForHttp(url, child);
  } catch (error) {
    await stopProcess(child);
    throw new Error(`${String(error)}\n${log}`);
  }
  return {
    url,
    child,
    close: async () => {
      await stopProcess(child);
      await rm(`${dir}${distDir}`, { recursive: true, force: true });
    },
  };
}

/** The shell inside the hero's frame, once it has painted its home page. */
async function openHero(page: Page, url: string): Promise<FrameLocator> {
  await page.goto(url);
  const frame = page.frameLocator('[data-testid="hero-browser-frame"]');
  // The store's first load has answered when the home page is up.
  await expect(frame.getByText("Good morning").or(frame.getByText("Good afternoon")).or(frame.getByText("Good evening"))).toBeVisible({ timeout: 30_000 });
  return frame;
}

/** The active pane's address, as the demo pane reports it. */
function activePage(frame: FrameLocator) {
  return frame.locator('[data-testid="demo-page"]');
}

test("the hero's browser works: tabs, favorites, addresses, links, console", async ({ page }) => {
  // A cold `next dev` compiles the site and the shell's chunk on first request.
  test.setTimeout(300_000);
  const site = await startWww();
  try {
    await page.setViewportSize({ width: 1440, height: 1200 });
    const frame = await openHero(page, site.url);
    const tabs = frame.getByTestId("sidebar-tab-list");

    // Seeded: three day tabs (the fourth open tab is the home page), six
    // favorites — X, YouTube, Google, Google Calendar, ChatGPT, Claude — and
    // the home page active.
    await expect(tabs.getByText("Pistachio - Wikipedia")).toBeVisible();
    await expect(tabs.getByText("GitHub", { exact: true })).toBeVisible();
    await expect(tabs.getByText("I let a browser agent run my errands for a week - YouTube")).toBeVisible();
    await expect(tabs.getByText("Home")).toBeVisible();
    const favorites = frame.getByTestId("favorites-grid").locator("img");
    await expect(favorites).toHaveCount(6);
    await expect(favorites.nth(0)).toHaveAttribute("src", "/img/favicons/x.png");
    await expect(favorites.nth(5)).toHaveAttribute("src", "/img/favicons/claude.png");
    await page.screenshot({ path: `${SCREENSHOTS}/01-home.png` });

    // A tab click paints that tab's page.
    await tabs.getByText("GitHub", { exact: true }).click();
    await expect(activePage(frame)).toHaveAttribute("data-url", "https://github.com/");
    await expect(frame.getByText("Top repositories")).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOTS}/02-tab.png` });

    // A favorite opens its page in a tab bound to the tile.
    await favorites.first().click();
    await expect(activePage(frame)).toHaveAttribute("data-url", "https://x.com/home");
    await expect(frame.getByText("What is happening?!")).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOTS}/03-favorite.png` });

    // An address typed into the bar navigates; the page and title follow.
    await frame.getByTestId("sidebar-address").click();
    const input = frame.getByTestId("address-input");
    await expect(input).toBeVisible();
    await input.fill("chatgpt.com");
    await input.press("Enter");
    await expect(activePage(frame)).toHaveAttribute("data-url", "https://chatgpt.com/");
    await expect(frame.getByText("ChatGPT can make mistakes.", { exact: false })).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOTS}/04-address.png` });

    // A link inside a page pushes history; back walks it.
    await frame.getByTestId("sidebar-address").click();
    await input.fill("youtube.com");
    await input.press("Enter");
    await expect(activePage(frame)).toHaveAttribute("data-url", "https://www.youtube.com/");
    await frame.getByText("Lo-fi beats for planning your quarter").first().click();
    await expect(activePage(frame)).toHaveAttribute("data-url", /youtube\.com\/watch\?v=/u);
    await expect(frame.getByText("Subscribe", { exact: true })).toBeVisible();
    await frame.getByRole("button", { name: /^back$/iu }).first().click();
    await expect(activePage(frame)).toHaveAttribute("data-url", "https://www.youtube.com/");
    await page.screenshot({ path: `${SCREENSHOTS}/05-back.png` });

    // Prose typed into the bar is a Google search, answered by the results page.
    await frame.getByTestId("sidebar-address").click();
    await input.fill("best cashew recipes");
    await input.press("Enter");
    await expect(activePage(frame)).toHaveAttribute("data-url", /google\.com\/search\?q=best/u);
    await expect(frame.getByText("results (0.31 seconds)", { exact: false })).toBeVisible();

    // The console opens (⌘I) and the host answers a message.
    await tabs.click({ position: { x: 100, y: 300 } });
    await page.keyboard.press("Meta+i");
    const ask = frame.getByPlaceholder(/Ask Pistachio/u);
    await expect(ask).toBeVisible();
    await ask.fill("Find me the cheapest nonstop to JFK on Oct 3");
    await ask.press("Enter");
    await expect(frame.getByText("download Pistachio and ask me again")).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOTS}/06-console.png` });

    // Closing a tab selects a neighbour and drops the row.
    await tabs.getByText("Pistachio - Wikipedia").click();
    await expect(activePage(frame)).toHaveAttribute("data-url", "https://en.wikipedia.org/wiki/Pistachio");
    await page.keyboard.press("Meta+w");
    await expect(tabs.getByText("Pistachio - Wikipedia")).toHaveCount(0);
  } finally {
    await site.close();
  }
});
