import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";

const VIDEO_URL = "pistachio://demo/invoices?fullscreen";

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", executableSuffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", executableSuffix),
  ];
  return candidates.find(
    (candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

async function pageAt(app: ElectronApplication, url: string): Promise<Page> {
  await expect.poll(() => app.windows().some((page) => page.url() === url)).toBe(true);
  const page = app.windows().find((candidate) => candidate.url() === url);
  if (page === undefined) throw new Error(`No Electron page at ${url}`);
  return page;
}

interface ViewGeometry {
  windowFullScreen: boolean;
  content: { width: number; height: number };
  view: { x: number; y: number; width: number; height: number } | null;
  viewVisible: boolean;
}

/** Where the tab's native view sits relative to the window's content box. */
function viewGeometry(app: ElectronApplication, url: string): Promise<ViewGeometry> {
  return app.evaluate(({ BrowserWindow }, pageUrl) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (window === undefined) throw new Error("No shell window");
    const { width, height } = window.getContentBounds();
    const view = window.contentView.children.find(
      (child) => "webContents" in child && (child as Electron.WebContentsView).webContents.getURL() === pageUrl,
    ) as Electron.WebContentsView | undefined;
    return {
      windowFullScreen: window.isFullScreen(),
      content: { width, height },
      view: view === undefined ? null : view.getBounds(),
      viewVisible: view !== undefined && view.getVisible(),
    };
  }, url);
}

test("a page's fullscreen request takes the window and fills it, and leaves with the tab", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-fullscreen-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" } }));
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });

  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    const { originalTabId, videoTabId } = await shell.evaluate(async (url) => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      const snapshot = await api.getSnapshot();
      await api.createTab(url);
      const after = await api.getSnapshot();
      const videoTab = after.tabs.find((tab) => tab.url === url);
      if (snapshot.activeTabId === null || videoTab === undefined) throw new Error("Tabs missing");
      return { originalTabId: snapshot.activeTabId, videoTabId: videoTab.id };
    }, VIDEO_URL);
    const videoPage = await pageAt(app, VIDEO_URL);

    // Before: the page sits in its pane, smaller than the window.
    const before = await viewGeometry(app, VIDEO_URL);
    expect(before.windowFullScreen).toBe(false);
    expect(before.view).not.toBeNull();
    expect(before.view!.width).toBeLessThan(before.content.width);

    // A player's ⛶ button: requestFullscreen from a real click gesture.
    await videoPage.evaluate(() => {
      const stage = document.createElement("div");
      stage.id = "stage";
      stage.style.cssText = "width:320px;height:180px;background:#000";
      const button = document.createElement("button");
      button.id = "go-fullscreen";
      button.textContent = "Fullscreen";
      button.addEventListener("click", () => {
        void stage.requestFullscreen().then(
          () => { document.body.dataset["fullscreen"] = "ok"; },
          (error: Error) => { document.body.dataset["fullscreen"] = `rejected: ${error.message}`; },
        );
      });
      document.body.prepend(button, stage);
    });
    await videoPage.locator("#go-fullscreen").click();
    await expect.poll(() => videoPage.evaluate(() => document.body.dataset["fullscreen"] ?? null)).toBe("ok");
    await expect.poll(() => videoPage.evaluate(() => document.fullscreenElement?.id ?? null)).toBe("stage");

    // The window goes native fullscreen and, once the transition settles,
    // the tab's view covers the entire content box with nothing else shown.
    await expect.poll(() => viewGeometry(app, VIDEO_URL).then((geometry) => geometry.windowFullScreen), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => {
      const { content, view } = await viewGeometry(app, VIDEO_URL);
      return view !== null && view.x === 0 && view.y === 0 && view.width === content.width && view.height === content.height;
    }, { timeout: 15_000 }).toBe(true);

    // Moving to another tab ends the presentation — even this soon, while
    // macOS may still be animating the window in: the page leaves
    // fullscreen, the window comes back, and the page hides behind the
    // newly selected tab.
    await shell.evaluate(async (tabId) => {
      await (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId);
    }, originalTabId);
    await expect.poll(() => videoPage.evaluate(() => document.fullscreenElement?.id ?? null), { timeout: 15_000 }).toBeNull();
    await expect.poll(() => viewGeometry(app, VIDEO_URL).then((geometry) => geometry.windowFullScreen), { timeout: 15_000 }).toBe(false);
    await expect.poll(() => viewGeometry(app, VIDEO_URL).then((geometry) => geometry.viewVisible), { timeout: 15_000 }).toBe(false);

    // Back on the page, it is laid out in its pane again, not stranded at
    // the screen's size.
    await shell.evaluate(async (tabId) => {
      await (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId);
    }, videoTabId);
    await expect.poll(async () => {
      const { content, view, viewVisible } = await viewGeometry(app, VIDEO_URL);
      return viewVisible && view !== null && view.width < content.width && view.height <= content.height;
    }, { timeout: 15_000 }).toBe(true);

    // Closing the tab while it presents: the page can no longer leave for
    // itself, so the window it took must be given back.
    await videoPage.locator("#go-fullscreen").click();
    await expect.poll(() => viewGeometry(app, VIDEO_URL).then((geometry) => geometry.windowFullScreen), { timeout: 15_000 }).toBe(true);
    await shell.evaluate(async (tabId) => {
      await (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(tabId);
    }, videoTabId);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFullScreen()), { timeout: 15_000 }).toBe(false);
  } finally {
    await app.close();
  }
});
