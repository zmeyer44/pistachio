import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { pageFirst, shellReady } from "./windows";

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/external-app");

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [
    process.env["PISTACHIO_ELECTRON_PATH"],
    join(process.cwd(), "node_modules/electron", suffix),
    resolve(process.cwd(), "../../../harbor/node_modules/.pnpm/electron@43.3.0/node_modules/electron", suffix),
  ].find((candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")));
}

async function captureShell(app: ElectronApplication, filename: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Pistachio window is unavailable");
    return (await window.capturePage()).toPNG().toString("base64");
  });
  await mkdir(screenshotDirectory, { recursive: true });
  await writeFile(join(screenshotDirectory, filename), Buffer.from(png, "base64"));
}

/** Run script in the meeting page's tab, as a person's own click would. */
function inMeetingTab(app: ElectronApplication, pageUrl: string, script: string): Promise<unknown> {
  return app.evaluate(
    async ({ webContents }, { pageUrl, script }) => {
      const tab = webContents.getAllWebContents().find((contents) => contents.getURL() === pageUrl);
      if (tab === undefined) throw new Error(`No tab is showing ${pageUrl}`);
      return tab.executeJavaScript(script, true);
    },
    { pageUrl, script },
  );
}

/** What main handed to the system, recorded by the stub installed below. */
function opened(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as { __openedExternally?: string[] }).__openedExternally ?? []);
}

test("a meeting page's app link asks first, and Always allow opens that kind of link silently from then on", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-external-app-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Join meeting</title><h1>Launch Meeting</h1><iframe id=frame></iframe>");
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Meeting test server did not bind a TCP port");
  const pageUrl = `http://localhost:${address.port}/`;
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst({ general: { homeUrl: pageUrl }, layout: { mode: "top", sidebar: "pinned" } })));

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellReady(app);
    await expect
      .poll(() => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().some((contents) => contents.getURL() === url && !contents.isLoading()), pageUrl))
      .toBe(true);

    // No real app is launched: the system's answers are stubbed. `zoomtest`
    // and `chattest` have a handler; `nothingtest` has none installed.
    await app.evaluate(({ app: electronApp, shell: electronShell }) => {
      const record: string[] = [];
      (globalThis as { __openedExternally?: string[] }).__openedExternally = record;
      electronShell.openExternal = async (url: string) => {
        record.push(url);
      };
      electronApp.getApplicationNameForProtocol = (url: string) =>
        url.startsWith("zoomtest:") ? "Zoom Test.app" : url.startsWith("chattest:") ? "Chat Test" : "";
    });

    const prompt = shell.getByTestId("permission-prompt");
    const meetingLink = "zoomtest://zoom.test/join?confno=123";

    // 1. The page points itself at the app link, the way Zoom's launcher does.
    await inMeetingTab(app, pageUrl, `location.href = ${JSON.stringify(meetingLink)}; true`);
    await expect(prompt).toBeVisible();
    await expect(prompt.getByRole("heading")).toHaveText(/wants to open Zoom Test$/);
    await expect(prompt).toContainText("open zoomtest links without asking again");
    await shell.waitForTimeout(400); // let the prompt finish fading in before the still
    await captureShell(app, "01-prompt.png");
    expect(await opened(app)).toEqual([]);
    await prompt.getByRole("button", { name: "Open once" }).click();
    await expect(prompt).toHaveCount(0);
    await expect.poll(() => opened(app)).toEqual([meetingLink]);
    // The tab never went anywhere.
    expect(await inMeetingTab(app, pageUrl, "document.title")).toBe("Join meeting");

    // 2. "Open once" is not remembered: the next link asks again.
    await inMeetingTab(app, pageUrl, `location.href = ${JSON.stringify(meetingLink)}; true`);
    await expect(prompt).toBeVisible();
    await prompt.getByRole("button", { name: "Always allow" }).click();
    await expect(prompt).toHaveCount(0);
    await expect.poll(() => opened(app)).toEqual([meetingLink, meetingLink]);

    // 3. From now on that kind of link opens with no prompt at all…
    await inMeetingTab(app, pageUrl, `location.href = ${JSON.stringify(meetingLink)}; true`);
    await expect.poll(() => opened(app)).toEqual([meetingLink, meetingLink, meetingLink]);
    await expect(prompt).toHaveCount(0);
    // …through window.open too, which makes no tab of it.
    const tabsBefore = await shell.getByTestId("human-tab").count();
    await inMeetingTab(app, pageUrl, `window.open(${JSON.stringify(meetingLink)}); true`);
    await expect.poll(() => opened(app)).toHaveLength(4);
    await expect(prompt).toHaveCount(0);
    expect(await shell.getByTestId("human-tab").count()).toBe(tabsBefore);
    const saved = JSON.parse(await readFile(join(userData, "site-permissions.json"), "utf8")) as { externalApps?: Record<string, string[]> };
    expect(saved.externalApps).toEqual({ [`http://localhost:${address.port}`]: ["zoomtest"] });

    // 4. The grant is for that scheme only: another app still asks, and
    //    Cancel opens nothing and remembers nothing.
    await inMeetingTab(app, pageUrl, `location.href = "chattest://open"; true`);
    await expect(prompt).toBeVisible();
    await expect(prompt.getByRole("heading")).toHaveText(/wants to open Chat Test$/);
    await prompt.getByRole("button", { name: "Cancel" }).click();
    await expect(prompt).toHaveCount(0);
    expect(await opened(app)).toHaveLength(4);

    // 5. A frame's app link never passes will-navigate; Chromium asks main
    //    for `openExternal`, and the same prompt answers it.
    await inMeetingTab(app, pageUrl, `document.getElementById("frame").src = "chattest://from-frame"; true`);
    await expect(prompt).toBeVisible();
    await expect(prompt.getByRole("heading")).toHaveText(/wants to open Chat Test$/);
    await prompt.getByRole("button", { name: "Cancel" }).click();
    await expect(prompt).toHaveCount(0);

    // 6. A scheme nothing on the computer answers is dropped without a prompt.
    await inMeetingTab(app, pageUrl, `location.href = "nothingtest://x"; true`);
    await shell.waitForTimeout(500);
    await expect(prompt).toHaveCount(0);
    expect(await opened(app)).toHaveLength(4);

    // 7. Site controls names what was remembered, and "Reset" forgets it.
    await shell.getByTestId("site-info-button").click();
    await shell.getByTestId("site-info-popover").getByTestId("site-info-site-controls").click();
    const controls = shell.getByTestId("site-controls");
    await expect(controls.getByTestId("external-app-schemes")).toContainText("Always opens zoomtest links");
    await captureShell(app, "02-site-controls.png");
    await controls.getByRole("button", { name: "Reset site decisions" }).click();
    await expect(controls.getByTestId("external-app-schemes")).toHaveCount(0);
    await shell.keyboard.press("Escape");
    await inMeetingTab(app, pageUrl, `location.href = ${JSON.stringify(meetingLink)}; true`);
    await expect(prompt).toBeVisible();
    await prompt.getByRole("button", { name: "Cancel" }).click();
    expect(await opened(app)).toHaveLength(4);
  } finally {
    await app.close();
    server.close();
  }
});

test("a Glance's app link is asked over the Glance, named for the Glance's own site, and Escape keeps the preview", async () => {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), "pistachio-external-app-glance-"));
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    const meeting = `http://127.0.0.1:${String((server.address() as { port: number }).port)}/meeting`;
    response.end(
      request.url === "/meeting"
        ? "<!doctype html><title>Join meeting</title><h1>Launch Meeting</h1>"
        : `<!doctype html><title>Calendar</title><h1>Calendar</h1><a id="meeting" href="${meeting}">Join the meeting</a>`,
    );
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Meeting test server did not bind a TCP port");
  // Two origins on one server: the calendar the tab shows, the meeting page the Glance shows.
  const ownerUrl = `http://localhost:${address.port}/`;
  const meetingUrl = `http://127.0.0.1:${address.port}/meeting`;
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst({ general: { homeUrl: ownerUrl }, layout: { mode: "top", sidebar: "pinned" } })));

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  try {
    const shell = await shellReady(app);
    await expect.poll(() => app.windows().some((page) => page.url() === ownerUrl)).toBe(true);
    const owner = app.windows().find((page) => page.url() === ownerUrl)!;
    await app.evaluate(({ app: electronApp, shell: electronShell }) => {
      const record: string[] = [];
      (globalThis as { __openedExternally?: string[] }).__openedExternally = record;
      electronShell.openExternal = async (url: string) => {
        record.push(url);
      };
      electronApp.getApplicationNameForProtocol = (url: string) =>
        url.startsWith("zoomtest:") ? "Zoom Test.app" : url.startsWith("chattest:") ? "Chat Test" : "";
    });

    await owner.locator("#meeting").click({ modifiers: ["Alt"] });
    const glance = shell.getByTestId("glance-overlay");
    await expect(glance).toBeVisible();
    await expect(shell.getByTestId("glance-promote")).toBeEnabled();
    await expect
      .poll(() => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().some((contents) => contents.getURL() === url && !contents.isLoading()), meetingUrl))
      .toBe(true);

    // The preview's page launches its app: the prompt comes up OVER the
    // Glance, and names the meeting site rather than the calendar under it.
    const prompt = shell.getByTestId("permission-prompt");
    await inMeetingTab(app, meetingUrl, `location.href = "zoomtest://zoom.test/join?confno=9"; true`);
    await expect(prompt).toBeVisible();
    await expect(prompt.getByRole("heading")).toHaveText(`127.0.0.1:${address.port} wants to open Zoom Test`);
    await shell.waitForTimeout(400);
    await captureShell(app, "03-glance-prompt.png");
    // A real click at the button: it must land on the dialog, not the Glance's veil.
    await prompt.getByRole("button", { name: "Always allow" }).click();
    await expect(prompt).toHaveCount(0);
    await expect.poll(() => opened(app)).toEqual(["zoomtest://zoom.test/join?confno=9"]);
    await expect(glance).toBeVisible();
    // Remembered for the meeting site, not for the calendar that opened the Glance.
    const saved = JSON.parse(await readFile(join(userData, "site-permissions.json"), "utf8")) as { externalApps?: Record<string, string[]> };
    expect(saved.externalApps).toEqual({ [`http://127.0.0.1:${address.port}`]: ["zoomtest"] });

    // Escape puts the prompt down and leaves the preview up.
    await inMeetingTab(app, meetingUrl, `location.href = "chattest://open"; true`);
    await expect(prompt).toBeVisible();
    await shell.keyboard.press("Escape");
    await expect(prompt).toHaveCount(0);
    await shell.waitForTimeout(500);
    await expect(glance).toBeVisible();
    expect(await opened(app)).toHaveLength(1);

    // Closing the preview takes its unanswered request with it.
    await shell.getByTestId("glance-close").click();
    await expect(glance).toHaveCount(0);
    await expect(shell.getByTestId("site-info-button")).toBeVisible();
    await shell.getByTestId("site-info-button").click();
    await expect(shell.getByTestId("site-info-popover")).toBeVisible();
    await expect(shell.getByTestId("site-info-pending")).toHaveCount(0);
  } finally {
    await app.close();
    server.close();
  }
});
