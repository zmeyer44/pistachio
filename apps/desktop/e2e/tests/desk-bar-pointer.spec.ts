/**
 * The Bar's notch over a live page is main's notch view, and the pointer on
 * it grows the Bar (docs/desk.md, "The foot"). The view goes from under the
 * pointer as the Bar grows, so it never hears the pointer go, and shown
 * again — a window brought down under the notch, one filling the desk —
 * its page has the pointer there still: the coming it then reported was no
 * one's. The Bar grew with the pointer elsewhere, never heard it leave, and
 * stayed grown, the window under it its picture, dead to the pointer
 * (2026-10-08). The view's word is now checked against the OS's pointer, and
 * while the Bar holds the pointer to be on it, it reads the OS's pointer
 * for the leave it may never hear.
 *
 * The OS pointer is main's `screen.getCursorScreenPoint`, stubbed here
 * (PISTACHIO_E2E_CURSOR lets main read it under Playwright).
 */

import { expect, test, type ElectronApplication } from "@playwright/test";
import type { WebContentsView } from "electron";
import { createGroup, launchDesk, openGroupDesk, openTabs, settled, windowSelector } from "./desk-harness";

const PAGE = "pistachio://demo/invoices";

/** The desk's notch view on screen, and its box in the window; null while it is not. */
function notchView(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const view = window?.contentView.children.find(
      (child) => "webContents" in child && (child as WebContentsView).webContents.getURL().endsWith("#notch") && (child as WebContentsView).getVisible(),
    ) as WebContentsView | undefined;
    return view === undefined ? null : view.getBounds();
  });
}

/** A move on the notch view, as its page would hear one (its own coordinates). */
function moveOnNotch(app: ElectronApplication, x: number, y: number): Promise<void> {
  return app.evaluate(
    async ({ webContents }, { x, y }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().endsWith("#notch"));
      if (contents === undefined) throw new Error("no notch view");
      contents.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
      await new Promise((done) => setTimeout(done, 60));
    },
    { x, y },
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

test("the notch view's word that the pointer came is the OS pointer's to confirm, and the Bar lets go once it has gone", { tag: ["@desk"] }, async () => {
  test.setTimeout(90_000);
  const { app, shell } = await launchDesk({ name: "bar-pointer", chrome: "drawer", env: { PISTACHIO_E2E_CURSOR: "1" } });
  try {
    // The pointer up in the window, well clear of the Bar.
    await pointerAt(app, 720, 200);
    const [tab] = (await openTabs(shell, [PAGE])) as [string];
    // A group of one: its window fills the desk, its page under the notch — main's notch view lies over it.
    await createGroup(shell, "bar", [tab], "Bar", "blue");
    await openGroupDesk(shell, "bar");
    await settled(shell, app);
    const stage = (await shell.locator(".desk-stage").boundingBox())!;
    const win = shell.locator(windowSelector(tab));
    const bar = shell.getByTestId("desk-bar");
    await expect.poll(() => notchView(app)).not.toBeNull();
    const notch = (await notchView(app))!;

    // The view says the pointer came — a page with the pointer there still from before it was last hidden — while
    // the OS's pointer is up on the page: the Bar stays its notch, and the window its live page.
    await moveOnNotch(app, notch.width / 2, notch.height / 2);
    await shell.waitForTimeout(600);
    await expect(bar).toHaveAttribute("data-compact", "");
    await expect(win).not.toHaveAttribute("data-drawn", "");
    expect(await notchView(app)).not.toBeNull();

    // The pointer really on the notch: moving there, the Bar grows (the view's page thought it there all along, and
    // says so as it moves), and the view goes.
    await pointerAt(app, notch.x + notch.width / 2, notch.y + notch.height / 2);
    await moveOnNotch(app, notch.width / 2 + 3, notch.height / 2);
    await expect(bar).not.toHaveAttribute("data-compact", "");
    await expect.poll(() => notchView(app)).toBeNull();

    // Off up the page with nothing the shell hears (the view is gone from under it, the window under the grown Bar a
    // picture the pointer never crossed): the Bar lets go all the same, and the window is its live page again.
    await pointerAt(app, stage.x + stage.width / 2, stage.y + 200);
    await expect(bar).toHaveAttribute("data-compact", "", { timeout: 3_000 });
    await expect(win).not.toHaveAttribute("data-drawn", "");
    await expect.poll(() => notchView(app)).not.toBeNull();
  } finally {
    await app.close();
  }
});
