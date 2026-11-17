/**
 * A mark on a tab's row (docs/primitives.md §4.7 — stage 4b's gate), end to
 * end through a fixture on the public API alone
 * (e2e/fixtures/extensions/unread): "mark the tabs I have not read" — a tab
 * opened behind what the person is doing is marked until it comes in front.
 *
 * - its sheet says what it adds, when it runs and the Low line for its marks;
 * - a tab opened behind is marked on its row, in the shell's words, by a
 *   worker nothing else started; looked at, the mark comes off;
 * - a marked tab closed takes its mark with it;
 * - the marks are main's: there after a restart with no worker running, and
 *   taken off together by the person from the Extensions page.
 *
 * The store and the scope's rules are extensions-tab-marks.test; the shell's
 * helpers packages/shell-ui/test/extension-shown.test. This proves the wiring
 * only the app has.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { ExtensionsSnapshot } from "@pistachio/shell-contracts/extensions";
import { chooseSpace, createGroup, launchDesk, openTabs, railSpace, screenshots, selectTab, settled, snapshot, spaceView, VENDOR } from "./desk-harness";

const capture = screenshots("extensions-tab-marks");
const ID = "dev.pistachio-e2e.unread";
const FIXTURE = fileURLToPath(new URL("../fixtures/extensions/unread", import.meta.url));
const NORTH = "pistachio://demo/invoices?page=north";
const READING = "reading";
const SAYS = "Unread: Not read yet";

type WithExtensions = { pistachio: { extensions(request: unknown): Promise<unknown>; onExtensions(listener: (snapshot: ExtensionsSnapshot) => void): () => void }; __ext?: ExtensionsSnapshot };

function extensionsSnapshot(shell: Page): Promise<ExtensionsSnapshot | null> {
  return shell.evaluate(() => (window as unknown as WithExtensions).__ext ?? null);
}

function extensionsRequest(shell: Page, request: unknown): Promise<unknown> {
  return shell.evaluate((body) => (window as unknown as WithExtensions).pistachio.extensions(body), request);
}

const unread = async (shell: Page) => (await extensionsSnapshot(shell))?.extensions.find((extension) => extension.id === ID);
const marked = async (shell: Page): Promise<string[]> => ((await extensionsSnapshot(shell))?.tabMarks ?? []).filter((mark) => mark.extensionId === ID).map((mark) => mark.tabId);

test.describe.serial("extensions: a mark on the tabs not read yet", { tag: ["@extensions", "@sidebar"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let userData: string;
  let server: Server;
  let origin: string;
  let vendor: string, north: string;

  const follow = async (): Promise<void> => {
    await shell.evaluate(() => {
      const w = window as unknown as WithExtensions;
      w.pistachio.onExtensions((next) => (w.__ext = next));
    });
    await extensionsRequest(shell, { type: "closePanel" });
  };
  const tabOn = async (url: string): Promise<string | null> => (await snapshot(shell)).tabs.find((tab) => tab.url === url)?.id ?? null;
  /** /later <address>, run in the Reading space: the address opens behind what is in front. */
  const later = async (path: string): Promise<string> => {
    const inUse = (await snapshot(shell)).activeTabId;
    await extensionsRequest(shell, { type: "barCommand", id: ID, command: "later", arg: `${origin}${path}`, spaceId: READING, tabId: inUse });
    await expect.poll(() => tabOn(`${origin}${path}`), { timeout: 15_000 }).not.toBeNull();
    // Behind: what is in use is as it was.
    expect((await snapshot(shell)).activeTabId).toBe(inUse);
    return (await tabOn(`${origin}${path}`))!;
  };
  /** A tab's row in the Reading space's card, and the mark on it. */
  const row = (tabId: string): Locator => spaceView(shell, READING).locator(`[role="tab"][data-tab-id="${tabId}"]`);
  const markOn = (tabId: string): Locator => row(tabId).getByTestId("tab-row-mark");
  const stored = async (key: string): Promise<string[]> => {
    try {
      const values = JSON.parse(await readFile(join(userData, "ExtensionData", ID, "storage.json"), "utf8")) as Record<string, unknown>;
      return (values[key] as string[] | undefined) ?? [];
    } catch {
      return [];
    }
  };

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Article ${request.url ?? ""}</title></head><body><h1>${request.url ?? ""}</h1></body></html>`);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    ({ app, shell, userData } = await launchDesk({ name: "extensions-tab-marks", sidebar: "whole" }));
    [vendor, north] = (await openTabs(shell, [VENDOR, NORTH])) as [string, string];
    // A space of tabs, shown one at a time: its card lists every tab of it, the one in use and the ones behind.
    await createGroup(shell, READING, [vendor, north], "Reading", "blue", { windows: false });
    await expect(railSpace(shell, READING)).toHaveCount(1);
    await chooseSpace(shell, READING);
    await settled(shell, app);
    const scratch = await mkdtemp(join(tmpdir(), "pistachio-unread-"));
    const folder = join(scratch, "unread");
    await cp(FIXTURE, folder, { recursive: true });
    // (The copy's own file events settle first, or main takes them for an edit and reloads it: extensions-capture.spec.)
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await follow();
    await extensionsRequest(shell, { type: "loadFolder", path: folder });
    await expect.poll(async () => (await unread(shell))?.pending?.manifestHash ?? null).not.toBeNull();
  });

  test.afterAll(async () => {
    await app?.close();
    await new Promise<void>((done) => server.close(() => done()));
  });

  test("its sheet says when it runs and the line for its marks; approved, nothing is marked yet", async () => {
    const pending = (await unread(shell))!.pending!;
    expect(pending.runs).toEqual(["When a tab opens", "When a tab comes in front", "When a tab closes"]);
    expect(pending.runsLimit).toBe("With nobody there it can only open tabs behind what you are doing and update what it shows. What it does to your spaces and tabs is listed, and can be undone.");
    expect(pending.can.map((line) => [line.tier, line.text])).toContainEqual(["low", "Puts a small mark on your tabs."]);
    await extensionsRequest(shell, { type: "approve", id: ID, manifestHash: pending.manifestHash });
    await expect.poll(async () => (await unread(shell))?.pending ?? null).toBeNull();
    expect(await marked(shell)).toEqual([]);
    await expect(shell.getByTestId("tab-row-mark")).toHaveCount(0);
  });

  test("a tab opened behind is marked on its row, in the shell's words; looked at, the mark comes off", async () => {
    test.setTimeout(60_000);
    const article = await later("/article-one");
    // The event reached the worker with which tab it was; the mark is main's from then on.
    await expect.poll(() => marked(shell), { timeout: 15_000 }).toEqual([article]);
    await expect(markOn(article)).toBeVisible();
    await expect(markOn(article)).toHaveAttribute("title", SAYS);
    await expect(markOn(article)).toHaveAttribute("aria-label", SAYS);
    await expect(markOn(article)).toHaveAttribute("data-tone", "blue");
    // The tabs that were already here, and the one in use, are not marked.
    await expect(shell.getByTestId("tab-row-mark")).toHaveCount(1);
    expect((await unread(shell))?.shows).toEqual([{ what: "tabMarks", spaceId: null, space: "", detail: "1 tab · Not read yet" }]);
    await capture(app, shell, "01-unread-mark.png");

    // Looked at: it is read.
    await selectTab(shell, article);
    await expect.poll(() => marked(shell), { timeout: 15_000 }).toEqual([]);
    await expect(markOn(article)).toHaveCount(0);
    await expect.poll(() => stored("read")).toContain(article);
  });

  test("a marked tab closed takes its mark with it", async () => {
    test.setTimeout(60_000);
    const second = await later("/article-two");
    await expect.poll(() => marked(shell), { timeout: 15_000 }).toEqual([second]);
    await shell.evaluate((id) => (window as unknown as { pistachio: { closeTab(tabId: string): Promise<void> } }).pistachio.closeTab(id), second);
    // Main dropped it as the tab went: no code of the extension's had to.
    await expect.poll(() => marked(shell)).toEqual([]);
    await expect.poll(() => stored("closed")).toContain(second);
    expect((await unread(shell))?.shows ?? []).toEqual([]);
  });

  test("the marks are main's: there after a restart with no worker running, and taken off together from the Extensions page", async () => {
    test.setTimeout(120_000);
    const third = await later("/article-three");
    const fourth = await later("/article-four");
    await expect.poll(async () => (await marked(shell)).sort(), { timeout: 15_000 }).toEqual([third, fourth].sort());
    await app.close();
    ({ app, shell } = await launchDesk({ name: "extensions-tab-marks", userData }));
    await follow();
    await chooseSpace(shell, READING);
    await expect(markOn(third)).toBeVisible({ timeout: 15_000 });
    await expect(markOn(fourth)).toBeVisible();
    // Nothing of the extension's is running: the rows were drawn from what main kept.
    expect((await unread(shell))?.status).toBe("idle");
    expect((await unread(shell))?.shows).toEqual([{ what: "tabMarks", spaceId: null, space: "", detail: "2 tabs · Not read yet" }]);

    // The person's Remove, on the Extensions page: all of its marks, in one press.
    await openTabs(shell, ["pistachio://extensions/"]);
    const page = (await snapshot(shell)).tabs.find((candidate) => candidate.url.startsWith("pistachio://extensions"))!;
    await selectTab(shell, page.id);
    const shows = shell.locator(`[data-testid="extension-shows"][data-extension-id="${ID}"]`);
    await expect(shows).toBeVisible({ timeout: 15_000 });
    await expect(shows).toContainText("Marks on 2 tabs · Not read yet");
    await capture(app, shell, "02-extensions-page-tab-marks.png");
    await shows.getByTestId("extension-shown-remove").click();
    await expect.poll(() => marked(shell)).toEqual([]);
    await expect(shows).toHaveCount(0);

    // A tab opened in front is two events at once — it opened, it came in front — and so two handlers, overlapping,
    // of a worker that only triggers started. Once both have answered it is stopped all the same: woken code does
    // not stay, however its deliveries fell.
    const [front] = (await openTabs(shell, [`${origin}/in-front`])) as [string];
    await expect.poll(() => stored("read"), { timeout: 15_000 }).toContain(front);
    await expect.poll(async () => (await unread(shell))?.status, { timeout: 15_000 }).toBe("idle");
  });
});
