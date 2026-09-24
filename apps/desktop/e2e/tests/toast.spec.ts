import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import { shellPage, shellReady } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/toast");

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

function visibleViewState(
  app: ElectronApplication,
): Promise<{ tabs: number }> {
  return app.evaluate(({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined)
      throw new Error("Pistachio window is unavailable");
    let tabs = 0;
    for (const child of window.contentView.children) {
      if (
        !("webContents" in child) ||
        !("getVisible" in child) ||
        !child.getVisible()
      )
        continue;
      const url = (child as WebContentsView).webContents.getURL();
      if (!Object.values(hashes).some((hash) => url.endsWith(hash)))
        tabs += 1;
    }
    return { tabs };
  }, CHROME_VIEW_HASHES);
}

function visibleTabLoadState(
  app: ElectronApplication,
): Promise<{ loading: boolean; url: string } | null> {
  return app.evaluate(({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined)
      throw new Error("Pistachio window is unavailable");
    const tab = window.contentView.children.find((child) => {
      if (
        !("webContents" in child) ||
        !("getVisible" in child) ||
        !child.getVisible()
      )
        return false;
      const url = (child as WebContentsView).webContents.getURL();
      return !Object.values(hashes).some((hash) => url.endsWith(hash));
    }) as WebContentsView | undefined;
    return tab === undefined
      ? null
      : { loading: tab.webContents.isLoading(), url: tab.webContents.getURL() };
  }, CHROME_VIEW_HASHES);
}

interface WindowCapture {
  shell: string;
  width: number;
  height: number;
  scale: number;
  views: Array<{ bounds: { x: number; y: number }; png: string }>;
}

/** Capture the shell and composite its native child views in their real stacking order. */
async function captureWindow(
  app: ElectronApplication,
  filename: string,
): Promise<void> {
  const capture = await app.evaluate(
    async ({ BrowserWindow }): Promise<WindowCapture> => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined)
        throw new Error("Pistachio window is unavailable");
      const shell = await window.capturePage();
      const size = shell.getSize();
      const [contentWidth] = window.getContentSize();
      const views = await Promise.all(
        window.contentView.children.flatMap((child) => {
          if (
            !("webContents" in child) ||
            !("getVisible" in child) ||
            !child.getVisible()
          )
            return [];
          const view = child as WebContentsView;
          return [
            view.webContents.capturePage().then((image) => ({
              bounds: view.getBounds(),
              png: image.toPNG().toString("base64"),
            })),
          ];
        }),
      );
      return {
        shell: shell.toPNG().toString("base64"),
        width: size.width,
        height: size.height,
        scale:
          contentWidth === undefined || contentWidth === 0
            ? 1
            : size.width / contentWidth,
        views,
      };
    },
  );
  const shell = await shellPage(app);
  const dataUrl = await shell.evaluate(
    async ({ shell: frame, width, height, scale, views }: WindowCapture) => {
      const decode = (png: string): Promise<HTMLImageElement> =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error("capture failed to decode"));
          image.src = `data:image/png;base64,${png}`;
        });
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("no 2d canvas context");
      context.drawImage(await decode(frame), 0, 0);
      for (const view of views) {
        context.drawImage(
          await decode(view.png),
          Math.round(view.bounds.x * scale),
          Math.round(view.bounds.y * scale),
        );
      }
      return canvas.toDataURL("image/png");
    },
    capture,
  );
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(
    join(screenshotDirectory, filename),
    Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"),
  );
}

/**
 * A navigation that fails is NOT this toast any more: Chromium's empty error
 * document is dressed in the tab itself (main/navigation-error-page.ts), so
 * the page keeps its address and the tab view stays up. The shell toast is
 * for a chrome action that could not do what was asked — reader view on a
 * page with no article is the smallest of those, and it needs no network.
 */
test("an error toast renders above tab WebContentsViews", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined)
    throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-toast-"));

  // Reader view is offered on http(s) pages only, so the page with nothing to
  // read is served here rather than from pistachio://.
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Nothing to read</title><p>No article here.</p>");
  });
  await new Promise<void>((listening, failed) => {
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => listening());
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("The test server did not bind a TCP port");
  const homeUrl = `http://127.0.0.1:${String(address.port)}/`;
  await writeFile(join(userData, "settings.json"), JSON.stringify({ general: { homeUrl } }));

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellReady(app);
    await expect
      .poll(() => visibleViewState(app))
      .toEqual({ tabs: 1 });
    // The home page must have settled first: a load that supersedes one
    // still in flight is aborted by Chromium rather than failed, and an
    // abort is not an error the shell shows.
    await expect
      .poll(() => visibleTabLoadState(app))
      .toMatchObject({ loading: false });

    // ⌘⇧A from the chrome: main finds no article and the shell says so.
    await shell.keyboard.press("Meta+Shift+A");

    const alert = shell.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/no article to read/i);
    await expect
      .poll(() => visibleViewState(app))
      .toEqual({ tabs: 0 });
    await captureWindow(app, "01-failed-navigation-toast.png");

    // A subsequent successful action clears the toast and restores the live
    // page; the overlay is not allowed to strand a hidden tab view.
    await shell.keyboard.press("Meta+l");
    const input = shell.getByTestId("address-input");
    await input.fill("pistachio://demo/invoices");
    await input.press("Enter");
    await expect(alert).toHaveCount(0);
    await expect
      .poll(() => visibleViewState(app))
      .toEqual({ tabs: 1 });
    await expect.poll(() => visibleTabLoadState(app)).toEqual({
      loading: false,
      url: "pistachio://demo/invoices",
    });
    await captureWindow(app, "02-live-page-restored.png");
  } finally {
    await app.close();
    await new Promise<void>((closed) => server.close(() => closed()));
  }
});
