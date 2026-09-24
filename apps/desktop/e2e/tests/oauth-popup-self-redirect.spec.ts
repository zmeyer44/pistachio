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

const screenshotDirectory = join(
  process.cwd(),
  "e2e/screenshots/oauth-popup-self-redirect",
);

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
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

async function launch(): Promise<ElectronApplication> {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined)
    throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-oauth-self-redirect-"));
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({
      layout: { mode: "sidebar", sidebar: "pinned" },
      general: { consoleOpenOnLaunch: false },
    }),
  );
  return electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
}

async function signInThroughPopup(
  app: ElectronApplication,
  relyingParty: SelfRedirectingRelyingParty,
  screenshotPrefix: string,
): Promise<Page> {
  const shell = await shellPage(app);
  const signInUrl = `${relyingParty.origin}/session/new`;
  await shell.evaluate(
    (url) =>
      (window as unknown as { pistachio: PistachioApi }).pistachio.createTab(url),
    signInUrl,
  );
  const owner = await pageAt(app, (page) => page.url() === signInUrl);
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
  // Give the browser every chance to issue a late reload before judging.
  await owner.waitForTimeout(6_500);
  expect(
    await owner.evaluate(() => (window as unknown as { __landed?: boolean }).__landed),
  ).toBe(true);
  await owner.screenshot({
    path: join(screenshotDirectory, `${screenshotPrefix}-home.png`),
    fullPage: true,
  });
  return owner;
}

test("a relying party that redirects itself after a Google popup is not reloaded out from under it", async () => {
  const relyingParty = await selfRedirectingRelyingParty({
    exchangeDelayMs: 400,
    homeDelayMs: 1_000,
    analyticsCookieChurn: false,
  });
  const app = await launch();
  try {
    await signInThroughPopup(app, relyingParty, "01-self-redirect");
    // One sign-in page, one exchange, one home load — the page's own — and
    // no reload re-serving either document.
    expect(relyingParty.requests()).toEqual([
      "GET /session/new",
      "POST /auth/jwt",
      "GET / [authenticated]",
    ]);
  } finally {
    await app.close();
    await Promise.all(relyingParty.servers.map(closeServer));
  }
});

test("analytics cookie churn during the popup does not trigger a reload mid-exchange", async () => {
  const relyingParty = await selfRedirectingRelyingParty({
    exchangeDelayMs: 1_200,
    homeDelayMs: 1_000,
    analyticsCookieChurn: true,
  });
  const app = await launch();
  try {
    await signInThroughPopup(app, relyingParty, "02-cookie-churn");
    expect(relyingParty.requests()).toEqual([
      "GET /session/new",
      "POST /auth/jwt",
      "GET / [authenticated]",
    ]);
  } finally {
    await app.close();
    await Promise.all(relyingParty.servers.map(closeServer));
  }
});
