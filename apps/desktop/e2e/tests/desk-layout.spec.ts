/**
 * The desk's smart layout end to end (docs/desk-layout.md): a window that
 * comes out, one that leaves, and ⌘⌥L each ask the layout model about the
 * desk, and the desk lays itself out as the model judged — with a notice
 * whose Undo puts it back — or, with the Feel's Layout set to By hand, stays
 * as it is.
 *
 * The model is scripted (PISTACHIO_LAYOUT_SCRIPT, main/desk-layout.ts): the
 * real evaluator, IPC hop, policy and geometry run over it, and the answers
 * are stated here. The pages are a local server's, so every window has a
 * title of its own for the script to name.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { noticePage, pageFirst, shellReady } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/desk-layout");

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [process.env["PISTACHIO_ELECTRON_PATH"], join(process.cwd(), "node_modules/electron", suffix)].find(
    (candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

function api<T>(shell: Page, call: (pistachio: PistachioApi) => Promise<T>): Promise<T> {
  return shell.evaluate(`(${call.toString()})(window.pistachio)`) as Promise<T>;
}

const snapshot = (shell: Page): Promise<ShellSnapshot> => api(shell, (pistachio) => pistachio.getSnapshot());

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function box(page: Page, selector: string): Promise<Box> {
  const found = await page.locator(selector).first().boundingBox();
  if (found === null) throw new Error(`${selector} has no box`);
  return found;
}

const windowSelector = (tabId: string): string => `[data-testid="desk-window"][data-tab-id="${tabId}"]`;
const iconSelector = (tabId: string): string => `[data-testid="desk-dock-icon"][data-tab-id="${tabId}"] .desk-dock-tile`;
/** The dock's column (DOCK_W) and the gap beside it; the Bar's band (and gap) at the desk's foot. */
const DOCK_COLUMN = 60 + 8;
const BAR_BAND = 52 + 8;
const GAP = 8;

/** The desk is at rest: nothing entering, nothing in hand, nothing flying or settling. */
async function settled(shell: Page): Promise<void> {
  await expect(shell.locator('.desk-stage[data-phase="open"]')).toHaveCount(1);
  await expect(shell.locator(".desk-stage[data-gesture]")).toHaveCount(0);
  await expect(shell.locator('[data-testid="desk-window"][data-flight]')).toHaveCount(0);
  await shell.waitForTimeout(900);
}

/** The window as a person sees it: the shell with every live page composited over it at its box. */
async function capture(app: ElectronApplication, shell: Page, filename: string): Promise<void> {
  const layers = await app.evaluate(async ({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    const base = (await window.capturePage()).toDataURL();
    const views: Array<{ dataUrl: string; bounds: { x: number; y: number; width: number; height: number } }> = [];
    for (const child of window.contentView.children) {
      if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) continue;
      const view = child as WebContentsView;
      if (Object.values(hashes).some((hash) => view.webContents.getURL().endsWith(hash))) continue;
      views.push({ dataUrl: (await view.webContents.capturePage()).toDataURL(), bounds: view.getBounds() });
    }
    return { base, views };
  }, CHROME_VIEW_HASHES);
  const png = await shell.evaluate(async ({ base, views }) => {
    const load = (src: string): Promise<HTMLImageElement> =>
      new Promise((done, fail) => {
        const image = new Image();
        image.onload = () => done(image);
        image.onerror = fail;
        image.src = src;
      });
    const ground = await load(base);
    const canvas = document.createElement("canvas");
    canvas.width = ground.naturalWidth;
    canvas.height = ground.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(ground, 0, 0);
    const scale = ground.naturalWidth / window.innerWidth;
    for (const view of views) {
      const image = await load(view.dataUrl);
      const { x, y, width, height } = view.bounds;
      context.save();
      context.beginPath();
      context.roundRect(x * scale, y * scale, width * scale, height * scale, 8 * scale);
      context.clip();
      context.drawImage(image, x * scale, y * scale, width * scale, height * scale);
      context.restore();
    }
    return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
  }, layers);
  await writeFile(join(screenshotDirectory, filename), Buffer.from(png, "base64"));
}

/** Move the window off the real cursor: a drag's native layer relays where the REAL pointer is. */
async function clearOfCursor(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = window.getBounds();
    const inside = cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width && cursor.y >= bounds.y && cursor.y < bounds.y + bounds.height;
    if (!inside) return;
    const area = screen.getDisplayNearestPoint(cursor).workArea;
    const x = cursor.x - area.x > bounds.width + 20 ? area.x : cursor.x + 20 + bounds.width <= area.x + area.width ? cursor.x + 20 : null;
    const y = cursor.y - area.y > bounds.height + 20 ? area.y : cursor.y + 20 + bounds.height <= area.y + area.height ? cursor.y + 20 : null;
    if (x !== null) window.setPosition(x, bounds.y);
    else if (y !== null) window.setPosition(bounds.x, y);
  });
}

/** Pages with titles of their own. */
const PAGES: Record<string, string> = {
  "/budget": "Q3 budget - Sheets",
  "/inbox": "Inbox - Mail",
  "/invoice": "Invoice #2048 - Atlas Medical Supply",
  "/vendor": "Atlas Medical Supply - Vendor record",
};

function serve(): Promise<Server> {
  const server = createServer((request, response) => {
    const title = PAGES[request.url ?? ""] ?? "Page";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>${title}</title><body style="font:16px system-ui;margin:24px"><h1>${title}</h1></body>`);
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

test("a window coming out, one leaving, and ⌘⌥L lay the desk out as the layout model judges, with Undo; By hand, nothing moves", async () => {
  test.setTimeout(120_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  await mkdir(screenshotDirectory, { recursive: true });
  const server = await serve();
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const urls = ["/budget", "/inbox", "/invoice", "/vendor"].map((path) => `${origin}${path}`);
  const userData = await mkdtemp(join(tmpdir(), "pistachio-desk-layout-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst({ onboarding: { completed: true, completedAt: null }, general: { homeUrl: urls[0] } })));
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: {
      ...process.env,
      PISTACHIO_E2E: "1",
      PISTACHIO_USER_DATA: userData,
      // The model's answers, by what happened: a window just out goes beside the invoice; a gap is closed up; asked, the budget is the main work.
      PISTACHIO_LAYOUT_SCRIPT: JSON.stringify({
        opened: { move: "pair", partner: "Invoice #2048" },
        closed: { move: "fill" },
        asked: { move: "focus", main: "Q3 budget" },
      }),
    },
  });
  try {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    await clearOfCursor(app);
    const shell = await shellReady(app);
    const notices = await noticePage(app);
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === urls[0])).toBe(true);
    for (const url of urls.slice(1)) await shell.evaluate((address) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(address), url);
    await expect.poll(async () => (await snapshot(shell)).tabs.filter((tab) => urls.includes(tab.url) && tab.title !== "").length).toBe(urls.length);
    const byUrl = new Map((await snapshot(shell)).tabs.map((tab) => [tab.url, tab.id]));
    const [budget, inbox, invoice, vendor] = urls.map((url) => byUrl.get(url)!) as [string, string, string, string];
    await shell.evaluate((tabIds) => (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "create", id: "desk-layout", tabIds, title: "Accounts", color: "orange" }), [budget, inbox, invoice, vendor]);
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), budget);
    const group = shell.getByTestId("tab-group");
    await group.getByTestId("tab-group-header").hover();
    await group.getByTestId("tab-group-desk").click();
    await expect(shell.getByTestId("desk-dock-icon")).toHaveCount(4);
    await settled(shell);
    const stage = await box(shell, ".desk-stage");
    const awayFromDock = (): Promise<void> => shell.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height * 0.95);
    // Two more windows out (nothing for the model to move: the script's partner is not out yet, or is the window itself), then tiled.
    for (const tabId of [inbox, invoice]) {
      await shell.locator(iconSelector(tabId)).click();
      await expect(shell.locator(windowSelector(tabId))).toHaveCount(1);
    }
    await awayFromDock();
    await settled(shell);
    await shell.getByTestId("desk-more").hover();
    await expect(shell.locator('[data-testid="desk-more-card"][data-shown]')).toHaveCount(1);
    await expect(shell.getByTestId("desk-arrange")).toContainText("⌘⌥L");
    await shell.getByTestId("desk-tile").click();
    await awayFromDock();
    await settled(shell);

    // The desk in its own terms: the usable box beside the dock, above the Bar.
    const left = stage.x + DOCK_COLUMN;
    const width = stage.x + stage.width - left;
    const height = stage.height - BAR_BAND;
    const halfW = (width - GAP) / 2;
    const halfH = (height - GAP) / 2;
    const near = (actual: Box, expected: { x: number; y: number; width: number; height: number }): string => {
      const off = Math.max(
        Math.abs(actual.x - expected.x),
        Math.abs(actual.y - expected.y),
        Math.abs(actual.width - expected.width),
        Math.abs(actual.height - expected.height),
      );
      return off <= 2 ? "there" : `off by ${off.toFixed(1)}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`;
    };
    const at = (tabId: string): Promise<Box> => box(shell, windowSelector(tabId));
    const quarter = {
      topLeft: { x: left, y: stage.y, width: halfW, height: halfH },
      topRight: { x: left + halfW + GAP, y: stage.y, width: halfW, height: halfH },
      bottomLeft: { x: left, y: stage.y + halfH + GAP, width: halfW, height: halfH },
      bottomRight: { x: left + halfW + GAP, y: stage.y + halfH + GAP, width: halfW, height: halfH },
    };
    const leftHalf = { x: left, y: stage.y, width: halfW, height };
    await expect.poll(async () => near(await at(budget), leftHalf)).toBe("there");
    await expect.poll(async () => near(await at(inbox), quarter.topRight)).toBe("there");
    await expect.poll(async () => near(await at(invoice), quarter.bottomRight)).toBe("there");
    await capture(app, shell, "01-tiled.png");

    // ── 1. A window out: the rule split the budget, the model sets it beside the invoice ─
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), budget);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(budget);
    await shell.locator(iconSelector(vendor)).click();
    await expect(shell.locator(windowSelector(vendor))).toHaveCount(1);
    await awayFromDock();
    const card = notices.getByTestId("notice-card").filter({ hasText: "beside" });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Put “Atlas Medical Supply - Vendor r…” beside “Invoice #2048 - Atlas Medical S…”");
    await settled(shell);
    // The budget has its half back; the invoice's quarter is shared, side by side.
    const shared = quarter.bottomRight;
    const sharedW = (shared.width - GAP) / 2;
    await expect.poll(async () => near(await at(budget), leftHalf)).toBe("there");
    await expect.poll(async () => near(await at(invoice), { ...shared, width: sharedW })).toBe("there");
    await expect.poll(async () => near(await at(vendor), { ...shared, x: shared.x + sharedW + GAP, width: sharedW })).toBe("there");
    await capture(app, shell, "02-paired.png");
    // Undo: where the rule put it, splitting the budget.
    await card.getByRole("button", { name: "Undo" }).click();
    await settled(shell);
    await expect.poll(async () => near(await at(budget), quarter.topLeft)).toBe("there");
    await expect.poll(async () => near(await at(vendor), quarter.bottomLeft)).toBe("there");
    await expect.poll(async () => near(await at(invoice), quarter.bottomRight)).toBe("there");
    await capture(app, shell, "03-undone.png");

    // ── 2. A window leaves: its neighbour closes the gap up, as a split view's pane does ─
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(tabId), inbox);
    await expect(shell.locator(windowSelector(inbox))).toHaveCount(0);
    await expect(notices.getByTestId("notice-card").filter({ hasText: "took the space" })).toHaveCount(1);
    await settled(shell);
    await expect.poll(async () => near(await at(budget), { x: left, y: stage.y, width, height: halfH })).toBe("there");
    await expect.poll(async () => near(await at(vendor), quarter.bottomLeft)).toBe("there");
    await capture(app, shell, "04-filled.png");

    // ── 3. ⌘⌥L: asked, the budget is the main work and takes the main place ─
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("pistachio:shell-command", { type: "runShortcut", id: "arrangeDesk" });
    });
    await expect(notices.getByTestId("notice-card").filter({ hasText: "the main place" })).toHaveCount(1);
    await settled(shell);
    const mainW = Math.round((width - GAP) * 0.62);
    await expect.poll(async () => near(await at(budget), { x: left, y: stage.y, width: mainW, height })).toBe("there");
    const column = { x: left + mainW + GAP, width: width - mainW - GAP };
    for (const tabId of [vendor, invoice]) {
      const placed = await at(tabId);
      expect(Math.abs(placed.x - column.x)).toBeLessThan(2);
      expect(Math.abs(placed.width - column.width)).toBeLessThan(2);
    }
    await capture(app, shell, "05-focused.png");

    // ── 4. By hand: a window leaving moves nothing ─
    await shell.getByTestId("desk-more").hover();
    await expect(shell.locator('[data-testid="desk-more-card"][data-shown]')).toHaveCount(1);
    await shell.getByTestId("desk-variant-layout").click();
    await expect(shell.getByTestId("desk-variant-layout")).toHaveAttribute("data-value", "hand");
    await awayFromDock();
    await settled(shell);
    const before = await at(budget);
    // (The close up above may still be saying so.)
    const said = await notices.getByTestId("notice-card").count();
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(tabId), vendor);
    await expect(shell.locator(windowSelector(vendor))).toHaveCount(0);
    await shell.waitForTimeout(1_200);
    expect(near(await at(budget), before)).toBe("there");
    expect(await notices.getByTestId("notice-card").count()).toBeLessThanOrEqual(said);
    await capture(app, shell, "06-by-hand.png");
  } finally {
    await app.close();
    server.close();
  }
});
