/**
 * The agent sending a space away (docs/primitives.md §2.4, stage 1's gate:
 * "hide Football for a while", asked of the agent): the turn runs through
 * the real runner, tools and controller, and only the model's choices are
 * scripted (PISTACHIO_AGENT_SCRIPT, main/scripted-agent-model.ts). Asked from
 * another space, the agent lists the spaces, sends Football away for a
 * minute, and answers: the space is away as the agent's (the shell says
 * "Pistachio"), due back in about a minute. Asked from INSIDE Football — the
 * turn at work in the very space it sends away (`ownTurn`) — the space still
 * goes, the desk passing on, and the notice says where it went.
 *
 * The tools' schemas, the time's reading and the gating are space-tools.test
 * (agent-runtime's and the desktop's); this proves the wiring only the app
 * has: the run controller's host reaching main's away service.
 */

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AwaySpaceInfo } from "@pistachio/shell-contracts/away";
import type { TabGroupCommand, TabGroupCommandResult } from "@pistachio/shell-contracts/tab-groups";
import { chooseSpace, createGroup, launchDesk, openTabs, railSpace, reachBar, screenshots, settled, snapshot, VENDOR } from "./desk-harness";
import { noticePage } from "./windows";

const capture = screenshots("spaces-away-agent");
const NORTH = "pistachio://demo/invoices?page=north";
const FOOTBALL = "football";
const SENT = "Football is away. It will be back in a minute.";
const SENT_AGAIN = "Done: this space is away for a minute.";

const SEND = { name: "space_send_away", input: { spaceId: FOOTBALL, at: null, inMinutes: 1 } };
const SCRIPT = {
  steps: [
    // Asked from another space: which spaces there are, then Football away for a minute, then the answer.
    { tools: [{ name: "spaces_list", input: {} }] },
    { tools: [SEND] },
    { text: SENT },
    // Asked from inside Football: the same call, from the turn at work in it.
    { tools: [SEND] },
    { text: SENT_AGAIN },
  ],
};

/** The active Profile's away spaces, as the snapshot lists them. */
async function away(shell: Page): Promise<AwaySpaceInfo[]> {
  return (await snapshot(shell)).awaySpaces ?? [];
}

function command(shell: Page, body: TabGroupCommand): Promise<TabGroupCommandResult> {
  return shell.evaluate((sent) => (window as unknown as { pistachio: { tabGroupCommand(command: TabGroupCommand): Promise<TabGroupCommandResult> } }).pistachio.tabGroupCommand(sent), body);
}

/** The window in front, so a notice main holds until someone is there to see it is said (spaces-away.spec.ts). */
async function inFront(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible());
    if (window === undefined) return;
    window.focus();
    if (!window.isFocused()) window.emit("focus");
  });
}

test.describe.serial("the agent sends a space away", { tag: ["@agent", "@sidebar"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let vendor: string, north: string;

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    ({ app, shell } = await launchDesk({ name: "spaces-away-agent", sidebar: "whole", env: { PISTACHIO_AGENT_SCRIPT: JSON.stringify(SCRIPT) } }));
    [vendor, north] = (await openTabs(shell, [VENDOR, NORTH])) as [string, string];
    await createGroup(shell, FOOTBALL, [vendor, north], "Football", "green");
    await expect(railSpace(shell, FOOTBALL)).toHaveCount(1);
    await settled(shell, app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("asked from another space: it lists the spaces, sends Football away for a minute, and says so", async () => {
    test.setTimeout(60_000);
    expect((await snapshot(shell)).currentGroupId).not.toBe(FOOTBALL);
    const asked = Date.now();
    await reachBar(shell);
    const input = shell.getByTestId("desk-bar-input");
    await input.fill("Hide my Football space for a minute.");
    await input.press("Enter");
    await expect(shell.getByTestId("desk-answer")).toContainText(SENT, { timeout: 20_000 });

    // ── 1. The two calls, through the real tools ─
    expect((await snapshot(shell)).run?.toolCalls.map((tool) => [tool.name, tool.status])).toEqual([
      ["spaces.list", "completed"],
      ["space.sendAway", "completed"],
    ]);

    // ── 2. Away, whole, as the agent's, due back in about a minute; the desk where it was (it was not Football's) ─
    const [space] = await away(shell);
    expect(space).toMatchObject({ id: FOOTBALL, title: "Football", tabCount: 2, by: { kind: "agent" } });
    expect(space!.until! - asked).toBeGreaterThan(55_000);
    expect(space!.until! - asked).toBeLessThan(90_000);
    const now = await snapshot(shell);
    expect(now.tabGroups.some((group) => group.id === FOOTBALL)).toBe(false);
    expect(now.tabs.some((tab) => tab.id === vendor || tab.id === north)).toBe(false);
    await expect(railSpace(shell, FOOTBALL)).toHaveCount(0);

    // ── 3. Said by the shell, naming who sent it in its own word ─
    await inFront(app);
    const notices = await noticePage(app);
    const sent = notices.locator('[data-testid="notice-card"][data-phase="live"]').filter({ hasText: "“Football” is away" });
    await expect(sent).toBeVisible();
    await expect(sent).toContainText("Pistachio");
    await expect(sent.getByRole("button", { name: "Bring back" })).toBeVisible();
    await capture(app, shell, "01-sent-by-the-agent.png");
  });

  test("asked from inside the space: the turn at work in it sends it away all the same, and the desk passes on", async () => {
    test.setTimeout(60_000);
    // Back, in front (the person's Bring back), its tabs the same.
    expect((await command(shell, { type: "bringBack", groupId: FOOTBALL })).refused).toBeUndefined();
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === FOOTBALL)?.tabIds ?? null).toEqual([vendor, north]);
    if ((await snapshot(shell)).currentGroupId !== FOOTBALL) await chooseSpace(shell, FOOTBALL);
    await settled(shell, app);

    const asked = Date.now();
    await reachBar(shell);
    const input = shell.getByTestId("desk-bar-input");
    await input.fill("Hide this space for a minute.");
    await input.press("Enter");

    // The space goes from under the turn that asked: away as the agent's, the desk on another space.
    await expect.poll(async () => (await away(shell)).map((space) => space.id), { timeout: 20_000 }).toEqual([FOOTBALL]);
    const [space] = await away(shell);
    expect(space).toMatchObject({ by: { kind: "agent" }, tabCount: 2 });
    expect(space!.until! - asked).toBeGreaterThan(55_000);
    await expect.poll(async () => (await snapshot(shell)).currentGroupId).not.toBe(FOOTBALL);
    const now = await snapshot(shell);
    expect(now.tabGroups.some((group) => group.id === FOOTBALL)).toBe(false);
    await expect(railSpace(shell, FOOTBALL)).toHaveCount(0);

    // Said where the person is now.
    await inFront(app);
    const notices = await noticePage(app);
    await expect(notices.locator('[data-testid="notice-card"][data-phase="live"]').filter({ hasText: "“Football” is away" }).last()).toContainText("Pistachio");

    // Brought back, it is itself — and the turn's answer is in its conversation, where it was asked.
    expect((await command(shell, { type: "bringBack", groupId: FOOTBALL })).refused).toBeUndefined();
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === FOOTBALL)?.tabIds ?? null).toEqual([vendor, north]);
    await expect.poll(async () => (await snapshot(shell)).currentGroupId).toBe(FOOTBALL);
    await expect(shell.getByTestId("desk-answer")).toContainText(SENT_AGAIN, { timeout: 20_000 });
    await capture(app, shell, "02-back-with-its-answer.png");
  });
});
