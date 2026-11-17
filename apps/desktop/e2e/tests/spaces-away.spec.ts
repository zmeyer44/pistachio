/**
 * Spaces that are away, end to end (docs/primitives.md §2): a space sent
 * away from its menu leaves the rail whole — its tile, its tabs — and is
 * listed on the Away tile's card, said in a notice that would bring it back;
 * Bring back on the card brings it back as itself, in front: the same space
 * id, the same tabs under the same ids, in their order. Sent with a time to
 * come back at (no menu offers one: the agent's and an extension's — here
 * the shell's own command), the space in front passes the desk on, and main
 * brings it back by its own clock, never in front, and says so in a notice
 * whose Show chooses it.
 *
 * Across a restart (the second group, on a profile of its own): a space away
 * when Pistachio quits is in the file, away when it opens again, and comes
 * back the same space with the same tabs; one whose time came while
 * Pistachio was closed is back as it opens — main's clock asks what is due
 * at launch, nothing having "fired" meanwhile.
 *
 * The rules that refuse a send, the file, the clock across a sleep and the
 * notice's words are away-spaces.test, away.test and shell-ui's
 * away-spaces.test; this proves the wiring only the app has.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AwaySpaceInfo } from "@pistachio/shell-contracts/away";
import type { TabGroupCommand, TabGroupCommandResult } from "@pistachio/shell-contracts/tab-groups";
import { chooseSpace, createGroup, launchDesk, openTabs, railSpace, screenshots, settled, snapshot, VENDOR } from "./desk-harness";
import { noticePage } from "./windows";

const capture = screenshots("spaces-away");
const NORTH = "pistachio://demo/invoices?page=north";
const FOOTBALL = "football";

/** The active Profile's away spaces, as the snapshot lists them. */
async function away(shell: Page): Promise<AwaySpaceInfo[]> {
  return (await snapshot(shell)).awaySpaces ?? [];
}

/** A space command, with what main answered: a refusal comes back as a sentence (TabGroupCommandResult.refused). */
function command(shell: Page, body: TabGroupCommand): Promise<TabGroupCommandResult> {
  return shell.evaluate((sent) => (window as unknown as { pistachio: { tabGroupCommand(command: TabGroupCommand): Promise<TabGroupCommandResult> } }).pistachio.tabGroupCommand(sent), body);
}

/**
 * The window in front, so a notice main holds until someone is there to see it (index.ts startAwaySpaces, as Tidy's) is
 * said: focused as a person's click would — and where the Mac will not give it the keyboard (its screen locked, another
 * app in front), told that it has it, which is all main waits for.
 */
async function inFront(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible());
    if (window === undefined) return;
    window.focus();
    if (!window.isFocused()) window.emit("focus");
  });
}

test.describe.serial("a space sent away and brought back", { tag: ["@sidebar"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let vendor: string, north: string;

  test.beforeAll(async () => {
    ({ app, shell } = await launchDesk({ name: "spaces-away", sidebar: "whole" }));
    [vendor, north] = (await openTabs(shell, [VENDOR, NORTH])) as [string, string];
    // A space of the two, beside the desk's own (the first tab's, still in use).
    await createGroup(shell, FOOTBALL, [vendor, north], "Football", "green");
    await expect(railSpace(shell, FOOTBALL)).toHaveCount(1);
    await settled(shell, app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("Send away, from its menu: off the rail with its tabs, on the Away card; Bring back: the same space, the same tabs", async () => {
    const before = await snapshot(shell);
    expect(before.awaySpaces ?? []).toEqual([]);
    await expect(shell.getByTestId("rail-away")).toHaveCount(0);
    const inUse = before.activeTabId;

    // ── 1. Its menu, from its tile on the rail ─
    await railSpace(shell, FOOTBALL).click({ button: "right" });
    const menu = shell.getByTestId("context-menu");
    await expect(menu).toBeVisible();
    await capture(app, shell, "01-menu.png");
    await menu.getByRole("menuitem", { name: "Send away", exact: true }).click();

    // ── 2. Gone from the rail, whole: the space and its tabs; the desk where it was ─
    await expect.poll(async () => (await away(shell)).map((space) => space.id)).toEqual([FOOTBALL]);
    const now = await snapshot(shell);
    expect(now.tabGroups.some((group) => group.id === FOOTBALL)).toBe(false);
    expect(now.tabs.some((tab) => tab.id === vendor || tab.id === north)).toBe(false);
    expect(now.activeTabId).toBe(inUse);
    expect((await away(shell))[0]).toMatchObject({ id: FOOTBALL, title: "Football", color: "green", tabCount: 2, by: { kind: "person" } });
    expect((await away(shell))[0]?.until).toBeUndefined();
    await expect(railSpace(shell, FOOTBALL)).toHaveCount(0);

    // ── 3. Said, with the way back ─
    await inFront(app);
    const notices = await noticePage(app);
    const sent = notices.locator('[data-testid="notice-card"][data-phase="live"]').filter({ hasText: "“Football” is away" });
    await expect(sent).toBeVisible();
    await expect(sent.getByRole("button", { name: "Bring back" })).toBeVisible();

    // ── 4. The Away tile, and its card ─
    const tile = shell.getByTestId("rail-away");
    await expect(tile).toBeVisible();
    await expect(tile).toHaveAttribute("data-count", "1");
    await expect(tile).toHaveAccessibleName("1 space away");
    await tile.click();
    const card = shell.locator('[data-testid="away-card"][data-shown]');
    await expect(card).toHaveCount(1);
    await expect(tile).toHaveAttribute("aria-expanded", "true");
    const row = card.locator(`[data-testid="away-space"][data-group-id="${FOOTBALL}"]`);
    await expect(row).toContainText("Football");
    await expect(row.getByTestId("away-space-line")).toHaveText("Away · 2 tabs");
    await capture(app, shell, "02-away-card.png");

    // ── 5. Bring back: itself, in front ─
    await row.getByTestId("away-bring-back").click();
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === FOOTBALL)?.tabIds ?? null).toEqual([vendor, north]);
    await expect.poll(async () => (await snapshot(shell)).currentGroupId).toBe(FOOTBALL);
    const back = await snapshot(shell);
    expect(back.awaySpaces ?? []).toEqual([]);
    expect(back.tabs.filter((tab) => tab.id === vendor || tab.id === north).map((tab) => tab.id).sort()).toEqual([vendor, north].sort());
    expect(back.tabGroups.find((group) => group.id === FOOTBALL)).toMatchObject({ title: "Football", color: "green" });
    await expect(railSpace(shell, FOOTBALL)).toHaveCount(1);
    await expect(shell.getByTestId("rail-away")).toHaveCount(0);
    await expect(shell.getByTestId("away-card")).toHaveCount(0);
    await expect(shell.locator(`.desk-stage[data-phase="open"][data-group-id="${FOOTBALL}"]`)).toHaveCount(1);
    await settled(shell, app);
    await capture(app, shell, "03-back.png");
  });

  test("sent with a time to come back at: the desk passes on, main brings it back by its clock, and the notice shows it", async () => {
    // In front, so sending it away has a desk to pass on.
    if ((await snapshot(shell)).currentGroupId !== FOOTBALL) await chooseSpace(shell, FOOTBALL);

    // ── 1. Away, until a moment from now (the shell's own command: no menu offers a time) ─
    const answer = await command(shell, { type: "sendAway", groupId: FOOTBALL, until: Date.now() + 1_500 });
    expect(answer.refused).toBeUndefined();
    await expect
      .poll(async () => {
        const now = await snapshot(shell);
        return { away: (now.awaySpaces ?? []).map((space) => space.id), here: now.tabGroups.some((group) => group.id === FOOTBALL), front: now.currentGroupId === FOOTBALL };
      })
      .toEqual({ away: [FOOTBALL], here: false, front: false });

    // ── 2. Back by itself: the same space and tabs, and not in front ─
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === FOOTBALL)?.tabIds ?? null, { timeout: 20_000 }).toEqual([vendor, north]);
    const back = await snapshot(shell);
    expect(back.awaySpaces ?? []).toEqual([]);
    expect(back.currentGroupId).not.toBe(FOOTBALL);
    await expect(railSpace(shell, FOOTBALL)).toHaveCount(1);
    await expect(shell.getByTestId("rail-away")).toHaveCount(0);

    // ── 3. Said, and Show chooses it ─
    await inFront(app);
    const notices = await noticePage(app);
    const returned = notices.locator('[data-testid="notice-card"][data-phase="live"]').filter({ hasText: "“Football” is back" });
    await expect(returned).toBeVisible();
    await capture(app, shell, "04-is-back.png");
    await returned.getByRole("button", { name: "Show" }).click();
    await expect.poll(async () => (await snapshot(shell)).currentGroupId).toBe(FOOTBALL);
    await expect(shell.locator(`.desk-stage[data-phase="open"][data-group-id="${FOOTBALL}"]`)).toHaveCount(1);
  });

  test("a time already past is refused, in main's sentence, and the space stays", async () => {
    const answer = await command(shell, { type: "sendAway", groupId: FOOTBALL, until: Date.now() - 60_000 });
    expect(answer.refused).toBe("The time to come back has passed already.");
    expect((await snapshot(shell)).tabGroups.some((group) => group.id === FOOTBALL)).toBe(true);
    expect(await away(shell)).toEqual([]);
  });

  test("a space with a page that would not be kept away is refused, naming the tab, and stays whole", async () => {
    // An address longer than the session keeps of a tab: read back from the away file, the tab would be gone — its page closed.
    const [long] = (await openTabs(shell, [`${NORTH}&pad=${"a".repeat(2_100)}`])) as [string];
    await createGroup(shell, "long", [long], "Long", "blue");
    await expect(railSpace(shell, "long")).toHaveCount(1);
    const answer = await command(shell, { type: "sendAway", groupId: "long" });
    expect(answer.refused).toMatch(/^“.+” cannot be kept while its space is away\. Close that tab, then send the space away\.$/);
    // Nothing moved: the space is here with its tab, the page still open, and nothing is away.
    const now = await snapshot(shell);
    expect(now.tabGroups.find((group) => group.id === "long")?.tabIds).toEqual([long]);
    expect(now.tabs.find((tab) => tab.id === long)?.url.length).toBeGreaterThan(2_048);
    expect(await away(shell)).toEqual([]);
  });

  test("an older copy restored from the archive does not take the id of the space that is away: brought back, the space is itself", async () => {
    type Archive = { pistachio: { getSnapshot(): Promise<{ activeSpaceId: string }>; tabArchive(request: unknown): Promise<{ type: string; entries?: Array<{ id: string; kind: string; groupId?: string }> }> } };
    // A space closed into the archive; then here again under its id with a newer tab, the archive's entry unspent —
    // as a restore point from another device leaves it.
    const [older] = (await openTabs(shell, [`${NORTH}&copy=older`])) as [string];
    await createGroup(shell, "trip", [older], "Trip", "blue");
    await command(shell, { type: "close", groupId: "trip" });
    await expect.poll(async () => (await snapshot(shell)).tabGroups.some((group) => group.id === "trip")).toBe(false);
    const entries = await shell.evaluate(async () => {
      const api = (window as unknown as Archive).pistachio;
      const listed = await api.tabArchive({ type: "list", spaceId: (await api.getSnapshot()).activeSpaceId });
      return listed.entries ?? [];
    });
    const entry = entries.find((candidate) => candidate.kind === "group" && candidate.groupId === "trip");
    expect(entry).toBeDefined();
    const [newer] = (await openTabs(shell, [`${NORTH}&copy=newer`])) as [string];
    await createGroup(shell, "trip", [newer], "Trip", "blue");
    // Sent away with its newer tab — and then the older copy is restored from the archive.
    expect((await command(shell, { type: "sendAway", groupId: "trip" })).refused).toBeUndefined();
    await expect.poll(async () => (await away(shell)).map((space) => space.id)).toEqual(["trip"]);
    await shell.evaluate((entryId) => (window as unknown as Archive).pistachio.tabArchive({ type: "restore", entryId }), entry!.id);
    // The archive's copy is a space of its own, under another id: the one that is away is still away, and not here.
    await expect.poll(async () => (await snapshot(shell)).tabGroups.filter((group) => group.title === "Trip" && group.loose !== true).map((group) => group.id)).toHaveLength(1);
    expect((await snapshot(shell)).tabGroups.some((group) => group.id === "trip")).toBe(false);
    expect((await away(shell)).map((space) => space.id)).toEqual(["trip"]);
    // Brought back, it is itself: the newer tab it went away with.
    expect((await command(shell, { type: "bringBack", groupId: "trip" })).refused).toBeUndefined();
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === "trip")?.tabIds).toEqual([newer]);
    expect(await away(shell)).toEqual([]);
  });
});

/** The away file as it is on disk: each space's id, when it is due, and its tabs' ids. */
async function awayFile(userData: string): Promise<Array<{ id: string; until: number | null; tabIds: string[] }>> {
  let text: string;
  try {
    text = await readFile(join(userData, "away-spaces.json"), "utf8");
  } catch {
    return [];
  }
  const file = JSON.parse(text) as { spaces: Array<{ id: string; until?: number; held: { tabs: Array<{ id: string }> } }> };
  return file.spaces.map((space) => ({ id: space.id, until: space.until ?? null, tabIds: space.held.tabs.map((tab) => tab.id) }));
}

test.describe.serial("a space away across a restart", { tag: ["@sidebar"] }, () => {
  const TAXES = "taxes";
  let app: ElectronApplication;
  let shell: Page;
  let userData: string;
  let vendor: string, north: string;

  test.beforeAll(async () => {
    ({ app, shell, userData } = await launchDesk({ name: "spaces-away-restart", sidebar: "whole" }));
    [vendor, north] = (await openTabs(shell, [VENDOR, NORTH])) as [string, string];
    await createGroup(shell, TAXES, [vendor, north], "Taxes", "blue");
    await expect(railSpace(shell, TAXES)).toHaveCount(1);
    await settled(shell, app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("away when Pistachio quits: in the file, away when it opens again, and back as itself", async () => {
    // ── 1. Away, due in a minute — long after this test is done with it ─
    const until = Date.now() + 60_000;
    expect((await command(shell, { type: "sendAway", groupId: TAXES, until })).refused).toBeUndefined();
    await expect.poll(async () => (await away(shell)).map((space) => space.id)).toEqual([TAXES]);
    await app.close();

    // ── 2. The file holds it whole: for as long as it is away, the only copy of its tabs ─
    expect(await awayFile(userData)).toEqual([{ id: TAXES, until, tabIds: [vendor, north] }]);

    // ── 3. Opened again: still away, none of it in the window ─
    ({ app, shell } = await launchDesk({ name: "spaces-away-restart", userData }));
    await expect.poll(async () => (await away(shell)).map((space) => space.id)).toEqual([TAXES]);
    const now = await snapshot(shell);
    expect(now.tabGroups.some((group) => group.id === TAXES)).toBe(false);
    expect(now.tabs.some((tab) => tab.id === vendor || tab.id === north)).toBe(false);
    expect((await away(shell))[0]).toMatchObject({ id: TAXES, title: "Taxes", color: "blue", tabCount: 2, by: { kind: "person" }, until });
    await expect(railSpace(shell, TAXES)).toHaveCount(0);
    const tile = shell.getByTestId("rail-away");
    await expect(tile).toHaveAttribute("data-count", "1");

    // ── 4. Bring back, from its card: the same space, the same tabs under the same ids, in their order ─
    await tile.click();
    const row = shell.locator(`[data-testid="away-card"][data-shown] [data-testid="away-space"][data-group-id="${TAXES}"]`);
    await expect(row).toContainText("Taxes");
    await row.getByTestId("away-bring-back").click();
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === TAXES)?.tabIds ?? null).toEqual([vendor, north]);
    const back = await snapshot(shell);
    expect(back.awaySpaces ?? []).toEqual([]);
    expect(back.tabGroups.find((group) => group.id === TAXES)).toMatchObject({ title: "Taxes", color: "blue" });
    expect(back.tabs.filter((tab) => tab.id === vendor || tab.id === north).map((tab) => tab.url).sort()).toEqual([NORTH, VENDOR].sort());
    await expect(railSpace(shell, TAXES)).toHaveCount(1);
    await expect.poll(() => awayFile(userData)).toEqual([]);
    await settled(shell, app);
  });

  test("due while Pistachio was closed: back as it opens, by a clock that asks what is due", async () => {
    // ── 1. Away, due in a few seconds, and Pistachio quit before then: nothing is there to fire ─
    const until = Date.now() + 5_000;
    expect((await command(shell, { type: "sendAway", groupId: TAXES, until })).refused).toBeUndefined();
    await expect.poll(async () => (await away(shell)).map((space) => space.id)).toEqual([TAXES]);
    await app.close();
    // (Still away as it quit — else this would prove the timer, not the launch.)
    expect(await awayFile(userData)).toEqual([{ id: TAXES, until, tabIds: [vendor, north] }]);

    // ── 2. The time comes and goes with the app closed (the time itself is what is tested) ─
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, until - Date.now()) + 500));

    // ── 3. Opened again: back by itself, the same space and tabs, and nothing left in the file ─
    ({ app, shell } = await launchDesk({ name: "spaces-away-restart", userData }));
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === TAXES)?.tabIds ?? null).toEqual([vendor, north]);
    expect(await away(shell)).toEqual([]);
    await expect(railSpace(shell, TAXES)).toHaveCount(1);
    await expect(shell.getByTestId("rail-away")).toHaveCount(0);
    await expect.poll(() => awayFile(userData)).toEqual([]);
  });
});
