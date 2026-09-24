/**
 * The shell host against a real Chromium context (docs/web-browser-design.md
 * §6.3, §6.5): tabs, the coalesced split snapshot, the shelf, split groups,
 * sleep and wake, the durable record, viewport following the pane, the
 * favicon fetched through the context, and find in page.
 */

import type { BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ShellTabsSnapshot } from "@pistachio/shell-contracts/ipc";
import type { BrowserSessionState } from "@pistachio/shell-contracts/tab-session";
import { SHELL_METHOD_NAMES } from "@pistachio/shell-contracts/ipc";
import { HOME_PAGE_FAVICON, HOME_PAGE_TITLE, HOME_PAGE_URL } from "@pistachio/shell-contracts/home";
import { NOTES_PAGE_FAVICON, NOTES_PAGE_TITLE, NOTES_PAGE_URL, noteUrl } from "@pistachio/shell-contracts/notes";
import { PlaywrightBrowserBackend } from "../../src/backend/playwright-backend.js";
import { installNetworkGuard } from "../../src/browser/guard.js";
import { SafeBrowserNetworkPolicy } from "../../src/browser/network-policy.js";
import { PlaywrightBrowserRuntime } from "../../src/browser/runtime.js";
import { isUnsupportedShellMethod, ShellHost, UNSUPPORTED, type ShellHostSpace } from "../../src/sessions/shell-host.js";
import { scriptedFindModel } from "@pistachio/smart-find/scripted";
import { CHROMIUM, describeChromium } from "../helpers/chromium.js";
import { settle, startFixture, type FixtureServer } from "../helpers/fixture-server.js";

const SPACE = "work";
const SESSION = "33333333-3333-4333-8333-333333333333";
const USER = "11111111-1111-4111-8111-111111111111";

const PAGE_HTML = `<!doctype html><html><head><title>Fixture</title>
<link rel="icon" href="/icon.png">
</head><body>
<h1>hello hello hello</h1>
<input id="field" name="field" />
<p id="width"></p>
<script>
  const paint = () => { document.getElementById("width").textContent = String(window.innerWidth) + "x" + String(window.innerHeight); };
  paint();
  window.addEventListener("resize", paint);
</script>
</body></html>`;

const OTHER_HTML = `<!doctype html><html><head><title>Other</title></head><body>other</body></html>`;

const runtime = new PlaywrightBrowserRuntime({ executablePath: CHROMIUM ?? undefined, proxyMode: "direct" });
const contexts: BrowserContext[] = [];
let iconRequests = 0;
const fixture: FixtureServer = await startFixture((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (path === "/denied") { response.writeHead(403); response.end(); return; }
  if (path === "/page.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE_HTML);
    return;
  }
  if (path === "/other.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(OTHER_HTML);
    return;
  }
  if (path === "/icon.png") {
    iconRequests += 1;
    response.writeHead(200, { "content-type": "image/png" });
    // One transparent pixel is a real image and small enough to inline.
    response.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    return;
  }
  response.writeHead(404);
  response.end();
});
const pageUrl = `${fixture.origin}/page.html`;
const otherUrl = `${fixture.origin}/other.html`;
/** One note's address — twelve hex, as `isNoteId` wants (docs/notes.md N6). */
const NOTE_URL = noteUrl("0123456789ab");

interface Harness {
  host: ShellHost;
  snapshots: ShellTabsSnapshot[];
  states: BrowserSessionState[];
  context: BrowserContext;
}

async function makeHost(extra: Partial<ConstructorParameters<typeof ShellHost>[0]> = {}): Promise<Harness> {
  const browser = await runtime.browser();
  const context = await browser.newContext({
    serviceWorkers: "block",
    acceptDownloads: false,
    viewport: { width: 1280, height: 800 },
  });
  contexts.push(context);
  const policy = new SafeBrowserNetworkPolicy({ allowedOrigins: [fixture.origin] });
  const listeners = new Set<() => void>();
  const backend = await PlaywrightBrowserBackend.attach({
    context,
    spaceId: SPACE,
    policy,
    installGuard: (page) => installNetworkGuard(page, { policy, gateway: () => null, credential: () => null }),
    onTabsChanged: () => {
      for (const listener of [...listeners]) listener();
    },
    settle: async () => undefined,
  });
  const space: ShellHostSpace = {
    browser: {
      backend,
      onTabsChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    workspace: null,
  };
  const host = new ShellHost({
    sessionId: SESSION,
    userId: USER,
    spaceId: SPACE,
    space,
    control: () => ({ holder: "human", generation: 0 }),
    version: "9.9.9",
    chromeVersion: () => "chromium/test",
    ...extra,
  });
  const snapshots: ShellTabsSnapshot[] = [];
  const states: BrowserSessionState[] = [];
  host.onSnapshot((snapshot) => snapshots.push(snapshot));
  host.onSessionState((state) => states.push(state));
  return { host, snapshots, states, context };
}

describe("the unsupported list", () => {
  it("names only real ShellApi methods, and every one of them refuses in the same shape", () => {
    const methods = new Set<string>(SHELL_METHOD_NAMES);
    for (const member of Object.keys(UNSUPPORTED)) {
      expect(methods.has(member), `${member} is not a ShellApi method`).toBe(true);
    }
    // Every entry carries a REASON a person can read, not a stage label: the
    // list is now what this host will never answer (W12 and the account
    // surface the web app owns), so the shell can put the reason on screen.
    for (const [member, reason] of Object.entries(UNSUPPORTED)) {
      expect(reason.length, `${member} has no readable reason`).toBeGreaterThanOrEqual(20);
      expect(reason, `${member} names a stage rather than a reason`).not.toMatch(/^S\d$/u);
    }
    // The list is what shrinks: the members this host DOES answer are not in
    // it — including everything S5 took out of it (§8).
    for (const answered of [
      "getSnapshot",
      "createTab",
      "closeTab",
      "selectTab",
      "navigate",
      "sidebarCommand",
      "getSettings",
      "find",
      "getAppInfo",
      "startDelegation",
      "newThread",
      "openThread",
      "sendAgentMessage",
      "answerAgentQuestion",
      "approve",
      "reject",
      "interruptAgent",
      "takeControl",
      "releaseControl",
      "revokeRun",
      "getEvidence",
      "startCloudRun",
      "closeLiveView",
      "sendLiveInput",
      // S6 (§11): every capability row below answers now.
      "getMedia",
      "controlMedia",
      "getBrowserControls",
      "browserControl",
      "getDownloads",
      "getTabSwitcherPreviews",
      "getGlance",
      "openGlance",
      "toggleReaderView",
      "clearBrowsingData",
      "getMemory",
      "addMemory",
      "getReminders",
      "addReminder",
      "getBookmarks",
      "bookmarkTab",
      "completeOnboarding",
      "deleteThread",
      "moveTabToSpace",
      "getUpdateState",
      // Stage 2a (docs/notes.md §7): the notes pages are shell-drawn, and
      // this host now draws them and answers them out of the workspace.
      "notes",
      "setTabTitle",
    ]) {
      expect(Object.keys(UNSUPPORTED)).not.toContain(answered);
    }
  });
});

describeChromium("ShellHost", () => {
  beforeAll(async () => {
    await runtime.browser();
  });

  afterAll(async () => {
    await Promise.all(contexts.splice(0).map((context) => context.close().catch(() => undefined)));
    await runtime.close();
    await fixture.close();
  });

  it("normalizes bare addresses for new tabs and navigation", async () => {
    const { host } = await makeHost();
    await host.createTab(pageUrl.replace("http://", ""));
    const first = await host.getSnapshot();
    expect(first.tabs[0]?.url).toBe(pageUrl);
    await host.navigate(first.activeTabId!, otherUrl.replace("http://", ""));
    expect((await host.getSnapshot()).tabs[0]?.url).toBe(otherUrl);
  });

  it("opens the home page as a blank page under its own address, and Back returns to it", async () => {
    const { host, snapshots, states } = await makeHost();
    // The default home page is Pistachio's own, and no `pistachio://`
    // address ever reaches the backend (its policy would refuse it).
    await host.createTab();
    const opened = await host.getSnapshot();
    expect(opened.tabs[0]).toMatchObject({ url: HOME_PAGE_URL, title: HOME_PAGE_TITLE, faviconUrl: HOME_PAGE_FAVICON, lifecycle: "live" });
    const id = opened.activeTabId!;

    await host.navigate(id, pageUrl);
    expect((await host.getSnapshot()).tabs[0]?.url).toBe(pageUrl);

    await host.goBack(id);
    await settle(() => snapshots.at(-1)?.tabs[0]?.url === HOME_PAGE_URL);
    expect((await host.getSnapshot()).tabs[0]).toMatchObject({ url: HOME_PAGE_URL, title: HOME_PAGE_TITLE, canGoForward: true });
    // The record carries the address, never `about:blank`.
    await settle(() => states.at(-1)?.tabs[0]?.url === HOME_PAGE_URL);

    // Typed or linked, the address goes back to the home page.
    await host.navigate(id, pageUrl);
    await host.navigate(id, "pistachio://home");
    expect((await host.getSnapshot()).tabs[0]?.url).toBe(HOME_PAGE_URL);
  });

  it("wakes a sleeping home tab blank, under the home address", async () => {
    const { host, snapshots } = await makeHost();
    await host.createTab(pageUrl);
    await host.createTab(HOME_PAGE_URL);
    const home = (await host.getSnapshot()).activeTabId!;
    const page = (await host.getSnapshot()).tabs.find((tab) => tab.id !== home)!.id;
    await host.selectTab(page);
    await host.suspendTab(home);
    expect((await host.getSnapshot()).tabs.find((tab) => tab.id === home)).toMatchObject({ url: HOME_PAGE_URL, lifecycle: "suspended" });
    await host.selectTab(home);
    await settle(() => snapshots.at(-1)?.tabs.find((tab) => tab.id === home)?.lifecycle === "live");
    expect((await host.getSnapshot()).tabs.find((tab) => tab.id === home)).toMatchObject({ url: HOME_PAGE_URL, title: HOME_PAGE_TITLE });
  });

  /* ------------------------ shell pages beyond home ----------------------- */

  it("draws a notes tab itself: its own address, never handed to Chromium, and library ↔ note is real history", async () => {
    const { host, snapshots, states, context } = await makeHost();
    await host.createTab(NOTES_PAGE_URL);
    const opened = await host.getSnapshot();
    const id = opened.activeTabId!;
    expect(opened.tabs[0]).toMatchObject({
      url: NOTES_PAGE_URL,
      title: NOTES_PAGE_TITLE,
      faviconUrl: NOTES_PAGE_FAVICON,
      lifecycle: "live",
    });
    // The page the tab actually holds is the placeholder: no `pistachio://`
    // address is ever handed to the backend, whose policy would refuse it.
    expect(context.pages().map((page) => page.url())).not.toContain(NOTES_PAGE_URL);
    expect(context.pages().some((page) => page.url().startsWith("data:text/html"))).toBe(true);

    // Library → note → back → forward. The two placeholders are DIFFERENT
    // documents (each carries its own address), so these are real entries.
    await host.navigate(id, NOTE_URL);
    expect((await host.getSnapshot()).tabs[0]).toMatchObject({ url: NOTE_URL, title: NOTES_PAGE_TITLE });
    await host.goBack(id);
    await settle(() => snapshots.at(-1)?.tabs[0]?.url === NOTES_PAGE_URL);
    expect((await host.getSnapshot()).tabs[0]).toMatchObject({ url: NOTES_PAGE_URL, canGoForward: true });
    await host.goForward(id);
    await settle(() => snapshots.at(-1)?.tabs[0]?.url === NOTE_URL);
    // The record carries the note's own address, never the placeholder.
    await settle(() => states.at(-1)?.tabs[0]?.url === NOTE_URL);
  });

  it("lets a shell-drawn page name its own tab, and refuses every other address", async () => {
    const { host } = await makeHost();
    await host.createTab(NOTE_URL);
    const noteTab = (await host.getSnapshot()).activeTabId!;
    await host.setTabTitle(noteTab, "  Pie   crust  ");
    expect((await host.getSnapshot()).tabs[0]).toMatchObject({ title: "Pie crust", url: NOTE_URL });

    // The placeholder's static `<title>` lands on every load; the name the
    // shell gave this address wins for as long as the tab is at it.
    await host.navigate(noteTab, NOTE_URL);
    expect((await host.getSnapshot()).tabs[0]?.title).toBe("Pie crust");
    await host.navigate(noteTab, NOTES_PAGE_URL);
    expect((await host.getSnapshot()).tabs[0]?.title).toBe(NOTES_PAGE_TITLE);

    await host.createTab(pageUrl);
    const site = (await host.getSnapshot()).activeTabId!;
    await expect(host.setTabTitle(site, "Not yours")).rejects.toThrow(/only a shell page/u);
  });

  it("rebuilds a stored notes tab as a shell page", async () => {
    const first = await makeHost();
    await first.host.createTab(NOTE_URL);
    const noteTab = (await first.host.getSnapshot()).activeTabId!;
    await first.host.setTabTitle(noteTab, "Pie crust");
    await first.host.createTab(pageUrl);
    await settle(() => first.states.length > 0);
    const state = first.host.sessionState();
    expect(state.tabs.map((tab) => tab.url)).toEqual([NOTE_URL, pageUrl]);

    const second = await makeHost();
    await second.host.restore(state);
    const rebuilt = await second.host.getSnapshot();
    // Asleep, and already the shell's to paint: the address and the note's
    // own name are on the strip before the tab is ever woken.
    expect(rebuilt.tabs[0]).toMatchObject({
      url: NOTE_URL,
      title: "Pie crust",
      faviconUrl: NOTES_PAGE_FAVICON,
      lifecycle: "suspended",
    });
    await second.host.selectTab(noteTab);
    await settle(() => second.snapshots.at(-1)?.tabs[0]?.lifecycle === "live");
    expect((await second.host.getSnapshot()).tabs[0]).toMatchObject({ url: NOTE_URL, title: "Pie crust" });
    expect(second.context.pages().map((page) => page.url())).not.toContain(NOTE_URL);
  });

  it("opens a tab, publishes one coalesced snapshot carrying it, and answers getSnapshot whole", async () => {
    const { host, snapshots } = await makeHost();
    await host.createTab(pageUrl);
    await settle(() => snapshots.some((snapshot) => snapshot.tabs.length === 1));
    const published = snapshots.find((snapshot) => snapshot.tabs.length === 1);
    expect(published?.tabs[0]).toMatchObject({ url: pageUrl, kind: "human", lifecycle: "live" });
    // The tab side never carries the conversation (architecture.md).
    expect(published).not.toHaveProperty("run");
    expect(published).not.toHaveProperty("threads");
    const whole = await host.getSnapshot();
    expect(whole.tabs).toHaveLength(1);
    expect(whole.run).toBeNull();
    expect(whole.activeTabId).toBe(whole.tabs[0]?.id);
    expect(whole.visibleTabIds).toEqual([whole.tabs[0]?.id]);
  });

  it("coalesces a burst of changes into one flush", async () => {
    // No page in flight: a live tab keeps publishing title ticks and favicon
    // arrivals, and what is under test is the coalescing, not the page.
    const { host, snapshots } = await makeHost();
    expect(snapshots).toHaveLength(0);
    host.publish();
    host.publish();
    host.publish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(snapshots).toHaveLength(1);
  });

  it("reorders tabs by the shell's own convention", async () => {
    const { host } = await makeHost();
    await host.createTab(pageUrl);
    await host.createTab(otherUrl);
    const [first, second] = (await host.getSnapshot()).tabs;
    await host.reorderTab(second!.id, 0);
    expect((await host.getSnapshot()).tabs.map((tab) => tab.id)).toEqual([second!.id, first!.id]);
  });

  it("puts two tabs into a split group and takes one out again", async () => {
    const { host } = await makeHost();
    await host.createTab(pageUrl);
    await host.createTab(otherUrl);
    const snapshot = await host.getSnapshot();
    const other = snapshot.tabs.find((tab) => tab.id !== snapshot.activeTabId);
    await host.splitWith(other!.id, "right");
    const split = await host.getSnapshot();
    expect(split.splitGroups).toHaveLength(1);
    expect(split.splitGroups[0]?.tabIds).toContain(other!.id);
    expect(split.visibleTabIds).toHaveLength(2);
    expect(split.splitMode).toBe("vertical");
    await host.removeFromSplit(other!.id);
    expect((await host.getSnapshot()).splitGroups).toHaveLength(0);
  });

  it("runs a shelf command through the shared controller and binds the tab to its pin", async () => {
    const { host } = await makeHost();
    await host.createTab(pageUrl);
    const tabId = (await host.getSnapshot()).activeTabId!;
    await host.sidebarCommand({ type: "pinTab", tabId, folderId: null, index: 0 });
    const snapshot = await host.getSnapshot();
    expect(snapshot.sidebar.entries).toHaveLength(1);
    const pin = snapshot.sidebar.entries[0]!;
    expect(snapshot.tabs.find((tab) => tab.id === tabId)?.anchorId).toBe(pin.id);
    // Opening the pin selects the tab that is already its page.
    await host.sidebarCommand({ type: "open", anchorId: pin.id });
    expect((await host.getSnapshot()).activeTabId).toBe(tabId);
  });

  it("sleeps a tab by closing its page, and wakes it back to the same address under the same id", async () => {
    const { host, context } = await makeHost();
    await host.createTab(pageUrl);
    await host.createTab(otherUrl);
    const snapshot = await host.getSnapshot();
    const sleepy = snapshot.tabs.find((tab) => tab.id !== snapshot.activeTabId)!;
    const pagesBefore = context.pages().length;
    await host.suspendTab(sleepy.id);
    expect((await host.getSnapshot()).tabs.find((tab) => tab.id === sleepy.id)?.lifecycle).toBe("suspended");
    await settle(() => context.pages().length === pagesBefore - 1);
    await host.selectTab(sleepy.id);
    const woken = (await host.getSnapshot()).tabs.find((tab) => tab.id === sleepy.id);
    expect(woken?.lifecycle).toBe("live");
    expect(woken?.url).toBe(sleepy.url);
  });

  it("wakes a visible sleeping pane once even when selection races it", async () => {
    const { host, context } = await makeHost();
    await host.createTab(pageUrl); await host.createTab(otherUrl);
    const sleepy = (await host.getSnapshot()).tabs.find(tab => tab.url === pageUrl)!;
    await host.suspendTab(sleepy.id);
    const count = context.pages().length;
    host.setPane(sleepy.id, { width: 800, height: 600, dpr: 1, visible: true });
    host.setPane(sleepy.id, { width: 900, height: 600, dpr: 1, visible: true });
    await host.selectTab(sleepy.id);
    await settle(() => host.guardSessionFor(sleepy.id) !== null);
    expect(context.pages()).toHaveLength(count + 1);
    expect(await context.pages().find(page => page.url() === pageUrl)!.evaluate(() => window.innerWidth)).toBe(900);
    expect((await host.getSnapshot()).tabs.find(tab => tab.id === sleepy.id)?.lifecycle).toBe("live");
  });

  it("keeps a durable record and rebuilds a session from it", async () => {
    const first = await makeHost();
    await first.host.createTab(pageUrl);
    await first.host.createTab(otherUrl);
    await settle(() => first.states.length > 0);
    const state = first.host.sessionState();
    expect(state.tabs.map((tab) => tab.url)).toEqual([pageUrl, otherUrl]);
    expect(state.activeTabId).toBe(state.tabs[1]?.id);

    const second = await makeHost();
    await second.host.restore(state);
    const rebuilt = await second.host.getSnapshot();
    expect(rebuilt.tabs.map((tab) => tab.id)).toEqual(state.tabs.map((tab) => tab.id));
    expect(rebuilt.tabs.map((tab) => tab.url)).toEqual([pageUrl, otherUrl]);
    // Only the active tab's page is opened; the rest stay asleep until chosen.
    expect(rebuilt.tabs.find((tab) => tab.id === state.activeTabId)?.lifecycle).toBe("live");
    expect(rebuilt.tabs.find((tab) => tab.id !== state.activeTabId)?.lifecycle).toBe("suspended");
    expect(second.context.pages()).toHaveLength(1);
  });

  it("retains a renderable tab when a restored navigation receives HTTP 403", async () => {
    const first = await makeHost(); await first.host.createTab(pageUrl);
    const state = first.host.sessionState();
    state.tabs[0]!.url = `${fixture.origin}/denied`;
    const restored = await makeHost(); await restored.host.restore(state);
    const tab = (await restored.host.getSnapshot()).tabs.find(tab => tab.id === state.activeTabId)!;
    expect(tab.lifecycle).toBe("live");
    expect(restored.host.guardSessionFor(tab.id)).not.toBeNull();
    expect(restored.context.pages()).toHaveLength(1);
    expect(tab.url).toBe(`${fixture.origin}/denied`);
    expect(await restored.context.pages()[0]!.locator("body").innerText()).toContain("HTTP ERROR 403");
    const messages: Array<{ k: string }> = [];
    const mirror = restored.host.mirrorFor(tab.id)!;
    await mirror.attach({ send: message => messages.push(message) });
    expect(messages.some(message => message.k === "snapshot")).toBe(true);
    await restored.host.navigate(tab.id, pageUrl);
    expect((await restored.host.getSnapshot()).tabs.find(candidate => candidate.id === tab.id)?.url).toBe(pageUrl);
  });

  it("sizes the page to its pane", async () => {
    const { host } = await makeHost();
    await host.createTab(pageUrl);
    const tabId = (await host.getSnapshot()).activeTabId!;
    host.setPane(tabId, { width: 640, height: 480, dpr: 2, visible: true });
    expect(host.paneFor(tabId)?.width).toBe(640);
    // The resize is debounced; give it its window, then read the page itself.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const size = await readPageSize(host, tabId);
    expect(size).toBe("640x480");
  });

  it("fetches the tab's icon through the context and caches it per origin", async () => {
    const { host, snapshots } = await makeHost();
    await host.createTab(pageUrl);
    await settle(() => snapshots.some((snapshot) => typeof snapshot.tabs[0]?.faviconUrl === "string"));
    const icon = (await host.getSnapshot()).tabs[0]?.faviconUrl;
    // The bytes came back through the context, so they went out under the
    // Space's cookies and the user's egress rather than to a favicon proxy.
    expect(icon).toMatch(/^data:image\/png;base64,/);
    expect(iconRequests).toBeGreaterThan(0);

    // A second tab on the same origin gets the cached icon — which is
    // observable precisely because that page declares no icon of its own.
    await host.createTab(otherUrl);
    await settle(() => snapshots.some((snapshot) => typeof snapshot.tabs[1]?.faviconUrl === "string"));
    expect((await host.getSnapshot()).tabs[1]?.faviconUrl).toBe(icon);
  });

  it("counts matches for find in page, and clears on close", async () => {
    const { host } = await makeHost();
    await host.createTab(pageUrl);
    await host.find({ type: "search", query: "hello", forward: true });
    const state = await host.getFindState();
    expect(state.open).toBe(true);
    expect(state.matches).toBe(3);
    await host.find({ type: "close" });
    expect(await host.getFindState()).toMatchObject({ open: false, matches: 0 });
  });

  it("finds by meaning when it has a model: reads the page, paints the match, steps, and clears on close", async () => {
    const { host, context } = await makeHost({ intentModel: () => scriptedFindModel({ "a greeting": ["hello"] }) });
    await host.createTab(pageUrl);
    const page = context.pages().find((candidate) => candidate.url() === pageUrl)!;
    const painted = () => page.evaluate(() => [...(CSS.highlights.get("pistachio-find-active") ?? [])].map(String));
    const until = async (test: () => Promise<boolean>): Promise<void> => {
      for (let turn = 0; turn < 200 && !(await test()); turn += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    };

    await host.find({ type: "mode", mode: "smart" });
    expect(await host.getFindState()).toMatchObject({ open: true, mode: "smart", smartAvailable: true, smart: { status: "idle" } });
    // A draft asks nothing.
    await host.find({ type: "search", query: "a greet", forward: true, mode: "smart", draft: true });
    expect((await host.getFindState()).smart.status).toBe("idle");

    await host.find({ type: "search", query: "a greeting", forward: true, mode: "smart" });
    await until(async () => (await host.getFindState()).smart.status === "done" && (await painted()).length === 1);
    expect(await host.getFindState()).toMatchObject({ query: "a greeting", matches: 1, activeMatchOrdinal: 1, smart: { excerpt: "hello hello hello", weak: false } });
    expect(await painted()).toEqual(["hello hello hello"]);
    expect(await page.evaluate(() => document.querySelectorAll("style").length)).toBe(0);

    // Back to exact words: the smart highlights come down and the text is searched as typed.
    await host.find({ type: "search", query: "hello", forward: true, mode: "exact" });
    expect(await host.getFindState()).toMatchObject({ mode: "exact", matches: 3 });
    expect(await painted()).toEqual([]);

    await host.find({ type: "search", query: "a greeting", forward: true, mode: "smart" });
    await until(async () => (await painted()).length === 1);
    await host.find({ type: "close" });
    await until(async () => (await painted()).length === 0);
    expect(await host.getFindState()).toMatchObject({ open: false, mode: "exact", matches: 0 });
  });

  it("stays an exact find when there is no model to ask, or the setting is off", async () => {
    const { host } = await makeHost();
    await host.createTab(pageUrl);
    await host.find({ type: "search", query: "hello", forward: true, mode: "smart" });
    expect(await host.getFindState()).toMatchObject({ mode: "exact", smartAvailable: false, matches: 3 });

    const off = await makeHost({ intentModel: () => scriptedFindModel({}) });
    await off.host.updateSettings({ search: { smartFind: false } });
    await off.host.find({ type: "mode", mode: "smart" });
    expect(await off.host.getFindState()).toMatchObject({ mode: "exact", smartAvailable: false });
  });

  it("answers `getAppInfo` as the web platform", async () => {
    const { host } = await makeHost();
    expect(await host.getAppInfo()).toMatchObject({ platform: "web", version: "9.9.9", chrome: "chromium/test" });
  });

  it("refuses a member it will never answer with the reason the shell shows", async () => {
    const { host } = await makeHost();
    await expect(host.listDevices()).rejects.toSatisfy(
      (error: unknown) => isUnsupportedShellMethod(error) && error.reason === UNSUPPORTED.listDevices,
    );
    // The reason IS the message: whatever the shell renders, it renders this.
    await expect(host.listDevices()).rejects.toThrow(UNSUPPORTED.listDevices);
  });
});

/** What the page itself thinks its viewport is. */
async function readPageSize(host: ShellHost, tabId: string): Promise<string> {
  const session = host.guardSessionFor(tabId);
  if (session === null) throw new Error("no guard session for the tab");
  const result = (await session.send("Runtime.evaluate", {
    expression: "document.getElementById('width').textContent",
    returnByValue: true,
  })) as { result: { value: string } };
  return result.result.value;
}
