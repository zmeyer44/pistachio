/**
 * One of Pistachio's own features on the public API (docs/primitives.md §5,
 * stage 6's gate): Tidy's filing of idle spaces (docs/tab-tidy.md §4), as a
 * fixture extension (e2e/fixtures/extensions/idle-spaces) with the built-in
 * pass switched off. Tidy's own tests of it — an auto space wholly idle is
 * archived as one entry, under its id; the person's is left; Undo makes it
 * again with that id — asked end to end of an extension:
 *
 * - its sheet leads with the line that it acts on any space, and says what
 *   it may do with nobody there;
 * - half an hour on, with nobody there: the space Pistachio gathered that
 *   nobody has used is closed into the archive, whole, under its id — never
 *   the person's own, never one with a tab still in use — and a model is
 *   asked what it was for;
 * - main says who closed it, with Undo; the journal lists it, and Undo there
 *   brings the space back as itself, not in front.
 *
 * The verb is space-closing.test; the scope's rules extensions-closing.test.
 * This proves the wiring only the app has.
 */

import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { ExtensionsSnapshot } from "@pistachio/shell-contracts/extensions";
import type { PistachioApi, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { launchApp, newProfile } from "./app";
import { screenshots } from "./desk-harness";
import { noticePage, pageFirst, shellReady } from "./windows";

const capture = screenshots("extensions-idle-spaces");
const ID = "dev.pistachio-e2e.idle-spaces";
const FIXTURE = fileURLToPath(new URL("../fixtures/extensions/idle-spaces", import.meta.url));
const HOUR = 60 * 60 * 1000;
const SAYS = "Every 30 minutes";
const LIMIT = "With nobody there it can only close your spaces into the archive and ask Pistachio's AI. What it does to your spaces and tabs is listed, and can be undone.";

interface SeedTab {
  id: string;
  title: string;
  url: string;
  idleHours: number;
}

const page = (name: string): string => `pistachio://demo/invoices?page=${name}`;
const TABS: SeedTab[] = [
  { id: "tab-active", title: "Invoices", url: "pistachio://demo/invoices", idleHours: 0 },
  // A space Tidy gathered, every tab of it a day old: the one to file.
  { id: "trip-a", title: "Flights to Lisbon", url: page("flights"), idleHours: 20 },
  { id: "trip-b", title: "Hotels in Alfama", url: page("hotels"), idleHours: 30 },
  // The person's own, just as old: never theirs to lose.
  { id: "mine-a", title: "Tax return", url: page("tax"), idleHours: 20 },
  { id: "mine-b", title: "Receipts", url: page("receipts"), idleHours: 20 },
  // One Tidy gathered with a tab still in use: not idle.
  { id: "desk-a", title: "Standing desk A", url: page("desk-a"), idleHours: 30 },
  { id: "desk-b", title: "Standing desk B", url: page("desk-b"), idleHours: 1 },
];
const GROUPS = [
  { id: "trip", title: "Trip", color: "green", tabIds: ["trip-a", "trip-b"], origin: "auto", open: false, createdAt: 1 },
  { id: "mine", title: "Mine", color: "red", tabIds: ["mine-a", "mine-b"], origin: "manual", open: false, createdAt: 2 },
  { id: "desk", title: "Desk", color: "blue", tabIds: ["desk-a", "desk-b"], origin: "auto", open: false, createdAt: 3 },
];

type WithExtensions = { pistachio: { extensions(request: unknown): Promise<unknown>; onExtensions(listener: (snapshot: ExtensionsSnapshot) => void): () => void }; __ext?: ExtensionsSnapshot };

function api<T>(shell: Page, call: (pistachio: PistachioApi) => Promise<T>): Promise<T> {
  return shell.evaluate(`(${call.toString()})(window.pistachio)`) as Promise<T>;
}

const snapshot = (shell: Page): Promise<ShellSnapshot> => api(shell, (pistachio) => pistachio.getSnapshot());

function extensionsRequest(shell: Page, request: unknown): Promise<unknown> {
  return shell.evaluate((body) => (window as unknown as WithExtensions).pistachio.extensions(body), request);
}

const idleSpaces = async (shell: Page) => (await shell.evaluate(() => (window as unknown as WithExtensions).__ext ?? null))?.extensions.find((extension) => extension.id === ID);

test.describe.serial("extensions: Tidy's filing of idle spaces, as an extension", { tag: ["@extensions", "@tabs"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let userData: string;
  let clock: string;
  let start: number;

  const setClock = (instant: number): Promise<void> => writeFile(clock, String(instant));
  const spaceIds = async (): Promise<string[]> => (await snapshot(shell)).tabGroups.map((group) => group.id).sort();
  const archived = async (): Promise<Array<{ kind: string; groupId?: string; group?: { title: string; color: string }; tabs?: unknown[] }>> => {
    const response = await shell.evaluate(() => (window as unknown as { pistachio: { tabArchive(request: unknown): Promise<{ entries?: unknown[] }> } }).pistachio.tabArchive({ type: "list", spaceId: "work" }));
    return (response.entries ?? []) as Array<{ kind: string; groupId?: string; group?: { title: string; color: string }; tabs?: unknown[] }>;
  };
  const filed = async (): Promise<unknown[]> => {
    try {
      const values = JSON.parse(await readFile(join(userData, "ExtensionData", ID, "storage.json"), "utf8")) as Record<string, unknown>;
      return (values["filed"] as unknown[] | undefined) ?? [];
    } catch {
      return [];
    }
  };

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const scratch = await mkdtemp(join(tmpdir(), "pistachio-idle-spaces-"));
    clock = join(scratch, "clock");
    // (On a mark of the half hour, so the next one is a known way off.)
    start = Math.floor(Date.now() / (30 * 60_000)) * 30 * 60_000 + 60_000;
    await setClock(start);
    const now = Date.now();
    userData = await newProfile("extensions-idle-spaces");
    ({ app } = await launchApp({
      userData,
      // The built-in pass is off — *Archive idle tabs after: Never* — so what is filed here is the extension's doing.
      settings: pageFirst({ onboarding: { completed: true, completedAt: null }, tabs: { archiveAfterHours: 0 } }),
      files: {
        "tab-session.json": {
          version: 1,
          spaces: {
            work: {
              activeTabId: "tab-active",
              recentTabIds: TABS.map((tab) => tab.id),
              splitGroups: [],
              tabGroups: GROUPS,
              tabs: TABS.map((tab) => ({ id: tab.id, spaceId: "work", title: tab.title, url: tab.url, faviconUrl: null, anchorId: null, lastActiveAt: now - tab.idleHours * HOUR })),
            },
          },
        },
      },
      env: { PISTACHIO_E2E_TRIGGER_CLOCK: clock, PISTACHIO_E2E_COMPLETE: JSON.stringify({ Trip: "Planning a Lisbon trip" }) },
    }));
    shell = await shellReady(app);
    await expect.poll(spaceIds).toEqual(["desk", "mine", "trip"]);
    const folder = join(scratch, "idle-spaces");
    await cp(FIXTURE, folder, { recursive: true });
    // (The copy's own file events settle first, or main takes them for an edit and reloads it: extensions-capture.spec.)
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await shell.evaluate(() => {
      const w = window as unknown as WithExtensions;
      w.pistachio.onExtensions((next) => (w.__ext = next));
    });
    await extensionsRequest(shell, { type: "closePanel" });
    await extensionsRequest(shell, { type: "loadFolder", path: folder });
    await expect.poll(async () => (await idleSpaces(shell))?.pending?.manifestHash ?? null).not.toBeNull();
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("its sheet leads with the line that it acts on any space, and says what it may do with nobody there", async () => {
    const pending = (await idleSpaces(shell))!.pending!;
    expect(pending.runs).toEqual([SAYS]);
    expect(pending.runsLimit).toBe(LIMIT);
    expect(pending.can.map((line) => [line.tier, line.text])).toEqual([
      ["high", "Acts on any of your spaces, not only the ones you ran it in."],
      ["high", "Sends what it chooses to Pistachio's AI and reads the answer (spends your AI usage)."],
      ["medium", "Sees the titles and addresses of your tabs."],
      ["medium", "Closes spaces into the archive, where they can be restored."],
    ]);
    const icon = shell.locator(`[data-testid="ledge-icon"][data-extension-id="${ID}"]`);
    await expect(icon).toBeVisible({ timeout: 10_000 });
    await icon.click();
    const sheet = shell.getByTestId("extension-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("approval-runs-limit")).toHaveText(LIMIT);
    await capture(app, shell, "01-sheet-idle-spaces.png");
    await sheet.getByTestId("extension-sheet-turn-on").click();
    await expect(sheet).toHaveCount(0);
    // An interval starts quiet: approved, nothing is filed until its next mark.
    await expect.poll(async () => (await idleSpaces(shell))?.status).not.toBe("needs-approval");
    expect(await spaceIds()).toEqual(["desk", "mine", "trip"]);
    expect(await archived()).toEqual([]);
  });

  test("half an hour on, with nobody there: the idle space Pistachio gathered is filed whole, under its id — not the person's, not one still in use", async () => {
    test.setTimeout(60_000);
    await setClock(start + 30 * 60_000);
    await expect.poll(spaceIds, { timeout: 20_000 }).toEqual(["desk", "mine"]);
    // Tidy's own test of it: one entry, a space's, with its title and colour — and its id, so it comes back as itself.
    const entries = await archived();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "group", groupId: "trip", group: { title: "Trip", color: "green" } });
    expect(entries[0]!.tabs).toHaveLength(2);
    // Its tabs went with it; the others are untouched.
    const titles = (await snapshot(shell)).tabs.map((tab) => tab.title);
    expect(titles).not.toContain("Flights to Lisbon");
    expect(titles).toEqual(expect.arrayContaining(["Tax return", "Receipts", "Standing desk A", "Standing desk B"]));
    // The model was asked what it was for (a spec's stand-in), with nobody there.
    await expect.poll(filed).toEqual([{ id: "trip", name: "Trip", about: "Planning a Lisbon trip" }]);
    // Main wrote it down: who, which trigger, what — and the archive's entry, the way back.
    await expect.poll(async () => (await idleSpaces(shell))?.journal?.length ?? 0).toBe(1);
    expect((await idleSpaces(shell))!.journal![0]).toMatchObject({ extensionId: ID, trigger: "sweep", verb: "closeSpace", spaceId: "trip", title: "Trip" });
    // And said it, with who did it and Undo, once the window is in front.
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible());
      if (window === undefined) return;
      window.focus();
      if (!window.isFocused()) window.emit("focus");
    });
    const notices = await noticePage(app);
    const said = notices.locator('[data-testid="notice-card"][data-phase="live"]').filter({ hasText: "Closed “Trip” · 2 tabs · Idle spaces" });
    await expect(said).toBeVisible();
    await expect(said.getByRole("button", { name: "Undo" })).toBeVisible();
    await capture(app, shell, "02-filed.png");
  });

  test("the next sweep files nothing more; Undo in the journal brings the space back as itself, not in front", async () => {
    test.setTimeout(60_000);
    await setClock(start + 60 * 60_000);
    // (The absence is what is tested: the sweep has run, and nothing else was its to file.)
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await spaceIds()).toEqual(["desk", "mine"]);
    expect(await archived()).toHaveLength(1);

    const inUse = (await snapshot(shell)).activeTabId;
    const line = (await idleSpaces(shell))!.journal![0]!;
    await extensionsRequest(shell, { type: "undoJournal", entry: line.id });
    await expect.poll(spaceIds).toEqual(["desk", "mine", "trip"]);
    const trip = (await snapshot(shell)).tabGroups.find((group) => group.id === "trip")!;
    expect(trip).toMatchObject({ title: "Trip", color: "green" });
    expect(trip.tabIds).toHaveLength(2);
    expect(await archived()).toEqual([]);
    // Taken back where it was: nobody is moved by an Undo of what nobody pressed.
    expect((await snapshot(shell)).activeTabId).toBe(inUse);
    await expect.poll(async () => (await idleSpaces(shell))?.journal?.[0]?.undone ?? null).not.toBeNull();
  });
});
