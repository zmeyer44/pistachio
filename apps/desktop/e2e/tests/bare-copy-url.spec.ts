/**
 * ⌘C with nothing selected copies the page's URL, as ⌘⇧C does — and only
 * then. A selection is copied as it always was, a page's own copy handler
 * (a canvas editor's, a code editor's copy-line) keeps the key, and a copy
 * nobody pressed ⌘C for leaves the clipboard alone.
 *
 * A real ⌘C reaches the page's before-input-event hook, then the Edit menu's
 * Copy. A key struck with sendInputEvent reaches only the first — macOS
 * matches menu key equivalents on the native event it lacks — so the spec
 * strikes it and then runs the menu's copy itself (`webContents.copy()`,
 * what the Copy role sends the focused page).
 */
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
import { pageFirst, shellReady } from "./windows";

function resolveElectronExecutable(): string | undefined {
  const executableSuffix = "dist/Electron.app/Contents/MacOS/Electron";
  const candidates = [process.env["PISTACHIO_ELECTRON_PATH"], join(process.cwd(), "node_modules/electron", executableSuffix)];
  return candidates.find(
    (candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    const ownCopy =
      request.url === "/editor"
        ? "<script>document.addEventListener('copy', (event) => { event.preventDefault(); event.clipboardData.setData('text/plain', 'the editor\\'s own'); });</script>"
        : "";
    response.end(
      `<!doctype html><title>Fixture One</title><body><h1>Fixture One</h1><input id="field" value="typed words">${ownCopy}</body>`,
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

test.afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

function readClipboard(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText());
}

async function writeClipboard(app: ElectronApplication, text: string): Promise<void> {
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
}

/** ⌘C in the tab view showing `url` — or, with `menuOnly`, Edit › Copy alone, no key. */
async function copyInPage(app: ElectronApplication, url: string, menuOnly = false): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, { url, menuOnly }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const view = window?.contentView.children.find(
        (child) => "webContents" in child && (child as WebContentsView).webContents.getURL() === url,
      ) as WebContentsView | undefined;
      if (view === undefined) throw new Error(`No tab view shows ${url}`);
      view.webContents.focus();
      if (!menuOnly) {
        view.webContents.sendInputEvent({ type: "keyDown", keyCode: "c", modifiers: ["meta"] });
        view.webContents.sendInputEvent({ type: "keyUp", keyCode: "c", modifiers: ["meta"] });
      }
      view.webContents.copy();
    },
    { url, menuOnly },
  );
}

async function tabPage(app: ElectronApplication, url: string): Promise<Page> {
  const found = app.windows().find((page) => page.url() === url);
  const page = found ?? (await app.waitForEvent("window", { predicate: (candidate) => candidate.url() === url }));
  await page.waitForLoadState("domcontentloaded");
  return page;
}

/** What ⌘C left on the clipboard, once it has had the time a stray URL copy would need to land. */
async function settledClipboard(app: ElectronApplication, page: Page): Promise<string> {
  await page.waitForTimeout(400);
  return readClipboard(app);
}

test("⌘C with nothing selected copies the page's URL, and nothing else changes", async () => {
  test.setTimeout(120_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-bare-copy-"));
  const plainUrl = `${origin}/`;
  const editorUrl = `${origin}/editor`;
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify(pageFirst({ general: { homeUrl: plainUrl }, layout: { mode: "sidebar", sidebar: "pinned" } })),
  );
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  // The clipboard is the machine's own; give back whatever was on it.
  const kept = await readClipboard(app);
  try {
    const shell = await shellReady(app);
    const page = await tabPage(app, plainUrl);

    // Nothing selected: the address.
    await writeClipboard(app, "before");
    await copyInPage(app, plainUrl);
    await expect.poll(() => readClipboard(app)).toBe(plainUrl);

    // Selected text is copied as it always was, and stays.
    await writeClipboard(app, "before");
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("h1") as HTMLElement);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
    });
    await copyInPage(app, plainUrl);
    await expect.poll(() => readClipboard(app)).toBe("Fixture One");
    expect(await settledClipboard(app, page)).toBe("Fixture One");

    // A text field: its selected words, or the address when only the caret is there.
    await writeClipboard(app, "before");
    await page.evaluate(() => {
      const field = document.getElementById("field") as HTMLInputElement;
      field.focus();
      field.setSelectionRange(0, 5);
    });
    await copyInPage(app, plainUrl);
    await expect.poll(() => readClipboard(app)).toBe("typed");
    expect(await settledClipboard(app, page)).toBe("typed");
    await page.evaluate(() => (document.getElementById("field") as HTMLInputElement).setSelectionRange(3, 3));
    await copyInPage(app, plainUrl);
    await expect.poll(() => readClipboard(app)).toBe(plainUrl);

    // Edit › Copy with nothing selected, no ⌘C: nothing to copy, nothing copied.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      document.getSelection()?.removeAllRanges();
    });
    await writeClipboard(app, "before");
    await copyInPage(app, plainUrl, true);
    expect(await settledClipboard(app, page)).toBe("before");

    // A page that answers copy itself keeps the key.
    await page.goto(editorUrl);
    await writeClipboard(app, "before");
    await copyInPage(app, editorUrl);
    await expect.poll(() => readClipboard(app)).toBe("the editor's own");
    expect(await settledClipboard(app, page)).toBe("the editor's own");

    // The chrome holding the keyboard, nothing selected in it: the address too.
    await writeClipboard(app, "before");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.focus());
    await shell.evaluate(() => document.getSelection()?.removeAllRanges());
    await shell.keyboard.press("Meta+C");
    await expect.poll(() => readClipboard(app)).toBe(editorUrl);
  } finally {
    await writeClipboard(app, kept);
    await app.close();
  }
});
