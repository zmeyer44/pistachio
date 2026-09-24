import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";

/** An app-served page whose CSP admits data: images, so the test needs no network. */
const PAGE_URL = "pistachio://demo/vendors/atlas-medical";
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAF0lEQVR42mP8z8DwnwEIGIEEAxQwYgEAcQwEAd0b4hkAAAAASUVORK5CYII=";
const screenshotDirectory = join(process.cwd(), "e2e/screenshots/add-to-chat");

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", suffix),
  ].find((candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")));
}

async function captureWindow(app: ElectronApplication, filename: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return (await window.capturePage()).toPNG().toString("base64");
  });
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(join(screenshotDirectory, filename), Buffer.from(png, "base64"));
}

async function pageAt(app: ElectronApplication, url: string): Promise<Page> {
  await expect.poll(() => app.windows().some((page) => page.url() === url)).toBe(true);
  const page = app.windows().find((candidate) => candidate.url() === url);
  if (page === undefined) throw new Error(`No Electron page at ${url}`);
  return page;
}

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

test("a page's image and selected words land in the composer as attachments", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-add-to-chat-"));
  // The console starts closed: choosing the item must open it.
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" }, general: { consoleOpenOnLaunch: false } }),
  );
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });

  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
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
    await captureWindow(app, "01-page-ready.png");

    // Add Image to Chat: the console opens with the image staged, named for
    // its bytes, and the composer focused for the words to go with it.
    await chooseMenuItem(app, page, "#fixture-image", "Add Image to Chat");
    const staged = shell.getByTestId("staged-attachments");
    await expect(staged.locator("img")).toHaveCount(1);
    await expect(staged.locator("img")).toHaveAttribute("alt", "image.png");
    await expect(staged.locator("img")).toHaveAttribute("src", PNG_DATA_URL);
    await expect(shell.getByTestId("delegation-intent")).toBeFocused();
    await captureWindow(app, "02-image-staged.png");

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
    await captureWindow(app, "03-selection-staged.png");

    // Both are removable like any dropped file.
    await shell.getByRole("button", { name: "Remove selection" }).click();
    await expect(chip).toHaveCount(0);
    await shell.getByRole("button", { name: "Remove image.png" }).click();
    await expect(shell.getByTestId("staged-attachments")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
