/**
 * A WebSocket handshake never reaches the CDP request guard: `Fetch`
 * interception does not see it, so `assertAllowed` cannot refuse it. With a
 * gateway the handshake is a CONNECT the gateway vets; without one the guard
 * has to stop the page from opening a socket at all (guard.ts).
 */

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { installNetworkGuard } from "../src/browser/guard.js";
import { SafeBrowserNetworkPolicy } from "../src/browser/network-policy.js";
import { PlaywrightBrowserRuntime } from "../src/browser/runtime.js";
import { CHROMIUM, describeChromium } from "./helpers/chromium.js";
import { settle, startFixture, type FixtureServer } from "./helpers/fixture-server.js";

describeChromium("websocket egress", () => {
  const runtime = new PlaywrightBrowserRuntime({ executablePath: CHROMIUM ?? undefined, proxyMode: "direct" });
  let origin: FixtureServer;
  let sockets: WebSocketServer;
  let socketUrl: string;
  let connections = 0;

  beforeAll(async () => {
    origin = await startFixture((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>ws</title><body>websocket fixture</body>");
    });
    sockets = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => sockets.on("listening", resolve));
    socketUrl = `ws://127.0.0.1:${String((sockets.address() as AddressInfo).port)}/socket`;
    sockets.on("connection", (socket) => {
      connections += 1;
      socket.close();
    });
    await runtime.browser();
  });

  afterAll(async () => {
    await runtime.close();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await origin.close();
  });

  /** `"opened"`, or the name of the error the page's `new WebSocket(...)` threw. */
  const attempt = `(() => new Promise((resolve) => {
    let socket;
    try {
      socket = new WebSocket(${JSON.stringify("SOCKET_URL")});
    } catch (error) {
      resolve(error.name);
      return;
    }
    socket.onopen = () => resolve("opened");
    socket.onerror = () => resolve("failed");
    setTimeout(() => resolve("timeout"), 3000);
  }))()`;

  it("refuses a page's WebSocket when no gateway vets the target, in every document of the page", async () => {
    const browser = await runtime.browser();
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, ignoreHTTPSErrors: false });
    try {
      const page = await context.newPage();
      const guard = await installNetworkGuard(page, {
        policy: new SafeBrowserNetworkPolicy({ allowedOrigins: [origin.origin] }),
        gateway: () => null,
        credential: () => null,
      });
      const script = attempt.replace("SOCKET_URL", socketUrl);
      // The document that is already there, the one loaded next, and a frame of it.
      expect(await page.evaluate(script)).toBe("SecurityError");
      await page.goto(`${origin.origin}/`);
      expect(await page.evaluate(script)).toBe("SecurityError");
      const framed = await page.evaluate(`(() => {
        const frame = document.createElement("iframe");
        document.body.append(frame);
        try {
          new frame.contentWindow.WebSocket(${JSON.stringify(socketUrl)});
          return "opened";
        } catch (error) {
          return error.name;
        }
      })()`);
      expect(framed).toBe("SecurityError");
      // An HTTP request the policy refuses is still refused by the request guard.
      await expect(page.goto("http://10.0.0.1/private")).rejects.toThrow();
      await settle(() => guard.stats.requestsBlocked >= 1);
      expect(connections).toBe(0);
      await guard.detach();
    } finally {
      await context.close();
    }
  });

  it("leaves the handshake to the gateway when the session has one", async () => {
    const browser = await runtime.browser();
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, ignoreHTTPSErrors: false });
    try {
      const page = await context.newPage();
      const guard = await installNetworkGuard(page, {
        policy: new SafeBrowserNetworkPolicy({ allowedOrigins: [origin.origin] }),
        gateway: () => ({ host: "127.0.0.1", port: 8443 }),
        credential: () => null,
      });
      await page.goto(`${origin.origin}/`);
      expect(await page.evaluate(attempt.replace("SOCKET_URL", socketUrl))).toBe("opened");
      expect(connections).toBe(1);
      await guard.detach();
    } finally {
      await context.close();
    }
  });
});
