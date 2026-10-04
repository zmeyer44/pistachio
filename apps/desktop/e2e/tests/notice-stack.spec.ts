import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { noticePage, shellReady } from "./windows";
import { launchApp } from "./app";
import { capturePage, captureWindow as captureComposite, settled, snapshot, visibleTabViews } from "./chrome-harness";

const FOLDER = "notice-stack";

function captureWindow(app: ElectronApplication, filename: string, settleMs = 0): Promise<void> {
  return captureComposite(app, FOLDER, filename, settleMs);
}

async function activeUrl(shell: Page): Promise<string | null> {
  const current = await snapshot(shell);
  return current.tabs.find((tab) => tab.id === current.activeTabId)?.url ?? null;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The browser surface's box in the shell page: what the stack is stood in. */
function surfaceBox(shell: Page): Promise<Box> {
  return shell.evaluate(() => {
    const rect = document.querySelector(".browser-surface")!.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  });
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

/** The first visible tab view's load state and address. */
function visibleTabLoadState(app: ElectronApplication): Promise<{ loading: boolean; url: string } | null> {
  return app.evaluate(({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    const tab = window.contentView.children.find((child) => {
      if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) return false;
      const url = (child as WebContentsView).webContents.getURL();
      return !Object.values(hashes).some((hash) => url.endsWith(hash));
    }) as WebContentsView | undefined;
    return tab === undefined ? null : { loading: tab.webContents.isLoading(), url: tab.webContents.getURL() };
  }, CHROME_VIEW_HASHES);
}

// One window over a page served here, with the compact sidebar hidden: the
// notices it says and where they stand, the Appearance pickers, and a shell
// toast — reader view on a page with no article, which needs no network.
test.describe.serial("notices", { tag: ["@settings", "@notices", "@pages"] }, () => {
  test.describe.configure({ timeout: 60_000 });
  let server: Server;
  let homeUrl: string;
  let app: ElectronApplication;
  let userData: string;
  let shell: Page;
  let notices: Page;

  test.beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>A page worth copying</title><body style='font: 16px system-ui; padding: 48px'><h1>A page worth copying</h1><p>Its address is the thing.</p>");
    });
    await new Promise<void>((listening, failed) => {
      server.once("error", failed);
      server.listen(0, "127.0.0.1", () => listening());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("The test server did not bind a TCP port");
    homeUrl = `http://127.0.0.1:${String(address.port)}/`;
    ({ app, userData } = await launchApp({
      settings: { general: { homePage: "url", homeUrl, newTab: "address" }, layout: { sidebar: "compact" } },
      name: "notice",
    }));
    shell = await shellReady(app);
    notices = await noticePage(app);
    await notices.waitForLoadState("domcontentloaded");
  });

  test.afterAll(async () => {
    await app?.close();
    await new Promise<void>((closed) => server?.close(() => closed()));
  });

  /**
   * The notice used to be a feature of the chrome — a pill in the top strip,
   * a card at the foot of the sidebar — so with the compact sidebar hidden,
   * ⌘⇧C copied the address and said nothing anyone could see. It is now a
   * stack in a view of its own over the page, whatever the chrome is doing.
   */
  test("⌘⇧C says so over the page with the compact sidebar hidden, and notices stack", async () => {
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
    await captureWindow(app, "01-url-copied.png", 450);

    // The same words again nudge the card; they do not stack a copy of it.
    await shell.keyboard.press("Meta+Shift+C");
    await expect(cards).toHaveCount(1);
    await expect(notices.locator(".notice-card-body[data-bumped]")).toHaveCount(1);
    // The oldest clock there is: the card's own, from no later than now.
    const oldestClockFrom = Date.now();

    // Something else joins the front, and the first is pushed back behind it.
    await shell.keyboard.press("Meta+Alt+Shift+C");
    await expect(cards).toHaveCount(2);
    await expect(notices.locator('[data-testid="notice-card"][data-depth="0"]')).toContainText("Link copied as Markdown");
    await expect(notices.locator('[data-testid="notice-card"][data-depth="1"]')).toContainText("URL copied");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(`[A page worth copying](${homeUrl})`);
    await captureWindow(app, "02-stacked.png", 450);

    // The pointer spreads the stack into a column, and holds the clocks:
    // past the moment the older card would have gone (NOTICE_MS, 4.5s), both stay.
    const stack = notices.getByTestId("notice-stack");
    await stack.hover();
    await expect(stack).toHaveAttribute("data-spread", "");
    await captureWindow(app, "03-spread.png", 450);
    await settled(stack);
    const spreadBoxes = await cards.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top));
    expect(Math.abs((spreadBoxes[0] ?? 0) - (spreadBoxes[1] ?? 0))).toBeGreaterThan(40);
    await notices.waitForTimeout(Math.max(0, oldestClockFrom + 4_500 + 300 - Date.now()));
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
  });

  /**
   * Settings → Appearance says where the stack stands. The edge is also the
   * direction: at the top a pill drops in and the older ones go down behind it.
   */
  test("the notice stack stands where Appearance says, and the picker moves it", async () => {
    await shell.evaluate(() =>
      (window as unknown as { pistachio: PistachioApi }).pistachio.updateSettings({ appearance: { toastPosition: "top-right" } }),
    );

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
    await settled(stack);
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
    await captureWindow(app, "05-picker-bottom-left.png", 450);

    // It is a setting like any other: written down.
    const saved = await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      return (await api.getSettings()).appearance.toastPosition;
    });
    expect(saved).toBe("bottom-left");
  });

  // The same Appearance page. (That a choice is applied at launch is
  // apps/desktop/test/desktop-icon.test.ts's, and in development both
  // choices are the same icon file, so a restart would show nothing more.)
  test("the desktop icon switches at once from Appearance", async () => {
    test.skip(process.platform !== "darwin", "This journey checks the macOS Dock API.");
    const settings = shell.getByTestId("settings-page");
    if (!(await settings.isVisible())) await shell.keyboard.press("Meta+,");
    await settings.getByRole("button", { name: "Appearance", exact: true }).click();
    // A fresh profile should visibly choose the white default.
    await expect(settings.getByTestId("desktop-icon-white")).toBeChecked();
    await expect(settings.getByTestId("desktop-icon-option-white")).toHaveAttribute("data-selected", "true");
    await settings.getByTestId("desktop-icon-picker").evaluate((element) => element.scrollIntoView({ block: "center" }));
    await capturePage(shell, FOLDER, "06-desktop-icon-white-default.png");

    // Observe the real Dock setter while preserving its native behavior.
    await app.evaluate(({ app }) => {
      const state = globalThis as typeof globalThis & { iconCalls: string[] };
      state.iconCalls = [];
      const dock = app.dock!;
      const setIcon = dock.setIcon.bind(dock);
      dock.setIcon = (icon) => {
        state.iconCalls.push(String(icon));
        setIcon(icon);
      };
    });
    const storedIcon = async () => (JSON.parse(await readFile(join(userData, "settings.json"), "utf8")) as { appearance: { desktopIcon?: string } }).appearance.desktopIcon;
    await settings.getByText("Green", { exact: true }).click();
    await expect(settings.getByTestId("desktop-icon-green")).toBeChecked();
    await expect(settings.getByTestId("desktop-icon-option-green")).toHaveAttribute("data-selected", "true");
    await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { iconCalls: string[] }).iconCalls.at(-1))).toMatch(/icon-macos-dev\.png$/);
    await expect.poll(storedIcon).toBe("green");
    await capturePage(shell, FOLDER, "07-desktop-icon-green-selected.png");

    // The default remains available after opting into green.
    await settings.getByTestId("desktop-icon-white").focus();
    await settings.getByTestId("desktop-icon-white").press("Space");
    await expect(settings.getByTestId("desktop-icon-white")).toBeChecked();
    await expect(settings.getByTestId("desktop-icon-option-white")).toHaveAttribute("data-selected", "true");
    await expect.poll(storedIcon).toBe("white");
  });

  /**
   * A navigation that fails is NOT this toast any more: Chromium's empty error
   * document is dressed in the tab itself (main/navigation-error-page.ts), so
   * the page keeps its address and the tab view stays up. The shell toast is
   * for a chrome action that could not do what was asked — reader view on a
   * page with no article is the smallest of those, and it needs no network.
   */
  test("an error toast renders above tab WebContentsViews", async () => {
    const settings = shell.getByTestId("settings-page");
    if (await settings.isVisible()) {
      await shell.keyboard.press("Escape");
      await expect(settings).toBeHidden();
    }
    await expect.poll(() => visibleTabViews(app)).toBe(1);
    // The page must have settled first: a load that supersedes one still in
    // flight is aborted by Chromium rather than failed, and an abort is not
    // an error the shell shows.
    await expect.poll(() => visibleTabLoadState(app)).toMatchObject({ loading: false, url: homeUrl });

    // ⌘⇧A from the chrome: main finds no article and the shell says so.
    await shell.keyboard.press("Meta+Shift+A");
    const alert = shell.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/no article to read/i);
    await expect.poll(() => visibleTabViews(app)).toBe(0);
    await captureWindow(app, "08-failed-reader-toast.png");

    // A subsequent successful action clears the toast and restores the live
    // page; the overlay is not allowed to strand a hidden tab view.
    await shell.keyboard.press("Meta+l");
    const input = shell.getByTestId("address-input");
    await input.fill("pistachio://demo/invoices");
    await input.press("Enter");
    await expect(alert).toHaveCount(0);
    await expect.poll(() => visibleTabViews(app)).toBe(1);
    await expect.poll(() => visibleTabLoadState(app)).toEqual({ loading: false, url: "pistachio://demo/invoices" });
    await captureWindow(app, "09-live-page-restored.png");
  });
});
