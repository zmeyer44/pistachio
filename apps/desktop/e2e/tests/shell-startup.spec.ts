import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { HOME_PAGE_URL } from "@pistachio/shell-contracts/home";
import { shellPage } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/shell-startup");

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", suffix),
  ].find(
    (candidate) =>
      candidate !== undefined &&
      existsSync(candidate) &&
      existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
}

async function closeApp(app: ElectronApplication): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const killAfter = new Promise<void>((done) => {
    timer = setTimeout(() => {
      app.process().kill("SIGKILL");
      done();
    }, 10_000);
  });
  await Promise.race([app.close(), killAfter]);
  if (timer !== undefined) clearTimeout(timer);
}

test("the shell and first page paint from a clean profile", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-shell-startup-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env["PISTACHIO_E2E"] = "1";
  env["PISTACHIO_USER_DATA"] = userData;
  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env,
  });
  try {
    const shell = await shellPage(app);
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
    const contents = await app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().map((item) => ({
        type: item.getType(),
        url: item.getURL(),
        title: item.getTitle(),
        loading: item.isLoading(),
        crashed: item.isCrashed(),
      })),
    );
    console.log(
      JSON.stringify({ state, contents, pendingRequests: [...pendingRequests], diagnostics }, null, 2),
    );

    await mkdir(screenshotDirectory, { recursive: true });
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error("Pistachio window is unavailable");
      return (await window.capturePage()).toPNG().toString("base64");
    });
    await writeFile(join(screenshotDirectory, "01-clean-profile-shell.png"), Buffer.from(png, "base64"));
    // Visible navigation chrome proves the lazy shell chunk mounted beyond the empty Suspense fallback.
    await expect(shell.getByTestId("sidebar-pane")).toBeVisible();
    expect(state.rootChildren).toBeGreaterThan(0);
    // A clean profile's first page is the home page: its tab loaded the
    // placeholder, and the shell drew the page itself.
    await expect(shell.getByTestId("home-page")).toBeVisible();
    expect(contents.some((item) => item.url === HOME_PAGE_URL && !item.crashed)).toBe(true);
    expect(diagnostics).toEqual([]);
  } finally {
    await closeApp(app);
  }
});
