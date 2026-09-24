/**
 * S6's capability table against a real Chromium context
 * (docs/web-browser-design.md §11).
 *
 * Every row of that table has a case here: uploads, the clipboard, downloads
 * (whose bytes are compared), print, the context-menu hit report, site
 * permissions and the geolocation they gate, reader view, zoom that survives
 * a rebuild, and the personal records the shell writes as the person. What is
 * NOT here is anything faked — the page really opens a file picker, really
 * copies, really downloads, and the host really answers.
 */

import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";
import { afterAll, beforeAll, expect, it, onTestFinished } from "vitest";
import { DeviceRegistryVerifier, type HubTransport } from "@pistachio/sync-engine";
import { deriveSpaceKeys, generateSpaceRootSecret, type WorkspaceRecordWire } from "@pistachio/sync-protocol";
import type { BrowserControlsSnapshot, BrowserDownload } from "@pistachio/shell-contracts/browser-controls";
import { WELCOME_TABS } from "@pistachio/shell-contracts/onboarding";
import type { NoteRequest, NoteResponse, NoteSnapshot } from "@pistachio/shell-contracts/notes";
import type { StreamClipboardCopy, StreamContextMenuEvent, StreamFileRequest } from "@pistachio/shell-contracts/socket";
import { PlaywrightBrowserBackend } from "../../src/backend/playwright-backend.js";
import { installNetworkGuard } from "../../src/browser/guard.js";
import { SafeBrowserNetworkPolicy } from "../../src/browser/network-policy.js";
import { PlaywrightBrowserRuntime } from "../../src/browser/runtime.js";
import { SessionDownloads } from "../../src/sessions/downloads.js";
import { ShellHost, type ShellHostSpace } from "../../src/sessions/shell-host.js";
import { withViewer, type ViewerIdentity } from "../../src/sessions/viewer-context.js";
import { WorkspaceToolStore } from "../../src/sync/workspace-tools.js";
import { CHROMIUM, describeChromium } from "../helpers/chromium.js";
import { settle, startFixture, must, type FixtureServer } from "../helpers/fixture-server.js";

const SPACE = "work";
const SESSION = "44444444-4444-4444-8444-444444444444";
const USER = "22222222-2222-4222-8222-222222222222";
const VIEWER = "55555555-5555-4555-8555-555555555555";
const FILE_BYTES = "the bytes that must come back exactly\n";
/** One transparent pixel: a real PNG, and small enough to write out here. */
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** One attached viewer, as the socket would present it (§5, §11). */
const viewer = (id: string, downloadKey: string): ViewerIdentity => ({ id, deviceId: VIEWER, downloadKey });
const ONE = viewer("viewer-one", "key-of-viewer-one");
const TWO = viewer("viewer-two", "key-of-viewer-two");

const PAGE_HTML = `<!doctype html><html><head><title>Capabilities</title></head><body>
<h1 id="head">Capabilities</h1>
<a id="link" href="/other.html">The other page</a>
<img id="pic" src="/icon.png" width="8" height="8">
<input id="file" type="file">
<input id="field" value="">
<p id="copied"></p>
<p id="where">nothing</p>
<button id="download">Download</button>
<script>
  document.getElementById("download").addEventListener("click", () => {
    const link = document.createElement("a");
    link.href = "/payload.bin";
    link.download = "payload.bin";
    link.click();
  });
  window.copyHeading = () => {
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("head"));
    selection.removeAllRanges();
    selection.addRange(range);
    // The same event Chromium raises for a real copy, on the same target the
    // bridge's capture listener watches. execCommand("copy") is refused in a
    // headless run with no clipboard, which would test nothing.
    document.dispatchEvent(new Event("copy", { bubbles: true }));
  };
  window.askWhere = () => navigator.geolocation.getCurrentPosition(
    (position) => { document.getElementById("where").textContent = position.coords.latitude.toFixed(2); },
    (error) => { document.getElementById("where").textContent = "denied:" + error.message; },
  );
</script>
</body></html>`;

/** Long enough that the reader's own 120-word floor is cleared honestly. */
const ARTICLE_HTML = `<!doctype html><html><head><title>A Long Read</title>
<meta name="author" content="A Writer"></head><body><article><h1>A Long Read</h1>
${Array.from({ length: 12 }, (_, index) => `<p>Paragraph ${String(index)} says something about the subject at hand, with commas, clauses, and enough ordinary prose that a scorer treating this as an article is not being generous. It goes on for a while, as articles do.</p>`).join("\n")}
</article></body></html>`;

const OTHER_HTML = `<!doctype html><html><head><title>Other</title></head><body>other</body></html>`;

const runtime = new PlaywrightBrowserRuntime({ executablePath: CHROMIUM ?? undefined, proxyMode: "direct" });
const contexts: BrowserContext[] = [];
const stateDirs: string[] = [];

const fixture: FixtureServer = await startFixture((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (path === "/page.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE_HTML);
    return;
  }
  if (path === "/article.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(ARTICLE_HTML);
    return;
  }
  if (path === "/other.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(OTHER_HTML);
    return;
  }
  if (path === "/payload.bin") {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="payload.bin"',
    });
    response.end(FILE_BYTES);
    return;
  }
  if (path === "/icon.png") {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    return;
  }
  response.writeHead(404);
  response.end();
});

const pageUrl = `${fixture.origin}/page.html`;
const articleUrl = `${fixture.origin}/article.html`;

interface Harness {
  close(): Promise<void>;
  host: ShellHost;
  downloads: SessionDownloads;
  workspace: WorkspaceToolStore;
  context: BrowserContext;
  stream: { channel: string; payload: unknown }[];
}

async function makeWorkspace(now?: () => Date): Promise<WorkspaceToolStore> {
  const signing = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const verifier = new DeviceRegistryVerifier("reject");
  verifier.addDevice("cloud-device", signing.publicKey);
  const store = new WorkspaceToolStore({
    deviceId: "cloud-device",
    ...(now === undefined ? {} : { now }),
    privateKey: (signing as CryptoKeyPair).privateKey,
    keys: deriveSpaceKeys("__workspace__", generateSpaceRootSecret()),
    transport: {
      publishWorkspace: (_docs: WorkspaceRecordWire[]) => undefined,
      state: "connected",
    } as unknown as HubTransport,
    verifier: async () => verifier,
  });
  store.hydrated();
  await store.ready;
  return store;
}

async function makeHost(options: { now?: () => Date } = {}): Promise<Harness> {
  const browser = await runtime.browser();
  const context = await browser.newContext({
    serviceWorkers: "block",
    // §11: a person's session downloads files, and the host decides where.
    acceptDownloads: true,
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
  const stateDir = await mkdtemp(join(tmpdir(), "pistachio-downloads-"));
  stateDirs.push(stateDir);
  const downloads = new SessionDownloads({ userId: USER, stateDir });
  const workspace = await makeWorkspace(options.now);
  const space: ShellHostSpace = {
    browser: {
      backend,
      onTabsChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    workspace,
  };
  const host = new ShellHost({
    sessionId: SESSION,
    userId: USER,
    spaceId: SPACE,
    space,
    control: () => ({ holder: "human", generation: 0 }),
    downloads,
    version: "9.9.9",
    chromeVersion: () => "chromium/test",
  });
  const stream: { channel: string; payload: unknown }[] = [];
  host.onFileRequest((payload) => stream.push({ channel: "pistachio:file-request", payload }));
  host.onClipboardCopy((payload) => stream.push({ channel: "pistachio:clipboard-copy", payload }));
  host.onContextMenu((payload) => stream.push({ channel: "pistachio:context-menu", payload }));
  const harness: Harness = {
    host,
    downloads,
    workspace,
    context,
    stream,
    // One Chromium holds every context in this file; a suite that never lets
    // one go runs out of tabs long before it runs out of cases.
    close: async () => {
      host.close();
      downloads.close();
      await context.close().catch(() => undefined);
    },
  };
  onTestFinished(() => harness.close());
  return harness;
}

/**
 * `settle` for a condition only the page can answer. The fixture helper's own
 * predicate is synchronous, and half of what this file waits on is a value
 * inside Chromium.
 */
async function settleIn(predicate: () => Promise<boolean>, turns = 200): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition did not settle within the turn budget");
}

/** One of the host's rendered welcome documents, by the title it carries. */
async function welcomePage(harness: Harness, title: string): Promise<import("playwright-core").Page> {
  const found: import("playwright-core").Page[] = [];
  await settleIn(async () => {
    for (const page of harness.context.pages()) {
      if (!page.url().startsWith("data:text/html")) continue;
      if ((await page.title().catch(() => "")) !== title) continue;
      found.push(page);
      return true;
    }
    return false;
  });
  return must(found[0], `the welcome page titled ${title}`);
}

/** The page behind the host's only tab, for driving the fixture directly. */
function pageOf(harness: Harness): import("playwright-core").Page {
  return must(harness.context.pages().find((page) => page.url().startsWith(fixture.origin)), "the fixture page");
}

describeChromium("S6 capabilities", () => {
  beforeAll(async () => {
    await runtime.browser();
  });

  afterAll(async () => {
    await Promise.all(contexts.splice(0).map((context) => context.close().catch(() => undefined)));
    await runtime.close();
    await fixture.close();
    await Promise.all(stateDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("turns a page's file picker into a request the pane answers, and the bytes land in the input", async () => {
    const harness = await makeHost();
    await harness.host.createTab(pageUrl);
    const page = pageOf(harness);
    // The click that opens the picker never settles until the chooser is
    // answered, so it is not awaited here.
    void page.click("#file").catch(() => undefined);
    await settle(() => harness.stream.some((entry) => entry.channel === "pistachio:file-request"));
    const request = must(
      harness.stream.find((entry) => entry.channel === "pistachio:file-request")?.payload,
      "the file request",
    ) as StreamFileRequest;
    expect(request.multiple).toBe(false);
    await harness.host.provideFiles(request.requestId, [
      { name: "note.txt", type: "text/plain", base64: Buffer.from(FILE_BYTES).toString("base64") },
    ]);
    const named = await page.evaluate(
      `(() => { const input = document.getElementById("file"); return input.files[0] ? input.files[0].name + ":" + String(input.files[0].size) : ""; })()`,
    );
    expect(named).toBe(`note.txt:${String(Buffer.byteLength(FILE_BYTES))}`);
  });

  it("refuses an upload over the 32 MB one call may carry, and tells the page nothing was chosen", async () => {
    const harness = await makeHost();
    await harness.host.createTab(pageUrl);
    const page = pageOf(harness);
    void page.click("#file").catch(() => undefined);
    await settle(() => harness.stream.some((entry) => entry.channel === "pistachio:file-request"));
    const request = must(
      harness.stream.find((entry) => entry.channel === "pistachio:file-request")?.payload,
      "the file request",
    ) as StreamFileRequest;
    await expect(
      harness.host.provideFiles(request.requestId, [
        { name: "huge.bin", type: "", base64: Buffer.alloc(33 * 1024 * 1024).toString("base64") },
      ]),
    ).rejects.toThrow(/32 MB/u);
  });

  it("mirrors a page's copy to the pane, and pastes the person's clipboard into the page", async () => {
    const harness = await makeHost();
    await harness.host.createTab(pageUrl);
    const page = pageOf(harness);
    await page.evaluate("window.copyHeading()");
    await settle(() => harness.stream.some((entry) => entry.channel === "pistachio:clipboard-copy"));
    const copied = must(
      harness.stream.find((entry) => entry.channel === "pistachio:clipboard-copy")?.payload,
      "the copy",
    ) as StreamClipboardCopy;
    expect(copied.text).toContain("Capabilities");

    const tabId = must((await harness.host.getSnapshot()).tabs[0]?.id, "the tab");
    await page.click("#field");
    await harness.host.pasteText(tabId, "pasted from the person");
    expect(await page.inputValue("#field")).toBe("pasted from the person");
  });

  it("keeps a download's bytes and serves them once through a viewer-bound URL", async () => {
    const harness = await makeHost();
    await harness.host.createTab(pageUrl);
    const page = pageOf(harness);
    await page.click("#download");
    await settle(() => harness.downloads.list().some((download) => download.state === "completed"));
    const download = must(harness.downloads.list()[0], "the download") satisfies BrowserDownload;
    expect(download.fileName).toBe("payload.bin");
    expect(download.receivedBytes).toBe(Buffer.byteLength(FILE_BYTES));
    expect(await harness.host.getDownloads()).toHaveLength(1);

    const { url } = await withViewer(ONE, () => harness.host.downloadUrl(download.id));
    const token = must(new URL(url, "http://x").searchParams.get("access_token"), "the token");
    // The URL alone is not a credential: a second viewer of the same session,
    // and anyone the link is forwarded to, has to present the key that minted
    // it, and only the socket it was issued to holds one.
    expect(await harness.host.openDownload(download.id, token, TWO.downloadKey)).toBeNull();
    expect(await harness.host.openDownload(download.id, token, "")).toBeNull();
    const stream = must(await harness.host.openDownload(download.id, token, ONE.downloadKey), "the stream");
    const chunks: Buffer[] = [];
    for await (const chunk of stream.body) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(FILE_BYTES);
    // One use only: a forwarded URL opens nothing.
    expect(await harness.host.openDownload(download.id, token, ONE.downloadKey)).toBeNull();
  });

  it("prints a tab to a PDF that appears as a download", async () => {
    const harness = await makeHost();
    await harness.host.createTab(articleUrl);
    const tabId = must((await harness.host.getSnapshot()).tabs[0]?.id, "the tab");
    await harness.host.printToPdf(tabId);
    const printed = must(
      harness.downloads.list().find((download) => download.fileName.endsWith(".pdf")),
      "the printed pdf",
    );
    expect(printed.state).toBe("completed");
    expect(printed.receivedBytes).toBeGreaterThan(0);
    const { url } = await withViewer(ONE, () => harness.host.downloadUrl(printed.id));
    const token = must(new URL(url, "http://x").searchParams.get("access_token"), "the token");
    const stream = must(await harness.host.openDownload(printed.id, token, ONE.downloadKey), "the stream");
    const chunks: Buffer[] = [];
    for await (const chunk of stream.body) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("reports what the pointer was over on a right-click, with the link the shell's menu needs", async () => {
    const harness = await makeHost();
    await harness.host.createTab(pageUrl);
    const page = pageOf(harness);
    await page.click("#link", { button: "right" });
    await settle(() => harness.stream.some((entry) => entry.channel === "pistachio:context-menu"));
    const event = must(
      harness.stream.find((entry) => entry.channel === "pistachio:context-menu")?.payload,
      "the context menu report",
    ) as StreamContextMenuEvent;
    expect(event.target.linkURL).toBe(`${fixture.origin}/other.html`);
    expect(event.target.pageURL).toBe(pageUrl);
    expect(event.target.isEditable).toBe(false);
    expect(event.x).toBeGreaterThanOrEqual(0);

    // …and over a text field the menu is the editing one.
    harness.stream.length = 0;
    await page.click("#field", { button: "right" });
    await settle(() => harness.stream.some((entry) => entry.channel === "pistachio:context-menu"));
    const editable = must(
      harness.stream.find((entry) => entry.channel === "pistachio:context-menu")?.payload,
      "the editable report",
    ) as StreamContextMenuEvent;
    expect(editable.target.isEditable).toBe(true);
  });

  it("prompts for geolocation, remembers the answer, and gives the page the emulated position", async () => {
    const harness = await makeHost();
    await harness.host.createTab(pageUrl);
    const page = pageOf(harness);
    const controls: BrowserControlsSnapshot[] = [];
    harness.host.onBrowserControlsChanged((snapshot) => controls.push(snapshot));
    await page.evaluate("window.askWhere()");
    await settle(() => controls.some((snapshot) => snapshot.pendingPermissions.length > 0));
    const pending = must(
      controls.find((snapshot) => snapshot.pendingPermissions.length > 0)?.pendingPermissions[0],
      "the prompt",
    );
    expect(pending.permission).toBe("geolocation");

    const tabId = must((await harness.host.getSnapshot()).tabs[0]?.id, "the tab");
    await harness.host.setGeolocation(tabId, { latitude: 51.5, longitude: -0.12, accuracy: 20 });
    await harness.host.browserControl({ type: "resolvePermission", requestId: pending.id, decision: "allow" });
    await settleIn(async () => (await page.textContent("#where")) === "51.50");
    expect(await page.textContent("#where")).toBe("51.50");

    // The decision is durable: it rides the sealed session record (§9).
    expect(harness.host.sessionState().permissions).toMatchObject({
      // Keyed by ORIGIN, not host: a grant given to https must not be spent
      // by the same name over plaintext http.
      [new URL(pageUrl).origin]: { geolocation: "allow" },
    });

    // …and camera and microphone are refused with the W12 message.
    const snapshot = await harness.host.getBrowserControls();
    expect(snapshot.permissions.camera.decision).toBe("block");
    expect(snapshot.permissions.microphone.reason).toMatch(/own device/u);
    expect(snapshot.passkeys.webAuthnAvailable).toBe(false);
  });

  it("blocks a site the person blocked, without asking again", async () => {
    const harness = await makeHost();
    await harness.host.createTab(pageUrl);
    const page = pageOf(harness);
    const controls: BrowserControlsSnapshot[] = [];
    harness.host.onBrowserControlsChanged((snapshot) => controls.push(snapshot));
    await page.evaluate("window.askWhere()");
    await settle(() => controls.some((snapshot) => snapshot.pendingPermissions.length > 0));
    const pending = must(
      controls.find((snapshot) => snapshot.pendingPermissions.length > 0)?.pendingPermissions[0],
      "the prompt",
    );
    await harness.host.browserControl({ type: "resolvePermission", requestId: pending.id, decision: "block" });
    await settleIn(async () => ((await page.textContent("#where")) ?? "").startsWith("denied"));

    // A second ask is answered from the stored decision, with no new prompt.
    await page.evaluate(`(() => { document.getElementById("where").textContent = "nothing"; window.askWhere(); })()`);
    await settleIn(async () => ((await page.textContent("#where")) ?? "").startsWith("denied"));
    expect((await harness.host.getBrowserControls()).pendingPermissions).toHaveLength(0);
  });

  it("shows an article as a reader page beside the tab it came from", async () => {
    const harness = await makeHost();
    await harness.host.createTab(articleUrl);
    const tabId = must((await harness.host.getSnapshot()).tabs[0]?.id, "the tab");
    expect(await harness.host.toggleReaderView(tabId)).toBe(true);
    const after = await harness.host.getSnapshot();
    expect(after.tabs).toHaveLength(2);
    const reader = must(after.tabs[1], "the reader tab");
    expect(reader.url.startsWith("data:text/html")).toBe(true);
    expect(decodeURIComponent(reader.url)).toContain("A Long Read");
    // Leaving reader view closes it again.
    expect(await harness.host.toggleReaderView(reader.id)).toBe(true);
    expect((await harness.host.getSnapshot()).tabs).toHaveLength(1);
  });

  it("answers false rather than opening a reader tab for a page with no article", async () => {
    const harness = await makeHost();
    await harness.host.createTab(pageUrl);
    const tabId = must((await harness.host.getSnapshot()).tabs[0]?.id, "the tab");
    expect(await harness.host.toggleReaderView(tabId)).toBe(false);
    expect((await harness.host.getSnapshot()).tabs).toHaveLength(1);
  });

  it("zooms per origin, applies it to the page, and keeps it in the durable record", async () => {
    const harness = await makeHost();
    await harness.host.createTab(pageUrl);
    const page = pageOf(harness);
    await harness.host.browserControl({ type: "zoomIn" });
    await harness.host.browserControl({ type: "zoomIn" });
    expect((await harness.host.getBrowserControls()).zoomPercent).toBe(120);
    await settleIn(async () => (await page.evaluate("document.documentElement.style.zoom")) === "1.2");
    const host = new URL(pageUrl).host;
    expect(harness.host.sessionState().zoom[host]).toBeCloseTo(1.2, 5);

    // A rebuilt session zooms the site the same way, without being told again.
    const rebuilt = await makeHost();
    await rebuilt.host.restore(harness.host.sessionState());
    expect((await rebuilt.host.getBrowserControls()).zoomPercent).toBe(120);
    const restored = must(rebuilt.context.pages().find((entry) => entry.url() === pageUrl), "the restored page");
    await settleIn(async () => (await restored.evaluate("document.documentElement.style.zoom")) === "1.2");

    await harness.host.browserControl({ type: "zoomReset" });
    expect(harness.host.sessionState().zoom[host]).toBeUndefined();
  });

  it("lists the playing media in a tab and mutes it", async () => {
    const harness = await makeHost();
    await harness.host.createTab(pageUrl);
    const page = pageOf(harness);
    await page.evaluate(
      `(() => {
        const audio = document.createElement("audio");
        audio.id = "player";
        audio.loop = true;
        audio.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";
        document.body.append(audio);
        return audio.play().catch(() => undefined);
      })()`,
    );
    await settleIn(async () => (await harness.host.getMedia()).length > 0);
    const media = await harness.host.getMedia();
    expect(media[0]?.tabTitle).toBe("Capabilities");
    const tabId = must((await harness.host.getSnapshot()).tabs[0]?.id, "the tab");
    await harness.host.controlMedia(tabId, { type: "mute" });
    expect(await page.evaluate(`document.getElementById("player").muted`)).toBe(true);
  });

  it("captures a still for each recent tab in the switcher", async () => {
    const harness = await makeHost();
    await harness.host.createTab(pageUrl);
    const previews = await harness.host.getTabSwitcherPreviews();
    expect(previews).toHaveLength(1);
    expect(previews[0]?.dataUrl?.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("opens a glance target as a tab beside the current one (§10)", async () => {
    const harness = await makeHost();
    await harness.host.createTab(pageUrl);
    expect(await harness.host.getGlance()).toBeNull();
    const opened = await harness.host.openGlance({
      url: `${fixture.origin}/other.html`,
      source: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(opened).toBe(true);
    const snapshot = await harness.host.getSnapshot();
    expect(snapshot.tabs.map((tab) => tab.url)).toEqual([pageUrl, `${fixture.origin}/other.html`]);
    // …and there is still never a glance overlay to close.
    expect(await harness.host.getGlance()).toBeNull();
  });

  it("clears the Space's cookies and page storage", async () => {
    const harness = await makeHost();
    await harness.host.createTab(pageUrl);
    const page = pageOf(harness);
    await page.evaluate(`(() => { document.cookie = "a=1"; localStorage.setItem("k", "v"); return true; })()`);
    expect(await harness.context.cookies(pageUrl)).not.toHaveLength(0);
    await harness.host.clearBrowsingData();
    expect(await harness.context.cookies(pageUrl)).toHaveLength(0);
    expect(await page.evaluate(`localStorage.getItem("k")`)).toBeNull();
  });

  it("writes bookmarks, memories and reminders as the person, through the same synced records the agent uses", async () => {
    const harness = await makeHost();
    await harness.host.createTab(pageUrl);

    const bookmark = await harness.host.bookmarkTab();
    expect(bookmark.url).toBe(pageUrl);
    expect(bookmark.source).toEqual({ kind: "user", runId: null });
    expect((await harness.host.getBookmarks()).bookmarks).toHaveLength(1);
    const updated = await harness.host.updateBookmark(bookmark.id, { note: "read again" });
    expect(updated.note).toBe("read again");
    await harness.host.deleteBookmark(bookmark.id);
    expect((await harness.host.getBookmarks()).bookmarks).toHaveLength(0);

    const memory = await harness.host.addMemory({
      content: "Claudius takes the aisle seat",
      kind: "static",
      bucket: "preference",
    });
    expect(memory.source).toEqual({ kind: "user", runId: null });
    const forgotten = await harness.host.forgetMemory(memory.id, "changed my mind");
    expect(forgotten.isForgotten).toBe(true);
    const restored = await harness.host.restoreMemory(memory.id);
    expect(restored.isForgotten).toBe(false);
    expect((await harness.host.reviewMemory(memory.id, "approved")).review).toBe("approved");
    expect(await harness.host.forgetAllMemory()).toBeGreaterThan(0);

    const reminder = await harness.host.addReminder({
      title: "Water the plants",
      schedule: { kind: "daily", time: "09:00" },
      action: { kind: "message", text: "Water the plants" },
      timezone: "UTC",
    });
    expect((await harness.host.getReminders()).reminders).toHaveLength(1);
    expect((await harness.host.cancelReminder(reminder.id)).status).toBe("cancelled");
    await harness.host.deleteReminder(reminder.id);
    expect((await harness.host.getReminders()).reminders).toHaveLength(0);
  });

  it("publishes a fresh snapshot to the shell whenever a record changes", async () => {
    const harness = await makeHost();
    const snapshots: number[] = [];
    harness.host.onBookmarks((snapshot) => snapshots.push(snapshot.bookmarks.length));
    await harness.host.addBookmark({ url: `${fixture.origin}/other.html`, title: "Other" });
    await settle(() => snapshots.includes(1));
    expect(snapshots).toContain(1);
  });

  it("finishes the walkthrough by writing what it gathered, not by pretending it ran", async () => {
    const harness = await makeHost();
    // With no settings record the walkthrough reads as done (§14): an account
    // that onboarded on a Mac is not asked again by a browser tab.
    expect((await harness.host.getSettings()).onboarding.completed).toBe(true);
    await harness.host.completeOnboarding({
      name: "Claudius",
      about: "Builds browsers",
      facts: [{ content: "Lives in Berlin", bucket: "location", kind: "static", label: "Home" }],
      favorites: [{ kind: "site", url: `${fixture.origin}/other.html`, title: "Other" }],
      spaceName: null,
      openWelcomeTabs: false,
    });
    const memory = await harness.host.getMemory();
    expect(memory.entries.map((entry) => entry.content)).toEqual(
      expect.arrayContaining(["Claudius", "Builds browsers", "Lives in Berlin"]),
    );
    expect((await harness.host.getSnapshot()).sidebar.favorites).toHaveLength(1);
    const settings = await harness.host.getSettings();
    expect(settings.onboarding.completedAt).not.toBeNull();
  });

  it("opens the welcome pages as documents of its own, at the addresses they are written at", async () => {
    const harness = await makeHost();
    await harness.host.completeOnboarding({
      name: "Claudius Meyer",
      about: "Builds browsers",
      facts: [],
      favorites: [],
      spaceName: null,
      openWelcomeTabs: true,
    });
    const snapshot = await harness.host.getSnapshot();
    // Four tabs, the overview active, each showing the `pistachio://` address
    // it IS rather than the `data:` document it was rendered into (§14).
    expect(snapshot.tabs.map((tab) => tab.url)).toEqual(WELCOME_TABS.map((tab) => tab.url));
    expect(snapshot.tabs.map((tab) => tab.title)).toEqual(WELCOME_TABS.map((tab) => tab.title));
    expect(snapshot.tabs.every((tab) => tab.kind === "human")).toBe(true);
    expect(snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId)?.url).toBe("pistachio://welcome/");

    const documents = harness.context.pages().filter((page) => page.url().startsWith("data:text/html"));
    expect(documents).toHaveLength(4);
  });

  it("greets the person by their first name on the welcome overview", async () => {
    const harness = await makeHost();
    await harness.host.completeOnboarding({
      name: "Claudius Meyer",
      about: "",
      facts: [],
      favorites: [],
      spaceName: null,
      openWelcomeTabs: true,
    });
    const overview = await welcomePage(harness, "Welcome to Pistachio");
    expect(await overview.textContent("h1")).toContain("Let's settle in, Claudius.");
    // The shortcut hints are the person's own bindings, drawn for a browser
    // rather than for a Mac's menu bar.
    expect(await overview.textContent("#shortcuts")).toContain("Ctrl");
  });

  it("follows a lesson link inside a welcome page without leaving the welcome set", async () => {
    const harness = await makeHost();
    await harness.host.completeOnboarding({
      name: "Claudius",
      about: "",
      facts: [],
      favorites: [],
      spaceName: null,
      openWelcomeTabs: true,
    });
    const active = must((await harness.host.getSnapshot()).activeTabId, "the active tab");
    const overview = await welcomePage(harness, "Welcome to Pistachio");
    // A `pistachio://` href cannot navigate a cloud tab — there is no such
    // protocol here — so the bridge reports the click and the host renders
    // the page it named into the same tab (§14).
    await overview.click(".basics .basic:first-child a");
    await settleIn(async () => {
      const tab = (await harness.host.getSnapshot()).tabs.find((entry) => entry.id === active);
      return tab?.url === "pistachio://learn/agent";
    });
    const tab = must((await harness.host.getSnapshot()).tabs.find((entry) => entry.id === active), "the welcome tab");
    expect(tab.url).toBe("pistachio://learn/agent");
    expect(tab.title).toBe("Hand work to the agent");
    expect(await overview.textContent("h1")).toBe("Hand work to the agent");
  });

  it("rebuilds the welcome tabs on restore instead of storing their documents", async () => {
    const harness = await makeHost();
    await harness.host.completeOnboarding({
      name: "Claudius",
      about: "",
      facts: [],
      favorites: [],
      spaceName: null,
      openWelcomeTabs: true,
    });
    const state = harness.host.sessionState();
    // Never the document: a `data:` welcome page in the sealed record is page
    // HTML in the workspace, which is exactly what the reader taught (§9).
    expect(state.tabs.map((tab) => tab.url)).toEqual(WELCOME_TABS.map((tab) => tab.url));
    expect(state.tabs.some((tab) => tab.url.startsWith("data:"))).toBe(false);

    const next = await makeHost();
    await next.host.restore(state);
    const snapshot = await next.host.getSnapshot();
    expect(snapshot.tabs.map((tab) => tab.url)).toEqual(WELCOME_TABS.map((tab) => tab.url));
    // The active one was opened, and it was RENDERED: the page behind it is
    // the welcome document, not a tab pointed at an address nothing serves.
    const rebuilt = await welcomePage(next, "Welcome to Pistachio");
    expect(rebuilt.url().startsWith("data:text/html")).toBe(true);
    expect(await rebuilt.textContent("h1")).toContain("Let's settle in");
  });

  it("hands a tab to another Space by writing it into that Space's own record", async () => {
    const harness = await makeHost();
    harness.workspace.putBrowserSession({
      version: 2,
      spaceId: "home",
      tabs: [],
      activeTabId: null,
      splitGroups: [],
      shelf: { favorites: [], entries: [] },
      zoom: {},
      permissions: {},
      updatedAt: 0,
    });
    await harness.host.createTab(pageUrl);
    const tabId = must((await harness.host.getSnapshot()).tabs[0]?.id, "the tab");
    await harness.host.moveTabToSpace(tabId, "home");
    expect((await harness.host.getSnapshot()).tabs).toHaveLength(0);
    const moved = must(harness.workspace.browserSession("home"), "the destination record");
    expect(moved.tabs.map((tab) => tab.url)).toEqual([pageUrl]);
    expect(moved.activeTabId).toBe(tabId);
  });

  it("refuses a hand-off to a Space this account does not have", async () => {
    const harness = await makeHost();
    await harness.host.createTab(pageUrl);
    const tabId = must((await harness.host.getSnapshot()).tabs[0]?.id, "the tab");
    await expect(harness.host.moveTabToSpace(tabId, "elsewhere")).rejects.toThrow(/not one of this account/u);
  });

  it("finishes the initial home document before accepting an address typed into the new tab", async () => {
    const harness = await makeHost();
    let navigation: Promise<void> | undefined;
    const off = harness.host.onSnapshot(snapshot => {
      const home = snapshot.tabs.find(tab => tab.url === "pistachio://home/");
      if (home && !navigation) navigation = harness.host.navigate(home.id, pageUrl);
    });
    await harness.host.createTab("pistachio://home");
    expect(navigation).toBeDefined();
    await navigation;
    off();
    expect((await harness.host.getSnapshot()).tabs.some(tab => tab.url === pageUrl)).toBe(true);
  });

  it("opens a second tab as readily as the first", async () => {
    const harness = await makeHost();
    await harness.host.createTab(pageUrl);
    await harness.host.createTab(articleUrl);
    const snapshot = await harness.host.getSnapshot();
    expect(snapshot.tabs.map((tab) => tab.url)).toEqual([pageUrl, articleUrl]);
  });

  /* ------------------------------ notes (§7) ------------------------------ */

  it("answers every note request out of the sealed workspace, as the person", async () => {
    // One tick per write, so "most recently edited first" is an order and not
    // a tie broken by whichever register happened to be made first.
    let clock = Date.parse("2026-09-23T10:00:00.000Z");
    const harness = await makeHost({ now: () => new Date((clock += 1000)) });
    const notes = (request: NoteRequest): Promise<NoteResponse> => harness.host.notes(request);

    const created = await notes({ type: "create", input: { title: "Pie crust", markdown: "# Pie crust\n\nFlour." } });
    const id = created.type === "note" ? created.note.id : "";
    expect(created).toMatchObject({ type: "note", note: { title: "Pie crust", revision: 1 } });
    // The person's own write, never a run's (docs/notes.md §7).
    expect(created.type === "note" ? created.note.source : null).toEqual({ kind: "user", runId: null });

    await notes({ type: "create", input: { title: "Groceries" } });
    const listed = await notes({ type: "list" });
    // Summaries, most recent first, and never the body.
    expect(listed.type === "list" ? listed.notes.map((note) => note.title) : []).toEqual(["Groceries", "Pie crust"]);
    expect(listed.type === "list" ? listed.notes[0] : {}).not.toHaveProperty("markdown");

    const searched = await notes({ type: "search", query: "crust" });
    expect(searched.type === "list" ? searched.notes.map((note) => note.id) : []).toEqual([id]);

    const updated = await notes({ type: "update", id, patch: { markdown: "# Pie crust\n\nButter." } });
    expect(updated).toMatchObject({ type: "note", note: { revision: 2 } });
    const read = await notes({ type: "get", id });
    expect(read.type === "maybeNote" ? read.note?.markdown : null).toContain("Butter");

    // Sharing is stage 2b: nothing is published from a worker, and the Share
    // menu is told so rather than shown a note as private that is not.
    await expect(notes({ type: "sharing", id })).resolves.toEqual({ type: "sharing", hosting: null });
    await expect(notes({ type: "setVisibility", id, visibility: "public" })).rejects.toThrow(/arrives later/u);

    await expect(notes({ type: "delete", id })).resolves.toEqual({ type: "deleted" });
    const after = await notes({ type: "list" });
    expect(after.type === "list" ? after.notes.map((note) => note.title) : []).toEqual(["Groceries"]);

    // The union is checked before the store sees it: a socket frame is nobody's friend.
    await expect(harness.host.notes({ type: "get", id: "not-an-id" })).rejects.toThrow(/note id/u);
    await expect(harness.host.notes({ type: "wat" })).rejects.toThrow(/unknown note request/u);
  });

  it("stores a note's picture by its bytes, inlines it into the export, and keeps the library quiet", async () => {
    const harness = await makeHost();
    const notes = (request: NoteRequest): Promise<NoteResponse> => harness.host.notes(request);
    const snapshots: NoteSnapshot[] = [];
    const off = harness.host.onNotes((snapshot) => snapshots.push(snapshot));
    onTestFinished(off);

    const created = await notes({ type: "create", input: { title: "Pie crust" } });
    const id = created.type === "note" ? created.note.id : "";
    // A write to the library is a change the shell must redraw for.
    expect(snapshots.at(-1)?.notes.map((note) => note.title)).toEqual(["Pie crust"]);
    const before = snapshots.length;

    const stored = await notes({ type: "putBlob", mediaType: "image/png", data: PIXEL_PNG });
    const blobId = stored.type === "blobId" ? stored.id : "";
    // Content-addressed: the same bytes twice are one register, written once (N3).
    expect(blobId).toMatch(/^[0-9a-f]{24}$/u);
    const again = await notes({ type: "putBlob", mediaType: "image/png", data: PIXEL_PNG });
    expect(again).toEqual({ type: "blobId", id: blobId });
    // And silent: a dropped picture must not re-serialise a 500-note library.
    expect(snapshots).toHaveLength(before);

    const fetched = await notes({ type: "getBlob", id: blobId });
    expect(fetched.type === "blob" ? fetched.blob : null).toMatchObject({ id: blobId, mediaType: "image/png", data: PIXEL_PNG });

    await notes({ type: "update", id, patch: { markdown: `Look:\n\n![a pixel](note-blob:${blobId})\n` } });
    const exported = await notes({ type: "exportHtml", id });
    const html = exported.type === "html" ? exported.html : "";
    // Self-contained: the bytes travel in the document, not as a register the
    // reader would have to hold a key for (N9).
    expect(html).toContain(`src="data:image/png;base64,${PIXEL_PNG}"`);
    expect(html).toContain("Pie crust");
    expect(html).not.toContain("note-blob:");

    await expect(harness.host.notes({ type: "exportHtml", id: "0123456789ab" })).rejects.toThrow(/no note/u);
  });

  it("sweeps a download's bytes and its record once the retention window is past", async () => {
    let clock = 1_000_000;
    const stateDir = await mkdtemp(join(tmpdir(), "pistachio-sweep-"));
    stateDirs.push(stateDir);
    const downloads = new SessionDownloads({ userId: USER, stateDir, now: () => clock });
    const reserved = await downloads.reserve("kept.txt");
    await (await import("node:fs/promises")).writeFile(reserved.path, FILE_BYTES);
    const record = downloads.adopt({
      tabId: "web:1",
      pageUrl: pageUrl,
      fileName: "kept.txt",
      path: reserved.path,
      bytes: Buffer.byteLength(FILE_BYTES),
    });
    expect(await readFile(reserved.path, "utf8")).toBe(FILE_BYTES);
    clock += 25 * 60 * 60 * 1000;
    downloads.sweep();
    expect(downloads.list()).toHaveLength(0);
    await settleIn(async () => (await readFile(reserved.path, "utf8").catch(() => null)) === null);
    expect(downloads.mint(record.id, VIEWER)).toBeNull();
  });
});
