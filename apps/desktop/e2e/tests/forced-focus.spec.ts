import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { captureEnabled, electronExecutable, newProfile } from "./app";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/forced-focus");

/**
 * What a site checks to decide whether it is the tab in front: the Page
 * Visibility API, document.hasFocus(), the events that announce changes to
 * either, and whether its animation frames and timers still run.
 */
const PROBE_PAGE = `<!doctype html><title>Focus probe</title><body><h1>Focus probe</h1><script>
  const events = [];
  document.addEventListener("visibilitychange", () => events.push("visibility:" + document.visibilityState));
  window.addEventListener("focus", (event) => { if (event.target === window) events.push("focus"); });
  window.addEventListener("blur", (event) => { if (event.target === window) events.push("blur"); });
  let frames = 0;
  (function frame() { frames++; requestAnimationFrame(frame); })();
  let ticks = 0;
  setInterval(() => ticks++, 20);
  window.focusProbe = () => ({
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    hasFocus: document.hasFocus(),
    events: events.slice(),
    frames,
    ticks,
  });
</script></body>`;

interface ProbeState {
  visibilityState: DocumentVisibilityState;
  hidden: boolean;
  hasFocus: boolean;
  events: string[];
  frames: number;
  ticks: number;
}

/**
 * The app, driven through its main process's Node inspector rather than
 * Playwright's Electron launcher. Playwright attaches a DevTools session to
 * every page it finds and turns on `Emulation.setFocusEmulationEnabled` in
 * each — the very mechanism under test — so under it every background tab
 * already reads as focused and visible. Nothing attaches to the pages here:
 * what a probe reports is what a site would see.
 */
interface App {
  /** Run `source` — `(electron, arg) => value` — in the main process. */
  main<T>(source: string, arg?: unknown): Promise<T>;
  /** Run an expression in the shell's own document. */
  shell<T>(expression: string): Promise<T>;
  close(): Promise<void>;
}

async function launch(executablePath: string, userData: string): Promise<App> {
  const child: ChildProcess = spawn(executablePath, [".", "--inspect=0"], {
    cwd: process.cwd(),
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  const inspectorUrl = await new Promise<string>((found, failed) => {
    let output = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /ws:\/\/\S+/.exec(output);
      if (match !== null) found(match[0]);
    });
    child.once("exit", () => failed(new Error(`app exited before its inspector opened:\n${output}`)));
  });
  const socket = new WebSocket(inspectorUrl);
  await new Promise((open) => socket.addEventListener("open", open, { once: true }));
  let nextId = 0;
  const pending = new Map<number, (message: InspectorReply) => void>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as InspectorReply;
    if (message.id !== undefined) pending.get(message.id)?.(message);
  });
  const evaluate = <T,>(expression: string): Promise<T> =>
    new Promise<T>((settle, fail) => {
      const id = ++nextId;
      pending.set(id, (message) => {
        pending.delete(id);
        const thrown = message.result?.exceptionDetails;
        if (message.error !== undefined || thrown !== undefined) {
          fail(new Error(thrown?.exception?.description ?? thrown?.text ?? message.error?.message ?? "evaluate failed"));
        } else settle(message.result?.result?.value as T);
      });
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true },
        }),
      );
    });
  const main = <T,>(source: string, arg?: unknown): Promise<T> =>
    evaluate<T>(`(${source})(require("electron"), ${JSON.stringify(arg ?? null)})`);
  const app: App = {
    main,
    shell: <T,>(expression: string) =>
      main<T>(
        `async ({ webContents }, expression) => {
          const shell = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("pistachio-app://shell/"));
          if (shell === undefined) throw new Error("the shell has not loaded");
          return shell.executeJavaScript(expression);
        }`,
        expression,
      ),
    close: async () => {
      socket.close();
      if (child.exitCode !== null) return;
      const exited = new Promise((settle) => child.once("exit", settle));
      child.kill();
      // An app still starting up can sit on SIGTERM; never leave one behind.
      const stubborn = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(stubborn);
    },
  };
  await expect.poll(() => app.shell<boolean>("typeof window.pistachio?.getSnapshot === 'function'").catch(() => false), { timeout: 30_000 }).toBe(true);
  return app;
}

interface InspectorReply {
  id?: number;
  error?: { message: string };
  result?: {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
}

/** The window, when captures are asked for; `settleMs` lets a motion finish first. */
async function capture(app: App, filename: string, settleMs = 0): Promise<void> {
  if (!captureEnabled) return;
  if (settleMs > 0) await new Promise((settle) => setTimeout(settle, settleMs));
  const png = await app.main<string>(`async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return (await window.capturePage()).toPNG().toString("base64");
  }`);
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(join(screenshotDirectory, filename), Buffer.from(png, "base64"));
}

/** Read the probe from inside the page, the way the site itself would see it. */
function probe(app: App, urlPrefix: string): Promise<ProbeState> {
  return app.main<ProbeState>(
    `async ({ webContents }, prefix) => {
      const page = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(prefix));
      if (page === undefined) throw new Error("no page at " + prefix);
      return page.executeJavaScript("window.focusProbe()");
    }`,
    urlPrefix,
  );
}

/** Animation frames and 20ms timer ticks the page ran in half a second: about 30 and 25 when it runs at full rate. */
async function measureRates(app: App, urlPrefix: string): Promise<{ frames: number; ticks: number }> {
  const before = await probe(app, urlPrefix);
  await new Promise((settle) => setTimeout(settle, 500));
  const after = await probe(app, urlPrefix);
  return { frames: after.frames - before.frames, ticks: after.ticks - before.ticks };
}

/**
 * A real mouse click, sent to the shell as input, at the middle of the box
 * of `selector` — or, given `{ menuItem }`, of the open menu's item with
 * that label, found in the same step so the menu cannot change in between.
 */
async function click(app: App, selector: string | { menuItem: string }, button: "left" | "right" = "left"): Promise<void> {
  const find =
    typeof selector === "string"
      ? `document.querySelector(${JSON.stringify(selector)})`
      : `[...document.querySelectorAll('[role^="menuitem"]')].find((node) => node.textContent?.trim() === ${JSON.stringify(selector.menuItem)})`;
  await app.main(
    `async ({ webContents }, { find, button }) => {
      const shell = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("pistachio-app://shell/"));
      const box = await shell.executeJavaScript(
        "(() => { const rect = (" + find + ")?.getBoundingClientRect();" +
        " return rect === undefined ? null : { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()",
      );
      if (box === null) throw new Error("nothing matches " + find);
      const at = { x: Math.round(box.x), y: Math.round(box.y) };
      shell.sendInputEvent({ type: "mouseMove", ...at });
      shell.sendInputEvent({ type: "mouseDown", button, clickCount: 1, ...at });
      shell.sendInputEvent({ type: "mouseUp", button, clickCount: 1, ...at });
    }`,
    { find, button },
  );
}

/** The open menu's item labelled `label`: whether it shows checked, or null while no such item is open. */
function menuItem(app: App, label: string): Promise<{ checked: boolean } | null> {
  return app.shell<{ checked: boolean } | null>(`(() => {
    const item = [...document.querySelectorAll('[role^="menuitem"]')].find((node) => node.textContent?.trim() === ${JSON.stringify(label)});
    if (item === undefined) return null;
    return { checked: item.getAttribute("aria-checked") === "true" || item.querySelector(".lucide-check") !== null };
  })()`);
}

/**
 * The open menu takes clicks and its entry animation has run out, so its
 * items are where a click aims. It waits, inert, until the shell is raised
 * over the page (ContextMenu's `ready`), then animates in.
 */
async function menuSettled(app: App): Promise<void> {
  await expect
    .poll(() =>
      app.shell<boolean>(`(async () => {
        const menu = document.querySelector('[data-testid="context-menu"]');
        if (menu === null || getComputedStyle(menu).pointerEvents === "none") return false;
        await Promise.all(menu.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined)));
        return getComputedStyle(menu).opacity === "1";
      })()`),
    )
    .toBe(true);
}

/** Right-click `row` and wait for its menu to offer `label`, at rest; reopens if a stray re-render closed it. */
async function openMenuWith(app: App, row: string, label: string): Promise<{ checked: boolean }> {
  for (let attempt = 0; ; attempt++) {
    await click(app, row, "right");
    try {
      await expect.poll(() => menuItem(app, label), { timeout: 3_000 }).not.toBeNull();
      await menuSettled(app);
      return (await menuItem(app, label)) ?? { checked: false };
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

const snapshot = (app: App): Promise<ShellSnapshot> => app.shell<ShellSnapshot>("window.pistachio.getSnapshot()");

// Its own launch, through the Node inspector (see `launch`): it cannot share a Playwright-driven app.
test("Force focus in a tab's context menu makes a background page believe it is the focused, visible tab", { tag: ["@tabs"] }, async () => {
  const server: Server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(request.url === "/other" ? "<!doctype html><title>Other tab</title><h1>Other tab</h1>" : PROBE_PAGE);
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const { port } = server.address() as AddressInfo;
  const probeUrl = `http://127.0.0.1:${port}/probe`;
  const otherUrl = `http://127.0.0.1:${port}/other`;
  // Another site entirely (localhost is not 127.0.0.1): a cross-site
  // navigation, which may move the page to a new renderer process.
  const crossSiteUrl = `http://localhost:${port}/probe`;

  const userData = await newProfile("forced-focus");
  await writeFile(join(userData, "settings.json"), JSON.stringify({ layout: { sidebar: "pinned" } }));
  const app = await launch(electronExecutable(), userData);
  try {
    // The probe opens in the first tab, then a second tab takes the front:
    // the probe is now a background tab, and it knows it.
    // Navigating before the start page settles would abort its load.
    await expect.poll(async () => (await snapshot(app)).tabs[0]?.loading, { timeout: 20_000 }).toBe(false);
    const first = (await snapshot(app)).tabs[0];
    if (first === undefined) throw new Error("no starting tab");
    const row = `[data-testid="human-tab"][data-tab-id="${first.id}"]`;
    const mark = `[data-testid="tab-forced-focus-mark-${first.id}"]`;
    await app.shell(`window.pistachio.navigate(${JSON.stringify(first.id)}, ${JSON.stringify(probeUrl)})`);
    await expect.poll(() => probe(app, probeUrl).then((state) => state.visibilityState).catch(() => "none")).toBe("visible");
    await app.shell(`window.pistachio.createTab(${JSON.stringify(otherUrl)})`);
    await expect.poll(async () => (await snapshot(app)).tabs.length).toBe(2);
    await expect.poll(async () => (await probe(app, probeUrl)).visibilityState).toBe("hidden");
    const backgrounded = await probe(app, probeUrl);
    expect(backgrounded.hidden).toBe(true);
    expect(backgrounded.hasFocus).toBe(false);
    expect(backgrounded.events).toContain("visibility:hidden");
    expect((await measureRates(app, probeUrl)).frames).toBe(0);
    expect((await snapshot(app)).tabs.find((tab) => tab.id === first.id)?.forcedFocus).toBe(false);
    await capture(app, "01-probe-in-background.png");

    // Right-click the background tab: the menu offers "Force focus", unchecked.
    expect(await openMenuWith(app, row, "Force focus")).toEqual({ checked: false });
    await capture(app, "02-context-menu.png");
    await click(app, { menuItem: "Force focus" });

    // The page, still behind the other tab, now reads as the focused,
    // visible one — and heard about it the way it would on a real switch.
    await expect.poll(async () => (await probe(app, probeUrl)).visibilityState).toBe("visible");
    const forced = await probe(app, probeUrl);
    expect(forced.hidden).toBe(false);
    expect(forced.hasFocus).toBe(true);
    expect(forced.events.slice(backgrounded.events.length)).toEqual(expect.arrayContaining(["visibility:visible", "focus"]));
    const forcedRates = await measureRates(app, probeUrl);
    expect(forcedRates.frames).toBeGreaterThan(10);
    expect(forcedRates.ticks).toBeGreaterThan(12);
    const afterToggle = await snapshot(app);
    expect(afterToggle.activeTabId).not.toBe(first.id);
    expect(afterToggle.tabs.find((tab) => tab.id === first.id)?.forcedFocus).toBe(true);
    await expect.poll(() => app.shell<boolean>(`document.querySelector(${JSON.stringify(mark)}) !== null`)).toBe(true);
    await capture(app, "03-forced-focus-on.png");

    // The menu now shows it checked.
    expect(await openMenuWith(app, row, "Force focus")).toEqual({ checked: true });
    await capture(app, "04-context-menu-checked.png");
    await app.main(`({ webContents }) => {
      const shell = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("pistachio-app://shell/"));
      shell.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      shell.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    }`);
    await expect.poll(() => menuItem(app, "Force focus")).toBeNull();

    // Blurring the whole window does not reach the page either.
    const eventsBefore = (await probe(app, probeUrl)).events.length;
    await app.main(`({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.blur()`);
    // The shell hears the blur; a page that was going to would have by a beat after.
    await expect.poll(() => app.shell<boolean>("document.hasFocus()")).toBe(false);
    await new Promise((settle) => setTimeout(settle, 200));
    const afterBlur = await probe(app, probeUrl);
    expect(afterBlur.hasFocus).toBe(true);
    expect(afterBlur.visibilityState).toBe("visible");
    expect(afterBlur.events.slice(eventsBefore)).not.toContain("blur");
    expect(afterBlur.events.slice(eventsBefore)).not.toContain("visibility:hidden");

    // It holds for the page's next document: a reload, then another site.
    await app.shell(`window.pistachio.reload(${JSON.stringify(first.id)})`);
    await expect.poll(() => probe(app, probeUrl).then((state) => state.frames < afterBlur.frames).catch(() => false)).toBe(true);
    await expect.poll(() => probe(app, probeUrl).then((state) => state.visibilityState)).toBe("visible");
    const reloaded = await probe(app, probeUrl);
    expect(reloaded).toMatchObject({ hidden: false, hasFocus: true });
    expect(reloaded.events).not.toContain("visibility:hidden");
    await app.shell(`window.pistachio.navigate(${JSON.stringify(first.id)}, ${JSON.stringify(crossSiteUrl)})`);
    await expect.poll(() => probe(app, crossSiteUrl).then((state) => state.visibilityState).catch(() => "none")).toBe("visible");
    const crossSite = await probe(app, crossSiteUrl);
    expect(crossSite.hasFocus).toBe(true);
    expect((await measureRates(app, crossSiteUrl)).frames).toBeGreaterThan(10);

    // Pressing the tab's mark turns it off: the page hears the truth at once.
    await click(app, mark);
    await expect.poll(async () => (await probe(app, crossSiteUrl)).visibilityState).toBe("hidden");
    const released = await probe(app, crossSiteUrl);
    expect(released.hidden).toBe(true);
    expect(released.hasFocus).toBe(false);
    expect(released.events).toContain("visibility:hidden");
    expect((await measureRates(app, crossSiteUrl)).frames).toBe(0);
    expect((await snapshot(app)).tabs.find((tab) => tab.id === first.id)?.forcedFocus).toBe(false);
    expect(await app.shell<boolean>(`document.querySelector(${JSON.stringify(mark)}) !== null`)).toBe(false);
    await capture(app, "05-forced-focus-off.png");
  } finally {
    await app.close();
    server.close();
  }
});
