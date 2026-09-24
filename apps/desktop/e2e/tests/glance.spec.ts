import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/glance");
const OWNER_URL = "pistachio://demo/invoices";
const PREVIEW_URL = "pistachio://demo/vendors/atlas-medical";

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", executableSuffix),
    resolve(
      process.cwd(),
      "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron",
      executableSuffix,
    ),
  ];
  return candidates.find(
    (candidate) =>
      candidate !== undefined &&
      existsSync(candidate) &&
      existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

/** The app starts on the home page; each test wants the demo page as its ONLY tab. */
async function openOwnerAlone(shell: Page): Promise<void> {
  await shell.evaluate(async (ownerUrl) => {
    const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
    const before = await api.getSnapshot();
    await api.createTab(ownerUrl);
    for (const tab of before.tabs) await api.closeTab(tab.id);
  }, OWNER_URL);
}

async function pageAt(app: ElectronApplication, url: string): Promise<Page> {
  await expect.poll(() => app.windows().some((page) => page.url() === url)).toBe(true);
  const page = app.windows().find((candidate) => candidate.url() === url);
  if (page === undefined) throw new Error(`No Electron page at ${url}`);
  return page;
}

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

/** Pick a shell context-menu action from a tab row or shelf tile. */
async function pick(shell: Page, target: ReturnType<Page["locator"]>, item: string): Promise<void> {
  await target.click({ button: "right" });
  const menu = shell.getByTestId("context-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: item }).click();
  await expect(menu).toHaveCount(0);
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

test("Glance previews a link, dismisses, promotes, and opens in a split", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-glance-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ layout: { mode: "top", sidebar: "pinned" }, general: { consoleOpenOnLaunch: false } }),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    await openOwnerAlone(shell);
    const owner = await pageAt(app, OWNER_URL);
    await shell.waitForLoadState("domcontentloaded");
    await expect(owner.locator("#vendor-record-link")).toBeVisible();

    // The modifier gesture must recess the owner and show one ephemeral live page, not create a tab.
    let preview = await openGlance(owner, shell, app);
    await expect(shell.getByTestId("glance-close")).toBeVisible();
    await expect(shell.getByTestId("glance-promote")).toBeVisible();
    await expect(shell.getByTestId("glance-split")).toBeVisible();
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

    // Promotion must reuse the exact preview webContents, preserving in-page state without a reload.
    preview = await openGlance(owner, shell, app);
    await preview.evaluate(() => sessionStorage.setItem("glance-preserved", "yes"));
    const previewView = (await tabViews(app)).find(({ url }) => url === PREVIEW_URL);
    if (previewView === undefined) throw new Error("Glance view is unavailable");
    const glanceFrame = shell.locator(".glance-frame");
    const previewBox = await glanceFrame.boundingBox();
    if (previewBox === null) throw new Error("Glance frame is unavailable");
    const fullTabBounds = await shell.locator(".browser-pane-grid").evaluate((grid) => {
      const surface = grid.parentElement;
      if (surface === null) throw new Error("Browser surface is unavailable");
      const surfaceRect = surface.getBoundingClientRect();
      const element = grid as HTMLElement;
      return {
        x: Math.round(surfaceRect.left + element.offsetLeft),
        y: Math.round(surfaceRect.top + element.offsetTop),
        width: Math.round(element.offsetWidth),
        height: Math.round(element.offsetHeight),
      };
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
    await expect.poll(async () => (await tabViews(app)).filter(({ visible }) => visible)).toEqual([
      expect.objectContaining({ id: previewView.id, url: PREVIEW_URL, visible: true }),
    ]);
    await expect.poll(async () =>
      (await tabViews(app)).find(({ id }) => id === previewView.id)?.bounds,
    ).toEqual(fullTabBounds);
    expect(await preview.evaluate(() => sessionStorage.getItem("glance-preserved"))).toBe("yes");
    const promoted = await shellSnapshot(shell);
    expect(promoted.tabs).toHaveLength(2);
    expect(promoted.tabs.find(({ id }) => id === promoted.activeTabId)?.url).toBe(PREVIEW_URL);
    await captureWindow(app, "04-promoted-to-tab.png");

    // Start once more from a single owner so the split action can prove both live pages survive side by side.
    const promotedId = promoted.activeTabId;
    if (promotedId === null) throw new Error("Promoted tab is unavailable");
    await shell.evaluate(async (tabId) => {
      await (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(tabId);
    }, promotedId);
    await expect.poll(async () => (await tabViews(app)).filter(({ visible }) => visible)).toEqual([
      expect.objectContaining({ url: OWNER_URL, visible: true }),
    ]);

    await openGlance(owner, shell, app);
    await shell.getByTestId("glance-split").click();
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    await expect.poll(async () => (await tabViews(app)).filter(({ visible }) => visible).length).toBe(2);
    const split = await shellSnapshot(shell);
    expect(split.splitMode).toBe("vertical");
    expect(split.tabs.map(({ url }) => url)).toEqual([OWNER_URL, PREVIEW_URL]);
    await captureWindow(app, "05-promoted-to-split.png");
  } finally {
    await app.close();
  }
});

test("a new-tab link automatically Glances from a favorite tab only", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-automatic-glance-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" }, general: { consoleOpenOnLaunch: false } }),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    await openOwnerAlone(shell);
    const owner = await pageAt(app, OWNER_URL);
    await shell.waitForLoadState("domcontentloaded");
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
    await expect(shell.getByTestId("glance-split")).toBeVisible();
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
  } finally {
    await app.close();
  }
});

test("a modifier click on a script-navigating control Glances its window.open", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-intent-glance-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ layout: { mode: "top", sidebar: "pinned" }, general: { consoleOpenOnLaunch: false } }),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    await openOwnerAlone(shell);
    const owner = await pageAt(app, OWNER_URL);
    await shell.waitForLoadState("domcontentloaded");
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
    // declare intent for itself, so whatever its window.open yields, it is
    // never a Glance.
    await owner.evaluate(() => {
      const target = document.querySelector("#vendor-record-open");
      if (target === null) throw new Error("demo button is missing");
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
    });
    await owner.waitForTimeout(800);
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("a new-tab link inside a Glance follows in the same Glance", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-glance-blank-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ layout: { mode: "top", sidebar: "pinned" }, general: { consoleOpenOnLaunch: false } }),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    await openOwnerAlone(shell);
    const owner = await pageAt(app, OWNER_URL);
    await shell.waitForLoadState("domcontentloaded");
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
  } finally {
    await app.close();
  }
});
