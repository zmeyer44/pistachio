import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { KeyboardInputEvent, WebContents, WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage, shellReady } from "./windows";
import { captureEnabled, launchApp } from "./app";
import { openAlone, pageAt, pick } from "./pages-harness";
import { api, createGroup, launchDesk, liveViews, openTabs, reachFrame, selectSpace, selectTab, settled, snapshot, tabGroupCommand, windowSelector } from "./desk-harness";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/glance");
const OWNER_URL = "pistachio://demo/invoices";
const PREVIEW_URL = "pistachio://demo/vendors/atlas-medical";
/** Another tab: the same portal at another address, its link to Glance from too. */
const OTHER_URL = "pistachio://demo/invoices?page=north";
/** A new tab made while a Glance is up. */
const NEW_URL = "pistachio://demo/invoices?page=south";

function tabViews(app: ElectronApplication): Promise<
  Array<{
    id: number;
    url: string;
    visible: boolean;
    bounds: { x: number; y: number; width: number; height: number };
  }>
> {
  return app.evaluate(({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return window.contentView.children.flatMap((child) => {
      if (!("webContents" in child) || !("getVisible" in child)) return [];
      const view = child as WebContentsView;
      const url = view.webContents.getURL();
      if (Object.values(hashes).some((hash) => url.endsWith(hash))) return [];
      return [{ id: view.webContents.id, url, visible: view.getVisible(), bounds: view.getBounds() }];
    });
  }, CHROME_VIEW_HASHES);
}

function shellSnapshot(shell: Page) {
  return shell.evaluate(async () => {
    const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
    const snapshot = await api.getSnapshot();
    return {
      tabs: snapshot.tabs.map(({ id, url, anchorId }) => ({ id, url, anchorId })),
      activeTabId: snapshot.activeTabId,
      secondaryTabId: snapshot.secondaryTabId,
      splitMode: snapshot.splitMode,
    };
  });
}

interface WindowCapture {
  shell: string;
  width: number;
  height: number;
  scale: number;
  views: Array<{ bounds: { x: number; y: number }; png: string }>;
}

/** Capture the shell and composite every visible native view in stacking order. */
async function captureWindow(app: ElectronApplication, filename: string): Promise<void> {
  if (!captureEnabled) return;
  const capture = await app.evaluate(async ({ BrowserWindow }): Promise<WindowCapture> => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    const shell = await window.capturePage();
    const size = shell.getSize();
    const [contentWidth] = window.getContentSize();
    const views = await Promise.all(
      window.contentView.children.flatMap((child) => {
        if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) return [];
        const view = child as WebContentsView;
        return [
          view.webContents.capturePage().then((image) => ({
            bounds: view.getBounds(),
            png: image.toPNG().toString("base64"),
          })),
        ];
      }),
    );
    return {
      shell: shell.toPNG().toString("base64"),
      width: size.width,
      height: size.height,
      scale: contentWidth === undefined || contentWidth === 0 ? 1 : size.width / contentWidth,
      views,
    };
  });
  const shell = await shellPage(app);
  const dataUrl = await shell.evaluate(async ({ shell: frame, width, height, scale, views }: WindowCapture) => {
    const decode = (png: string): Promise<HTMLImageElement> =>
      new Promise((resolveImage, reject) => {
        const image = new Image();
        image.onload = () => resolveImage(image);
        image.onerror = () => reject(new Error("capture failed to decode"));
        image.src = `data:image/png;base64,${png}`;
      });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2d canvas context");
    context.drawImage(await decode(frame), 0, 0);
    for (const view of views) {
      context.drawImage(
        await decode(view.png),
        Math.round(view.bounds.x * scale),
        Math.round(view.bounds.y * scale),
      );
    }
    return canvas.toDataURL("image/png");
  }, capture);
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(
    join(screenshotDirectory, filename),
    Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"),
  );
}

/** The native page views main shows, bottom to top. */
async function shownViews(app: ElectronApplication) {
  return (await tabViews(app)).filter(({ visible }) => visible);
}

/** A mark the page in this view was given and how far it is scrolled, read from main: kept only by a page never reloaded. */
function pageState(app: ElectronApplication, id: number): Promise<{ mark: string | null; scrollY: number } | null> {
  return app.evaluate(async ({ webContents }, contentsId) => {
    const contents = webContents.fromId(contentsId);
    if (contents === undefined || contents.isDestroyed()) return null;
    return (await contents.executeJavaScript("({ mark: window.glanceMark ?? null, scrollY: window.scrollY })")) as { mark: string | null; scrollY: number };
  }, id);
}

/** The colour at the middle of a still (a data URL), decoded in the shell. */
function stillMiddle(shell: Page, dataUrl: string): Promise<[number, number, number]> {
  return shell.evaluate(async (src) => {
    const image = new Image();
    image.src = src;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2d canvas context");
    context.drawImage(image, 0, 0);
    const [r = 0, g = 0, b = 0] = context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
    return [r, g, b] as [number, number, number];
  }, dataUrl);
}

const isRed = ([r, g, b]: [number, number, number]): boolean => r > 200 && g < 80 && b < 80;

/** A view's key: its contents' id, or the shell's. */
type ViewKey = number | "shell";

interface KeyboardModel {
  holder: ViewKey;
  given: Record<string, number>;
  restore: Array<() => void>;
}

/**
 * Who has the keyboard, as main hands it over: these views' focus() and isFocused() follow one holder — the screen may
 * be locked, where no view really takes it — and each hand-over is counted, by the view's key.
 */
function modelKeyboard(app: ElectronApplication, ids: number[], holder: ViewKey): Promise<void> {
  return app.evaluate(({ BrowserWindow, webContents }, { ids, holder }) => {
    const model: KeyboardModel = { holder, given: {}, restore: [] };
    (globalThis as { __keyboardModel?: KeyboardModel }).__keyboardModel = model;
    const watch = (contents: WebContents, key: ViewKey): void => {
      const { focus, isFocused } = contents;
      contents.focus = () => {
        model.holder = key;
        model.given[String(key)] = (model.given[String(key)] ?? 0) + 1;
        focus.call(contents);
      };
      contents.isFocused = () => model.holder === key;
      model.restore.push(() => {
        contents.focus = focus;
        contents.isFocused = isFocused;
      });
    };
    watch(BrowserWindow.getAllWindows()[0]!.webContents, "shell");
    for (const id of ids) {
      const contents = webContents.fromId(id);
      if (contents === undefined) throw new Error(`no contents ${String(id)}`);
      watch(contents, id);
    }
  }, { ids, holder });
}

function keyboardModel(app: ElectronApplication): Promise<{ holder: ViewKey; given: Record<string, number> }> {
  return app.evaluate(() => {
    const model = (globalThis as { __keyboardModel?: KeyboardModel }).__keyboardModel!;
    return { holder: model.holder, given: { ...model.given } };
  });
}

/** The person put the keyboard elsewhere themselves (a press in the shell, say). */
function setKeyboardHolder(app: ElectronApplication, holder: ViewKey): Promise<void> {
  return app.evaluate((_electron, holder) => {
    (globalThis as { __keyboardModel?: KeyboardModel }).__keyboardModel!.holder = holder;
  }, holder);
}

function unmodelKeyboard(app: ElectronApplication): Promise<void> {
  return app.evaluate(() => {
    const model = (globalThis as { __keyboardModel?: KeyboardModel }).__keyboardModel;
    for (const restore of model?.restore ?? []) restore();
    delete (globalThis as { __keyboardModel?: KeyboardModel }).__keyboardModel;
  });
}

/** Native key events into one view, through the before-input-event path a real keyboard takes (tab-switcher.spec.ts). */
function sendKeys(app: ElectronApplication, target: ViewKey, inputs: KeyboardInputEvent[]): Promise<void> {
  return app.evaluate(({ BrowserWindow, webContents }, { target, inputs }) => {
    const contents = target === "shell" ? BrowserWindow.getAllWindows()[0]?.webContents : webContents.fromId(target);
    if (contents === undefined) throw new Error(`no view ${String(target)}`);
    for (const input of inputs) contents.sendInputEvent(input);
  }, { target, inputs });
}

async function openGlance(owner: Page, shell: Page, app: ElectronApplication): Promise<Page> {
  await owner.locator("#vendor-record-link").click({ modifiers: ["Alt"] });
  await expect(shell.getByTestId("glance-overlay")).toBeVisible();
  await expect.poll(async () => (await tabViews(app)).filter(({ visible }) => visible)).toEqual([
    expect.objectContaining({ url: PREVIEW_URL, visible: true }),
  ]);
  return pageAt(app, PREVIEW_URL);
}

// One window. Each test starts from the demo page as the window's only tab.
test.describe.serial("Glance", { tag: ["@glance"] }, () => {
  test.describe.configure({ timeout: 45_000 });
  let app: ElectronApplication;
  let shell: Page;

  /** The app starts on the home page; each test wants the demo page as its ONLY tab, no Glance up. */
  async function ownerAlone(): Promise<void> {
    await openAlone(shell, OWNER_URL);
    await expect.poll(async () => (await shellSnapshot(shell)).tabs.map(({ url }) => url)).toEqual([OWNER_URL]);
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
  }

  test.beforeAll(async () => {
    ({ app } = await launchApp({
      settings: { layout: { sidebar: "pinned" }, general: { consoleOpenOnLaunch: false } },
      name: "glance",
      // Its pages are clicked by Playwright beside another window, which Fit zooms out: Playwright's own click geometry
      // misses on a page under device emulation (a person's press is mapped), so every page is at its own size.
      deskFeel: { zoom: "actual" },
    }));
    shell = await shellReady(app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("Glance previews a link, dismisses, is taken in filling the desk, and as a tile beside its window", { tag: ["@smoke"] }, async () => {
    await ownerAlone();
    const owner = await pageAt(app, OWNER_URL);
    await expect(owner.locator("#vendor-record-link")).toBeVisible();

    // The modifier gesture must recess the owner and show one ephemeral live page, not create a tab.
    let preview = await openGlance(owner, shell, app);
    await expect(shell.getByTestId("glance-close")).toBeVisible();
    await expect(shell.getByTestId("glance-promote")).toBeVisible();
    // On the desk, a tile beside its window in place of the web's split.
    await expect(shell.getByTestId("glance-tile")).toBeVisible();
    await expect(shell.getByTestId("glance-split")).toHaveCount(0);
    expect((await shellSnapshot(shell)).tabs).toHaveLength(1);
    await captureWindow(app, "01-link-preview.png");

    // A focused field is protected: the first Escape asks for confirmation instead of discarding an edit.
    await preview.evaluate(() => {
      const input = document.createElement("input");
      input.setAttribute("aria-label", "Unsaved preview field");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.focus();
    });
    await preview.keyboard.press("Escape");
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();
    const confirmButton = shell.getByTestId("glance-close");
    await expect(confirmButton).toHaveAttribute("data-confirm", "");
    await confirmButton.evaluate(async (button) => {
      await Promise.all(button.getAnimations().map((animation) => animation.finished));
    });
    expect(
      await confirmButton.evaluate((button) => ({
        background: getComputedStyle(button).backgroundColor,
        color: getComputedStyle(button).color,
      })),
    ).toEqual({ background: "rgb(220, 53, 69)", color: "rgb(255, 255, 255)" });
    await captureWindow(app, "02-focused-field-confirmation.png");

    // A confirmed Escape inside the native preview runs the reverse motion and restores its owner.
    await preview.keyboard.press("Escape");
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    await expect.poll(async () => (await tabViews(app)).filter(({ visible }) => visible)).toEqual([
      expect.objectContaining({ url: OWNER_URL, visible: true }),
    ]);
    await captureWindow(app, "03-dismissed-to-owner.png");

    // Taken in — filling the desk — it must reuse the exact preview webContents, preserving in-page state without a reload.
    preview = await openGlance(owner, shell, app);
    await preview.evaluate(() => sessionStorage.setItem("glance-preserved", "yes"));
    const previewView = (await tabViews(app)).find(({ url }) => url === PREVIEW_URL);
    if (previewView === undefined) throw new Error("Glance view is unavailable");
    const glanceFrame = shell.locator(".glance-frame");
    const previewBox = await glanceFrame.boundingBox();
    if (previewBox === null) throw new Error("Glance frame is unavailable");
    // Where it lands: the whole desk (its window filling it, the Drawer in, the page the window's whole box).
    const fullTabBounds = await shell.locator(".desk-stage").evaluate((stage) => {
      const rect = stage.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    });
    await shell.getByTestId("glance-promote").click();
    await expect(glanceFrame).toHaveAttribute("data-flight", "promote");
    await expect(glanceFrame.locator(".glance-frame-page > img")).toHaveCount(0);
    // Hold the CSS animation halfway so the test can inspect the handoff. The
    // exact same native view stays visible and follows the growing frame.
    await glanceFrame.evaluate((element) => {
      const animation = element.getAnimations()[0];
      if (animation === undefined) throw new Error("Promotion animation did not start");
      animation.pause();
      const duration = Number(animation.effect?.getTiming().duration ?? 0);
      animation.currentTime = duration / 2;
    });
    const midpointBox = await glanceFrame.boundingBox();
    if (midpointBox === null) throw new Error("Promoting frame is unavailable");
    expect(midpointBox.width).toBeGreaterThan(previewBox.width + 1);
    expect(midpointBox.width).toBeLessThan(fullTabBounds.width - 1);
    await expect.poll(async () =>
      (await tabViews(app)).find(({ id }) => id === previewView.id),
    ).toEqual(expect.objectContaining({
      bounds: {
        x: Math.round(midpointBox.x),
        y: Math.round(midpointBox.y),
        width: Math.round(midpointBox.width),
        height: Math.round(midpointBox.height),
      },
      visible: true,
    }));
    await glanceFrame.evaluate((element) => {
      for (const animation of element.getAnimations()) animation.play();
    });
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    // On top, the desk's whole box: the window it was opened from under it.
    await expect.poll(async () => (await tabViews(app)).filter(({ visible }) => visible).at(-1)).toEqual(
      expect.objectContaining({ id: previewView.id, url: PREVIEW_URL, visible: true }),
    );
    await expect
      .poll(async () => {
        const bounds = (await tabViews(app)).find(({ id }) => id === previewView.id)?.bounds;
        if (bounds === undefined) return "no view";
        const off = Math.max(...(["x", "y", "width", "height"] as const).map((key) => Math.abs(bounds[key] - fullTabBounds[key])));
        return off <= 2 ? "the desk's" : `off by ${String(off)}: ${JSON.stringify(bounds)}`;
      })
      .toBe("the desk's");
    expect(await preview.evaluate(() => sessionStorage.getItem("glance-preserved"))).toBe("yes");
    const promoted = await shellSnapshot(shell);
    expect(promoted.tabs).toHaveLength(2);
    expect(promoted.tabs.find(({ id }) => id === promoted.activeTabId)?.url).toBe(PREVIEW_URL);
    await captureWindow(app, "04-promoted-to-tab.png");

    // Start once more from a single owner so the tile can prove both live pages survive side by side.
    const promotedId = promoted.activeTabId;
    if (promotedId === null) throw new Error("Promoted tab is unavailable");
    await shell.evaluate(async (tabId) => {
      await (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(tabId);
    }, promotedId);
    await expect.poll(async () => (await tabViews(app)).filter(({ visible }) => visible)).toEqual([
      expect.objectContaining({ url: OWNER_URL, visible: true }),
    ]);

    await openGlance(owner, shell, app);
    await shell.getByTestId("glance-tile").click();
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    await expect.poll(async () => (await tabViews(app)).filter(({ visible }) => visible).length).toBe(2);
    const tiled = await shellSnapshot(shell);
    // Two windows on the desk, not a split: there are none on the desktop.
    expect(tiled.splitMode).toBe("single");
    expect(tiled.tabs.map(({ url }) => url)).toEqual([OWNER_URL, PREVIEW_URL]);
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await captureWindow(app, "05-taken-in-as-a-tile.png");
    // A second window on a Home tab: the two grown into a space made for the person, as its row's + grows it — and
    // back to Home with the preview closed (docs/double-sidebar.md §1, "And back").
    const [ownerTab, tileTab] = tiled.tabs.map(({ id }) => id) as [string, string];
    const spaceOfOwner = () =>
      shell.evaluate(async (tabId) => {
        const snapshot = await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot();
        const group = snapshot.tabGroups.find((candidate) => candidate.tabIds.includes(tabId));
        return group === undefined ? null : { origin: group.origin, grown: group.grown === true, tabIds: group.tabIds };
      }, ownerTab);
    await expect.poll(spaceOfOwner).toEqual({ origin: "auto", grown: true, tabIds: [ownerTab, tileTab] });
    await shell.evaluate(async (tabId) => {
      await (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(tabId);
    }, tileTab);
    await expect.poll(spaceOfOwner).toBe(null);
  });

  test("a new-tab link automatically Glances from a favorite tab only", async () => {
    await ownerAlone();
    const owner = await pageAt(app, OWNER_URL);
    const sidebar = shell.getByTestId("sidebar-chrome");
    await expect(sidebar).toBeVisible();
    await expect(owner.locator("#vendor-record-link")).toBeVisible();

    // Binding the current page to the favorites grid enables automatic
    // Glance in its isolated preload without navigating or recreating it.
    const dayTab = sidebar.getByTestId("sidebar-tab-list").getByTestId("human-tab").first();
    await pick(shell, dayTab, "Add to favorites");
    const favorite = sidebar.getByTestId("favorite-tile");
    await expect(favorite).toHaveCount(1);
    await expect(favorite).toHaveAttribute("data-live", "");
    await expect.poll(async () => (await shellSnapshot(shell)).tabs[0]?.anchorId).not.toBeNull();

    // A same-tab link must still navigate in place even though its owner is a
    // favorite; only navigation that would create a tab is intercepted.
    await owner.locator("#vendor-record-link").evaluate((link) => link.removeAttribute("target"));
    await owner.locator("#vendor-record-link").click();
    await expect.poll(() => owner.url()).toBe(PREVIEW_URL);
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    expect((await shellSnapshot(shell)).tabs).toHaveLength(1);
    await captureWindow(app, "06-favorite-same-tab-navigation.png");

    // Returning reloads the fixture's _blank target and preserves the same
    // favorite binding, ready for the automatic Glance branch.
    await owner.goBack();
    await expect.poll(() => owner.url()).toBe(OWNER_URL);
    await expect(owner.locator("#vendor-record-link")).toHaveAttribute("target", "_blank");
    await expect.poll(async () => (await shellSnapshot(shell)).tabs[0]?.anchorId).not.toBeNull();

    // A same-tab link to ANOTHER site is treated like a new-tab link: the
    // favorite keeps its page and the other site opens as a Glance.
    await owner.locator("#vendor-record-link").evaluate((link) => {
      link.removeAttribute("target");
      link.setAttribute("href", "pistachio://reminders/");
    });
    await owner.locator("#vendor-record-link").click();
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();
    expect(owner.url()).toBe(OWNER_URL);
    expect((await shellSnapshot(shell)).tabs).toHaveLength(1);
    await (await pageAt(app, "pistachio://reminders/")).keyboard.press("Escape");
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    expect(owner.url()).toBe(OWNER_URL);
    await owner.reload();
    await expect(owner.locator("#vendor-record-link")).toHaveAttribute("target", "_blank");
    await expect.poll(async () => (await shellSnapshot(shell)).tabs[0]?.anchorId).not.toBeNull();

    // No modifier: the existing Glance UI replaces the otherwise-new tab,
    // while the favorite remains the owner and keeps its original URL.
    await owner.locator("#vendor-record-link").click();
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();
    await expect(shell.getByTestId("glance-close")).toBeVisible();
    await expect(shell.getByTestId("glance-promote")).toBeVisible();
    await expect(shell.getByTestId("glance-tile")).toBeVisible();
    const glancedFavicon = favorite.getByTestId("favorite-glance-favicon");
    await expect(glancedFavicon).toBeVisible();
    await expect(glancedFavicon).toHaveAttribute("aria-label", /Glancing Atlas Medical Supply/);
    await expect(glancedFavicon.locator("img")).toBeVisible();
    expect((await shellSnapshot(shell)).tabs).toHaveLength(1);
    expect(owner.url()).toBe(OWNER_URL);
    const preview = await pageAt(app, PREVIEW_URL);
    await expect.poll(async () => (await tabViews(app)).filter(({ visible }) => visible)).toEqual([
      expect.objectContaining({ url: PREVIEW_URL, visible: true }),
    ]);
    await captureWindow(app, "07-automatic-from-favorite-new-tab-link.png");

    // Escape returns directly to the favorite without changing its URL.
    await preview.keyboard.press("Escape");
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    await expect(favorite.getByTestId("favorite-glance-favicon")).toHaveCount(0);
    await expect.poll(async () => (await tabViews(app)).filter(({ visible }) => visible)).toEqual([
      expect.objectContaining({ url: OWNER_URL, visible: true }),
    ]);
    expect(owner.url()).toBe(OWNER_URL);
    await captureWindow(app, "08-automatic-dismissed-to-favorite.png");

    // Once the shelf binding is removed, the same _blank link creates a
    // regular tab. Automatic Glance never leaks into day tabs.
    await pick(shell, favorite, "Remove from favorites");
    await expect.poll(async () => (await shellSnapshot(shell)).tabs[0]?.anchorId).toBeNull();
    await owner.locator("#vendor-record-link").click();
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    await expect.poll(async () => (await shellSnapshot(shell)).tabs).toHaveLength(2);
    expect(owner.url()).toBe(OWNER_URL);
    await pageAt(app, PREVIEW_URL);
    await captureWindow(app, "09-new-tab-link-after-unfavorite.png");
  });

  test("a modifier click on a script-navigating control Glances its window.open", async () => {
    await ownerAlone();
    const owner = await pageAt(app, OWNER_URL);
    const button = owner.locator("#vendor-record-open");
    await expect(button).toBeVisible();

    // The button carries no href; its click handler calls window.open. The
    // modifier still means "preview": the intent recorded on the trusted
    // click turns that window into a Glance, and no tab is created.
    await button.click({ modifiers: ["Alt"] });
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();
    await expect.poll(async () => (await tabViews(app)).filter(({ visible }) => visible)).toEqual([
      expect.objectContaining({ url: PREVIEW_URL, visible: true }),
    ]);
    expect((await shellSnapshot(shell)).tabs).toHaveLength(1);
    await captureWindow(app, "06-script-open-preview.png");

    // Dismissing restores the owner alone.
    const preview = await pageAt(app, PREVIEW_URL);
    await preview.keyboard.press("Escape");
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    await expect.poll(async () => (await tabViews(app)).filter(({ visible }) => visible)).toEqual([
      expect.objectContaining({ url: OWNER_URL, visible: true }),
    ]);

    // Without the modifier the same control opens a tab, exactly as before.
    await button.click();
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    await expect
      .poll(async () => (await shellSnapshot(shell)).tabs.map(({ url }) => url))
      .toEqual([OWNER_URL, PREVIEW_URL]);

    // A synthetic modifier click is not a person's gesture: the page cannot
    // declare intent for itself, so its window.open is never a Glance. It
    // opens a tab like any other, and that tab says main has answered it.
    await owner.evaluate(() => {
      const target = document.querySelector("#vendor-record-open");
      if (target === null) throw new Error("demo button is missing");
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
    });
    await expect
      .poll(async () => (await shellSnapshot(shell)).tabs.map(({ url }) => url))
      .toEqual([OWNER_URL, PREVIEW_URL, PREVIEW_URL]);
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
  });

  test("a new-tab link inside a Glance follows in the same Glance", async () => {
    await ownerAlone();
    const owner = await pageAt(app, OWNER_URL);
    await expect(owner.locator("#vendor-record-link")).toBeVisible();

    const preview = await openGlance(owner, shell, app);
    const previewView = (await tabViews(app)).find(({ url }) => url === PREVIEW_URL);
    if (previewView === undefined) throw new Error("Glance view is unavailable");

    // A tab opened from here would land behind the preview, unseen: the
    // `_blank` link navigates the Glance's own page instead.
    const linkedUrl = `${OWNER_URL}?from=glance-link`;
    await preview.evaluate((href) => {
      const link = document.createElement("a");
      link.id = "glance-blank-link";
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Open invoices";
      document.body.prepend(link);
    }, linkedUrl);
    await preview.locator("#glance-blank-link").click();
    await expect.poll(async () => (await tabViews(app)).filter(({ visible }) => visible)).toEqual([
      expect.objectContaining({ id: previewView.id, url: linkedUrl, visible: true }),
    ]);
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();
    expect((await shellSnapshot(shell)).tabs.map(({ url }) => url)).toEqual([OWNER_URL]);

    // The Glance now shows the portal, whose button opens the vendor record
    // from script: a window.open follows the same rule.
    await preview.locator("#vendor-record-open").click();
    await expect.poll(async () => (await tabViews(app)).filter(({ visible }) => visible)).toEqual([
      expect.objectContaining({ id: previewView.id, url: PREVIEW_URL, visible: true }),
    ]);
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();
    expect((await shellSnapshot(shell)).tabs.map(({ url }) => url)).toEqual([OWNER_URL]);
    await captureWindow(app, "07-blank-link-stays-in-glance.png");
  });

  // A Glance is the tab's it was opened from: another tab chosen, it goes down as its tab's page goes from view — its own
  // page kept, never reloaded — and its tab chosen again, it is back as it was. Each tab has its own; one goes with its tab; taken
  // in, it is an ordinary tab.
  /** Make `tabId` the tab in use, as its row does. */
  async function choose(tabId: string): Promise<void> {
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(id), tabId);
    await expect.poll(async () => (await shellSnapshot(shell)).activeTabId).toBe(tabId);
  }

  /** The owner and another tab (made, then left for the owner, in use with its page up): their ids. */
  async function ownerAndOther(): Promise<{ ownerId: string; otherId: string }> {
    await ownerAlone();
    const ownerId = (await shellSnapshot(shell)).activeTabId;
    if (ownerId === null) throw new Error("the owner's tab is unavailable");
    await shell.evaluate((url) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(url), OTHER_URL);
    await expect
      .poll(async () => {
        const now = await shellSnapshot(shell);
        return now.tabs.find(({ id }) => id === now.activeTabId)?.url ?? null;
      })
      .toBe(OTHER_URL);
    const otherId = (await shellSnapshot(shell)).activeTabId!;
    await choose(ownerId);
    await expect.poll(async () => (await shownViews(app)).map(({ url }) => url)).toEqual([OWNER_URL]);
    return { ownerId, otherId };
  }

  test("a Glance is its tab's: down while another tab is in use, back as it was, and gone with its tab", async () => {
    const { ownerId, otherId } = await ownerAndOther();
    const preview = await openGlance(await pageAt(app, OWNER_URL), shell, app);
    const previewId = (await shownViews(app))[0]!.id;
    await preview.evaluate(() => {
      const room = document.createElement("div");
      room.style.height = "4000px";
      document.body.append(room);
      window.scrollTo(0, 600);
      (window as unknown as { glanceMark?: string }).glanceMark = "the owner's";
    });
    expect(await pageState(app, previewId)).toEqual({ mark: "the owner's", scrollY: 600 });

    // Another tab chosen: the Glance is down with its page — the very view, hidden, not closed.
    await choose(otherId);
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    await expect.poll(async () => (await shownViews(app)).map(({ url }) => url)).toEqual([OTHER_URL]);
    expect((await tabViews(app)).find(({ id }) => id === previewId)).toEqual(expect.objectContaining({ url: PREVIEW_URL, visible: false }));
    expect(await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getGlance())).toBeNull();
    await captureWindow(app, "08-glance-down-with-its-tab.png");

    // Its tab chosen again: the same Glance, as it was — the same page, its mark and its scroll kept, and its card where
    // it was, flying out of no link.
    await shell.evaluate(() => {
      const flights: string[] = [];
      const watch = new MutationObserver(() => {
        for (const frame of document.querySelectorAll(".glance-frame")) flights.push(frame.getAttribute("data-flight") ?? "landed");
      });
      watch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-flight"] });
      (window as unknown as { glanceFlights: { flights: string[]; watch: MutationObserver } }).glanceFlights = { flights, watch };
    });
    await choose(ownerId);
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();
    await expect.poll(() => shownViews(app)).toEqual([expect.objectContaining({ id: previewId, url: PREVIEW_URL, visible: true })]);
    expect(await pageState(app, previewId)).toEqual({ mark: "the owner's", scrollY: 600 });
    const flights = await shell.evaluate(() => {
      const { flights, watch } = (window as unknown as { glanceFlights: { flights: string[]; watch: MutationObserver } }).glanceFlights;
      watch.disconnect();
      return flights;
    });
    expect(flights).toContain("landed");
    expect(flights).not.toContain("in");
    expect((await shellSnapshot(shell)).tabs).toHaveLength(2);
    await captureWindow(app, "09-glance-back-with-its-tab.png");

    // A new tab made in use takes it down as well (until 2026-11-15 the Glance stayed up over it); the owner chosen, back.
    await shell.evaluate((url) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(url), NEW_URL);
    await expect
      .poll(async () => {
        const now = await shellSnapshot(shell);
        return now.tabs.find(({ id }) => id === now.activeTabId)?.url ?? null;
      })
      .toBe(NEW_URL);
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    await expect.poll(async () => (await shownViews(app)).map(({ url }) => url)).toEqual([NEW_URL]);
    const newId = (await shellSnapshot(shell)).activeTabId!;
    await choose(ownerId);
    await expect.poll(async () => (await shownViews(app)).map(({ id }) => id)).toEqual([previewId]);
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(id), newId);
    await expect.poll(async () => (await shellSnapshot(shell)).tabs).toHaveLength(2);
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();

    // The other tab's own Glance, while the owner's is down: each comes back with its own tab.
    await choose(otherId);
    await expect.poll(async () => (await shownViews(app)).map(({ url }) => url)).toEqual([OTHER_URL]);
    await (await pageAt(app, OTHER_URL)).locator("#vendor-record-link").click({ modifiers: ["Alt"] });
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();
    await expect.poll(async () => (await shownViews(app)).map(({ url }) => url)).toEqual([PREVIEW_URL]);
    const otherPreviewId = (await shownViews(app))[0]!.id;
    expect(otherPreviewId).not.toBe(previewId);
    await choose(ownerId);
    await expect.poll(async () => (await shownViews(app)).map(({ id }) => id)).toEqual([previewId]);
    await choose(otherId);
    await expect.poll(async () => (await shownViews(app)).map(({ id }) => id)).toEqual([otherPreviewId]);
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();

    // The owner closed, its Glance goes with it (its page closed); the other tab's stays up.
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(id), ownerId);
    await expect.poll(async () => (await tabViews(app)).some(({ id }) => id === previewId)).toBe(false);
    expect(await pageState(app, previewId)).toBeNull();
    await expect.poll(async () => (await shownViews(app)).map(({ id }) => id)).toEqual([otherPreviewId]);
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();

    // Taken in, a Glance that came back is an ordinary tab: the same page, and nothing over its owner when chosen.
    await expect(shell.getByTestId("glance-promote")).toBeEnabled();
    await shell.getByTestId("glance-promote").click();
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    await expect
      .poll(async () => {
        const now = await shellSnapshot(shell);
        return now.tabs.find(({ id }) => id === now.activeTabId)?.url ?? null;
      })
      .toBe(PREVIEW_URL);
    const promotedId = (await shellSnapshot(shell)).activeTabId!;
    await expect.poll(async () => (await shownViews(app)).at(-1)?.id).toBe(otherPreviewId);
    await choose(otherId);
    await expect.poll(async () => (await shownViews(app)).map(({ url }) => url)).toEqual([OTHER_URL]);
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    await choose(promotedId);
    await expect.poll(async () => (await shownViews(app)).map(({ id }) => id)).toEqual([otherPreviewId]);
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
  });

  /** ⌃Tab from a view, and Return in the switcher: the gesture lands on the tab used before the one in use. */
  async function switchBack(from: ViewKey): Promise<void> {
    // (A key sent to a page still loading can be lost: tab-switcher.spec.ts's focusPage.)
    if (from !== "shell")
      await expect
        .poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)?.isLoading() === false, from))
        .toBe(true);
    await sendKeys(app, from, [
      { type: "keyDown", keyCode: "Control", modifiers: ["control"] },
      { type: "keyDown", keyCode: "Tab", modifiers: ["control"] },
    ]);
    const switcher = shell.getByTestId("tab-switcher");
    await expect(switcher).toHaveAttribute("data-ready", "");
    await sendKeys(app, "shell", [{ type: "keyDown", keyCode: "Return", modifiers: ["control"] }]);
    await expect(switcher).toHaveCount(0);
    await sendKeys(app, "shell", [{ type: "keyUp", keyCode: "Control", modifiers: [] }]);
  }

  /** The owner's, the other tab's and the Glance's views, by their contents' ids. */
  async function viewIds(): Promise<{ ownerView: number; otherView: number; previewView: number }> {
    const views = await tabViews(app);
    const id = (url: string): number => {
      const view = views.find((candidate) => candidate.url === url);
      if (view === undefined) throw new Error(`no view at ${url}`);
      return view.id;
    };
    return { ownerView: id(OWNER_URL), otherView: id(OTHER_URL), previewView: id(PREVIEW_URL) };
  }

  // The keyboard the tab switcher borrowed goes back to the page in front of the tab it lands on, and a Glance up over
  // that tab is that page: never the page receded under it, which the person cannot see.
  test("the tab switcher landing on a tab hands its Glance the keyboard, not the page under it", async () => {
    const { ownerId, otherId } = await ownerAndOther();
    await openGlance(await pageAt(app, OWNER_URL), shell, app);
    const { ownerView, otherView, previewView } = await viewIds();
    // The Glance did not have the keyboard (a press in the shell) as the other tab was chosen.
    await modelKeyboard(app, [ownerView, otherView, previewView], "shell");
    try {
      await choose(otherId);
      await expect.poll(async () => (await shownViews(app)).map(({ url }) => url)).toEqual([OTHER_URL]);
      await setKeyboardHolder(app, otherView);
      await switchBack(otherView);
      await expect.poll(async () => (await shellSnapshot(shell)).activeTabId).toBe(ownerId);
      await expect.poll(async () => (await shownViews(app)).map(({ id }) => id)).toEqual([previewView]);
      await expect.poll(async () => (await keyboardModel(app)).holder).toBe(previewView);
      expect((await keyboardModel(app)).given[String(ownerView)] ?? 0).toBe(0);
    } finally {
      await unmodelKeyboard(app);
    }
  });

  // The switcher takes the keyboard from the Glance before it takes the Glance down with its tab: the Glance had it all
  // the same, and has it back when its tab is chosen again.
  test("a Glance that had the keyboard when the tab switcher took it down with its tab has it back with its tab", async () => {
    const { ownerId, otherId } = await ownerAndOther();
    await openGlance(await pageAt(app, OWNER_URL), shell, app);
    const { ownerView, otherView, previewView } = await viewIds();
    await modelKeyboard(app, [ownerView, otherView, previewView], previewView);
    try {
      await switchBack(previewView);
      await expect.poll(async () => (await shellSnapshot(shell)).activeTabId).toBe(otherId);
      await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
      await choose(ownerId);
      await expect.poll(async () => (await shownViews(app)).map(({ id }) => id)).toEqual([previewView]);
      await expect.poll(async () => (await keyboardModel(app)).holder).toBe(previewView);
      expect((await keyboardModel(app)).given[String(ownerView)] ?? 0).toBe(0);
    } finally {
      await unmodelKeyboard(app);
    }
  });

  // Back with its tab, a Glance stands over the pages as they are now: main takes their pictures afresh, as when it
  // opened, so a page that changed while it was down is not drawn as it was under it.
  test("a Glance back with its tab stands over its page as it is now, not as it was when the Glance opened", async () => {
    const { ownerId, otherId } = await ownerAndOther();
    await openGlance(await pageAt(app, OWNER_URL), shell, app);
    const ownerStill = async (): Promise<string | null> => {
      const glance = await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getGlance());
      return glance?.backgroundStills.find((still) => still.tabId === ownerId)?.dataUrl ?? null;
    };
    const opened = await ownerStill();
    expect(opened).not.toBeNull();
    expect(isRed(await stillMiddle(shell, opened!))).toBe(false);
    await choose(otherId);
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    // The owner's page changes while it is out of sight.
    await app.evaluate(({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
      return contents.executeJavaScript(`(() => {
        const cover = document.createElement("div");
        cover.style.cssText = "position:fixed;inset:0;background:rgb(255,0,0);z-index:2147483647";
        document.body.append(cover);
        return true;
      })()`);
    }, OWNER_URL);
    await choose(ownerId);
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();
    await expect
      .poll(async () => {
        const still = await ownerStill();
        return still === null ? "none" : isRed(await stillMiddle(shell, still)) ? "as it is now" : "as it was";
      })
      .toBe("as it is now");
    // And the window under it is drawn so.
    const drawn = shell.locator(`${windowSelector(ownerId)} [data-testid="desk-window-page"] img`).first();
    await expect.poll(async () => isRed(await stillMiddle(shell, await drawn.evaluate((img) => (img as HTMLImageElement).src)))).toBe(true);
  });

  // A Glance down with its tab is still a page of the person's to the session — a download it begins goes on, judged by
  // its site — but out of their sight: what it asks is refused, and nothing opens from it over the tab they are on.
  test("a Glance down with its tab: a download it begins goes on; it asks nothing and opens nothing over the tab in use", async () => {
    const { otherId } = await ownerAndOther();
    await openGlance(await pageAt(app, OWNER_URL), shell, app);
    const { previewView } = await viewIds();
    const glanceTabId = (await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getGlance()))?.tab.id;
    await choose(otherId);
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    await expect.poll(async () => (await shownViews(app)).map(({ url }) => url)).toEqual([OTHER_URL]);
    const inGlance = (script: string, gesture = false): Promise<unknown> =>
      app.evaluate(({ webContents }, { id, script, gesture }) => webContents.fromId(id)!.executeJavaScript(script, gesture), { id: previewView, script, gesture });

    // A download: saved to the test's own folder (one let go on would otherwise ask where, in a dialog).
    const savePath = test.info().outputPath("glance-download.txt");
    await mkdir(dirname(savePath), { recursive: true });
    await app.evaluate(({ webContents }, { id, savePath }) => {
      webContents.fromId(id)!.session.once("will-download", (_event, item) => item.setSavePath(savePath));
    }, { id: previewView, savePath });
    await inGlance(`(() => {
      const link = document.createElement("a");
      link.href = "data:text/plain,glance";
      link.download = "glance-download.txt";
      document.body.append(link);
      link.click();
      link.remove();
      return true;
    })()`);
    await expect
      .poll(async () => {
        const downloads = await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getDownloads());
        return downloads.find((download) => download.fileName === "glance-download.txt")?.tabId ?? null;
      })
      .toBe(glanceTabId);

    // A permission it asks for is refused at once, never held for a prompt no one would see (the time is what is tested).
    expect(await inGlance(`Promise.race([Notification.requestPermission(), new Promise((resolve) => setTimeout(() => resolve("held"), 3000))])`)).toBe("denied");
    // Nor is a permission check answered for it, even for one its site has (reading the clipboard, allowed by default):
    // some of a page's calls act on a check alone, never asking. The page in use is answered as ever.
    const clipboardRead = `navigator.permissions.query({ name: "clipboard-read" }).then((status) => status.state)`;
    expect(await inGlance(clipboardRead)).toBe("denied");
    expect(await app.evaluate(({ webContents }, { url, script }) => webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.executeJavaScript(script), { url: OTHER_URL, script: clipboardRead })).toBe("granted");

    // A window it opens, with a gesture of its own: no tab comes of it. (No event says nothing happened: one would be
    // made within a beat.)
    await inGlance(`window.open(${JSON.stringify(NEW_URL)}, "_blank"); true`, true);
    await shell.waitForTimeout(800);
    expect((await shellSnapshot(shell)).tabs.map(({ url }) => url)).not.toContain(NEW_URL);
  });

  // Back with its tab, a Glance whose pages cannot be taken afresh (an overlay over the window keeps every page down
  // past the wait for its tab's) keeps the pictures it had: it never stands over an empty backdrop.
  test("a Glance back with its tab keeps the pictures it had when none can be taken afresh", async () => {
    const { ownerId, otherId } = await ownerAndOther();
    await openGlance(await pageAt(app, OWNER_URL), shell, app);
    const stillsOf = async (): Promise<string[] | null> =>
      (await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getGlance()))?.backgroundStills.map(({ tabId }) => tabId) ?? null;
    expect(await stillsOf()).toContain(ownerId);
    await choose(otherId);
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    await shell.evaluate(async () => {
      const pistachio = (window as unknown as { pistachio: PistachioApi }).pistachio;
      await pistachio.prepareOverlay();
      await pistachio.setOverlay(true);
    });
    try {
      await choose(ownerId);
      await expect.poll(stillsOf).not.toBeNull();
      expect(await stillsOf()).toContain(ownerId);
    } finally {
      await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.setOverlay(false));
    }
    await expect.poll(async () => (await shownViews(app)).map(({ url }) => url)).toEqual([PREVIEW_URL]);
  });

  // A Glance being closed is closed, whatever comes between the close asked and its last frame taken: its tab left
  // meanwhile, it is not kept for that tab to bring back.
  test("a Glance closed as its tab is left is not kept for the tab to bring back", async () => {
    const { ownerId, otherId } = await ownerAndOther();
    await openGlance(await pageAt(app, OWNER_URL), shell, app);
    const { previewView } = await viewIds();
    // Main's picture of the closing page is held until the tab has been left.
    await app.evaluate(({ webContents }, id) => {
      const contents = webContents.fromId(id)!;
      const capture = contents.capturePage.bind(contents);
      const hold: { release?: () => void } = {};
      (globalThis as { __captureHold?: typeof hold }).__captureHold = hold;
      contents.capturePage = ((...args: Parameters<typeof capture>) =>
        new Promise((resolve, reject) => {
          // (Its page closed meanwhile, the capture fails, as it would have.)
          hold.release = () => {
            try {
              void capture(...args).then(resolve, reject);
            } catch (error: unknown) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          };
        })) as typeof contents.capturePage;
    }, previewView);
    await shell.getByTestId("glance-close").click();
    await expect.poll(() => app.evaluate(() => (globalThis as { __captureHold?: { release?: () => void } }).__captureHold?.release !== undefined)).toBe(true);
    await choose(otherId);
    await app.evaluate(() => (globalThis as { __captureHold?: { release?: () => void } }).__captureHold?.release?.());
    // Closed for good: its page is gone, and its tab chosen again has no Glance over it.
    await expect.poll(async () => (await tabViews(app)).some(({ id }) => id === previewView)).toBe(false);
    await choose(ownerId);
    await expect.poll(async () => (await shownViews(app)).map(({ url }) => url)).toEqual([OWNER_URL]);
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
  });
});

// On a desk, the window the link was in recedes: under main's picture of it, dimmed, and back — filling the desk, as
// its space came up, and set down on it. (Until 2026-10-12 in each frame, the Title bar's and the Drawer's.) Another
// space chosen, the Glance goes with its window's page, and comes back with it.
test("a Glance from a desk window recedes the desk on the pictures it was opened over, and goes and comes back with its space", { tag: ["@glance", "@desk"] }, async () => {
  test.setTimeout(90_000);
  const { app, shell } = await launchDesk({ name: "glance-desk" });
  try {
    const [invoice, vendor] = (await openTabs(shell, [OWNER_URL, PREVIEW_URL])) as [string, string];
    await createGroup(shell, "glance", [invoice, vendor], "Glance", "blue");
    await selectTab(shell, invoice);
    await selectSpace(shell, "glance");
    await settled(shell, app);
    const stage = shell.locator(".desk-stage");
    const win = shell.locator(windowSelector(invoice));
    const filter = (): Promise<string> => win.evaluate((el) => getComputedStyle(el).filter);
    const glanceOnce = async (label: string): Promise<void> => {
      const owner = await pageAt(app, OWNER_URL);
      await owner.locator("#vendor-record-link").click({ modifiers: ["Alt"] });
      await expect(shell.getByTestId("glance-overlay")).toBeVisible();
      // Every page under it is down; the window shows what main captured as the Glance came up, dimmed.
      await expect(stage).toHaveAttribute("data-glance", "");
      const captured = await api(shell, async (pistachio) => (await pistachio.getGlance())?.backgroundStills.map((still) => [still.tabId, still.dataUrl.length] as const) ?? []);
      const mine = captured.find(([tabId]) => tabId === invoice);
      expect(mine, "the window's page among the pictures main took").toBeDefined();
      const drawn = win.locator('[data-testid="desk-window-page"] img').first();
      await expect.poll(() => drawn.evaluate((img) => (img as HTMLImageElement).src.length)).toBe(mine![1]);
      await expect.poll(filter).toBe("opacity(0.3)");
      await captureWindow(app, `desk-${label}.png`);
      // Gone, the window is back as it was: undimmed, its page live again.
      await shell.keyboard.press("Escape");
      await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
      await expect(stage).not.toHaveAttribute("data-glance", "");
      await expect.poll(filter).toBe("none");
      await expect.poll(async () => (await liveViews(app)).some((view) => view.url === OWNER_URL)).toBe(true);
    };
    // Filling the desk, as its space came up (its tab the one it was on).
    const whole = (await stage.boundingBox())!;
    await expect.poll(async () => Math.round((await win.boundingBox())!.width)).toBe(Math.round(whole.width));
    await glanceOnce("filled");
    // A window set down on the desk (its frame within reach first: its drawer comes out for the pointer).
    await reachFrame(app, shell, invoice);
    await win.getByRole("button", { name: "Restore" }).click();
    await shell.mouse.move(10, 10);
    await settled(shell, app);
    await expect.poll(async () => Math.round((await win.boundingBox())!.width)).toBeLessThan(Math.round(whole.width) - 40);
    await glanceOnce("opened");

    // Another space chosen, the Glance goes down with its window's page (its own kept); its space chosen again, the
    // window it came from back in use, the same Glance is back over the desk.
    const before = new Set((await tabViews(app)).map(({ id }) => id));
    await (await pageAt(app, OWNER_URL)).locator("#vendor-record-link").click({ modifiers: ["Alt"] });
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();
    await expect(stage).toHaveAttribute("data-glance", "");
    const isGlance = ({ id, url }: { id: number; url: string }): boolean => url === PREVIEW_URL && !before.has(id);
    await expect.poll(async () => (await tabViews(app)).some((view) => view.visible && isGlance(view))).toBe(true);
    const glanceView = (await tabViews(app)).find(isGlance)!;
    await tabGroupCommand(shell, { type: "create", id: "elsewhere", tabIds: [], title: "Elsewhere", select: true });
    await expect(shell.locator('.desk-stage[data-phase="open"][data-group-id="elsewhere"]')).toHaveCount(1);
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    await expect(stage).not.toHaveAttribute("data-glance", "");
    expect((await tabViews(app)).find(({ id }) => id === glanceView.id)).toEqual(expect.objectContaining({ visible: false }));
    await selectSpace(shell, "glance");
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(invoice);
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();
    await expect(stage).toHaveAttribute("data-glance", "");
    await expect.poll(async () => (await tabViews(app)).filter(({ visible }) => visible).map(({ id }) => id)).toEqual([glanceView.id]);
    await captureWindow(app, "desk-back-with-its-space.png");
  } finally {
    await app.close();
  }
});

/** Watch, from main, whether the preview's view is up — every few milliseconds, until stopWatchingPreview. */
function watchPreview(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ BrowserWindow }, url) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    const seen: boolean[] = [];
    const timer = setInterval(() => {
      const view = window.contentView.children.find((child) => "webContents" in child && (child as WebContentsView).webContents.getURL() === url);
      seen.push(view !== undefined && view.getVisible());
    }, 4);
    (globalThis as { __previewWatch?: { seen: boolean[]; timer: NodeJS.Timeout } }).__previewWatch = { seen, timer };
  }, PREVIEW_URL);
}

function stopWatchingPreview(app: ElectronApplication): Promise<boolean[]> {
  return app.evaluate(() => {
    const watch = (globalThis as { __previewWatch?: { seen: boolean[]; timer: NodeJS.Timeout } }).__previewWatch;
    if (watch === undefined) return [];
    clearInterval(watch.timer);
    return watch.seen;
  });
}

// Taken in on a desk, a Glance is one of the desk's windows: Fill the desk makes it a window filling the desk, Add as a
// tile a tile beside the window it was opened from (half of it, on a tiled desk). Its page is live throughout — never
// down while its tab joins the group and the desk makes its window where the page landed.
test("a Glance taken in on a desk fills the desk, or takes a tile beside its window, its page up throughout", { tag: ["@glance", "@desk"] }, async () => {
  test.setTimeout(90_000);
  const { app, shell } = await launchDesk({ name: "glance-taken-in" });
  try {
    const [invoice] = (await openTabs(shell, [OWNER_URL])) as [string];
    await createGroup(shell, "glance", [invoice], "Glance", "blue");
    await selectTab(shell, invoice);
    await selectSpace(shell, "glance");
    await settled(shell, app);
    const stage = (await shell.locator(".desk-stage").boundingBox())!;
    const owner = shell.locator(windowSelector(invoice));
    const near = (actual: number, expected: number): void => expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(2);
    // A group of one: its window is the desk.
    await expect.poll(async () => Math.round((await owner.boundingBox())!.width)).toBe(Math.round(stage.width));

    const takeIn = async (action: "glance-promote" | "glance-tile", label: string): Promise<string> => {
      const page = await pageAt(app, OWNER_URL);
      await page.locator("#vendor-record-link").click({ modifiers: ["Alt"] });
      await expect(shell.getByTestId(action)).toBeEnabled();
      await expect(shell.getByTestId("glance-split")).toHaveCount(0);
      await captureWindow(app, `desk-taken-in-${label}-glance.png`);
      await watchPreview(app);
      await shell.getByTestId(action).click();
      await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
      // Its tab joins the desk's group, in use, and its window is out.
      await expect.poll(async () => (await snapshot(shell)).tabs.find((tab) => tab.url === PREVIEW_URL)?.id ?? null).not.toBeNull();
      const tabId = (await snapshot(shell)).tabs.find((tab) => tab.url === PREVIEW_URL)!.id;
      await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === "glance")?.tabIds.includes(tabId)).toBe(true);
      await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(tabId);
      await expect(shell.locator(windowSelector(tabId))).toHaveCount(1);
      await settled(shell, app);
      const seen = await stopWatchingPreview(app);
      expect(seen.length, "samples of the preview's view").toBeGreaterThan(10);
      expect(seen.indexOf(false), "the preview's page went down on the way").toBe(-1);
      await captureWindow(app, `desk-taken-in-${label}.png`);
      return tabId;
    };

    // Filling the desk: the window is the desk, its page the desk's whole box, over the window it came from.
    const filled = await takeIn("glance-promote", "filled");
    const whole = (await shell.locator(windowSelector(filled)).boundingBox())!;
    near(whole.x, stage.x);
    near(whole.y, stage.y);
    near(whole.width, stage.width);
    near(whole.height, stage.height);
    const top = (await liveViews(app)).at(-1)!;
    expect(top.url).toBe(PREVIEW_URL);
    near(top.bounds.x, stage.x);
    near(top.bounds.width, stage.width);
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(id), filled);
    await expect(shell.locator(windowSelector(filled))).toHaveCount(0);
    await settled(shell, app);

    // As a tile, on a desk its window fills: the two halves, the new one beside it.
    const tiled = await takeIn("glance-tile", "tiled");
    const left = (await owner.boundingBox())!;
    const right = (await shell.locator(windowSelector(tiled)).boundingBox())!;
    near(left.x, stage.x);
    near(left.height, stage.height);
    near(right.x + right.width, stage.x + stage.width);
    near(right.height, stage.height);
    near(left.width, right.width);
    expect(right.x).toBeGreaterThan(left.x + left.width);
    const views = await liveViews(app);
    const preview = views.find((view) => view.url === PREVIEW_URL)!;
    near(preview.bounds.x, right.x);
    near(preview.bounds.width, right.width);
    expect(views.some((view) => view.url === OWNER_URL)).toBe(true);
  } finally {
    await app.close();
  }
});
