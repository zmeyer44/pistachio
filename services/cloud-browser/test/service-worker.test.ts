import { afterAll, beforeAll, expect, it } from "vitest";
import { installNetworkGuard } from "../src/browser/guard.js";
import { SafeBrowserNetworkPolicy } from "../src/browser/network-policy.js";
import { PlaywrightBrowserRuntime } from "../src/browser/runtime.js";
import { CHROMIUM, describeChromium } from "./helpers/chromium.js";
import { startFixture, type FixtureServer } from "./helpers/fixture-server.js";

describeChromium("service worker block", () => {
  const runtime = new PlaywrightBrowserRuntime({ executablePath: CHROMIUM ?? undefined, proxyMode: "direct" });
  let origin: FixtureServer;
  let dataRequests = 0;

  beforeAll(async () => {
    origin = await startFixture((request, response) => {
      if (request.url === "/sw.js") {
        response.writeHead(200, { "content-type": "application/javascript" });
        response.end(`self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => event.respondWith(new Response('from-sw', { headers: { 'content-type': 'text/plain' } })));`);
        return;
      }
      if (request.url === "/data") {
        dataRequests += 1;
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("from-origin");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>sw</title><body>sw fixture</body>");
    });
    await runtime.browser();
  });

  afterAll(async () => {
    await runtime.close();
    await origin.close();
  });

  it("keeps a page's fetches on the network even when the page registers a service worker", async () => {
    const browser = await runtime.browser();
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, ignoreHTTPSErrors: false });
    try {
      const page = await context.newPage();
      const guard = await installNetworkGuard(page, {
        policy: new SafeBrowserNetworkPolicy({ allowedOrigins: [origin.origin] }),
        gateway: () => null,
        credential: () => null,
      });
      await page.goto(`${origin.origin}/`);
      const registration = await page.evaluate(`navigator.serviceWorker.register('/sw.js').then(() => 'registered', (error) => 'rejected: ' + error.message)`);
      // Whether the registration is refused outright or merely bypassed, no fetch reaches a worker.
      await page.waitForTimeout(300);
      const first = await page.evaluate(`fetch('/data').then((r) => r.text())`);
      expect(first).toBe("from-origin");
      await page.reload();
      const second = await page.evaluate(`fetch('/data').then((r) => r.text())`);
      expect(second).toBe("from-origin");
      const controller = await page.evaluate(`navigator.serviceWorker.controller === null`);
      expect(controller).toBe(true);
      expect(dataRequests).toBe(2);
      expect(typeof registration).toBe("string");
      expect(context.serviceWorkers()).toHaveLength(0);
      await guard.detach();
    } finally {
      await context.close();
    }
  });
});
