import { createServer, type Server } from "node:http";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { PistachioApi } from "@pistachio/shell-contracts/ipc";
import { noticePage, pageFirst, shellReady } from "./windows";
import { launchApp } from "./app";
import { capturePage, captureShell as captureWindowFrame, snapshot } from "./chrome-harness";

/**
 * While a tab shares the screen, the chrome says so and can stop it
 * (@pistachio/shell-contracts/screen-share): the sidebar's card, the sharing
 * tab's mark, and the hidden compact sidebar's red handle with a notice. macOS's picker would open over the whole
 * desktop, so each share here is the page's own tab, handed over by a
 * display-media handler that stands in for it — a real capture, whose track
 * the page holds and hears end, with no Screen Recording permission needed.
 * (How the page's own stop and a clone's are heard is
 * packages/shell-contracts/test/screen-share.test.ts's.)
 */

const FOLDER = "screen-share-indicator";

function captureShell(app: ElectronApplication, filename: string, settleMs = 0): Promise<void> {
  return captureWindowFrame(app, FOLDER, filename, settleMs);
}

interface Meeting {
  app: ElectronApplication;
  shell: Page;
  pageUrl: string;
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

/** The meeting page is open and done loading. */
async function meetingLoaded(meeting: Meeting): Promise<void> {
  await expect
    .poll(() =>
      meeting.app.evaluate(
        ({ webContents }, pageUrl) => webContents.getAllWebContents().some((contents) => contents.getURL() === pageUrl && !contents.isLoading()),
        meeting.pageUrl,
      ),
    )
    .toBe(true);
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

// One meeting, pinned: the sidebar's card and the tab's mark, then — with the
// sidebar made compact (⌘S) — the hidden sidebar's red handle and its notice.
test.describe.serial("a tab sharing the screen", { tag: ["@sidebar", "@media", "@notices"] }, () => {
  test.describe.configure({ timeout: 60_000 });
  let server: Server;
  let meeting: Meeting;

  test.beforeAll(async () => {
    server = createServer((request, response) => {
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
    const { app } = await launchApp({
      settings: pageFirst({ general: { homeUrl: pageUrl }, layout: { sidebar: "pinned" } }),
      files: { "site-permissions.json": { version: 1, sites: { [origin]: { "display-capture": "allow" } } } },
      name: "screen-share",
    });
    meeting = { app, shell: await shellReady(app), pageUrl };
    await meetingLoaded(meeting);
  });

  test.afterAll(async () => {
    await meeting?.app.close();
    server?.close();
  });

  test("the sidebar says a tab is sharing, and stops it", async () => {
    const { shell } = meeting;
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
    await captureShell(meeting.app, "01-sidebar-sharing.png", 300);

    // Stop: every captured track stops, and the page hears it end as it would from a browser's own button.
    await card.getByTestId("screen-share-stop").click();
    await expect(card).toHaveCount(0);
    await expect(tabMark).toHaveCount(0);
    expect(await trackState(meeting)).toEqual({ readyState: "ended", ended: 1 });
    await captureShell(meeting.app, "02-sidebar-stopped.png");

    // A capture ends with its document: leaving the page leaves nothing shown.
    await startShare(meeting);
    await expect(card).toBeVisible();
    await inMeeting(meeting, `setTimeout(() => { location.href = "/elsewhere"; }, 0)`);
    await expect(card).toHaveCount(0);
    await expect(tabMark).toHaveCount(0);
  });

  test("the hidden compact sidebar keeps a red handle, and a share that begins says so", async () => {
    const { shell, app } = meeting;
    // Back to the meeting, with the sidebar made compact.
    const tabId = (await snapshot(shell)).activeTabId;
    if (tabId === null) throw new Error("no active tab");
    await shell.evaluate(({ tabId, url }) => (window as unknown as { pistachio: PistachioApi }).pistachio.navigate(tabId, url), { tabId, url: meeting.pageUrl });
    await meetingLoaded(meeting);
    await shell.keyboard.press("Meta+s");
    const edge = shell.getByTestId("sidebar-edge");
    await expect(edge).toBeVisible();
    await expect(edge).not.toHaveAttribute("data-screen-share", "");

    await startShare(meeting);
    await expect(edge).toHaveAttribute("data-screen-share", "");
    const notices = await noticePage(app);
    const notice = notices.getByTestId("notice-card");
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText(`Sharing a tab with ${new URL(meeting.pageUrl).host}`);
    await captureShell(app, "03-compact-sharing.png", 450);
    // The notice is its own view over the page, which a window capture leaves out.
    await capturePage(notices, FOLDER, "05-compact-notice.png");

    await notice.getByRole("button", { name: "Stop sharing" }).click();
    await expect(edge).not.toHaveAttribute("data-screen-share", "");
    expect(await trackState(meeting)).toEqual({ readyState: "ended", ended: 1 });
  });
});
