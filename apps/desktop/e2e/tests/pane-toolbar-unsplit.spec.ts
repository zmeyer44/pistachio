import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { SURFACE_GUTTER } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/pane-toolbar-unsplit");

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", executableSuffix),
    resolve(
      process.cwd(),
      "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron",
      executableSuffix,
    ),
  ];
  return candidates.find(
    (candidate) =>
      candidate !== undefined &&
      existsSync(candidate) &&
      existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

async function captureShell(app: ElectronApplication, filename: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return (await window.capturePage()).toPNG().toString("base64");
  });
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(join(screenshotDirectory, filename), Buffer.from(png, "base64"));
}

async function expectSingleFullWidthPane(shell: Page): Promise<void> {
  await expect(shell.getByTestId("secondary-pane")).toHaveCount(0);
  const surface = await shell.getByTestId("browser-surface").boundingBox();
  const primary = await shell.getByTestId("primary-pane").boundingBox();
  if (surface === null || primary === null) throw new Error("browser surface geometry is unavailable");
  expect(primary.width).toBeCloseTo(surface.width - SURFACE_GUTTER, 0);
}

/**
 * The pane toolbar, revealed the Playwright way: main cannot read the OS
 * pointer here, so the trigger strip's own pointer move stands. The trigger
 * only exists while the row is hidden — a still-revealed row from an earlier
 * reveal, or a row mid-hide, must not strand the locator — so each attempt
 * re-reads the state and the whole exchange retries until the row is up.
 */
async function revealPaneToolbar(shell: Page): Promise<void> {
  await expect(async () => {
    const trigger = shell.getByTestId("pane-toolbar-trigger");
    if ((await trigger.count()) > 0) await trigger.dispatchEvent("pointermove");
    await expect(shell.getByTestId("pane-toolbar")).not.toHaveAttribute("data-hidden", "", { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  // Let the row's slide-in (and the surface's padding transition under it)
  // finish so captures and clicks meet the row at rest.
  await shell.getByTestId("browser-surface").evaluate(async (surface) => {
    await Promise.all(surface.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined)));
  });
}

/**
 * Click a button in the pane toolbar. With no readable OS pointer, any
 * scheduled leave-check hides the row again (getCursorPoint answers null),
 * possibly between a reveal and the click's own stability wait — so reveal
 * and click travel together, and the pair retries until the click lands.
 */
async function clickPaneToolbarButton(shell: Page, button: Locator): Promise<void> {
  await expect(async () => {
    const trigger = shell.getByTestId("pane-toolbar-trigger");
    if ((await trigger.count()) > 0) await trigger.dispatchEvent("pointermove");
    await button.click({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

test("the pane toolbar's unsplit button removes a pane from the split without closing its tab", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-pane-toolbar-unsplit-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" } }),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");

    const tabIds = await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      await api.createTab("pistachio://demo/invoices?tab=second");
      return (await api.getSnapshot()).tabs.map((tab) => tab.id);
    });
    const [secondaryId, primaryId] = tabIds;
    if (secondaryId === undefined || primaryId === undefined) throw new Error("two tabs were not created");

    // Removing the unfocused pane keeps the focused one as the lone page.
    await shell.evaluate(
      (tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.splitWith(tabId, "right"),
      secondaryId,
    );
    await expect(shell.getByTestId("secondary-pane")).toBeVisible();
    await revealPaneToolbar(shell);
    const secondaryCluster = shell.locator(`[data-testid="pane-toolbar-cluster"][data-tab-id="${secondaryId}"]`);
    await expect(secondaryCluster.getByTestId("pane-toolbar-unsplit")).toBeVisible();
    await captureShell(app, "01-toolbar-over-split.png");
    await clickPaneToolbarButton(shell, secondaryCluster.getByTestId("pane-toolbar-unsplit"));
    await expectSingleFullWidthPane(shell);
    // A lone pane offers no unsplit button.
    await expect(shell.getByTestId("pane-toolbar-unsplit")).toHaveCount(0);
    await expect
      .poll(() =>
        shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot()),
      )
      .toMatchObject({
        activeTabId: primaryId,
        splitMode: "single",
        splitGroups: [],
        tabs: expect.arrayContaining([
          expect.objectContaining({ id: secondaryId }),
          expect.objectContaining({ id: primaryId }),
        ]),
      });
    await expect(shell.getByTestId("sidebar-tab-list").getByTestId("human-tab")).toHaveCount(2);
    await captureShell(app, "02-secondary-removed-tab-kept.png");

    // Removing the FOCUSED pane hands the surface to the survivor instead of
    // following the removed tab out of the split.
    await shell.evaluate(
      (tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.splitWith(tabId, "right"),
      secondaryId,
    );
    await expect(shell.getByTestId("secondary-pane")).toBeVisible();
    await revealPaneToolbar(shell);
    const primaryCluster = shell.locator(`[data-testid="pane-toolbar-cluster"][data-tab-id="${primaryId}"]`);
    await clickPaneToolbarButton(shell, primaryCluster.getByTestId("pane-toolbar-unsplit"));
    await expectSingleFullWidthPane(shell);
    await expect
      .poll(() =>
        shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot()),
      )
      .toMatchObject({
        activeTabId: secondaryId,
        splitMode: "single",
        splitGroups: [],
        tabs: expect.arrayContaining([
          expect.objectContaining({ id: secondaryId }),
          expect.objectContaining({ id: primaryId }),
        ]),
      });
    await expect(shell.getByTestId("sidebar-tab-list").getByTestId("human-tab")).toHaveCount(2);
    await captureShell(app, "03-focused-pane-removed-survivor-active.png");
  } finally {
    await app.close();
  }
});
