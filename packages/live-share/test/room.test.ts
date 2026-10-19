import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveInkOp } from "../src/protocol.js";

/**
 * `LiveRoom`'s own logic over a stand-in for livekit-client: who a message
 * is from and whether it is dropped, how it is sent and to whom, window
 * publishing, what a lost connection does, and the lobby's camera and
 * microphone it takes over. The real SFU behind it is proved by
 * apps/desktop/e2e/tests/live-share-room.spec.ts; this covers what that
 * cannot provoke quickly (a connection LiveKit gives up on, a permission
 * prompt answered after joining).
 */

const lk = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;

  class Emitter {
    readonly listeners = new Map<string, Set<Handler>>();
    on(event: string, handler: Handler): this {
      const set = this.listeners.get(event) ?? new Set();
      set.add(handler);
      this.listeners.set(event, set);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.listeners.get(event) ?? []) handler(...args);
    }
  }

  /**
   * A camera or microphone as LiveKit makes one: turned off (muted) and switched to another device in place. It sends
   * what it captures (`mediaStreamTrack`), or a processor's picture of it; what it captures from is its `mediaStream`'s.
   */
  function localTrack(kind: "audio" | "video") {
    const capture = { readyState: "live" as MediaStreamTrackState };
    const track = {
      kind,
      capture,
      mediaStreamTrack: capture as { readyState: MediaStreamTrackState },
      mediaStream: { getTracks: () => [capture] },
      isMuted: false,
      stop: vi.fn(),
      mute: vi.fn(async () => {
        track.isMuted = true;
        return track;
      }),
      unmute: vi.fn(async () => {
        track.isMuted = false;
        return track;
      }),
      setDeviceId: vi.fn(async (_deviceId: unknown) => true),
    };
    return track;
  }
  type FakeLocalTrack = ReturnType<typeof localTrack>;

  /**
   * LiveKit's LocalTrack for a window's MediaStreamTrack: it keeps the
   * publish options, and swaps the sender's track — only while it is
   * published, when it has a sender.
   */
  function windowTrack(mediaStreamTrack: unknown, options: Record<string, unknown>) {
    const track = {
      kind: options["source"] === "screen_share_audio" ? "audio" : "video",
      mediaStreamTrack,
      publishOptions: options,
      sender: undefined as object | undefined,
      replaceTrack: vi.fn(async (next: unknown, _options?: unknown) => {
        if (track.sender === undefined) throw new Error("unable to replace an unpublished track");
        track.mediaStreamTrack = next;
        return track;
      }),
      attach: vi.fn(),
      detach: vi.fn(),
    };
    return track;
  }
  type FakeWindowTrack = ReturnType<typeof windowTrack>;

  interface FakePublication {
    trackName: string;
    track: { kind: string; attach: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> } | FakeLocalTrack | FakeWindowTrack | undefined;
    /** Whether it went out muted (LiveKit's `AddTrackRequest.muted`, the track's own state as it is published). */
    muted?: boolean;
    videoTrack?: { publishOptions?: Record<string, unknown>; replaceTrack?: ReturnType<typeof vi.fn> } | unknown;
    isSubscribed: boolean;
    options?: Record<string, unknown>;
    trackSid: string;
    source?: string;
    isMuted?: boolean;
    /** Taken down by `unpublishTrack`. */
    unpublished?: boolean;
    /** Whether this side wants it (LiveKit subscribes to what is published until told otherwise). */
    isDesired?: boolean;
    setSubscribed?: (subscribed: boolean) => void;
  }

  class FakeParticipant {
    readonly trackPublications = new Map<string, FakePublication>();
    joinedAt = new Date(0);
    isMicrophoneEnabled = false;
    isSpeaking = false;
    audioLevel = 0;
    connectionQuality = "excellent";
    constructor(
      public identity: string,
      public name: string,
      public metadata: string | undefined,
    ) {}
    getTrackPublication(): FakePublication | undefined {
      return undefined;
    }
    getTrackPublicationByName(name: string): FakePublication | undefined {
      return [...this.trackPublications.values()].find((publication) => publication.trackName === name);
    }
  }

  class FakeLocalParticipant extends FakeParticipant {
    /** Every publication of mine, in the order made (`trackPublications`: those out now). */
    readonly published: FakePublication[] = [];
    /** Raise a room event, as LiveKit's local participant does through its room. */
    tell: (event: string, ...args: unknown[]) => void = () => undefined;
    publishTrack = vi.fn(async (track: unknown, options: Record<string, unknown>) => {
      // A camera or microphone (a LocalTrack) is published as it is; a window's MediaStreamTrack in a LocalTrack of LiveKit's.
      const own = options["source"] === "camera" || options["source"] === "microphone";
      return this.put(own ? (track as FakeLocalTrack) : windowTrack(track, options), options);
    });
    unpublishTrack = vi.fn<(track: unknown, stop?: boolean) => Promise<undefined>>(async (track) => {
      // Named by its LocalTrack, or by the MediaStreamTrack handed to publishTrack; one not out now is not unpublished.
      for (const publication of this.trackPublications.values()) {
        const local = publication.track as { mediaStreamTrack?: unknown } | undefined;
        if (local === track || local?.mediaStreamTrack === track) this.take(publication);
      }
      return undefined;
    });
    /** LiveKit publishing a LocalTrack: a new publication holding it, told of before whoever asked hears back. */
    put(track: FakeLocalTrack | FakeWindowTrack, options: Record<string, unknown>): FakePublication {
      const publication: FakePublication = {
        trackName: String(options["name"] ?? ""),
        track,
        // A video's LocalVideoTrack is its publication's video track as well.
        videoTrack: track.kind === "video" ? track : undefined,
        muted: (track as { isMuted?: boolean }).isMuted === true,
        isSubscribed: true,
        options,
        trackSid: `TR_${String(this.published.length)}`,
        source: String(options["source"]),
      };
      if ("sender" in track) track.sender = {};
      this.published.push(publication);
      this.trackPublications.set(publication.trackSid, publication);
      this.tell("localTrackPublished", publication, this);
      return publication;
    }
    /** LiveKit unpublishing: the publication gone, letting go of its track, which has no sender any more. */
    take(publication: FakePublication): void {
      const track = publication.track;
      if (track !== undefined && "sender" in track) track.sender = undefined;
      this.trackPublications.delete(publication.trackSid);
      publication.unpublished = true;
      publication.track = undefined;
      publication.videoTrack = undefined;
      this.tell("localTrackUnpublished", publication, this);
    }
    publishData = vi.fn<(data: Uint8Array, options: Record<string, unknown>) => Promise<undefined>>(async () => undefined);
    sendText = vi.fn<(text: string, options: Record<string, unknown>) => Promise<undefined>>(async () => undefined);
    /** LiveKit's own microphone coming on (`setMicrophoneEnabled`): its capture, then its publish. */
    micComing: Promise<unknown> | null = null;
    /**
     * LiveKit's own microphone switch: on, the one out unmuted, or one
     * captured and published; off, one still coming waited for — its
     * capture and its publish — and then the one out muted.
     */
    setMicrophoneEnabled = vi.fn(async (on: boolean, options?: Record<string, unknown>) => {
      const out = (): FakeLocalTrack | undefined => this.getTrackPublication("microphone")?.track as FakeLocalTrack | undefined;
      if (!on) {
        await this.micComing;
        await out()?.mute();
        return;
      }
      if (out() !== undefined) {
        await out()?.unmute();
        return;
      }
      this.micComing = this.createTracks({ audio: options ?? {} }).then(([track]) => this.publishTrack(track, { source: "microphone" }));
      await this.micComing;
    });
    /** Cameras and microphones captured as LiveKit captures one (`createTracks`), not published. */
    readonly captured: FakeLocalTrack[] = [];
    createTracks = vi.fn(async (options: Record<string, unknown>) => {
      const track = localTrack(options["audio"] === undefined ? "video" : "audio");
      this.captured.push(track);
      return [track];
    });
    /** What is published now from `source` (a camera's publication says it is on). */
    override getTrackPublication(source?: string): FakePublication | undefined {
      return this.published.filter((publication) => publication.options?.["source"] === source && publication.unpublished !== true).at(-1);
    }
    setTrackSubscriptionPermissions = vi.fn<(allParticipants: boolean, permissions: Array<{ participantIdentity: string; allowAll: boolean }>) => void>();
  }

  class Room extends Emitter {
    static readonly instances: Room[] = [];
    static getLocalDevices = vi.fn(async () => []);
    /** What LiveKit does as a room joins, before `connect` resolves: subscribing it to what is in the room. A test's. */
    static joining: ((room: Room) => void) | null = null;
    readonly remoteParticipants = new Map<string, FakeParticipant>();
    readonly localParticipant = new FakeLocalParticipant("", "", undefined);
    readonly textHandlers = new Map<string, Handler>();
    readonly tokens: string[] = [];
    failConnects = 0;
    constructor(public options: Record<string, unknown>) {
      super();
      this.localParticipant.tell = (event, ...args) => this.emit(event, ...args);
      Room.instances.push(this);
    }
    async connect(_url: string, token: string): Promise<void> {
      this.tokens.push(token);
      if (this.failConnects > 0) {
        this.failConnects -= 1;
        throw new Error("could not connect");
      }
      this.localParticipant.identity = token.split(":")[1] ?? "";
      Room.joining?.(this);
    }
    async disconnect(): Promise<void> {
      this.emit("disconnected", 1);
    }
    /** LiveKit giving the connection up: every publication of mine gone (the tracks kept, as the room asks), then the event. */
    drop(reason = 9): void {
      for (const publication of [...this.localParticipant.trackPublications.values()]) this.localParticipant.take(publication);
      this.emit("disconnected", reason);
    }
    /**
     * LiveKit's own full reconnect (`republishAllTracks`, as its signal
     * restarts): every publication of mine unpublished, letting go of its
     * track, then the same track published anew with the old publication's
     * options — a new publication. `meanwhile` runs in between, as LiveKit
     * restarting a camera or microphone lets the page in.
     */
    async republishAll(meanwhile?: () => Promise<unknown>): Promise<void> {
      const local = this.localParticipant;
      const out = [...local.trackPublications.values()].map((publication) => ({ publication, track: publication.track as FakeLocalTrack | FakeWindowTrack }));
      for (const { publication } of out) local.take(publication);
      await meanwhile?.();
      for (const { publication, track } of out) local.put(track, publication.options ?? {});
    }
    registerTextStreamHandler(topic: string, handler: Handler): void {
      this.textHandlers.set(topic, handler);
    }
    getActiveDevice(): undefined {
      return undefined;
    }
    switchActiveDevice = vi.fn(async () => true);
    startAudio = vi.fn(async () => undefined);
  }

  class VideoPreset {
    readonly encoding: { maxBitrate: number; maxFramerate: number };
    constructor(
      public width: number,
      public height: number,
      maxBitrate: number,
      maxFramerate: number,
    ) {
      this.encoding = { maxBitrate, maxFramerate };
    }
  }

  return {
    Room,
    FakeParticipant,
    localTrack,
    VideoPreset,
    VideoPresets: { h720: { resolution: { width: 1280, height: 720 } } },
    AudioPresets: { music: { maxBitrate: 48_000 } },
    LocalVideoTrack: class {},
    LocalAudioTrack: class {},
    RoomEvent: {
      DataReceived: "dataReceived",
      ConnectionStateChanged: "connectionStateChanged",
      Disconnected: "disconnected",
      AudioPlaybackStatusChanged: "audioPlaybackChanged",
      ParticipantConnected: "participantConnected",
      ParticipantActive: "participantActive",
      ParticipantDisconnected: "participantDisconnected",
      ParticipantMetadataChanged: "participantMetadataChanged",
      ParticipantNameChanged: "participantNameChanged",
      TrackMuted: "trackMuted",
      TrackUnmuted: "trackUnmuted",
      ActiveSpeakersChanged: "activeSpeakersChanged",
      ConnectionQualityChanged: "connectionQualityChanged",
      TrackPublished: "trackPublished",
      LocalTrackPublished: "localTrackPublished",
      LocalTrackUnpublished: "localTrackUnpublished",
      TrackSubscribed: "trackSubscribed",
      TrackUnsubscribed: "trackUnsubscribed",
    },
    Track: {
      Source: { Camera: "camera", Microphone: "microphone", ScreenShare: "screen_share", ScreenShareAudio: "screen_share_audio" },
      Kind: { Audio: "audio", Video: "video" },
    },
    ConnectionState: { Disconnected: "disconnected", Connecting: "connecting", Connected: "connected", Reconnecting: "reconnecting", SignalReconnecting: "signalReconnecting" },
    ConnectionQuality: { Excellent: "excellent", Good: "good", Poor: "poor", Lost: "lost", Unknown: "unknown" },
    DisconnectReason: { UNKNOWN_REASON: 0, CLIENT_INITIATED: 1, DUPLICATE_IDENTITY: 2, PARTICIPANT_REMOVED: 4, ROOM_DELETED: 5, SIGNAL_CLOSE: 9, ROOM_CLOSED: 10 },
    createAudioAnalyser: vi.fn(),
    createLocalAudioTrack: vi.fn(),
    createLocalVideoTrack: vi.fn(),
  };
});

/**
 * The background effects (effects.test.ts covers them): put on at once
 * unless a test holds one; what a camera shows, as a test says; a camera
 * stopped for good is stopped.
 */
const fx = vi.hoisted(() => ({
  applyBackground: vi.fn<(track: unknown, background: unknown, options?: unknown) => Promise<boolean>>(),
  backgroundOn: vi.fn<(track: unknown) => unknown>(),
  stopCamera: vi.fn<(track: { stop(): void }) => void>(),
}));

vi.mock("livekit-client", () => lk);
vi.mock("../src/effects.js", () => fx);

const { LivePreview, LiveRoom, windowBitrate } = await import("../src/room.js");
const { PACKET_LIMIT_BYTES, encodeMessage } = await import("../src/protocol.js");

type FakeRoom = InstanceType<typeof lk.Room>;

const guestMeta = JSON.stringify({ role: "guest", color: "#E54D2E" });
const hostMeta = JSON.stringify({ role: "host", color: "#3E63DD" });

async function join(role: "host" | "guest", refreshToken?: () => Promise<string>) {
  const room = await LiveRoom.connect({ url: "ws://sfu", token: `tok:${role === "host" ? "host" : "g_ana"}`, role, ...(refreshToken ? { refreshToken } : {}) });
  const fake = lk.Room.instances.at(-1) as FakeRoom;
  return { room, fake };
}

function remote(fake: FakeRoom, identity: string, metadata: string | undefined) {
  const participant = new lk.FakeParticipant(identity, identity, metadata);
  fake.remoteParticipants.set(identity, participant);
  return participant;
}

const bytes = (topic: Parameters<typeof encodeMessage>[0], body: unknown) => encodeMessage(topic, body as never);

/** My publications out now, in the order made. */
const mine = (fake: FakeRoom) => [...fake.localParticipant.trackPublications.values()];

/** A fake MediaStreamTrack of a window. */
const capture = (width = 1920, height = 1080) => ({ contentHint: "", getSettings: () => ({ width, height }) }) as unknown as MediaStreamTrack;

beforeEach(() => {
  lk.Room.instances.length = 0;
  lk.Room.joining = null;
  fx.applyBackground.mockReset().mockResolvedValue(true);
  fx.backgroundOn.mockReset().mockReturnValue({ kind: "none" });
  fx.stopCamera.mockReset().mockImplementation((track) => track.stop());
});

describe("connecting", () => {
  it("joins with adaptive stream and dynacast, keeping handed tracks alive", async () => {
    const { room, fake } = await join("guest");
    expect(room.identity).toBe("g_ana");
    expect(room.state()).toBe("connected");
    // A guest asks for its screen's pixels (soft on Retina otherwise); the host watches only faces.
    expect(fake.options).toMatchObject({ adaptiveStream: { pixelDensity: "screen" }, dynacast: true, stopLocalTrackOnUnpublish: false });
    const host = await join("host");
    expect(host.fake.options).toMatchObject({ adaptiveStream: true, dynacast: true });
    // A text-stream handler for every topic, so a large body is never lost.
    expect([...fake.textHandlers.keys()]).toContain("lv.sync");
  });
});

describe("participants", () => {
  it("says who is in by sid as well, and says it again when someone comes back under the same identity", async () => {
    const { room, fake } = await join("host");
    const ana = remote(fake, "g_ana", guestMeta);
    (ana as unknown as { sid: string }).sid = "PA_1";
    const heard: string[][] = [];
    room.on("participants", (participants) => heard.push(participants.filter((p) => !p.isLocal).map((p) => `${p.identity}@${p.sid}`)));
    fake.emit("participantConnected", ana);
    await Promise.resolve();
    // Removed and straight back with a refreshed token: LiveKit's client keeps the participant, with a new sid, and
    // says only that it is active again.
    (ana as unknown as { sid: string }).sid = "PA_2";
    fake.emit("participantActive", ana);
    await Promise.resolve();
    expect(heard).toEqual([["g_ana@PA_1"], ["g_ana@PA_2"]]);
  });
});

describe("receiving", () => {
  it("names the sender by control's metadata, the server when there is no participant", async () => {
    const { room, fake } = await join("host");
    const ana = remote(fake, "g_ana", guestMeta);
    const got: unknown[] = [];
    room.onMessage("lv.input", (body, from) => got.push({ body, from }));
    room.onMessage("lv.knock", (body, from) => got.push({ body, from }));
    const input = { w: "tab-1", e: { type: "char", text: "a" } };
    fake.emit("dataReceived", bytes("lv.input", input), ana, 0, "lv.input");
    fake.emit("dataReceived", bytes("lv.knock", { requestId: "R1", name: "Bo" }), undefined, 0, "lv.knock");
    expect(got).toEqual([
      { body: input, from: { identity: "g_ana", role: "guest" } },
      { body: { requestId: "R1", name: "Bo" }, from: { identity: null, role: "server" } },
    ]);
  });

  it("drops and counts what the sender's role may not send; ignores foreign topics", async () => {
    const { room, fake } = await join("guest");
    const mallory = remote(fake, "g_mallory", guestMeta);
    const stranger = remote(fake, "x", "not json");
    const desks: unknown[] = [];
    room.onMessage("lv.desk", (body) => desks.push(body));
    const desk = { v: 1, seq: 1, stage: { w: 10, h: 10 }, hostPresent: true, space: { title: "S", color: "#000000" }, windows: [] };
    fake.emit("dataReceived", bytes("lv.desk", desk), mallory, 0, "lv.desk");
    // Unreadable metadata reads as a guest, never a host.
    fake.emit("dataReceived", bytes("lv.desk", desk), stranger, 0, "lv.desk");
    // The server may send only knocks.
    fake.emit("dataReceived", bytes("lv.desk", desk), undefined, 0, "lv.desk");
    fake.emit("dataReceived", new TextEncoder().encode("{}"), mallory, 0, "lk.chat");
    expect(desks).toEqual([]);
    expect(room.stats()).toMatchObject({ received: 0, dropped: 3, droppedByTopic: { "lv.desk": 3 } });
  });

  it("keeps dispatching when one handler throws", async () => {
    const { room, fake } = await join("host");
    const ana = remote(fake, "g_ana", guestMeta);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const seen: string[] = [];
    room.onMessage("lv.ask", () => {
      throw new Error("handler bug");
    });
    room.onMessage("lv.ask", (body) => seen.push(body.w));
    fake.emit("dataReceived", bytes("lv.ask", { w: "tab-1" }), ana, 0, "lv.ask");
    expect(seen).toEqual(["tab-1"]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("reads a text stream from a known participant up to the topic's limit", async () => {
    const { room, fake } = await join("guest");
    remote(fake, "host", hostMeta);
    const syncs: unknown[] = [];
    room.onMessage("lv.sync", (body) => syncs.push(body));
    const stream = (chunks: string[], size?: number) => {
      let read = 0;
      return {
        info: { size },
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) {
            read += 1;
            yield chunk;
          }
        },
        get read() {
          return read;
        },
      };
    };
    const sync = { desk: null, strokes: [], chat: [], grants: [] };
    const text = JSON.stringify(sync);
    const handler = fake.textHandlers.get("lv.sync")!;
    handler(stream([text.slice(0, 10), text.slice(10)]), { identity: "host" });
    // From someone the room does not know: dropped, and read off to its end (LiveKit holds what nobody reads).
    const unknown = stream([text]);
    handler(unknown, { identity: "ghost" });
    // Over the limit: nothing more is kept from the chunk that crosses it.
    const huge = stream(["x".repeat(5 * 1024 * 1024), "x".repeat(5 * 1024 * 1024), "thrown away"]);
    handler(huge, { identity: "host" });
    await vi.waitFor(() => expect(room.stats().dropped).toBe(2));
    expect(syncs).toEqual([sync]);
    expect(unknown.read).toBe(1);
    await vi.waitFor(() => expect(huge.read).toBe(3));
  });

  /** A stream the test feeds chunk by chunk, open until `end()`. */
  function liveStream() {
    const queue: string[] = [];
    let ended = false;
    let wake: (() => void) | null = null;
    const nudge = () => {
      wake?.();
      wake = null;
    };
    const state = { read: 0 };
    return {
      state,
      reader: {
        info: { size: undefined },
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (queue.length > 0) {
              state.read += 1;
              yield queue.shift()!;
            } else if (ended) return;
            else await new Promise<void>((resolve) => (wake = resolve));
          }
        },
      },
      push(chunk: string) {
        queue.push(chunk);
        nudge();
      },
      end() {
        ended = true;
        nudge();
      },
    };
  }

  /** A sync body padded to about `chars` characters (a field the schema ignores), in chunks. */
  const paddedSync = (chars: number): string[] => ['{"desk":null,"strokes":[],"chat":[],"grants":[],"pad":"', "x".repeat(chars), '"}'];

  it("judges a stream's sender before keeping a byte: a guest's sync is dropped while it is still coming", async () => {
    const { room, fake } = await join("host");
    remote(fake, "g_mallory", guestMeta);
    const syncs: unknown[] = [];
    room.onMessage("lv.sync", (body) => syncs.push(body));
    const flood = liveStream();
    fake.textHandlers.get("lv.sync")!(flood.reader, { identity: "g_mallory" });
    flood.push("x".repeat(1024 * 1024));
    await vi.waitFor(() => expect(room.stats().droppedByTopic["lv.sync"]).toBe(1));
    // Read off as it comes, never held: the stream is still open.
    flood.push("x".repeat(1024 * 1024));
    await vi.waitFor(() => expect(flood.state.read).toBe(2));
    flood.end();
    expect(syncs).toEqual([]);
  });

  it("holds two streams of one sender at a time, within a budget for all of them, and drops the rest", async () => {
    const { room, fake } = await join("guest");
    remote(fake, "host", hostMeta);
    const syncs: unknown[] = [];
    room.onMessage("lv.sync", (body) => syncs.push(body));
    const handler = fake.textHandlers.get("lv.sync")!;
    const [first, second, third] = [liveStream(), liveStream(), liveStream()];
    for (const each of [first, second, third]) handler(each.reader, { identity: "host" });
    // The third while two are open: dropped at once.
    await vi.waitFor(() => expect(room.stats().dropped).toBe(1));
    third.end();
    // 5 MB held by the first, and the second's 5 MB would pass what all streams may hold together.
    const [head, pad, tail] = paddedSync(5 * 1024 * 1024);
    first.push(head!);
    first.push(pad!);
    await vi.waitFor(() => expect(first.state.read).toBe(2));
    second.push(head!);
    second.push(pad!);
    second.push(tail!);
    second.end();
    await vi.waitFor(() => expect(room.stats().dropped).toBe(2));
    first.push(tail!);
    first.end();
    await vi.waitFor(() => expect(syncs).toHaveLength(1));
    // Their slots and budget are free again.
    const after = liveStream();
    handler(after.reader, { identity: "host" });
    for (const chunk of paddedSync(10)) after.push(chunk);
    after.end();
    await vi.waitFor(() => expect(syncs).toHaveLength(2));
    expect(room.stats().dropped).toBe(2);
  });
});

describe("sending", () => {
  it("sends small bodies as packets with the topic's reliability, large ones as text streams", async () => {
    const { room, fake } = await join("host");
    const local = fake.localParticipant;
    await room.send("lv.cursor", { x: 0.5, y: 0.5, tool: "pointer" });
    await room.send("lv.grant", { w: "tab-1", user: null }, { to: ["g_ana"] });
    expect(local.publishData.mock.calls.map(([, options]) => options)).toEqual([
      { reliable: false, topic: "lv.cursor" },
      { reliable: true, topic: "lv.grant", destinationIdentities: ["g_ana"] },
    ]);
    const chat = Array.from({ length: 10 }, (_, n) => ({ id: `m${String(n)}`, from: "g_ana", name: "Ana", color: "#E54D2E", text: "x".repeat(1500), at: n }));
    await room.send("lv.sync", { desk: null, strokes: [], chat, grants: [] }, { to: ["g_ana"] });
    const [text, options] = local.sendText.mock.calls[0]!;
    expect(text.length).toBeGreaterThan(PACKET_LIMIT_BYTES);
    expect(options).toEqual({ topic: "lv.sync", destinationIdentities: ["g_ana"] });
    expect(room.stats().sent).toBe(3);
  });

  it("sends what a guest says to the host to the host alone, whoever the caller names", async () => {
    const { room, fake } = await join("guest");
    await room.send("lv.input", { w: "tab-1", e: { type: "insertText", text: "hunter2" } });
    await room.send("lv.input", { w: "tab-1", e: { type: "char", text: "x" } }, { to: ["g_bo"] });
    await room.send("lv.ask", { w: "tab-1" }, { to: [] });
    await room.send("lv.hello", {});
    // What is everyone's goes to whom the guest is with: the host alone, before the host lists anyone.
    await room.send("lv.react", { emoji: "🎉" });
    expect(fake.localParticipant.publishData.mock.calls.map(([, options]) => [options["topic"], options["destinationIdentities"]])).toEqual([
      ["lv.input", ["host"]],
      ["lv.input", ["host"]],
      ["lv.ask", ["host"]],
      ["lv.hello", ["host"]],
      ["lv.react", ["host"]],
    ]);
  });

  it("refuses a topic its role may not send, and drops cursors while the connection is down", async () => {
    const { room, fake } = await join("guest");
    await expect(room.send("lv.desk", { v: 1, seq: 1, stage: { w: 1, h: 1 }, hostPresent: true, space: { title: "", color: "#000000" }, windows: [] })).rejects.toThrow(
      "a guest does not send lv.desk",
    );
    fake.emit("connectionStateChanged", "reconnecting");
    expect(room.state()).toBe("reconnecting");
    await room.send("lv.cursor", { x: 0.1, y: 0.1, tool: "pointer" });
    expect(fake.localParticipant.publishData).not.toHaveBeenCalled();
  });
});

/**
 * A guest's camera or microphone as another participant sees it published: wanted until this side says otherwise.
 * Attached, it gives the element it plays in.
 */
function guestTrack(participant: InstanceType<typeof lk.FakeParticipant>, trackSid: string, kind: "video" | "audio") {
  const publication = {
    trackName: "",
    trackSid,
    track: { kind, attach: vi.fn(() => ({ hidden: false, remove: vi.fn() })), detach: vi.fn() },
    isSubscribed: true,
    isDesired: true,
    setSubscribed: vi.fn((subscribed: boolean) => {
      publication.isDesired = subscribed;
    }),
  };
  participant.trackPublications.set(trackSid, publication);
  return publication;
}

/** Who may subscribe to this side's tracks, as LiveKit was last told. */
const permitted = (fake: FakeRoom) => fake.localParticipant.setTrackSubscriptionPermissions.mock.calls.at(-1)?.[1].map((each) => each.participantIdentity);

/** Each message published: its topic and whom it went to. */
const sentTo = (fake: FakeRoom) => fake.localParticipant.publishData.mock.calls.map(([, options]) => [options["topic"], options["destinationIdentities"]]);

/** The host's list, as it reaches a guest. */
const list = (fake: FakeRoom, host: InstanceType<typeof lk.FakeParticipant>, guests: string[]) => fake.emit("dataReceived", bytes("lv.guests", { guests }), host, 0, "lv.guests");

describe("who a guest is with", () => {
  it("lets only the host subscribe until the host lists the guests it lets in — set before the lobby's tracks go out", async () => {
    const preview = new LivePreview();
    const microphone = { kind: "audio", stop: vi.fn() };
    lk.createLocalAudioTrack.mockResolvedValueOnce(microphone as never);
    await preview.setMicrophone(true);
    const { fake } = await joinWith(preview);
    const local = fake.localParticipant;
    expect(permitted(fake)).toEqual(["host"]);
    expect(local.setTrackSubscriptionPermissions.mock.calls[0]?.[0]).toBe(false);
    expect(local.setTrackSubscriptionPermissions.mock.invocationCallOrder[0]).toBeLessThan(local.publishTrack.mock.invocationCallOrder[0]!);
    const host = remote(fake, "host", hostMeta);
    // The list names this guest too: it lets the others in, not itself.
    list(fake, host, ["g_bo", "g_ana", "g_cy"]);
    expect(permitted(fake)).toEqual(["host", "g_bo", "g_cy"]);
    list(fake, host, ["g_ana", "g_cy"]);
    expect(permitted(fake)).toEqual(["host", "g_cy"]);
  });

  it("takes a list from the host alone", async () => {
    const { fake } = await join("guest");
    const mallory = remote(fake, "g_mallory", guestMeta);
    list(fake, mallory, ["g_ana", "g_mallory"]);
    expect(permitted(fake)).toEqual(["host"]);
  });

  it("says nothing past the host and the guests listed; strokes and chat said before the list wait for it, then go in order", async () => {
    const { room, fake } = await join("guest");
    const host = remote(fake, "host", hostMeta);
    remote(fake, "g_bo", guestMeta);
    remote(fake, "g_stranger", guestMeta);
    const begin: LiveInkOp = { op: "begin", id: "g_ana:1", tool: "pen", color: "#E54D2E", size: 0.003, pts: [0.1, 0.2] };
    // Of the moment: the host alone. What stays: held.
    await room.send("lv.cursor", { x: 0.5, y: 0.5, tool: "pointer" });
    await room.send("lv.ink", begin);
    await room.send("lv.chat", { id: "c1", text: "hi" });
    await room.send("lv.ink", { op: "end", id: "g_ana:1" });
    await room.send("lv.ping", { x: 0.2, y: 0.2 });
    expect(sentTo(fake)).toEqual([
      ["lv.cursor", ["host"]],
      ["lv.ping", ["host"]],
    ]);
    list(fake, host, ["g_ana", "g_bo"]);
    await room.send("lv.react", { emoji: "🎉" });
    // Named outside them: nobody left, nothing sent — never the empty list LiveKit reads as everyone.
    await room.send("lv.chat", { id: "c2", text: "psst" }, { to: ["g_stranger"] });
    expect(sentTo(fake)).toEqual([
      ["lv.cursor", ["host"]],
      ["lv.ping", ["host"]],
      ["lv.ink", ["host", "g_bo"]],
      ["lv.chat", ["host", "g_bo"]],
      ["lv.ink", ["host", "g_bo"]],
      ["lv.react", ["host", "g_bo"]],
    ]);
    expect(JSON.parse(new TextDecoder().decode(fake.localParticipant.publishData.mock.calls[2]![0]))).toEqual(begin);
    expect(room.stats().sent).toBe(6);
  });

  it("hears, shows and plays nobody but the host and the guests listed", async () => {
    const { room, fake } = await join("guest");
    const host = remote(fake, "host", hostMeta);
    const bo = remote(fake, "g_bo", guestMeta);
    const stranger = remote(fake, "g_stranger", guestMeta);
    const boCamera = guestTrack(bo, "TR_bo", "video");
    const strangerMic = guestTrack(stranger, "TR_st", "audio");
    const heard: string[] = [];
    room.onMessage("lv.chat", (body, from) => heard.push(`${String(from.identity)}:${body.text}`));
    const shown: string[][] = [];
    room.on("participants", (participants) => shown.push(participants.map((p) => p.identity)));
    const chat = (from: InstanceType<typeof lk.FakeParticipant>, text: string) => fake.emit("dataReceived", bytes("lv.chat", { id: text.replaceAll(" ", "-"), text }), from, 0, "lv.chat");

    expect(room.participants().map((p) => p.identity)).toEqual(["host", "g_ana"]);
    chat(host, "welcome");
    chat(bo, "early");
    // Published as LiveKit subscribes to everything: let go, and never played (no audio element made).
    fake.emit("trackPublished", strangerMic, stranger);
    expect(strangerMic.setSubscribed).toHaveBeenLastCalledWith(false);
    fake.emit("trackSubscribed", strangerMic.track, strangerMic, stranger);
    expect(strangerMic.track.attach).not.toHaveBeenCalled();
    // Bo's camera, subscribed before the host listed him: let go too, and not his face's.
    fake.emit("trackSubscribed", boCamera.track, boCamera, bo);
    expect(boCamera.isDesired).toBe(false);
    expect(boCamera.track.attach).not.toHaveBeenCalled();

    list(fake, host, ["g_ana", "g_bo"]);
    expect(boCamera.setSubscribed).toHaveBeenLastCalledWith(true);
    expect(strangerMic.isDesired).toBe(false);
    chat(bo, "listed");
    chat(stranger, "let me in");
    // A large message from the stranger is read off and thrown away, never kept.
    const stream = { info: { size: undefined }, async *[Symbol.asyncIterator]() { yield JSON.stringify({ id: "s2", text: "x".repeat(100) }); } };
    fake.textHandlers.get("lv.chat")!(stream, { identity: "g_stranger" });
    await vi.waitFor(() => expect(room.stats().droppedByTopic["lv.chat"]).toBe(3));
    expect(heard).toEqual(["host:welcome", "g_bo:listed"]);
    await Promise.resolve();
    expect(shown.at(-1)).toEqual(["host", "g_ana", "g_bo"]);

    // Let out: no longer heard, shown or subscribed to.
    list(fake, host, ["g_ana"]);
    chat(bo, "after");
    expect(heard).toEqual(["host:welcome", "g_bo:listed"]);
    expect(boCamera.isDesired).toBe(false);
    await Promise.resolve();
    expect(shown.at(-1)).toEqual(["host", "g_ana"]);
  });

  it("tells nobody but the host from a reconnect until the host's list comes again, still hearing the last one", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const { room, fake } = await join("guest", async () => `tok:g_ana:${String((n += 1))}`);
      const host = remote(fake, "host", hostMeta);
      const bo = remote(fake, "g_bo", guestMeta);
      const heard: string[] = [];
      room.onMessage("lv.chat", (body) => heard.push(body.text));
      list(fake, host, ["g_ana", "g_bo"]);
      expect(permitted(fake)).toEqual(["host", "g_bo"]);

      // LiveKit resuming: back to the host alone at once; Bo's word, on the last list, still heard.
      fake.emit("connectionStateChanged", "reconnecting");
      expect(permitted(fake)).toEqual(["host"]);
      fake.emit("connectionStateChanged", "connected");
      await room.send("lv.chat", { id: "c1", text: "while away" });
      fake.emit("dataReceived", bytes("lv.chat", { id: "b1", text: "from Bo" }), bo, 0, "lv.chat");
      expect(heard).toEqual(["from Bo"]);
      expect(sentTo(fake)).toEqual([]);
      list(fake, host, ["g_ana", "g_bo"]);
      expect(permitted(fake)).toEqual(["host", "g_bo"]);
      expect(sentTo(fake)).toEqual([["lv.chat", ["host", "g_bo"]]]);

      // Joined again from scratch: the host alone, set before anything is published again.
      await room.setMicrophone(true);
      fake.emit("disconnected", 9);
      await vi.runAllTimersAsync();
      expect(room.state()).toBe("connected");
      expect(permitted(fake)).toEqual(["host"]);
      await room.send("lv.ink", { op: "clear", scope: "mine" });
      expect(sentTo(fake)).toHaveLength(1);
      list(fake, host, ["g_ana", "g_bo"]);
      expect(sentTo(fake).at(-1)).toEqual(["lv.ink", ["host", "g_bo"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("past what it holds, sends the oldest to the host alone, so the host's board keeps it", async () => {
    const { room, fake } = await join("guest");
    const host = remote(fake, "host", hostMeta);
    remote(fake, "g_bo", guestMeta);
    for (let n = 0; n <= 256; n += 1) await room.send("lv.chat", { id: `c${String(n)}`, text: `m${String(n)}` });
    await Promise.resolve();
    expect(sentTo(fake)).toEqual([["lv.chat", ["host"]]]);
    list(fake, host, ["g_ana", "g_bo"]);
    const texts = fake.localParticipant.publishData.mock.calls.map(([data]) => (JSON.parse(new TextDecoder().decode(data)) as { text: string }).text);
    expect(texts).toHaveLength(257);
    expect(texts.slice(0, 3)).toEqual(["m0", "m1", "m2"]);
    expect(texts.at(-1)).toBe("m256");
  });
});

describe("the host's room", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /**
   * The host joining a room Ana and a stranger (a removed guest LiveKit still has) are in, each with a microphone
   * out: LiveKit subscribes it to both as it joins, before `connect` resolves — and again as it joins afresh, to
   * microphones published anew. The page it would play them in, `played`.
   */
  async function hostJoins(options: { receivers?: string[]; refreshToken?: () => Promise<string> } = {}) {
    const played = vi.fn();
    vi.stubGlobal("document", { body: { append: played } });
    const mics = { ana: [] as Array<ReturnType<typeof guestTrack>>, stranger: [] as Array<ReturnType<typeof guestTrack>> };
    lk.Room.joining = (fake) => {
      for (const [who, identity] of [["ana", "g_ana"], ["stranger", "g_stranger"]] as const) {
        const participant = remote(fake, identity, guestMeta);
        const mic = guestTrack(participant, `TR_${identity}_${String(mics[who].length)}`, "audio");
        mics[who].push(mic);
        fake.emit("trackSubscribed", mic.track, mic, participant);
      }
    };
    const room = await LiveRoom.connect({ url: "ws://sfu", token: "tok:host", role: "host", ...options });
    return { room, fake: lk.Room.instances.at(-1) as FakeRoom, mics, played };
  }

  it("takes nobody's camera or microphone, and lets nobody subscribe, until it is told: one subscribed as it joins is let go unplayed", async () => {
    const { room, fake, mics, played } = await hostJoins();
    const [ana, stranger] = [mics.ana[0]!, mics.stranger[0]!];
    expect([ana.track.attach, stranger.track.attach, played].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);
    expect([ana.isDesired, stranger.isDesired]).toEqual([false, false]);
    expect(fake.localParticipant.setTrackSubscriptionPermissions.mock.calls).toEqual([[false, []]]);
    // Told: Ana's is asked for again.
    room.setReceivers(["g_ana"]);
    expect([ana.isDesired, stranger.isDesired]).toEqual([true, false]);
  });

  it("joins, and joins again from scratch, with the receivers it is given: only their microphones play, only they may subscribe", async () => {
    vi.useFakeTimers();
    let n = 0;
    const { fake, mics, played } = await hostJoins({ receivers: ["g_ana"], refreshToken: async () => `tok:host:${String((n += 1))}` });
    expect(mics.ana[0]!.track.attach).toHaveBeenCalledOnce();
    expect(played).toHaveBeenCalledExactlyOnceWith(mics.ana[0]!.track.attach.mock.results[0]!.value);
    expect(mics.stranger[0]!.track.attach).not.toHaveBeenCalled();
    expect(mics.stranger[0]!.isDesired).toBe(false);
    expect(permitted(fake)).toEqual(["g_ana"]);

    fake.drop();
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.tokens).toEqual(["tok:host", "tok:host:1"]);
    expect(mics.ana[1]!.track.attach).toHaveBeenCalledOnce();
    expect(mics.stranger[1]!.track.attach).not.toHaveBeenCalled();
    expect(mics.stranger[1]!.isDesired).toBe(false);
    expect(played).toHaveBeenCalledTimes(2);
    expect(permitted(fake)).toEqual(["g_ana"]);
  });

  it("takes the cameras and microphones of the guests it lets in alone", async () => {
    const { room, fake } = await join("host");
    const ana = remote(fake, "g_ana", guestMeta);
    const stranger = remote(fake, "g_stranger", guestMeta);
    const anaMic = guestTrack(ana, "TR_ana", "audio");
    const strangerCamera = guestTrack(stranger, "TR_st", "video");
    room.setReceivers([]);
    expect([anaMic.isDesired, strangerCamera.isDesired]).toEqual([false, false]);
    room.setReceivers(["g_ana"]);
    expect([anaMic.isDesired, strangerCamera.isDesired]).toEqual([true, false]);
    // It hears everyone still: whose word counts is the host app's to say (a newcomer's hello comes before main lets them in).
    const hellos: Array<string | null> = [];
    room.onMessage("lv.hello", (_body, from) => hellos.push(from.identity));
    fake.emit("dataReceived", bytes("lv.hello", {}), stranger, 0, "lv.hello");
    expect(hellos).toEqual(["g_stranger"]);
    expect(room.participants().map((p) => p.identity)).toEqual(["host", "g_ana", "g_stranger"]);
  });
});

describe("window tracks", () => {
  it("publishes a window as an H.264 screen share with a half-size layer, unhinted for the hardware encoder", async () => {
    const { room, fake } = await join("host");
    const video = capture(1920, 1080);
    await room.publishWindow("tab-1", video);
    // "detail" would send it to the software encoder.
    expect(video.contentHint).toBe("");
    const [, options] = fake.localParticipant.publishTrack.mock.calls[0]!;
    expect(options).toMatchObject({
      name: "win:tab-1",
      source: "screen_share",
      videoCodec: "h264",
      simulcast: true,
      degradationPreference: "maintain-resolution",
      screenShareEncoding: { maxBitrate: windowBitrate(1920, 1080), maxFramerate: 30 },
    });
    expect(windowBitrate(1920, 1080)).toBe(2_500_000);
    expect((options["screenShareSimulcastLayers"] as Array<{ width: number; height: number }>)[0]).toMatchObject({ width: 960, height: 540 });
    expect(room.publishedWindows()).toEqual(["tab-1"]);
  });

  it("changes nothing for the same tracks, replaces new ones, and never stops what it was given", async () => {
    const { room, fake } = await join("host");
    const local = fake.localParticipant;
    const video = capture();
    const sound = capture();
    await room.publishWindow("tab-1", video);
    await room.publishWindow("tab-1", video);
    expect(local.publishTrack).toHaveBeenCalledTimes(1);
    await room.publishWindow("tab-1", video, sound);
    expect(local.publishTrack.mock.calls[1]?.[1]).toMatchObject({ name: "win-audio:tab-1", source: "screen_share_audio" });
    await room.publishWindow("tab-1", capture(800, 600), sound);
    expect(local.publishTrack).toHaveBeenCalledTimes(3);
    expect(local.unpublishTrack).toHaveBeenCalledTimes(1);
    await room.publishWindow("tab-1", capture(800, 600), null);
    await room.unpublishWindow("tab-1");
    expect(room.publishedWindows()).toEqual([]);
    expect(local.unpublishTrack.mock.calls.every(([, stop]) => stop === false)).toBe(true);
  });

  it("swaps a streamed window's track in place, its encodings, and those a full reconnect publishes it with, following the new size", async () => {
    const { room, fake } = await join("host");
    const local = fake.localParticipant;
    const sound = capture();
    await room.publishWindow("tab-1", capture(1920, 1080), sound);
    const publication = local.published[0]!;
    const sender = publication.videoTrack as { publishOptions: Record<string, unknown>; replaceTrack: ReturnType<typeof vi.fn> };
    // Captured afresh at another size: the same publication, its track swapped, no unpublish.
    const fresh = capture(1280, 800);
    await room.replaceWindowTrack("tab-1", fresh);
    expect(local.publishTrack).toHaveBeenCalledTimes(2);
    expect(local.unpublishTrack).not.toHaveBeenCalled();
    expect(sender.replaceTrack).toHaveBeenCalledWith(fresh, { userProvidedTrack: true });
    expect(sender.publishOptions).toMatchObject({
      name: "win:tab-1",
      simulcast: true,
      screenShareEncoding: { maxBitrate: windowBitrate(1280, 800), maxFramerate: 30 },
    });
    expect((sender.publishOptions["screenShareSimulcastLayers"] as Array<{ width: number; height: number }>)[0]).toMatchObject({ width: 640, height: 400 });
    // LiveKit publishes it again from the publication's options after a full reconnect.
    expect(publication.options).toBe(sender.publishOptions);
    expect(fresh.contentHint).toBe("");
    // The same track resized in place (applyConstraints): its encodings again, nothing republished.
    (fresh as unknown as { getSettings: () => object }).getSettings = () => ({ width: 2560, height: 1600 });
    await room.replaceWindowTrack("tab-1", fresh);
    expect(sender.replaceTrack).toHaveBeenLastCalledWith(fresh, { userProvidedTrack: true });
    expect(sender.publishOptions).toMatchObject({ screenShareEncoding: { maxBitrate: windowBitrate(2560, 1600) } });
    expect(publication.options).toMatchObject({ screenShareEncoding: { maxBitrate: windowBitrate(2560, 1600) } });
    expect(local.publishTrack).toHaveBeenCalledTimes(2);
    expect(room.publishedWindows()).toEqual(["tab-1"]);
  });

  it("publishes a window not streamed yet when asked to replace its track, and falls back to publishing afresh when the swap fails", async () => {
    const { room, fake } = await join("host");
    const local = fake.localParticipant;
    await room.replaceWindowTrack("tab-1", capture());
    expect(local.publishTrack.mock.calls.map(([, options]) => options["name"])).toEqual(["win:tab-1"]);
    const sender = local.published[0]!.videoTrack as { replaceTrack: ReturnType<typeof vi.fn> };
    sender.replaceTrack.mockRejectedValueOnce(new Error("sender closed"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await room.replaceWindowTrack("tab-1", capture(800, 600));
    errors.mockRestore();
    expect(local.unpublishTrack).toHaveBeenCalledTimes(1);
    expect(local.publishTrack.mock.calls.map(([, options]) => options["name"])).toEqual(["win:tab-1", "win:tab-1"]);
  });

  it("publishes the same track on the next ask when the swap and the fresh publish both failed", async () => {
    const { room, fake } = await join("host");
    const local = fake.localParticipant;
    await room.replaceWindowTrack("tab-1", capture());
    const sender = local.published[0]!.videoTrack as { replaceTrack: ReturnType<typeof vi.fn> };
    sender.replaceTrack.mockRejectedValueOnce(new Error("sender closed"));
    local.publishTrack.mockRejectedValueOnce(new Error("publication of local track timed out"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fresh = capture(800, 600);
    await expect(room.replaceWindowTrack("tab-1", fresh)).rejects.toThrow("timed out");
    errors.mockRestore();
    // The caller asks again with the track it has: the window has no publication now, so it is published.
    await room.replaceWindowTrack("tab-1", fresh);
    expect(local.publishTrack).toHaveBeenCalledTimes(3);
    expect(local.publishTrack.mock.calls[2]?.[0]).toBe(fresh);
    expect(room.publishedWindows()).toEqual(["tab-1"]);
  });

  it("acts on the publication LiveKit made anew in a full reconnect of its own: resized, captured afresh, unpublished", async () => {
    const { room, fake } = await join("host");
    const local = fake.localParticipant;
    const video = capture(1920, 1080);
    await room.publishWindow("tab-1", video, capture());
    await room.publishWindow("tab-2", capture());
    const before = local.published[0]!;
    await fake.republishAll();
    // The same tracks out on new publications, the old ones letting go of them.
    expect(before.track).toBeUndefined();
    const now = mine(fake).find((publication) => publication.trackName === "win:tab-1")!;
    const sender = now.videoTrack as { replaceTrack: ReturnType<typeof vi.fn> };
    // Resized in place: swapped on the track out now, its publication carrying the new size's encodings.
    (video as unknown as { getSettings: () => object }).getSettings = () => ({ width: 1280, height: 800 });
    await room.replaceWindowTrack("tab-1", video);
    expect(sender.replaceTrack).toHaveBeenLastCalledWith(video, { userProvidedTrack: true });
    expect(now.options).toMatchObject({ screenShareEncoding: { maxBitrate: windowBitrate(1280, 800) } });
    // Captured afresh: swapped in on it too, never a second publication.
    const fresh = capture(1280, 800);
    await room.replaceWindowTrack("tab-1", fresh);
    expect(sender.replaceTrack).toHaveBeenLastCalledWith(fresh, { userProvidedTrack: true });
    expect(local.publishTrack).toHaveBeenCalledTimes(3);
    expect(mine(fake).map((publication) => publication.trackName)).toEqual(["win:tab-1", "win-audio:tab-1", "win:tab-2"]);
    // Unpublished: what is out of it goes.
    await room.unpublishWindow("tab-1");
    expect(mine(fake).map((publication) => publication.trackName)).toEqual(["win:tab-2"]);
  });

  it("leaves nothing out of a window let go as LiveKit puts it out again: unpublished, or captured afresh, meanwhile", async () => {
    const { room, fake } = await join("host");
    await room.publishWindow("tab-1", capture());
    await room.publishWindow("tab-2", capture());
    const fresh = capture(800, 600);
    await fake.republishAll(async () => {
      await room.unpublishWindow("tab-1");
      await room.replaceWindowTrack("tab-2", fresh);
    });
    expect(mine(fake).map((publication) => [publication.trackName, (publication.track as { mediaStreamTrack: unknown }).mediaStreamTrack])).toEqual([["win:tab-2", fresh]]);
    expect(room.publishedWindows()).toEqual(["tab-2"]);
    // Out again, the window is the one captured afresh.
    await room.unpublishWindow("tab-2");
    expect(mine(fake)).toEqual([]);
  });

  it("is the host's alone", async () => {
    const { room } = await join("guest");
    expect(() => room.publishWindow("tab-1", capture())).toThrow("publishWindow is the host's");
    expect(() => room.replaceWindowTrack("tab-1", capture())).toThrow("replaceWindowTrack is the host's");
    expect(() => room.setReceivers(["g_ana"])).toThrow("setReceivers is the host's");
  });

  it("attaches a guest's element to the host's window track whenever it (re)appears", async () => {
    const { room, fake } = await join("guest");
    const host = remote(fake, "host", hostMeta);
    const element = {} as HTMLVideoElement;
    const detach = room.attachWindow("tab-1", element);
    const first = { kind: "video", attach: vi.fn(), detach: vi.fn() };
    const publication = { trackName: "win:tab-1", track: first, videoTrack: first, isSubscribed: true, trackSid: "TR_1" };
    host.trackPublications.set("TR_1", publication);
    const windows: string[][] = [];
    room.on("windows", (ids) => windows.push(ids));
    fake.emit("trackSubscribed", first, publication, host);
    expect(first.attach).toHaveBeenCalledWith(element);
    await Promise.resolve();
    expect(windows.at(-1)).toEqual(["tab-1"]);
    publication.isSubscribed = false;
    fake.emit("trackUnsubscribed", first, publication, host);
    expect(first.detach).toHaveBeenCalledWith(element);
    const second = { kind: "video", attach: vi.fn(), detach: vi.fn() };
    Object.assign(publication, { track: second, videoTrack: second, isSubscribed: true });
    fake.emit("trackSubscribed", second, publication, host);
    expect(second.attach).toHaveBeenCalledWith(element);
    detach();
    expect(second.detach).toHaveBeenCalledWith(element);
  });

  it("shows a window the host published again (captured afresh) from its new track, whichever way the old one goes", async () => {
    const { room, fake } = await join("guest");
    const host = remote(fake, "host", hostMeta);
    const element = {} as HTMLVideoElement;
    room.attachWindow("tab-1", element);
    const video = () => ({ kind: "video", attach: vi.fn(), detach: vi.fn() });
    const old = video();
    const was = { trackName: "win:tab-1", track: old, videoTrack: old, isSubscribed: true, trackSid: "TR_1" };
    host.trackPublications.set("TR_1", was);
    fake.emit("trackSubscribed", old, was, host);
    // The new capture is subscribed while the old publication is still listed first by name…
    const fresh = video();
    const now = { trackName: "win:tab-1", track: fresh, videoTrack: fresh, isSubscribed: true, trackSid: "TR_2" };
    host.trackPublications.set("TR_2", now);
    fake.emit("trackSubscribed", fresh, now, host);
    expect(fresh.attach).toHaveBeenCalledWith(element);
    expect(room.windowTrack("tab-1")).toBe(fresh);
    // …and the old one going takes nothing with it.
    was.isSubscribed = false;
    host.trackPublications.delete("TR_1");
    fake.emit("trackUnsubscribed", old, was, host);
    expect(fresh.detach).not.toHaveBeenCalled();
    expect(room.windowTrack("tab-1")).toBe(fresh);

    // The other order: the old one unsubscribed (still listed) as the new one arrives.
    const third = video();
    const next = { trackName: "win:tab-1", track: third, videoTrack: third, isSubscribed: true, trackSid: "TR_3" };
    now.isSubscribed = false;
    fake.emit("trackUnsubscribed", fresh, now, host);
    expect(fresh.detach).toHaveBeenCalledWith(element);
    host.trackPublications.set("TR_3", next);
    fake.emit("trackSubscribed", third, next, host);
    expect(third.attach).toHaveBeenCalledWith(element);
  });

  it("takes window tracks only from the host", async () => {
    const { room, fake } = await join("guest");
    const mallory = remote(fake, "g_mallory", guestMeta);
    const track = { kind: "video", attach: vi.fn(), detach: vi.fn() };
    mallory.trackPublications.set("TR_9", { trackName: "win:tab-1", track, videoTrack: track, isSubscribed: true, trackSid: "TR_9" });
    expect(room.windowTrack("tab-1")).toBeNull();
  });
});

describe("losing the connection", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ends at once for a removal, a deleted room or a replaced host", async () => {
    for (const [reason, end] of [
      [4, "removed"],
      [5, "ended"],
      [10, "ended"],
      [2, "replaced"],
    ] as const) {
      const refreshToken = vi.fn(async () => "tok:g_ana");
      const { room, fake } = await join("guest", refreshToken);
      const ends: string[] = [];
      room.on("disconnected", (why) => ends.push(why));
      expect(room.endReason()).toBeNull();
      fake.emit("disconnected", reason);
      await vi.runAllTimersAsync();
      expect(ends).toEqual([end]);
      expect(room.state()).toBe("disconnected");
      // Kept, for whoever asks after the event (a guest restoring its camera after a reload).
      expect(room.endReason()).toBe(end);
      expect(refreshToken).not.toHaveBeenCalled();
    }
  });

  it("lets only the receivers it is given subscribe, and says so again before republishing after joining from scratch", async () => {
    let n = 0;
    const { room, fake } = await join("host", async () => `tok:host:${String((n += 1))}`);
    const local = fake.localParticipant;
    // Nobody let in yet: nobody may subscribe.
    room.setReceivers([]);
    expect(local.setTrackSubscriptionPermissions).toHaveBeenLastCalledWith(false, []);
    room.setReceivers(["g_ana", "g_bo"]);
    expect(local.setTrackSubscriptionPermissions).toHaveBeenLastCalledWith(false, [
      { participantIdentity: "g_ana", allowAll: true },
      { participantIdentity: "g_bo", allowAll: true },
    ]);
    await room.publishWindow("tab-1", capture());
    const calls = local.setTrackSubscriptionPermissions.mock.calls.length;
    fake.emit("disconnected", 9);
    await vi.runAllTimersAsync();
    expect(local.setTrackSubscriptionPermissions).toHaveBeenCalledTimes(calls + 1);
    expect(local.setTrackSubscriptionPermissions).toHaveBeenLastCalledWith(false, [
      { participantIdentity: "g_ana", allowAll: true },
      { participantIdentity: "g_bo", allowAll: true },
    ]);
    // Before the window went out again.
    const permitted = local.setTrackSubscriptionPermissions.mock.invocationCallOrder.at(-1)!;
    const republished = local.publishTrack.mock.invocationCallOrder.at(-1)!;
    expect(permitted).toBeLessThan(republished);
  });

  it("joins again with a fresh token and publishes its windows again", async () => {
    let n = 0;
    const refreshToken = vi.fn(async () => `tok:host:${String((n += 1))}`);
    const { room, fake } = await join("host", refreshToken);
    await room.publishWindow("tab-1", capture());
    const states: string[] = [];
    room.on("state", (state) => states.push(state));
    fake.failConnects = 1;
    fake.emit("disconnected", 9);
    expect(room.state()).toBe("reconnecting");
    // A window asked for while away goes out once joined, and only once.
    await room.publishWindow("tab-2", capture());
    await vi.runAllTimersAsync();
    expect(fake.tokens).toEqual(["tok:host", "tok:host:1", "tok:host:2"]);
    expect(states).toEqual(["reconnecting", "connected"]);
    const names = fake.localParticipant.publishTrack.mock.calls.map(([, options]) => options["name"]);
    expect(names).toEqual(["win:tab-1", "win:tab-1", "win:tab-2"]);
  });

  describe("what is chosen while it joins again from scratch", () => {
    /** A guest in with the lobby's microphone on, and a way back after a loss. */
    async function joinSpeaking() {
      const microphone = lk.localTrack("audio");
      const preview = new LivePreview();
      lk.createLocalAudioTrack.mockResolvedValueOnce(microphone as never);
      await preview.setMicrophone(true);
      let n = 0;
      const room = await LiveRoom.connect({ url: "ws://sfu", token: "tok:g_ana", role: "guest", preview, refreshToken: async () => `tok:g_ana:${String((n += 1))}` });
      return { room, fake: lk.Room.instances.at(-1) as FakeRoom, microphone };
    }

    it("sends a microphone turned off meanwhile out again off, muted, never live: LiveKit has no publication of it to turn off", async () => {
      const { room, fake, microphone } = await joinSpeaking();
      expect(micsOut(fake)).toEqual([[microphone, false]]);
      fake.drop();
      expect(room.state()).toBe("reconnecting");
      await room.setMicrophone(false);
      await vi.runAllTimersAsync();
      expect(room.state()).toBe("connected");
      expect(micsOut(fake)).toEqual([
        [microphone, false],
        [microphone, true],
      ]);
      // Out again, it is LiveKit's to turn on, as ever.
      await room.setMicrophone(true);
      expect(fake.localParticipant.setMicrophoneEnabled).toHaveBeenCalledTimes(1);
      expect(fake.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true, expect.anything());
    });

    it("sends the camera and microphone out again as last chosen meanwhile: on again, on the devices chosen", async () => {
      const { room, fake, microphone } = await joinSpeaking();
      await room.setCamera(true);
      const camera = captured(fake)[0]!;
      fake.drop();
      await room.setMicrophone(false);
      await room.setMicrophone(true, "mic-2");
      await room.setCamera(true, "cam-2");
      await room.switchDevice("audioinput", "mic-3");
      await vi.runAllTimersAsync();
      expect(microphone.setDeviceId.mock.calls).toEqual([[{ exact: "mic-2" }], [{ exact: "mic-3" }]]);
      expect(camera.setDeviceId.mock.calls).toEqual([[{ exact: "cam-2" }]]);
      // Switched before they went out again, the microphone live.
      const local = fake.localParticipant;
      expect(camera.setDeviceId.mock.invocationCallOrder[0]).toBeLessThan(local.publishTrack.mock.invocationCallOrder.at(-2)!);
      expect(published(fake).slice(-2)).toEqual([
        [camera, "camera"],
        [microphone, "microphone"],
      ]);
      expect(micsOut(fake).at(-1)).toEqual([microphone, false]);
      // Out again, LiveKit switches them.
      await room.switchDevice("videoinput", "cam-3");
      expect(camera.setDeviceId).toHaveBeenCalledTimes(1);
      expect(fake.switchActiveDevice).toHaveBeenLastCalledWith("videoinput", "cam-3", true);
    });

    it("does not send a camera turned off meanwhile out again: it is stopped and kept no more", async () => {
      const { room, fake } = await joinSpeaking();
      await room.setCamera(true);
      const camera = captured(fake)[0]!;
      fake.drop();
      await room.setCamera(false);
      expect(camera.stop).toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(room.state()).toBe("connected");
      expect(published(fake).filter(([, source]) => source === "camera")).toEqual([[camera, "camera"]]);
    });

    it("sends the camera out again behind the background chosen meanwhile", async () => {
      const { room, fake } = await joinSpeaking();
      await room.setCamera(true);
      const camera = captured(fake)[0]!;
      fake.drop();
      expect(await room.setBackground(blur)).toBe(true);
      await vi.runAllTimersAsync();
      const local = fake.localParticipant;
      expect(published(fake).filter(([, source]) => source === "camera")).toEqual([
        [camera, "camera"],
        [camera, "camera"],
      ]);
      expect(fx.applyBackground).toHaveBeenLastCalledWith(camera, blur, {});
      expect(fx.applyBackground.mock.invocationCallOrder.at(-1)).toBeLessThan(local.publishTrack.mock.invocationCallOrder.at(-2)!);
      expect(room.background()).toEqual(blur);
    });

    it("captures a microphone turned on meanwhile itself, out once the room says who may have it; turned off before it comes, never", async () => {
      let n = 0;
      const { room, fake } = await join("guest", async () => `tok:g_ana:${String((n += 1))}`);
      const local = fake.localParticipant;
      fake.drop();
      // LiveKit's own switch would publish a capture of its own the moment it is back, before the permissions.
      await room.setMicrophone(true, "mic-2");
      expect(local.setMicrophoneEnabled).not.toHaveBeenCalled();
      expect(local.createTracks).toHaveBeenLastCalledWith({ audio: expect.objectContaining({ deviceId: "mic-2" }) });
      const microphone = captured(fake)[0];
      expect(micsOut(fake)).toEqual([]);
      await vi.runAllTimersAsync();
      expect(micsOut(fake)).toEqual([[microphone, false]]);
      expect(local.setTrackSubscriptionPermissions.mock.invocationCallOrder.at(-1)).toBeLessThan(local.publishTrack.mock.invocationCallOrder.at(-1)!);

      // On and off again while away, with none kept: the capture that comes after the off is stopped, nothing goes out.
      const quiet = await join("guest", async () => `tok:g_ana:${String((n += 1))}`);
      let answer = (): void => undefined;
      const late = lk.localTrack("audio");
      quiet.fake.localParticipant.createTracks.mockImplementationOnce(() => new Promise((resolve) => (answer = () => resolve([late]))));
      quiet.fake.drop();
      const on = quiet.room.setMicrophone(true);
      await quiet.room.setMicrophone(false);
      answer();
      await on;
      await vi.runAllTimersAsync();
      expect(late.stop).toHaveBeenCalled();
      expect(micsOut(quiet.fake)).toEqual([]);
    });
  });

  describe("each of mine going out again on its own after joining from scratch", () => {
    // (Each refusal is reported as it comes.)
    beforeEach(() => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      return () => errors.mockRestore();
    });

    /** The host in with its camera, microphone and a window out, and a way back after a loss. */
    async function joinLive() {
      let n = 0;
      const { room, fake } = await join("host", async () => `tok:host:${String((n += 1))}`);
      await room.setCamera(true);
      await room.setMicrophone(true);
      await room.publishWindow("tab-1", capture());
      const [camera, microphone] = captured(fake);
      const failures: unknown[] = [];
      room.on("mediaFailed", (failure) => failures.push(failure));
      return { room, fake, camera: camera!, microphone: microphone!, failures };
    }

    /** What of mine is out now, by source. */
    const out = (fake: FakeRoom) => mine(fake).map((publication) => publication.source);

    /** How many times the room asked LiveKit to publish my `source`. */
    const tries = (fake: FakeRoom, source: string) => published(fake).filter(([, published]) => published === source).length;

    it("sends the microphone and the windows out again though the camera does not go, and tries the camera again apart", async () => {
      const { room, fake, camera } = await joinLive();
      failPublishes(fake, "camera", 1);
      fake.drop();
      // Joined again (the first wait): the camera refused, the rest out with nothing held up.
      await vi.advanceTimersByTimeAsync(500);
      expect(room.state()).toBe("connected");
      expect(out(fake)).toEqual(["microphone", "screen_share"]);
      expect(camera.stop).not.toHaveBeenCalled();
      // Tried again a second on, the same camera.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(out(fake)).toEqual(["microphone", "screen_share", "camera"]);
      expect(fake.localParticipant.getTrackPublication("camera")?.track).toBe(camera);
      expect(room.participants()).toMatchObject([{ isLocal: true, cameraOn: true }]);
    });

    it("tries the microphone again apart too, and with the rest when the room goes away again meanwhile — never twice", async () => {
      const { room, fake } = await joinLive();
      failPublishes(fake, "microphone", 1);
      fake.drop();
      await vi.advanceTimersByTimeAsync(500);
      expect(room.state()).toBe("connected");
      expect(out(fake)).toEqual(["camera", "screen_share"]);
      // Gone again before its next try: it goes out as the room joins again, and that try never comes.
      fake.drop();
      await vi.advanceTimersByTimeAsync(500);
      expect(out(fake)).toEqual(["camera", "microphone", "screen_share"]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(tries(fake, "microphone")).toBe(3);
    });

    it("sends a microphone turned on between its tries, its own publish refused too, out muted — off, as the person was told — never live", async () => {
      const { room, fake, microphone } = await joinLive();
      failPublishes(fake, "microphone", 2);
      fake.drop();
      await vi.advanceTimersByTimeAsync(500);
      await expect(room.setMicrophone(true)).rejects.toThrow("timed out");
      // The room's next try.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mine(fake).flatMap((publication) => (publication.source === "microphone" ? [[publication.track, publication.muted]] : []))).toEqual([[microphone, true]]);
    });

    it("takes a camera or microphone that never goes out again out of the room, and says so: stopped, kept no more, off — on again, a new capture goes out", async () => {
      for (const kind of ["camera", "microphone"] as const) {
        const joined = await joinLive();
        const { room, fake, failures } = joined;
        const track = joined[kind];
        const refused = failPublishes(fake, kind);
        fake.drop();
        await vi.advanceTimersByTimeAsync(500);
        // Tried again 1, 3 and 8 s on; kept, and nobody told, until the last.
        await vi.advanceTimersByTimeAsync(1_000 + 3_000);
        expect(tries(fake, kind)).toBe(4);
        expect(track.stop).not.toHaveBeenCalled();
        expect(failures).toEqual([]);
        await vi.advanceTimersByTimeAsync(8_000);
        expect(tries(fake, kind)).toBe(5);
        expect(track.stop).toHaveBeenCalled();
        expect(failures).toEqual([{ kind, error: expect.any(Error) }]);
        expect(out(fake)).toEqual(kind === "camera" ? ["microphone", "screen_share"] : ["camera", "screen_share"]);
        expect(room.participants()).toMatchObject([{ isLocal: true, cameraOn: kind !== "camera" }]);
        // Asked for no more, and not in the next room joined afresh either.
        await vi.advanceTimersByTimeAsync(60_000);
        fake.drop();
        await vi.advanceTimersByTimeAsync(500);
        expect(tries(fake, kind)).toBe(5);
        // On again: captured afresh, out.
        refused.heal();
        await (kind === "camera" ? room.setCamera(true) : room.setMicrophone(true));
        const fresh = captured(fake).at(-1);
        expect(fresh).not.toBe(track);
        expect(fake.localParticipant.getTrackPublication(kind)?.track).toBe(fresh);
      }
    });

    it("keeps a camera whose last try is refused as the room goes away again: it goes out as the room joins again", async () => {
      const { fake, camera, failures } = await joinLive();
      failPublishes(fake, "camera", 3);
      fake.drop();
      await vi.advanceTimersByTimeAsync(500 + 1_000 + 3_000);
      let refuse = (): void => undefined;
      fake.localParticipant.publishTrack.mockImplementationOnce(() => new Promise((_resolve, reject) => (refuse = () => reject(new Error("engine closed")))));
      await vi.advanceTimersByTimeAsync(8_000);
      expect(tries(fake, "camera")).toBe(5);
      fake.drop();
      refuse();
      await vi.advanceTimersByTimeAsync(500);
      expect(failures).toEqual([]);
      expect(camera.stop).not.toHaveBeenCalled();
      expect(fake.localParticipant.getTrackPublication("camera")?.track).toBe(camera);
    });

    it("turns off — mutes — a microphone whose first publish is refused with the room here, so no rejoin sends it out live: one turned on in the room, the lobby's as it joins", async () => {
      let n = 0;
      const token = async () => `tok:g_ana:${String((n += 1))}`;
      const { room, fake } = await join("guest", token);
      failPublishes(fake, "microphone", 1);
      await expect(room.setMicrophone(true)).rejects.toThrow("timed out");
      const microphone = captured(fake)[0];
      expect(room.participants()).toMatchObject([{ isLocal: true, micOn: false }]);
      fake.drop();
      await vi.advanceTimersByTimeAsync(500);
      expect(mine(fake).map((publication) => [publication.track, publication.muted])).toEqual([[microphone, true]]);

      const lobby = lk.localTrack("audio");
      const preview = new LivePreview();
      lk.createLocalAudioTrack.mockResolvedValueOnce(lobby as never);
      await preview.setMicrophone(true);
      const joining = LiveRoom.connect({ url: "ws://sfu", token: "tok:g_ana", role: "guest", preview, refreshToken: token });
      const second = lk.Room.instances.at(-1) as FakeRoom;
      failPublishes(second, "microphone", 1);
      const joined = await joining;
      expect(joined.participants()).toMatchObject([{ isLocal: true, micOn: false }]);
      second.drop();
      await vi.advanceTimersByTimeAsync(500);
      expect(mine(second).map((publication) => [publication.track, publication.muted])).toEqual([[lobby, true]]);
    });

    it("is back only when the latest loss's rejoin is: lost again as it puts its tracks out again, it stays reconnecting, and nothing goes out before that rejoin says who may have it", async () => {
      let n = 0;
      const { room, fake } = await join("host", async () => `tok:host:${String((n += 1))}`);
      const local = fake.localParticipant;
      room.setReceivers(["g_ana"]);
      await room.setCamera(true);
      await room.publishWindow("tab-1", capture());
      fake.drop();
      // Joined again, the camera's publish waiting on the server as the connection goes again.
      let refuse = (): void => undefined;
      local.publishTrack.mockImplementationOnce(() => new Promise((_resolve, reject) => (refuse = () => reject(new Error("engine closed")))));
      await vi.advanceTimersByTimeAsync(500);
      expect(tries(fake, "camera")).toBe(2);
      fake.drop();
      refuse();
      await vi.advanceTimersByTimeAsync(0);
      expect(room.state()).toBe("reconnecting");
      // Nothing more of the first rejoin goes out — its window waits for the latest — nor a microphone turned on now.
      expect(out(fake)).toEqual([]);
      await room.setMicrophone(true);
      expect(out(fake)).toEqual([]);
      await vi.advanceTimersByTimeAsync(500);
      expect(room.state()).toBe("connected");
      expect(out(fake)).toEqual(["camera", "microphone", "screen_share"]);
      // Each after the latest rejoin said who may have it.
      const permitted = local.setTrackSubscriptionPermissions.mock.invocationCallOrder.at(-1)!;
      expect(local.publishTrack.mock.invocationCallOrder.slice(-3).every((at) => at > permitted)).toBe(true);
    });

    it("never sends out a camera or microphone that stopped under it: let go and the person told — but not of a microphone that was off", async () => {
      const { room, fake, camera, microphone, failures } = await joinLive();
      // The camera's picture is a processor's, still running over a capture that ends while the room is away.
      camera.mediaStreamTrack = { readyState: "live" };
      // The microphone's first try times out, and LiveKit stops it as it refuses.
      const publish = fake.localParticipant.publishTrack.getMockImplementation()!;
      let timedOut = false;
      fake.localParticipant.publishTrack.mockImplementation(async (track, options) => {
        if (track !== microphone || timedOut) return publish(track, options);
        timedOut = true;
        microphone.capture.readyState = "ended";
        throw new Error("publishing rejected as engine not connected within timeout");
      });
      fake.drop();
      camera.capture.readyState = "ended";
      await vi.advanceTimersByTimeAsync(500);
      expect(out(fake)).toEqual(["screen_share"]);
      expect(camera.stop).toHaveBeenCalled();
      expect(failures).toEqual([{ kind: "camera", error: expect.any(Error) }]);
      // Its next try finds it stopped.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(out(fake)).toEqual(["screen_share"]);
      expect(tries(fake, "microphone")).toBe(2);
      expect(microphone.stop).toHaveBeenCalled();
      expect(failures).toEqual([
        { kind: "camera", error: expect.any(Error) },
        { kind: "microphone", error: expect.any(Error) },
      ]);
      expect(room.participants()).toMatchObject([{ isLocal: true, micOn: false, cameraOn: false }]);

      // Off, and stopped while away: let go, nobody told.
      const quiet = await joinLive();
      await quiet.room.setMicrophone(false);
      quiet.fake.drop();
      quiet.microphone.capture.readyState = "ended";
      await vi.advanceTimersByTimeAsync(500);
      expect(out(quiet.fake)).toEqual(["camera", "screen_share"]);
      expect(quiet.microphone.stop).toHaveBeenCalled();
      expect(quiet.failures).toEqual([]);
    });

    it("reads my camera and microphone as the room has them while it joins again and tries again — as I left them — and off once let go", async () => {
      const { room, fake, camera } = await joinLive();
      const me = () => room.participants().find((participant) => participant.isLocal);
      failPublishes(fake, "camera");
      fake.drop();
      expect(me()).toMatchObject({ micOn: true, cameraOn: true, camera });
      await vi.advanceTimersByTimeAsync(500);
      expect(me()).toMatchObject({ micOn: true, cameraOn: true, camera });
      await room.setMicrophone(false);
      expect(me()).toMatchObject({ micOn: false });
      await vi.advanceTimersByTimeAsync(12_000);
      expect(me()).toMatchObject({ cameraOn: false, camera: null });
    });
  });

  it("takes down a camera turned off as LiveKit puts it out again in a full reconnect of its own; a mic turned off then goes out muted", async () => {
    const microphone = lk.localTrack("audio");
    const preview = new LivePreview();
    lk.createLocalAudioTrack.mockResolvedValueOnce(microphone as never);
    await preview.setMicrophone(true);
    const { room, fake } = await joinWith(preview);
    await room.setCamera(true);
    const camera = captured(fake)[0]!;
    // LiveKit restarts a camera and a microphone before it publishes them again: a choice made then finds neither out.
    await fake.republishAll(async () => {
      await room.setCamera(false);
      await room.setMicrophone(false);
    });
    expect(camera.stop).toHaveBeenCalled();
    expect(mine(fake).map((publication) => [publication.track, publication.muted])).toEqual([[microphone, true]]);
    expect(room.participants()).toMatchObject([{ isLocal: true, cameraOn: false }]);
  });

  it("gives up after its attempts, and without a way to get a token", async () => {
    const refreshToken = vi.fn(async () => {
      throw new Error("control is down");
    });
    const { room, fake } = await join("guest", refreshToken);
    const ends: string[] = [];
    room.on("disconnected", (why) => ends.push(why));
    fake.emit("disconnected", 9);
    await vi.runAllTimersAsync();
    expect(refreshToken).toHaveBeenCalledTimes(6);
    expect(ends).toEqual(["failed"]);

    const alone = await join("guest");
    const aloneEnds: string[] = [];
    alone.room.on("disconnected", (why) => aloneEnds.push(why));
    alone.fake.emit("disconnected", 9);
    expect(aloneEnds).toEqual(["failed"]);
  });

  it("leaves for good on disconnect()", async () => {
    const refreshToken = vi.fn(async () => "tok:g_ana");
    const { room } = await join("guest", refreshToken);
    const ends: string[] = [];
    room.on("disconnected", (why) => ends.push(why));
    await room.disconnect();
    await vi.runAllTimersAsync();
    expect(ends).toEqual(["left"]);
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("is not left when LiveKit lets the room go as the page goes away: a reload must still find its request", async () => {
    const refreshToken = vi.fn(async () => "tok:g_ana");
    const { room, fake } = await join("guest", refreshToken);
    const ends: string[] = [];
    room.on("disconnected", (why) => ends.push(why));
    // LiveKit's own disconnect on pagehide / beforeunload / freeze: client-initiated, with no disconnect() of ours.
    fake.emit("disconnected", 1);
    await vi.runAllTimersAsync();
    expect(ends).toEqual(["failed"]);
    expect(room.endReason()).toBe("failed");
    // Nothing joined again from a page on its way out.
    expect(refreshToken).not.toHaveBeenCalled();
  });
});

const blur = { kind: "blur" } as const;
const dusk = { kind: "image", url: "data:image/svg+xml,dusk" } as const;

/** The next background put on a camera, held: as the segmenter loads, until the test lets it finish or fail. */
function holdBackground() {
  let settle: { finish(applied: boolean): void; fail(error: Error): void } = { finish: () => undefined, fail: () => undefined };
  fx.applyBackground.mockImplementationOnce(() => new Promise<boolean>((resolve, reject) => (settle = { finish: resolve, fail: reject })));
  return {
    finish: (applied = true) => settle.finish(applied),
    fail: () => settle.fail(new Error("the segmenter did not load")),
  };
}

/** Every turn of the event loop that is waiting to run (the room's awaits, any publish that would follow). */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A capture still waiting on the browser's permission prompt; it comes when the person answers. */
function prompted(kind: "video" | "audio") {
  const capture = { readyState: "live" as MediaStreamTrackState };
  const track = { kind, mediaStreamTrack: capture, mediaStream: { getTracks: () => [capture] }, stop: vi.fn(), setDeviceId: vi.fn(async (_deviceId: unknown) => true) };
  let answer = (): void => undefined;
  const comes = new Promise<typeof track>((resolve) => {
    answer = () => resolve(track);
  });
  return { track, comes, answer: () => answer() };
}

const joinWith = async (preview: InstanceType<typeof LivePreview>) => {
  const room = await LiveRoom.connect({ url: "ws://sfu", token: "tok:g_ana", role: "guest", preview });
  return { room, fake: lk.Room.instances.at(-1) as FakeRoom };
};

/** What the room published of mine: each track and its source. */
const published = (fake: FakeRoom) => fake.localParticipant.publishTrack.mock.calls.map(([track, options]) => [track, options["source"]]);

/** The cameras the room captured itself, in order. */
const captured = (fake: FakeRoom) => fake.localParticipant.captured;

/** When the room asked LiveKit to publish `track` (its first publish), as a mock's call order. */
const publishedAt = (fake: FakeRoom, track: unknown) => {
  const publish = fake.localParticipant.publishTrack.mock;
  const at = publish.calls.findIndex(([published]) => published === track);
  expect(at).toBeGreaterThanOrEqual(0);
  return publish.invocationCallOrder[at]!;
};

/**
 * LiveKit refusing to publish my `source` — the next `times` asks, or every one until healed — as it does when the
 * server does not answer a publish.
 */
function failPublishes(fake: FakeRoom, source: string, times = Number.POSITIVE_INFINITY) {
  const local = fake.localParticipant;
  const publish = local.publishTrack.getMockImplementation()!;
  let left = times;
  local.publishTrack.mockImplementation(async (track, options) => {
    if (options["source"] !== source || left <= 0) return publish(track, options);
    left -= 1;
    throw new Error("publication of local track timed out, no response from server");
  });
  return { heal: () => (left = 0) };
}

/** My microphone's publications, in order: the track, and whether it went out muted. */
const micsOut = (fake: FakeRoom) =>
  fake.localParticipant.publishTrack.mock.calls.flatMap(([track, options], i) => (options["source"] === "microphone" ? [[track, fake.localParticipant.published[i]?.muted]] : []));

describe("the lobby's camera and microphone", () => {
  /** The camera and microphone a preview asked for, both still prompting. */
  function asking(preview: InstanceType<typeof LivePreview>) {
    const camera = prompted("video");
    const microphone = prompted("audio");
    lk.createLocalVideoTrack.mockImplementationOnce(() => camera.comes);
    lk.createLocalAudioTrack.mockImplementationOnce(() => microphone.comes);
    const asked = Promise.all([preview.setCamera(true), preview.setMicrophone(true)]);
    const answer = async () => {
      camera.answer();
      microphone.answer();
      await asked;
    };
    return { camera: camera.track, microphone: microphone.track, answer };
  }

  it("are the room's when they come after joining (the prompt answered late), and stop with it", async () => {
    const preview = new LivePreview();
    const { camera, microphone, answer } = asking(preview);
    const { room, fake } = await joinWith(preview);
    expect(published(fake)).toEqual([]);
    await answer();
    // (The camera after its background: the microphone may go first.)
    await vi.waitFor(() => expect(published(fake)).toHaveLength(2));
    expect(published(fake)).toEqual(
      expect.arrayContaining([
        [camera, "camera"],
        [microphone, "microphone"],
      ]),
    );
    // The lobby, still up as the room joins, shows them as the room's: stopping it (leaving it) stops nothing.
    expect([preview.camera(), preview.microphone()]).toEqual([camera, microphone]);
    preview.stop();
    expect(camera.stop).not.toHaveBeenCalled();
    await room.disconnect();
    expect(camera.stop).toHaveBeenCalled();
    expect(microphone.stop).toHaveBeenCalled();
    expect([preview.camera(), preview.microphone()]).toEqual([null, null]);
  });

  it("are stopped as they come when the lobby was left, or the device turned off again, meanwhile", async () => {
    const left = new LivePreview();
    const late = asking(left);
    left.stop();
    await late.answer();
    expect(late.camera.stop).toHaveBeenCalled();
    expect(late.microphone.stop).toHaveBeenCalled();
    expect([left.camera(), left.microphone()]).toEqual([null, null]);

    const offAgain = new LivePreview();
    const again = asking(offAgain);
    await Promise.all([offAgain.setCamera(false), offAgain.setMicrophone(false)]);
    await again.answer();
    expect(again.camera.stop).toHaveBeenCalled();
    expect(again.microphone.stop).toHaveBeenCalled();
    expect([offAgain.camera(), offAgain.microphone()]).toEqual([null, null]);
  });

  it("are stopped as they come once the room ended, or the person chose again in it", async () => {
    const ended = new LivePreview();
    const tooLate = asking(ended);
    const gone = await joinWith(ended);
    await gone.room.disconnect();
    await tooLate.answer();
    expect(published(gone.fake)).toEqual([]);
    expect(tooLate.camera.stop).toHaveBeenCalled();
    expect(tooLate.microphone.stop).toHaveBeenCalled();

    const chose = new LivePreview();
    const superseded = asking(chose);
    const { room, fake } = await joinWith(chose);
    await room.setCamera(true);
    await room.setMicrophone(false);
    await superseded.answer();
    // The room's own camera alone.
    expect(published(fake)).toEqual([[captured(fake)[0], "camera"]]);
    expect(superseded.camera.stop).toHaveBeenCalled();
    expect(superseded.microphone.stop).toHaveBeenCalled();
  });

  it("come after joining on the camera and microphone chosen in the room meanwhile", async () => {
    const preview = new LivePreview();
    const { camera, microphone, answer } = asking(preview);
    const { room, fake } = await joinWith(preview);
    await room.switchDevice("videoinput", "cam-2");
    await room.switchDevice("audioinput", "mic-2");
    await answer();
    await vi.waitFor(() => expect(published(fake)).toHaveLength(2));
    expect(camera.setDeviceId.mock.calls).toEqual([[{ exact: "cam-2" }]]);
    expect(microphone.setDeviceId.mock.calls).toEqual([[{ exact: "mic-2" }]]);
    for (const track of [camera, microphone]) expect(track.setDeviceId.mock.invocationCallOrder[0]).toBeLessThan(publishedAt(fake, track));
  });

  /** Two lobby tracks on, as a guest joins with them. */
  async function lobbyOn() {
    const preview = new LivePreview();
    const microphone = lk.localTrack("audio");
    const camera = lk.localTrack("video");
    lk.createLocalAudioTrack.mockResolvedValueOnce(microphone as never);
    lk.createLocalVideoTrack.mockResolvedValueOnce(camera as never);
    await Promise.all([preview.setMicrophone(true), preview.setCamera(true)]);
    return { preview, microphone, camera };
  }

  it("are the room's to switch from the moment it has them, the lobby still up as it joins: a microphone turned off as it is published goes out muted, a camera turned off as it comes not at all", async () => {
    const { preview, microphone, camera } = await lobbyOn();
    // The camera's background loads in the room as the microphone's publish waits on the server.
    const loading = holdBackground();
    const joining = LiveRoom.connect({ url: "ws://sfu", token: "tok:g_ana", role: "guest", preview });
    const fake = lk.Room.instances.at(-1) as FakeRoom;
    const local = fake.localParticipant;
    let land = (): void => undefined;
    local.publishTrack.mockImplementationOnce(async (track, options) => {
      await new Promise<void>((resolve) => (land = resolve));
      return local.put(track as ReturnType<typeof lk.localTrack>, options);
    });
    await vi.waitFor(() => expect(local.publishTrack).toHaveBeenCalled());
    // The lobby shows what the room has on, and its switches are the room's.
    expect([preview.camera(), preview.microphone()]).toEqual([camera, microphone]);
    await preview.setMicrophone(false);
    await preview.setCamera(false);
    expect([preview.camera(), preview.microphone()]).toEqual([null, null]);
    land();
    loading.finish();
    const room = await joining;
    await settled();
    expect(micsOut(fake)).toEqual([[microphone, true]]);
    expect(published(fake)).toEqual([[microphone, "microphone"]]);
    expect(camera.stop).toHaveBeenCalled();
    await room.disconnect();
  });

  it("go out as the lobby chose last while the room joined: a background, a camera and a microphone chosen there then are the room's", async () => {
    const { preview, microphone, camera } = await lobbyOn();
    const loading = holdBackground();
    const { room, fake } = await joinWith(preview);
    // Joined, the lobby not gone yet: the camera's background still loads in the room.
    expect(await preview.setBackground(dusk)).toBe(true);
    const choosing = preview.setCamera(true, "cam-2");
    await preview.setMicrophone(true, "mic-2");
    expect(fake.switchActiveDevice).toHaveBeenCalledWith("audioinput", "mic-2", true);
    loading.finish();
    await choosing;
    expect(camera.setDeviceId.mock.calls).toEqual([[{ exact: "cam-2" }]]);
    expect(camera.setDeviceId.mock.invocationCallOrder[0]).toBeLessThan(publishedAt(fake, camera));
    expect(fx.applyBackground).toHaveBeenLastCalledWith(camera, dusk, {});
    expect(published(fake)).toEqual([
      [microphone, "microphone"],
      [camera, "camera"],
    ]);
    expect([room.background(), preview.background()]).toEqual([dusk, dusk]);
  });
});

describe("my microphone and the devices chosen", () => {
  // (LiveKit's own switch would wait for its capture and publish, and mute only what went out live.)
  it("turned off on its permission prompt, never goes out: the capture is stopped as it comes", async () => {
    const { room, fake } = await join("host");
    const microphone = lk.localTrack("audio");
    let answer = (): void => undefined;
    fake.localParticipant.createTracks.mockImplementationOnce(() => new Promise((resolve) => (answer = () => resolve([microphone]))));
    const on = room.setMicrophone(true);
    const off = room.setMicrophone(false);
    answer();
    await Promise.all([on, off]);
    expect(micsOut(fake)).toEqual([]);
    expect(microphone.stop).toHaveBeenCalled();
  });

  it("turned off as it is published, goes out muted, never live", async () => {
    const { room, fake } = await join("host");
    const local = fake.localParticipant;
    let land = (): void => undefined;
    local.publishTrack.mockImplementationOnce(async (track, options) => {
      await new Promise<void>((resolve) => (land = resolve));
      return local.put(track as ReturnType<typeof lk.localTrack>, options);
    });
    const coming = room.setMicrophone(true);
    await vi.waitFor(() => expect(local.publishTrack).toHaveBeenCalled());
    const muting = room.setMicrophone(false);
    land();
    await Promise.all([coming, muting]);
    expect(micsOut(fake)).toEqual([[captured(fake)[0], true]]);
  });

  it("comes on again on the device chosen while it was off, switched while still muted; the system's camera is not asked for exactly", async () => {
    const { room, fake } = await join("host");
    const local = fake.localParticipant;
    await room.setMicrophone(true, "mic-2");
    await room.setMicrophone(false);
    await room.setMicrophone(true, "default");
    expect(fake.switchActiveDevice).toHaveBeenLastCalledWith("audioinput", "default", false);
    // Muted, LiveKit takes the device as it unmutes: not a moment of the one before goes out.
    expect(fake.switchActiveDevice.mock.invocationCallOrder.at(-1)).toBeLessThan(local.setMicrophoneEnabled.mock.invocationCallOrder.at(-1)!);
    expect(local.setMicrophoneEnabled).toHaveBeenLastCalledWith(true, expect.anything());

    // Chromium has no camera "default" to capture exactly (and LiveKit stops a camera before it captures the next).
    await room.setCamera(true, "default");
    expect(local.createTracks).toHaveBeenLastCalledWith({ video: expect.objectContaining({ deviceId: "default" }) });
    await room.switchDevice("videoinput", "cam-2");
    expect(fake.switchActiveDevice).toHaveBeenLastCalledWith("videoinput", "cam-2", true);
    await room.switchDevice("videoinput", "default");
    expect(fake.switchActiveDevice).toHaveBeenLastCalledWith("videoinput", "default", false);
  });

  // (LiveKit's switch, with nothing published, only notes a device for the next capture.)
  it("goes out on the camera or microphone chosen while it comes — its prompt up, a camera's background loading — not the one it was asked on", async () => {
    const { room, fake } = await join("guest");
    const local = fake.localParticipant;
    // Another camera chosen from the menu as the background loads on this one.
    const loading = holdBackground();
    const on = room.setCamera(true, "cam-1");
    await vi.waitFor(() => expect(fx.applyBackground).toHaveBeenCalled());
    const camera = captured(fake)[0]!;
    await room.switchDevice("videoinput", "cam-2");
    loading.finish();
    await on;
    expect(camera.setDeviceId.mock.calls).toEqual([[{ exact: "cam-2" }]]);
    expect(camera.setDeviceId.mock.invocationCallOrder[0]).toBeLessThan(publishedAt(fake, camera));
    await room.setCamera(false);

    // On their prompts: the camera asked on again on another, the system's microphone chosen.
    const answers: Array<() => void> = [];
    const prompt = (track: ReturnType<typeof lk.localTrack>) => local.createTracks.mockImplementationOnce(() => new Promise((resolve) => answers.push(() => resolve([track]))));
    const second = lk.localTrack("video");
    const microphone = lk.localTrack("audio");
    prompt(second);
    prompt(microphone);
    const coming = room.setCamera(true);
    const speaking = room.setMicrophone(true);
    const again = room.setCamera(true, "cam-3");
    await room.switchDevice("audioinput", "default");
    for (const answer of answers) answer();
    await Promise.all([coming, speaking, again]);
    expect(second.setDeviceId.mock.calls).toEqual([[{ exact: "cam-3" }]]);
    expect(microphone.setDeviceId.mock.calls).toEqual([["default"]]);
    for (const track of [second, microphone]) expect(track.setDeviceId.mock.invocationCallOrder[0]).toBeLessThan(publishedAt(fake, track));
    expect(micsOut(fake)).toEqual([[microphone, false]]);
  });
});

describe("the camera's background", () => {
  it("is on the camera before it goes out: turned on with a background chosen, the camera is published only once the background is on it", async () => {
    const { room, fake } = await join("guest");
    // Chosen with the camera off: kept for when it comes on.
    expect(await room.setBackground(blur)).toBe(true);
    const loading = holdBackground();
    const on = room.setCamera(true);
    await vi.waitFor(() => expect(captured(fake)).toHaveLength(1));
    await settled();
    expect(published(fake)).toEqual([]);
    const [camera] = captured(fake);
    expect(fx.applyBackground).toHaveBeenCalledWith(camera, blur, {});
    loading.finish();
    await on;
    expect(published(fake)).toEqual([[camera, "camera"]]);
    expect(room.participants().find((p) => p.isLocal)?.cameraOn).toBe(true);
  });

  it("stays off when the background cannot be put on: the capture stopped, nothing published, the error the caller's", async () => {
    const { room, fake } = await join("guest");
    await room.setBackground(dusk);
    const loading = holdBackground();
    const on = room.setCamera(true);
    await vi.waitFor(() => expect(fx.applyBackground).toHaveBeenCalled());
    loading.fail();
    await expect(on).rejects.toThrow("the segmenter did not load");
    expect(published(fake)).toEqual([]);
    expect(captured(fake)[0]?.stop).toHaveBeenCalled();
    expect(room.participants().find((p) => p.isLocal)?.cameraOn).toBe(false);
    // Where effects are unsupported: the same.
    fx.applyBackground.mockResolvedValueOnce(false);
    await expect(room.setCamera(true)).rejects.toThrow();
    expect(published(fake)).toEqual([]);
    expect(captured(fake)[1]?.stop).toHaveBeenCalled();
  });

  it("goes out behind the background chosen last, one chosen while the first loads included", async () => {
    const { room, fake } = await join("guest");
    await room.setBackground(blur);
    const first = holdBackground();
    const second = holdBackground();
    const on = room.setCamera(true);
    await vi.waitFor(() => expect(fx.applyBackground).toHaveBeenCalledTimes(1));
    expect(await room.setBackground(dusk)).toBe(true);
    first.finish();
    await vi.waitFor(() => expect(fx.applyBackground).toHaveBeenCalledTimes(2));
    await settled();
    expect(published(fake)).toEqual([]);
    second.finish();
    await on;
    const [camera] = captured(fake);
    expect(fx.applyBackground.mock.calls.map(([track, background]) => [track, background])).toEqual([
      [camera, blur],
      [camera, dusk],
    ]);
    expect(published(fake)).toEqual([[camera, "camera"]]);
  });

  it("turned off while its background loads, never goes out, its capture stopped at once; asked on again meanwhile, it is the same camera", async () => {
    const { room, fake } = await join("guest");
    await room.setBackground(blur);
    const loading = holdBackground();
    const on = room.setCamera(true);
    const again = room.setCamera(true);
    await vi.waitFor(() => expect(fx.applyBackground).toHaveBeenCalled());
    expect(captured(fake)).toHaveLength(1);
    const [camera] = captured(fake);
    await room.setCamera(false);
    expect(camera?.stop).toHaveBeenCalled();
    loading.finish();
    await Promise.all([on, again]);
    expect(published(fake)).toEqual([]);
  });

  it("off, is unpublished and stopped (not muted, to come back raw): on again, the new capture has the background first", async () => {
    const { room, fake } = await join("guest");
    await room.setCamera(true);
    const [first] = captured(fake);
    await room.setCamera(false);
    expect(fake.localParticipant.unpublishTrack).toHaveBeenCalledWith(first, false);
    expect(first?.stop).toHaveBeenCalled();
    expect(room.participants().find((p) => p.isLocal)?.cameraOn).toBe(false);
    // Off, a background is chosen; on again, it is on the camera before the camera is out.
    await room.setBackground(blur);
    const loading = holdBackground();
    const on = room.setCamera(true);
    await vi.waitFor(() => expect(captured(fake)).toHaveLength(2));
    await settled();
    expect(published(fake)).toEqual([[first, "camera"]]);
    const second = captured(fake)[1];
    expect(fx.applyBackground).toHaveBeenLastCalledWith(second, blur, {});
    loading.finish();
    await on;
    expect(published(fake)).toEqual([
      [first, "camera"],
      [second, "camera"],
    ]);
  });

  it("is on the lobby's camera before the room publishes it, a background still loading as the guest joins included; failing, the camera stays off", async () => {
    for (const ends of ["on", "failed"] as const) {
      const preview = new LivePreview();
      const camera = { kind: "video", stop: vi.fn() };
      lk.createLocalVideoTrack.mockResolvedValueOnce(camera);
      await preview.setCamera(true);
      // Chosen in the lobby just before joining: the lobby's segmenter still loads, and so does the room's.
      const inLobby = holdBackground();
      void preview.setBackground(blur);
      const inRoom = holdBackground();
      const joined = await joinWith(preview);
      await settled();
      expect(published(joined.fake)).toEqual([]);
      expect(fx.applyBackground).toHaveBeenLastCalledWith(camera, blur, {});
      inLobby.finish();
      if (ends === "on") {
        inRoom.finish();
        await vi.waitFor(() => expect(published(joined.fake)).toEqual([[camera, "camera"]]));
      } else {
        const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
        inRoom.fail();
        await vi.waitFor(() => expect(camera.stop).toHaveBeenCalled());
        await settled();
        expect(published(joined.fake)).toEqual([]);
        // No caller to tell (the join went on without it): reported, and the room is usable.
        expect(reported).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ message: "the segmenter did not load" }));
        reported.mockRestore();
        expect(joined.room.state()).toBe("connected");
      }
    }
  });

  it("is on a lobby camera that comes after joining before it goes out, and keeps it off when it cannot be", async () => {
    const preview = new LivePreview();
    await preview.setBackground(blur);
    const late = prompted("video");
    lk.createLocalVideoTrack.mockImplementationOnce(() => late.comes);
    const asked = preview.setCamera(true);
    const { fake } = await joinWith(preview);
    const loading = holdBackground();
    late.answer();
    await asked;
    await vi.waitFor(() => expect(fx.applyBackground).toHaveBeenCalledWith(late.track, blur, {}));
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    loading.fail();
    await vi.waitFor(() => expect(late.track.stop).toHaveBeenCalled());
    await settled();
    expect(published(fake)).toEqual([]);
    expect(reported).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ message: "the segmenter did not load" }));
    reported.mockRestore();
  });

  it("changed on a camera that is out and failing, gives way to the one the camera had: the room's choice again, the camera still out", async () => {
    const { room, fake } = await join("guest");
    await room.setBackground(blur);
    await room.setCamera(true);
    const [camera] = captured(fake);
    // The picture does not load: the effects put the blur back on the camera (effects.test.ts).
    fx.backgroundOn.mockReturnValue(blur);
    fx.applyBackground.mockRejectedValueOnce(new Error("the picture did not load"));
    await expect(room.setBackground(dusk)).rejects.toThrow("the picture did not load");
    expect(room.background()).toBe(blur);
    expect(fx.backgroundOn).toHaveBeenCalledWith(camera);
    expect(camera?.stop).not.toHaveBeenCalled();
    expect(fake.localParticipant.unpublishTrack).not.toHaveBeenCalled();
    // Where effects are unsupported: nothing changed on the camera, and the room's choice says so.
    fx.applyBackground.mockResolvedValueOnce(false);
    expect(await room.setBackground(dusk)).toBe(false);
    expect(room.background()).toBe(blur);
  });

  it("changed again while a change loads, answers for the later one: the first failing after is let go", async () => {
    const { room, fake } = await join("guest");
    await room.setCamera(true);
    const [camera] = captured(fake);
    const first = holdBackground();
    const failing = room.setBackground(blur);
    expect(await room.setBackground(dusk)).toBe(true);
    first.fail();
    expect(await failing).toBe(true);
    expect(room.background()).toBe(dusk);
    expect(camera?.stop).not.toHaveBeenCalled();
  });

  it("turned off while a change loads on it, out, leaves the room at once; the change landing after brings nothing back and tells nobody", async () => {
    for (const ends of ["on", "failed"] as const) {
      const { room, fake } = await join("guest");
      await room.setCamera(true);
      const camera = captured(fake).at(-1);
      expect(published(fake)).toEqual([[camera, "camera"]]);
      const loading = holdBackground();
      const changing = room.setBackground(dusk);
      await vi.waitFor(() => expect(fx.applyBackground).toHaveBeenLastCalledWith(camera, dusk, {}));
      // Off while the segmenter loads: answered before it is done, the camera stopped and out of the room.
      await room.setCamera(false);
      expect(camera?.stop).toHaveBeenCalled();
      expect(fake.localParticipant.unpublishTrack).toHaveBeenCalledWith(camera, false);
      expect(room.participants().find((p) => p.isLocal)?.cameraOn).toBe(false);
      if (ends === "on") loading.finish();
      else loading.fail();
      expect(await changing).toBe(true);
      await settled();
      expect(published(fake)).toEqual([[camera, "camera"]]);
      expect(fake.localParticipant.unpublishTrack).toHaveBeenCalledTimes(1);
      expect(room.participants().find((p) => p.isLocal)?.cameraOn).toBe(false);
      // The choice stands for the camera turned on again.
      expect(room.background()).toBe(dusk);
    }
  });

  it("stops every camera it lets go while a background loads for it for good, so the effects let that background go too", async () => {
    // Out, a change loading on it, turned off.
    const out = await join("guest");
    await out.room.setCamera(true);
    const [kept] = captured(out.fake);
    holdBackground();
    void out.room.setBackground(dusk);
    await out.room.setCamera(false);
    expect(fx.stopCamera).toHaveBeenLastCalledWith(kept);
    // Coming on behind its background, turned off; and the room left while one loads on the camera.
    const coming = await join("guest");
    await coming.room.setBackground(blur);
    const loading = holdBackground();
    const on = coming.room.setCamera(true);
    await vi.waitFor(() => expect(fx.applyBackground).toHaveBeenLastCalledWith(captured(coming.fake)[0], blur, {}));
    await coming.room.setCamera(false);
    expect(fx.stopCamera).toHaveBeenLastCalledWith(captured(coming.fake)[0]);
    loading.finish();
    await on;
    const left = await join("guest");
    await left.room.setCamera(true);
    holdBackground();
    void left.room.setBackground(dusk);
    await left.room.disconnect();
    expect(fx.stopCamera).toHaveBeenLastCalledWith(captured(left.fake)[0]);
    // The lobby's: turned off, and the lobby left, while a background loads on it.
    for (const leave of ["off", "stop"] as const) {
      const preview = new LivePreview();
      const camera = { kind: "video", stop: vi.fn() };
      lk.createLocalVideoTrack.mockResolvedValueOnce(camera);
      await preview.setCamera(true);
      holdBackground();
      void preview.setBackground(blur);
      if (leave === "off") await preview.setCamera(false);
      else preview.stop();
      expect(fx.stopCamera).toHaveBeenLastCalledWith(camera);
    }
  });

  it("takes the camera out of the room when, its change failed, nobody can say what is behind it", async () => {
    const { room, fake } = await join("guest");
    await room.setCamera(true);
    const [camera] = captured(fake);
    fx.backgroundOn.mockReturnValue(null);
    fx.applyBackground.mockRejectedValueOnce(new Error("the picture did not load"));
    await expect(room.setBackground(dusk)).rejects.toThrow("the picture did not load");
    expect(camera?.stop).toHaveBeenCalled();
    expect(fake.localParticipant.unpublishTrack).toHaveBeenCalledWith(camera, false);
    expect(room.participants().find((p) => p.isLocal)?.cameraOn).toBe(false);
  });

  it("in the lobby, gives way to the one the camera had when a change cannot be put on", async () => {
    const preview = new LivePreview();
    const camera = { kind: "video", stop: vi.fn() };
    lk.createLocalVideoTrack.mockResolvedValueOnce(camera);
    await preview.setCamera(true);
    fx.applyBackground.mockRejectedValueOnce(new Error("the segmenter did not load"));
    await expect(preview.setBackground(blur)).rejects.toThrow("the segmenter did not load");
    expect(preview.background()).toEqual({ kind: "none" });
    expect(preview.camera()).toBe(camera);
    fx.applyBackground.mockResolvedValueOnce(false);
    expect(await preview.setBackground(dusk)).toBe(false);
    expect(preview.background()).toEqual({ kind: "none" });
  });

  it("in the lobby, keeps the camera off when the background chosen cannot be put on it, as the room would", async () => {
    const preview = new LivePreview();
    await preview.setBackground(blur);
    const camera = { kind: "video", stop: vi.fn() };
    lk.createLocalVideoTrack.mockResolvedValueOnce(camera);
    fx.applyBackground.mockRejectedValueOnce(new Error("the segmenter did not load"));
    await expect(preview.setCamera(true)).rejects.toThrow("the segmenter did not load");
    expect(camera.stop).toHaveBeenCalled();
    expect(preview.camera()).toBeNull();
    // The choice stands, for the camera turned on again (or None chosen).
    expect(preview.background()).toBe(blur);
  });
});

describe("sound", () => {
  it("keeps that the browser blocked it for whoever asks after: LiveKit says so once, perhaps before anyone listens", async () => {
    const { room, fake } = await join("guest");
    expect(room.audioBlocked()).toBe(false);
    // Blocked as the room joined, before the page listened.
    fake.emit("audioPlaybackChanged", false);
    expect(room.audioBlocked()).toBe(true);
    const heard: boolean[] = [];
    room.on("audioBlocked", (blocked) => heard.push(blocked));
    fake.emit("audioPlaybackChanged", true);
    expect(room.audioBlocked()).toBe(false);
    expect(heard).toEqual([false]);
  });

  it("plays on the speaker it is given from the first track, a lobby's join and a reload's alike", async () => {
    const preview = new LivePreview();
    await LiveRoom.connect({ url: "ws://sfu", token: "tok:g_ana", role: "guest", preview, audioOutput: "speaker-2" });
    expect((lk.Room.instances.at(-1) as FakeRoom).options["audioOutput"]).toEqual({ deviceId: "speaker-2" });
    await LiveRoom.connect({ url: "ws://sfu", token: "tok:g_ana", role: "guest", audioOutput: "speaker-2" });
    expect((lk.Room.instances.at(-1) as FakeRoom).options["audioOutput"]).toEqual({ deviceId: "speaker-2" });
    // None chosen: LiveKit's default, the system's.
    const { fake } = await join("guest");
    expect(fake.options["audioOutput"]).toBeUndefined();
  });
});
