import { createServer, type Server } from "node:http";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellReady } from "./windows";
import { launchApp } from "./app";
import { captureShell, revealPaneToolbar, snapshot } from "./chrome-harness";

const FOLDER = "pane-toolbar";
const LONG_TITLE = "A considerably longer page title that needs more room than the minimum allows";

/** Pages titled by their path; /long wears a title wider than the button's minimum. */
async function startPages(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (request.url === "/long") response.end(`<!doctype html><title>${LONG_TITLE}</title><p>long</p>`);
    else response.end(`<!doctype html><title>Page ${request.url ?? ""}</title><p>${request.url ?? ""}</p>`);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture did not bind a TCP port");
  return { server, origin: `http://127.0.0.1:${String(address.port)}` };
}

function cluster(shell: Page, tabId: string) {
  return shell.locator(`[data-testid="pane-toolbar-cluster"][data-tab-id="${tabId}"]`);
}

async function urlOf(shell: Page, tabId: string): Promise<string | undefined> {
  return (await snapshot(shell)).tabs.find((tab) => tab.id === tabId)?.url;
}

/** Opens `first`, then navigates the same tab to `second`, so it has a back entry. */
async function tabWithHistory(shell: Page, first: string, second: string): Promise<string> {
  const tabId = await shell.evaluate(async (url) => {
    const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
    await api.createTab(url);
    return (await api.getSnapshot()).activeTabId;
  }, first);
  if (tabId === null) throw new Error("no active tab");
  await expect.poll(() => urlOf(shell, tabId)).toBe(first);
  await shell.evaluate(
    ([id, url]) => (window as unknown as { pistachio: PistachioApi }).pistachio.navigate(id, url),
    [tabId, second] as const,
  );
  await expect.poll(async () => (await snapshot(shell)).tabs.find((t) => t.id === tabId)?.canGoBack).toBe(true);
  return tabId;
}

/** The cluster's and its title button's boxes, read while the row is up. */
async function titleGeometry(shell: Page, tabId: string): Promise<{ cluster: number; title: number; titleRight: number; closeRight: number; clusterRight: number }> {
  let geometry: { cluster: number; title: number; titleRight: number; closeRight: number; clusterRight: number } | undefined;
  await expect(async () => {
    await revealPaneToolbar(shell);
    const row = cluster(shell, tabId);
    const clusterBox = await row.boundingBox({ timeout: 1_000 });
    const titleBox = await row.getByTestId("pane-toolbar-title").boundingBox({ timeout: 1_000 });
    const closeBox = await row.getByTestId("pane-toolbar-close").boundingBox({ timeout: 1_000 });
    if (clusterBox === null || titleBox === null || closeBox === null) throw new Error("pane toolbar geometry is unavailable");
    geometry = {
      cluster: clusterBox.width,
      title: titleBox.width,
      titleRight: titleBox.x + titleBox.width,
      closeRight: closeBox.x + closeBox.width,
      clusterRight: clusterBox.x + clusterBox.width,
    };
  }).toPass({ timeout: 20_000 });
  if (geometry === undefined) throw new Error("pane toolbar geometry is unavailable");
  return geometry;
}

// One window, pinned: the pane toolbar over a single pane, the same pane with
// the sidebar compact (⌘S), a split's two toolbars, and last — it resizes
// the window — how the title button gives way.
test.describe.serial("the pane toolbar", { tag: ["@sidebar", "@split"] }, () => {
  test.describe.configure({ timeout: 60_000 });
  let app: ElectronApplication;
  let shell: Page;
  let server: Server;
  let origin: string;
  let left: string;

  test.beforeAll(async () => {
    ({ server, origin } = await startPages());
    ({ app } = await launchApp({ settings: { layout: { sidebar: "pinned" } }, name: "pane-toolbar" }));
    shell = await shellReady(app);
  });

  test.afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
  });

  test("a pinned sidebar over a single pane leaves navigation to the sidebar", async () => {
    left = await tabWithHistory(shell, `${origin}/left-1`, `${origin}/left-2`);
    await revealPaneToolbar(shell);
    await expect(cluster(shell, left).getByTestId("pane-toolbar-close")).toBeVisible();
    await expect(cluster(shell, left).getByTestId("pane-toolbar-back")).toHaveCount(0);
    await captureShell(app, FOLDER, "01-pinned-single.png");
  });

  test("a compact sidebar puts back, forward and reload on the pane toolbar", async () => {
    await shell.keyboard.press("Meta+s");
    await expect(shell.getByTestId("sidebar-edge")).toBeVisible();
    await revealPaneToolbar(shell);
    const row = cluster(shell, left);
    await expect(row.getByTestId("pane-toolbar-back")).toBeVisible();
    await expect(row.getByTestId("pane-toolbar-forward")).toHaveAttribute("aria-disabled", "true");
    await expect(row.getByTestId("pane-toolbar-reload")).toBeVisible();
    // The controls sit to the left of the title.
    const back = await row.getByTestId("pane-toolbar-back").boundingBox();
    const title = await row.getByTestId("pane-toolbar-title").boundingBox();
    if (back === null || title === null) throw new Error("pane toolbar geometry is unavailable");
    expect(back.x).toBeLessThan(title.x);
    await captureShell(app, FOLDER, "02-compact.png");

    await row.getByTestId("pane-toolbar-back").click();
    await expect.poll(() => urlOf(shell, left)).toBe(`${origin}/left-1`);
    await expect(row.getByTestId("pane-toolbar-forward")).not.toHaveAttribute("aria-disabled", "true");
    await row.getByTestId("pane-toolbar-forward").click();
    await expect.poll(() => urlOf(shell, left)).toBe(`${origin}/left-2`);

    // Pinned again for the rest.
    await shell.keyboard.press("Meta+s");
    await expect(shell.getByTestId("sidebar-chrome")).toBeVisible();
  });

  test("a split view gives each pane its own navigation, bound to that pane", async () => {
    const right = await tabWithHistory(shell, `${origin}/right-1`, `${origin}/right-2`);
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.splitWith(tabId, "right"), left);
    await expect(shell.getByTestId("secondary-pane")).toBeVisible();
    await revealPaneToolbar(shell);
    await expect(cluster(shell, left).getByTestId("pane-toolbar-back")).toBeVisible();
    await expect(cluster(shell, right).getByTestId("pane-toolbar-back")).toBeVisible();
    await captureShell(app, FOLDER, "03-split.png");

    // Back on one pane moves that pane's tab only.
    await revealPaneToolbar(shell);
    const active = (await snapshot(shell)).activeTabId;
    const other = active === left ? right : left;
    await cluster(shell, other).getByTestId("pane-toolbar-back").click();
    await expect.poll(() => urlOf(shell, other)).toBe(other === left ? `${origin}/left-1` : `${origin}/right-1`);
    expect(await urlOf(shell, active!)).toBe(active === left ? `${origin}/left-2` : `${origin}/right-2`);

    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.setSplit("single"));
    await expect(shell.getByTestId("secondary-pane")).toHaveCount(0);
  });

  test("the pane toolbar's title button is as wide as its title, not the pane", async () => {
    const shortId = (await snapshot(shell)).activeTabId;
    if (shortId === null) throw new Error("no active tab");

    // A short title: the button rests at its minimum, well short of the pane,
    // and close still sits at the pane's far edge.
    const short = await titleGeometry(shell, shortId);
    await captureShell(app, FOLDER, "04-short-title.png");
    expect(short.title).toBeGreaterThanOrEqual(160);
    expect(short.title).toBeLessThan(short.cluster / 2);
    expect(short.closeRight).toBeCloseTo(short.clusterRight, 0);

    // A long title widens the button past its minimum.
    const longId = await shell.evaluate(async (url) => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      await api.createTab(url);
      return (await api.getSnapshot()).activeTabId;
    }, `${origin}/long`);
    if (longId === null) throw new Error("no active tab");
    await expect(cluster(shell, longId)).toContainText(LONG_TITLE, { timeout: 15_000 });
    const long = await titleGeometry(shell, longId);
    await captureShell(app, FOLDER, "05-long-title.png");
    expect(long.title).toBeGreaterThan(short.title + 100);
    expect(long.title).toBeLessThan(long.cluster);

    // In a narrow pane the button gives way (the title truncates) instead of
    // pushing close off the pane.
    await shell.evaluate(
      (tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.splitWith(tabId, "right"),
      shortId,
    );
    await expect(shell.getByTestId("secondary-pane")).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(820, 700);
    });
    await expect.poll(async () => (await titleGeometry(shell, longId)).cluster).toBeLessThan(400);
    const narrow = await titleGeometry(shell, longId);
    await captureShell(app, FOLDER, "06-narrow-split.png");
    expect(narrow.closeRight).toBeLessThanOrEqual(narrow.clusterRight + 0.5);
    expect(narrow.titleRight).toBeLessThan(narrow.clusterRight);
  });
});
