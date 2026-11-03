/**
 * Chrome extensions (docs/extensions.md §2 "Click one" / "Approve one", §4 "Chrome extensions", §11 S1): an unpacked
 * folder with a `manifest.json` (the `mini-action` fixture: an action with a popup, a content script, a badge,
 * `chrome.storage`) loaded through *Load a folder…* waits on the approval sheet; *Turn it on* loads it into the
 * Profile's session; its action's icon stands on the Ledge (`crx://`, served by electron-chrome-extensions); a click
 * opens the library's popup at the icon; a page it matches runs its content script, which writes `chrome.storage.local`.
 *
 * The popup is a frameless child window: with the Mac's screen locked it is made but may not be shown, so what is
 * asserted is that it was created and its page ran (main's webContents), never that it is on screen.
 */

import { cp, mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { pageAt } from "./chrome-harness";
import { createTab, launchDesk, screenshots, settled, snapshot } from "./desk-harness";

const capture = screenshots("extensions-chrome");
const FIXTURE = join(process.cwd(), "e2e/fixtures/chrome/mini-action");

type WithPistachio = { pistachio: PistachioApi };

/** What a contents of main's at `url` (exactly, or by prefix) answers to `script`; null while there is none. */
function evaluateIn(app: ElectronApplication, url: string, script: string): Promise<unknown> {
  return app.evaluate(
    async ({ webContents }, { url, script }) => {
      const contents = webContents.getAllWebContents().find((candidate) => !candidate.isDestroyed() && candidate.getURL().startsWith(url));
      if (contents === undefined) return null;
      try {
        return await contents.executeJavaScript(script);
      } catch {
        return null;
      }
    },
    { url, script },
  );
}

test.describe.serial("Chrome extensions: an unpacked folder, the sheet, the Ledge, a popup, a content script", { tag: ["@extensions"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let server: Server;
  let pageUrl: string;
  /** Pages at origins no host permission covers ([::1], two ports): theirs is the extension's to see by `activeTab` alone. */
  let elsewhere: Server;
  let farther: Server;
  let elsewhereUrl: string;
  let fartherUrl: string;
  let folder: string;
  let extensionId: string;

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    // A copy of the fixture: its id is its path's, and Chromium may write beside an unpacked extension's files.
    folder = join(await mkdtemp(join(tmpdir(), "pistachio-chrome-ext-")), "mini-action");
    await cp(FIXTURE, folder, { recursive: true });
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><head><title>Mini page</title></head><body><p>A page Mini Action matches.</p></body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    pageUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mini`;
    const serve = (title: string): Server =>
      createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html><head><title>${title}</title></head><body><p>${title}</p></body></html>`);
      });
    elsewhere = serve("Elsewhere");
    farther = serve("Farther");
    await new Promise<void>((resolve) => elsewhere.listen(0, "::1", resolve));
    await new Promise<void>((resolve) => farther.listen(0, "::1", resolve));
    elsewhereUrl = `http://[::1]:${String((elsewhere.address() as AddressInfo).port)}/one`;
    fartherUrl = `http://[::1]:${String((farther.address() as AddressInfo).port)}/`;
    ({ app, shell } = await launchDesk({ name: "extensions-chrome" }));
    await settled(shell, app);
  });

  test.afterAll(async () => {
    await app?.close();
    for (const open of [server, elsewhere, farther]) await new Promise<void>((resolve) => (open === undefined ? resolve() : open.close(() => resolve())));
  });

  test("Load a folder… on a Chrome extension: it waits on the sheet, and Turn it on puts its icon on the Ledge", async () => {
    // ── 1. The folder, as *Load a folder…* hands it over: an unpacked Chrome record, waiting for the person ─
    const answer = await shell.evaluate((path) => (window as unknown as WithPistachio).pistachio.extensions({ type: "loadFolder", path }), folder);
    expect(answer).toEqual({ type: "folder", path: folder });
    const icon = shell.locator('[data-testid="ledge-icon"][title^="Mini Action"]');
    await expect(icon).toBeVisible({ timeout: 15_000 });
    await expect(icon).toHaveAttribute("data-dot", "amber");
    extensionId = (await icon.getAttribute("data-extension-id")) ?? "";
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    // Not loaded before it is approved: no service worker, no page of it anywhere.
    expect(await evaluateIn(app, `chrome-extension://${extensionId}/`, "1")).toBeNull();

    // ── 2. The sheet (the snapshot's `pending`): Chrome's warnings in words, its verdict ─
    await icon.click();
    const sheet = shell.getByTestId("extension-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("extension-sheet-name")).toHaveText("Mini Action");
    await expect(sheet).toContainText("Read and change pages on");
    await expect(sheet.getByTestId("extension-sheet-wont")).toHaveCount(0);
    await capture(app, shell, "01-sheet.png");
    await sheet.getByTestId("extension-sheet-turn-on").click();
    await expect(sheet).toHaveCount(0);

    // ── 3. On: no dot, and its action's icon served by `crx://` from the Profile's session ─
    await expect(icon).not.toHaveAttribute("data-dot", /.+/, { timeout: 15_000 });
    const img = icon.locator("img");
    await expect(img).toHaveAttribute("src", new RegExp(`^crx://extension-icon/${extensionId}/`), { timeout: 15_000 });
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)), { timeout: 10_000 }).toBeGreaterThan(0);
    await capture(app, shell, "02-on-the-ledge.png");
  });

  test("a page it matches runs its content script, which writes chrome.storage.local", async () => {
    await createTab(shell, pageUrl);
    await expect.poll(() => evaluateIn(app, pageUrl, "document.documentElement.dataset.miniAction ?? null"), { timeout: 15_000 }).toBe("ran");
    // The count the content script stored and read back from chrome.storage.local.
    await expect.poll(() => evaluateIn(app, pageUrl, "document.documentElement.dataset.miniStorage ?? null"), { timeout: 15_000 }).toBe("1");
  });

  test("the page's context menu carries its contextMenus item after the page's own, and a click reaches its worker", async () => {
    // The native menu is caught as it would pop up (a spec can't press a macOS menu), then its item is clicked.
    await app.evaluate(({ Menu }) => {
      const held = globalThis as unknown as { __menu?: Electron.Menu; __popup?: Electron.Menu["popup"] };
      held.__popup ??= Menu.prototype.popup;
      Menu.prototype.popup = function (this: Electron.Menu) {
        held.__menu = this;
      };
    });
    const page = await pageAt(app, pageUrl);
    await page.click("p", { button: "right" });
    const labels = (): Promise<string[]> =>
      app.evaluate(() => (globalThis as unknown as { __menu?: Electron.Menu }).__menu?.items.map((item) => item.label) ?? []);
    await expect.poll(labels, { timeout: 10_000 }).toContain("Mini Action: mark this page");
    const items = await labels();
    // After the page's own (Back, Reload, …), past a separator.
    expect(items.indexOf("Mini Action: mark this page")).toBeGreaterThan(items.indexOf("Reload"));
    await app.evaluate(({ Menu }) => {
      const held = globalThis as unknown as { __menu?: Electron.Menu; __popup?: Electron.Menu["popup"] };
      held.__menu?.items.find((item) => item.label === "Mini Action: mark this page")?.click();
      if (held.__popup !== undefined) Menu.prototype.popup = held.__popup;
    });
    // The worker heard contextMenus.onClicked and stored the page (read back in the popup below).
  });

  test("its icon opens the library's popup at the icon, whose page reads chrome.storage and pings the worker", async () => {
    const icon = shell.locator(`[data-testid="ledge-icon"][data-extension-id="${extensionId}"]`);
    await icon.click();
    const popupUrl = `chrome-extension://${extensionId}/popup.html`;
    // The popup was created (electron-chrome-extensions' PopupView: a child window of Pistachio's, at the icon).
    await expect
      .poll(
        () =>
          app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.webContents.getURL() === url), popupUrl),
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect.poll(() => evaluateIn(app, popupUrl, "document.body.dataset.popup ?? null"), { timeout: 15_000 }).toBe("ready");
    // chrome.storage.local holds every mark: the content script's page, the menu item's click, this popup's opening.
    const stored = (await evaluateIn(app, popupUrl, 'chrome.storage.local.get(["pageMarks", "popupOpens", "menuClickedOn"])')) as {
      pageMarks?: number;
      popupOpens?: number;
      menuClickedOn?: string | null;
    } | null;
    expect(stored?.pageMarks).toBeGreaterThanOrEqual(1);
    expect(stored?.popupOpens).toBeGreaterThanOrEqual(1);
    expect(stored?.menuClickedOn).toBe(pageUrl);
    await expect.poll(() => evaluateIn(app, popupUrl, "document.getElementById('status')?.textContent ?? null")).toContain("worker: pong");
    // Sized to its page (220px of body and its padding: 248 wide), opened above the Ledge icon from its leading edge.
    const popupBox = (): Promise<{ x: number; bottom: number; width: number; height: number } | null> =>
      app.evaluate(({ BrowserWindow }, url) => {
        const popup = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === url);
        const parent = popup?.getParentWindow();
        if (popup === undefined || parent === null || parent === undefined) return null;
        const box = popup.getBounds();
        const content = parent.getContentBounds();
        return { x: box.x - content.x, bottom: box.y + box.height - content.y, width: box.width, height: box.height };
      }, popupUrl);
    await expect.poll(async () => (await popupBox())?.width ?? 0, { timeout: 10_000 }).toBe(248);
    const placed = await popupBox();
    const anchor = await icon.boundingBox();
    expect(placed).not.toBeNull();
    expect(anchor).not.toBeNull();
    expect(placed!.height).toBeGreaterThan(40);
    expect(Math.abs(placed!.x - Math.round(anchor!.x))).toBeLessThanOrEqual(2);
    expect(placed!.bottom).toBeLessThanOrEqual(Math.round(anchor!.y));
    // It follows its page as the page changes: taller with a block added, and shorter again once it is gone.
    await evaluateIn(app, popupUrl, `(() => { const block = document.createElement("div"); block.id = "block"; block.style.height = "300px"; document.body.appendChild(block); return true; })()`);
    await expect.poll(async () => (await popupBox())?.height ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(placed!.height + 280);
    await evaluateIn(app, popupUrl, `(document.getElementById("block").remove(), true)`);
    await expect.poll(async () => (await popupBox())?.height ?? 0, { timeout: 10_000 }).toBeLessThanOrEqual(placed!.height + 4);
    // The worker's badge, on the Ledge.
    await expect(icon.getByTestId("ledge-badge")).toHaveText("1", { timeout: 10_000 });
    await capture(app, shell, "03-popup.png");
  });

  test("activeTab: a click grants the page's address to the popup and the worker after it, until the tab goes to another origin", async () => {
    const icon = shell.locator(`[data-testid="ledge-icon"][data-extension-id="${extensionId}"]`);
    const popupUrl = `chrome-extension://${extensionId}/popup.html`;
    const popupOpen = (): Promise<boolean> =>
      app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.webContents.getURL() === url), popupUrl);
    // One open from before is closed first (the icon toggles it), then a fresh one opens on the tab in use — asked as the
    // icon's click asks (actions.ts activateExtension), the icon's box as the anchor: a Playwright click on the Ledge
    // right after a tab opened is sometimes not taken (the Ledge mid-reflow), and the click itself is the test above.
    const openPopup = async (): Promise<void> => {
      if (await popupOpen()) {
        await icon.click();
        await expect.poll(popupOpen, { timeout: 10_000 }).toBe(false);
      }
      const box = await icon.boundingBox();
      const anchor = box === null ? null : { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
      await shell.evaluate(
        ({ id, tab, at }) => (window as unknown as WithPistachio).pistachio.extensions({ type: "activate", id, tabId: tab, anchor: at }),
        { id: extensionId, tab: (await snapshot(shell)).activeTabId, at: anchor },
      );
      await expect.poll(() => evaluateIn(app, popupUrl, "document.body.dataset.popup ?? null"), { timeout: 15_000 }).toBe("ready");
    };
    const stored = async <T,>(key: string): Promise<T | null> => (await evaluateIn(app, popupUrl, `chrome.storage.local.get(${JSON.stringify(key)}).then((v) => v[${JSON.stringify(key)}] ?? null)`)) as T | null;
    type Update = { tabId: number; url: string | null; status: string | null };

    // ── 1. A page no host permission covers, in use; the popup opened on it reads its address by the click's grant ─
    await createTab(shell, elsewhereUrl);
    await expect
      .poll(
        async () => {
          const state = await snapshot(shell);
          return state.tabs.find((tab) => tab.id === state.activeTabId)?.url ?? null;
        },
        { timeout: 15_000 },
      )
      .toBe(elsewhereUrl);
    const tabId = (await snapshot(shell)).tabs.find((tab) => tab.url === elsewhereUrl)!.id;
    // (A click on the page first: a popup opened in the second after a tab opened is blurred by the page view taking
    // the keyboard, and the library closes it on blur — the person's focus settles somewhere before they reach the Ledge.)
    await (await pageAt(app, elsewhereUrl)).click("p");
    await openPopup();
    expect(await evaluateIn(app, popupUrl, "document.body.dataset.activeUrl ?? null")).toBe(elsewhereUrl);
    // A query filtered by that address finds the granted tab too (the filter consults the grant).
    expect(await evaluateIn(app, popupUrl, "document.body.dataset.activeByUrl ?? null")).toBe("1");
    // And the popup styles the page by the click's grant alone (tabs.insertCSS, patch hunk 7): the page wears it.
    expect(await evaluateIn(app, popupUrl, "document.body.dataset.activeCss ?? null")).toBe("1");
    // And runs a script in it (MV3 scripting.executeScript, patch hunk 23): the page's title comes back.
    expect(await evaluateIn(app, popupUrl, "document.body.dataset.activeScript ?? null")).toBe(await (await pageAt(app, elsewhereUrl)).title());
    await expect.poll(async () => (await pageAt(app, elsewhereUrl)).evaluate(() => getComputedStyle(document.body).outlineColor), { timeout: 10_000 }).toBe("rgb(1, 2, 3)");

    // ── 2. The grant outlives the click: a same-origin navigation's address reaches the worker's tabs.onUpdated ─
    const sameOrigin = elsewhereUrl.replace(/\/one$/, "/two");
    await shell.evaluate(({ id, url }) => (window as unknown as WithPistachio).pistachio.navigate(id, url), { id: tabId, url: sameOrigin });
    await expect.poll(async () => ((await stored<Update[]>("tabUpdates")) ?? []).some((update) => update.url === sameOrigin), { timeout: 15_000 }).toBe(true);

    // ── 3. At another origin the grant is gone: that navigation's address is hidden from the worker, until a new click ─
    const before = ((await stored<Update[]>("tabUpdates")) ?? []).length;
    await shell.evaluate(({ id, url }) => (window as unknown as WithPistachio).pistachio.navigate(id, url), { id: tabId, url: fartherUrl });
    await expect.poll(async () => ((await stored<Update[]>("tabUpdates")) ?? []).slice(before).some((update) => update.status === "complete"), { timeout: 15_000 }).toBe(true);
    const since = ((await stored<Update[]>("tabUpdates")) ?? []).slice(before);
    expect(since.some((update) => update.url === fartherUrl)).toBe(false);
    expect(since.every((update) => update.url === null)).toBe(true);
    await openPopup();
    expect(await evaluateIn(app, popupUrl, "document.body.dataset.activeUrl ?? null")).toBe(fartherUrl);
    expect(await evaluateIn(app, popupUrl, "document.body.dataset.activeByUrl ?? null")).toBe("1");

    // ── 4. On one of Pistachio's own pages the tab is no tab to extensions: its navigation reaches no webNavigation
    // listener and no tabs.onUpdated; back on the web it is a tab again, each navigation heard once (patch hunk 22) ─
    type Nav = { kind: string; tabId: number; frameId: number; url: string };
    const navsSince = async (from: number): Promise<Nav[]> => ((await stored<Nav[]>("navEvents")) ?? []).slice(from);
    const navsBefore = ((await stored<Nav[]>("navEvents")) ?? []).length;
    const updatesBefore = ((await stored<Update[]>("tabUpdates")) ?? []).length;
    await shell.evaluate(({ id, url }) => (window as unknown as WithPistachio).pistachio.navigate(id, url), { id: tabId, url: "pistachio://notes/" });
    await expect.poll(async () => (await snapshot(shell)).tabs.find((tab) => tab.id === tabId)?.url ?? null, { timeout: 15_000 }).toMatch(/^pistachio:\/\/notes/);
    await shell.evaluate(({ id, url }) => (window as unknown as WithPistachio).pistachio.navigate(id, url), { id: tabId, url: fartherUrl });
    await expect.poll(async () => (await navsSince(navsBefore)).some((nav) => nav.kind === "completed" && nav.url === fartherUrl), { timeout: 15_000 }).toBe(true);
    const navs = await navsSince(navsBefore);
    expect(navs.filter((nav) => nav.url.startsWith("pistachio:"))).toEqual([]);
    expect(navs.filter((nav) => nav.kind === "committed" && nav.frameId === 0 && nav.url === fartherUrl)).toHaveLength(1);
    expect(navs.filter((nav) => nav.kind === "completed" && nav.frameId === 0 && nav.url === fartherUrl)).toHaveLength(1);
    const updates = ((await stored<Update[]>("tabUpdates")) ?? []).slice(updatesBefore);
    expect(updates.filter((update) => (update.url ?? "").startsWith("pistachio:"))).toEqual([]);
    expect(updates.filter((update) => update.status === "complete")).toHaveLength(1);
  });
});
