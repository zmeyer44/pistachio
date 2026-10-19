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

import { existsSync } from "node:fs";
import { expect, test, type ElectronApplication } from "@playwright/test";
import type { WebContentsView } from "electron";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { createGroup, launchDesk, selectSpace, openTabs, settled, windowSelector } from "./desk-harness";

const PAGE = "pistachio://demo/invoices";
/** How long the nub takes to swell (nub-motion's SWELL_IN_MS). */
const SWELL_IN_MS = 350;

/** Whether native/desk-glass is built here (scripts/build-native.mjs skips it where it cannot be: the nub keeps its stand-in). */
const NATIVE_GLASS = process.platform === "darwin" && existsSync(new URL("../../native/desk-glass/build/desk_glass.node", import.meta.url));

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

/** From now on, whether the notch view ever leaves the screen (main looks every few ms): notchLeft. */
function watchNotch(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ BrowserWindow }) => {
    const state = globalThis as unknown as { __notchLeft?: boolean; __notchWatch?: ReturnType<typeof setInterval> };
    state.__notchLeft = false;
    clearInterval(state.__notchWatch);
    state.__notchWatch = setInterval(() => {
      const window = BrowserWindow.getAllWindows()[0];
      const view = window?.contentView.children.find((child) => "webContents" in child && (child as WebContentsView).webContents.getURL().endsWith("#notch"));
      if (view === undefined || !view.getVisible()) state.__notchLeft = true;
    }, 5);
  });
}

function notchLeft(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(() => {
    const state = globalThis as unknown as { __notchLeft?: boolean; __notchWatch?: ReturnType<typeof setInterval> };
    clearInterval(state.__notchWatch);
    return state.__notchLeft === true;
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
  const { app, shell } = await launchDesk({ name: "bar-pointer", env: { PISTACHIO_E2E_CURSOR: "1" } });
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
    // for the shell's own nub — the band it appears in given way first (the page under it a still) — and goes with the
    // pointer. The view stays over that still throughout, the nub swelled under the pointer: until 2026-10-16 it went
    // from under the pointer as the page gave way and came back once the page was live again, the pointer's cursor and
    // the nub drawn afresh each way (the user's report: "glitchy").
    const faceTip = shell.getByTestId("desk-bar-tip").filter({ hasText: "Ask about Bar" });
    await pointerAt(app, notch.x + onNub.x, notch.y + onNub.y);
    await watchNotch(app);
    await moveOnNotch(app, onNub.x, onNub.y);
    await expect(nub).toHaveAttribute("data-hovered", "");
    await expect(faceTip).toHaveAttribute("data-shown", "");
    await expect(win).toHaveAttribute("data-drawn", "");
    await moveOnNotch(app, onNub.x + 1, onNub.y);
    await expect(faceTip).toHaveAttribute("data-shown", "");
    await pointerAt(app, stage.x + stage.width / 2, stage.y + 200);
    await expect(nub).not.toHaveAttribute("data-hovered", "", { timeout: 3_000 });
    await expect(faceTip).toHaveCount(0);
    await expect(win).not.toHaveAttribute("data-drawn", "");
    expect(await notchLeft(app)).toBe(false);
    expect(await notchView(app)).not.toBeNull();
  } finally {
    await app.close();
  }
});

/** The offscreen page the nub's picture is painted in, and the hidden window it paints at the size of (main/desk-glass.ts); null while there is none. */
function notchPicture(app: ElectronApplication) {
  return app.evaluate(({ BaseWindow, BrowserWindow, screen }) => {
    const [window] = BrowserWindow.getAllWindows();
    const pictureOf = (host: Electron.BaseWindow): WebContentsView | undefined =>
      host.contentView.children.find((child) => "webContents" in child && (child as WebContentsView).webContents.getURL().endsWith("#notch-picture")) as
        | WebContentsView
        | undefined;
    const host = BaseWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && pictureOf(candidate) !== undefined);
    const page = host === undefined ? undefined : pictureOf(host);
    if (window === undefined || host === undefined || page === undefined || page.webContents.isDestroyed()) return null;
    const display = screen.getDisplayMatching(window.getBounds());
    return {
      size: host.getContentSize(),
      rate: page.webContents.getFrameRate(),
      displayRate: display.displayFrequency,
      offscreen: page.webContents.isOffscreen(),
      visible: host.isVisible(),
      // (Not one of the browser's windows, newest first as they are listed.)
      browserWindow: BrowserWindow.getAllWindows().some((candidate) => candidate.id === host.id),
    };
  });
}

test("over a live page the nub is the window's own glass with the nub painted on it offscreen — and with the desktop glass off, the surface's colour", { tag: ["@desk"] }, async () => {
  const { app, shell } = await launchDesk({ name: "bar-glass", env: { PISTACHIO_E2E_CURSOR: "1" } });
  try {
    await pointerAt(app, 720, 200);
    const [tab] = (await openTabs(shell, [PAGE])) as [string];
    await createGroup(shell, "glass", [tab], "Glass", "blue");
    await selectSpace(shell, "glass");
    await settled(shell, app);
    await expect.poll(() => notchView(app)).not.toBeNull();
    const notch = (await notchView(app))!;
    const view = app.windows().find((page) => page.url().endsWith("#notch"))!;
    const ground = view.locator(".desk-notch-view");
    const paint = (): Promise<string> => ground.evaluate((el) => getComputedStyle(el).backgroundColor);
    // The view paints its stand-in whatever lies over it: the nub until the glass and the nub's picture are laid over the
    // view, and if the glass steps aside.
    await expect.poll(paint).not.toBe("rgba(0, 0, 0, 0)");

    if (NATIVE_GLASS) {
      // The nub on the glass is the view's page painted again offscreen, at the display's rate: until 2026-10-16 it was
      // the view's own page through main's frame subscription, at most 30 frames a second, and through a swell the
      // glass's edge glided while the mark on it stepped. Its window is the view's box twice over: the nub, and under it
      // the outline the glass is cut to — one frame holds both, so they move as one.
      await expect.poll(async () => (await notchPicture(app))?.size).toEqual([notch.width, notch.height * 2]);
      const picture = (await notchPicture(app))!;
      expect(picture.offscreen).toBe(true);
      expect(picture.visible).toBe(false);
      expect(picture.browserWindow).toBe(false);
      expect(picture.rate).toBe(Math.min(240, Math.max(30, Math.round(picture.displayRate))));

      // On the glass it paints what the gutter lays over its glass round the desk (`.chrome-container`): the tint and
      // the theme's gradient, no stand-in.
      await expect.poll(() => app.windows().some((page) => page.url().endsWith("#notch-picture"))).toBe(true);
      const nub = app.windows().find((page) => page.url().endsWith("#notch-picture"))!.locator(".desk-notch-view[data-picture]");
      const gutter = await shell.locator(".chrome-container").first().evaluate((el) => {
        const style = getComputedStyle(el);
        return { color: style.backgroundColor, image: style.backgroundImage };
      });
      expect(gutter.color).not.toBe("rgba(0, 0, 0, 0)");
      await expect.poll(() => nub.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(gutter.color);
      expect(await nub.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe(gutter.image);

      // A paint of it: at the nub's face, the nub over its outline, which is opaque; at the box's far corner, neither.
      const face = await nub.locator(".desk-notch-view-face").evaluate((el) => {
        const box = el.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      });
      const alpha = await app.evaluate(async ({ webContents }, { face, size }) => {
        const picture = webContents.getAllWebContents().find((candidate) => candidate.getURL().endsWith("#notch-picture"))!;
        const painted = new Promise<Electron.NativeImage>((done) => picture.once("paint", (_event, _dirty, image) => done(image)));
        picture.invalidate();
        const bitmap = (await painted).toBitmap();
        const [width, height] = size as [number, number];
        const scale = Math.sqrt(bitmap.length / 4 / (width * height));
        const at = (x: number, y: number): number => bitmap[(Math.floor(y * scale) * Math.round(width * scale) + Math.floor(x * scale)) * 4 + 3]!;
        const half = height / 2;
        return { nub: at(face.x, face.y), outline: at(face.x, face.y + half), far: at(2, 2), farOutline: at(2, half + 2) };
      }, { face, size: picture.size });
      expect(alpha.nub).toBeGreaterThan(0);
      expect(alpha.outline).toBe(255);
      expect(alpha.far).toBe(0);
      expect(alpha.farOutline).toBe(0);

      // Through a swell under the pointer, it paints at its rate, near enough (measured on a 75 Hz display: 27 in the
      // swell's 350 ms, where the frame subscription gave 10 or 11) — the swell's own motion, not the person's setting
      // (with Reduce Motion it is over at once).
      await shell.emulateMedia({ reducedMotion: "no-preference" });
      await app.evaluate(({ webContents }) => {
        const picture = webContents.getAllWebContents().find((candidate) => candidate.getURL().endsWith("#notch-picture"))!;
        const state = globalThis as unknown as { __picturePaints?: number };
        state.__picturePaints = 0;
        picture.on("paint", () => {
          state.__picturePaints! += 1;
        });
      });
      const onNub = { x: notch.width * 0.62, y: notch.height * 0.62 };
      await pointerAt(app, notch.x + onNub.x, notch.y + onNub.y);
      await moveOnNotch(app, onNub.x, onNub.y);
      await expect(shell.getByTestId("desk-nub")).toHaveAttribute("data-hovered", "");
      await shell.waitForTimeout(SWELL_IN_MS + 150);
      expect(await app.evaluate(() => (globalThis as unknown as { __picturePaints?: number }).__picturePaints ?? 0)).toBeGreaterThanOrEqual(
        Math.floor(picture.rate * (SWELL_IN_MS / 1000) * 0.6),
      );
      await pointerAt(app, 720, 200);
      await expect(shell.getByTestId("desk-nub")).not.toHaveAttribute("data-hovered", "", { timeout: 3_000 });
      await shell.emulateMedia({ reducedMotion: null });

      // The display's rate, as it changes — the display's own (its refresh rate set anew), or the window moved to another
      // — with no word from the shell about the nub.
      const displayAt = (hz: number | null): Promise<void> =>
        app.evaluate(({ screen }, hz) => {
          const state = globalThis as unknown as { __getDisplayMatching?: typeof screen.getDisplayMatching };
          state.__getDisplayMatching ??= screen.getDisplayMatching.bind(screen);
          const real = state.__getDisplayMatching;
          screen.getDisplayMatching = hz === null ? real : (rect) => ({ ...real(rect), displayFrequency: hz });
        }, hz);
      await displayAt(50);
      await app.evaluate(({ screen }) => {
        const display = screen.getPrimaryDisplay();
        screen.emit("display-metrics-changed", { preventDefault: () => undefined }, display, ["displayFrequency"]);
      });
      await expect.poll(async () => (await notchPicture(app))?.rate).toBe(50);
      await displayAt(120);
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.emit("moved");
      });
      await expect.poll(async () => (await notchPicture(app))?.rate).toBe(120);
      await displayAt(null);
    } else {
      expect(await notchPicture(app)).toBeNull();
    }

    // Off, nothing to lay under it: the view paints the surface's own colour, as the shell does round the desk, and
    // the picture goes.
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.updateSettings({ appearance: { desktopGlass: false } }));
    await expect.poll(() => notchPicture(app)).toBeNull();
    await expect.poll(paint).not.toBe("rgba(0, 0, 0, 0)");

    // And on again, the picture with it.
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.updateSettings({ appearance: { desktopGlass: true } }));
    if (NATIVE_GLASS) await expect.poll(async () => (await notchPicture(app))?.size).toEqual([notch.width, notch.height * 2]);
  } finally {
    await app.close();
  }
});
