import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellReady } from "./windows";
import { launchApp } from "./app";
import { captureWindow, pageAt } from "./agent-harness";

/**
 * What a page's context menu adds to a message, on a local page and no
 * model: its image and its selected words, staged in the chat's field — the
 * desk's Bar, the desktop's one chat (no panel stands beside the desk since
 * 2026-11-16). (The page-in-view chip — attached unless the person dismisses
 * it, docs/console-routing.md §5.1 — is the sidebar console's, which is the
 * web's alone now: at a desk the space is the subject, and the Bar's message
 * names no page.)
 */

/** An app-served page whose CSP admits data: images, so the test needs no network. */
const PAGE_URL = "pistachio://demo/vendors/atlas-medical";
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAF0lEQVR42mP8z8DwnwEIGIEEAxQwYgEAcQwEAd0b4hkAAAAASUVORK5CYII=";

/**
 * A native context menu cannot be driven from Playwright, so the main
 * process keeps every template the page menu builds and swallows the popup;
 * the test then chooses an item exactly as a click on it would.
 */
async function interceptPageMenus(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const templates: Electron.MenuItemConstructorOptions[][] = [];
    (globalThis as { __pageMenus?: unknown }).__pageMenus = templates;
    Menu.buildFromTemplate = ((template: Electron.MenuItemConstructorOptions[]) => {
      templates.push(template);
      return { popup() {}, closePopup() {} };
    }) as unknown as typeof Menu.buildFromTemplate;
  });
}

async function chooseMenuItem(app: ElectronApplication, page: Page, selector: string, label: string): Promise<void> {
  const before = await app.evaluate(() => ((globalThis as { __pageMenus?: unknown[] }).__pageMenus ?? []).length);
  await page.click(selector, { button: "right" });
  await expect
    .poll(() => app.evaluate(() => ((globalThis as { __pageMenus?: unknown[] }).__pageMenus ?? []).length))
    .toBeGreaterThan(before);
  const outcome = await app.evaluate(
    (_electron, { index, label }) => {
      const menus = (globalThis as { __pageMenus?: Electron.MenuItemConstructorOptions[][] }).__pageMenus ?? [];
      const item = menus[index]?.find((candidate) => candidate.label === label);
      if (item === undefined) return `missing "${label}" in: ${(menus[index] ?? []).map((entry) => entry.label ?? entry.role ?? "—").join(", ")}`;
      if (item.enabled === false) return `"${label}" is disabled`;
      (item.click as () => void)();
      return "ok";
    },
    { index: before, label },
  );
  expect(outcome).toBe("ok");
}

test.describe.serial("a page's image and words, added to the chat", { tag: ["@agent"] }, () => {
  test.describe.configure({ timeout: 45_000 });

  let app: ElectronApplication;
  let shell: Page;

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    ({ app } = await launchApp({
      name: "add-to-chat",
      settings: { layout: { sidebar: "pinned" } },
      // Its pages are clicked by Playwright beside another window, which Fit zooms out: Playwright's own click geometry
      // misses on a page under device emulation (a person's press is mapped), so every page is at its own size.
      deskFeel: { zoom: "actual" },
    }));
    shell = await shellReady(app);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("a page's image and selected words land in the Bar's field as attachments, the pill out for them", async () => {
    await interceptPageMenus(app);
    // The chat is in its nub: nothing out, and no panel beside the desk.
    await expect(shell.getByTestId("agent-panel")).toHaveCount(0);
    await expect(shell.getByTestId("desk-bar")).toHaveAttribute("data-compact", "");

    await shell.evaluate((url) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(url), PAGE_URL);
    const page = await pageAt(app, PAGE_URL);
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate((png) => {
      const box = document.createElement("div");
      box.id = "fixture";
      box.style.cssText = "position:fixed;top:16px;left:16px;z-index:9999;display:flex;flex-direction:column;gap:12px;background:#fff;padding:12px";
      box.innerHTML = `<img id="fixture-image" width="64" height="64" src="${png}"><p id="fixture-words" style="font:18px serif">Reconcile the Atlas invoice before Friday</p>`;
      document.body.prepend(box);
    }, PNG_DATA_URL);
    await page.waitForFunction(() => (document.getElementById("fixture-image") as HTMLImageElement).naturalWidth > 0);
    await captureWindow(app, "add-to-chat", "01-page-ready.png");

    // Add Image to Chat: the pill comes out of the nub with the image staged, named for its bytes, and the keyboard
    // in its field for the words to go with it. No conversation yet, so no answer card comes up for it.
    await chooseMenuItem(app, page, "#fixture-image", "Add Image to Chat");
    const staged = shell.getByTestId("desk-bar-staged");
    await expect(staged.locator("img")).toHaveCount(1);
    await expect(staged.locator("img")).toHaveAttribute("alt", "image.png");
    await expect(staged.locator("img")).toHaveAttribute("src", PNG_DATA_URL);
    await expect(shell.getByTestId("desk-bar")).not.toHaveAttribute("data-compact", "");
    await expect(shell.getByTestId("desk-bar-input")).toBeFocused();
    await expect(shell.getByTestId("desk-answer")).toHaveCount(0);
    await captureWindow(app, "add-to-chat", "02-image-staged.png");

    // Add Selection to Chat: the words join the image as a quote chip.
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("fixture-words") as HTMLElement);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await chooseMenuItem(app, page, "#fixture-words", "Add Selection to Chat");
    const chip = staged.getByTestId("staged-selection");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("Reconcile the Atlas invoice before Frid…");
    await expect(chip).toHaveAttribute("title", "Selected on Atlas Medical Supply · Vendor record");
    await expect(staged.locator("img")).toHaveCount(1);
    await captureWindow(app, "add-to-chat", "03-selection-staged.png");

    // Both are removable like any dropped file.
    await shell.getByRole("button", { name: "Remove selection" }).click();
    await expect(chip).toHaveCount(0);
    await shell.getByRole("button", { name: "Remove image.png" }).click();
    await expect(shell.getByTestId("desk-bar-staged")).toHaveCount(0);
  });

  test("what is added is its space's: a picture read once the person has gone on, and across a change of Profile", async () => {
    const page = await pageAt(app, PAGE_URL);
    const pistachio = <T,>(call: (api: PistachioApi) => Promise<T>): Promise<T> => shell.evaluate(`(${call.toString()})(window.pistachio)`) as Promise<T>;
    const current = (): Promise<string | null> => pistachio((api) => api.getSnapshot()).then((state) => state.currentGroupId ?? null);
    const staged = shell.getByTestId("desk-bar-staged");
    const here = (await current())!;
    // (Every shell command main sends from here on is kept, to read what it says of the space.)
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      const sent: unknown[] = [];
      (globalThis as { __shellCommands?: unknown[] }).__shellCommands = sent;
      const send = contents.send.bind(contents);
      contents.send = ((channel: string, ...args: unknown[]) => {
        if (channel === "pistachio:shell-command") sent.push(args[0]);
        send(channel, ...args);
      }) as typeof contents.send;
    });

    // Added here: staged here, and main says which space it was added in.
    await chooseMenuItem(app, page, "#fixture-image", "Add Image to Chat");
    await expect(staged.locator("img")).toHaveCount(1);
    const added = await app.evaluate(() => ((globalThis as { __shellCommands?: Array<{ type?: string; groupId?: string }> }).__shellCommands ?? []).filter((command) => command.type === "attachToChat"));
    expect(added.map((command) => command.groupId)).toEqual([here]);

    // Another space: its field holds nothing of this one's.
    await pistachio((api) => api.tabGroupCommand({ type: "create", id: "space-other", tabIds: [], title: "Other", select: true }));
    await expect.poll(current).toBe("space-other");
    await expect(staged).toHaveCount(0);
    // A picture added in the first space, read only now that the person is in this one (main's command, as it sends
    // it when the read is done): it is the first space's — staged there, with what that space was left with.
    await app.evaluate(
      ({ BrowserWindow }, { url, groupId }) =>
        BrowserWindow.getAllWindows()[0]!.webContents.send("pistachio:shell-command", { type: "attachToChat", insert: { kind: "image", name: "late.png", mediaType: "image/png", url }, groupId }),
      { url: PNG_DATA_URL, groupId: here },
    );
    await shell.evaluate((groupId) => (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "select", groupId }), here);
    await expect.poll(current).toBe(here);
    await expect(staged.locator("img")).toHaveCount(2);
    await expect(staged.locator("img").nth(1)).toHaveAttribute("alt", "late.png");
    // (And this space's alone: the other one's field was handed nothing.)
    await pistachio((api) => api.tabGroupCommand({ type: "select", groupId: "space-other" }));
    await expect.poll(current).toBe("space-other");
    await expect(staged).toHaveCount(0);
    await shell.evaluate((groupId) => (window as unknown as { pistachio: PistachioApi }).pistachio.tabGroupCommand({ type: "select", groupId }), here);
    await expect.poll(current).toBe(here);
    await expect(staged.locator("img")).toHaveCount(2);

    // Another Profile and back — the desk, and the Bar with it, are made anew for each: what this space's field held
    // (the words too) is here again.
    await shell.getByTestId("desk-bar-input").fill("half a thought");
    const first = await pistachio(async (api) => {
      const from = (await api.getSnapshot()).activeSpaceId;
      await api.forkSpace({ name: "Research", purpose: "Somewhere else", tabs: "active", includeShelf: false, includeSession: false });
      return from;
    });
    await expect.poll(() => pistachio((api) => api.getSnapshot()).then((state) => state.activeSpaceId)).not.toBe(first);
    await expect(staged).toHaveCount(0);
    await shell.evaluate((spaceId) => (window as unknown as { pistachio: PistachioApi }).pistachio.switchSpace(spaceId), first);
    await expect.poll(() => pistachio((api) => api.getSnapshot()).then((state) => state.activeSpaceId)).toBe(first);
    await expect.poll(current).toBe(here);
    await expect(staged.locator("img")).toHaveCount(2);
    await expect(shell.getByTestId("desk-bar-input")).toHaveValue("half a thought");
  });
});
