import type { BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { installNetworkGuard, gatewayMatches, type GuardCredential, type PageNetworkGuard } from "../src/browser/guard.js";
import { SafeBrowserNetworkPolicy } from "../src/browser/network-policy.js";
import { PlaywrightBrowserRuntime } from "../src/browser/runtime.js";
import { CHROMIUM, describeChromium } from "./helpers/chromium.js";
import { settle, startFixture, type FixtureServer } from "./helpers/fixture-server.js";
import { AuthProxy, basicAuthorization } from "./helpers/proxy.js";
import { AssetBroker } from "../src/sessions/mirror/asset-broker.js";

describe("gateway matching", () => {
  it("compares host and port with default ports resolved", () => {
    expect(gatewayMatches("https://gw.example", { host: "gw.example", port: 443 })).toBe(true);
    expect(gatewayMatches("http://127.0.0.1:8443", { host: "127.0.0.1", port: 8443 })).toBe(true);
    expect(gatewayMatches("http://[::1]:8443", { host: "::1", port: 8443 })).toBe(true);
    expect(gatewayMatches("https://GW.EXAMPLE:443", { host: "gw.example", port: 443 })).toBe(true);
    expect(gatewayMatches("https://gw.example:8443", { host: "gw.example", port: 443 })).toBe(false);
    expect(gatewayMatches("https://other.example", { host: "gw.example", port: 443 })).toBe(false);
    expect(gatewayMatches("https://gw.example", null)).toBe(false);
    expect(gatewayMatches("not a url", { host: "gw.example", port: 443 })).toBe(false);
  });
});

describeChromium("proxy auth guard", () => {
  const runtime = new PlaywrightBrowserRuntime({ executablePath: CHROMIUM ?? undefined });
  let origin: FixtureServer;
  let proxy: AuthProxy;
  const originRequests: Array<{ path: string; authorization: string | null }> = [];
  const contexts: BrowserContext[] = [];

  beforeAll(async () => {
    origin = await startFixture((request, response) => {
      originRequests.push({ path: request.url ?? "", authorization: request.headers.authorization ?? null });
      if (request.url === "/mirror.svg") {
        response.writeHead(200, { "content-type": "image/svg+xml" });
        response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
        return;
      }
      if (request.url?.startsWith("/protected") === true) {
        if (request.headers.authorization === undefined) {
          response.writeHead(401, { "www-authenticate": 'Basic realm="origin"', "content-type": "text/plain" });
          response.end("origin login required");
          return;
        }
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("origin secret");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>fixture</title><body>hello through the proxy</body>");
    });
    proxy = new AuthProxy();
    await proxy.start();
    await runtime.browser();
  });

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((context) => context.close().catch(() => undefined)));
  });

  afterAll(async () => {
    await runtime.close();
    await proxy.close();
    await origin.close();
  });

  async function guardedPage(
    proxyPort: number,
    credential: () => GuardCredential | null,
    gatewayPort = proxyPort,
    onCredentialRejected?: () => void,
  ): Promise<{ page: Page; guard: PageNetworkGuard; context: BrowserContext }> {
    const browser = await runtime.browser();
    const context = await browser.newContext({
      proxy: { server: `http://127.0.0.1:${String(proxyPort)}`, bypass: "<-loopback>" },
      serviceWorkers: "block",
      acceptDownloads: false,
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: false,
    });
    contexts.push(context);
    const page = await context.newPage();
    const guard = await installNetworkGuard(page, {
      policy: new SafeBrowserNetworkPolicy({ allowedOrigins: [origin.origin] }),
      gateway: () => ({ host: "127.0.0.1", port: gatewayPort }),
      credential,
      ...(onCredentialRejected === undefined ? {} : { onCredentialRejected }),
    });
    return { page, guard, context };
  }

  it("serves captured mirror assets without bypassing or repeating authenticated egress", async () => {
    const credential = { username: "mirror-viewer", password: "mirror-proxy-secret" };
    proxy.setCredential(credential.username, credential.password);
    const { page } = await guardedPage(proxy.port, () => credential);
    const broker = new AssetBroker({ waitMs: 100 });
    broker.observe(page);
    await page.goto(origin.origin);
    await page.evaluate(url => new Promise<void>((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(); image.onerror = () => reject(new Error("asset failed"));
      image.src = url; document.body.append(image);
    }), `${origin.origin}/mirror.svg`);
    const scope = broker.scopeFor(page);
    const id = broker.assign(`${origin.origin}/mirror.svg`, "image", scope);
    const before = originRequests.filter(request => request.path === "/mirror.svg").length;
    expect(before).toBe(1);
    expect(proxy.records.some(record => record.accepted && record.target.endsWith("/mirror.svg"))).toBe(true);
    proxy.setCredential("rotated", "unavailable-to-the-page");
    const asset = await broker.bytesFor(id);
    expect(asset && asset !== "missing" && asset !== "pending" && new TextDecoder().decode(asset.bytes)).toContain("<svg");
    expect(originRequests.filter(request => request.path === "/mirror.svg")).toHaveLength(before);
    const missing = broker.assign("http://169.254.169.254/latest/meta-data/", "image", scope);
    expect(await broker.bytesFor(missing)).toBe("pending");
    expect(proxy.records.some(record => record.target.includes("169.254.169.254"))).toBe(false);
  });

  it("answers the gateway's 407 with the session's current credential, also after rotation, without recreating the context", async () => {
    const session = { current: { username: "pe1.user.dev.cred1.9999999999", password: "first-secret" } as GuardCredential | null };
    proxy.setCredential("pe1.user.dev.cred1.9999999999", "first-secret");
    const { page, guard } = await guardedPage(proxy.port, () => session.current);

    const first = await page.goto(`${origin.origin}/?first`);
    expect(first?.status()).toBe(200);
    expect(await page.textContent("body")).toContain("hello through the proxy");
    expect(proxy.records.some((record) => record.accepted && record.target.endsWith("/?first"))).toBe(true);
    expect(proxy.records.at(-1)?.proxyAuthorization).toBe(basicAuthorization("pe1.user.dev.cred1.9999999999", "first-secret"));
    expect(guard.stats.proxyChallengesAnswered).toBeGreaterThanOrEqual(1);
    expect(guard.stats.proxyChallengesCancelled).toBe(0);
    // The origin never saw the proxy credential.
    expect(originRequests.every((request) => request.authorization === null)).toBe(true);

    // Rotate: the gateway now accepts only the new credential; the session was told; same context, same page.
    session.current = { username: "pe1.user.dev.cred2.9999999999", password: "second-secret" };
    proxy.setCredential("pe1.user.dev.cred2.9999999999", "second-secret");
    const before = proxy.records.length;
    const second = await page.goto(`${origin.origin}/?second`);
    expect(second?.status()).toBe(200);
    const rotated = proxy.records.slice(before).filter((record) => record.target.endsWith("/?second"));
    expect(rotated.at(-1)?.accepted).toBe(true);
    expect(rotated.at(-1)?.proxyAuthorization).toBe(basicAuthorization("pe1.user.dev.cred2.9999999999", "second-secret"));
    expect(rotated.some((record) => record.proxyAuthorization === basicAuthorization("pe1.user.dev.cred2.9999999999", "second-secret"))).toBe(true);
    expect(guard.stats.credentialRejections).toBe(0);
    await guard.detach();
  });

  it("never hands the egress credential to an origin's 401 Basic challenge", async () => {
    const credential = { username: "pe1.user.dev.cred3.9999999999", password: "third-secret" };
    proxy.setCredential(credential.username, credential.password);
    const { page, guard } = await guardedPage(proxy.port, () => credential);
    const before = originRequests.length;
    const response = await page.goto(`${origin.origin}/protected`);
    expect(response?.status()).toBe(401);
    const protectedRequests = originRequests.slice(before).filter((request) => request.path.startsWith("/protected"));
    expect(protectedRequests.length).toBeGreaterThanOrEqual(1);
    expect(protectedRequests.every((request) => request.authorization === null)).toBe(true);
    await settle(() => guard.stats.serverChallengesCancelled >= 1);
    expect(guard.stats.serverChallengesCancelled).toBe(1);
    await guard.detach();
  });

  it("cancels a challenge from a proxy that is not the gateway", async () => {
    const other = new AuthProxy();
    await other.start();
    try {
      const credential = { username: "pe1.user.dev.cred4.9999999999", password: "fourth-secret" };
      other.setCredential(credential.username, credential.password);
      // The context talks to `other`, but the session's gateway is `proxy`: the challenge does not match.
      const { page, guard } = await guardedPage(other.port, () => credential, proxy.port);
      const response = await page.goto(`${origin.origin}/?foreign`).catch(() => null);
      expect(response?.status() ?? 407).toBe(407);
      expect(other.records.every((record) => record.proxyAuthorization === null)).toBe(true);
      await settle(() => guard.stats.proxyChallengesCancelled >= 1);
      expect(guard.stats.proxyChallengesAnswered).toBe(0);
      await guard.detach();
    } finally {
      await other.close();
    }
  });

  it("cancels the second consecutive gateway challenge for one request and asks for a fresh credential", async () => {
    const stale = { username: "pe1.user.dev.cred5.9999999999", password: "stale-secret" };
    const session = { current: stale as GuardCredential | null };
    proxy.setCredential("pe1.user.dev.cred6.9999999999", "fresh-secret");
    let rejections = 0;
    const onCredentialRejected = (): void => {
      rejections += 1;
      session.current = { username: "pe1.user.dev.cred6.9999999999", password: "fresh-secret" };
    };
    const { page, guard, context } = await guardedPage(proxy.port, () => session.current, proxy.port, onCredentialRejected);
    const response = await page.goto(`${origin.origin}/?stale`).catch(() => null);
    expect(response?.status() ?? 407).toBe(407);
    await settle(() => rejections >= 1);
    expect(guard.stats.credentialRejections).toBe(1);
    expect(guard.stats.proxyChallengesAnswered).toBe(1);
    expect(proxy.records.filter((record) => record.target.endsWith("/?stale")).every((record) => !record.accepted)).toBe(true);
    // The refreshed credential now succeeds on the same context (a fresh page: the cancelled
    // navigation is still settling on its error page).
    const next = await context.newPage();
    const nextGuard = await installNetworkGuard(next, {
      policy: new SafeBrowserNetworkPolicy({ allowedOrigins: [origin.origin] }),
      gateway: () => ({ host: "127.0.0.1", port: proxy.port }),
      credential: () => session.current,
    });
    const retry = await next.goto(`${origin.origin}/?fresh`);
    expect(retry?.status()).toBe(200);
    expect(proxy.records.at(-1)?.proxyAuthorization).toBe(basicAuthorization("pe1.user.dev.cred6.9999999999", "fresh-secret"));
    await nextGuard.detach();
    await guard.detach();
  });

  it("blocks requests the network policy refuses", async () => {
    const credential = { username: "pe1.user.dev.cred7.9999999999", password: "seven" };
    proxy.setCredential(credential.username, credential.password);
    const { page, guard } = await guardedPage(proxy.port, () => credential);
    await expect(page.goto("http://10.0.0.1/private")).rejects.toThrow();
    await settle(() => guard.stats.requestsBlocked >= 1);
    expect(proxy.records.some((record) => record.target.includes("10.0.0.1"))).toBe(false);
    await guard.detach();
  });
});
