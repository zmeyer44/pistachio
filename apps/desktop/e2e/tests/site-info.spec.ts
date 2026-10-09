import { expect, test, type ElectronApplication } from "@playwright/test";
import { pageFirst, shellReady } from "./windows";
import { launchApp } from "./app";
import { box, snapshot, windowSelector } from "./desk-harness";
import { captureShell as captureWindow, openSiteInfo, visibleTabViews } from "./pages-harness";

function captureShell(app: ElectronApplication, filename: string): Promise<void> {
  return captureWindow(app, `site-info/${filename}`);
}

test("the site-info card hangs from the window's ⋯ on the desk, and flips permissions and sound", { tag: ["@site", "@desk"] }, async () => {
  const { app } = await launchApp({ settings: pageFirst({ layout: { sidebar: "pinned" } }), name: "site-info" });
  try {
    const shell = await shellReady(app);
    const sidebar = shell.getByTestId("sidebar-chrome");
    await expect(sidebar.getByTestId("sidebar-address")).toBeVisible();
    await expect.poll(() => visibleTabViews(app)).toBe(1);
    // Not in the column: the page's own controls ride with its window, on its ⋯.
    await expect(sidebar.getByTestId("site-info-button")).toHaveCount(0);
    const tabId = (await snapshot(shell)).activeTabId!;
    const more = shell.locator(windowSelector(tabId)).getByTestId("desk-window-more");

    // Opening it raises the chrome over the page, and the ⋯ says it is up.
    const popover = await openSiteInfo(shell, app);
    await expect(more).toHaveAttribute("aria-pressed", "true");
    // Named for the site it describes: the start page's host leads the card.
    await expect(shell.getByRole("dialog", { name: /^Site information for \S+/ })).toBeVisible();
    await expect(popover.getByRole("heading", { level: 2 })).not.toHaveText("This page");
    await expect(popover.getByTestId("site-info-connection")).toContainText("Connection is secure");
    await expect(popover.getByTestId("site-info-permission-camera")).toContainText("Asks before use");
    await expect.poll(() => visibleTabViews(app)).toBe(0);
    // Under the ⋯, hanging from its trailing edge: the card grows toward the page, not off the window.
    const buttonBox = await box(shell, `${windowSelector(tabId)} [data-testid="desk-window-more"]`);
    await expect.poll(async () => (await box(shell, '[data-testid="site-info-popover"]')).y).toBeGreaterThanOrEqual(buttonBox.y + buttonBox.height);
    const popoverBox = await box(shell, '[data-testid="site-info-popover"]');
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
    await openSiteInfo(shell, app);
    await shell.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(more).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => visibleTabViews(app)).toBe(1);

    // The full page is one row away; taking it closes the popover.
    await openSiteInfo(shell, app);
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
