import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/pane-toolbar-title");

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", executableSuffix),
    resolve(
      process.cwd(),
      "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron",
      executableSuffix,
    ),
  ];
  return candidates.find(
    (candidate) =>
      candidate !== undefined &&
      existsSync(candidate) &&
      existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

async function captureShell(app: ElectronApplication, filename: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return (await window.capturePage()).toPNG().toString("base64");
  });
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(join(screenshotDirectory, filename), Buffer.from(png, "base64"));
}

const LONG_TITLE = "A considerably longer page title that needs more room than the minimum allows";

async function startTitledPage(): Promise<{ server: Server; origin: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>${LONG_TITLE}</title><p>long</p>`);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture did not bind a TCP port");
  return { server, origin: `http://127.0.0.1:${String(address.port)}` };
}

/** The pane toolbar, revealed the Playwright way (see pane-toolbar-unsplit.spec.ts). */
async function revealPaneToolbar(shell: Page): Promise<void> {
  await expect(async () => {
    const trigger = shell.getByTestId("pane-toolbar-trigger");
    if ((await trigger.count()) > 0) await trigger.dispatchEvent("pointermove");
    await expect(shell.getByTestId("pane-toolbar")).not.toHaveAttribute("data-hidden", "", { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await shell.getByTestId("browser-surface").evaluate(async (surface) => {
    await Promise.all(surface.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined)));
  });
}

/** The cluster's and its title button's boxes, read while the row is up. */
async function titleGeometry(shell: Page, tabId: string): Promise<{ cluster: number; title: number; titleRight: number; closeRight: number; clusterRight: number }> {
  let geometry: { cluster: number; title: number; titleRight: number; closeRight: number; clusterRight: number } | undefined;
  await expect(async () => {
    await revealPaneToolbar(shell);
    const cluster = shell.locator(`[data-testid="pane-toolbar-cluster"][data-tab-id="${tabId}"]`);
    const clusterBox = await cluster.boundingBox({ timeout: 1_000 });
    const titleBox = await cluster.getByTestId("pane-toolbar-title").boundingBox({ timeout: 1_000 });
    const closeBox = await cluster.getByTestId("pane-toolbar-close").boundingBox({ timeout: 1_000 });
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

test("the pane toolbar's title button is as wide as its title, not the pane", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-pane-toolbar-title-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" } }),
  );

  const { server, origin } = await startTitledPage();
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    const shortId = await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      return (await api.getSnapshot()).activeTabId;
    });
    if (shortId === null) throw new Error("no active tab");

    // A short title: the button rests at its minimum, well short of the pane,
    // and close still sits at the pane's far edge.
    const short = await titleGeometry(shell, shortId);
    await captureShell(app, "01-short-title.png");
    expect(short.title).toBeGreaterThanOrEqual(160);
    expect(short.title).toBeLessThan(short.cluster / 2);
    expect(short.closeRight).toBeCloseTo(short.clusterRight, 0);

    // A long title widens the button past its minimum.
    const longId = await shell.evaluate(async (url) => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      await api.createTab(url);
      return (await api.getSnapshot()).activeTabId;
    }, `${origin}/`);
    if (longId === null) throw new Error("no active tab");
    await expect(shell.locator(`[data-testid="pane-toolbar-cluster"][data-tab-id="${longId}"]`)).toContainText(LONG_TITLE, { timeout: 15_000 });
    const long = await titleGeometry(shell, longId);
    await captureShell(app, "02-long-title.png");
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
    await expect
      .poll(async () => (await titleGeometry(shell, longId)).cluster)
      .toBeLessThan(400);
    const narrow = await titleGeometry(shell, longId);
    await captureShell(app, "03-narrow-split.png");
    expect(narrow.closeRight).toBeLessThanOrEqual(narrow.clusterRight + 0.5);
    expect(narrow.titleRight).toBeLessThan(narrow.clusterRight);
  } finally {
    await app.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
