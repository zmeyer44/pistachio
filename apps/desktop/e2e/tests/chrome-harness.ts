import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { captureEnabled } from "./app";
import { liveViews, shellPage } from "./windows";

/**
 * What the chrome specs (sidebar, tabs, notices, media) share: the shell's
 * snapshot, where main has the tab views, waits for the chrome's motion to
 * land, and the
 * screenshots a person reviewing a change asks for
 * (PISTACHIO_E2E_CAPTURE=1). Nothing asserts on a screenshot, so a capture
 * helper returns at once — and skips any settling wait with it — when
 * capture is off.
 */

const screenshotRoot = join(process.cwd(), "e2e/screenshots");

async function writeCapture(folder: string, filename: string, base64: string): Promise<void> {
  await mkdir(join(screenshotRoot, folder), { recursive: true });
  await writeFile(join(screenshotRoot, folder, filename), Buffer.from(base64, "base64"));
}

/** The shell's snapshot, as the renderer reads it. */
export function snapshot(shell: Page): Promise<ShellSnapshot> {
  return shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot());
}

/** The Electron page showing `url`, once one is. */
export async function pageAt(app: ElectronApplication, url: string): Promise<Page> {
  await expect.poll(() => app.windows().some((page) => page.url() === url)).toBe(true);
  const page = app.windows().find((candidate) => candidate.url() === url);
  if (page === undefined) throw new Error(`No Electron page at ${url}`);
  return page;
}

/** Close the app, and kill it if it is still quitting after 10s (capture streams can hold it up). */
export async function closeApp(app: ElectronApplication | undefined): Promise<void> {
  if (app === undefined) return;
  let timer: NodeJS.Timeout | undefined;
  const killAfter = new Promise<void>((done) => {
    timer = setTimeout(() => {
      app.process().kill("SIGKILL");
      done();
    }, 10_000);
  });
  await Promise.race([app.close(), killAfter]);
  if (timer !== undefined) clearTimeout(timer);
}

/** Where main has each visible TAB view (the chrome's own views told apart by their hash), in child order. */
export async function visibleTabViewBoxes(app: ElectronApplication): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
  return (await liveViews(app)).map((view) => view.bounds);
}

/** How many tab views are on screen: a modal raises the chrome over them, and lowering it must bring them back. */
export async function visibleTabViews(app: ElectronApplication): Promise<number> {
  return (await liveViews(app)).length;
}

/**
 * Wait out the motion under `target`: two frames for a relayout to start its
 * glide, then every finite animation in it (a FLIP slide, a fade). A
 * looping animation (a busy sweep, a spinner) is not waited for.
 */
export async function settled(target: Locator): Promise<void> {
  await target.evaluate(async (element) => {
    const frame = (): Promise<void> => new Promise((done) => requestAnimationFrame(() => done()));
    await frame();
    await frame();
    const finite = element.getAnimations({ subtree: true }).filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

/** Two painted frames of the shell: what a pointer move needs to land before the button comes up. */
export async function nextFrames(shell: Page): Promise<void> {
  await shell.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

/**
 * The window's own frame — the shell page, which leaves out the native tab
 * views — to e2e/screenshots/<folder>/<filename>. `settleMs` lets a motion
 * finish first; it is only waited when a capture is taken.
 */
export async function captureShell(app: ElectronApplication, folder: string, filename: string, settleMs = 0): Promise<void> {
  if (!captureEnabled) return;
  if (settleMs > 0) await new Promise((done) => setTimeout(done, settleMs));
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return (await window.capturePage()).toPNG().toString("base64");
  });
  await writeCapture(folder, filename, png);
}

/** One Playwright page — the shell, a chrome view, a tab — as it renders, to e2e/screenshots/<folder>/<filename>. */
export async function capturePage(page: Page | Locator, folder: string, filename: string, settleMs = 0): Promise<void> {
  if (!captureEnabled) return;
  if (settleMs > 0) await new Promise((done) => setTimeout(done, settleMs));
  await mkdir(join(screenshotRoot, folder), { recursive: true });
  await page.screenshot({ path: join(screenshotRoot, folder, filename), timeout: 15_000 });
}

/** The first visible tab view on its own, as main has it painted. */
export async function captureTabView(app: ElectronApplication, folder: string, filename: string): Promise<void> {
  if (!captureEnabled) return;
  const png = await app.evaluate(async ({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    const view = window.contentView.children.find((child) => {
      if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) return false;
      const url = (child as WebContentsView).webContents.getURL();
      return !Object.values(hashes).some((hash) => url.endsWith(hash));
    }) as WebContentsView | undefined;
    if (view === undefined) throw new Error("No tab view is visible");
    return (await view.webContents.capturePage()).toPNG().toString("base64");
  }, CHROME_VIEW_HASHES);
  await writeCapture(folder, filename, png);
}

interface WindowCapture {
  shell: string;
  /** The shell frame's pixel size — capturePage renders at the display's scale. */
  width: number;
  height: number;
  /** Pixels per DIP, so a view's DIP bounds land on the right pixels. */
  scale: number;
  views: Array<{ bounds: { x: number; y: number }; png: string }>;
}

/** capturePage throws UnknownVizError until a view's compositor has its first frame. */
async function withFirstFrame<T>(capture: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await capture();
    } catch (error: unknown) {
      lastError = error;
      await new Promise((done) => setTimeout(done, 150));
    }
  }
  throw lastError;
}

/**
 * The whole window as a person sees it: the shell page with every visible
 * child view — the tab panes and any visible utility view — composited over
 * it in stacking order, which a plain shell capture never shows. The
 * compositing happens on a canvas INSIDE the shell page, so the test needs
 * nothing installed beyond the Electron it already drives.
 */
export async function captureWindow(app: ElectronApplication, folder: string, filename: string, settleMs = 0): Promise<void> {
  if (!captureEnabled) return;
  if (settleMs > 0) await new Promise((done) => setTimeout(done, settleMs));
  const capture = await withFirstFrame(() =>
    app.evaluate(async ({ BrowserWindow }): Promise<WindowCapture> => {
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
    }),
  );
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
  await writeCapture(folder, filename, dataUrl.slice(dataUrl.indexOf(",") + 1));
}
