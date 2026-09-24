import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellPage } from "./windows";

const screenshotDirectory = join(
  process.cwd(),
  "e2e/screenshots/service-worker-session",
);

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(
      process.cwd(),
      "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron",
      suffix,
    ),
  ].find(
    (candidate) =>
      candidate !== undefined &&
      existsSync(candidate) &&
      existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

async function pageAt(
  app: ElectronApplication,
  predicate: (page: Page) => boolean,
): Promise<Page> {
  await expect
    .poll(() => app.windows().some(predicate), { timeout: 20_000 })
    .toBe(true);
  const page = app.windows().find(predicate);
  if (page === undefined) throw new Error("Expected browser page is unavailable");
  return page;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) =>
      error === undefined ? resolveClose() : rejectClose(error),
    ),
  );
}

test("a Service Worker can deliver a Blob-backed session request", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined)
    throw new Error("No complete Electron runtime is installed.");

  let deliveredLogouts = 0;
  const server = createServer((request, response) => {
    const path = new URL(
      request.url ?? "/",
      "http://localhost",
    ).pathname;
    if (path === "/sw.js") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/javascript; charset=utf-8",
      });
      response.end(`
        self.addEventListener("install", () => self.skipWaiting());
        self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
        self.addEventListener("fetch", (event) => {
          const url = new URL(event.request.url);
          if (url.pathname !== "/session-backed-logout" || event.request.method !== "POST") return;
          const networkRequest = event.request.clone();
          event.respondWith(Promise.resolve(new Response("", { status: 202 })));
          event.waitUntil(fetch(networkRequest));
        });
      `);
      return;
    }
    if (path === "/session-backed-logout" && request.method === "POST") {
      deliveredLogouts += 1;
      request.resume();
      response.writeHead(204).end();
      return;
    }
    if (path === "/logout-count") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ deliveredLogouts }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html><head><title>Service Worker session request</title><style>
        body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f1e8; color: #24221e; font: 16px system-ui; }
        main { width: min(440px, calc(100vw - 48px)); padding: 40px; border: 1px solid #d8d0c0; border-radius: 20px; background: #fffdf8; }
        button { border: 0; border-radius: 999px; padding: 12px 20px; background: #24221e; color: white; font: inherit; font-weight: 700; }
        output { display: block; margin-top: 18px; color: #655f54; }
      </style></head><body data-worker="starting" data-network-logouts="0"><main>
        <h1>Session transition</h1>
        <p>The Service Worker owns this request, matching X's logout path.</p>
        <button type="button">Log out</button>
        <output>Waiting</output>
      </main><script>
        const output = document.querySelector("output");
        async function pollDelivery() {
          const { deliveredLogouts } = await fetch("/logout-count").then((result) => result.json());
          document.body.dataset.networkLogouts = String(deliveredLogouts);
          if (deliveredLogouts > 0) {
            output.textContent = "Server session cleared";
            return;
          }
          setTimeout(() => void pollDelivery(), 25);
        }
        document.querySelector("button").addEventListener("click", async () => {
          const result = await fetch("/session-backed-logout", {
            method: "POST",
            body: new Blob(["logout"], { type: "application/json" }),
          });
          document.body.dataset.workerStatus = String(result.status);
          output.textContent = "Worker accepted; waiting for network";
          void pollDelivery();
        });
        void (async () => {
          await navigator.serviceWorker.register("/sw.js");
          await navigator.serviceWorker.ready;
          if (!navigator.serviceWorker.controller) {
            await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
          }
          document.body.dataset.worker = "controlled";
        })();
      </script></body></html>`);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address() as AddressInfo;
  const origin = `http://localhost:${address.port}`;
  const userData = await mkdtemp(
    join(tmpdir(), "pistachio-service-worker-session-"),
  );
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: {
      ...process.env,
      PISTACHIO_E2E: "1",
      PISTACHIO_USER_DATA: userData,
    },
  });

  try {
    const shell = await shellPage(app);
    await shell.waitForLoadState("domcontentloaded");
    await shell.evaluate(async (url) => {
      const api = (window as unknown as { pistachio: PistachioApi }).pistachio;
      const snapshot = await api.getSnapshot();
      if (snapshot.activeTabId === null) throw new Error("No active tab");
      await api.navigate(snapshot.activeTabId, url);
    }, origin);
    const page = await pageAt(app, (candidate) =>
      candidate.url().startsWith(origin),
    );

    // The page must be under Service Worker control before the regression path exists.
    await expect(page.locator("body")).toHaveAttribute(
      "data-worker",
      "controlled",
    );
    await mkdir(screenshotDirectory, { recursive: true });
    await page.screenshot({
      path: join(screenshotDirectory, "01-worker-controlled.png"),
      fullPage: true,
    });

    // A synthetic 202 is insufficient: the Blob-backed request must reach the server too.
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page.locator("body")).toHaveAttribute(
      "data-worker-status",
      "202",
    );
    await expect(page.locator("body")).toHaveAttribute(
      "data-network-logouts",
      "1",
    );
    expect(deliveredLogouts).toBe(1);
    await expect(page.getByText("Server session cleared")).toBeVisible();
    await page.screenshot({
      path: join(screenshotDirectory, "02-server-session-cleared.png"),
      fullPage: true,
    });
  } finally {
    await app.close();
    await closeServer(server);
  }
});
