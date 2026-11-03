/**
 * Capture, input, desk, keys and agent.ask (docs/extensions.md §5, S3), end to
 * end through a fixture that uses the public API alone
 * (e2e/fixtures/extensions/capture-probe): `/probe` on the window in use holds
 * it, subscribes to its input, captures it through getDisplayMedia in the
 * worker (main's display-media handler answering with the tab's frame), and
 * records two seconds with a MediaRecorder into its data folder — while the
 * spec moves, clicks and types in the page. Main's half is asserted through
 * what it publishes (the snapshot's `captures` and status pill) and the
 * fixture's own log in its folder (`.pistachio/log.ndjson`).
 *
 * The page is served from localhost (an address an extension may record:
 * never a pistachio: page). Input reaches the page as main's own
 * `sendInputEvent`, which passes `before-mouse-event`/`before-input-event` as
 * a person's does; the OS pointer is not read under Playwright, so the moves
 * are the page's own events (no 60 Hz fill).
 */

import { cp, mkdtemp, readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { ExtensionsSnapshot } from "@pistachio/shell-contracts/extensions";
import { createTab, launchDesk, reachBar, screenshots, settled, snapshot } from "./desk-harness";

const capture = screenshots("extensions-capture");
const PROBE_ID = "dev.pistachio-e2e.capture-probe";
const FIXTURE = fileURLToPath(new URL("../fixtures/extensions/capture-probe", import.meta.url));

const PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Capture target</title>
    <style>body{margin:0;font:16px system-ui}canvas{position:fixed;inset:0;width:100vw;height:100vh;z-index:-1}
      #go{position:absolute;left:40px;top:40px;width:160px;height:48px}#name{position:absolute;left:40px;top:120px;width:300px}
      #secret{position:absolute;left:40px;top:180px;width:300px}
      open-login{position:absolute;left:40px;top:240px}closed-login{position:absolute;left:40px;top:300px}</style></head>
  <body>
    <canvas id="c"></canvas>
    <button id="go">Press me</button>
    <input id="name" placeholder="Your name" />
    <input id="secret" type="password" placeholder="Password" />
    <open-login></open-login>
    <closed-login></closed-login>
    <div id="closed-plain"></div>
    <script>
      // A closed tree on a plain div, no custom element to tell it by: the window sees a focused div.
      { const plain = document.getElementById("closed-plain"); const root = plain.attachShadow({ mode: "closed" }); root.innerHTML = '<input id="pass" type="password" />'; plain.focusPassword = () => root.getElementById("pass").focus(); }
      // A sign-in form in a shadow tree, open and closed: what the window sees of a move inside is the host's events.
      customElements.define("open-login", class extends HTMLElement {
        constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<input id="user" placeholder="User" /> <input id="pass" type="password" />'; }
      });
      customElements.define("closed-login", class extends HTMLElement {
        constructor() { super(); const root = this.attachShadow({ mode: "closed" }); root.innerHTML = '<input id="pass" type="password" />'; this.focusPassword = () => root.getElementById("pass").focus(); }
      });
      const c = document.getElementById("c"), x = c.getContext("2d"); let n = 0;
      (function paint() { c.width = innerWidth; c.height = innerHeight; x.fillStyle = "hsl(" + (n++ % 360) + ",70%,80%)"; x.fillRect(0, 0, c.width, c.height); requestAnimationFrame(paint); })();
    </script>
  </body>
</html>`;

type WithExtensions = { pistachio: { extensions(request: unknown): Promise<unknown>; onExtensions(listener: (snapshot: ExtensionsSnapshot) => void): () => void }; __ext?: ExtensionsSnapshot };

/** The extensions snapshot as main last published it (the shell's own subscription, read). */
async function extensionsSnapshot(shell: Page): Promise<ExtensionsSnapshot | null> {
  return shell.evaluate(() => (window as unknown as WithExtensions).__ext ?? null);
}

function extensionsRequest(shell: Page, request: unknown): Promise<unknown> {
  return shell.evaluate((body) => (window as unknown as WithExtensions).pistachio.extensions(body), request);
}

/** The fixture's log lines (`probe: <step>`), by step. */
/** How many times the fixture said `step` (a later run says the same steps again: the map keeps the last). */
async function probeCount(folder: string, step: string): Promise<number> {
  let text = "";
  try {
    text = await readFile(join(folder, ".pistachio", "log.ndjson"), "utf8");
  } catch {
    return 0;
  }
  return text.split("\n").filter((line) => line.includes(`"probe: ${step}"`)).length;
}

async function probeLog(folder: string): Promise<Map<string, unknown>> {
  const steps = new Map<string, unknown>();
  let text = "";
  try {
    text = await readFile(join(folder, ".pistachio", "log.ndjson"), "utf8");
  } catch {
    return steps;
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line) as { message?: string; data?: unknown };
    const step = /^probe: (\w+)$/.exec(entry.message ?? "")?.[1];
    if (step !== undefined) steps.set(step, entry.data ?? null);
  }
  return steps;
}

/** Input sent to the page's view as main sends it (sendInputEvent: before-mouse-event and before-input-event hear it). */
function sendToPage(app: ElectronApplication, url: string, events: Record<string, unknown>[]): Promise<void> {
  return app.evaluate(
    async ({ webContents }, { url: address, events: list }) => {
      const page = webContents.getAllWebContents().find((contents) => contents.getURL() === address);
      if (page === undefined) throw new Error(`no page at ${address}`);
      for (const event of list) {
        page.sendInputEvent(event as never);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    },
    { url, events },
  );
}

function pageEval<T>(app: ElectronApplication, url: string, code: string): Promise<T> {
  return app.evaluate(
    ({ webContents }, { url: address, code: script }) => {
      const page = webContents.getAllWebContents().find((contents) => contents.getURL() === address);
      if (page === undefined) throw new Error(`no page at ${address}`);
      return page.executeJavaScript(script) as Promise<T>;
    },
    { url, code },
  );
}

test.describe.serial("extensions: capture, input, desk, keys", { tag: ["@extensions"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let userData: string;
  let server: Server;
  let pageUrl: string;
  let folder: string;
  let tabId: string;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(PAGE);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("the page's server did not bind");
    pageUrl = `http://localhost:${String(address.port)}/`;
    ({ app, shell, userData } = await launchDesk({ name: "extensions-capture", homeUrl: pageUrl }));
    await settled(shell, app);
    // The fixture, in a folder of this run's: its status file and log are written beside it.
    folder = join(await mkdtemp(join(tmpdir(), "pistachio-capture-probe-")), "capture-probe");
    await cp(FIXTURE, folder, { recursive: true });
    // (The copy's own file events settle first: FSEvents hands a watch begun at once the writes just before it,
    // and main would take them for an edit — a dev-reload, which restarts the worker mid-recording.)
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await shell.evaluate(() => {
      const w = window as unknown as WithExtensions;
      w.pistachio.onExtensions((next) => (w.__ext = next));
    });
    await extensionsRequest(shell, { type: "loadFolder", path: folder });
    await expect.poll(async () => (await extensionsSnapshot(shell))?.extensions.find((extension) => extension.id === PROBE_ID)?.pending?.manifestHash ?? null).not.toBeNull();
    const hash = (await extensionsSnapshot(shell))!.extensions.find((extension) => extension.id === PROBE_ID)!.pending!.manifestHash;
    await extensionsRequest(shell, { type: "approve", id: PROBE_ID, manifestHash: hash });
    await expect.poll(async () => (await extensionsSnapshot(shell))?.extensions.find((extension) => extension.id === PROBE_ID)?.status).toMatch(/idle|running/);
    tabId = (await snapshot(shell)).tabs.find((tab) => tab.url === pageUrl)!.id;
  });

  test.afterAll(async () => {
    await app?.close();
    server?.close();
  });

  test("/probe records the window in use and hears what was done in it — never a password's keys", async () => {
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(tabId);
    await extensionsRequest(shell, { type: "barCommand", id: PROBE_ID, command: "probe", arg: "", spaceId: null, tabId });
    // Main marks the window and draws the pill while it records.
    await expect.poll(async () => (await probeLog(folder)).has("capturing"), { timeout: 15_000 }).toBe(true);
    const live = (await extensionsSnapshot(shell))!.extensions.find((extension) => extension.id === PROBE_ID)!;
    expect(live.captures).toContain(tabId);
    expect(live.statusPill).toEqual({ text: "● Recording · Capture probe", actions: [{ id: "stop", title: "Stop" }] });
    await capture(app, shell, "01-recording.png");

    // The person moves, presses the button, types a name, then a password.
    const button = await pageEval<{ x: number; y: number }>(app, pageUrl, `(() => { const r = document.getElementById("go").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const moves = Array.from({ length: 6 }, (_, i) => ({ type: "mouseMove", x: 300 + i * 10, y: 300 }));
    await sendToPage(app, pageUrl, [...moves, { type: "mouseMove", x: button.x, y: button.y }, { type: "mouseDown", x: button.x, y: button.y, button: "left", clickCount: 1 }, { type: "mouseUp", x: button.x, y: button.y, button: "left", clickCount: 1 }]);
    await pageEval(app, pageUrl, `document.getElementById("name").focus(), true`);
    await sendToPage(app, pageUrl, [
      { type: "keyDown", keyCode: "a" },
      { type: "char", keyCode: "a" },
      { type: "keyUp", keyCode: "a" },
    ]);
    await pageEval(app, pageUrl, `document.getElementById("secret").focus(), true`);
    // (Long enough for the page's word on the secret field to reach main before the keys.)
    await new Promise((resolve) => setTimeout(resolve, 150));
    await sendToPage(app, pageUrl, [
      { type: "keyDown", keyCode: "x" },
      { type: "char", keyCode: "x" },
      { type: "keyUp", keyCode: "x" },
    ]);
    // Then a sign-in form inside an open shadow tree: its user field counts a key, its password field silences them;
    // and one inside a closed tree, where the window sees only the host — kept secret for that.
    await pageEval(app, pageUrl, `document.querySelector("open-login").shadowRoot.getElementById("user").focus(), true`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await sendToPage(app, pageUrl, [
      { type: "keyDown", keyCode: "u" },
      { type: "char", keyCode: "u" },
      { type: "keyUp", keyCode: "u" },
    ]);
    await pageEval(app, pageUrl, `document.querySelector("open-login").shadowRoot.getElementById("pass").focus(), true`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await sendToPage(app, pageUrl, [
      { type: "keyDown", keyCode: "y" },
      { type: "char", keyCode: "y" },
      { type: "keyUp", keyCode: "y" },
    ]);
    await pageEval(app, pageUrl, `document.querySelector("closed-login").focusPassword(), true`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await sendToPage(app, pageUrl, [
      { type: "keyDown", keyCode: "z" },
      { type: "char", keyCode: "z" },
      { type: "keyUp", keyCode: "z" },
    ]);
    // And a closed tree on a plain div: a focused div is taken for a host hiding one.
    await pageEval(app, pageUrl, `document.getElementById("closed-plain").focusPassword(), true`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await sendToPage(app, pageUrl, [
      { type: "keyDown", keyCode: "w" },
      { type: "char", keyCode: "w" },
      { type: "keyUp", keyCode: "w" },
    ]);

    await expect.poll(async () => (await probeLog(folder)).has("result") || (await probeLog(folder)).has("failed"), { timeout: 15_000 }).toBe(true);
    const steps = await probeLog(folder);
    expect(steps.get("failed")).toBeUndefined();
    const result = steps.get("result") as {
      frames: number;
      size: { width: number; height: number } | null;
      bytes: number;
      kinds: Record<string, number>;
      keys: { kind: string; chord?: string }[];
      focus: { secret: boolean; at: number }[];
      target: { role: string; w: number; h: number } | null;
    };
    console.log(`[capture-probe] ${JSON.stringify({ capturing: steps.get("capturing"), desk: steps.get("desk"), ...result })}`);
    // Frames (the page repaints every frame; 30 fps asked for two seconds), and a recording on disk.
    expect(result.frames).toBeGreaterThan(10);
    expect(result.bytes).toBeGreaterThan(1_000);
    expect((await stat(join(userData, "ExtensionData", PROBE_ID, "data", "probe", "recording.webm"))).size).toBe(result.bytes);
    // What was done: where the pointer went, the press on the button with its rect, the view's box, the page.
    expect(result.kinds["move"]).toBeGreaterThan(0);
    expect(result.kinds["down"]).toBeGreaterThan(0);
    expect(result.kinds["box"]).toBeGreaterThan(0);
    expect(result.kinds["nav"]).toBeGreaterThan(0);
    expect(result.target).toMatchObject({ role: "button", w: 160, h: 48 });
    // The name's key and the shadow form's user key as kinds, nothing typed in them; the passwords' not at all —
    // the page's, the open tree's, and the closed tree's, whose host is all the window sees.
    expect(result.keys).toHaveLength(2);
    for (const key of result.keys) expect(key).toEqual(expect.objectContaining({ k: "key", kind: "char" }));
    expect(JSON.stringify(result.keys)).not.toMatch(/"a"|"x"|"u"|"y"|"z"|"w"/);
    const secrets = result.focus.filter((change) => change.secret);
    expect(secrets.length).toBeGreaterThanOrEqual(3);
    expect(secrets[0]!.at).toBe(1);
    expect(secrets.at(-1)!.at).toBe(2);
    // The window's box on the desk, where main drew it.
    expect(steps.get("desk")).toMatchObject({ inUse: true });
    expect((steps.get("desk") as { box: { width: number } }).box.width).toBeGreaterThan(0);

    // The tracks stopped, the hold let go: main sees the capture end, and the pill goes.
    await expect
      .poll(async () => {
        const info = (await extensionsSnapshot(shell))!.extensions.find((extension) => extension.id === PROBE_ID)!;
        return { captures: info.captures ?? [], pill: info.statusPill };
      }, { timeout: 10_000 })
      .toEqual({ captures: [], pill: null });
  });

  test("a watch that begins with focus already inside a shadow form still hears the move to its password", async () => {
    // Focus sits in the open tree's user field before anything watches: no focus event will mark the tree later.
    await pageEval(app, pageUrl, `document.querySelector("open-login").shadowRoot.getElementById("user").focus(), true`);
    const runs = await probeCount(folder, "capturing");
    const results = await probeCount(folder, "result");
    await extensionsRequest(shell, { type: "barCommand", id: PROBE_ID, command: "probe", arg: "", spaceId: null, tabId });
    await expect.poll(() => probeCount(folder, "capturing"), { timeout: 15_000 }).toBe(runs + 1);
    // Within the tree, to its password: the move fires past no root, so the root itself must have been watched from the start.
    await pageEval(app, pageUrl, `document.querySelector("open-login").shadowRoot.getElementById("pass").focus(), true`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await sendToPage(app, pageUrl, [
      { type: "keyDown", keyCode: "q" },
      { type: "char", keyCode: "q" },
      { type: "keyUp", keyCode: "q" },
    ]);
    await expect.poll(() => probeCount(folder, "result"), { timeout: 15_000 }).toBe(results + 1);
    const result = (await probeLog(folder)).get("result") as { keys: unknown[]; focus: { secret: boolean; at: number }[] };
    expect(result.keys).toEqual([]);
    expect(result.focus.map((change) => change.secret)).toEqual(expect.arrayContaining([false, true]));
  });

  test("a capture that goes on after Stop is ended by main: the pill stays until it is, then the worker goes", async () => {
    // The worker takes its stream past the runtime (the raw wire, then getDisplayMedia) and never stops it.
    await extensionsRequest(shell, { type: "barCommand", id: PROBE_ID, command: "probe", arg: "hold", spaceId: null, tabId });
    await expect.poll(async () => (await probeLog(folder)).has("holding") || (await probeLog(folder)).has("failed"), { timeout: 15_000 }).toBe(true);
    expect((await probeLog(folder)).get("failed")).toBeUndefined();
    // (The page's own isBeingCaptured() is no witness here: under Playwright every page reports captured.)
    const trackStates = (): Promise<string | null> =>
      app.evaluate(async ({ webContents }) => {
        const worker = webContents.getAllWebContents().find((contents) => contents.getURL().includes("__pistachio__/worker.html"));
        if (worker === undefined) return null;
        return (await worker.executeJavaScript("globalThis.__held ? globalThis.__held.stream.getTracks().map((t) => t.readyState).join() : null", false)) as string | null;
      });
    await expect.poll(trackStates, { timeout: 5_000 }).toBe("live");
    const info = async () => (await extensionsSnapshot(shell))!.extensions.find((extension) => extension.id === PROBE_ID)!;
    await expect.poll(async () => (await info()).captures ?? [], { timeout: 5_000 }).toContain(tabId);

    // Stop on main's pill: the worker is told, and holds on. The capture stays listed — the pill up — while it does.
    await extensionsRequest(shell, { type: "statusAction", id: PROBE_ID, action: "stop", source: "status" });
    const told = await info();
    expect(told.captures).toContain(tabId);
    expect(told.statusPill).toEqual({ text: "● Recording · Capture probe", actions: [{ id: "stop", title: "Stop" }] });
    expect(await trackStates()).toBe("live");

    // Past the grace main ends the worker's tracks itself (the preload's guard): the track is ended, the pill goes,
    // the worker lives on, and its log says what was done.
    await expect.poll(trackStates, { timeout: 10_000 }).toBe("ended");
    await expect.poll(async () => ({ captures: (await info()).captures ?? [], pill: (await info()).statusPill }), { timeout: 5_000 }).toEqual({ captures: [], pill: null });
    expect((await info()).status).toMatch(/idle|running/);
    const log = await readFile(join(folder, ".pistachio", "log.ndjson"), "utf8");
    expect(log).toContain("went on 3 s after it was told to end: its streams were ended from main");
    expect(log).not.toContain("killed");
  });

  test("a clone made through a frame's realm is past the guard: main discounts the worker's word, and Stop kills it", async () => {
    await extensionsRequest(shell, { type: "barCommand", id: PROBE_ID, command: "probe", arg: "frame", spaceId: null, tabId });
    await expect.poll(async () => (await probeLog(folder)).has("framed") || (await probeLog(folder)).has("failed"), { timeout: 15_000 }).toBe(true);
    expect((await probeLog(folder)).get("failed")).toBeUndefined();
    // The guard sees no track; the clone records on (MEASURED: another realm's clone outlives the original's stop).
    expect((await probeLog(folder)).get("framed")).toEqual({ clone: "live", original: "ended", guard: 0 });
    const info = async () => (await extensionsSnapshot(shell))!.extensions.find((extension) => extension.id === PROBE_ID)!;
    // (The time is the point: past the start grace, a worker with no live track would have been taken as done.)
    await new Promise((resolve) => setTimeout(resolve, 4_500));
    const kept = await info();
    expect(kept.captures).toContain(tabId);
    expect(kept.statusPill).toEqual({ text: "● Recording · Capture probe", actions: [{ id: "stop", title: "Stop" }] });
    // Stop: the worker's word counts for nothing now, so main ends the tracks it knows, then kills the worker — the
    // one end no realm survives — and the capture is gone with it.
    await extensionsRequest(shell, { type: "statusAction", id: PROBE_ID, action: "stop", source: "status" });
    await expect.poll(async () => (await info()).captures ?? [], { timeout: 15_000 }).toEqual([]);
    await expect.poll(
      () =>
        app.evaluate(({ webContents }) =>
          webContents.getAllWebContents().some((contents) => contents.getURL().includes("__pistachio__/worker.html") && !contents.isDestroyed() && !contents.isCrashed()),
        ),
      { timeout: 10_000 },
    ).toBe(false);
    const log = await readFile(join(folder, ".pistachio", "log.ndjson"), "utf8");
    expect(log).toContain("the page made a frame");
    expect(log).toContain("its worker was killed");
  });

  test("off in this Profile: its input subscription and its capture end now, not at the next tab change", async () => {
    const inWorker = (code: string): Promise<unknown> =>
      app.evaluate(async ({ webContents }, script) => {
        const worker = webContents.getAllWebContents().find((contents) => contents.getURL().includes("__pistachio__/worker.html"));
        return worker === undefined ? null : ((await worker.executeJavaScript(script, false)) as unknown);
      }, code);
    const events = async (): Promise<number> => ((await inWorker("globalThis.__held ? globalThis.__held.events.count : -1")) as number | null) ?? -1;
    const trackStates = (): Promise<unknown> => inWorker("globalThis.__held ? globalThis.__held.stream.getTracks().map((t) => t.readyState).join() : null");
    const moves = (from: number): Record<string, unknown>[] => Array.from({ length: 5 }, (_, i) => ({ type: "mouseMove", x: from + i * 7, y: 200 }));
    const info = async () => (await extensionsSnapshot(shell))!.extensions.find((extension) => extension.id === PROBE_ID)!;

    // A fresh hold, its input watched: the moves reach the worker.
    await extensionsRequest(shell, { type: "barCommand", id: PROBE_ID, command: "probe", arg: "hold", spaceId: null, tabId });
    await expect.poll(trackStates, { timeout: 15_000 }).toBe("live");
    await sendToPage(app, pageUrl, moves(100));
    await expect.poll(events, { timeout: 5_000 }).toBeGreaterThan(0);

    // Off in this Profile: nothing more reaches it, and its capture ends. (This Profile is its last: off here is off
    // everywhere, and its worker is stopped with the rest — on in another Profile, the worker would live on and only
    // what it watched and captured here would end.)
    const before = await events();
    await extensionsRequest(shell, { type: "setEnabled", id: PROBE_ID, enabled: false, scope: "here" });
    await expect.poll(async () => (await info()).enabledHere, { timeout: 5_000 }).toBe(false);
    await sendToPage(app, pageUrl, moves(300));
    await new Promise((resolve) => setTimeout(resolve, 600));
    await sendToPage(app, pageUrl, moves(500));
    await new Promise((resolve) => setTimeout(resolve, 600));
    // (The worker gone, nothing counts; alive, it heard nothing more.)
    const after = await events();
    expect(after === -1 || after === before).toBe(true);
    await expect.poll(trackStates, { timeout: 10_000 }).not.toBe("live");
    await expect.poll(async () => ({ captures: (await info()).captures ?? [], pill: (await info()).statusPill }), { timeout: 5_000 }).toEqual({ captures: [], pill: null });
    await expect.poll(async () => (await info()).status, { timeout: 5_000 }).toBe("off");
    // Its icon, dim here, runs nothing on a click.
    await expect(extensionsRequest(shell, { type: "activate", id: PROBE_ID, tabId, anchor: null })).rejects.toThrow(/is off/);

    // Back on here, for what follows.
    await extensionsRequest(shell, { type: "setEnabled", id: PROBE_ID, enabled: true, scope: "here" });
    await expect.poll(async () => (await info()).enabledHere, { timeout: 5_000 }).toBe(true);
    await expect.poll(async () => (await info()).status, { timeout: 10_000 }).toMatch(/idle|running/);
  });

  test("capture.sources from the worker lists the desk's windows, with a picture only of the one the person pointed it at", async () => {
    // A second window, in use on the desk in front; the command is run on the first page (its grant), the chooser closed.
    const otherUrl = `${pageUrl}?other`;
    await createTab(shell, otherUrl);
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === otherUrl), { timeout: 10_000 }).toBe(true);
    const otherId = (await snapshot(shell)).tabs.find((tab) => tab.url === otherUrl)!.id;
    await extensionsRequest(shell, { type: "barCommand", id: PROBE_ID, command: "probe", arg: "sources", spaceId: null, tabId });
    await expect.poll(async () => (await probeLog(folder)).has("sources") || (await probeLog(folder)).has("failed"), { timeout: 15_000 }).toBe(true);
    const said = (await probeLog(folder)).get("sources") as { invoked: string; list: { tabId: string; url: string; still: boolean }[] };
    expect(said).toBeDefined();
    // The window in use is listed — never pointed at, without its picture (a list of pictures of the desk is a
    // screenshot; the rule itself is extensions-capture.test.ts picturedSources: under the e2e no still comes either way).
    expect(said.list.map((source) => source.tabId)).toContain(otherId);
    expect(said.list.find((source) => source.tabId === otherId)?.still).toBe(false);
    await shell.evaluate((id) => (window as unknown as { pistachio: { closeTab(id: string): Promise<void> } }).pistachio.closeTab(id), otherId);
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.id === otherId), { timeout: 10_000 }).toBe(false);
  });

  test("a panel the worker opened on its own is no chooser: its capture.sources pictures only what was granted; opened by the person, every window", async () => {
    // A second window on the desk, granted to no one; the first is granted by the commands run on it.
    const secondUrl = `${pageUrl}?second`;
    await createTab(shell, secondUrl);
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === secondUrl), { timeout: 10_000 }).toBe(true);
    const secondId = (await snapshot(shell)).tabs.find((tab) => tab.url === secondUrl)!.id;
    const panels = await probeCount(folder, "panel");
    await extensionsRequest(shell, { type: "barCommand", id: PROBE_ID, command: "probe", arg: "panel-later", spaceId: null, tabId });
    await expect.poll(() => probeCount(folder, "panel-scheduled"), { timeout: 10_000 }).toBeGreaterThan(0);
    // (The time is the point: the command's gesture is five seconds old by the time the worker opens the panel.)
    await expect.poll(() => probeCount(folder, "panel"), { timeout: 20_000 }).toBe(panels + 1);
    type Listed = { total: number; pictured: number; list: { tabId: string; still: boolean }[] };
    const unasked = (await probeLog(folder)).get("panel") as Listed;
    // The second window is listed, granted to no one: no picture of it from a panel no one opened.
    expect(unasked.list.find((source) => source.tabId === secondId)).toEqual({ tabId: secondId, still: false });
    const card = shell.getByTestId("extension-panel-card");
    await expect(card).toHaveAttribute("data-shown", "");
    // The person: the icon closes the panel the worker opened, and opens it again as theirs — a chooser now.
    const icon = shell.locator(`[data-testid="ledge-icon"][data-extension-id="${PROBE_ID}"]`);
    await icon.click();
    await expect(card).toHaveCount(0);
    await icon.click();
    await expect(card).toHaveAttribute("data-shown", "");
    // (The panel's view is kept across a close and an open: its page is reloaded here to ask once more, now as the person's.)
    await app.evaluate(({ webContents }, id) => {
      webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(`pistachio-ext://${id}/panel.html`))?.reload();
    }, PROBE_ID);
    await expect.poll(() => probeCount(folder, "panel"), { timeout: 15_000 }).toBe(panels + 2);
    const asked = (await probeLog(folder)).get("panel") as Listed;
    expect(asked.list.find((source) => source.tabId === secondId)).toEqual({ tabId: secondId, still: true });
    expect(asked.pictured).toBe(asked.total);
    await shell.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await shell.evaluate((id) => (window as unknown as { pistachio: { closeTab(id: string): Promise<void> } }).pistachio.closeTab(id), secondId);
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.id === secondId), { timeout: 10_000 }).toBe(false);
  });

  test("a declared key runs on the window in use; one the app holds stays unbound and the status file says so", async () => {
    await sendToPage(app, pageUrl, [{ type: "keyDown", keyCode: "9", modifiers: ["meta", "shift"] }, { type: "keyUp", keyCode: "9", modifiers: ["meta", "shift"] }]);
    await expect.poll(async () => (await probeLog(folder)).get("key") ?? null, { timeout: 10_000 }).toMatchObject({ tabId });
    const status = JSON.parse(await readFile(join(folder, ".pistachio", "status.json"), "utf8")) as { keys: { id: string; binding: string | null; unbound: string | null }[] };
    expect(status.keys).toEqual([
      { id: "probe-key", key: "Cmd+Shift+9", binding: "Mod+Shift+9", unbound: null },
      { id: "steal", key: "Cmd+T", binding: null, unbound: expect.stringContaining("New tab") },
    ]);
    expect((await probeLog(folder)).has("stolen")).toBe(false);
  });

  test("agent.ask fills the Bar for the person to send", async () => {
    await extensionsRequest(shell, { type: "barCommand", id: PROBE_ID, command: "ask", arg: "", spaceId: null, tabId });
    await expect.poll(async () => (await probeLog(folder)).has("asked")).toBe(true);
    await reachBar(shell);
    await expect(shell.getByTestId("desk-bar-input")).toHaveValue("What does this page say about invoices?");
    await capture(app, shell, "02-asked.png");
  });
});
