/**
 * Favorites and pins on the desk (docs/desk.md, "A page's group"): a
 * favorite's or pin's page chosen on a desk gets a page's group, so its desk
 * has all a group's does — ⌘T and a file dropped there stay on it, drawn
 * under the favorite while its desk is up and counted on its tile when not,
 * and it comes back as it was left. Dragged into the day's tabs it comes
 * down as a group like any other, the favorite staying, closed; let go over
 * another group's desk a favorite's or pin's page comes down into that
 * group, its window where it was let go; and Tidy's favorites reset brings
 * a favorite's group down (docs/tab-tidy.md §3.7).
 */

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { IPC, type PistachioApi } from "@pistachio/shell-contracts/ipc";
import type { SidebarCommand } from "@pistachio/shell-contracts/sidebar";
import {
  api,
  box,
  center,
  createGroup,
  INVOICES,
  launchDesk,
  openGroupDesk,
  openTabs,
  screenshots,
  selectTab,
  settled,
  snapshot,
  VENDOR,
  windowSelector,
  type Box,
} from "./desk-harness";

const capture = screenshots("desk-entries");

const MAIL = "pistachio://demo/auth/relying-party?favorite=mail";
const NORTH = "pistachio://demo/invoices?page=north";
const SOUTH = "pistachio://demo/invoices?page=south";

const sidebarCommand = (shell: Page, command: SidebarCommand): Promise<unknown> =>
  shell.evaluate((body) => (window as unknown as { pistachio: PistachioApi }).pistachio.sidebarCommand(body), command);

/** ⌘ and a key, struck in the shell (which has the keyboard when nothing on a page does). */
function strikeInShell(app: ElectronApplication, keyCode: string): Promise<void> {
  return app.evaluate(({ BrowserWindow }, keyCode) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    contents.focus();
    contents.sendInputEvent({ type: "keyDown", keyCode: "Meta", modifiers: ["meta"] });
    contents.sendInputEvent({ type: "keyDown", keyCode, modifiers: ["meta"] });
    contents.sendInputEvent({ type: "keyUp", keyCode, modifiers: ["meta"] });
    contents.sendInputEvent({ type: "keyUp", keyCode: "Meta", modifiers: [] });
  }, keyCode);
}

/** A text file dragged over the desk and let go on its workspace at a point: the drop zone comes up first, as for a person's drag. */
async function dropFileOnDesk(shell: Page, name: string, text: string, at: { x: number; y: number }): Promise<void> {
  const data = await shell.evaluateHandle(
    ({ name, text }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([text], name, { type: "text/plain" }));
      return transfer;
    },
    { name, text },
  );
  await shell.dispatchEvent(".desk-stage", "dragenter", { dataTransfer: data, clientX: at.x, clientY: at.y });
  await expect(shell.locator('[data-testid="desk-drop-zone"][data-up]')).toHaveCount(1);
  for (const type of ["dragenter", "dragover", "drop"]) await shell.dispatchEvent('[data-testid="desk-drop-zone"]', type, { dataTransfer: data, clientX: at.x, clientY: at.y });
}

/** A row or tile carried from where it is to `to`, slowly, the pointer still before it lets go: a placement. */
async function carry(shell: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await shell.mouse.move(from.x, from.y);
  await shell.mouse.down();
  await shell.mouse.move(from.x, from.y + 6, { steps: 2 });
  for (let step = 1; step <= 14; step += 1) {
    await shell.mouse.move(from.x + ((to.x - from.x) * step) / 14, from.y + 6 + ((to.y - from.y - 6) * step) / 14);
    await shell.waitForTimeout(16);
  }
  await shell.waitForTimeout(200);
  await shell.mouse.up();
}

const near = (a: Box, b: Box, within = 2): boolean => ["x", "y", "width", "height"].every((key) => Math.abs(a[key as keyof Box] - b[key as keyof Box]) < within);

test.describe.serial("favorites and pins on the desk", { tag: ["@desk", "@sidebar", "@tabs"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let g0: string;

  /** The tab that is an entry's page now, if any. */
  const pageOf = async (anchorId: string): Promise<string | null> => (await snapshot(shell)).tabs.find((tab) => tab.anchorId === anchorId)?.id ?? null;
  /** The page's group of an entry, if it has one. */
  const pageGroupOf = async (anchorId: string) => ((await snapshot(shell)).anchorGroups ?? []).find((group) => group.anchorId === anchorId) ?? null;

  test.beforeAll(async () => {
    ({ app, shell } = await launchDesk({
      name: "entries",
      files: {
        "sidebar.json": {
          version: 1,
          spaces: {
            work: {
              favorites: [
                { id: "fav-mail", url: MAIL, title: "Mail", faviconUrl: null },
                { id: "fav-vendor", url: VENDOR, title: "Vendor", faviconUrl: null },
              ],
              entries: [{ kind: "pin", id: "pin-north", url: NORTH, title: "North", faviconUrl: null, folderId: null }],
            },
          },
        },
      },
    }));
    let g1: string;
    [g0, g1] = (await openTabs(shell, [INVOICES, SOUTH])) as [string, string];
    await createGroup(shell, "desk-g", [g0, g1], "Ledger", "blue");
    await selectTab(shell, g0);
    await openGroupDesk(shell, "desk-g");
    await expect(shell.locator('[data-testid="sidebar-motion-slot"][data-rail]')).toHaveCount(1);
    await settled(shell, app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("a favorite's desk is its page's group: ⌘T and a file dropped there stay on it, under the favorite, counted on it once away, and it comes back as left", async () => {
    test.setTimeout(90_000);
    const stage = await box(shell, ".desk-stage");

    // ── 1. Chosen on the desk, a favorite's page gets a group of its own: its desk has the Bar and the Stack, its one window the desk ─
    await sidebarCommand(shell, { type: "open", anchorId: "fav-mail" });
    await expect.poll(async () => (await pageGroupOf("fav-mail"))?.tabIds.length ?? 0).toBe(1);
    const page = (await pageOf("fav-mail"))!;
    await expect(shell.locator(windowSelector(page))).toHaveCount(1);
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await settled(shell, app);
    expect(near(await box(shell, windowSelector(page)), stage)).toBe(true);
    await expect(shell.getByTestId("desk-bar")).toHaveCount(1);
    const under = shell.locator('[data-testid="entry-tabs"][data-anchor-id="fav-mail"]');
    await expect(under).toHaveCount(1);
    await expect(under.getByTestId("desk-stack")).toHaveCount(1);

    // ── 2. ⌘T there: a new tab in the favorite's group, out on its desk, under the favorite — not among the day's tabs ─
    await strikeInShell(app, "t");
    await expect.poll(async () => (await pageGroupOf("fav-mail"))?.tabIds.length ?? 0).toBe(2);
    const fresh = (await pageGroupOf("fav-mail"))!.tabIds.find((tabId) => tabId !== page)!;
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await expect(under.locator(`[data-tab-id="${fresh}"]`)).toHaveCount(1);
    await expect(shell.locator(`#sidebar-section-live [data-tab-id="${fresh}"]`)).toHaveCount(0);
    expect((await pageGroupOf("fav-mail"))!.tabIds[0]).toBe(page);
    await settled(shell, app);

    // ── 3. A file dropped on it: a document window, its file in the favorite's Stack ─
    const group = (await pageGroupOf("fav-mail"))!;
    await dropFileOnDesk(shell, "plan.txt", "Lisbon plan\n", { x: stage.x + stage.width * 0.5, y: stage.y + stage.height * 0.5 });
    await expect(shell.getByTestId("desk-window")).toHaveCount(3);
    await expect
      .poll(async () => (await api(shell, (pistachio) => pistachio.getGroupContexts())).find((context) => context.groupId === group.id)?.items.map((item) => (item.kind === "file" ? item.name : "")))
      .toEqual(["plan.txt"]);
    await settled(shell, app);
    await capture(app, shell, "01-favorite-desk-group.png");

    // ── 4. Away to another group: its windows go home to the favorite, whose row on the rail counts the tab waiting there ─
    await selectTab(shell, g0);
    await expect(shell.locator(windowSelector(page))).toHaveCount(0);
    await expect(under).toHaveCount(0);
    const openRow = shell.locator(`[data-testid="rail-favorite-open"][data-live-tab-id="${page}"]`);
    await expect(openRow.getByTestId("favorite-tab-count")).toHaveText("1");
    await settled(shell, app);
    await capture(app, shell, "02-favorite-counted.png");

    // ── 5. Back by its row: all of it comes out again, as it was left ─
    await openRow.click();
    await expect(shell.getByTestId("desk-window")).toHaveCount(3);
    await expect(shell.locator(windowSelector(fresh))).toHaveCount(1);
    await expect(under).toHaveCount(1);
    await settled(shell, app);
  });

  test("dragged into the day's tabs, a favorite's page brings its group down as a group like any other; the favorite stays, closed, and opens afresh", async () => {
    test.setTimeout(90_000);
    const page = (await pageOf("fav-mail"))!;
    const group = (await pageGroupOf("fav-mail"))!;
    const stage = await box(shell, ".desk-stage");

    // ── 1. Its page's row, under the favorites' folder, carried down the column into the day's tabs ─
    const from = center(await box(shell, `[data-testid="rail-favorite-open"][data-live-tab-id="${page}"]`));
    const live = await box(shell, "#sidebar-section-live");
    await carry(shell, from, { x: from.x, y: live.y + live.height + 12 });
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((candidate) => candidate.id === group.id)?.tabIds).toEqual(group.tabIds);
    expect(await pageGroupOf("fav-mail")).toBe(null);
    expect(await pageOf("fav-mail")).toBe(null);
    expect((await snapshot(shell)).sidebar.favorites.map((favorite) => favorite.id)).toEqual(["fav-mail", "fav-vendor"]);
    // The desk is that group's still: drawn among the day's tabs now, its windows where they were.
    await expect(shell.locator(`#sidebar-section-live [data-testid="tab-group"][data-group-id="${group.id}"]`)).toHaveCount(1);
    await expect(shell.getByTestId("desk-window")).toHaveCount(3);
    await settled(shell, app);
    // Its document with it, the group's context the same.
    await expect(shell.getByTestId("desk-window").filter({ hasText: "plan.txt" })).toHaveCount(1);
    await capture(app, shell, "03-favorite-brought-down.png");

    // ── 2. Opened again, the favorite is a page of its own, on a desk of its own, filling it ─
    await sidebarCommand(shell, { type: "open", anchorId: "fav-mail" });
    await expect.poll(async () => (await pageGroupOf("fav-mail"))?.tabIds.length ?? 0).toBe(1);
    const again = (await pageOf("fav-mail"))!;
    expect(again).not.toBe(page);
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await settled(shell, app);
    expect(near(await box(shell, windowSelector(again)), stage)).toBe(true);
  });

  test("let go over another group's desk, a pin's page — or a favorite with none open — comes down into that group, its window where it was let go; the entry stays", async () => {
    test.setTimeout(90_000);
    const stage = await box(shell, ".desk-stage");

    // ── 1. The pin's page open (its own desk for a moment), then back on the group's ─
    await sidebarCommand(shell, { type: "open", anchorId: "pin-north" });
    await expect.poll(() => pageOf("pin-north")).not.toBe(null);
    const north = (await pageOf("pin-north"))!;
    await expect(shell.locator(windowSelector(north))).toHaveCount(1);
    await selectTab(shell, g0);
    await expect(shell.locator(windowSelector(north))).toHaveCount(0);
    await settled(shell, app);

    // ── 2. Its row carried out over the desk and let go there ─
    const pinRow = center(await box(shell, '[data-testid="pinned-tab"][data-flip-id="pin-north"]'));
    const there = { x: stage.x + stage.width * 0.6, y: stage.y + stage.height * 0.4 };
    await carry(shell, pinRow, there);
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "desk-g")?.tabIds.includes(north)).toBe(true);
    await expect(shell.locator(windowSelector(north))).toHaveCount(1);
    expect(await pageOf("pin-north")).toBe(null);
    expect((await snapshot(shell)).sidebar.entries.some((entry) => entry.id === "pin-north")).toBe(true);
    await settled(shell, app);
    // Where it was let go (kept inside the desk, so it may have risen to fit).
    const landed = await box(shell, windowSelector(north));
    expect(there.x > landed.x && there.x < landed.x + landed.width && there.y > landed.y && there.y < landed.y + landed.height).toBe(true);

    // ── 3. In the whole sidebar, a favorite that is not open, its tile let go over the desk: a fresh page of it in the group ─
    await shell.getByTestId("desk-rail-toggle").click();
    await expect(shell.locator('[data-testid="sidebar-motion-slot"]:not([data-rail])[data-desk]')).toHaveCount(1);
    await settled(shell, app);
    const wide = await box(shell, ".desk-stage");
    const tile = center(await box(shell, '[data-testid="favorite-tile"][aria-label="Vendor"]'));
    await carry(shell, tile, { x: wide.x + wide.width * 0.3, y: wide.y + wide.height * 0.6 });
    await expect.poll(async () => {
      const now = await snapshot(shell);
      const members = now.tabGroups.find((candidate) => candidate.id === "desk-g")?.tabIds ?? [];
      return now.tabs.filter((tab) => members.includes(tab.id) && tab.url === VENDOR).length;
    }).toBe(1);
    expect(await pageOf("fav-vendor")).toBe(null);
    expect((await snapshot(shell)).sidebar.favorites.map((favorite) => favorite.id)).toEqual(["fav-mail", "fav-vendor"]);
    await expect(shell.getByTestId("desk-window")).toHaveCount(3);
    await settled(shell, app);
    await capture(app, shell, "04-entries-dropped-on-desk.png");
    await shell.getByTestId("desk-rail-toggle").click();
    await expect(shell.locator('[data-testid="sidebar-motion-slot"][data-rail]')).toHaveCount(1);
    await settled(shell, app);
  });

  test("Tidy's favorites reset brings a favorite's group down into the day's tabs, the favorite closed", async () => {
    test.setTimeout(60_000);
    await sidebarCommand(shell, { type: "open", anchorId: "fav-mail" });
    await expect.poll(async () => (await pageGroupOf("fav-mail"))?.tabIds.length ?? 0).toBe(1);
    const page = (await pageOf("fav-mail"))!;
    await expect(shell.locator(windowSelector(page))).toHaveCount(1);
    await settled(shell, app);
    await strikeInShell(app, "t");
    await expect.poll(async () => (await pageGroupOf("fav-mail"))?.tabIds.length ?? 0).toBe(2);
    const group = (await pageGroupOf("fav-mail"))!;
    // Out of view: the reset never takes a page in sight.
    await selectTab(shell, g0);
    await expect(shell.locator(windowSelector(page))).toHaveCount(0);
    await settled(shell, app);

    await api(shell, (pistachio) => pistachio.tidy({ type: "run" }));
    await expect.poll(() => pageGroupOf("fav-mail")).toBe(null);
    expect((await snapshot(shell)).tabGroups.find((candidate) => candidate.id === group.id)?.tabIds).toEqual(group.tabIds);
    expect(await pageOf("fav-mail")).toBe(null);
    expect((await snapshot(shell)).sidebar.favorites.map((favorite) => favorite.id)).toEqual(["fav-mail", "fav-vendor"]);
    await expect(shell.locator(`#sidebar-section-live [data-testid="tab-group"][data-group-id="${group.id}"]`)).toHaveCount(1);
  });

  test("on the rail, the open favorites keep their order as the desk passes from one's to the other's, its tabs and Stack under the one up", async () => {
    test.setTimeout(60_000);
    await expect(shell.locator('[data-testid="sidebar-motion-slot"][data-rail]')).toHaveCount(1);
    for (const anchorId of ["fav-mail", "fav-vendor"]) {
      await sidebarCommand(shell, { type: "open", anchorId });
      await expect.poll(async () => (await pageGroupOf(anchorId))?.tabIds.length ?? 0).toBe(1);
    }
    const mail = (await pageOf("fav-mail"))!;
    const vendor = (await pageOf("fav-vendor"))!;
    const openRows = shell.getByTestId("rail-favorite-open");
    const order = async (): Promise<string[]> => openRows.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-live-tab-id") ?? ""));
    /** The tab whose row the desk's tabs and Stack stand under (none: -1). */
    const entryUnder = (): Promise<string | null> =>
      shell.evaluate(() => document.querySelector('[data-testid="rail-favorite-entry"]')?.previousElementSibling?.getAttribute("data-live-tab-id") ?? null);
    for (const [up, row] of [
      [vendor, null],
      [mail, mail],
      [vendor, vendor],
    ] as const) {
      // Chosen by its row (the first time, it was just opened).
      if (row !== null) await shell.locator(`[data-testid="rail-favorite-open"][data-live-tab-id="${row}"]`).click();
      await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(up);
      await expect(shell.locator(windowSelector(up))).toHaveCount(1);
      // The favorites' order, whichever is up, and its Stack under its own row — not its page's row a second time.
      await expect.poll(order).toEqual([mail, vendor]);
      await expect.poll(entryUnder).toBe(up);
      await expect(shell.locator('[data-testid="rail-favorite-entry"] [data-testid="desk-stack"]')).toHaveCount(1);
      await expect(shell.locator(`[data-testid="entry-tabs"] [data-tab-id="${up}"]`)).toHaveCount(0);
      // (Its desk up, its tabs are under it: none counted on its row.)
      await expect(shell.locator(`[data-testid="rail-favorite-open"][data-live-tab-id="${up}"] [data-testid="favorite-tab-count"]`)).toHaveCount(0);
    }
    await settled(shell, app);
    await capture(app, shell, "05-rail-favorites-in-order.png");

    // ⇧⌫ with the pointer on that row closes its page, as on any tab's row on a desk.
    await app.evaluate(({ ipcMain }, channel) => {
      ipcMain.on(channel, (_event, state: { dockHover?: boolean } | null) => {
        (globalThis as unknown as { deskDockHover: boolean }).deskDockHover = state?.dockHover === true;
      });
    }, IPC.deskSet);
    await shell.locator(`[data-testid="rail-favorite-open"][data-live-tab-id="${vendor}"]`).hover();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { deskDockHover?: boolean }).deskDockHover === true)).toBe(true);
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      contents.sendInputEvent({ type: "keyDown", keyCode: "Backspace", modifiers: ["shift"] });
      contents.sendInputEvent({ type: "keyUp", keyCode: "Backspace", modifiers: ["shift"] });
    });
    await expect.poll(() => pageOf("fav-vendor")).toBe(null);
    expect((await snapshot(shell)).sidebar.favorites.map((favorite) => favorite.id)).toEqual(["fav-mail", "fav-vendor"]);
  });

  test("on the rail, a favorite's desk with more tabs than the column holds scrolls under its row, and leaves the tab list its room", async () => {
    test.setTimeout(90_000);
    await expect(shell.locator('[data-testid="sidebar-motion-slot"][data-rail]')).toHaveCount(1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 560));
    try {
      await sidebarCommand(shell, { type: "open", anchorId: "fav-mail" });
      await expect.poll(() => pageOf("fav-mail")).not.toBe(null);
      // Tabs enough on its desk to run the column out.
      for (let added = 0; added < 12; added += 1) {
        const before = (await pageGroupOf("fav-mail"))?.tabIds.length ?? 0;
        await strikeInShell(app, "t");
        await expect.poll(async () => (await pageGroupOf("fav-mail"))?.tabIds.length ?? 0).toBe(before + 1);
      }
      const stack = shell.locator('[data-testid="rail-favorite-entry"] [data-testid="desk-stack"]');
      await expect(stack).toHaveCount(1);
      await stack.scrollIntoViewIfNeeded();
      const height = await shell.evaluate(() => window.innerHeight);
      const reached = (await stack.boundingBox())!;
      expect(reached.y + reached.height).toBeLessThanOrEqual(height);
      // The day's tabs and groups still have their list.
      expect((await box(shell, '[data-testid="sidebar-tab-list"]')).height).toBeGreaterThan(80);
      await capture(app, shell, "06-rail-favorite-desk-scrolls.png");
      // One of its rows carried, the rows scrolled: it stays under the pointer (its place read within the scrolled rows).
      const last = shell.locator('[data-testid="rail-favorite-entry"] [data-row-kind="entry"]').last();
      await last.scrollIntoViewIfNeeded();
      expect(await shell.evaluate(() => document.querySelector('[data-testid="rail-favorites-open"]')!.scrollTop)).toBeGreaterThan(20);
      const row = (await last.boundingBox())!;
      const grab = { x: row.x + row.width / 2, y: row.y + row.height / 2 };
      await shell.mouse.move(grab.x, grab.y);
      await shell.mouse.down();
      await shell.mouse.move(grab.x, grab.y + 6, { steps: 2 });
      await shell.mouse.move(grab.x, grab.y + 14, { steps: 4 });
      await shell.waitForTimeout(100);
      const held = (await last.boundingBox())!;
      expect(Math.abs(held.y + held.height / 2 - (grab.y + 14))).toBeLessThan(6);
      await shell.mouse.up();
    } finally {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
    }
  });
});
