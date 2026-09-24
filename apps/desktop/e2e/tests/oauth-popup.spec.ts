import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/oauth-popup");
const OWNER_URL = "pistachio://demo/auth/relying-party";

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
  const existing = app.windows().find(predicate);
  if (existing !== undefined) return existing;
  return app.waitForEvent("window", { predicate });
}

async function pick(
  shell: Page,
  target: ReturnType<Page["locator"]>,
  item: string,
): Promise<void> {
  await target.click({ button: "right" });
  const menu = shell.getByTestId("context-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: item }).click();
  await expect(menu).toHaveCount(0);
}

async function delayedSessionServer(): Promise<{
  exchangeCount: () => number;
  origin: string;
  providerOrigin: string;
  servers: Server[];
}> {
  let exchanges = 0;
  let origin = "";
  const providerServer = createServer((request, response) => {
    if (
      new URL(request.url ?? "/", "http://127.0.0.1").pathname ===
      "/oauth/google"
    ) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html><head><title>Google OAuth</title><style>
          body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f8f9fa; color: #202124; font: 15px system-ui; }
          main { width: min(360px, calc(100vw - 48px)); padding: 36px; border: 1px solid #dadce0; border-radius: 18px; background: white; text-align: center; }
          button { border: 0; border-radius: 999px; padding: 12px 22px; background: #0b57d0; color: white; font: inherit; font-weight: 650; }
        </style></head><body data-opener="pending"><main>
          <h1>Choose an account</h1><p>Continue to X</p><button>Continue as Avery</button>
        </main><script>
          document.body.dataset.opener = window.opener ? "connected" : "isolated";
          document.querySelector("button").addEventListener("click", () => {
            const openerOrigin = new URLSearchParams(location.search).get("opener");
            if (openerOrigin) location.href = openerOrigin + "/oauth/callback";
          });
        </script></body></html>`);
      return;
    }
    response.writeHead(404).end();
  });
  const providerOrigin = await listenOnLoopback(providerServer);

  const relyingPartyServer = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/oauth/bootstrap") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Opening Google</title><script>
        location.replace("${providerOrigin}/oauth/google?opener=${encodeURIComponent(origin)}");
      </script>`);
      return;
    }
    if (path === "/oauth/callback") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Authentication complete</title><script>
        window.opener?.postMessage({ type: "google-oauth-result" }, location.origin);
        setTimeout(() => window.close(), 25);
      </script>`);
      return;
    }
    if (path === "/session" && request.method === "POST") {
      exchanges += 1;
      // X exchanges the Google result in the opener. Its Set-Cookie response can
      // arrive after the Google child has already closed.
      setTimeout(() => {
        response.writeHead(200, {
          "Content-Length": "0",
          "Set-Cookie": "x-session=connected; Path=/; HttpOnly; SameSite=Lax",
        });
        response.end();
      }, 250);
      return;
    }
    if (path === "/cookies") {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(request.headers.cookie ?? "");
      return;
    }
    if (path === "/logout/complete" && request.method === "POST") {
      response.writeHead(200, {
        "Content-Length": "0",
        "Set-Cookie": "x-session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      });
      response.end();
      return;
    }
    if (path === "/logout") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html><head><title>Log out of X</title><style>
          body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #000; color: #f2f2f2; font: 16px system-ui; }
          main { width: min(360px, calc(100vw - 48px)); padding: 38px; border: 1px solid #2f3336; border-radius: 20px; }
          button { width: 100%; border: 0; border-radius: 999px; padding: 13px 20px; background: white; color: #0f1419; font: inherit; font-weight: 700; }
          p { color: #8b98a5; }
        </style></head><body><main>
          <h1>Log out of X?</h1><p>You can always log back in at any time.</p><button>Log out</button>
        </main><script>
          document.querySelector("button").addEventListener("click", async () => {
            await fetch("/logout/complete", { method: "POST" });
            window.close();
          });
        </script></body></html>`);
      return;
    }

    const authenticated = (request.headers.cookie ?? "").includes(
      "x-session=connected",
    );
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html><head><title>X sign in</title><style>
        body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #000; color: #f2f2f2; font: 16px system-ui; }
        main { width: min(440px, calc(100vw - 48px)); padding: 44px; border: 1px solid #2f3336; border-radius: 20px; }
        button, a { display: block; width: 100%; box-sizing: border-box; border: 0; border-radius: 999px; padding: 13px 20px; background: white; color: #0f1419; font: inherit; font-weight: 700; text-align: center; text-decoration: none; }
        p { color: #8b98a5; }
      </style></head><body data-authenticated="${authenticated}"><main>
        <h1>${authenticated ? "Welcome to X" : "Sign in to X"}</h1>
        <p>${authenticated ? "Your Google session is connected." : "Use your Google account to continue."}</p>
        ${authenticated ? '<a href="/logout" target="_blank">Log out</a>' : "<button>Continue with Google</button>"}
      </main><script>
        document.querySelector("button")?.addEventListener("click", () => {
          window.open("/oauth/bootstrap", "x-google-oauth", "popup=yes,width=520,height=680");
        });
        window.addEventListener("message", (event) => {
          if (event.origin === location.origin && event.data?.type === "google-oauth-result") {
            void fetch("/session", { method: "POST" });
          }
        });
      </script></body></html>`);
  });
  origin = await listenOnLoopback(relyingPartyServer);
  return {
    exchangeCount: () => exchanges,
    origin,
    providerOrigin,
    servers: [providerServer, relyingPartyServer],
  };
}

async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

test("Google OAuth keeps popup semantics and refreshes same-Space relying-party tabs", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined)
    throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-oauth-popup-"));
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({
      layout: { mode: "sidebar", sidebar: "pinned" },
      general: { consoleOpenOnLaunch: false },
    }),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    await shell.evaluate(
      (url) =>
        (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(
          url,
        ),
      OWNER_URL,
    );
    const owner = await pageAt(app, (page) => page.url() === OWNER_URL);
    await expect(
      owner.getByRole("heading", { name: "Connected accounts" }),
    ).toBeVisible();
    const tabCount = await shell.evaluate(
      async () =>
        (
          await (
            window as unknown as { pistachio: PistachioApi }
          ).pistachio.getSnapshot()
        ).tabs.length,
    );

    // A favorite enables automatic Glance, so this proves auth links bypass it.
    const sidebar = shell.getByTestId("sidebar-chrome");
    const ownerTab = sidebar
      .getByTestId("sidebar-tab-list")
      .getByTestId("human-tab")
      .last();
    await pick(shell, ownerTab, "Add to favorites");
    await expect(sidebar.getByTestId("favorite-tile")).toHaveCount(1);

    // YouTube uses a target-blank/noopener handoff; its shared cookies must
    // refresh the original favorite even though postMessage is unavailable.
    await owner.getByRole("link", { name: "Sign in with Google" }).click();
    await expect(shell.getByTestId("glance-overlay")).toHaveCount(0);
    const youtubePopup = await pageAt(app, (page) =>
      page.url().includes("pistachio://accounts/oauth/google?flow=youtube"),
    );
    await expect(
      youtubePopup.getByRole("heading", { name: "Choose an account" }),
    ).toBeVisible();
    await expect(youtubePopup.locator("body")).toHaveAttribute(
      "data-opener",
      "isolated",
    );
    await youtubePopup.screenshot({
      path: join(screenshotDirectory, "01-youtube-google-popup.png"),
      fullPage: true,
    });
    expect(
      await shell.evaluate(
        async () =>
          (
            await (
              window as unknown as { pistachio: PistachioApi }
            ).pistachio.getSnapshot()
          ).tabs.length,
      ),
    ).toBe(tabCount);

    await youtubePopup
      .getByRole("button", { name: "Continue as Avery" })
      .click();
    await expect.poll(() => youtubePopup.isClosed()).toBe(true);
    await expect(owner.locator("#youtube-status")).toHaveText(
      "Connected with Google",
    );
    await expect(owner.locator("body")).toHaveAttribute(
      "data-youtube-authenticated",
      "true",
    );
    await owner.screenshot({
      path: join(screenshotDirectory, "02-youtube-owner-authenticated.png"),
      fullPage: true,
    });

    // X opens a named JavaScript popup; the real child context must retain
    // window.opener so its OAuth result can be posted directly to the opener.
    await owner.getByRole("button", { name: "Continue with Google" }).click();
    const xPopup = await pageAt(app, (page) =>
      page.url().includes("pistachio://accounts/oauth/google?flow=x"),
    );
    await expect(
      xPopup.getByRole("heading", { name: "Choose an account" }),
    ).toBeVisible();
    await expect(xPopup.locator("body")).toHaveAttribute(
      "data-opener",
      "connected",
    );
    await xPopup.screenshot({
      path: join(screenshotDirectory, "03-x-google-popup-with-opener.png"),
      fullPage: true,
    });
    expect(
      await shell.evaluate(
        async () =>
          (
            await (
              window as unknown as { pistachio: PistachioApi }
            ).pistachio.getSnapshot()
          ).tabs.length,
      ),
    ).toBe(tabCount);

    await xPopup.getByRole("button", { name: "Continue as Avery" }).click();
    await expect.poll(() => xPopup.isClosed()).toBe(true);
    await expect(owner.locator("#x-status")).toHaveText(
      "Connected with Google",
    );
    await expect(owner.locator("body")).toHaveAttribute(
      "data-x-authenticated",
      "true",
    );
    await expect(owner.locator("#youtube-status")).toHaveText(
      "Connected with Google",
    );
    await owner.screenshot({
      path: join(screenshotDirectory, "04-x-and-youtube-authenticated.png"),
      fullPage: true,
    });
  } finally {
    await app.close();
  }
});

test("X signs in and out through session-changing child windows without manual refresh", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined)
    throw new Error("No complete Electron runtime is installed.");
  const { exchangeCount, origin, providerOrigin, servers } =
    await delayedSessionServer();
  const userData = await mkdtemp(
    join(tmpdir(), "pistachio-oauth-delayed-session-"),
  );
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({
      layout: { mode: "sidebar", sidebar: "pinned" },
      general: { consoleOpenOnLaunch: false },
    }),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    const relyingPartyUrl = `${origin}/`;
    await shell.evaluate(
      (url) =>
        (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(
          url,
        ),
      relyingPartyUrl,
    );
    const owner = await pageAt(app, (page) => page.url() === relyingPartyUrl);
    await expect(
      owner.getByRole("heading", { name: "Sign in to X" }),
    ).toBeVisible();

    const existingWindows = new Set(app.windows());
    const popupPromise = app.waitForEvent("window", {
      predicate: (page) => !existingWindows.has(page),
    });
    await owner.getByRole("button", { name: "Continue with Google" }).click();
    const popup = await popupPromise;
    await popup.waitForURL(
      (url) =>
        url.origin === providerOrigin && url.pathname === "/oauth/google",
    );
    await expect(popup.locator("body")).toHaveAttribute(
      "data-opener",
      "connected",
    );
    await popup.getByRole("button", { name: "Continue as Avery" }).click();
    await expect.poll(() => popup.isClosed()).toBe(true);
    await expect.poll(exchangeCount).toBe(1);
    await expect
      .poll(() =>
        owner.evaluate(() =>
          fetch("/cookies").then((response) => response.text()),
        ),
      )
      .toContain("x-session=connected");

    // The opener does not update its own UI. Only the controller observing the
    // late relying-party cookie and reloading it can satisfy this assertion.
    await expect(owner.locator("body")).toHaveAttribute(
      "data-authenticated",
      "true",
    );
    await expect(
      owner.getByRole("heading", { name: "Welcome to X" }),
    ).toBeVisible();
    await owner.screenshot({
      path: join(screenshotDirectory, "05-x-delayed-session-complete.png"),
      fullPage: true,
    });

    // Logout must retain a child context too, so the original X document can
    // observe the inverse session transition instead of remaining stale.
    const tabCount = await shell.evaluate(
      async () =>
        (
          await (
            window as unknown as { pistachio: PistachioApi }
          ).pistachio.getSnapshot()
        ).tabs.length,
    );
    await owner.getByRole("link", { name: "Log out" }).click();
    const logoutPopup = await pageAt(
      app,
      (page) => page.url() === `${origin}/logout`,
    );
    await expect(
      logoutPopup.getByRole("heading", { name: "Log out of X?" }),
    ).toBeVisible();
    expect(
      await shell.evaluate(
        async () =>
          (
            await (
              window as unknown as { pistachio: PistachioApi }
            ).pistachio.getSnapshot()
          ).tabs.length,
      ),
    ).toBe(tabCount);
    await logoutPopup.screenshot({
      path: join(screenshotDirectory, "06-x-logout-confirmation.png"),
      fullPage: true,
    });
    await logoutPopup.getByRole("button", { name: "Log out" }).click();
    await expect.poll(() => logoutPopup.isClosed()).toBe(true);

    // No explicit reload is issued here; cookie removal must refresh the owner.
    await expect(owner.locator("body")).toHaveAttribute(
      "data-authenticated",
      "false",
    );
    await expect(
      owner.getByRole("heading", { name: "Sign in to X" }),
    ).toBeVisible();
    await owner.screenshot({
      path: join(screenshotDirectory, "07-x-logged-out-owner.png"),
      fullPage: true,
    });

    // A completed sign-out must not leave a terminal URL or stale observer that
    // reverses the next successful identity transition.
    const windowsAfterLogout = new Set(app.windows());
    const reloginPopupPromise = app.waitForEvent("window", {
      predicate: (page) => !windowsAfterLogout.has(page),
    });
    await owner.getByRole("button", { name: "Continue with Google" }).click();
    const reloginPopup = await reloginPopupPromise;
    await reloginPopup.waitForURL(
      (url) =>
        url.origin === providerOrigin && url.pathname === "/oauth/google",
    );
    await expect(reloginPopup.locator("body")).toHaveAttribute(
      "data-opener",
      "connected",
    );
    await reloginPopup
      .getByRole("button", { name: "Continue as Avery" })
      .click();
    await expect.poll(() => reloginPopup.isClosed()).toBe(true);
    await expect.poll(exchangeCount).toBe(2);
    await expect(owner.locator("body")).toHaveAttribute(
      "data-authenticated",
      "true",
    );
    await expect(
      owner.getByRole("heading", { name: "Welcome to X" }),
    ).toBeVisible();
    await owner.screenshot({
      path: join(screenshotDirectory, "08-x-relogin-complete.png"),
      fullPage: true,
    });
  } finally {
    await app.close();
    await Promise.all(servers.map(closeServer));
  }
});

test("an authentication popup offers to continue in the main app", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined)
    throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-oauth-popup-"));
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({
      layout: { mode: "sidebar", sidebar: "pinned" },
      general: { consoleOpenOnLaunch: false },
    }),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellPage(app);
    await shell.evaluate(
      (url) =>
        (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(
          url,
        ),
      OWNER_URL,
    );
    const owner = await pageAt(app, (page) => page.url() === OWNER_URL);
    await expect(
      owner.getByRole("heading", { name: "Connected accounts" }),
    ).toBeVisible();
    const tabUrls = async (): Promise<string[]> =>
      (
        await shell.evaluate(async () =>
          (
            await (
              window as unknown as { pistachio: PistachioApi }
            ).pistachio.getSnapshot()
          ).tabs.map((tab) => tab.url),
        )
      ).sort();
    const before = await tabUrls();

    await owner.getByRole("link", { name: "Sign in with Google" }).click();
    const popupUrl = "pistachio://accounts/oauth/google?flow=youtube";
    const popup = await pageAt(app, (page) => page.url() === popupUrl);
    await expect(
      popup.getByRole("heading", { name: "Choose an account" }),
    ).toBeVisible();
    const bar = await pageAt(app, (page) => page.url().startsWith("data:text/html"));
    const open = bar.getByRole("button", { name: "Open in Main App" });
    await expect(open).toBeVisible();

    // The bar sits above the page, which is pushed down rather than covered.
    const layout = await app.evaluate(({ BaseWindow }) => {
      const child = BaseWindow.getAllWindows().find(
        (candidate) => candidate.getParentWindow() !== null,
      );
      if (child === undefined) throw new Error("no popup window");
      return {
        content: child.getContentBounds(),
        views: child.contentView.children.map((view) => view.getBounds()),
      };
    });
    expect(layout.views).toHaveLength(2);
    const [pageBounds, barBounds] = layout.views.sort((a, b) => b.y - a.y);
    expect(barBounds).toEqual({
      x: 0,
      y: 0,
      width: layout.content.width,
      height: 36,
    });
    expect(pageBounds).toEqual({
      x: 0,
      y: 36,
      width: layout.content.width,
      height: layout.content.height - 36,
    });
    await bar.screenshot({
      path: join(screenshotDirectory, "08-popup-open-in-main-app-bar.png"),
    });

    await open.click();
    await expect.poll(() => popup.isClosed()).toBe(true);
    await expect.poll(tabUrls).toEqual([...before, popupUrl].sort());
  } finally {
    await app.close();
  }
});
