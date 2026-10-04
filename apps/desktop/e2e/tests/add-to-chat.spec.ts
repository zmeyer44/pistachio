import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { IPC, type PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellReady } from "./windows";
import { launchApp } from "./app";
import { captureWindow, pageAt } from "./agent-harness";

/**
 * What goes with a message from the composer, on local pages and no model:
 * a page's image and selected words added from its context menu, and the
 * page in view, attached unless the person dismisses it
 * (docs/console-routing.md §5.1).
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

test.describe.serial("the composer's attachments", { tag: ["@agent"] }, () => {
  test.describe.configure({ timeout: 45_000 });

  let server: Server;
  let origin: string;
  let app: ElectronApplication;
  let shell: Page;

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    // Two plain pages for the page-in-view chip, each named by its title.
    server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const title = path === "/guidelines" ? "Brand Guidelines" : path === "/pricing" ? "Pricing" : null;
      if (title === null) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>Typography: use Inter at 16px.</p></body></html>`);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    // The console starts closed: choosing a page menu's item must open it.
    ({ app } = await launchApp({
      name: "add-to-chat",
      settings: { layout: { sidebar: "pinned" }, general: { consoleOpenOnLaunch: false } },
    }));
    shell = await shellReady(app);
  });

  test.afterAll(async () => {
    await app?.close();
    if (server !== undefined) await new Promise<void>((done) => server.close(() => done()));
  });

  test("a page's image and selected words land in the composer as attachments", async () => {
    await interceptPageMenus(app);
    await expect(shell.getByTestId("delegation-intent")).toHaveCount(0);

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

    // Add Image to Chat: the console opens with the image staged, named for
    // its bytes, and the composer focused for the words to go with it.
    await chooseMenuItem(app, page, "#fixture-image", "Add Image to Chat");
    const staged = shell.getByTestId("staged-attachments");
    await expect(staged.locator("img")).toHaveCount(1);
    await expect(staged.locator("img")).toHaveAttribute("alt", "image.png");
    await expect(staged.locator("img")).toHaveAttribute("src", PNG_DATA_URL);
    await expect(shell.getByTestId("delegation-intent")).toBeFocused();
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
    const chip = shell.getByTestId("staged-selection");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("Reconcile the Atlas invoice before Frid…");
    await expect(chip).toHaveAttribute("title", "Selected on Atlas Medical Supply · Vendor record");
    await expect(staged.locator("img")).toHaveCount(1);
    await captureWindow(app, "add-to-chat", "03-selection-staged.png");

    // Both are removable like any dropped file.
    await shell.getByRole("button", { name: "Remove selection" }).click();
    await expect(chip).toHaveCount(0);
    await shell.getByRole("button", { name: "Remove image.png" }).click();
    await expect(shell.getByTestId("staged-attachments")).toHaveCount(0);
  });

  test("the page in view is attached to a message until the person dismisses it", async () => {
    // What reaches main: the composer's sends are recorded, not run.
    await app.evaluate(({ ipcMain }, channels) => {
      const sent: unknown[][] = [];
      (globalThis as unknown as { sent: unknown[][] }).sent = sent;
      ipcMain.removeHandler(channels.start);
      ipcMain.handle(channels.start, (_event, ...args: unknown[]) => void sent.push(args));
    }, { start: IPC.runStart });
    const sent = (): Promise<unknown[][]> => app.evaluate(() => (globalThis as unknown as { sent: unknown[][] }).sent);

    // The console is open from the step before; the page in view is a plain web page.
    await shell.evaluate((url) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(url), `${origin}/guidelines`);
    const chip = shell.getByTestId("composer-context");
    await expect(chip).toHaveText("Brand Guidelines");
    await expect(chip).toHaveAttribute("data-page-attached", "true");
    const dismiss = shell.getByTestId("composer-context-dismiss");
    await expect(dismiss).toBeVisible();
    await captureWindow(app, "composer-page-context", "01-page-attached.png", 150);

    // Attached: the message goes with the page.
    await shell.getByTestId("delegation-intent").fill("does this mention rules around typography?");
    await shell.getByTestId("delegation-intent").press("Enter");
    await expect.poll(async () => (await sent()).at(-1)?.[2]).toEqual({ page: true });

    // Dismissed: struck through, "Attach" offered, and the message goes without it.
    await dismiss.click();
    await expect(chip).toHaveAttribute("data-page-attached", "false");
    await expect(shell.getByTestId("composer-context-attach")).toBeVisible();
    await captureWindow(app, "composer-page-context", "02-page-dismissed.png", 150);
    await shell.getByTestId("delegation-intent").fill("what is a hash map?");
    await shell.getByTestId("delegation-intent").press("Enter");
    await expect.poll(async () => (await sent()).at(-1)?.[2]).toEqual({ page: false });

    // "Attach" undoes it.
    await shell.getByTestId("composer-context-attach").click();
    await expect(chip).toHaveAttribute("data-page-attached", "true");

    // A dismissal belongs to its page: another page is attached again.
    await dismiss.click();
    await expect(chip).toHaveAttribute("data-page-attached", "false");
    await shell.evaluate((url) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(url), `${origin}/pricing`);
    await expect(chip).toHaveText("Pricing");
    await expect(chip).toHaveAttribute("data-page-attached", "true");
  });
});
