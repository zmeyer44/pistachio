/**
 * Tidy end to end (docs/tab-tidy.md): idle tabs are archived, related tabs
 * become a group that opens on hover, a group opens as a split view and
 * closes into the archive, the archive restores, favorites go home, and one
 * Undo takes a whole run back.
 *
 * Age is seeded, not waited for: the profile's tab-session.json carries tabs
 * whose `lastActiveAt` is a day old, which is exactly what a morning launch
 * looks like. The model is a script (`PISTACHIO_TIDY_SCRIPT`) that names tabs
 * by their titles. Restored tabs sleep until shown, so nothing here touches
 * the network but the demo pages the app serves itself.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { noticePage, pageFirst, shellReady } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/tab-tidy");
const HOUR = 3_600_000;

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", suffix),
  ].find((candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")));
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

async function seedProfile(): Promise<string> {
  const userData = await mkdtemp(join(tmpdir(), "pistachio-tab-tidy-"));
  const now = Date.now();
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst({ onboarding: { completed: true, completedAt: null } })));
  await writeFile(
    join(userData, "tab-session.json"),
    JSON.stringify({
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
    }),
  );
  await writeFile(
    join(userData, "sidebar.json"),
    JSON.stringify({ version: 1, spaces: { work: { favorites: [{ id: FAVORITE_ID, url: FAVORITE_HOME, title: "Vendors", faviconUrl: null }], entries: [] } } }),
  );
  return userData;
}

function api<T>(shell: Page, call: (pistachio: PistachioApi) => Promise<T>): Promise<T> {
  return shell.evaluate(`(${call.toString()})(window.pistachio)`) as Promise<T>;
}

const snapshot = (shell: Page): Promise<ShellSnapshot> => api(shell, (pistachio) => pistachio.getSnapshot());

const dayTitles = async (shell: Page): Promise<string[]> => {
  const state = await snapshot(shell);
  return state.tabs.filter((tab) => tab.anchorId === null).map((tab) => tab.title);
};

test("tidy archives idle tabs, groups related ones, resets favorites, and can be undone", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  await mkdir(screenshotDirectory, { recursive: true });
  const userData = await seedProfile();
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      cwd: process.cwd(),
      executablePath,
      env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData, PISTACHIO_TIDY_SCRIPT: JSON.stringify({ ...SCRIPT, delayMs: 1_500 }) },
    });
    const shell = await shellReady(app);
    const list = shell.getByTestId("sidebar-tab-list");
    await expect(list.getByTestId("human-tab")).toHaveCount(8);
    await shell.screenshot({ path: join(screenshotDirectory, "01-before.png") });

    // ── 1. Tidy now ────────────────────────────────────────────────────────
    await shell.getByTestId("section-header-live").hover();
    await shell.getByTestId("tidy-tabs-button").click();
    // While the run is out, the live section says so: the header reads
    // "Tidying tabs…" and the rows are marked busy under a sweeping light.
    await expect(shell.getByTestId("section-busy-live")).toHaveText("Tidying tabs…");
    await expect(shell.locator("#sidebar-section-live")).toHaveAttribute("aria-busy", "true");
    await shell.waitForTimeout(400); // past the rows' fade, for the screenshot
    await shell.screenshot({ path: join(screenshotDirectory, "01b-tidying.png") });
    const notices = await noticePage(app);
    const card = notices.locator('[data-testid="notice-card"][data-depth="0"]');
    // Hotels stays (grouped with fresh tabs); desk A + B and the news story go: 3 archived, 1 group made.
    await expect(card).toContainText("Archived 3 tabs · made 1 group");
    await expect(card.getByRole("button", { name: "Undo" })).toBeVisible();
    await expect(shell.getByTestId("section-busy-live")).toHaveCount(0);
    await expect(shell.locator("#sidebar-section-live")).toHaveAttribute("aria-busy", "false");
    await notices.screenshot({ path: join(screenshotDirectory, "02-notice.png") });

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
    await shell.screenshot({ path: join(screenshotDirectory, "03-tidied-collapsed.png") });

    // The favorite went home — asleep, re-addressed, its old page one Back away.
    const favorite = (await snapshot(shell)).tabs.find((tab) => tab.anchorId === FAVORITE_ID);
    expect(favorite?.url).toBe(FAVORITE_HOME);

    // ── 2. Hover opens the group in place; leaving closes it ────────────────
    await group.getByTestId("tab-group-header").hover();
    await expect(group.getByTestId("tab-group-members").getByTestId("human-tab")).toHaveCount(3);
    await shell.screenshot({ path: join(screenshotDirectory, "04-group-hover-open.png") });
    await shell.mouse.move(900, 500);
    await expect(group.getByTestId("tab-group-members")).toHaveCount(0);

    // ── 3. The group's menu: colour, rename ─────────────────────────────────
    await group.getByTestId("tab-group-header").click({ button: "right" });
    const menu = shell.getByTestId("context-menu");
    await expect(menu.getByRole("menuitem", { name: "Open as split view" })).toBeVisible();
    await shell.screenshot({ path: join(screenshotDirectory, "05-group-menu.png") });
    await menu.getByTestId("group-color-amber").click();
    await expect(group).toHaveAttribute("data-group-color", "amber");
    await group.getByTestId("tab-group-header").dblclick();
    await shell.getByTestId("tab-group-name-input").fill("Portugal");
    await shell.getByTestId("tab-group-name-input").press("Enter");
    await expect(group.getByTestId("tab-group-title")).toHaveText("Portugal");
    // Renaming made it the person's own.
    expect((await snapshot(shell)).tabGroups[0]).toMatchObject({ title: "Portugal", color: "amber", origin: "manual" });

    // ── 4. Open the group as a split view ───────────────────────────────────
    await group.getByTestId("tab-group-header").hover();
    await group.getByTestId("tab-group-split").click();
    await expect.poll(async () => (await snapshot(shell)).visibleTabIds.length).toBe(3);
    const split = await snapshot(shell);
    expect(split.splitMode).toBe("grid");
    expect([...split.visibleTabIds].sort()).toEqual(["tab-flights", "tab-food", "tab-hotels"]);
    // It holds tabs in view, so it stays open without the pointer.
    await shell.mouse.move(900, 500);
    await expect(group.getByTestId("tab-group-members")).toHaveCount(1);
    await shell.screenshot({ path: join(screenshotDirectory, "06-group-as-split.png") });
    // Its chevron folds it away anyway — the tabs in view and the pointer on it notwithstanding — and opens it again.
    await group.getByTestId("tab-group-header").hover();
    await expect(group.getByTestId("tab-group-toggle")).toHaveAttribute("aria-label", "Collapse group");
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
    await shell.screenshot({ path: join(screenshotDirectory, "07-archive.png") });
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
    await shell.screenshot({ path: join(screenshotDirectory, "08-restored-group.png") });

    // ── 7. Groups survive a restart ────────────────────────────────────────
    await app.close();
    app = await electron.launch({ args: ["."], cwd: process.cwd(), executablePath, env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData } });
    const again = await shellReady(app);
    await expect(again.getByTestId("sidebar-tab-list").getByTestId("tab-group")).toHaveCount(2);
    expect((await snapshot(again)).tabGroups.map((candidate) => candidate.title).sort()).toEqual(["Desk research", "Portugal"]);
  } finally {
    await app?.close();
  }
});

test("one Undo takes a whole tidy back", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  await mkdir(screenshotDirectory, { recursive: true });
  const userData = await seedProfile();
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      cwd: process.cwd(),
      executablePath,
      env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData, PISTACHIO_TIDY_SCRIPT: JSON.stringify(SCRIPT) },
    });
    const shell = await shellReady(app);
    const before = await dayTitles(shell);
    expect(before).toHaveLength(8);

    await api(shell, (pistachio) => pistachio.tidy({ type: "run" }));
    expect(await dayTitles(shell)).toHaveLength(5);
    const status = await api(shell, (pistachio) => pistachio.tidy({ type: "status" }));
    expect(status).toMatchObject({ type: "status", canUndo: true });

    await api(shell, (pistachio) => pistachio.tidy({ type: "undo" }));
    // Every tab is back, in the order it was in, and the group is gone.
    expect(await dayTitles(shell)).toEqual(before);
    const state = await snapshot(shell);
    expect(state.tabGroups).toEqual([]);
    expect(state.tabs.find((tab) => tab.anchorId === FAVORITE_ID)?.url).toBe("pistachio://demo/vendors/atlas-medical");
    const archived = await api(shell, (pistachio) => pistachio.tabArchive({ type: "list", spaceId: "work" }));
    expect(archived).toMatchObject({ type: "list", entries: [] });
    await shell.screenshot({ path: join(screenshotDirectory, "09-after-undo.png") });
  } finally {
    await app?.close();
  }
});

test("tidy runs from the sidebar menu and from its keyboard shortcut", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  await mkdir(screenshotDirectory, { recursive: true });
  const userData = await seedProfile();
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      cwd: process.cwd(),
      executablePath,
      env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData, PISTACHIO_TIDY_SCRIPT: JSON.stringify(SCRIPT) },
    });
    const shell = await shellReady(app);
    const list = shell.getByTestId("sidebar-tab-list");
    await expect(list.getByTestId("human-tab")).toHaveCount(8);

    // ── The sidebar menu: "Tidy tabs", with its shortcut beside it ──
    await shell.getByTestId("sidebar-menu-button").click();
    const item = shell.getByTestId("tidy-tabs-menu-item");
    await expect(item).toBeVisible();
    await expect(item).toContainText("Tidy tabs");
    await expect(item).toContainText("K");
    await shell.screenshot({ path: join(screenshotDirectory, "13-sidebar-menu.png") });
    await item.click();
    const notices = await noticePage(app);
    const card = notices.locator('[data-testid="notice-card"][data-depth="0"]');
    await expect(card).toContainText("Archived 3 tabs · made 1 group");
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
    await expect(notices.locator('[data-testid="notice-card"][data-phase="live"]').filter({ hasText: "Made 2 groups" })).toBeVisible();
    expect((await snapshot(shell)).tabGroups.map((candidate) => candidate.title).sort()).toEqual(["Desk research", "Lisbon trip"]);
    expect(await dayTitles(shell)).toHaveLength(8);

    // The binding is a setting like any other.
    const settings = await api(shell, (pistachio) => pistachio.getSettings());
    expect(settings.shortcuts.tidyTabs).toBe("Mod+Shift+K");
  } finally {
    await app?.close();
  }
});

test("undo restores order and never duplicates; a new tab makes a group yours; a tab moved to another Space leaves its group behind", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await seedProfile();
  // Flights and Fresh reading sit far apart in the row, so grouping them MOVES one of them.
  const script = { groups: [{ title: "Mix", titles: ["Flights to Lisbon", "Fresh reading"] }] };
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      cwd: process.cwd(),
      executablePath,
      env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData, PISTACHIO_TIDY_SCRIPT: JSON.stringify(script) },
    });
    const shell = await shellReady(app);
    await expect(shell.getByTestId("sidebar-tab-list").getByTestId("human-tab")).toHaveCount(8);
    const before = (await dayTitles(shell)).slice(1);
    expect(before).toEqual(["Flights to Lisbon", "Hotels in Alfama", "Lisbon food guide", "Standing desk A", "Standing desk B", "Old news story", "Fresh reading"]);

    // ── Undo: the row's order, and no second copy of what was already restored ──
    await api(shell, (pistachio) => pistachio.tidy({ type: "run" }));
    // Hotels, both desks and the news story were idle and in no group: archived. Fresh reading was gathered up beside Flights.
    expect((await dayTitles(shell)).slice(1)).toEqual(["Flights to Lisbon", "Fresh reading", "Lisbon food guide"]);
    const listed = await api(shell, (pistachio) => pistachio.tabArchive({ type: "list", spaceId: "work" }));
    const news = listed.type === "list" ? listed.entries.find((entry) => entry.kind === "tab" && entry.tab.title === "Old news story") : undefined;
    if (news === undefined) throw new Error("the news story was not archived");
    await shell.evaluate((entryId) => (window as unknown as { pistachio: PistachioApi }).pistachio.tabArchive({ type: "restore", entryId }), news.id);
    await api(shell, (pistachio) => pistachio.selectTab("tab-active"));
    await api(shell, (pistachio) => pistachio.tidy({ type: "undo" }));
    const after = (await dayTitles(shell)).slice(1);
    // Everything is back where it was — Fresh reading at the end again, not left beside Flights — and the
    // story the person had already restored is there ONCE, where they restored it to (the end).
    expect(after.filter((title) => title.includes("news") || title.includes("Northstar")).length).toBe(1);
    expect(after.filter((title) => !title.includes("news") && !title.includes("Northstar"))).toEqual([
      "Flights to Lisbon",
      "Hotels in Alfama",
      "Lisbon food guide",
      "Standing desk A",
      "Standing desk B",
      "Fresh reading",
    ]);
    expect((await snapshot(shell)).tabGroups).toEqual([]);

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

test("a group made by hand is named from its tabs — unless the person names it first, or nobody can", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  await mkdir(screenshotDirectory, { recursive: true });

  /** Select two day tabs and choose "Group selected tabs", as a person would. */
  const groupTwo = async (shell: Page): Promise<void> => {
    const list = shell.getByTestId("sidebar-tab-list");
    await list.locator('[data-tab-id="tab-flights"]').click({ modifiers: ["Meta"] });
    await list.locator('[data-tab-id="tab-hotels"]').click({ modifiers: ["Meta"] });
    await list.locator('[data-tab-id="tab-hotels"]').click({ button: "right" });
    await shell.getByTestId("context-menu").getByRole("menuitem", { name: "Group selected tabs" }).click();
  };
  const launch = async (script: unknown): Promise<{ app: ElectronApplication; shell: Page }> => {
    const userData = await seedProfile();
    const app = await electron.launch({
      args: ["."],
      cwd: process.cwd(),
      executablePath,
      env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData, ...(script === undefined ? {} : { PISTACHIO_TIDY_SCRIPT: JSON.stringify(script) }) },
    });
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
    await shell.screenshot({ path: join(screenshotDirectory, "14-naming.png") });
    await expect(group.getByTestId("tab-group-title")).toHaveText("Lisbon trip");
    await expect(shell.getByTestId("tab-group-name-input")).toHaveCount(0);
    expect((await snapshot(shell)).tabGroups[0]).toMatchObject({ title: "Lisbon trip", origin: "manual", tabIds: ["tab-flights", "tab-hotels"] });

    // ── 2. The person's name stands: renamed while the model is still thinking, its answer is dropped. ──
    await api(shell, (pistachio) => pistachio.tabGroupCommand({ type: "create", id: "g-mine", tabIds: ["tab-food", "tab-fresh"] }));
    expect((await snapshot(shell)).tabGroups.find((candidate) => candidate.id === "g-mine")?.naming).toBe(true);
    await api(shell, (pistachio) => pistachio.tabGroupCommand({ type: "rename", groupId: "g-mine", title: "Mine" }));
    await shell.waitForTimeout(900);
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
    await expect(input).toHaveValue("New group");
  } finally {
    await running.app.close();
  }

  // ── 4. Nobody to ask (no model here; the same as signed out or switched off): the field at once, as it always was. ──
  running = await launch(undefined);
  try {
    const { shell } = running;
    await groupTwo(shell);
    await expect(shell.getByTestId("tab-group-name-input")).toHaveValue("New group");
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
  await new Promise((done) => setTimeout(done, 350));
  const box = await from.boundingBox();
  if (box === null) throw new Error("drag source has no box");
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await shell.mouse.move(startX, startY);
  await shell.mouse.down();
  // Past the 5px threshold first, then to the target in steps so every row on the way sees a move.
  await shell.mouse.move(startX, startY + 8, { steps: 2 });
  await shell.mouse.move(startX, to.y, { steps: 12 });
  await new Promise((done) => setTimeout(done, 120));
  await beforeDrop?.();
  await shell.mouse.up();
}

// Once a drag begins the native drag layer holds the machine's REAL pointer,
// and relays it: a person moving their mouse over this window while the spec
// runs steers the drag (confirmed 2026-09-19 by logging the samples — every
// failing run carried `native` moves, no passing run did). Every drag spec
// shares this; on a machine in use, a retry is the honest remedy.
test.describe.configure({ retries: 2 });

test("tabs drag into a tab group, to a place within it, and out of it again", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  await mkdir(screenshotDirectory, { recursive: true });
  const userData = await seedProfile();
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ args: ["."], cwd: process.cwd(), executablePath, env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData } });
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
      await shell.screenshot({ path: join(screenshotDirectory, "10-drag-into-closed-group.png") });
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
      await shell.screenshot({ path: join(screenshotDirectory, "11-drag-between-members.png") });
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
    await shell.screenshot({ path: join(screenshotDirectory, "12-after-drags.png") });

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
