import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SHIELDS, mergeShieldsPatch, type ShieldsSettings } from "@pistachio/shell-contracts/shields";

// The compile worker, run in-process: the same module, answering the same job.
vi.mock("electron", () => ({
  utilityProcess: {
    fork: () => {
      const listeners = new Map<string, (value: unknown) => void>();
      return {
        stderr: null,
        on: (event: string, listener: (value: unknown) => void) => listeners.set(event, listener),
        kill: () => undefined,
        postMessage: (job: import("../src/main/shields/compile-worker").CompileJob) => {
          void (async () => {
            const { readFileSync, writeFileSync, rmSync: remove } = await import("node:fs");
            const { compileEngines } = await import("../src/main/shields/compile");
            const read = (entries: typeof job.lists) => entries.map((entry) => ({ id: entry.id, trusted: entry.trusted, text: readFileSync(entry.path, "utf8") }));
            const output = compileEngines({
              lists: read(job.lists),
              dangerLists: read(job.dangerLists),
              customFilters: job.customFilters,
              resources: job.resourcesPath === null ? null : readFileSync(job.resourcesPath, "utf8"),
            });
            writeFileSync(job.enginePath, output.engine);
            if (output.danger === null) remove(job.dangerPath, { force: true });
            else writeFileSync(job.dangerPath, output.danger);
            listeners.get("message")?.({ ok: true, networkFilters: output.networkFilters, cosmeticFilters: output.cosmeticFilters, dangerFilters: output.dangerFilters, customErrors: output.customErrors });
          })();
        },
      };
    },
  },
}));

const { ShieldsService } = await import("../src/main/shields/service");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Handler = (details: Record<string, unknown>, callback: (response: Record<string, unknown>) => void) => void;

function fakeSession() {
  const listeners: Record<string, Handler | undefined> = {};
  let userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Pistachio/0.0.29 Chrome/150.0.7871.224 Electron/43.4.1 Safari/537.36";
  const register = (name: string) => (filter: unknown, listener?: Handler) => {
    listeners[name] = filter === null ? undefined : listener;
  };
  const session = {
    getUserAgent: () => userAgent,
    setUserAgent: (value: string) => {
      userAgent = value;
    },
    webRequest: {
      onBeforeRequest: register("request"),
      onBeforeSendHeaders: register("send"),
      onHeadersReceived: register("received"),
      onBeforeRedirect: register("redirect"),
    },
  } as unknown as Session;
  const fire = (name: string, details: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const listener = listeners[name];
      if (listener === undefined) resolve({});
      else if (name === "redirect") {
        // onBeforeRedirect is an event: no callback.
        listener(details, () => undefined);
        resolve({});
      } else listener(details, resolve);
    });
  return { session, fire, userAgent: () => userAgent };
}

function fakeContents(id: number, url = "https://news.example/", session?: Session) {
  const loaded: string[] = [];
  const contents = {
    id,
    session,
    setUserAgent: vi.fn(),
    getURL: () => url,
    isDestroyed: () => false,
    setWebRTCIPHandlingPolicy: vi.fn(),
    once: () => undefined,
    loadURL: (url: string) => {
      loaded.push(url);
      return Promise.resolve();
    },
  } as unknown as WebContents;
  return { contents, loaded };
}

async function setup(
  patch: Partial<ShieldsSettings> = {},
  topUrl = "https://news.example/",
  options: {
    fetch?: import("../src/main/shields/lists").FetchLike;
    offline?: boolean;
    seed?: (directory: string) => void;
    onPageChanged?: (contentsId: number) => void;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "pistachio-shields-service-"));
  dirs.push(directory);
  options.seed?.(directory);
  let settings = mergeShieldsPatch(DEFAULT_SHIELDS, { level: "custom", customFilters: "||ads.example.net^\n||cdn.news.example/track.js\n", ...patch });
  const service = new ShieldsService({
    directory,
    settings: () => settings,
    fetch: options.fetch ?? (() => Promise.reject(new Error("offline"))),
    workerPath: "unused",
    offline: options.offline ?? true,
    topUrlFor: () => topUrl,
    onPageChanged: options.onPageChanged ?? (() => undefined),
    webRtcFloor: () => "default",
  });
  await service.start();
  await vi.waitFor(() => expect(service.status().engine.state).toBe("ready"));
  const { session, fire, userAgent } = fakeSession();
  service.attachSession(session);
  const tab = fakeContents(7, "https://news.example/", session);
  service.attachContents(tab.contents);
  const update = (next: Partial<ShieldsSettings>) => {
    settings = mergeShieldsPatch(settings, next);
    service.applySettings(settings);
  };
  return { service, fire, tab, update, userAgent };
}

const page = (url: string, extra: Record<string, unknown> = {}) => ({ id: 1, url, method: "GET", resourceType: "mainFrame", webContentsId: 7, referrer: "", uploadData: [], ...extra });
const sub = (url: string, resourceType: string, extra: Record<string, unknown> = {}) => ({ id: 2, url, method: "GET", resourceType, webContentsId: 7, referrer: "https://news.example/", ...extra });

describe("the Shields service", () => {
  it("blocks third parties in Standard, the site's own requests only in Aggressive", async () => {
    const { fire, update, service } = await setup();
    await fire("request", page("https://news.example/"));
    expect(await fire("request", sub("https://ads.example.net/a.js", "script"))).toEqual({ cancel: true });
    expect(await fire("request", sub("https://cdn.news.example/track.js", "script"))).toEqual({});
    update({ blocking: "aggressive" });
    expect(await fire("request", sub("https://cdn.news.example/track.js", "script"))).toEqual({ cancel: true });
    expect(service.siteState(7, "https://news.example/").blocked).toBe(2);
    expect(service.status().stats.blocked).toBe(2);
  });

  it("cleans addresses and keeps the count on the page they lead to", async () => {
    const { fire, service } = await setup();
    expect(await fire("request", page("https://shop.example/item?id=1&gclid=x"))).toEqual({ redirectURL: "https://shop.example/item?id=1" });
    expect(await fire("request", page("https://shop.example/item?id=1"))).toEqual({});
    expect(service.siteState(7, "https://shop.example/item?id=1").cleaned).toBe(1);
    expect(await fire("request", page("https://l.facebook.com/l.php?u=https%3A%2F%2Fshop.example%2F"))).toEqual({ redirectURL: "https://shop.example/" });
  });

  it("upgrades to HTTPS and falls back when the site cannot answer", async () => {
    const { fire, tab, service } = await setup({ https: "upgrade" });
    expect(await fire("request", page("http://plain-site.com/a"))).toEqual({ redirectURL: "https://plain-site.com/a" });
    await fire("request", page("https://plain-site.com/a"));
    expect(service.navigationFailed(tab.contents, "https://plain-site.com/a", -202)).toBe(true);
    expect(tab.loaded).toEqual(["http://plain-site.com/a"]);
    // Remembered for the run: the fallback is not upgraded again.
    expect(await fire("request", page("http://plain-site.com/a"))).toEqual({});
    // A DNS failure is the network's, not the site's: no fallback.
    await fire("request", page("http://other-site.net/"));
    await fire("request", page("https://other-site.net/"));
    expect(service.navigationFailed(tab.contents, "https://other-site.net/", -105)).toBe(false);
  });

  it("does not bounce forever with a site that redirects HTTPS back to HTTP", async () => {
    const { fire } = await setup({ https: "upgrade" });
    expect(await fire("request", page("http://downgrade-site.org/"))).toEqual({ redirectURL: "https://downgrade-site.org/" });
    await fire("request", page("https://downgrade-site.org/"));
    await fire("received", { ...page("https://downgrade-site.org/"), statusCode: 301, responseHeaders: { Location: ["http://downgrade-site.org/"] } });
    await fire("redirect", { ...page("https://downgrade-site.org/"), redirectURL: "http://downgrade-site.org/", statusCode: 301 });
    expect(await fire("request", page("http://downgrade-site.org/"))).toEqual({});
  });

  it("warns first under HTTPS-Only, and lets the site through from the warning", async () => {
    const { fire, tab, service } = await setup({ https: "strict" });
    await fire("request", page("http://plain-site.com/"));
    await fire("request", page("https://plain-site.com/"));
    expect(service.navigationFailed(tab.contents, "https://plain-site.com/", -107)).toBe(true);
    const warning = new URL(tab.loaded[0] ?? "");
    expect(warning.href).toMatch(/^pistachio:\/\/shields\/insecure\?t=/);
    const html = await service.respond(warning)!.text();
    expect(html).toContain("plain-site.com doesn't support a secure connection");
    const proceed = await service.respond(new URL(`pistachio://shields/proceed?t=${warning.searchParams.get("t") ?? ""}`))!.text();
    expect(proceed).toContain('url=http://plain-site.com/');
    expect(await fire("request", page("http://plain-site.com/"))).toEqual({});
    // A spent or forged token answers nothing useful.
    expect(service.respond(new URL("pistachio://shields/proceed?t=forged"))!.status).toBe(410);
  });

  it("stands down on a site with an exception, except for GPC", async () => {
    const { fire, service } = await setup();
    service.setSite("https://www.news.example/", false);
    expect(await fire("request", sub("https://ads.example.net/a.js", "script"))).toEqual({});
    const sent = await fire("send", { ...sub("https://ads.example.net/a.js", "script"), requestHeaders: { Cookie: "a=1", Referer: "https://news.example/secret" } });
    expect(sent).toEqual({ requestHeaders: { Cookie: "a=1", Referer: "https://news.example/secret", "Sec-GPC": "1" } });
    expect(service.frameBootstrap("https://news.example/")?.protections).toMatchObject({ globalPrivacyControl: true, fingerprinting: "off" });
    expect(service.status().exceptions.map((exception) => exception.key)).toEqual(["news.example"]);
    service.setSite("shop.news.example", true);
    expect(service.status().exceptions).toEqual([]);
  });

  it("keeps cookies and full referrers from other sites", async () => {
    const { fire } = await setup({ crossSiteCookies: "all", referrer: "trim" });
    expect(
      await fire("send", { ...sub("https://widgets.other/w.js", "script"), requestHeaders: { Cookie: "id=1", Referer: "https://news.example/story/42" } }),
    ).toEqual({ requestHeaders: { Referer: "https://news.example/", "Sec-GPC": "1" } });
    // The page's own site keeps both.
    expect(await fire("send", { ...sub("https://img.news.example/a.png", "image"), requestHeaders: { Cookie: "id=1", Referer: "https://news.example/story/42" } })).toEqual({
      requestHeaders: { Cookie: "id=1", Referer: "https://news.example/story/42", "Sec-GPC": "1" },
    });
    const received = await fire("received", { ...sub("https://widgets.other/w.js", "script"), statusCode: 200, responseHeaders: { "Set-Cookie": ["id=2"], "Content-Type": ["text/javascript"] } });
    expect(received).toEqual({ responseHeaders: { "Content-Type": ["text/javascript"] } });
  });

  it("takes its handlers off the session while switched off, and puts them back", async () => {
    const { fire, update } = await setup();
    update({ enabled: false });
    // No listener at all: the request never makes the trip.
    expect(await fire("send", { ...sub("https://ads.example.net/a.js", "script"), requestHeaders: {} })).toEqual({});
    expect(await fire("request", sub("https://ads.example.net/a.js", "script"))).toEqual({});
    update({ enabled: true });
    // The engine was let go while off; the cached build comes back from disk.
    await vi.waitFor(async () => expect(await fire("request", sub("https://ads.example.net/a.js", "script"))).toEqual({ cancel: true }));
  });

  it("warns under HTTPS-Only when the site redirects HTTPS back to HTTP, instead of letting it through", async () => {
    const { fire, service } = await setup({ https: "strict" });
    await fire("request", page("http://downgrade-site.org/"));
    await fire("request", page("https://downgrade-site.org/"));
    await fire("received", { ...page("https://downgrade-site.org/"), statusCode: 301, responseHeaders: { Location: ["http://downgrade-site.org/"] } });
    await fire("redirect", { ...page("https://downgrade-site.org/"), redirectURL: "http://downgrade-site.org/", statusCode: 301 });
    const answer = await fire("request", page("http://downgrade-site.org/"));
    expect(String(answer["redirectURL"])).toMatch(/^pistachio:\/\/shields\/insecure\?t=/);
    const token = new URL(String(answer["redirectURL"])).searchParams.get("t") ?? "";
    expect(await service.respond(new URL(`pistachio://shields/insecure?t=${token}`))!.text()).toContain("downgrade-site.org");
    // Not remembered as HTTP-only without the person's say-so: the next visit is upgraded again.
    expect(await fire("request", page("http://downgrade-site.org/again"))).toEqual({ redirectURL: "https://downgrade-site.org/again" });
    // Continuing from the warning is what lets it through.
    await service.respond(new URL(`pistachio://shields/proceed?t=${token}`))!.text();
    expect(await fire("request", page("http://downgrade-site.org/"))).toEqual({});
  });

  it("fetches a list as soon as it is switched on, not at the next hourly check", async () => {
    const fetched: string[] = [];
    const fetch: import("../src/main/shields/lists").FetchLike = (url) => {
      fetched.push(url);
      return Promise.resolve(new Response("! Expires: 4 days\n||annoying.example^\n"));
    };
    const { update } = await setup({}, "https://news.example/", { fetch, offline: false });
    expect(fetched).toEqual([]);
    update({ lists: { ...DEFAULT_SHIELDS.lists, "fanboy-social": true } });
    await vi.waitFor(() => expect(fetched.some((url) => url.includes("fanboy-social"))).toBe(true));
  });

  it("keeps cross-site cookies off WebSocket handshakes too", async () => {
    const { fire } = await setup({ crossSiteCookies: "all" });
    expect(await fire("send", { ...sub("wss://chat.other/socket", "webSocket"), requestHeaders: { Cookie: "id=1" } })).toEqual({ requestHeaders: { "Sec-GPC": "1" } });
    expect(await fire("received", { ...sub("wss://chat.other/socket", "webSocket"), statusCode: 101, responseHeaders: { "Set-Cookie": ["id=2"] } })).toEqual({ responseHeaders: {} });
  });

  it("gives sites under a private suffix seeds of their own", async () => {
    const { service } = await setup();
    const alice = service.frameBootstrap("https://alice.github.io/")?.protections.seed;
    const bob = service.frameBootstrap("https://bob.github.io/")?.protections.seed;
    expect(alice).toBeDefined();
    expect(alice).not.toBe(bob);
  });

  it("lifts its WebRTC restriction on a site with Shields down, keeping the egress floor", async () => {
    const { service, tab, fire } = await setup({ webRtc: "proxied" }, "https://meet.example/");
    const policy = tab.contents.setWebRTCIPHandlingPolicy as unknown as { mock: { calls: string[][] } };
    expect(policy.mock.calls.at(-1)).toEqual(["disable_non_proxied_udp"]);
    service.setSite("meet.example", false);
    await fire("request", page("https://meet.example/call"));
    expect(policy.mock.calls.at(-1)).toEqual(["default"]);
    await fire("request", page("https://other.example/"));
    expect(policy.mock.calls.at(-1)).toEqual(["disable_non_proxied_udp"]);
  });

  it("never upgrades a form POST, which a fallback could only replay as a GET", async () => {
    const { fire } = await setup({ https: "upgrade" });
    expect(await fire("request", page("http://plain-site.com/submit", { method: "POST" }))).toEqual({});
    expect(await fire("request", page("http://plain-site.com/submit"))).toEqual({ redirectURL: "https://plain-site.com/submit" });
  });

  it("applies $removeparam filters to page addresses, not only to their requests", async () => {
    const { fire, service } = await setup({ customFilters: "||shop-site.com^$removeparam=tracking_id" });
    expect(await fire("request", page("https://shop-site.com/item?id=4&tracking_id=abc"))).toEqual({ redirectURL: "https://shop-site.com/item?id=4" });
    expect(await fire("request", page("https://shop-site.com/item?id=4"))).toEqual({});
    expect(service.siteState(7, "https://shop-site.com/item?id=4").cleaned).toBe(1);
  });

  it("runs the person's own scriptlets with every list switched off", async () => {
    const seed = (directory: string) => {
      const lists = join(directory, "lists");
      mkdirSync(lists, { recursive: true });
      const now = Date.now();
      writeFileSync(
        join(lists, "resources.json"),
        JSON.stringify({ scriptlets: [{ name: "shields-test.js", aliases: [], dependencies: [], body: "function shieldsTest(v = '') { window.__x = v; }" }], redirects: [] }),
      );
      writeFileSync(join(lists, "lists.json"), JSON.stringify({ resources: { fetchedAt: now, expiresAt: now + 86_400_000, period: 86_400_000, etag: null, lastModified: null, rules: 0, error: null } }));
    };
    const noLists = Object.fromEntries(Object.keys(DEFAULT_SHIELDS.lists).map((id) => [id, false])) as ShieldsSettings["lists"];
    const { service } = await setup({ lists: noLists, dangerousSites: false, customFilters: "news.example##+js(shields-test, ran)" }, "https://news.example/", { seed });
    expect(service.frameBootstrap("https://news.example/")?.scripts.join("")).toContain("shieldsTest");
  });

  it("does not let an automatic HTTP fallback outlive a switch to HTTPS-Only", async () => {
    const { fire, tab, service, update } = await setup({ https: "upgrade" });
    await fire("request", page("http://plain-site.com/"));
    await fire("request", page("https://plain-site.com/"));
    expect(service.navigationFailed(tab.contents, "https://plain-site.com/", -202)).toBe(true);
    expect(await fire("request", page("http://plain-site.com/"))).toEqual({});
    update({ https: "strict" });
    expect(await fire("request", page("http://plain-site.com/"))).toEqual({ redirectURL: "https://plain-site.com/" });
  });

  it("adds a $csp filter's policy to framed documents as well as pages", async () => {
    const { fire } = await setup({ customFilters: "||frame-site.com^$csp=script-src 'none'" });
    const framed = await fire("received", { ...sub("https://frame-site.com/embed", "subFrame"), statusCode: 200, responseHeaders: {} });
    expect(framed).toEqual({ responseHeaders: { "Content-Security-Policy": ["script-src 'none'"] } });
    const top = await fire("received", { ...page("https://frame-site.com/"), statusCode: 200, responseHeaders: {} });
    expect(top).toEqual({ responseHeaders: { "Content-Security-Policy": ["script-src 'none'"] } });
  });

  it("judges Standard's first-party leniency against the site being visited, not the requesting frame", async () => {
    const { fire } = await setup({ customFilters: "||ads.example.net^$script\n@@||ads.example.net^$subdocument" });
    await fire("request", page("https://news.example/"));
    const frame = { url: "https://ads.example.net/frame", top: { url: "https://news.example/" } };
    expect(await fire("request", sub("https://ads.example.net/frame", "subFrame", { frame: { url: "https://news.example/", top: { url: "https://news.example/" } } }))).toEqual({});
    expect(await fire("request", sub("https://ads.example.net/x.js", "script", { frame }))).toEqual({ cancel: true });
  });

  it("protects every frame of a page with the page's own seed and the page's exception", async () => {
    const { service } = await setup({ customFilters: "ads.example.net##.creative" });
    const page = service.frameBootstrap("https://news.example/");
    const frame = service.frameBootstrap("https://ads.example.net/frame", "https://news.example/");
    expect(frame?.protections.seed).toBe(page?.protections.seed);
    expect(frame?.styles).toContain(".creative");
    // A blank frame the page makes gets the protections and nothing else.
    expect(service.frameBootstrap("about:srcdoc", "https://news.example/")).toMatchObject({ styles: "", scripts: [], watchDom: false });
    expect(service.frameBootstrap("about:blank", "pistachio://home/")).toBeNull();
    service.setSite("news.example", false);
    expect(service.frameBootstrap("https://ads.example.net/frame", "https://news.example/")).toMatchObject({ styles: "", protections: { fingerprinting: "off" } });
    expect(service.cosmetics("https://ads.example.net/frame", { classes: ["creative"], ids: [], hrefs: [] }, "https://news.example/")).toBe("");
  });

  it("changes the user agent of tabs already open, not only the session's default", async () => {
    const { tab, update } = await setup();
    const setUserAgent = tab.contents.setUserAgent as unknown as { mock: { calls: string[][] } };
    update({ fingerprinting: "off" });
    expect(setUserAgent.mock.calls.at(-1)?.[0]).toContain("Electron/");
    update({ fingerprinting: "standard" });
    expect(setUserAgent.mock.calls.at(-1)?.[0]).toMatch(/Chrome\/150\.0\.0\.0 Safari/);
  });

  it("matches requests from about:blank and about:srcdoc frames in the site they inherit", async () => {
    const { fire } = await setup({ customFilters: "||tracker.example^$domain=news.example" });
    await fire("request", page("https://news.example/"));
    const srcdoc = { url: "about:srcdoc", parent: { url: "https://news.example/", parent: null }, top: { url: "https://news.example/" } };
    expect(await fire("request", sub("https://tracker.example/p.js", "script", { frame: srcdoc }))).toEqual({ cancel: true });
  });

  it("honors a site's exception for its service worker's requests", async () => {
    const { fire, service } = await setup();
    const worker = { id: 9, url: "https://ads.example.net/a.js", method: "GET", resourceType: "script", referrer: "https://news.example/sw.js" };
    expect(await fire("request", worker)).toEqual({ cancel: true });
    service.setSite("news.example", false);
    expect(await fire("request", worker)).toEqual({});
  });

  it("counts private suffixes as sites when filters ask about third parties", async () => {
    const { fire } = await setup({ customFilters: "||bob.github.io^$third-party" }, "https://alice.github.io/");
    await fire("request", page("https://alice.github.io/"));
    const frame = { url: "https://alice.github.io/", top: { url: "https://alice.github.io/" } };
    expect(await fire("request", sub("https://bob.github.io/track.js", "script", { frame }))).toEqual({ cancel: true });
  });

  it("gives blob: and data: frames the page's protections", async () => {
    const { service } = await setup();
    expect(service.frameBootstrap("blob:https://news.example/2c0b", "https://news.example/")).toMatchObject({ styles: "", protections: { fingerprinting: "standard" } });
    expect(service.frameBootstrap("data:text/html,x", "https://news.example/")).toMatchObject({ protections: { globalPrivacyControl: true } });
  });

  it("redraws the site controls of open pages when the settings or an exception change", async () => {
    const changed: number[] = [];
    const { update, service } = await setup({}, "https://news.example/", { onPageChanged: (id) => changed.push(id) });
    changed.length = 0;
    update({ enabled: false });
    await vi.waitFor(() => expect(changed).toContain(7));
    changed.length = 0;
    update({ enabled: true });
    service.setSite("news.example", false);
    await vi.waitFor(() => expect(changed).toContain(7));
  });

  it("refuses <a ping> but not beacons", async () => {
    const { fire } = await setup();
    expect(await fire("send", { ...sub("https://news.example/ping", "ping"), requestHeaders: { "Ping-To": "https://x.example/" } })).toEqual({ cancel: true });
    expect(await fire("send", { ...sub("https://news.example/beacon", "ping"), requestHeaders: { "Content-Type": "text/plain" } })).toEqual({
      requestHeaders: { "Content-Type": "text/plain", "Sec-GPC": "1" },
    });
  });

  it("hands the page its hiding rules and protections, and reports a plain Chrome user agent", async () => {
    const { service, update, userAgent } = await setup({ customFilters: "news.example##.promo\n##.ad-slot" });
    const boot = service.frameBootstrap("https://news.example/a");
    expect(boot?.styles).toContain(".promo");
    expect(boot?.watchDom).toBe(true);
    expect(boot?.protections.fingerprinting).toBe("standard");
    expect(service.cosmetics("https://news.example/a", { classes: ["ad-slot"], ids: [], hrefs: [] })).toContain(".ad-slot");
    expect(service.frameBootstrap("pistachio://home/")).toBeNull();
    expect(userAgent()).not.toContain("Electron");
    update({ fingerprinting: "off" });
    expect(userAgent()).toContain("Electron");
    // The same site gets the same seed for the run; another site another.
    expect(service.frameBootstrap("https://a.news.example/")?.protections.seed).toBe(boot?.protections.seed);
    expect(service.frameBootstrap("https://elsewhere.example/")?.protections.seed).not.toBe(boot?.protections.seed);
  });
});
