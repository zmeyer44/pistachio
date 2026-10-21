import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { IPC, type PistachioApi } from "@pistachio/shell-contracts/ipc";
import type { LiveDeskReport, LiveHostReport, LiveShareState } from "@pistachio/shell-contracts/live-share";
import { captureEnabled } from "./app";
import { createGroup, createTab, fromFrameMenu, launchDesk, railHome, railSpace, reachBar, selectSpace, settled, snapshot, windowSelector } from "./desk-harness";
import { noticePage } from "./windows";

/**
 * Live share in the shell (docs/live-share.md §1, §6.4), in the real app with
 * accounts on and a stand-in for control: *Share live…* on a space's menu
 * opens the Live card starting, then live with its link on the clipboard;
 * the rail tile and the card's head wear the live mark; the desk's report to
 * main is the windows' real boxes in the stage's coordinates — the space in
 * front from the engine, the space left from its saved arrangement; a knock
 * is a notice with Admit and a row in the card, which admits through
 * control; a guest's arrival, their message, the chat's reply; *Guests can
 * use* from the card and from a window's ⋯; `/share` and `/draw` in the
 * Bar; and Stop sharing. The room is not here (the live-host app's, and the
 * end to end's): what the room would tell main is told as the live-host app
 * tells it (`sendLiveHostReport`).
 */

const PAGE = (title: string): string => `<!doctype html><html><head><title>${title}</title></head><body style="font:16px sans-serif;margin:24px"><h1>${title}</h1></body></html>`;
const SPACE = "space-live";
const LINK = "https://www.pistachio.run/live/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";
const shots = join(process.cwd(), "e2e/screenshots/live-share-shell");

interface FakeControl {
  url: string;
  requests: Array<{ method: string; path: string; body: unknown }>;
  /** How long making a share takes (the card says "Starting…" meanwhile). */
  createDelayMs: number;
  /** The share's pending knocks, as control lists them. */
  knocks: Array<{ requestId: string; identity: string; name: string; color: string; status: string; createdAt: string }>;
  /** The guests let in, as control lists them: main counts no one in the room a guest until control does (§6.1). */
  admitted: FakeControl["knocks"];
  close(): Promise<void>;
}

/** Control, as far as a signed-out Mac's anonymous account and a live share need it. */
async function fakeControl(): Promise<FakeControl> {
  const shareId = randomUUID();
  const share = (status: "live" | "ended") => ({ id: shareId, title: "Launch plan", hostName: null, admission: "ask", status, room: `live_${shareId}`, createdAt: new Date().toISOString(), endedAt: null });
  const reply = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const control: FakeControl = {
    url: "",
    requests: [],
    createDelayMs: 0,
    knocks: [],
    admitted: [],
    close: async () => undefined,
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    request.on("end", () => {
      const path = (request.url ?? "").split("?")[0] ?? "";
      const body = raw === "" ? null : (JSON.parse(raw) as Record<string, unknown>);
      control.requests.push({ method: request.method ?? "", path, body });
      const exp = Math.floor(Date.now() / 1000) + 3600;
      if (path === "/v1/auth/device-challenge") return reply(response, 200, { challenge: "challenge" });
      if (path === "/v1/accounts/anonymous") {
        const deviceId = String(body?.["deviceId"] ?? "");
        return reply(response, 201, { userId: "u_live", device: { id: deviceId, name: "Mac", platform: "macos", devicePublicKey: "", agreementPublicKey: "", createdAt: null, lastSeenAt: null, revokedAt: null }, token: "device-token", exp });
      }
      const base = `/v1/live/shares/${shareId}`;
      if (path === "/v1/live/shares" && request.method === "POST") {
        setTimeout(() => reply(response, 201, { share: share("live"), link: LINK, livekit: { url: "ws://127.0.0.1:9", token: "host-token", room: `live_${shareId}`, identity: "host" } }), control.createDelayMs);
        return;
      }
      if (path === base && request.method === "GET") return reply(response, 200, { share: share("live"), knocks: control.knocks, admitted: control.admitted });
      if (path === base && request.method === "PATCH") return reply(response, 200, { share: { ...share("live"), ...body } });
      if (path === `${base}/heartbeat`) return reply(response, 200, { share: share("live") });
      if (path.startsWith(`${base}/requests/`)) {
        const requestId = path.slice(`${base}/requests/`.length);
        const knocked = control.knocks.find((knock) => knock.requestId === requestId);
        if (knocked !== undefined && body?.["decision"] === "admit") control.admitted.push({ ...knocked, status: "admitted" });
        control.knocks = control.knocks.filter((knock) => knock.requestId !== requestId);
        return reply(response, 200, { request: { requestId, status: body?.["decision"] === "admit" ? "admitted" : "denied" } });
      }
      if (path === base && request.method === "DELETE") return reply(response, 200, { share: share("ended") });
      return reply(response, 404, { error: "not_found" });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  control.url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  control.close = () => new Promise((done) => server.close(() => done()));
  return control;
}

async function site(): Promise<Server> {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE(request.url === "/b" ? "Pricing" : "GitHub"));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return server;
}

type Bridge = { pistachio: PistachioApi };

const liveShare = (shell: Page): Promise<LiveShareState> => shell.evaluate(() => (window as unknown as Bridge).pistachio.getLiveShare());

/** The views main shows over the browser's window (not the live-host window's), by the page they hold. */
function shownViews(app: ElectronApplication): Promise<Array<{ url: string; bounds: { x: number; y: number; width: number; height: number } }>> {
  return app.evaluate(({ BrowserWindow }) => {
    const browser = BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().endsWith("#live-host"))!;
    return browser.contentView.children.flatMap((child) => {
      if (!("webContents" in child) || !("getVisible" in child) || !child.getVisible()) return [];
      const view = child as Electron.WebContentsView;
      return [{ url: view.webContents.getURL(), bounds: view.getBounds() }];
    });
  });
}

/** Every desk report the shell sent main, as main's own listener heard it (the latest last). */
function reports(app: ElectronApplication): Promise<Array<LiveDeskReport | null>> {
  return app.evaluate(() => (globalThis as unknown as { __liveDeskReports: Array<LiveDeskReport | null> }).__liveDeskReports);
}

async function capture(target: Locator, filename: string): Promise<void> {
  if (!captureEnabled) return;
  await mkdir(shots, { recursive: true });
  await target.page().waitForTimeout(300);
  await target.screenshot({ path: join(shots, filename), animations: "disabled" });
}

test.describe.serial("live share in the shell: the Live card, its ways in, the marks, the desk's report", { tag: ["@share"] }, () => {
  let control: FakeControl;
  let pages: Server;
  let base: string;
  let app: ElectronApplication;
  let shell: Page;
  let tabA: string;
  let tabB: string;
  const card = (): Locator => shell.getByTestId("live-card");
  const host = (): Page => app.windows().find((page) => page.url().endsWith("#live-host"))!;
  const report = (message: LiveHostReport): Promise<void> => host().evaluate((body) => (window as unknown as Bridge).pistachio.sendLiveHostReport(body), message);

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    control = await fakeControl();
    pages = await site();
    base = `http://127.0.0.1:${String((pages.address() as AddressInfo).port)}`;
    ({ app, shell } = await launchDesk({
      name: "live-shell",
      homeUrl: `${base}/a`,
      args: ["--use-mock-keychain"],
      env: { PISTACHIO_E2E: "0", PISTACHIO_CONTROL_URL: control.url, PISTACHIO_ANONYMOUS: "1" },
    }));
    tabA = (await snapshot(shell)).tabs.find((tab) => tab.url === `${base}/a`)!.id;
    // A space of two windows: the first tab, and a second made in it (out on its desk as the window in use).
    await createGroup(shell, SPACE, [tabA], "Launch plan", "blue");
    await selectSpace(shell, SPACE, tabA);
    await createTab(shell, `${base}/b`);
    await expect.poll(async () => (await snapshot(shell)).tabGroups.find((group) => group.id === SPACE)?.tabIds.length).toBe(2);
    tabB = (await snapshot(shell)).tabs.find((tab) => tab.url === `${base}/b`)!.id;
    await expect(shell.locator(windowSelector(tabB))).toHaveCount(1);
    await settled(shell, app);
    // What the shell tells main of the desk, heard beside main's own listener.
    await app.evaluate(({ ipcMain }, channel) => {
      const heard: unknown[] = [];
      (globalThis as unknown as { __liveDeskReports: unknown[] }).__liveDeskReports = heard;
      ipcMain.on(channel, (_event, body: unknown) => {
        heard.push(body);
        if (heard.length > 400) heard.shift();
      });
    }, IPC.liveDeskSet);
  });

  test.afterAll(async () => {
    await app?.close();
    await control?.close();
    await new Promise((done) => pages?.close(done));
  });

  test("Share live… on a space's menu: the card comes up starting, then live, its link on the clipboard, the space marked", async () => {
    control.createDelayMs = 1_500;
    await railSpace(shell, SPACE).click({ button: "right" });
    await shell.locator('[data-testid="context-menu"] [data-testid="space-share-live"]').click();
    await expect(card()).toHaveAttribute("data-status", "starting");
    await expect(card()).toHaveAttribute("data-shown", "");
    await expect(card().getByTestId("live-starting")).toContainText("Making a link for “Launch plan”");
    await capture(card(), "01-starting.png");

    await expect(card()).toHaveAttribute("data-status", "live", { timeout: 15_000 });
    expect((await liveShare(shell)).groupId).toBe(SPACE);
    await expect(card().getByTestId("live-link")).toContainText("www.pistachio.run/live/AbCdEfGhIj…");
    await expect(card().getByTestId("live-link-note")).toContainText("Link copied");
    await expect(card().getByTestId("live-link-note")).toContainText("Guests see every window in this space");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(LINK);
    await expect(card().getByTestId("live-elapsed")).toHaveText(/^0:0\d$/);
    // The space's windows, each with Guests can use, off.
    await expect(card().getByTestId("live-window")).toHaveCount(2);
    await expect(card().locator(`[data-testid="live-window"][data-window-id="${tabA}"] [role="switch"]`)).toHaveAttribute("aria-checked", "false");

    // Its rail tile and the card's head wear the live mark; the tooltip says how many are in.
    await expect(railSpace(shell, SPACE)).toHaveAttribute("data-live", "");
    await expect(railSpace(shell, SPACE).getByTestId("live-mark")).toBeVisible();
    await expect(railSpace(shell, SPACE)).toHaveAttribute("aria-label", /· Live · 0$/);
    await expect(shell.getByTestId("space-live")).toHaveAttribute("title", "Live · 0");
    await capture(shell.getByTestId("sidebar-pane"), "02-marks.png");
    // The space's menu now offers its card and Stop sharing live.
    await shell.keyboard.press("Escape");
    await expect(card()).toHaveCount(0);
    await railSpace(shell, SPACE).click({ button: "right" });
    await expect(shell.locator('[data-testid="context-menu"] [data-testid="space-stop-live"]')).toBeVisible();
    await expect(shell.locator('[data-testid="context-menu"] [data-testid="space-share-live"]')).toHaveCount(0);
    await shell.keyboard.press("Escape");
  });

  test("the desk's report is the windows' real boxes, in the stage's coordinates, settled once at rest", async () => {
    await settled(shell, app);
    const tabs = (await snapshot(shell)).tabs;
    const urlOf = (id: string): string => tabs.find((tab) => tab.id === id)!.url;
    await expect
      .poll(async () => {
        const last = (await reports(app)).at(-1);
        return last !== null && last !== undefined && last.groupId === SPACE && last.settled && last.windows.length === 2;
      })
      .toBe(true);
    const last = (await reports(app)).at(-1)!;
    const stage = (await shell.locator(".desk-stage").boundingBox())!;
    expect(last.stageInWindow).toEqual({ x: Math.round(stage.x), y: Math.round(stage.y), w: Math.round(stage.width), h: Math.round(stage.height) });
    expect(last.stage).toEqual({ w: Math.round(stage.width), h: Math.round(stage.height) });
    expect(new Set(last.windows.map((window) => window.id))).toEqual(new Set([tabA, tabB]));
    expect(last.windows.every((window) => window.kind === "page")).toBe(true);
    // The window in use, on top.
    expect(last.windows.at(-1)!.focused).toBe(true);
    const views = await shownViews(app);
    let compared = 0;
    for (const window of last.windows) {
      const view = views.find((candidate) => candidate.url === urlOf(window.id));
      // (A window covered by the other is its still: no view to compare.)
      if (view === undefined) continue;
      compared += 1;
      expect({ x: window.page.x + last.stageInWindow.x, y: window.page.y + last.stageInWindow.y, w: window.page.w, h: window.page.h }).toEqual({
        x: view.bounds.x,
        y: view.bounds.y,
        w: view.bounds.width,
        h: view.bounds.height,
      });
    }
    expect(compared).toBeGreaterThan(0);
    // Its windows where the shell draws them, in the stage.
    for (const window of last.windows) {
      const frame = (await shell.locator(windowSelector(window.id)).boundingBox())!;
      expect(Math.abs(frame.x - stage.x - window.frame.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(frame.y - stage.y - window.frame.y)).toBeLessThanOrEqual(1);
    }
  });

  test("passing to another space: the shared one is reported as it was left, and the host is away", async () => {
    const before = (await reports(app)).at(-1)!;
    await railHome(shell).click();
    await expect.poll(async () => (await liveShare(shell)).hostAway).toBe(true);
    await expect
      .poll(async () => {
        const last = (await reports(app)).at(-1);
        return last !== null && last !== undefined && last.groupId === SPACE && last.settled && last.windows.length === 2;
      })
      .toBe(true);
    const saved = (await reports(app)).at(-1)!;
    for (const window of before.windows) {
      const after = saved.windows.find((candidate) => candidate.id === window.id)!;
      for (const key of ["x", "y", "w", "h"] as const) expect(Math.abs(after.frame[key] - window.frame[key])).toBeLessThanOrEqual(1);
    }
    // Sent once, not every frame of the other space's desk.
    const count = (await reports(app)).length;
    await settled(shell, app);
    expect((await reports(app)).length - count).toBeLessThanOrEqual(1);
    // The card says so, and takes the host back.
    await railSpace(shell, SPACE).click({ button: "right" });
    await shell.locator('[data-testid="context-menu"] [data-testid="space-live-card"]').click();
    await expect(card()).toHaveAttribute("data-shown", "");
    await expect(card().getByTestId("live-away")).toContainText("Guests see “Launch plan” as you left it");
    await card().getByTestId("live-away").getByRole("button", { name: "Go back" }).click();
    await expect(shell.locator(`.desk-stage[data-phase="open"][data-group-id="${SPACE}"]`)).toHaveCount(1);
    await expect.poll(async () => (await liveShare(shell)).hostAway).toBe(false);
    await expect(card().getByTestId("live-away")).toHaveCount(0);
    await shell.keyboard.press("Escape");
    await expect(card()).toHaveCount(0);
    await settled(shell, app);
  });

  test("a knock is a notice with Admit, several knocks one notice; the card lists who waits, and Admit lets them in", async () => {
    const notices = await noticePage(app);
    const knock = (requestId: string, name: string) => ({ requestId, identity: `g_${requestId}`, name, color: "#E54D2E", status: "pending", createdAt: new Date().toISOString() });
    control.knocks = [knock("r1", "Sam")];
    await report({ type: "knock", requestId: "r1", name: "Sam" });
    const sam = notices.getByTestId("notice-card").filter({ hasText: "Sam wants to join" });
    await expect(sam).toBeVisible();
    await expect(sam.locator(".notice-action")).toHaveText("Admit");
    control.knocks = [knock("r1", "Sam"), knock("r2", "Ann")];
    await report({ type: "knock", requestId: "r2", name: "Ann" });
    await expect(notices.getByTestId("notice-card").filter({ hasText: "2 people want to join" })).toBeVisible();
    await capture(notices.getByTestId("notice-card").filter({ hasText: "2 people want to join" }), "03-knocks-notice.png");
    await expect(notices.getByTestId("notice-card").filter({ hasText: "wants to join" })).toHaveCount(0);

    // The card, from the live mark in the space's head: both at the door.
    await shell.getByTestId("space-live").click();
    await expect(card()).toHaveAttribute("data-shown", "");
    await expect(card().getByTestId("live-knock")).toHaveCount(2);
    await card().getByTestId("live-knock").filter({ hasText: "Sam" }).getByTestId("live-admit").click();
    await expect.poll(() => control.requests.some((request) => request.method === "POST" && request.path.endsWith("/requests/r1") && (request.body as { decision?: string } | null)?.decision === "admit")).toBe(true);
    await expect(card().getByTestId("live-knock")).toHaveCount(1);
  });

  test("a guest comes in and writes; the chat answers; Guests can use from the card and from a window's ⋯", async () => {
    const notices = await noticePage(app);
    await report({ type: "roster", guests: [{ identity: "g_r1", name: "Sam", color: "#E54D2E", micOn: true, cameraOn: false }] });
    await expect(notices.getByTestId("notice-card").filter({ hasText: "Sam joined" })).toBeVisible();
    await expect(card().getByTestId("live-person")).toHaveCount(1);
    await expect(card().getByTestId("live-person")).toContainText("Sam");
    await expect(railSpace(shell, SPACE)).toHaveAttribute("aria-label", /· Live · 1$/);
    await report({ type: "chat", from: "g_r1", id: "m1", text: "Can you open the pricing page?" });
    await expect(card().getByTestId("live-unread")).toHaveText("1");
    await capture(card(), "04-live-guest-knock.png");

    await card().getByTestId("live-tab-chat").click();
    await expect(card().getByTestId("live-chat-message")).toContainText("Can you open the pricing page?");
    await expect.poll(async () => (await liveShare(shell)).unread).toBe(0);
    await card().getByTestId("live-chat-input").fill("Opening it now");
    await card().getByTestId("live-chat-input").press("Enter");
    await expect.poll(async () => (await liveShare(shell)).chat.map((message) => [message.from, message.text])).toEqual([
      ["g_r1", "Can you open the pricing page?"],
      ["host", "Opening it now"],
    ]);
    await expect(card().getByTestId("live-chat-message")).toHaveCount(2);
    await capture(card(), "05-chat.png");

    await card().getByTestId("live-tab-share").click();
    await card().locator(`[data-testid="live-window"][data-window-id="${tabA}"] [role="switch"]`).click();
    await expect.poll(async () => (await liveShare(shell)).controllable).toEqual([tabA]);
    await shell.keyboard.press("Escape");
    await expect(card()).toHaveCount(0);
    // A window's ⋯: Guests can use this window.
    await settled(shell, app);
    await fromFrameMenu(shell, windowSelector(tabB), "desk-page-guests-use");
    await expect.poll(async () => (await liveShare(shell)).controllable.sort()).toEqual([tabA, tabB].sort());
  });

  test("/share in the Bar shows the shared space's card; /draw draws over the desk and gives it back", async () => {
    const input = shell.getByTestId("desk-bar-input");
    await reachBar(shell);
    await input.fill("/share");
    await input.press("Enter");
    await expect(card()).toHaveAttribute("data-status", "live");
    await expect(card()).toHaveAttribute("data-shown", "");
    await shell.keyboard.press("Escape");
    await expect(card()).toHaveCount(0);
    await reachBar(shell);
    await input.fill("/draw");
    await input.press("Enter");
    await expect.poll(async () => (await liveShare(shell)).drawing).toEqual({ tool: "pen", color: "#3E63DD" });
    // (Drawing, the live-host window holds the pointer and the keys: the desk is given back as its Escape would.)
    await shell.evaluate(() => (window as unknown as Bridge).pistachio.liveShare({ type: "setDrawing", drawing: null }));
    await expect.poll(async () => (await liveShare(shell)).drawing).toBeNull();
  });

  test("Stop sharing ends the share: the card and the marks go, control hears it, the desk is reported no more", async () => {
    // The Live pill over the desk, pressed: main says so, and the card comes up.
    await report({ type: "openCard" });
    await expect(card()).toHaveAttribute("data-shown", "");
    await card().getByTestId("live-stop").click();
    await expect.poll(async () => (await liveShare(shell)).status).toBe("idle");
    expect((await liveShare(shell)).ended).toBe("stopped");
    await expect(card()).toHaveCount(0);
    await expect(railSpace(shell, SPACE)).not.toHaveAttribute("data-live", "");
    await expect(shell.getByTestId("space-live")).toHaveCount(0);
    expect(control.requests.some((request) => request.method === "DELETE" && request.path.startsWith("/v1/live/shares/"))).toBe(true);
    await expect.poll(async () => (await reports(app)).at(-1)).toBeNull();
  });
});
