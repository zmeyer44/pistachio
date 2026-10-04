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

// One window, pinned, over a web page — ⌘T asks for an address here: the
// address modal's new-tab flow, whose still hand-off needs a real page under
// the modal (the home page is drawn by the shell, its view hidden). Then the
// tab menu's own duplicate and the self-drop split.
test.describe.serial("duplicating a tab", { tag: ["@sidebar", "@tabs", "@split", "@address"] }, () => {
  test.describe.configure({ timeout: 60_000 });
  let app: ElectronApplication;
  let shell: Page;

  test.beforeAll(async () => {
    ({ app } = await launchApp({ settings: pageFirst({ layout: { sidebar: "pinned" } }), name: "duplicate-tab" }));
    shell = await shellReady(app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("a new-tab result duplicates an already-open site without replacing or selecting its split", async () => {
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
  });

  test("a tab duplicates from its context menu, and self-drops split with a fresh copy", async () => {
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
    await shell.getByRole("menuitem", { name: "Duplicate tab" }).or(shell.getByRole("button", { name: "Duplicate tab" })).click();
    await expect(rows).toHaveCount(rowCount + 1);
    const afterMenu = await shellSnapshot(shell);
    expect(afterMenu.tabs).toHaveLength(before.tabs.length + 1);
    const menuCopy = afterMenu.tabs.find((tab) => isNew(tab.id, before.tabs.map((known) => known.id)));
    if (menuCopy === undefined) throw new Error("no duplicate tab appeared");
    expect(menuCopy.url).toBe(original.url);
    expect(afterMenu.activeTabId).toBe(menuCopy.id);
    await captureShell(app, "05-duplicated-from-menu.png");

    // "Open in split view" on the ACTIVE tab — like dropping it onto its own
    // surface (both commit splitWith with the tab's own id) — splits it with
    // a fresh copy instead of pulling in the other, unrelated tab.
    await shell.locator(`[data-testid="human-tab"][data-tab-id="${menuCopy.id}"]`).click({ button: "right" });
    await shell.getByRole("menuitem", { name: "Open in split view" }).or(shell.getByRole("button", { name: "Open in split view" })).click();
    await expect(shell.getByTestId("secondary-pane")).toBeVisible();
    const afterSelfSplit = await shellSnapshot(shell);
    expect(afterSelfSplit.tabs).toHaveLength(afterMenu.tabs.length + 1);
    const splitCopy = afterSelfSplit.tabs.find((tab) => isNew(tab.id, afterMenu.tabs.map((known) => known.id)));
    if (splitCopy === undefined) throw new Error("the self-drop created no duplicate");
    expect(splitCopy.url).toBe(menuCopy.url);
    const selfGroup = afterSelfSplit.splitGroups.find((group) => group.tabIds.includes(menuCopy.id));
    expect(selfGroup?.tabIds).toEqual([menuCopy.id, splitCopy.id]);
    // The original stayed out of the split.
    expect(selfGroup?.tabIds).not.toContain(original.id);
    await captureShell(app, "06-self-drop-split-with-copy.png");

    // A second self-drop grows the same group with another copy on the
    // dropped edge rather than replacing a pane.
    const activeId = afterSelfSplit.activeTabId;
    if (activeId === null) throw new Error("no active tab after the self split");
    await shell.evaluate(
      (tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.splitWith(tabId, "left"),
      activeId,
    );
    const afterSecond = await shellSnapshot(shell);
    expect(afterSecond.tabs).toHaveLength(afterSelfSplit.tabs.length + 1);
    const group = afterSecond.splitGroups.find((candidate) => candidate.id === selfGroup?.id);
    if (group === undefined) throw new Error("the split group dissolved");
    expect(group.tabIds).toHaveLength(3);
    expect(group.tabIds[0]).not.toBe(activeId);
    expect(group.tabIds).toContain(activeId);
    await captureShell(app, "07-second-self-drop-grows-group.png");
  });
});