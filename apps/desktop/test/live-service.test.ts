/**
 * The live share's owner in main (docs/live-share.md §6.1): starting through
 * control and failing in words, stopping, the ends it comes to on its own
 * (its space closed, its Profile switched away, the window closed, control
 * saying so, the app quitting), the desk turned into frames for the host
 * app, the lobby read so no knock is missed, guests' chat, asks and hands on
 * a window, drawing, and the host's token kept fresh.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronInputStep } from "@pistachio/live-share";
import type { LiveDeskReport, LiveDeskReportWindow, LiveGuest, LiveHostEvent, LiveShareState } from "@pistachio/shell-contracts/live-share";
import { ControlError } from "../src/main/account/control-client";
import { LiveUnavailableError, type LiveControl } from "../src/main/live/live-control";
import {
  LIVE_HEARTBEAT_MS,
  LIVE_HOLD_GRACE_MS,
  LIVE_KNOCK_POLL_MS,
  LIVE_LOBBY_RETRY_MS,
  LIVE_END_WAIT_MS,
  LIVE_REMOVE_RETRY_MAX_MS,
  LIVE_REMOVE_RETRY_MS,
  LIVE_RETITLE_MS,
  LiveShareService,
  type LiveBrowser,
  type LiveHeldTab,
} from "../src/main/live/live-service";

const ANN = { identity: "g_ann1", name: "Ann", color: "#E54D2E", micOn: true, cameraOn: false };
const BO = { identity: "g_bo22", name: "Bo", color: "#30A46C", micOn: false, cameraOn: false };

function win(id: string, patch: Partial<LiveDeskReportWindow> = {}): LiveDeskReportWindow {
  return { id, kind: "page", frame: { x: 0, y: 0, w: 600, h: 400 }, page: { x: 0, y: 30, w: 600, h: 370 }, focused: false, minimized: false, masked: false, covered: false, ...patch };
}

function desk(windows: LiveDeskReportWindow[] = [win("a"), win("b", { focused: true })], shellCovered = false): LiveDeskReport {
  return { groupId: "g1", stage: { w: 1200, h: 800 }, stageInWindow: { x: 240, y: 12, w: 1200, h: 800 }, viewport: { w: 1440, h: 900 }, windows, settled: true, shellCovered, covers: [], mark: 1 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(options: { control?: () => Promise<LiveControl>; hostName?: () => Promise<string | null> } = {}) {
  const control = {
    create: vi.fn<LiveControl["create"]>(async () => ({ shareId: "s1", link: "https://www.pistachio.run/live/tok", admission: "ask", livekit: { url: "ws://127.0.0.1:7880", token: "t1" } })),
    // (A control that let Ann and Bo in, unless a test says otherwise.)
    get: vi.fn<LiveControl["get"]>(async () => ({ ended: false, knocks: [], admitted: new Set([ANN.identity, BO.identity]) })),
    update: vi.fn<LiveControl["update"]>(async () => undefined),
    heartbeat: vi.fn<LiveControl["heartbeat"]>(async () => ({ token: null })),
    decide: vi.fn<LiveControl["decide"]>(async () => undefined),
    remove: vi.fn<LiveControl["remove"]>(async () => undefined),
    end: vi.fn<LiveControl["end"]>(async () => undefined),
  };
  const world = { spaceId: "p1", current: "g1" as string | null, shown: true, spaceGone: false, title: "Launch plan" };
  const held: LiveHeldTab[][] = [];
  const heldGroups: Array<string | null> = [];
  const sent: Array<{ tabId: string; steps: readonly ElectronInputStep[] }> = [];
  const activated: string[] = [];
  const browser: LiveBrowser = {
    space: (groupId) => (groupId === "g1" && !world.spaceGone ? { title: world.title, color: "#388cf0", spaceId: "p1" } : null),
    current: () => ({ spaceId: world.spaceId, groupId: world.current }),
    windowShown: () => world.shown,
    facts: (windowId) => ({ title: windowId.toUpperCase(), url: `https://${windowId}.test/`, favicon: null, page: true }),
    hold: (groupId, tabs) => {
      heldGroups.push(groupId);
      held.push([...tabs]);
    },
    viewSize: () => ({ width: 600, height: 370 }),
    send: (tabId, steps) => {
      sent.push({ tabId, steps });
      return true;
    },
    activate: (tabId) => activated.push(tabId),
    isShortcut: () => false,
  };
  const host = { events: [] as LiveHostEvent[], interactive: [] as boolean[], drawing: [] as boolean[], opened: 0, closed: 0 };
  const states: LiveShareState[] = [];
  const rosters: LiveGuest[][] = [];
  const clipboard: string[] = [];
  const cards: number[] = [];
  const service = new LiveShareService({
    control: options.control ?? (async () => control),
    browser,
    openHost: () => {
      host.opened += 1;
      return {
        send: (event) => host.events.push(event),
        setInteractive: (active) => host.interactive.push(active),
        setDrawing: (drawing) => host.drawing.push(drawing),
        close: () => (host.closed += 1),
      };
    },
    writeClipboard: (text) => clipboard.push(text),
    publish: (state) => states.push(state),
    publishRoster: (participants) => rosters.push(participants),
    openCard: () => cards.push(1),
    pointer: () => null,
    ...(options.hostName === undefined ? {} : { hostName: options.hostName }),
    log: () => undefined,
  });
  const events = <T extends LiveHostEvent["type"]>(type: T) => host.events.filter((event): event is Extract<LiveHostEvent, { type: T }> => event.type === type);
  return { service, control, world, held, heldGroups, sent, activated, host, states, rosters, clipboard, cards, events };
}

/** Lets the share's promises and its coalesced publish run. */
async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

async function live(options?: Parameters<typeof setup>[0]) {
  const harness = setup(options);
  await harness.service.command({ type: "start", groupId: "g1", hostName: "Zach" });
  await settle();
  return harness;
}

describe("LiveShareService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts: control makes the share, its link is copied, the host window opens and the lobby is read", async () => {
    const { service, control, clipboard, host, states } = await live();
    expect(control.create).toHaveBeenCalledWith({ title: "Launch plan", hostName: "Zach" });
    expect(service.state).toMatchObject({ status: "live", groupId: "g1", shareId: "s1", link: "https://www.pistachio.run/live/tok", admission: "ask", hostAway: false, error: null });
    expect(clipboard).toEqual(["https://www.pistachio.run/live/tok"]);
    expect(host.opened).toBe(1);
    expect(control.get).toHaveBeenCalledWith("s1");
    expect(states.map((state) => state.status)).toContain("starting");
    expect(states.at(-1)?.status).toBe("live");
    expect(service.hostConfig()).toMatchObject({ livekit: { url: "ws://127.0.0.1:7880", token: "t1" }, shareId: "s1", frame: null, stage: null });
  });

  it("names the host by the Mac's own name when the shell names nobody, and by the shell's name when it does", async () => {
    const unnamed = setup({ hostName: async () => "Claudius" });
    await unnamed.service.command({ type: "start", groupId: "g1" });
    await settle();
    expect(unnamed.control.create).toHaveBeenCalledWith({ title: "Launch plan", hostName: "Claudius" });
    const named = setup({ hostName: async () => "Claudius" });
    await named.service.command({ type: "start", groupId: "g1", hostName: "Zach" });
    await settle();
    expect(named.control.create).toHaveBeenCalledWith({ title: "Launch plan", hostName: "Zach" });
    // A Mac whose name names nobody, or that cannot be read: the share goes without one.
    const nobody = setup({ hostName: async () => Promise.reject(new Error("no scutil")) });
    await nobody.service.command({ type: "start", groupId: "g1" });
    await settle();
    expect(nobody.control.create).toHaveBeenCalledWith({ title: "Launch plan" });
    expect(nobody.service.state.status).toBe("live");
  });

  it("starts with the host away when the shared space is not the one in front", async () => {
    const harness = setup();
    harness.world.current = "g2";
    await harness.service.command({ type: "start", groupId: "g1" });
    await settle();
    expect(harness.service.state).toMatchObject({ status: "live", hostAway: true });
    harness.world.current = "g1";
    harness.service.refresh();
    expect(harness.service.state.hostAway).toBe(false);
  });

  it("says why it could not start: no account, or control's refusal", async () => {
    const off = setup({ control: async () => Promise.reject(new LiveUnavailableError("Sign-in services are off.")) });
    await off.service.command({ type: "start", groupId: "g1" });
    await settle();
    expect(off.service.state).toMatchObject({ status: "error", groupId: "g1", error: "Sign-in services are off.", shareId: null });
    expect(off.host.opened).toBe(0);
    // Stop puts the failure away.
    await off.service.command({ type: "stop" });
    expect(off.service.state.status).toBe("idle");

    const busy = setup();
    busy.control.create.mockRejectedValueOnce(new ControlError(409, "live_too_many_shares", "POST", "/v1/live/shares"));
    await busy.service.command({ type: "start", groupId: "g1" });
    expect(busy.service.state).toMatchObject({ status: "error", error: "You're already sharing live from another Mac." });
  });

  it("stops: the app is told and its window closes, the tabs are let go, and control ends the share", async () => {
    const { service, control, host, held, events, states } = await live();
    await service.command({ type: "stop" });
    await settle();
    expect(events("end")).toHaveLength(1);
    expect(host.closed).toBe(1);
    expect(held.at(-1)).toEqual([]);
    expect(control.end).toHaveBeenCalledWith("s1");
    expect(states.map((state) => state.status)).toContain("ending");
    expect(service.state).toMatchObject({ status: "idle", ended: "stopped", shareId: null, link: null });
    expect(service.hostConfig()).toBeNull();
  });

  it("ends at once what control made when it was stopped while starting", async () => {
    const harness = setup();
    const made = deferred<Awaited<ReturnType<LiveControl["create"]>>>();
    harness.control.create.mockReturnValueOnce(made.promise);
    const starting = harness.service.command({ type: "start", groupId: "g1" });
    await settle();
    expect(harness.service.state.status).toBe("starting");
    await harness.service.command({ type: "stop" });
    made.resolve({ shareId: "s9", link: "https://x.test/live/a", admission: "ask", livekit: { url: "ws://x", token: "t" } });
    await starting;
    await settle();
    expect(harness.control.end).toHaveBeenCalledWith("s9");
    expect(harness.host.opened).toBe(0);
    expect(harness.service.state).toMatchObject({ status: "idle", ended: "stopped" });
  });

  it("ends when its space closes, its Profile is switched away, or the window closes", async () => {
    const closed = await live();
    closed.world.spaceGone = true;
    closed.service.refresh();
    await settle();
    expect(closed.service.state.ended).toBe("space-closed");
    expect(closed.control.end).toHaveBeenCalled();

    const switched = await live();
    switched.world.spaceId = "p2";
    switched.service.refresh();
    await settle();
    expect(switched.service.state.ended).toBe("profile-switched");

    const window = await live();
    window.service.windowClosed();
    await settle();
    expect(window.service.state.ended).toBe("window-closed");
    expect(window.host.closed).toBe(1);
  });

  it("ends without telling control when control says the share is over", async () => {
    const { service, control } = await live();
    control.heartbeat.mockRejectedValueOnce(new ControlError(409, "live_ended", "POST", "/v1/live/shares/s1/heartbeat"));
    await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS);
    await settle();
    expect(service.state).toMatchObject({ status: "idle", ended: "ended-elsewhere" });
    expect(control.end).not.toHaveBeenCalled();
  });

  it("waits only a moment for control as the app quits", async () => {
    const { service, control } = await live();
    control.end.mockReturnValueOnce(new Promise(() => undefined));
    let done = false;
    void service.quit().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(LIVE_END_WAIT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(control.end).toHaveBeenCalledWith("s1");
    // Nothing left to hold the quit up a second time.
    expect(service.active).toBe(false);
  });

  it("ends the share before this Mac's account leaves it, control told under that account's own credentials, waiting only a moment", async () => {
    const { service, control, host, events } = await live();
    // The credentials the account's control client sends with: the request takes the ones it goes out with.
    let account = "anon-1";
    const endedUnder: string[] = [];
    control.end.mockImplementation(() => {
      endedUnder.push(account);
      return new Promise(() => undefined);
    });
    let done = false;
    void service.accountChanging().then(() => (done = true));
    // Told at once, with the window closed and the guests sent off; control's answer is waited for a moment at most.
    expect(endedUnder).toEqual(["anon-1"]);
    expect(events("end")).toHaveLength(1);
    expect(host.closed).toBe(1);
    await vi.advanceTimersByTimeAsync(LIVE_END_WAIT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    // The account goes; nothing of the share asks control anything under the next one.
    account = "anon-2";
    const reads = control.get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS * 2);
    expect(endedUnder).toEqual(["anon-1"]);
    expect(control.get.mock.calls.length).toBe(reads);
    expect(control.heartbeat).not.toHaveBeenCalled();
  });

  it("says the share ended with the account, and ends one control was still making as it lands, before the account goes", async () => {
    const answered = await live();
    await answered.service.accountChanging();
    await settle();
    expect(answered.service.state).toMatchObject({ status: "idle", ended: "account-changed", shareId: null });

    const harness = setup();
    let account = "anon-1";
    const endedUnder: Array<[string, string]> = [];
    harness.control.end.mockImplementation(async (shareId) => void endedUnder.push([shareId, account]));
    const made = deferred<Awaited<ReturnType<LiveControl["create"]>>>();
    harness.control.create.mockReturnValueOnce(made.promise);
    void harness.service.command({ type: "start", groupId: "g1" });
    await settle();
    let done = false;
    void harness.service.accountChanging().then(() => (done = true));
    await settle();
    expect(done).toBe(false);
    made.resolve({ shareId: "s9", link: "https://x.test/live/a", admission: "ask", livekit: { url: "ws://x", token: "t" } });
    await settle();
    expect(done).toBe(true);
    account = "anon-2";
    expect(endedUnder).toEqual([["s9", "anon-1"]]);
    expect(harness.host.opened).toBe(0);
    expect(harness.service.state).toMatchObject({ status: "idle", ended: "account-changed" });
  });

  it("tells the shell which windows stream, so the card can say why guests cannot use the others", async () => {
    const { service, states } = await live();
    // Bottom to top: w0…w9; the eight from the top stream, and a minimized one gives its place to the next.
    service.setDesk(desk(Array.from({ length: 10 }, (_, index) => win(`w${String(index)}`, { minimized: index === 9 }))));
    await settle();
    expect([...service.state.streamed].sort()).toEqual(["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8"]);
    expect(states.at(-1)?.streamed).toEqual(service.state.streamed);
    // A frame that streams the same windows is no news to the shell.
    const published = states.length;
    service.setDesk(desk(Array.from({ length: 10 }, (_, index) => win(`w${String(index)}`, { minimized: index === 9, focused: index === 3 }))));
    await settle();
    expect(states).toHaveLength(published);
    await service.command({ type: "stop" });
    await settle();
    expect(service.state.streamed).toEqual([]);
  });

  it("streams a shell-drawn window from the shell's own page: never as a tab, held awake or used, and only while the host is on the space", async () => {
    const { service, world, held, events } = await live();
    service.hostReport({ type: "roster", guests: [ANN] });
    service.setDesk(desk([win("a"), win("term", { kind: "shell" })]));
    await settle();
    const frame = events("desk").at(-1)!.frame;
    expect(frame.windows.map((window) => [window.id, window.kind, window.track, window.paused])).toEqual([
      ["a", "page", "win:a", false],
      ["term", "shell", "win:term", false],
    ]);
    // With the shell's mark the report was painted under, and where it put the stage: what the picture is cut by (§6.6).
    expect(events("desk").at(-1)!.shell).toEqual({ mark: 1, stage: { x: 240, y: 12, w: 1200, h: 800 }, viewport: { w: 1440, h: 900 } });
    expect(service.hostConfig()?.shell?.mark).toBe(1);
    // Its tab is no page main captures, keeps awake or lets a guest use.
    expect(held.at(-1)?.map((tab) => tab.tabId)).toEqual(["a"]);
    expect(service.streams("term")).toBe(false);
    expect(service.shellStreams()).toBe(true);
    // Something of the shell's over the desk: the frame holds its picture, at once.
    service.setDesk(desk([win("a"), win("term", { kind: "shell" })], true));
    expect(events("desk").at(-1)!.frame.windows.map((window) => window.paused)).toEqual([false, true]);
    // Away, the shell shows another space: no capture of it is handed out.
    world.current = "g2";
    service.refresh();
    expect(service.shellStreams()).toBe(false);
    world.current = "g1";
    service.refresh();
    expect(service.shellStreams()).toBe(true);
    service.setDesk(desk([win("a")]));
    expect(service.shellStreams()).toBe(false);
  });

  it("holds the shell-drawn windows' pictures while the shell reloads, or its desk goes, until it reports again", async () => {
    const { service, events } = await live();
    service.hostReport({ type: "roster", guests: [ANN] });
    const term = desk([win("a"), win("term", { kind: "shell" })]);
    service.setDesk(term);
    await settle();
    const paused = (): boolean[] => events("desk").at(-1)!.frame.windows.map((window) => window.paused);
    expect(paused()).toEqual([false, false]);
    service.shellLoading();
    expect(paused()).toEqual([false, true]);
    service.setDesk(term);
    await vi.advanceTimersByTimeAsync(40);
    expect(paused()).toEqual([false, false]);
    service.setDesk(null);
    expect(paused()).toEqual([false, true]);
    // The windows stay where they were for guests.
    expect(events("desk").at(-1)!.frame.windows.map((window) => window.id)).toEqual(["a", "term"]);
  });

  it("tells the host app what of the browser's own lies over the desk, in the window: the shell's covers, the notices", async () => {
    const harness = setup();
    // A notice up before the share: the app starts from it.
    harness.service.setNoticeCover({ x: 520, y: 760, w: 265, h: 50 });
    await harness.service.command({ type: "start", groupId: "g1", hostName: "Zach" });
    await settle();
    const { service, events } = harness;
    expect(service.hostConfig()?.chrome).toEqual([{ x: 520, y: 760, w: 265, h: 50 }]);
    // The Live card's column, from the shell's report: placed by the report's stage (240, 12).
    service.setDesk({ ...desk(), covers: [{ x: -8, y: -8, w: 346, h: 816 }] });
    expect(events("chrome").at(-1)?.over).toEqual([
      { x: 232, y: 4, w: 346, h: 816 },
      { x: 520, y: 760, w: 265, h: 50 },
    ]);
    // The same again is no news; the notice gone is.
    const told = events("chrome").length;
    service.setDesk({ ...desk(), covers: [{ x: -8, y: -8, w: 346, h: 816 }] });
    service.setNoticeCover({ x: 520, y: 760, w: 265, h: 50 });
    expect(events("chrome")).toHaveLength(told);
    service.setNoticeCover(null);
    expect(events("chrome").at(-1)?.over).toEqual([{ x: 232, y: 4, w: 346, h: 816 }]);
    // Something over the desk that no box holds (the palette), or the shell reloading: no outline at all.
    service.setDesk(desk(undefined, true));
    expect(events("chrome").at(-1)?.over).toBeNull();
    service.setDesk(desk());
    expect(events("chrome").at(-1)?.over).toEqual([]);
    service.shellLoading();
    expect(events("chrome").at(-1)?.over).toBeNull();
    expect(service.hostConfig()?.chrome).toBeNull();
  });

  it("turns the desk into frames for the host app, holds the streamed tabs, and follows the host on and off the space", async () => {
    const { service, world, held, events } = await live();
    // (A guest is in: the streamed windows are held awake for them.)
    service.hostReport({ type: "roster", guests: [ANN] });
    service.setDesk(desk());
    await settle();
    const frame = events("desk").at(-1)!.frame;
    expect(frame.windows.map((window) => [window.id, window.track, window.title, window.origin])).toEqual([
      ["a", "win:a", "A", "a.test"],
      ["b", "win:b", "B", "b.test"],
    ]);
    expect(frame.hostPresent).toBe(true);
    // Held with their pages' sizes, so one not on screen is laid out at its own (and again when that changes).
    expect(held.at(-1)).toEqual([
      { tabId: "a", width: 600, height: 370 },
      { tabId: "b", width: 600, height: 370 },
    ]);
    const holds = held.length;
    service.setDesk(desk([win("a", { frame: { x: 10, y: 0, w: 600, h: 400 } }), win("b", { focused: true })]));
    expect(held).toHaveLength(holds);
    service.setDesk(desk([win("a", { page: { x: 0, y: 30, w: 500.4, h: 300 } }), win("b", { focused: true })]));
    expect(held.at(-1)?.[0]).toEqual({ tabId: "a", width: 500, height: 300 });
    expect(events("stage").at(-1)?.rect).toEqual({ x: 240, y: 12, w: 1200, h: 800 });
    expect(service.streams("a")).toBe(true);
    expect(service.streams("x")).toBe(false);
    // Another space in front: the host is away, nothing is drawn over the desk, and the guests hear it.
    world.current = "g2";
    service.refresh();
    await vi.advanceTimersByTimeAsync(40);
    expect(service.state.hostAway).toBe(true);
    expect(events("stage").at(-1)?.rect).toBeNull();
    expect(events("desk").at(-1)?.frame.hostPresent).toBe(false);
    // A report of another space is not the shared desk's.
    service.setDesk({ ...desk([win("z")]), groupId: "g2" });
    await vi.advanceTimersByTimeAsync(40);
    expect(events("desk").at(-1)?.frame.windows.map((window) => window.id)).toEqual(["a", "b"]);
    // A page woken or back from a crash is captured again; one not streamed is not news.
    service.pageReplaced("a");
    service.pageReplaced("x");
    expect(events("capture")).toEqual([{ type: "capture", windowId: "a" }]);
  });

  it("never misses a knock: heard through the room or read from the lobby, gone once answered or in the room", async () => {
    const { service, control } = await live();
    control.get.mockResolvedValue({ ended: false, admitted: new Set(), knocks: [{ requestId: "r1", name: "Ann" }] });
    control.get.mockClear();
    service.hostReport({ type: "knock", requestId: "r1", name: "Ann" });
    await settle();
    // The room's knock is read from the lobby at once, not at the next 15 s poll.
    expect(control.get).toHaveBeenCalledTimes(1);
    expect(service.state.knocks.map((knock) => knock.requestId)).toEqual(["r1"]);
    // The lobby, read every 15 s, holds one the room never brought.
    control.get.mockResolvedValue({ ended: false, admitted: new Set(), knocks: [{ requestId: "r1", name: "Ann" }, { requestId: "r2", name: "Bo" }] });
    await vi.advanceTimersByTimeAsync(LIVE_KNOCK_POLL_MS);
    expect(service.state.knocks.map((knock) => knock.requestId)).toEqual(["r1", "r2"]);
    await service.command({ type: "admit", requestId: "r2" });
    expect(control.decide).toHaveBeenCalledWith("s1", "r2", "admit");
    expect(service.state.knocks.map((knock) => knock.requestId)).toEqual(["r1"]);
    // A read that left before control heard the answer does not bring it back.
    await vi.advanceTimersByTimeAsync(LIVE_KNOCK_POLL_MS);
    expect(service.state.knocks.map((knock) => knock.requestId)).toEqual(["r1"]);
    // Let in, they are in the room, not at the door.
    control.get.mockResolvedValue({ ended: false, admitted: new Set(["g_r1"]), knocks: [] });
    service.hostReport({ type: "roster", guests: [{ ...ANN, identity: "g_r1" }] });
    await settle();
    expect(service.state.knocks).toEqual([]);
    // Anyone with the link: the lobby is no longer read for knocks (only with the minute's heartbeat, while anyone is let in).
    control.get.mockClear();
    await service.command({ type: "setAdmission", admission: "open" });
    expect(control.update).toHaveBeenCalledWith("s1", { admission: "open" });
    await vi.advanceTimersByTimeAsync(LIVE_KNOCK_POLL_MS);
    expect(control.get).not.toHaveBeenCalled();
  });

  it("lists a knock heard through the room only once control's lobby has it pending, reading once for a burst", async () => {
    const { service, control } = await live();
    const read = deferred<Awaited<ReturnType<LiveControl["get"]>>>();
    control.get.mockClear();
    control.get.mockReturnValueOnce(read.promise);
    // Anything without a participant reads as the server: a knock control never had is not one.
    service.hostReport({ type: "knock", requestId: "fake", name: "Mallory" });
    service.hostReport({ type: "knock", requestId: "fake2", name: "Mallory" });
    service.hostReport({ type: "knock", requestId: "r1", name: "Ann" });
    await settle();
    expect(service.state.knocks).toEqual([]);
    expect(control.get).toHaveBeenCalledTimes(1);
    // The read in flight left before some of them: one more read follows it, and only then are they listed.
    control.get.mockResolvedValue({ ended: false, admitted: new Set(), knocks: [{ requestId: "r1", name: "Ann" }] });
    read.resolve({ ended: false, admitted: new Set(), knocks: [] });
    await settle();
    expect(control.get).toHaveBeenCalledTimes(2);
    expect(service.state.knocks.map((knock) => [knock.requestId, knock.name])).toEqual([["r1", "Ann"]]);
  });

  it("re-reads the share when control does not know a knock or a guest, and ends only if the share is gone", async () => {
    const { service, control } = await live();
    const notFound = (path: string) => new ControlError(404, "live_not_found", "POST", path);
    // A stale or spoofed knock admitted: control has no such request, the share goes on.
    control.decide.mockRejectedValueOnce(notFound("/v1/live/shares/s1/requests/zz"));
    control.get.mockClear();
    await service.command({ type: "admit", requestId: "zz" });
    await settle();
    expect(control.get).toHaveBeenCalledWith("s1");
    expect(service.state).toMatchObject({ status: "live", error: null });
    control.remove.mockRejectedValueOnce(notFound("/v1/live/shares/s1/participants/g_zz/remove"));
    await service.command({ type: "remove", identity: "g_zz" });
    await settle();
    expect(service.state.status).toBe("live");
    expect(control.end).not.toHaveBeenCalled();
    // The share itself gone: the read says so, and it ends.
    control.decide.mockRejectedValueOnce(notFound("/v1/live/shares/s1/requests/r9"));
    control.get.mockRejectedValueOnce(new ControlError(404, "live_not_found", "GET", "/v1/live/shares/s1"));
    await service.command({ type: "deny", requestId: "r9" });
    await settle();
    expect(service.state).toMatchObject({ status: "idle", ended: "ended-elsewhere" });
    expect(control.end).not.toHaveBeenCalled();
  });

  it("keeps the chat: guests' messages counted until read, the host's sent to the room", async () => {
    const { service, events } = await live();
    service.hostReport({ type: "roster", guests: [ANN] });
    await settle();
    service.hostReport({ type: "chat", from: ANN.identity, id: "m1", text: "  hi there " });
    service.hostReport({ type: "chat", from: ANN.identity, id: "m1", text: "hi there" });
    service.hostReport({ type: "chat", from: "g_stranger", id: "m2", text: "let me in" });
    await settle();
    expect(service.state.chat).toEqual([{ id: "m1", from: ANN.identity, name: "Ann", color: ANN.color, text: "hi there", at: expect.any(Number) }]);
    expect(service.state.unread).toBe(1);
    await service.command({ type: "markRead" });
    expect(service.state.unread).toBe(0);
    // A guest's ids are their own: one sending the host's next id first hides nothing of the host's.
    service.hostReport({ type: "chat", from: ANN.identity, id: "host:1", text: "me first" });
    await service.command({ type: "chat", text: "welcome" });
    await settle();
    expect(events("chat")).toEqual([{ type: "chat", id: "host:1", text: "welcome" }]);
    expect(service.state.chat.map((message) => [message.from, message.text])).toEqual([
      [ANN.identity, "hi there"],
      [ANN.identity, "me first"],
      ["host", "welcome"],
    ]);
    expect(service.state.chat.at(-1)).toMatchObject({ id: "host:1", from: "host", name: "Zach", text: "welcome" });
    expect(events("state").at(-1)?.state.chat).toHaveLength(3);
  });

  it("lets a guest's hands onto a window the host allowed, as the one using it, and takes them off as they leave", async () => {
    const { service, sent, activated, events } = await live();
    service.setDesk(desk());
    service.hostReport({ type: "roster", guests: [ANN] });
    await settle();
    const press = { type: "mouseDown", x: 0.5, y: 0.5, button: "left", buttons: 1, clickCount: 1, modifiers: [] };
    // Not allowed yet: the guest asks.
    service.hostReport({ type: "input", from: ANN.identity, windowId: "a", event: press });
    service.hostReport({ type: "ask", from: ANN.identity, windowId: "a" });
    await settle();
    expect(sent).toEqual([]);
    expect(service.state.asks).toEqual([{ identity: ANN.identity, name: "Ann", windowId: "a", at: expect.any(Number) }]);
    await service.command({ type: "answerAsk", identity: ANN.identity, windowId: "a", allow: true });
    await vi.advanceTimersByTimeAsync(40);
    expect(service.state.controllable).toEqual(["a"]);
    expect(service.state.asks).toEqual([]);
    expect(events("desk").at(-1)?.frame.windows.find((window) => window.id === "a")?.controllable).toBe(true);
    service.hostReport({ type: "input", from: ANN.identity, windowId: "a", event: press });
    await settle();
    expect(sent).toEqual([{ tabId: "a", steps: [{ type: "mouseDown", x: 300, y: 185, button: "left", clickCount: 1, modifiers: ["leftbuttondown"] }] }]);
    expect(activated).toEqual(["a"]);
    expect(service.state.using).toEqual([{ windowId: "a", identity: ANN.identity }]);
    expect(events("grant")).toEqual([{ type: "grant", windowId: "a", identity: ANN.identity }]);
    // Ann leaves: nobody is using the window.
    service.hostReport({ type: "roster", guests: [] });
    await settle();
    expect(service.state.using).toEqual([]);
    expect(events("grant").at(-1)).toEqual({ type: "grant", windowId: "a", identity: null });
  });

  it("lets go of what a guest holds down on a page as their hands come off it: taken back, the host away, removed, gone, the share over", async () => {
    const { service, world, sent } = await live();
    service.setDesk(desk());
    await service.command({ type: "setControllable", windowId: "a", allowed: true });
    service.hostReport({ type: "roster", guests: [ANN, BO] });
    await settle();
    const input = (from: string, event: Record<string, unknown>): void => service.hostReport({ type: "input", from, windowId: "a", event });
    const down = { type: "mouseDown", x: 0.5, y: 0.5, button: "left", buttons: 1, clickCount: 1, modifiers: [] };
    const up = { type: "mouseUp", x: 0.25, y: 0.5, button: "left", buttons: 0, clickCount: 1, modifiers: [] };
    const released = (): ElectronInputStep[] => sent.flatMap(({ steps }) => steps).filter((step) => step.type === "mouseUp" || step.type === "keyUp");
    const atRest = { type: "mouseUp", x: 300, y: 185, button: "left", clickCount: 1, modifiers: [] };

    // Mid-drag with a key down, the host takes the window back: the page hears both let go, where the pointer was.
    input(ANN.identity, down);
    input(ANN.identity, { type: "mouseMove", x: 0.25, y: 0.5, button: "left", buttons: 1, clickCount: 0, modifiers: [] });
    input(ANN.identity, { type: "keyDown", key: "a", code: "KeyA", modifiers: [] });
    await service.command({ type: "setControllable", windowId: "a", allowed: false });
    expect(released()).toEqual([
      { type: "mouseUp", x: 150, y: 185, button: "left", clickCount: 1, modifiers: [] },
      { type: "keyUp", keyCode: "a", modifiers: [] },
    ]);
    // The guest's own release, after, is the one the page already had: nothing more.
    input(ANN.identity, up);
    expect(released()).toHaveLength(2);

    // The host goes to another space mid-press.
    await service.command({ type: "setControllable", windowId: "a", allowed: true });
    sent.length = 0;
    input(ANN.identity, down);
    world.current = "g2";
    service.refresh();
    expect(released()).toEqual([atRest]);
    world.current = "g1";
    service.refresh();

    // Bo is removed mid-press, and Ann leaves the room with one.
    sent.length = 0;
    input(BO.identity, down);
    await service.command({ type: "remove", identity: BO.identity });
    expect(released()).toEqual([atRest]);
    input(ANN.identity, down);
    service.hostReport({ type: "roster", guests: [] });
    expect(released()).toEqual([atRest, atRest]);

    // And the share stopping lets go of the last.
    service.hostReport({ type: "roster", guests: [ANN] });
    await settle();
    sent.length = 0;
    input(ANN.identity, down);
    await service.command({ type: "stop" });
    expect(released()).toEqual([atRest]);
  });

  it("draws: the host window takes the pointer, and gives it back when the app says the drawing ended", async () => {
    const { service, host, cards } = await live();
    await service.command({ type: "setDrawing", drawing: { tool: "pen", color: "#E54D2E" } });
    expect(host.drawing).toEqual([true]);
    expect(service.state.drawing).toEqual({ tool: "pen", color: "#E54D2E" });
    service.hostReport({ type: "drawEnded" });
    expect(host.drawing).toEqual([true, false]);
    expect(service.state.drawing).toBeNull();
    service.hostReport({ type: "interactive", active: true });
    expect(host.interactive).toEqual([true]);
    service.hostReport({ type: "openCard" });
    expect(cards).toHaveLength(1);
  });

  it("keeps the host's token fresh: a heartbeat's new token goes to the app, and the room asking always gets one", async () => {
    const { service, control, events } = await live();
    control.heartbeat.mockResolvedValueOnce({ token: "t2" });
    await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS);
    expect(events("token")).toEqual([{ type: "token", token: "t2" }]);
    expect(service.hostConfig()?.livekit.token).toBe("t2");
    control.heartbeat.mockResolvedValueOnce({ token: "t3" });
    service.hostReport({ type: "tokenExpiring" });
    await settle();
    expect(events("token").at(-1)).toEqual({ type: "token", token: "t3" });
    // Asked when control has nothing newer (the room reconnecting), or cannot be reached: the token held.
    control.heartbeat.mockRejectedValueOnce(new Error("offline"));
    service.hostReport({ type: "tokenExpiring" });
    await settle();
    expect(events("token")).toHaveLength(3);
    expect(events("token").at(-1)).toEqual({ type: "token", token: "t3" });
    // A heartbeat with nothing new says nothing.
    await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS);
    expect(events("token")).toHaveLength(3);
  });

  it("asks control for a fresh token when the room must join again, though the answer that brought the last was lost", async () => {
    const { service, control, events } = await live();
    // The minute's heartbeat had control mint the next token, but its answer never came: control holds that one new.
    control.heartbeat.mockRejectedValueOnce(new Error("socket hang up"));
    await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS);
    expect(events("token")).toEqual([]);
    // So control gives a token now only when asked for one.
    let minted = 2;
    control.heartbeat.mockImplementation(async (_shareId, ask) => ({ token: ask?.refresh === true ? `t${String((minted += 1))}` : null }));
    service.hostReport({ type: "tokenExpiring" });
    await settle();
    expect(events("token")).toEqual([{ type: "token", token: "t3" }]);
    expect(service.hostConfig()?.livekit.token).toBe("t3");
    // The minute's heartbeat asks for none: the token held serves until the room must join again.
    await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS);
    expect(events("token")).toHaveLength(1);
    service.hostReport({ type: "tokenExpiring" });
    await settle();
    expect(events("token").at(-1)).toEqual({ type: "token", token: "t4" });
  });

  it("takes the app's own controls as the shell's, but never a start", async () => {
    const { service, control } = await live();
    service.hostReport({ type: "command", command: { type: "setMic", on: true } });
    await settle();
    expect(service.state.local.mic).toBe(true);
    service.hostReport({ type: "command", command: { type: "start", groupId: "g2" } });
    await settle();
    expect(control.create).toHaveBeenCalledTimes(1);
    service.hostReport({ type: "command", command: { type: "stop" } });
    await settle();
    expect(service.state).toMatchObject({ status: "idle", ended: "stopped" });
  });

  it("puts the host's camera or mic back off when the app says it did not take, and says why", async () => {
    const { service } = await live();
    await service.command({ type: "setCamera", on: true });
    await service.command({ type: "setBackground", background: { kind: "blur" } });
    service.hostReport({ type: "mediaFailed", kind: "camera", error: "No camera was found." });
    expect(service.state.local).toMatchObject({ camera: false, background: { kind: "blur" } });
    expect(service.state.error).toBe("No camera was found.");
    await service.command({ type: "setMic", on: true });
    service.hostReport({ type: "mediaFailed", kind: "mic", error: "No microphone was found." });
    expect(service.state.local.mic).toBe(false);
  });

  it("names the background the camera shows when the one chosen did not take — the one it had, not the one that failed — and says why", async () => {
    const { service, events } = await live();
    await service.command({ type: "setCamera", on: true });
    await service.command({ type: "setBackground", background: { kind: "blur" } });
    await service.command({ type: "setBackground", background: { kind: "image", url: "data:image/svg+xml,dusk" } });
    service.hostReport({ type: "mediaFailed", kind: "background", tried: { kind: "image", url: "data:image/svg+xml,dusk" }, background: { kind: "blur" }, error: "The camera background didn't load. Try again." });
    expect(service.state.local).toMatchObject({ camera: true, background: { kind: "blur" } });
    expect(service.state.error).toBe("The camera background didn't load. Try again.");
    // The live-host app hears it as main's word, and so does the Live card.
    await settle();
    expect(events("state").at(-1)?.state.local.background).toEqual({ kind: "blur" });
  });

  it("lets a background that did not take go when the host has chosen another since: that one answers for itself", async () => {
    const { service } = await live();
    await service.command({ type: "setCamera", on: true });
    await service.command({ type: "setBackground", background: { kind: "blur" } });
    await service.command({ type: "setBackground", background: { kind: "image", url: "data:image/svg+xml,dusk" } });
    await service.command({ type: "setBackground", background: { kind: "image", url: "data:image/svg+xml,lagoon" } });
    service.hostReport({ type: "mediaFailed", kind: "background", tried: { kind: "image", url: "data:image/svg+xml,dusk" }, background: { kind: "blur" }, error: "The camera background didn't load. Try again." });
    expect(service.state.local.background).toEqual({ kind: "image", url: "data:image/svg+xml,lagoon" });
    expect(service.state.error).toBeNull();
  });

  it("tells guests in the desk frame whether they may draw", async () => {
    const { service, events } = await live();
    service.setDesk(desk());
    await vi.advanceTimersByTimeAsync(40);
    expect(events("desk").at(-1)?.frame.guestsCanDraw).toBe(true);
    await service.command({ type: "setGuestsCanDraw", allowed: false });
    await vi.advanceTimersByTimeAsync(40);
    expect(events("desk").at(-1)?.frame.guestsCanDraw).toBe(false);
  });

  it("keeps a removed guest out for the share: never one of its guests again, and shown out again whenever they are back", async () => {
    const { service, control, sent, events } = await live();
    service.setDesk(desk());
    await service.command({ type: "setControllable", windowId: "a", allowed: true });
    service.hostReport({ type: "roster", guests: [ANN, BO] });
    await settle();
    // The host app hears who may receive the room.
    expect(events("admitted").at(-1)).toEqual({ type: "admitted", identities: [ANN.identity, BO.identity] });
    const removal = deferred<void>();
    control.remove.mockReturnValueOnce(removal.promise);
    const removing = service.command({ type: "remove", identity: ANN.identity });
    // At once, before control or LiveKit answer: not a guest, nothing sent them, their hands off the windows.
    expect(service.state.participants.map((guest) => guest.identity)).toEqual([BO.identity]);
    expect(events("admitted").at(-1)).toEqual({ type: "admitted", identities: [BO.identity] });
    const press = { type: "mouseDown", x: 0.5, y: 0.5, button: "left", buttons: 1, clickCount: 1, modifiers: [] };
    service.hostReport({ type: "input", from: ANN.identity, windowId: "a", event: press });
    service.hostReport({ type: "chat", from: ANN.identity, id: "m1", text: "still here" });
    service.hostReport({ type: "ask", from: ANN.identity, windowId: "b" });
    // A roster that still lists them while control is at it asks for nothing more.
    service.hostReport({ type: "roster", guests: [ANN, BO] });
    await settle();
    expect(sent).toEqual([]);
    expect(service.state.chat).toEqual([]);
    expect(service.state.asks).toEqual([]);
    expect(control.remove).toHaveBeenCalledTimes(1);
    removal.resolve();
    await removing;
    service.hostReport({ type: "roster", guests: [BO] });
    await settle();
    // Back with a token LiveKit refreshed: still no guest of the share's, and control shows them out again.
    const admittedSends = events("admitted").length;
    service.hostReport({ type: "roster", guests: [BO, ANN] });
    await settle();
    expect(control.remove).toHaveBeenCalledTimes(2);
    expect(control.remove).toHaveBeenLastCalledWith("s1", ANN.identity);
    expect(service.state.participants.map((guest) => guest.identity)).toEqual([BO.identity]);
    expect(events("admitted")).toHaveLength(admittedSends);
    // A guest turned away at the door is never let in by a token either.
    await service.command({ type: "deny", requestId: "cy333" });
    service.hostReport({ type: "roster", guests: [BO, { ...ANN, identity: "g_cy333", name: "Cy" }] });
    await settle();
    expect(control.remove).toHaveBeenLastCalledWith("s1", "g_cy333");
    expect(service.hostConfig()?.admitted).toEqual([BO.identity]);
  });

  it("shows a removed guest the room still lists out again on every lobby read, though the room reported nothing new", async () => {
    const { service, control } = await live();
    service.hostReport({ type: "roster", guests: [ANN, BO] });
    await settle();
    await service.command({ type: "remove", identity: ANN.identity });
    await settle();
    expect(control.remove).toHaveBeenCalledTimes(1);
    // Ann is back under her identity before the room said she left: its roster never changed, so no report says so.
    await vi.advanceTimersByTimeAsync(LIVE_KNOCK_POLL_MS);
    expect(control.remove).toHaveBeenCalledTimes(2);
    expect(control.remove).toHaveBeenLastCalledWith("s1", ANN.identity);
    // Each read asks again while the room lists her, never twice at once.
    const removal = deferred<void>();
    control.remove.mockReturnValueOnce(removal.promise);
    await vi.advanceTimersByTimeAsync(LIVE_KNOCK_POLL_MS);
    await vi.advanceTimersByTimeAsync(LIVE_KNOCK_POLL_MS);
    expect(control.remove).toHaveBeenCalledTimes(3);
    removal.resolve();
    await settle();
    // Gone from the room: reads ask nothing more, and she was never one of the share's guests again.
    service.hostReport({ type: "roster", guests: [BO] });
    await vi.advanceTimersByTimeAsync(LIVE_KNOCK_POLL_MS);
    expect(control.remove).toHaveBeenCalledTimes(3);
    expect(service.state.participants.map((guest) => guest.identity)).toEqual([BO.identity]);
  });

  it("asks control again, 1, 2, 4… s on and at most 30 s apart, until it confirms a removal, though nothing else would ask (anyone may join)", async () => {
    const { service, control } = await live();
    await service.command({ type: "setAdmission", admission: "open" });
    service.hostReport({ type: "roster", guests: [ANN, BO] });
    await settle();
    expect(service.state.participants.map((guest) => guest.identity)).toEqual([ANN.identity, BO.identity]);
    control.remove.mockRejectedValue(new ControlError(502, "live_unavailable", "POST", "/v1/live/shares/s1/participants/g_ann1/remove"));
    await service.command({ type: "remove", identity: ANN.identity });
    expect(control.remove).toHaveBeenCalledTimes(1);
    // Out for the host at once, who is told it has not gone through yet.
    expect(service.state.participants.map((guest) => guest.identity)).toEqual([BO.identity]);
    expect(service.state.error).toBe("Couldn't remove Ann from the room yet. Trying again.");
    let asked = 1;
    for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, LIVE_REMOVE_RETRY_MAX_MS, LIVE_REMOVE_RETRY_MAX_MS]) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(control.remove, `${String(wait)} ms on`).toHaveBeenCalledTimes(asked);
      await vi.advanceTimersByTimeAsync(1);
      expect(control.remove).toHaveBeenCalledTimes((asked += 1));
    }
    // A roster that still lists her while a try waits asks nothing more.
    service.hostReport({ type: "roster", guests: [ANN, BO] });
    await settle();
    expect(control.remove).toHaveBeenCalledTimes(asked);
    // LiveKit is back: the next try is confirmed, the host's word on it goes, and nothing more is asked.
    control.remove.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(LIVE_REMOVE_RETRY_MAX_MS);
    expect(control.remove).toHaveBeenCalledTimes((asked += 1));
    expect(service.state.error).toBeNull();
    service.hostReport({ type: "roster", guests: [BO] });
    await vi.advanceTimersByTimeAsync(10 * LIVE_REMOVE_RETRY_MAX_MS);
    expect(control.remove).toHaveBeenCalledTimes(asked);
    expect(control.remove.mock.calls.every(([shareId, identity]) => shareId === "s1" && identity === ANN.identity)).toBe(true);
  });

  it("asks again, until control confirms, to show out whoever it no longer lets in; never for someone it has no request of, nor once the share ends", async () => {
    const { service, control } = await live();
    await service.command({ type: "setAdmission", admission: "open" });
    await settle();
    control.remove.mockRejectedValue(new Error("offline"));
    // Bo comes back though control has him gone: the read does not list him, and he is shown out.
    control.get.mockResolvedValue({ ended: false, knocks: [], admitted: new Set([ANN.identity]) });
    service.hostReport({ type: "roster", guests: [ANN, BO] });
    await settle();
    expect(control.remove).toHaveBeenCalledTimes(1);
    expect(control.remove).toHaveBeenLastCalledWith("s1", BO.identity);
    // (Main's own doing, not the host's: nothing to tell them.)
    expect(service.state.error).toBeNull();
    await vi.advanceTimersByTimeAsync(LIVE_REMOVE_RETRY_MS + 2 * LIVE_REMOVE_RETRY_MS);
    expect(control.remove).toHaveBeenCalledTimes(3);
    // Gone from the host's roster, he may still be LiveKit's: it is asked on.
    service.hostReport({ type: "roster", guests: [ANN] });
    await settle();
    await vi.advanceTimersByTimeAsync(4 * LIVE_REMOVE_RETRY_MS);
    expect(control.remove).toHaveBeenCalledTimes(4);
    // Control has no request of him (a token it never made): it cannot remove him, and is asked no more.
    control.remove.mockRejectedValueOnce(new ControlError(404, "live_not_found", "POST", "/v1/live/shares/s1/participants/g_bo22/remove"));
    await vi.advanceTimersByTimeAsync(8 * LIVE_REMOVE_RETRY_MS);
    expect(control.remove).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(10 * LIVE_REMOVE_RETRY_MAX_MS);
    expect(control.remove).toHaveBeenCalledTimes(5);
    expect(service.state.status).toBe("live");
    // Someone else shown out as the share stops: their next try never comes.
    service.hostReport({ type: "roster", guests: [ANN, { ...BO, identity: "g_cy333", name: "Cy" }] });
    await settle();
    expect(control.remove).toHaveBeenCalledTimes(6);
    await service.command({ type: "stop" });
    await vi.advanceTimersByTimeAsync(10 * LIVE_REMOVE_RETRY_MAX_MS);
    expect(control.remove).toHaveBeenCalledTimes(6);
  });

  it("ends the share when control, asked to remove someone, says it is over", async () => {
    const { service, control } = await live();
    service.hostReport({ type: "roster", guests: [ANN] });
    await settle();
    control.remove.mockRejectedValueOnce(new ControlError(409, "live_ended", "POST", "/v1/live/shares/s1/participants/g_ann1/remove"));
    await service.command({ type: "remove", identity: ANN.identity });
    await settle();
    expect(service.state).toMatchObject({ status: "idle", ended: "ended-elsewhere" });
    expect(control.end).not.toHaveBeenCalled();
  });

  it("shows out anyone in the room control no longer lets in, judged only by a read that set out after they came", async () => {
    const { service, control } = await live();
    const read = deferred<Awaited<ReturnType<LiveControl["get"]>>>();
    control.get.mockClear();
    control.get.mockReturnValueOnce(read.promise);
    // Ann joins: control is asked about her.
    service.hostReport({ type: "roster", guests: [ANN] });
    await settle();
    expect(control.get).toHaveBeenCalledTimes(1);
    // Bo comes while that read is out: it cannot speak for him (he was let in after it set out), so one more follows it.
    service.hostReport({ type: "roster", guests: [ANN, BO] });
    control.get.mockResolvedValueOnce({ ended: false, knocks: [], admitted: new Set([ANN.identity, BO.identity]) });
    read.resolve({ ended: false, knocks: [], admitted: new Set([ANN.identity]) });
    await settle();
    expect(control.get).toHaveBeenCalledTimes(2);
    expect(control.remove).not.toHaveBeenCalled();
    expect(service.state.participants.map((guest) => guest.identity)).toEqual([ANN.identity, BO.identity]);
    // Bo leaves, and is back though control has him gone (he left): a read that set out after he came does not list him.
    service.hostReport({ type: "roster", guests: [ANN] });
    control.get.mockResolvedValueOnce({ ended: false, knocks: [], admitted: new Set([ANN.identity]) });
    service.hostReport({ type: "roster", guests: [ANN, BO] });
    await settle();
    expect(control.remove).toHaveBeenCalledWith("s1", BO.identity);
    expect(service.state.participants.map((guest) => guest.identity)).toEqual([ANN.identity]);
  });

  it("lets a guest in only once control, asked after they came, lists them: until then, and ever for one it does not list, nothing is theirs", async () => {
    const { service, control, sent, held, events } = await live();
    service.setDesk(desk());
    await service.command({ type: "setControllable", windowId: "a", allowed: true });
    const read = deferred<Awaited<ReturnType<LiveControl["get"]>>>();
    control.get.mockClear();
    control.get.mockReturnValueOnce(read.promise);
    // Ann, let in, and someone control never let in (a token minted elsewhere) come into the room: control is asked at once.
    const stranger = { ...BO, identity: "g_stranger", name: "Stranger" };
    service.hostReport({ type: "roster", guests: [ANN, stranger] });
    await settle();
    expect(control.get).toHaveBeenCalledTimes(1);
    // Until it answers, neither is the share's guest: the host app lets nobody subscribe or hear the room, and nothing of theirs is heard.
    expect(events("admitted")).toEqual([]);
    expect(service.hostConfig()?.admitted).toEqual([]);
    expect(service.state.participants).toEqual([]);
    const press = { type: "mouseDown", x: 0.5, y: 0.5, button: "left", buttons: 1, clickCount: 1, modifiers: [] };
    service.hostReport({ type: "input", from: stranger.identity, windowId: "a", event: press });
    service.hostReport({ type: "chat", from: ANN.identity, id: "m1", text: "hello?" });
    service.hostReport({ type: "ask", from: stranger.identity, windowId: "b" });
    await settle();
    expect(sent).toEqual([]);
    expect(service.state.chat).toEqual([]);
    expect(service.state.asks).toEqual([]);
    expect(held.at(-1)).toEqual([]);
    // Control lists Ann: she is in. The stranger never is, and is shown out.
    read.resolve({ ended: false, knocks: [], admitted: new Set([ANN.identity]) });
    await settle();
    expect(events("admitted")).toEqual([{ type: "admitted", identities: [ANN.identity] }]);
    expect(service.state.participants.map((guest) => guest.identity)).toEqual([ANN.identity]);
    expect(held.at(-1)?.map((tab) => tab.tabId)).toEqual(["a", "b"]);
    expect(control.remove).toHaveBeenCalledWith("s1", stranger.identity);
    // Back in the room after leaving it, Ann is asked about afresh, and is in again once control lists her.
    service.hostReport({ type: "roster", guests: [stranger] });
    await settle();
    expect(events("admitted").at(-1)).toEqual({ type: "admitted", identities: [] });
    const again = deferred<Awaited<ReturnType<LiveControl["get"]>>>();
    const third = deferred<Awaited<ReturnType<LiveControl["get"]>>>();
    control.get.mockReturnValueOnce(again.promise).mockReturnValueOnce(third.promise);
    service.hostReport({ type: "roster", guests: [stranger, ANN] });
    await settle();
    expect(events("admitted").at(-1)).toEqual({ type: "admitted", identities: [] });
    // She leaves and is back while that read is out: it speaks for the Ann who came before it, not this one.
    service.hostReport({ type: "roster", guests: [stranger] });
    service.hostReport({ type: "roster", guests: [stranger, ANN] });
    again.resolve({ ended: false, knocks: [], admitted: new Set([ANN.identity]) });
    await settle();
    expect(events("admitted").at(-1)).toEqual({ type: "admitted", identities: [] });
    third.resolve({ ended: false, knocks: [], admitted: new Set([ANN.identity]) });
    await settle();
    expect(events("admitted").at(-1)).toEqual({ type: "admitted", identities: [ANN.identity] });
    // A read that fails is tried again soon while someone waits on it, not only at the next poll (there is none while anyone may join).
    await service.command({ type: "setAdmission", admission: "open" });
    await settle();
    control.get.mockClear();
    control.get.mockRejectedValueOnce(new Error("offline"));
    service.hostReport({ type: "roster", guests: [stranger, ANN, BO] });
    await settle();
    expect(control.get).toHaveBeenCalledTimes(1);
    expect(events("admitted").at(-1)).toEqual({ type: "admitted", identities: [ANN.identity] });
    await vi.advanceTimersByTimeAsync(LIVE_LOBBY_RETRY_MS);
    expect(control.get).toHaveBeenCalledTimes(2);
    expect(events("admitted").at(-1)).toEqual({ type: "admitted", identities: [ANN.identity, BO.identity] });
    // Whoever it was, the stranger was never named to the host app.
    expect(events("admitted").flatMap((event) => event.identities)).not.toContain(stranger.identity);
    expect(service.hostConfig()?.admitted).toEqual([ANN.identity, BO.identity]);
  });

  it("shows out a guest it let in once a later read no longer lists them, though the room said nothing new; with anyone free to join, each heartbeat reads", async () => {
    const { service, control, sent, events } = await live();
    service.setDesk(desk());
    await service.command({ type: "setControllable", windowId: "a", allowed: true });
    await service.command({ type: "setAdmission", admission: "open" });
    // Nobody let in: the minute's beat reads nothing (no knock waits on a read while anyone may join).
    control.get.mockClear();
    await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS);
    expect(control.get).not.toHaveBeenCalled();
    service.hostReport({ type: "roster", guests: [ANN, BO] });
    await settle();
    expect(events("admitted").at(-1)).toEqual({ type: "admitted", identities: [ANN.identity, BO.identity] });
    const down = { type: "mouseDown", x: 0.5, y: 0.5, button: "left", buttons: 1, clickCount: 1, modifiers: [] };
    service.hostReport({ type: "input", from: BO.identity, windowId: "a", event: down });
    expect(service.state.using).toEqual([{ windowId: "a", identity: BO.identity }]);
    // Control lets Bo go (he left, or the sweep found him gone) while LiveKit keeps him — its removal failed, or he is back
    // under his identity before the room said he left — so the room reports nothing new, and nothing else would read.
    control.get.mockClear();
    control.get.mockResolvedValue({ ended: false, knocks: [], admitted: new Set([ANN.identity]) });
    control.remove.mockRejectedValueOnce(new ControlError(502, "live_unavailable", "POST", "/v1/live/shares/s1/participants/g_bo22/remove"));
    sent.length = 0;
    await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS - 1);
    expect(control.get).not.toHaveBeenCalled();
    expect(service.state.participants.map((guest) => guest.identity)).toEqual([ANN.identity, BO.identity]);
    await vi.advanceTimersByTimeAsync(1);
    expect(control.get).toHaveBeenCalledTimes(1);
    // Out at once: no guest of the share's, the host app told (whom it lets subscribe, and the guests' list of who is
    // with them), his hands off the window and what he held down let go.
    expect(service.state.participants.map((guest) => guest.identity)).toEqual([ANN.identity]);
    expect(events("admitted").at(-1)).toEqual({ type: "admitted", identities: [ANN.identity] });
    expect(service.hostConfig()?.admitted).toEqual([ANN.identity]);
    expect(service.state.using).toEqual([]);
    expect(events("grant").at(-1)).toEqual({ type: "grant", windowId: "a", identity: null });
    expect(sent.flatMap(({ steps }) => steps)).toEqual([{ type: "mouseUp", x: 300, y: 185, button: "left", clickCount: 1, modifiers: [] }]);
    const out = events("admitted").length;
    // Nothing of his is heard.
    service.hostReport({ type: "input", from: BO.identity, windowId: "a", event: down });
    service.hostReport({ type: "chat", from: BO.identity, id: "m1", text: "still here" });
    service.hostReport({ type: "ask", from: BO.identity, windowId: "b" });
    await settle();
    expect(sent).toHaveLength(1);
    expect(service.state.chat).toEqual([]);
    expect(service.state.asks).toEqual([]);
    // Control shows him out, asked again until it confirms.
    expect(control.remove).toHaveBeenCalledTimes(1);
    expect(control.remove).toHaveBeenLastCalledWith("s1", BO.identity);
    await vi.advanceTimersByTimeAsync(LIVE_REMOVE_RETRY_MS);
    expect(control.remove).toHaveBeenCalledTimes(2);
    expect(control.remove).toHaveBeenLastCalledWith("s1", BO.identity);
    // A read speaks only of guests who came before it set out: Ann leaves while one is out and is back, and that read,
    // not listing her, is no word on this coming of hers — the read that follows decides, and lists her.
    const read = deferred<Awaited<ReturnType<LiveControl["get"]>>>();
    control.get.mockReturnValueOnce(read.promise);
    await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS);
    expect(control.get).toHaveBeenCalledTimes(2);
    service.hostReport({ type: "roster", guests: [BO] });
    service.hostReport({ type: "roster", guests: [BO, ANN] });
    read.resolve({ ended: false, knocks: [], admitted: new Set() });
    await settle();
    expect(control.get).toHaveBeenCalledTimes(3);
    expect(control.remove).not.toHaveBeenCalledWith("s1", ANN.identity);
    expect(events("admitted").at(-1)).toEqual({ type: "admitted", identities: [ANN.identity] });
    expect(events("admitted").slice(out).flatMap((event) => event.identities)).not.toContain(BO.identity);
  });

  it("keeps a knock it could not answer: back at the door with why, and read from the lobby after", async () => {
    const { service, control } = await live();
    control.get.mockResolvedValue({ ended: false, admitted: new Set(), knocks: [{ requestId: "r9", name: "Dee" }] });
    await vi.advanceTimersByTimeAsync(LIVE_KNOCK_POLL_MS);
    expect(service.state.knocks.map((knock) => knock.requestId)).toEqual(["r9"]);
    // Eight are in: control turns the admit down.
    control.decide.mockRejectedValueOnce(new ControlError(409, "live_full", "POST", "/v1/live/shares/s1/requests/r9"));
    await service.command({ type: "admit", requestId: "r9" });
    expect(service.state.knocks.map((knock) => knock.requestId)).toEqual(["r9"]);
    expect(service.state.error).toBe("The share is full.");
    // Later reads list it still, and the room's word of it is heard.
    await vi.advanceTimersByTimeAsync(LIVE_KNOCK_POLL_MS);
    expect(service.state.knocks.map((knock) => knock.requestId)).toEqual(["r9"]);
    // Unreachable: the same.
    control.decide.mockRejectedValueOnce(new Error("offline"));
    await service.command({ type: "deny", requestId: "r9" });
    expect(service.state.knocks.map((knock) => knock.requestId)).toEqual(["r9"]);
    expect(service.state.error).toBe("Couldn't reach Pistachio. Check your connection and try again.");
    // A seat free, the host lets them in after all.
    await service.command({ type: "admit", requestId: "r9" });
    expect(control.decide).toHaveBeenLastCalledWith("s1", "r9", "admit");
    expect(service.state).toMatchObject({ knocks: [], error: null });
  });

  it("makes one share at a time: one still being made for a start that was stopped lands before the next is made", async () => {
    const harness = setup();
    const first = deferred<Awaited<ReturnType<LiveControl["create"]>>>();
    harness.control.create.mockReturnValueOnce(first.promise);
    const starting = harness.service.command({ type: "start", groupId: "g1" });
    await settle();
    await harness.service.command({ type: "stop" });
    const again = harness.service.command({ type: "start", groupId: "g1" });
    await settle();
    // Control has not answered the first: the second is not asked for yet.
    expect(harness.control.create).toHaveBeenCalledTimes(1);
    first.resolve({ shareId: "s0", link: "https://x.test/live/old", admission: "ask", livekit: { url: "ws://x", token: "t" } });
    await starting;
    await again;
    await settle();
    expect(harness.control.create).toHaveBeenCalledTimes(2);
    expect(harness.control.end).toHaveBeenCalledWith("s0");
    expect(harness.service.state).toMatchObject({ status: "live", shareId: "s1" });
    expect(harness.host.opened).toBe(1);
  });

  it("sends a guest's speaking to the shell as the guests alone, not the share with its chat again, and not to the host app", async () => {
    const { service, states, rosters, events } = await live();
    service.hostReport({ type: "roster", guests: [ANN] });
    await settle();
    const published = states.length;
    const told = events("state").length;
    service.hostReport({ type: "roster", guests: [{ ...ANN, speaking: true }] });
    await settle();
    service.hostReport({ type: "roster", guests: [{ ...ANN, speaking: false, connection: "poor" }] });
    await settle();
    expect(rosters).toEqual([[{ ...ANN, speaking: true }], [{ ...ANN, speaking: false, connection: "poor" }]]);
    expect(states).toHaveLength(published);
    expect(events("state")).toHaveLength(told);
    expect(service.state.participants).toEqual([{ ...ANN, speaking: false, connection: "poor" }]);
    // Anything else — a mute, a join — is the share whole again.
    service.hostReport({ type: "roster", guests: [{ ...ANN, micOn: false, connection: "poor" }] });
    await settle();
    expect(states).toHaveLength(published + 1);
    expect(states.at(-1)?.participants[0]?.micOn).toBe(false);
    expect(events("state")).toHaveLength(told + 1);
  });

  it("renames the share in the guests' lobby once the space's new name has stood a moment", async () => {
    const { service, control, world } = await live();
    world.title = "Q4 pla";
    service.refresh();
    world.title = "Q4 plan";
    for (let tick = 0; tick < 4; tick += 1) {
      service.refresh();
      await vi.advanceTimersByTimeAsync(LIVE_RETITLE_MS / 4);
    }
    expect(control.update).toHaveBeenCalledTimes(1);
    expect(control.update).toHaveBeenCalledWith("s1", { title: "Q4 plan" });
    service.refresh();
    await vi.advanceTimersByTimeAsync(LIVE_RETITLE_MS);
    expect(control.update).toHaveBeenCalledTimes(1);
  });

  it("names the share as control keeps names, so control's word on a name it cleaned asks for nothing again", async () => {
    const { service, control, world } = setup();
    world.title = "\u200Fשלום\u0007  team ";
    await service.command({ type: "start", groupId: "g1", hostName: "Zach" });
    await settle();
    expect(control.create).toHaveBeenCalledWith({ title: "שלום team", hostName: "Zach" });
    control.get.mockResolvedValue({ ended: false, knocks: [], admitted: new Set(), settings: { admission: "ask", title: "שלום team" } });
    await vi.advanceTimersByTimeAsync(LIVE_KNOCK_POLL_MS);
    expect(control.update).not.toHaveBeenCalled();
    // Cut to 200 characters, it never ends in a space control would trim.
    world.title = `${"x".repeat(199)} tail`;
    service.refresh();
    await vi.advanceTimersByTimeAsync(LIVE_RETITLE_MS);
    expect(control.update).toHaveBeenCalledWith("s1", { title: "x".repeat(199) });
  });

  it("sends control one update of the share at a time, only the newest of each choice after it, so control ends on what the card says", async () => {
    const { service, control, world } = await live();
    // Control as it takes an update: when it answers.
    const held = { admission: "ask", title: "Launch plan" };
    const answers: Array<() => void> = [];
    control.update.mockImplementation(
      (_shareId, patch) =>
        new Promise<void>((resolve) =>
          answers.push(() => {
            Object.assign(held, patch);
            resolve();
          }),
        ),
    );
    const picks = (["open", "ask", "open", "ask"] as const).map((admission) => service.command({ type: "setAdmission", admission }));
    // Renamed while the first is on its way: the new name waits for it too.
    world.title = "Q4 plan";
    service.refresh();
    await vi.advanceTimersByTimeAsync(LIVE_RETITLE_MS);
    expect(answers).toHaveLength(1);
    // Answered latest first, as a control taking them all at once might apply them.
    while (answers.length > 0) {
      answers.pop()?.();
      await settle();
    }
    await Promise.all(picks);
    expect(service.state.admission).toBe("ask");
    expect(held).toEqual({ admission: "ask", title: "Q4 plan" });
    expect(control.update.mock.calls).toEqual([
      ["s1", { admission: "open" }],
      ["s1", { admission: "ask", title: "Q4 plan" }],
    ]);
  });

  it("puts control back on the host's choices when a read finds it holding others, judging only by a read that crossed no update", async () => {
    const { service, control } = await live();
    // An update main took for failed that control applied after all: the card is back on Ask me, control lets anyone in.
    control.update.mockRejectedValueOnce(new Error("offline"));
    await service.command({ type: "setAdmission", admission: "open" });
    expect(service.state).toMatchObject({ admission: "ask", error: "Couldn't reach Pistachio. Check your connection and try again." });
    control.get.mockResolvedValue({ ended: false, knocks: [], admitted: new Set(), settings: { admission: "open", title: "Launch plan" } });
    await vi.advanceTimersByTimeAsync(LIVE_KNOCK_POLL_MS);
    expect(control.update).toHaveBeenLastCalledWith("s1", { admission: "ask" });
    // With anyone free to join no knock poll reads the lobby: the minute's heartbeat says what control holds (a rename it never took, too).
    await service.command({ type: "setAdmission", admission: "open" });
    control.update.mockClear();
    control.heartbeat.mockResolvedValueOnce({ token: null, settings: { admission: "ask", title: "Launch" } });
    await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS);
    expect(control.update.mock.calls).toEqual([["s1", { admission: "open", title: "Launch plan" }]]);
    // A read that set out before an update went may carry what control held before it: it asks for nothing.
    control.update.mockClear();
    const read = deferred<Awaited<ReturnType<LiveControl["get"]>>>();
    control.get.mockReturnValueOnce(read.promise);
    const update = deferred<void>();
    control.update.mockReturnValueOnce(update.promise);
    const picked = service.command({ type: "setAdmission", admission: "ask" });
    await settle();
    update.resolve();
    await picked;
    read.resolve({ ended: false, knocks: [], admitted: new Set(), settings: { admission: "open", title: "Launch plan" } });
    await settle();
    expect(control.update.mock.calls).toEqual([["s1", { admission: "ask" }]]);
  });

  it("holds the streamed windows awake only while guests are in, letting them go 30 s after the last left; the space is the share's throughout", async () => {
    const { service, held, heldGroups } = await live();
    service.setDesk(desk());
    // Nobody to see them: nothing is woken or laid out, but the space is named (Tidy leaves it be).
    expect(held.at(-1)).toEqual([]);
    expect(heldGroups.at(-1)).toBe("g1");
    service.hostReport({ type: "roster", guests: [ANN] });
    await settle();
    expect(held.at(-1)?.map((tab) => tab.tabId)).toEqual(["a", "b"]);
    // The last guest leaves (a reload, maybe): held a while yet, and back in time nothing is let go.
    service.hostReport({ type: "roster", guests: [] });
    await vi.advanceTimersByTimeAsync(LIVE_HOLD_GRACE_MS - 1_000);
    service.hostReport({ type: "roster", guests: [ANN] });
    await vi.advanceTimersByTimeAsync(LIVE_HOLD_GRACE_MS);
    expect(held.at(-1)?.map((tab) => tab.tabId)).toEqual(["a", "b"]);
    service.hostReport({ type: "roster", guests: [] });
    await vi.advanceTimersByTimeAsync(LIVE_HOLD_GRACE_MS - 1);
    expect(held.at(-1)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(held.at(-1)).toEqual([]);
    expect(heldGroups.at(-1)).toBe("g1");
    await service.command({ type: "stop" });
    expect(heldGroups.at(-1)).toBeNull();
  });
});
