/**
 * The double sidebar end to end (docs/double-sidebar.md): the RAIL at the
 * window's edge — Home and every space with more than one window: a drawn
 * one, an empty one's ring, a favorite's page with a tab beside it — and
 * beside it the CARD with the chosen one in detail: Home's favorites,
 * Pinned and Today (the day's loose rows alone), or a space's view (its
 * name, count, layouts, rows and Context), the desk passing to it as it is
 * chosen. A Today row's + grows its tab into a space: up onto the rail, the
 * card turned to it, its desk two windows side by side; one of them closed,
 * it goes back to Home. The space view's layouts lay its windows out, the
 * ghosts drawn on the desk first, ⌃Z putting them back; the rail takes rows
 * let go on it; and ⌘S cycles the three ways to stand, the traffic lights
 * going with the card.
 *
 * What only the real app has is proved here: the shell's DOM against main's
 * groups, the desk's windows, main's window buttons. The rules — which spaces
 * stand on the rail, which view the card shows, where a drop lands, the
 * card's outline, the layouts' geometry — are double-sidebar.test and
 * desk-layouts.test's.
 */

import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { SIDEBAR_CARD_INSET, SIDEBAR_DEFAULT_W, SIDEBAR_EDGE_W, SIDEBAR_RAIL_W } from "@pistachio/shell-contracts/chrome";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import type { SidebarCommand } from "@pistachio/shell-contracts/sidebar";
import { settled as chromeSettled } from "./chrome-harness";
import {
  box,
  buttonsNow,
  center,
  chooseHome,
  chooseSpace,
  createGroup,
  groupSelector,
  homeView,
  INVOICES,
  launchDesk,
  layoutOption,
  openTabs,
  pointerAt,
  railHome,
  railSpace,
  recordButtons,
  rowSelector,
  screenshots,
  selectSpace,
  selectTab,
  settled,
  showFrame,
  snapshot,
  spaceRows,
  spaceView,
  tabGroupCommand,
  VENDOR,
  windowSelector,
  type Box,
} from "./desk-harness";

const capture = screenshots("double-sidebar");

const MAIL = "pistachio://demo/auth/relying-party?favorite=mail";
const NORTH = "pistachio://demo/invoices?page=north";
const SOUTH = "pistachio://demo/invoices?page=south";
const EAST = "pistachio://demo/invoices?page=east";
const WEST = "pistachio://demo/invoices?page=west";
const LATE = "pistachio://demo/invoices?page=late";

/** The whole column on the desktop: the rail, the card at the sidebar's width, and the gap to the desk. */
const WHOLE_W = SIDEBAR_RAIL_W + SIDEBAR_DEFAULT_W + SIDEBAR_CARD_INSET;
const SLOT = '[data-testid="sidebar-motion-slot"]';

const sidebarCommand = (shell: Page, command: SidebarCommand): Promise<unknown> =>
  shell.evaluate((body) => (window as unknown as { pistachio: PistachioApi }).pistachio.sidebarCommand(body), command);

/** The rail's spaces, top to bottom, by their ids. */
const railOrder = (shell: Page): Promise<string[]> =>
  shell.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="rail-space"]')].map((tile) => tile.dataset["groupId"] ?? ""));

/** Today's rows (the day's loose tabs, in Home's card), by their tabs. */
const todayRows = (shell: Page): Locator => shell.locator('#sidebar-section-live [role="tab"]');

/** Two boxes the same, within a couple of pixels. */
const near = (a: Box, b: Box, within = 2): boolean => (["x", "y", "width", "height"] as const).every((key) => Math.abs(a[key] - b[key]) < within);

/**
 * A row or tile carried onto a rail item — a space's tile, Home, New space — and held there until the item says it
 * takes it (`data-dropping`), then let go. Never right past the column's edge: there the native drag layer would take
 * it, relaying the machine's real pointer.
 */
async function carryOnto(shell: Page, from: Locator, onto: Locator): Promise<void> {
  await chromeSettled(shell.getByTestId("sidebar-tab-list"));
  const start = center((await from.boundingBox())!);
  const end = center((await onto.boundingBox())!);
  await shell.mouse.move(start.x, start.y);
  await shell.mouse.down();
  await shell.mouse.move(start.x, start.y + 8, { steps: 2 });
  for (let step = 1; step <= 14; step += 1) {
    await shell.mouse.move(start.x + ((end.x - start.x) * step) / 14, start.y + 8 + ((end.y - start.y - 8) * step) / 14);
    await shell.waitForTimeout(16);
  }
  await expect(onto).toHaveAttribute("data-dropping", "");
  await shell.mouse.up();
}

test.describe.serial("the rail and the card", { tag: ["@sidebar", "@desk"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let invoices: string, south: string, east: string, west: string;
  /** The favorite's page and the tab opened beside it: a space of the rail's. */
  let mailSpace: string;
  let mailPage: string;
  let stage: Box;
  /** Off the column and the Bar's nub: where the pointer rests between gestures. */
  const awayFromColumn = (): Promise<void> => shell.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height * 0.6);

  test.beforeAll(async () => {
    ({ app, shell } = await launchDesk({
      name: "double-sidebar",
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
    [invoices, south, east, west] = (await openTabs(shell, [INVOICES, SOUTH, EAST, WEST])) as [string, string, string, string];
    // A drawn space of two, and an empty one of the person's.
    await createGroup(shell, "ds-research", [south, east], "Research", "blue");
    await tabGroupCommand(shell, { type: "create", id: "ds-errands", tabIds: [], title: "Errands", color: "green" });
    // A favorite's page with a tab opened beside it.
    await sidebarCommand(shell, { type: "open", anchorId: "fav-mail" });
    await expect.poll(async () => (await snapshot(shell)).anchorGroups?.find((group) => group.anchorId === "fav-mail")?.tabIds.length ?? 0).toBe(1);
    const page = (await snapshot(shell)).anchorGroups!.find((group) => group.anchorId === "fav-mail")!;
    mailSpace = page.id;
    mailPage = page.tabIds[0]!;
    await tabGroupCommand(shell, { type: "newTab", groupId: mailSpace });
    await expect.poll(async () => (await snapshot(shell)).anchorGroups?.find((group) => group.id === mailSpace)?.tabIds.length ?? 0).toBe(2);
    // Back to the day's first tab: Home.
    await selectTab(shell, invoices);
    await expect(shell.locator('[data-testid="sidebar-chrome"][data-view="home"]')).toHaveCount(1);
    await settled(shell, app);
    stage = await box(shell, ".desk-stage");
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("the rail holds Home and every space of more than one window; Home's card is the favorites, Pinned and Today, the day's loose rows alone", async () => {
    // ── 1. The rail: Home, chosen; the drawn space, the empty space's ring, then the favorite's page with company ─
    await expect(railHome(shell)).toHaveAttribute("aria-current", "true");
    await expect.poll(() => railOrder(shell)).toEqual(["ds-research", "ds-errands", mailSpace]);
    await expect(railSpace(shell, "ds-research")).toHaveAttribute("aria-label", "Research, 2 windows");
    await expect(railSpace(shell, "ds-research")).toHaveAttribute("data-group-color", "blue");
    await expect(railSpace(shell, "ds-research").getByTestId("favicon-cluster")).toHaveCount(1);
    await expect(railSpace(shell, "ds-errands")).toHaveAttribute("aria-label", "Errands, No windows");
    await expect(railSpace(shell, "ds-errands").getByTestId("space-empty-mark")).toHaveCount(1);
    await expect(railSpace(shell, mailSpace)).toHaveAttribute("data-page", "");
    await expect(railSpace(shell, mailSpace)).toHaveAttribute("aria-label", /, 2 windows$/);
    // A loose tab is Home's, not the rail's.
    for (const tabId of [invoices, west]) {
      const loose = (await snapshot(shell)).looseGroups?.find((group) => group.tabIds.includes(tabId));
      expect(loose).toBeDefined();
      await expect(railSpace(shell, loose!.id)).toHaveCount(0);
    }

    // ── 2. Home's card: the favorites four to a row (Mail's counting the tab beside its page), Pinned, Today ─
    const home = homeView(shell);
    await expect(home).toHaveCount(1);
    await expect(home.getByTestId("favorites-grid")).toHaveAttribute("data-columns", "4");
    await expect(home.getByTestId("favorite-tile")).toHaveCount(2);
    await expect(home.locator('[data-testid="favorite-tile"][data-flip-id="fav-mail"] [data-testid="favorite-tab-count"]')).toHaveText("1");
    await expect(home.locator('[data-testid="pinned-tab"][data-flip-id="pin-north"]')).toHaveCount(1);
    await expect(home.getByTestId("section-header-live")).toContainText("Today");
    // Today: the day's loose rows, the one in use raised — none of a space's, none of a page's.
    await expect(todayRows(shell)).toHaveCount(2);
    for (const tabId of [invoices, west]) await expect(shell.locator(rowSelector(tabId))).toHaveCount(1);
    for (const tabId of [south, east, mailPage]) await expect(shell.locator(rowSelector(tabId))).toHaveCount(0);
    await expect(shell.locator(rowSelector(invoices))).toHaveAttribute("aria-selected", "true");
    await awayFromColumn();
    await capture(app, shell, "01-home.png");
  });

  test("a tile chosen is its space in the card — name, count, layouts, rows, Context — and the desk passes to it", async () => {
    // ── 1. The drawn space: its view, the desk its own ─
    await chooseSpace(shell, "ds-research");
    await expect(railHome(shell)).not.toHaveAttribute("aria-current", "true");
    const view = spaceView(shell, "ds-research");
    await expect(view.getByTestId("space-name")).toHaveText("Research");
    await expect(view.getByLabel("2 windows")).toHaveCount(1);
    await expect(spaceRows(shell)).toHaveCount(2);
    await expect(view.getByTestId("layout-control")).toBeVisible();
    await expect(view.getByTestId("desk-stack")).toHaveCount(1);
    await expect(shell.locator('.desk-stage[data-group-id="ds-research"]')).toHaveAttribute("data-group-color", "blue");
    // Home's rows are not drawn while a space shows.
    await expect(shell.locator(rowSelector(west))).toHaveCount(0);
    await awayFromColumn();
    await capture(app, shell, "02-space.png");

    // ── 2. The empty space: says so, nothing to lay out, the desk its empty mark ─
    await chooseSpace(shell, "ds-errands");
    await expect(spaceView(shell, "ds-errands").getByTestId("space-empty-line")).toBeVisible();
    await expect(spaceView(shell, "ds-errands").getByTestId("layout-control")).toHaveCount(0);
    await expect(shell.getByTestId("desk-empty")).toBeVisible();

    // ── 3. The favorite's page with company: named after its page, its page's row first ─
    await chooseSpace(shell, mailSpace);
    await expect(spaceView(shell, mailSpace).getByTestId("space-name")).toHaveAttribute("data-page", "");
    await expect(spaceRows(shell)).toHaveCount(2);
    await expect(spaceRows(shell).first()).toHaveAttribute("data-tab-id", mailPage);

    // ── 4. Home again: the Home tab used last, the card Home's ─
    await chooseHome(shell);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(invoices);
    await expect(shell.locator('[data-testid="sidebar-chrome"][data-view="home"]')).toHaveCount(1);
  });

  test("a Today row's + grows its tab into a space: up on the rail, the card turned to it, its desk two windows side by side; one closed, it goes back to Home", async () => {
    test.setTimeout(60_000);
    const before = new Set((await snapshot(shell)).tabs.map((tab) => tab.id));

    // ── 1. The + on west's row (on hover): a window beside it ─
    await shell.locator(rowSelector(west)).hover();
    await shell.locator(rowSelector(west)).getByTestId("row-beside").click();
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.tabIds.includes(west))?.tabIds.length ?? 0).toBe(2);
    const grown = (await snapshot(shell)).tabGroups.find((group) => group.tabIds.includes(west))!;
    const fresh = grown.tabIds.find((tabId) => !before.has(tabId))!;
    // Made for the person, not theirs: Tidy's to leave whole (grown).
    expect(grown).toMatchObject({ origin: "auto", grown: true });
    expect(grown.loose).toBeUndefined();
    // Its tile on the rail, chosen; the card turns to it.
    await expect(railSpace(shell, grown.id)).toHaveAttribute("aria-current", "true");
    await expect(spaceView(shell, grown.id)).toHaveCount(1);
    await expect(shell.locator('[data-testid="sidebar-chrome"][data-view="space"]')).toHaveCount(1);
    await expect(shell.locator(rowSelector(west))).toHaveCount(1);
    await expect(shell.locator(rowSelector(fresh))).toHaveCount(1);
    // Its desk splits: the page keeps the left half, the new window the right.
    await awayFromColumn();
    await settled(shell, app);
    const half = (stage.width - 8) / 2;
    await expect.poll(async () => near(await box(shell, windowSelector(west)), { x: stage.x, y: stage.y, width: half, height: stage.height })).toBe(true);
    await expect.poll(async () => near(await box(shell, windowSelector(fresh)), { x: stage.x + half + 8, y: stage.y, width: half, height: stage.height })).toBe(true);
    await capture(app, shell, "03-grown.png");

    // ── 2. The new window closed (its frame's ×): one window left, the space goes back to Home as that tab ─
    await showFrame(shell, windowSelector(fresh));
    await shell.locator(windowSelector(fresh)).getByTestId("desk-close").click();
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.id === fresh)).toBe(false);
    await expect.poll(async () => (await snapshot(shell)).tabGroups.some((group) => group.tabIds.includes(west))).toBe(false);
    expect((await snapshot(shell)).looseGroups?.some((group) => group.tabIds.length === 1 && group.tabIds[0] === west)).toBe(true);
    await expect(railSpace(shell, grown.id)).toHaveCount(0);
    await expect(shell.locator('[data-testid="sidebar-chrome"][data-view="home"]')).toHaveCount(1);
    await expect(todayRows(shell).and(shell.locator(`[data-tab-id="${west}"]`))).toHaveCount(1);
    await awayFromColumn();
    await settled(shell, app);
    await capture(app, shell, "04-back-home.png");
  });

  test("the space view's layouts: the window count's options, ghosts on the desk for the one looked at, a click lays the windows out, the thumb follows, ⌃Z puts them back", async () => {
    test.setTimeout(60_000);
    await chooseSpace(shell, "ds-research");
    for (const tabId of [south, east]) {
      if ((await shell.locator(windowSelector(tabId)).count()) === 0) await shell.locator(rowSelector(tabId)).click();
      await expect(shell.locator(windowSelector(tabId))).toHaveCount(1);
    }
    await awayFromColumn();
    await settled(shell, app);
    // Cascaded first, from the track itself: a known start that is none of the others.
    await layoutOption(shell, "cascade").click();
    await awayFromColumn();
    await settled(shell, app);
    await expect(layoutOption(shell, "cascade")).toHaveAttribute("aria-pressed", "true");
    const cascaded = { [south]: await box(shell, windowSelector(south)), [east]: await box(shell, windowSelector(east)) };

    // ── 1. Two windows: Side by side, Stacked, Main and side, Cascade, then apart, Arrange for me ─
    const kinds = await shell.locator('[data-testid="layout-option"]').evaluateAll((options) => options.map((option) => option.getAttribute("data-kind")));
    expect(kinds).toEqual(["halves", "stack", "focus", "cascade"]);
    await expect(layoutOption(shell, "smart")).toBeVisible();
    await expect(shell.getByTestId("layout-caption")).toContainText("Cascade");

    // ── 2. Resting on Side by side: its ghosts on the desk, a window's mark in each, the caption names it ─
    await layoutOption(shell, "halves").hover();
    await expect(shell.getByTestId("layout-caption")).toContainText("Side by side");
    await expect(shell.locator('[data-testid="desk-layout-ghosts"][data-kind="halves"]')).toHaveCount(1);
    await expect(shell.getByTestId("desk-layout-ghost")).toHaveCount(2);
    await expect(shell.locator(".desk-stage[data-layout-preview]")).toHaveCount(1);
    const half = (stage.width - 8) / 2;
    const leftHalf = { x: stage.x, y: stage.y, width: half, height: stage.height };
    const rightHalf = { x: stage.x + half + 8, y: stage.y, width: half, height: stage.height };
    /** Two windows' (or ghosts') boxes, left to right. */
    const pair = async (of: (tabId: string) => string): Promise<Box[]> => [await box(shell, of(south)), await box(shell, of(east))].sort((a, b) => a.x - b.x);
    const ghostOf = (tabId: string): string => `[data-testid="desk-layout-ghost"][data-id="${tabId}"]`;
    // (They glide to their places: at rest, the two halves.)
    await expect.poll(async () => { const [a, b] = await pair(ghostOf); return near(a!, leftHalf) && near(b!, rightHalf); }).toBe(true);
    // Nothing moved yet.
    for (const tabId of [south, east]) expect(near(await box(shell, windowSelector(tabId)), cascaded[tabId]!)).toBe(true);
    await capture(app, shell, "05-layout-ghosts.png");
    // Off the track: the ghosts go.
    await awayFromColumn();
    await expect(shell.getByTestId("desk-layout-ghosts")).toHaveCount(0);

    // ── 3. A click lays them out: the windows in the ghosts' places, the thumb under Side by side ─
    await layoutOption(shell, "halves").click();
    await awayFromColumn();
    await settled(shell, app);
    const laid = await pair(windowSelector);
    expect(near(laid[0]!, leftHalf)).toBe(true);
    expect(near(laid[1]!, rightHalf)).toBe(true);
    await expect(layoutOption(shell, "halves")).toHaveAttribute("aria-pressed", "true");
    await expect(layoutOption(shell, "cascade")).toHaveAttribute("aria-pressed", "false");
    await expect(shell.getByTestId("layout-caption")).toContainText("Side by side");
    // Stacked: the thumb follows.
    await layoutOption(shell, "stack").click();
    await awayFromColumn();
    await settled(shell, app);
    await expect(layoutOption(shell, "stack")).toHaveAttribute("aria-pressed", "true");
    await expect(layoutOption(shell, "halves")).toHaveAttribute("aria-pressed", "false");
    const rows = [await box(shell, windowSelector(south)), await box(shell, windowSelector(east))].sort((a, b) => a.y - b.y);
    expect(Math.abs(rows[0]!.width - stage.width)).toBeLessThan(2);
    expect(Math.abs(rows[1]!.y - (rows[0]!.y + rows[0]!.height + 8))).toBeLessThan(2);
    await capture(app, shell, "06-layout-stacked.png");

    // ── 4. ⌃Z, struck in the shell within its moment: the windows back where Stacked found them (side by side) ─
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      contents.focus();
      contents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["control"] });
      contents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["control"] });
    });
    await settled(shell, app);
    await expect.poll(async () => { const [a, b] = await pair(windowSelector); return near(a!, leftHalf) && near(b!, rightHalf); }).toBe(true);
    await expect(layoutOption(shell, "halves")).toHaveAttribute("aria-pressed", "true");
  });

  test("the rail takes rows: a Today row let go on a space's tile joins it, at its end; a space's row let go on Home leaves it", async () => {
    test.setTimeout(60_000);
    // A loose tab to carry, opened in the background.
    const [late] = (await openTabs(shell, [LATE])) as [string];
    await chooseHome(shell);
    await expect(shell.locator(rowSelector(late))).toHaveCount(1);

    // ── 1. Onto Research's tile: the tile says it takes it, and the tab joins at the end ─
    await carryOnto(shell, shell.locator(rowSelector(late)), railSpace(shell, "ds-research"));
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === "ds-research")?.tabIds).toEqual([south, east, late]);
    await expect(shell.locator(rowSelector(late))).toHaveCount(0);
    await expect(railSpace(shell, "ds-research")).toHaveAttribute("aria-label", "Research, 3 windows");

    // ── 2. Its row, in Research's view, onto Home: a Home tab again, a loose one of its own ─
    await chooseSpace(shell, "ds-research");
    await carryOnto(shell, shell.locator(rowSelector(late)), railHome(shell));
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === "ds-research")?.tabIds).toEqual([south, east]);
    expect((await snapshot(shell)).looseGroups?.some((group) => group.tabIds.length === 1 && group.tabIds[0] === late)).toBe(true);
    await expect(railSpace(shell, "ds-research")).toHaveAttribute("aria-label", "Research, 2 windows");
  });
});

test.describe.serial("the three ways to stand", { tag: ["@sidebar", "@desk"] }, () => {
  let app: ElectronApplication;
  let shell: Page;

  /** Off the column: the middle of the desk, for the OS's pointer and the shell's. */
  const onDesk = async (): Promise<void> => {
    const desk = await box(shell, ".desk-stage");
    await pointerAt(app, desk.x + desk.width * 0.6, desk.y + desk.height * 0.4);
    await shell.mouse.move(desk.x + desk.width * 0.6, desk.y + desk.height * 0.4);
  };

  test.beforeAll(async () => {
    ({ app, shell } = await launchDesk({ name: "double-sidebar-modes", env: { PISTACHIO_E2E_CURSOR: "1" } }));
    await pointerAt(app, 900, 300);
    const [south, east] = (await openTabs(shell, [SOUTH, EAST])) as [string, string];
    await createGroup(shell, "ds-modes", [south, east], "Modes", "purple");
    await selectSpace(shell, "ds-modes");
    await settled(shell, app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("⌘S: whole (the rail and the card) → the rail alone (the chosen tile on its backing) → hidden (both out together over the desk) → whole; the slot's width and the traffic lights with each", async () => {
    test.setTimeout(90_000);
    const slot = shell.locator(SLOT);
    const pane = shell.getByTestId("sidebar-pane");
    const tile = railSpace(shell, "ds-modes");
    await onDesk();
    await recordButtons(app);

    // ── 1. Whole: the rail and the card, the desk beside them; the traffic lights over the card's shoulder ─
    await expect(slot).toHaveAttribute("data-mode", "whole");
    await expect.poll(async () => Math.round((await box(shell, SLOT)).width)).toBe(WHOLE_W);
    await expect(shell.getByTestId("space-rail")).toBeVisible();
    await expect(shell.getByTestId("space-card")).toBeVisible();
    await expect.poll(async () => Math.round((await box(shell, '[data-testid="space-card"]')).width)).toBe(SIDEBAR_DEFAULT_W);
    await expect(tile).toHaveAttribute("aria-current", "true");
    await expect.poll(() => buttonsNow(app)).toBe(true);
    await settled(shell, app);
    expect(Math.abs((await box(shell, ".desk-stage")).x - WHOLE_W)).toBeLessThan(2);
    await capture(app, shell, "10-whole.png");

    // ── 2. ⌘S: the rail alone — no card; its head the card's button and the desk's ⋯; the chosen tile on a backing of
    //       the card's colour (the column's sheet, cut to the rail round it). The traffic lights hidden ─
    await shell.keyboard.press("Meta+s");
    await expect(slot).toHaveAttribute("data-mode", "rail");
    await expect.poll(async () => Math.round((await box(shell, SLOT)).width)).toBe(SIDEBAR_RAIL_W);
    await expect(shell.getByTestId("space-card")).toHaveCount(0);
    await expect(shell.locator('[data-testid="space-rail"][data-rail-only]')).toHaveCount(1);
    await expect(shell.locator('[data-testid="space-rail"] [data-testid="desk-rail-toggle"]')).toBeVisible();
    await expect(shell.locator('[data-testid="space-rail"] [data-testid="desk-more"]')).toBeVisible();
    await expect(tile).toHaveAttribute("aria-current", "true");
    await expect.poll(() => buttonsNow(app)).toBe(false);
    // (The backing: the sheet's outline round the chosen tile, within the rail, a margin about it.)
    await expect
      .poll(() =>
        shell.evaluate(
          ({ tileSelector, railW }) => {
            const path = document.querySelector<SVGGraphicsElement>(".space-column-sheet");
            const tile = document.querySelector(tileSelector)?.getBoundingClientRect();
            const svg = path?.ownerSVGElement?.getBoundingClientRect();
            if (path == null || tile === undefined || svg === undefined) return false;
            const shape = path.getBBox();
            const [left, top] = [svg.left + shape.x, svg.top + shape.y];
            return shape.width > 0 && left + shape.width <= svg.left + railW + 0.5 && top <= tile.top && top + shape.height >= tile.bottom;
          },
          { tileSelector: groupSelector("ds-modes"), railW: SIDEBAR_RAIL_W },
        ),
      )
      .toBe(true);
    await settled(shell, app);
    expect(Math.abs((await box(shell, ".desk-stage")).x - SIDEBAR_RAIL_W)).toBeLessThan(2);
    await capture(app, shell, "11-rail.png");

    // ── 3. ⌘S: hidden — the strip at the window's edge, the column away and the traffic lights with it; the pointer at
    //       the edge brings the rail and the card out together over the desk, which stays put ─
    await shell.keyboard.press("Meta+s");
    await expect(slot).toHaveAttribute("data-mode", "hidden");
    await expect.poll(async () => Math.round((await box(shell, SLOT)).width)).toBe(SIDEBAR_EDGE_W);
    await expect(pane).toHaveAttribute("data-hidden", "");
    await expect.poll(() => buttonsNow(app)).toBe(false);
    await settled(shell, app);
    const deskHidden = await box(shell, ".desk-stage");
    await pointerAt(app, 2, 420);
    await shell.mouse.move(2, 420);
    await shell.mouse.move(3, 426);
    await expect(pane).not.toHaveAttribute("data-hidden", "");
    await expect(slot).toHaveAttribute("data-overlay", "");
    await expect(shell.getByTestId("space-rail")).toBeVisible();
    await expect(shell.getByTestId("space-card")).toBeVisible();
    await expect(spaceView(shell, "ds-modes")).toHaveCount(1);
    await expect.poll(() => buttonsNow(app)).toBe(true);
    expect(Math.round((await box(shell, SLOT)).width)).toBe(SIDEBAR_EDGE_W);
    expect(near(await box(shell, ".desk-stage"), deskHidden, 1)).toBe(true);
    // (Held out by the pointer on it, the OS's too, once its slide has landed.)
    await expect.poll(async () => Math.round((await pane.boundingBox())?.x ?? -1)).toBe(0);
    await pointerAt(app, 120, 430);
    await shell.mouse.move(120, 430);
    await capture(app, shell, "12-hidden-out.png");

    // ── 4. ⌘S: whole again ─
    await shell.keyboard.press("Meta+s");
    await expect(slot).toHaveAttribute("data-mode", "whole");
    await expect.poll(async () => Math.round((await box(shell, SLOT)).width)).toBe(WHOLE_W);
    await expect(shell.getByTestId("space-card")).toBeVisible();
    await expect(shell.getByTestId("sidebar-edge")).toHaveCount(0);
    await onDesk();
    await expect.poll(() => buttonsNow(app)).toBe(true);
    await settled(shell, app);
    expect(Math.abs((await box(shell, ".desk-stage")).x - WHOLE_W)).toBeLessThan(2);
  });
});
