import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { shellReady } from "./windows";
import { launchApp } from "./app";
import { capturePage, pageAt, pick } from "./pages-harness";

/**
 * Authentication popups and the session changes they make: Google OAuth
 * child windows (with and without an opener), relying parties that reload
 * or redirect themselves, a passkey request inside a popup, and a Service
 * Worker that carries a session request — all in one window, each on its
 * own tabs and its own fixture server.
 */

const OWNER_URL = "pistachio://demo/auth/relying-party";

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

interface SelfRedirectingRelyingParty {
  origin: string;
  providerOrigin: string;
  /** Every main-document and API request the relying party served, in order. */
  requests: () => string[];
  servers: Server[];
}

/**
 * A relying party shaped like Dribbble's Google Identity Services flow: the
 * provider popup posts a credential to the opener and closes itself; the
 * opener shows a submitting state, exchanges the credential over fetch, and
 * navigates itself to the `redirect_to` the exchange returns. The browser has
 * nothing to do after the popup closes — any reload it issues races the
 * page's own transition.
 */
async function selfRedirectingRelyingParty(options: {
  exchangeDelayMs: number;
  /** How long the signed-in home page takes to render, like a real server. */
  homeDelayMs: number;
  /** Rewrite a JS-visible analytics cookie on the sign-in page when the popup opens. */
  analyticsCookieChurn: boolean;
}): Promise<SelfRedirectingRelyingParty> {
  const requests: string[] = [];
  let origin = "";

  const providerServer = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/gsi/select") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html><head><title>Choose an account</title></head>
        <body data-opener="pending"><main>
          <h1>Choose an account</h1><button>Continue as Avery</button>
        </main><script>
          document.body.dataset.opener = window.opener ? "connected" : "isolated";
          document.querySelector("button").addEventListener("click", () => {
            window.opener.postMessage({ type: "credential", credential: "jwt" }, "*");
            window.close();
          });
        </script></body></html>`);
      return;
    }
    response.writeHead(404).end();
  });
  const providerOrigin = await listenOnLoopback(providerServer);

  const relyingPartyServer = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const authenticated = (request.headers.cookie ?? "").includes(
      "rp-session=connected",
    );
    requests.push(`${request.method} ${path}${authenticated ? " [authenticated]" : ""}`);
    if (path === "/auth/jwt" && request.method === "POST") {
      setTimeout(() => {
        response.writeHead(202, {
          "Content-Type": "application/json",
          "Set-Cookie": "rp-session=connected; Path=/; HttpOnly; SameSite=Lax",
        });
        response.end(JSON.stringify({ redirect_to: "/" }));
      }, options.exchangeDelayMs);
      return;
    }
    if (path === "/") {
      if (!authenticated) {
        response.writeHead(302, { Location: "/session/new" }).end();
        return;
      }
      setTimeout(() => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html><head><title>Home</title></head>
          <body data-authenticated="true"><h1>Welcome home</h1></body></html>`);
      }, options.homeDelayMs);
      return;
    }
    if (path === "/session/new") {
      if (authenticated) {
        response.writeHead(302, { Location: "/" }).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html><head><title>Sign in</title></head>
        <body data-authenticated="false" data-state="idle"><main>
          <h1>Sign in</h1>
          <button>Continue with Google</button>
        </main><script>
          document.querySelector("button").addEventListener("click", () => {
            window.open(
              "${providerOrigin}/gsi/select",
              "gsi_popup",
              "toolbar=no,location=no,status=no,menubar=no,popup=yes,width=500,height=600",
            );
            ${
              options.analyticsCookieChurn
                ? 'setTimeout(() => { document.cookie = "_ga_session=" + Date.now() + "; Path=/; SameSite=Lax"; }, 300);'
                : ""
            }
          });
          window.addEventListener("message", async (event) => {
            if (event.data?.type !== "credential") return;
            document.body.dataset.state = "submitting";
            const response = await fetch("/auth/jwt", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ credential: event.data.credential }),
            });
            if (response.status !== 202) {
              document.body.dataset.state = "error";
              return;
            }
            const { redirect_to } = await response.json();
            window.location.href = redirect_to;
          });
        </script></body></html>`);
      return;
    }
    response.writeHead(404).end();
  });
  origin = await listenOnLoopback(relyingPartyServer);
  return {
    origin,
    providerOrigin,
    requests: () => requests,
    servers: [providerServer, relyingPartyServer],
  };
}

/**
 * Sign in to a self-redirecting relying party at `origin` (its own server's
 * address, or the same server by another host name) through its Google
 * popup, and see the page's own navigation land. Answers the page and when
 * the popup closed: whether the browser reloads it late is judged after.
 */
async function signInThroughPopup(
  app: ElectronApplication,
  shell: Page,
  origin: string,
  relyingParty: SelfRedirectingRelyingParty,
): Promise<{ owner: Page; closedAt: number }> {
  const signInUrl = `${origin}/session/new`;
  await shell.evaluate(
    (url) =>
      (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(url),
    signInUrl,
  );
  const owner = await pageAt(app, signInUrl);
  await expect(owner.getByRole("heading", { name: "Sign in" })).toBeVisible();

  const windowsBefore = new Set(app.windows());
  const popupPromise = app.waitForEvent("window", {
    predicate: (page) =>
      !windowsBefore.has(page) && page.url().startsWith(relyingParty.providerOrigin),
  });
  await owner.getByRole("button", { name: "Continue with Google" }).click();
  const popup = await popupPromise;
  await expect(popup.locator("body")).toHaveAttribute("data-opener", "connected");
  await popup.getByRole("button", { name: "Continue as Avery" }).click();
  await expect.poll(() => popup.isClosed()).toBe(true);
  const closedAt = Date.now();

  // The page's own navigation must win: it lands on the signed-in home page
  // and never sits in its submitting state or on a re-served sign-in page.
  await expect(owner.getByRole("heading", { name: "Welcome home" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(owner.locator("body")).toHaveAttribute("data-authenticated", "true");
  expect(new URL(owner.url()).pathname).toBe("/");
  await owner.evaluate(() => {
    (window as unknown as { __landed: boolean }).__landed = true;
  });
  return { owner, closedAt };
}

test.describe.serial("authentication popups", { tag: ["@site", "@popup"] }, () => {
  test.describe.configure({ timeout: 45_000 });
  let app: ElectronApplication;
  let shell: Page;
  const servers: Server[] = [];

  test.beforeAll(async () => {
    ({ app } = await launchApp({
      settings: {
        layout: { sidebar: "pinned" },
        general: { consoleOpenOnLaunch: false },
      },
      name: "oauth-popup",
    }));
    shell = await shellReady(app);
  });

  test.afterAll(async () => {
    await app?.close();
    await Promise.all(servers.map(closeServer));
  });

  test("Google OAuth keeps popup semantics and refreshes same-Profile relying-party tabs", async () => {
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
    await capturePage(youtubePopup, "oauth-popup/01-youtube-google-popup.png", { fullPage: true });
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
    await capturePage(owner, "oauth-popup/02-youtube-owner-authenticated.png", { fullPage: true });

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
    await capturePage(xPopup, "oauth-popup/03-x-google-popup-with-opener.png", { fullPage: true });
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
    await capturePage(owner, "oauth-popup/04-x-and-youtube-authenticated.png", { fullPage: true });
  });

  test("X signs in and out through session-changing child windows without manual refresh", async () => {
    const { exchangeCount, origin, providerOrigin, servers: fixture } =
      await delayedSessionServer();
    servers.push(...fixture);
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
    await capturePage(owner, "oauth-popup/05-x-delayed-session-complete.png", { fullPage: true });

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
    await capturePage(logoutPopup, "oauth-popup/06-x-logout-confirmation.png", { fullPage: true });
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
    await capturePage(owner, "oauth-popup/07-x-logged-out-owner.png", { fullPage: true });

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
    await capturePage(owner, "oauth-popup/08-x-relogin-complete.png", { fullPage: true });
  });

  test("an authentication popup offers to continue in the main app", async () => {
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
    await capturePage(bar, "oauth-popup/08-popup-open-in-main-app-bar.png");

    await open.click();
    await expect.poll(() => popup.isClosed()).toBe(true);
    await expect.poll(tabUrls).toEqual([...before, popupUrl].sort());
  });

  // A page that redirects itself once its popup closes must not be reloaded
  // out from under it — with a quiet sign-in page, and with one rewriting an
  // analytics cookie mid-exchange. The two run on two host names (cookies
  // are kept per host), and are judged together once both have had the
  // time a late reload would take (the browser's settle window is 5 s).
  test("a relying party that redirects itself after a Google popup is not reloaded out from under it, cookie churn or not", async () => {
    const quiet = await selfRedirectingRelyingParty({
      exchangeDelayMs: 400,
      homeDelayMs: 1_000,
      analyticsCookieChurn: false,
    });
    const churning = await selfRedirectingRelyingParty({
      exchangeDelayMs: 1_200,
      homeDelayMs: 1_000,
      analyticsCookieChurn: true,
    });
    servers.push(...quiet.servers, ...churning.servers);
    const first = await signInThroughPopup(app, shell, quiet.origin, quiet);
    const second = await signInThroughPopup(app, shell, churning.origin.replace("127.0.0.1", "localhost"), churning);

    // Give the browser every chance to issue a late reload before judging.
    await shell.waitForTimeout(Math.max(0, Math.max(first.closedAt, second.closedAt) + 6_500 - Date.now()));
    for (const [{ owner }, relyingParty, name] of [
      [first, quiet, "01-self-redirect"],
      [second, churning, "02-cookie-churn"],
    ] as const) {
      expect(
        await owner.evaluate(() => (window as unknown as { __landed?: boolean }).__landed),
      ).toBe(true);
      await capturePage(owner, `oauth-popup-self-redirect/${name}-home.png`, { fullPage: true });
      // One sign-in page, one exchange, one home load — the page's own — and
      // no reload re-serving either document.
      expect(relyingParty.requests()).toEqual([
        "GET /session/new",
        "POST /auth/jwt",
        "GET / [authenticated]",
      ]);
    }
  });

  test("a Service Worker can deliver a Blob-backed session request", async () => {
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
    servers.push(server);
    await shell.evaluate(
      (url) => (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(url),
      origin,
    );
    const page = await pageAt(app, (candidate) => candidate.url().startsWith(origin));

    // The page must be under Service Worker control before the regression path exists.
    await expect(page.locator("body")).toHaveAttribute(
      "data-worker",
      "controlled",
    );
    await capturePage(page, "service-worker-session/01-worker-controlled.png", { fullPage: true });

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
    await capturePage(page, "service-worker-session/02-server-session-cleared.png", { fullPage: true });
  });

  test("a sign-in popup completes and cancels discoverable passkey requests", async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        request.url === "/"
          ? `<!doctype html><title>Passkey relying party</title>
        <h1>Sign in</h1><button onclick="window.open('${origin}/oauth/passkey', 'sign-in', 'width=520,height=600')">Sign in with passkey</button>`
          : `<!doctype html><title>Passkey provider</title><h1>Passkey sign-in</h1>
        <button id="register">Create test accounts</button><button id="login">Use passkey</button>
        <p role="status">Ready</p><script>
          const status = document.querySelector('[role=status]');
          const bytes = text => new TextEncoder().encode(text);
          document.querySelector('#register').onclick = async () => {
            for (const name of ['Avery', 'Blair']) {
              const credential = await navigator.credentials.create({ publicKey: {
                challenge: crypto.getRandomValues(new Uint8Array(32)),
                rp: { id: location.hostname, name: 'Passkey test' },
                user: { id: bytes(name), name: name + '@example.test', displayName: name },
                pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
                authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
              }});
              if (name === 'Avery') window.expectedCredential = credential.id;
            }
            status.textContent = 'Accounts created';
          };
          document.querySelector('#login').onclick = async () => {
            status.textContent = 'Waiting for passkey';
            try {
              const credential = await navigator.credentials.get({ publicKey: {
                challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname,
                userVerification: 'required', timeout: 30000
              }});
              status.textContent = credential.id === window.expectedCredential ? 'Signed in as Avery' : 'Wrong account';
            } catch (error) { status.textContent = error.name; }
          };
        </script>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("No test server");
    const origin = `http://localhost:${address.port}`;
    const ownerUrl = `http://127.0.0.1:${address.port}/`;
    servers.push(server);
    await shell.evaluate(
      (url) =>
        (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(
          url,
        ),
      ownerUrl,
    );
    const owner = await pageAt(app, ownerUrl);
    // Preserve the real child context used by Google/OAuth handoffs.
    await owner.getByRole("button", { name: "Sign in with passkey" }).click();
    const popupUrl = `${origin}/oauth/passkey`;
    const popup = await pageAt(app, popupUrl);
    await expect(
      popup.getByRole("heading", { name: "Passkey sign-in" }),
    ).toBeVisible();
    await capturePage(popup, "passkey-popup/01-sign-in-popup.png");
    await app.evaluate(async ({ webContents }, url) => {
      const page = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL() === url)!;
      page.debugger.attach("1.3");
      await page.debugger.sendCommand("WebAuthn.enable");
      await page.debugger.sendCommand("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          automaticPresenceSimulation: true,
          isUserVerified: true,
        },
      });
    }, popupUrl);
    // Chromium creates real credentials on a test authenticator; no account event is mocked.
    await popup.getByRole("button", { name: "Create test accounts" }).click();
    await expect(popup.getByRole("status")).toHaveText("Accounts created");
    await popup.getByRole("button", { name: "Use passkey" }).click();
    const bar = await pageAt(app, (page) => page.url().startsWith("data:text/html"));
    const chooser = bar.getByTestId("passkey-account-chooser");
    await expect(chooser).toBeVisible();
    await expect(chooser).toContainText("localhost");
    await expect(chooser).toContainText("Avery@example.test");
    await expect(chooser).toContainText("Blair@example.test");
    // Only the trusted strip has the bridge; stale messages cannot pick an account.
    expect(await popup.evaluate(() => "pistachioPopup" in window)).toBe(false);
    await bar.evaluate(() => {
      (
        window as unknown as {
          pistachioPopup: {
            selectPasskey(id: string, account: string | null): void;
          };
        }
      ).pistachioPopup.selectPasskey("stale-request", null);
    });
    await expect(chooser).toBeVisible();
    const credentialId = await popup.evaluate(
      () =>
        (window as unknown as { expectedCredential: string })
          .expectedCredential,
    );
    expect(await bar.content()).not.toContain(credentialId);
    await capturePage(bar, "passkey-popup/02-passkey-account-chooser.png");
    await chooser
      .getByRole("button", { name: "Avery Avery@example.test", exact: true })
      .click();
    await expect(popup.getByRole("status")).toHaveText("Signed in as Avery");
    await expect(chooser).toBeHidden();
    const controls = await shell.evaluate(() =>
      (
        window as unknown as { pistachio: PistachioApi }
      ).pistachio.getBrowserControls(),
    );
    expect(
      controls.recentEvents.find((event) => event.capability === "passkey"),
    ).toMatchObject({
      origin,
      decision: "allow",
    });
    await capturePage(popup, "passkey-popup/03-signed-in.png");

    // Explicit cancellation rejects the page request and leaves the popup usable.
    await popup.getByRole("button", { name: "Use passkey" }).click();
    await expect(chooser).toBeVisible();
    await chooser.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(popup.getByRole("status")).toHaveText("NotAllowedError");
    await expect(chooser).toBeHidden();
    await capturePage(popup, "passkey-popup/04-cancelled.png");

    // Same-document navigation preserves a request; a replacement document cancels it.
    await popup.getByRole("button", { name: "Use passkey" }).click();
    await expect(chooser).toBeVisible();
    await popup.evaluate(() => {
      location.hash = "still-signing-in";
    });
    await expect(chooser).toBeVisible();
    await popup.goto(`${popupUrl}?replacement=1`);
    await expect(chooser).toBeHidden();
    await expect(popup.getByRole("status")).toHaveText("Ready");
    await capturePage(popup, "passkey-popup/05-navigation-cleared-chooser.png");

    // Closing with an unanswered request removes both popup views without stranding the owner.
    await popup.getByRole("button", { name: "Use passkey" }).click();
    await expect(chooser).toBeVisible();
    await app.evaluate(({ webContents }, url) => {
      webContents
        .getAllWebContents()
        .find((page) => page.getURL() === url)!
        .close();
    }, `${popupUrl}?replacement=1`);
    await expect.poll(() => popup.isClosed() && bar.isClosed()).toBe(true);
    await expect(
      owner.getByRole("button", { name: "Sign in with passkey" }),
    ).toBeVisible();
    await capturePage(owner, "passkey-popup/06-popup-closed.png");
  });
});
