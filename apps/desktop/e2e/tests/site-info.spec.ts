import { expect, test, type ElectronApplication } from "@playwright/test";
import { pageFirst, shellReady } from "./windows";
import { launchApp } from "./app";
import { captureShell as captureWindow, revealPaneToolbar, visibleTabViews } from "./pages-harness";

function captureShell(app: ElectronApplication, filename: string): Promise<void> {
  return captureWindow(app, `site-info/${filename}`);
}

test("the site-info button sits in the pane toolbar beside bookmark and opens a popover that flips permissions and sound", { tag: ["@site", "@split"] }, async () => {
  const { app } = await launchApp({ settings: pageFirst({ layout: { sidebar: "pinned" } }), name: "site-info" });
  try {
    const shell = await shellReady(app);
    const sidebar = shell.getByTestId("sidebar-chrome");
    await expect(sidebar.getByTestId("sidebar-address")).toBeVisible();
    await expect.poll(() => visibleTabViews(app)).toBe(1);
    // Not in the column: the button rides with the page's own controls.
    await expect(sidebar.getByTestId("site-info-button")).toHaveCount(0);

    // The pane toolbar comes out over the card; the button is on it, just before bookmark.
    const revealToolbar = () => revealPaneToolbar(shell);
    await revealToolbar();
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
    // Named for the site it describes: the start page's host leads the card.
    await expect(shell.getByRole("dialog", { name: /^Site information for \S+/ })).toBeVisible();
    await expect(popover.getByRole("heading", { level: 2 })).not.toHaveText("This page");
    await expect(popover.getByTestId("site-info-connection")).toContainText("Connection is secure");
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

    // A press on the page (its still, while the popover is up) closes it.
    await shell.mouse.click(popoverBox.x - 40, popoverBox.y + 200);
    await expect(popover).toHaveCount(0);
    await expect.poll(() => visibleTabViews(app)).toBe(1);

    // Escape closes it too, and hands the page back.
    await revealToolbar();
    await button.click();
    await expect(popover).toBeVisible();
    await shell.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => visibleTabViews(app)).toBe(1);

    // The full page is one row away; taking it closes the popover.
    await revealToolbar();
    await button.click();
    await popover.getByTestId("site-info-site-controls").click();
    await expect(popover).toHaveCount(0);
    const controls = shell.getByTestId("site-controls");
    await expect(controls).toBeVisible();
    await expect(controls.getByLabel("Microphone permission")).toBeVisible();
    await shell.keyboard.press("Escape");
    await expect(controls).toHaveCount(0);
    await expect.poll(() => visibleTabViews(app)).toBe(1);
  } finally {
    await app.close();
  }
});
