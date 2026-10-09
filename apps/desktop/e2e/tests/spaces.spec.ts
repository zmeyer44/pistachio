/**
 * Spaces end to end (docs/spaces.md): every listed tab is in one, a space
 * may stand empty, and which is current is main's — the desk always shows it.
 * New space from the sidebar's slot is an empty space, current at once, its
 * name field open, and its desk the empty mark; a row let go on its header
 * joins it, its window out; its last tab closed, it stays (it is the
 * person's), empty where it stood. A loose space goes with its last tab and
 * the desk passes to the space of the tab used last. Files dropped on an
 * empty desk are its space's, and keep it; Close space files it in the
 * archive and Restore brings it back by its id, its Stack with it. Tidy
 * never touches the current space. A relaunch comes back on the space that
 * was current, its windows where they were.
 *
 * The engine's and main's arithmetic (beforeUnit, the reconcile, the cold
 * start) is spaces.test, tab-groups.test and desk-engine.test's.
 */

import { expect, test, type ElectronApplication, type JSHandle, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import type { ArchiveEntryView } from "@pistachio/shell-contracts/tab-archive";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { launchApp, newProfile } from "./app";
import { nextFrames, settled as chromeSettled } from "./chrome-harness";
import {
  api,
  box,
  center,
  createGroup,
  groupSelector,
  INVOICES,
  launchDesk,
  openTabs,
  rowSelector,
  screenshots,
  selectTab,
  settled,
  snapshot,
  tabGroupCommand,
  VENDOR,
  windowSelector,
} from "./desk-harness";
import { pageFirst, shellReady } from "./windows";

const capture = screenshots("spaces");
const NORTH = "pistachio://demo/invoices?page=north";
const SOUTH = "pistachio://demo/invoices?page=south";

/** The current space (main's), as the snapshot lists it: a drawn one, a loose tab's, or a page's. */
async function currentSpace(shell: Page): Promise<TabGroupInfo | null> {
  const now = await snapshot(shell);
  const id = now.currentGroupId ?? null;
  return [...now.tabGroups, ...(now.looseGroups ?? []), ...(now.anchorGroups ?? [])].find((group) => group.id === id) ?? null;
}

/** Close a tab, as its row's × does. */
function closeTab(shell: Page, tabId: string): Promise<void> {
  return shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(id), tabId);
}

/** The day's row units as the sidebar draws them, top to bottom: a tab's row by its tab, a space's by its id. */
function dayUnits(shell: Page): Promise<string[]> {
  return shell.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="sidebar-tab-list"] [data-row-kind="tab"], [data-testid="sidebar-tab-list"] [data-row-kind="group"]')].map((row) =>
      row.dataset["rowKind"] === "group" ? `group:${row.dataset["groupId"] ?? ""}` : `tab:${row.dataset["tabId"] ?? ""}`,
    ),
  );
}

/**
 * A row dragged in the sidebar and let go on a target: past the drag's threshold first, then to the target in steps —
 * and onto it again where it is once the rows have closed up under the lifted row, until it holds still under the
 * pointer.
 */
async function dragRow(shell: Page, selector: string, target: string, beforeDrop?: () => Promise<void>): Promise<void> {
  await chromeSettled(shell.getByTestId("sidebar-tab-list"));
  const from = center(await box(shell, selector));
  await shell.mouse.move(from.x, from.y);
  await shell.mouse.down();
  await shell.mouse.move(from.x, from.y + 8, { steps: 2 });
  let to = center(await box(shell, target));
  for (let step = 1; step <= 12; step += 1) {
    await shell.mouse.move(from.x + ((to.x - from.x) * step) / 12, from.y + 8 + ((to.y - from.y - 8) * step) / 12);
    await shell.waitForTimeout(16);
  }
  for (let tries = 0; tries < 5; tries += 1) {
    await chromeSettled(shell.getByTestId("sidebar-tab-list"));
    const now = center(await box(shell, target));
    if (Math.abs(now.y - to.y) < 2) break;
    to = now;
    await shell.mouse.move(to.x, to.y, { steps: 4 });
  }
  await nextFrames(shell);
  await beforeDrop?.();
  await shell.mouse.up();
}

/** The archive's entries for the Profile in use, newest first. */
async function archived(shell: Page): Promise<ArchiveEntryView[]> {
  const listed = await api(shell, (pistachio) => pistachio.getSnapshot().then((now) => pistachio.tabArchive({ type: "list", spaceId: now.activeSpaceId })));
  if (listed.type !== "list") throw new Error("no archive listing");
  return listed.entries;
}

/** A text file as a drag carries it, made in the shell's page. */
function textFile(shell: Page, name: string, text: string): Promise<JSHandle<DataTransfer>> {
  return shell.evaluateHandle(
    ({ name, text }) => {
      const data = new DataTransfer();
      data.items.add(new File([text], name, { type: "text/plain" }));
      return data;
    },
    { name, text },
  );
}

/** Files dragged over the desk and let go on it at a point: its drop zone comes up first, as for a person's drag. */
async function dropOnDesk(shell: Page, data: JSHandle<DataTransfer>, at: { x: number; y: number }): Promise<void> {
  await shell.dispatchEvent(".desk-stage", "dragenter", { dataTransfer: data, clientX: at.x, clientY: at.y });
  await expect(shell.locator('[data-testid="desk-drop-zone"][data-up]')).toHaveCount(1);
  for (const type of ["dragenter", "dragover", "drop"]) await shell.dispatchEvent('[data-testid="desk-drop-zone"]', type, { dataTransfer: data, clientX: at.x, clientY: at.y });
}

test.describe.serial("a space of one's own: New space, a row let in, its last tab closed", { tag: ["@desk", "@sidebar", "@tabs"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let invoices: string, vendor: string, north: string;
  let lisbon: string;

  test.beforeAll(async () => {
    // The whole sidebar: its foot row holds New space beside New tab and New folder.
    ({ app, shell } = await launchDesk({ name: "spaces", sidebar: "whole" }));
    [invoices, vendor, north] = (await openTabs(shell, [INVOICES, VENDOR, NORTH])) as [string, string, string];
    await settled(shell, app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("New space from the sidebar's slot: an empty space, named with its field open, current at once, its desk the empty mark", async () => {
    // Every listed tab is in a space: these three are loose ones, the first the desk's.
    const before = await snapshot(shell);
    for (const tabId of [invoices, vendor, north]) expect(before.looseGroups?.some((group) => group.tabIds.includes(tabId))).toBe(true);
    expect(before.activeTabId).toBe(invoices);

    // ── 1. The foot row's third slot, on hover beside New tab and New folder ─
    await shell.getByTestId("new-tab-button").hover();
    await shell.getByTestId("new-space-button").click();
    await expect.poll(async () => (await currentSpace(shell))?.tabIds.length ?? null).toBe(0);
    const made = (await currentSpace(shell))!;
    lisbon = made.id;
    expect(made).toMatchObject({ title: "New space", origin: "manual" });
    expect(made.loose).toBeUndefined();
    // Nothing is in use: the keyboard is the shell's.
    expect((await snapshot(shell)).activeTabId).toBeNull();
    // Its row: the name field open on it, the row empty, the current one.
    const row = shell.locator(groupSelector(lisbon));
    await expect(row).toHaveAttribute("data-empty", "");
    await expect(row).toHaveAttribute("data-current", "");
    const name = row.getByTestId("tab-group-name-input");
    await expect(name).toBeFocused();
    // The desk: the space's, with nothing out — the empty mark, its name and what can be done.
    await expect(shell.locator(`.desk-stage[data-phase="open"][data-group-id="${lisbon}"][data-empty]`)).toHaveCount(1);
    await expect(shell.getByTestId("desk-window")).toHaveCount(0);
    await expect(shell.getByTestId("desk-empty")).toBeVisible();
    await expect(shell.getByTestId("desk-empty-title")).toHaveText("New space");
    await expect(shell.getByTestId("desk-empty-new-tab")).toBeVisible();
    await capture(app, shell, "01-new-space.png");

    // ── 2. Named: the row and the desk say so ─
    await name.fill("Lisbon");
    await name.press("Enter");
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === lisbon)?.title).toBe("Lisbon");
    await expect(name).toHaveCount(0);
    await expect(shell.getByTestId("desk-empty-title")).toHaveText("Lisbon");
    await capture(app, shell, "02-named.png");
  });

  test("a row let go on the empty space's header joins it, and its window comes out on the space's desk", async () => {
    // (Held over it until it says it takes the row.)
    await dragRow(shell, rowSelector(vendor), `${groupSelector(lisbon)} [data-testid="tab-group-header"]`, async () => {
      await expect(shell.locator(groupSelector(lisbon))).toHaveAttribute("data-receiving", "");
    });
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === lisbon)?.tabIds).toEqual([vendor]);
    // Its loose space is gone with it; the space it joined is current, its window out.
    await expect.poll(async () => (await snapshot(shell)).looseGroups?.some((group) => group.tabIds.includes(vendor)) ?? false).toBe(false);
    expect((await snapshot(shell)).currentGroupId).toBe(lisbon);
    await expect(shell.locator(windowSelector(vendor))).toHaveCount(1);
    await expect(shell.getByTestId("desk-empty")).toHaveCount(0);
    await expect(shell.locator(`.desk-stage[data-group-id="${lisbon}"][data-empty]`)).toHaveCount(0);
    await shell.mouse.move(900, 500);
    await settled(shell, app);
    await capture(app, shell, "03-row-joined.png");
  });

  test("its last tab closed, the space stays — it is the person's — empty where its row stood, and the desk shows the empty mark", async () => {
    const units = await dayUnits(shell);
    expect(units).toContain(`group:${lisbon}`);
    await selectTab(shell, vendor);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(vendor);
    await closeTab(shell, vendor);
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.id === vendor)).toBe(false);
    // Still there, empty, still current; nothing in use.
    const kept = (await snapshot(shell)).tabGroups.find((group) => group.id === lisbon);
    expect(kept).toMatchObject({ title: "Lisbon", tabIds: [] });
    expect((await snapshot(shell)).currentGroupId).toBe(lisbon);
    expect((await snapshot(shell)).activeTabId).toBeNull();
    await expect(shell.getByTestId("desk-empty")).toBeVisible();
    await expect(shell.getByTestId("desk-empty-title")).toHaveText("Lisbon");
    // Where it stood: the row has not jumped to the end (TabGroupInfo.beforeUnit).
    await expect(shell.locator(groupSelector(lisbon))).toHaveAttribute("data-empty", "");
    await expect.poll(() => dayUnits(shell)).toEqual(units.filter((unit) => unit !== `tab:${vendor}`));
    await capture(app, shell, "04-last-tab-closed.png");
  });

  test("a loose space's last tab closed: the space goes with it, and the desk passes to the space of the tab used last", async () => {
    // North in use, then the invoices: the tab used last before the invoices is north.
    await selectTab(shell, north);
    await expect(shell.locator(windowSelector(north))).toHaveCount(1);
    await selectTab(shell, invoices);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(invoices);
    const looseOfInvoices = (await currentSpace(shell))!;
    expect(looseOfInvoices.loose).toBe(true);
    await settled(shell, app);
    await closeTab(shell, invoices);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(north);
    const now = await snapshot(shell);
    expect([...now.tabGroups, ...(now.looseGroups ?? [])].some((group) => group.id === looseOfInvoices.id)).toBe(false);
    expect((await currentSpace(shell))?.tabIds).toEqual([north]);
    await expect(shell.locator(`.desk-stage[data-phase="open"][data-group-id="${now.currentGroupId!}"]`)).toHaveCount(1);
    await expect(shell.locator(windowSelector(north))).toHaveCount(1);
    // The person's empty space stays where it was, current no more.
    await expect(shell.locator(groupSelector(lisbon))).not.toHaveAttribute("data-current", "");
    expect((await snapshot(shell)).tabGroups.find((group) => group.id === lisbon)?.tabIds).toEqual([]);
    await settled(shell, app);
    await capture(app, shell, "05-loose-gone-passed.png");
  });
});

test.describe.serial("an empty space's Stack: kept, filed and restored whole, and a relaunch", { tag: ["@desk", "@sidebar", "@tabs"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let userData: string;
  let home: string;
  let spare: string | null = null;
  let kept: string;

  test.beforeAll(async () => {
    ({ app, shell, userData } = await launchDesk({ name: "spaces-stack", sidebar: "whole" }));
    home = (await snapshot(shell)).activeTabId!;
    await settled(shell, app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("files dropped on an empty desk are its space's, and keep it standing when it is left", async () => {
    // ── 1. The Profile's last tab closed: the desk shows a fresh empty space, so there is always one current ─
    await closeTab(shell, home);
    await expect.poll(async () => (await snapshot(shell)).tabs.length).toBe(0);
    await expect.poll(async () => (await snapshot(shell)).currentGroupId ?? null).not.toBeNull();
    expect((await snapshot(shell)).activeTabId).toBeNull();
    kept = (await snapshot(shell)).currentGroupId!;
    await expect(shell.locator(`.desk-stage[data-phase="open"][data-group-id="${kept}"]`)).toHaveCount(1);
    await expect(shell.getByTestId("desk-empty")).toBeVisible();
    await settled(shell, app);
    await capture(app, shell, "10-no-tab-left.png");

    // ── 2. A file let go on it: the space's Stack holds it, and its window comes out ─
    const stage = await box(shell, ".desk-stage");
    await dropOnDesk(shell, await textFile(shell, "itinerary.txt", "Friday: Alfama\nSaturday: Sintra\n"), { x: stage.x + stage.width * 0.4, y: stage.y + stage.height * 0.4 });
    await expect
      .poll(async () => (await api(shell, (pistachio) => pistachio.getGroupContexts())).find((context) => context.groupId === kept)?.items.map((item) => item.kind) ?? [])
      .toEqual(["file"]);
    await expect(shell.locator('[data-testid="desk-window"][data-window-kind="file"]')).toHaveCount(1);
    await shell.mouse.move(stage.x + stage.width * 0.8, stage.y + stage.height * 0.8);
    await settled(shell, app);

    // ── 3. Left for a page of another space: it stays, empty of tabs, its Stack kept — the person's now ─
    [spare] = (await openTabs(shell, [SOUTH])) as [string];
    await selectTab(shell, spare);
    await expect(shell.locator(`.desk-stage[data-phase="open"]:not([data-group-id="${kept}"])`)).toHaveCount(1);
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === kept)?.tabIds ?? null).toEqual([]);
    await expect(shell.locator(groupSelector(kept))).toHaveAttribute("data-empty", "");
    await settled(shell, app);
    await capture(app, shell, "11-kept-by-its-stack.png");

    // ── 4. Back: its file's window where it was ─
    await tabGroupCommand(shell, { type: "select", groupId: kept });
    await expect(shell.locator(`.desk-stage[data-phase="open"][data-group-id="${kept}"]`)).toHaveCount(1);
    await expect(shell.locator('[data-testid="desk-window"][data-window-kind="file"]')).toHaveCount(1);
    expect((await snapshot(shell)).activeTabId).toBeNull();
  });

  test("Close space files an empty space whole, and Restore brings it back by its id, its Stack with it", async () => {
    // Its menu, from its header.
    await shell.locator(`${groupSelector(kept)} [data-testid="tab-group-header"]`).click({ button: "right" });
    const menu = shell.getByTestId("context-menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "Close space", exact: true }).click();
    await expect.poll(async () => (await snapshot(shell)).tabGroups.some((group) => group.id === kept)).toBe(false);
    // The desk passed on: the tab used last's space.
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(spare);
    // One entry in the archive, the space itself: its id, no tabs.
    const entry = (await archived(shell)).find((candidate) => candidate.kind === "group" && candidate.groupId === kept);
    expect(entry).toBeDefined();
    expect(entry?.kind === "group" ? entry.tabs : null).toEqual([]);

    // Restored: the same space, current, its Stack and its file's window back with it.
    await shell.evaluate((entryId) => (window as unknown as { pistachio: PistachioApi }).pistachio.tabArchive({ type: "restore", entryId }), entry!.id);
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === kept)?.tabIds ?? null).toEqual([]);
    await expect.poll(async () => (await snapshot(shell)).currentGroupId).toBe(kept);
    expect((await api(shell, (pistachio) => pistachio.getGroupContexts())).find((context) => context.groupId === kept)?.items.map((item) => (item.kind === "file" ? item.name : item.kind))).toEqual(["itinerary.txt"]);
    await expect(shell.locator(`.desk-stage[data-phase="open"][data-group-id="${kept}"]`)).toHaveCount(1);
    await expect(shell.locator('[data-testid="desk-window"][data-window-kind="file"]')).toHaveCount(1);
    await settled(shell, app);
    await capture(app, shell, "12-restored.png");
  });

  test("a relaunch comes back on the space that was current, its windows where they were", async () => {
    // A space of two windows, current: the one the app quits on.
    const [north, south] = (await openTabs(shell, [NORTH, SOUTH])) as [string, string];
    await createGroup(shell, "relaunch", [north, south], "Regions", "orange");
    await selectTab(shell, north);
    await expect(shell.locator('.desk-stage[data-phase="open"][data-group-id="relaunch"]')).toHaveCount(1);
    await shell.locator(rowSelector(south)).click();
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await shell.mouse.move(900, 500);
    await settled(shell, app);
    const left = { [north]: await box(shell, windowSelector(north)), [south]: await box(shell, windowSelector(south)) };
    const inUse = (await snapshot(shell)).activeTabId;
    // (The arrangement is kept as it changes, in the shell's storage.)
    await expect
      .poll(() => shell.evaluate(() => (JSON.parse(localStorage.getItem("pistachio.desk.v1") ?? "{}") as { saved?: Record<string, { windows: unknown[] }> }).saved?.["relaunch"]?.windows.length ?? 0))
      .toBe(2);
    await app.close();

    ({ app, shell } = await launchDesk({ name: "spaces-stack", userData }));
    await expect.poll(async () => (await snapshot(shell)).currentGroupId).toBe("relaunch");
    await expect(shell.locator('.desk-stage[data-phase="open"][data-group-id="relaunch"]')).toHaveCount(1);
    await expect(shell.getByTestId("desk-window")).toHaveCount(2);
    await settled(shell, app);
    for (const tabId of [north, south]) {
      const now = await box(shell, windowSelector(tabId));
      const was = left[tabId]!;
      for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(now[key] - was[key])).toBeLessThan(3);
    }
    expect((await snapshot(shell)).activeTabId).toBe(inUse);
    // The empty space with its Stack came back with the session too.
    expect((await snapshot(shell)).tabGroups.find((group) => group.id === kept)?.tabIds).toEqual([]);
    await capture(app, shell, "13-relaunched.png");
  });
});

/** A morning launch's tabs: two idle spaces Tidy made, the current one among them. */
async function launchIdle(): Promise<{ app: ElectronApplication; shell: Page }> {
  const HOUR = 3_600_000;
  const now = Date.now();
  const tab = (id: string, title: string, page: string, idleHours: number) => ({
    id,
    spaceId: "work",
    title,
    url: `pistachio://demo/invoices?page=${page}`,
    faviconUrl: null,
    anchorId: null,
    lastActiveAt: now - idleHours * HOUR,
  });
  const tabs = [tab("tab-a1", "Alpha one", "a1", 30), tab("tab-a2", "Alpha two", "a2", 31), tab("tab-b1", "Beta one", "b1", 32), tab("tab-b2", "Beta two", "b2", 33)];
  const group = (id: string, title: string, tabIds: string[]) => ({ id, title, color: "blue", tabIds, origin: "auto", open: false, createdAt: now - 40 * HOUR });
  const userData = await newProfile("spaces-tidy");
  const { app } = await launchApp({
    userData,
    name: "spaces-tidy",
    size: { width: 1440, height: 900 },
    clearOfCursor: true,
    settings: pageFirst({ onboarding: { completed: true, completedAt: null } }),
    files: {
      "tab-session.json": {
        version: 1,
        spaces: {
          work: {
            activeTabId: "tab-a1",
            recentTabIds: tabs.map((candidate) => candidate.id),
            splitGroups: [],
            tabs,
            tabGroups: [group("idle-a", "Alpha", ["tab-a1", "tab-a2"]), group("idle-b", "Beta", ["tab-b1", "tab-b2"])],
            currentGroupId: "idle-a",
          },
        },
      },
    },
    // No model: Tidy's own rule archives what is idle.
    env: { PISTACHIO_TIDY_SCRIPT: JSON.stringify({ groups: [] }) },
  });
  return { app, shell: await shellReady(app) };
}

test("Tidy leaves the current space alone: an idle space of Tidy's is archived, the one the desk shows is not", { tag: ["@desk", "@tabs"] }, async () => {
  const { app, shell } = await launchIdle();
  try {
    await expect.poll(async () => (await snapshot(shell)).currentGroupId).toBe("idle-a");
    await expect(shell.locator('.desk-stage[data-phase="open"][data-group-id="idle-a"]')).toHaveCount(1);
    await api(shell, (pistachio) => pistachio.tidy({ type: "run" }));
    // Beta, idle and Tidy's, goes into the archive whole; Alpha — as idle, but current — stays, its tabs with it.
    await expect.poll(async () => (await snapshot(shell)).tabGroups.map((group) => group.id)).toEqual(["idle-a"]);
    const now = await snapshot(shell);
    expect(now.tabGroups[0]?.tabIds).toEqual(["tab-a1", "tab-a2"]);
    expect(now.tabs.map((tab) => tab.id).sort()).toEqual(["tab-a1", "tab-a2"]);
    expect(now.currentGroupId).toBe("idle-a");
    expect((await archived(shell)).find((entry) => entry.kind === "group" && entry.group.title === "Beta")?.kind).toBe("group");
  } finally {
    await app.close();
  }
});
