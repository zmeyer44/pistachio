/**
 * The address field shows where the active row goes (shell-ui's
 * lib/use-field-preview.ts), in the home page's search and the address modal
 * alike: ↑/↓ commit to the row's text, the pointer only looks.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/address-preview");

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [process.env["PISTACHIO_ELECTRON_PATH"], join(process.cwd(), "node_modules/electron", executableSuffix)];
  return candidates.find(
    (candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

async function captureShell(app: ElectronApplication, shell: Page, filename: string): Promise<void> {
  // The frame that shows the field's new text has to be painted before it can be captured.
  await shell.evaluate(() => new Promise((painted) => requestAnimationFrame(() => requestAnimationFrame(painted))));
  await shell.waitForTimeout(150);
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return (await window.capturePage()).toPNG().toString("base64");
  });
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(join(screenshotDirectory, filename), Buffer.from(png, "base64"));
}

async function tabs(shell: Page): Promise<Array<{ id: string; url: string; title: string }>> {
  return shell.evaluate(async () => {
    const snapshot = await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot();
    return snapshot.tabs.filter((tab) => tab.kind === "human").map(({ id, url, title }) => ({ id, url, title }));
  });
}

/** ↑/↓ until `row` is the active one — chips and groups make the count the list's business. */
async function arrowTo(shell: Page, list: Locator, row: Locator): Promise<void> {
  const active = list.locator("[data-index].bg-alpha-200, [data-index].bg-alpha-300");
  for (let presses = 0; presses < 24; presses++) {
    const target = Number(await row.getAttribute("data-index"));
    const at = (await active.count()) === 0 ? -1 : Number(await active.first().getAttribute("data-index"));
    if (at === target) return;
    await shell.keyboard.press(at < target ? "ArrowDown" : "ArrowUp");
  }
  await expect(row).toHaveClass(/bg-alpha-200/);
}

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/one") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head><title>Fixture One</title></head><body><h1>Fixture One</h1></body></html>");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

test.afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

test("the address field shows the active row's text, from the arrows and from the pointer", async () => {
  test.setTimeout(120_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-address-preview-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" } }));
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    // No model: the order under test is the heuristics' own.
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData, PISTACHIO_INTENT_MODEL: "off" },
  });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    await expect(shell.getByTestId("home-page")).toBeVisible();
    const homeId = (await tabs(shell))[0]!.id;
    const fixtureUrl = `${origin}/one`;

    // A second tab to find, then back to the home tab.
    await shell.evaluate((url) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(url), fixtureUrl);
    await expect.poll(async () => (await tabs(shell)).find((tab) => tab.url === fixtureUrl)?.title).toBe("Fixture One");
    const fixtureId = (await tabs(shell)).find((tab) => tab.url === fixtureUrl)!.id;
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(id), homeId);

    // ── The home page's search ──────────────────────────────────────────────
    const homeInput = shell.getByTestId("home-search-input");
    await homeInput.click();
    await shell.keyboard.type("Fixture");
    const homeResults = shell.getByTestId("home-search-results");
    const homeTabRow = homeResults.locator(`[data-tab-id="${fixtureId}"]`);
    await expect(homeTabRow).toBeVisible();
    // The list's own default selection is not a preview.
    await expect(homeInput).toHaveValue("Fixture");

    // ↓ down the list and ↑ back: the field follows the active row. The rows
    // that ARE the typed text (the web search, the AI prompt) leave it alone.
    await shell.keyboard.press("ArrowDown");
    await arrowTo(shell, homeResults, homeTabRow);
    await expect(homeInput).toHaveValue(fixtureUrl);
    await captureShell(app, shell, "01-home-arrow-preview.png");
    await arrowTo(shell, homeResults, homeResults.locator('[data-suggestion-kind="search"]'));
    await expect(homeInput).toHaveValue("Fixture");

    // A row reached by the arrows is text to edit: what is typed next lands on it.
    await arrowTo(shell, homeResults, homeTabRow);
    await shell.keyboard.type("?x");
    await expect(homeInput).toHaveValue(`${fixtureUrl}?x`);
    await expect(homeResults.locator('[data-suggestion-kind="navigate"]')).toBeVisible();

    // The pointer only looks: the field shows the row under it, puts the typed
    // text back when it leaves the list…
    await homeInput.fill("Fixture");
    await expect(homeTabRow).toBeVisible();
    await homeTabRow.hover();
    await expect(homeInput).toHaveValue(fixtureUrl);
    await captureShell(app, shell, "02-home-hover-preview.png");
    await homeInput.hover();
    await expect(homeInput).toHaveValue("Fixture");
    // …and typing over a look continues what was typed, not the row's address.
    await homeTabRow.hover();
    await expect(homeInput).toHaveValue(fixtureUrl);
    await shell.keyboard.type("s");
    await expect(homeInput).toHaveValue("Fixtures");
    await shell.keyboard.press("Escape");
    await expect(homeInput).toHaveValue("");
    await shell.keyboard.press("Escape");

    // ── The address modal ───────────────────────────────────────────────────
    // Over the home tab the field opens empty; ↓ into the open tabs shows the
    // tab's address, and ↑ back out of the list shows the empty field again.
    await shell.keyboard.press("Meta+L");
    const address = shell.getByTestId("address-input");
    await expect(address).toBeFocused();
    await expect(address).toHaveValue("");
    const modal = shell.getByTestId("url-bar");
    // The dialog fades in; a capture before it lands shows no dialog at all.
    await expect(modal).toHaveCSS("opacity", "1");
    const modalTabRow = modal.locator(`[data-testid="open-tab-result"][data-tab-id="${fixtureId}"]`);
    await expect(modalTabRow).toBeVisible();
    await arrowTo(shell, modal, modalTabRow);
    await expect(address).toHaveValue(fixtureUrl);
    await captureShell(app, shell, "03-modal-arrow-preview.png");
    for (let presses = 0; presses < 24 && (await address.inputValue()) !== ""; presses++) await shell.keyboard.press("ArrowUp");
    await expect(address).toHaveValue("");
    await shell.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);

    // Over a page the field opens holding its address, selected. A pointer
    // that strays onto a row must not cost that: typing still replaces it.
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(id), fixtureId);
    await shell.keyboard.press("Meta+L");
    await expect(address).toBeFocused();
    await expect(address).toHaveValue(fixtureUrl);
    await expect(modal).toHaveCSS("opacity", "1");
    const homeTabInModal = modal.locator(`[data-testid="open-tab-result"][data-tab-id="${homeId}"]`);
    await expect(homeTabInModal).toBeVisible();
    await homeTabInModal.hover();
    await expect(address).not.toHaveValue(fixtureUrl);
    await captureShell(app, shell, "04-modal-hover-preview.png");
    await shell.keyboard.type("abc");
    await expect(address).toHaveValue("abc");

    // The typed face looks and lets go the same way.
    const typedHomeRow = modal.getByTestId("command-results").locator(`[data-tab-id="${homeId}"]`);
    await address.fill("Home");
    await expect(typedHomeRow).toBeVisible();
    await typedHomeRow.hover();
    await expect(address).not.toHaveValue("Home");
    await address.hover();
    await expect(address).toHaveValue("Home");
    await shell.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
  } finally {
    await app.close();
  }
});
