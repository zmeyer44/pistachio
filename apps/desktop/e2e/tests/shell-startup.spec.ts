import { spawn } from "node:child_process";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { HOME_PAGE_URL } from "@pistachio/shell-contracts/home";
import { shellPage } from "./windows";
import { electronExecutable, launchApp } from "./app";
import { captureShell, closeApp } from "./chrome-harness";

const FOLDER = "shell-startup";

/** A second process on the same profile, as a second double-click would start; its exit code. */
async function runDuplicate(userData: string): Promise<number | null> {
  const duplicate = spawn(electronExecutable(), ["."], {
    cwd: process.cwd(),
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
    stdio: "ignore",
  });
  return new Promise<number | null>((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      duplicate.kill();
      rejectExit(new Error("Duplicate Pistachio instance did not exit"));
    }, 10_000);
    duplicate.once("error", (error) => {
      clearTimeout(timeout);
      rejectExit(error);
    });
    duplicate.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
}

// One clean profile: the first paint, then a second process started on it.
test.describe.serial("starting up", { tag: ["@home", "@startup"] }, () => {
  let app: ElectronApplication | undefined;
  let userData: string;
  let shell: Page;

  test.beforeAll(async () => {
    ({ app, userData } = await launchApp({ name: "shell-startup" }));
    shell = await shellPage(app);
  });

  test.afterAll(async () => {
    await closeApp(app);
  });

  test("the shell and first page paint from a clean profile", { tag: ["@smoke"] }, async () => {
    const running = app!;
    const diagnostics: string[] = [];
    const pendingRequests = new Set<string>();
    shell.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        diagnostics.push(`console.${message.type()}: ${message.text()}`);
      }
    });
    shell.on("pageerror", (error) => diagnostics.push(`pageerror: ${error.message}`));
    shell.on("request", (request) => pendingRequests.add(request.url()));
    shell.on("requestfinished", (request) => pendingRequests.delete(request.url()));
    shell.on("requestfailed", (request) => {
      pendingRequests.delete(request.url());
      const error = request.failure()?.errorText ?? "unknown";
      // The reload below aborts whatever the first document still had in
      // flight (the home page's weather, say): cancelled, not failed.
      if (error === "net::ERR_ABORTED") return;
      diagnostics.push(`requestfailed: ${request.url()} (${error})`);
    });

    // Reload after listeners are attached so module and resource failures cannot race the test harness.
    await shell.reload({ waitUntil: "domcontentloaded" });
    await shell
      .waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0, null, {
        timeout: 8_000,
      })
      .catch(() => undefined);
    const state = await shell.evaluate(() => ({
      url: location.href,
      readyState: document.readyState,
      rootChildren: document.getElementById("root")?.childElementCount ?? -1,
      bodyText: document.body.innerText.slice(0, 240),
      resourceCount: performance.getEntriesByType("resource").length,
      hasPreloadBridge: "pistachio" in window,
      chromeView: document.body.dataset["chromeView"] ?? null,
    }));
    const contents = await running.evaluate(({ webContents }) =>
      webContents.getAllWebContents().map((item) => ({
        type: item.getType(),
        url: item.getURL(),
        title: item.getTitle(),
        loading: item.isLoading(),
        crashed: item.isCrashed(),
      })),
    );
    console.log(JSON.stringify({ state, contents, pendingRequests: [...pendingRequests], diagnostics }, null, 2));

    await captureShell(running, FOLDER, "01-clean-profile-shell.png");
    // Visible navigation chrome proves the lazy shell chunk mounted beyond the empty Suspense fallback.
    await expect(shell.getByTestId("sidebar-pane")).toBeVisible();
    expect(state.rootChildren).toBeGreaterThan(0);
    // A clean profile's first page is the home page: its tab loaded the
    // placeholder, and the shell drew the page itself.
    await expect(shell.getByTestId("home-page")).toBeVisible();
    expect(contents.some((item) => item.url === HOME_PAGE_URL && !item.crashed)).toBe(true);
    // (The home page's weather is fetched by the shell: on a machine
    // without a network that request fails and shows up here.)
    expect(diagnostics).toEqual([]);
  });

  test("a duplicate process cannot share a durable Profile session", async () => {
    const running = app!;
    await captureShell(running, FOLDER, "02-primary-instance.png");

    expect(await runDuplicate(userData)).toBe(0);
    expect(shell.isClosed()).toBe(false);
    await expect
      .poll(() =>
        running.evaluate(({ BrowserWindow }) => ({
          count: BrowserWindow.getAllWindows().length,
          visible: BrowserWindow.getAllWindows()[0]?.isVisible() ?? false,
        })),
      )
      .toEqual({ count: 1, visible: true });
    await captureShell(running, FOLDER, "03-primary-remains-active.png");
  });
});
