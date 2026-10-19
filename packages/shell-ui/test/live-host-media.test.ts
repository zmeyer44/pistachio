import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveRoom } from "@pistachio/live-share/room";
import { LIVE_LOCAL_MEDIA_DEFAULT, idleLiveShare, type LiveBackgroundChoice, type LiveHostReport, type LiveLocalMedia } from "@pistachio/shell-contracts/live-share";
import { LiveHostSession } from "../src/components/live-host/host-session";
import { afterStep, forgiven, mediaSteps, NO_REFUSALS, type MediaStep } from "../src/components/live-host/media-steps";

// (The room is LiveKit's in a browser; the session meets it through `LiveRoom.connect`, which each test answers.)
vi.mock("@pistachio/live-share/room", () => ({ LiveRoom: { connect: vi.fn() }, WINDOW_CAPTURE_MAX_SIDE: 2560, WINDOW_MAX_FPS: 30 }));

const media = (patch: Partial<LiveLocalMedia> = {}, devices: Partial<LiveLocalMedia["devices"]> = {}): LiveLocalMedia => ({
  ...LIVE_LOCAL_MEDIA_DEFAULT,
  ...patch,
  devices: { ...LIVE_LOCAL_MEDIA_DEFAULT.devices, ...devices },
});

/** Every step applied in turn, as the session does when each one takes. */
const applyAll = (from: LiveLocalMedia, steps: MediaStep[]): LiveLocalMedia => steps.reduce(afterStep, from);

describe("the host's media steps", () => {
  it("sets the background before the camera comes on, so the camera comes on with it", () => {
    const wanted = media({ camera: true, background: { kind: "blur" } }, { videoinput: "cam-2" });
    const steps = mediaSteps(media(), wanted);
    expect(steps).toEqual([
      { kind: "background", background: { kind: "blur" } },
      { kind: "camera", on: true, deviceId: "cam-2" },
    ]);
    expect(applyAll(media(), steps)).toEqual(wanted);
    expect(mediaSteps(wanted, wanted)).toEqual([]);
  });

  it("switches a device only while its kind is on; the speaker always", () => {
    const on = media({ mic: true }, { audioinput: "mic-1" });
    expect(mediaSteps(on, media({ mic: true }, { audioinput: "mic-2" }))).toEqual([{ kind: "device", device: "audioinput", deviceId: "mic-2" }]);
    expect(mediaSteps(media(), media({}, { audioinput: "mic-2" }))).toEqual([]);
    expect(mediaSteps(media(), media({}, { audiooutput: "speakers" }))).toEqual([{ kind: "device", device: "audiooutput", deviceId: "speakers" }]);
  });

  it("turns things off", () => {
    expect(mediaSteps(media({ mic: true, camera: true }), media())).toEqual([
      { kind: "mic", on: false, deviceId: null },
      { kind: "camera", on: false, deviceId: null },
    ]);
  });

  it("does not try again what failed to come on until the host turns it off", () => {
    const wanted = media({ camera: true, mic: true });
    const refused = { ...NO_REFUSALS, camera: true };
    expect(mediaSteps(media(), wanted, refused)).toEqual([{ kind: "mic", on: true, deviceId: null }]);
    expect(forgiven(refused, wanted, wanted)).toEqual(refused);
    expect(forgiven(refused, media({ mic: true }), wanted)).toEqual(NO_REFUSALS);
  });

  it("does not try again a background pick that failed until main names another; another pick goes on", () => {
    const blur = media({ camera: true, background: { kind: "blur" } });
    const dusk = media({ camera: true, background: { kind: "image", url: "data:image/svg+xml,dusk" } });
    const lagoon = media({ camera: true, background: { kind: "image", url: "data:image/svg+xml,lagoon" } });
    const refused = { ...NO_REFUSALS, background: dusk.background };
    expect(mediaSteps(blur, dusk, refused)).toEqual([]);
    expect(mediaSteps(blur, lagoon, refused)).toEqual([{ kind: "background", background: lagoon.background }]);
    expect(forgiven(refused, dusk, dusk)).toEqual(refused);
    // Main names the one the camera shows (it does once told); then the picture again is the host's new choice.
    expect(forgiven(refused, blur, dusk)).toEqual(NO_REFUSALS);
  });
});

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The room as the session meets it, its camera by the room's rule
 * (packages/live-share/src/room.ts): a camera asked on is captured — held
 * until the test lets it land — and goes out behind the background chosen
 * last, as it stands when it lands; one turned off before it landed never
 * goes out. Off, a camera that is out leaves at once. A background changed
 * on a camera that is out loads (held, with `holdBackground`, until the test
 * ends the load): one that fails gives way to the one the camera had, the
 * room's choice again — unless the camera went, or a later choice came,
 * meanwhile: that failure is let go. A microphone asked on waits on its
 * prompt (with `holdMicrophone`) until the test answers, and goes out live
 * only if no later choice came meanwhile. `drop()` is LiveKit giving up on
 * the room: it ends, and its camera with it. `lose(kind)` is the room
 * taking its camera or mic out, unable to put it out again after joining
 * from scratch.
 */
class FakeRoom {
  /** The setCamera / setMicrophone / setBackground / switchDevice calls, in order. */
  readonly calls: string[] = [];
  /** Each camera that went out, with the background it went out behind. */
  readonly published: LiveBackgroundChoice[] = [];
  /** Each microphone that went out live, by the device it was asked on. */
  readonly micsOut: string[] = [];
  readonly captures: Deferred[] = [];
  readonly prompts: Deferred[] = [];
  /** Background changes loading on a camera that is out, while `holdBackground`. */
  readonly loads: Deferred[] = [];
  holdMicrophone = false;
  holdBackground = false;
  /** The camera that is out (the choice it came on for), or null. */
  out: number | null = null;
  #background: LiveBackgroundChoice = { kind: "none" };
  #cameraAsked = 0;
  #micAsked = 0;
  readonly #listeners = new Map<string, Set<(value: never) => void>>();

  on(event: string, listener: (value: never) => void): () => void {
    const listeners = this.#listeners.get(event) ?? new Set();
    this.#listeners.set(event, listeners);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  #emit(event: string, value: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(value as never);
  }
  drop(): void {
    this.out = null;
    this.#emit("disconnected", "failed");
  }
  lose(kind: "camera" | "microphone", error: Error): void {
    if (kind === "camera") this.out = null;
    this.#emit("mediaFailed", { kind, error });
  }
  onMessage(): () => void {
    return () => undefined;
  }
  state(): "connected" {
    return "connected";
  }
  participants(): [] {
    return [];
  }
  setReceivers(): void {}
  async send(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async setBackground(background: LiveBackgroundChoice): Promise<boolean> {
    this.calls.push(`background ${background.kind}`);
    const had = this.#background;
    this.#background = background;
    const camera = this.out;
    if (camera === null || !this.holdBackground) return true;
    const load = deferred();
    this.loads.push(load);
    try {
      await load.promise;
    } catch (error) {
      if (this.out !== camera || this.#background !== background) return true;
      this.#background = had;
      throw error;
    }
    return true;
  }

  background(): LiveBackgroundChoice {
    return this.#background;
  }

  async setCamera(on: boolean, deviceId?: string): Promise<void> {
    this.calls.push(`camera ${on ? "on" : "off"}${deviceId === undefined ? "" : ` ${deviceId}`}`);
    const ask = (this.#cameraAsked += 1);
    if (!on) {
      this.out = null;
      return;
    }
    const capture = deferred();
    this.captures.push(capture);
    await capture.promise;
    if (ask !== this.#cameraAsked) return;
    this.out = ask;
    this.published.push(this.#background);
  }

  async setMicrophone(on: boolean, deviceId?: string): Promise<void> {
    this.calls.push(`mic ${on ? "on" : "off"}${deviceId === undefined ? "" : ` ${deviceId}`}`);
    const ask = (this.#micAsked += 1);
    if (!on) return;
    if (this.holdMicrophone) {
      const prompt = deferred();
      this.prompts.push(prompt);
      await prompt.promise;
    }
    if (ask === this.#micAsked) this.micsOut.push(deviceId ?? "(the last one)");
  }

  async switchDevice(kind: MediaDeviceKind, deviceId: string): Promise<void> {
    this.calls.push(`device ${kind} ${deviceId}`);
  }
}

/** Let every promise the session and the room have under way run as far as it can. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("the host's camera and mic in the room", () => {
  let session: LiveHostSession | null = null;

  beforeEach(() => {
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), devicePixelRatio: 2, innerWidth: 1200, innerHeight: 800 });
    vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices: async () => [], addEventListener: vi.fn(), removeEventListener: vi.fn() } });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    session?.dispose();
    session = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A session in its room, the host's media as main says it is, and what it tells main. */
  async function joined() {
    const room = new FakeRoom();
    vi.mocked(LiveRoom.connect).mockResolvedValue(room as unknown as LiveRoom);
    const reports: LiveHostReport[] = [];
    const share = { ...idleLiveShare(), status: "live" as const };
    const live = new LiveHostSession(
      { livekit: { url: "ws://room.test", token: "host-token" }, shareId: "share-1", state: share, frame: null, shell: null, stage: null, chrome: [], admitted: [] },
      { sendLiveHostReport: (report) => void reports.push(report), liveHostSource: async () => null, liveHostShellSource: async () => null },
    );
    session = live;
    live.start();
    await settle();
    const want = async (patch: Partial<LiveLocalMedia>, devices: Partial<LiveLocalMedia["devices"]> = {}): Promise<void> => {
      live.handle({ type: "state", state: { ...share, local: media(patch, devices) } });
      await settle();
    };
    const failures = (): LiveHostReport[] => reports.filter((report) => report.type === "mediaFailed");
    return { room, live, want, failures };
  }

  it("goes out behind the background chosen while it was coming on, not the one it was asked on with", async () => {
    const { room, want } = await joined();
    await want({ camera: true });
    await want({ camera: true, background: { kind: "blur" } });
    room.captures[0]!.resolve();
    await settle();
    expect(room.published).toEqual([{ kind: "blur" }]);
    // The room had the new background while the camera was still coming on, and nothing was asked of it after.
    expect(room.calls).toEqual(["camera on default", "background blur"]);
  });

  it("is let go at once when turned off while it comes on, and never goes out", async () => {
    const { room, want, failures } = await joined();
    await want({ camera: true, background: { kind: "blur" } });
    await want({ camera: false, background: { kind: "blur" } });
    expect(room.calls).toEqual(["background blur", "camera on default", "camera off"]);
    room.captures[0]!.resolve();
    await settle();
    expect(room.published).toEqual([]);
    // On again: a new camera, which goes out.
    await want({ camera: true, background: { kind: "blur" } });
    room.captures[1]!.resolve();
    await settle();
    expect(room.published).toEqual([{ kind: "blur" }]);
    expect(failures()).toEqual([]);
  });

  it("is not held up by a microphone waiting on its prompt", async () => {
    const { room, want } = await joined();
    room.holdMicrophone = true;
    await want({ mic: true, camera: true });
    expect([...room.calls].sort()).toEqual(["camera on default", "mic on default"]);
    // Off, and another background, while the mic's prompt is still up: both reach the room now, the off first.
    await want({ mic: true, camera: false, background: { kind: "image", url: "/live/backgrounds/office.jpg" } });
    expect(room.calls.slice(2)).toEqual(["camera off", "background image"]);
    room.captures[0]!.resolve();
    room.prompts[0]!.resolve();
    await settle();
    expect(room.published).toEqual([]);
  });

  it("turns the mic off at once while its prompt is up, so it never goes out live; one that fails after is not told", async () => {
    for (const prompt of ["answered", "refused"] as const) {
      const { room, want, failures } = await joined();
      room.holdMicrophone = true;
      await want({ mic: true }, { audioinput: "mic-1" });
      // Off while the prompt is up: it reaches the room now, not once the prompt is answered.
      await want({ mic: false }, { audioinput: "mic-1" });
      expect(room.calls).toEqual(["mic on mic-1", "mic off"]);
      if (prompt === "answered") room.prompts[0]!.resolve();
      else room.prompts[0]!.reject(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
      await settle();
      expect(room.micsOut).toEqual([]);
      expect(room.calls).toEqual(["mic on mic-1", "mic off"]);
      expect(failures()).toEqual([]);
      // On again: it comes on.
      await want({ mic: true }, { audioinput: "mic-1" });
      room.prompts[1]!.resolve();
      await settle();
      expect(room.micsOut).toEqual(["mic-1"]);
      session?.dispose();
    }
  });

  it("turns the mic and the camera on on the device chosen while they were off, the system's by name", async () => {
    const { room, want } = await joined();
    await want({ mic: true, camera: true }, { audioinput: "mic-2", videoinput: "cam-2" });
    room.captures[0]!.resolve();
    await settle();
    await want({}, { audioinput: "mic-2", videoinput: "cam-2" });
    // "System default" chosen while both are off: nothing to switch yet, so turning them on must name it.
    await want({});
    await want({ mic: true, camera: true });
    expect(room.calls).toEqual(["camera on cam-2", "mic on mic-2", "camera off", "mic off", "camera on default", "mic on default"]);
    expect(room.micsOut).toEqual(["mic-2", "default"]);
    // Switched to while on, the system's is named too, as is the speaker's.
    room.captures[1]!.resolve();
    await settle();
    await want({ mic: true, camera: true }, { audioinput: "mic-2", videoinput: "cam-2", audiooutput: "speakers-2" });
    await want({ mic: true, camera: true });
    expect(room.calls.slice(6).sort()).toEqual([
      "device audioinput default",
      "device audioinput mic-2",
      "device audiooutput default",
      "device audiooutput speakers-2",
      "device videoinput cam-2",
      "device videoinput default",
    ]);
  });

  it("switches to a camera chosen while one comes on once it is in", async () => {
    const { room, want } = await joined();
    await want({ camera: true });
    await want({ camera: true }, { videoinput: "cam-2" });
    expect(room.calls).toEqual(["camera on default"]);
    room.captures[0]!.resolve();
    await settle();
    expect(room.calls).toEqual(["camera on default", "device videoinput cam-2"]);
  });

  it("tells main once when it does not come on, and does not try again; a camera let go first is not told", async () => {
    const { room, want, failures } = await joined();
    await want({ camera: true, background: { kind: "blur" } });
    room.captures[0]!.reject(new Error("the background did not load"));
    await settle();
    expect(failures()).toEqual([{ type: "mediaFailed", kind: "camera", error: "The camera didn't start." }]);
    await want({ camera: true, background: { kind: "blur" } });
    expect(room.calls.filter((call) => call.startsWith("camera"))).toEqual(["camera on default"]);

    // Main puts it off; on again, then off before it failed: nothing more to tell.
    await want({ camera: false, background: { kind: "blur" } });
    await want({ camera: true, background: { kind: "blur" } });
    await want({ camera: false, background: { kind: "blur" } });
    room.captures[1]!.reject(new Error("the background did not load"));
    await settle();
    expect(failures()).toHaveLength(1);
  });

  it("tells main when the room took the camera or the mic out, unable to put it out again after joining afresh, and asks for neither again until main does", async () => {
    const { room, want, failures } = await joined();
    await want({ camera: true, mic: true });
    room.captures[0]!.resolve();
    await settle();
    expect(room.published).toHaveLength(1);
    expect(room.micsOut).toHaveLength(1);
    room.lose("camera", new Error("publication of local track timed out, no response from server"));
    room.lose("microphone", new Error("publication of local track timed out, no response from server"));
    expect(failures()).toEqual([
      { type: "mediaFailed", kind: "camera", error: "The camera didn't start." },
      { type: "mediaFailed", kind: "mic", error: "The microphone didn't start." },
    ]);
    // Main's word still says on until it hears: neither is asked for again.
    const asked = (): string[] => room.calls.filter((call) => call === "camera on default" || call === "mic on default").sort();
    await want({ camera: true, mic: true });
    expect(asked()).toEqual(["camera on default", "mic on default"]);
    // Main puts them off as told, and the host turns them on again: asked for afresh.
    await want({});
    await want({ camera: true, mic: true });
    expect(asked()).toEqual(["camera on default", "camera on default", "mic on default", "mic on default"]);
    expect(failures()).toHaveLength(2);
  });

  it("is turned off at once while a background loads on it, and the load ending after brings nothing back", async () => {
    for (const ends of ["loads", "fails"] as const) {
      const { room, want, failures } = await joined();
      await want({ camera: true });
      room.captures[0]!.resolve();
      await settle();
      expect(room.published).toEqual([{ kind: "none" }]);
      // Blur on the camera that is out: the segmenter's first load, held.
      room.holdBackground = true;
      await want({ camera: true, background: { kind: "blur" } });
      expect(room.loads).toHaveLength(1);
      await want({ camera: false, background: { kind: "blur" } });
      expect(room.calls).toEqual(["camera on default", "background blur", "camera off"]);
      expect(room.out).toBeNull();
      if (ends === "loads") room.loads[0]!.resolve();
      else room.loads[0]!.reject(new Error("the segmenter did not load"));
      await settle();
      expect(room.calls).toEqual(["camera on default", "background blur", "camera off"]);
      expect(room.published).toEqual([{ kind: "none" }]);
      expect(failures()).toEqual([]);
      // On again: it goes out behind the blur chosen.
      await want({ camera: true, background: { kind: "blur" } });
      room.captures[1]!.resolve();
      await settle();
      expect(room.published).toEqual([{ kind: "none" }, { kind: "blur" }]);
      session?.dispose();
    }
  });

  it("tells main the background the camera shows when a change does not take, and tries that change again when the host makes it again", async () => {
    const { room, want, failures } = await joined();
    const blur = { kind: "blur" } as const;
    const dusk = { kind: "image", url: "data:image/svg+xml,dusk" } as const;
    await want({ camera: true, background: blur });
    room.captures[0]!.resolve();
    await settle();
    room.holdBackground = true;
    await want({ camera: true, background: dusk });
    room.loads[0]!.reject(new Error("the picture did not load"));
    await settle();
    expect(failures()).toEqual([{ type: "mediaFailed", kind: "background", tried: dusk, background: blur, error: "The camera background didn't load. Try again." }]);
    // Not tried again on main's next word while that still names the picture.
    await want({ camera: true, background: dusk });
    expect(room.loads).toHaveLength(1);
    // Main names what the camera shows (live-service.ts); the host chooses the picture again: it is tried again.
    await want({ camera: true, background: blur });
    await want({ camera: true, background: dusk });
    expect(room.calls).toEqual(["background blur", "camera on default", "background image", "background image"]);
    room.loads[1]!.resolve();
    await settle();
    expect(failures()).toHaveLength(1);
  });

  it("puts on a background the host chose while the one before it failed: only that pick is held back", async () => {
    const { room, want, failures } = await joined();
    const blur = { kind: "blur" } as const;
    const dusk = { kind: "image", url: "data:image/svg+xml,dusk" } as const;
    const lagoon = { kind: "image", url: "data:image/svg+xml,lagoon" } as const;
    await want({ camera: true, background: blur });
    room.captures[0]!.resolve();
    await settle();
    room.holdBackground = true;
    await want({ camera: true, background: dusk });
    // The host picks another while the picture still loads; then the picture fails (the room had not heard of the other yet).
    await want({ camera: true, background: lagoon });
    room.loads[0]!.reject(new Error("the picture did not load"));
    await settle();
    expect(failures()).toEqual([{ type: "mediaFailed", kind: "background", tried: dusk, background: blur, error: "The camera background didn't load. Try again." }]);
    expect(room.loads).toHaveLength(2);
    room.loads[1]!.resolve();
    await settle();
    expect(room.background()).toEqual(lagoon);
  });

  it("starts afresh in a room joined again while a step was under way in the last: the camera goes out there behind its background", async () => {
    const blur = { kind: "blur" } as const;
    for (const under of ["a background loading", "a background loading, a camera switch after it", "a mic on its prompt"] as const) {
      const { room, live, want } = await joined();
      if (under === "a mic on its prompt") {
        room.holdMicrophone = true;
        await want({ mic: true });
      } else {
        await want({ camera: true });
        room.captures[0]!.resolve();
        await settle();
        room.holdBackground = true;
        await want({ camera: true, background: blur }, under === "a background loading" ? {} : { videoinput: "cam-2" });
      }
      // LiveKit gives up on the room; the session joins a new one with a fresh token while that step is still under way.
      const next = new FakeRoom();
      vi.mocked(LiveRoom.connect).mockResolvedValue(next as unknown as LiveRoom);
      vi.useFakeTimers();
      room.drop();
      await vi.advanceTimersByTimeAsync(1_000);
      live.handle({ type: "token", token: "host-token-2" });
      await vi.advanceTimersByTimeAsync(0);
      expect(LiveRoom.connect).toHaveBeenLastCalledWith(expect.objectContaining({ token: "host-token-2" }));
      // The step lands in the room that was left.
      if (under === "a mic on its prompt") room.prompts[0]!.resolve();
      else room.loads[0]!.resolve();
      await vi.advanceTimersByTimeAsync(0);
      if (under === "a mic on its prompt") {
        expect(next.calls).toEqual(["mic on default"]);
      } else {
        expect(next.calls).toEqual(["background blur", under === "a background loading" ? "camera on default" : "camera on cam-2"]);
        next.captures[0]!.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(next.published).toEqual([blur]);
      }
      session?.dispose();
      vi.useRealTimers();
    }
  });
});
