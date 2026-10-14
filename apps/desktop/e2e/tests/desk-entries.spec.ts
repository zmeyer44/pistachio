/**
 * Favorites and pins on the desk (docs/desk.md, "A page's group"): a
 * favorite's or pin's page chosen on a desk gets a page's group, so its desk
 * has all a group's does — ⌘T and a file dropped there stay on it, and it
 * comes back as it was left. Alone, the page is Home's, its desk's Stack
 * under the favorites; with a tab beside it, it is a space of the double
 * sidebar's rail (docs/double-sidebar.md), its rows the card's space view,
 * its tile counting its windows while away. Made a space of its own (its
 * menu) it comes down as a space like any other, the favorite staying,
 * closed; let go on another space's tile a pin's page — or a favorite with
 * none open — comes down into that space; and Tidy's favorites reset brings
 * a favorite's group down (docs/tab-tidy.md §3.7).
 */

import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import type { SidebarCommand } from "@pistachio/shell-contracts/sidebar";
import {
  api,
  box,
  center,
  chooseHome,
  chooseSpace,
  createGroup,
  groupSelector,
  INVOICES,
  launchDesk,
  openTabs,
  railSpace,
  rowSelector,
  screenshots,
  selectSpace,
  selectTab,
  settled,
  snapshot,
  spaceView,
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

/** A row or tile carried onto a rail item, held there until the item says it takes it, then let go. */
async function carryOnto(shell: Page, from: { x: number; y: number }, to: { x: number; y: number }, target: Locator): Promise<void> {
  await shell.mouse.move(from.x, from.y);
  await shell.mouse.down();
  await shell.mouse.move(from.x, from.y + 6, { steps: 2 });
  for (let step = 1; step <= 14; step += 1) {
    await shell.mouse.move(from.x + ((to.x - from.x) * step) / 14, from.y + 6 + ((to.y - from.y - 6) * step) / 14);
    await shell.waitForTimeout(16);
  }
  await expect(target).toHaveAttribute("data-dropping", "");
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
    await selectSpace(shell, "desk-g");
    await expect(shell.locator('[data-testid="sidebar-motion-slot"][data-mode="whole"]')).toHaveCount(1);
    await settled(shell, app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("a favorite's desk is its page's space: ⌘T and a file dropped there stay on it, a space of the rail's then, counted on its tile once away, and it comes back as left", async () => {
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

    // ── 2. ⌘T there: a new tab in the favorite's group, out on its desk — not a day's tab. A page with a tab beside it is
    //       a space of the rail's: its tile (a page's), the card its view, the page's row first ─
    await strikeInShell(app, "t");
    await expect.poll(async () => (await pageGroupOf("fav-mail"))?.tabIds.length ?? 0).toBe(2);
    const fresh = (await pageGroupOf("fav-mail"))!.tabIds.find((tabId) => tabId !== page)!;
    const spaceId = (await pageGroupOf("fav-mail"))!.id;
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await expect(railSpace(shell, spaceId)).toHaveAttribute("data-page", "");
    await expect(railSpace(shell, spaceId)).toHaveAttribute("aria-current", "true");
    await expect(spaceView(shell, spaceId).locator('[role="tab"]')).toHaveCount(2);
    await expect(spaceView(shell, spaceId).locator('[role="tab"]').first()).toHaveAttribute("data-tab-id", page);
    await expect(shell.locator(rowSelector(fresh))).toHaveCount(1);
    await expect(under).toHaveCount(0);
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

    // ── 4. Away to another space: its windows go home to its tile on the rail, which says how many it holds ─
    await selectTab(shell, g0);
    await expect(shell.locator(windowSelector(page))).toHaveCount(0);
    await expect(railSpace(shell, spaceId)).not.toHaveAttribute("aria-current", "true");
    await expect(railSpace(shell, spaceId)).toHaveAttribute("aria-label", /, 2 windows$/);
    await settled(shell, app);
    await capture(app, shell, "02-favorite-counted.png");

    // ── 5. Back by its tile: all of it comes out again, as it was left ─
    await chooseSpace(shell, spaceId);
    await expect(shell.getByTestId("desk-window")).toHaveCount(3);
    await expect(shell.locator(windowSelector(fresh))).toHaveCount(1);
    await settled(shell, app);
  });

  test("made a space of its own, a favorite's page brings its space down as a space like any other; the favorite stays, closed, and opens afresh", async () => {
    test.setTimeout(90_000);
    const page = (await pageOf("fav-mail"))!;
    const group = (await pageGroupOf("fav-mail"))!;
    const stage = await box(shell, ".desk-stage");

    // ── 1. Its space's menu, in the card's head: Make it a space of its own. (Until 2026-10-13 its page's row was carried
    //       down the column into the day's tabs: the card shows one space's rows, or Home's, never both.) ─
    await spaceView(shell, group.id).getByTestId("space-more").click();
    const menu = shell.getByTestId("context-menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "Make it a space of its own", exact: true }).click();
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((candidate) => candidate.id === group.id)?.tabIds).toEqual(group.tabIds);
    expect(await pageGroupOf("fav-mail")).toBe(null);
    expect(await pageOf("fav-mail")).toBe(null);
    expect((await snapshot(shell)).sidebar.favorites.map((favorite) => favorite.id)).toEqual(["fav-mail", "fav-vendor"]);
    // The desk is that space's still: a drawn space's tile on the rail now, no page's, its windows where they were.
    await expect(railSpace(shell, group.id)).toHaveCount(1);
    await expect(railSpace(shell, group.id)).not.toHaveAttribute("data-page", "");
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

  test("let go on another space's tile on the rail, a pin's page — or a favorite with none open — comes down into that space, at its end; the entry stays", async () => {
    test.setTimeout(90_000);

    // ── 1. The pin's page open: alone, it is Home's, its desk the page's own — Home's card shows Pinned ─
    await sidebarCommand(shell, { type: "open", anchorId: "pin-north" });
    await expect.poll(() => pageOf("pin-north")).not.toBe(null);
    const north = (await pageOf("pin-north"))!;
    await expect(shell.locator(windowSelector(north))).toHaveCount(1);
    await expect(shell.locator('[data-testid="sidebar-chrome"][data-view="home"]')).toHaveCount(1);
    await settled(shell, app);

    // ── 2. Its row carried onto the space's tile on the rail and let go there: its page comes down into the space, at its
    //       end, and the pin stays. (Until 2026-10-13 it was let go over the space's desk, beside it in the one list.) ─
    const pinRow = center(await box(shell, '[data-testid="pinned-tab"][data-flip-id="pin-north"]'));
    const ledger = center(await box(shell, groupSelector("desk-g")));
    await carryOnto(shell, pinRow, ledger, railSpace(shell, "desk-g"));
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "desk-g")?.tabIds.at(-1)).toBe(north);
    expect(await pageOf("pin-north")).toBe(null);
    expect((await snapshot(shell)).sidebar.entries.some((entry) => entry.id === "pin-north")).toBe(true);
    await chooseSpace(shell, "desk-g");
    await expect(shell.locator(rowSelector(north))).toHaveCount(1);
    await settled(shell, app);

    // ── 3. A favorite that is not open, its tile (Home's) let go on the space's tile: a fresh page of it in the space ─
    await chooseHome(shell);
    const tile = center(await box(shell, '[data-testid="favorite-tile"][aria-label="Vendor"]'));
    await carryOnto(shell, tile, center(await box(shell, groupSelector("desk-g"))), railSpace(shell, "desk-g"));
    await expect.poll(async () => {
      const now = await snapshot(shell);
      const members = now.tabGroups.find((candidate) => candidate.id === "desk-g")?.tabIds ?? [];
      return now.tabs.filter((tab) => members.includes(tab.id) && tab.url === VENDOR).length;
    }).toBe(1);
    expect(await pageOf("fav-vendor")).toBe(null);
    expect((await snapshot(shell)).sidebar.favorites.map((favorite) => favorite.id)).toEqual(["fav-mail", "fav-vendor"]);
    await chooseSpace(shell, "desk-g");
    await settled(shell, app);
    await capture(app, shell, "04-entries-dropped-on-tile.png");
  });

  test("Tidy's favorites reset brings a favorite's space down into the day's tabs, the favorite closed", async () => {
    test.setTimeout(60_000);
    await sidebarCommand(shell, { type: "open", anchorId: "fav-mail" });
    await expect.poll(async () => (await pageGroupOf("fav-mail"))?.tabIds.length ?? 0).toBe(1);
    const page = (await pageOf("fav-mail"))!;
    await expect(shell.locator(windowSelector(page))).toHaveCount(1);
    await settled(shell, app);
    await strikeInShell(app, "t");
    await expect.poll(async () => (await pageGroupOf("fav-mail"))?.tabIds.length ?? 0).toBe(2);
    const group = (await pageGroupOf("fav-mail"))!;
    // (The new tab in use first, as ⌘T leaves it: chosen away before that, main's own choice of it would come after.)
    const fresh = group.tabIds.find((tabId) => tabId !== page)!;
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(fresh);
    // Out of view: the reset never takes a page in sight.
    await selectTab(shell, g0);
    await expect.poll(async () => (await snapshot(shell)).currentGroupId).toBe("desk-g");
    await expect(shell.locator(windowSelector(page))).toHaveCount(0);
    await settled(shell, app);

    await api(shell, (pistachio) => pistachio.tidy({ type: "run" }));
    await expect.poll(() => pageGroupOf("fav-mail")).toBe(null);
    expect((await snapshot(shell)).tabGroups.find((candidate) => candidate.id === group.id)?.tabIds).toEqual(group.tabIds);
    expect(await pageOf("fav-mail")).toBe(null);
    expect((await snapshot(shell)).sidebar.favorites.map((favorite) => favorite.id)).toEqual(["fav-mail", "fav-vendor"]);
    // A drawn space's tile on the rail now, not a page's.
    await expect(railSpace(shell, group.id)).toHaveCount(1);
    await expect(railSpace(shell, group.id)).not.toHaveAttribute("data-page", "");
  });

  // (Retired 2026-10-13: "on the rail, the open favorites keep their order …" and "on the rail, a favorite's desk with
  // more tabs than the column holds scrolls under its row …" — the rail's favorites folder, its open favorites' rows and
  // the desk's tabs under them (RailFavorites) are not drawn on the desktop since the double sidebar: a favorite's page
  // with tabs beside it is a space on the rail, its rows the card's space view (docs/double-sidebar.md).)
});
