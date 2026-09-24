import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi, ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", suffix),
  ].find((candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")));
}

async function launch(executablePath: string, userData: string): Promise<{ app: ElectronApplication; shell: Page }> {
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  const shell = await shellPage(app);
  await shell.waitForLoadState("domcontentloaded");
  return { app, shell };
}

function snapshot(shell: Page): Promise<ShellSnapshot> {
  return shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot());
}

const navigate = (shell: Page, tabId: string, url: string): Promise<void> =>
  shell.evaluate(({ tabId, url }) => (window as unknown as { pistachio: PistachioApi }).pistachio.navigate(tabId, url), { tabId, url });
const goBack = (shell: Page, tabId: string): Promise<void> =>
  shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.goBack(tabId), tabId);
const closeTab = (shell: Page, tabId: string): Promise<void> =>
  shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(tabId), tabId);
const duplicateTab = (shell: Page, tabId: string): Promise<string> =>
  shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.duplicateTab(tabId), tabId);

/** Three linked pages, the last with a form, served by this test. */
async function fixture(): Promise<{ server: Server; origin: string }> {
  const page = (title: string, body: string) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1>${body}`;
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (request.url === "/museums") response.end(page("Museums", '<a href="/hotels">Hotels</a>'));
    else if (request.url === "/hotels")
      response.end(page("Hotels", '<textarea id="note" placeholder="Travel note"></textarea>'));
    else response.end(page("Travel planning", '<a href="/museums">Museums</a>'));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture did not bind a TCP port");
  return { server, origin: `http://127.0.0.1:${String(address.port)}` };
}

/** The draft in every live fixture page showing the given path. */
function draftsAt(app: ElectronApplication, url: string): Promise<string[]> {
  return app.evaluate(
    ({ webContents }, target) =>
      Promise.all(
        webContents
          .getAllWebContents()
          .filter((contents) => contents.getURL() === target)
          .map((contents) => contents.executeJavaScript("document.getElementById('note')?.value ?? ''") as Promise<string>),
      ),
    url,
  );
}

test("a tab's back/forward stack follows it through duplicate, reopen, and restart", async () => {
  test.setTimeout(90_000);
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-tab-history-"));
  const { server, origin } = await fixture();
  const home = `${origin}/`;
  const museums = `${origin}/museums`;
  const hotels = `${origin}/hotels`;
  const draft = "Book two rooms near the station.";
  let current: ElectronApplication | null = null;
  try {
    let launched = await launch(executablePath, userData);
    current = launched.app;
    let state = await snapshot(launched.shell);
    const original = state.activeTabId;
    if (original === null) throw new Error("initial tab unavailable");

    // Home → Museums → Hotels in one tab, then a draft on the last page.
    for (const url of [home, museums, hotels]) {
      await navigate(launched.shell, original, url);
      await expect.poll(async () => (await snapshot(launched.shell)).tabs.find((tab) => tab.id === original)?.url).toBe(url);
    }
    await expect.poll(async () => (await snapshot(launched.shell)).tabs.find((tab) => tab.id === original)?.canGoBack).toBe(true);
    await launched.app.evaluate(
      ({ webContents }, { target, value }) => {
        const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === target);
        if (contents === undefined) throw new Error("fixture page is unavailable");
        return contents.executeJavaScript(
          `(() => { const note = document.getElementById("note"); note.value = ${JSON.stringify(value)}; note.dispatchEvent(new Event("input", { bubbles: true })); })()`,
        );
      },
      { target: hotels, value: draft },
    );
    // Chromium commits form state to the navigation entry on a short timer.
    await launched.shell.waitForTimeout(1_500);

    // Duplicate: the copy can go Back to Museums, and starts from the draft.
    const duplicate = await duplicateTab(launched.shell, original);
    await expect
      .poll(async () => {
        const tab = (await snapshot(launched.shell)).tabs.find((candidate) => candidate.id === duplicate);
        return tab === undefined ? null : { url: tab.url, loading: tab.loading, canGoBack: tab.canGoBack };
      })
      .toEqual({ url: hotels, loading: false, canGoBack: true });
    await expect.poll(() => draftsAt(launched.app, hotels)).toEqual([draft, draft]);
    await goBack(launched.shell, duplicate);
    await expect.poll(async () => (await snapshot(launched.shell)).tabs.find((tab) => tab.id === duplicate)?.url).toBe(museums);
    // The original is untouched by the copy's Back.
    expect((await snapshot(launched.shell)).tabs.find((tab) => tab.id === original)?.url).toBe(hotels);

    // Close the original, reopen it with ⌘⇧T: same page, same stack, same draft.
    await closeTab(launched.shell, original);
    await expect.poll(async () => (await snapshot(launched.shell)).tabs.some((tab) => tab.id === original)).toBe(false);
    await launched.shell.keyboard.press("Meta+Shift+T");
    await expect
      .poll(async () => {
        state = await snapshot(launched.shell);
        const active = state.tabs.find((tab) => tab.id === state.activeTabId);
        return active === undefined || active.id === duplicate
          ? null
          : { url: active.url, loading: active.loading, canGoBack: active.canGoBack };
      })
      .toEqual({ url: hotels, loading: false, canGoBack: true });
    const reopened = state.activeTabId;
    if (reopened === null) throw new Error("no reopened tab");
    await expect.poll(() => draftsAt(launched.app, hotels)).toEqual([draft]);
    await closeTab(launched.shell, duplicate);
    await expect.poll(async () => (await snapshot(launched.shell)).tabs.map((tab) => tab.id)).toEqual([reopened]);
    await launched.app.close();
    current = null;

    // After a restart the stack is back — the draft, by design, is not.
    launched = await launch(executablePath, userData);
    current = launched.app;
    await expect
      .poll(async () => {
        const tab = (await snapshot(launched.shell)).tabs.find((candidate) => candidate.id === reopened);
        return tab === undefined ? null : { url: tab.url, loading: tab.loading, canGoBack: tab.canGoBack };
      })
      .toEqual({ url: hotels, loading: false, canGoBack: true });
    expect(await draftsAt(launched.app, hotels)).toEqual([""]);
    await goBack(launched.shell, reopened);
    await expect.poll(async () => (await snapshot(launched.shell)).tabs.find((tab) => tab.id === reopened)?.url).toBe(museums);
    await goBack(launched.shell, reopened);
    await expect.poll(async () => (await snapshot(launched.shell)).tabs.find((tab) => tab.id === reopened)?.url).toBe(home);
    // The page the tab opened on sits under the three fixture pages, so the
    // whole stack came back, forward entries included.
    expect((await snapshot(launched.shell)).tabs.find((tab) => tab.id === reopened)).toMatchObject({ canGoBack: true, canGoForward: true });
  } finally {
    if (current !== null) await current.close();
    server.close();
  }
});
