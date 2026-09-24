// @ts-nocheck
import { captureComposite } from "./capture";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import { dragPage, shellPage } from "../../../tests/windows";

const screenshotDirectory = resolve(process.cwd(), "../../docs/qa/2026-09-09/organization/extra/sidebar-split-drag");

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

async function captureLivePage(app: ElectronApplication, filename: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    const view = window.contentView.children.find((child) => {
      if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) return false;
      const url = (child as WebContentsView).webContents.getURL();
      return !Object.values(hashes).some((hash) => url.endsWith(hash));
    }) as WebContentsView | undefined;
    if (view === undefined) throw new Error("No live page is visible during the split preview");
    return (await view.webContents.capturePage()).toPNG().toString("base64");
  }, CHROME_VIEW_HASHES);
  await writeFile(join(screenshotDirectory, filename), Buffer.from(png, "base64"));
}

function visibleTabViewBoxes(app: ElectronApplication): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
  return app.evaluate(({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return window.contentView.children.flatMap((child) => {
      if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) return [];
      const url = (child as WebContentsView).webContents.getURL();
      return Object.values(hashes).some((hash) => url.endsWith(hash)) ? [] : [(child as WebContentsView).getBounds()];
    });
  }, CHROME_VIEW_HASHES);
}

test("a sidebar tab live-previews the page reflow before it becomes a split", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-sidebar-split-drag-"));
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" } }),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    const layer = await dragPage(app);
    await shell.waitForLoadState("domcontentloaded");
    await layer.waitForLoadState("domcontentloaded");
    const source = shell.getByTestId("sidebar-tab-list").getByTestId("human-tab").first();
    const content = shell.getByTestId("primary-pane");
    await expect(source).toBeVisible();
    await expect(content).toBeVisible();
    await captureShell(app, "01-ready.png");

    // Crossing into the page must resize the live native view and expose one
    // exact landing pane instead of floating four abstract targets over it.
    const sourceBox = await source.boundingBox();
    const contentBox = await content.boundingBox();
    if (sourceBox === null || contentBox === null) throw new Error("drag geometry is unavailable");
    const start = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
    const target = { x: contentBox.x + contentBox.width / 4, y: contentBox.y + contentBox.height / 2 };
    await shell.mouse.move(start.x, start.y);
    await shell.mouse.down();
    await shell.mouse.move(start.x + 8, start.y, { steps: 2 });
    await shell.mouse.move(target.x, target.y, { steps: 12 });

    const landing = shell.getByTestId("split-drop-preview");
    await expect(landing).toBeVisible();
    await expect(landing).toHaveAttribute("data-side", "left");
    await shell.getByTestId("browser-surface").evaluate(async (surface) => {
      await Promise.all(surface.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined)));
    });
    await expect(shell.getByTestId("split-drop-zones")).toHaveCount(0);
    await expect(shell.locator("img.pane-still")).toHaveCount(0);
    await expect.poll(() => visibleTabViewBoxes(app).then((boxes) => boxes.length)).toBe(1);
    const previewPageBox = (await visibleTabViewBoxes(app))[0];
    if (previewPageBox === undefined) throw new Error("live preview page has no native bounds");
    expect(previewPageBox.width).toBeLessThan(contentBox.width * 0.62);
    expect(previewPageBox.x).toBeGreaterThan(contentBox.x + contentBox.width * 0.4);
    const ghost = layer.getByTestId("tab-drag-preview");
    await expect(ghost).toBeVisible();
    await expect(ghost).toHaveAttribute("data-split-zone", "left");
    await captureShell(app, "02-live-split-preview.png");
    await captureLivePage(app, "03-native-page-reflow.png");
    await layer.screenshot({ path: join(screenshotDirectory, "04-drag-ghost.png"), omitBackground: true });

    // Once the real pointer is over a page, the drag layer owns its samples.
    // Crossing to the opposite edge must move both the landing pane and the
    // live native view without sending another synthetic move to the shell.
    const rightTarget = { x: contentBox.x + contentBox.width * 0.75, y: contentBox.y + contentBox.height / 2 };
    await layer.evaluate(({ x, y }) => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
    }, rightTarget);
    await expect(landing).toHaveAttribute("data-side", "right");
    await expect(ghost).toHaveAttribute("data-split-zone", "right");
    await shell.getByTestId("browser-surface").evaluate(async (surface) => {
      await Promise.all(surface.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined)));
    });
    const movedPageBox = (await visibleTabViewBoxes(app))[0];
    if (movedPageBox === undefined) throw new Error("moved live preview page has no native bounds");
    expect(movedPageBox.x).toBeLessThan(contentBox.x + contentBox.width * 0.1);
    await captureShell(app, "05-live-split-preview-right.png");

    // Releasing commits the already-visible geometry and removes both pieces
    // of transient drag chrome without a one-pane intermediate frame.
    await layer.evaluate(({ x, y }) => {
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: x, clientY: y, bubbles: true }));
    }, rightTarget);
    await expect(landing).toHaveCount(0);
    await expect(ghost).toHaveCount(0);
    await shell.mouse.up();
    await expect(shell.getByTestId("secondary-pane")).toBeVisible();
    await expect(shell.getByRole("group", { name: /^Split view:/ })).toBeVisible();
    await expect.poll(() => visibleTabViewBoxes(app).then((boxes) => boxes.length)).toBe(2);
    await shell.getByTestId("sidebar-tab-list").evaluate(async (list) => {
      await Promise.all(list.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined)));
    });
    await captureShell(app, "06-split-committed.png");
    await captureComposite(app,"drag-split-committed");
  } finally {
    await captureComposite(app,"sidebar-split-drag-final").catch(()=>{});
    await app.close();
  }
});
