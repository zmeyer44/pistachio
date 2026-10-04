import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellReady } from "./windows";
import { launchApp } from "./app";
import { captureShell, openAlone, pick } from "./pages-harness";

const FAVORITE_URL = "pistachio://demo/invoices";
const ELSEWHERE_URL = "pistachio://demo/vendors/atlas-medical";
const ELSEWHERE_AGAIN_URL = "pistachio://demo/invoices?from-day-tab";

function tabsInShell(shell: Page): Promise<{ active: string | null; tabs: Array<{ id: string; url: string; anchorId: string | null }> }> {
  return shell.evaluate(async () => {
    const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
    const snapshot = await api.getSnapshot();
    return {
      active: snapshot.activeTabId,
      tabs: snapshot.tabs.map((tab) => ({ id: tab.id, url: tab.url, anchorId: tab.anchorId })),
    };
  });
}

/** ⌘L, type an address, ↵ — the way a person changes the current page. */
async function enterAddress(shell: Page, url: string): Promise<void> {
  await shell.keyboard.press("Meta+L");
  const input = shell.getByTestId("address-input");
  await expect(input).toBeFocused();
  await input.fill(url);
  await input.press("Enter");
  await expect(shell.getByTestId("url-bar")).toHaveCount(0);
}

/** The demo page as the only tab, made a favorite: its tile is live, bound to this page. */
async function favoriteAlone(shell: Page): Promise<string> {
  // A favorite left by the test before is taken off first, so the grid starts empty.
  const sidebar = shell.getByTestId("sidebar-chrome");
  await expect(sidebar).toBeVisible();
  const leftover = sidebar.getByTestId("favorite-tile");
  if ((await leftover.count()) > 0) {
    await pick(shell, leftover.first(), "Remove from favorites");
    await expect(leftover).toHaveCount(0);
  }
  await openAlone(shell, FAVORITE_URL);
  await expect.poll(async () => (await tabsInShell(shell)).tabs.map((tab) => tab.url)).toEqual([FAVORITE_URL]);
  const dayTab = sidebar.getByTestId("sidebar-tab-list").getByTestId("human-tab").first();
  await pick(shell, dayTab, "Add to favorites");
  const favorite = sidebar.getByTestId("favorite-tile");
  await expect(favorite).toHaveCount(1);
  await expect(favorite).toHaveAttribute("data-live", "");
  await expect.poll(async () => (await tabsInShell(shell)).tabs[0]?.anchorId).not.toBeNull();
  const favoriteTabId = (await tabsInShell(shell)).tabs[0]?.id;
  if (favoriteTabId === undefined) throw new Error("the favorite's tab is missing");
  return favoriteTabId;
}

// One window: one row per place, then the address entered over a favorite
// (that order, so the second's day-tab address is not yet among the recents
// the first counts).
test.describe.serial("addresses and favorites", { tag: ["@sidebar", "@address"] }, () => {
  test.describe.configure({ timeout: 45_000 });
  let app: ElectronApplication;
  let shell: Page;

  test.beforeAll(async () => {
    ({ app } = await launchApp({
      settings: { layout: { sidebar: "pinned" }, general: { consoleOpenOnLaunch: false } },
      name: "favorite-address",
    }));
    shell = await shellReady(app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  /**
   * One row per place (packages/shell-ui/src/lib/destination.ts): a page that
   * is open in a tab, kept as a favorite, and in the recents is ONE result in
   * the typed face, shown as the best way to get there — the open tab.
   */
  test("a page that is a tab, a favorite and a recent is listed once in the address bar", async () => {
    await favoriteAlone(shell);

    // Search from ANOTHER tab: the tab being edited is never its own result.
    await shell.evaluate(
      (url) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(url),
      ELSEWHERE_URL,
    );
    await expect.poll(async () => (await tabsInShell(shell)).tabs.length).toBe(2);

    await shell.keyboard.press("Meta+L");
    const input = shell.getByTestId("address-input");
    await expect(input).toBeFocused();
    await input.fill("invoices");
    const results = shell.getByTestId("command-results");
    await expect(results).toBeVisible();
    const samePlace = results.locator("[data-result-kind]").filter({ hasText: "demo/invoices" });
    await captureShell(app, "address-dedupe.png");
    await expect(samePlace).toHaveCount(1);
    // …and it is the open tab: ↵ switches to it rather than loading it again.
    await expect(samePlace).toHaveAttribute("data-result-kind", "tab");
    await samePlace.click();
    await expect
      .poll(async () => {
        const { active, tabs } = await tabsInShell(shell);
        return { count: tabs.length, activeUrl: tabs.find((tab) => tab.id === active)?.url };
      })
      .toEqual({ count: 2, activeUrl: FAVORITE_URL });
  });

  test("an address entered over a favorite opens a new tab; the favorite keeps its page", async () => {
    const favoriteTabId = await favoriteAlone(shell);
    const favorite = shell.getByTestId("sidebar-chrome").getByTestId("favorite-tile");

    // Changing the address from the favorite opens the new page as a fresh
    // day tab and lands there, leaving the favorite on its own page.
    await enterAddress(shell, ELSEWHERE_URL);
    await expect.poll(async () => (await tabsInShell(shell)).tabs.length).toBe(2);
    await expect
      .poll(async () => {
        const { active, tabs } = await tabsInShell(shell);
        const opened = tabs.find((tab) => tab.id !== favoriteTabId);
        return {
          activeIsNew: active !== null && active === opened?.id,
          openedUrl: opened?.url,
          openedAnchor: opened?.anchorId,
          favoriteUrl: tabs.find((tab) => tab.id === favoriteTabId)?.url,
        };
      })
      .toEqual({ activeIsNew: true, openedUrl: ELSEWHERE_URL, openedAnchor: null, favoriteUrl: FAVORITE_URL });
    await expect(favorite).toHaveAttribute("data-live", "");

    // A plain day tab still navigates in place — no third tab appears.
    await enterAddress(shell, ELSEWHERE_AGAIN_URL);
    await expect
      .poll(async () => {
        const { active, tabs } = await tabsInShell(shell);
        return { count: tabs.length, activeUrl: tabs.find((tab) => tab.id === active)?.url };
      })
      .toEqual({ count: 2, activeUrl: ELSEWHERE_AGAIN_URL });
  });
});
