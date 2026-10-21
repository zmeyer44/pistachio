/**
 * A page that dies, or goes deaf, comes back (main/page-health.ts). A page
 * whose renderer dies on screen is reloaded at once, its view down until
 * then (a drag over a dead page's view took the app down); one that dies
 * again soon after is left for the person, its window saying so with
 * Reload. And a page left holding a drag it never heard the end of — which
 * drops every event until reloaded, scrolling alone still working — is let
 * go of when the pointer next reaches it: a press, or moves well after the
 * drag began. Each is logged to the profile's logs/page-health.log.
 *
 * The deaf page is made as Chromium leaves one: its drag intercepted over
 * the debugger (Input.setInterceptDrags), so it begins and nothing ends it
 * — and the OS is never asked for a drag. A press sent with sendInputEvent
 * is, to main, the pointer's own (it passes no hook of main's own input).
 */

import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createGroup, launchDesk, openTabs, selectSpace, selectTab, settled, windowSelector } from "./desk-harness";

const PAGE = `<!doctype html><html><head><title>Recovery</title></head><body style="margin:0;font:14px sans-serif">
<a id="link" href="/elsewhere" style="position:absolute;left:20px;top:40px;width:140px;height:40px;background:#cfe">a link</a>
<div id="pad" style="position:absolute;left:20px;top:140px;width:300px;height:200px;background:#eee">pad</div>
<script>
  window.__born = performance.timeOrigin;
  window.__downs = 0;
  window.__drags = [];
  addEventListener("mousedown", () => (window.__downs += 1));
  addEventListener("dragstart", () => window.__drags.push("start"));
  addEventListener("dragend", () => window.__drags.push("end"));
</script></body></html>`;

/** A script's answer in the page at `url`, or null when it does not answer (a dead page never does). */
function inPage<T>(app: ElectronApplication, url: string, script: string): Promise<T | null> {
  return app.evaluate(
    async ({ webContents }, { url, script }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
      if (contents === undefined || contents.isDestroyed()) return null;
      return Promise.race([contents.executeJavaScript(script).catch(() => null), new Promise((done) => setTimeout(() => done(null), 1000))]) as Promise<T | null>;
    },
    { url, script },
  );
}

test.describe.serial("a page that dies or goes deaf comes back", { tag: ["@desk"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let userData: string;
  let server: Server;
  let url: string;
  let site: string;
  let tabId: string;
  const win = () => shell.locator(windowSelector(tabId));

  /** Whether the page's view is up in the window. */
  const viewShown = (): Promise<boolean> =>
    app.evaluate(({ BrowserWindow, webContents }, page) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === page);
      for (const window of BrowserWindow.getAllWindows()) {
        const view = window.contentView.children.find((child) => "webContents" in child && (child as Electron.WebContentsView).webContents === contents);
        if (view !== undefined) return view.getVisible();
      }
      return false;
    }, url);
  const crash = (): Promise<void> =>
    app.evaluate(({ webContents }, page) => webContents.getAllWebContents().find((candidate) => candidate.getURL() === page)!.forcefullyCrashRenderer(), url);
  /** Mouse events into the page, as the OS pointer's would arrive (view px; the desk shows it at actual size). */
  const send = (events: Electron.MouseInputEvent[]): Promise<void> =>
    app.evaluate(({ webContents }, { page, events }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === page)!;
      for (const event of events) contents.sendInputEvent(event);
    }, { page: url, events });
  const press = (x: number, y: number): Promise<void> =>
    send([
      { type: "mouseDown", x, y, button: "left", clickCount: 1 },
      { type: "mouseUp", x, y, button: "left", clickCount: 1 },
    ]);
  /** The page begins a drag of its link that nothing will end. */
  const strand = async (): Promise<void> => {
    const intercepted = await app.evaluate(async ({ webContents }, page) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === page)!;
      contents.debugger.attach("1.3");
      try {
        const seen = new Promise<boolean>((done) => {
          contents.debugger.on("message", (_event, method) => method === "Input.dragIntercepted" && done(true));
          setTimeout(() => done(false), 3000);
        });
        await contents.debugger.sendCommand("Input.setInterceptDrags", { enabled: true });
        contents.sendInputEvent({ type: "mouseMove", x: 60, y: 60 });
        contents.sendInputEvent({ type: "mouseDown", x: 60, y: 60, button: "left", clickCount: 1 });
        for (let step = 1; step <= 10; step += 1) contents.sendInputEvent({ type: "mouseMove", x: 60 + step * 8, y: 60 + step * 8, modifiers: ["leftbuttondown"] });
        const was = await seen;
        await contents.debugger.sendCommand("Input.setInterceptDrags", { enabled: false });
        return was;
      } finally {
        contents.debugger.detach();
      }
    }, url);
    expect(intercepted).toBe(true);
    await expect.poll(() => inPage<string[]>(app, url, "window.__drags")).toEqual(["start"]);
  };
  const healthLog = async (): Promise<Array<Record<string, unknown>>> => {
    const text = await readFile(join(userData, "logs", "page-health.log"), "utf8").catch(() => "");
    return text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };
  /** A fresh document, its page live on the desk. */
  const fresh = async (): Promise<void> => {
    const born = await inPage<number>(app, url, "window.__born");
    await app.evaluate(({ webContents }, page) => webContents.getAllWebContents().find((candidate) => candidate.getURL() === page)!.reload(), url);
    await expect.poll(async () => (await inPage<number>(app, url, "window.__born")) ?? 0).toBeGreaterThan(born ?? 0);
    await expect.poll(viewShown).toBe(true);
  };

  test.beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(PAGE);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as { port: number }).port;
    site = `127.0.0.1:${String(port)}`;
    url = `http://${site}/recovery`;
    ({ app, shell, userData } = await launchDesk({ name: "page-recovery" }));
    [tabId] = (await openTabs(shell, [url])) as [string];
    await createGroup(shell, "recovery", [tabId], "Recovery", "green");
    await selectTab(shell, tabId);
    await selectSpace(shell, "recovery");
    await expect(win()).toHaveCount(1);
    await settled(shell, app);
    await expect.poll(viewShown).toBe(true);
  });

  test.afterAll(async () => {
    await app?.close();
    server?.close();
  });

  test("a page that dies on screen is reloaded at once; one that dies again soon after offers Reload", async () => {
    const born = (await inPage<number>(app, url, "window.__born"))!;
    await crash();
    // A new document, and its view up again once it has painted. The window never offered Reload for it.
    await expect.poll(async () => (await inPage<number>(app, url, "window.__born")) ?? 0).toBeGreaterThan(born);
    await expect.poll(viewShown).toBe(true);
    await expect(win().getByTestId("desk-window-crashed")).toHaveCount(0);

    // Dead again a moment later: left for the person. Its view stays down; the window says so.
    await crash();
    await expect(win().getByTestId("desk-window-crashed")).toBeVisible();
    await expect(win().getByTestId("desk-window-crashed")).toHaveAttribute("data-crashed", "crashed");
    await expect(win().getByTestId("desk-window-crashed")).toContainText("This page crashed");
    expect(await viewShown()).toBe(false);

    // Reload brings it back.
    const before = (await inPage<number>(app, url, "window.__born")) ?? 0;
    await win().getByTestId("desk-window-crash-reload").click();
    await expect(win().getByTestId("desk-window-crashed")).toHaveCount(0);
    await expect.poll(async () => (await inPage<number>(app, url, "window.__born")) ?? 0).toBeGreaterThan(before);
    await expect.poll(viewShown).toBe(true);

    // Logged by site alone, with what was done.
    const crashes = (await healthLog()).filter((entry) => entry["event"] === "crashed");
    expect(crashes.map(({ site: where, reason, shown, reloaded }) => ({ site: where, reason, shown, reloaded }))).toEqual([
      { site, reason: "killed", shown: true, reloaded: true },
      { site, reason: "killed", shown: true, reloaded: false },
    ]);
  });

  test("a page left holding a drag nothing ended is let go of at the next press", async () => {
    await fresh();
    await strand();
    // Deaf: the press is dropped…
    await press(100, 240);
    await new Promise((done) => setTimeout(done, 100));
    expect(await inPage<number>(app, url, "window.__downs")).toBe(1);
    // …but it says the drag is over: main ends it, and the next press lands.
    await expect.poll(() => inPage<string[]>(app, url, "window.__drags")).toEqual(["start", "end"]);
    await press(100, 240);
    await expect.poll(() => inPage<number>(app, url, "window.__downs")).toBe(2);
    const released = (await healthLog()).filter((entry) => entry["event"] === "drag-released");
    expect(released.map(({ site: where, trigger, released: done }) => ({ site: where, trigger, released: done }))).toEqual([{ site, trigger: "press", released: true }]);
  });

  test("and when the pointer moves over it well after the drag began, before any press", async () => {
    await fresh();
    await strand();
    // Moves in the first moments after a press may come before an OS drag begins: they say nothing.
    await send([{ type: "mouseMove", x: 100, y: 240 }]);
    await new Promise((done) => setTimeout(done, 300));
    expect(await inPage<string[]>(app, url, "window.__drags")).toEqual(["start"]);
    // Later, and going on: the pointer is on a deaf page.
    await new Promise((done) => setTimeout(done, 1400));
    for (let step = 0; step < 8; step += 1) {
      await send([{ type: "mouseMove", x: 100 + step * 10, y: 240 }]);
      await new Promise((done) => setTimeout(done, 100));
    }
    await expect.poll(() => inPage<string[]>(app, url, "window.__drags")).toEqual(["start", "end"]);
    await press(100, 240);
    await expect.poll(() => inPage<number>(app, url, "window.__downs")).toBe(2);
    const released = (await healthLog()).filter((entry) => entry["event"] === "drag-released");
    expect(released.at(-1)).toMatchObject({ site, trigger: "hover", released: true });
  });

  test("a page closed while main is ending its drag takes nothing down with it", async () => {
    await fresh();
    await strand();
    const rejections = (): Promise<string[]> => app.evaluate(() => (globalThis as { __rejections?: string[] }).__rejections ?? []);
    const released = async (): Promise<Array<Record<string, unknown>>> => (await healthLog()).filter((entry) => entry["event"] === "drag-released");
    const before = (await released()).length;
    // Main's dragCancel is held until the tab has closed; whatever main's own
    // code rejects with meanwhile is caught here.
    await app.evaluate(({ webContents }, page) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === page)!;
      const held = globalThis as { __rejections?: string[]; __letDragEndGo?: () => void };
      held.__rejections = [];
      process.on("unhandledRejection", (reason) => held.__rejections!.push(String(reason)));
      const session = contents.debugger;
      const send = session.sendCommand.bind(session);
      session.sendCommand = (method: string, params?: object) =>
        method !== "Input.dispatchDragEvent" ? send(method, params) : new Promise((done) => (held.__letDragEndGo = () => done(send(method, params))));
    }, url);
    await press(100, 240);
    await expect.poll(() => app.evaluate(() => typeof (globalThis as { __letDragEndGo?: unknown }).__letDragEndGo)).toBe("function");
    await shell.evaluate((id) => (window as unknown as { pistachio: { closeTab(tabId: string): Promise<void> } }).pistachio.closeTab(id), tabId);
    await expect.poll(() => app.evaluate(({ webContents }, page) => webContents.getAllWebContents().some((candidate) => candidate.getURL() === page), url)).toBe(false);
    await app.evaluate(() => (globalThis as { __letDragEndGo?: () => void }).__letDragEndGo!());
    // Logged by the site it was, the drag never ended (there is no page left to end it in), and nothing thrown.
    await expect.poll(async () => (await rejections()).length + (await released()).length - before).toBeGreaterThan(0);
    expect(await rejections()).toEqual([]);
    expect((await released()).at(-1)).toMatchObject({ site, trigger: "press", released: false });
  });
});
