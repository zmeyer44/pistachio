/**
 * The security regressions from the adversarial review, against a real
 * Chromium (docs/web-browser-design.md §11).
 *
 * Every one of these needs a page: a hostile frame calling the bridge, a
 * script reaching past a shim on the wrong object, a download starting in a
 * context nobody is keeping. A fake page would prove none of them.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { BrowserControlsSnapshot } from "@pistachio/shell-contracts/browser-controls";
import type { StreamFileRequest } from "@pistachio/shell-contracts/socket";
import { PlaywrightBrowserBackend } from "../../src/backend/playwright-backend.js";
import { installNetworkGuard } from "../../src/browser/guard.js";
import { SafeBrowserNetworkPolicy } from "../../src/browser/network-policy.js";
import { PlaywrightBrowserRuntime } from "../../src/browser/runtime.js";
import { SessionDownloads } from "../../src/sessions/downloads.js";
import { ShellHost, type ShellHostSpace } from "../../src/sessions/shell-host.js";
import { withViewer, type ViewerIdentity } from "../../src/sessions/viewer-context.js";
import { CHROMIUM, describeChromium } from "../helpers/chromium.js";
import { settle, startFixture, must, type FixtureServer } from "../helpers/fixture-server.js";

const SPACE = "work";
const SESSION = "88888888-8888-4888-8888-888888888888";
const USER = "99999999-9999-4999-8999-999999999999";

const ONE: ViewerIdentity = { id: "viewer-one", deviceId: "device-one", downloadKey: "key-one" };
const TWO: ViewerIdentity = { id: "viewer-two", deviceId: "device-two", downloadKey: "key-two" };

const HOST_HTML = `<!doctype html><html><head><title>Host page</title></head><body>
<p id="where">nothing</p>
<p id="proto">nothing</p>
<p id="notify">nothing</p>
<input id="file" type="file">
<script>
  window.askWhere = () => navigator.geolocation.getCurrentPosition(
    (position) => { document.getElementById("where").textContent = position.coords.latitude.toFixed(2); },
    (error) => { document.getElementById("where").textContent = "denied:" + error.code; },
  );
  // The gate must survive being reached round the instance. An own property
  // on navigator.geolocation is one line from being bypassed.
  window.askThroughPrototype = () => Geolocation.prototype.getCurrentPosition.call(
    navigator.geolocation,
    (position) => { document.getElementById("proto").textContent = position.coords.latitude.toFixed(2); },
    (error) => { document.getElementById("proto").textContent = "denied:" + error.code; },
  );
  window.askNotify = () => {
    // Deliberately NOT returned: the caller must not wait on the person.
    void Notification.requestPermission().then((answer) => {
      document.getElementById("notify").textContent = answer;
    });
  };
  // Anything a site could walk the window for and recognise as this browser.
  window.shellGlobals = () => Object.keys(globalThis).filter((name) => /pistachio/i.test(name)).join(",");
</script>
</body></html>`;

/** A page whose only job is to be a DIFFERENT origin inside an iframe. */
const FRAME_HTML = `<!doctype html><html><body><script>
  window.addEventListener("message", () => {
    navigator.geolocation.getCurrentPosition(
      (position) => { parent.postMessage("got:" + position.coords.latitude.toFixed(2), "*"); },
      (error) => { parent.postMessage("denied:" + error.code, "*"); },
    );
  });
</script></body></html>`;

const runtime = new PlaywrightBrowserRuntime({ executablePath: CHROMIUM ?? undefined, proxyMode: "direct" });
const contexts: BrowserContext[] = [];
const stateDirs: string[] = [];

const fixture: FixtureServer = await startFixture((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (path === "/host.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(HOST_HTML);
    return;
  }
  if (path === "/frame.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(FRAME_HTML);
    return;
  }
  if (path === "/other.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Other site</title><body>other</body>");
    return;
  }
  if (path === "/payload.bin") {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="payload.bin"',
    });
    response.end("some bytes\n");
    return;
  }
  response.writeHead(404);
  response.end();
});

/**
 * The same server under a second hostname is a second ORIGIN as far as the
 * web platform is concerned, which is all a hostile-frame test needs.
 */
const foreignOrigin = fixture.origin.replace("127.0.0.1", "localhost");
const hostUrl = `${fixture.origin}/host.html`;
const otherUrl = `${foreignOrigin}/other.html`;
const frameUrl = `${foreignOrigin}/frame.html`;

interface Harness {
  host: ShellHost;
  downloads: SessionDownloads;
  context: BrowserContext;
  backend: PlaywrightBrowserBackend;
  stream: { channel: string; payload: unknown }[];
}

async function makeBackend(): Promise<{ backend: PlaywrightBrowserBackend; context: BrowserContext; listeners: Set<() => void> }> {
  const browser = await runtime.browser();
  const context = await browser.newContext({
    serviceWorkers: "block",
    acceptDownloads: true,
    viewport: { width: 900, height: 600 },
  });
  contexts.push(context);
  const policy = new SafeBrowserNetworkPolicy({ allowedOrigins: [fixture.origin, foreignOrigin] });
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
  return { backend, context, listeners };
}

async function makeHost(): Promise<Harness> {
  const { backend, context, listeners } = await makeBackend();
  const stateDir = await mkdtemp(join(tmpdir(), "pistachio-security-"));
  stateDirs.push(stateDir);
  const downloads = new SessionDownloads({ userId: USER, stateDir });
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
    downloads,
  });
  const stream: { channel: string; payload: unknown }[] = [];
  withViewer(ONE, () => host.onFileRequest((payload) => stream.push({ channel: "one", payload })));
  withViewer(TWO, () => host.onFileRequest((payload) => stream.push({ channel: "two", payload })));
  return { host, downloads, context, backend, stream };
}

/** Poll an asynchronous condition, the way the capabilities suite does. */
async function settleIn(predicate: () => Promise<boolean>, turns = 200): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition did not settle within the turn budget");
}

function pageOf(harness: Harness): Page {
  const [tab] = harness.backend.listTabs();
  return must(harness.backend.pageFor(must(tab, "a tab").id), "the page");
}

beforeAll(() => undefined);

afterAll(async () => {
  for (const context of contexts) await context.close().catch(() => undefined);
  await runtime.close().catch(() => undefined);
  await fixture.close();
  for (const dir of stateDirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describeChromium("site permissions, under a hostile page", () => {
  it("a frame cannot choose the origin of a permission prompt", async () => {
    const harness = await makeHost();
    await harness.host.createTab(hostUrl);
    const page = pageOf(harness);
    const controls: BrowserControlsSnapshot[] = [];
    harness.host.onBrowserControlsChanged((snapshot) => controls.push(snapshot));

    // The person allows the page they are looking at, once and for all.
    await page.evaluate("window.askWhere()");
    await settle(() => controls.some((snapshot) => snapshot.pendingPermissions.length > 0));
    const prompt = must(controls.find((snapshot) => snapshot.pendingPermissions.length > 0)?.pendingPermissions[0], "the prompt");
    expect(prompt.origin).toBe(fixture.origin);
    const tabId = must((await harness.host.getSnapshot()).tabs[0]?.id, "the tab");
    await harness.host.setGeolocation(tabId, { latitude: 51.5, longitude: -0.12, accuracy: 20 });
    await harness.host.browserControl({ type: "resolvePermission", requestId: prompt.id, decision: "allow" });

    // Now a third-party frame asks. The binding is installed on EVERY frame's
    // window (that is what `page.exposeBinding` does), so an advertisement in
    // an iframe can call it as easily as the page can. The origin it is
    // answered for is the one Playwright resolved for THAT frame, never one
    // the caller supplied — so the site the person allowed is not the frame's
    // to speak for.
    controls.length = 0;
    await page.evaluate(
      `(async () => {
         const frame = document.createElement("iframe");
         frame.id = "third-party";
         frame.src = ${JSON.stringify(frameUrl)};
         const ready = new Promise((resolve) => { frame.onload = resolve; });
         document.body.appendChild(frame);
         await ready;
         window.__answer = "waiting";
         window.addEventListener("message", (event) => { window.__answer = String(event.data); }, { once: true });
         frame.contentWindow.postMessage("ask", "*");
       })()`,
    );
    // It gets a prompt of its OWN, named for its own origin — not a silent
    // yes off the parent's stored decision, which is what a stored "allow"
    // plus a payload-supplied origin used to produce.
    await settle(() => controls.some((snapshot) => snapshot.pendingPermissions.length > 0), { turns: 400 });
    const frameAsk = must(
      controls.find((snapshot) => snapshot.pendingPermissions.length > 0)?.pendingPermissions[0],
      "the frame's prompt",
    );
    expect(frameAsk.origin).toBe(foreignOrigin);
    expect(await page.evaluate("window.__answer")).toBe("waiting");

    // The person says no to the frame, and the site they DID allow keeps its
    // decision, untouched and unspent.
    await harness.host.browserControl({ type: "resolvePermission", requestId: frameAsk.id, decision: "block" });
    await settleIn(async () => String(await page.evaluate("window.__answer")).startsWith("denied"));
    expect(harness.host.sessionState().permissions).toEqual({
      [fixture.origin]: { geolocation: "allow" },
      [foreignOrigin]: { geolocation: "block" },
    });
  }, 60_000);

  it("a page cannot reach the granted capability round the shim", async () => {
    const harness = await makeHost();
    await harness.host.createTab(hostUrl);
    const page = pageOf(harness);
    const controls: BrowserControlsSnapshot[] = [];
    harness.host.onBrowserControlsChanged((snapshot) => controls.push(snapshot));
    await page.evaluate("window.askWhere()");
    await settle(() => controls.some((snapshot) => snapshot.pendingPermissions.length > 0));
    const prompt = must(controls.find((snapshot) => snapshot.pendingPermissions.length > 0)?.pendingPermissions[0], "the prompt");
    await harness.host.browserControl({ type: "resolvePermission", requestId: prompt.id, decision: "block" });

    // `Geolocation.prototype.getCurrentPosition.call(navigator.geolocation, …)`
    // used to walk straight past a gate installed on the instance.
    await page.evaluate("window.askThroughPrototype()");
    await settleIn(async () => ((await page.textContent("#proto")) ?? "").startsWith("denied"));
    expect(await page.textContent("#proto")).toMatch(/^denied:/u);
  }, 60_000);

  it("allow this time does not leave the site a grant to spend later", async () => {
    const harness = await makeHost();
    await harness.host.createTab(hostUrl);
    const page = pageOf(harness);
    const controls: BrowserControlsSnapshot[] = [];
    harness.host.onBrowserControlsChanged((snapshot) => controls.push(snapshot));
    await page.evaluate("window.askWhere()");
    await settle(() => controls.some((snapshot) => snapshot.pendingPermissions.length > 0));
    const prompt = must(controls.find((snapshot) => snapshot.pendingPermissions.length > 0)?.pendingPermissions[0], "the prompt");
    await harness.host.browserControl({ type: "resolvePermission", requestId: prompt.id, decision: "allow-once" });

    // Nothing durable was stored — Site Controls says `ask` — and the live
    // grant went with the call it was given for, rather than lasting the life
    // of the context with no revoke path.
    expect(harness.host.sessionState().permissions).toEqual({});
    const snapshot = await harness.host.getBrowserControls();
    expect(snapshot.permissions.geolocation.decision).toBe("ask");
    const state = await page.evaluate(
      `navigator.permissions.query({ name: "geolocation" }).then((status) => status.state)`,
    );
    expect(state).not.toBe("granted");
  }, 60_000);

  it("resetting one site's permissions leaves every other site's alone", async () => {
    const harness = await makeHost();
    await harness.host.createTab(hostUrl);
    const first = must((await harness.host.getSnapshot()).tabs[0]?.id, "the tab");
    await harness.host.browserControl({ type: "setPermission", permission: "geolocation", decision: "allow" });
    await harness.host.createTab(otherUrl);
    await harness.host.browserControl({ type: "setPermission", permission: "geolocation", decision: "allow" });
    expect(Object.keys(harness.host.sessionState().permissions).sort()).toEqual([fixture.origin, foreignOrigin].sort());

    // `clearPermissions()` is whole-context. Resetting site B used to revoke
    // site A's LIVE grant while leaving A's stored decision saying "allow".
    await harness.host.browserControl({ type: "clearPermissions" });
    expect(Object.keys(harness.host.sessionState().permissions)).toEqual([fixture.origin]);
    await harness.host.selectTab(first);
    const page = pageOf(harness);
    const state = await page.evaluate(
      `navigator.permissions.query({ name: "geolocation" }).then((status) => status.state)`,
    );
    expect(state).toBe("granted");
  }, 60_000);

  it("asks the person before a site may show notifications", async () => {
    const harness = await makeHost();
    await harness.host.createTab(hostUrl);
    const page = pageOf(harness);
    const controls: BrowserControlsSnapshot[] = [];
    harness.host.onBrowserControlsChanged((snapshot) => controls.push(snapshot));
    // `notifications` was in the bridge's report union and wrapped by nothing,
    // so the prompt the shell was written to show never appeared.
    await page.evaluate("window.askNotify()");
    await settle(() => controls.some((snapshot) => snapshot.pendingPermissions.length > 0));
    const prompt = must(controls.find((snapshot) => snapshot.pendingPermissions.length > 0)?.pendingPermissions[0], "the prompt");
    expect(prompt.permission).toBe("notifications");
    await harness.host.browserControl({ type: "resolvePermission", requestId: prompt.id, decision: "block" });
    await settleIn(async () => (await page.textContent("#notify")) === "denied");
  }, 60_000);
});

describeChromium("what a page can learn about the browser it is in", () => {
  it("does not answer to a fixed name every site can probe", async () => {
    const harness = await makeHost();
    await harness.host.createTab(hostUrl);
    const page = pageOf(harness);
    // `__pistachioShellReport` and `__pistachioShellBridge` were a fingerprint
    // ("this is a Pistachio worker") and a function to probe. The name is now
    // per session and hidden from enumeration.
    expect(await page.evaluate("typeof globalThis.__pistachioShellReport")).toBe("undefined");
    expect(await page.evaluate("typeof globalThis.__pistachioShellBridge")).toBe("undefined");
    // `__pistachioOpenGuardedPopup` is the network guard's, and predates this
    // review; what must not be there is a fixed name that answers.
    expect(await page.evaluate("window.shellGlobals()")).toBe("__pistachioOpenGuardedPopup");
  }, 60_000);
});

describeChromium("downloads in a context nobody is keeping", () => {
  it("are cancelled where they start rather than filling the worker's disk", async () => {
    // The Space's context is shared by its runs and its browser session, and
    // `acceptDownloads` is on for the session's sake. An ordinary hosted run —
    // no session, no host, nowhere to put bytes — must not accept a download a
    // hostile page an agent visits starts.
    const { backend } = await makeBackend();
    const tabId = await backend.openTab(hostUrl, { kind: "agent" });
    const page = must(backend.pageFor(tabId), "the page");
    const download = await Promise.all([
      page.waitForEvent("download"),
      page.evaluate(
        `(() => { const link = document.createElement("a"); link.href = "/payload.bin"; link.download = "payload.bin"; document.body.appendChild(link); link.click(); })()`,
      ),
    ]).then(([event]) => event);
    expect(await download.failure()).not.toBeNull();
    expect(backend.downloadsClaimed).toBe(false);
  }, 60_000);

  it("are kept once a session host claims the context, and cancelled again when it goes", async () => {
    const harness = await makeHost();
    expect(harness.backend.downloadsClaimed).toBe(true);
    harness.host.close();
    expect(harness.backend.downloadsClaimed).toBe(false);
  }, 60_000);
});

describeChromium("a page's file picker", () => {
  it("is answered by the viewer it was shown to, and by nobody else", async () => {
    const harness = await makeHost();
    harness.host.noteViewerActivity(ONE.id);
    await harness.host.createTab(hostUrl);
    const page = pageOf(harness);
    await page.click("#file");
    await settle(() => harness.stream.length > 0);
    // Addressed to the viewer that is driving; a second viewer never sees it,
    // so it cannot cancel an upload the first one is halfway through.
    expect(harness.stream.map((entry) => entry.channel)).toEqual(["one"]);
    const requestId = (harness.stream[0]?.payload as StreamFileRequest).requestId;

    await withViewer(TWO, () => harness.host.cancelFileRequest(requestId));
    expect(harness.host.pendingFileRequests()).toContain(requestId);
    await withViewer(ONE, () => harness.host.cancelFileRequest(requestId));
    expect(harness.host.pendingFileRequests()).not.toContain(requestId);
  }, 60_000);

  it("is released rather than left holding the page when the session closes", async () => {
    const harness = await makeHost();
    harness.host.noteViewerActivity(ONE.id);
    await harness.host.createTab(hostUrl);
    await pageOf(harness).click("#file");
    await settle(() => harness.host.pendingFileRequests().length > 0);
    // An unresolved `filechooser` is a tab that can never be typed into again.
    harness.host.close();
    expect(harness.host.pendingFileRequests()).toEqual([]);
  }, 60_000);
});
