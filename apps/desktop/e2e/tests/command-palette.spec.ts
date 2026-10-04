import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { pageFirst, shellReady } from "./windows";
import { launchApp } from "./app";
import { activeUrl } from "./pages-harness";

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

/**
 * Open the overlay and wait for main's palette inventory — which carries
 * the clipboard's verdict — to have been answered. A row that should show
 * is waited for as usual; where a row should NOT show, `settle` gives the
 * answer a beat to be drawn, so a missing row means "not offered", never
 * "not yet".
 */
async function openBrowsing(shell: Page, settle = false): Promise<void> {
  await shell.keyboard.press("Meta+L");
  await expect(shell.getByTestId("address-input")).toBeFocused();
  await shell.evaluate(() =>
    (window as unknown as { pistachio: PistachioApi }).pistachio.getCommandPalette(),
  );
  if (settle) await shell.waitForTimeout(250);
}

// One window: the palette's commands first, then Paste and Go over a fresh tab.
test.describe.serial("the address overlay", { tag: ["@tabs", "@address"] }, () => {
  test.describe.configure({ timeout: 60_000 });
  let app: ElectronApplication;
  let shell: Page;

  test.beforeAll(async () => {
    ({ app } = await launchApp({ settings: pageFirst(), name: "command-palette" }));
    shell = await shellReady(app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("the address overlay fuzzy-ranks commands, tabs, Spaces, settings, and recovery actions", { tag: ["@smoke"] }, async () => {
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
  });

  test("the address overlay offers the clipboard's URL first, as Paste and Go", async () => {
    // A plain day tab in front: the pinned page the test above left would
    // send an entered address to a new tab of its own.
    const start = "pistachio://demo/invoices?paste-start";
    await shell.evaluate(
      (url) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(url),
      start,
    );
    await expect.poll(() => activeUrl(shell)).toBe(start);

    // This drives the machine's real clipboard; put back what it held.
    const previous = await app.evaluate(({ clipboard }) => clipboard.readText());
    try {
      const target = "pistachio://demo/invoices?paste-and-go";

      // A copied address is the first row, the first stop on ↓, and ↵ goes there.
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), target);
      await openBrowsing(shell);
      const row = shell.getByTestId("paste-and-go");
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute("data-index", "0");
      await expect(row).toContainText("Paste and Go");
      await expect(row).toContainText("demo/invoices?paste-and-go");
      await shell.keyboard.press("ArrowDown");
      await expect(row).toHaveClass(/bg-alpha-200/);
      await shell.keyboard.press("Enter");
      await expect(shell.getByTestId("url-bar")).toHaveCount(0);
      await expect.poll(() => activeUrl(shell)).toBe(target);

      // Already on that page: nothing to paste and go to.
      await openBrowsing(shell, true);
      await expect(shell.getByTestId("paste-and-go")).toHaveCount(0);
      await shell.keyboard.press("Escape");

      // Copied prose is not an address, and never becomes a search.
      await app.evaluate(({ clipboard }) => clipboard.writeText("invoice policy notes"));
      await openBrowsing(shell, true);
      await expect(shell.getByTestId("paste-and-go")).toHaveCount(0);
      await shell.keyboard.press("Escape");

      // Typing hides the row: the typed address is the suggestion then.
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), "pistachio://demo/invoices?typed-over");
      await openBrowsing(shell);
      await expect(shell.getByTestId("paste-and-go")).toBeVisible();
      await shell.getByTestId("address-input").fill("keyboard shortcuts");
      await expect(shell.getByTestId("paste-and-go")).toHaveCount(0);
      await shell.keyboard.press("Escape");
    } finally {
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), previous);
    }
  });
});
