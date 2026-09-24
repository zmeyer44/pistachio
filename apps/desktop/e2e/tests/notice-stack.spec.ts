import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { noticePage, shellPage, shellReady } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/notice-stack");

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

function activeUrl(shell: Page): Promise<string | null> {
  return shell.evaluate(async () => {
    const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
    const current = await api.getSnapshot();
    return current.tabs.find((tab) => tab.id === current.activeTabId)?.url ?? null;
  });
}

/** The browser surface's box in the shell page: what the stack is stood in. */
function surfaceBox(shell: Page): Promise<Box> {
  return shell.evaluate(() => {
    const rect = document.querySelector(".browser-surface")!.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  });
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The notice view as main has it: on screen or not, where, and the page view it stands over. */
function noticeViewState(app: ElectronApplication): Promise<{ visible: boolean; bounds: Box; pane: Box | null; topmost: boolean }> {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    const views = window.contentView.children.filter((child) => "webContents" in child) as WebContentsView[];
    const notice = views.find((view) => view.webContents.getURL().endsWith("#notice"));
    if (notice === undefined) throw new Error("no notice view");
    const pane = views.find((view) => view.getVisible() && /^https?:/.test(view.webContents.getURL()));
    const shown = views.filter((view) => view.getVisible());
    return {
      visible: notice.getVisible(),
      bounds: notice.getBounds(),
      pane: pane === undefined ? null : pane.getBounds(),
      topmost: shown[shown.length - 1] === notice,
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

/** The window as a person sees it: the shell with its native child views composited in stacking order. */
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
        return [view.webContents.capturePage().then((image) => ({ bounds: view.getBounds(), png: image.toPNG().toString("base64") }))];
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
      new Promise((done, failed) => {
        const image = new Image();
        image.onload = () => done(image);
        image.onerror = () => failed(new Error("capture failed to decode"));
        image.src = `data:image/png;base64,${png}`;
      });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2d canvas context");
    context.drawImage(await decode(frame), 0, 0);
    for (const view of views) context.drawImage(await decode(view.png), Math.round(view.bounds.x * scale), Math.round(view.bounds.y * scale));
    return canvas.toDataURL("image/png");
  }, capture);
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(join(screenshotDirectory, filename), Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
}

/**
 * The notice used to be a feature of the chrome — a pill in the top strip,
 * a card at the foot of the sidebar — so with the compact sidebar hidden,
 * ⌘⇧C copied the address and said nothing anyone could see. It is now a
 * stack in a view of its own over the page, whatever the chrome is doing.
 */
test("⌘⇧C says so over the page with the compact sidebar hidden, and notices stack", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-notice-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>A page worth copying</title><body style='font: 16px system-ui; padding: 48px'><h1>A page worth copying</h1><p>Its address is the thing.</p>");
  });
  await new Promise<void>((listening, failed) => {
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => listening());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The test server did not bind a TCP port");
  const homeUrl = `http://127.0.0.1:${String(address.port)}/`;
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ general: { homePage: "url", homeUrl, newTab: "address" }, layout: { mode: "sidebar", sidebar: "compact" } }),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellReady(app);
    const notices = await noticePage(app);
    await notices.waitForLoadState("domcontentloaded");
    await expect.poll(() => activeUrl(shell)).toBe(homeUrl);
    await expect.poll(async () => (await noticeViewState(app)).pane).not.toBeNull();
    // Nothing said yet: the view is loaded and out of the way.
    expect((await noticeViewState(app)).visible).toBe(false);

    await shell.keyboard.press("Meta+Shift+C");
    const cards = notices.getByTestId("notice-card");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("URL copied");
    await expect(cards.first()).toHaveAttribute("data-phase", "live");
    await expect(cards.first()).toHaveAttribute("data-tone", "success");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(homeUrl);

    // Over the page: on screen, above every other view, centred on the pane's foot.
    const placed = await noticeViewState(app);
    expect(placed.visible).toBe(true);
    expect(placed.topmost).toBe(true);
    expect(placed.pane).not.toBeNull();
    const pane = placed.pane!;
    expect(Math.abs(placed.bounds.x + placed.bounds.width / 2 - (pane.x + pane.width / 2))).toBeLessThanOrEqual(12);
    expect(placed.bounds.y + placed.bounds.height).toBeGreaterThanOrEqual(pane.y + pane.height - 1);
    // And the page is still live under it: a notice is not a shell overlay.
    expect(pane.width).toBeGreaterThan(400);
    await notices.waitForTimeout(450);
    await captureWindow(app, "01-url-copied.png");

    // The same words again nudge the card; they do not stack a copy of it.
    await shell.keyboard.press("Meta+Shift+C");
    await expect(cards).toHaveCount(1);
    await expect(notices.locator(".notice-card-body[data-bumped]")).toHaveCount(1);

    // Something else joins the front, and the first is pushed back behind it.
    await shell.keyboard.press("Meta+Alt+Shift+C");
    await expect(cards).toHaveCount(2);
    await expect(notices.locator('[data-testid="notice-card"][data-depth="0"]')).toContainText("Link copied as Markdown");
    await expect(notices.locator('[data-testid="notice-card"][data-depth="1"]')).toContainText("URL copied");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(`[A page worth copying](${homeUrl})`);
    await notices.waitForTimeout(450);
    await captureWindow(app, "02-stacked.png");

    // The pointer spreads the stack into a column, and holds the clocks.
    const stack = notices.getByTestId("notice-stack");
    await stack.hover();
    await expect(stack).toHaveAttribute("data-spread", "");
    await notices.waitForTimeout(450);
    await captureWindow(app, "03-spread.png");
    const spreadBoxes = await cards.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top));
    expect(Math.abs((spreadBoxes[0] ?? 0) - (spreadBoxes[1] ?? 0))).toBeGreaterThan(40);
    await notices.waitForTimeout(4_600);
    await expect(cards).toHaveCount(2);

    // A card's own button takes just that card.
    await notices.locator('[data-testid="notice-card"][data-depth="0"]').getByRole("button", { name: "Dismiss" }).click();
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("URL copied");
    await expect(cards.first()).toHaveAttribute("data-depth", "0");

    // Left alone, the rest goes on its own, the view after it — and the keyboard goes back to the page.
    await notices.mouse.move(1, 1);
    await expect(cards).toHaveCount(0, { timeout: 12_000 });
    await expect.poll(async () => (await noticeViewState(app)).visible).toBe(false);
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0];
          const views = (window?.contentView.children ?? []).filter((child) => "webContents" in child) as WebContentsView[];
          return views.some((view) => view.webContents.getURL().endsWith("#notice") && view.webContents.isFocused());
        }),
      )
      .toBe(false);
  } finally {
    await app.close();
    await new Promise<void>((closed) => server.close(() => closed()));
  }
});

/**
 * Settings → Appearance says where the stack stands. The edge is also the
 * direction: at the top a pill drops in and the older ones go down behind it.
 */
test("the notice stack stands where Appearance says, and the picker moves it", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-notice-position-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({
      general: { homePage: "url", homeUrl: "pistachio://demo/invoices", newTab: "address" },
      appearance: { toastPosition: "top-right" },
    }),
  );
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellReady(app);
    const notices = await noticePage(app);
    await notices.waitForLoadState("domcontentloaded");
    await expect.poll(() => activeUrl(shell)).toBe("pistachio://demo/invoices");

    // The seeded corner: the view hangs from the top of the browser surface, against its right side.
    await shell.keyboard.press("Meta+Shift+C");
    const cards = notices.getByTestId("notice-card");
    const stack = notices.getByTestId("notice-stack");
    await expect(cards).toHaveCount(1);
    await expect(stack).toHaveAttribute("data-edge", "top");
    await expect(stack).toHaveAttribute("data-align", "right");
    let surface = await surfaceBox(shell);
    let placed = await noticeViewState(app);
    expect(placed.visible).toBe(true);
    expect(Math.abs(placed.bounds.y - surface.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(placed.bounds.x + placed.bounds.width - (surface.x + surface.width))).toBeLessThanOrEqual(1);

    // A second one goes in front, and the first retreats DOWNWARD behind it.
    await shell.keyboard.press("Meta+Alt+Shift+C");
    await expect(cards).toHaveCount(2);
    await notices.waitForTimeout(450);
    const tops = await notices.evaluate(() => {
      const top = (depth: string): number => document.querySelector(`[data-testid="notice-card"][data-depth="${depth}"]`)!.getBoundingClientRect().top;
      return { front: top("0"), behind: top("1") };
    });
    expect(tops.behind).toBeGreaterThan(tops.front);
    await captureWindow(app, "04-top-right.png");

    // The picker: a picture of the page with a pill at each place. Choosing one
    // moves the stack and says so from there — over Settings, which veils the
    // find bar and the bookmark card but not a notice.
    await shell.keyboard.press("Meta+,");
    const settings = shell.getByTestId("settings-page");
    await settings.getByRole("button", { name: "Appearance", exact: true }).click();
    const picker = settings.getByTestId("toast-position");
    await expect(picker.getByRole("radio", { name: "Top right corner" })).toHaveAttribute("aria-checked", "true");
    await picker.getByRole("radio", { name: "Bottom left corner" }).click();
    await expect(picker.getByRole("radio", { name: "Bottom left corner" })).toHaveAttribute("aria-checked", "true");
    await expect(notices.locator('[data-testid="notice-card"][data-depth="0"]')).toContainText("Notifications appear here");
    await expect(stack).toHaveAttribute("data-edge", "bottom");
    await expect(stack).toHaveAttribute("data-align", "left");
    surface = await surfaceBox(shell);
    await expect
      .poll(async () => {
        placed = await noticeViewState(app);
        return [Math.abs(placed.bounds.x - surface.x) <= 1, Math.abs(placed.bounds.y + placed.bounds.height - (surface.y + surface.height)) <= 1];
      })
      .toEqual([true, true]);
    expect(placed.visible).toBe(true);
    await notices.waitForTimeout(450);
    await captureWindow(app, "05-picker-bottom-left.png");

    // It is a setting like any other: written down, and there after a restart.
    const saved = await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      return (await api.getSettings()).appearance.toastPosition;
    });
    expect(saved).toBe("bottom-left");
  } finally {
    await app.close();
  }
});
