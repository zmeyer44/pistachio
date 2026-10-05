/**
 * A page shown again under a resting pointer is told the pointer left it
 * (main/browser-controller.ts, #releaseRestingPointer). On macOS a page
 * hidden under the pointer — under the address palette, a menu, a desk
 * window turned to its still — and shown again kept the shell's arrow over
 * its links and buttons until the page asked for another kind of cursor:
 * spots of page that seemed dead to the pointer.
 *
 * Launched by Playwright, Chromium sends a leave itself as the page goes
 * down, so the stale cursor never shows under a spec. What this proves
 * is the wiring: main reads the pointer, a page shown under it hears a leave
 * at that very point (never the page's corner, which exit-intent scripts
 * read as the pointer heading off the page), and a page shown away from it
 * hears none. The OS pointer is main's `screen.getCursorScreenPoint`, stubbed
 * here, since Playwright's pointer never reaches the OS.
 */

import { createServer, type Server } from "node:http";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import { launchApp } from "./app";
import { visibleTabViews } from "./pages-harness";
import { pageFirst, shellReady } from "./windows";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The page's view: its box in the window, as main placed it. */
function pageBox(app: ElectronApplication): Promise<Box> {
  return app.evaluate(({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    const view = window.contentView.children.find((child) => {
      if (!("webContents" in child) || !child.getVisible()) return false;
      const url = (child as WebContentsView).webContents.getURL();
      return url.startsWith("http://127.0.0.1") && !Object.values(hashes).some((hash) => url.endsWith(hash));
    }) as WebContentsView | undefined;
    if (view === undefined) throw new Error("the page's view is not on screen");
    return view.getBounds();
  }, CHROME_VIEW_HASHES);
}

/** Main reads the OS pointer at this point of the window's content box. */
function restPointerAt(app: ElectronApplication, point: { x: number; y: number }): Promise<void> {
  return app.evaluate(({ BrowserWindow, screen }, at) => {
    const content = BrowserWindow.getAllWindows()[0]!.getContentBounds();
    screen.getCursorScreenPoint = () => ({ x: content.x + at.x, y: content.y + at.y });
  }, point);
}

/** The page's `mouseLeave`s, as main sees them (`before-mouse-event`), from now on. */
function recordLeaves(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ webContents }) => {
    const record = globalThis as unknown as { __leaves?: Array<{ x: number; y: number }>; __leavesHooked?: boolean };
    record.__leaves = [];
    if (record.__leavesHooked === true) return;
    const page = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("http://127.0.0.1"));
    if (page === undefined) throw new Error("no page to listen to");
    record.__leavesHooked = true;
    page.on("before-mouse-event", (_event, mouse) => {
      if (mouse.type === "mouseLeave") record.__leaves?.push({ x: mouse.x, y: mouse.y });
    });
  });
}

const leaves = (app: ElectronApplication): Promise<Array<{ x: number; y: number }>> =>
  app.evaluate(() => (globalThis as unknown as { __leaves: Array<{ x: number; y: number }> }).__leaves);

test.describe.serial("a page shown again under a resting pointer", { tag: ["@address"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let server: Server;

  test.beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Links</title><a href="#" style="display:block;height:100vh;cursor:pointer">A link the size of the page</a>`);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${String((server.address() as { port: number }).port)}/links`;
    ({ app } = await launchApp({ settings: pageFirst({ general: { homeUrl: url } }), name: "resting-pointer" }));
    shell = await shellReady(app);
    await expect.poll(() => visibleTabViews(app)).toBe(1);
  });

  test.afterEach(async () => {
    // The real pointer reading back, for whatever runs next.
    await app?.evaluate(({ screen }) => {
      delete (screen as unknown as Record<string, unknown>)["getCursorScreenPoint"];
    });
  });

  test.afterAll(async () => {
    await app?.close();
    server?.close();
  });

  /** The palette up over the page (its view down), then Escape (the view back); leaves recorded only once the page is down. */
  async function paletteRoundTrip(): Promise<void> {
    await shell.keyboard.press("Meta+L");
    await expect(shell.getByTestId("address-input")).toBeFocused();
    await expect.poll(() => visibleTabViews(app)).toBe(0);
    // Whatever Chromium says as the page goes down is not this test's.
    await shell.waitForTimeout(300);
    await recordLeaves(app);
    await shell.keyboard.press("Escape");
    await expect.poll(() => visibleTabViews(app)).toBe(1);
  }

  test("the page shown again under the pointer hears it leave, at the pointer's own point", async () => {
    const box = await pageBox(app);
    const at = { x: box.x + Math.round(box.width / 2) + 13, y: box.y + Math.round(box.height / 2) + 7 };
    await restPointerAt(app, at);
    await paletteRoundTrip();
    await expect.poll(() => leaves(app)).toEqual([{ x: at.x - box.x, y: at.y - box.y }]);
  });

  test("a page shown again away from the pointer hears nothing", async () => {
    // Over the sidebar: coming onto the page later is an entry of its own.
    await restPointerAt(app, { x: 20, y: 400 });
    await paletteRoundTrip();
    await shell.waitForTimeout(300);
    expect(await leaves(app)).toEqual([]);
  });
});
