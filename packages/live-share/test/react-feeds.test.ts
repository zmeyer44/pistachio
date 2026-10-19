import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendChat,
  CHAT_KEEP,
  chooseBackground,
  createEmitter,
  CursorFeed,
  GuestMediaMemory,
  InkStore,
  MediaButton,
  MediaSwitches,
  mediaProblemOf,
  mergeChat,
  newChatId,
  readBackground,
  switchReadsOn,
  type BackgroundControl,
  type GuestMediaPrefs,
  type MediaAvailability,
  type MediaButtonProps,
  type MediaControl,
  type MediaSwitchKind,
} from "../src/react/index.js";
import type { LiveBackground } from "../src/effects.js";
import { LASER_FADE_MS, MARK_RATE, STROKE_IDLE_MS, type LiveChatEntry } from "../src/index.js";
import { roomPingHandler, roomReactionHandler, type LivePingEvent, type LiveReactionEvent } from "../src/react/hooks.js";
import { MarkPile, MAX_MARKS_UP } from "../src/react/mark-pile.js";
import type { LiveParticipant } from "../src/room.js";

const entry = (id: string, text = id): LiveChatEntry => ({ id, from: "g_a", name: "Ana", color: "#E54D2E", text, at: 1 });

describe("chat log", () => {
  it("appends once per sender and id", () => {
    const one = appendChat([], entry("a"));
    expect(appendChat(one, entry("a", "again"))).toBe(one);
    expect(appendChat(one, entry("b")).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("puts a sync's history first and keeps what came after it, once", () => {
    const local = [entry("c"), entry("d")];
    expect(mergeChat(local, [entry("a"), entry("b"), entry("c")]).map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("keys a message by its sender and id: a guest sending another's id first hides nothing, live or in the host's history", () => {
    const spoof: LiveChatEntry = { id: "host:1", from: "g_eve", name: "Eve", color: "#E54D2E", text: "not the host", at: 1 };
    const host: LiveChatEntry = { id: "host:1", from: "host", name: "Zach", color: "#388CF0", text: "welcome", at: 2 };
    const live = appendChat(appendChat([], spoof), host);
    expect(live.map((m) => m.text)).toEqual(["not the host", "welcome"]);
    // The same sender's message of that id again is the same message.
    expect(appendChat(live, { ...spoof, text: "again" })).toBe(live);
    // The host's history brings both; what reached this side live of either shows once.
    expect(mergeChat([spoof], [spoof, host]).map((m) => m.text)).toEqual(["not the host", "welcome"]);
    expect(mergeChat([spoof], [host]).map((m) => m.text)).toEqual(["welcome", "not the host"]);
  });

  it("keeps the newest when it grows past what a guest keeps", () => {
    let log: readonly LiveChatEntry[] = [];
    for (let n = 0; n < CHAT_KEEP + 5; n += 1) log = appendChat(log, entry(`m${String(n)}`));
    expect(log).toHaveLength(CHAT_KEEP);
    expect(log[0]?.id).toBe("m5");
  });

  it("makes ids the protocol takes, distinct per message", () => {
    const a = newChatId("g_abc123", 1_700_000_000_000);
    const b = newChatId("g_abc123", 1_700_000_000_000);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_:-]{1,64}$/u);
  });
});

describe("InkStore", () => {
  it("tells its listeners when the board changed, not when an op was refused", () => {
    const store = new InkStore();
    let changes = 0;
    store.subscribe(() => {
      changes += 1;
    });
    const ana = { identity: "g_a", role: "guest" as const };
    expect(store.apply({ op: "begin", id: "g_a:1", tool: "pen", color: "#E54D2E", size: 0.003, pts: [0.1, 0.1] }, ana, 0)).toBe(true);
    // Someone else's stroke id: refused, no news.
    expect(store.apply({ op: "add", id: "g_a:1", pts: [0.2, 0.2] }, { identity: "g_b", role: "guest" }, 1)).toBe(false);
    store.release("g_a", 2);
    store.release("g_a", 3);
    expect(changes).toBe(2);
    store.load([], 4, 5);
    expect(changes).toBe(3);
  });

  it("tells its listeners when a laser fades out, not at the next op", () => {
    vi.useFakeTimers();
    try {
      const store = new InkStore(undefined, () => Date.now());
      const counts: number[] = [];
      store.subscribe(() => counts.push(store.board.size));
      const ana = { identity: "g_a", role: "guest" as const };
      store.apply({ op: "begin", id: "g_a:1", tool: "laser", color: "#E54D2E", size: 0.003, pts: [0.1, 0.1] }, ana);
      vi.advanceTimersByTime(100);
      store.apply({ op: "end", id: "g_a:1" }, ana);
      expect(counts).toEqual([1, 1]);
      vi.advanceTimersByTime(LASER_FADE_MS - 1);
      expect(counts).toEqual([1, 1]);
      vi.advanceTimersByTime(1);
      expect(counts).toEqual([1, 1, 0]);
      // Nothing left to wait for.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wakes its layer when an open stroke goes idle, so it is drawn as finished", () => {
    vi.useFakeTimers();
    try {
      const store = new InkStore(undefined, () => Date.now());
      let wakes = 0;
      store.subscribe(() => {
        wakes += 1;
      });
      store.load([{ id: "g_a:1", tool: "pen", color: "#E54D2E", size: 0.003, pts: [0.1, 0.1], done: false }], Date.now());
      expect(wakes).toBe(1);
      vi.advanceTimersByTime(STROKE_IDLE_MS);
      expect(wakes).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CursorFeed", () => {
  it("wakes its layer on every sample and removal", () => {
    const feed = new CursorFeed();
    let wakes = 0;
    feed.onWake(() => {
      wakes += 1;
    });
    feed.push("host", { x: 0.5, y: 0.5, tool: "pointer" }, 0);
    feed.remove("host");
    expect(wakes).toBe(2);
    expect(feed.smoother.sample(10)).toEqual([]);
  });

  it("puts a held pointer away at once, drops its samples while held, and shows it again with the next one after", () => {
    const feed = new CursorFeed();
    feed.push("host", { x: 0.5, y: 0.5, tool: "pointer" }, 0);
    feed.push("g_a", { x: 0.2, y: 0.2, tool: "pointer" }, 0);
    feed.hold("host", true);
    expect(feed.smoother.sample(10).map((cursor) => cursor.id)).toEqual(["g_a"]);
    // A sample still on its way when the host left.
    feed.push("host", { x: 0.6, y: 0.6, tool: "pointer" }, 20);
    expect(feed.smoother.sample(30).map((cursor) => cursor.id)).toEqual(["g_a"]);
    feed.hold("host", false);
    expect(feed.smoother.sample(40).map((cursor) => cursor.id)).toEqual(["g_a"]);
    feed.push("host", { x: 0.7, y: 0.7, tool: "pointer" }, 50);
    expect(feed.smoother.sample(60).map((cursor) => cursor.id).sort()).toEqual(["g_a", "host"]);
  });
});

describe("pings and reactions from the room", () => {
  const ana = { identity: "g_ana", role: "guest" } as const;
  const bo = { identity: "g_bo", role: "guest" } as const;
  const people = [
    { identity: "g_ana", color: "#E54D2E" },
    { identity: "g_bo", color: "#30A46C" },
  ] as LiveParticipant[];
  const room = { participants: () => people };

  it("draws any one participant's pings at most 4 a second, 8 at once, and nobody else's fewer for it", () => {
    let now = 0;
    const drawn: LivePingEvent[] = [];
    const feed = createEmitter<LivePingEvent>();
    feed.on((ping) => drawn.push(ping));
    const hear = roomPingHandler(room, feed, () => now);
    // Another guest, straight to this one (§4), sends a thousand at once.
    for (let n = 0; n < 1000; n += 1) hear({ x: 0.5, y: 0.5 }, ana);
    expect(drawn).toHaveLength(MARK_RATE.burst);
    hear({ x: 0.2, y: 0.8 }, bo);
    expect(drawn.at(-1)).toEqual({ x: 0.2, y: 0.8, color: "#30A46C" });
    // A second on, four more of theirs.
    now = 1000;
    for (let n = 0; n < 1000; n += 1) hear({ x: 0.5, y: 0.5 }, ana);
    expect(drawn).toHaveLength(MARK_RATE.burst + 1 + MARK_RATE.rate);
    // Nobody the room vouches for, or someone not among the participants: not drawn.
    hear({ x: 0.5, y: 0.5 }, { identity: null, role: "server" });
    hear({ x: 0.5, y: 0.5 }, { identity: "g_gone", role: "guest" });
    expect(drawn).toHaveLength(MARK_RATE.burst + 1 + MARK_RATE.rate);
  });

  it("draws any one participant's reactions at most 4 a second, 8 at once", () => {
    let now = 0;
    const drawn: LiveReactionEvent[] = [];
    const feed = createEmitter<LiveReactionEvent>();
    feed.on((reaction) => drawn.push(reaction));
    const hear = roomReactionHandler(feed, () => now);
    for (let n = 0; n < 1000; n += 1) hear({ emoji: "🎉" }, ana);
    hear({ emoji: "👍" }, bo);
    expect(drawn).toHaveLength(MARK_RATE.burst + 1);
    expect(drawn.at(-1)).toEqual({ emoji: "👍", identity: "g_bo" });
    now = 500;
    for (let n = 0; n < 1000; n += 1) hear({ emoji: "🎉" }, ana);
    expect(drawn).toHaveLength(MARK_RATE.burst + 1 + MARK_RATE.rate / 2);
  });
});

describe("MarkPile", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const mark = (): { remove: ReturnType<typeof vi.fn> } => ({ remove: vi.fn() });

  it("takes each mark down when its life is over", () => {
    vi.useFakeTimers();
    const pile = new MarkPile(1600);
    const first = mark();
    pile.add(first);
    vi.advanceTimersByTime(1000);
    const second = mark();
    pile.add(second);
    vi.advanceTimersByTime(600);
    expect(first.remove).toHaveBeenCalledOnce();
    expect(second.remove).not.toHaveBeenCalled();
    expect(pile.size).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(second.remove).toHaveBeenCalledOnce();
    expect(pile.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds at most its cap, taking the oldest down early, its timer with it", () => {
    vi.useFakeTimers();
    const pile = new MarkPile(2600);
    const marks = Array.from({ length: MAX_MARKS_UP + 10 }, mark);
    for (const one of marks) pile.add(one);
    expect(pile.size).toBe(MAX_MARKS_UP);
    expect(vi.getTimerCount()).toBe(MAX_MARKS_UP);
    expect(marks.slice(0, 10).every((one) => one.remove.mock.calls.length === 1)).toBe(true);
    expect(marks.slice(10).every((one) => one.remove.mock.calls.length === 0)).toBe(true);
    // Their timers went with them: nothing is taken down twice.
    vi.advanceTimersByTime(2600);
    expect(marks.every((one) => one.remove.mock.calls.length === 1)).toBe(true);
  });

  it("takes everything down, timers too, when its layer goes", () => {
    vi.useFakeTimers();
    const pile = new MarkPile(1600);
    const marks = [mark(), mark()];
    for (const one of marks) pile.add(one);
    pile.clear();
    expect(marks.every((one) => one.remove.mock.calls.length === 1)).toBe(true);
    expect(pile.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("mediaProblemOf", () => {
  it("reads getUserMedia's refusals", () => {
    expect(mediaProblemOf(new DOMException("no", "NotAllowedError"))).toBe("blocked");
    expect(mediaProblemOf(new DOMException("none", "NotFoundError"))).toBe("missing");
    expect(mediaProblemOf(new DOMException("held", "NotReadableError"))).toBe("busy");
    expect(mediaProblemOf(new Error("?"))).toBe("failed");
    expect(mediaProblemOf(null)).toBe("failed");
  });
});

describe("chooseBackground", () => {
  const blur: LiveBackground = { kind: "blur" };
  const picture: LiveBackground = { kind: "image", url: "blob:the-picture" };

  /** A room or preview whose camera had blur on, and whose change goes as `outcome` says (putting the blur back when it fails). */
  function control(outcome: "on" | "failed" | "unsupported"): BackgroundControl {
    let chosen = blur;
    return {
      background: () => chosen,
      setBackground: async (background) => {
        chosen = background;
        if (outcome === "on") return true;
        chosen = blur;
        if (outcome === "unsupported") return false;
        throw new Error("the picture did not load");
      },
    };
  }

  it("tells the menu what the camera shows instead, and why, when a background is not put on; nothing when it is", async () => {
    const [on, failed, unsupported] = [vi.fn(), vi.fn(), vi.fn()];
    chooseBackground(control("on"), picture, on);
    chooseBackground(control("failed"), picture, failed);
    chooseBackground(control("unsupported"), picture, unsupported);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith(blur, "failed"));
    expect(unsupported).toHaveBeenCalledWith(blur, "unsupported");
    expect(on).not.toHaveBeenCalled();
  });
});

describe("MediaSwitches", () => {
  /** A room's camera and microphone: an on waits until the test lets it come (its prompt, its background loading); an off is at once. */
  function control() {
    const coming: Array<{ come(): void; fail(error: unknown): void }> = [];
    const calls: string[] = [];
    const turn = async (kind: string, on: boolean): Promise<void> => {
      calls.push(`${kind} ${on ? "on" : "off"}`);
      if (!on) return;
      await new Promise<void>((resolve, reject) => coming.push({ come: resolve, fail: reject }));
    };
    const media: MediaControl = { setCamera: (on) => turn("camera", on), setMicrophone: (on) => turn("microphone", on) };
    return { media, coming, calls };
  }

  it("turns a camera off while it comes on, at once; the on it overtook is neither the person's choice nor a failure", async () => {
    for (const lands of ["comes", "fails"] as const) {
      const { media, coming, calls } = control();
      const switches = new MediaSwitches(media);
      const heard = vi.fn();
      switches.subscribe(heard);
      const on = switches.set("camera", true);
      expect(switches.state()).toMatchObject({ busy: { camera: true }, coming: { camera: true } });
      expect(await switches.set("camera", false)).toBe("done");
      expect(calls).toEqual(["camera on", "camera off"]);
      expect(switches.state()).toMatchObject({ busy: { camera: false }, coming: { camera: false }, problem: { camera: null } });
      const told = heard.mock.calls.length;
      if (lands === "comes") coming[0]!.come();
      else coming[0]!.fail(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
      expect(await on).toBe("overtaken");
      expect(switches.state()).toMatchObject({ busy: { camera: false }, coming: { camera: false }, problem: { camera: null } });
      expect(heard).toHaveBeenCalledTimes(told);
    }
  });

  it("reads a camera or microphone coming on as on, so toggling it then turns it off, and it never comes on", async () => {
    for (const kind of ["camera", "microphone"] as const) {
      const { media, coming, calls } = control();
      const switches = new MediaSwitches(media);
      // As the room and the lobby toggle, by a click or a key: the opposite of what the switch reads, the device still off.
      const reads = (): boolean => switchReadsOn(switches.state(), kind, false);
      const toggle = () => switches.set(kind, !reads());
      expect(reads()).toBe(false);
      const on = toggle();
      expect(reads()).toBe(true);
      const off = toggle();
      expect(calls).toEqual([`${kind} on`, `${kind} off`]);
      expect(await off).toBe("done");
      coming[0]!.come();
      expect(await on).toBe("overtaken");
      expect(reads()).toBe(false);
      // On, it reads on, whatever is under way.
      expect(switchReadsOn(switches.state(), kind, true)).toBe(true);
    }
  });

  it("turns one on on the device asked for or, that one gone, on the default; never in place of one that failed otherwise", async () => {
    const calls: string[] = [];
    const failing = (name: string) => async (on: boolean, deviceId?: string) => {
      calls.push(`${on ? "on" : "off"} ${deviceId ?? "default"}`);
      if (deviceId !== undefined) throw Object.assign(new Error(name), { name });
    };
    const gone = new MediaSwitches({ setCamera: failing("OverconstrainedError"), setMicrophone: failing("NotFoundError") });
    // Each says the device it came on: the default (undefined) in place of the one gone.
    expect(await gone.setOnOrDefault("camera", "cam-gone")).toEqual({ outcome: "done", deviceId: undefined });
    expect(await gone.setOnOrDefault("microphone", "mic-gone")).toEqual({ outcome: "done", deviceId: undefined });
    expect(calls.splice(0)).toEqual(["on cam-gone", "on default", "on mic-gone", "on default"]);
    expect(gone.state().problem).toEqual({ microphone: null, camera: null });
    for (const name of ["NotAllowedError", "NotReadableError", "Error"]) {
      const refused = new MediaSwitches({ setCamera: failing(name), setMicrophone: failing(name) });
      expect(await refused.setOnOrDefault("camera", "cam-2")).toEqual({ outcome: "failed", deviceId: "cam-2" });
      expect(calls.splice(0)).toEqual(["on cam-2"]);
    }
  });

  it("says why the latest switch of a kind failed, and keeps the other kind's apart", async () => {
    const { media, coming } = control();
    const switches = new MediaSwitches(media);
    const microphone = switches.set("microphone", true);
    const camera = switches.set("camera", true);
    coming[0]!.fail(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
    expect(await microphone).toBe("failed");
    expect(switches.state()).toMatchObject({ busy: { microphone: false, camera: true }, coming: { camera: true }, problem: { microphone: "blocked", camera: null } });
    coming[1]!.come();
    expect(await camera).toBe("done");
    expect(switches.state()).toMatchObject({ busy: { camera: false }, coming: { camera: false }, problem: { microphone: "blocked", camera: null } });
  });

  /** A switch whose every on fails as `name` says; an off is at once. */
  const refusing = (name: string) => async (on: boolean) => {
    if (on) throw Object.assign(new Error(name), { name });
  };

  /**
   * The browser, as the test says: each list of devices asked for waits
   * until the test answers it; each kind's permission a status whose state
   * the test changes.
   */
  function browser() {
    const lists: Array<(kinds: string[]) => void> = [];
    const devices = Object.assign(new EventTarget(), {
      enumerateDevices: () => new Promise<Array<{ kind: string }>>((resolve) => lists.push((kinds) => resolve(kinds.map((kind) => ({ kind }))))),
    });
    const statuses = {
      microphone: Object.assign(new EventTarget(), { state: "denied" as PermissionState }),
      camera: Object.assign(new EventTarget(), { state: "denied" as PermissionState }),
    };
    const permissions = { query: ({ name }: { name: MediaSwitchKind }) => Promise.resolve(statuses[name]) };
    const availability: MediaAvailability = { devices, permissions };
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    return {
      availability,
      settle,
      /** Something plugged in or out; the list asked for is answered (`kinds`) when the test says. */
      change: () => {
        devices.dispatchEvent(new Event("devicechange"));
        return lists.shift()!;
      },
      /** Something plugged in or out, and the list answered at once (when one was asked for). */
      plug: async (...kinds: string[]) => {
        devices.dispatchEvent(new Event("devicechange"));
        lists.shift()?.(kinds);
        await settle();
      },
      permit: (kind: MediaSwitchKind, state: PermissionState) => {
        statuses[kind].state = state;
        statuses[kind].dispatchEvent(new Event("change"));
      },
    };
  }

  it("forgets a device missing once one of its kind is plugged in, and one blocked once access is no longer denied; nothing else", async () => {
    const switches = new MediaSwitches({ setCamera: refusing("NotFoundError"), setMicrophone: refusing("NotAllowedError") });
    const { availability, settle, plug, permit } = browser();
    const stop = switches.watch(availability);
    await settle();
    expect(await switches.set("camera", true)).toBe("failed");
    expect(await switches.set("microphone", true)).toBe("failed");
    expect(switches.state().problem).toEqual({ camera: "missing", microphone: "blocked" });
    const heard = vi.fn();
    switches.subscribe(heard);
    // A speaker is no camera; a microphone plugged in does not unblock one; the camera's access says nothing of the microphone's; denied is still blocked.
    await plug("audiooutput");
    await plug("audiooutput", "audioinput");
    permit("camera", "granted");
    permit("microphone", "denied");
    expect(switches.state().problem).toEqual({ camera: "missing", microphone: "blocked" });
    expect(heard).not.toHaveBeenCalled();
    await plug("audioinput", "videoinput");
    expect(switches.state()).toMatchObject({ busy: { camera: false }, problem: { camera: null, microphone: "blocked" } });
    permit("microphone", "prompt");
    expect(switches.state().problem).toEqual({ camera: null, microphone: null });
    expect(heard).toHaveBeenCalledTimes(2);
    // Stopped — at once, before the browser answered, too — it hears nothing.
    await switches.set("camera", true);
    await switches.set("microphone", true);
    stop();
    switches.watch(availability)();
    await settle();
    await plug("videoinput");
    permit("microphone", "granted");
    expect(switches.state().problem).toEqual({ camera: "missing", microphone: "blocked" });
  });

  it("answers by the newest list of devices; a browser with no permission for a kind is watched for the rest", async () => {
    const switches = new MediaSwitches({ setCamera: refusing("NotFoundError"), setMicrophone: refusing("NotAllowedError") });
    const { availability, settle, change } = browser();
    const statuses = { microphone: Object.assign(new EventTarget(), { state: "denied" as PermissionState }) };
    const permissions = {
      query: ({ name }: { name: MediaSwitchKind }) => (name === "camera" ? Promise.reject(new TypeError("no such permission")) : Promise.resolve(statuses.microphone)),
    };
    switches.watch({ devices: availability.devices, permissions });
    await settle();
    await switches.set("camera", true);
    await switches.set("microphone", true);
    // A camera plugged in and out again: the list that still had it answers last, and is let go.
    const plugged = change();
    const unplugged = change();
    unplugged([]);
    plugged(["videoinput"]);
    await settle();
    expect(switches.state().problem.camera).toBe("missing");
    statuses.microphone.state = "granted";
    statuses.microphone.dispatchEvent(new Event("change"));
    expect(switches.state().problem.microphone).toBeNull();
    // Nothing to watch is no watch at all.
    switches.watch({})();
  });

  it("forgets a kind's problem when asked (a device chosen took), the other kind's and a switch under way kept", async () => {
    const { media, coming } = control();
    const switches = new MediaSwitches({ ...media, setMicrophone: refusing("NotReadableError") });
    const camera = switches.set("camera", true);
    coming[0]!.fail(Object.assign(new Error("gone"), { name: "OverconstrainedError" }));
    expect(await camera).toBe("failed");
    expect(await switches.set("microphone", true)).toBe("failed");
    const again = switches.set("camera", true);
    switches.forget("camera", ["blocked"]);
    expect(switches.state()).toMatchObject({ busy: { camera: true }, coming: { camera: true }, problem: { camera: "missing", microphone: "busy" } });
    switches.forget("camera");
    expect(switches.state()).toMatchObject({ busy: { camera: true }, coming: { camera: true }, problem: { camera: null, microphone: "busy" } });
    coming[1]!.come();
    expect(await again).toBe("done");
  });

  it("says why one went off with no switch — the room could not put it out again — until the next attempt answers, a switch under way kept", async () => {
    const { media, coming } = control();
    const switches = new MediaSwitches(media);
    const heard = vi.fn();
    switches.subscribe(heard);
    switches.wentOff("camera", new Error("publication of local track timed out, no response from server"));
    expect(switches.state()).toMatchObject({ busy: { camera: false }, coming: { camera: false }, problem: { camera: "failed", microphone: null } });
    expect(heard).toHaveBeenCalledTimes(1);
    // Still a click from trying again, which answers for it.
    const camera = switches.set("camera", true);
    coming[0]!.come();
    expect(await camera).toBe("done");
    expect(switches.state().problem.camera).toBeNull();
    // A switch under way stays under way, and its outcome answers when it lands.
    const microphone = switches.set("microphone", true);
    switches.wentOff("microphone", Object.assign(new Error("gone"), { name: "NotFoundError" }));
    expect(switches.state()).toMatchObject({ busy: { microphone: true }, coming: { microphone: true }, problem: { microphone: "missing" } });
    coming[1]!.come();
    expect(await microphone).toBe("done");
    expect(switches.state().problem.microphone).toBeNull();
  });
});

describe("MediaButton", () => {
  const render = (props: Partial<MediaButtonProps>): string =>
    renderToStaticMarkup(createElement(MediaButton, { kind: "camera", on: false, onToggle: () => undefined, shortcut: "V", ...props }));

  it("says why an off switch did not come on, and stays a click from trying again", () => {
    const html = render({ problem: "No camera was found." });
    expect(html).toContain('title="No camera was found. Turn on camera (V)"');
    expect(html).toContain("data-problem");
    expect(html).not.toContain("disabled");
    // On, or coming on, it has nothing to tell; an on under way on a switch that reads off is the one that waits.
    expect(render({ on: true, busy: true, problem: "No camera was found." })).not.toMatch(/data-problem|disabled|found/u);
    expect(render({ busy: true })).toContain("disabled");
  });

  it("keeps a camera or microphone coming on a click from turning off", () => {
    const prompting = (): Promise<void> => new Promise(() => undefined);
    const switches = new MediaSwitches({ setCamera: prompting, setMicrophone: prompting });
    for (const [kind, shortcut] of [["camera", "V"], ["microphone", "M"]] as const) {
      void switches.set(kind, true);
      const state = switches.state();
      const html = render({ kind, shortcut, on: switchReadsOn(state, kind, false), busy: state.busy[kind] });
      expect(html).toContain('aria-pressed="true"');
      expect(html).toContain(`title="Turn off ${kind} (${shortcut})"`);
      expect(html).not.toContain("disabled");
    }
  });
});

describe("GuestMediaMemory", () => {
  const before: GuestMediaPrefs = { microphone: true, camera: false, audioinput: "mic-2", videoinput: "cam-2", audiooutput: null, background: { kind: "none" } };
  const offer = { scenes: [{ kind: "image", label: "Dusk", url: "data:image/svg+xml,dusk" }], supported: true } as const;

  /** A room's camera and microphone: a camera's on waits until the test lets it come (or fail); the rest is at once. */
  function control() {
    const coming: Array<{ come(): void; fail(error: unknown): void }> = [];
    const calls: string[] = [];
    const turn = async (kind: string, on: boolean, deviceId?: string): Promise<void> => {
      calls.push(`${kind} ${on ? "on" : "off"} ${deviceId ?? "default"}`);
      if (on && kind === "camera") await new Promise<void>((resolve, reject) => coming.push({ come: resolve, fail: reject }));
    };
    const media: MediaControl = { setCamera: (on, deviceId) => turn("camera", on, deviceId), setMicrophone: (on, deviceId) => turn("microphone", on, deviceId) };
    return { switches: new MediaSwitches(media), coming, calls };
  }

  it("remembers a switch that lands late over the choices as they stand then, not as they stood when it was made", async () => {
    const { switches, coming, calls } = control();
    const saved: GuestMediaPrefs[] = [];
    const memory = new GuestMediaMemory(before, (prefs) => saved.push(prefs), offer);
    const heard = vi.fn();
    memory.subscribe(heard);
    // The camera waits on its prompt; meanwhile the microphone goes off and another speaker is chosen.
    const camera = memory.switch(switches.set, "camera", true);
    expect(await memory.switch(switches.set, "microphone", false)).toBe("done");
    memory.remember({ audiooutput: "speaker-2" });
    coming[0]!.come();
    expect(await camera).toBe("done");
    // Each on the device remembered for it; an off names none.
    expect(calls).toEqual(["camera on cam-2", "microphone off default"]);
    const after = { microphone: false, camera: true, audioinput: "mic-2", videoinput: "cam-2", audiooutput: "speaker-2", background: { kind: "none" } };
    expect(memory.current()).toEqual(after);
    expect(saved.at(-1)).toEqual(after);
    expect(heard).toHaveBeenCalledTimes(3);
  });

  it("remembers nothing of a switch that failed, or that a later one overtook", async () => {
    const { switches, coming } = control();
    const memory = new GuestMediaMemory({ ...before, microphone: false }, () => undefined, offer);
    const failed = memory.switch(switches.set, "camera", true);
    coming[0]!.fail(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
    expect(await failed).toBe("failed");
    const overtaken = memory.switch(switches.set, "camera", true);
    memory.remember({ microphone: true });
    expect(await memory.switch(switches.set, "camera", false)).toBe("done");
    coming[1]!.come();
    expect(await overtaken).toBe("overtaken");
    expect(memory.current()).toEqual({ ...before, microphone: true, camera: false });
  });

  it("starts what was on on the default in place of a device gone, and remembers the default then, so off and on again asks for the one in use", async () => {
    const calls: string[] = [];
    const coming: Array<() => void> = [];
    const turn = async (kind: string, on: boolean, deviceId?: string): Promise<void> => {
      calls.push(`${kind} ${on ? "on" : "off"} ${deviceId ?? "default"}`);
      if (on && deviceId?.endsWith("-gone") === true) throw Object.assign(new Error("Requested device not found"), { name: "NotFoundError" });
      if (on && deviceId === "mic-refused") throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
      if (on && kind === "camera") await new Promise<void>((resolve) => coming.push(resolve));
    };
    const switches = new MediaSwitches({ setCamera: (on, deviceId) => turn("camera", on, deviceId), setMicrophone: (on, deviceId) => turn("microphone", on, deviceId) });
    const saved: GuestMediaPrefs[] = [];
    const memory = new GuestMediaMemory({ ...before, camera: true, audioinput: "mic-gone", videoinput: "cam-gone" }, (prefs) => saved.push(prefs), offer);
    expect(await memory.resume(switches.setOnOrDefault, "microphone")).toBe("done");
    expect(memory.current().audioinput).toBeNull();
    expect(saved.at(-1)?.audioinput).toBeNull();
    // Off and on again (the lobby's switch, the room's): the default, which came on — not the one gone, which would fail.
    expect(await memory.switch(switches.set, "microphone", false)).toBe("done");
    expect(await memory.switch(switches.set, "microphone", true)).toBe("done");
    expect(calls.splice(0)).toEqual(["microphone on mic-gone", "microphone on default", "microphone off default", "microphone on default"]);
    // Another camera chosen while the default comes on stands: it is the one the person asked for last.
    const camera = memory.resume(switches.setOnOrDefault, "camera");
    await vi.waitFor(() => expect(coming).toHaveLength(1));
    memory.remember({ videoinput: "cam-3" });
    coming[0]!();
    expect(await camera).toBe("done");
    expect(calls.splice(0)).toEqual(["camera on cam-gone", "camera on default"]);
    expect(memory.current().videoinput).toBe("cam-3");
    // A device that is there but refused stays remembered: nothing else came on.
    const refused = new GuestMediaMemory({ ...before, audioinput: "mic-refused" }, () => undefined, offer);
    expect(await refused.resume(switches.setOnOrDefault, "microphone")).toBe("failed");
    expect(refused.current().audioinput).toBe("mic-refused");
  });

  it("remembers a background the moment it is chosen, reads back only what it wrote, and holds the camera for one it cannot put back", () => {
    const saved: GuestMediaPrefs[] = [];
    const memory = new GuestMediaMemory(before, (prefs) => saved.push(prefs), offer);
    // Still loading on the camera: a reload now must not bring the camera back behind what this replaced.
    memory.chooseBackground({ kind: "blur", strength: "light" });
    expect(saved.at(-1)?.background).toEqual({ kind: "blur", strength: "light" });
    expect(memory.background()).toEqual({ kind: "blur", strength: "light" });
    // Prefs saved before backgrounds were remembered, or spoiled: none, as then.
    for (const value of [undefined, null, "blur", { kind: "scene", name: 3 }, { kind: "image", url: "https://elsewhere.example/x.png" }]) expect(readBackground(value)).toEqual({ kind: "none" });
    expect(readBackground({ kind: "blur", strength: "huge" })).toEqual({ kind: "blur" });
    // A scene the page no longer offers cannot be put back.
    const renamed = new GuestMediaMemory({ ...before, camera: true, background: { kind: "scene", name: "Dawn" } }, () => undefined, offer);
    expect(renamed.background()).toEqual({ kind: "none" });
    expect(renamed.held()).toBe("not-kept");
    // Remembering the camera off does not answer it; on does.
    renamed.remember({ camera: false });
    expect(renamed.held()).toBe("not-kept");
    renamed.remember({ camera: true });
    expect(renamed.held()).toBeNull();
  });
});
