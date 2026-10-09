/**
 * Screenshots of the window (@pistachio/shell-contracts/screenshot): ⌘⇧1
 * keeps the pages — the desk, the desktop's surface, whole, without the
 * sidebar, the window's frame or the desk's Bar; ⌘⇧2 holds the
 * window and keeps the area dragged out over it. Each is copied and saved
 * (here, in the spec's own folder: PISTACHIO_SCREENSHOT_DIR).
 *
 * What only the real app can show: main lays the shell page and the native
 * views over it up into one picture, at the box the shell names. The pixel
 * work itself is unit-tested (test/window-compose.test.ts).
 */

import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { launchApp } from "./app";
import { pageAt } from "./chrome-harness";
import { box, createGroup, fromFrameMenu, INVOICES, launchDesk, liveViews, selectSpace, openTabs, selectTab, settled, windowSelector, type Box } from "./desk-harness";
import { findPage, noticePage, shellReady } from "./windows";

/** A saved PNG's pixel size, and its colour (r, g, b) at each of `points` (in its own pixels). */
function readPng(app: ElectronApplication, path: string, points: ReadonlyArray<{ x: number; y: number }> = []): Promise<{ width: number; height: number; colors: number[][] }> {
  return app.evaluate(
    ({ nativeImage }, { path, points }) => {
      const image = nativeImage.createFromPath(path);
      const { width, height } = image.getSize();
      const bitmap = image.toBitmap();
      const colors = points.map(({ x, y }) => {
        const at = (Math.round(y) * width + Math.round(x)) * 4;
        return [bitmap[at + 2]!, bitmap[at + 1]!, bitmap[at]!];
      });
      return { width, height, colors };
    },
    { path, points },
  );
}

/** The live page view at `url`, captured on its own: its colour (r, g, b) at a point in its box (CSS px). */
function pageColor(app: ElectronApplication, url: string, point: { x: number; y: number }): Promise<number[]> {
  return app.evaluate(
    async ({ BrowserWindow }, { url, point }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const view = window.contentView.children.find(
        (child) => "webContents" in child && (child as WebContentsView).webContents.getURL() === url && child.getVisible(),
      ) as WebContentsView | undefined;
      if (view === undefined) throw new Error(`no live view at ${url}`);
      const image = await view.webContents.capturePage({ x: Math.round(point.x), y: Math.round(point.y), width: 1, height: 1 });
      const bitmap = image.toBitmap();
      return [bitmap[2]!, bitmap[1]!, bitmap[0]!];
    },
    { url, point },
  );
}

/** Device pixels to a CSS px on the window's display. */
function scaleOf(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow, screen }) => screen.getDisplayMatching(BrowserWindow.getAllWindows()[0]!.getBounds()).scaleFactor);
}

/** Whether a chrome view (by its hash) is up over the window. */
function chromeViewShown(app: ElectronApplication, hash: string): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }, hash) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    return window.contentView.children.some(
      (child) => "webContents" in child && (child as WebContentsView).webContents.getURL().endsWith(hash) && child.getVisible(),
    );
  }, hash);
}

type Watched = Electron.WebContents & { __restore?: () => void };
type KeyboardCounts = { page: number; shell: number };

/**
 * The OS says which view has the keyboard only to a key window (not while the
 * screen is locked), so the page at `url` is told it has it, and from here
 * every hand-over of the keyboard — main focusing the page, or the shell — is
 * counted (keyboardGiven), until unwatchKeyboard.
 */
function watchKeyboard(app: ElectronApplication, url: string): Promise<void> {
  return app.evaluate(({ BrowserWindow, webContents }, url) => {
    const counts = { page: 0, shell: 0 };
    (globalThis as { __keyboard?: KeyboardCounts }).__keyboard = counts;
    const count = (contents: Watched, key: keyof KeyboardCounts, alwaysFocused: boolean): void => {
      const { isFocused, focus } = contents;
      if (alwaysFocused) contents.isFocused = () => true;
      contents.focus = () => {
        counts[key] += 1;
        focus.call(contents);
      };
      contents.__restore = () => {
        contents.isFocused = isFocused;
        contents.focus = focus;
      };
    };
    count(webContents.getAllWebContents().find((contents) => contents.getURL() === url)! as Watched, "page", true);
    count(BrowserWindow.getAllWindows()[0]!.webContents as Watched, "shell", false);
  }, url);
}

function keyboardGiven(app: ElectronApplication): Promise<KeyboardCounts> {
  return app.evaluate(() => ({ ...(globalThis as { __keyboard?: KeyboardCounts }).__keyboard! }));
}

function unwatchKeyboard(app: ElectronApplication, url: string): Promise<void> {
  return app.evaluate(({ BrowserWindow, webContents }, url) => {
    (webContents.getAllWebContents().find((contents) => contents.getURL() === url) as Watched | undefined)?.__restore?.();
    (BrowserWindow.getAllWindows()[0]!.webContents as Watched).__restore?.();
  }, url);
}

function near(actual: number[], expected: number[], tolerance = 4): boolean {
  return actual.every((value, index) => Math.abs(value - expected[index]!) <= tolerance);
}

test.describe.serial("window screenshots", { tag: ["@screenshot", "@desk"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let folder: string;
  let scale: number;
  let kept: string;
  /** Every file saved so far. */
  let saved: string[] = [];

  /** The file the last screenshot saved, once there is one more than before. */
  async function nextShot(): Promise<string> {
    let added: string[] = [];
    await expect
      .poll(async () => {
        added = (await readdir(folder)).filter((name) => !saved.includes(name));
        return added.length;
      })
      .toBe(1);
    saved = [...saved, ...added];
    return join(folder, added[0]!);
  }

  async function expectNoShot(): Promise<void> {
    await shell.waitForTimeout(500);
    expect((await readdir(folder)).filter((name) => !saved.includes(name))).toEqual([]);
  }

  test.beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "pistachio-screenshots-"));
    ({ app, shell } = await launchDesk({ name: "screenshot", env: { PISTACHIO_SCREENSHOT_DIR: folder } }));
    scale = await scaleOf(app);
    // The clipboard is the machine's own: whatever text was on it goes back.
    kept = await app.evaluate(({ clipboard }) => clipboard.readText());
  });

  test.afterAll(async () => {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), kept).catch(() => undefined);
    await app.close();
  });

  test("⌘⇧1 keeps the desk's box, with the live page in it, and copies it", async () => {
    await expect.poll(async () => (await liveViews(app)).some((view) => view.url === INVOICES)).toBe(true);
    // (The desk: the window the app came up on fills it, its one tab's.)
    const panes = await box(shell, ".desk-stage");
    const view = (await liveViews(app)).find((candidate) => candidate.url === INVOICES)!.bounds;
    await app.evaluate(({ clipboard }) => clipboard.clear());
    await shell.keyboard.press("Meta+Shift+Digit1");
    const path = await nextShot();
    // A point inside the page, clear of its rounded corners: the page's own pixel, at its place in the picture.
    const inPage = { x: view.width / 2, y: Math.min(view.height / 2, 200) };
    const shot = await readPng(app, path, [{ x: (view.x - panes.x + inPage.x) * scale, y: (view.y - panes.y + inPage.y) * scale }]);
    expect(Math.abs(shot.width - panes.width * scale)).toBeLessThanOrEqual(2);
    expect(Math.abs(shot.height - panes.height * scale)).toBeLessThanOrEqual(2);
    expect(near(shot.colors[0]!, await pageColor(app, INVOICES, inPage))).toBe(true);
    expect(await app.evaluate(({ clipboard }) => clipboard.readImage().isEmpty())).toBe(false);
    await expect((await noticePage(app)).getByText("Screenshot copied and saved")).toBeVisible();
  });

  test("from the address palette: \"take screenshot\" offers both; Enter takes the page, without the palette in it; a click starts the area", async () => {
    const view = (await liveViews(app)).find((candidate) => candidate.url === INVOICES)!.bounds;
    const panes = await box(shell, ".desk-stage");
    const inPage = { x: view.width / 2, y: Math.min(view.height / 2, 200) };
    const expected = await pageColor(app, INVOICES, inPage);
    const input = shell.getByTestId("address-input");
    const pageRow = shell.locator('[data-testid="command-result"][data-action-id="chrome:screenshotView"]');
    const areaRow = shell.locator('[data-testid="command-result"][data-action-id="chrome:screenshotArea"]');

    await shell.keyboard.press("Meta+L");
    await expect(input).toBeFocused();
    await input.fill("take screenshot");
    await expect(pageRow).toHaveAttribute("data-index", "0");
    await expect(pageRow).toContainText("⌘⇧1");
    await expect(areaRow).toContainText("⌘⇧2");
    await shell.keyboard.press("Enter");
    await expect(input).toHaveCount(0);
    // The palette and its veil over the window are gone from the picture: the page's own pixel is there.
    const shot = await readPng(app, await nextShot(), [{ x: (view.x - panes.x + inPage.x) * scale, y: (view.y - panes.y + inPage.y) * scale }]);
    expect(Math.abs(shot.width - panes.width * scale)).toBeLessThanOrEqual(2);
    expect(near(shot.colors[0]!, expected)).toBe(true);

    await shell.keyboard.press("Meta+L");
    await expect(input).toBeFocused();
    await input.fill("screenshot");
    await areaRow.click();
    await expect(shell.locator("[data-testid='screenshot-overlay'][data-ready]")).toHaveCount(1);
    // What the area is chosen over is the window without the palette (a JPEG: a little leeway).
    const held = await shell.getByTestId("screenshot-held").evaluate(
      (img: HTMLImageElement, { x, y, scale }) => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(img, 0, 0);
        return [...context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.slice(0, 3)];
      },
      { x: view.x + inPage.x, y: view.y + inPage.y, scale },
    );
    expect(near(held, expected, 8)).toBe(true);
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("screenshot-overlay")).toHaveCount(0);
    await expectNoShot();
  });

  test("⌘⇧2 over the window: the area dragged out is kept; Escape keeps nothing", async () => {
    await shell.keyboard.press("Meta+Shift+Digit2");
    const overlay = shell.locator("[data-testid='screenshot-overlay'][data-ready]");
    await expect(overlay).toHaveCount(1);
    // Across the sidebar and into the page: an area is any part of the window.
    await shell.mouse.move(120, 140);
    await shell.mouse.down();
    await shell.mouse.move(300, 200, { steps: 4 });
    await shell.mouse.move(520, 340, { steps: 4 });
    await expect(shell.getByTestId("screenshot-selection")).toBeVisible();
    await shell.mouse.up();
    await expect(shell.getByTestId("screenshot-overlay")).toHaveCount(0);
    const shot = await readPng(app, await nextShot());
    expect(Math.abs(shot.width - 400 * scale)).toBeLessThanOrEqual(2);
    expect(Math.abs(shot.height - 200 * scale)).toBeLessThanOrEqual(2);

    await shell.keyboard.press("Meta+Shift+Digit2");
    await expect(overlay).toHaveCount(1);
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("screenshot-overlay")).toHaveCount(0);
    await expectNoShot();

    // A right click lets the area go too — the whole click: the row under it opens no menu.
    const row = await box(shell, '[data-testid="sidebar-tab-list"] [role="tab"]');
    await shell.keyboard.press("Meta+Shift+Digit2");
    await expect(overlay).toHaveCount(1);
    await shell.mouse.click(row.x + row.width / 2, row.y + row.height / 2, { button: "right" });
    await expect(shell.getByTestId("screenshot-overlay")).toHaveCount(0);
    await shell.waitForTimeout(300);
    await expect(shell.getByTestId("context-menu")).toHaveCount(0);
    await expectNoShot();
  });

  test("a notice up as ⌘⇧2 is pressed steps aside for the selector: nothing lies over the area being chosen", async () => {
    await shell.keyboard.press("Meta+Shift+Digit1");
    await nextShot();
    await expect.poll(() => chromeViewShown(app, "#notice")).toBe(true);
    await shell.keyboard.press("Meta+Shift+Digit2");
    await expect(shell.locator("[data-testid='screenshot-overlay'][data-ready]")).toHaveCount(1);
    // (The notice lives 8 s: well inside that, so it is the selector that took it down, and gives it back.)
    await expect.poll(() => chromeViewShown(app, "#notice"), { timeout: 1_500 }).toBe(false);
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("screenshot-overlay")).toHaveCount(0);
    await expect.poll(() => chromeViewShown(app, "#notice"), { timeout: 1_500 }).toBe(true);
    await expectNoShot();
  });

  test("the keys reach the shell from inside a page, as main relays them, and the page has the keyboard back after", async () => {
    await watchKeyboard(app, INVOICES);
    try {
      await app.evaluate(({ webContents }, url) => {
        const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
        contents.sendInputEvent({ type: "keyDown", keyCode: "2", modifiers: ["meta", "shift"] });
        contents.sendInputEvent({ type: "keyUp", keyCode: "2", modifiers: ["meta", "shift"] });
      }, INVOICES);
      await expect(shell.locator("[data-testid='screenshot-overlay'][data-ready]")).toHaveCount(1);
      expect((await keyboardGiven(app)).page).toBe(0);
      // A click that never became a drag keeps nothing.
      await shell.mouse.click(600, 400);
      await expect(shell.getByTestId("screenshot-overlay")).toHaveCount(0);
      await expect.poll(async () => (await keyboardGiven(app)).page).toBeGreaterThan(0);
      await expectNoShot();
    } finally {
      await unwatchKeyboard(app, INVOICES);
    }
  });

  test("⌘⇧2, then the window resizes: the held picture no longer lines up with it, so the area is let go", async () => {
    await shell.keyboard.press("Meta+Shift+Digit2");
    await expect(shell.locator("[data-testid='screenshot-overlay'][data-ready]")).toHaveCount(1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1300, 860));
    await expect(shell.getByTestId("screenshot-overlay")).toHaveCount(0);
    await expectNoShot();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
    await expect.poll(() => shell.evaluate(() => [innerWidth, innerHeight])).toEqual([1440, 900]);
  });

  test("⌘⇧2 over a dialog: the area is chosen over the picture it is cut from, and the dialog is as it was after, draft and all", async () => {
    // A second tab, so the tab switcher (main's own gesture, ⌃Tab) has somewhere to go.
    // (Not the vendor page: the Glance below previews that one, and finds its page by its address.)
    const [invoice] = (await openTabs(shell, [INVOICES, `${INVOICES}?second`])) as [string, string];
    await selectTab(shell, invoice);
    await expect.poll(async () => (await liveViews(app)).map((view) => view.url)).toEqual([INVOICES]);
    const dialog = shell.getByTestId("space-fork-dialog");
    await shell.keyboard.press("Meta+Shift+KeyF");
    await expect(dialog).toBeVisible();
    await shell.getByTestId("fork-space-name").fill("Trip");
    await shell.getByTestId("fork-space-purpose").fill("Plan the week");
    await shell.getByTestId("fork-space-name").focus();
    await shell.keyboard.press("Meta+Shift+Digit2");
    await expect(shell.locator("[data-testid='screenshot-overlay'][data-ready]")).toHaveCount(1);
    // Under the selector is main's picture of the window, the dialog and all, pixel for pixel.
    const held = shell.getByTestId("screenshot-held");
    await expect(held).toBeVisible();
    const size = await held.evaluate((img: HTMLImageElement) => ({ width: img.naturalWidth, height: img.naturalHeight, innerWidth, innerHeight }));
    expect(size.width).toBe(Math.round(size.innerWidth * scale));
    expect(size.height).toBe(Math.round(size.innerHeight * scale));
    // A native gesture main reads before any page does (⌃Tab, the tab switcher) is the selector's too: nothing opens under it.
    const strike = (keys: ReadonlyArray<{ type: "keyDown" | "keyUp"; keyCode: string; modifiers?: Array<"control"> }>): Promise<void> =>
      app.evaluate(({ BrowserWindow }, keys) => {
        const contents = BrowserWindow.getAllWindows()[0]!.webContents;
        for (const key of keys) contents.sendInputEvent(key);
      }, keys);
    await strike([
      { type: "keyDown", keyCode: "Control", modifiers: ["control"] },
      { type: "keyDown", keyCode: "Tab", modifiers: ["control"] },
      { type: "keyUp", keyCode: "Tab", modifiers: ["control"] },
    ]);
    await shell.waitForTimeout(600);
    await expect(shell.getByTestId("tab-switcher")).toHaveCount(0);
    await strike([{ type: "keyUp", keyCode: "Control" }]);
    await shell.waitForTimeout(300);
    await expect(shell.locator("[data-testid='screenshot-overlay'][data-ready]")).toHaveCount(1);
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("screenshot-overlay")).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(shell.getByTestId("fork-space-name")).toHaveValue("Trip");
    await expect(shell.getByTestId("fork-space-purpose")).toHaveValue("Plan the week");
    await expect(shell.getByTestId("fork-space-name")).toBeFocused();
    await expectNoShot();
    await shell.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("⌘⇧2 over a context menu: the selector has every key and press, so the menu is still open after, cancelled or kept", async () => {
    const menu = shell.getByTestId("context-menu");
    const row = shell.locator('[data-testid="sidebar-tab-list"] [role="tab"]').first();
    await row.click({ button: "right" });
    await expect(menu).toBeVisible();
    const overlay = shell.locator("[data-testid='screenshot-overlay'][data-ready]");
    await shell.keyboard.press("Meta+Shift+Digit2");
    await expect(overlay).toHaveCount(1);
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("screenshot-overlay")).toHaveCount(0);
    await expect(menu).toBeVisible();
    await expectNoShot();
    await shell.keyboard.press("Meta+Shift+Digit2");
    await expect(overlay).toHaveCount(1);
    await shell.mouse.move(700, 300);
    await shell.mouse.down();
    await shell.mouse.move(900, 450, { steps: 4 });
    await shell.mouse.up();
    const shot = await readPng(app, await nextShot());
    expect(Math.abs(shot.width - 200 * scale)).toBeLessThanOrEqual(2);
    await expect(menu).toBeVisible();
    await shell.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });

  test("⌘⇧2 pressed in the find bar: the find bar has the keyboard back after", async () => {
    await shell.keyboard.press("Meta+F");
    await expect.poll(() => chromeViewShown(app, "#find")).toBe(true);
    // As watchKeyboard does for a page: the find bar is told it has the keyboard, and its focus() calls are counted.
    await app.evaluate(({ webContents }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().endsWith("#find"))! as Watched & { __given?: number };
      const { isFocused, focus } = contents;
      contents.__given = 0;
      contents.isFocused = () => true;
      contents.focus = () => {
        contents.__given = (contents.__given ?? 0) + 1;
        focus.call(contents);
      };
      contents.__restore = () => {
        contents.isFocused = isFocused;
        contents.focus = focus;
      };
    });
    const given = (): Promise<number> =>
      app.evaluate(({ webContents }) => (webContents.getAllWebContents().find((candidate) => candidate.getURL().endsWith("#find")) as { __given?: number }).__given ?? 0);
    try {
      await shell.keyboard.press("Meta+Shift+Digit2");
      await expect(shell.locator("[data-testid='screenshot-overlay'][data-ready]")).toHaveCount(1);
      await expect.poll(() => chromeViewShown(app, "#find")).toBe(false);
      // (Counted from here: the find bar took the keyboard as it opened.)
      const before = await given();
      await shell.keyboard.press("Escape");
      await expect(shell.getByTestId("screenshot-overlay")).toHaveCount(0);
      await expect.poll(() => chromeViewShown(app, "#find")).toBe(true);
      await expect.poll(given).toBeGreaterThan(before);
    } finally {
      await app.evaluate(({ webContents }) => {
        (webContents.getAllWebContents().find((candidate) => candidate.getURL().endsWith("#find")) as Watched | undefined)?.__restore?.();
      });
    }
    await (await findPage(app)).keyboard.press("Escape");
    await expect.poll(() => chromeViewShown(app, "#find")).toBe(false);
  });

  test("⌘⇧2 pressed in a Glance: the preview has the keyboard back after", async () => {
    const preview = "pistachio://demo/vendors/atlas-medical";
    await (await pageAt(app, INVOICES)).locator("#vendor-record-link").click({ modifiers: ["Alt"] });
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();
    await expect.poll(async () => (await liveViews(app)).map((view) => view.url)).toEqual([preview]);
    await watchKeyboard(app, preview);
    try {
      await app.evaluate(({ webContents }, url) => {
        const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
        contents.sendInputEvent({ type: "keyDown", keyCode: "2", modifiers: ["meta", "shift"] });
        contents.sendInputEvent({ type: "keyUp", keyCode: "2", modifiers: ["meta", "shift"] });
      }, preview);
      await expect(shell.locator("[data-testid='screenshot-overlay'][data-ready]")).toHaveCount(1);
      expect((await keyboardGiven(app)).page).toBe(0);
      await shell.keyboard.press("Escape");
      await expect(shell.getByTestId("screenshot-overlay")).toHaveCount(0);
      await expect.poll(async () => (await keyboardGiven(app)).page).toBeGreaterThan(0);
    } finally {
      await unwatchKeyboard(app, preview);
    }
    await (await pageAt(app, preview)).keyboard.press("Escape");
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    await expect.poll(async () => (await liveViews(app)).map((view) => view.url)).toEqual([INVOICES]);
  });

  test("⌘⇧1 on another space's desk keeps the whole desk, without its Bar", async () => {
    const [invoice] = (await openTabs(shell, [INVOICES])) as [string];
    await createGroup(shell, "shot-desk", [invoice], "Northstar", "blue");
    await selectTab(shell, invoice);
    await selectSpace(shell, "shot-desk");
    await settled(shell, app);
    const stage: Box = await box(shell, ".desk-stage");
    const nub = await box(shell, "[data-testid='desk-nub']");
    // A space of one tab, never on a desk before: its window comes up filling the desk, its page under the Bar's nub in the trailing corner.
    const view = (await liveViews(app)).find((candidate) => candidate.url === INVOICES)!.bounds;
    const under = { x: nub.x + nub.width * 0.4, y: nub.y + nub.height * 0.4 };
    expect(under.y).toBeLessThan(view.y + view.height - 4);
    await shell.keyboard.press("Meta+Shift+Digit1");
    const shot = await readPng(app, await nextShot(), [{ x: (under.x - stage.x) * scale, y: (under.y - stage.y) * scale }]);
    expect(Math.abs(shot.width - stage.width * scale)).toBeLessThanOrEqual(2);
    expect(Math.abs(shot.height - stage.height * scale)).toBeLessThanOrEqual(2);
    // Where the nub was is the page under it.
    expect(near(shot.colors[0]!, await pageColor(app, INVOICES, { x: under.x - view.x, y: under.y - view.y }))).toBe(true);
    // And the Bar is back.
    await expect(shell.getByTestId("desk-bar-lane")).toBeVisible();

    // An area of the desk: its window gives way to its picture under the overlay, and is live again after.
    await shell.keyboard.press("Meta+Shift+Digit2");
    await expect(shell.locator("[data-testid='screenshot-overlay'][data-ready]")).toHaveCount(1);
    await shell.mouse.move(stage.x + 100, stage.y + 100);
    await shell.mouse.down();
    await shell.mouse.move(stage.x + 400, stage.y + 250, { steps: 4 });
    await shell.mouse.up();
    const area = await readPng(app, await nextShot());
    expect(Math.abs(area.width - 300 * scale)).toBeLessThanOrEqual(2);
    expect(Math.abs(area.height - 150 * scale)).toBeLessThanOrEqual(2);
    await expect.poll(async () => (await liveViews(app)).some((candidate) => candidate.url === INVOICES)).toBe(true);

    // Over the mask selector: the Escape that lets the area go (a real key, as main reads every view's keys for the
    // desk) leaves the mask being chosen.
    await fromFrameMenu(shell, windowSelector(invoice), "desk-mask");
    const maskSelector = shell.locator(`${windowSelector(invoice)} [data-testid="desk-mask-selector"]`);
    await expect(maskSelector).toBeVisible();
    await shell.keyboard.press("Meta+Shift+Digit2");
    await expect(shell.locator("[data-testid='screenshot-overlay'][data-ready]")).toHaveCount(1);
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      contents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      contents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    });
    await expect(shell.getByTestId("screenshot-overlay")).toHaveCount(0);
    await shell.waitForTimeout(300);
    await expect(maskSelector).toBeVisible();
    await shell.keyboard.press("Escape");
    await expect(maskSelector).toHaveCount(0);
  });
});

test("⌘⇧1 with a page in HTML fullscreen keeps the whole page, not the window it left", { tag: ["@screenshot", "@media"] }, async () => {
  test.setTimeout(60_000);
  const url = "pistachio://demo/invoices?fullscreen";
  const folder = await mkdtemp(join(tmpdir(), "pistachio-screenshots-"));
  const { app } = await launchApp({ settings: { layout: { sidebar: "pinned" } }, name: "screenshot-fullscreen", env: { PISTACHIO_SCREENSHOT_DIR: folder } });
  try {
    const shell = await shellReady(app);
    await shell.evaluate((address) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(address), url);
    const page = await pageAt(app, url);
    // A player's ⛶ button: requestFullscreen from a real click.
    await page.evaluate(() => {
      const button = document.createElement("button");
      button.id = "go-fullscreen";
      button.textContent = "Fullscreen";
      button.addEventListener("click", () => void document.documentElement.requestFullscreen());
      document.body.prepend(button);
    });
    await page.locator("#go-fullscreen").click();
    const content = (): Promise<{ width: number; height: number; fills: boolean }> =>
      app.evaluate(({ BrowserWindow }, address) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        const { width, height } = window.getContentBounds();
        const view = window.contentView.children.find(
          (child) => "webContents" in child && (child as WebContentsView).webContents.getURL() === address,
        ) as WebContentsView | undefined;
        const bounds = view?.getBounds();
        return { width, height, fills: bounds !== undefined && bounds.x === 0 && bounds.y === 0 && bounds.width === width && bounds.height === height };
      }, url);
    await expect.poll(async () => (await content()).fills, { timeout: 15_000 }).toBe(true);
    const { width, height } = await content();
    await shell.keyboard.press("Meta+Shift+Digit1");
    let saved: string[] = [];
    await expect.poll(async () => (saved = await readdir(folder)).length).toBe(1);
    const scale = await scaleOf(app);
    const shot = await readPng(app, join(folder, saved[0]!));
    expect(Math.abs(shot.width - width * scale)).toBeLessThanOrEqual(2);
    expect(Math.abs(shot.height - height * scale)).toBeLessThanOrEqual(2);

    // ⌘⇧2 over it, pressed in the page: the selector leaves the page fullscreen (another overlay would end it,
    // and the window's resize would let the area go) and has the keyboard while it is up, the area is kept, and
    // the page is still fullscreen, with the keyboard back, after.
    await watchKeyboard(app, url);
    await app.evaluate(({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
      contents.sendInputEvent({ type: "keyDown", keyCode: "2", modifiers: ["meta", "shift"] });
      contents.sendInputEvent({ type: "keyUp", keyCode: "2", modifiers: ["meta", "shift"] });
    }, url);
    const overlay = shell.locator("[data-testid='screenshot-overlay'][data-ready]");
    await expect(overlay).toHaveCount(1);
    await expect.poll(async () => (await keyboardGiven(app)).shell).toBeGreaterThan(0);
    expect((await keyboardGiven(app)).page).toBe(0);
    await shell.waitForTimeout(1_000);
    await expect(overlay).toHaveCount(1);
    await shell.mouse.move(200, 150);
    await shell.mouse.down();
    await shell.mouse.move(500, 350, { steps: 4 });
    await shell.mouse.up();
    await expect.poll(async () => (saved = await readdir(folder)).length).toBe(2);
    const area = await readPng(app, join(folder, saved.find((name) => name.includes("(2)")) ?? saved.sort().at(-1)!));
    expect(Math.abs(area.width - 300 * scale)).toBeLessThanOrEqual(2);
    expect(Math.abs(area.height - 200 * scale)).toBeLessThanOrEqual(2);
    await expect.poll(async () => (await content()).fills).toBe(true);
    expect(await page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
    await expect.poll(async () => (await keyboardGiven(app)).page).toBeGreaterThan(0);
    await unwatchKeyboard(app, url);
    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFullScreen()), { timeout: 15_000 }).toBe(false);
  } finally {
    await app.close();
  }
});
