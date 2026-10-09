/**
 * Tidy end to end (docs/tab-tidy.md): idle tabs are archived, related tabs
 * become a space that opens on hover, a space chosen is the desk's and closes
 * into the archive, the archive restores, favorites go home, and one Undo
 * takes a whole run back.
 *
 * Age is seeded, not waited for: the profile's tab-session.json carries tabs
 * whose `lastActiveAt` is a day old, which is exactly what a morning launch
 * looks like. The model is a script (`PISTACHIO_TIDY_SCRIPT`) that names tabs
 * by their titles. Restored tabs sleep until shown, so nothing here touches
 * the network but the demo pages the app serves itself.
 */

import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { PistachioApi, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { noticePage, pageFirst, shellReady } from "./windows";
import { launchApp, newProfile, type LaunchedApp } from "./app";
import { capturePage, nextFrames, settled } from "./chrome-harness";

const HOUR = 3_600_000;

function capture(page: Page | Locator, filename: string, settleMs = 0): Promise<void> {
  return capturePage(page, "tab-tidy", filename, settleMs);
}

const SCRIPT = {
  groups: [
    // One of these is fresh, so the group stays in the sidebar…
    { title: "Lisbon trip", titles: ["Flights to Lisbon", "Hotels in Alfama", "Lisbon food guide"] },
    // …and every one of these is idle, so they leave together, under their title.
    { title: "Desk research", titles: ["Standing desk A", "Standing desk B"] },
  ],
};

const FAVORITE_ID = "fav-vendors";
const FAVORITE_HOME = "pistachio://demo/vendors";

interface SeedTab {
  id: string;
  title: string;
  url: string;
  idleHours: number;
  anchorId?: string;
}

const TABS: SeedTab[] = [
  { id: "tab-active", title: "Invoices", url: "pistachio://demo/invoices", idleHours: 0 },
  { id: "tab-flights", title: "Flights to Lisbon", url: "pistachio://demo/invoices?page=flights", idleHours: 1 },
  { id: "tab-hotels", title: "Hotels in Alfama", url: "pistachio://demo/invoices?page=hotels", idleHours: 20 },
  { id: "tab-food", title: "Lisbon food guide", url: "pistachio://demo/invoices?page=food", idleHours: 2 },
  { id: "tab-desk-a", title: "Standing desk A", url: "pistachio://demo/invoices?page=desk-a", idleHours: 30 },
  { id: "tab-desk-b", title: "Standing desk B", url: "pistachio://demo/invoices?page=desk-b", idleHours: 31 },
  { id: "tab-news", title: "Old news story", url: "pistachio://demo/invoices?page=news", idleHours: 40 },
  { id: "tab-fresh", title: "Fresh reading", url: "pistachio://demo/invoices?page=fresh", idleHours: 1 },
  // A favorite that wandered off to one vendor, hours ago.
  { id: "tab-favorite", title: "Atlas Medical", url: "pistachio://demo/vendors/atlas-medical", idleHours: 20, anchorId: FAVORITE_ID },
];

/** Launch on a profile seeded as a morning launch looks; `script` is the model's stand-in (`PISTACHIO_TIDY_SCRIPT`), none for no model. */
async function launchSeeded(script?: unknown): Promise<LaunchedApp> {
  const userData = await newProfile("tab-tidy");
  const now = Date.now();
  return launchApp({
    userData,
    settings: pageFirst({ onboarding: { completed: true, completedAt: null } }),
    files: {
      "tab-session.json": {
        version: 1,
        spaces: {
          work: {
            activeTabId: "tab-active",
            recentTabIds: TABS.map((tab) => tab.id),
            splitGroups: [],
            tabs: TABS.map((tab) => ({
              id: tab.id,
              spaceId: "work",
              title: tab.title,
              url: tab.url,
              faviconUrl: null,
              anchorId: tab.anchorId ?? null,
              lastActiveAt: now - tab.idleHours * HOUR,
            })),
          },
        },
      },
      "sidebar.json": { version: 1, spaces: { work: { favorites: [{ id: FAVORITE_ID, url: FAVORITE_HOME, title: "Vendors", faviconUrl: null }], entries: [] } } },
    },
    env: script === undefined ? {} : { PISTACHIO_TIDY_SCRIPT: JSON.stringify(script) },
  });
}

function api<T>(shell: Page, call: (pistachio: PistachioApi) => Promise<T>): Promise<T> {
  return shell.evaluate(`(${call.toString()})(window.pistachio)`) as Promise<T>;
}

const snapshot = (shell: Page): Promise<ShellSnapshot> => api(shell, (pistachio) => pistachio.getSnapshot());

const dayTitles = async (shell: Page): Promise<string[]> => {
  const state = await snapshot(shell);
  return state.tabs.filter((tab) => tab.anchorId === null).map((tab) => tab.title);
};

test("tidy archives idle tabs, puts related ones in a space, resets favorites, and can be undone", { tag: ["@tabs", "@sidebar", "@notices"] }, async () => {
  test.setTimeout(60_000);
  let app: ElectronApplication | null = null;
  try {
    const launched = await launchSeeded({ ...SCRIPT, delayMs: 1_000 });
    app = launched.app;
    const shell = await shellReady(app);
    const list = shell.getByTestId("sidebar-tab-list");
    await expect(list.getByTestId("human-tab")).toHaveCount(8);
    await capture(shell, "01-before.png");

    // ── 1. Tidy now ────────────────────────────────────────────────────────
    await shell.getByTestId("section-header-live").hover();
    await shell.getByTestId("tidy-tabs-button").click();
    // While the run is out, the live section says so: the header reads
    // "Tidying tabs…" and the rows are marked busy under a sweeping light.
    await expect(shell.getByTestId("section-busy-live")).toHaveText("Tidying tabs…");
    await expect(shell.locator("#sidebar-section-live")).toHaveAttribute("aria-busy", "true");
    await capture(shell, "01b-tidying.png", 400); // past the rows' fade
    const notices = await noticePage(app);
    const card = notices.locator('[data-testid="notice-card"][data-depth="0"]');
    // Hotels stays (grouped with fresh tabs); desk A + B and the news story go: 3 archived, 1 group made.
    await expect(card).toContainText("Archived 3 tabs · made 1 space");
    await expect(card.getByRole("button", { name: "Undo" })).toBeVisible();
    await expect(shell.getByTestId("section-busy-live")).toHaveCount(0);
    await expect(shell.locator("#sidebar-section-live")).toHaveAttribute("aria-busy", "false");
    await capture(notices, "02-notice.png");

    const group = list.getByTestId("tab-group");
    await expect(group).toHaveCount(1);
    await expect(group.getByTestId("tab-group-title")).toHaveText("Lisbon trip");
    await expect(group.getByTestId("tab-group-count")).toHaveText("3");
    // (The first tab is the one in view: it loaded, so it wears its page's own title.)
    expect((await dayTitles(shell)).slice(1)).toEqual(["Flights to Lisbon", "Hotels in Alfama", "Lisbon food guide", "Fresh reading"]);
    // At rest the group is ONE row: its tabs are not drawn.
    await shell.mouse.move(900, 500);
    await expect(group.getByTestId("tab-group-members")).toHaveCount(0);
    await expect(list.getByTestId("human-tab")).toHaveCount(2);
    await capture(shell, "03-tidied-collapsed.png");

    // The favorite went home — asleep, re-addressed, its old page one Back away.
    const favorite = (await snapshot(shell)).tabs.find((tab) => tab.anchorId === FAVORITE_ID);
    expect(favorite?.url).toBe(FAVORITE_HOME);

    // ── 2. Hover opens the group in place; leaving closes it ────────────────
    await group.getByTestId("tab-group-header").hover();
    await expect(group.getByTestId("tab-group-members").getByTestId("human-tab")).toHaveCount(3);
    await capture(shell, "04-group-hover-open.png");
    await shell.mouse.move(900, 500);
    await expect(group.getByTestId("tab-group-members")).toHaveCount(0);

    // ── 3. The group's menu: colour, rename ─────────────────────────────────
    await group.getByTestId("tab-group-header").click({ button: "right" });
    const menu = shell.getByTestId("context-menu");
    await expect(menu.getByRole("menuitem", { name: "Release the tabs" })).toBeVisible();
    // No split view on the desktop: the desk lays a space's tabs out as windows.
    await expect(menu.getByRole("menuitem", { name: /split/i })).toHaveCount(0);
    await capture(shell, "05-group-menu.png");
    await menu.getByTestId("group-color-amber").click();
    await expect(group).toHaveAttribute("data-group-color", "amber");
    await group.getByTestId("tab-group-header").dblclick();
    await shell.getByTestId("tab-group-name-input").fill("Portugal");
    await shell.getByTestId("tab-group-name-input").press("Enter");
    await expect(group.getByTestId("tab-group-title")).toHaveText("Portugal");
    // Renaming made it the person's own.
    expect((await snapshot(shell)).tabGroups[0]).toMatchObject({ title: "Portugal", color: "amber", origin: "manual" });

    // ── 4. One of its tabs chosen: the desk passes to the space ─────────────
    const portugal = (await snapshot(shell)).tabGroups[0]!.id;
    await api(shell, (pistachio) => pistachio.selectTab("tab-flights"));
    await expect.poll(async () => (await snapshot(shell)).currentGroupId).toBe(portugal);
    await expect(shell.locator(`.desk-stage[data-phase="open"][data-group-id="${portugal}"]`)).toHaveCount(1);
    expect((await snapshot(shell)).splitMode).toBe("single");
    // It holds the tab in use, so it stays open without the pointer.
    await shell.mouse.move(900, 500);
    await expect(group.getByTestId("tab-group-members")).toHaveCount(1);
    await capture(shell, "06-space-on-the-desk.png");
    // Its chevron folds it away anyway — the tab in use and the pointer on it notwithstanding — and opens it again.
    await group.getByTestId("tab-group-header").hover();
    await expect(group.getByTestId("tab-group-toggle")).toHaveAttribute("aria-label", "Collapse space");
    await group.getByTestId("tab-group-toggle").click();
    await expect(group.getByTestId("tab-group-members")).toHaveCount(0);
    await shell.mouse.move(900, 500);
    await expect(group.getByTestId("tab-group-members")).toHaveCount(0);
    await group.getByTestId("tab-group-toggle").click();
    await expect(group.getByTestId("tab-group-members").getByTestId("human-tab")).toHaveCount(3);
    await shell.mouse.move(900, 500);
    await expect(group.getByTestId("tab-group-members")).toHaveCount(1);

    // ── 5. Close the group: it is filed whole, and Undo brings it back ──────
    await group.getByTestId("tab-group-header").hover();
    await group.getByTestId("tab-group-close").click();
    await expect(list.getByTestId("tab-group")).toHaveCount(0);
    await expect(card).toContainText("Closed “Portugal” · 3 tabs");
    await card.getByRole("button", { name: "Undo" }).click();
    await expect(list.getByTestId("tab-group")).toHaveCount(1);
    await expect(list.getByTestId("tab-group").getByTestId("tab-group-title")).toHaveText("Portugal");

    // ── 6. The archive ─────────────────────────────────────────────────────
    await api(shell, (pistachio) => pistachio.selectTab("tab-active"));
    await shell.getByTestId("section-header-live").click({ button: "right" });
    await shell.getByTestId("context-menu").getByRole("menuitem", { name: "Archived tabs" }).click();
    const archive = shell.getByTestId("archive-page");
    await expect(archive).toBeVisible();
    await expect(archive.getByTestId("archive-summary")).toContainText("3 tabs");
    await expect(archive.getByTestId("archive-entry")).toHaveCount(2);
    await archive.getByTestId("archive-group-toggle").click();
    await expect(archive.getByTestId("archive-group-tab")).toHaveCount(2);
    await capture(shell, "07-archive.png");
    await archive.getByTestId("archive-filter").fill("news");
    await expect(archive.getByTestId("archive-entry")).toHaveCount(1);
    await archive.getByTestId("archive-filter").fill("");

    // Restoring the archived group brings back the group, titled, with its tabs.
    const deskEntry = archive.getByTestId("archive-entry").filter({ hasText: "Desk research" });
    await deskEntry.hover();
    await deskEntry.getByTestId("archive-restore").click();
    await expect(archive).toHaveCount(0);
    await expect(list.getByTestId("tab-group")).toHaveCount(2);
    const restored = (await snapshot(shell)).tabGroups.find((candidate) => candidate.title === "Desk research");
    expect(restored?.tabIds).toHaveLength(2);
    await capture(shell, "08-restored-group.png");

    // ── 7. Groups survive a restart ────────────────────────────────────────
    await app.close();
    ({ app } = await launchApp({ userData: launched.userData }));
    const again = await shellReady(app);
    await expect(again.getByTestId("sidebar-tab-list").getByTestId("tab-group")).toHaveCount(2);
    expect((await snapshot(again)).tabGroups.map((candidate) => candidate.title).sort()).toEqual(["Desk research", "Portugal"]);
  } finally {
    await app?.close();
  }
});

test("tidy runs from the sidebar menu and from its keyboard shortcut", { tag: ["@tabs", "@sidebar"] }, async () => {
  let app: ElectronApplication | null = null;
  try {
    ({ app } = await launchSeeded(SCRIPT));
    const shell = await shellReady(app);
    const list = shell.getByTestId("sidebar-tab-list");
    await expect(list.getByTestId("human-tab")).toHaveCount(8);

    // ── The sidebar menu: "Tidy tabs", with its shortcut beside it ──
    await shell.getByTestId("sidebar-menu-button").click();
    const item = shell.getByTestId("tidy-tabs-menu-item");
    await expect(item).toBeVisible();
    await expect(item).toContainText("Tidy tabs");
    await expect(item).toContainText("K");
    await capture(shell, "13-sidebar-menu.png");
    await item.click();
    const notices = await noticePage(app);
    const card = notices.locator('[data-testid="notice-card"][data-depth="0"]');
    await expect(card).toContainText("Archived 3 tabs · made 1 space");
    await expect(list.getByTestId("tab-group")).toHaveCount(1);

    // Take it back, so the shortcut has the same work to do.
    await card.getByRole("button", { name: "Undo" }).click();
    await expect(list.getByTestId("tab-group")).toHaveCount(0);
    await expect.poll(async () => (await dayTitles(shell)).length).toBe(8);

    // ── ⌘⇧K, from the shell ──
    // Undo gave the restored tabs a fresh clock (or the next sweep would take
    // them straight back), so nothing is idle now: this run archives nothing,
    // and the desk tabs — all idle before — become a live group this time.
    await shell.keyboard.press("Meta+Shift+K");
    await expect(list.getByTestId("tab-group")).toHaveCount(2);
    // The earlier notice may still be on its way out: the live card is the one that speaks.
    await expect(notices.locator('[data-testid="notice-card"][data-phase="live"]').filter({ hasText: "Made 2 spaces" })).toBeVisible();
    expect((await snapshot(shell)).tabGroups.map((candidate) => candidate.title).sort()).toEqual(["Desk research", "Lisbon trip"]);
    expect(await dayTitles(shell)).toHaveLength(8);

    // The binding is a setting like any other.
    const settings = await api(shell, (pistachio) => pistachio.getSettings());
    expect(settings.shortcuts.tidyTabs).toBe("Mod+Shift+K");
  } finally {
    await app?.close();
  }
});

// (Undo's order and its never-twice rule are apps/desktop/test/tab-tidy.test.ts's.)
test("a new tab makes a space yours; a tab moved to another Profile leaves its space behind", { tag: ["@tabs"] }, async () => {
  // Flights and Fresh reading sit far apart in the row, so grouping them MOVES one of them.
  const script = { groups: [{ title: "Mix", titles: ["Flights to Lisbon", "Fresh reading"] }] };
  let app: ElectronApplication | null = null;
  try {
    ({ app } = await launchSeeded(script));
    const shell = await shellReady(app);
    await expect(shell.getByTestId("sidebar-tab-list").getByTestId("human-tab")).toHaveCount(8);

    // ── "New tab in group" is the person's own addition: the group is theirs, and Tidy will not archive it ──
    await api(shell, (pistachio) => pistachio.tidy({ type: "run" }));
    const made = (await snapshot(shell)).tabGroups.find((candidate) => candidate.title === "Mix");
    if (made === undefined) throw new Error("the group was not made");
    expect(made.origin).toBe("auto");
    await shell.evaluate((groupId) => (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "newTab", groupId }), made.id);
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((candidate) => candidate.id === made.id)?.origin).toBe("manual");
    const grown = (await snapshot(shell)).tabGroups.find((candidate) => candidate.id === made.id);
    expect(grown?.tabIds).toHaveLength(3);

    // ── Moving a group's FIRST tab to another Space leaves the group, and the rest of it, where they were ──
    const targetSpaceId = await shell.evaluate(async () => {
      const pistachio = (window as unknown as { pistachio: PistachioApi }).pistachio;
      const here = (await pistachio.getSnapshot()).activeSpaceId;
      const fork = await pistachio.forkSpace({ name: "Research", purpose: "Somewhere else", tabs: "active", includeShelf: false, includeSession: false });
      await pistachio.switchSpace(here);
      return fork.spaceId;
    });
    const [first, ...rest] = grown?.tabIds ?? [];
    if (first === undefined) throw new Error("the group is empty");
    await api(shell, (pistachio) => pistachio.selectTab("tab-active"));
    await shell.evaluate(({ tabId, spaceId }) => (window as unknown as { pistachio: PistachioApi }).pistachio.moveTabToSpace(tabId, spaceId), { tabId: first, spaceId: targetSpaceId });
    await api(shell, (pistachio) => pistachio.switchSpace("work"));
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((candidate) => candidate.id === made.id)?.tabIds).toEqual(rest);
    const home = await snapshot(shell);
    expect(home.tabs.some((tab) => tab.id === first)).toBe(false);
    expect(rest.every((tabId) => home.tabs.some((tab) => tab.id === tabId))).toBe(true);
  } finally {
    await app?.close();
  }
});

test("a space made by hand is named from its tabs — unless the person names it first, or nobody can", { tag: ["@tabs", "@sidebar"] }, async () => {
  test.setTimeout(60_000);

  /** Select two day tabs and choose "New space with selected tabs", as a person would. */
  const groupTwo = async (shell: Page): Promise<void> => {
    const list = shell.getByTestId("sidebar-tab-list");
    await list.locator('[data-tab-id="tab-flights"]').click({ modifiers: ["Meta"] });
    await list.locator('[data-tab-id="tab-hotels"]').click({ modifiers: ["Meta"] });
    await list.locator('[data-tab-id="tab-hotels"]').click({ button: "right" });
    await shell.getByTestId("context-menu").getByRole("menuitem", { name: "New space with selected tabs" }).click();
  };
  const launch = async (script: unknown): Promise<{ app: ElectronApplication; shell: Page }> => {
    const { app } = await launchSeeded(script);
    const shell = await shellReady(app);
    await expect(shell.getByTestId("sidebar-tab-list").getByTestId("human-tab")).toHaveCount(8);
    return { app, shell };
  };

  // ── 1. The model names it: the row says so, then wears the name. No field ever opens. ──
  let running = await launch({ name: "Lisbon trip" });
  try {
    const { shell } = running;
    const group = shell.getByTestId("sidebar-tab-list").getByTestId("tab-group");
    await groupTwo(shell);
    await expect(group.getByTestId("tab-group-title")).toHaveText("Naming…");
    await capture(shell, "14-naming.png");
    await expect(group.getByTestId("tab-group-title")).toHaveText("Lisbon trip");
    await expect(shell.getByTestId("tab-group-name-input")).toHaveCount(0);
    expect((await snapshot(shell)).tabGroups[0]).toMatchObject({ title: "Lisbon trip", origin: "manual", tabIds: ["tab-flights", "tab-hotels"] });

    // ── 2. The person's name stands: renamed while the model is still thinking, its answer is dropped. ──
    await api(shell, (pistachio) => pistachio.tabGroupCommand({ type: "create", id: "g-mine", tabIds: ["tab-food", "tab-fresh"] }));
    expect((await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "g-mine")?.naming).toBe(true);
    await api(shell, (pistachio) => pistachio.tabGroupCommand({ type: "rename", groupId: "g-mine", title: "Mine" }));
    // The model answers in the order it was asked: once a group asked after
    // "Mine" wears its answer, the answer for "Mine" has come and gone.
    await api(shell, (pistachio) => pistachio.tabGroupCommand({ type: "create", id: "g-later", tabIds: ["tab-desk-a", "tab-desk-b"] }));
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "g-later")?.title).toBe("Lisbon trip");
    expect((await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "g-mine")).toMatchObject({ title: "Mine" });
  } finally {
    await running.app.close();
  }

  // ── 3. The asking came to nothing: the placeholder stays, and the person is handed the field. ──
  running = await launch({ name: null });
  try {
    const { shell } = running;
    await groupTwo(shell);
    const input = shell.getByTestId("tab-group-name-input");
    await expect(input).toBeVisible();
    await expect(input).toHaveValue("New space");
  } finally {
    await running.app.close();
  }

  // ── 4. Nobody to ask (no model here; the same as signed out or switched off): the field at once, as it always was. ──
  running = await launch(undefined);
  try {
    const { shell } = running;
    await groupTwo(shell);
    await expect(shell.getByTestId("tab-group-name-input")).toHaveValue("New space");
    expect((await snapshot(shell)).tabGroups[0]?.naming).not.toBe(true);
    await shell.getByTestId("tab-group-name-input").fill("Typed by hand");
    await shell.getByTestId("tab-group-name-input").press("Enter");
    await expect(shell.getByTestId("sidebar-tab-list").getByTestId("tab-group-title")).toHaveText("Typed by hand");
  } finally {
    await running.app.close();
  }
});

/**
 * A real pointer drag from a row to a height in the list, with an optional
 * look at the proposed layout before letting go. The pointer travels STRAIGHT
 * along the column: a row that drifts right past the column's edge is handed
 * to the native drag layer (it may be on its way to the page), and that layer
 * relays the machine's real cursor, which a spec does not control.
 */
async function dragTo(shell: Page, from: ReturnType<Page["locator"]>, to: { x: number; y: number }, beforeDrop?: () => Promise<void>): Promise<void> {
  // Rows FLIP-slide after any relayout, and hit-testing follows the slide: let the column land first.
  await settled(shell.getByTestId("sidebar-tab-list"));
  const box = await from.boundingBox();
  if (box === null) throw new Error("drag source has no box");
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await shell.mouse.move(startX, startY);
  await shell.mouse.down();
  // Past the 5px threshold first, then to the target in steps so every row on the way sees a move.
  await shell.mouse.move(startX, startY + 8, { steps: 2 });
  await shell.mouse.move(startX, to.y, { steps: 12 });
  // The drop target follows the last move on the next frame.
  await nextFrames(shell);
  await beforeDrop?.();
  await shell.mouse.up();
}

// Once a drag begins the native drag layer holds the machine's REAL pointer,
// and relays it: a person moving their mouse over this window while the spec
// runs steers the drag (confirmed 2026-09-19 by logging the samples — every
// failing run carried `native` moves, no passing run did). Every drag spec
// shares this; on a machine in use, a retry is the honest remedy.
test.describe("dragging rows", () => {
  test.describe.configure({ retries: 2 });

  test("tabs drag into a space, to a place within it, and out of it again", { tag: ["@tabs", "@sidebar"] }, async () => {
    let app: ElectronApplication | null = null;
    try {
      ({ app } = await launchSeeded());
      const shell = await shellReady(app);
      const list = shell.getByTestId("sidebar-tab-list");
      await expect(list.getByTestId("human-tab")).toHaveCount(8);
      await api(shell, (pistachio) => pistachio.tabGroupCommand({ type: "create", id: "g-trip", title: "Trip", tabIds: ["tab-flights", "tab-hotels"] }));
      const group = list.getByTestId("tab-group");
      const header = group.getByTestId("tab-group-header");
      const row = (tabId: string): ReturnType<Page["locator"]> => list.locator(`[data-tab-id="${tabId}"]`);
      const members = async (): Promise<string[]> => (await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "g-trip")?.tabIds ?? [];
      const centre = async (target: ReturnType<Page["locator"]>, dy = 0): Promise<{ x: number; y: number }> => {
        const box = await target.boundingBox();
        if (box === null) throw new Error("drop target has no box");
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 + dy };
      };
      await expect(group.getByTestId("tab-group-count")).toHaveText("2");

      // ── 1. Onto a CLOSED group's header: it opens to take the tab, which joins at the end ──
      await shell.mouse.move(900, 500);
      await expect(group.getByTestId("tab-group-members")).toHaveCount(0);
      await dragTo(shell, row("tab-fresh"), await centre(header), async () => {
        await expect(group).toHaveAttribute("data-receiving", "");
        await expect(group.getByTestId("tab-group-members").getByTestId("human-tab")).toHaveCount(3);
        await capture(shell, "10-drag-into-closed-group.png");
      });
      await expect.poll(members).toEqual(["tab-flights", "tab-hotels", "tab-fresh"]);
      // It was the person's hand, and it closes again once the pointer has gone.
      await shell.mouse.move(900, 500);
      await expect(group.getByTestId("tab-group-members")).toHaveCount(0);
      await expect(group.getByTestId("tab-group-count")).toHaveText("3");

      // ── 2. Into an OPEN group, between two of its tabs ──
      await api(shell, (pistachio) => pistachio.tabGroupCommand({ type: "setOpen", groupId: "g-trip", open: true }));
      await expect(group.getByTestId("tab-group-members").getByTestId("human-tab")).toHaveCount(3);
      // Just above the middle of "Hotels": the slot between Flights and Hotels.
      await dragTo(shell, row("tab-food"), await centre(row("tab-hotels"), -10), async () => {
        await capture(shell, "11-drag-between-members.png");
      });
      await expect.poll(members).toEqual(["tab-flights", "tab-food", "tab-hotels", "tab-fresh"]);

      // ── 3. Within the group: the last tab to its head (just under the header) ──
      await dragTo(shell, row("tab-fresh"), await centre(row("tab-flights"), -10));
      await expect.poll(members).toEqual(["tab-fresh", "tab-flights", "tab-food", "tab-hotels"]);

      // ── 4. Out of the group, down among the day's rows ──
      await dragTo(shell, row("tab-hotels"), await centre(row("tab-news"), 10));
      await expect.poll(members).toEqual(["tab-fresh", "tab-flights", "tab-food"]);
      const after = await snapshot(shell);
      const order = after.tabs.filter((tab) => tab.anchorId === null).map((tab) => tab.id);
      // Hotels is a loose tab again, right after the news story it was set down under.
      expect(order.indexOf("tab-hotels")).toBe(order.indexOf("tab-news") + 1);
      await capture(shell, "12-after-drags.png");

      // ── 5. The group itself still drags as one unit, to the top of the day's rows ──
      await api(shell, (pistachio) => pistachio.tabGroupCommand({ type: "setOpen", groupId: "g-trip", open: false }));
      await shell.mouse.move(900, 500);
      await expect(group.getByTestId("tab-group-members")).toHaveCount(0);
      await dragTo(shell, header, await centre(row("tab-active"), -10));
      await expect
        .poll(async () => (await snapshot(shell)).tabs.filter((tab) => tab.anchorId === null).map((tab) => tab.id).slice(0, 4))
        .toEqual(["tab-fresh", "tab-flights", "tab-food", "tab-active"]);
      expect(await members()).toEqual(["tab-fresh", "tab-flights", "tab-food"]);
    } finally {
      await app?.close();
    }
  });
});
