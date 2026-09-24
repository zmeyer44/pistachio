import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/pane-toolbar-nav");

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

async function startPages(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Page ${request.url ?? ""}</title><p>${request.url ?? ""}</p>`);
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

function cluster(shell: Page, tabId: string) {
  return shell.locator(`[data-testid="pane-toolbar-cluster"][data-tab-id="${tabId}"]`);
}

async function snapshotOf(shell: Page) {
  return shell.evaluate(async () => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot());
}

async function launch(sidebar: "pinned" | "compact") {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-pane-toolbar-nav-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify({ layout: { mode: "sidebar", sidebar } }));
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  const shell = await shellPage(app);
  await shell.waitForLoadState("domcontentloaded");
  return { app, shell };
}

/** Opens `first`, then navigates the same tab to `second`, so it has a back entry. */
async function tabWithHistory(shell: Page, first: string, second: string): Promise<string> {
  const tabId = await shell.evaluate(async (url) => {
    const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
    await api.createTab(url);
    return (await api.getSnapshot()).activeTabId;
  }, first);
  if (tabId === null) throw new Error("no active tab");
  await expect.poll(async () => (await snapshotOf(shell)).tabs.find((t) => t.id === tabId)?.url).toBe(first);
  await shell.evaluate(
    ([id, url]) => (window as unknown as { pistachio: PistachioApi }).pistachio.navigate(id, url),
    [tabId, second] as const,
  );
  await expect.poll(async () => (await snapshotOf(shell)).tabs.find((t) => t.id === tabId)?.canGoBack).toBe(true);
  return tabId;
}

test("a pinned sidebar over a single pane leaves navigation to the sidebar", async () => {
  const { server, origin } = await startPages();
  const { app, shell } = await launch("pinned");
  try {
    const tabId = await tabWithHistory(shell, `${origin}/a`, `${origin}/b`);
    await revealPaneToolbar(shell);
    await expect(cluster(shell, tabId).getByTestId("pane-toolbar-close")).toBeVisible();
    await expect(cluster(shell, tabId).getByTestId("pane-toolbar-back")).toHaveCount(0);
    await captureShell(app, "01-pinned-single.png");
  } finally {
    await app.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

test("a compact sidebar puts back, forward and reload on the pane toolbar", async () => {
  const { server, origin } = await startPages();
  const { app, shell } = await launch("compact");
  try {
    const tabId = await tabWithHistory(shell, `${origin}/a`, `${origin}/b`);
    await revealPaneToolbar(shell);
    const row = cluster(shell, tabId);
    await expect(row.getByTestId("pane-toolbar-back")).toBeVisible();
    await expect(row.getByTestId("pane-toolbar-forward")).toHaveAttribute("aria-disabled", "true");
    await expect(row.getByTestId("pane-toolbar-reload")).toBeVisible();
    // The controls sit to the left of the title.
    const back = await row.getByTestId("pane-toolbar-back").boundingBox();
    const title = await row.getByTestId("pane-toolbar-title").boundingBox();
    if (back === null || title === null) throw new Error("pane toolbar geometry is unavailable");
    expect(back.x).toBeLessThan(title.x);
    await captureShell(app, "02-compact.png");

    await row.getByTestId("pane-toolbar-back").click();
    await expect.poll(async () => (await snapshotOf(shell)).tabs.find((t) => t.id === tabId)?.url).toBe(`${origin}/a`);
    await expect(row.getByTestId("pane-toolbar-forward")).not.toHaveAttribute("aria-disabled", "true");
    await row.getByTestId("pane-toolbar-forward").click();
    await expect.poll(async () => (await snapshotOf(shell)).tabs.find((t) => t.id === tabId)?.url).toBe(`${origin}/b`);
  } finally {
    await app.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

test("a split view gives each pane its own navigation, bound to that pane", async () => {
  const { server, origin } = await startPages();
  const { app, shell } = await launch("pinned");
  try {
    const left = await tabWithHistory(shell, `${origin}/left-1`, `${origin}/left-2`);
    const right = await tabWithHistory(shell, `${origin}/right-1`, `${origin}/right-2`);
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.splitWith(tabId, "right"), left);
    await expect(shell.getByTestId("secondary-pane")).toBeVisible();
    await revealPaneToolbar(shell);
    await expect(cluster(shell, left).getByTestId("pane-toolbar-back")).toBeVisible();
    await expect(cluster(shell, right).getByTestId("pane-toolbar-back")).toBeVisible();
    await captureShell(app, "03-split.png");

    // Back on one pane moves that pane's tab only.
    await revealPaneToolbar(shell);
    const active = (await snapshotOf(shell)).activeTabId;
    const other = active === left ? right : left;
    await cluster(shell, other).getByTestId("pane-toolbar-back").click();
    await expect
      .poll(async () => (await snapshotOf(shell)).tabs.find((t) => t.id === other)?.url)
      .toBe(other === left ? `${origin}/left-1` : `${origin}/right-1`);
    expect((await snapshotOf(shell)).tabs.find((t) => t.id === active)?.url).toBe(active === left ? `${origin}/left-2` : `${origin}/right-2`);
  } finally {
    await app.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
