/**
 * Pistachio as the default web browser (electron-builder.yml's http, https
 * and HTML claims): what macOS hands it — a link (`open-url`), an .html file
 * (`open-file`) — opens as a tab, in front. A file's page follows its links
 * to the files beside it, in place or in a tab of their own; its tab is
 * duplicated, reopened and restored at its file, never searched for. (A web
 * page never reaches a file: Chromium refuses it before main would.)
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { launchApp, newProfile } from "./app";
import { activeUrl } from "./pages-harness";
import { shellReady } from "./windows";

/** What macOS sends: Electron's app hears it with an event to prevent. */
function handOver(app: ElectronApplication, event: "open-url" | "open-file", value: string): Promise<void> {
  return app.evaluate(
    ({ app: electronApp }, { event, value }) => {
      electronApp.emit(event, { preventDefault: () => undefined }, value);
    },
    { event, value },
  );
}

/** The title of the page showing `url` once it has loaded, or null while none has. */
function titleAt(app: ElectronApplication, url: string): Promise<string | null> {
  return app.evaluate(({ webContents }, target) => {
    const page = webContents.getAllWebContents().find((contents) => contents.getURL() === target && !contents.isLoading());
    return page?.getTitle() ?? null;
  }, url);
}

/** Run script in the page showing `url`, as a person's own click would. */
function inPage(app: ElectronApplication, url: string, script: string): Promise<unknown> {
  return app.evaluate(
    async ({ webContents }, { url, script }) => {
      const page = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
      if (page === undefined) throw new Error(`No page is showing ${url}`);
      return page.executeJavaScript(script, true);
    },
    { url, script },
  );
}

/**
 * Click a link of the page showing `url`, as a person's click would: a file's page runs none of its own scripts, so
 * the click is the debugger's (it evaluates where the page may not) — not a click at a point, which a window still
 * opening on the desk, its picture standing in, would not reach.
 */
function clickLink(app: ElectronApplication, url: string, id: string): Promise<void> {
  return app.evaluate(
    async ({ webContents }, { url, id }) => {
      const page = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
      if (page === undefined) throw new Error(`No page is showing ${url}`);
      page.debugger.attach("1.3");
      try {
        const result = (await page.debugger.sendCommand("Runtime.evaluate", { expression: `document.getElementById(${JSON.stringify(id)}).click()`, userGesture: true })) as { exceptionDetails?: unknown };
        if (result.exceptionDetails !== undefined) throw new Error(`The click on #${id} failed: ${JSON.stringify(result.exceptionDetails)}`);
      } finally {
        page.debugger.detach();
      }
    },
    { url, id },
  );
}

/** The ids of the tabs at `url`, in main's snapshot — asleep ones too. */
function tabsAt(shell: Page, url: string): Promise<string[]> {
  return shell.evaluate(async (target) => {
    const snapshot = await (window as unknown as { pistachio: PistachioApi }).pistachio.getSnapshot();
    return snapshot.tabs.filter((tab) => tab.url === target).map((tab) => tab.id);
  }, url);
}

test.describe.serial("opened from other apps", { tag: ["@tabs", "@startup"] }, () => {
  test.describe.configure({ timeout: 60_000 });
  let server: Server;
  let webUrl: string;
  let userData: string;
  let app: ElectronApplication | undefined;
  let shell: Page;
  let firstPath: string;
  let firstUrl: string;
  let secondUrl: string;
  let thirdUrl: string;

  async function launch(): Promise<void> {
    ({ app } = await launchApp({ userData }));
    shell = await shellReady(app);
  }

  test.beforeAll(async () => {
    const folder = await mkdtemp(join(tmpdir(), "open-file-"));
    firstPath = join(folder, "first file.html");
    const second = join(folder, "second.html");
    const third = join(folder, "third.html");
    const secret = join(folder, "secret.txt");
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Web page</title><h1>Web page</h1>");
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("The test server did not bind a TCP port");
    webUrl = `http://127.0.0.1:${String(address.port)}/link`;
    // Its script, were it run, would rename the page at once and read the file beside it (Electron lets a file: page).
    await writeFile(secret, "the person's own");
    await writeFile(
      firstPath,
      `<!doctype html><title>First file</title><script>document.title = "Scripts ran"; fetch(${JSON.stringify(pathToFileURL(secret).href)}).then((r) => r.text()).then((t) => { document.title = "Read " + t; });</script>` +
        `<a id="next" href="second.html">Next</a> <a id="aside" href="third.html" target="_blank">Aside</a> <a id="web" href="${webUrl}">Web</a>`,
    );
    await writeFile(second, "<!doctype html><title>Second file</title><h1>Second</h1>");
    await writeFile(third, "<!doctype html><title>Third file</title><h1>Third</h1>");
    firstUrl = pathToFileURL(firstPath).href;
    secondUrl = pathToFileURL(second).href;
    thirdUrl = pathToFileURL(third).href;
    userData = await newProfile("open-from-other-apps");
    await launch();
  });

  test.afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
  });

  test("a link another app opens is a tab, in front", async () => {
    await handOver(app!, "open-url", webUrl);
    await expect.poll(() => titleAt(app!, webUrl)).toBe("Web page");
    await expect.poll(() => activeUrl(shell)).toBe(webUrl);
  });

  test("an .html file opened in Finder is a tab at its file: address, its scripts not run, and follows its link to the file beside it", async () => {
    await handOver(app!, "open-file", firstPath);
    // Loaded under its own title: its script — renaming it as it parses, then reading the file beside it — never ran.
    await expect.poll(() => titleAt(app!, firstUrl)).toBe("First file");
    await expect.poll(() => activeUrl(shell)).toBe(firstUrl);
    await clickLink(app!, firstUrl, "next");
    await expect.poll(() => titleAt(app!, secondUrl)).toBe("Second file");
    await expect.poll(() => activeUrl(shell)).toBe(secondUrl);
  });

  test("a file's link that asks for a tab opens the file beside it in a tab of its own", async () => {
    await handOver(app!, "open-file", firstPath);
    await expect.poll(() => titleAt(app!, firstUrl)).toBe("First file");
    await expect.poll(() => activeUrl(shell)).toBe(firstUrl);
    await clickLink(app!, firstUrl, "aside");
    await expect.poll(() => titleAt(app!, thirdUrl)).toBe("Third file");
    await expect.poll(() => activeUrl(shell)).toBe(thirdUrl);
    expect(await tabsAt(shell, firstUrl)).toHaveLength(1);
  });

  test("a file's link to the web opens a tab of its own, with scripts; the file's tab stays on its file", async () => {
    const [tabId] = await tabsAt(shell, firstUrl);
    expect(tabId).toBeDefined();
    const before = (await tabsAt(shell, webUrl)).length;
    await clickLink(app!, firstUrl, "web");
    await expect.poll(async () => (await tabsAt(shell, webUrl)).length).toBe(before + 1);
    await expect.poll(() => titleAt(app!, webUrl)).toBe("Web page");
    expect(await tabsAt(shell, firstUrl)).toEqual([tabId]);
    expect(await inPage(app!, webUrl, "1 + 1")).toBe(2);
  });

  test("a file's own address given back from the address bar loads it again; another file is refused — never a search", async () => {
    const [tabId] = await tabsAt(shell, firstUrl);
    expect(tabId).toBeDefined();
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(id), tabId!);
    await expect.poll(() => activeUrl(shell)).toBe(firstUrl);
    // ⌘L, the address as it reads — its space unescaped — and Enter: the page loads again, at its file, where a search
    // would have taken the tab away from it.
    await app!.evaluate(({ webContents }, url) => {
      const page = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
      page?.once("did-start-loading", () => {
        (globalThis as { __fileReloaded?: boolean }).__fileReloaded = true;
      });
    }, firstUrl);
    await shell.keyboard.press("Meta+L");
    const input = shell.getByTestId("address-input");
    await expect(input).toBeFocused();
    await input.fill(decodeURIComponent(firstUrl));
    await input.press("Enter");
    await expect.poll(() => app!.evaluate(() => (globalThis as { __fileReloaded?: boolean }).__fileReloaded === true)).toBe(true);
    await expect.poll(() => titleAt(app!, firstUrl)).toBe("First file");
    await expect.poll(() => activeUrl(shell)).toBe(firstUrl);
    // Another file, given to a tab that is not showing it, is refused.
    const refused = await shell.evaluate(
      ({ id, url }) =>
        (window as unknown as { pistachio: PistachioApi }).pistachio.navigate(id, url).then(
          () => "loaded",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
      { id: tabId!, url: thirdUrl },
    );
    expect(refused).toContain("only from Finder");
    expect(await tabsAt(shell, firstUrl)).toEqual([tabId]);
  });

  test("a file's tab duplicated, and closed and reopened, is at its file again — never a search for it", async () => {
    const [tabId] = await tabsAt(shell, thirdUrl);
    expect(tabId).toBeDefined();
    const copyId = await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.duplicateTab(id), tabId!);
    await expect.poll(() => tabsAt(shell, thirdUrl)).toEqual(expect.arrayContaining([tabId, copyId]));
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(id), copyId);
    await expect.poll(() => tabsAt(shell, thirdUrl)).toEqual([tabId]);
    await shell.evaluate(() => (window as unknown as { pistachio: PistachioApi }).pistachio.restoreClosedTab());
    await expect.poll(async () => (await tabsAt(shell, thirdUrl)).length).toBe(2);
    await expect.poll(() => activeUrl(shell)).toBe(thirdUrl);
  });

  test("a file's tab comes back after a restart, at its file", async () => {
    await app!.close();
    app = undefined;
    await launch();
    await expect.poll(async () => (await tabsAt(shell, secondUrl)).length).toBe(1);
    const restored = await tabsAt(shell, firstUrl);
    expect(restored).toHaveLength(1);
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.selectTab(id), restored[0]!);
    await expect.poll(() => titleAt(app!, firstUrl)).toBe("First file");
  });
});
