import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { noticePage, pageFirst, shellReady } from "./windows";

/**
 * While a tab shares the screen, the chrome says so and can stop it
 * (@pistachio/shell-contracts/screen-share): the sidebar's card and the
 * strip's pill, the sharing tab's mark, and the hidden compact sidebar's
 * red handle with a notice. macOS's picker would open over the whole
 * desktop, so each share here is the page's own tab, handed over by a
 * display-media handler that stands in for it — a real capture, whose track
 * the page holds and hears end, with no Screen Recording permission needed.
 */

const screenshotDirectory = join(process.cwd(), "e2e/screenshots/screen-share-indicator");

function resolveElectronExecutable(): string | undefined {
  const suffix = "dist/Electron.app/Contents/MacOS/Electron";
  return [process.env["PISTACHIO_ELECTRON_PATH"], join(process.cwd(), "node_modules/electron", suffix)].find(
    (candidate) => candidate !== undefined && existsSync(candidate) && existsSync(resolve(dirname(candidate), "../Info.plist")),
  );
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

interface Meeting {
  app: ElectronApplication;
  shell: Page;
  pageUrl: string;
  close(): Promise<void>;
}

async function openMeeting(layout: { mode: "sidebar" | "top"; sidebar: "pinned" | "compact" }, label: string): Promise<Meeting> {
  const executablePath = resolveElectronExecutable();
  if (executablePath === undefined) throw new Error("No complete Electron runtime is installed.");
  const userData = await mkdtemp(join(tmpdir(), `pistachio-screen-share-${label}-`));
  const server: Server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      request.url === "/elsewhere"
        ? "<!doctype html><title>Elsewhere</title><h1>Elsewhere</h1>"
        : "<!doctype html><title>Team standup</title><body style='font:24px system-ui;padding:40px'><h1>Team standup</h1><p>Presenting…</p></body>",
    );
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Meeting test server did not bind a TCP port");
  const origin = `http://localhost:${address.port}`;
  const pageUrl = `${origin}/`;
  await writeFile(join(userData, "settings.json"), JSON.stringify(pageFirst({ general: { homeUrl: pageUrl }, layout })));
  await writeFile(join(userData, "site-permissions.json"), JSON.stringify({ version: 1, sites: { [origin]: { "display-capture": "allow" } } }));

  const app = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    executablePath,
    env: { ...process.env, PISTACHIO_E2E: "1", PISTACHIO_USER_DATA: userData },
  });
  const shell = await shellReady(app);
  await expect
    .poll(() =>
      app.evaluate(
        ({ webContents }, pageUrl) => webContents.getAllWebContents().some((contents) => contents.getURL() === pageUrl && !contents.isLoading()),
        pageUrl,
      ),
    )
    .toBe(true);
  return {
    app,
    shell,
    pageUrl,
    close: async () => {
      await app.close();
      server.close();
    },
  };
}

/** Run a script in the meeting's page as its own share button would, with a click's activation. */
function inMeeting<T>(meeting: Meeting, script: string, url = meeting.pageUrl): Promise<T> {
  return meeting.app.evaluate(
    async ({ webContents }, { url, script }) => {
      const tab = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
      if (tab === undefined) throw new Error(`No tab is showing ${url}`);
      return tab.executeJavaScript(script, true);
    },
    { url, script },
  ) as Promise<T>;
}

/** Share: the stand-in picker hands the page its own tab, and the page keeps the stream and counts its `ended` events. */
async function startShare(meeting: Meeting): Promise<void> {
  await meeting.app.evaluate(({ webContents }, url) => {
    const tab = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
    if (tab === undefined) throw new Error(`No tab is showing ${url}`);
    tab.session.setDisplayMediaRequestHandler((request, callback) => callback(request.frame === null ? {} : { video: request.frame }));
  }, meeting.pageUrl);
  const surface = await inMeeting<string>(
    meeting,
    `navigator.mediaDevices.getDisplayMedia({ video: true }).then((stream) => {
      window.__share = stream;
      window.__ended = 0;
      for (const track of stream.getTracks()) track.addEventListener("ended", () => { window.__ended += 1; });
      return stream.getVideoTracks()[0].getSettings().displaySurface;
    }, (error) => error.name)`,
  );
  expect(surface).toBe("browser");
}

function trackState(meeting: Meeting): Promise<{ readyState: string; ended: number }> {
  return inMeeting(meeting, `({ readyState: window.__share.getVideoTracks()[0].readyState, ended: window.__ended })`);
}

test("the sidebar says a tab is sharing, and stops it", async () => {
  const meeting = await openMeeting({ mode: "sidebar", sidebar: "pinned" }, "sidebar");
  const { shell } = meeting;
  try {
    const card = shell.getByTestId("screen-share-card");
    const tabMark = shell.locator('[data-testid^="tab-screen-share-mark-"]');
    await expect(card).toHaveCount(0);
    await expect(tabMark).toHaveCount(0);
    // What the page sees of the watcher: the built-in, by name and by source.
    expect(
      await inMeeting(meeting, `[navigator.mediaDevices.getDisplayMedia.name, Function.prototype.toString.call(MediaStreamTrack.prototype.stop)]`),
    ).toEqual(["getDisplayMedia", expect.stringContaining("[native code]")]);

    await startShare(meeting);
    await expect(card).toBeVisible();
    await expect(card).toContainText("Sharing a tab");
    await expect(card).toContainText(`with ${new URL(meeting.pageUrl).host}`);
    await expect(tabMark).toHaveCount(1);
    await expect(tabMark).toHaveAttribute("aria-label", "Sharing a tab");
    // The card sits clear of the last row: the list pads for it.
    const dock = await card.boundingBox();
    const footer = await shell.getByTestId("sidebar-chrome").locator(":scope > div").last().boundingBox();
    expect(dock).not.toBeNull();
    expect(dock!.y + dock!.height).toBeLessThanOrEqual(footer!.y);
    await shell.waitForTimeout(300);
    await captureShell(meeting.app, "01-sidebar-sharing.png");

    // Stop: every captured track stops, and the page hears it end as it would from a browser's own button.
    await card.getByTestId("screen-share-stop").click();
    await expect(card).toHaveCount(0);
    await expect(tabMark).toHaveCount(0);
    expect(await trackState(meeting)).toEqual({ readyState: "ended", ended: 1 });
    await captureShell(meeting.app, "02-sidebar-stopped.png");

    // The page's own stop takes the share down too.
    await startShare(meeting);
    await expect(card).toBeVisible();
    await inMeeting(meeting, `window.__share.getTracks().forEach((track) => track.stop())`);
    await expect(card).toHaveCount(0);

    // So does a clone outliving its original only once the clone stops.
    await startShare(meeting);
    await expect(card).toBeVisible();
    await inMeeting(meeting, `window.__clone = window.__share.getVideoTracks()[0].clone(); window.__share.getVideoTracks()[0].stop()`);
    await shell.waitForTimeout(300);
    await expect(card).toBeVisible();
    await inMeeting(meeting, `window.__clone.stop()`);
    await expect(card).toHaveCount(0);

    // A capture ends with its document: leaving the page leaves nothing shown.
    await startShare(meeting);
    await expect(card).toBeVisible();
    await inMeeting(meeting, `setTimeout(() => { location.href = "/elsewhere"; }, 0)`);
    await expect(card).toHaveCount(0);
    await expect(tabMark).toHaveCount(0);
  } finally {
    await meeting.close();
  }
});

test("the strip says a tab is sharing, and stops it", async () => {
  const meeting = await openMeeting({ mode: "top", sidebar: "pinned" }, "top");
  const { shell } = meeting;
  try {
    const pill = shell.getByTestId("screen-share-pill");
    await startShare(meeting);
    await expect(pill).toBeVisible();
    await expect(pill).toContainText("Sharing a tab");
    await expect(shell.locator('[data-testid^="tab-screen-share-mark-"]')).toHaveCount(1);
    // First in the trailing cluster, ahead of the strip's own buttons.
    const pillBox = await pill.boundingBox();
    const settingsBox = await shell.getByTestId("settings-button").boundingBox();
    expect(pillBox!.x).toBeLessThan(settingsBox!.x);
    await shell.waitForTimeout(300);
    await captureShell(meeting.app, "03-strip-sharing.png");

    await pill.getByTestId("screen-share-stop").click();
    await expect(pill).toHaveCount(0);
    expect(await trackState(meeting)).toEqual({ readyState: "ended", ended: 1 });
  } finally {
    await meeting.close();
  }
});

test("the hidden compact sidebar keeps a red handle, and a share that begins says so", async () => {
  const meeting = await openMeeting({ mode: "sidebar", sidebar: "compact" }, "compact");
  const { shell, app } = meeting;
  try {
    const edge = shell.getByTestId("sidebar-edge");
    await expect(edge).toBeVisible();
    await expect(edge).not.toHaveAttribute("data-screen-share", "");

    await startShare(meeting);
    await expect(edge).toHaveAttribute("data-screen-share", "");
    const notices = await noticePage(app);
    const notice = notices.getByTestId("notice-card");
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText(`Sharing a tab with ${new URL(meeting.pageUrl).host}`);
    await notices.waitForTimeout(450);
    await captureShell(app, "04-compact-sharing.png");
    // The notice is its own view over the page, which a window capture leaves out.
    await notices.screenshot({ path: join(screenshotDirectory, "05-compact-notice.png") });

    await notice.getByRole("button", { name: "Stop sharing" }).click();
    await expect(edge).not.toHaveAttribute("data-screen-share", "");
    expect(await trackState(meeting)).toEqual({ readyState: "ended", ended: 1 });
  } finally {
    await meeting.close();
  }
});
