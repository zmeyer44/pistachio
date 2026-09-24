import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { SURFACE_GUTTER } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/split-close");

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
  // BrowserSurface's gutter, on the trailing edge only in this (sidebar)
  // layout — the sidebar's column owns the leading one. The lone pane fills
  // whatever the gutter leaves.
  expect(primary.width).toBeCloseTo(surface.width - SURFACE_GUTTER, 0);
}

test("closing either pane of a split promotes the survivor instead of filling the vacancy", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-split-close-"));
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

    // Keep a third tab open so the regression cannot pass by having no
    // unrelated tab available to fill the closed pane.
    const tabIds = await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      await api.createTab("pistachio://demo/invoices?tab=second");
      await api.createTab("pistachio://demo/invoices?tab=third");
      return (await api.getSnapshot()).tabs.map((tab) => tab.id);
    });
    const [unrelatedId, secondaryId, primaryId] = tabIds;
    if (unrelatedId === undefined || secondaryId === undefined || primaryId === undefined) {
      throw new Error("three tabs were not created");
    }
    await expect(shell.getByTestId("sidebar-tab-list").getByTestId("human-tab")).toHaveCount(3);

    // Closing the secondary pane leaves the primary as the sole full-width
    // page; the unrelated first tab remains open but is not pulled in.
    await shell.evaluate(
      (tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.splitWith(tabId, "right"),
      secondaryId,
    );
    let split = shell.getByRole("group", { name: /^Split view:/ });
    await expect(split).toBeVisible();
    await expect(shell.getByTestId("secondary-pane")).toBeVisible();
    await captureShell(app, "01-secondary-ready-to-close.png");
    const secondaryHalf = split.getByTestId("human-tab").last();
    await secondaryHalf.hover();
    await secondaryHalf.getByRole("button", { name: /^Close Northstar/ }).click();
    await expect(split).toHaveCount(0);
    await expectSingleFullWidthPane(shell);
    await expect
      .poll(() =>
        shell.evaluate(
          () => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot(),
        ),
      )
      .toMatchObject({
        activeTabId: primaryId,
        secondaryTabId: null,
        splitMode: "single",
        tabs: expect.arrayContaining([expect.objectContaining({ id: unrelatedId }), expect.objectContaining({ id: primaryId })]),
      });
    await captureShell(app, "02-primary-promoted-full-width.png");

    // Recreate the pair in the opposite order. Closing the primary now
    // promotes the secondary with the same single-pane result.
    await shell.evaluate(
      (tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.splitWith(tabId, "right"),
      unrelatedId,
    );
    split = shell.getByRole("group", { name: /^Split view:/ });
    await expect(split).toBeVisible();
    await captureShell(app, "03-primary-ready-to-close.png");
    const primaryHalf = split.getByTestId("human-tab").first();
    await primaryHalf.hover();
    await primaryHalf.getByRole("button", { name: /^Close Northstar/ }).click();
    await expect(split).toHaveCount(0);
    await expectSingleFullWidthPane(shell);
    await expect
      .poll(() =>
        shell.evaluate(
          () => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot(),
        ),
      )
      .toMatchObject({
        activeTabId: unrelatedId,
        secondaryTabId: null,
        splitMode: "single",
        tabs: [expect.objectContaining({ id: unrelatedId })],
      });
    await captureShell(app, "04-secondary-promoted-full-width.png");
  } finally {
    await app.close();
  }
});
