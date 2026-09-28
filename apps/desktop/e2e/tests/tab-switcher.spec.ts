import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { KeyboardInputEvent } from "electron";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { pageFirst, shellReady } from "./windows";

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", suffix),
  ].find((candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")));
}

async function launch(name: string): Promise<ElectronApplication> {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), `pistachio-${name}-`));
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst()));
  return electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
}

/** Open each address as a new, selected tab; the ids in visit order. */
async function openTabs(shell: Page, urls: string[]): Promise<string[]> {
  return shell.evaluate(async (targets) => {
    const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
    const ids: string[] = [];
    for (const url of targets) {
      await api.createTab(url);
      const active = (await api.getSnapshot()).activeTabId;
      if (active === null) throw new Error("the new tab was not selected");
      ids.push(active);
    }
    return ids;
  }, urls);
}

function activeTabId(shell: Page): Promise<string | null> {
  return shell.evaluate(async () =>
    (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot().then((state) => state.activeTabId),
  );
}

/**
 * Native key events into one view — the page at `url`, or the shell —
 * through the same before-input-event path a real keyboard takes (Playwright's
 * keyboard bypasses it). The view is not refocused: the switcher moves the
 * keyboard itself, and the test follows it.
 */
async function sendKeys(app: ElectronApplication, target: { url: string } | "shell", inputs: KeyboardInputEvent[]): Promise<void> {
  await app.evaluate(({ BrowserWindow, webContents }, { target, inputs }) => {
    const contents =
      target === "shell"
        ? BrowserWindow.getAllWindows()[0]?.webContents
        : webContents.getAllWebContents().find((candidate) => candidate.getURL() === target.url);
    if (contents === undefined) throw new Error(`no view for ${JSON.stringify(target)}`);
    for (const input of inputs) contents.sendInputEvent(input);
  }, { target, inputs });
}

async function focusPage(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate(({ webContents }, target) => {
    webContents.getAllWebContents().find((candidate) => candidate.getURL() === target)?.focus();
  }, url);
}

function focusedUrl(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(({ BrowserWindow, webContents }) => {
    const shell = BrowserWindow.getAllWindows()[0]?.webContents;
    const focused = webContents.getAllWebContents().find((candidate) => candidate.isFocused());
    if (focused === undefined) return null;
    return focused === shell ? "shell" : focused.getURL();
  });
}

/** Start recording the keydowns the page at `url` sees, as "meta+b" (a modifier on its own is not recorded). */
async function recordPageKeys(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate(async ({ webContents }, target) => {
    await webContents
      .getAllWebContents()
      .find((candidate) => candidate.getURL() === target)
      ?.executeJavaScript(
        `window.__keys = [];
        addEventListener("keydown", (e) => {
          if (!["Meta", "Control", "Shift", "Alt"].includes(e.key)) window.__keys.push((e.metaKey ? "meta+" : "") + e.key);
        }, true);
        true`,
      );
  }, url);
}

/** Run `script` in the page at `url`. */
function inPage<T>(app: ElectronApplication, url: string, script: string): Promise<T> {
  return app.evaluate(
    ({ webContents }, { target, script }) =>
      webContents.getAllWebContents().find((candidate) => candidate.getURL() === target)?.executeJavaScript(script),
    { target: url, script },
  ) as Promise<T>;
}

const PAGES = [
  "pistachio://demo/vendors/atlas-medical?visit=1",
  "pistachio://demo/invoices?visit=2",
  "pistachio://demo/vendors/atlas-medical?visit=3",
  "pistachio://demo/invoices?visit=4",
  "pistachio://demo/vendors/atlas-medical?visit=5",
];

test("⌃Tab from a page opens on the previous tab with live thumbnails, and Return goes there", async () => {
  const app = await launch("tab-switcher-chord");
  try {
    const shell = await shellReady(app);
    const visited = await openTabs(shell, PAGES);
    await focusPage(app, PAGES[4]!);

    await sendKeys(app, { url: PAGES[4]! }, [
      { type: "keyDown", keyCode: "Control", modifiers: ["control"] },
      { type: "keyDown", keyCode: "Tab", modifiers: ["control"] },
    ]);

    const switcher = shell.getByTestId("tab-switcher");
    await expect(switcher).toHaveAttribute("data-ready", "");
    const options = switcher.getByTestId("tab-switcher-option");
    await expect(options.nth(0)).toHaveAttribute("data-tab-id", visited[4]!);
    await expect(options.nth(1)).toHaveAttribute("data-tab-id", visited[3]!);
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    // Every demo page is captured; the thumbnails arrive as main takes them.
    await expect.poll(() => options.locator(".tab-switcher-thumbnail > img").count()).toBeGreaterThanOrEqual(5);
    // The switcher took the keyboard, so the release lands where it is seen.
    expect(await focusedUrl(app)).toBe("shell");
    await shell.screenshot({ path: test.info().outputPath("tab-switcher-open.png") });

    await sendKeys(app, "shell", [{ type: "keyDown", keyCode: "Tab", modifiers: ["control"] }]);
    await expect(options.nth(2)).toHaveAttribute("aria-selected", "true");
    await sendKeys(app, "shell", [{ type: "keyDown", keyCode: "Tab", modifiers: ["control", "shift"] }]);
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await sendKeys(app, "shell", [{ type: "keyDown", keyCode: "Return", modifiers: ["control"] }]);

    await expect(switcher).toHaveCount(0);
    await expect.poll(() => activeTabId(shell)).toBe(visited[3]);
    // The chosen page has the keyboard back.
    await expect.poll(() => focusedUrl(app)).toBe(PAGES[3]);
  } finally {
    await app.close();
  }
});

test("holding ⌘ alone opens on the active tab; arrows move and Escape cancels", async () => {
  const app = await launch("tab-switcher-hold");
  try {
    const shell = await shellReady(app);
    const visited = await openTabs(shell, PAGES.slice(0, 3));
    await focusPage(app, PAGES[2]!);

    await sendKeys(app, { url: PAGES[2]! }, [{ type: "keyDown", keyCode: "Meta", modifiers: ["meta"] }]);
    const switcher = shell.getByTestId("tab-switcher");
    await expect(switcher).toHaveAttribute("data-ready", "");
    const options = switcher.getByTestId("tab-switcher-option");
    await expect(options.nth(0)).toHaveAttribute("data-tab-id", visited[2]!);
    await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");

    await sendKeys(app, "shell", [{ type: "keyDown", keyCode: "Right", modifiers: ["meta"] }]);
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await sendKeys(app, "shell", [{ type: "keyDown", keyCode: "Escape", modifiers: ["meta"] }]);
    await expect(switcher).toHaveCount(0);
    expect(await activeTabId(shell)).toBe(visited[2]);
  } finally {
    await app.close();
  }
});

test("a page's shortcut typed once a ⌘ hold has the switcher up still reaches the page", async () => {
  const app = await launch("tab-switcher-pass-on");
  try {
    const shell = await shellReady(app);
    const visited = await openTabs(shell, PAGES.slice(0, 3));
    await focusPage(app, PAGES[2]!);
    await recordPageKeys(app, PAGES[2]!);
    await sendKeys(app, { url: PAGES[2]! }, [{ type: "keyDown", keyCode: "b", modifiers: ["meta"] }]);
    await expect.poll(() => inPage<string[]>(app, PAGES[2]!, "window.__keys")).toEqual(["meta+b"]);

    await sendKeys(app, { url: PAGES[2]! }, [{ type: "keyDown", keyCode: "Meta", modifiers: ["meta"] }]);
    const switcher = shell.getByTestId("tab-switcher");
    await expect(switcher).toHaveAttribute("data-ready", "");
    expect(await focusedUrl(app)).toBe("shell");
    // The shell has the keyboard now; ⌘B cancels the switcher and goes on to the page.
    await sendKeys(app, "shell", [{ type: "keyDown", keyCode: "b", modifiers: ["meta"] }]);
    await expect(switcher).toHaveCount(0);
    await expect.poll(() => inPage<string[]>(app, PAGES[2]!, "window.__keys")).toEqual(["meta+b", "meta+b"]);
    expect(await focusedUrl(app)).toBe(PAGES[2]);
    expect(await activeTabId(shell)).toBe(visited[2]);

    // An Edit menu key does its work there too, though the menu never sees a sent key.
    await inPage(app, PAGES[2]!, "getSelection().removeAllRanges(); true");
    await sendKeys(app, { url: PAGES[2]! }, [{ type: "keyDown", keyCode: "Meta", modifiers: ["meta"] }]);
    await expect(switcher).toHaveAttribute("data-ready", "");
    await sendKeys(app, "shell", [{ type: "keyDown", keyCode: "a", modifiers: ["meta"] }]);
    await expect(switcher).toHaveCount(0);
    await expect.poll(() => inPage<number>(app, PAGES[2]!, "getSelection().toString().length")).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});

test("a pressed shortcut is never taken for a hold", async () => {
  const app = await launch("tab-switcher-shortcut");
  try {
    const shell = await shellReady(app);
    await openTabs(shell, PAGES.slice(0, 2));
    await focusPage(app, PAGES[1]!);
    await sendKeys(app, { url: PAGES[1]! }, [
      { type: "keyDown", keyCode: "Meta", modifiers: ["meta"] },
      { type: "keyDown", keyCode: "Shift", modifiers: ["meta", "shift"] },
    ]);
    await shell.waitForTimeout(800);
    await expect(shell.getByTestId("tab-switcher")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("the pointer picks a card, and the modifier's release goes to it", async () => {
  const app = await launch("tab-switcher-hover");
  try {
    const shell = await shellReady(app);
    const visited = await openTabs(shell, PAGES.slice(0, 3));
    await focusPage(app, PAGES[2]!);

    await sendKeys(app, { url: PAGES[2]! }, [{ type: "keyDown", keyCode: "Control", modifiers: ["control"] }]);
    const switcher = shell.getByTestId("tab-switcher");
    await expect(switcher).toHaveAttribute("data-ready", "");
    const options = switcher.getByTestId("tab-switcher-option");
    const target = options.nth(2);
    await expect(target).toHaveAttribute("data-tab-id", visited[0]!);

    // The document sees the held modifier on the pointer's events too.
    await shell.keyboard.down("Control");
    const box = await target.boundingBox();
    if (box === null) throw new Error("the card has no box");
    await shell.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await shell.mouse.move(box.x + box.width / 2 + 4, box.y + box.height / 2 + 2);
    await expect(target).toHaveAttribute("aria-selected", "true");

    // Electron's synthetic input carries no modifier-only keyUp; a key sent
    // without the flag is how main learns of a release it did not see.
    await sendKeys(app, "shell", [{ type: "keyDown", keyCode: "Shift", modifiers: ["shift"] }]);
    await expect(switcher).toHaveCount(0);
    await expect.poll(() => activeTabId(shell)).toBe(visited[0]);
    await shell.keyboard.up("Control");
  } finally {
    await app.close();
  }
});

test("a quick ⌃Tab flips to the previous tab", async () => {
  const app = await launch("tab-switcher-flip");
  try {
    const shell = await shellReady(app);
    const visited = await openTabs(shell, PAGES.slice(0, 3));
    await focusPage(app, PAGES[2]!);
    await sendKeys(app, { url: PAGES[2]! }, [
      { type: "keyDown", keyCode: "Control", modifiers: ["control"] },
      { type: "keyDown", keyCode: "Tab", modifiers: ["control"] },
    ]);
    await sendKeys(app, "shell", [{ type: "keyDown", keyCode: "Return", modifiers: ["control"] }]);
    await expect.poll(() => activeTabId(shell)).toBe(visited[1]);
    await expect(shell.getByTestId("tab-switcher")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("closing the active tab returns to the most recently visited tab", async () => {
  const app = await launch("tab-close-mru");
  try {
    const shell = await shellReady(app);
    const outcome = await shell.evaluate(async () => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      const ids: string[] = [];
      for (const url of [
        "pistachio://demo/vendors/atlas-medical?close=1",
        "pistachio://demo/invoices?close=2",
        "pistachio://demo/vendors/atlas-medical?close=3",
      ]) {
        await api.createTab(url);
        const active = (await api.getSnapshot()).activeTabId;
        if (active === null) throw new Error("the new tab was not selected");
        ids.push(active);
      }
      // Visit order is now C > B > A; return to B so C is the previous tab.
      await api.selectTab(ids[1]!);
      await api.closeTab(ids[1]!);
      return { survivorId: ids[2], activeTabId: (await api.getSnapshot()).activeTabId };
    });
    expect(outcome.activeTabId).toBe(outcome.survivorId);
  } finally {
    await app.close();
  }
});
