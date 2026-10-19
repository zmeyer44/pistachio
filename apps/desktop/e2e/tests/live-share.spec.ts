import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect, test, type Browser, type BrowserContext, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { hostNameFrom } from "@pistachio/live-share";
import { IPC, type PistachioApi } from "@pistachio/shell-contracts/ipc";
import type { LiveDeskReport, LiveShareState } from "@pistachio/shell-contracts/live-share";
import { captureEnabled } from "./app";
import { chooseSpace, createGroup, createTab, launchDesk, railSpace, reachBar, selectSpace, settled, showFrame, snapshot, tabGroupCommand, windowSelector } from "./desk-harness";
import { linkToken } from "./live-host-harness";
import { BOARD_MARK, captureHost, NOTES_MARK, serveSharedPages, type SharedPages } from "./live-share-stack";
import { startLiveKit, type LiveKitServer } from "./livekit-harness";
import { chromiumPath, startWebStack, type WebStack } from "./web-harness";
import { noticePage } from "./windows";

/**
 * Live share end to end, as people use it (docs/live-share.md §1, §12): the
 * real Mac app hosting — a signed-out Mac's anonymous account on control,
 * the shell's own desk report, the live-host window's room — and the real
 * guest page from www, in a Chromium with a fake camera and microphone,
 * through a spawned `livekit-server`.
 *
 * The host shares a space of two windows from its menu; the guest opens the
 * link, knocks, and is let in from the Live card; they see both windows where
 * the host's desk has them, live (the window behind as well as the one in
 * use); pointers cross both ways (and the guest's is timed to the host's
 * screen); ink, laser and clearing; faces and mute; chat and reactions; the
 * guest asks for a window, is allowed, clicks, types and scrolls on it —
 * nothing reaches the other window, nor anything while the host is in
 * another space; the desk follows the host's window and layout; and the host
 * removes the guest, lets a second in without knocking, and stops.
 *
 * The host has no camera here: Chromium's fake devices answer a tab capture
 * with "Requested device not found", and this Mac may have none — the host's
 * face is its initial. The host's pointer is main's cursor source
 * (`screen.getCursorScreenPoint`), stubbed: Playwright cannot move the OS
 * pointer. Skipped without `livekit-server` on PATH.
 */

type Bridge = { pistachio: PistachioApi };
type Box = { x: number; y: number; width: number; height: number };
type Rect = { x: number; y: number; w: number; h: number };

const SPACE = "space-live-e2e";
const SPACE_TITLE = "Launch plan";
/** A space to step away to: empty, as a space may be. */
const ELSEWHERE = "space-elsewhere";
const shots = join(process.cwd(), "e2e/screenshots/live-share");

const liveShare = (shell: Page): Promise<LiveShareState> => shell.evaluate(() => (window as unknown as Bridge).pistachio.getLiveShare());
const command = (shell: Page, body: Parameters<PistachioApi["liveShare"]>[0]): Promise<void> => shell.evaluate((input) => (window as unknown as Bridge).pistachio.liveShare(input), body);

/** Run in a tab's page, found by its address. */
function inPage<T>(app: ElectronApplication, url: string, script: string): Promise<T> {
  return app.evaluate(
    async ({ webContents }, { url, script }) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
      if (contents === undefined) throw new Error(`no page at ${url}`);
      return (await contents.executeJavaScript(script)) as T;
    },
    { url, script },
  ) as Promise<T>;
}

/** The browser's window (not the live-host one) and its content box. */
function mainContent(app: ElectronApplication): Promise<Electron.Rectangle> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().endsWith("#live-host"))!.getContentBounds());
}

/** The OS pointer as main reads it, at this point of the browser window's content box, from now on. */
function hostPointerAt(app: ElectronApplication, x: number, y: number): Promise<void> {
  return app.evaluate(
    ({ BrowserWindow, screen }, at) => {
      const main = BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().endsWith("#live-host"))!;
      const state = globalThis as unknown as { __livePointer?: { x: number; y: number } };
      state.__livePointer = at;
      screen.getCursorScreenPoint = () => {
        const content = main.getContentBounds();
        return { x: Math.round(content.x + state.__livePointer!.x), y: Math.round(content.y + state.__livePointer!.y) };
      };
    },
    { x, y },
  );
}

/** Every desk report the shell sent main, as main's own listener heard it (the latest last). */
function reports(app: ElectronApplication): Promise<Array<LiveDeskReport | null>> {
  return app.evaluate(() => (globalThis as unknown as { __liveDeskReports: Array<LiveDeskReport | null> }).__liveDeskReports);
}

/** The shared desk as the shell last reported it at rest. */
async function settledDesk(app: ElectronApplication): Promise<LiveDeskReport> {
  let found: LiveDeskReport | null = null;
  await expect
    .poll(async () => {
      const last = (await reports(app)).at(-1) ?? null;
      found = last !== null && last.groupId === SPACE && last.settled ? last : null;
      return found !== null;
    })
    .toBe(true);
  return found!;
}

/** The guest's stage and each window's page box, in client px. */
function guestDesk(guest: Page): Promise<{ stage: Box; pages: Record<string, Box> } | null> {
  return guest.evaluate(() => {
    const box = (element: Element): Box => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const stage = document.querySelector('[data-testid="live-stage"]');
    if (stage === null) return null;
    const pages: Record<string, Box> = {};
    for (const window of document.querySelectorAll<HTMLElement>("[data-window]")) {
      const page = window.querySelector("[data-page]");
      if (page !== null) pages[window.dataset["window"] ?? ""] = box(page);
    }
    return { stage: box(stage), pages };
  });
}

/** How far (the largest of x, y, w, h, as a share of the stage) the guest's page box is from the host's. */
function placeError(guest: { stage: Box; page: Box }, host: { stage: { w: number; h: number }; page: Rect }): number {
  const { stage, page } = guest;
  return Math.max(
    Math.abs((page.x - stage.x) / stage.width - host.page.x / host.stage.w),
    Math.abs((page.y - stage.y) / stage.height - host.page.y / host.stage.h),
    Math.abs(page.width / stage.width - host.page.w / host.stage.w),
    Math.abs(page.height / stage.height - host.page.h / host.stage.h),
  );
}

/** A window's video on the guest: its size and the frames it has shown. */
function guestVideo(guest: Page, windowId: string): Promise<{ width: number; height: number; frames: number } | null> {
  return guest.evaluate((id) => {
    const video = document.querySelector<HTMLVideoElement>(`[data-window="${CSS.escape(id)}"] video`);
    if (video === null) return null;
    return { width: video.videoWidth, height: video.videoHeight, frames: video.getVideoPlaybackQuality().totalVideoFrames };
  }, windowId);
}

/** The colour of one point (fractions of the picture) of a window's video, as the guest's browser decodes it. */
function videoColor(guest: Page, windowId: string, fx: number, fy: number): Promise<[number, number, number] | null> {
  return guest.evaluate(
    ([id, x, y]) => {
      const video = document.querySelector<HTMLVideoElement>(`[data-window="${CSS.escape(id)}"] video`);
      if (video === null || video.videoWidth === 0) return null;
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(video, 0, 0);
      const data = context.getImageData(Math.round(x * (canvas.width - 1)), Math.round(y * (canvas.height - 1)), 1, 1).data;
      return [data[0]!, data[1]!, data[2]!] as [number, number, number];
    },
    [windowId, fx, fy] as const,
  );
}

/** A window's video as the guest's browser decodes it now, as a PNG. */
async function videoFrame(guest: Page, windowId: string): Promise<Buffer | null> {
  const url = await guest.evaluate((id) => {
    const video = document.querySelector<HTMLVideoElement>(`[data-window="${CSS.escape(id)}"] video`);
    if (video === null || video.videoWidth === 0) return null;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    return canvas.toDataURL("image/png");
  }, windowId);
  return url === null ? null : Buffer.from(url.split(",")[1]!, "base64");
}

const near = (color: readonly number[] | null, mark: readonly number[]): boolean => color !== null && color.every((channel, index) => Math.abs(channel - mark[index]!) <= 48);

/** The largest alpha of a page's ink (its settled and its live canvas, each over the stage) around a stage-normalized point. */
function inkAlpha(page: Page, x: number, y: number): Promise<number> {
  return page.evaluate(
    ([px, py]) => {
      let alpha = 0;
      for (const canvas of document.querySelectorAll<HTMLCanvasElement>(".lv-ink-canvas")) {
        const context = canvas.getContext("2d");
        if (context === null || canvas.width === 0) continue;
        const data = context.getImageData(Math.round(px * canvas.width) - 4, Math.round(py * canvas.height) - 4, 9, 9).data;
        for (let index = 3; index < data.length; index += 4) alpha = Math.max(alpha, data[index]!);
      }
      return alpha;
    },
    [x, y] as const,
  );
}

/** A cursor's tip in its layer, from its transform. */
async function cursorTip(cursor: Locator): Promise<{ x: number; y: number }> {
  const matrix = await cursor.evaluate((node) => new DOMMatrix(getComputedStyle(node).transform));
  return { x: matrix.e, y: matrix.f };
}

test.describe.serial("live share end to end: the Mac hosts a space, a browser joins it", { tag: ["@web", "@share"] }, () => {
  let livekit: LiveKitServer | undefined;
  let stack: WebStack | undefined;
  let pages: SharedPages | undefined;
  let browser: Browser | undefined;
  let app: ElectronApplication | undefined;
  let shell: Page;
  let host: Page;
  let guestContext: BrowserContext;
  let guest: Page;
  let compositor: Page;
  let board: string;
  let notes: string;
  let link: string;
  let hostName: string;
  let guestId: string;
  let desk: LiveDeskReport;

  const card = (): Locator => shell.getByTestId("live-card");
  const guestRoot = (): Locator => guest.getByTestId("live-guest");
  const boardWindow = (): Locator => guest.locator(`[data-window="${board}"]`);
  const notesWindow = (): Locator => guest.locator(`[data-window="${notes}"]`);

  /** The Live card, up. */
  async function openCard(): Promise<void> {
    if ((await card().count()) > 0 && (await card().getAttribute("data-shown")) !== null) return;
    await shell.getByTestId("space-live").click();
    await expect(card()).toHaveAttribute("data-shown", "");
  }

  async function closeCard(): Promise<void> {
    if ((await card().count()) === 0) return;
    await shell.keyboard.press("Escape");
    await expect(card()).toHaveCount(0);
  }

  /** The host passes to another space (the rail's tile; the space made the first time). */
  async function stepAway(): Promise<void> {
    if ((await snapshot(shell)).tabGroups.some((group) => group.id === ELSEWHERE)) await railSpace(shell, ELSEWHERE).click();
    else await tabGroupCommand(shell, { type: "create", id: ELSEWHERE, tabIds: [], title: "Elsewhere", select: true });
    await expect.poll(async () => (await snapshot(shell)).currentGroupId).toBe(ELSEWHERE);
  }

  /** Both sides, as each person sees them, for the reviewer. */
  async function picture(name: string): Promise<void> {
    if (!captureEnabled || app === undefined) return;
    await guest.screenshot({ path: join(shots, `${name}-guest.png`) });
    await captureHost(app, compositor, join(shots, `${name}-host.png`));
  }

  /** A point of a window's page, as fractions of it, in the guest's client px. */
  async function onGuestPage(windowId: string, fx: number, fy: number): Promise<[number, number]> {
    const box = (await guestDesk(guest))!.pages[windowId]!;
    return [box.x + box.width * fx, box.y + box.height * fy];
  }

  /** Where an element of the board's page is, as fractions of the page. */
  function boardSpot(selector: string): Promise<{ x: number; y: number }> {
    return inPage(app!, pages!.board, `(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: (box.left + box.width / 2) / innerWidth, y: (box.top + box.height / 2) / innerHeight }; })()`);
  }

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    livekit = await startLiveKit();
    stack = await startWebStack({
      chromium: chromiumPath(),
      name: "live-e2e",
      apps: ["www"],
      livekit: { url: livekit.url, apiKey: livekit.apiKey, apiSecret: livekit.apiSecret },
    });
    // The guest's route is compiled by Next's dev server on its first visit: started now, it is ready sooner.
    void fetch(`${stack.urls.www}/live/warming-up`).catch(() => undefined);
    const served = await serveSharedPages();
    pages = served;

    // The Mac: accounts on (a signed-out Mac's anonymous one, made by this control), as hosting needs. No fake devices.
    ({ app, shell } = await launchDesk({
      name: "live-share-e2e",
      homeUrl: served.board,
      args: ["--use-mock-keychain"],
      env: { PISTACHIO_E2E: "0", PISTACHIO_CONTROL_URL: stack.controlUrl, PISTACHIO_ANONYMOUS: "1" },
    }));
    // A space of two windows: the board, and the notes made in it (out on its desk as the window in use).
    const boardTab = (await snapshot(shell)).tabs.find((tab) => tab.url === served.board)!.id;
    await createGroup(shell, SPACE, [boardTab], SPACE_TITLE, "green");
    await selectSpace(shell, SPACE, boardTab);
    await createTab(shell, served.notes);
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === SPACE)?.tabIds.length).toBe(2);
    // The tab ids are the windows' ids in the room.
    const tabs = (await snapshot(shell)).tabs;
    board = tabs.find((tab) => tab.url === served.board)!.id;
    notes = tabs.find((tab) => tab.url === served.notes)!.id;
    await expect(shell.locator(windowSelector(notes))).toHaveCount(1);
    await settled(shell, app);
    // The notes fill the desk, so the board lies wholly under them: covered, its still on the Mac…
    await showFrame(shell, windowSelector(notes));
    await shell.locator(windowSelector(notes)).getByRole("button", { name: "Fill the desk" }).click();
    await settled(shell, app);
    // …and asleep, as a covered window is once its page has been let go: put to sleep from another space, and
    // still asleep back on this one (the desk wakes only what shows). Sharing must wake it, and its page be seen.
    await stepAway();
    // (Refused while the desk is still passing from the space, its windows on their way home: asked again until it sleeps.)
    await expect
      .poll(async () => {
        await shell.evaluate((tabId) => (window as unknown as Bridge).pistachio.suspendTab(tabId), board);
        return (await snapshot(shell)).tabs.find((tab) => tab.id === board)?.lifecycle;
      })
      .toBe("suspended");
    await chooseSpace(shell, SPACE);
    await settled(shell, app);
    expect((await snapshot(shell)).tabs.find((tab) => tab.id === board)?.lifecycle).toBe("suspended");
    // What the shell tells main of the desk, heard beside main's own listener.
    await app.evaluate(({ ipcMain }, channel) => {
      const heard: unknown[] = [];
      (globalThis as unknown as { __liveDeskReports: unknown[] }).__liveDeskReports = heard;
      ipcMain.on(channel, (_event, body: unknown) => {
        heard.push(body);
        if (heard.length > 400) heard.shift();
      });
    }, IPC.liveDeskSet);

    browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
    guestContext = await browser.newContext({ permissions: ["camera", "microphone"], viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    guest = await guestContext.newPage();
    guest.on("pageerror", (error) => console.info(`[guest] ${error.message}`));
    compositor = await (await browser.newContext()).newPage();
  });

  test.afterAll(async () => {
    await app?.close();
    await browser?.close();
    await pages?.close();
    await stack?.close();
    await livekit?.stop();
  });

  test("the host shares the space from its menu: the Live card is up with the link copied, and the room is joined", async () => {
    test.setTimeout(90_000);
    await railSpace(shell, SPACE).click({ button: "right" });
    await shell.locator('[data-testid="context-menu"] [data-testid="space-share-live"]').click();
    await expect(card()).toHaveAttribute("data-status", "live", { timeout: 20_000 });
    const share = await liveShare(shell);
    expect(share.groupId).toBe(SPACE);
    expect(share.link).toMatch(/\/live\/[A-Za-z0-9_-]{43}$/u);
    expect(await app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(share.link);
    await expect(card().getByTestId("live-link-note")).toContainText("Link copied");
    // Control builds links on the production site; the guest opens this stack's www with the same token.
    link = `${stack!.urls.www}/live/${linkToken(share.link!)}`;
    const info = (await (await fetch(`${stack!.controlUrl}/v1/live/join/${linkToken(share.link!)}`)).json()) as { title: string; hostName: string | null };
    expect(info.title).toBe(SPACE_TITLE);
    // Guests know the host by the Mac's own name ("Zach's MacBook Pro" → Zach), as macOS has it — not the network name.
    const named = hostNameFrom(execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim());
    expect(info.hostName).toBe(named);
    hostName = info.hostName ?? "the host";

    await expect.poll(() => app!.windows().some((page) => page.url().endsWith("#live-host"))).toBe(true);
    host = app!.windows().find((page) => page.url().endsWith("#live-host"))!;
    host.on("console", (message) => {
      if (message.text().startsWith("[live-host]")) console.info(message.text());
    });
    // (A first join that times out — LiveKit gives the signal connection 15 s — is joined again a second later.)
    await expect(host.getByTestId("live-host")).toHaveAttribute("data-connection", "connected", { timeout: 45_000 });
    await expect.poll(async () => (await liveShare(shell)).connection).toBe("connected");
    // The shell reports the desk on its own; the host is on it.
    desk = await settledDesk(app!);
    expect(new Set(desk.windows.map((window) => window.id))).toEqual(new Set([board, notes]));
    await expect(host.getByTestId("live-host")).toHaveAttribute("data-present", "");
    await expect(host.getByTestId("live-host-pill")).toBeVisible();
    // (Put away: a knock is a notice only while the card does not show it.)
    await closeCard();
  });

  test("the guest opens the link, knocks from the lobby, and the host admits them from the Live card", async () => {
    test.setTimeout(300_000);
    // The first visit compiles the route in Next's dev server.
    await guest.goto(link, { timeout: 240_000 });
    await expect(guestRoot()).toHaveAttribute("data-screen", "lobby", { timeout: 180_000 });
    await expect(guest.getByRole("heading", { name: SPACE_TITLE })).toBeVisible();
    await expect(guest.getByText(`${hostName} is sharing`)).toBeVisible();
    await guest.getByLabel("Your name").fill("Ana");
    await guest.getByRole("button", { name: "Ask to join" }).click();
    await expect(guestRoot()).toHaveAttribute("data-screen", "knocking");
    await expect(guest.getByRole("heading", { name: `Waiting for ${hostName} to let you in` })).toBeVisible();

    // The knock reaches the host through the room, confirmed by the lobby: a row in the state, and a notice.
    await expect.poll(async () => (await liveShare(shell)).knocks.map((knock) => knock.name), { timeout: 10_000 }).toEqual(["Ana"]);
    const notices = await noticePage(app!);
    await expect(notices.getByTestId("notice-card").filter({ hasText: "Ana wants to join" })).toBeVisible();
    await openCard();
    await card().getByTestId("live-knock").filter({ hasText: "Ana" }).getByTestId("live-admit").click();
    await expect(guestRoot()).toHaveAttribute("data-screen", "room", { timeout: 30_000 });
    await expect.poll(async () => (await liveShare(shell)).participants.map((guest) => guest.name), { timeout: 15_000 }).toEqual(["Ana"]);
    guestId = (await liveShare(shell)).participants[0]!.identity;
    expect((await liveShare(shell)).knocks).toEqual([]);
    await expect(card().getByTestId("live-person")).toContainText("Ana");
    await expect(host.getByTestId("live-host")).toHaveAttribute("data-guests", "1");
    await closeCard();
  });

  test("the guest sees both windows where the host's desk has them, each live at its page's shape — the one behind too", async () => {
    test.setTimeout(60_000);
    await expect(boardWindow()).toBeVisible({ timeout: 20_000 });
    await expect(notesWindow()).toBeVisible();
    desk = await settledDesk(app!);
    for (const [windowId, mark] of [
      [board, BOARD_MARK],
      [notes, NOTES_MARK],
    ] as const) {
      const hostWindow = desk.windows.find((window) => window.id === windowId)!;
      // At the host's place, as a share of the stage.
      await expect.poll(async () => {
        const seen = await guestDesk(guest);
        const page = seen?.pages[windowId];
        return seen === null || page === undefined ? 1 : placeError({ stage: seen.stage, page }, { stage: desk.stage, page: hostWindow.page });
      }).toBeLessThan(0.005);
      // Live: frames keep coming, at the page box's shape.
      await expect.poll(async () => (await guestVideo(guest, windowId))?.width ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
      const before = (await guestVideo(guest, windowId))!.frames;
      await expect.poll(async () => (await guestVideo(guest, windowId))!.frames, { timeout: 10_000 }).toBeGreaterThan(before + 10);
      const video = (await guestVideo(guest, windowId))!;
      console.info(`[live-share] ${windowId === board ? "board" : "notes"}: guest video ${String(video.width)}×${String(video.height)} for a ${String(hostWindow.page.w)}×${String(hostWindow.page.h)} page box`);
      expect(Math.abs(video.width / video.height / (hostWindow.page.w / hostWindow.page.h) - 1)).toBeLessThan(0.02);
      // And the page's own picture, not a blank: its marker's colour where the page has it (clear of its lettering).
      let seenColor: [number, number, number] | null = null;
      const marked = expect.poll(async () => near((seenColor = await videoColor(guest, windowId, 0.06, 0.06)), mark), { message: `the ${windowId === board ? "board" : "notes"}'s marker` }).toBe(true);
      await marked.finally(async () => {
        console.info(`[live-share] ${windowId === board ? "board" : "notes"}: the guest's video shows ${JSON.stringify(seenColor)} where the page's marker is ${JSON.stringify(mark)}`);
        const frame = await videoFrame(guest, windowId);
        if (frame !== null && captureEnabled) {
          await mkdir(shots, { recursive: true });
          await writeFile(join(shots, `03-${windowId === board ? "board" : "notes"}-video-frame.png`), frame);
        }
      });
    }
    // The board was the one under the notes, asleep until the share woke it.
    expect(desk.windows.map((window) => window.id)).toEqual([board, notes]);
    await picture("03-both-windows");

    // Side by side (the space's layout, in its card): the board comes out from under, and the guest's desk follows.
    await shell.locator('[data-testid="layout-option"][data-kind="halves"]').click();
    await settled(shell, app!);
    await expect.poll(async () => {
      const now = await settledDesk(app!);
      const seen = await guestDesk(guest);
      if (seen === null) return 1;
      return Math.max(...now.windows.map((window) => (seen.pages[window.id] === undefined ? 1 : placeError({ stage: seen.stage, page: seen.pages[window.id]! }, { stage: now.stage, page: window.page }))));
    }).toBeLessThan(0.005);
    desk = await settledDesk(app!);
    const [left, right] = desk.windows.map((window) => window.page).sort((a, b) => a.x - b.x);
    expect(left!.x + left!.w).toBeLessThanOrEqual(right!.x);
    // The notes, half as wide now, are captured afresh and published again: the guest shows the new picture, at its new shape.
    const narrowed = desk.windows.find((window) => window.id === notes)!.page;
    await expect
      .poll(async () => {
        const video = await guestVideo(guest, notes);
        if (video === null || video.width === 0 || Math.abs(video.width / video.height / (narrowed.w / narrowed.h) - 1) >= 0.02) return false;
        return near(await videoColor(guest, notes, 0.06, 0.06), NOTES_MARK);
      }, { timeout: 15_000 })
      .toBe(true);
    const shown = (await guestVideo(guest, notes))!.frames;
    await expect.poll(async () => (await guestVideo(guest, notes))?.frames ?? 0).toBeGreaterThan(shown + 10);
    await picture("03b-side-by-side");
  });

  test("pointers: the host's reaches the guest, the guest's the live-host window — and how long the guest's takes", async () => {
    test.setTimeout(90_000);
    desk = await settledDesk(app!);
    const stage = desk.stageInWindow;
    // The host's pointer over the stage, as main reads the OS pointer.
    await hostPointerAt(app!, stage.x + stage.w * 0.4, stage.y + stage.h * 0.35);
    const hostCursor = guest.locator('.lv-cursor[data-cursor="host"]');
    await expect(hostCursor).toBeVisible({ timeout: 10_000 });
    await expect(hostCursor.locator(".lv-cursor-name")).toHaveText(hostName);
    await expect
      .poll(async () => {
        const seen = (await guestDesk(guest))!.stage;
        const box = (await hostCursor.boundingBox())!;
        return [Math.round(((box.x - seen.x) / seen.width) * 100), Math.round(((box.y - seen.y) / seen.height) * 100)];
      })
      .toEqual([40, 35]);

    // The guest's pointer over the stage shows in the live-host window where it is on theirs, with their name.
    const seen = (await guestDesk(guest))!.stage;
    const at = (x: number, y: number): [number, number] => [seen.x + seen.width * x, seen.y + seen.height * y];
    await guest.mouse.move(...at(0.5, 0.5));
    const guestCursor = host.locator(`.lv-cursor[data-cursor="${guestId}"]`);
    await expect(guestCursor).toHaveCount(1);
    await expect(guestCursor.locator(".lv-cursor-name")).toHaveText("Ana");
    const onHost = (x: number, y: number): { x: number; y: number } => ({ x: stage.x + stage.w * x, y: stage.y + stage.h * y });
    await expect.poll(async () => {
      const tip = await cursorTip(guestCursor);
      const want = onHost(0.5, 0.5);
      return Math.round(Math.hypot(tip.x - want.x, tip.y - want.y));
    }).toBeLessThanOrEqual(2);

    // Latency, guest → host: from the guest's pointermove to the live-host window drawing the pointer's first step toward it.
    await guest.evaluate(() => {
      const state = window as unknown as { __moves: number[] };
      state.__moves = [];
      addEventListener("pointermove", () => state.__moves.push(performance.timeOrigin + performance.now()), true);
    });
    await host.evaluate((identity) => {
      const state = window as unknown as { __draws: Array<{ at: number; x: number; y: number }> };
      state.__draws = [];
      const node = document.querySelector<HTMLElement>(`.lv-cursor[data-cursor="${CSS.escape(identity)}"]`)!;
      new MutationObserver(() => {
        const [x, y] = (/translate3d\(([-\d.]+)px, ([-\d.]+)px/u.exec(node.style.transform) ?? []).slice(1).map(Number);
        if (x !== undefined && y !== undefined) state.__draws.push({ at: performance.timeOrigin + performance.now(), x, y });
      }).observe(node, { attributes: true, attributeFilter: ["style"] });
    }, guestId);
    const latencies: number[] = [];
    for (let move = 0; move < 21; move += 1) {
      const target = { x: move % 2 === 0 ? 0.3 : 0.7, y: 0.3 + (move % 7) * 0.05 };
      const settledAt = await host.evaluate(() => (window as unknown as { __draws: unknown[] }).__draws.length);
      const before = await cursorTip(guestCursor);
      const want = onHost(target.x, target.y);
      const moves = await guest.evaluate(() => (window as unknown as { __moves: number[] }).__moves.length);
      await guest.mouse.move(...at(target.x, target.y));
      // Drawn there, and still: the next move starts from rest.
      await expect.poll(async () => {
        const tip = await cursorTip(guestCursor);
        return Math.hypot(tip.x - want.x, tip.y - want.y) <= 1.5;
      }).toBe(true);
      const sent = await guest.evaluate((from) => (window as unknown as { __moves: number[] }).__moves[from], moves);
      // The first draw that set off toward this move (the tail of the last glide is a fraction of a px from where it was).
      const drawn = await host.evaluate(
        ([from, was, to]) => {
          const away = (point: { x: number; y: number }): number => Math.hypot(point.x - to.x, point.y - to.y);
          return (window as unknown as { __draws: Array<{ at: number; x: number; y: number }> }).__draws.slice(from).find((draw) => away(draw) < away(was) - 2)?.at;
        },
        [settledAt, before, want] as const,
      );
      // (The first move warms the path up; it is not counted.)
      if (move > 0 && sent !== undefined && drawn !== undefined) latencies.push(drawn - sent);
    }
    latencies.sort((a, b) => a - b);
    const median = latencies[Math.floor(latencies.length / 2)]!;
    console.info(`[live-share] guest → host pointer latency over ${String(latencies.length)} moves: median ${median.toFixed(1)} ms, min ${latencies[0]!.toFixed(1)} ms, max ${latencies.at(-1)!.toFixed(1)} ms`);
    expect(latencies.length).toBeGreaterThanOrEqual(18);
    expect(latencies[0]).toBeGreaterThan(0);
    expect(median).toBeLessThan(100);
  });

  test("ink: a guest's stroke shows on the host, the host's on the guest; the laser fades; clear-mine and clear-all", async () => {
    test.setTimeout(60_000);
    const seen = (await guestDesk(guest))!.stage;
    const at = (x: number, y: number): [number, number] => [seen.x + seen.width * x, seen.y + seen.height * y];
    // The guest's pen.
    await guest.keyboard.press("d");
    await expect(guest.getByRole("radio", { name: "Pen" })).toBeChecked();
    await guest.mouse.move(...at(0.2, 0.75));
    await guest.mouse.down();
    for (let step = 1; step <= 16; step += 1) await guest.mouse.move(...at(0.2 + step * 0.015, 0.75 - Math.sin(step / 3) * 0.05));
    await guest.mouse.up();
    await expect(host.getByTestId("live-host")).toHaveAttribute("data-strokes", "1");

    // The host's pen, from /draw in the Bar, drawn over the desk in the live-host window.
    await reachBar(shell);
    await shell.getByTestId("desk-bar-input").fill("/draw");
    await shell.getByTestId("desk-bar-input").press("Enter");
    await expect(host.getByTestId("live-host")).toHaveAttribute("data-drawing", "pen");
    desk = await settledDesk(app!);
    const stage = desk.stageInWindow;
    const onHost = (x: number, y: number): [number, number] => [stage.x + stage.w * x, stage.y + stage.h * y];
    const hostStroke: Array<[number, number]> = [];
    for (let step = 0; step <= 14; step += 1) hostStroke.push([0.55 + step * 0.02, 0.6 + Math.cos(step / 3) * 0.05]);
    await host.mouse.move(...onHost(...hostStroke[0]!));
    await host.mouse.down();
    for (const point of hostStroke.slice(1)) await host.mouse.move(...onHost(...point));
    await host.mouse.up();
    await expect(host.getByTestId("live-host")).toHaveAttribute("data-strokes", "2");
    const [hx, hy] = hostStroke[7]!;
    await expect.poll(() => inkAlpha(guest, hx, hy)).toBeGreaterThan(200);
    await picture("05-ink");
    await host.keyboard.press("Escape");
    await expect.poll(async () => (await liveShare(shell)).drawing).toBeNull();

    // The laser: drawn on the host's desk, then gone of itself (1.2 s from its last point).
    await guest.keyboard.press("l");
    await expect(guest.getByRole("radio", { name: "Laser" })).toBeChecked();
    await guest.mouse.move(...at(0.3, 0.2));
    await guest.mouse.down();
    for (let step = 1; step <= 10; step += 1) await guest.mouse.move(...at(0.3 + step * 0.02, 0.2));
    await guest.mouse.up();
    await expect(host.getByTestId("live-host")).toHaveAttribute("data-strokes", "3");
    await expect.poll(() => inkAlpha(host, 0.4, 0.2), { intervals: [50] }).toBeGreaterThan(0);
    await expect.poll(() => inkAlpha(host, 0.4, 0.2), { timeout: 5_000 }).toBe(0);
    await expect.poll(() => inkAlpha(guest, 0.4, 0.2), { timeout: 5_000 }).toBe(0);

    // Clear mine takes the guest's own stroke off every board, the host's stays; the host's Clear all takes the rest.
    await guest.getByRole("button", { name: "Clear my ink" }).click();
    await expect(host.getByTestId("live-host")).toHaveAttribute("data-strokes", "1");
    expect(await inkAlpha(guest, hx, hy)).toBeGreaterThan(200);
    await openCard();
    await card().getByTestId("live-clear-ink").click();
    await expect(host.getByTestId("live-host")).toHaveAttribute("data-strokes", "0");
    await expect.poll(() => inkAlpha(guest, hx, hy)).toBe(0);
    await closeCard();
    await guest.keyboard.press("p");
    await expect(guest.getByRole("radio", { name: "Pointer" })).toBeChecked();
  });

  test("faces: the guest's camera is a face on the host, the host's an initial on the guest; the guest's mute shows on the host", async () => {
    test.setTimeout(60_000);
    const face = host.locator(`.lv-face[data-face="${guestId}"]`);
    await expect(face).toHaveAttribute("data-camera", "");
    const playing = (): Promise<{ width: number; time: number }> => face.locator("video").evaluate((video: HTMLVideoElement) => ({ width: video.videoWidth, time: video.currentTime }));
    await expect.poll(async () => (await playing()).width, { timeout: 15_000 }).toBeGreaterThan(0);
    const first = (await playing()).time;
    await expect.poll(async () => (await playing()).time).toBeGreaterThan(first);
    expect((await liveShare(shell)).participants[0]).toMatchObject({ cameraOn: true, micOn: true });

    // The host has no camera: an initial on their colour.
    const hostFace = guest.locator('.lvg-faces .lv-face[data-face="host"]');
    await expect(hostFace).toBeVisible();
    await expect(hostFace).not.toHaveAttribute("data-camera", /.*/);
    await expect(hostFace.locator(".lv-face-initial")).toHaveText(hostName.slice(0, 1).toUpperCase());

    // Muted on the guest's side: the host's state and the face's slashed mic; and back.
    await guest.getByRole("button", { name: "Microphone on" }).click();
    await expect(guest.getByRole("button", { name: "Microphone off" })).toBeVisible();
    await expect.poll(async () => (await liveShare(shell)).participants[0]?.micOn).toBe(false);
    await expect(face.locator(".lv-face-muted")).toBeVisible();
    await picture("06-faces-muted");
    await guest.getByRole("button", { name: "Microphone off" }).click();
    await expect.poll(async () => (await liveShare(shell)).participants[0]?.micOn).toBe(true);
    await expect(face.locator(".lv-face-muted")).toHaveCount(0);
  });

  test("chat and a reaction, both ways", async () => {
    await guest.getByRole("button", { name: "Chat", exact: true }).click();
    await guest.getByLabel("Message").fill("Can you open the pricing doc?");
    await guest.keyboard.press("Enter");
    await expect.poll(async () => (await liveShare(shell)).chat.map((message) => `${message.name}: ${message.text}`)).toEqual(["Ana: Can you open the pricing doc?"]);
    await openCard();
    await card().getByTestId("live-tab-chat").click();
    await expect(card().getByTestId("live-chat-message")).toContainText("Can you open the pricing doc?");
    await card().getByTestId("live-chat-input").fill("On it — one sec.");
    await card().getByTestId("live-chat-input").press("Enter");
    await expect(guest.locator(".lv-chat-message").filter({ hasText: "On it — one sec." })).toBeVisible();
    await card().getByTestId("live-tab-share").click();
    await closeCard();
    await guest.getByRole("button", { name: "Close chat" }).click();

    await guest.getByRole("button", { name: "React" }).click();
    await guest.getByRole("button", { name: "React 🎉" }).click();
    await expect(host.locator(".lv-reaction").filter({ hasText: "🎉" })).toHaveCount(1);
    await guest.keyboard.press("Escape");
    // (The host has no reaction control of its own; the shell's command is the way main is told.)
    await command(shell, { type: "react", emoji: "👏" });
    await expect(guest.locator(".lv-reaction").filter({ hasText: "👏" })).toHaveCount(1);
  });

  test("control: the guest asks for the board and is allowed; their click, typing and scrolling land on it — nothing on the notes, nothing while the host is away", async () => {
    test.setTimeout(90_000);
    // Asked from the window's label, allowed from the Live card.
    await boardWindow().locator(".lvg-window-tab").hover();
    await boardWindow().getByRole("button", { name: "Ask to use" }).click();
    await expect.poll(async () => (await liveShare(shell)).asks.map((ask) => [ask.name, ask.windowId])).toEqual([["Ana", board]]);
    await openCard();
    await card().getByTestId("live-ask").getByTestId("live-allow").click();
    await expect.poll(async () => (await liveShare(shell)).controllable).toEqual([board]);
    await closeCard();
    await expect(guest.getByText(`${hostName} let you use`)).toBeVisible();
    await expect(boardWindow()).toHaveAttribute("data-usable", "");

    // A click on the button counts on the Mac's page.
    const button = await boardSpot("#press");
    await guest.mouse.click(...(await onGuestPage(board, button.x, button.y)));
    await expect.poll(() => inPage<number>(app!, pages!.board, "window.__clicks")).toBe(1);
    await expect.poll(async () => (await liveShare(shell)).using).toEqual([{ windowId: board, identity: guestId }]);
    // Typing into the field.
    const field = await boardSpot("#field");
    await guest.mouse.click(...(await onGuestPage(board, field.x, field.y)));
    await expect.poll(() => inPage<string>(app!, pages!.board, "document.activeElement?.id ?? ''")).toBe("field");
    await guest.keyboard.type("hello");
    await expect.poll(() => inPage<string>(app!, pages!.board, `document.getElementById("field").value`)).toBe("hello");
    // Scrolling the area.
    const area = await boardSpot("#area");
    await guest.mouse.move(...(await onGuestPage(board, area.x, area.y)));
    await guest.mouse.wheel(0, 400);
    await expect.poll(() => inPage<number>(app!, pages!.board, `document.getElementById("area").scrollTop`)).toBeGreaterThan(100);
    await picture("08-guest-using-the-board");

    // The notes are not theirs: a click and a key there reach nothing. (Input is ordered: once a later click on
    // the board has landed, anything for the notes before it would have too.)
    desk = await settledDesk(app!);
    const boardBox = desk.windows.find((window) => window.id === board)!.frame;
    const notesBox = desk.windows.find((window) => window.id === notes)!.page;
    // A point of the notes no part of the board lies over.
    const free = [0.85, 0.5, 0.15].flatMap((fx) => [0.85, 0.5, 0.15].map((fy) => ({ fx, fy }))).find(({ fx, fy }) => {
      const x = notesBox.x + notesBox.w * fx;
      const y = notesBox.y + notesBox.h * fy;
      return !(x >= boardBox.x && x <= boardBox.x + boardBox.w && y >= boardBox.y && y <= boardBox.y + boardBox.h);
    });
    expect(free).toBeDefined();
    await guest.mouse.click(...(await onGuestPage(notes, free!.fx, free!.fy)));
    await guest.keyboard.type("x");
    await guest.mouse.click(...(await onGuestPage(board, button.x, button.y)));
    await expect.poll(() => inPage<number>(app!, pages!.board, "window.__clicks")).toBe(2);
    expect(await inPage<string[]>(app!, pages!.notes, "window.__events")).toEqual([]);

    // The host in another space: the guest is told, and their hands are off.
    await stepAway();
    await expect.poll(async () => (await liveShare(shell)).hostAway).toBe(true);
    await expect(guest.getByText(`${hostName} is in another space`)).toBeVisible();
    await expect(boardWindow()).not.toHaveAttribute("data-usable", "");
    // Their pointer is gone from the guest's desk at once (it belongs to the shared desk).
    await expect(guest.locator('.lv-cursor[data-cursor="host"]')).toHaveCount(0);
    await guest.mouse.click(...(await onGuestPage(board, button.x, button.y)));
    await picture("08b-host-away");
    await chooseSpace(shell, SPACE);
    await expect.poll(async () => (await liveShare(shell)).hostAway).toBe(false);
    await expect(guest.getByText(`${hostName} is in another space`)).toHaveCount(0);
    await expect(boardWindow()).toHaveAttribute("data-usable", "");
    // Back, a click lands — the one, not the one made while away.
    await guest.mouse.click(...(await onGuestPage(board, button.x, button.y)));
    await expect.poll(() => inPage<number>(app!, pages!.board, "window.__clicks")).toBe(3);
    // And their pointer shows again as it moves.
    desk = await settledDesk(app!);
    await hostPointerAt(app!, desk.stageInWindow.x + desk.stageInWindow.w * 0.6, desk.stageInWindow.y + desk.stageInWindow.h * 0.3);
    await expect(guest.locator('.lv-cursor[data-cursor="host"]')).toBeVisible();
  });

  test("the guest's desk follows the host's: the window resized, a window moved", async () => {
    test.setTimeout(60_000);
    const before = await settledDesk(app!);
    await app!.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().endsWith("#live-host"))!.setContentSize(1200, 860);
    });
    await expect.poll(async () => (await mainContent(app!)).width).toBe(1200);
    await settled(shell, app!);
    await expect.poll(async () => (await settledDesk(app!)).stage.w).not.toBe(before.stage.w);
    desk = await settledDesk(app!);
    const followed = async (): Promise<number> => {
      const seen = await guestDesk(guest);
      if (seen === null) return 1;
      const aspect = Math.abs(seen.stage.width / seen.stage.height - desk.stage.w / desk.stage.h);
      const places = desk.windows.map((window) => {
        const page = seen.pages[window.id];
        return page === undefined ? 1 : placeError({ stage: seen.stage, page }, { stage: desk.stage, page: window.page });
      });
      return Math.max(aspect, ...places);
    };
    await expect.poll(followed).toBeLessThan(0.006);

    // A window moved on the host (the space's layout chosen in its card) moves on the guest.
    const moved = JSON.stringify(desk.windows.map((window) => window.frame));
    for (const kind of ["focus", "stack", "cascade"]) {
      await shell.locator(`[data-testid="layout-option"][data-kind="${kind}"]`).click();
      await settled(shell, app!);
      desk = await settledDesk(app!);
      if (JSON.stringify(desk.windows.map((window) => window.frame)) !== moved) break;
    }
    expect(JSON.stringify(desk.windows.map((window) => window.frame))).not.toBe(moved);
    await expect.poll(followed).toBeLessThan(0.006);
  });

  test("the host removes the guest, who cannot come back by reloading; a second guest comes straight in; stopping ends it for good", async () => {
    test.setTimeout(120_000);
    // The request this tab holds (a reload rejoins with it while admitted).
    const held = await guest.evaluate(() => {
      for (let index = 0; index < sessionStorage.length; index += 1) {
        const value = sessionStorage.getItem(sessionStorage.key(index) ?? "") ?? "";
        if (value.includes('"secret"')) return JSON.parse(value) as { requestId: string; secret: string };
      }
      return null;
    });
    expect(held?.requestId).toBe(guestId.slice("g_".length));
    await openCard();
    await card().getByTestId("live-person").filter({ hasText: "Ana" }).getByTestId("live-person-more").click();
    await shell.getByTestId("live-remove").click();
    await expect(guestRoot()).toHaveAttribute("data-screen", "removed", { timeout: 15_000 });
    await expect(guest.getByRole("heading", { name: "You were removed from the share" })).toBeVisible();
    await expect.poll(async () => (await liveShare(shell)).participants).toEqual([]);
    // That request can mint no token again, and a reload does not bring them back: the page let it go, and shows the lobby.
    const asked = await fetch(`${stack!.controlUrl}/v1/live/join/${linkToken(link)}/requests/${held!.requestId}`, { headers: { authorization: `Bearer ${held!.secret}` } });
    expect(await asked.json()).toEqual({ status: "removed" });
    await guest.reload();
    await expect(guestRoot()).toHaveAttribute("data-screen", "lobby", { timeout: 60_000 });
    expect((await liveShare(shell)).participants).toEqual([]);

    // Anyone with the link: no knock.
    await card().getByTestId("live-admission").getByRole("radio", { name: "Anyone with the link" }).click();
    await expect.poll(async () => (await liveShare(shell)).admission).toBe("open");
    const second = await (await browser!.newContext({ permissions: ["camera", "microphone"], viewport: { width: 1280, height: 800 } })).newPage();
    await second.goto(link);
    await expect(second.getByTestId("live-guest")).toHaveAttribute("data-screen", "lobby", { timeout: 60_000 });
    await second.getByLabel("Your name").fill("Bo");
    await second.getByRole("button", { name: "Join", exact: true }).click();
    await expect(second.getByTestId("live-guest")).toHaveAttribute("data-screen", "room", { timeout: 30_000 });
    await expect.poll(async () => (await liveShare(shell)).participants.map((guest) => guest.name)).toEqual(["Bo"]);
    expect((await liveShare(shell)).knocks).toEqual([]);
    await expect(second.locator(`[data-window="${board}"] video`)).toBeVisible();

    // Stop: the guest sees it ended, and the link is dead.
    await card().getByTestId("live-stop").click();
    await expect.poll(async () => (await liveShare(shell)).status).toBe("idle");
    await expect(second.getByTestId("live-guest")).toHaveAttribute("data-screen", "ended", { timeout: 20_000 });
    await expect(second.getByRole("heading", { name: "This share has ended" })).toBeVisible();
    const third = await second.context().newPage();
    await third.goto(link);
    await expect(third.getByTestId("live-guest")).toHaveAttribute("data-screen", "ended", { timeout: 60_000 });
    await expect.poll(() => app!.windows().some((page) => page.url().endsWith("#live-host"))).toBe(false);
  });
});
