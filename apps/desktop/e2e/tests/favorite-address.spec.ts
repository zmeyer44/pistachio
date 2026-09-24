import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";

const FAVORITE_URL = "pistachio://demo/invoices";
const ELSEWHERE_URL = "pistachio://demo/vendors/atlas-medical";
const ELSEWHERE_AGAIN_URL = "pistachio://demo/invoices?from-day-tab";

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", suffix),
  ].find(
    (candidate) =>
      candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

async function openAlone(shell: Page, url: string): Promise<void> {
  await shell.evaluate(async (target) => {
    const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
    const before = await api.getSnapshot();
    await api.createTab(target);
    for (const tab of before.tabs) await api.closeTab(tab.id);
  }, url);
}

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

/** Right-click a row and pick a menu item by name. */
async function pick(shell: Page, target: ReturnType<Page["locator"]>, item: string | RegExp): Promise<void> {
  await target.click({ button: "right" });
  const menu = shell.getByTestId("context-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: item }).click();
  await expect(menu).toHaveCount(0);
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

test("an address entered over a favorite opens a new tab; the favorite keeps its page", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-favorite-address-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" }, general: { consoleOpenOnLaunch: false } }),
  );

  const app: ElectronApplication = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    await openAlone(shell, FAVORITE_URL);
    const sidebar = shell.getByTestId("sidebar-chrome");
    await expect(sidebar).toBeVisible();

    // Make the only tab a favorite: its tile is live, bound to this page.
    const dayTab = sidebar.getByTestId("sidebar-tab-list").getByTestId("human-tab").first();
    await pick(shell, dayTab, "Add to favorites");
    const favorite = sidebar.getByTestId("favorite-tile");
    await expect(favorite).toHaveCount(1);
    await expect(favorite).toHaveAttribute("data-live", "");
    await expect.poll(async () => (await tabsInShell(shell)).tabs[0]?.anchorId).not.toBeNull();
    const favoriteTabId = (await tabsInShell(shell)).tabs[0]?.id;
    if (favoriteTabId === undefined) throw new Error("the favorite's tab is missing");

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
  } finally {
    await app.close();
  }
});
