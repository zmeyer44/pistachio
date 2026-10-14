/**
 * ⌘L's two siblings (2026-10-10): the same address bar, but ↵ leaves the page
 * in use as it was. ⌥L opens what was chosen in a new tab of the current
 * space, out on its desk as the window in use; ⌘⇧L opens it in a new space of
 * its own, current at once with that tab in use — main makes the two together
 * (TabGroupCommand `create` with `url`). Pressed with the bar up, either only
 * changes where ↵ goes.
 *
 * ⌥↵ and ⌘⇧↵ choose the same at the end, from ⌘L's bar; ⌘N makes an empty
 * space, its name field open; and ⌘T, when General's "New tabs open" says
 * the address bar, opens ⌥L's.
 *
 * ⌘⇧L and ⌘N are struck inside the page, through Electron's input pipeline, as a real
 * key reaches main's before-input-event relay. ⌥L is the shell's own key event:
 * macOS composes ⌥L into "¬", which a synthesized input never does — and an
 * Option press that composed plain ASCII is typing, not a binding (⌥L is @ on
 * a German Mac; shortcuts.ts), so a synthesized "l" would rightly be ignored.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { INVOICES, launchDesk, snapshot, spaceView, windowSelector } from "./desk-harness";
import { captureShell } from "./pages-harness";

let server: Server;
let origin: string;
/** Answers to /slow, held until a test lets them go: a page still loading. */
const held: Array<() => void> = [];

/** The space a tab is in, as the snapshot lists it: drawn, a loose tab's, or a page's. */
function spaceOf(now: ShellSnapshot, tabId: string): string | null {
  return [...now.tabGroups, ...(now.looseGroups ?? []), ...(now.anchorGroups ?? [])].find((group) => group.tabIds.includes(tabId))?.id ?? null;
}

/** A ⌘ key (⌘⇧L, ⌘N) struck in the page showing `url`, as a real key reaches it — once the page has committed (the snapshot names a new tab's address first). */
async function strikeInPage(app: ElectronApplication, url: string, keyCode: string, modifiers: Array<"meta" | "shift">): Promise<void> {
  await expect
    .poll(() =>
      app.evaluate(({ webContents }, { address, keyCode, modifiers }) => {
        const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === address);
        if (contents === undefined || contents.isLoading()) return false;
        contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
        contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
        return true;
      }, { address: url, keyCode, modifiers }),
    )
    .toBe(true);
}

/** ⌥L in the shell, as macOS delivers it on a US keyboard: the composed "¬" on the L key. */
function pressOptionL(shell: Page): Promise<void> {
  return shell.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "¬", code: "KeyL", altKey: true, cancelable: true }));
  });
}

/** Type an address in the open bar and go — with ↵, or a modified one (⌥↵, ⌘⇧↵). */
async function go(shell: Page, address: string, enter = "Enter"): Promise<void> {
  const input = shell.getByTestId("address-input");
  await expect(input).toBeFocused();
  await input.fill(address);
  await shell.keyboard.press(enter);
  await expect(shell.getByTestId("url-bar")).toHaveCount(0);
}

/** Every space the snapshot lists: drawn, a loose tab's, or a page's. */
function spaceIds(now: ShellSnapshot): Set<string> {
  return new Set([...now.tabGroups, ...(now.looseGroups ?? []), ...(now.anchorGroups ?? [])].map((group) => group.id));
}

test.describe.serial("the address bar's destinations", { tag: ["@address", "@desk"] }, () => {
  test.describe.configure({ timeout: 60_000 });
  let app: ElectronApplication;
  let shell: Page;

  test.beforeAll(async () => {
    server = createServer((request, response) => {
      const answer = (): void => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html><head><title>Fixture ${request.url ?? ""}</title></head><body><h1>Fixture</h1></body></html>`);
      };
      if (request.url === "/slow") held.push(answer);
      else answer();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    ({ app, shell } = await launchDesk({ name: "address-destinations" }));
  });

  test.afterAll(async () => {
    for (const answer of held.splice(0)) answer();
    await app?.close();
    await new Promise<void>((done) => server.close(() => done()));
  });

  test("⌥L opens the address in a new tab of the current space, the page in use left as it was", async () => {
    const before = await snapshot(shell);
    const firstId = before.activeTabId!;
    const space = spaceOf(before, firstId);
    expect(space).not.toBeNull();

    // ⌘L edits the page in use; ⌥L with the bar up only changes where ↵ goes.
    await shell.keyboard.press("Meta+L");
    await expect(shell.getByTestId("url-bar")).toBeVisible();
    await expect(shell.getByTestId("url-bar-destination")).toHaveCount(0);
    await pressOptionL(shell);
    await expect(shell.getByTestId("url-bar-destination")).toHaveText("New tab");
    await captureShell(app, "address-destinations/new-tab-bar.png", 250);

    const address = `${origin}/alpha`;
    await go(shell, address);
    await expect
      .poll(async () => {
        const now = await snapshot(shell);
        const made = now.tabs.find((tab) => tab.url === address);
        return {
          first: now.tabs.find((tab) => tab.id === firstId)?.url,
          inUse: made !== undefined && now.activeTabId === made.id,
          sameSpace: made !== undefined && spaceOf(now, made.id) === spaceOf(now, firstId),
          current: made !== undefined && now.currentGroupId === spaceOf(now, made.id),
        };
      })
      .toEqual({ first: INVOICES, inUse: true, sameSpace: true, current: true });
    const made = (await snapshot(shell)).tabs.find((tab) => tab.url === address)!;
    await expect(shell.locator(windowSelector(made.id))).toBeVisible();
    await expect(shell.locator(windowSelector(firstId))).toBeVisible();
  });

  test("⌘⇧L struck in a page opens the address in a new space of its own, current with it in use", async () => {
    const before = await snapshot(shell);
    const inUse = before.tabs.find((tab) => tab.id === before.activeTabId)!;
    const oldSpace = spaceOf(before, inUse.id);
    const oldMembers = [...before.tabGroups, ...(before.looseGroups ?? [])].find((group) => group.id === oldSpace)!.tabIds;
    const known = spaceIds(before);

    await strikeInPage(app, inUse.url, "l", ["meta", "shift"]);
    await expect(shell.getByTestId("url-bar")).toBeVisible();
    await expect(shell.getByTestId("url-bar-destination")).toHaveText("New space");
    await expect(shell.getByTestId("address-input")).toHaveAttribute("placeholder", /new space/);
    await captureShell(app, "address-destinations/new-space-bar.png", 250);

    const address = `${origin}/beta`;
    await go(shell, address);
    await expect
      .poll(async () => {
        const now = await snapshot(shell);
        const made = now.tabs.find((tab) => tab.url === address);
        const space = made === undefined ? null : spaceOf(now, made.id);
        return {
          fresh: space !== null && !known.has(space) && now.tabGroups.find((group) => group.id === space)?.tabIds.length === 1,
          current: space !== null && now.currentGroupId === space,
          inUse: made !== undefined && now.activeTabId === made.id,
          left: now.tabs.find((tab) => tab.id === inUse.id)?.url,
          oldSpace: [...now.tabGroups, ...(now.looseGroups ?? [])].find((group) => group.id === oldSpace)?.tabIds,
        };
      })
      .toEqual({ fresh: true, current: true, inUse: true, left: inUse.url, oldSpace: oldMembers });
    const now = await snapshot(shell);
    const made = now.tabs.find((tab) => tab.url === address)!;
    await expect(shell.locator(`.desk-stage[data-phase="open"][data-group-id="${now.currentGroupId!}"]`)).toHaveCount(1);
    await expect(shell.locator(windowSelector(made.id))).toBeVisible();
  });

  test("⌥↵ and ⌘⇧↵ send ⌘L's choice to a new tab or a new space, the page in use left as it was", async () => {
    const before = await snapshot(shell);
    const inUse = before.tabs.find((tab) => tab.id === before.activeTabId)!;
    const space = spaceOf(before, inUse.id);

    // ⌥↵: a new tab of this space.
    await shell.keyboard.press("Meta+L");
    await expect(shell.getByTestId("url-bar")).toBeVisible();
    await expect(shell.getByTestId("url-bar-destination")).toHaveCount(0);
    const gamma = `${origin}/gamma`;
    await go(shell, gamma, "Alt+Enter");
    await expect
      .poll(async () => {
        const now = await snapshot(shell);
        const made = now.tabs.find((tab) => tab.url === gamma);
        return {
          left: now.tabs.find((tab) => tab.id === inUse.id)?.url,
          inUse: made !== undefined && now.activeTabId === made.id,
          sameSpace: made !== undefined && spaceOf(now, made.id) === space,
        };
      })
      .toEqual({ left: inUse.url, inUse: true, sameSpace: true });

    // ⌘⇧↵: a new space of its own.
    const known = spaceIds(await snapshot(shell));
    const gammaId = (await snapshot(shell)).tabs.find((tab) => tab.url === gamma)!.id;
    await shell.keyboard.press("Meta+L");
    await expect(shell.getByTestId("url-bar")).toBeVisible();
    const delta = `${origin}/delta`;
    await go(shell, delta, "Meta+Shift+Enter");
    await expect
      .poll(async () => {
        const now = await snapshot(shell);
        const made = now.tabs.find((tab) => tab.url === delta);
        const madeSpace = made === undefined ? null : spaceOf(now, made.id);
        return {
          left: now.tabs.find((tab) => tab.id === gammaId)?.url,
          fresh: madeSpace !== null && !known.has(madeSpace) && now.tabGroups.find((group) => group.id === madeSpace)?.tabIds.length === 1,
          current: madeSpace !== null && now.currentGroupId === madeSpace,
          inUse: made !== undefined && now.activeTabId === made.id,
        };
      })
      .toEqual({ left: gamma, fresh: true, current: true, inUse: true });
  });

  test("a new space is current as soon as it is made, its page still loading", async () => {
    const known = spaceIds(await snapshot(shell));
    await shell.keyboard.press("Meta+L");
    await expect(shell.getByTestId("url-bar")).toBeVisible();
    const slow = `${origin}/slow`;
    await go(shell, slow, "Meta+Shift+Enter");
    await expect.poll(() => held.length).toBe(1);
    // Its answer is held: the space and its window are up while the page is still on its way.
    await expect
      .poll(async () => {
        const now = await snapshot(shell);
        const made = now.tabs.find((tab) => tab.url === slow);
        const space = made === undefined ? null : spaceOf(now, made.id);
        return { fresh: space !== null && !known.has(space), current: space !== null && now.currentGroupId === space, inUse: made !== undefined && now.activeTabId === made.id };
      })
      .toEqual({ fresh: true, current: true, inUse: true });
    const now = await snapshot(shell);
    await expect(shell.locator(`.desk-stage[data-phase="open"][data-group-id="${now.currentGroupId!}"]`)).toHaveCount(1);
    await expect(shell.locator(windowSelector(now.activeTabId!))).toBeVisible();
    for (const answer of held.splice(0)) answer();
    await expect.poll(async () => (await snapshot(shell)).tabs.find((tab) => tab.id === now.activeTabId)?.title).toBe("Fixture /slow");
    // Loaded, it leaves the space where it is: nothing is selected again.
    expect((await snapshot(shell)).currentGroupId).toBe(now.currentGroupId);
  });

  test("⌘N struck in a page makes an empty space, current at once, its name field open", async () => {
    const before = await snapshot(shell);
    const inUse = before.tabs.find((tab) => tab.id === before.activeTabId)!;
    const known = spaceIds(before);

    await strikeInPage(app, inUse.url, "n", ["meta"]);
    await expect
      .poll(async () => {
        const now = await snapshot(shell);
        const current = now.tabGroups.find((group) => group.id === now.currentGroupId);
        return { fresh: current !== undefined && !known.has(current.id), empty: current?.tabIds.length, title: current?.title, inUse: now.activeTabId };
      })
      .toEqual({ fresh: true, empty: 0, title: "New space", inUse: null });
    const made = (await snapshot(shell)).currentGroupId!;
    // The card turns to the new space, its name field open in its head, and the keyboard is the field's.
    const name = spaceView(shell, made).getByTestId("tab-group-name-input");
    await expect(name).toBeFocused();
    await expect(shell.locator(`.desk-stage[data-phase="open"][data-group-id="${made}"][data-empty]`)).toHaveCount(1);
    await name.fill("Errands");
    await name.press("Enter");
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === made)?.title).toBe("Errands");
    expect((await snapshot(shell)).tabs.find((tab) => tab.id === inUse.id)?.url).toBe(inUse.url);

    // Over the address bar, or a page over the desk (Settings), ⌘N sweeps it away for the new space and its name.
    for (const [open, cover] of [
      [() => shell.keyboard.press("Meta+L"), "url-bar"],
      [() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send("pistachio:shell-command", { type: "runShortcut", id: "openSettings" })), "settings-page"],
    ] as const) {
      const spaces = spaceIds(await snapshot(shell));
      await open();
      await expect(shell.getByTestId(cover)).toBeVisible();
      await shell.keyboard.press("Meta+N");
      await expect(shell.getByTestId(cover)).toHaveCount(0);
      await expect.poll(async () => {
        const now = await snapshot(shell);
        return now.currentGroupId != null && !spaces.has(now.currentGroupId);
      }).toBe(true);
      const next = (await snapshot(shell)).currentGroupId!;
      const field = spaceView(shell, next).getByTestId("tab-group-name-input");
      await expect(field).toBeFocused();
      await field.fill(cover === "url-bar" ? "Over the bar" : "Over Settings");
      await field.press("Enter");
      await expect(field).toHaveCount(0);
    }

    // The sidebar hidden and away: it comes out for the name, its field taking the keyboard.
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.updateSettings({ layout: { sidebar: "hidden" } }));
    await expect(shell.getByTestId("sidebar-pane")).toHaveAttribute("data-hidden", "");
    const shown = spaceIds(await snapshot(shell));
    await shell.keyboard.press("Meta+N");
    await expect.poll(async () => {
      const now = await snapshot(shell);
      return now.currentGroupId != null && !shown.has(now.currentGroupId);
    }).toBe(true);
    const away = (await snapshot(shell)).currentGroupId!;
    const field = spaceView(shell, away).getByTestId("tab-group-name-input");
    await expect(shell.getByTestId("sidebar-pane")).not.toHaveAttribute("data-hidden", "");
    await expect(field).toBeFocused();
    await field.fill("Hidden away");
    await field.press("Enter");
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === away)?.title).toBe("Hidden away");
  });

  test("⌘T opens the address bar when New tabs open says so, its choice a window in the current space", async () => {
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.updateSettings({ general: { newTab: "address" } }));
    const space = (await snapshot(shell)).currentGroupId!;

    await shell.keyboard.press("Meta+T");
    await expect(shell.getByTestId("url-bar")).toBeVisible();
    await expect(shell.getByTestId("url-bar-destination")).toHaveText("New tab");
    const epsilon = `${origin}/epsilon`;
    await go(shell, epsilon);
    await expect
      .poll(async () => {
        const now = await snapshot(shell);
        const made = now.tabs.find((tab) => tab.url === epsilon);
        return { inUse: made !== undefined && now.activeTabId === made.id, space: made === undefined ? null : spaceOf(now, made.id), current: now.currentGroupId };
      })
      .toEqual({ inUse: true, space, current: space });
    const made = (await snapshot(shell)).tabs.find((tab) => tab.url === epsilon)!;
    await expect(shell.locator(windowSelector(made.id))).toBeVisible();
  });
});
