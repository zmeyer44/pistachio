import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellReady } from "./windows";
import { launchApp } from "./app";
import { captureShell, clickPaneToolbarButton, expectSingleFullWidthPane, revealPaneToolbar, snapshot } from "./chrome-harness";

const FOLDER = "split-close";

function splitWith(shell: Page, tabId: string): Promise<void> {
  return shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.splitWith(id, "right"), tabId);
}

// One window, pinned: a pane leaves a split by the pane toolbar's unsplit
// button (its tab stays open), then by closing its tab (the survivor fills
// the surface). Either way no other tab is pulled in to fill the vacancy.
test.describe.serial("leaving a split", { tag: ["@sidebar", "@split"] }, () => {
  test.describe.configure({ timeout: 60_000 });
  let app: ElectronApplication;
  let shell: Page;

  test.beforeAll(async () => {
    ({ app } = await launchApp({ settings: { layout: { sidebar: "pinned" } }, name: "split-close" }));
    shell = await shellReady(app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("the pane toolbar's unsplit button removes a pane from the split without closing its tab", async () => {
    const tabIds = await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      await api.createTab("pistachio://demo/invoices?tab=second");
      return (await api.getSnapshot()).tabs.map((tab) => tab.id);
    });
    const [secondaryId, primaryId] = tabIds;
    if (secondaryId === undefined || primaryId === undefined) throw new Error("two tabs were not created");

    // Removing the unfocused pane keeps the focused one as the lone page.
    await splitWith(shell, secondaryId);
    await expect(shell.getByTestId("secondary-pane")).toBeVisible();
    await revealPaneToolbar(shell);
    const secondaryCluster = shell.locator(`[data-testid="pane-toolbar-cluster"][data-tab-id="${secondaryId}"]`);
    await expect(secondaryCluster.getByTestId("pane-toolbar-unsplit")).toBeVisible();
    await captureShell(app, FOLDER, "unsplit-01-toolbar-over-split.png");
    await clickPaneToolbarButton(shell, secondaryCluster.getByTestId("pane-toolbar-unsplit"));
    await expectSingleFullWidthPane(shell);
    // A lone pane offers no unsplit button.
    await expect(shell.getByTestId("pane-toolbar-unsplit")).toHaveCount(0);
    await expect
      .poll(() => snapshot(shell))
      .toMatchObject({
        activeTabId: primaryId,
        splitMode: "single",
        splitGroups: [],
        tabs: expect.arrayContaining([expect.objectContaining({ id: secondaryId }), expect.objectContaining({ id: primaryId })]),
      });
    await expect(shell.getByTestId("sidebar-tab-list").getByTestId("human-tab")).toHaveCount(2);
    await captureShell(app, FOLDER, "unsplit-02-secondary-removed-tab-kept.png");

    // Removing the FOCUSED pane hands the surface to the survivor instead of
    // following the removed tab out of the split.
    await splitWith(shell, secondaryId);
    await expect(shell.getByTestId("secondary-pane")).toBeVisible();
    await revealPaneToolbar(shell);
    const primaryCluster = shell.locator(`[data-testid="pane-toolbar-cluster"][data-tab-id="${primaryId}"]`);
    await clickPaneToolbarButton(shell, primaryCluster.getByTestId("pane-toolbar-unsplit"));
    await expectSingleFullWidthPane(shell);
    await expect
      .poll(() => snapshot(shell))
      .toMatchObject({
        activeTabId: secondaryId,
        splitMode: "single",
        splitGroups: [],
        tabs: expect.arrayContaining([expect.objectContaining({ id: secondaryId }), expect.objectContaining({ id: primaryId })]),
      });
    await expect(shell.getByTestId("sidebar-tab-list").getByTestId("human-tab")).toHaveCount(2);
    await captureShell(app, FOLDER, "unsplit-03-focused-pane-removed-survivor-active.png");
  });

  test("closing either pane of a split promotes the survivor instead of filling the vacancy", async () => {
    // Keep a third tab open so the regression cannot pass by having no
    // unrelated tab available to fill the closed pane.
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab("pistachio://demo/invoices?tab=third"));
    const [unrelatedId, secondaryId, primaryId] = (await snapshot(shell)).tabs.map((tab) => tab.id);
    if (unrelatedId === undefined || secondaryId === undefined || primaryId === undefined) {
      throw new Error("three tabs were not created");
    }
    await expect(shell.getByTestId("sidebar-tab-list").getByTestId("human-tab")).toHaveCount(3);

    // Closing the secondary pane leaves the primary as the sole full-width
    // page; the unrelated first tab remains open but is not pulled in.
    await splitWith(shell, secondaryId);
    let split = shell.getByRole("group", { name: /^Split view:/ });
    await expect(split).toBeVisible();
    await expect(shell.getByTestId("secondary-pane")).toBeVisible();
    await captureShell(app, FOLDER, "01-secondary-ready-to-close.png");
    const secondaryHalf = split.getByTestId("human-tab").last();
    await secondaryHalf.hover();
    await secondaryHalf.getByRole("button", { name: /^Close Northstar/ }).click();
    await expect(split).toHaveCount(0);
    await expectSingleFullWidthPane(shell);
    await expect
      .poll(() => snapshot(shell))
      .toMatchObject({
        activeTabId: primaryId,
        secondaryTabId: null,
        splitMode: "single",
        tabs: expect.arrayContaining([expect.objectContaining({ id: unrelatedId }), expect.objectContaining({ id: primaryId })]),
      });
    await captureShell(app, FOLDER, "02-primary-promoted-full-width.png");

    // Recreate the pair in the opposite order. Closing the primary now
    // promotes the secondary with the same single-pane result.
    await splitWith(shell, unrelatedId);
    split = shell.getByRole("group", { name: /^Split view:/ });
    await expect(split).toBeVisible();
    await captureShell(app, FOLDER, "03-primary-ready-to-close.png");
    const primaryHalf = split.getByTestId("human-tab").first();
    await primaryHalf.hover();
    await primaryHalf.getByRole("button", { name: /^Close Northstar/ }).click();
    await expect(split).toHaveCount(0);
    await expectSingleFullWidthPane(shell);
    await expect
      .poll(() => snapshot(shell))
      .toMatchObject({
        activeTabId: unrelatedId,
        secondaryTabId: null,
        splitMode: "single",
        tabs: [expect.objectContaining({ id: unrelatedId })],
      });
    await captureShell(app, FOLDER, "04-secondary-promoted-full-width.png");
  });
});
