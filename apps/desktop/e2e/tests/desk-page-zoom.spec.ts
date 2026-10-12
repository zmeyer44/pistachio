/**
 * Page zoom (the desk's Feel, Fit; docs/desk.md): a page in a window that
 * takes less of the desk is shown zoomed out — laid out at its box over the
 * zoom and drawn scaled into it by main (Chromium's device emulation, as a
 * minimized window's is) — 75% at half the desk, and back at 100% filling
 * it. The window's ⋯ says the zoom. This proves the wiring only the real
 * app has: the page lays out at that size, a press lands where it is seen,
 * and the site's own zoom (⌘+, every tab of the site's) is never touched;
 * its strength, set on the Feel's slider (Off to Strongest), is followed by
 * the pages there. The curve itself is desk-page-zoom.test.ts's.
 *
 * The pages are a local server's: a target at a known place on each, which
 * counts the presses it takes.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { box, createGroup, createTab, fromFrameMenu, launchDesk, openMore, screenshots, selectSpace, selectTab, settled, snapshot, windowSelector } from "./desk-harness";

const capture = screenshots("desk-page-zoom");

/** The target's box in the page's own CSS px. */
const TARGET = { x: 400, y: 300, size: 120 };
/** A link's box in the page's own CSS px, to Glance. */
const LINK = { x: 600, y: 500, w: 100, h: 40 };

const PAGE = `<!doctype html><title>Page</title><body style="font:16px system-ui;margin:0">
<h1 style="margin:24px">Page</h1>
<div id="target" style="position:absolute;left:${String(TARGET.x)}px;top:${String(TARGET.y)}px;width:${String(TARGET.size)}px;height:${String(TARGET.size)}px;background:#4a7"></div>
<a href="/glanced" style="position:absolute;display:block;left:${String(LINK.x)}px;top:${String(LINK.y)}px;width:${String(LINK.w)}px;height:${String(LINK.h)}px;background:#47a"></a>
<script>window.__hits = 0; document.getElementById("target").addEventListener("mousedown", () => { window.__hits += 1; });
window.__resizes = 0; addEventListener("resize", () => { window.__resizes += 1; });</script>
</body>`;

function serve(): Promise<Server> {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE.replace("<title>Page</title>", `<title>${request.url ?? ""}</title>`));
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

/** What the tab's page lays out at, the presses its target took, the resizes it heard, and the site's own zoom factor. */
function pageState(app: ElectronApplication, url: string): Promise<{ width: number; height: number; hits: number; resizes: number; siteZoom: number }> {
  return app.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
    if (contents === undefined) throw new Error(`no page at ${url}`);
    const [width, height, hits, resizes] = (await contents.executeJavaScript("[innerWidth, innerHeight, window.__hits, window.__resizes]")) as [number, number, number, number];
    return { width, height, hits, resizes, siteZoom: contents.getZoomFactor() };
  }, url);
}

/** A video playing on the tab's page, its sound on (a feed's muted one behind a window does not float): a canvas's stream, painted continuously. */
function playVideo(app: ElectronApplication, url: string): Promise<void> {
  return app.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
    if (contents === undefined) throw new Error(`no page at ${url}`);
    await contents.executeJavaScript(
      `(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 180;
        const context = canvas.getContext("2d");
        let frame = 0;
        const paint = () => { frame += 1; context.fillStyle = "hsl(" + String(frame % 360) + " 54% 24%)"; context.fillRect(0, 0, 320, 180); requestAnimationFrame(paint); };
        paint();
        const video = document.createElement("video");
        video.playsInline = true;
        video.style.cssText = "position:absolute;left:24px;top:80px;width:320px;height:180px";
        video.srcObject = canvas.captureStream(12);
        document.body.append(video);
        return video.play();
      })()`,
      true,
    );
  }, url);
}

/** A press and release on the tab's view at a point of the view (not of the page), as the person's pointer would land. */
function pressView(app: ElectronApplication, url: string, x: number, y: number, modifiers: Array<"alt"> = []): Promise<void> {
  return app.evaluate(
    async ({ webContents }, { url, x, y, modifiers }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
      if (contents === undefined) throw new Error(`no page at ${url}`);
      contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1, modifiers });
      contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1, modifiers });
      await new Promise((done) => setTimeout(done, 100));
    },
    { url, x, y, modifiers },
  );
}

test.describe.serial("Page zoom: a page zoomed out for its window's share of the desk", { tag: ["@desk"] }, () => {
  let server: Server;
  let app: ElectronApplication;
  let shell: Page;
  let urls: [string, string];
  let tabs: [string, string];
  let away: () => Promise<void>;
  const pageBox = (tabId: string) => box(shell, `${windowSelector(tabId)} [data-testid="desk-window-page"]`);
  /** What the window's ⋯ says of its zoom. */
  const menuZoom = async (tabId: string): Promise<string> => {
    await shell.locator(windowSelector(tabId)).getByTestId("desk-window-more").click();
    const reading = shell.locator('[data-testid="context-menu"] [data-testid="desk-page-zoom"]');
    await expect(reading).toBeVisible();
    const text = (await reading.textContent()) ?? "";
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("context-menu")).toHaveCount(0);
    return text;
  };

  test.beforeAll(async () => {
    server = await serve();
    const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    urls = [`${origin}/a`, `${origin}/b`];
    ({ app, shell } = await launchDesk({
      name: "page-zoom",
      homeUrl: urls[0],
      zoom: "fit",
      // A window opened: the others stay where they are (the spec tiles them itself).
      env: { PISTACHIO_LAYOUT_SCRIPT: JSON.stringify({ opened: { move: "keep" }, closed: { move: "keep" }, asked: { move: "keep" } }) },
    }));
    await createTab(shell, urls[1]);
    await expect.poll(async () => (await snapshot(shell)).tabs.filter((tab) => urls.includes(tab.url)).length).toBe(2);
    const byUrl = new Map((await snapshot(shell)).tabs.map((tab) => [tab.url, tab.id]));
    tabs = [byUrl.get(urls[0])!, byUrl.get(urls[1])!];
    await createGroup(shell, "zoom", tabs, "Zoom", "green");
    await selectTab(shell, tabs[0]);
    await selectSpace(shell, "zoom");
    await settled(shell, app);
    const stage = await box(shell, ".desk-stage");
    away = () => shell.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height * 0.95);
  });

  test.afterAll(async () => {
    await app?.close();
    server?.close();
  });

  test("side by side, each page is at 75%: laid out at its box over that, pressed where it is seen, its site's zoom untouched; filling the desk, at 100%", async () => {
    await expect(shell.locator(windowSelector(tabs[1]))).toHaveCount(1);
    await away();
    await settled(shell, app);
    await openMore(shell);
    await shell.getByTestId("desk-tile").click();
    await away();
    await settled(shell, app);
    const stage = await box(shell, ".desk-stage");
    const half = await pageBox(tabs[0]);
    expect(half.width).toBeLessThan(stage.width * 0.55);
    // Laid out at its box over 75%, and the site's own zoom as it was.
    await expect.poll(async () => (await pageState(app, urls[0])).width).toBe(Math.round(Math.round(half.width) / 0.75));
    const zoomed = await pageState(app, urls[0]);
    expect(zoomed.height).toBe(Math.round(Math.round(half.height) / 0.75));
    expect(zoomed.siteZoom).toBe(1);
    expect((await pageState(app, urls[1])).width).toBe(zoomed.width);
    expect(await menuZoom(tabs[0])).toContain("75%");
    await shell.locator(windowSelector(tabs[0])).getByTestId("desk-window-more").click();
    await expect(shell.getByTestId("context-menu")).toBeVisible();
    await capture(app, shell, "01-side-by-side-menu.png");
    await shell.keyboard.press("Escape");
    await away();
    await settled(shell, app);
    await capture(app, shell, "02-side-by-side.png");

    // A press on the target where it is seen (its page box × 75% into the view) lands on it; one where it would be at 100% does not.
    const seen = { x: (TARGET.x + TARGET.size / 2) * 0.75, y: (TARGET.y + TARGET.size / 2) * 0.75 };
    await pressView(app, urls[0], Math.round(seen.x), Math.round(seen.y));
    await expect.poll(async () => (await pageState(app, urls[0])).hits).toBe(1);
    await pressView(app, urls[0], TARGET.x + TARGET.size - 6, TARGET.y + TARGET.size - 6);
    expect((await pageState(app, urls[0])).hits).toBe(1);

    // A link ⌥-clicked where it is seen Glances, growing out of the link as it is seen: its page box × 75%, in the view.
    await pressView(app, urls[0], Math.round((LINK.x + LINK.w / 2) * 0.75), Math.round((LINK.y + LINK.h / 2) * 0.75), ["alt"]);
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();
    const view = await app.evaluate(({ BrowserWindow }, url) => {
      const found = BrowserWindow.getAllWindows()[0]!.contentView.children.find((child) => "webContents" in child && (child as { webContents: { getURL(): string } }).webContents.getURL() === url) as { getBounds(): { x: number; y: number } };
      return found.getBounds();
    }, urls[0]);
    const glance = await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getGlance());
    const grownFrom = { x: view.x + LINK.x * 0.75, y: view.y + LINK.y * 0.75, width: LINK.w * 0.75, height: LINK.h * 0.75 };
    for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(glance!.source[key] - grownFrom[key]), key).toBeLessThanOrEqual(1);
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.closeGlance());
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);

    // Its Open Link in Glance, from a right-click on the link where it is seen: growing out of that point, which is
    // Electron's own and the view's already (the native menu stood in for, as it would hold the run up).
    const seenLink = { x: Math.round((LINK.x + LINK.w / 2) * 0.75), y: Math.round((LINK.y + LINK.h / 2) * 0.75) };
    await app.evaluate(
      ({ Menu, webContents }, { url, x, y }) => {
        type Items = { items: Array<{ label: string; click: () => void }> };
        const prototype = Menu.prototype as unknown as { popup: (this: Items) => void };
        const popup = prototype.popup;
        prototype.popup = function (this: Items) {
          prototype.popup = popup;
          this.items.find((item) => item.label === "Open Link in Glance")?.click();
        };
        const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
        contents.sendInputEvent({ type: "mouseDown", x, y, button: "right", clickCount: 1 });
        contents.sendInputEvent({ type: "mouseUp", x, y, button: "right", clickCount: 1 });
      },
      { url: urls[0], ...seenLink },
    );
    await expect(shell.getByTestId("glance-overlay")).toBeVisible();
    const fromMenu = await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getGlance());
    expect(Math.abs(fromMenu!.source.x - (view.x + seenLink.x)), "x").toBeLessThanOrEqual(1);
    expect(Math.abs(fromMenu!.source.y - (view.y + seenLink.y)), "y").toBeLessThanOrEqual(1);
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.closeGlance());
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);

    // Filling the desk: back at 100%, laid out at its own box.
    await shell.locator(windowSelector(tabs[0])).getByRole("button", { name: "Fill the desk" }).click();
    await away();
    await settled(shell, app);
    const filled = await pageBox(tabs[0]);
    expect(filled.width).toBeGreaterThan(stage.width * 0.9);
    await expect.poll(async () => (await pageState(app, urls[0])).width).toBe(Math.round(filled.width));
    expect(await menuZoom(tabs[0])).toContain("100%");
    await capture(app, shell, "03-filled.png");
  });

  test("masked while zoomed, its page stays laid out as it was, the region at the size it was seen; unmasked, it is zoomed for its size again", async () => {
    await shell.locator(windowSelector(tabs[0])).getByRole("button", { name: "Restore" }).click();
    await away();
    await settled(shell, app);
    const page = await pageBox(tabs[0]);
    const laidOut = Math.round(Math.round(page.width) / 0.75);
    await expect.poll(async () => (await pageState(app, urls[0])).width).toBe(laidOut);
    const before = await pageState(app, urls[0]);

    // A region chosen over the zoomed page, as desk.spec chooses one.
    const region = { x: 40, y: 40, w: 300, h: 200 };
    await fromFrameMenu(shell, windowSelector(tabs[0]), "desk-mask");
    await expect(shell.locator(`${windowSelector(tabs[0])} [data-testid="desk-mask-selector"]`)).toBeVisible();
    await shell.mouse.move(page.x + region.x, page.y + region.y);
    await shell.mouse.down();
    for (let step = 1; step <= 10; step += 1) {
      await shell.mouse.move(page.x + region.x + (region.w * step) / 10, page.y + region.y + (region.h * step) / 10);
      await shell.waitForTimeout(16);
    }
    await shell.mouse.up();
    await expect(shell.locator(`${windowSelector(tabs[0])}[data-masked]`)).toHaveCount(1);
    await away();
    await settled(shell, app);
    // The region at the size it was seen at; the page laid out as it was, never at the window's box.
    const masked = await box(shell, windowSelector(tabs[0]));
    expect(Math.abs(masked.width - region.w)).toBeLessThan(2);
    const kept = await pageState(app, urls[0]);
    expect(kept.width).toBe(laidOut);
    console.log(`resizes masking a zoomed page: ${String(kept.resizes - before.resizes)}`);
    await capture(app, shell, "04-masked-while-zoomed.png");

    // Unmasked: back at its own size, then zoomed for the box it has, once main's release of the mask is done.
    await shell.locator(windowSelector(tabs[0])).getByTestId("desk-unmask").click();
    await expect(shell.locator(`${windowSelector(tabs[0])}[data-masked]`)).toHaveCount(0);
    await away();
    await settled(shell, app);
    const whole = await pageBox(tabs[0]);
    const reading = await menuZoom(tabs[0]);
    const zoom = Number(/(\d+)%/.exec(reading)![1]) / 100;
    expect(zoom).toBeLessThan(1);
    await expect.poll(async () => Math.abs((await pageState(app, urls[0])).width - Math.round(whole.width) / zoom)).toBeLessThan(2);
    await capture(app, shell, "05-unmasked.png");
  });

  test("a zoomed window's video floating — behind a window filling the desk, then popped out — its page keeps the layout it had", async () => {
    // (The window's fullscreen transitions, in and out, take seconds each.)
    test.setTimeout(120_000);
    await playVideo(app, urls[0]);
    const playing = (): Promise<boolean> =>
      shell.evaluate(async (tabId) => (await (window as unknown as { pistachio: PistachioApi }).pistachio.getMedia()).some((item) => item.tabId === tabId && item.playing), tabs[0]);
    await expect.poll(playing).toBe(true);
    await settled(shell, app);
    const before = await pageState(app, urls[0]);
    expect(before.width).toBeGreaterThan(Math.round((await pageBox(tabs[0])).width));
    const pip = shell.getByTestId("desk-pip");
    // Its layout viewport, not its resize events: a page in the floating player hears resizes of its own size as its
    // scale factor changes under the capture of a playing page (PROBED: at Actual size too, before the zoom was there).
    const kept = async (): Promise<void> => {
      const now = await pageState(app, urls[0]);
      expect(now.width).toBe(before.width);
      expect(now.height).toBe(before.height);
    };

    // Behind the other window filling the desk: its video floats, its page laid out as in its window.
    await shell.locator(windowSelector(tabs[1])).getByRole("button", { name: "Fill the desk" }).click();
    await expect(pip).toHaveAttribute("data-tab-id", tabs[0]);
    await away();
    await settled(shell, app);
    await kept();
    // Fullscreen from the floating player (its player's own button): the page on the whole screen, laid out at its size,
    // not at the viewport the player kept for it; back from it, floating again as it was.
    // (Not awaiting the page's promise; and leaving only once the window's transition in has ended — asked to leave
    // while macOS still animates it in, the page's exit hung for minutes.)
    const fullscreen = (go: boolean): Promise<void> =>
      app.evaluate(({ BrowserWindow, webContents }, { url, go }) => {
        const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
        const settled = globalThis as unknown as { fullscreenSettled?: boolean };
        settled.fullscreenSettled = false;
        const window = BrowserWindow.getAllWindows()[0]!;
        const done = (): void => void (settled.fullscreenSettled = true);
        if (go) window.once("enter-full-screen", done);
        else window.once("leave-full-screen", done);
        void contents.executeJavaScript(go ? "void document.documentElement.requestFullscreen()" : "void document.exitFullscreen()", true);
      }, { url: urls[0], go });
    const fullscreenSettled = (): Promise<boolean> => app.evaluate(() => (globalThis as unknown as { fullscreenSettled?: boolean }).fullscreenSettled === true);
    await fullscreen(true);
    await expect.poll(fullscreenSettled, { timeout: 15_000 }).toBe(true);
    const screen = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentBounds());
    await expect.poll(async () => { const { width, height } = await pageState(app, urls[0]); return `${String(width)}x${String(height)}`; }, { timeout: 15_000 }).toBe(`${String(screen.width)}x${String(screen.height)}`);
    await fullscreen(false);
    await expect.poll(fullscreenSettled, { timeout: 15_000 }).toBe(true);
    await expect(pip).toHaveAttribute("data-tab-id", tabs[0]);
    await away();
    await settled(shell, app);
    await expect.poll(async () => (await pageState(app, urls[0])).width).toBe(before.width);
    await kept();
    // Let down: its window's again, at its zoom.
    await shell.locator(windowSelector(tabs[1])).getByRole("button", { name: "Restore" }).click();
    await expect(pip).toHaveCount(0);
    await away();
    await settled(shell, app);
    await kept();

    // Popped out (from its frame, its window over the other): its window goes into its row, and its page lays out as it
    // did there, in the floating player too.
    await selectTab(shell, tabs[0]);
    await settled(shell, app);
    await shell.locator(windowSelector(tabs[0])).getByTestId("desk-pop-out").click();
    await expect(shell.locator(windowSelector(tabs[0]))).toHaveCount(0);
    await expect(pip).toHaveAttribute("data-tab-id", tabs[0]);
    await away();
    await settled(shell, app);
    await kept();
    await capture(app, shell, "06-popped-out.png");

    // Back to the desk from the player.
    await expect.poll(() => app.windows().some((page) => page.url().endsWith(CHROME_VIEW_HASHES.pip))).toBe(true);
    const face = app.windows().find((page) => page.url().endsWith(CHROME_VIEW_HASHES.pip))!;
    await face.getByTestId("desk-pip-view").hover();
    await face.getByTestId("desk-pip-return").click();
    await expect(shell.locator(windowSelector(tabs[0]))).toHaveCount(1);
    await expect(pip).toHaveCount(0);
  });

  test("its strength, on the Feel's slider: the pages follow it — Strongest 50% at half the desk, Slight 88% — and Off, every page at 100% beside its neighbour too", async () => {
    await openMore(shell);
    await shell.getByTestId("desk-tile").click();
    await away();
    await settled(shell, app);
    const half = await pageBox(tabs[0]);
    const row = shell.getByTestId("desk-variant-zoom");
    /** The slider set to a strength's stop, the card left, and the desk settled. */
    const strength = async (step: number, id: string, label: string): Promise<void> => {
      await openMore(shell);
      await row.locator('input[type="range"]').fill(String(step));
      await expect(row).toHaveAttribute("data-value", id);
      await expect(row).toContainText(label);
      await expect
        .poll(() => shell.evaluate(() => (JSON.parse(localStorage.getItem("pistachio.desk.v1") ?? "{}") as { variants?: { zoom?: string } }).variants?.zoom))
        .toBe(id);
      if (id === "strongest") await capture(app, shell, "07-feel-strength.png");
      await away();
      await settled(shell, app);
    };
    // Medium (the default) at half the desk: 75%.
    await expect.poll(async () => (await pageState(app, urls[0])).width).toBe(Math.round(Math.round(half.width) / 0.75));

    await strength(4, "strongest", "Strongest");
    await expect.poll(async () => (await pageState(app, urls[0])).width).toBe(Math.round(Math.round(half.width) / 0.5));
    expect((await pageState(app, urls[1])).width).toBe(Math.round(Math.round(half.width) / 0.5));
    expect(await menuZoom(tabs[0])).toContain("50%");
    await capture(app, shell, "08-strongest.png");

    await strength(1, "slight", "Slight");
    await expect.poll(async () => (await pageState(app, urls[0])).width).toBe(Math.round(Math.round(half.width) / 0.88));
    expect(await menuZoom(tabs[0])).toContain("88%");

    await strength(0, "actual", "Off");
    await expect.poll(async () => (await pageState(app, urls[0])).width).toBe(Math.round(half.width));
    expect((await pageState(app, urls[1])).width).toBe(Math.round(half.width));
    expect(await menuZoom(tabs[0])).toContain("100%");
    await capture(app, shell, "09-off.png");
  });
});
