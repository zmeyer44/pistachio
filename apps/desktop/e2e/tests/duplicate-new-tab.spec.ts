import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { CHROME_VIEW_HASHES } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { pageFirst, shellReady } from "./windows";
import { launchApp } from "./app";
import { captureShell as captureWindowFrame, snapshot as shellSnapshot, visibleTabViews } from "./chrome-harness";

function captureShell(app: ElectronApplication, filename: string): Promise<void> {
  return captureWindowFrame(app, "duplicate-tab", filename);
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
      // (The window's page, drawn: main's picture of it, on the desk.)
      const still = document.querySelector<HTMLImageElement>('[data-testid="desk-window-page"] img.desk-still');
      if (still === null) return;
      observer.disconnect();
      void (async () => {
        await still.decode().catch(() => undefined);
        await frame();
        await frame();
        (window as unknown as { overlayStillPaintedAt?: number }).overlayStillPaintedAt = Date.now();
      })();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
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

// One window, its sidebar whole, over a web page: the address palette
// (⌘L) over its live page — whose still hand-off needs a real page under the
// palette (the home page is drawn by the shell, its view hidden) — then the
// palette over an empty space, where a choice opens as a new tab in it; then
// the tab menu's own duplicate.
test.describe.serial("duplicating a tab", { tag: ["@sidebar", "@tabs", "@desk", "@address"] }, () => {
  test.describe.configure({ timeout: 60_000 });
  let app: ElectronApplication;
  let shell: Page;

  test.beforeAll(async () => {
    ({ app } = await launchApp({ settings: pageFirst(), sidebar: "whole", name: "duplicate-tab" }));
    shell = await shellReady(app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("the palette over a page waits for its still; over an empty space an open site's result is a new tab there, not the open one", async () => {
    // Capturing the page still is asynchronous. The address palette must wait
    // invisibly until main has hidden the native tab view, or its entrance
    // starts underneath that view and appears to jump stacking contexts.
    await delayNextTabCapture(app, 750);
    await recordNextTabHide(app);
    await observeNextPaneStillPaint(shell);
    await shell.keyboard.press("Meta+L");
    const pendingVeil = shell.getByTestId("url-bar-veil");
    await pendingVeil.waitFor({ state: "attached" });
    expect(await pendingVeil.evaluate((element) => ({
      opacity: getComputedStyle(element).opacity,
      ready: element.hasAttribute("data-ready"),
    }))).toEqual({ opacity: "0", ready: false });
    expect(await visibleTabViews(app)).toBe(1);
    // Once captured, the replacement is decoded and painted under the live
    // native page before main swaps the view out. There is never a blank window.
    await expect(shell.locator('[data-testid="desk-window-page"] img.desk-still')).toHaveCount(1);
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

    // The site open in a space of its own; a new, empty space current, so
    // switching to the open one would be visibly different from a new tab here.
    const first = (await snapshot(shell)).tabs[0]!;
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "create", id: "fresh", tabIds: [], title: "Fresh", select: true }));
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBeNull();
    await expect(shell.getByTestId("desk-empty")).toBeVisible();
    await captureShell(app, "01-empty-space.png");

    // Nothing in use: the palette composes a new tab. It may offer an open
    // page as a shortcut, but choosing it uses its URL for a new tab here.
    await shell.keyboard.press("Meta+L");
    const result = shell.getByTestId("url-bar").locator(`[data-testid="open-tab-result"][data-tab-id="${first.id}"]`);
    await expect(shell.getByTestId("address-input")).toBeFocused();
    await expect(result).toBeVisible();
    await expect(result.getByText("New tab", { exact: true })).toBeVisible();
    await shell.getByTestId("url-bar-veil").evaluate(async (veil) => {
      await Promise.all(veil.getAnimations({ subtree: true }).map((animation) => animation.finished));
    });
    await captureShell(app, "02-existing-site-offered-in-new-tab.png");
    await result.click();

    // The duplicate is a second tab with a distinct id, in the empty space;
    // the original is where it was, not chosen.
    await expect.poll(async () => (await snapshot(shell)).tabCount).toBe(2);
    const after = await snapshot(shell);
    const duplicate = after.tabs.find((candidate) => candidate.id !== first.id);
    expect(duplicate?.url).toBe(first.url);
    expect(after.activeTabId).toBe(duplicate?.id);
    expect(after.splitMode).toBe("single");
    expect(await shell.evaluate(async () => (await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot()).tabGroups.find((group) => group.id === "fresh")?.tabIds)).toEqual([duplicate!.id]);
    await expect(shell.getByTestId("url-bar")).toHaveCount(0);
    const duplicateRow = shell.getByTestId("sidebar-tab-list").locator(`[data-tab-id="${duplicate!.id}"]`);
    await expect(duplicateRow).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => visibleTabViews(app)).toBe(1);
    await captureShell(app, "03-duplicate-site-open-in-the-space.png");
  });

  test("a tab duplicates from its context menu beside it, in its space, in use — and offers no split view", async () => {
    const rows = shell.getByTestId("sidebar-tab-list").getByTestId("human-tab");
    const before = await shellSnapshot(shell);
    const original = before.tabs.find((tab) => tab.id === before.activeTabId);
    if (original === undefined) throw new Error("no active tab");
    const rowCount = await rows.count();
    const isNew = (id: string, known: string[]) => !known.includes(id);

    // "Duplicate tab" in the row's context menu opens a second tab on the
    // same page, right beside the original, and hands it the focus.
    await shell.locator(`[data-testid="human-tab"][data-tab-id="${original.id}"]`).click({ button: "right" });
    await captureShell(app, "04-context-menu.png");
    // (No split view on the desktop: the desk lays windows side by side.)
    await expect(shell.getByTestId("context-menu").getByRole("menuitem", { name: /split/i })).toHaveCount(0);
    await shell.getByRole("menuitem", { name: "Duplicate tab" }).or(shell.getByRole("button", { name: "Duplicate tab" })).click();
    await expect(rows).toHaveCount(rowCount + 1);
    const afterMenu = await shellSnapshot(shell);
    expect(afterMenu.tabs).toHaveLength(before.tabs.length + 1);
    const menuCopy = afterMenu.tabs.find((tab) => isNew(tab.id, before.tabs.map((known) => known.id)));
    if (menuCopy === undefined) throw new Error("no duplicate tab appeared");
    expect(menuCopy.url).toBe(original.url);
    expect(afterMenu.activeTabId).toBe(menuCopy.id);
    expect(afterMenu.tabGroups.find((group) => group.id === "fresh")?.tabIds).toEqual([original.id, menuCopy.id]);
    await expect(shell.locator(`[data-testid="desk-window"][data-tab-id="${menuCopy.id}"]`)).toHaveCount(1);
    await captureShell(app, "05-duplicated-from-menu.png");
  });
});
