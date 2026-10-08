/**
 * A desk window growing into a larger box while something of the shell's
 * lies over it (docs/desk.md §3, "A window growing into a larger box is its
 * live page"). A live page is a native view that
 * would paint over the shell, so a covered window is drawn as its still.
 * Growing so — a neighbour closed under the More card, say — its page is
 * laid out at the box it grows to and stays there once it lands, though its
 * view is down: let go then, the page went back to the size it had (a view
 * resized while hidden never tells its page), every still was that page
 * blown up to the window, and shown at last it was laid out anew. And a
 * frame button's tooltip, itself a cover, goes as the button is pressed:
 * Fill the desk grew its window as its still while the tooltip stayed up.
 * Shrinking, a window is its live page too, laid out at each size it
 * passes through (it was its still, scaled down, until it landed).
 *
 * The pages are a local server's, each counting the resizes it hears.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { box, createGroup, createTab, launchDesk, openGroupDesk, openMore, rowSelector, screenshots, selectTab, settled, snapshot, windowSelector } from "./desk-harness";

const capture = screenshots("desk-grow");

const PAGE = `<!doctype html><title>Page</title><body style="font:16px system-ui;margin:24px"><h1>Page</h1><script>
window.__resizes = 0; addEventListener("resize", () => { window.__resizes += 1; });
</script></body>`;

function serve(): Promise<Server> {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE.replace("<title>Page</title>", `<title>${request.url ?? ""}</title>`));
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

/** What the tab's page says of its own size, and how many resizes it has heard. */
function pageSize(app: ElectronApplication, url: string): Promise<{ width: number; height: number; resizes: number }> {
  return app.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
    if (contents === undefined) throw new Error(`no page at ${url}`);
    const [width, height, resizes] = (await contents.executeJavaScript("[innerWidth, innerHeight, window.__resizes]")) as [number, number, number];
    return { width, height, resizes };
  }, url);
}

/** Every frame from the next press on: whether the window was drawn (its still), until the returned call says. */
async function watchDrawnFromPress(shell: Page, tabId: string): Promise<() => Promise<boolean[]>> {
  await shell.evaluate((tabId) => {
    const state = window as unknown as { __drawn: boolean[] | null; __watching: boolean };
    state.__drawn = null;
    state.__watching = true;
    document.addEventListener("pointerdown", () => (state.__drawn ??= []), { capture: true, once: true });
    const frame = (): void => {
      const el = document.querySelector(`[data-testid="desk-window"][data-tab-id="${tabId}"]`);
      if (el !== null && state.__drawn !== null) state.__drawn.push(el.hasAttribute("data-drawn"));
      if (state.__watching) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, tabId);
  return () =>
    shell.evaluate(() => {
      const state = window as unknown as { __drawn: boolean[] | null; __watching: boolean };
      state.__watching = false;
      return state.__drawn ?? [];
    });
}

test.describe.serial("a desk window growing, and shrinking", { tag: ["@desk"] }, () => {
  let server: Server;
  let app: ElectronApplication;
  let shell: Page;
  let urls: [string, string];
  let tabs: [string, string];
  let away: () => Promise<void>;

  test.beforeAll(async () => {
    server = await serve();
    const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    urls = [`${origin}/a`, `${origin}/b`];
    ({ app, shell } = await launchDesk({
      name: "grow",
      homeUrl: urls[0],
      // A window closed: the one beside it takes the space.
      env: { PISTACHIO_LAYOUT_SCRIPT: JSON.stringify({ opened: { move: "keep" }, closed: { move: "fill" }, asked: { move: "keep" } }) },
    }));
    await createTab(shell, urls[1]);
    await expect.poll(async () => (await snapshot(shell)).tabs.filter((tab) => urls.includes(tab.url)).length).toBe(2);
    const byUrl = new Map((await snapshot(shell)).tabs.map((tab) => [tab.url, tab.id]));
    tabs = [byUrl.get(urls[0])!, byUrl.get(urls[1])!];
    await createGroup(shell, "grow", tabs, "Growing", "green");
    await selectTab(shell, tabs[0]);
    await openGroupDesk(shell, "grow");
    await settled(shell, app);
    const stage = await box(shell, ".desk-stage");
    away = () => shell.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height * 0.95);
  });

  test.afterAll(async () => {
    await app?.close();
    server?.close();
  });

  /** Both windows out, side by side. */
  async function sideBySide(): Promise<void> {
    if ((await shell.locator(windowSelector(tabs[1])).count()) === 0) {
      await shell.locator(rowSelector(tabs[1])).click();
      await expect(shell.locator(windowSelector(tabs[1]))).toHaveCount(1);
    }
    await away();
    await settled(shell, app);
    await openMore(shell);
    await shell.getByTestId("desk-tile").click();
    await away();
    await settled(shell, app);
  }

  test("Fill the desk, pressed with its tooltip up, grows the window as its live page", async () => {
    await sideBySide();
    const fill = shell.locator(windowSelector(tabs[0])).getByRole("button", { name: "Fill the desk" });
    await fill.hover();
    // The tooltip is a cover: its own window is its still while it is up.
    await expect(shell.locator('[data-testid="desk-window-tip"][data-shown]')).toHaveCount(1);
    await expect(shell.locator(windowSelector(tabs[0]))).toHaveAttribute("data-drawn", "");
    const drawn = await watchDrawnFromPress(shell, tabs[0]);
    await fill.click();
    await settled(shell, app);
    const frames = await drawn();
    // Live from the frame after the press on (the tooltip gone with it): never its still, stretched to the desk.
    expect(frames.length).toBeGreaterThan(8);
    expect(frames.slice(2).filter(Boolean)).toEqual([]);
    await capture(app, shell, "01-filled-with-tooltip.png");
  });

  test("grown under the More card, its page stays laid out at the box it grew to, and is shown there without a resize", async () => {
    // Back beside its neighbour. Shrinking, it stays its live page, laid out at the sizes it passes through.
    const filled = await pageSize(app, urls[0]);
    const shrink = await watchDrawnFromPress(shell, tabs[0]);
    await shell.locator(windowSelector(tabs[0])).getByRole("button", { name: "Restore" }).click();
    await settled(shell, app);
    const shrinkFrames = await shrink();
    expect(shrinkFrames.length).toBeGreaterThan(8);
    expect(shrinkFrames.slice(2).filter(Boolean)).toEqual([]);
    const restored = await pageSize(app, urls[0]);
    expect(restored.width).toBeLessThan(filled.width - 100);
    expect(restored.resizes - filled.resizes).toBeGreaterThan(3);
    await sideBySide();
    const half = await pageSize(app, urls[0]);
    // The More card up over the desk's side: the window under it is its still.
    await openMore(shell);
    await expect(shell.locator(windowSelector(tabs[0]))).toHaveAttribute("data-drawn", "");
    // Its neighbour closed under the card: the window takes the space, still under it.
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(tabId), tabs[1]);
    await expect(shell.locator(windowSelector(tabs[1]))).toHaveCount(0);
    await settled(shell);
    await capture(app, shell, "02-grown-under-the-card.png");
    const stage = await box(shell, ".desk-stage");
    const grown = await box(shell, `${windowSelector(tabs[0])} [data-testid="desk-window-page"]`);
    expect(grown.width).toBeGreaterThan(stage.width * 0.9);
    await expect(shell.locator(windowSelector(tabs[0]))).toHaveAttribute("data-drawn", "");
    // Its page is laid out at the desk's width, though its view is down — not back at the half it had.
    await expect.poll(async () => (await pageSize(app, urls[0])).width).toBe(Math.round(grown.width));
    expect(half.width).toBeLessThan(stage.width * 0.6);
    const before = await pageSize(app, urls[0]);
    // The card gone, it is live: at the size it was laid out at, with nothing to lay out anew.
    await away();
    await expect(shell.locator('[data-testid="desk-more-card"]')).toHaveCount(0);
    await expect(shell.locator(windowSelector(tabs[0]))).not.toHaveAttribute("data-drawn", "");
    await settled(shell, app);
    const after = await pageSize(app, urls[0]);
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    expect(after.resizes).toBe(before.resizes);
    await capture(app, shell, "03-live-at-its-size.png");
  });
});

/**
 * How wide the page's corner square (`markCorner`) is drawn in the window's still, in CSS px: the run of its blue
 * along a row near its top, at the scale the still is drawn at. Null while the window shows no still.
 */
function cornerInStill(shell: Page, tabId: string): Promise<number | null> {
  return shell.evaluate(async (tabId) => {
    const img = document.querySelector<HTMLImageElement>(`[data-testid="desk-window"][data-tab-id="${tabId}"] [data-testid="desk-window-page"] img.desk-still`);
    if (img === null) return null;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(img, 0, 0);
    const row = context.getImageData(0, 4, img.naturalWidth, 1).data;
    let run = 0;
    for (let x = 2; x < img.naturalWidth; x += 1) {
      const [r, g, b] = [row[x * 4]!, row[x * 4 + 1]!, row[x * 4 + 2]!];
      if (b < 180 || r > 80 || g > 80) break;
      run += 1;
    }
    const scale = Math.max(img.clientWidth / img.naturalWidth, img.clientHeight / img.naturalHeight);
    return (run + 2) * scale;
  }, tabId);
}

/** A square 100 CSS px a side, solid blue, fixed in the page's top-left corner. */
function markCorner(app: ElectronApplication, url: string): Promise<void> {
  return app.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
    if (contents === undefined) throw new Error(`no page at ${url}`);
    await contents.executeJavaScript(
      `document.body.insertAdjacentHTML("beforeend", '<div style="position:fixed;left:0;top:0;width:100px;height:100px;background:#0000ff;z-index:9"></div>')`,
    );
  }, url);
}

// On a Retina display a page's picture is in the display's pixels, two to a CSS px. A window grown under a cover is
// its still, its page held at the box it grew to, and that still was cut to the box's size in CSS px — the top-left
// quarter of the picture — and drawn over the whole window: the page zoomed into its corner, dead to the pointer
// until the cover went (2026-10-08). Every other spec runs at 1×, where a pixel is a CSS px.
test("at 2×, a window grown under the More card is its page at its own scale, not zoomed into its corner", { tag: ["@desk"] }, async () => {
  test.setTimeout(90_000);
  const server = await serve();
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const urls = [`${origin}/a`, `${origin}/b`] as const;
  const { app, shell } = await launchDesk({
    name: "grow-2x",
    homeUrl: urls[0],
    args: ["--force-device-scale-factor=2"],
    env: { PISTACHIO_LAYOUT_SCRIPT: JSON.stringify({ opened: { move: "keep" }, closed: { move: "fill" }, asked: { move: "keep" } }) },
  });
  try {
    await createTab(shell, urls[1]);
    await expect.poll(async () => (await snapshot(shell)).tabs.filter((tab) => (urls as readonly string[]).includes(tab.url)).length).toBe(2);
    const byUrl = new Map((await snapshot(shell)).tabs.map((tab) => [tab.url, tab.id]));
    const tabs = [byUrl.get(urls[0])!, byUrl.get(urls[1])!] as const;
    await createGroup(shell, "grow", tabs, "Growing", "green");
    await selectTab(shell, tabs[0]);
    await openGroupDesk(shell, "grow");
    await settled(shell, app);
    const stage = await box(shell, ".desk-stage");
    const away = () => shell.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height * 0.95);
    await markCorner(app, urls[0]);
    await shell.locator(rowSelector(tabs[1])).click();
    await expect(shell.locator(windowSelector(tabs[1]))).toHaveCount(1);
    await away();
    await settled(shell, app);
    await openMore(shell);
    await shell.getByTestId("desk-tile").click();
    await away();
    await settled(shell, app);
    // The More card up over it: the window is its still, the square its own size.
    await openMore(shell);
    await expect(shell.locator(windowSelector(tabs[0]))).toHaveAttribute("data-drawn", "");
    await expect.poll(() => cornerInStill(shell, tabs[0])).toBeGreaterThan(90);
    // Its neighbour closed under the card: it grows, still under it, its page held at the box it grew to.
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(tabId), tabs[1]);
    await expect(shell.locator(windowSelector(tabs[1]))).toHaveCount(0);
    await settled(shell);
    const grown = await box(shell, `${windowSelector(tabs[0])} [data-testid="desk-window-page"]`);
    expect(grown.width).toBeGreaterThan(stage.width * 0.9);
    await expect(shell.locator(windowSelector(tabs[0]))).toHaveAttribute("data-drawn", "");
    // Every still it shows meanwhile has the square at 100 CSS px, as the page has it (it was 200: the corner zoomed).
    await shell.waitForTimeout(600);
    const drawn = await cornerInStill(shell, tabs[0]);
    expect(drawn).not.toBeNull();
    expect(drawn!).toBeGreaterThan(90);
    expect(drawn!).toBeLessThan(115);
    await capture(app, shell, "04-grown-under-the-card-2x.png");
  } finally {
    await app.close();
    server.close();
  }
});
