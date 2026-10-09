/**
 * The Bar's nub over a live page is main's notch view, and the pointer on
 * it swells the nub (docs/desk.md, "The foot") and asks the page under what
 * the nub opens to give way. The view goes from under the pointer once the
 * page is a still, so it never hears the pointer go, and shown again — a
 * window brought down under the nub, one filling the desk — its page has
 * the pointer there still: the coming it then reported was no one's. The
 * Bar grew with the pointer elsewhere, never heard it leave, and stayed
 * grown, the window under it its picture, dead to the pointer (2026-10-08).
 * The view's word is now checked against the OS's pointer, and while the
 * nub holds the pointer to be on it, it reads the OS's pointer for the
 * leave it may never hear.
 *
 * The OS pointer is main's `screen.getCursorScreenPoint`, stubbed here
 * (PISTACHIO_E2E_CURSOR lets main read it under Playwright).
 */

import { expect, test, type ElectronApplication } from "@playwright/test";
import type { WebContentsView } from "electron";
import { createGroup, launchDesk, selectSpace, openTabs, settled, windowSelector } from "./desk-harness";

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

/** A press on the notch view, as its page would hear one. */
function pressOnNotch(app: ElectronApplication, x: number, y: number): Promise<void> {
  return app.evaluate(
    async ({ webContents }, { x, y }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().endsWith("#notch"));
      if (contents === undefined) throw new Error("no notch view");
      contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: Math.round(x), y: Math.round(y) });
      await new Promise((done) => setTimeout(done, 40));
      contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: Math.round(x), y: Math.round(y) });
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
    // A group of one: its window fills the desk, its page under the nub in the corner — main's notch view lies over it.
    await createGroup(shell, "bar", [tab], "Bar", "blue");
    await selectSpace(shell, "bar");
    await settled(shell, app);
    const stage = (await shell.locator(".desk-stage").boundingBox())!;
    const win = shell.locator(windowSelector(tab));
    const nub = shell.getByTestId("desk-nub");
    await expect.poll(() => notchView(app)).not.toBeNull();
    const notch = (await notchView(app))!;

    // Its corner is the desk's.
    expect(Math.abs(notch.x + notch.width - (stage.x + stage.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(notch.y + notch.height - (stage.y + stage.height))).toBeLessThanOrEqual(1);
    // (On the nub's circle, in the view's own coordinates.)
    const onNub = { x: notch.width * 0.62, y: notch.height * 0.62 };

    // The view says the pointer came — a page with the pointer there still from before it was last hidden — while
    // the OS's pointer is up on the page: the nub stays as it is, and the window its live page.
    await moveOnNotch(app, onNub.x, onNub.y);
    await shell.waitForTimeout(600);
    await expect(nub).not.toHaveAttribute("data-hovered", "");
    await expect(win).not.toHaveAttribute("data-drawn", "");
    expect(await notchView(app)).not.toBeNull();

    // The pointer really on the nub: moving there, it swells (the view's page thought it there all along, and says so
    // as it moves) — the view draws the swell, and the page under it stays live.
    await pointerAt(app, notch.x + onNub.x, notch.y + onNub.y);
    await moveOnNotch(app, onNub.x + 2, onNub.y);
    await expect(nub).toHaveAttribute("data-hovered", "");
    // (Before its tooltip's delay: the band the tooltip appears in is a cover, below.)
    await expect(win).not.toHaveAttribute("data-drawn", "");
    expect(await notchView(app)).not.toBeNull();
    // A press there lets out the menu: the page under it gives way, and the view goes from under the pointer.
    await pressOnNotch(app, onNub.x + 2, onNub.y);
    await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(1);
    await expect(win).toHaveAttribute("data-drawn", "");
    await expect.poll(() => notchView(app)).toBeNull();

    // Off up the page with nothing the shell hears (the view is gone from under it, the window under the nub a picture
    // the pointer never crossed): the nub lets go of it all the same; the menu put back, the window is its live page
    // again, and the view is back over it.
    await pointerAt(app, stage.x + stage.width / 2, stage.y + 200);
    await expect(nub).not.toHaveAttribute("data-hovered", "", { timeout: 3_000 });
    await shell.keyboard.press("Escape");
    await expect(shell.locator('[data-testid="desk-nub-menu"][data-open]')).toHaveCount(0);
    await expect(win).not.toHaveAttribute("data-drawn", "");
    await expect.poll(() => notchView(app)).not.toBeNull();
    await expect(nub).not.toHaveAttribute("data-hovered", "");

    // What the nub is for, which its mark alone does not say: resting on the view, the nub's tooltip opens as it does
    // for the shell's own nub — the band it appears in given way first (the page under it a still, the view gone) —
    // and goes with the pointer.
    const faceTip = shell.getByTestId("desk-bar-tip").filter({ hasText: "Ask about Bar" });
    await pointerAt(app, notch.x + onNub.x, notch.y + onNub.y);
    await moveOnNotch(app, onNub.x, onNub.y);
    await expect(nub).toHaveAttribute("data-hovered", "");
    await expect(faceTip).toHaveAttribute("data-shown", "");
    await expect(win).toHaveAttribute("data-drawn", "");
    await pointerAt(app, stage.x + stage.width / 2, stage.y + 200);
    await expect(nub).not.toHaveAttribute("data-hovered", "", { timeout: 3_000 });
    await expect(faceTip).toHaveCount(0);
    await expect(win).not.toHaveAttribute("data-drawn", "");
    await expect.poll(() => notchView(app)).not.toBeNull();
  } finally {
    await app.close();
  }
});
