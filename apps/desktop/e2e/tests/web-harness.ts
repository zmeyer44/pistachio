import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page } from "@playwright/test";
import { getRequestListener } from "../../../../services/control/node_modules/@hono/node-server/dist/index.js";
import {
  createApp,
  createDbFromUrl,
  ensureSchema,
  generateSigningKeys,
  httpRunnerClient,
  type ControlApp,
  type Db,
} from "../../../../services/control/src/index.js";
import { registryChromiumPath } from "../../../../services/cloud-browser/src/config.js";
import { createRunner, type Runner } from "../../../../services/cloud-browser/src/runner.js";

/**
 * The stack the web apps' end-to-end specs run against, in one place
 * (docs/web-browser-design.md §7, §14, §15).
 *
 * Everything here is real, which is the point: control on PGlite with its
 * hub, a cloud-browser worker with real Chromium and no egress gateway, and
 * one or both web apps as `next dev --webpack` on a port of their own,
 * pointed at that control and building into a private dist directory so they
 * cannot contend with a developer's live Next process.
 *
 * There are TWO apps now (§15) and a spec says which it needs: `web` is the
 * browser (the shell at `/`), `www` is the site and the account dashboard.
 * Both ports are allocated either way, so control's allowed origins and the
 * worker's two pinned origins are the same whichever is booted, and each app
 * is told where the other lives.
 */

/** The Chromium the worker drives, or null when no build is available. */
export function chromiumPath(): string | null {
  const fromEnv = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return existsSync(fromEnv) ? fromEnv : null;
  return registryChromiumPath();
}

export async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export async function waitForHttp(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`web app exited with ${String(child.exitCode)}`);
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // The dev server has not bound its port yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("web app did not become ready");
}

/**
 * Stop the dev server AND the `next` it spawned. `pnpm exec` is a shell in
 * front of the real process, so signalling the child alone leaves Next running
 * — and a Next that outlives the `rm` below writes its dist directory back
 * onto a disk this repository is short of. The child is its own process group
 * (`detached`), so the negative pid takes the whole tree.
 */
export async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  const pid = child.pid;
  const signal = (name: NodeJS.Signals): void => {
    try {
      process.kill(-pid, name);
    } catch {
      // The group is already gone.
    }
  };
  signal("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) signal("SIGKILL");
  await new Promise<void>((resolve) => setTimeout(resolve, 500));
}

/** The two web apps, by package name (§15). */
export type WebApp = "web" | "www";

export interface WebStackOptions {
  /** The Chromium the worker drives; the caller has already skipped without one. */
  chromium: string | null;
  /** A name for this spec's state directory, so a crash leaves an obvious trail. */
  name: string;
  /**
   * Which apps to boot, in order; the first is what `webUrl` names. Defaults
   * to the browser app alone, which is what most of these specs walk.
   */
  apps?: WebApp[];
  /** Sites the worker's egress may reach, beyond the fleet's own. */
  allowedOrigins?: string[];
  /** The shared secret control and the worker authenticate to each other with. */
  serviceToken?: string;
  /** Extra env for the Next apps, e.g. a feature flag a spec turns on. */
  webEnv?: Record<string, string>;
}

export interface WebStack {
  controlUrl: string;
  runnerUrl: string;
  /** The first app this spec booted — the one a single-app spec walks. */
  webUrl: string;
  /** Every app's address, booted or not: what each was told about the other. */
  urls: Record<WebApp, string>;
  /** `CLOUD_BROWSER_STATE_DIR`: where the worker keeps sessions and downloads. */
  stateDir: string;
  /** Everything the processes said, for a failure message. */
  logs(): { control: string; runner: string; web: string };
  /** Anything the browser said, folded into the web log. */
  noteWebLog(line: string): void;
  stopCloudBrowser(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Boot control, the worker and the apps this spec asked for, in that order,
 * and hand back the addresses. The caller closes it in a `finally`.
 */
export async function startWebStack(options: WebStackOptions): Promise<WebStack> {
  const serviceToken = options.serviceToken ?? `${options.name}-e2e-service-token`;
  const apps: WebApp[] = options.apps ?? ["web"];
  const controlPort = await availablePort();
  const runnerPort = await availablePort();
  const controlUrl = `http://127.0.0.1:${String(controlPort)}`;
  const runnerUrl = `http://127.0.0.1:${String(runnerPort)}`;
  // Next's development asset server treats localhost as its canonical dev
  // origin; using it avoids HMR reloads while the API remains on loopback.
  const urls: Record<WebApp, string> = {
    web: `http://localhost:${String(await availablePort())}`,
    www: `http://localhost:${String(await availablePort())}`,
  };
  const first = apps[0] ?? "web";
  const stateDir = join(process.cwd(), "e2e", `.state-${options.name}-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true });

  let controlLog = "";
  let runnerLog = "";
  let webLog = "";

  const db: Db = await createDbFromUrl("pglite:memory://");
  await ensureSchema(db);
  const signing = await generateSigningKeys();
  const runnerClient = httpRunnerClient({ baseUrl: runnerUrl, serviceToken });
  const control: ControlApp = createApp(db, {
    signing,
    // The worker's claim poll is most of control's traffic and none of a
    // spec's interest; what the TAB asked for is what a failure needs.
    log: (line) => {
      if (!line.includes("/v1/internal/")) controlLog += `\n${line}`;
    },
    env: {
      CLOUD_BROWSER_SERVICE_TOKEN: serviceToken,
      // The fleet's one public address: what a session ticket names, and what
      // the tab dials for the shell socket.
      CLOUD_BROWSER_PUBLIC_URL: runnerUrl,
      // Both sites, always: they are two origins of one account (§15).
      CONTROL_ALLOWED_ORIGINS: `${urls.www},${urls.web}`,
      CONTROL_PUBLIC_URL: controlUrl,
      HUB_PUBLIC_URL: `${controlUrl.replace(/^http/u, "ws")}/v1/hub/ws`,
    },
    runner: {
      provision: (userId, nonce) => runnerClient.provision(userId, nonce),
      steer: (body) => runnerClient.steer(body),
      routeIMessage: (input) => runnerClient.routeIMessage(input),
    },
  });
  const controlServer: Server = createServer(getRequestListener(control.app.fetch));
  await new Promise<void>((resolve) => controlServer.listen(controlPort, "127.0.0.1", resolve));
  const hub = control.hub.attach(controlServer);

  /**
   * The worker installs undici's `fetch`, `Response` and friends over Node's
   * own when it starts. In production it is a separate process and nobody
   * notices; in a spec control's HTTP listener was built against Node's
   * classes in the same process, and afterwards it answers a browser's
   * preflight with a 500 from deep inside `@hono/node-server`. So the web
   * globals are put back once the worker is up — control keeps the classes it
   * was born with, and the worker keeps using whatever it captured.
   */
  const WEB_GLOBALS = [
    "fetch",
    "Headers",
    "Request",
    "Response",
    "FormData",
    "WebSocket",
    "CloseEvent",
    "ErrorEvent",
    "MessageEvent",
    "EventSource",
  ] as const;
  const nodeGlobals = new Map<string, unknown>(
    WEB_GLOBALS.map((name) => [name, (globalThis as unknown as Record<string, unknown>)[name]]),
  );

  const runner: Runner = createRunner({
    controlUrl,
    serviceToken,
    stateDir,
    stateKey: randomBytes(32),
    ...(options.chromium === null ? {} : { chromiumPath: options.chromium }),
    // No run is started by either spec; a model is never asked for one.
    modelFactory: () => {
      throw new Error("this spec starts no agent run");
    },
    ports: { http: runnerPort },
    host: "127.0.0.1",
    publicUrl: runnerUrl,
    internalUrl: runnerUrl,
    // `www` is where an artifact and a run's live view are read; the shell
    // socket pins `Origin` to the browser app and nothing else (§5, §15), so
    // a page anywhere else cannot drive someone's browser.
    artifactWebUrl: urls.www,
    browserUrl: urls.web,
    allowedOrigins: options.allowedOrigins ?? [],
    egressMode: "direct",
    claimIntervalMs: 50,
    commandWaitSeconds: 1,
    // Not silent: what the worker says while it drives the session is half of
    // any diagnosis when a step fails, and it is in the failure message.
    log: {
      info: (message: string, fields?: Record<string, unknown>) => {
        runnerLog += `info ${message} ${JSON.stringify(fields ?? {})}\n`;
      },
      warn: (message: string, fields?: Record<string, unknown>) => {
        runnerLog += `warn ${message} ${JSON.stringify(fields ?? {})}\n`;
      },
      error: (message: string, fields?: Record<string, unknown>) => {
        runnerLog += `error ${message} ${JSON.stringify(fields ?? {})}\n`;
      },
    },
  });
  await runner.start();
  for (const [name, value] of nodeGlobals) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  /**
   * One app. Each is told where the other lives, because the dashboard links
   * to the browser and the browser links back (§15) — and because the gate,
   * which both mount, reads `NEXT_PUBLIC_PISTACHIO_WWW_URL`.
   */
  const started: { app: WebApp; child: ChildProcess; distDir: string; dir: string }[] = [];
  for (const app of apps) {
    const distDir = `.next-e2e-${randomUUID()}`;
    const dir = fileURLToPath(new URL(`../../../${app}/`, import.meta.url));
    const port = new URL(urls[app]).port;
    const env = {
        ...process.env,
        NEXT_PUBLIC_PISTACHIO_CONTROL_URL: controlUrl,
        NEXT_PUBLIC_PISTACHIO_BROWSER_URL: urls.web,
        NEXT_PUBLIC_PISTACHIO_WWW_URL: urls.www,
        PISTACHIO_NEXT_DIST_DIR: distDir,
        ...options.webEnv,
    };
    const production = process.env["PISTACHIO_E2E_WEB_PRODUCTION"] === "1";
    if (production) {
      const build = spawn("pnpm", ["--filter", app, "exec", "next", "build", "--webpack"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      build.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      build.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      const [code] = await once(build, "exit");
      if (code !== 0) throw new Error(`Production build failed: ${output}`);
    }
    const command = production ? ["start", "--port", port] : ["dev", "--webpack", "--port", port];
    const child = spawn("pnpm", ["--filter", app, "exec", "next", ...command], {
      cwd: process.cwd(), env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      webLog += `[${app}] ${chunk.toString("utf8")}`;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      webLog += `[${app}] ${chunk.toString("utf8")}`;
    });
    started.push({ app, child, distDir, dir });
  }
  for (const { app, child } of started) await waitForHttp(urls[app], child);

  let runnerStopped = false;
  const stopCloudBrowser = async () => {
    if (runnerStopped) return;
    runnerStopped = true;
    await runner.stop();
  };
  return {
    stopCloudBrowser,
    controlUrl,
    runnerUrl,
    webUrl: urls[first],
    urls,
    stateDir,
    logs: () => ({ control: controlLog, runner: runnerLog, web: webLog }),
    noteWebLog: (line: string) => {
      webLog += `\n${line}`;
    },
    close: async () => {
      for (const { child } of started) await stopProcess(child);
      for (const { dir, distDir } of started) await rm(`${dir}${distDir}`, { recursive: true, force: true });
      await stopCloudBrowser();
      await control.idle();
      await hub.close();
      controlServer.closeAllConnections();
      await new Promise<void>((resolve) => controlServer.close(() => resolve()));
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

/**
 * The tab reaches control cross-origin, so the preflight is part of the
 * setup: without the allowlist every call from the page fails before it is
 * sent, and the failure shows up much later as an empty screen.
 */
export async function corsAllowed(controlUrl: string, webUrl: string): Promise<string | null> {
  const preflight = await fetch(`${controlUrl}/v1/accounts`, {
    method: "OPTIONS",
    headers: {
      origin: webUrl,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  return preflight.headers.get("access-control-allow-origin");
}


/* ------------------------------- the walk in ------------------------------ */

/**
 * Create an account in the tab. Signing up is also the password ceremony
 * that derives this browser's keys and wraps the first Space for the cloud
 * device (cloud-sync-design.md §17).
 *
 * There is no navigation afterwards on either site (§15): the gate is the
 * whole page until the session is ready, and what replaces it is whatever
 * that address is. On the browser app that is the shell, with the walkthrough
 * waiting (§14); on `www` it is the dashboard.
 *
 * `remember` puts a PIN ceremony in between, because keeping the session means
 * sealing it under one — see `choosePin`.
 *
 * `at` is the address the gate is standing on — `/` on the browser app, and
 * `/app` on `www` — and `ready` is what proves it opened.
 */
export async function signUpInTab(
  page: Page,
  options: { webUrl: string; email: string; password: string; remember?: boolean; at?: string },
): Promise<void> {
  await page.goto(`${options.webUrl}${options.at ?? "/"}`);
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill(options.email);
  await page.getByLabel("Password", { exact: true }).fill(options.password);
  // Without this a reload lands on the unlock screen: the derived keys are
  // held in tab memory only unless the person asks otherwise.
  const remember = options.remember !== false;
  if (remember) await page.getByLabel("Stay unlocked on this browser").check();
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  // The door is gone when the account exists; what is behind it is either the
  // PIN ceremony or this address's own page.
  await expect(page.getByRole("button", { name: "Create account", exact: true })).toHaveCount(0, { timeout: 60_000 });
  if (remember) await choosePin(page);
  await expect(page).toHaveURL(`${options.webUrl}${options.at ?? "/"}`);
}

/** The PIN every web test seals its session under. */
export const TEST_PIN = "246810";

/**
 * Choose the PIN, twice, on the screen that follows a password unlock with
 * "stay unlocked" on.
 *
 * The pad auto-advances and submits itself, so there is no button to press —
 * and afterwards the six circles roll up into a ring and spin away, which is
 * why this waits for the pad to be GONE rather than for the next screen: what
 * is behind it differs per site, and the animation outlives the state change
 * that starts it.
 */
export async function choosePin(page: Page, pin: string = TEST_PIN): Promise<void> {
  const pad = page.getByRole("group", { name: "Choose a PIN" });
  await expect(pad).toBeVisible({ timeout: 30_000 });
  await page.keyboard.type(pin);
  await expect(page.getByRole("group", { name: "Confirm your PIN" })).toBeVisible({ timeout: 10_000 });
  await page.keyboard.type(pin);
  await expect(page.locator(".pa-pin")).toHaveCount(0, { timeout: 30_000 });
}

/**
 * Answer the PIN on a browser that kept its session — what a reload lands on
 * once "stay unlocked" has been used (§15).
 */
export async function enterPin(page: Page, pin: string = TEST_PIN): Promise<void> {
  await expect(page.getByRole("group", { name: "Your PIN" })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.type(pin);
  await expect(page.locator(".pa-pin")).toHaveCount(0, { timeout: 30_000 });
}

/**
 * Sign IN on a site this account already exists on, but this browser profile
 * has never been to: a second origin holds no device keys, so it enrols one
 * of its own (§15).
 */
export async function signInInTab(
  page: Page,
  options: { webUrl: string; email: string; password: string; at?: string },
): Promise<void> {
  await page.goto(`${options.webUrl}${options.at ?? "/"}`);
  await page.getByLabel("Email", { exact: true }).fill(options.email);
  await page.getByLabel("Password", { exact: true }).fill(options.password);
  await page.getByLabel("Stay unlocked on this browser").check();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0, { timeout: 60_000 });
  await choosePin(page);
}

/**
 * Wait for the shell, turning the cloud on first if the sign-up's own attempt
 * did not land. Answers when either the walkthrough or the chrome is up.
 */
export async function openBrowseShell(page: Page): Promise<void> {
  const enable = page.getByRole("button", { name: /Turn on cloud browser|Unlock to turn on/u });
  const chrome = page.getByTestId("new-tab-button").first();
  await expect(enable.or(chrome).first()).toBeVisible({ timeout: 120_000 });
  if (await enable.isVisible()) await enable.click();
  // Claiming the session opens a Chromium context and hydrates the Space's
  // cookies, which is the slowest thing in either spec.
  await expect(chrome).toBeVisible({ timeout: 180_000 });
}

/**
 * A new tab from the shell's own chrome, and its address field: the home
 * page's search (@pistachio/shell-contracts/home), which takes the keyboard
 * as the new tab shows and goes where ↵ says, as the address bar does.
 */
export async function openNewTab(page: Page): Promise<Locator> {
  await page.getByTestId("new-tab-button").first().click();
  const address = page.locator('[data-testid="home-search-input"]:focus');
  await expect(address).toBeVisible({ timeout: 15_000 });
  return address;
}

/**
 * Walk the first run at speed, for a spec whose subject is what comes AFTER
 * it. `web-onboarding.spec.ts` is the one that reads every step.
 */
export async function walkFirstRun(page: Page, name: string): Promise<void> {
  const wizard = page.getByTestId("onboarding");
  await expect(wizard).toBeVisible({ timeout: 60_000 });
  await expect(wizard).toHaveAttribute("data-step", "about");
  const typeInstead = page.getByTestId("onboarding-type-instead");
  if (await typeInstead.isVisible()) await typeInstead.click();
  await page.getByTestId("onboarding-name").fill(name);
  await page.getByTestId("onboarding-primary").click();
  await expect(wizard).toHaveAttribute("data-step", "import");
  await page.getByTestId("onboarding-primary").click();
  await expect(wizard).toHaveAttribute("data-step", "favorites");
  await page.getByTestId("onboarding-primary").click();
  await expect(wizard).toHaveAttribute("data-step", "appearance");
  await page.getByTestId("onboarding-primary").click();
  await expect(wizard).toHaveCount(0, { timeout: 60_000 });
}
