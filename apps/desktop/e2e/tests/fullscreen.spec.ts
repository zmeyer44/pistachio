import { expect, test, type ElectronApplication } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";
import { launchApp } from "./app";
import { pageAt } from "./chrome-harness";

const VIDEO_URL = "pistachio://demo/invoices?fullscreen";

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

test("a page's fullscreen request takes the window and fills it, and leaves with the tab", { tag: ["@media", "@tabs"] }, async () => {
  const { app } = await launchApp({ settings: { layout: { sidebar: "pinned" } }, name: "fullscreen" });

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
