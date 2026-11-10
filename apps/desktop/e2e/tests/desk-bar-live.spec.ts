/**
 * The Bar's pill out, the page under it stays live (docs/desk-agent.md
 * §1, "The pill"; docs/desk.md, "The foot"). Until 2026-11-05 the pill was
 * a cover like the nub's menu: the window under it gave way to its still,
 * and a page that reached the desk's foot — every filled one — was a picture
 * dead to the pointer for as long as the pill was out, as if a pane of glass
 * lay over it. Now the desk keeps a band clear at its foot for the pill
 * (DeskEngine.setBand): the windows glide up out of it, their pages live,
 * the pill lies on the ground the band leaves, and they come back as the
 * pill goes in. The pill's close and side buttons above the nub, which lie
 * over the page, are drawn by main's notch view there, as the nub is.
 */

import { expect, test, type ElectronApplication } from "@playwright/test";
import type { WebContentsView } from "electron";
import { box, createGroup, INVOICES, launchDesk, openTabs, pressNubButton, reachBar, screenshots, selectSpace, selectTab, settled, windowSelector, type Box } from "./desk-harness";
import { pageAt } from "./pages-harness";
import { liveViews } from "./windows";

// (With the notch view in the picture: over a live page it draws the nub and the pill's buttons.)
const capture = screenshots("desk-bar-live", ["notch"]);

/** A press through the window at a point of its content box, as the OS would land it: on the topmost view there, else the shell. Which page took it. */
function pressThrough(app: ElectronApplication, x: number, y: number): Promise<string> {
  return app.evaluate(
    async ({ BrowserWindow }, at) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error("Pistachio window is unavailable");
      let target = window.webContents;
      let local = { x: at.x, y: at.y };
      const views = window.contentView.children;
      for (let i = views.length - 1; i >= 0; i--) {
        const view = views[i]!;
        if (!("webContents" in view) || !view.getVisible()) continue;
        const bounds = view.getBounds();
        if (at.x < bounds.x || at.y < bounds.y || at.x >= bounds.x + bounds.width || at.y >= bounds.y + bounds.height) continue;
        target = (view as WebContentsView).webContents;
        local = { x: at.x - bounds.x, y: at.y - bounds.y };
        break;
      }
      const x = Math.round(local.x);
      const y = Math.round(local.y);
      target.sendInputEvent({ type: "mouseMove", x, y });
      await new Promise((done) => setTimeout(done, 20));
      target.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x, y });
      await new Promise((done) => setTimeout(done, 30));
      target.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x, y });
      await new Promise((done) => setTimeout(done, 60));
      return target.getURL();
    },
    { x, y },
  );
}

/** The notch view on screen: its box in the window, or null. */
function notchBounds(app: ElectronApplication): Promise<Box | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const view = window?.contentView.children.find(
      (child) => "webContents" in child && (child as WebContentsView).webContents.getURL().endsWith("#notch") && child.getVisible(),
    ) as WebContentsView | undefined;
    return view === undefined ? null : view.getBounds();
  });
}

test("the pill out, the page under it stays live and takes a click; the pill's buttons over it are the notch view's; the page comes back as the pill goes in", { tag: ["@desk"] }, async () => {
  test.setTimeout(90_000);
  const { app, shell } = await launchDesk({ name: "bar-live" });
  try {
    const [invoice] = (await openTabs(shell, [INVOICES])) as [string];
    await createGroup(shell, "bar-live", [invoice], "Northstar", "green");
    await selectTab(shell, invoice);
    await selectSpace(shell, "bar-live");
    await settled(shell, app);
    const stage = await box(shell, ".desk-stage");
    const win = shell.locator(windowSelector(invoice));
    await expect(win).toHaveCount(1);
    // The page fills the desk, down to its foot, live.
    const before = (await liveViews(app)).find((view) => view.url === INVOICES);
    expect(before).toBeDefined();
    expect(before!.bounds.y + before!.bounds.height).toBeGreaterThan(stage.y + stage.height - 4);
    const page = await pageAt(app, INVOICES);
    await page.evaluate(() => {
      const state = window as unknown as { __clicks: number };
      state.__clicks = 0;
      document.addEventListener("click", () => (state.__clicks += 1));
    });

    // The pill out of the nub's prompt droplet: the window gives way by moving, not by freezing — its page live, its
    // view's foot above the pill's footprint, the pill on the ground below it.
    await reachBar(shell);
    await expect(shell.getByTestId("desk-bar-input")).toBeFocused();
    await settled(shell, app);
    await expect(win).not.toHaveAttribute("data-drawn", "");
    const pill = await box(shell, '[data-testid="desk-bar"]');
    const live = (await liveViews(app)).find((view) => view.url === INVOICES);
    expect(live, "the page's view is on screen with the pill out").toBeDefined();
    expect(live!.bounds.y + live!.bounds.height).toBeLessThanOrEqual(pill.y - 8 + 1);
    expect(live!.bounds.y + live!.bounds.height).toBeGreaterThan(pill.y - 40);
    await capture(app, shell, "01-pill-out-page-live.png");

    // A click lands on the page, where the pill's cover would have held its still: in the view, counted by the page.
    const at = { x: live!.bounds.x + live!.bounds.width * 0.5, y: live!.bounds.y + live!.bounds.height - 30 };
    expect(await pressThrough(app, at.x, at.y)).toBe(INVOICES);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBe(1);
    // (The press on the page took the keyboard from the pill, as a press on any window does; the pill, empty, went in.)

    // Out again with words in it, the pill stays out whatever has the keyboard: its close above the nub lies over the
    // live page, so it is main's notch view that draws it (the shell's stands veiled in its place), and the view's box
    // reaches up over it.
    await reachBar(shell);
    await shell.getByTestId("desk-bar-input").fill("A question to keep");
    await settled(shell, app);
    const close = shell.getByTestId("desk-bar-close");
    await expect(close).toHaveAttribute("data-shown", "");
    await expect(close).toHaveAttribute("data-veiled", "");
    const closeBox = await box(shell, '[data-testid="desk-bar-close"]');
    const notch = await notchBounds(app);
    expect(notch).not.toBeNull();
    expect(notch!.y).toBeLessThanOrEqual(closeBox.y - stage.y + 0);
    expect(notch!.x + notch!.width).toBeGreaterThanOrEqual(stage.x + stage.width - 1);
    await capture(app, shell, "02-close-in-the-view.png", 400, undefined);
    // The page is live under it still, and takes a click beside the column.
    const again = (await liveViews(app)).find((view) => view.url === INVOICES);
    expect(again).toBeDefined();
    expect(await pressThrough(app, again!.bounds.x + again!.bounds.width * 0.5, again!.bounds.y + again!.bounds.height - 30)).toBe(INVOICES);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBe(2);
    await expect(shell.getByTestId("desk-bar")).not.toHaveAttribute("data-compact", "");

    // The view's close pressed: the pill goes in (what was typed kept), and the window comes back down to the foot.
    await pressNubButton(app, shell, "desk-bar-close");
    await expect(shell.getByTestId("desk-bar")).toHaveAttribute("data-compact", "");
    await settled(shell, app);
    const after = (await liveViews(app)).find((view) => view.url === INVOICES);
    expect(after).toBeDefined();
    expect(after!.bounds.y + after!.bounds.height).toBeGreaterThan(stage.y + stage.height - 4);
    await expect(win).not.toHaveAttribute("data-drawn", "");
    await reachBar(shell);
    await expect(shell.getByTestId("desk-bar-input")).toHaveValue("A question to keep");
    await capture(app, shell, "03-back-at-the-foot.png");
  } finally {
    await app.close();
  }
});
