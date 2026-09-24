import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { pageFirst, shellPage } from "./windows";

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(
      process.cwd(),
      "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron",
      suffix,
    ),
  ].find(
    (candidate) =>
      candidate !== undefined &&
      existsSync(candidate) &&
      existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

async function openPalette(shell: Page, query: string): Promise<void> {
  await shell.keyboard.press("Meta+L");
  const input = shell.getByTestId("address-input");
  await expect(input).toBeFocused();
  await input.fill(query);
}

function snapshot(shell: Page) {
  return shell.evaluate(() =>
    (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot(),
  );
}

test("the address overlay fuzzy-ranks commands, tabs, Spaces, settings, and recovery actions", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined)
    throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-command-palette-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst()));
  const app: ElectronApplication = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: {
      ...process.env,
      PISTACHIO_E2E: "1",
      PISTACHIO_USER_DATA: userData,
    },
  });

  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");

    // Settings sections participate in the same fuzzy inventory and an exact
    // section match beats the generic web-search row.
    await openPalette(shell, "keyboard shortcuts");
    const shortcuts = shell.locator(
      '[data-testid="command-result"][data-action-id="settings:shortcuts"]',
    );
    await expect(shortcuts).toHaveAttribute("data-index", "0");
    await shell.keyboard.press("Enter");
    await expect(
      shell.getByRole("heading", { name: "Keyboard shortcuts" }),
    ).toBeVisible();
    await shell.keyboard.press("Escape");

    const setup = await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      const initial = await api.getSnapshot();
      if (initial.activeTabId === null)
        throw new Error("active tab unavailable");
      const sourceUrl = "pistachio://demo/invoices?palette-source";
      await api.navigate(initial.activeTabId, sourceUrl);
      const fork = await api.forkSpace({
        name: "Research",
        purpose: "Investigate command palette routing",
        tabs: "active",
        includeShelf: true,
        includeSession: false,
      });
      await api.switchSpace(initial.activeSpaceId);
      return {
        sourceSpaceId: initial.activeSpaceId,
        targetSpaceId: fork.spaceId,
        sourceTabId: initial.activeTabId,
        sourceUrl,
      };
    });

    // Generated move commands recreate the tab in the destination's isolated
    // partition and follow it there.
    await openPalette(shell, "move current tab research");
    const move = shell.locator(
      `[data-testid="command-result"][data-action-id="space:move:${setup.targetSpaceId}"]`,
    );
    await expect(move).toHaveAttribute("data-index", "0");
    await move.click();
    await expect
      .poll(async () => {
        const current = await snapshot(shell);
        const active = current.tabs.find(
          (tab) => tab.id === current.activeTabId,
        );
        return {
          activeSpaceId: current.activeSpaceId,
          activeTabId: current.activeTabId,
          url: active?.url,
          anchorId: active?.anchorId,
        };
      })
      .toEqual({
        activeSpaceId: setup.targetSpaceId,
        activeTabId: setup.sourceTabId,
        url: setup.sourceUrl,
        anchorId: null,
      });

    // Existing chrome actions are executable results too. Pin the moved tab,
    // then clear every ordinary tab in this Space while retaining that page.
    await openPalette(shell, "pin tab");
    await shell
      .locator(
        '[data-testid="command-result"][data-action-id="chrome:togglePin"]',
      )
      .click();
    await expect
      .poll(async () => {
        const current = await snapshot(shell);
        return (
          current.tabs.find((tab) => tab.id === setup.sourceTabId)?.anchorId ??
          null
        );
      })
      .not.toBeNull();

    await openPalette(shell, "clear unpinned tabs");
    await shell
      .locator(
        '[data-testid="command-result"][data-action-id="tabs:clear-unpinned"]',
      )
      .click();
    await expect
      .poll(async () => {
        const current = await snapshot(shell);
        return current.tabs.map((tab) => ({
          id: tab.id,
          anchorId: tab.anchorId,
        }));
      })
      .toEqual([{ id: setup.sourceTabId, anchorId: expect.any(String) }]);

    // A tab in another Space is still searchable. Selecting it switches Space;
    // the dedicated new-tab flow's duplicate behavior is covered separately.
    await shell.evaluate((spaceId) => {
      return (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.switchSpace(spaceId);
    }, setup.sourceSpaceId);
    await openPalette(shell, "palette-source");
    const crossSpaceTab = shell.locator(
      `[data-testid="open-tab-result"][data-tab-id="${setup.sourceTabId}"]`,
    );
    await expect(crossSpaceTab).toBeVisible();
    await crossSpaceTab.click();
    await expect
      .poll(async () => (await snapshot(shell)).activeSpaceId)
      .toBe(setup.targetSpaceId);

    // Close and restore are palette-native actions. The restored page keeps
    // its shelf anchor because no other live tab owns it.
    await openPalette(shell, "close current tab");
    await shell
      .locator(
        '[data-testid="command-result"][data-action-id="tab:close-current"]',
      )
      .click();
    await expect
      .poll(async () =>
        (await snapshot(shell)).tabs.some(
          (tab) => tab.id === setup.sourceTabId,
        ),
      )
      .toBe(false);
    await openPalette(shell, "restore closed tab");
    const restore = shell.locator(
      '[data-testid="command-result"][data-action-id="tab:restore-closed"]',
    );
    await expect(restore).toHaveAttribute("data-index", "0");
    await restore.click();
    await expect
      .poll(async () => {
        const current = await snapshot(shell);
        const active = current.tabs.find(
          (tab) => tab.id === current.activeTabId,
        );
        return { url: active?.url, anchored: active?.anchorId !== null };
      })
      .toEqual({ url: setup.sourceUrl, anchored: true });
  } finally {
    await app.close();
  }
});
