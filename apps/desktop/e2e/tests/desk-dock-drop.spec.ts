/**
 * A desk window carried over the sidebar's column (docs/desk.md, "Over the
 * sidebar"; lib/desk/dock-drop.ts): over the card showing its space it becomes
 * one of the card's rows, over another space's tile on the rail one of the
 * rail's tiles — and back over the desk the window again — and let go there it
 * collapses into its row, its tab joins that space, makes a space of its own
 * on New space, or is a Home tab on Home. The real wiring: the drag layer's
 * samples over the column (the sidebar's own DOM hears nothing then), the
 * window's morph, the target lit in the sidebar, and each release's result in
 * main's snapshot. The hit-test and the shapes are desk-dock-drop.test's, the
 * engine's springs and releases desk-engine.test's.
 */

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import type { SidebarCommand } from "@pistachio/shell-contracts/sidebar";
import {
  box,
  center,
  createGroup,
  frameGrip,
  INVOICES,
  launchDesk,
  openTabs,
  railSpace,
  rowSelector,
  screenshots,
  selectSpace,
  settled,
  snapshot,
  VENDOR,
  windowSelector,
  type Box,
} from "./desk-harness";

const capture = screenshots("desk-dock-drop");

/** A favorite's address: its page is the favorite's (BrowserTabInfo.anchorId) while it is Home's. */
const FAVORITE = "pistachio://demo/invoices?page=ledger";

/** Carry a window by its drawer to `to`, a step at a time, and stop there a moment (no throw). The button stays down. */
async function carry(app: ElectronApplication, shell: Page, tabId: string, to: { x: number; y: number }): Promise<void> {
  const { at } = await frameGrip(app, shell, tabId);
  await shell.mouse.move(at.x, at.y);
  await shell.mouse.down();
  await shell.mouse.move(at.x - 6, at.y + 4, { steps: 2 });
  await moveTo(shell, at, to);
}

const sidebarCommand = (shell: Page, command: SidebarCommand): Promise<unknown> =>
  shell.evaluate((body) => (window as unknown as { pistachio: PistachioApi }).pistachio.sidebarCommand(body), command);

/** The foot of the lowest space's tile on the rail (viewport px): the rail's ground lies below it. */
async function lowestTileBottom(shell: Page): Promise<number> {
  const feet = await shell.locator('[data-testid="rail-space"]').evaluateAll((tiles) => tiles.map((tile) => tile.getBoundingClientRect().bottom));
  expect(feet.length).toBeGreaterThan(0);
  return Math.max(...feet);
}

async function moveTo(shell: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  for (let step = 1; step <= 14; step += 1) {
    await shell.mouse.move(from.x + ((to.x - from.x) * step) / 14, from.y + ((to.y - from.y) * step) / 14);
    await shell.waitForTimeout(16);
  }
  await shell.waitForTimeout(260);
}

test.describe.serial("a desk window carried over the sidebar's column", { tag: ["@desk", "@sidebar"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  const urls = [INVOICES, VENDOR, "pistachio://demo/invoices?page=north", "pistachio://demo/invoices?page=south", "pistachio://demo/invoices?page=east"];
  let ids: string[];
  let stage: Box;

  test.beforeAll(async () => {
    ({ app, shell } = await launchDesk({
      name: "dock-drop",
      files: { "sidebar.json": { version: 1, spaces: { work: { favorites: [{ id: "fav-dd", url: FAVORITE, title: "Ledger", faviconUrl: null }], entries: [] } } } },
    }));
    ids = await openTabs(shell, urls);
    await createGroup(shell, "dd-research", ids.slice(0, 3), "Research", "blue");
    await createGroup(shell, "dd-other", ids.slice(3), "Other", "green");
    await expect(railSpace(shell, "dd-other")).toHaveCount(1);
    await selectSpace(shell, "dd-research", ids[0]!);
    await settled(shell, app);
    stage = await box(shell, ".desk-stage");
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("over the card it is one of its rows, the window again over the desk; let go there it collapses into its row", async () => {
    // A second window out: its row, clicked.
    await shell.locator(rowSelector(ids[1]!)).click();
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await settled(shell, app);
    const before = await box(shell, windowSelector(ids[1]!));
    const card = await box(shell, '[data-testid="space-card"]');
    const list = await box(shell, '[data-testid="space-card"] [data-testid="sidebar-tab-list"]');
    const overCard = { x: card.x + card.width / 2, y: list.y + list.height * 0.6 };
    await carry(app, shell, ids[1]!, overCard);
    const win = shell.locator(windowSelector(ids[1]!));
    await expect(win).toHaveAttribute("data-morph", "row");
    await expect(shell.locator('[data-testid="space-card"][data-dropping]')).toHaveCount(1);
    await expect(shell.locator(".desk-zone[data-on]")).toHaveCount(0);
    // A row of the card's list: its rows' width, a row's height, its middle at the pointer.
    await expect
      .poll(async () => {
        const row = await box(shell, windowSelector(ids[1]!));
        return Math.max(Math.abs(row.x - (list.x + 8)), Math.abs(row.width - (list.width - 16)), Math.abs(row.height - 32), Math.abs(row.y + row.height / 2 - overCard.y));
      })
      .toBeLessThan(2);
    await expect(win.getByTestId("desk-window-face")).toHaveAttribute("data-shown", "");
    await capture(app, shell, "01-row-over-card.png");

    // Back over the desk: the window in hand again, at its own size.
    const overDesk = { x: stage.x + stage.width * 0.5, y: stage.y + stage.height * 0.4 };
    await moveTo(shell, overCard, overDesk);
    await expect(win).not.toHaveAttribute("data-morph", /.*/);
    await expect(shell.locator('[data-testid="space-card"][data-dropping]')).toHaveCount(0);
    await expect.poll(async () => Math.abs((await box(shell, windowSelector(ids[1]!))).width - before.width)).toBeLessThan(40);
    await capture(app, shell, "02-back-over-desk.png");

    // Over the card again, and let go: into its row, its tab kept in the space.
    await moveTo(shell, overDesk, overCard);
    await expect(win).toHaveAttribute("data-morph", "row");
    await shell.mouse.up();
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await settled(shell, app);
    const now = await snapshot(shell);
    expect(now.tabGroups.find((group) => group.id === "dd-research")!.tabIds).toEqual(ids.slice(0, 3));
    expect(now.currentGroupId).toBe("dd-research");
  });

  test("over another space's tile it is that tile; let go there its tab joins that space, and the desk stays", async () => {
    // The window in use (tab 0's), the only one out.
    const tile = center(await box(shell, `[data-testid="rail-space"][data-group-id="dd-other"]`));
    await carry(app, shell, ids[0]!, tile);
    const win = shell.locator(windowSelector(ids[0]!));
    await expect(win).toHaveAttribute("data-morph", "tile");
    await expect(railSpace(shell, "dd-other")).toHaveAttribute("data-dropping", "");
    await expect(win.getByTestId("desk-window-face")).toHaveAttribute("data-group-color", "green");
    await expect
      .poll(async () => {
        const shown = await box(shell, windowSelector(ids[0]!));
        return Math.max(Math.abs(shown.width - 38), Math.abs(shown.height - 38), Math.abs(shown.x + 19 - tile.x), Math.abs(shown.y + 19 - tile.y));
      })
      .toBeLessThan(2);
    await capture(app, shell, "03-tile-over-rail.png");
    await shell.mouse.up();
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === "dd-other")!.tabIds.includes(ids[0]!)).toBe(true);
    await expect(railSpace(shell, "dd-other")).not.toHaveAttribute("data-dropping", /.*/);
    await settled(shell, app);
    const now = await snapshot(shell);
    // Another of the space's tabs took over, and the desk is still the space's.
    expect(now.currentGroupId).toBe("dd-research");
    expect(now.activeTabId).not.toBe(ids[0]);
    await expect(shell.locator(windowSelector(ids[0]!))).toHaveCount(0);
    await expect(shell.locator(`.desk-stage[data-group-id="dd-research"]`)).toHaveCount(1);
  });

  test("over New space, and over the rail's ground below the tiles, New space lights; let go on the ground its tab is a space of its own, and the desk stays where it is", async () => {
    const inUse = (await snapshot(shell)).activeTabId!;
    expect(ids.slice(1, 3)).toContain(inUse);
    await expect(shell.locator(windowSelector(inUse))).toHaveCount(1);
    const plusBox = await box(shell, '[data-testid="rail-new-space"]');
    const plus = center(plusBox);
    await carry(app, shell, inUse, plus);
    await expect(shell.locator(windowSelector(inUse))).toHaveAttribute("data-morph", "tile");
    await expect(shell.getByTestId("rail-new-space")).toHaveAttribute("data-dropping", "");
    await capture(app, shell, "04-tile-over-new-space.png");
    // Up onto the rail's ground, midway between the lowest tile and New space (2026-10-26; until then nothing there took
    // it): a tile still, New space still lit, no tile lit.
    const ground = { x: plus.x, y: (plusBox.y + (await lowestTileBottom(shell))) / 2 };
    expect(plusBox.y - ground.y).toBeGreaterThan(30);
    await moveTo(shell, plus, ground);
    await expect(shell.locator(windowSelector(inUse))).toHaveAttribute("data-morph", "tile");
    await expect(shell.getByTestId("rail-new-space")).toHaveAttribute("data-dropping", "");
    await expect(shell.locator('[data-testid="rail-space"][data-dropping]')).toHaveCount(0);
    await capture(app, shell, "04b-tile-over-rail-ground.png");
    await shell.mouse.up();
    await expect.poll(async () => (await snapshot(shell)).tabGroups.some((group) => group.tabIds.length === 1 && group.tabIds[0] === inUse)).toBe(true);
    await settled(shell, app);
    const now = await snapshot(shell);
    expect(now.currentGroupId).toBe("dd-research");
    expect(now.tabGroups.find((group) => group.id === "dd-research")!.tabIds).not.toContain(inUse);
  });

  test("let go on Home, its tab is a Home tab; its space's last, the desk goes with it", async () => {
    const last = (await snapshot(shell)).tabGroups.find((group) => group.id === "dd-research")!.tabIds;
    expect(last).toHaveLength(1);
    const tabId = last[0]!;
    await expect(shell.locator(windowSelector(tabId))).toHaveCount(1);
    const home = center(await box(shell, '[data-testid="rail-home"]'));
    await carry(app, shell, tabId, home);
    await expect(shell.locator(windowSelector(tabId))).toHaveAttribute("data-morph", "tile");
    await expect(shell.getByTestId("rail-home")).toHaveAttribute("data-dropping", "");
    await shell.mouse.up();
    await expect.poll(async () => ((await snapshot(shell)).looseGroups ?? []).some((group) => group.tabIds.includes(tabId))).toBe(true);
    // The tab in use is in its own space now: the desk passed to it, and its window is out there, in use.
    await expect.poll(async () => (await snapshot(shell)).currentGroupId).not.toBe("dd-research");
    await settled(shell, app);
    await expect(shell.locator(`${windowSelector(tabId)}[data-focused]`)).toHaveCount(1);
    await expect(shell.locator(`${windowSelector(tabId)}[data-morph]`)).toHaveCount(0);
    await capture(app, shell, "05-home-tab.png");
  });

  test("a favorite's page let go on a space's tile comes down into that space, still the favorite's", async () => {
    // Its page, chosen: Home's, a desk of its own (its page's space), its window the desk.
    await sidebarCommand(shell, { type: "open", anchorId: "fav-dd" });
    await expect.poll(async () => (await snapshot(shell)).tabs.find((tab) => tab.anchorId === "fav-dd")?.id ?? null).not.toBeNull();
    const page = (await snapshot(shell)).tabs.find((tab) => tab.anchorId === "fav-dd")!.id;
    await expect(shell.locator(windowSelector(page))).toHaveCount(1);
    await settled(shell, app);
    const tile = center(await box(shell, `[data-testid="rail-space"][data-group-id="dd-other"]`));
    await carry(app, shell, page, tile);
    await expect(shell.locator(windowSelector(page))).toHaveAttribute("data-morph", "tile");
    await expect(railSpace(shell, "dd-other")).toHaveAttribute("data-dropping", "");
    await shell.mouse.up();
    // Brought down into the space (main's bringDown, not addTab: an entry's page is no day tab), the favorite open on it.
    await expect
      .poll(async () => {
        const now = await snapshot(shell);
        const linked = now.tabs.find((tab) => tab.linkedAnchorId === "fav-dd");
        return linked !== undefined && now.tabGroups.find((group) => group.id === "dd-other")!.tabIds.includes(linked.id);
      })
      .toBe(true);
    expect((await snapshot(shell)).sidebar.favorites.map((favorite) => favorite.id)).toEqual(["fav-dd"]);
    await settled(shell, app);
  });
});
