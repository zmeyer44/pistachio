import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { pageFirst, shellPage } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/duplicate-new-tab");

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

function visibleTabViews(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return window.contentView.children.filter((child) => {
      if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) return false;
      const url = (child as WebContentsView).webContents.getURL();
      return !Object.values(hashes).some((hash) => url.endsWith(hash));
    }).length;
  }, CHROME_VIEW_HASHES);
}

async function delayNextTabCapture(app: ElectronApplication, delayMs: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, { hashes, delayMs }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    const tabView = window.contentView.children.find((child) => {
      if (!("webContents" in child)) return false;
      const url = (child as WebContentsView).webContents.getURL();
      return !Object.values(hashes).some((hash) => url.endsWith(hash));
    });
    if (tabView === undefined || !("webContents" in tabView)) throw new Error("No tab view is available");
    const contents = (tabView as WebContentsView).webContents;
    const capturePage = contents.capturePage.bind(contents);
    const ownCapturePage = Object.getOwnPropertyDescriptor(contents, "capturePage");
    Object.defineProperty(contents, "capturePage", {
      configurable: true,
      value: async (...args: Parameters<typeof contents.capturePage>) => {
        if (ownCapturePage === undefined) Reflect.deleteProperty(contents, "capturePage");
        else Object.defineProperty(contents, "capturePage", ownCapturePage);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return capturePage(...args);
      },
    });
  }, { hashes: CHROME_VIEW_HASHES, delayMs });
}

async function recordNextTabHide(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }, hashes) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    const tabView = window.contentView.children.find((child) => {
      if (!("webContents" in child)) return false;
      const url = (child as WebContentsView).webContents.getURL();
      return !Object.values(hashes).some((hash) => url.endsWith(hash));
    });
    if (tabView === undefined || !("setVisible" in tabView)) throw new Error("No tab view is available");
    const view = tabView as WebContentsView;
    const setVisible = view.setVisible.bind(view);
    const ownSetVisible = Object.getOwnPropertyDescriptor(view, "setVisible");
    Object.defineProperty(view, "setVisible", {
      configurable: true,
      value: (visible: boolean) => {
        if (visible) return setVisible(true);
        if (ownSetVisible === undefined) Reflect.deleteProperty(view, "setVisible");
        else Object.defineProperty(view, "setVisible", ownSetVisible);
        (globalThis as { overlayTabHiddenAt?: number }).overlayTabHiddenAt = Date.now();
        return setVisible(false);
      },
    });
  }, CHROME_VIEW_HASHES);
}

async function observeNextPaneStillPaint(shell: Page): Promise<void> {
  await shell.evaluate(() => {
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const observer = new MutationObserver(() => {
      const still = document.querySelector<HTMLImageElement>("img.pane-still");
      if (still === null) return;
      observer.disconnect();
      void (async () => {
        await still.decode().catch(() => undefined);
        await frame();
        await frame();
        (window as unknown as { overlayStillPaintedAt?: number }).overlayStillPaintedAt = Date.now();
      })();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

function snapshot(shell: Page) {
  return shell.evaluate(async () => {
    const state = await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot();
    return {
      tabCount: state.tabs.length,
      tabs: state.tabs.map(({ id, url }) => ({ id, url })),
      activeTabId: state.activeTabId,
      secondaryTabId: state.secondaryTabId,
      splitMode: state.splitMode,
      groups: state.splitGroups.map(({ primaryTabId, secondaryTabId }) =>
        [primaryTabId, secondaryTabId].sort().join(":"),
      ),
    };
  });
}

test("a new-tab result duplicates an already-open site without replacing or selecting its split", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-duplicate-tab-"));
  await writeFile(
    join(userData, "settings.json"),
    // ⌘T asks for an address here: this spec is the address modal's new-tab
    // flow, and its still hand-off needs a real page under the modal, which
    // the home page (drawn by the shell, its view hidden) is not.
    JSON.stringify(pageFirst({ layout: { mode: "sidebar", sidebar: "pinned" } })),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");

    // Capturing the page still is asynchronous. The address modal must wait
    // invisibly until main has hidden the native tab view, or its entrance
    // starts underneath that view and appears to jump stacking contexts.
    await delayNextTabCapture(app, 750);
    await recordNextTabHide(app);
    await observeNextPaneStillPaint(shell);
    await shell.keyboard.press("Meta+T");
    const pendingVeil = shell.getByTestId("url-bar-veil");
    await pendingVeil.waitFor({ state: "attached" });
    expect(await pendingVeil.evaluate((element) => ({
      opacity: getComputedStyle(element).opacity,
      ready: element.hasAttribute("data-ready"),
    }))).toEqual({ opacity: "0", ready: false });
    expect(await visibleTabViews(app)).toBe(1);
    // Once captured, the replacement is decoded and painted under the live
    // native page before main swaps the view out. There is never a blank pane.
    await expect(shell.locator("img.pane-still")).toHaveCount(1);
    await expect(pendingVeil).toHaveAttribute("data-ready", "");
    await expect(pendingVeil).toHaveCSS("opacity", "1");
    await expect.poll(() => visibleTabViews(app)).toBe(0);
    const stillPaintedAt = await shell.evaluate(
      () => (window as unknown as { overlayStillPaintedAt?: number }).overlayStillPaintedAt ?? null,
    );
    const tabHiddenAt = await app.evaluate(
      () => (globalThis as { overlayTabHiddenAt?: number }).overlayTabHiddenAt ?? null,
    );
    expect(stillPaintedAt).not.toBeNull();
    expect(tabHiddenAt).not.toBeNull();
    expect(tabHiddenAt!).toBeGreaterThanOrEqual(stillPaintedAt!);
    await shell.keyboard.press("Escape");
    await expect(pendingVeil).toHaveCount(0);
    await expect.poll(() => visibleTabViews(app)).toBe(1);

    // Keep the target site inside a saved pair so switching to it would be
    // visibly different from creating the requested fresh, lone tab.
    const setup = await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      const before = await api.getSnapshot();
      const first = before.tabs[0];
      if (first === undefined) throw new Error("the initial tab is unavailable");
      await api.createTab("pistachio://demo/invoices?tab=split-partner");
      const second = (await api.getSnapshot()).tabs[1];
      if (second === undefined) throw new Error("the split partner was not created");
      await api.selectTab(first.id);
      await api.splitWith(second.id, "right");
      return { firstId: first.id, secondId: second.id, targetUrl: first.url };
    });
    const pair = [setup.firstId, setup.secondId].sort().join(":");
    await expect.poll(() => snapshot(shell)).toEqual({
      tabCount: 2,
      tabs: [
        { id: setup.firstId, url: setup.targetUrl },
        { id: setup.secondId, url: "pistachio://demo/invoices?tab=split-partner" },
      ],
      activeTabId: setup.firstId,
      secondaryTabId: setup.secondId,
      splitMode: "vertical",
      groups: [pair],
    });
    const splitRow = shell.getByTestId("sidebar-tab-list").locator("[data-split-group-id]");
    await expect(splitRow).toBeVisible();
    await splitRow.evaluate(async (row) => {
      await Promise.all(row.getAnimations({ subtree: false }).map((animation) => animation.finished));
    });
    await expect.poll(() => visibleTabViews(app)).toBe(2);
    await captureShell(app, "01-site-open-in-split.png");

    // New-tab browse mode may offer an open page as a shortcut, but choosing
    // it must use its URL as the source for a new tab rather than switch tabs.
    await shell.keyboard.press("Meta+T");
    const result = shell.getByTestId("url-bar").locator(`[data-testid="open-tab-result"][data-tab-id="${setup.firstId}"]`);
    await expect(result).toBeVisible();
    await expect(result.getByText("New tab", { exact: true })).toBeVisible();
    await expect.poll(() => visibleTabViews(app)).toBe(0);
    await shell.getByTestId("url-bar-veil").evaluate(async (veil) => {
      await Promise.all(veil.getAnimations({ subtree: true }).map((animation) => animation.finished));
    });
    await captureShell(app, "02-existing-site-offered-in-new-tab.png");
    await result.click();

    // The duplicate is a third tab with a distinct id; the original pair is
    // still saved and no longer occupies the visible secondary pane.
    await expect.poll(() => snapshot(shell)).toEqual({
      tabCount: 3,
      tabs: expect.arrayContaining([
        { id: setup.firstId, url: setup.targetUrl },
        { id: setup.secondId, url: "pistachio://demo/invoices?tab=split-partner" },
        { id: expect.not.stringMatching(new RegExp(`^(${setup.firstId}|${setup.secondId})$`)), url: setup.targetUrl },
      ]),
      activeTabId: expect.not.stringMatching(new RegExp(`^(${setup.firstId}|${setup.secondId})$`)),
      secondaryTabId: null,
      splitMode: "single",
      groups: [pair],
    });
    await expect(shell.getByTestId("secondary-pane")).toHaveCount(0);
    await expect(shell.getByTestId("url-bar")).toHaveCount(0);
    const after = await snapshot(shell);
    const duplicate = after.tabs.find(
      (candidate) =>
        candidate.id !== setup.firstId &&
        candidate.id !== setup.secondId &&
        candidate.url === setup.targetUrl,
    );
    if (duplicate === undefined) throw new Error("the duplicate tab was not created");
    const duplicateRow = shell.getByTestId("sidebar-tab-list").locator(`[data-tab-id="${duplicate.id}"]`);
    await expect(duplicateRow).toHaveAttribute("aria-selected", "true");
    await duplicateRow.evaluate(async (row) => {
      await Promise.all(row.getAnimations({ subtree: false }).map((animation) => animation.finished));
    });
    await expect.poll(() => visibleTabViews(app)).toBe(1);
    await captureShell(app, "03-duplicate-site-open-as-lone-tab.png");
  } finally {
    await app.close();
  }
});
