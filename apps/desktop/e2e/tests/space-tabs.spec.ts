/**
 * A space shows its tabs as a browser does (docs/space-tabs.md; since 2026-11-02): one page at a time, the tab in use
 * filling the desk, as Home's tabs do — a row chosen, ⌘T, a tab closed: the desk goes from one whole page to the next —
 * until it is made a space of WINDOWS: a row dragged out of the card onto the desk beside the page, the page carried off
 * the whole desk by its frame, or the space's Tabs/Windows control (and its menu's Show as windows / Show as tabs).
 * Back to tabs, the page in use fills the desk and the others go home into their rows; to windows again, they come
 * back where they were left.
 *
 * What only the real app has is proved here: the shell's desk against main's space (`TabGroupInfo.windows`), the card's
 * control and menu, a person's drags. The engine's rules — the swap, the gather, the spread — are desk-engine.test's
 * ("a space of tabs"), the space's flag the contracts' (tab-groups.test).
 */

import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import {
  box,
  center,
  chooseSpace,
  createGroup,
  launchDesk,
  openTabs,
  railSpace,
  rowSelector,
  screenshots,
  settled,
  showFrame,
  snapshot,
  spaceView,
  windowSelector,
  type Box,
} from "./desk-harness";

const capture = screenshots("space-tabs");

const NORTH = "pistachio://demo/invoices?page=north";
const SOUTH = "pistachio://demo/invoices?page=south";
const EAST = "pistachio://demo/invoices?page=east";
const SPACE = "trip";
const WEST = "pistachio://demo/invoices?page=west";
const LATE = "pistachio://demo/invoices?page=late";

/** Two boxes the same, within a few pixels. */
const near = (a: Box, b: Box, within = 3): boolean => (["x", "y", "width", "height"] as const).every((key) => Math.abs(a[key] - b[key]) < within);

/** A slow drag: the pointer stops before letting go, so it is a placement, not a throw (desk.spec's `place`). */
async function place(shell: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await shell.mouse.move(from.x, from.y);
  await shell.mouse.down();
  await shell.mouse.move(from.x + 6, from.y, { steps: 2 });
  for (let step = 1; step <= 12; step += 1) {
    await shell.mouse.move(from.x + ((to.x - from.x) * step) / 12, from.y + ((to.y - from.y) * step) / 12);
    await shell.waitForTimeout(16);
  }
  await shell.waitForTimeout(160);
  await shell.mouse.up();
}

test.describe.serial("a space shows its tabs as a browser does, until it is made one of windows", { tag: ["@desk", "@sidebar"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let ids: string[];
  let stage: Box;
  const space = async () => (await snapshot(shell)).tabGroups.find((group) => group.id === SPACE);
  const windows = (): Locator => shell.getByTestId("desk-window");
  const mode = (): Locator => shell.getByTestId("space-mode");
  const active = async (): Promise<string> => (await snapshot(shell)).activeTabId ?? "";
  /** The one window out, the tab in use's, filling the desk. */
  const alone = async (tabId: string): Promise<void> => {
    await expect(windows()).toHaveCount(1);
    await expect(shell.locator(windowSelector(tabId))).toHaveCount(1);
    await settled(shell, app);
    expect(near(await box(shell, windowSelector(tabId)), stage)).toBe(true);
  };

  test.beforeAll(async () => {
    ({ app, shell } = await launchDesk({ name: "space-tabs" }));
    ids = await openTabs(shell, [NORTH, SOUTH, EAST]);
    // (A space as Tidy, a drop on New space or Group selected tabs makes one: of tabs, the default.)
    await createGroup(shell, SPACE, ids, "Trip", "green", { windows: false });
    await chooseSpace(shell, SPACE);
    stage = await box(shell, ".desk-stage");
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("a space comes up as its tab used last alone, filling the desk; a row chosen takes the desk from it, ⌘T opens a tab of it filling the desk, and closing it brings the next", async () => {
    test.setTimeout(90_000);
    // ── 1. Of tabs: its control says so, and its page is the whole desk ─
    expect((await space())?.windows).toBeUndefined();
    await expect(mode()).toHaveAttribute("data-mode", "tabs");
    await expect(shell.getByTestId("space-mode-tabs")).toHaveAttribute("aria-checked", "true");
    const first = await active();
    expect(ids).toContain(first);
    await alone(first);
    // (One window out: no layouts to choose among.)
    await expect(shell.getByTestId("layout-control")).toHaveCount(0);
    await capture(app, shell, "01-space-of-tabs.png");

    // ── 2. Another of its rows chosen: its page takes the whole desk, the one before goes home ─
    const other = ids.find((id) => id !== first)!;
    await shell.locator(rowSelector(other)).click();
    await expect.poll(active).toBe(other);
    await alone(other);
    expect((await snapshot(shell)).currentGroupId).toBe(SPACE);
    await capture(app, shell, "02-row-chosen.png");

    // ── 3. ⌘T: a tab of the space, in use, filling the desk — never a second window ─
    await shell.keyboard.press("Meta+t");
    await expect.poll(async () => (await space())?.tabIds.length).toBe(4);
    // (It joins the space a moment before it is the tab in use.)
    await expect.poll(async () => ids.includes(await active())).toBe(false);
    const made = await active();
    expect((await space())?.tabIds).toContain(made);
    await alone(made);

    // ── 4. Closed: the next tab in use takes the desk, alone ─
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(id), made);
    await expect.poll(async () => (await space())?.tabIds.length).toBe(3);
    await expect.poll(async () => ids.includes(await active())).toBe(true);
    const next = await active();
    expect(ids).toContain(next);
    await alone(next);
    expect((await space())?.windows).toBeUndefined();
  });

  test("a row dragged out of the card onto the desk beside the page is a second window, and the space is one of windows: Windows lit, its layouts there", async () => {
    test.setTimeout(60_000);
    const page = await active();
    const other = ids.find((id) => id !== page)!;
    await place(shell, center(await box(shell, rowSelector(other))), { x: stage.x + stage.width * 0.55, y: stage.y + stage.height * 0.2 });
    await expect(windows()).toHaveCount(2);
    await expect.poll(async () => (await space())?.windows).toBe(true);
    await expect(mode()).toHaveAttribute("data-mode", "windows");
    await expect(shell.getByTestId("space-mode-windows")).toHaveAttribute("aria-checked", "true");
    await settled(shell, app);
    // The page it was dropped beside is where it was; the row's window where it was let go, not filling the desk.
    expect(near(await box(shell, windowSelector(other)), stage)).toBe(false);
    await expect(shell.getByTestId("layout-control")).toHaveCount(1);
    await capture(app, shell, "03-row-dragged-out.png");
  });

  test("Show as tabs (the space's ⋯): the page in use fills the desk, the others go home into their rows; Windows brings them back where they were", async () => {
    test.setTimeout(60_000);
    await settled(shell, app);
    const inUse = await active();
    const out = await windows().evaluateAll((list) => list.map((el) => (el as HTMLElement).dataset["tabId"] ?? ""));
    expect(out).toHaveLength(2);
    const before = new Map<string, Box>();
    for (const tabId of out) before.set(tabId, await box(shell, windowSelector(tabId)));

    // ── 1. Show as tabs, from the space's own menu ─
    await spaceView(shell, SPACE).getByTestId("space-more").click();
    await shell.getByRole("menuitem", { name: "Show as tabs" }).click();
    await expect.poll(async () => (await space())?.windows).toBeUndefined();
    await expect(mode()).toHaveAttribute("data-mode", "tabs");
    expect(await active()).toBe(inUse);
    await alone(inUse);
    await capture(app, shell, "04-shown-as-tabs.png");

    // ── 2. Windows, from the control: back as they were left ─
    await shell.getByTestId("space-mode-windows").click();
    await expect.poll(async () => (await space())?.windows).toBe(true);
    await expect(windows()).toHaveCount(2);
    await settled(shell, app);
    for (const tabId of out) expect(near(await box(shell, windowSelector(tabId)), before.get(tabId)!, 6), tabId).toBe(true);
    expect(await active()).toBe(inUse);
    await capture(app, shell, "05-windows-again.png");
  });

  test("its page carried off the whole desk by its frame makes it a space of windows, the window where it was let go", async () => {
    test.setTimeout(60_000);
    await shell.getByTestId("space-mode-tabs").click();
    await expect.poll(async () => (await space())?.windows).toBeUndefined();
    const page = await active();
    await alone(page);

    // ── Carried by its frame into the desk's middle, and let go (as a Home tab breaks away: double-sidebar.spec) ─
    await showFrame(shell, windowSelector(page));
    const drawer = `${windowSelector(page)} [data-testid="desk-window-drawer"]`;
    const title = await box(shell, `${drawer} [data-testid="desk-window-address"]`);
    const buttons = await box(shell, `${drawer} .desk-window-controls`);
    const frame = await box(shell, drawer);
    const at = { x: (title.x + title.width + buttons.x) / 2, y: frame.y + frame.height / 2 };
    await shell.mouse.move(at.x, at.y);
    await shell.mouse.down();
    const to = { x: stage.x + stage.width * 0.55, y: stage.y + stage.height * 0.45 };
    for (let step = 1; step <= 14; step += 1) {
      await shell.mouse.move(at.x + ((to.x - at.x) * step) / 14, at.y + ((to.y - at.y) * step) / 14);
      await shell.waitForTimeout(16);
    }
    await shell.mouse.up();

    await expect.poll(async () => (await space())?.windows).toBe(true);
    await expect(mode()).toHaveAttribute("data-mode", "windows");
    await shell.mouse.move(stage.x + stage.width * 0.9, stage.y + stage.height * 0.9);
    await settled(shell, app);
    await expect(windows()).toHaveCount(1);
    expect(near(await box(shell, windowSelector(page)), stage)).toBe(false);
    // The same space, current, its other tabs still in their rows.
    expect((await snapshot(shell)).currentGroupId).toBe(SPACE);
    expect((await space())?.tabIds).toHaveLength(3);
    await capture(app, shell, "06-carried-off.png");
  });

  test("Show as windows from the menu of a space not in front: the desk passing to it brings its tabs out as windows, tiled", async () => {
    test.setTimeout(60_000);
    const errands = (await openTabs(shell, [WEST, LATE])) as [string, string];
    await createGroup(shell, "errands", errands, "Errands", "amber", { windows: false });
    await expect(railSpace(shell, "errands")).toHaveCount(1);
    expect((await snapshot(shell)).currentGroupId).toBe(SPACE);

    // ── Its tile's menu: Show as windows — the space in front stays as it is ─
    await railSpace(shell, "errands").click({ button: "right" });
    await shell.getByTestId("context-menu").getByRole("menuitem", { name: "Show as windows", exact: true }).click();
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === "errands")?.windows).toBe(true);
    expect((await snapshot(shell)).currentGroupId).toBe(SPACE);

    // ── Chosen: its tabs come out side by side, as its Windows would bring them out in front ─
    await chooseSpace(shell, "errands");
    await expect(windows()).toHaveCount(2);
    await settled(shell, app);
    const [a, b] = [await box(shell, windowSelector(errands[0])), await box(shell, windowSelector(errands[1]))];
    expect(Math.abs(a.width - b.width)).toBeLessThan(4);
    expect(Math.min(a.x + a.width, b.x + b.width)).toBeLessThanOrEqual(Math.max(a.x, b.x));
    await capture(app, shell, "07-windows-from-the-tile.png");
  });
});
