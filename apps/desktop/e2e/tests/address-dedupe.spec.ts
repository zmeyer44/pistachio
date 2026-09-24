import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";

const FAVORITE_URL = "pistachio://demo/invoices";
const ELSEWHERE_URL = "pistachio://demo/vendors/atlas-medical";

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

/**
 * One row per place (packages/shell-ui/src/lib/destination.ts): a page that
 * is open in a tab, kept as a favorite, and in the recents is ONE result in
 * the typed face, shown as the best way to get there — the open tab.
 */
test("a page that is a tab, a favorite and a recent is listed once in the address bar", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-address-dedupe-"));
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
    const dayTab = sidebar.getByTestId("sidebar-tab-list").getByTestId("human-tab").first();
    await pick(shell, dayTab, "Add to favorites");
    await expect(sidebar.getByTestId("favorite-tile")).toHaveCount(1);
    await expect.poll(async () => (await tabsInShell(shell)).tabs[0]?.anchorId).not.toBeNull();

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
    await shell.screenshot({ path: "e2e/screenshots/address-dedupe.png" });
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
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});
