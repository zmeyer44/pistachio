/**
 * The desk's Drawer frame end to end (docs/desk.md): chosen on the More
 * card, a window is its page alone. The window in use, with room above it,
 * has its drawer out above it — its title and controls — and its page where
 * it was. Filled (no room above), its drawer is in, and comes out for the
 * pointer at the top of its live page, which main relays: the window slides
 * down under the drawer, its view cut at the desk's foot and its page held
 * at its own size; the pointer further down the page puts it back.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type ElectronApplication } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { box, createGroup, INVOICES, launchDesk, liveViews, openGroupDesk, openMore, openTabs, rowSelector, screenshots, selectTab, settled, snapshot, VENDOR, windowSelector } from "./desk-harness";

const capture = screenshots("desk-drawer");

/** The drawer's height (the engine's DRAWER_H). */
const DRAWER_H = 34;

/** A mouse event on the tab's page, as the person's would reach it (main's mouse hook sees it). */
function pageMouse(app: ElectronApplication, url: string, type: "mouseMove" | "mouseLeave" | "mouseDown" | "mouseUp", x: number, y: number): Promise<void> {
  return app.evaluate(
    async ({ webContents }, { url, type, x, y }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
      if (contents === undefined) throw new Error(`no page at ${url}`);
      contents.sendInputEvent(type === "mouseDown" || type === "mouseUp" ? { type, x, y, button: "left", clickCount: 1 } : { type, x, y });
      await new Promise((done) => setTimeout(done, 60));
    },
    { url, type, x, y },
  );
}

/** Run a script in the tab's page. */
function inPage<T>(app: ElectronApplication, url: string, script: string): Promise<T> {
  return app.evaluate(
    async ({ webContents }, { url, script }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
      if (contents === undefined) throw new Error(`no page at ${url}`);
      return contents.executeJavaScript(script) as Promise<T>;
    },
    { url, script },
  );
}

/** What the tab's page lays out at. */
function pageSize(app: ElectronApplication, url: string): Promise<{ width: number; height: number }> {
  return app.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
    if (contents === undefined) throw new Error(`no page at ${url}`);
    const [width, height] = (await contents.executeJavaScript("[innerWidth, innerHeight]")) as [number, number];
    return { width, height };
  }, url);
}

test("the Drawer frame: out above the window in use; filled, out for the pointer at its page's top, the window slid down under it and its page held at its size", { tag: ["@desk"] }, async () => {
  test.setTimeout(120_000);
  const { app, shell } = await launchDesk({ name: "drawer" });
  try {
    const [invoice, vendor] = (await openTabs(shell, [INVOICES, VENDOR])) as [string, string];
    await createGroup(shell, "desk-drawer", [invoice, vendor], "Northstar", "blue");
    await selectTab(shell, invoice);
    await openGroupDesk(shell, "desk-drawer");
    await settled(shell, app);
    await shell.locator(rowSelector(vendor)).click();
    await settled(shell, app);
    await expect(shell.locator('[data-testid="desk-window"]')).toHaveCount(2);

    // ── 1. The Drawer frame, from the More card's Feel; the windows cascaded, each with room above it ─
    await openMore(shell);
    const frame = shell.getByTestId("desk-variant-chrome");
    for (let i = 0; i < 4 && (await frame.getAttribute("data-value")) !== "drawer"; i += 1) await frame.click();
    await expect(frame).toHaveAttribute("data-value", "drawer");
    await shell.getByTestId("desk-cascade").click();
    await shell.keyboard.press("Escape");
    await expect(shell.locator('[data-testid="desk-more-card"][data-shown]')).toHaveCount(0);
    const stage = await box(shell, ".desk-stage");
    // Off every window: in the gutter above the desk.
    const away = (): Promise<void> => shell.mouse.move(stage.x + stage.width - 40, stage.y - 4);
    await away();
    await settled(shell, app);

    const inUse = shell.locator('[data-testid="desk-window"][data-focused]');
    const tabId = (await inUse.getAttribute("data-tab-id"))!;
    const url = tabId === invoice ? INVOICES : VENDOR;
    const other = tabId === invoice ? vendor : invoice;
    const win = shell.locator(windowSelector(tabId));
    await expect(win).toHaveAttribute("data-chrome", "drawer");
    await expect(win).toHaveAttribute("data-drawer-room", "roomy");
    // In use: its drawer out above it, the window's page where the window is.
    await expect(win).toHaveAttribute("data-drawer-out", "");
    const cascaded = await box(shell, windowSelector(tabId));
    expect(cascaded.y - stage.y).toBeGreaterThanOrEqual(DRAWER_H);
    const drawer = await box(shell, `${windowSelector(tabId)} [data-testid="desk-window-drawer"]`);
    expect(Math.round(drawer.width)).toBe(Math.round(cascaded.width));
    await expect.poll(async () => (await liveViews(app)).find((view) => view.url === url)?.bounds.y).toBe(Math.round(cascaded.y));
    // The other, not in use and not under the pointer: in.
    await expect(shell.locator(windowSelector(other))).not.toHaveAttribute("data-drawer-out", "");
    await capture(app, shell, "01-drawer-out-in-use.png");

    // ── 2. Filled from its drawer: no room above, so in — until the pointer is at its page's top ─
    await win.getByRole("button", { name: "Fill the desk" }).click();
    await away();
    await settled(shell, app);
    await expect(win).toHaveAttribute("data-drawer-room", "tight");
    await expect(win).not.toHaveAttribute("data-drawer-out", "");
    const whole = { x: Math.round(stage.x), y: Math.round(stage.y), width: Math.round(stage.width), height: Math.round(stage.height) };
    await expect.poll(async () => (await liveViews(app)).find((view) => view.url === url)?.bounds).toEqual(whole);
    await expect.poll(() => pageSize(app, url)).toEqual({ width: whole.width, height: whole.height });
    await capture(app, shell, "02-filled-drawer-in.png");

    // (Every resize the page sees from here on is recorded: it is to see none.)
    await inPage(app, url, "window.__resizes = []; addEventListener('resize', () => __resizes.push([innerWidth, innerHeight])); true");
    await pageMouse(app, url, "mouseMove", 240, 4);
    await expect(win).toHaveAttribute("data-drawer-out", "");
    // The page slid away from under the pointer: it is on the drawer now (Playwright's pointer is the shell's alone, so it is moved there).
    await pageMouse(app, url, "mouseLeave", 240, 4);
    await shell.mouse.move(stage.x + 240, stage.y + DRAWER_H / 2);
    await settled(shell, app);
    await expect(win).toHaveAttribute("data-drawer-out", "");
    // The window slid down under its drawer: its view cut at the desk's foot, its page laid out at its own size still.
    expect(await liveViews(app).then((views) => views.find((view) => view.url === url)?.bounds)).toEqual({ ...whole, y: whole.y + DRAWER_H, height: whole.height - DRAWER_H });
    expect(await pageSize(app, url)).toEqual({ width: whole.width, height: whole.height });
    const out = await box(shell, `${windowSelector(tabId)} [data-testid="desk-window-drawer"]`);
    expect(Math.round(out.y)).toBe(whole.y);
    // Its controls take the pointer down to their lower edge: nothing of the strip at the window's top lies over them.
    const controls = await shell.locator(`${windowSelector(tabId)} [data-testid="desk-window-drawer"] button`).all();
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      const at = (await control.boundingBox())!;
      const hit = await shell.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label") ?? null, {
        x: at.x + at.width / 2,
        y: at.y + at.height - 1,
      });
      expect(hit).toBe(await control.getAttribute("aria-label"));
    }
    await capture(app, shell, "03-filled-drawer-out.png");

    // ── 3. Further down the page: back in, the window back up, its page never laid out at the cut box ─
    await away();
    await pageMouse(app, url, "mouseMove", 240, 300);
    await expect(win).not.toHaveAttribute("data-drawer-out", "");
    await settled(shell, app);
    await expect.poll(async () => (await liveViews(app)).find((view) => view.url === url)?.bounds).toEqual(whole);
    expect(await pageSize(app, url)).toEqual({ width: whole.width, height: whole.height });
    expect(await inPage(app, url, "window.__resizes")).toEqual([]);
    await pageMouse(app, url, "mouseLeave", 240, 300);

    // ── 4. Left for the desk's own surface: its drawer in, and it looks out of use; a press on its page, and it is back ─
    await pageMouse(app, url, "mouseMove", 240, 4);
    await expect(win).toHaveAttribute("data-drawer-out", "");
    await pageMouse(app, url, "mouseLeave", 240, 4);
    await shell.mouse.move(stage.x + 240, stage.y + DRAWER_H / 2);
    await win.getByRole("button", { name: "Restore" }).click();
    await away();
    await settled(shell, app);
    await expect(win).toHaveAttribute("data-drawer-room", "roomy");
    await expect(win).toHaveAttribute("data-drawer-out", "");
    await expect(win).toHaveAttribute("data-focused", "");
    // A point of the desk's own, between its windows.
    const bare = await shell.evaluate(() => {
      const desk = document.querySelector(".desk-stage")!.getBoundingClientRect();
      for (let y = desk.bottom - 60; y > desk.top + 40; y -= 30)
        for (let x = desk.right - 40; x > desk.left + 40; x -= 30) if (document.elementFromPoint(x, y)?.classList.contains("desk-stage") === true) return { x, y };
      return null;
    });
    expect(bare).not.toBeNull();
    await shell.mouse.click(bare!.x, bare!.y);
    await expect(win).not.toHaveAttribute("data-drawer-out", "");
    await expect(win).not.toHaveAttribute("data-focused", "");
    // Still the browser's tab in use: only the person has left it.
    expect((await snapshot(shell)).activeTabId).toBe(tabId);
    await capture(app, shell, "04-left-for-the-desk.png");
    await pageMouse(app, url, "mouseDown", 200, 200);
    await pageMouse(app, url, "mouseUp", 200, 200);
    await expect(win).toHaveAttribute("data-drawer-out", "");
    await expect(win).toHaveAttribute("data-focused", "");
    await pageMouse(app, url, "mouseLeave", 200, 200);

    // ── 5. Its drawer's page controls, as the pane toolbar's: back and forward (dimmed with no history), and reload ─
    const server = await new Promise<Server>((done) => {
      const created = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>Second page</title><h1>Second page</h1>");
      });
      created.listen(0, "127.0.0.1", () => done(created));
    });
    try {
      const second = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/second`;
      const urlNow = async (): Promise<string | undefined> => (await snapshot(shell)).tabs.find((tab) => tab.id === tabId)?.url;
      const drawerOf = win.getByTestId("desk-window-drawer");
      const back = drawerOf.getByTestId("desk-back");
      const forward = drawerOf.getByTestId("desk-forward");
      await expect(back).toHaveAttribute("aria-disabled", "true");
      await expect(forward).toHaveAttribute("aria-disabled", "true");
      // (Dimmed, a click is nothing: the page stays. Playwright clicks no aria-disabled button of its own accord.)
      await back.click({ force: true });
      expect(await urlNow()).toBe(url);
      await shell.evaluate(({ tabId, second }) => (window as unknown as { pistachio: PistachioApi }).pistachio.navigate(tabId, second), { tabId, second });
      await expect.poll(urlNow).toBe(second);
      await expect(back).not.toHaveAttribute("aria-disabled", "true");
      await back.click();
      await expect.poll(urlNow).toBe(url);
      await expect(forward).not.toHaveAttribute("aria-disabled", "true");
      await forward.click();
      await expect.poll(urlNow).toBe(second);
      await expect.poll(() => inPage<string>(app, second, "document.title").catch(() => "")).toBe("Second page");
      await inPage(app, second, "window.__before = true");
      await drawerOf.getByTestId("desk-reload").click();
      await expect.poll(() => inPage<boolean>(app, second, "window.__before === undefined").catch(() => false)).toBe(true);
      await away();
      await settled(shell, app);
      await capture(app, shell, "05-drawer-page-controls.png");
    } finally {
      server.close();
    }
  } finally {
    await app.close();
  }
});
