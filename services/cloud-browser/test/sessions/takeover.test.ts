/**
 * What a takeover has to stop (docs/web-browser-design.md W7, §13 revision 6).
 *
 * Two halves of the same promise, both of which need a real page to prove:
 *
 *  - an agent action the person's takeover overtook must not land, even when
 *    it is already INSIDE the backend, awaiting a focus round trip;
 *  - a person navigating, moving through history, reloading or closing a tab
 *    the agent is driving IS a takeover — the fence moves through control's
 *    interrupt first, and the page changes only after it has.
 */

import type { BrowserContext } from "playwright-core";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTabInfo } from "@pistachio/agent-runtime";
import type { SpaceKeys } from "@pistachio/sync-protocol";
import { PlaywrightBrowserBackend } from "../../src/backend/playwright-backend.js";
import { installNetworkGuard } from "../../src/browser/guard.js";
import { SafeBrowserNetworkPolicy } from "../../src/browser/network-policy.js";
import { PlaywrightBrowserRuntime } from "../../src/browser/runtime.js";
import { ControlClient } from "../../src/control-client.js";
import { fencedBrowser, isControlLost, type ControlFence } from "../../src/runs/control-fence.js";
import { BrowserSession } from "../../src/sessions/browser-session.js";
import type { SessionSpace } from "../../src/sessions/shell-host.js";
import type { CloudBrowser } from "../../src/sync/session.js";
import { CHROMIUM, describeChromium } from "../helpers/chromium.js";
import { startFakeControl, type FakeControl } from "../helpers/fake-control.js";
import { must, settle, startFixture, type FixtureServer } from "../helpers/fixture-server.js";
import { testSpaceKeys, USER_A } from "../helpers/keys.js";

const SPACE = "work";
const TAKE_CONTROL = "__pistachioTestTakeControl";

/**
 * The page the agent types into. The person's takeover is dispatched from the
 * page itself, on the very focus the backend's type preparation performs: the
 * binding call travels the same CDP connection as the preparation's own
 * answer and is delivered first, so the fence has moved by the time the
 * backend comes back from its await — which is the window this is about, and
 * a wall-clock sleep would only approximate.
 */
const TYPE_HTML = `<!doctype html><html><head><title>Two fields</title></head><body>
<input id="field" name="field">
<input id="other" name="other">
<script>
  window.__armed = false;
  document.getElementById("field").addEventListener("focus", () => {
    if (!window.__armed) return;
    window.__armed = false;
    // The person takes control…
    void window.${TAKE_CONTROL}();
    // …and puts the caret in a field of their own. A task, so it happens
    // after the preparation script's own select() rather than under it.
    setTimeout(() => { document.getElementById("other").focus(); }, 0);
  });
</script>
</body></html>`;

const PAGE_HTML = `<!doctype html><html><head><title>Fixture</title></head><body><h1>fixture</h1></body></html>`;
const OTHER_HTML = `<!doctype html><html><head><title>Other</title></head><body><h1>other</h1></body></html>`;

const runtime = new PlaywrightBrowserRuntime({ executablePath: CHROMIUM ?? undefined, proxyMode: "direct" });
const contexts: BrowserContext[] = [];

const fixture: FixtureServer = await startFixture((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const body = path === "/type.html" ? TYPE_HTML : path === "/other.html" ? OTHER_HTML : PAGE_HTML;
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
});
const typeUrl = `${fixture.origin}/type.html`;
const pageUrl = `${fixture.origin}/page.html`;
const otherUrl = `${fixture.origin}/other.html`;

async function makeContext(): Promise<BrowserContext> {
  const browser = await runtime.browser();
  const context = await browser.newContext({
    serviceWorkers: "block",
    acceptDownloads: false,
    viewport: { width: 800, height: 600 },
  });
  contexts.push(context);
  return context;
}

async function makeBackend(context: BrowserContext): Promise<PlaywrightBrowserBackend> {
  const policy = new SafeBrowserNetworkPolicy({ allowedOrigins: [fixture.origin] });
  return PlaywrightBrowserBackend.attach({
    context,
    spaceId: SPACE,
    policy,
    installGuard: (page) => installNetworkGuard(page, { policy, gateway: () => null, credential: () => null }),
    settle: async () => undefined,
  });
}

afterAll(async () => {
  for (const context of contexts.splice(0)) await context.close().catch(() => undefined);
  await runtime.close();
  await fixture.close();
});

describeChromium("a takeover that lands while an agent action is inside the backend", () => {
  it("does not let the agent's keystrokes reach the field the person moved to", async () => {
    const context = await makeContext();
    const backend = await makeBackend(context);
    const fence: ControlFence = { holder: "agent", generation: 7 };
    let dropped = 0;
    await context.exposeBinding(TAKE_CONTROL, () => {
      fence.holder = "human";
      fence.generation += 1;
      return true;
    });
    const browser = fencedBrowser(backend, () => fence, () => {
      dropped += 1;
    });
    const tabId = await browser.openTab(typeUrl);
    const page = must(backend.pageFor(tabId), "the page");
    await page.evaluate("window.__armed = true");

    // The tool call is dispatched under the agent's fence and passes both of
    // the wrapper's checks. The takeover happens inside `type`, between the
    // focus preparation and the keystrokes.
    await expect(browser.type(tabId, "#field", "the agent's text")).rejects.toSatisfy(isControlLost);
    expect(dropped).toBe(1);
    expect(await page.inputValue("#other")).toBe("");
    expect(await page.inputValue("#field")).toBe("");
  }, 60_000);

  it("refuses a navigation the takeover overtook while the policy was still deciding", async () => {
    const context = await makeContext();
    const backend = await makeBackend(context);
    const fence: ControlFence = { holder: "agent", generation: 2 };
    const browser = fencedBrowser(backend, () => fence);
    const tabId = await browser.openTab(pageUrl);
    const page = must(backend.pageFor(tabId), "the page");
    // `navigate` awaits the network policy before Playwright is asked for
    // anything; a takeover there is the same window as the typing one.
    const inFlight = browser.navigate(tabId, otherUrl);
    fence.holder = "human";
    fence.generation = 3;
    await expect(inFlight).rejects.toSatisfy(isControlLost);
    expect(page.url()).toBe(pageUrl);
  }, 60_000);
});

/* ------------------------ navigation is a takeover ------------------------ */

let fake: FakeControl;
let control: ControlClient;
let keys: SpaceKeys;
let deviceId: string;
let session: BrowserSession;

/** A fake control plane and a claimed session, for the suites that need one. */
function useFakeControl(): void {
  beforeEach(async () => {
    fake = await startFakeControl();
    control = new ControlClient({ baseUrl: fake.baseUrl, serviceToken: fake.serviceToken });
    keys = await testSpaceKeys(SPACE);
    deviceId = fake.addWebDevice(USER_A).id;
  });

  afterEach(async () => {
    await session.close("shutdown").catch(() => undefined);
    await fake.close();
  });
}

/** A claimed session whose run has the wheel: the fence says `agent`. */
async function driveWithAgent(space: SessionSpace): Promise<{ runId: string }> {
  const row = fake.addBrowserSession({ userId: USER_A, spaceId: SPACE });
  const claimed = await control.claimSession(row.id, "worker-a", "http://10.0.0.7:8791");
  if ("refused" in claimed) throw new Error(`the fake refused the claim: ${claimed.refused}`);
  session = new BrowserSession({
    id: row.id,
    userId: USER_A,
    spaceId: SPACE,
    space,
    keys,
    leaseToken: claimed.leaseToken,
    controlClient: control,
    viewerDeviceId: deviceId,
  });
  const { runId } = await session.host.startCloudRun({ intent: "Fill the form" });
  // The run is claimed: control moves the fence to the agent in the same
  // transaction, and the worker adopts that generation (§8.1).
  const claimedRun = await control.claimRun("worker-a");
  session.setControl({ holder: "agent", generation: claimedRun?.session?.generation ?? 1 });
  expect(session.control).toEqual({ holder: "agent", generation: 1 });
  return { runId };
}

describeChromium("a person's page change on a tab the agent is driving", () => {
  useFakeControl();

  async function chromiumSpace(): Promise<{ space: SessionSpace; backend: PlaywrightBrowserBackend }> {
    const backend = await makeBackend(await makeContext());
    const listeners = new Set<() => void>();
    return {
      backend,
      space: {
        ready: Promise.resolve(),
        workspace: null,
        browser: {
          backend: backend as unknown as CloudBrowser,
          onTabsChanged: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      },
    };
  }

  it("takes control through control's interrupt before the page changes", async () => {
    const { space, backend } = await chromiumSpace();
    const { runId } = await driveWithAgent(space);
    await session.host.createTab(pageUrl);
    const tabId = must((await session.host.getSnapshot()).tabs[0], "the tab").id;

    await session.host.navigate(tabId, otherUrl);

    // The fence moved first, through the same path `takeControl` uses, so the
    // executor's turn is aborted and the agent's next tool call is stale.
    const kinds = fake.run(runId).events.map((event) => event.event.t);
    expect(kinds.filter((kind) => kind === "cmd.interrupt")).toHaveLength(1);
    expect(session.control).toEqual({ holder: "human", generation: 2 });
    // …and only then did the page change.
    expect(must(backend.listTabs()[0], "a backend tab").url).toBe(otherUrl);
    expect((await session.host.getSnapshot()).tabs[0]?.url).toBe(otherUrl);
  }, 60_000);

  it("takes control before closing a tab the agent is driving", async () => {
    const { space } = await chromiumSpace();
    const { runId } = await driveWithAgent(space);
    await session.host.createTab(pageUrl);
    const tabId = must((await session.host.getSnapshot()).tabs[0], "the tab").id;

    await session.host.closeTab(tabId);

    const kinds = fake.run(runId).events.map((event) => event.event.t);
    expect(kinds.filter((kind) => kind === "cmd.interrupt")).toHaveLength(1);
    expect(session.control).toEqual({ holder: "human", generation: 2 });
    expect((await session.host.getSnapshot()).tabs).toHaveLength(0);
  }, 60_000);

  it("goes back and reloads under the person's own fence", async () => {
    const { space } = await chromiumSpace();
    const { runId } = await driveWithAgent(space);
    await session.host.createTab(pageUrl);
    const tabId = must((await session.host.getSnapshot()).tabs[0], "the tab").id;
    await session.host.navigate(tabId, otherUrl);
    // The first navigation took control; the rest happen as the person.
    await session.host.goBack(tabId);
    await session.host.reload(tabId);
    expect((await session.host.getSnapshot()).tabs[0]?.url).toBe(pageUrl);
    const kinds = fake.run(runId).events.map((event) => event.event.t);
    expect(kinds.filter((kind) => kind === "cmd.interrupt")).toHaveLength(1);
  }, 60_000);
});

describe("the fence after the takeover's own awaits", () => {
  useFakeControl();

  /** A browser with no browser in it, which grabs the wheel back mid-wake. */
  function stubBackend(onOpen: () => void): CloudBrowser & { pages: Map<string, string> } {
    const pages = new Map<string, string>();
    let next = 0;
    const backend = {
      kind: "cloud" as const,
      pages,
      get activeTabId() {
        return [...pages.keys()][0] ?? null;
      },
      guardFor: () => null,
      listTabs: (): AgentTabInfo[] =>
        [...pages.entries()].map(([id, url]) => ({
          id,
          spaceId: SPACE,
          title: "",
          url,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          kind: "human" as const,
        })),
      openTab: async (url?: string) => {
        next += 1;
        const id = `cloud:${String(next)}`;
        pages.set(id, url ?? "about:blank");
        onOpen();
        return id;
      },
      closeTab: async (tabId: string) => {
        pages.delete(tabId);
      },
      focusTab: async () => undefined,
      navigate: async (tabId: string, url: string) => {
        pages.set(tabId, url);
      },
      back: async () => undefined,
      forward: async () => undefined,
      reload: async () => undefined,
    } as unknown as CloudBrowser & { pages: Map<string, string> };
    return backend;
  }

  it("refuses the page change when the agent took the wheel back during the wake", async () => {
    let armed = false;
    const backend = stubBackend(() => {
      if (!armed) return;
      armed = false;
      // Control handed the wheel back to a run between the person's takeover
      // and the navigation itself: the generation this call was authorised
      // under is gone.
      session.setControl({ holder: "agent", generation: 9 });
    });
    const listeners = new Set<() => void>();
    await driveWithAgent({
      ready: Promise.resolve(),
      workspace: null,
      browser: {
        backend,
        onTabsChanged: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    });
    await session.host.createTab("https://fixture.example/one");
    await session.host.createTab("https://fixture.example/two");
    const [first] = (await session.host.getSnapshot()).tabs;
    const tabId = must(first, "the first tab").id;
    // A sleeping tab is what puts an await between the takeover and the
    // mutation; the wake is the window.
    await session.host.suspendTab(tabId);
    await settle(() => backend.pages.size === 1);
    armed = true;

    await expect(session.host.navigate(tabId, "https://fixture.example/three")).rejects.toThrow(/took control/u);
    expect([...backend.pages.values()]).not.toContain("https://fixture.example/three");
  });
});
