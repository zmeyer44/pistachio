/**
 * An extension sending a space away (docs/primitives.md §2.5, stage 1's gate),
 * end to end through a fixture that uses the public API alone
 * (e2e/fixtures/extensions/away-command, "Game day"): its sheet says what
 * `spaces:write` lets it do in the shell's words; `/gameday` run in a space
 * gives it that space and sends it away under the extension's name, main
 * bringing it back by its own clock; a space it was never run in is refused;
 * and a space it sent away until asked comes back by itself when the
 * extension is removed — nothing is stranded behind one that is gone.
 *
 * The grant's rules, the refusals' codes and the Profile filter are
 * extensions-away.test and extensions-scope.test; the verbs and the clock
 * away-spaces.test. This proves the wiring only the app has: an invocation
 * reaching the scope's grant, the scope reaching main's away service, the
 * shell drawing who sent it.
 */

import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AwaySpaceInfo } from "@pistachio/shell-contracts/away";
import type { ExtensionsSnapshot } from "@pistachio/shell-contracts/extensions";
import { chooseSpace, createGroup, launchDesk, openTabs, railSpace, screenshots, settled, snapshot, VENDOR } from "./desk-harness";

const capture = screenshots("extensions-away");
const ID = "dev.pistachio-e2e.away-command";
const FIXTURE = fileURLToPath(new URL("../fixtures/extensions/away-command", import.meta.url));
const NORTH = "pistachio://demo/invoices?page=north";
const SOUTH = "pistachio://demo/invoices?page=south";
const FOOTBALL = "football";
const TAXES = "taxes";

type WithExtensions = { pistachio: { extensions(request: unknown): Promise<unknown>; onExtensions(listener: (snapshot: ExtensionsSnapshot) => void): () => void }; __ext?: ExtensionsSnapshot };

/** The extensions snapshot as main last published it (the shell's own subscription, read). */
function extensionsSnapshot(shell: Page): Promise<ExtensionsSnapshot | null> {
  return shell.evaluate(() => (window as unknown as WithExtensions).__ext ?? null);
}

function extensionsRequest(shell: Page, request: unknown): Promise<unknown> {
  return shell.evaluate((body) => (window as unknown as WithExtensions).pistachio.extensions(body), request);
}

const gameDay = async (shell: Page) => (await extensionsSnapshot(shell))?.extensions.find((extension) => extension.id === ID);

/** The active Profile's away spaces, as the snapshot lists them. */
async function away(shell: Page): Promise<AwaySpaceInfo[]> {
  return (await snapshot(shell)).awaySpaces ?? [];
}

type Marked = { ok?: unknown; error?: { code: string | null; message: string }; at: number };

/** What the fixture left in its storage under `key` (main's file of it: `<userData>/ExtensionData/<id>/storage.json`), or null. */
async function stored<T = Marked>(userData: string, key: string): Promise<T | null> {
  try {
    const values = JSON.parse(await readFile(join(userData, "ExtensionData", ID, "storage.json"), "utf8")) as Record<string, unknown>;
    return (values[key] as T | undefined) ?? null;
  } catch {
    return null;
  }
}

test.describe.serial("extensions: a space sent away from a Bar command", { tag: ["@extensions"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let userData: string;
  let folder: string;
  let vendor: string, north: string, south: string;

  /** One of Game day's commands, run in a space as the Bar runs it: the space named, and its tab in use. */
  const run = (command: string, spaceId: string, tabId: string, arg = ""): Promise<unknown> => extensionsRequest(shell, { type: "barCommand", id: ID, command, arg, spaceId, tabId });

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    ({ app, shell, userData } = await launchDesk({ name: "extensions-away", sidebar: "whole" }));
    [vendor, north, south] = (await openTabs(shell, [VENDOR, NORTH, SOUTH])) as [string, string, string];
    // Two spaces beside the desk's own: the one Game day is run in, and one it never is.
    await createGroup(shell, FOOTBALL, [vendor, north], "Football", "green");
    await createGroup(shell, TAXES, [south], "Taxes", "blue");
    await expect(railSpace(shell, FOOTBALL)).toHaveCount(1);
    await expect(railSpace(shell, TAXES)).toHaveCount(1);
    await settled(shell, app);
    // The fixture, in a folder of this run's: its status file and log are written beside it.
    folder = join(await mkdtemp(join(tmpdir(), "pistachio-away-command-")), "away-command");
    await cp(FIXTURE, folder, { recursive: true });
    // (The copy's own file events settle first, or main takes them for an edit and reloads it: extensions-capture.spec.)
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await shell.evaluate(() => {
      const w = window as unknown as WithExtensions;
      w.pistachio.onExtensions((next) => (w.__ext = next));
    });
    await extensionsRequest(shell, { type: "loadFolder", path: folder });
    await expect.poll(async () => (await gameDay(shell))?.pending?.manifestHash ?? null).not.toBeNull();
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("its sheet says what it may do with spaces, in the shell's words, and the person turns it on", async () => {
    // What the sheet is drawn from, as main computed it from the manifest: the capability's fixed sentence, Medium.
    const pending = (await gameDay(shell))!.pending!;
    expect(pending.can).toContainEqual({ tier: "medium", text: "Sends spaces away and brings them back." });
    expect(pending.adds.join(" ")).toContain("/gameday");

    // The person's click: its icon on the Ledge, waiting, opens the sheet.
    const icon = shell.locator(`[data-testid="ledge-icon"][data-extension-id="${ID}"]`);
    await expect(icon).toBeVisible({ timeout: 10_000 });
    await expect(icon).toHaveAttribute("data-dot", "amber");
    await icon.click();
    const sheet = shell.getByTestId("extension-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("extension-sheet-name")).toHaveText("Game day");
    await expect(sheet.getByTestId("extension-sheet-can")).toContainText("Sends spaces away and brings them back.");
    await capture(app, shell, "01-sheet.png");
    await sheet.getByTestId("extension-sheet-turn-on").click();
    await expect(sheet).toHaveCount(0);
    await expect.poll(async () => (await gameDay(shell))?.status).toMatch(/idle|running/);
    expect((await gameDay(shell))?.grants?.capabilities).toContain("spaces:write");
  });

  test("/gameday run in a space sends it away under the extension's name, and main brings it back by its clock", async () => {
    test.setTimeout(60_000);
    await chooseSpace(shell, FOOTBALL);
    const inUse = (await snapshot(shell)).activeTabId!;
    expect([vendor, north]).toContain(inUse);
    await run("gameday", FOOTBALL, inUse);

    // ── 1. Away, whole, the desk passed on: sent by Game day — the name on its sheet, drawn by the shell — with a time ─
    await expect.poll(async () => (await away(shell)).map((space) => space.id)).toEqual([FOOTBALL]);
    const [sent] = await away(shell);
    expect(sent).toMatchObject({ id: FOOTBALL, title: "Football", tabCount: 2, by: { kind: "extension", extensionId: ID, name: "Game day" } });
    expect(sent!.until).toBeGreaterThan(sent!.since);
    const now = await snapshot(shell);
    expect(now.tabGroups.some((group) => group.id === FOOTBALL)).toBe(false);
    expect(now.tabs.some((tab) => tab.id === vendor || tab.id === north)).toBe(false);
    expect(now.currentGroupId).not.toBe(FOOTBALL);

    // ── 2. As the extension heard it: the space it sent is its own (`mine`), and it is among what is away ─
    await expect.poll(() => stored(userData, "gameday")).not.toBeNull();
    const marked = (await stored<{ ok?: { sent: { id: string; name: string; tabCount: number; mine: boolean; until?: number }; away: Array<{ id: string; mine: boolean }> }; error?: unknown }>(userData, "gameday"))!;
    expect(marked.error).toBeUndefined();
    expect(marked.ok?.sent).toMatchObject({ id: FOOTBALL, name: "Football", tabCount: 2, mine: true });
    expect(marked.ok?.sent.until).toBe(sent!.until);
    expect(marked.ok?.away).toEqual([expect.objectContaining({ id: FOOTBALL, mine: true })]);

    // ── 3. Back by main's clock — the extension did nothing more — the same space and tabs, never in front ─
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === FOOTBALL)?.tabIds ?? null, { timeout: 20_000 }).toEqual([vendor, north]);
    const back = await snapshot(shell);
    expect(back.awaySpaces ?? []).toEqual([]);
    expect(back.currentGroupId).not.toBe(FOOTBALL);
    await expect(railSpace(shell, FOOTBALL)).toHaveCount(1);
    // And it heard both: the event an extension follows spaces' going and coming by.
    await expect.poll(async () => (await stored<{ event: string; space: { id: string; mine: boolean } }>(userData, "changed.returned"))?.space ?? null).toMatchObject({ id: FOOTBALL, mine: true });
    expect((await stored<{ event: string; space: { id: string } }>(userData, "changed.sent"))?.space.id).toBe(FOOTBALL);
  });

  test("a space it was never run in is not its to send: refused, and the space stays", async () => {
    // Run in Football (which it holds), naming Taxes in words: a name is not a gesture in that space.
    const inUse = (await snapshot(shell)).tabGroups.find((group) => group.id === FOOTBALL)!.tabIds[0]!;
    await run("sendother", FOOTBALL, inUse, TAXES);
    await expect.poll(() => stored(userData, "sendother")).not.toBeNull();
    const marked = (await stored(userData, "sendother"))!;
    expect(marked.ok).toBeUndefined();
    expect(marked.error?.code).toBe("PERMISSION_DENIED");
    // Said so an agent that wrote the extension can fix it: run a command in that space, and pass ctx.spaceId.
    expect(marked.error?.message).toContain("spaceId");
    const now = await snapshot(shell);
    expect(now.tabGroups.find((group) => group.id === TAXES)?.tabIds).toEqual([south]);
    expect(now.awaySpaces ?? []).toEqual([]);
    await expect(railSpace(shell, TAXES)).toHaveCount(1);
  });

  test("sent away until asked, then the extension removed: the space comes back by itself", async () => {
    const inUse = (await snapshot(shell)).tabGroups.find((group) => group.id === FOOTBALL)!.tabIds[0]!;
    await run("benched", FOOTBALL, inUse);
    await expect.poll(async () => (await away(shell)).map((space) => space.id)).toEqual([FOOTBALL]);
    expect((await away(shell))[0]?.until).toBeUndefined();

    // ── 1. On the Away card, the shell says who sent it: the extension's name, never its own words ─
    const tile = shell.getByTestId("rail-away");
    await expect(tile).toHaveAttribute("data-count", "1");
    await tile.click();
    const row = shell.locator(`[data-testid="away-card"][data-shown] [data-testid="away-space"][data-group-id="${FOOTBALL}"]`);
    await expect(row).toContainText("Football");
    await expect(row.getByTestId("away-space-line")).toContainText("Game day");
    await capture(app, shell, "02-away-by-game-day.png");
    await shell.keyboard.press("Escape");

    // ── 2. Removed: nobody is left to bring it back, so main does — the same space, the same tabs ─
    await extensionsRequest(shell, { type: "uninstall", id: ID });
    await expect.poll(async () => (await gameDay(shell)) ?? null).toBeNull();
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === FOOTBALL)?.tabIds ?? null).toEqual([vendor, north]);
    expect(await away(shell)).toEqual([]);
    await expect(railSpace(shell, FOOTBALL)).toHaveCount(1);
    await expect(shell.getByTestId("rail-away")).toHaveCount(0);
  });
});
