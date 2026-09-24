import { BROWSER_BACKEND_FIXTURE_HTML, browserBackendContract } from "@pistachio/agent-runtime/testing";
import type { BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightBrowserBackend } from "../src/backend/playwright-backend.js";
import { installNetworkGuard } from "../src/browser/guard.js";
import { SafeBrowserNetworkPolicy } from "../src/browser/network-policy.js";
import { PlaywrightBrowserRuntime } from "../src/browser/runtime.js";
import { CHROMIUM, describeChromium } from "./helpers/chromium.js";
import { must, settle, startFixture, type FixtureServer } from "./helpers/fixture-server.js";

const runtime = new PlaywrightBrowserRuntime({ executablePath: CHROMIUM ?? undefined, proxyMode: "direct" });
const contexts: BrowserContext[] = [];
// The contract binds `fixtureUrl` at registration time, so the origin exists before any describe runs.
const fixture: FixtureServer = await startFixture((request, response) => {
  if (new URL(request.url ?? "/", "http://localhost").pathname === "/fixture.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(BROWSER_BACKEND_FIXTURE_HTML);
    return;
  }
  response.writeHead(404);
  response.end();
});
const fixtureUrl = `${fixture.origin}/fixture.html`;
// A second loopback origin the policy refuses: nothing the page does may reach it.
const blockedRequests: string[] = [];
const blockedOrigin: FixtureServer = await startFixture((request, response) => {
  blockedRequests.push(request.url ?? "");
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>Blocked</title><body>this page must never load</body>");
});

describe("Playwright browser runtime", () => {
  it("launches once for concurrent first callers", async () => {
    let launches = 0;
    let closes = 0;
    const browser = {
      close: () => {
        closes += 1;
        return Promise.resolve();
      },
      isConnected: () => true,
    } as unknown as Awaited<ReturnType<PlaywrightBrowserRuntime["browser"]>>;
    const fake = new PlaywrightBrowserRuntime({
      launch: async () => {
        launches += 1;
        await Promise.resolve();
        return browser;
      },
    });
    const [first, second] = await Promise.all([fake.browser(), fake.browser()]);
    expect(first).toBe(browser);
    expect(second).toBe(browser);
    expect(launches).toBe(1);
    await fake.close();
    expect(closes).toBe(1);
  });
});

describeChromium("PlaywrightBrowserBackend", () => {
  beforeAll(async () => {
    await runtime.browser();
  });

  afterAll(async () => {
    await Promise.all(contexts.splice(0).map((context) => context.close().catch(() => undefined)));
    await runtime.close();
    await fixture.close();
    await blockedOrigin.close();
  });

  const make = async (): Promise<PlaywrightBrowserBackend> => {
    const browser = await runtime.browser();
    const context = await browser.newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: false,
    });
    contexts.push(context);
    const policy = new SafeBrowserNetworkPolicy({ allowedOrigins: [fixture.origin] });
    return PlaywrightBrowserBackend.attach({
      context,
      spaceId: "work",
      policy,
      installGuard: (page) => installNetworkGuard(page, { policy, gateway: () => null, credential: () => null }),
      settle: async () => undefined,
    });
  };

  browserBackendContract("PlaywrightBrowserBackend", make, fixtureUrl);

  it("gives up on a tab whose guard never finishes installing, instead of holding the turn open", async () => {
    const context = await (await runtime.browser()).newContext();
    contexts.push(context);
    const policy = new SafeBrowserNetworkPolicy({ allowedOrigins: [fixture.origin] });
    const backend = await PlaywrightBrowserBackend.attach({
      context,
      spaceId: "work",
      policy,
      installGuard: () => new Promise(() => undefined),
      tabSetupTimeoutMs: 150,
      settle: async () => undefined,
    });
    await expect(backend.openTab(fixtureUrl)).rejects.toThrow(/did not finish within/);
    expect(backend.listTabs()).toHaveLength(0);
    // The unguarded page is closed rather than left where something could navigate it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(context.pages()).toHaveLength(0);
  });

  it("injects credential fields without returning or re-exposing their values", async () => {
    const backend = await make();
    const tabId = await backend.openTab(fixtureUrl);
    await expect(
      backend.fillCredentialFields(tabId, fixture.origin, [
        { target: "#query", value: "private@example.com" },
        { target: "#notes", value: "top-secret-value" },
      ]),
    ).resolves.toEqual({ status: "complete", attemptedCount: 2, clearedCount: 0 });
    const inspection = await backend.inspect(tabId);
    expect(inspection.controls.find((control) => control.selector === "#query")?.value).toBe("[secure value]");
    expect(inspection.controls.find((control) => control.selector === "#notes")?.value).toBe("[secure value]");
    expect(JSON.stringify(inspection)).not.toContain("private@example.com");
    expect(JSON.stringify(inspection)).not.toContain("top-secret-value");
    await expect(
      backend.fillCredentialFields(tabId, "https://wrong.example", [{ target: "#query", value: "must-not-leak" }]),
    ).rejects.toThrow("origin changed");
    await expect(
      backend.fillCredentialFields(tabId, fixture.origin, [{ target: "#missing", value: "must-not-leak" }]),
    ).rejects.not.toThrow("must-not-leak");
  });

  it("rejects unfocusable textbox roles before typing any secret", async () => {
    const backend = await make();
    const tabId = await backend.openTab(fixtureUrl);
    const page = backend.pageFor(tabId);
    expect(page).not.toBeNull();
    await page?.evaluate(() => {
      const trap = document.createElement("div");
      trap.id = "credential-trap";
      trap.setAttribute("role", "textbox");
      document.body.append(trap);
    });
    await expect(
      backend.fillCredentialFields(tabId, fixture.origin, [{ target: "#credential-trap", value: "never-type-this" }]),
    ).rejects.toThrow("safely editable");
    expect(await page?.evaluate(() => document.body.textContent)).not.toContain("never-type-this");
  });

  it("falls back to exact insertion when a control rejects shifted keystrokes", async () => {
    const backend = await make();
    const tabId = await backend.openTab(fixtureUrl);
    const page = backend.pageFor(tabId);
    expect(page).not.toBeNull();
    await page?.evaluate(() => {
      const input = document.createElement("input");
      input.id = "strict-password";
      input.type = "password";
      input.addEventListener("keydown", (event) => {
        if (event.shiftKey) event.preventDefault();
      });
      document.body.append(input);
    });
    const value = "Synthetic44$Synthetic44$";
    await expect(
      backend.fillCredentialFields(tabId, fixture.origin, [{ target: "#strict-password", value }]),
    ).resolves.toEqual({ status: "complete", attemptedCount: 1, clearedCount: 0 });
    expect(await page?.locator("#strict-password").inputValue()).toBe(value);
  });

  it("clears already-touched controls and reports a partial injection", async () => {
    const backend = await make();
    const tabId = await backend.openTab(fixtureUrl);
    const page = backend.pageFor(tabId);
    await page?.evaluate(() => {
      document.querySelector("#query")?.addEventListener("input", () => {
        document.querySelector("#notes")?.remove();
      }, { once: true });
    });
    await expect(
      backend.fillCredentialFields(tabId, fixture.origin, [
        { target: "#query", value: "clear-me" },
        { target: "#notes", value: "never-written" },
      ]),
    ).resolves.toEqual({
      status: "partial",
      attemptedCount: 1,
      clearedCount: 1,
      failureReason: "focus_failed",
    });
    expect(await page?.locator("#query").inputValue()).toBe("");
    expect((await backend.inspect(tabId)).controls.find((control) => control.selector === "#query")?.value).toBe("");
  });

  it("drops credential redactions when a new document loads in the tab", async () => {
    const backend = await make();
    const tabId = await backend.openTab(fixtureUrl);
    await backend.fillCredentialFields(tabId, fixture.origin, [{ target: "#query", value: "first-secret" }]);
    expect((await backend.inspect(tabId)).controls.find((control) => control.selector === "#query")?.value).toBe("[secure value]");
    await backend.navigate(tabId, `${fixtureUrl}?fresh-document`);
    await backend.type(tabId, "#query", "ordinary-visible-value");
    expect((await backend.inspect(tabId)).controls.find((control) => control.selector === "#query")?.value).toBe("ordinary-visible-value");
  });

  it("uses cloud:<uuid> tab ids, tracks history, and reports agent tabs of its Space", async () => {
    const backend = await make();
    const tabId = await backend.openTab(fixtureUrl);
    expect(tabId).toMatch(/^cloud:[0-9a-f-]{36}$/u);
    let tab = backend.listTabs().find((item) => item.id === tabId);
    expect(tab).toMatchObject({ spaceId: "work", kind: "agent", url: fixtureUrl, title: "Backend fixture", canGoBack: false, canGoForward: false });
    await backend.navigate(tabId, `${fixtureUrl}?second`);
    tab = backend.listTabs().find((item) => item.id === tabId);
    expect(tab?.canGoBack).toBe(true);
    await backend.back(tabId);
    tab = backend.listTabs().find((item) => item.id === tabId);
    expect(tab?.url).toBe(fixtureUrl);
    expect(tab?.canGoForward).toBe(true);
    await backend.forward(tabId);
    expect(backend.listTabs().find((item) => item.id === tabId)?.url).toBe(`${fixtureUrl}?second`);
    expect(backend.activeTabId).toBe(tabId);
    expect(backend.guardFor(tabId)?.session).toBeDefined();
    await expect(backend.navigate(tabId, "http://10.0.0.1/")).rejects.toThrow("blocks address");
    await backend.closeTab(tabId);
    expect(backend.listTabs()).toHaveLength(0);
  });

  it("routes window.open through the guarded popup path as a new tab", async () => {
    const backend = await make();
    const tabId = await backend.openTab(fixtureUrl);
    const page = backend.pageFor(tabId);
    if (page === null) throw new Error("no page");
    const opened = await page.evaluate(`window.open(${JSON.stringify(`${fixtureUrl}?popup`)}) === null`);
    expect(opened).toBe(true);
    await settle(() => backend.listTabs().some((tab) => tab.url === `${fixtureUrl}?popup`));
    const tabs = backend.listTabs();
    expect(tabs).toHaveLength(2);
    expect(tabs.every((tab) => tab.id.startsWith("cloud:"))).toBe(true);
    expect(backend.activeTabId).not.toBe(tabId);
    // A popup to a blocked address never opens.
    await page.evaluate(`window.open("http://10.0.0.1/")`);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(backend.listTabs()).toHaveLength(2);
  });

  it("routes a middle or modifier click through the guarded popup path before the new page can navigate", async () => {
    const backend = await make();
    const tabId = await backend.openTab(fixtureUrl);
    const page = backend.pageFor(tabId);
    if (page === null) throw new Error("no page");
    await page.evaluate(`(() => {
      const allowed = document.createElement("a");
      allowed.id = "aux-allowed";
      allowed.href = ${JSON.stringify(`${fixtureUrl}?aux`)};
      allowed.textContent = "allowed";
      const refused = document.createElement("a");
      refused.id = "aux-refused";
      refused.href = ${JSON.stringify(`${blockedOrigin.origin}/leak`)};
      refused.textContent = "refused";
      document.body.append(allowed, refused);
    })()`);

    await page.locator("#aux-allowed").click({ button: "middle" });
    await settle(() => backend.listTabs().some((tab) => tab.url === `${fixtureUrl}?aux`));
    const opened = must(backend.listTabs().find((tab) => tab.url === `${fixtureUrl}?aux`), "the popup tab");
    // Its own guard fetched the popup's first document: the page never
    // navigated behind the guard's back.
    expect(backend.guardFor(opened.id)?.stats.requestsAllowed).toBeGreaterThanOrEqual(1);

    const before = backend.listTabs().length;
    await page.locator("#aux-refused").click({ button: "middle" });
    await page.locator("#aux-refused").click({ modifiers: ["Shift"] });
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(backend.listTabs()).toHaveLength(before);
    expect(blockedRequests).toEqual([]);
  });
});
