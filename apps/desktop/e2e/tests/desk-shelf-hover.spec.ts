/**
 * A parked window raised from main's shelf view (docs/desk.md, "The foot"):
 * over a live page the parked windows are the shelf view's, and the pointer
 * onto one raises it. Raised, it covers the page under it, which gives way,
 * and the view goes — from under the pointer, so it never hears the pointer
 * leave. The window stayed up for good once the pointer had gone off it onto
 * the page, and the view, shown again, still had the pointer on it from
 * before, so the same window did not rise again under it (the user's report,
 * 2026-10-08: "very glitchy"). The shell now reads the OS's pointer while a
 * parked window is raised and lets it down once the pointer is off it, and
 * main tells the view the pointer has gone each time it comes back.
 *
 * The OS pointer is main's `screen.getCursorScreenPoint`, stubbed here
 * (PISTACHIO_E2E_CURSOR lets main read it under Playwright). Step 2 fails
 * without the shell's reading of it. Step 3 passes either way here:
 * Playwright's Chromium tells a view hidden under the pointer that the
 * pointer left, which the real app's does not — only a run with the real
 * pointer shows the view's stale pointer.
 */

import { expect, test, type ElectronApplication } from "@playwright/test";
import type { WebContentsView } from "electron";
import { createGroup, fromFrameMenu, INVOICES, launchDesk, selectSpace, openTabs, rowSelector, selectTab, settled, windowSelector } from "./desk-harness";

const ACCOUNTS = "pistachio://demo/auth/relying-party";

/** The desk's shelf view on screen, and its box in the window; null while it is not. */
function shelfView(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const view = window?.contentView.children.find(
      (child) => "webContents" in child && (child as WebContentsView).webContents.getURL().endsWith("#shelf") && (child as WebContentsView).getVisible(),
    ) as WebContentsView | undefined;
    return view === undefined ? null : view.getBounds();
  });
}

/** A move on the shelf view, as its page would hear one (its own coordinates). */
function moveOnShelf(app: ElectronApplication, x: number, y: number): Promise<void> {
  return app.evaluate(
    async ({ webContents }, { x, y }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().endsWith("#shelf"));
      if (contents === undefined) throw new Error("no shelf view");
      contents.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
      await new Promise((done) => setTimeout(done, 60));
    },
    { x, y },
  );
}

/** Moves across a tab's page, as its own view would hear them. */
function moveOnPage(app: ElectronApplication, url: string, points: Array<{ x: number; y: number }>): Promise<void> {
  return app.evaluate(
    async ({ webContents }, { url, points }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
      if (contents === undefined) throw new Error(`no page at ${url}`);
      for (const point of points) {
        contents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
        await new Promise((done) => setTimeout(done, 30));
      }
    },
    { url, points },
  );
}

/** Where the OS's pointer is, in the window's content box, from now on. */
function pointerAt(app: ElectronApplication, x: number, y: number): Promise<void> {
  return app.evaluate(
    ({ BrowserWindow, screen }, at) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error("Pistachio window is unavailable");
      const state = globalThis as unknown as { __pointer?: { x: number; y: number } };
      state.__pointer = at;
      screen.getCursorScreenPoint = () => {
        const content = window.getContentBounds();
        return { x: content.x + state.__pointer!.x, y: content.y + state.__pointer!.y };
      };
    },
    { x, y },
  );
}

test("a parked window raised from the shelf view goes back down once the pointer is off it, and rises again under it", { tag: ["@desk"] }, async () => {
  test.setTimeout(120_000);
  const { app, shell } = await launchDesk({ name: "shelf-hover", env: { PISTACHIO_E2E_CURSOR: "1" } });
  try {
    await pointerAt(app, 720, 160);
    const [invoice, accounts] = (await openTabs(shell, [INVOICES, ACCOUNTS])) as [string, string];
    await createGroup(shell, "shelf", [invoice, accounts], "Shelf", "blue");
    await selectTab(shell, invoice);
    await selectSpace(shell, "shelf");
    await settled(shell, app);
    await shell.locator(rowSelector(accounts)).click();
    await settled(shell, app);
    // The invoice minimized into the shelf; the accounts filling the desk, its live page under the shelf.
    const invoiceWindow = shell.locator(windowSelector(invoice));
    await fromFrameMenu(shell, invoiceWindow, "desk-minimize");
    await settled(shell, app);
    await expect(invoiceWindow).toHaveAttribute("data-mini", "parked");
    await selectTab(shell, accounts);
    await settled(shell, app);
    await shell.locator(`${windowSelector(accounts)} button[aria-label="Fill the desk"]`).click({ force: true });
    await settled(shell, app);
    await shell.mouse.move(720, 160);
    await expect.poll(() => shelfView(app), { timeout: 10_000 }).not.toBeNull();
    const view = (await shelfView(app))!;
    /** On the invoice as it peeks up in the shelf view, in the view's coordinates. */
    const onParked = { x: 62, y: 19 };

    // ── 1. The pointer onto it in the view: it rises, and the view goes from under the pointer ─
    await pointerAt(app, view.x + onParked.x, view.y + onParked.y);
    await moveOnShelf(app, onParked.x, onParked.y);
    await expect(invoiceWindow).toHaveAttribute("data-raised", "");
    await expect.poll(() => shelfView(app)).toBeNull();
    // Resting there — on the window that rose under it — it stays up.
    await shell.waitForTimeout(600);
    await expect(invoiceWindow).toHaveAttribute("data-raised", "");

    // ── 2. Off up onto the page filling the desk, which the shell never hears (its view does): it goes back down ─
    await pointerAt(app, 720, 160);
    await moveOnPage(app, ACCOUNTS, [
      { x: 400, y: 300 },
      { x: 400, y: 200 },
      { x: 400, y: 120 },
    ]);
    await expect(invoiceWindow).not.toHaveAttribute("data-raised", "", { timeout: 3_000 });
    await expect.poll(() => shelfView(app)).not.toBeNull();

    // ── 3. Back onto it in the view, where the view last had the pointer: it rises again ─
    await pointerAt(app, view.x + onParked.x, view.y + onParked.y);
    await moveOnShelf(app, onParked.x, onParked.y);
    await expect(invoiceWindow).toHaveAttribute("data-raised", "");
  } finally {
    await app.close();
  }
});
