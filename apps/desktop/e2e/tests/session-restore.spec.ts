import { createServer, type Server } from "node:http";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";
import { launchApp, newProfile } from "./app";
import { snapshot } from "./chrome-harness";

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

/**
 * Whether Chromium has committed `value` to the page state of the current
 * navigation entry of the page at `url` — which it does on a short timer
 * after the form changes, and which is what a duplicate or a reopen carries.
 */
function draftCommitted(app: ElectronApplication, url: string, value: string): Promise<boolean> {
  return app.evaluate(
    ({ webContents }, { url, value }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
      if (contents === undefined) return false;
      const state = contents.navigationHistory.getEntryAtIndex(contents.navigationHistory.getActiveIndex())?.pageState;
      if (state === undefined) return false;
      const bytes = Buffer.from(state, "base64");
      return bytes.includes(Buffer.from(value, "utf16le")) || bytes.includes(Buffer.from(value, "utf8"));
    },
    { url, value },
  );
}

/** The tab's address, whether it is loading, and its Back, or null while it is not there. */
async function stackOf(shell: Page, tabId: string) {
  const tab = (await snapshot(shell)).tabs.find((candidate) => candidate.id === tabId);
  return tab === undefined ? null : { url: tab.url, loading: tab.loading, canGoBack: tab.canGoBack };
}

// One profile, restarted twice: a tab's back/forward stack through duplicate,
// reopen and restart, and which tabs, splits and sleeping tabs come back.
// The restarts are shared — the stack's check runs in the launch that
// restores the split — so each test leaves the app open for the next.
test.describe.serial("tabs across restarts", { tag: ["@tabs", "@split", "@startup"] }, () => {
  test.describe.configure({ timeout: 60_000 });
  let server: Server;
  let origin: string;
  let userData: string;
  let app: ElectronApplication | undefined;
  let shell: Page;
  let reopened: string;
  let second: string;
  let background: string;
  const draft = "Book two rooms near the station.";

  async function launch(): Promise<void> {
    ({ app } = await launchApp({ userData }));
    shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
  }

  async function restart(): Promise<void> {
    await app?.close();
    app = undefined;
    await launch();
  }

  test.beforeAll(async () => {
    ({ server, origin } = await fixture());
    userData = await newProfile("restart");
    await launch();
  });

  test.afterAll(async () => {
    await app?.close();
    server?.close();
  });

  test("a tab's back/forward stack follows it through duplicate and reopen", async () => {
    const home = `${origin}/`;
    const museums = `${origin}/museums`;
    const hotels = `${origin}/hotels`;
    const running = app!;
    const original = (await snapshot(shell)).activeTabId;
    if (original === null) throw new Error("initial tab unavailable");

    // Home → Museums → Hotels in one tab, then a draft on the last page.
    for (const url of [home, museums, hotels]) {
      await navigate(shell, original, url);
      await expect.poll(async () => (await snapshot(shell)).tabs.find((tab) => tab.id === original)?.url).toBe(url);
    }
    await expect.poll(async () => (await snapshot(shell)).tabs.find((tab) => tab.id === original)?.canGoBack).toBe(true);
    await running.evaluate(
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
    await expect.poll(() => draftCommitted(running, hotels, draft)).toBe(true);

    // Duplicate: the copy can go Back to Museums, and starts from the draft.
    const duplicate = await duplicateTab(shell, original);
    await expect.poll(() => stackOf(shell, duplicate)).toEqual({ url: hotels, loading: false, canGoBack: true });
    await expect.poll(() => draftsAt(running, hotels)).toEqual([draft, draft]);
    await goBack(shell, duplicate);
    await expect.poll(async () => (await snapshot(shell)).tabs.find((tab) => tab.id === duplicate)?.url).toBe(museums);
    // The original is untouched by the copy's Back.
    expect((await snapshot(shell)).tabs.find((tab) => tab.id === original)?.url).toBe(hotels);

    // Close the original, reopen it with ⌘⇧T: same page, same stack, same draft.
    await closeTab(shell, original);
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.id === original)).toBe(false);
    await shell.keyboard.press("Meta+Shift+T");
    await expect
      .poll(async () => {
        const state = await snapshot(shell);
        const active = state.tabs.find((tab) => tab.id === state.activeTabId);
        return active === undefined || active.id === duplicate
          ? null
          : { url: active.url, loading: active.loading, canGoBack: active.canGoBack };
      })
      .toEqual({ url: hotels, loading: false, canGoBack: true });
    const reopenedId = (await snapshot(shell)).activeTabId;
    if (reopenedId === null) throw new Error("no reopened tab");
    reopened = reopenedId;
    await expect.poll(() => draftsAt(running, hotels)).toEqual([draft]);
    await closeTab(shell, duplicate);
    await expect.poll(async () => (await snapshot(shell)).tabs.map((tab) => tab.id)).toEqual([reopened]);
  });

  test("human tabs and split groups restore durably while background tabs remain suspended", async () => {
    // The reopened tab above is the first; a second joins it in a split, and a third sleeps.
    const first = reopened;
    const open = async (url: string): Promise<string> => {
      await shell.evaluate((target) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(target), url);
      const active = (await snapshot(shell)).activeTabId;
      if (active === null) throw new Error(`no tab for ${url}`);
      return active;
    };
    second = await open("pistachio://demo/vendors/atlas-medical");
    if (second === first) throw new Error("second tab unavailable");
    background = await open("pistachio://demo/invoices?restored=background");
    if (background === second) throw new Error("background tab unavailable");

    await shell.evaluate(
      ({ secondId, firstId }) =>
        (window as unknown as { pistachio: PistachioApi }).pistachio
          .selectTab(secondId)
          .then(() => (window as unknown as { pistachio: PistachioApi }).pistachio.splitWith(firstId, "right")),
      { secondId: second, firstId: first },
    );
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.suspendTab(tabId), background);
    let state = await snapshot(shell);
    expect(state).toMatchObject({ activeTabId: second, secondaryTabId: first, splitMode: "vertical" });
    expect(state.tabs.find((tab) => tab.id === background)?.lifecycle).toBe("suspended");

    await restart();
    state = await snapshot(shell);
    expect(state.tabs.map((tab) => tab.id)).toEqual([first, second, background]);
    expect(state).toMatchObject({ activeTabId: second, secondaryTabId: first, splitMode: "vertical" });
    expect(state.tabs.find((tab) => tab.id === first)?.lifecycle).toBe("live");
    expect(state.tabs.find((tab) => tab.id === second)?.lifecycle).toBe("live");
    expect(state.tabs.find((tab) => tab.id === background)?.lifecycle).toBe("suspended");
    await expect(shell.getByLabel("Sleeping")).toHaveCount(1);
  });

  test("after a restart a tab's back/forward stack is back, and its draft, by design, is not", async () => {
    // The reopened tab came back live, in its split, from the restart above.
    const hotels = `${origin}/hotels`;
    await expect.poll(() => stackOf(shell, reopened)).toEqual({ url: hotels, loading: false, canGoBack: true });
    expect(await draftsAt(app!, hotels)).toEqual([""]);
    await goBack(shell, reopened);
    await expect.poll(async () => (await snapshot(shell)).tabs.find((tab) => tab.id === reopened)?.url).toBe(`${origin}/museums`);
    await goBack(shell, reopened);
    await expect.poll(async () => (await snapshot(shell)).tabs.find((tab) => tab.id === reopened)?.url).toBe(`${origin}/`);
    // The page the tab opened on sits under the three fixture pages, so the
    // whole stack came back, forward entries included.
    expect((await snapshot(shell)).tabs.find((tab) => tab.id === reopened)).toMatchObject({ canGoBack: true, canGoForward: true });
  });

  test("a woken tab stays live across a restart, and the split it left sleeps", async () => {
    await shell.evaluate((tabId) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(tabId), background);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(background);
    expect((await snapshot(shell)).tabs.find((tab) => tab.id === background)?.lifecycle).toBe("live");

    await restart();
    const state = await snapshot(shell);
    expect(state.activeTabId).toBe(background);
    expect(state.tabs.find((tab) => tab.id === background)?.lifecycle).toBe("live");
    expect(state.tabs.find((tab) => tab.id === reopened)?.lifecycle).toBe("suspended");
    expect(state.tabs.find((tab) => tab.id === second)?.lifecycle).toBe("suspended");
    expect(state.splitGroups).toEqual([expect.objectContaining({ primaryTabId: second, secondaryTabId: reopened, mode: "vertical" })]);
    await expect(shell.getByLabel("Sleeping")).toHaveCount(2);
  });
});
