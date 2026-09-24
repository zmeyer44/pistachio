import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import { pageFirst, shellPage } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/site-info");

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", executableSuffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", executableSuffix),
  ];
  return candidates.find(
    (candidate) =>
      candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
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

/** Native tab views main is showing — none while a shell overlay has the chrome raised. */
function visibleTabViews(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return window.contentView.children.filter((child) => {
      if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) return false;
      const url = (child as WebContentsView).webContents.getURL();
      return !Object.values(hashes).some((hash) => url.endsWith(hash));
    }).length;
  }, CHROME_VIEW_HASHES);
}

test("the active tab's site-info button opens a popover that flips permissions and sound", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-site-info-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst({ layout: { mode: "top", sidebar: "pinned" } })));

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    await expect(shell.getByTestId("human-tab")).toBeVisible();
    await expect.poll(() => visibleTabViews(app)).toBe(1);

    // The button leads the active tab — the strip's omnibox — and only it.
    const button = shell.getByTestId("site-info-button");
    await expect(button).toHaveCount(1);
    await expect(shell.getByTestId("human-tab").filter({ has: button })).toHaveCount(1);
    await button.click();
    const popover = shell.getByTestId("site-info-popover");
    await expect(popover).toBeVisible();
    // Named for the site it describes: the start page's host leads the card.
    await expect(shell.getByRole("dialog", { name: /^Site information for \S+/ })).toBeVisible();
    await expect(popover.getByRole("heading", { level: 2 })).not.toHaveText("This page");
    await expect(popover.getByTestId("site-info-connection")).toContainText("Connection is secure");
    // A shell overlay: main has raised the chrome over the page for the duration.
    await expect.poll(() => visibleTabViews(app)).toBe(0);
    await captureShell(app, "01-popover.png");

    // Microphone: off and "asks" by default; ON allows, and the reset pill appears.
    const microphone = popover.getByTestId("site-info-permission-microphone");
    await expect(microphone).toContainText("Asks before use");
    await expect(popover.getByTestId("site-info-reset")).toHaveCount(0);
    await popover.getByRole("switch", { name: "Microphone" }).click();
    await expect(microphone).toContainText("Allowed");
    await expect(popover.getByRole("switch", { name: "Microphone" })).toHaveAttribute("aria-checked", "true");
    await expect(popover.getByTestId("site-info-reset")).toBeVisible();
    // OFF blocks rather than returning to "ask".
    await popover.getByRole("switch", { name: "Microphone" }).click();
    await expect(microphone).toContainText("Blocked");
    await captureShell(app, "02-microphone-blocked.png");

    // Sound is this tab's mute.
    const sound = popover.getByTestId("site-info-sound");
    await expect(sound).toContainText("Allowed in this tab");
    await popover.getByRole("switch", { name: "Sound" }).click();
    await expect(sound).toContainText("Muted in this tab");
    await popover.getByRole("switch", { name: "Sound" }).click();
    await expect(sound).toContainText("Allowed in this tab");

    // Reset returns every decision to "ask" and retires the pill.
    await popover.getByTestId("site-info-reset").click();
    await expect(microphone).toContainText("Asks before use");
    await expect(popover.getByTestId("site-info-reset")).toHaveCount(0);

    // The full page is one row away; taking it closes the popover.
    await popover.getByTestId("site-info-site-controls").click();
    await expect(popover).toHaveCount(0);
    const controls = shell.getByTestId("site-controls");
    await expect(controls).toBeVisible();
    await expect(controls.getByLabel("Microphone permission")).toBeVisible();
    await shell.keyboard.press("Escape");
    await expect(controls).toHaveCount(0);
    await expect.poll(() => visibleTabViews(app)).toBe(1);

    // Escape closes the popover and hands the page back.
    await button.click();
    await expect(popover).toBeVisible();
    await shell.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => visibleTabViews(app)).toBe(1);
  } finally {
    await app.close();
  }
});

test("in the sidebar layout the button sits in the pane toolbar beside bookmark and opens the same popover", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-site-info-sidebar-"));
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
    await expect(sidebar.getByTestId("sidebar-address")).toBeVisible();
    await expect.poll(() => visibleTabViews(app)).toBe(1);
    // Not in the column: the button rides with the page's own controls.
    await expect(sidebar.getByTestId("site-info-button")).toHaveCount(0);

    // The pane toolbar comes out over the card; the button is on it, just before bookmark.
    await expect(async () => {
      const trigger = shell.getByTestId("pane-toolbar-trigger");
      if ((await trigger.count()) > 0) await trigger.dispatchEvent("pointermove");
      await expect(shell.getByTestId("pane-toolbar")).not.toHaveAttribute("data-hidden", "", { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    const toolbar = shell.getByTestId("pane-toolbar");
    const button = toolbar.getByTestId("site-info-button");
    await expect(button).toBeVisible();
    await expect(shell.getByTestId("site-info-button")).toHaveCount(1);
    const buttonBox = await button.boundingBox();
    const bookmarkBox = await toolbar.getByRole("button", { name: /^Bookmark / }).boundingBox();
    if (buttonBox === null || bookmarkBox === null) throw new Error("pane toolbar is not laid out");
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(bookmarkBox.x + 1);
    expect(bookmarkBox.x - (buttonBox.x + buttonBox.width)).toBeLessThan(12);

    // Opening the popover keeps the row out — it is the row's own — and raises the chrome.
    await button.click();
    const popover = shell.getByTestId("site-info-popover");
    await expect(popover).toBeVisible();
    await expect(popover.getByTestId("site-info-permission-camera")).toContainText("Asks before use");
    await expect.poll(() => visibleTabViews(app)).toBe(0);
    await expect(toolbar).not.toHaveAttribute("data-hidden", "");
    // Under the button, hanging from its RIGHT edge: the button is at the
    // row's far end, so the card grows toward the page, not off the window.
    const popoverBox = await popover.boundingBox();
    if (popoverBox === null) throw new Error("popover is not laid out");
    expect(popoverBox.y).toBeGreaterThanOrEqual(buttonBox.y + buttonBox.height);
    expect(Math.abs(popoverBox.x + popoverBox.width - (buttonBox.x + buttonBox.width))).toBeLessThanOrEqual(8);
    const viewport = shell.viewportSize();
    if (viewport !== null) expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(viewport.width);
    await captureShell(app, "03-sidebar.png");

    // A press on the page (its still, while the popover is up) closes it.
    await shell.mouse.click(popoverBox.x - 40, popoverBox.y + 200);
    await expect(popover).toHaveCount(0);
    await expect.poll(() => visibleTabViews(app)).toBe(1);
  } finally {
    await app.close();
  }
});
