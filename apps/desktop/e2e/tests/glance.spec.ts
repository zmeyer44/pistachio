import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage, shellReady } from "./windows";
import { captureEnabled, launchApp } from "./app";
import { openAlone, pageAt, pick } from "./pages-harness";
import { api, createGroup, launchDesk, liveViews, openTabs, reachFrame, selectSpace, selectTab, settled, snapshot, windowSelector } from "./desk-harness";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/glance");
const OWNER_URL = "pistachio://demo/invoices";
const PREVIEW_URL = "pistachio://demo/vendors/atlas-medical";

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
});

// On a desk, the window the link was in recedes: under main's picture of it, dimmed, and back — filling the desk, as
// its space came up, and set down on it, in either frame.
for (const chrome of ["bar", "drawer"] as const) {
  test(`a Glance from a desk window (${chrome} frame) recedes the desk on the pictures it was opened over`, { tag: ["@glance", "@desk"] }, async () => {
    test.setTimeout(90_000);
    const { app, shell } = await launchDesk({ name: `glance-${chrome}`, chrome });
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
        await captureWindow(app, `desk-${chrome}-${label}.png`);
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
      // A window set down on the desk (its frame within reach first: a Drawer comes out for the pointer).
      await reachFrame(app, shell, invoice);
      await win.getByRole("button", { name: "Restore" }).click();
      await shell.mouse.move(10, 10);
      await settled(shell, app);
      await expect.poll(async () => Math.round((await win.boundingBox())!.width)).toBeLessThan(Math.round(whole.width) - 40);
      await glanceOnce("opened");
    } finally {
      await app.close();
    }
  });
}

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
  const { app, shell } = await launchDesk({ name: "glance-taken-in", chrome: "drawer" });
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
