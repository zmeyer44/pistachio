import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { KeyboardInputEvent } from "electron";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { pageFirst, shellReady } from "./windows";
import { captureEnabled, launchApp } from "./app";
import { nextFrames } from "./chrome-harness";
import { openTabs as openInBackground, selectTab } from "./desk-harness";

/**
 * Open each address as a new tab and choose it, in a space of its own — the
 * desk passing to it, as a new tab in front did before the desk was always up
 * (a new tab the shell makes joins the current space instead, all of them one
 * desk's windows); the ids in visit order.
 */
async function openTabs(shell: Page, urls: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const url of urls) {
    const [id] = (await openInBackground(shell, [url])) as [string];
    await selectTab(shell, id);
    await expect.poll(() => activeTabId(shell)).toBe(id);
    ids.push(id);
  }
  return ids;
}

function activeTabId(shell: Page): Promise<string | null> {
  return shell.evaluate(async () =>
    (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot().then((state) => state.activeTabId),
  );
}

/**
 * Native key events into one view — the page at `url`, or the shell —
 * through the same before-input-event path a real keyboard takes (Playwright's
 * keyboard bypasses it). The view is not refocused: the switcher moves the
 * keyboard itself, and the test follows it.
 */
async function sendKeys(app: ElectronApplication, target: { url: string } | "shell", inputs: KeyboardInputEvent[]): Promise<void> {
  await app.evaluate(({ BrowserWindow, webContents }, { target, inputs }) => {
    const contents =
      target === "shell"
        ? BrowserWindow.getAllWindows()[0]?.webContents
        : webContents.getAllWebContents().find((candidate) => candidate.getURL() === target.url);
    if (contents === undefined) throw new Error(`no view for ${JSON.stringify(target)}`);
    for (const input of inputs) contents.sendInputEvent(input);
  }, { target, inputs });
}

/**
 * Give the page the keyboard once it has loaded (a key sent to a page still
 * loading can be lost), in a focused window: a hold only opens the switcher
 * in the window in front (main/index.ts tabSwitcherHoldElapsed).
 */
async function focusPage(app: ElectronApplication, url: string): Promise<void> {
  await expect
    .poll(() =>
      app.evaluate(({ webContents }, target) => {
        const page = webContents.getAllWebContents().find((candidate) => candidate.getURL() === target);
        return page !== undefined && !page.isLoading();
      }, url),
    )
    .toBe(true);
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (window !== undefined && !window.isFocused()) window.focus();
        return window?.isFocused() ?? false;
      }),
    )
    .toBe(true);
  await app.evaluate(({ webContents }, target) => {
    webContents.getAllWebContents().find((candidate) => candidate.getURL() === target)?.focus();
  }, url);
}

function focusedUrl(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(({ BrowserWindow, webContents }) => {
    const shell = BrowserWindow.getAllWindows()[0]?.webContents;
    const focused = webContents.getAllWebContents().find((candidate) => candidate.isFocused());
    if (focused === undefined) return null;
    return focused === shell ? "shell" : focused.getURL();
  });
}

/** Start recording the keydowns the page at `url` sees, as "meta+b" or "alt+meta+b" (a modifier on its own is not recorded; a letter by its key, not the character ⌥ composes). */
async function recordPageKeys(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate(async ({ webContents }, target) => {
    await webContents
      .getAllWebContents()
      .find((candidate) => candidate.getURL() === target)
      ?.executeJavaScript(
        `window.__keys = [];
        addEventListener("keydown", (e) => {
          if (!["Meta", "Control", "Shift", "Alt"].includes(e.key)) window.__keys.push((e.altKey ? "alt+" : "") + (e.metaKey ? "meta+" : "") + (/^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key));
        }, true);
        true`,
      );
  }, url);
}

/** Run `script` in the page at `url`. */
function inPage<T>(app: ElectronApplication, url: string, script: string): Promise<T> {
  return app.evaluate(
    ({ webContents }, { target, script }) =>
      webContents.getAllWebContents().find((candidate) => candidate.getURL() === target)?.executeJavaScript(script),
    { target: url, script },
  ) as Promise<T>;
}

const PAGES = [
  "pistachio://demo/vendors/atlas-medical?visit=1",
  "pistachio://demo/invoices?visit=2",
  "pistachio://demo/vendors/atlas-medical?visit=3",
  "pistachio://demo/invoices?visit=4",
  "pistachio://demo/vendors/atlas-medical?visit=5",
];

/**
 * Three pages of a test's own: the window is shared, and a page is found by
 * its address, so each test opens fresh ones. Opened last, they are the
 * three most recent tabs — the switcher's first cards.
 */
function pagesFor(run: string): string[] {
  return PAGES.slice(0, 3).map((url) => `${url}&run=${run}`);
}

// One window over a web page. Every gesture below ends with the switcher
// closed and its keys let go, so the next starts from rest.
test.describe.serial("the tab switcher", { tag: ["@tabs"] }, () => {
  test.describe.configure({ timeout: 60_000 });
  let app: ElectronApplication;
  let shell: Page;

  test.beforeAll(async () => {
    ({ app } = await launchApp({ settings: pageFirst(), name: "tab-switcher" }));
    shell = await shellReady(app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("⌃Tab from a page opens on the previous tab with live thumbnails, and Return goes there", async () => {
    const visited = await openTabs(shell, PAGES);
    await focusPage(app, PAGES[4]!);

    await sendKeys(app, { url: PAGES[4]! }, [
      { type: "keyDown", keyCode: "Control", modifiers: ["control"] },
      { type: "keyDown", keyCode: "Tab", modifiers: ["control"] },
    ]);

    const switcher = shell.getByTestId("tab-switcher");
    await expect(switcher).toHaveAttribute("data-ready", "");
    const options = switcher.getByTestId("tab-switcher-option");
    await expect(options.nth(0)).toHaveAttribute("data-tab-id", visited[4]!);
    await expect(options.nth(1)).toHaveAttribute("data-tab-id", visited[3]!);
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    // Every demo page is captured; the thumbnails arrive as main takes them.
    await expect.poll(() => options.locator(".tab-switcher-thumbnail > img").count()).toBeGreaterThanOrEqual(5);
    // The switcher took the keyboard, so the release lands where it is seen.
    expect(await focusedUrl(app)).toBe("shell");
    if (captureEnabled) await shell.screenshot({ path: test.info().outputPath("tab-switcher-open.png") });

    await sendKeys(app, "shell", [{ type: "keyDown", keyCode: "Tab", modifiers: ["control"] }]);
    await expect(options.nth(2)).toHaveAttribute("aria-selected", "true");
    await sendKeys(app, "shell", [{ type: "keyDown", keyCode: "Tab", modifiers: ["control", "shift"] }]);
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await sendKeys(app, "shell", [{ type: "keyDown", keyCode: "Return", modifiers: ["control"] }]);

    await expect(switcher).toHaveCount(0);
    await expect.poll(() => activeTabId(shell)).toBe(visited[3]);
    // The chosen page has the keyboard back.
    await expect.poll(() => focusedUrl(app)).toBe(PAGES[3]);
  });

  test("holding ⌥⌘ opens on the active tab (⌘ alone no longer does); arrows move and Escape cancels", async () => {
    const pages = pagesFor("hold");
    const visited = await openTabs(shell, pages);
    await focusPage(app, pages[2]!);

    // ⌘ held on its own, well past the hold (150ms by default): nothing.
    await sendKeys(app, { url: pages[2]! }, [{ type: "keyDown", keyCode: "Meta", modifiers: ["meta"] }]);
    await shell.waitForTimeout(400);
    const switcher = shell.getByTestId("tab-switcher");
    await expect(switcher).toHaveCount(0);
    // ⌥ joins it: the pair, held, opens the switcher.
    await sendKeys(app, { url: pages[2]! }, [{ type: "keyDown", keyCode: "Alt", modifiers: ["meta", "alt"] }]);
    await expect(switcher).toHaveAttribute("data-ready", "");
    const options = switcher.getByTestId("tab-switcher-option");
    await expect(options.nth(0)).toHaveAttribute("data-tab-id", visited[2]!);
    await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");

    await sendKeys(app, "shell", [{ type: "keyDown", keyCode: "Right", modifiers: ["meta", "alt"] }]);
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await sendKeys(app, "shell", [{ type: "keyDown", keyCode: "Escape", modifiers: ["meta", "alt"] }]);
    await expect(switcher).toHaveCount(0);
    expect(await activeTabId(shell)).toBe(visited[2]);
  });

  test("a page's shortcut typed once a ⌥⌘ hold has the switcher up still reaches the page", async () => {
    const pages = pagesFor("pass-on");
    const visited = await openTabs(shell, pages);
    await focusPage(app, pages[2]!);
    await recordPageKeys(app, pages[2]!);
    await sendKeys(app, { url: pages[2]! }, [{ type: "keyDown", keyCode: "b", modifiers: ["meta"] }]);
    await expect.poll(() => inPage<string[]>(app, pages[2]!, "window.__keys")).toEqual(["meta+b"]);

    await sendKeys(app, { url: pages[2]! }, [
      { type: "keyDown", keyCode: "Meta", modifiers: ["meta"] },
      { type: "keyDown", keyCode: "Alt", modifiers: ["meta", "alt"] },
    ]);
    const switcher = shell.getByTestId("tab-switcher");
    await expect(switcher).toHaveAttribute("data-ready", "");
    expect(await focusedUrl(app)).toBe("shell");
    // The shell has the keyboard now; ⌥⌘B (the pair held a beat too long) cancels the switcher and goes on to the page.
    await sendKeys(app, "shell", [{ type: "keyDown", keyCode: "b", modifiers: ["meta", "alt"] }]);
    await expect(switcher).toHaveCount(0);
    await expect.poll(() => inPage<string[]>(app, pages[2]!, "window.__keys")).toEqual(["meta+b", "alt+meta+b"]);
    expect(await focusedUrl(app)).toBe(pages[2]);
    expect(await activeTabId(shell)).toBe(visited[2]);

    // An Edit menu key does its work there too, though the menu never sees a sent key.
    // (⌥ let go first: ⌘A is the release, and goes on to select all.)
    await inPage(app, pages[2]!, "getSelection().removeAllRanges(); true");
    await sendKeys(app, { url: pages[2]! }, [
      { type: "keyDown", keyCode: "Meta", modifiers: ["meta"] },
      { type: "keyDown", keyCode: "Alt", modifiers: ["meta", "alt"] },
    ]);
    await expect(switcher).toHaveAttribute("data-ready", "");
    await sendKeys(app, "shell", [{ type: "keyDown", keyCode: "a", modifiers: ["meta"] }]);
    await expect(switcher).toHaveCount(0);
    await expect.poll(() => inPage<number>(app, pages[2]!, "getSelection().toString().length")).toBeGreaterThan(0);
  });

  test("the pointer picks a card, and the modifier's release goes to it", async () => {
    const pages = pagesFor("hover");
    const visited = await openTabs(shell, pages);
    await focusPage(app, pages[2]!);

    await sendKeys(app, { url: pages[2]! }, [
      { type: "keyDown", keyCode: "Control", modifiers: ["control"] },
      { type: "keyDown", keyCode: "Alt", modifiers: ["control", "alt"] },
    ]);
    const switcher = shell.getByTestId("tab-switcher");
    await expect(switcher).toHaveAttribute("data-ready", "");
    const options = switcher.getByTestId("tab-switcher-option");
    const target = options.nth(2);
    await expect(target).toHaveAttribute("data-tab-id", visited[0]!);

    // The pointer, moved through the window's own input with the pair still
    // held, as a real one is: the document sees the pair on its events too.
    // (Playwright's keyboard cannot hold two modifiers without first sending
    // a keydown that carries one, which the switcher reads as a release.)
    const box = await target.boundingBox();
    if (box === null) throw new Error("the card has no box");
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    // A card takes the selection when the pointer has moved on it, by its screen position.
    const moveTo = (point: { x: number; y: number }) =>
      app.evaluate(({ BrowserWindow }, { x, y }) => {
        const shellContents = BrowserWindow.getAllWindows()[0]?.webContents;
        if (shellContents === undefined) throw new Error("Pistachio window is unavailable");
        shellContents.sendInputEvent({ type: "mouseMove", x, y, globalX: x, globalY: y, modifiers: ["control", "alt"] });
      }, point);
    // Moves within one frame reach the document as one: a frame between them.
    await moveTo({ x, y });
    await nextFrames(shell);
    await moveTo({ x: x + 4, y: y + 2 });
    await expect(target).toHaveAttribute("aria-selected", "true");

    // Electron's synthetic input carries no modifier-only keyUp; a key sent
    // without the flag is how main learns of a release it did not see.
    await sendKeys(app, "shell", [{ type: "keyDown", keyCode: "Shift", modifiers: ["shift"] }]);
    await expect(switcher).toHaveCount(0);
    await expect.poll(() => activeTabId(shell)).toBe(visited[0]);
  });

  test("a quick ⌃Tab flips to the previous tab", async () => {
    const pages = pagesFor("flip");
    const visited = await openTabs(shell, pages);
    await focusPage(app, pages[2]!);
    await sendKeys(app, { url: pages[2]! }, [
      { type: "keyDown", keyCode: "Control", modifiers: ["control"] },
      { type: "keyDown", keyCode: "Tab", modifiers: ["control"] },
    ]);
    await sendKeys(app, "shell", [{ type: "keyDown", keyCode: "Return", modifiers: ["control"] }]);
    await expect.poll(() => activeTabId(shell)).toBe(visited[1]);
    await expect(shell.getByTestId("tab-switcher")).toHaveCount(0);
  });

  test("closing the active tab returns to the most recently visited tab", async () => {
    const outcome = await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      const ids: string[] = [];
      for (const url of [
        "pistachio://demo/vendors/atlas-medical?close=1",
        "pistachio://demo/invoices?close=2",
        "pistachio://demo/vendors/atlas-medical?close=3",
      ]) {
        await api.createTab(url);
        const active = (await api.getSnapshot()).activeTabId;
        if (active === null) throw new Error("the new tab was not selected");
        ids.push(active);
      }
      // Visit order is now C > B > A; return to B so C is the previous tab.
      await api.selectTab(ids[1]!);
      await api.closeTab(ids[1]!);
      return { survivorId: ids[2], activeTabId: (await api.getSnapshot()).activeTabId };
    });
    expect(outcome.activeTabId).toBe(outcome.survivorId);
  });
});
