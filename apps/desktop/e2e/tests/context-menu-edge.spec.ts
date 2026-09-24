import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { pageFirst, shellPage } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/context-menu-edge");

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", suffix),
  ].find((candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")));
}

async function captureWindow(app: ElectronApplication, filename: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return (await window.capturePage()).toPNG().toString("base64");
  });
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(join(screenshotDirectory, filename), Buffer.from(png, "base64"));
}

test("a sidebar context menu keeps its pointer anchor above the native page", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-context-menu-edge-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst({ layout: { mode: "sidebar", sidebar: "pinned" } })));
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });

  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    const sidebar = shell.getByTestId("sidebar-chrome");
    const tab = sidebar.getByTestId("human-tab").first();
    await expect(tab).toBeVisible();
    await captureWindow(app, "01-sidebar-ready.png");

    const tabBox = await tab.boundingBox();
    if (tabBox === null) throw new Error("tab geometry is unavailable");
    // Preserve the pointer anchor while raising the shell above the native
    // page, so the card can extend naturally beyond the sidebar.
    await tab.click({ button: "right" });
    const menu = shell.getByTestId("context-menu");
    await expect(menu).toBeVisible();
    await expect(menu).toHaveCSS("opacity", "1");
    const sidebarBox = await sidebar.boundingBox();
    if (sidebarBox === null) throw new Error("sidebar geometry is unavailable");
    const menuBox = await menu.boundingBox();
    if (menuBox === null) throw new Error("context-menu geometry is unavailable");
    const anchoredLeft = await menu.evaluate((element) => Number.parseFloat((element as HTMLElement).style.left));
    expect(anchoredLeft).toBeCloseTo(tabBox.x + tabBox.width / 2, 0);
    expect(menuBox.x + menuBox.width).toBeGreaterThan(sidebarBox.x + sidebarBox.width + 40);
    await expect(shell.locator("img.pane-still")).toHaveCount(1);
    await expect(menu.getByRole("menuitem", { name: "Close tab" })).toBeVisible();
    await captureWindow(app, "02-menu-over-page.png");

    // Dismissal lowers the shell and restores the live native page.
    await shell.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(shell.locator("img.pane-still")).toHaveCount(0);
    await captureWindow(app, "03-menu-dismissed.png");
  } finally {
    await app.close();
  }
});
