import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { sidebarMenuItem } from "./footer";
import { pageFirst, shellPage, shellReady } from "./windows";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import type { DesktopSettings } from "@pistachio/shell-contracts/settings";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/layout");

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", executableSuffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", executableSuffix),
  ];
  return candidates.find(
    (candidate) =>
      candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

/** capturePage throws UnknownVizError until a view's compositor has its first frame. */
async function withFirstFrame<T>(capture: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await capture();
    } catch (error: unknown) {
      lastError = error;
      await new Promise((done) => setTimeout(done, 150));
    }
  }
  throw lastError;
}

/** One capture of the window: the shell's frame plus every visible child view, in stacking order. */
interface WindowCapture {
  shell: string;
  /** The shell frame's pixel size — capturePage renders at the display's scale. */
  width: number;
  height: number;
  /** Pixels per DIP, so a view's DIP bounds land on the right pixels. */
  scale: number;
  views: Array<{ bounds: { x: number; y: number }; png: string }>;
}

/**
 * The whole window: the shell page with every visible child view composited
 * over it in stacking order — the tab panes and any visible utility view —
 * which a plain shell capture never shows.
 *
 * The compositing happens on a canvas INSIDE the shell page rather than in
 * an image tool on the machine: the test then needs nothing installed
 * beyond the Electron it already drives.
 */
async function captureWindow(app: ElectronApplication, filename: string): Promise<void> {
  // Let the layout's re-arrangement, the page's 140ms fade-in, and the
  // sidebar's 220ms slide settle first.
  await new Promise((done) => setTimeout(done, 400));
  const capture = await withFirstFrame(() =>
    app.evaluate(async ({ BrowserWindow }): Promise<WindowCapture> => {
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
    }),
  );
  const shell = await shellPage(app);
  const dataUrl = await shell.evaluate(async ({ shell: frame, width, height, scale, views }: WindowCapture) => {
    const decode = (png: string): Promise<HTMLImageElement> =>
      new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
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
      context.drawImage(await decode(view.png), Math.round(view.bounds.x * scale), Math.round(view.bounds.y * scale));
    }
    return canvas.toDataURL("image/png");
  }, capture);
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(join(screenshotDirectory, filename), Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
}

/**
 * The window buttons as main has them, and whether a sidebar chrome view
 * exists at all (it must not: the compact sidebar is the shell's own column).
 * Electron exposes no public getter for the buttons' visibility;
 * `_getWindowButtonVisibility` is the internal one its own test suite reads.
 */
function windowState(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    const sidebarView = window.contentView.children.some(
      (child) => "webContents" in child && (child as WebContentsView).webContents.getURL().endsWith("#sidebar"),
    );
    const buttons = (window as unknown as { _getWindowButtonVisibility?: () => boolean })._getWindowButtonVisibility;
    return { sidebarView, windowButtons: buttons?.call(window) ?? null };
  });
}

/**
 * How many TAB views are on screen. A modal raises the chrome over them and
 * lowering must bring them back — even when the lower outruns the raise's
 * pane captures (BrowserController.setOverlay).
 */
function visibleTabViews(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return window.contentView.children.filter((child) => {
      if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) return false;
      const url = (child as WebContentsView).webContents.getURL();
      return !Object.values(hashes).some((hash) => url.endsWith(hash));
    }).length;
  }, CHROME_VIEW_HASHES);
}

/** The strip's tablist — the sidebar's list is the vertical one. */
function tabStrip(shell: Page) {
  return shell.locator('[role="tablist"]:not([aria-orientation="vertical"])');
}

/** Open Settings by key, or by the layout's own control: the strip's button, or the sidebar footer menu's row. */
async function openGeneralSettings(shell: Page, viaButton = false) {
  if (!viaButton) await shell.keyboard.press("Meta+,");
  else if ((await shell.getByTestId("sidebar-chrome").count()) > 0) await (await sidebarMenuItem(shell, "settings-button")).click();
  else await shell.getByTestId("settings-button").click();
  const page = shell.getByTestId("settings-page");
  await expect(page).toBeVisible();
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
  return page;
}

async function storedLayout(userData: string): Promise<DesktopSettings["layout"] | null> {
  try {
    const raw = await readFile(join(userData, "settings.json"), "utf8");
    return (JSON.parse(raw) as DesktopSettings).layout;
  } catch {
    return null;
  }
}

test("the chrome re-arranges between top tabs and the sidebar, pinned and compact, without losing a control", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-layout-"));
  // This transition test begins in the non-default layout so it can exercise
  // top tabs → sidebar → top tabs without coupling the sequence to defaults.
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify(pageFirst({ layout: { mode: "top", sidebar: "pinned" } })),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellReady(app);

    // TOP TABS: the strip holds the tab, its new-tab tail, and trailing cluster.
    await expect(tabStrip(shell)).toBeVisible();
    await expect(shell.getByTestId("human-tab")).toBeVisible();
    await expect(shell.getByTestId("split-toggle")).toBeVisible();
    await expect(shell.getByTestId("agent-panel-toggle")).toBeVisible();
    await expect(shell.getByTestId("settings-button")).toBeVisible();
    await expect(shell.getByTestId("new-tab-button")).toBeVisible();
    await expect(shell.getByTestId("sidebar-chrome")).toHaveCount(0);
    await expect(shell.getByTestId("side-rail")).toHaveCount(0);
    await captureWindow(app, "01-top.png");

    // SIDEBAR, PINNED. Choosing the layout re-arranges the chrome live under
    // the still-open settings page; the strip is gone and every control it
    // had is in the column.
    let settings = await openGeneralSettings(shell, true);
    const sidebarCard = settings.getByTestId("layout-mode-sidebar");
    await expect(sidebarCard).toHaveAttribute("aria-checked", "false");
    await sidebarCard.click();
    await expect(sidebarCard).toHaveAttribute("aria-checked", "true");
    await expect(settings).toBeVisible();
    await shell.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await expect.poll(() => visibleTabViews(app)).toBe(1);

    const sidebar = shell.getByTestId("sidebar-chrome");
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByTestId("sidebar-address")).toBeVisible();
    await expect(sidebar.getByTestId("sidebar-tab-list")).toBeVisible();
    await expect(sidebar.getByTestId("human-tab")).toBeVisible();
    await expect(tabStrip(shell)).toHaveCount(0);
    await expect(shell.getByRole("tablist", { name: "Open tabs" })).toHaveAttribute("aria-orientation", "vertical");
    await expect(shell.getByTestId("new-tab-button")).toHaveCount(1);
    await expect(sidebar.getByTestId("new-tab-button")).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "Compact sidebar" })).toBeVisible();

    // The footer is one button, the Space avatar: its menu has the Space on
    // top and the strip's trailing cluster as rows below. Hovering it shows
    // the menu; moving away hides it again.
    await expect(sidebar.getByTestId("sidebar-menu-button")).toBeVisible();
    await expect(sidebar.getByTestId("split-toggle")).toHaveCount(0);
    await sidebar.getByTestId("sidebar-menu-button").hover();
    const footerMenu = sidebar.getByTestId("sidebar-menu");
    await expect(footerMenu).toBeVisible();
    await expect(footerMenu.getByTestId("sidebar-menu-profile")).toBeVisible();
    await expect(footerMenu.getByTestId("split-toggle")).toHaveCount(0);
    await expect(footerMenu.getByTestId("agent-panel-toggle")).toBeVisible();
    await expect(footerMenu.getByTestId("reminders-button")).toBeVisible();
    await expect(footerMenu.getByTestId("settings-button")).toBeVisible();
    await sidebar.getByTestId("sidebar-address").hover();
    await expect(footerMenu).toHaveCount(0);

    // Split view still works in the sidebar layout (the menu no longer lists it).
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.setSplit("vertical"));
    await expect(shell.getByTestId("secondary-pane")).toBeVisible();
    await expect(sidebar.getByRole("group", { name: /^Split view:/ })).toBeVisible();
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.setSplit("single"));
    await expect(shell.getByTestId("secondary-pane")).toHaveCount(0);

    // The list's "New tab" row does what ⌘T does: the address modal composing
    // a new tab, over the whole window.
    await sidebar.getByTestId("new-tab-button").click();
    await expect(shell.getByTestId("url-bar")).toBeVisible();
    await expect(shell.getByTestId("address-input")).toBeFocused();
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("url-bar")).toHaveCount(0);
    await expect.poll(() => visibleTabViews(app)).toBe(1);
    await captureWindow(app, "02-sidebar-pinned.png");
    await expect.poll(() => storedLayout(userData)).toEqual({ mode: "sidebar", sidebar: "pinned" });

    // SIDEBAR, COMPACT: the column leaves the shell's layout; only the edge
    // trigger stays, and the traffic lights go with the sidebar. No chrome
    // view is involved: the compact sidebar is the pinned column, auto-hidden.
    settings = await openGeneralSettings(shell, true);
    await settings.getByTestId("sidebar-presentation").selectOption("compact");
    await shell.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    // The column remains mounted so compact reveal/hide can reverse without
    // recreating its shelf; hidden makes it inert after the retreat lands.
    await expect(shell.getByTestId("sidebar-chrome")).toBeHidden();
    await expect(shell.getByTestId("sidebar-edge")).toBeVisible();
    await expect.poll(() => storedLayout(userData)).toEqual({ mode: "sidebar", sidebar: "compact" });
    await expect.poll(() => windowState(app)).toMatchObject({ windowButtons: false, sidebarView: false });
    const hiddenPage = await shell.getByTestId("primary-pane").boundingBox();
    await captureWindow(app, "03-sidebar-compact.png");

    // Pointer movement in the edge puts the SAME column back into the
    // layout, and the page moves over to make room — identical to pinned —
    // with the traffic lights back over its toolbar.
    // A raw move, not locator.hover(): the strip unmounts the moment the
    // pointer moves in it, which hover() would wait out as "unstable".
    const edge = await shell.getByTestId("sidebar-edge").boundingBox();
    await shell.mouse.move(edge!.x + 4, edge!.y + 200);
    await shell.mouse.move(edge!.x + 5, edge!.y + 210);
    const pane = shell.getByTestId("sidebar-pane");
    await expect(pane).toBeVisible();
    await expect(pane).toHaveAttribute("data-auto-hide", "");
    await expect(shell.getByTestId("sidebar-edge")).toHaveCount(0);
    await expect(shell.getByTestId("sidebar-chrome")).toBeVisible();
    await expect(pane.getByTestId("human-tab").first()).toBeVisible();
    await expect(pane.getByTestId("sidebar-address")).toBeVisible();
    await expect(pane.getByRole("button", { name: "Pin sidebar" })).toBeVisible();
    await expect.poll(() => windowState(app)).toMatchObject({ windowButtons: true, sidebarView: false });
    await expect
      .poll(async () => Math.round((await shell.getByTestId("sidebar-motion-slot").boundingBox())?.width ?? 0))
      .toBe(Math.round((await pane.boundingBox())?.width ?? 0));
    const revealedPage = await shell.getByTestId("primary-pane").boundingBox();
    const paneBox = await pane.boundingBox();
    expect(paneBox).not.toBeNull();
    expect(revealedPage!.x).toBeGreaterThanOrEqual(paneBox!.x + paneBox!.width);
    expect(revealedPage!.width).toBeLessThan(hiddenPage!.width);
    await expect.poll(() => visibleTabViews(app)).toBe(1);
    await captureWindow(app, "04-sidebar-compact-revealed.png");

    // Moving onto the page is the leave: the column goes, the edge returns,
    // and the page takes its width back.
    await shell.mouse.move(revealedPage!.x + revealedPage!.width / 2, revealedPage!.y + revealedPage!.height / 2);
    await expect(shell.getByTestId("sidebar-pane")).toBeHidden();
    await expect(shell.getByTestId("sidebar-edge")).toBeVisible();
    await expect.poll(() => windowState(app)).toMatchObject({ windowButtons: false });
    await expect.poll(async () => (await shell.getByTestId("primary-pane").boundingBox())?.width).toBe(hiddenPage!.width);

    // And again: the edge is back under the layout, and movement in it
    // brings the column out a second time — the cycle that used to break.
    await shell.mouse.move(edge!.x + 4, edge!.y + 300);
    await shell.mouse.move(edge!.x + 5, edge!.y + 310);
    await expect(shell.getByTestId("sidebar-pane")).toBeVisible();
    await expect(shell.getByTestId("sidebar-edge")).toHaveCount(0);
    await expect.poll(() => windowState(app)).toMatchObject({ windowButtons: true });
    await expect
      .poll(async () => Math.round((await shell.getByTestId("sidebar-motion-slot").boundingBox())?.width ?? 0))
      .toBe(Math.round((await pane.boundingBox())?.width ?? 0));
    // Resting on the column keeps it: no hide creeps in on its own.
    await shell.mouse.move(60, 400);
    await new Promise((done) => setTimeout(done, 500));
    await expect(shell.getByTestId("sidebar-pane")).toBeVisible();
    await shell.mouse.move(revealedPage!.x + revealedPage!.width / 2, revealedPage!.y + revealedPage!.height / 2);
    await expect(shell.getByTestId("sidebar-pane")).toBeHidden();
    await expect(shell.getByTestId("sidebar-edge")).toBeVisible();

    // ⌘S pins the sidebar back into the layout and again makes it compact
    // (which hides it at once, rather than holding it until the pointer leaves).
    await shell.keyboard.press("Meta+s");
    await expect.poll(() => storedLayout(userData)).toEqual({ mode: "sidebar", sidebar: "pinned" });
    await expect(shell.getByTestId("sidebar-chrome")).toBeVisible();
    await expect(shell.getByTestId("sidebar-pane")).not.toHaveAttribute("data-auto-hide", "");
    await expect(shell.getByTestId("sidebar-edge")).toHaveCount(0);
    await expect.poll(() => windowState(app)).toMatchObject({ windowButtons: true });
    await shell.keyboard.press("Meta+s");
    await expect.poll(() => storedLayout(userData)).toEqual({ mode: "sidebar", sidebar: "compact" });
    await expect(shell.getByTestId("sidebar-chrome")).toBeHidden();
    await expect(shell.getByTestId("sidebar-edge")).toBeVisible();

    // BACK TO TOP TABS: the strip returns with its tail and cluster, and the
    // edge trigger leaves with the sidebar.
    settings = await openGeneralSettings(shell);
    await settings.getByTestId("layout-mode-top").click();
    await expect(settings.getByTestId("sidebar-presentation")).toBeDisabled();
    await shell.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await expect(tabStrip(shell)).toBeVisible();
    await expect(tabStrip(shell).getByTestId("human-tab").first()).toBeVisible();
    await expect(shell.getByTestId("new-tab-button")).toBeVisible();
    await expect(shell.getByTestId("split-toggle")).toBeVisible();
    await expect(shell.getByTestId("agent-panel-toggle")).toBeVisible();
    await expect(shell.getByTestId("sidebar-chrome")).toHaveCount(0);
    await expect(shell.getByTestId("sidebar-edge")).toHaveCount(0);
    await expect.poll(() => storedLayout(userData)).toEqual({ mode: "top", sidebar: "compact" });
    await expect.poll(() => windowState(app)).toMatchObject({ windowButtons: true, sidebarView: false });
    await captureWindow(app, "05-back-to-top.png");
  } finally {
    await app.close();
  }
});
