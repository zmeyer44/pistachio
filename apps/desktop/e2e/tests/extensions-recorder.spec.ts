/**
 * The Recorder (docs/recorder.md §6), end to end in the real app: turned on
 * from the extensions page's library, `/record` in the Bar records the window
 * in use (an animated page served from localhost), the spec presses the
 * page's button while it records, the status pill's ■ stops it, and then:
 * the recording's folder in the extension's data root (`screen.mp4`,
 * `events.jsonl`, `project.json` with a zoom on the press), the editor opened
 * as a desk window on it, and an MP4 export of 1080p30 from the editor into
 * this run's screenshots folder (PISTACHIO_SCREENSHOT_DIR), read back with
 * mediabunny. A second export goes on with the editor's window closed under
 * it (the engine, the extension's worker, runs it): the file lands all the
 * same, a notice says *Exported*, and the editor opened again shows it.
 *
 * The editor is an extension page in a native view: Playwright does not
 * attach to it, so the spec drives its sheet from main through the view's
 * `executeJavaScript` (as extensions-capture.spec.ts reaches its page).
 *
 * The person's input goes through the window's real surface
 * (`throughWindow`): to the topmost view on screen under the point, as the OS
 * hands it out — so while the Recorder records, the recorded window must be
 * live (its page's view on screen, not its still under a cover), or the
 * press lands on the shell. Its status pill lies in the nub's lane, drawn
 * over the live page by main's notch view, and its ■ is pressed there.
 */

import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { WebContentsView } from "electron";
/**
 * mediabunny, loaded by name at run time: its typings reference `dom-mediacapture-transform`, whose global overloads
 * of MediaStream.getAudioTracks break shell-contracts' screen-share.ts under the desktop's node typecheck — so the
 * spec keeps its types out and names the little it uses.
 */
interface Mediabunny {
  ALL_FORMATS: unknown;
  BufferSource: new (buffer: ArrayBuffer) => unknown;
  EncodedPacketSink: new (track: unknown) => { packets(): AsyncIterable<unknown> };
  Input: new (options: { source: unknown; formats: unknown }) => {
    getPrimaryVideoTrack(): Promise<{ getCodecParameterString(): Promise<string>; getDisplayWidth(): Promise<number>; getDisplayHeight(): Promise<number> } | null>;
    computeDuration(): Promise<number>;
    getFormat(): Promise<{ name: string }>;
  };
}
const mediabunny = (): Promise<Mediabunny> => import(/* @vite-ignore */ "media" + "bunny") as Promise<Mediabunny>;
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { launchDesk, liveViews, reachBar, screenshots, selectTab, settled, snapshot, windowSelector } from "./desk-harness";
import { noticePage } from "./windows";

const capture = screenshots("extensions-recorder", ["notch"]);
const RECORDER = "com.pistachio.recorder";

const PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Record me</title>
    <style>body{margin:0;font:16px system-ui}canvas{position:fixed;inset:0;width:100vw;height:100vh;z-index:-1}
      #go{position:absolute;left:120px;top:160px;width:160px;height:48px;font:600 16px system-ui}</style></head>
  <body>
    <canvas id="c"></canvas>
    <button id="go" onclick="this.textContent='Pressed'">Press me</button>
    <script>
      const c = document.getElementById("c"), x = c.getContext("2d"); let n = 0;
      (function paint() {
        c.width = innerWidth; c.height = innerHeight; x.fillStyle = "#f6f6f9"; x.fillRect(0, 0, c.width, c.height);
        x.fillStyle = "#e5484d"; x.fillRect((n * 4) % innerWidth, innerHeight * 0.6, 60, 60); n++;
        requestAnimationFrame(paint);
      })();
    </script>
  </body>
</html>`;

interface Point {
  x: number;
  y: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The pointer moved, pressed and let go through the window's real surface: each event to the topmost view on screen
 * whose box holds the point (the window's own coordinates), at that view's own coordinates — or to the shell, under
 * them all — as the OS hands a person's input out (before-mouse-event hears it as theirs). Says whose view had each.
 */
function throughWindow(app: ElectronApplication, events: Array<{ type: "mouseMove" | "mouseDown" | "mouseUp" } & Point>): Promise<string[]> {
  return app.evaluate(async ({ BrowserWindow }, list) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    const hits: string[] = [];
    for (const event of list) {
      let target = window.webContents;
      let at = { x: event.x, y: event.y };
      const views = window.contentView.children;
      for (let i = views.length - 1; i >= 0; i--) {
        const view = views[i]!;
        if (!("webContents" in view) || !view.getVisible()) continue;
        const box = view.getBounds();
        if (event.x < box.x || event.y < box.y || event.x >= box.x + box.width || event.y >= box.y + box.height) continue;
        target = (view as WebContentsView).webContents;
        at = { x: event.x - box.x, y: event.y - box.y };
        break;
      }
      const press = event.type === "mouseMove" ? {} : { button: "left" as const, clickCount: 1 };
      target.sendInputEvent({ type: event.type, x: Math.round(at.x), y: Math.round(at.y), ...press });
      hits.push(target.getURL());
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    return hits;
  }, events);
}

/** Script run in the page at `url` (a tab's view). */
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

/** Main's notch view while it is on screen — its box in the window — and the Recorder's pill and ■ in it (its own coordinates). */
function notchView(app: ElectronApplication): Promise<{ bounds: Box; pill: Box | null; stop: Box | null } | null> {
  return app.evaluate(async ({ BrowserWindow }, id) => {
    const window = BrowserWindow.getAllWindows()[0];
    const view = window?.contentView.children.find(
      (child) => "webContents" in child && (child as WebContentsView).webContents.getURL().endsWith("#notch") && child.getVisible(),
    ) as WebContentsView | undefined;
    if (view === undefined) return null;
    const boxes = (await view.webContents.executeJavaScript(
      `(() => {
        const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
        const pill = document.querySelector('[data-testid="extension-status-pill"][data-extension-id="${id}"]');
        return { pill: box(pill), stop: box(pill && pill.querySelector('[data-action="stop"]')) };
      })()`,
    )) as { pill: Box | null; stop: Box | null };
    return { bounds: view.getBounds(), ...boxes };
  }, RECORDER);
}

const middle = (box: Box): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/** Script run in the first view whose address starts with `prefix` (the editor's: Playwright does not attach to it). */
function viewEval<T>(app: ElectronApplication, prefix: string, code: string): Promise<T> {
  return app.evaluate(
    ({ webContents }, { prefix: start, code: script }) => {
      const view = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(start));
      if (view === undefined) throw new Error(`no view at ${start}…`);
      return view.executeJavaScript(script) as Promise<T>;
    },
    { prefix, code },
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

test.describe.serial("extensions: the Recorder", { tag: ["@extensions"] }, () => {
  let app: ElectronApplication;
  let shell: Page;
  let userData: string;
  let server: Server;
  let pageUrl: string;
  let tabId: string;
  let shots: string;
  let recordingId: string;
  let editorUrl: string;

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
    shots = await mkdtemp(join(tmpdir(), "pistachio-recorder-shots-"));
    ({ app, shell, userData } = await launchDesk({ name: "extensions-recorder", homeUrl: pageUrl, env: { PISTACHIO_SCREENSHOT_DIR: shots } }));
    await settled(shell, app);
    tabId = (await snapshot(shell)).tabs.find((tab) => tab.url === pageUrl)!.id;
  });

  test.afterAll(async () => {
    await app?.close();
    server?.close();
  });

  test("turned on from the library: Made for Pistachio → Turn on → its sheet → Turn it on", async () => {
    await shell.getByTestId("ledge-empty").click();
    const page = shell.getByTestId("extensions-page");
    await expect(page).toBeVisible();
    const row = page.getByTestId("extensions-library").getByTestId("extensions-library-row").filter({ hasText: "Recorder" });
    await expect(row).toBeVisible();
    await row.getByTestId("extensions-library-on").click();
    // In, waiting on the person: its sheet comes up at once and says what it may do (no *Review* to find).
    const installed = page.locator(`[data-testid="extensions-installed-row"][data-extension-id="${RECORDER}"]`);
    await expect(installed).toBeVisible();
    const sheet = shell.getByTestId("extension-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("extension-sheet-name")).toHaveText("Recorder");
    await capture(app, shell, "01-sheet.png");
    await sheet.getByTestId("extension-sheet-turn-on").click();
    await expect(sheet).toHaveCount(0);
    await expect(shell.locator(`[data-testid="ledge-icon"][data-extension-id="${RECORDER}"]`)).toBeVisible();
    // Back to the page's window: the one /record records.
    await selectTab(shell, tabId);
    await expect.poll(async () => (await snapshot(shell)).activeTabId).toBe(tabId);
    await settled(shell, app);
  });

  test("/record records the window in use; the pill's ■ stops it; the recording is solved and the editor opens on it", async () => {
    test.setTimeout(90_000);
    await reachBar(shell);
    await shell.getByTestId("desk-bar-input").fill("/record");
    const command = shell.locator(`[data-testid="desk-command"][data-command="record"][data-extension-id="${RECORDER}"]`);
    await expect(command).toBeVisible();
    await command.click();

    // The count of three in the pill, then the clock.
    const pill = shell.locator(`[data-testid="extension-status-pill"][data-extension-id="${RECORDER}"]`);
    await expect(pill).toBeVisible({ timeout: 10_000 });
    await expect(pill).toContainText(/● \d+:\d\d/, { timeout: 15_000 });
    await capture(app, shell, "02-recording.png");

    // While it records, the recorded window is live — its page's view, not its still: the pill is no cover. It lies in
    // the nub's lane (the nub drawn out along the desk's foot by its width), drawn over the live page by main's notch
    // view, whose box is the lane's.
    const win = shell.locator(windowSelector(tabId));
    await expect.poll(() => win.getAttribute("data-drawn"), { timeout: 5_000 }).toBeNull();
    await expect.poll(async () => (await notchView(app))?.stop ?? null, { timeout: 5_000 }).not.toBeNull();
    const notch = (await notchView(app))!;
    console.log(`[recorder notch] ${JSON.stringify(notch)}`);
    expect(notch.bounds.width).toBeGreaterThan(notch.pill!.width + 40);
    expect(notch.pill!.x + notch.pill!.width).toBeLessThan(notch.bounds.width - 40);

    // Three seconds in, the person moves to the page's button and presses it — through the window's surface, which
    // hands it to the page's own view.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const view = (await liveViews(app)).find((candidate) => candidate.url === pageUrl);
    expect(view).toBeDefined();
    const page = await pageEval<{ button: Box; width: number }>(
      app,
      pageUrl,
      `(() => { const r = document.getElementById("go").getBoundingClientRect(); return { button: { x: r.x, y: r.y, width: r.width, height: r.height }, width: innerWidth }; })()`,
    );
    // (The page's CSS px to the view's: a page zoomed with its window's share of the desk is drawn smaller.)
    const scale = view!.bounds.width / page.width;
    const onPage = (x: number, y: number): Point => ({ x: view!.bounds.x + x * scale, y: view!.bounds.y + y * scale });
    const button = onPage(middle(page.button).x, middle(page.button).y);
    const moves = Array.from({ length: 8 }, (_, i) => ({ type: "mouseMove" as const, ...onPage(420 - i * 30, 320 - i * 16) }));
    const hits = await throughWindow(app, [...moves, { type: "mouseMove", ...button }, { type: "mouseDown", ...button }, { type: "mouseUp", ...button }]);
    expect([...new Set(hits)]).toEqual([pageUrl]);
    await expect.poll(() => pageEval<string>(app, pageUrl, `document.getElementById("go").textContent`)).toBe("Pressed");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await capture(app, shell, "02b-pressed.png");

    // ■ in the pill stops it: pressed where the pill is drawn, over the page — main's notch view has it.
    const at = await notchView(app);
    expect(at?.stop).not.toBeNull();
    const stop = middle({ ...at!.stop!, x: at!.bounds.x + at!.stop!.x, y: at!.bounds.y + at!.stop!.y });
    const stopped = await throughWindow(app, [{ type: "mouseMove", ...stop }, { type: "mouseDown", ...stop }, { type: "mouseUp", ...stop }]);
    expect(stopped.every((url) => url.endsWith("#notch"))).toBe(true);
    await expect(pill).toHaveCount(0, { timeout: 20_000 });

    // The recording's folder in the extension's data root.
    const root = join(userData, "ExtensionData", RECORDER, "data", "recordings");
    await expect.poll(async () => (await readdir(root).catch(() => [] as string[])).length, { timeout: 20_000 }).toBe(1);
    recordingId = (await readdir(root))[0]!;
    const dir = join(root, recordingId);
    await expect.poll(async () => (await exists(join(dir, "screen.mp4"))) && (await exists(join(dir, "events.jsonl"))) && (await exists(join(dir, "project.json"))), { timeout: 20_000 }).toBe(true);
    const lines = (await readFile(join(dir, "events.jsonl"), "utf8")).split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
    const meta = lines[0] as { k: string; capture: { w: number; h: number; dpr: number }; view: { w: number; h: number }; cursorBaked?: boolean };
    const kinds: Record<string, number> = {};
    for (const line of lines.slice(1)) kinds[String(line["k"])] = (kinds[String(line["k"])] ?? 0) + 1;
    const project = JSON.parse(await readFile(join(dir, "project.json"), "utf8")) as { cuts: { in: number; out: number }[]; zooms: { start: number; end: number; level: number; center: [number, number] }[] };
    console.log(`[recorder] ${JSON.stringify({ id: recordingId, meta, kinds, cuts: project.cuts, zooms: project.zooms, screenBytes: (await stat(join(dir, "screen.mp4"))).size })}`);
    expect(meta.k).toBe("meta");
    expect(meta.cursorBaked).toBe(true);
    expect(kinds["frame"]).toBeGreaterThan(30);
    expect(kinds["down"]).toBeGreaterThan(0);
    // The page and the view's box as they stood when the recording began (said during the countdown), at t = 0.
    expect(lines.find((line) => line["k"] === "nav")).toMatchObject({ t: 0, url: pageUrl });
    expect(lines.find((line) => line["k"] === "box")).toMatchObject({ t: 0 });
    // Its view uncovered throughout: never its still under the pill (the input taps say `visible` with each box).
    const boxes = lines.filter((line) => line["k"] === "box") as Array<{ t: number; visible: boolean }>;
    console.log(`[recorder boxes] ${JSON.stringify(boxes)}`);
    expect(boxes.every((box) => box.visible)).toBe(true);
    expect(project.zooms.length).toBeGreaterThanOrEqual(1);

    // The editor, a desk window on the recording.
    editorUrl = `pistachio-ext://${RECORDER}/editor.html?rec=${recordingId}`;
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === editorUrl), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => viewEval<boolean>(app, editorUrl, `document.querySelector(".timeline-canvas") !== null`).catch(() => false), { timeout: 20_000 }).toBe(true);
    await settled(shell, app);
    await capture(app, shell, "03-editor.png");
  });

  test("the editor exports an MP4 at 1080p30 into the screenshots folder", async () => {
    test.setTimeout(90_000);
    // The sheet: MP4, 1080p, 30 fps, then Copy (no Finder window from a spec); Export.
    await viewEval(app, editorUrl, `document.querySelector(".titlebar .button.primary").click(), true`);
    await expect.poll(() => viewEval<boolean>(app, editorUrl, `!document.querySelector(".sheet-layer").hidden`)).toBe(true);
    const pick = (label: string) => `(() => { const b = [...document.querySelectorAll(".sheet .segment")].find((el) => el.textContent === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true; })()`;
    expect(await viewEval<boolean>(app, editorUrl, pick("MP4"))).toBe(true);
    expect(await viewEval<boolean>(app, editorUrl, pick("1080p"))).toBe(true);
    expect(await viewEval<boolean>(app, editorUrl, pick("30 fps"))).toBe(true);
    expect(await viewEval<boolean>(app, editorUrl, pick("Copy"))).toBe(true);
    await capture(app, shell, "04-export-sheet.png");
    await viewEval(app, editorUrl, `document.querySelector(".sheet-foot .button.primary").click(), true`);
    // Done: the finished card in the editor, and the file in this run's screenshots folder.
    await expect
      .poll(() => viewEval<string>(app, editorUrl, `(() => { const card = document.querySelector(".finished-card"); const warn = document.querySelector(".sheet .note.warn"); return card && !card.hidden ? "done" : warn ? "error: " + warn.textContent : "running"; })()`), { timeout: 60_000 })
      .toBe("done");
    await capture(app, shell, "05-exported.png");
    const saved = (await readdir(shots)).filter((name) => name.startsWith("Screen Recording ") && name.endsWith(".mp4"));
    expect(saved).toHaveLength(1);
    const bytes = await readFile(join(shots, saved[0]!));
    const { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } = await mediabunny();
    const input = new Input({ source: new BufferSource(new Uint8Array(bytes).buffer), formats: ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack();
    expect(video).not.toBeNull();
    let frames = 0;
    for await (const _packet of new EncodedPacketSink(video!).packets()) frames++;
    const duration = await input.computeDuration();
    console.log(`[recorder export] ${JSON.stringify({ file: saved[0], bytes: bytes.length, format: (await input.getFormat()).name, codec: await video!.getCodecParameterString(), w: await video!.getDisplayWidth(), h: await video!.getDisplayHeight(), frames, duration })}`);
    expect((await input.getFormat()).name).toBe("MP4");
    expect(await video!.getDisplayHeight()).toBe(1080);
    expect(frames).toBeGreaterThan(1);
    expect(Math.abs(frames - duration * 30)).toBeLessThan(6);

    // The editor's own copy (its data's `exports/`, which the finished card plays) stays while the card shows, and goes
    // with it: the file is in the screenshots folder.
    const exports = join(userData, "ExtensionData", RECORDER, "data", "exports");
    expect((await readdir(exports).catch(() => [] as string[])).length).toBe(1);
    await viewEval(app, editorUrl, `document.querySelector(".finished-close").click(), true`);
    await expect.poll(async () => (await readdir(exports).catch(() => [] as string[])).length, { timeout: 10_000 }).toBe(0);
    expect(await exists(join(shots, saved[0]!))).toBe(true);
  });

  test("an export goes on when its editor closes: the file reaches the screenshots folder, Exported says so, and the reopened editor shows it", async () => {
    test.setTimeout(120_000);
    const recordings = async (): Promise<string[]> => (await readdir(shots)).filter((name) => name.startsWith("Screen Recording ") && name.endsWith(".mp4"));
    const before = new Set(await recordings());
    const notices = await noticePage(app);
    const exported = notices.getByTestId("notice-card").filter({ hasText: "Exported" });
    // (The last export's notice has gone first: the one this test waits for is this export's.)
    await expect(exported).toHaveCount(0, { timeout: 15_000 });
    // The sheet again: MP4 at 1080p60 (a longer run than the last), then Copy; Export.
    await viewEval(app, editorUrl, `document.querySelector(".titlebar .button.primary").click(), true`);
    await expect.poll(() => viewEval<boolean>(app, editorUrl, `!document.querySelector(".sheet-layer").hidden`)).toBe(true);
    const pick = (label: string) => `(() => { const b = [...document.querySelectorAll(".sheet .segment")].find((el) => el.textContent === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true; })()`;
    for (const label of ["MP4", "1080p", "60 fps", "Copy"]) expect(await viewEval<boolean>(app, editorUrl, pick(label))).toBe(true);
    await viewEval(app, editorUrl, `document.querySelector(".sheet-foot .button.primary").click(), true`);
    // Once the export is under way — its file opened in the Recorder's data — the editor's window closes (its tab's ×:
    // the page and everything it owns go).
    const exports = join(userData, "ExtensionData", RECORDER, "data", "exports");
    await expect.poll(async () => (await readdir(exports).catch(() => [] as string[])).length, { timeout: 10_000 }).toBe(1);
    const editorTab = (await snapshot(shell)).tabs.find((tab) => tab.url === editorUrl)!.id;
    await shell.evaluate((id) => (window as unknown as { pistachio: PistachioApi }).pistachio.closeTab(id), editorTab);
    await expect.poll(async () => (await snapshot(shell)).tabs.some((tab) => tab.url === editorUrl)).toBe(false);

    // The export is the worker's: the file lands in the screenshots folder all the same, and the notice says so.
    await expect.poll(async () => (await recordings()).filter((name) => !before.has(name)).length, { timeout: 60_000 }).toBe(1);
    await expect(exported).toBeVisible({ timeout: 15_000 });
    const name = (await recordings()).find((file) => !before.has(file))!;
    const bytes = await readFile(join(shots, name));
    const { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } = await mediabunny();
    const input = new Input({ source: new BufferSource(new Uint8Array(bytes).buffer), formats: ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack();
    expect(video).not.toBeNull();
    let frames = 0;
    for await (const _packet of new EncodedPacketSink(video!).packets()) frames++;
    const duration = await input.computeDuration();
    console.log(`[recorder export, editor closed] ${JSON.stringify({ file: name, bytes: bytes.length, h: await video!.getDisplayHeight(), frames, duration })}`);
    expect(await video!.getDisplayHeight()).toBe(1080);
    expect(Math.abs(frames - duration * 60)).toBeLessThan(10);

    // Opened again on the recording (as the panel's Recent does, by the worker), the editor shows the finished card;
    // closing the card removes the Recorder's own copy.
    expect((await readdir(exports).catch(() => [] as string[])).length).toBe(1);
    await viewEval(app, `pistachio-ext://${RECORDER}/__pistachio__/worker.html`, `pistachio.ui.openPage("editor", { query: "rec=${recordingId}" }).then(() => true)`);
    await expect
      .poll(() => viewEval<string>(app, editorUrl, `(() => { const card = document.querySelector(".finished-card"); return card && !card.hidden ? document.querySelector(".finished-name")?.textContent ?? "" : "no card"; })()`).catch(() => "no editor"), { timeout: 20_000 })
      .toMatch(/^Screen Recording .+\.mp4$/);
    await viewEval(app, editorUrl, `document.querySelector(".finished-close").click(), true`);
    await expect.poll(async () => (await readdir(exports).catch(() => [] as string[])).length, { timeout: 10_000 }).toBe(0);
    expect(await exists(join(shots, name))).toBe(true);
  });
});
