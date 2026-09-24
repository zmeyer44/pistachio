/**
 * The keyboard, at the level below the DOM: which web contents the window
 * delivers keystrokes to. The shell draws the home page and every overlay in
 * its own document, so when either comes up over a page that was being typed
 * into, the shell's web contents must take the keyboard — the shell focusing
 * its own field is not enough. `page.keyboard` goes straight to a document
 * through CDP, so the shortcuts here are struck through Electron's input
 * pipeline, the way a real key reaches the page's before-input-event hook.
 */
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import type { WebContentsView } from "electron";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";

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
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head><title>Fixture One</title></head><body><h1>Fixture One</h1></body></html>");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

test.afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

/** Who holds the keyboard: "shell", a tab view (by URL), or nobody. */
function keyboardHolder(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    if (window.webContents.isFocused()) return "shell";
    for (const child of window.contentView.children) {
      if (!("webContents" in child)) continue;
      const view = child as WebContentsView;
      if (view.webContents.isFocused()) return view.webContents.getURL();
    }
    return null;
  });
}

/** Act on the tab view showing `url` in main. */
function withTabView(app: ElectronApplication, url: string, action: "focus" | "meta+l" | "meta+t"): Promise<void> {
  return app.evaluate(
    ({ BrowserWindow }, { url, action }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error("Pistachio window is unavailable");
      for (const child of window.contentView.children) {
        if (!("webContents" in child)) continue;
        const view = child as WebContentsView;
        if (view.webContents.getURL() !== url) continue;
        if (action === "focus") {
          view.webContents.focus();
          continue;
        }
        const keyCode = action === "meta+l" ? "l" : "t";
        view.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers: ["meta"] });
        view.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers: ["meta"] });
      }
    },
    { url, action },
  );
}

test("⌘L and ⌘T struck in a page hand the keyboard to the shell's address bar and home page", async () => {
  test.setTimeout(120_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-keyboard-handoff-"));
  await writeFile(join(userData, "settings.json"), JSON.stringify({ layout: { mode: "sidebar", sidebar: "pinned" } }));

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    await expect(shell.getByTestId("home-page")).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());

    // A fresh window opens on the home page: the shell has the keyboard, not
    // one of the chrome's hidden utility views.
    await expect.poll(() => keyboardHolder(app)).toBe("shell");

    // The first tab goes to a page, and the page is typed into.
    const url = `${origin}/one`;
    const firstId = await shell.evaluate(
      async () => (await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot()).activeTabId,
    );
    await shell.evaluate(({ id, url }) => (window as unknown as { pistachio: PistachioApi }).pistachio.navigate(id, url), {
      id: firstId!,
      url,
    });
    await expect(shell.getByTestId("home-page")).toHaveCount(0);
    await withTabView(app, url, "focus");
    await expect.poll(() => keyboardHolder(app)).toBe(url);

    // ⌘L in the page: the address bar comes up and the shell takes the keyboard.
    await withTabView(app, url, "meta+l");
    await expect(shell.getByTestId("url-bar")).toBeVisible();
    await expect.poll(() => keyboardHolder(app)).toBe("shell");
    await expect(shell.getByTestId("address-input")).toBeFocused();
    await shell.keyboard.press("Escape");
    await expect(shell.getByTestId("url-bar")).toHaveCount(0);

    // ⌘T in the page: the new tab's home page takes the keyboard for its search.
    await withTabView(app, url, "focus");
    await expect.poll(() => keyboardHolder(app)).toBe(url);
    await withTabView(app, url, "meta+t");
    await expect(shell.getByTestId("home-page")).toBeVisible();
    await expect.poll(() => keyboardHolder(app)).toBe("shell");
    await expect(shell.getByTestId("home-search-input")).toBeFocused();
  } finally {
    await app.close();
  }
});
