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
 * let go on it — and (2026-10-14) favorites and pins, New space making a
 * space of one, drawn over the rail as a space's tile meanwhile; a favorite
 * brought into a space goes there when chosen, never back to Home; a tile
 * carried onto another merges the two, between two it moves —; and ⌘S
 * cycles the three ways to stand, the traffic lights going with the card.
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
import { MAX_TAB_GROUPS_PER_SPACE } from "@pistachio/shell-contracts/tab-groups";
import { settled as chromeSettled } from "./chrome-harness";
import {
  box,
  buttonsNow,
  center,
  chooseHome,
  chooseSpace,
  createGroup,
  dropFileOnDesk,
  groupSelector,
  homeView,
  INVOICES,
  launchDesk,
  layoutOption,
  openMore,
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

    // ── 2. Home's card: the favorites three to a row (Mail's counting the tab beside its page), Pinned, Today ─
    const home = homeView(shell);
    await expect(home).toHaveCount(1);
    const [grid, tile] = await Promise.all([box(shell, '[data-testid="home-view"] [data-testid="favorites-grid"]'), box(shell, '[data-testid="home-view"] [data-testid="favorite-tile"]')]);
    expect(Math.round(grid.width / tile.width)).toBe(3);
    // The address as far under the sheet's edge left of the shoulder (SpaceColumn's SHOULDER_Y, y 36) as over the favorites.
    const address = await box(shell, '[data-testid="space-card"] [data-testid="sidebar-address"]');
    expect(Math.round(address.y - 36)).toBe(Math.round(grid.y - (address.y + address.height)));
    await expect(home.getByTestId("favorite-tile")).toHaveCount(2);
    await expect(home.locator('[data-testid="favorite-tile"][data-flip-id="fav-mail"] [data-testid="favorite-tab-count"]')).toHaveText("1");
    await expect(home.locator('[data-testid="pinned-tab"][data-flip-id="pin-north"]')).toHaveCount(1);
    await expect(home.getByTestId("section-header-live")).toContainText("Today");
    // Today: the day's loose rows, the one in use raised — none of a space's, none of a page's.
    await expect(todayRows(shell)).toHaveCount(2);
    for (const tabId of [invoices, west]) await expect(shell.locator(rowSelector(tabId))).toHaveCount(1);
    for (const tabId of [south, east, mailPage]) await expect(shell.locator(rowSelector(tabId))).toHaveCount(0);
    await expect(shell.locator(rowSelector(invoices))).toHaveAttribute("aria-selected", "true");
    // No Stack under the tab in use: Home's rows stay where they are as the tab changes.
    await expect(home.getByTestId("desk-stack")).toHaveCount(0);
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
    // (One of its two windows out on its desk, the other put away in its row: nothing to lay out, so no layouts — the
    // space view's layouts with windows out to lay out are a test of their own, below.)
    await settled(shell, app);
    await expect(shell.locator('.desk-stage[data-group-id="ds-research"] [data-testid="desk-window"]')).toHaveCount(1);
    await expect(view.getByTestId("layout-control")).toHaveCount(0);
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

    // ── 5. Down the rail by its keys, as Slack's: ⌘1 Home, ⌘2 on the spaces top to bottom (a page's space too) ─
    await shell.keyboard.press("Meta+3");
    await expect(railSpace(shell, "ds-errands")).toHaveAttribute("aria-current", "true");
    await shell.keyboard.press("Meta+4");
    await expect(railSpace(shell, mailSpace)).toHaveAttribute("aria-current", "true");
    await shell.keyboard.press("Meta+2");
    await expect(railSpace(shell, "ds-research")).toHaveAttribute("aria-current", "true");
    await expect(spaceView(shell, "ds-research")).toHaveCount(1);
    await settled(shell, app);
    // A page holding the keyboard: main hands the key on to the shell.
    await expect
      .poll(() =>
        app.evaluate(({ webContents }, address) => {
          const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === address);
          if (contents === undefined || contents.isLoading()) return false;
          contents.sendInputEvent({ type: "keyDown", keyCode: "1", modifiers: ["meta"] });
          contents.sendInputEvent({ type: "keyUp", keyCode: "1", modifiers: ["meta"] });
          return true;
        }, SOUTH),
      )
      .toBe(true);
    await expect(railHome(shell)).toHaveAttribute("aria-current", "true");
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(invoices);
    await settled(shell, app);
    // Past the last space: nothing.
    await shell.keyboard.press("Meta+5");
    await expect(railHome(shell)).toHaveAttribute("aria-current", "true");
  });

  test("the ⋯ card: a space's own controls, as its tile's menu has them — none in Home — then the arrangements, and Feel folded away", async () => {
    const card = shell.getByTestId("desk-more-card");
    const errandsColor = async (): Promise<string | undefined> => (await snapshot(shell)).tabGroups.find((group) => group.id === "ds-errands")?.color;

    // ── 1. Home: none of a space's controls; Feel folded away under its heading until opened ─
    await chooseHome(shell);
    await openMore(shell);
    await expect(card.getByTestId("desk-more-space")).toHaveCount(0);
    await expect(card.getByTestId("desk-tile")).toBeVisible();
    const feel = card.getByTestId("desk-feel-toggle");
    await expect(feel).toHaveAttribute("aria-expanded", "false");
    await expect(card.getByTestId("desk-variant-physics")).toHaveCount(0);
    await feel.click();
    await expect(feel).toHaveAttribute("aria-expanded", "true");
    await expect(card.getByTestId("desk-variant-physics")).toBeVisible();
    await feel.click();
    await expect(card.getByTestId("desk-variant-physics")).toHaveCount(0);
    await awayFromColumn();
    await expect(card).toHaveCount(0);

    // ── 2. A space: its tile's menu on the card, above the arrangements ─
    await chooseSpace(shell, "ds-errands");
    await openMore(shell);
    const space = card.getByTestId("desk-more-space");
    for (const name of ["Rename", "New tab in space", "Share live…", "Release the tabs", "Close space"]) await expect(space.getByRole("button", { name })).toHaveCount(1);
    await expect(space.getByRole("button", { name: "Release the tabs" })).toBeDisabled();
    await expect(space.getByTestId("group-color-green")).toHaveAttribute("aria-checked", "true");
    await capture(app, shell, "04b-more-space.png");
    // A colour: the space's at once, the card left up, its ring on the colour now.
    await space.getByTestId("group-color-purple").click();
    await expect.poll(errandsColor).toBe("purple");
    await expect(space.getByTestId("group-color-purple")).toHaveAttribute("aria-checked", "true");
    await expect(shell.locator('[data-testid="desk-more-card"][data-shown]')).toHaveCount(1);
    await space.getByTestId("group-color-green").click();
    await expect.poll(errandsColor).toBe("green");
    // Rename: the card away, the space's name open in the card's head.
    await space.getByRole("button", { name: "Rename" }).click();
    await expect(card).toHaveCount(0);
    const field = spaceView(shell, "ds-errands").locator(".space-name-field input");
    await expect(field).toBeFocused();
    await field.press("Escape");
    await expect(spaceView(shell, "ds-errands").getByTestId("space-name")).toHaveText("Errands");
    await chooseHome(shell);
  });

  test("a space's pages asleep are woken for its card's picture, one at a time, and put back to sleep", async () => {
    await chooseHome(shell);
    await settled(shell, app);
    const research = (await snapshot(shell)).tabGroups.find((group) => group.id === "ds-research")!.tabIds;
    for (const tabId of research) await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.suspendTab(id), tabId);
    const asleep = async (): Promise<number> => (await snapshot(shell)).tabs.filter((tab) => research.includes(tab.id) && tab.lifecycle === "suspended").length;
    await expect.poll(asleep).toBe(research.length);
    // Every page main loads from here on.
    await app.evaluate(({ app: electron }) => {
      const woke: string[] = [];
      (globalThis as unknown as { __woke: string[] }).__woke = woke;
      electron.on("web-contents-created", (_event, contents) => contents.once("did-finish-load", () => woke.push(contents.getURL())));
    });
    const card = shell.locator('[data-testid="rail-space-card"][data-group-id="ds-research"]');
    await railSpace(shell, "ds-research").hover();
    await expect(card).toHaveAttribute("data-shown", "", { timeout: 5_000 });
    // Its page pictured, not its icon — woken for it…
    await expect(card.locator(".rail-space-card-still").first()).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => app.evaluate((_electron, urls) => (globalThis as unknown as { __woke: string[] }).__woke.filter((url) => urls.includes(url)).length, [SOUTH, EAST]))
      .toBeGreaterThan(0);
    // …and asleep again.
    await expect.poll(asleep, { timeout: 15_000 }).toBe(research.length);
    await capture(app, shell, "04d-rail-card-asleep.png");
    await awayFromColumn();
    await expect(card).toHaveCount(0);
  });

  test("a space's tile rested on brings up its card a moment later — its desk drawn small, its name and count — and leaving the tile takes it away", async () => {
    await chooseHome(shell);
    await settled(shell, app);
    const card = shell.locator('[data-testid="rail-space-card"][data-group-id="ds-research"]');
    await railSpace(shell, "ds-research").hover();
    // Not at once: only for the pointer that stays.
    await shell.waitForTimeout(400);
    await expect(card).toHaveCount(0);
    await expect(card).toHaveAttribute("data-shown", "", { timeout: 5_000 });
    await expect(card).toContainText("Research");
    await expect(card).toContainText("2 windows");
    // Its desk as it would come out: the windows left on it, the one it would come up on ringed.
    await expect(card.getByTestId("rail-space-card-window").first()).toBeVisible();
    await expect(card.locator('[data-testid="rail-space-card-window"][data-focused]')).toHaveCount(1);
    await capture(app, shell, "04c-rail-card.png");
    await awayFromColumn();
    await expect(card).toHaveCount(0);
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

    // ── 5. Tab with the pointer resting on a layout: its windows trade places, the ghosts showing it, a click following ─
    // On the layout the desk is in, nothing is drawn until Tab turns the windows; the caption says what Tab does.
    const westOf = async (tabId: string): Promise<number> => (await box(shell, windowSelector(tabId))).x;
    const southLeft = (await westOf(south)) < (await westOf(east));
    await layoutOption(shell, "halves").hover();
    await expect(shell.getByTestId("layout-caption-cycle")).toContainText("swaps them");
    await expect(shell.getByTestId("desk-layout-ghosts")).toHaveCount(0);
    // Struck in a page (main takes it while the pointer rests there: DeskState.cycleKey).
    await app.evaluate(({ webContents }, url) => {
      const page = webContents.getAllWebContents().find((contents) => contents.getURL() === url)!;
      page.focus();
      page.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
      page.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    }, SOUTH);
    await expect(shell.locator('[data-testid="desk-layout-ghosts"][data-kind="halves"]')).toHaveCount(1);
    await expect.poll(async () => near(await box(shell, ghostOf(south)), southLeft ? rightHalf : leftHalf)).toBe(true);
    await expect.poll(async () => near(await box(shell, ghostOf(east)), southLeft ? leftHalf : rightHalf)).toBe(true);
    await layoutOption(shell, "halves").click();
    await awayFromColumn();
    await settled(shell, app);
    await expect.poll(async () => near(await box(shell, windowSelector(south)), southLeft ? rightHalf : leftHalf)).toBe(true);
    await expect(layoutOption(shell, "halves")).toHaveAttribute("aria-pressed", "true");
    // Struck in the shell's own document, on Stacked: its two places trade windows too.
    await layoutOption(shell, "stack").hover();
    await expect(shell.locator('[data-testid="desk-layout-ghosts"][data-kind="stack"]')).toHaveCount(1);
    const topGhost = async (): Promise<string> => ((await box(shell, ghostOf(south))).y < (await box(shell, ghostOf(east))).y ? south : east);
    await expect.poll(async () => Math.abs((await box(shell, ghostOf(south))).y - (await box(shell, ghostOf(east))).y) > 100).toBe(true);
    const onTop = await topGhost();
    await shell.keyboard.press("Tab");
    await expect.poll(topGhost).toBe(onTop === south ? east : south);
    await awayFromColumn();
    await expect(shell.getByTestId("desk-layout-ghosts")).toHaveCount(0);
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

/**
 * A row, a favorite or a pin carried from the card and held over a rail item: it is drawn there as a space's tile (the
 * token, chrome/shelf-drag.tsx), the item lit to take it — then let go. As carryOnto, never right past the column.
 */
async function holdOver(shell: Page, from: Locator, onto: Locator): Promise<void> {
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
  // The token: a tile, up over the rail.
  const face = shell.getByTestId("shelf-rail-token-face");
  await expect(face).toHaveAttribute("data-shown", "");
  await expect(face).toHaveAttribute("data-shape", "tile");
}

/** A space's tile carried along the rail to `to` and held there a beat (its gap opened, or the tile under it lit). */
async function carryTile(shell: Page, tile: Locator, to: { x: number; y: number }): Promise<void> {
  const start = center((await tile.boundingBox())!);
  await shell.mouse.move(start.x, start.y);
  await shell.mouse.down();
  await shell.mouse.move(start.x, start.y + (to.y > start.y ? 8 : -8), { steps: 2 });
  await shell.mouse.move(to.x, to.y, { steps: 10 });
  await expect(tile).toHaveAttribute("data-moving", "");
}

test.describe.serial("the rail takes favorites, pins and spaces", { tag: ["@sidebar", "@desk"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let invoices: string, west: string, late: string;
  /** The space the favorite was let go on New space into, and its page there. */
  let vendorSpace: string;
  let vendorTab: string;

  test.beforeAll(async () => {
    ({ app, shell } = await launchDesk({
      name: "double-sidebar-drops",
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
    let south: string, east: string;
    [invoices, south, east, west, late] = (await openTabs(shell, [INVOICES, SOUTH, EAST, WEST, LATE])) as [string, string, string, string, string];
    await createGroup(shell, "dd-research", [south, east], "Research", "blue");
    await createGroup(shell, "dd-errands", [west], "Errands", "green");
    await selectTab(shell, invoices);
    await expect(shell.locator('[data-testid="sidebar-chrome"][data-view="home"]')).toHaveCount(1);
    await settled(shell, app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("a Today row and a favorite let go on New space each make a space of their own, not chosen — the favorite open there, in its colour; held over the rail each is a space's tile", async () => {
    test.setTimeout(60_000);
    const before = new Set((await snapshot(shell)).tabGroups.map((group) => group.id));
    const fresh = async (): Promise<string[]> => (await snapshot(shell)).tabGroups.filter((group) => !before.has(group.id)).map((group) => group.id);

    // ── 1. The day's row: held over New space it is a tile, New space lit; let go, a space of its own, the desk staying ─
    await holdOver(shell, shell.locator(rowSelector(late)), shell.getByTestId("rail-new-space"));
    // (Its row waits in its slot, dimmed: the token is what is carried.)
    await expect.poll(() => shell.locator(rowSelector(late)).evaluate((row) => Number(getComputedStyle(row).opacity))).toBeLessThan(0.6);
    await capture(app, shell, "20-row-over-new-space.png");
    await shell.mouse.up();
    await expect.poll(fresh).toHaveLength(1);
    const [lateSpace] = await fresh();
    let now = await snapshot(shell);
    expect(now.tabGroups.find((group) => group.id === lateSpace)?.tabIds).toEqual([late]);
    expect(now.currentGroupId).not.toBe(lateSpace);
    await expect(railSpace(shell, lateSpace!)).toHaveCount(1);
    await expect(shell.locator(rowSelector(late))).toHaveCount(0);
    await expect(shell.getByTestId("shelf-rail-token-face")).not.toHaveAttribute("data-shown", "");
    before.add(lateSpace!);

    // ── 2. A favorite not open, its tile let go on New space: a space of its page, opened there, still the favorite's ─
    const vendorTile = homeView(shell).locator('[data-testid="favorite-tile"][data-flip-id="fav-vendor"]');
    await holdOver(shell, vendorTile, shell.getByTestId("rail-new-space"));
    await capture(app, shell, "21-favorite-over-new-space.png");
    await shell.mouse.up();
    await expect.poll(fresh).toHaveLength(1);
    [vendorSpace] = (await fresh()) as [string];
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === vendorSpace)?.tabIds.length ?? 0).toBe(1);
    now = await snapshot(shell);
    const space = now.tabGroups.find((group) => group.id === vendorSpace)!;
    vendorTab = space.tabIds[0]!;
    expect(now.tabs.find((tab) => tab.id === vendorTab)).toMatchObject({ url: VENDOR, anchorId: null, linkedAnchorId: "fav-vendor" });
    expect(space.origin).toBe("manual");
    expect(now.currentGroupId).not.toBe(vendorSpace);
    // The favorite stays, open in that space: its mark in that space's colour.
    expect(now.sidebar.favorites.map((favorite) => favorite.id)).toEqual(["fav-mail", "fav-vendor"]);
    await expect(vendorTile).toHaveAttribute("data-linked-group", vendorSpace);
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === vendorSpace)?.naming === true).toBe(false);
    const color = (await snapshot(shell)).tabGroups.find((group) => group.id === vendorSpace)!.color;
    await expect(vendorTile.getByTestId("entry-linked-mark")).toHaveAttribute("data-group-color", color);
    before.add(vendorSpace);

    // ── 3. The pin onto Home: it is Home's already — Home does not light, and nothing comes of it ─
    const pinRow = shell.locator('[data-testid="pinned-tab"][data-flip-id="pin-north"]');
    await chromeSettled(shell.getByTestId("sidebar-tab-list"));
    const from = center((await pinRow.boundingBox())!);
    const home = center(await box(shell, '[data-testid="rail-home"]'));
    await shell.mouse.move(from.x, from.y);
    await shell.mouse.down();
    await shell.mouse.move(from.x, from.y + 8, { steps: 2 });
    await shell.mouse.move(home.x, home.y, { steps: 12 });
    await expect(shell.getByTestId("shelf-rail-token-face")).toHaveAttribute("data-shown", "");
    await expect(railHome(shell)).not.toHaveAttribute("data-dropping", "");
    await shell.mouse.up();
    await expect.poll(fresh).toHaveLength(0);
    expect((await snapshot(shell)).tabs.some((tab) => tab.url === NORTH)).toBe(false);
  });

  test("a favorite chosen in Home opens there, a page of its own — never in a space made of its page: one brought into a space, or one with a tab beside it, stays that space's", async () => {
    test.setTimeout(60_000);
    await chooseHome(shell);
    // Every view the card shows from here.
    await shell.evaluate(() => {
      const record: string[] = [];
      (window as unknown as { __views: string[] }).__views = record;
      const column = document.querySelector<HTMLElement>('[data-testid="sidebar-chrome"]')!;
      new MutationObserver(() => record.push(column.dataset["view"] ?? "")).observe(column, { attributes: true, attributeFilter: ["data-view"] });
    });
    const views = (): Promise<string[]> => shell.evaluate(() => (window as unknown as { __views: string[] }).__views);
    const pageOf = async (anchorId: string): Promise<string | null> => (await snapshot(shell)).tabs.find((tab) => tab.anchorId === anchorId)?.id ?? null;

    // ── 1. Its page brought into a space (the test before): chosen, a fresh page of it in Home, in use; the space keeps
    //       its tab, no longer the favorite's. (Earlier on 2026-10-14 it went there, the desk passing to that space.) ─
    const vendorTile = homeView(shell).locator('[data-testid="favorite-tile"][data-flip-id="fav-vendor"]');
    await expect(vendorTile).toHaveAttribute("data-linked-group", vendorSpace);
    await vendorTile.click();
    await expect.poll(() => pageOf("fav-vendor")).not.toBe(null);
    const vendorPage = (await pageOf("fav-vendor"))!;
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(vendorPage);
    let now = await snapshot(shell);
    expect(vendorPage).not.toBe(vendorTab);
    expect(now.currentGroupId).not.toBe(vendorSpace);
    expect(now.tabGroups.find((group) => group.id === vendorSpace)?.tabIds).toEqual([vendorTab]);
    expect(now.tabs.find((tab) => tab.id === vendorTab)?.linkedAnchorId).toBeUndefined();
    expect(now.tabs.filter((tab) => tab.url === VENDOR)).toHaveLength(2);
    await expect(shell.locator('[data-testid="sidebar-chrome"][data-view="home"]')).toHaveCount(1);
    await expect(vendorTile).not.toHaveAttribute("data-linked-group");
    await expect(shell.locator(windowSelector(vendorPage))).toHaveCount(1);
    await settled(shell, app);
    expect(await views()).toEqual([]);
    await capture(app, shell, "22-favorite-chosen-opens-in-home.png");

    // ── 2. A favorite's page with a tab beside it — a page's space on the rail — then Home: chosen, a fresh page of it in
    //       Home; its page's space is a space of its own, named after it, at the foot of the spaces ─
    const mailTile = homeView(shell).locator('[data-testid="favorite-tile"][data-flip-id="fav-mail"]');
    await mailTile.click();
    await expect.poll(() => pageOf("fav-mail")).not.toBe(null);
    const mailPage = (await pageOf("fav-mail"))!;
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(mailPage);
    const pageSpace = (await snapshot(shell)).anchorGroups!.find((group) => group.anchorId === "fav-mail")!;
    // (As ⌘T there does: a new tab in the space in front.)
    await tabGroupCommand(shell, { type: "newTab", groupId: pageSpace.id });
    await expect(railSpace(shell, pageSpace.id)).toHaveAttribute("data-page", "");
    const beside = (await snapshot(shell)).anchorGroups!.find((group) => group.id === pageSpace.id)!.tabIds.find((tabId) => tabId !== mailPage)!;
    await settled(shell, app);
    await chooseHome(shell);
    await shell.evaluate(() => (window as unknown as { __views: string[] }).__views.splice(0));
    await mailTile.click();
    await expect.poll(async () => ((await pageOf("fav-mail")) ?? mailPage) !== mailPage).toBe(true);
    const fresh = (await pageOf("fav-mail"))!;
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(fresh);
    now = await snapshot(shell);
    // (Titled after the favorite, whose title follows its page's.)
    const mailTitle = now.sidebar.favorites.find((favorite) => favorite.id === "fav-mail")!.title;
    expect(now.tabGroups.find((group) => group.id === pageSpace.id)).toMatchObject({ title: mailTitle, origin: "manual", tabIds: [mailPage, beside] });
    expect(now.anchorGroups?.find((group) => group.anchorId === "fav-mail")?.tabIds).toEqual([fresh]);
    expect(now.tabs.find((tab) => tab.id === mailPage)).toMatchObject({ anchorId: null });
    expect(now.tabs.find((tab) => tab.id === mailPage)?.linkedAnchorId).toBeUndefined();
    await expect(railSpace(shell, pageSpace.id)).not.toHaveAttribute("data-page", "");
    await expect.poll(async () => (await railOrder(shell)).at(-1)).toBe(pageSpace.id);
    await expect(shell.locator('[data-testid="sidebar-chrome"][data-view="home"]')).toHaveCount(1);
    await expect(shell.locator(windowSelector(fresh))).toHaveCount(1);
    await settled(shell, app);
    expect(await views()).toEqual([]);
  });

  test("a space's tile carried onto another merges into it — every tab, at its end; the other keeps its name and colour — and carried between two, it moves", async () => {
    test.setTimeout(60_000);
    // ── 0. Errands, one window: nothing to lay out, so no layouts in its view ─
    await chooseSpace(shell, "dd-errands");
    await expect(spaceRows(shell)).toHaveCount(1);
    await settled(shell, app);
    await expect(spaceView(shell, "dd-errands").getByTestId("layout-control")).toHaveCount(0);
    await chooseHome(shell);
    const research = (await snapshot(shell)).tabGroups.find((group) => group.id === "dd-research")!;

    // ── 1. Errands onto Research's middle: Research lights to take it, the carried tile shrinks; let go, one space ─
    await carryTile(shell, railSpace(shell, "dd-errands"), center(await box(shell, groupSelector("dd-research"))));
    await expect(railSpace(shell, "dd-research")).toHaveAttribute("data-merging", "");
    await expect(railSpace(shell, "dd-research")).toHaveAttribute("data-dropping", "");
    await capture(app, shell, "23-tile-over-tile.png");
    await shell.mouse.up();
    await expect(railSpace(shell, "dd-errands")).toHaveCount(0);
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === "dd-research")?.tabIds).toEqual([...research.tabIds, west]);
    const merged = (await snapshot(shell)).tabGroups.find((group) => group.id === "dd-research")!;
    expect(merged).toMatchObject({ title: "Research", color: "blue", origin: "manual" });
    expect((await snapshot(shell)).tabGroups.some((group) => group.id === "dd-errands")).toBe(false);
    await expect(railSpace(shell, "dd-research")).toHaveAttribute("aria-label", "Research, 3 windows");
    await expect(railSpace(shell, "dd-research")).not.toHaveAttribute("data-merging", "");

    // ── 2. The first tile carried into the gap below the second (over its foot): the gap opens, and it moves there ─
    await expect.poll(async () => (await railOrder(shell)).length).toBeGreaterThanOrEqual(3);
    const [first, second, ...rest] = await railOrder(shell);
    const below = await box(shell, groupSelector(second!));
    await carryTile(shell, railSpace(shell, first!), { x: below.x + below.width / 2, y: below.y + below.height + 4 });
    // (The second steps up into the first's place.)
    await expect.poll(() => railSpace(shell, second!).evaluate((tile) => getComputedStyle(tile).transform)).not.toBe("none");
    await capture(app, shell, "24-tile-between.png");
    await shell.mouse.up();
    await expect.poll(() => railOrder(shell)).toEqual([second, first, ...rest]);
    // (Carried, not chosen.)
    await expect(railHome(shell)).toHaveAttribute("aria-current", "true");
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

  test("the rail alone: a space's card lies over the only page in view, so a page asleep is woken for its picture and drawn once the card is gone — there for the next look — and put back to sleep; its space chosen meanwhile, the page is the person's, heard", async () => {
    test.setTimeout(60_000);
    // Two spaces of two pages asleep; Home's one page the whole desk.
    const [north, west, late, vendor, invoices] = (await openTabs(shell, [NORTH, WEST, LATE, VENDOR, INVOICES])) as [string, string, string, string, string];
    await createGroup(shell, "ds-asleep", [north, west], "Asleep", "blue");
    await createGroup(shell, "ds-chosen", [late, vendor], "Chosen", "green");
    await selectTab(shell, invoices);
    await shell.keyboard.press("Meta+s");
    await expect(shell.locator(SLOT)).toHaveAttribute("data-mode", "rail");
    await onDesk();
    await settled(shell, app);
    for (const tabId of [north, west, late, vendor]) await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.suspendTab(id), tabId);
    const asleep = async (tabIds = [north, west]): Promise<number> =>
      (await snapshot(shell)).tabs.filter((tab) => tabIds.includes(tab.id) && tab.lifecycle === "suspended").length;
    await expect.poll(() => asleep([north, west, late, vendor])).toBe(4);
    await app.evaluate(({ app: electron }) => {
      const woke: string[] = [];
      (globalThis as unknown as { __woke: string[] }).__woke = woke;
      electron.on("web-contents-created", (_event, contents) => contents.once("did-finish-load", () => woke.push(contents.getURL())));
    });
    const woken = (urls = [NORTH, WEST]): Promise<string[]> =>
      app.evaluate((_electron, among) => (globalThis as unknown as { __woke: string[] }).__woke.filter((url) => among.includes(url)), urls);
    const card = shell.locator('[data-testid="rail-space-card"][data-group-id="ds-asleep"]');
    const restOnTile = async (groupId = "ds-asleep"): Promise<{ x: number; y: number }> => {
      const tile = center(await box(shell, groupSelector(groupId)));
      await pointerAt(app, tile.x, tile.y);
      await shell.mouse.move(tile.x, tile.y);
      await expect(shell.locator(`[data-testid="rail-space-card"][data-group-id="${groupId}"]`)).toHaveAttribute("data-shown", "", { timeout: 5_000 });
      return tile;
    };

    // ── 1. The card over the page in use, whose view is down for it: a page woken now has nothing to be drawn beneath ─
    await restOnTile();
    const [over, page] = [await box(shell, '[data-testid="rail-space-card"]'), await box(shell, windowSelector(invoices))];
    expect(over.x + over.width).toBeGreaterThan(page.x);
    await expect.poll(async () => (await woken()).length, { timeout: 20_000 }).toBeGreaterThan(0);
    // ── 2. The card gone, the page back: the woken page is drawn beneath it, pictured, and asleep again ─
    await onDesk();
    await expect(card).toHaveCount(0);
    await expect.poll(asleep, { timeout: 20_000 }).toBe(2);
    // ── 3. The next look: its picture at once, not its icon ─
    await restOnTile();
    await expect(card.locator(".rail-space-card-still").first()).toBeVisible({ timeout: 2_000 });
    await capture(app, shell, "13-rail-card-asleep.png");
    await onDesk();
    await expect(card).toHaveCount(0);

    // ── 4. Another space's card: its page woken, silent from the start, waits to be drawn — and the space is chosen
    //       meanwhile: the person's page now, heard at once and left awake ─
    const tile = await restOnTile("ds-chosen");
    await expect.poll(async () => (await woken([LATE, VENDOR])).length, { timeout: 20_000 }).toBeGreaterThan(0);
    const [url] = await woken([LATE, VENDOR]);
    const muted = (): Promise<boolean | null> =>
      app.evaluate(({ webContents }, address) => webContents.getAllWebContents().find((contents) => contents.getURL() === address)?.isAudioMuted() ?? null, url!);
    expect(await muted()).toBe(true);
    await shell.mouse.click(tile.x, tile.y);
    await expect(railSpace(shell, "ds-chosen")).toHaveAttribute("aria-current", "true");
    await expect.poll(muted, { timeout: 2_000 }).toBe(false);
    await onDesk();
    expect((await snapshot(shell)).tabs.find((tab) => tab.id === (url === LATE ? late : vendor))?.lifecycle).toBe("live");
  });
});

test.describe.serial("Home is a browser's tabs", { tag: ["@sidebar", "@desk"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let invoices: string, south: string;
  let stage: Box;
  /** The space a tab is in: a loose tab's (a Home tab's), a page's, or a drawn one. */
  const spaceOf = async (tabId: string) => {
    const now = await snapshot(shell);
    return [...now.tabGroups, ...(now.looseGroups ?? []), ...(now.anchorGroups ?? [])].find((group) => group.tabIds.includes(tabId)) ?? null;
  };
  const homeShown = (): Locator => shell.locator('[data-testid="sidebar-chrome"][data-view="home"]');

  test.beforeAll(async () => {
    ({ app, shell } = await launchDesk({ name: "double-sidebar-home" }));
    [invoices, south] = (await openTabs(shell, [INVOICES, SOUTH])) as [string, string];
    await selectTab(shell, invoices);
    await expect(homeShown()).toHaveCount(1);
    await settled(shell, app);
    stage = await box(shell, ".desk-stage");
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("a new tab made in Home is a Home tab of its own, the whole desk — ⌘T, a duplicate — never a second window on the one in use", async () => {
    test.setTimeout(60_000);
    const drawn = (await snapshot(shell)).tabGroups.length;

    // ── 1. ⌘T on a Home tab: a Home tab of its own, in use, filling the desk; the one before it still a Home tab ─
    await shell.keyboard.press("Meta+t");
    await expect.poll(async () => (await snapshot(shell)).activeTabId).not.toBe(invoices);
    const made = (await snapshot(shell)).activeTabId!;
    expect((await spaceOf(made))).toMatchObject({ loose: true, tabIds: [made] });
    expect((await spaceOf(invoices))).toMatchObject({ loose: true, tabIds: [invoices] });
    expect((await snapshot(shell)).tabGroups).toHaveLength(drawn);
    await expect(homeShown()).toHaveCount(1);
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await settled(shell, app);
    expect(near(await box(shell, windowSelector(made)), stage)).toBe(true);
    // Going between Home tabs: each the whole desk.
    await selectTab(shell, invoices);
    await expect(shell.getByTestId("desk-window")).toHaveCount(1);
    await settled(shell, app);
    expect(near(await box(shell, windowSelector(invoices)), stage)).toBe(true);
    await capture(app, shell, "40-home-new-tab.png");

    // ── 2. A duplicate of a Home tab: a Home tab of its own, straight after it in Today, in use ─
    const copy = await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.duplicateTab(id), invoices);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(copy);
    expect((await spaceOf(copy))).toMatchObject({ loose: true, tabIds: [copy] });
    expect((await spaceOf(invoices))?.tabIds).toEqual([invoices]);
    const rows = await todayRows(shell).evaluateAll((list) => list.map((row) => (row as HTMLElement).dataset["tabId"] ?? ""));
    expect(rows.slice(rows.indexOf(invoices), rows.indexOf(invoices) + 2)).toEqual([invoices, copy]);
    expect((await snapshot(shell)).tabGroups).toHaveLength(drawn);
    await expect(homeShown()).toHaveCount(1);
    await settled(shell, app);
    // (The copy closed: a page found by its address — frameGrip's — would be either.)
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(id), copy);
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.id === copy)).toBe(false);
  });

  test("a Home tab's window carried off the whole desk and let go is a space of its own: the same space, on the rail, its window where it was let go", async () => {
    test.setTimeout(60_000);
    await selectTab(shell, invoices);
    await settled(shell, app);
    const home = (await spaceOf(invoices))!;
    expect(home.loose).toBe(true);

    // ── 1. Carried by its frame into the desk's middle, and let go ─
    await showFrame(shell, windowSelector(invoices));
    const drawer = `${windowSelector(invoices)} [data-testid="desk-window-drawer"]`;
    const title = await box(shell, `${drawer} [data-testid="desk-window-address"]`);
    const buttons = await box(shell, `${drawer} .desk-window-controls`);
    const frame = await box(shell, drawer);
    // (Between its title and its buttons: the frame's own, neither a button's nor the address's — frameGrip's point.)
    const at = { x: (title.x + title.width + buttons.x) / 2, y: frame.y + frame.height / 2 };
    await shell.mouse.move(at.x, at.y);
    await shell.mouse.down();
    const to = { x: stage.x + stage.width * 0.55, y: stage.y + stage.height * 0.45 };
    for (let step = 1; step <= 14; step += 1) {
      await shell.mouse.move(at.x + ((to.x - at.x) * step) / 14, at.y + ((to.y - at.y) * step) / 14);
      await shell.waitForTimeout(16);
    }
    await shell.mouse.up();

    // ── 2. Its space is one of its own: drawn, the person's, the same id — the desk stayed on it — on the rail, chosen ─
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === home.id)?.tabIds).toEqual([invoices]);
    const space = (await snapshot(shell)).tabGroups.find((group) => group.id === home.id)!;
    expect(space.origin).toBe("manual");
    expect(space.loose).toBeUndefined();
    expect((await snapshot(shell)).currentGroupId).toBe(home.id);
    await expect(railSpace(shell, home.id)).toHaveAttribute("aria-current", "true");
    await expect(spaceView(shell, home.id)).toHaveCount(1);
    await expect(shell.locator(`.desk-stage[data-phase="open"][data-group-id="${home.id}"]`)).toHaveCount(1);
    // Where it was let go: no longer the whole desk.
    await shell.mouse.move(stage.x + stage.width * 0.9, stage.y + stage.height * 0.9);
    await settled(shell, app);
    expect(near(await box(shell, windowSelector(invoices)), stage)).toBe(false);
    await capture(app, shell, "41-home-tab-broken-away.png");
    // (Of one window it stays a space: it is the person's.)
    await selectTab(shell, south);
    await expect(homeShown()).toHaveCount(1);
    await expect(railSpace(shell, home.id)).toHaveCount(1);
  });

  test("something dropped in a Home tab's Context makes it a space of its own, the file's window beside the page", async () => {
    test.setTimeout(60_000);
    await selectTab(shell, south);
    await settled(shell, app);
    const home = (await spaceOf(south))!;
    expect(home.loose).toBe(true);
    await dropFileOnDesk(shell, "notes.txt", "Bring the invoices\n", { x: stage.x + stage.width * 0.6, y: stage.y + stage.height * 0.5 });
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === home.id)?.origin).toBe("manual");
    await expect(railSpace(shell, home.id)).toHaveCount(1);
    await expect(spaceView(shell, home.id)).toHaveCount(1);
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await settled(shell, app);

    // Brought in from another space's Context (the Stack's Bring in, `adopt`): the same.
    const [late] = (await openTabs(shell, [LATE])) as [string];
    await selectTab(shell, late);
    await settled(shell, app);
    const lateHome = (await spaceOf(late))!;
    expect(lateHome.loose).toBe(true);
    await shell.evaluate(
      ([groupId, fromGroupId]) => (window as unknown as { pistachio: PistachioApi }).pistachio.groupContext({ type: "adopt", groupId, title: "", fromGroupId }),
      [lateHome.id, home.id] as const,
    );
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === lateHome.id)?.origin).toBe("manual");
    await expect(railSpace(shell, lateHome.id)).toHaveCount(1);
    await settled(shell, app);
  });

  test("a favorite chosen with no room for another space goes to its page's space as it stands — it never falls apart into Home tabs", async () => {
    test.setTimeout(60_000);
    await sidebarCommand(shell, { type: "addFavorite", source: { url: MAIL, title: "Mail" } });
    await expect.poll(async () => (await snapshot(shell)).sidebar.favorites.length).toBe(1);
    const mail = (await snapshot(shell)).sidebar.favorites[0]!.id;
    const pageOf = async (): Promise<string[]> => (await snapshot(shell)).tabs.filter((tab) => tab.anchorId === mail).map((tab) => tab.id);
    await sidebarCommand(shell, { type: "open", anchorId: mail });
    await expect.poll(pageOf).toHaveLength(1);
    const [page] = (await pageOf()) as [string];
    const pageSpace = (await spaceOf(page))!;
    // A tab beside its page: a page's space, on the rail.
    await tabGroupCommand(shell, { type: "newTab", groupId: pageSpace.id });
    await expect(railSpace(shell, pageSpace.id)).toHaveAttribute("data-page", "");
    await settled(shell, app);
    // The Profile filled to the bound with empty spaces.
    const drawn = (await snapshot(shell)).tabGroups.length;
    for (let index = drawn; index < MAX_TAB_GROUPS_PER_SPACE; index += 1)
      await tabGroupCommand(shell, { type: "create", id: `filler-${String(index)}`, tabIds: [], title: `Filler ${String(index)}` });
    await expect.poll(async () => (await snapshot(shell)).tabGroups.length).toBe(MAX_TAB_GROUPS_PER_SPACE);
    await chooseHome(shell);

    await sidebarCommand(shell, { type: "open", anchorId: mail });
    await expect.poll(async () => (await snapshot(shell)).currentGroupId).toBe(pageSpace.id);
    const now = await snapshot(shell);
    expect(now.activeTabId).toBe(page);
    expect(now.anchorGroups?.find((group) => group.id === pageSpace.id)).toMatchObject({ anchorId: mail });
    expect(now.anchorGroups?.find((group) => group.id === pageSpace.id)?.tabIds).toHaveLength(2);
    expect(await pageOf()).toEqual([page]);
    expect(now.tabGroups).toHaveLength(MAX_TAB_GROUPS_PER_SPACE);
    await settled(shell, app);
  });
});
