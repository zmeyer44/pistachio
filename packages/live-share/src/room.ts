/**
 * `LiveRoom`: the one wrapper over livekit-client both ends use
 * (docs/live-share.md §3, §4). The live-host app on the Mac and the guest
 * page build on this API alone:
 *
 *   const room = await LiveRoom.connect({ url, token, role, refreshToken?, preview?, audioOutput?, effectsAssetPath?, receivers? });
 *   room.identity, room.role
 *   room.state()                       "connecting" | "connected" | "reconnecting" | "disconnected"
 *   room.endReason()                   why it ended (kept), or null while it lasts
 *   room.participants()                LiveParticipant[]: host first, then guests in join order, me included
 *                                      (a guest's room: the guests the host lists alone; mine: what the room
 *                                      keeps on, whether or not it is out this moment)
 *   room.on("state" | "participants" | "windows" | "disconnected" | "audioBlocked" | "mediaFailed", cb) → off()
 *   room.send(topic, body, { to? })    reliability from LIVE_TOPICS; > 12 KB goes as a text stream;
 *                                      a topic for the host alone (guest → host) goes to it alone;
 *                                      a guest's goes no further than the host and the guests it lists
 *   room.onMessage(topic, cb)          cb(body, { identity, role }) — validated, sender-checked, else dropped
 *   room.stats()                       messages received / sent / dropped (by topic)
 *   room.setMicrophone(on, deviceId?), room.setCamera(on, deviceId?), room.setBackground(bg)
 *   room.devices(kind), room.switchDevice(kind, id), room.localCamera()
 *   room.audioBlocked(), room.startAudio()  whether playback is refused (kept: LiveKit says it once); start it after a gesture
 *   host:  room.publishWindow(id, video, audio?), room.replaceWindowTrack(id, video),
 *          room.unpublishWindow(id), room.publishedWindows(), room.setReceivers(identities)
 *   guest: room.windowTrack(id), room.attachWindow(id, videoElement) → detach()
 *   room.disconnect()
 *
 * `LivePreview` is the lobby's camera and microphone before joining (preview,
 * mic level, background, devices); passed to `connect`, its tracks are
 * published as they are — no second camera prompt, no segmenter reload —
 * and one still waiting on its permission prompt is published when it comes.
 *
 * A camera goes out behind the background chosen, or not at all: every
 * camera that comes into the room — turned on in it, the lobby's, one whose
 * prompt was answered late — has the background put on it before it is
 * published, and is stopped unpublished when that fails (`#putCamera`).
 * A background changed on a camera that is out and failing gives way to the
 * one the camera had, put back on it and the room's choice again
 * (`setBackground`). Turned off, it is unpublished and stopped, never muted:
 * a muted camera would come back raw while its background loads again. A
 * camera let go is stopped for good (`stopCamera`), so a background still
 * loading for it goes with it.
 *
 * A room joined again from scratch (LiveKit gave the connection up)
 * publishes my camera, microphone and windows again as they are then: what
 * was chosen while it was away — the mic or the camera turned off, another
 * device, a background, a window's new picture — is what goes out, never
 * what was out before. LiveKit holds no publication of them meanwhile, so
 * the room makes those choices on the tracks it keeps. Each goes out on its
 * own, one that does not holding up none of the others: a camera or
 * microphone is tried again a few times and then taken out of the room
 * ("mediaFailed"); a window is the caller's to ask for again.
 *
 * Messages: every inbound packet or text stream is checked by
 * `decodeMessage` — the sender's role (from control's metadata; no
 * participant means the server) before the body, then size and shape — and a
 * failure is dropped and counted, never thrown. A text stream is held only
 * from a sender whose role may send its topic, two of theirs at a time,
 * within the topic's limit and a budget for all streams together; the rest
 * are read off and thrown away. Remote audio (microphones and
 * windows' sound) plays on its own: the room attaches it to hidden audio
 * elements.
 *
 * Who a guest is with (§4 `lv.guests`): the host, and the guests the host
 * lists — the guests it lets in, sent to them on every change and as each
 * says hello. Only they may subscribe to a guest's camera and microphone,
 * only they are sent what it says, and only theirs is heard, shown or
 * played; until the first list comes, and from a reconnect until a fresh
 * one does, its camera, mic and word reach the host alone (what it hears
 * stays the last list's). LiveKit's subscription permissions are each
 * publisher's own, so this is how someone in the room the host has not let
 * in — a removed guest before LiveKit drops them, a token minted outside
 * control — gets nothing of the guests'. The host lets in whom main says
 * (`receivers` as it joins, `setReceivers` from then on) and nobody before
 * it says, and is with those alone for its tracks; it hears everyone, since
 * the host app decides whose word counts.
 *
 * Window tracks (host): `win:<windowId>` as ScreenShare, H.264, simulcast at
 * full and half resolution, no content hint, degradation
 * "maintain-resolution", ≤ 30 fps, bitrate by pixels;
 * `win-audio:<windowId>` as ScreenShareAudio. A window captured afresh or
 * resized keeps its publication (`replaceWindowTrack`), so guests never lose
 * its picture. The caller owns the MediaStreamTracks it hands over:
 * unpublishing never stops them, and they survive a reconnect, after which
 * the room publishes them again. A full reconnect of LiveKit's own
 * publishes them anew itself, on new publications of the same LiveKit
 * tracks: the room holds each window by its track, so a resize, a new
 * capture or an unpublish acts on whichever publication is out now, and a
 * track it let go of meanwhile — a window's, a camera turned off — is taken
 * down again as LiveKit puts it out. It caps capture size by asking for it
 * (`WINDOW_CAPTURE_MAX_SIDE` in the capture constraints).
 *
 * Browser-only (needs WebRTC and a document).
 */

import {
  AudioPresets,
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
  VideoPreset,
  VideoPresets,
  createAudioAnalyser,
  createLocalAudioTrack,
  createLocalVideoTrack,
  type LocalTrack,
  type LocalTrackPublication,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteVideoTrack,
  type TextStreamReader,
  type TrackPublishOptions,
  type VideoTrack,
} from "livekit-client";
import { applyBackground, backgroundOn, stopCamera, type LiveBackground } from "./effects.js";
import {
  HOST_COLOR,
  HOST_IDENTITY,
  LIVE_TOPICS,
  LiveProtocolError,
  PACKET_LIMIT_BYTES,
  decodeMessage,
  destinationsOf,
  encodeText,
  isLiveTopic,
  parseParticipantMetadata,
  senderAllowed,
  type LiveBody,
  type LiveRole,
  type LiveSenderRole,
  type LiveTopic,
} from "./protocol.js";

export type { LiveBackground } from "./effects.js";

export type LiveConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

/** Why the room ended for good. */
export type LiveEndReason =
  /** `disconnect()` was called — only that. */
  | "left"
  /** The host removed this guest. */
  | "removed"
  /** The share ended (the room was deleted). */
  | "ended"
  /** The same identity joined elsewhere (a second host connection replaces the first). */
  | "replaced"
  /** The connection was lost and could not be made again, or LiveKit let it go as the page went away (a reload). */
  | "failed";

export interface LiveParticipant {
  identity: string;
  /**
   * This presence's LiveKit sid. Someone back under the same identity before
   * the room said they left — a reload, a removed guest's refreshed token —
   * has a new one, and is otherwise the same participant to LiveKit's client.
   */
  sid: string;
  name: string;
  role: LiveRole;
  color: string;
  isLocal: boolean;
  micOn: boolean;
  cameraOn: boolean;
  speaking: boolean;
  /** 0..1, as the SFU last reported it. */
  audioLevel: number;
  connection: "excellent" | "good" | "poor" | "lost";
  /** The camera, attachable with `track.attach(videoElement)`; null when off. */
  camera: VideoTrack | null;
}

/** Who sent a message: the participant's identity (null for the server) and role. */
export interface LiveSender {
  identity: string | null;
  role: LiveSenderRole;
}

export interface LiveRoomStats {
  received: number;
  sent: number;
  dropped: number;
  droppedByTopic: Record<string, number>;
}

export interface LiveRoomEvents {
  state: LiveConnectionState;
  participants: LiveParticipant[];
  /** The windows with a picture: published (host) or subscribed (guest). */
  windows: string[];
  disconnected: LiveEndReason;
  /** The browser refused to play remote audio until a gesture; call `startAudio()` from one. */
  audioBlocked: boolean;
  /**
   * My camera or microphone is off though nobody turned it off: after the room joined again from scratch it could
   * not go out again — refused a few times, or stopped while it was not out — and was taken out of the room. Tell
   * the person, as for one that did not come on. (Not said of a microphone that was off.)
   */
  mediaFailed: { kind: LiveLocalMedia["kind"]; error: unknown };
}

export interface LiveConnectOptions {
  /** The LiveKit URL (`wss://…`). */
  url: string;
  token: string;
  role: LiveRole;
  /**
   * A fresh token, for when LiveKit could not resume the connection and the
   * room must join again from scratch (its token may have expired). Without
   * it, such a loss ends the room ("failed").
   */
  refreshToken?: () => Promise<string>;
  /** The lobby's tracks, published as they are on joining. */
  preview?: LivePreview;
  /**
   * The speaker ("audiooutput" device id) the room's sound plays on from its
   * first track, as `switchDevice` would set it later: a guest's choice,
   * kept across visits. One that is gone, or a browser that cannot choose,
   * plays on the default.
   */
  audioOutput?: string;
  /** Base URL of the background segmenter's assets (see effects.ts). */
  effectsAssetPath?: string;
  /**
   * Host: whom it lets in from the moment it joins, as `setReceivers` says
   * from then on — nobody, left out. LiveKit subscribes the room to what is
   * in it as it joins, before `connect` returns: a camera or microphone of
   * anyone else is let go unplayed, and they may subscribe to nothing.
   */
  receivers?: readonly string[];
}

/** My camera or my microphone, and which it is. */
export type LiveLocalMedia = { kind: "camera"; track: LocalVideoTrack } | { kind: "microphone"; track: LocalAudioTrack };

/** Window track names (§3). */
export const windowTrackName = (windowId: string): string => `win:${windowId}`;
export const windowAudioTrackName = (windowId: string): string => `win-audio:${windowId}`;

/** The largest side a window is captured at (§3), for the capture constraints. */
export const WINDOW_CAPTURE_MAX_SIDE = 2560;
export const WINDOW_MAX_FPS = 30;

/** The top layer's bitrate for a window of this size: ≈ 2.5 Mbps at 1080p, by pixels. */
export function windowBitrate(width: number, height: number): number {
  const perPixel = 2_500_000 / (1920 * 1080);
  return Math.round(Math.min(6_000_000, Math.max(250_000, width * height * perPixel)));
}

/**
 * A window track's encodings for its size now: the top layer at
 * `windowBitrate`, and a half-resolution layer at a third of it — a guest
 * showing the window small gets that one.
 */
function windowEncodings(video: MediaStreamTrack): Pick<TrackPublishOptions, "screenShareEncoding" | "screenShareSimulcastLayers"> {
  const settings = video.getSettings();
  const width = settings.width ?? 1280;
  const height = settings.height ?? 720;
  const bitrate = windowBitrate(width, height);
  return {
    screenShareEncoding: { maxBitrate: bitrate, maxFramerate: WINDOW_MAX_FPS },
    screenShareSimulcastLayers: [new VideoPreset(Math.round(width / 2), Math.round(height / 2), Math.round(bitrate / 3), WINDOW_MAX_FPS)],
  };
}

/** A participant whose metadata is not control's: a guest, in grey. */
const FALLBACK_COLOR = "#8B8D98";

/** How long to wait before each attempt to join again after the connection is lost. */
const REJOIN_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];

/**
 * How long to wait before each new try of my camera or microphone when it did not go out again after joining from
 * scratch; past the last, it is taken out of the room (`#publishKept`).
 */
const LOCAL_RETRY_MS = [1_000, 3_000, 8_000];

/** Text streams one sender may have open at once (the host: a sync and a desk frame); more are dropped. */
const STREAM_SLOTS = 2;
/** What every open text stream together may hold: one sync and one desk frame at their largest. */
const STREAM_BUDGET_CHARS = LIVE_TOPICS["lv.sync"].maxBytes + LIVE_TOPICS["lv.desk"].maxBytes;

/**
 * What a guest says that stays — strokes and chat — while it does not know
 * whom to tell (joined, or back from a reconnect, before the host's list):
 * held, and sent once the list comes to the host and the guests on it, so
 * no board or chat misses what the others have. Pointers, pings and
 * reactions are of the moment: they go to the host alone meanwhile.
 */
const HELD_TOPICS: ReadonlySet<LiveTopic> = new Set(["lv.ink", "lv.chat"]);
/** Messages held at most; past it the oldest goes to the host alone, whose board and chat are the room's. */
const HELD_MAX = 256;

const encoder = new TextEncoder();

type Listener<K extends keyof LiveRoomEvents> = (value: LiveRoomEvents[K]) => void;
type MessageHandler = (body: never, from: LiveSender) => void;

interface PublishedWindow {
  video: MediaStreamTrack;
  audio: MediaStreamTrack | null;
  /**
   * LiveKit's tracks for them once published, held rather than their
   * publications: a full reconnect of LiveKit's own (`republishAllTracks`)
   * publishes the same track anew, the old publication letting go of it, so
   * the window's publication is whichever holds its track now.
   */
  videoTrack: LocalVideoTrack | null;
  audioTrack: LocalTrack | null;
}

interface WindowBinding {
  element: HTMLVideoElement;
  track: RemoteVideoTrack | null;
}

/** A guest's message held until it knows whom to tell (`HELD_TOPICS`), as `send` was asked for it. */
interface HeldMessage {
  topic: LiveTopic;
  text: string;
  named: string[] | undefined;
}

/** A camera on its way into the room: the choice it is for, its capture once there is one, and its arrival. */
interface CameraComing {
  ask: number;
  track: LocalVideoTrack | null;
  done: Promise<void>;
}

/** An error inside a caller's handler must not stop the others; surface it without breaking dispatch. */
function report(error: unknown): void {
  if (typeof globalThis.reportError === "function") globalThis.reportError(error);
  else console.error("[live-share]", error);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether my camera or microphone has stopped for good: what it sends (a
 * processor's picture, if it has one) or what it captures from (its
 * `mediaStream`'s track, which a processor never replaces) has ended — a
 * device unplugged, the capture taken away, LiveKit stopping it as a
 * publish timed out. Out, it would send nothing.
 */
function hasEnded(track: LocalTrack): boolean {
  return [track.mediaStreamTrack, ...(track.mediaStream?.getTracks() ?? [])].some((each) => each.readyState === "ended");
}

/** A camera or microphone as LiveKit's own switch asks for it: exactly, the system's ("default") not (`#switchInput`). */
const deviceConstraint = (deviceId: string): ConstrainDOMString => (deviceId === "default" ? deviceId : { exact: deviceId });

/** Read a text stream to its end, keeping nothing. */
async function drain(reader: TextStreamReader): Promise<void> {
  try {
    const chunks = reader[Symbol.asyncIterator]();
    for (let next = await chunks.next(); next.done !== true; next = await chunks.next()) {
      // thrown away as it comes
    }
  } catch {
    // An aborted stream is as gone as a read one.
  }
}

/** A background change a camera did not take (docs/live-share.md §7). */
interface BackgroundRefused {
  /** What the camera shows instead: the background it had, put back on it — or null when nobody can say. */
  shows: LiveBackground | null;
  /** Why: it did not load; null where effects are unsupported. */
  failure: { error: unknown } | null;
}

/**
 * Put `background` on a camera that is on. Null when it is on, and when
 * `current()` says a later change came meanwhile (or the camera went): that
 * one answers. Otherwise what the camera shows instead (`applyBackground`
 * put the one it had back on it).
 */
async function changeBackground(camera: LocalVideoTrack, background: LiveBackground, options: { assetPath?: string }, current: () => boolean): Promise<BackgroundRefused | null> {
  let failure: { error: unknown } | null = null;
  try {
    if (await applyBackground(camera, background, options)) return null;
  } catch (error) {
    failure = { error };
  }
  return current() ? { shows: backgroundOn(camera), failure } : null;
}

export class LiveRoom {
  readonly role: LiveRole;

  readonly #room: Room;
  readonly #url: string;
  readonly #refreshToken: (() => Promise<string>) | null;
  readonly #effectsAssetPath: string | undefined;
  readonly #listeners = new Map<keyof LiveRoomEvents, Set<Listener<keyof LiveRoomEvents>>>();
  readonly #handlers = new Map<LiveTopic, Set<MessageHandler>>();
  readonly #stats: LiveRoomStats = { received: 0, sent: 0, dropped: 0, droppedByTopic: {} };
  /** Host: windows handed to `publishWindow`, kept across a reconnect. */
  readonly #windows = new Map<string, PublishedWindow>();
  /** Per-window chain, so publish/unpublish calls for one window run in order. */
  readonly #windowQueue = new Map<string, Promise<void>>();
  /**
   * My tracks the room took out for good — a window's let go, a camera
   * turned off. LiveKit, putting everything out again in a full reconnect of
   * its own, may still publish one the room let go of meanwhile: it is taken
   * down again as it comes.
   */
  readonly #letGo = new WeakSet<LocalTrack>();
  /** Guest: video elements showing each window, re-attached when its track changes. */
  readonly #bindings = new Map<string, Set<WindowBinding>>();
  /** Remote audio playing, by track sid. */
  readonly #audio = new Map<string, HTMLMediaElement>();
  /** Text streams being read, by sender, and the characters they hold together. */
  readonly #openStreams = new Map<string, number>();
  #streamChars = 0;
  #state: LiveConnectionState = "connecting";
  /** The first connection succeeded: a loss from here on is worth joining again. */
  #joined = false;
  #ended = false;
  #endReason: LiveEndReason | null = null;
  #rejoining = false;
  /**
   * Losses LiveKit gave up on, counted. A loss can come while the room puts
   * its tracks out again after the last: only the latest loss's rejoin says
   * the room is back, or that it is not joining again any more.
   */
  #losses = 0;
  #background: LiveBackground = { kind: "none" };
  /** Background choices made with `setBackground`, counted: a change that fails after a later one came is that one's to answer. */
  #backgroundAsked = 0;
  /** The browser refused to play the room's sound until a gesture. LiveKit says so once, perhaps before anyone listens. */
  #audioBlocked = false;
  /**
   * Camera and microphone tracks, kept to publish again after joining from
   * scratch, as they are then: what is chosen while the room is away is
   * theirs (`setMicrophone`, `#switchInput`). A camera is kept once its
   * background is on it, and only while it is on; a microphone turned off is
   * kept muted, as LiveKit turns one off.
   */
  #localTracks: { camera: LocalVideoTrack | null; microphone: LocalAudioTrack | null } = { camera: null, microphone: null };
  /**
   * The microphone's choices in the room, counted (0: none made here): a
   * lobby capture that comes after one is not wanted, nor a capture or a
   * switch overtaken by a later one.
   */
  #micAsked = 0;
  /**
   * The camera's choices in the room, counted (0: the lobby's, none made
   * here): a camera coming in for one a later choice replaced is stopped,
   * never published.
   */
  #cameraAsked = 0;
  /** The camera coming in now, if one is (`#comeCamera`). */
  #cameraComing: CameraComing | null = null;
  /** The next try of my camera and of my microphone that did not go out again after joining from scratch (`#publishKept`). */
  readonly #retries = new Map<LiveLocalMedia["kind"], ReturnType<typeof setTimeout>>();
  /**
   * The microphone and the camera chosen last here (`#switchInput`), and how
   * many choices each has had: a capture still coming in for the room — on
   * its prompt, a camera behind its background — is put on the device chosen
   * since it was asked for before it goes out, as LiveKit's switch, with
   * nothing published, only notes it for the next capture.
   */
  readonly #inputs: Record<"audioinput" | "videoinput", { id: string; chosen: number }> = {
    audioinput: { id: "default", chosen: 0 },
    videoinput: { id: "default", chosen: 0 },
  };
  /** Host: who may subscribe to its tracks, and whose cameras and microphones it takes (`setReceivers`). */
  #receivers: string[];
  /**
   * Guest: the other guests the host lists (`lv.guests`): whom this room
   * hears, shows and plays. The last list, kept across a reconnect.
   */
  #listed: ReadonlySet<string> = new Set();
  /**
   * Guest: whether `#listed` is the host's word since this room last
   * connected. Until it is — joined, or back from a reconnect — the camera,
   * mic and word go to the host alone: someone the host let out meanwhile
   * may still be on the last list.
   */
  #listFresh = false;
  /** Guest: strokes and chat said while the list is not fresh, sent once it is. */
  #held: HeldMessage[] = [];
  #participantsQueued = false;
  #windowsQueued = false;

  private constructor(room: Room, options: LiveConnectOptions) {
    this.#room = room;
    this.#url = options.url;
    this.#refreshToken = options.refreshToken ?? null;
    this.#effectsAssetPath = options.effectsAssetPath;
    this.role = options.role;
    this.#receivers = [...(options.receivers ?? [])];
  }

  /** My identity in the room (`host`, or `g_<requestId>`). */
  get identity(): string {
    return this.#room.localParticipant.identity;
  }

  /** Join the room. Rejects when the first connection fails (bad token, unreachable server). */
  static async connect(options: LiveConnectOptions): Promise<LiveRoom> {
    const room = new Room({
      // Both ends watch some video small (guests: windows and faces; the
      // host: faces), and both publish layers nobody may watch. A guest
      // asks for the pixels its screen has: at LiveKit's default density a
      // window on a Retina display is sent its half layer and reads soft.
      adaptiveStream: options.role === "guest" ? { pixelDensity: "screen" } : true,
      dynacast: true,
      // Tracks we hand the room (windows, the lobby's camera) are ours to
      // stop, and they must survive a lost connection to be published again.
      stopLocalTrackOnUnpublish: false,
      videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      publishDefaults: { simulcast: true, videoCodec: "vp8", dtx: true, red: true },
      ...(options.audioOutput === undefined ? {} : { audioOutput: { deviceId: options.audioOutput } }),
    });
    const live = new LiveRoom(room, options);
    live.#wire();
    try {
      await room.connect(options.url, options.token, { autoSubscribe: true });
    } catch (error) {
      live.#ended = true;
      await room.disconnect().catch(() => undefined);
      throw error;
    }
    live.#joined = true;
    live.#setState("connected");
    // Who may subscribe goes first: nothing is published before it.
    live.#applyPermissions();
    live.#followTracks();
    // The lobby's microphone and camera, published without waiting on a
    // prompt again; a failure leaves the room usable (the person turns it on again).
    if (options.preview !== undefined) await live.#adopt(options.preview).catch(report);
    live.#queueParticipants();
    return live;
  }

  state(): LiveConnectionState {
    return this.#state;
  }

  /**
   * Why the room ended, or null while it lasts. Kept, so an end that came
   * before anyone listened for "disconnected" (while the camera came back
   * after a reload) is still known.
   */
  endReason(): LiveEndReason | null {
    return this.#endReason;
  }

  stats(): LiveRoomStats {
    return { ...this.#stats, droppedByTopic: { ...this.#stats.droppedByTopic } };
  }

  on<K extends keyof LiveRoomEvents>(event: K, listener: Listener<K>): () => void {
    let set = this.#listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as Listener<keyof LiveRoomEvents>);
    return () => set.delete(listener as Listener<keyof LiveRoomEvents>);
  }

  // -------------------------------------------------------------------------
  // Participants
  // -------------------------------------------------------------------------

  /**
   * Everyone in the room — on a guest's, only those it is with: the host,
   * itself, and the guests the host lists (someone else in the room is
   * nobody's guest here, and is not shown).
   */
  participants(): LiveParticipant[] {
    const local = this.#room.localParticipant;
    const remote = [...this.#room.remoteParticipants.values()].filter((participant) => this.#hears({ identity: participant.identity, role: this.#roleOf(participant) }));
    const everyone: Participant[] = [local, ...remote];
    everyone.sort((a, b) => (a.joinedAt?.getTime() ?? 0) - (b.joinedAt?.getTime() ?? 0));
    const all = everyone.map((participant) => this.#describe(participant, participant === local));
    // The host first, then everyone in join order.
    return [...all.filter((p) => p.role === "host"), ...all.filter((p) => p.role !== "host")];
  }

  /**
   * A participant as shown. Mine is what the room has on — the camera and
   * microphone it keeps, whether or not LiveKit has them out this moment (the
   * room joining again, a try still to come) — so my switches read as I left
   * them, not off for as long as the room is away, and off once one is let go.
   */
  #describe(participant: Participant, isLocal: boolean): LiveParticipant {
    const meta = parseParticipantMetadata(participant.metadata);
    const camera = participant.getTrackPublication(Track.Source.Camera);
    const microphone = this.#localTracks.microphone;
    const cameraTrack = isLocal ? this.#localTracks.camera : camera !== undefined && !camera.isMuted ? (camera.videoTrack ?? null) : null;
    return {
      identity: participant.identity,
      sid: participant.sid,
      name: participant.name !== undefined && participant.name !== "" ? participant.name : participant.identity,
      role: meta?.role ?? (isLocal ? this.role : "guest"),
      color: meta?.color ?? (isLocal && this.role === "host" ? HOST_COLOR : FALLBACK_COLOR),
      isLocal,
      micOn: isLocal ? microphone !== null && !microphone.isMuted : participant.isMicrophoneEnabled,
      cameraOn: cameraTrack !== null,
      speaking: participant.isSpeaking,
      audioLevel: participant.audioLevel,
      connection: connectionOf(participant.connectionQuality),
      camera: cameraTrack,
    };
  }

  /** A remote participant's role as a sender: control's metadata, or a guest when it is unreadable. */
  #roleOf(participant: Participant): LiveRole {
    return parseParticipantMetadata(participant.metadata)?.role ?? "guest";
  }

  /**
   * Whether this room hears a sender (and shows them): the host and the
   * server always; another guest, in a guest's room, once the host lists
   * them. The host's room hears everyone — the host app decides whose word
   * counts, and must hear a newcomer's hello before main lets them in.
   */
  #hears(from: LiveSender): boolean {
    return this.role === "host" || from.role !== "guest" || (from.identity !== null && this.#listed.has(from.identity));
  }

  /** Whether this room takes a guest's tracks: those the host lets in, those a guest's list names. */
  #takesTracksOf(identity: string): boolean {
    if (this.role === "host") return this.#receivers.includes(identity);
    return this.#listed.has(identity);
  }

  /**
   * Who may subscribe to what this side publishes, and whom a guest's
   * messages reach: the host's receivers; a guest's host, and the guests
   * listed while the list is fresh.
   */
  #audience(): string[] {
    if (this.role === "host") return this.#receivers;
    return [HOST_IDENTITY, ...(this.#listFresh ? this.#listed : [])];
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  /**
   * Send a message to everyone, or to `to` only — but a topic §4 addresses
   * to the host alone (a guest's hello, ask, input) goes to the host alone,
   * whatever `to` says (`destinationsOf`), and a guest's goes no further
   * than the host and the guests the host lists: to the host alone while
   * the list is not fresh, strokes and chat held until it is
   * (`HELD_TOPICS`). Nobody left to send to sends nothing — never the empty
   * list LiveKit reads as everyone. Throws `LiveProtocolError` for a topic
   * this role may not send or a body that breaks its schema. Lossy topics
   * are skipped while the connection is down rather than queued.
   */
  async send<T extends LiveTopic>(topic: T, body: LiveBody<T>, options: { to?: string[] } = {}): Promise<void> {
    if (!senderAllowed(topic, this.role)) throw new LiveProtocolError(`a ${this.role} does not send ${topic}`);
    const text = encodeText(topic, body);
    if (this.#state !== "connected" && !LIVE_TOPICS[topic].reliable) return;
    if (this.role === "guest" && !this.#listFresh && HELD_TOPICS.has(topic)) {
      this.#hold({ topic, text, named: options.to });
      return;
    }
    await this.#publish(topic, text, options.to);
  }

  /** A message on its way, to whom `send` would send it now. */
  async #publish(topic: LiveTopic, text: string, named: string[] | undefined): Promise<void> {
    const within = this.role === "guest" ? this.#audience() : undefined;
    const destinationIdentities = destinationsOf(topic, named, within);
    if (destinationIdentities?.length === 0) return;
    const to = destinationIdentities === undefined ? {} : { destinationIdentities };
    const bytes = encoder.encode(text);
    if (bytes.byteLength > PACKET_LIMIT_BYTES) {
      await this.#room.localParticipant.sendText(text, { topic, ...to });
    } else {
      await this.#room.localParticipant.publishData(bytes, { reliable: LIVE_TOPICS[topic].reliable, topic, ...to });
    }
    this.#stats.sent += 1;
  }

  /** Keep a guest's stroke or chat until the list comes; past `HELD_MAX`, the oldest goes to the host alone. */
  #hold(message: HeldMessage): void {
    this.#held.push(message);
    const over = this.#held.length > HELD_MAX ? this.#held.shift() : undefined;
    if (over !== undefined) void this.#publish(over.topic, over.text, over.named).catch(report);
  }

  /** The list came: what was held goes, in the order it was said, before anything said after. */
  #sendHeld(): void {
    const held = this.#held;
    this.#held = [];
    for (const message of held) void this.#publish(message.topic, message.text, message.named).catch(report);
  }

  /** Handle every valid `topic` message from a sender allowed to send it. */
  onMessage<T extends LiveTopic>(topic: T, handler: (body: LiveBody<T>, from: LiveSender) => void): () => void {
    let set = this.#handlers.get(topic);
    if (set === undefined) {
      set = new Set();
      this.#handlers.set(topic, set);
    }
    set.add(handler as MessageHandler);
    return () => set.delete(handler as MessageHandler);
  }

  #receive(topic: string | undefined, data: Uint8Array | string, from: LiveSender): void {
    if (!isLiveTopic(topic)) return;
    const body = this.#hears(from) ? decodeMessage(topic, data, from.role) : null;
    if (body === null) {
      this.#drop(topic);
      return;
    }
    this.#stats.received += 1;
    for (const handler of this.#handlers.get(topic) ?? []) {
      try {
        handler(body as never, from);
      } catch (error) {
        report(error);
      }
    }
  }

  /**
   * A text stream (a body over 12 KB). Kept only from a participant we know
   * and hear whose role may send the topic — judged before a byte is kept —
   * with at most `STREAM_SLOTS` of theirs open at once, up to the topic's
   * limit, and while every open stream together holds under `STREAM_BUDGET_CHARS`.
   * Anything else is read to its end and thrown away: LiveKit queues a
   * stream's chunks whether or not anyone reads them, and cancelling one
   * makes its next chunk throw inside LiveKit, so draining is how it goes.
   */
  async #receiveStream(topic: LiveTopic, reader: TextStreamReader, identity: string): Promise<void> {
    const participant = this.#room.remoteParticipants.get(identity);
    const limit = LIVE_TOPICS[topic].maxBytes;
    const role = participant === undefined ? null : this.#roleOf(participant);
    const declared = reader.info.size;
    const open = this.#openStreams.get(identity) ?? 0;
    if (role === null || !senderAllowed(topic, role) || !this.#hears({ identity, role }) || (declared !== undefined && declared > limit * 4) || open >= STREAM_SLOTS) {
      this.#drop(topic);
      await drain(reader);
      return;
    }
    this.#openStreams.set(identity, open + 1);
    let text = "";
    let kept = true;
    try {
      for await (const chunk of reader) {
        if (!kept) continue;
        if (text.length + chunk.length > limit || this.#streamChars + chunk.length > STREAM_BUDGET_CHARS) {
          kept = false;
          this.#streamChars -= text.length;
          text = "";
          continue;
        }
        text += chunk;
        this.#streamChars += chunk.length;
      }
    } catch {
      kept = false;
    } finally {
      this.#streamChars -= text.length;
      const left = (this.#openStreams.get(identity) ?? 1) - 1;
      if (left > 0) this.#openStreams.set(identity, left);
      else this.#openStreams.delete(identity);
    }
    if (kept) this.#receive(topic, text, { identity, role });
    else this.#drop(topic);
  }

  #drop(topic: string): void {
    this.#stats.dropped += 1;
    this.#stats.droppedByTopic[topic] = (this.#stats.droppedByTopic[topic] ?? 0) + 1;
  }

  // -------------------------------------------------------------------------
  // Local media
  // -------------------------------------------------------------------------

  /**
   * Turn my microphone on (on `deviceId`, or switch to it) or off: muted, as
   * LiveKit turns one off. LiveKit turns on or off only a microphone it has
   * published, and has none while the room joins again from scratch: its
   * own switch would leave the kept one as it was — to go out again live
   * once the room is back, though it was turned off — or capture a second
   * and publish it before the room says who may have it. So a kept
   * microphone LiveKit has not published takes the choice itself (muted or
   * not, on the device chosen) and goes out as it is then (`#publishLocal`;
   * with the room here, an on sends it). An on with none kept is captured
   * here too, never by LiveKit's own switch, whose off waits for that
   * capture and its publish and then mutes what went out live (past ten
   * seconds on a permission prompt it stops waiting, and leaves it live).
   * Captured here, it goes out only if no later choice came meanwhile (one
   * turned off as it is published goes out muted), on the microphone chosen
   * last (one chosen on its prompt included: `#putMicrophone`), and while
   * the room joins again, with the rest. "default" is the system's
   * microphone (`#switchInput`).
   */
  async setMicrophone(on: boolean, deviceId?: string): Promise<void> {
    const ask = (this.#micAsked += 1);
    const local = this.#room.localParticipant;
    const options = { ...(deviceId === undefined ? {} : { deviceId }), echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const kept = this.#localTracks.microphone;
    if (kept !== null && !this.#isOut(kept)) {
      if (on && deviceId !== undefined) await this.#switchInput("audioinput", deviceId);
      // A later choice made while it switched answers.
      if (ask !== this.#micAsked) return;
      await (on ? kept.unmute() : kept.mute());
      // With the room here, kept but not out is on its way (LiveKit waits for that publish and gives it back) or
      // did not make it (a publish that failed).
      if (on && this.#canPublish()) await this.#publishMicrophone(kept, () => ask === this.#micAsked);
    } else if (on && kept === null) {
      // Captured as LiveKit's own `setMicrophoneEnabled` would, not published.
      const chosen = this.#inputs.audioinput.chosen;
      const track = (await local.createTracks({ audio: options }))[0] as LocalAudioTrack;
      await this.#putMicrophone(track, () => ask === this.#micAsked && !this.#ended, chosen);
    } else {
      // Switched first: muted, it takes the device as it comes on, so not a moment of the one it had goes out.
      if (on && deviceId !== undefined && this.#room.getActiveDevice("audioinput") !== deviceId) {
        await this.#switchInput("audioinput", deviceId);
        if (ask !== this.#micAsked) return;
      }
      await local.setMicrophoneEnabled(on, options);
    }
    this.#queueParticipants();
  }

  /**
   * Turn my camera on (on `deviceId`, or switch to it; "default" is the
   * system's) or off. On, it is captured and published behind the
   * background (`#putCamera`): rejects, the camera left off, when the
   * capture is refused or the background cannot be put on. Asked on again
   * while it comes, it is that camera, not a second capture — put on the
   * device named, if one is, before it goes out. Off, it is unpublished and
   * stopped, one still coming too (its light goes out at once).
   */
  async setCamera(on: boolean, deviceId?: string): Promise<void> {
    const coming = this.#cameraComing;
    if (on && coming !== null && coming.ask === this.#cameraAsked) {
      if (deviceId !== undefined) await this.#switchInput("videoinput", deviceId);
      await coming.done;
      return;
    }
    const ask = (this.#cameraAsked += 1);
    if (!on) {
      if (coming?.track) stopCamera(coming.track);
      await this.#dropCamera();
    } else if (this.#localTracks.camera !== null) {
      // (Its processor restarts on the new capture before LiveKit hands that to the sender.)
      if (deviceId !== undefined && this.#room.getActiveDevice("videoinput") !== deviceId) await this.#switchInput("videoinput", deviceId);
    } else {
      // Captured as LiveKit's own `setCameraEnabled` would (the room's capture defaults, a device switched to while off), not published.
      const chosen = this.#inputs.videoinput.chosen;
      const capture = this.#room.localParticipant
        .createTracks({ video: { ...(deviceId === undefined ? {} : { deviceId }), resolution: VideoPresets.h720.resolution } })
        .then(([track]) => track as LocalVideoTrack);
      await this.#comeCamera(ask, chosen, capture);
    }
    this.#queueParticipants();
  }

  /**
   * The background behind my camera, now and whenever it comes on: a camera
   * still coming in goes out behind the one chosen last. On a camera that is
   * out, one that cannot be put on — false where effects are unsupported, a
   * rejection when it did not load — gives way to the one the camera had,
   * which the effects put back on it and which is my choice again
   * (`background()`); a camera nobody can say that of any more leaves the
   * room. A change failing after a later one came is let go (true): the
   * later one answers.
   */
  async setBackground(background: LiveBackground): Promise<boolean> {
    const ask = (this.#backgroundAsked += 1);
    this.#background = background;
    const camera = this.#localTracks.camera;
    if (camera === null) return true;
    const refused = await changeBackground(camera, background, this.#effectOptions(), () => ask === this.#backgroundAsked && this.#localTracks.camera === camera);
    if (refused === null) return true;
    if (refused.shows !== null) {
      this.#background = refused.shows;
    } else {
      await this.#dropCamera();
      this.#queueParticipants();
    }
    if (refused.failure !== null) throw refused.failure.error;
    return false;
  }

  background(): LiveBackground {
    return this.#background;
  }

  /** My camera track (for a self view), or null when it is off. */
  localCamera(): LocalVideoTrack | null {
    const publication = this.#room.localParticipant.getTrackPublication(Track.Source.Camera);
    const track = publication?.track;
    return track instanceof LocalVideoTrack && !publication?.isMuted ? track : null;
  }

  devices(kind: MediaDeviceKind): Promise<MediaDeviceInfo[]> {
    return Room.getLocalDevices(kind);
  }

  /** Use another camera, microphone or speaker ("audiooutput") from now on; "default" is the system's. */
  async switchDevice(kind: MediaDeviceKind, deviceId: string): Promise<void> {
    if (kind === "audioinput" || kind === "videoinput") await this.#switchInput(kind, deviceId);
    else await this.#room.switchActiveDevice(kind, deviceId);
  }

  /**
   * Use another camera or microphone. LiveKit switches the ones it has
   * published, and only records the choice for the next capture otherwise:
   * a kept one it has not published — the room joining again from scratch,
   * or about to publish it again — is switched here, or it would go out
   * again on the device it had; and one still coming in — on its prompt, a
   * camera behind its background — is put on it before it goes out
   * (`#inputs`). The system's ("default") is asked for as LiveKit asks when
   * none is named, not exactly: no camera has that id (probed in Chromium),
   * and LiveKit stops a camera before it captures the next, so an exact
   * "default" would leave the camera out dark.
   */
  async #switchInput(kind: "audioinput" | "videoinput", deviceId: string): Promise<void> {
    // Noted first: a capture that lands while LiveKit switches goes out on it.
    const input = this.#inputs[kind];
    input.id = deviceId;
    input.chosen += 1;
    await this.#room.switchActiveDevice(kind, deviceId, deviceId !== "default");
    const kept = kind === "audioinput" ? this.#localTracks.microphone : this.#localTracks.camera;
    if (kept !== null && !this.#isOut(kept)) await kept.setDeviceId(deviceConstraint(deviceId));
  }

  /** Whether LiveKit has `track`, my camera or microphone, published now: none while the room joins again from scratch. */
  #isOut(track: LocalVideoTrack | LocalAudioTrack): boolean {
    const source = track.kind === Track.Kind.Audio ? Track.Source.Microphone : Track.Source.Camera;
    return this.#room.localParticipant.getTrackPublication(source)?.track === track;
  }

  /** Whether the browser refuses to play the room's sound until a gesture: kept, for a page that listens only once it has joined. */
  audioBlocked(): boolean {
    return this.#audioBlocked;
  }

  /** Start remote audio from a user gesture after the browser blocked it. */
  async startAudio(): Promise<void> {
    await this.#room.startAudio();
  }

  /** Hear a participant's voice at `volume` (0..1) here only — the host muting a guest for themself; others still hear them. */
  setParticipantVolume(identity: string, volume: number): void {
    this.#room.remoteParticipants.get(identity)?.setVolume(Math.min(1, Math.max(0, volume)));
  }

  #effectOptions(): { assetPath?: string } {
    return this.#effectsAssetPath === undefined ? {} : { assetPath: this.#effectsAssetPath };
  }

  /**
   * Take the lobby's tracks as mine, and the ones it is still waiting for
   * (`#adoptLate`). Its camera comes in as any does, behind the background,
   * and is not waited for: a background still loading holds up the camera,
   * not the join. The lobby stays up until the join is done — the
   * microphone's publish can take a while — and from now on its switches,
   * devices and background are mine, and it shows what I have on.
   */
  async #adopt(preview: LivePreview): Promise<void> {
    const { camera, microphone, background } = preview.handOver({
      late: (late) => void this.#adoptLate(late).catch(report),
      setCamera: (on, deviceId) => this.setCamera(on, deviceId),
      setMicrophone: (on, deviceId) => this.setMicrophone(on, deviceId),
      setBackground: (chosen) => this.setBackground(chosen),
      background: () => this.#background,
      media: () => this.#ownMedia(),
    });
    this.#background = background;
    // (Asked for in the lobby, before any device was chosen here.)
    if (camera !== null) void this.#comeCamera(this.#cameraAsked, 0, camera).catch(report);
    if (microphone !== null) {
      this.#keepLocal("microphone", microphone);
      await this.#publishMicrophone(microphone, () => this.#micAsked === 0);
    }
  }

  /**
   * A lobby capture that came after joining (its permission prompt answered
   * late): the room's, as the lobby's tracks are, on the device chosen here
   * meanwhile — unless the room has ended, or the person has turned that
   * device on or off in it since, the later choice. Then it is stopped:
   * nobody else holds it, and a camera left running would stay on after
   * leaving.
   */
  async #adoptLate(late: LiveLocalMedia): Promise<void> {
    const chosen = (late.kind === "camera" ? this.#cameraAsked : this.#micAsked) > 0;
    if (this.#ended || chosen) {
      late.track.stop();
      return;
    }
    // (Asked for in the lobby, before any device was chosen here.)
    if (late.kind === "camera") {
      await this.#comeCamera(this.#cameraAsked, 0, late.track);
      return;
    }
    await this.#putMicrophone(late.track, () => this.#micAsked === 0 && !this.#ended, 0);
    this.#queueParticipants();
  }

  /**
   * My camera — kept, or coming in for the choice that stands — and my
   * microphone unless it is off (muted): what the lobby shows while the room
   * joins.
   */
  #ownMedia(): { camera: LocalVideoTrack | null; microphone: LocalAudioTrack | null } {
    const coming = this.#cameraComing;
    const microphone = this.#localTracks.microphone;
    return {
      camera: this.#localTracks.camera ?? (coming !== null && coming.ask === this.#cameraAsked ? coming.track : null),
      microphone: microphone !== null && !microphone.isMuted ? microphone : null,
    };
  }

  /**
   * Bring a microphone captured for the room in (`chosen`: how many choices
   * of device there had been when it was asked for): put on the one chosen
   * since, if one was, then kept and published (while the room joins again
   * from scratch, `#republish` publishes it). One no longer `wanted` is
   * stopped, quietly; one that cannot be put on that device, stopped.
   */
  async #putMicrophone(track: LocalAudioTrack, wanted: () => boolean, chosen: number): Promise<void> {
    let on = chosen;
    try {
      while (wanted() && on !== this.#inputs.audioinput.chosen) {
        const input = this.#inputs.audioinput;
        on = input.chosen;
        await track.setDeviceId(deviceConstraint(input.id));
      }
    } catch (error) {
      track.stop();
      if (wanted()) throw error;
      return;
    }
    if (!wanted()) {
      track.stop();
      return;
    }
    this.#keepLocal("microphone", track);
    if (this.#canPublish()) await this.#publishMicrophone(track, wanted);
  }

  /**
   * Publish my microphone, the room here. One that does not go out is off,
   * as whoever asked for it is told: muted, as LiveKit turns one off — unless
   * a later choice came meanwhile, which answers — so nothing puts it out
   * live after (a try of the room's after joining from scratch, the next
   * rejoin) while its switch reads off.
   */
  async #publishMicrophone(track: LocalAudioTrack, current: () => boolean): Promise<void> {
    try {
      await this.#publishMedia({ kind: "microphone", track });
    } catch (error) {
      if (current()) await track.mute();
      throw error;
    }
  }

  /** A camera coming in for the `ask`th choice (`#putCamera`; `chosen` as there), the one coming while it does. */
  #comeCamera(ask: number, chosen: number, capture: Promise<LocalVideoTrack> | LocalVideoTrack): Promise<void> {
    const coming: CameraComing = { ask, track: null, done: Promise.resolve() };
    coming.done = Promise.resolve(capture).then((track) => {
      coming.track = track;
      return this.#putCamera(track, () => ask === this.#cameraAsked && !this.#ended, chosen);
    });
    this.#cameraComing = coming;
    const gone = (): void => {
      if (this.#cameraComing === coming) this.#cameraComing = null;
    };
    coming.done.then(gone, gone);
    return coming.done;
  }

  /**
   * Bring a camera into the room behind the background: the background is
   * put on it first — the one chosen last, whatever is chosen while it loads
   * — and only then is it kept and published, so not a frame of what the
   * background hides goes out. So is the device: a camera chosen since this
   * one was asked for (`chosen`: how many choices there had been then),
   * while it loads included, is the one it goes out on. When the background
   * cannot be put on (it did not load, effects are unsupported), or the
   * camera cannot be put on that device, it is stopped, nothing is
   * published, and this rejects. A camera no longer `wanted` (turned off,
   * chosen again, the room ended) is stopped, quietly.
   */
  async #putCamera(track: LocalVideoTrack, wanted: () => boolean, chosen: number): Promise<void> {
    try {
      let on = chosen;
      let put: LiveBackground | null = null;
      while (wanted()) {
        const input = this.#inputs.videoinput;
        if (on !== input.chosen) {
          // (Its background, once on, restarts on the new capture.)
          on = input.chosen;
          await track.setDeviceId(deviceConstraint(input.id));
          continue;
        }
        const background = this.#background;
        if (background === put) break;
        if (!(await applyBackground(track, background, this.#effectOptions()))) throw new Error("camera backgrounds are not supported here");
        put = background;
      }
    } catch (error) {
      stopCamera(track);
      if (wanted()) throw error;
      return;
    }
    if (!wanted()) {
      stopCamera(track);
      return;
    }
    this.#keepLocal("camera", track);
    // While the room joins again from scratch, `#republish` publishes it.
    if (this.#canPublish()) {
      try {
        await this.#publishMedia({ kind: "camera", track });
      } catch (error) {
        // Turned off while it went out: gone already.
        if (this.#localTracks.camera !== track) return;
        this.#localTracks.camera = null;
        stopCamera(track);
        throw error;
      }
    }
    this.#queueParticipants();
  }

  /** My camera out of the room: stopped first, so its light and its frames end at once, then unpublished. */
  async #dropCamera(): Promise<void> {
    const camera = this.#localTracks.camera;
    if (camera === null) return;
    this.#localTracks.camera = null;
    this.#letGo.add(camera);
    stopCamera(camera);
    // (LiveKit waits for a publish still under way before it unpublishes.)
    await this.#room.localParticipant.unpublishTrack(camera, false).catch(report);
  }

  /**
   * Publish my camera and microphone tracks again after joining from
   * scratch, each as it is when it goes: what was chosen while the room was
   * away is the kept tracks' own — a camera turned off is kept no more, a
   * microphone turned off is muted (and goes out so), each on the device
   * chosen last, the camera behind the background chosen last. Each on its
   * own: one that does not go holds up nothing else (`#publishKept`).
   */
  async #publishLocal(): Promise<void> {
    await this.#publishKept("camera", 0);
    // Read once the camera has gone, or not: one taken in its place meanwhile (a lobby's late capture) is the one.
    await this.#publishKept("microphone", 0);
  }

  /**
   * My kept camera or microphone out again after joining from scratch. One
   * that does not go is tried again (`LOCAL_RETRY_MS`) while it is still the
   * one kept, not out, and the room here — away again, the room publishes it
   * as it joins. Failing every time, it is taken out of the room
   * (`#takeOut`). Left kept, it would be off to its switch with its light
   * on, an on would find it there and send nothing, and the next rejoin
   * would put it out unasked. One that stopped under the room — its capture
   * ended while the room was away, or LiveKit stopped it as its publish
   * timed out — is never sent: it would go out dark or silent, reading as
   * on. It is taken out at once.
   */
  async #publishKept(kind: LiveLocalMedia["kind"], tries: number): Promise<void> {
    const media = this.#kept(kind);
    if (media === null || this.#isOut(media.track) || !this.#canPublish()) return;
    if (hasEnded(media.track)) {
      this.#takeOut(media, new Error(`the ${kind} stopped while it was not out`));
      return;
    }
    try {
      await this.#publishMedia(media);
    } catch (error) {
      // Turned off, replaced, or out meanwhile (the person's own on sent it), or the room away again: not this try's.
      if (this.#localTracks[kind] !== media.track || this.#isOut(media.track) || !this.#canPublish()) return;
      report(error);
      const delay = LOCAL_RETRY_MS[tries];
      if (delay === undefined) {
        this.#takeOut(media, error);
        return;
      }
      clearTimeout(this.#retries.get(kind));
      this.#retries.set(kind, setTimeout(() => void this.#publishKept(kind, tries + 1), delay));
    }
  }

  /**
   * My kept camera or microphone that cannot go out again, taken out of the
   * room as one whose publish fails as it comes on: stopped, kept no more,
   * and the person told (`mediaFailed`) — but not of a microphone that was
   * off (muted), which they are not missing.
   */
  #takeOut(media: LiveLocalMedia, error: unknown): void {
    this.#localTracks[media.kind] = null;
    if (media.kind === "camera") stopCamera(media.track);
    else media.track.stop();
    if (media.kind === "camera" || !media.track.isMuted) this.#emit("mediaFailed", { kind: media.kind, error });
    this.#queueParticipants();
  }

  #kept(kind: LiveLocalMedia["kind"]): LiveLocalMedia | null {
    const { camera, microphone } = this.#localTracks;
    if (kind === "camera") return camera === null ? null : { kind, track: camera };
    return microphone === null ? null : { kind, track: microphone };
  }

  #stopRetries(): void {
    for (const retry of this.#retries.values()) clearTimeout(retry);
    this.#retries.clear();
  }

  #publishMedia(media: LiveLocalMedia): Promise<LocalTrackPublication> {
    const local = this.#room.localParticipant;
    return media.kind === "camera"
      ? local.publishTrack(media.track, { source: Track.Source.Camera, simulcast: true })
      : local.publishTrack(media.track, { source: Track.Source.Microphone });
  }

  /**
   * Let only these participants subscribe to what the host publishes — its
   * windows, camera and microphone — whoever else is in the room: LiveKit
   * does not revoke a removed guest's token, so they can be back in it, and
   * would otherwise be sent every picture until shown out again. Given to
   * `connect`, so it holds before anything is subscribed to or published,
   * and set again whenever the list changes; kept across a reconnect
   * (LiveKit sends it again after resuming, and the room after joining from
   * scratch). The host's room takes only their cameras and microphones too:
   * nobody else's is played on the Mac. Host only.
   */
  setReceivers(identities: readonly string[]): void {
    this.#assertHost("setReceivers");
    this.#receivers = [...identities];
    this.#applyPermissions();
    this.#followTracks();
  }

  /**
   * A guest's list from the host (`lv.guests`): the guests it is with from
   * now on — they may subscribe to it, are sent its word (what was held
   * first) and are heard; the rest are not.
   */
  #takeList(guests: readonly string[]): void {
    this.#listed = new Set(guests.filter((identity) => identity !== this.identity));
    this.#listFresh = true;
    this.#applyPermissions();
    this.#followTracks();
    this.#sendHeld();
    this.#queueParticipants();
  }

  /**
   * Back from a reconnect, a guest knows nobody but the host until a fresh
   * list comes (the page asks for the room again, and the host's answer
   * brings one): whoever the host let out meanwhile may be on the last.
   * LiveKit sends the permissions again as it resumes.
   */
  #listStale(): void {
    if (this.role !== "guest" || !this.#listFresh) return;
    this.#listFresh = false;
    this.#applyPermissions();
  }

  /** Let only `#audience` subscribe to what this side publishes. */
  #applyPermissions(): void {
    this.#room.localParticipant.setTrackSubscriptionPermissions(
      false,
      this.#audience().map((identity) => ({ participantIdentity: identity, allowAll: true })),
    );
  }

  /**
   * Subscribe to a guest's tracks only while this room takes them
   * (`#takesTracksOf`), so nobody else's camera is shown or voice played.
   * LiveKit subscribes to whatever is published as it comes; this lets go
   * of what it should not have and asks again for what it may.
   */
  #followTracks(): void {
    for (const participant of this.#room.remoteParticipants.values()) {
      if (this.#roleOf(participant) !== "guest") continue;
      const wanted = this.#takesTracksOf(participant.identity);
      for (const publication of participant.trackPublications.values()) {
        if (publication.isDesired !== wanted) publication.setSubscribed(wanted);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Window tracks: host
  // -------------------------------------------------------------------------

  /**
   * Stream a window: its video as `win:<id>` and, while given, its sound as
   * `win-audio:<id>`. Calling again with other tracks publishes them afresh
   * (guests lose the picture for a moment: use `replaceWindowTrack` for a
   * window streaming now); the same ones change nothing. `audio: null` stops
   * publishing the sound.
   */
  publishWindow(windowId: string, video: MediaStreamTrack, audio: MediaStreamTrack | null = null): Promise<void> {
    this.#assertHost("publishWindow");
    return this.#serial(windowId, () => this.#putWindow(windowId, video, audio));
  }

  /**
   * Give a streamed window a new picture without unpublishing it: `video` is
   * a fresh capture of the window (its page replaced, or captured again), or
   * the same track after `applyConstraints` gave it a new size. The
   * publication stays, so guests keep their subscription and their video
   * never goes blank: the track is swapped on the sender
   * (`LocalTrack.replaceTrack`), simulcast kept, and the bitrate and the
   * half-size layer follow the new size in place (LiveKit recomputes the
   * sender's encodings from the track's publish options, set here for that
   * size). A window not streamed yet, or not out now (the room joining
   * again, LiveKit's own publish of it again still to come), is published as
   * `publishWindow(windowId, video)` would, its sound kept. Host only; the
   * caller owns both tracks (the one replaced is not stopped).
   */
  replaceWindowTrack(windowId: string, video: MediaStreamTrack): Promise<void> {
    this.#assertHost("replaceWindowTrack");
    return this.#serial(windowId, async () => {
      const entry = this.#windows.get(windowId);
      const published = entry?.videoTrack ?? null;
      const publication = this.#publicationOf(published);
      if (entry === undefined || published === null || publication === undefined) {
        await this.#putWindow(windowId, video, entry?.audio ?? null);
        return;
      }
      entry.video = video;
      // LiveKit reads the track's options as it sets the sender for the new size,
      // and the publication's as it publishes again after a full reconnect.
      const options = { ...published.publishOptions, ...windowEncodings(video) };
      published.publishOptions = options;
      publication.options = options;
      try {
        await published.replaceTrack(video, { userProvidedTrack: true });
      } catch (error) {
        // The sender went from under it (the connection dropping): publish afresh. The old publication is gone
        // first, so a publish that fails too leaves the window with none, and the caller's next ask, of the
        // same track, publishes it.
        report(error);
        await this.#unpublish(published);
        entry.videoTrack = null;
        if (this.#canPublish()) entry.videoTrack = await this.#publishWindowVideo(windowId, video);
        this.#queueWindows();
      }
    });
  }

  /** Stop streaming a window (its tracks are the caller's to stop). */
  unpublishWindow(windowId: string): Promise<void> {
    this.#assertHost("unpublishWindow");
    return this.#serial(windowId, async () => {
      const entry = this.#windows.get(windowId);
      if (entry === undefined) return;
      this.#windows.delete(windowId);
      await this.#unpublish(entry.videoTrack);
      await this.#unpublish(entry.audioTrack);
      this.#queueWindows();
    });
  }

  publishedWindows(): string[] {
    return [...this.#windows.keys()];
  }

  /** `publishWindow`'s work, in the window's turn. */
  async #putWindow(windowId: string, video: MediaStreamTrack, audio: MediaStreamTrack | null): Promise<void> {
    const entry = this.#windows.get(windowId) ?? { video, audio: null, videoTrack: null, audioTrack: null };
    this.#windows.set(windowId, entry);
    // The same tracks change nothing while they are out: one LiveKit failed to publish again in its own full
    // reconnect, or has yet to, goes out afresh.
    if (entry.video !== video || this.#publicationOf(entry.videoTrack) === undefined) {
      await this.#unpublish(entry.videoTrack);
      entry.video = video;
      entry.videoTrack = null;
      if (this.#canPublish()) entry.videoTrack = await this.#publishWindowVideo(windowId, video);
    }
    if (entry.audio !== audio || (audio !== null && this.#publicationOf(entry.audioTrack) === undefined)) {
      await this.#unpublish(entry.audioTrack);
      entry.audio = audio;
      entry.audioTrack = null;
      if (audio !== null && this.#canPublish()) entry.audioTrack = await this.#publishWindowAudio(windowId, audio);
    }
    this.#queueWindows();
  }

  /**
   * Encoded in software on the Mac (OpenH264), whatever is asked here: the
   * SFU forwards only the H.264 its answer puts first, Constrained Baseline,
   * and Chromium never gives that profile to macOS's hardware encoder (which
   * it uses for Baseline, Main and High). A window sent in High gets
   * VideoToolbox, but the SFU drops every packet of it (probed in Electron 43
   * with livekit-server 1.13; docs/live-share.md §3). No `contentHint`:
   * "detail" puts OpenH264 in its screen-content mode (6–17 fps for a
   * repainting 2560-px page). `maintain-resolution` is what keeps text sharp
   * when the encoder must give something up.
   */
  async #publishWindowVideo(windowId: string, video: MediaStreamTrack): Promise<LocalVideoTrack | null> {
    const publication = await this.#room.localParticipant.publishTrack(video, {
      name: windowTrackName(windowId),
      source: Track.Source.ScreenShare,
      videoCodec: "h264",
      backupCodec: false,
      simulcast: true,
      ...windowEncodings(video),
      degradationPreference: "maintain-resolution",
    });
    return publication.videoTrack ?? null;
  }

  async #publishWindowAudio(windowId: string, audio: MediaStreamTrack): Promise<LocalTrack | null> {
    const publication = await this.#room.localParticipant.publishTrack(audio, {
      name: windowAudioTrackName(windowId),
      source: Track.Source.ScreenShareAudio,
      audioPreset: AudioPresets.music,
      dtx: false,
      red: false,
    });
    return publication.track ?? null;
  }

  /**
   * Take a window's track out for good. LiveKit unpublishes whichever
   * publication holds it now, waiting for one on its way out. Never stopped:
   * the window's capture is the caller's.
   */
  async #unpublish(track: LocalTrack | null): Promise<void> {
    if (track === null) return;
    this.#letGo.add(track);
    await this.#room.localParticipant.unpublishTrack(track, false).catch(report);
  }

  /** LiveKit's publication of my `track` now, if it has it out. */
  #publicationOf(track: LocalTrack | null): LocalTrackPublication | undefined {
    if (track === null) return undefined;
    for (const publication of this.#room.localParticipant.trackPublications.values()) {
      if (publication.track === track) return publication;
    }
    return undefined;
  }

  /**
   * While LiveKit resumes on its own, publishing waits for it; while the room
   * joins again from scratch, `#republish` publishes what was asked for.
   */
  #canPublish(): boolean {
    return this.#joined && !this.#rejoining && !this.#ended;
  }

  #serial(windowId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.#windowQueue.get(windowId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.#windowQueue.set(windowId, next);
    void next.finally(() => {
      if (this.#windowQueue.get(windowId) === next) this.#windowQueue.delete(windowId);
    }).catch(() => undefined);
    return next;
  }

  #assertHost(method: string): void {
    if (this.role !== "host") throw new LiveProtocolError(`${method} is the host's`);
  }

  // -------------------------------------------------------------------------
  // Window tracks: guest
  // -------------------------------------------------------------------------

  /** The host's subscribed video for a window, or null. */
  windowTrack(windowId: string): RemoteVideoTrack | null {
    const publication = this.#windowPublication(windowId);
    const track = publication?.videoTrack;
    return track !== undefined && publication?.isSubscribed === true ? (track as RemoteVideoTrack) : null;
  }

  /** Show a window's video in `element` now and whenever its track (re)appears; returns detach. */
  attachWindow(windowId: string, element: HTMLVideoElement): () => void {
    const binding: WindowBinding = { element, track: null };
    let set = this.#bindings.get(windowId);
    if (set === undefined) {
      set = new Set();
      this.#bindings.set(windowId, set);
    }
    set.add(binding);
    this.#bind(binding, this.windowTrack(windowId));
    return () => {
      binding.track?.detach(element);
      binding.track = null;
      set.delete(binding);
      if (set.size === 0) this.#bindings.delete(windowId);
    };
  }

  #bind(binding: WindowBinding, track: RemoteVideoTrack | null): void {
    if (binding.track === track) return;
    binding.track?.detach(binding.element);
    binding.track = track;
    track?.attach(binding.element);
  }

  #rebind(windowId: string): void {
    const track = this.windowTrack(windowId);
    for (const binding of this.#bindings.get(windowId) ?? []) this.#bind(binding, track);
  }

  /**
   * The host's publication of a window. A window captured afresh (at a new
   * size, or its page replaced) is published again, and its new publication
   * can be subscribed while the old one is still listed beside it: the one
   * subscribed, the latest first, is the window's — never the first by name.
   */
  #windowPublication(windowId: string): RemoteTrackPublication | undefined {
    const name = windowTrackName(windowId);
    let found: RemoteTrackPublication | undefined;
    for (const participant of this.#room.remoteParticipants.values()) {
      if (this.#roleOf(participant) !== "host") continue;
      for (const publication of participant.trackPublications.values()) {
        if (publication.trackName !== name) continue;
        if (found === undefined || !found.isSubscribed || publication.isSubscribed) found = publication;
      }
    }
    return found;
  }

  /** Window ids with a picture now. */
  #windowIds(): string[] {
    if (this.role === "host") return this.publishedWindows();
    const ids = new Set<string>();
    for (const participant of this.#room.remoteParticipants.values()) {
      if (this.#roleOf(participant) !== "host") continue;
      for (const publication of participant.trackPublications.values()) {
        const id = windowIdOf(publication.trackName);
        if (id !== null && publication.isSubscribed && publication.videoTrack !== undefined) ids.add(id);
      }
    }
    return [...ids];
  }

  // -------------------------------------------------------------------------
  // Leaving
  // -------------------------------------------------------------------------

  /** Leave the room for good. */
  async disconnect(): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    for (const entry of this.#windows.values()) {
      await this.#unpublish(entry.videoTrack);
      await this.#unpublish(entry.audioTrack);
    }
    this.#windows.clear();
    await this.#room.disconnect(false).catch(report);
    this.#stopLocalTracks();
    this.#finish("left");
  }

  #stopLocalTracks(): void {
    if (this.#cameraComing?.track) stopCamera(this.#cameraComing.track);
    if (this.#localTracks.camera !== null) stopCamera(this.#localTracks.camera);
    this.#localTracks.microphone?.stop();
    this.#localTracks = { camera: null, microphone: null };
  }

  #finish(reason: LiveEndReason): void {
    this.#ended = true;
    this.#endReason = reason;
    this.#held = [];
    this.#stopRetries();
    for (const element of this.#audio.values()) element.remove();
    this.#audio.clear();
    for (const [windowId, set] of this.#bindings) {
      for (const binding of set) this.#bind(binding, null);
      this.#bindings.delete(windowId);
    }
    this.#setState("disconnected");
    this.#emit("disconnected", reason);
  }

  /** LiveKit gave up on the connection: end, or join again with a fresh token. */
  async #lost(reason: DisconnectReason | undefined): Promise<void> {
    if (!this.#joined || this.#ended || this.#rejoining) return;
    const terminal = endReasonOf(reason);
    if (terminal !== null || this.#refreshToken === null) {
      this.#stopLocalTracks();
      this.#finish(terminal ?? "failed");
      return;
    }
    const loss = (this.#losses += 1);
    this.#rejoining = true;
    this.#setState("reconnecting");
    // A new presence: a guest knows nobody but the host again until a fresh list comes.
    this.#listFresh = false;
    // LiveKit unpublished everything; what was published goes again once joined (a camera or microphone still to be
    // tried again too, its tries afresh).
    this.#stopRetries();
    for (const entry of this.#windows.values()) {
      entry.videoTrack = null;
      entry.audioTrack = null;
    }
    try {
      for (const delay of REJOIN_DELAYS_MS) {
        await sleep(delay);
        if (this.#ended) return;
        try {
          const token = await this.#refreshToken();
          if (this.#ended) return;
          await this.#room.connect(this.#url, token, { autoSubscribe: true });
        } catch {
          continue; // try again after the next delay
        }
        this.#rejoining = false;
        // Who may receive goes first: nothing is published again before it.
        this.#applyPermissions();
        this.#followTracks();
        // Joined: a track that fails to go out again is reported (and tried again), not a reason to join again.
        await this.#republish().catch(report);
        // Lost again as it went out: that loss's rejoin has the room now, and says when it is back.
        if (loss !== this.#losses) return;
        this.#setState("connected");
        this.#queueParticipants();
        this.#queueWindows();
        return;
      }
      this.#stopLocalTracks();
      this.#finish("failed");
    } finally {
      if (loss === this.#losses) this.#rejoining = false;
    }
  }

  /**
   * After joining from scratch: my camera, microphone and windows as they
   * were, each on its own — one that does not go out holds up none of the
   * others. A window that does not is reported: the host app asks for every
   * window's picture again once the room is back, and goes on asking for one
   * it refuses (docs/live-share.md §6.3).
   */
  async #republish(): Promise<void> {
    await this.#publishLocal();
    await Promise.all(
      [...this.#windows.keys()].map((windowId) =>
        this.#serial(windowId, async () => {
          // A `publishWindow` since joining may have published it already; lost again meanwhile, the next rejoin will.
          const entry = this.#windows.get(windowId);
          if (entry === undefined || !this.#canPublish()) return;
          entry.videoTrack ??= await this.#publishWindowVideo(windowId, entry.video);
          if (entry.audio !== null) entry.audioTrack ??= await this.#publishWindowAudio(windowId, entry.audio);
        }).catch(report),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  #wire(): void {
    const room = this.#room;
    room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      // No participant: the server (control through LiveKit's API).
      const from: LiveSender = participant === undefined ? { identity: null, role: "server" } : { identity: participant.identity, role: this.#roleOf(participant) };
      this.#receive(topic, payload, from);
    });
    for (const topic of Object.keys(LIVE_TOPICS) as LiveTopic[]) {
      room.registerTextStreamHandler(topic, (reader, { identity }) => {
        void this.#receiveStream(topic, reader, identity);
      });
    }

    if (this.role === "guest") this.onMessage("lv.guests", ({ guests }) => this.#takeList(guests));

    room.on(RoomEvent.ConnectionStateChanged, (state) => {
      if (this.#ended || this.#rejoining) return;
      if (state === ConnectionState.Connected) this.#setState("connected");
      else if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) {
        this.#listStale();
        this.#setState("reconnecting");
      }
    });
    room.on(RoomEvent.Disconnected, (reason) => {
      void this.#lost(reason);
    });
    room.on(RoomEvent.AudioPlaybackStatusChanged, (playing) => {
      this.#audioBlocked = !playing;
      this.#emit("audioBlocked", this.#audioBlocked);
    });

    const participants = (): void => this.#queueParticipants();
    for (const event of [
      RoomEvent.ParticipantConnected,
      // (Someone back under the same identity before the room said they left is no new participant to LiveKit's
      // client — no connected event — only a new sid, which comes with their becoming active.)
      RoomEvent.ParticipantActive,
      RoomEvent.ParticipantMetadataChanged,
      RoomEvent.ParticipantNameChanged,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.ActiveSpeakersChanged,
      RoomEvent.ConnectionQualityChanged,
      RoomEvent.LocalTrackUnpublished,
    ] as const) {
      room.on(event, participants);
    }
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      this.#queueParticipants();
      if (this.#roleOf(participant) === "host") {
        for (const windowId of this.#bindings.keys()) this.#rebind(windowId);
        this.#queueWindows();
      }
    });
    room.on(RoomEvent.LocalTrackPublished, (publication) => {
      // (The camera is kept before it is published, and only while it is on: one turned off as it went out stays gone.)
      const track = publication.track;
      if (publication.source === Track.Source.Microphone && track instanceof LocalAudioTrack) this.#keepLocal("microphone", track);
      // A full reconnect of LiveKit's own publishes everything anew as it had it, restarting a camera or a microphone
      // first: a track the room let go of while LiveKit had it unpublished found nothing to take out then.
      if (track !== undefined && this.#letGo.has(track)) void this.#room.localParticipant.unpublishTrack(track, false).catch(report);
      this.#queueParticipants();
    });
    // LiveKit subscribes to a track as it is published: one of a guest this room does not take is let go at once.
    room.on(RoomEvent.TrackPublished, (publication, participant) => {
      if (this.#roleOf(participant) === "guest" && !this.#takesTracksOf(participant.identity)) publication.setSubscribed(false);
    });
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => this.#subscribed(track, publication, participant));
    room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => this.#unsubscribed(track, publication, participant));
  }

  #keepLocal(kind: "camera" | "microphone", track: LocalTrack): void {
    const previous = this.#localTracks[kind];
    if (previous !== null && previous !== track) previous.stop();
    if (kind === "camera") this.#localTracks.camera = track as LocalVideoTrack;
    else this.#localTracks.microphone = track as LocalAudioTrack;
  }

  #subscribed(track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant): void {
    if (this.#roleOf(participant) === "guest" && !this.#takesTracksOf(participant.identity)) {
      // Subscribed before this room let go of it: never played or shown.
      publication.setSubscribed(false);
      return;
    }
    if (track.kind === Track.Kind.Audio) {
      const element = track.attach();
      element.hidden = true;
      document.body.append(element);
      this.#audio.set(publication.trackSid, element);
    }
    const windowId = windowIdOf(publication.trackName);
    if (windowId !== null && track.kind === Track.Kind.Video && this.#roleOf(participant) === "host") {
      this.#rebind(windowId);
      this.#queueWindows();
    }
    this.#queueParticipants();
  }

  #unsubscribed(track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant): void {
    const element = this.#audio.get(publication.trackSid);
    if (element !== undefined) {
      track.detach(element);
      element.remove();
      this.#audio.delete(publication.trackSid);
    }
    const windowId = windowIdOf(publication.trackName);
    if (windowId !== null && this.#roleOf(participant) === "host") {
      // What shows the window now: its publication that is still subscribed (a republished window's new one), if any.
      const now = this.windowTrack(windowId);
      for (const binding of this.#bindings.get(windowId) ?? []) {
        if (binding.track === track) this.#bind(binding, now === track ? null : now);
      }
      this.#queueWindows();
    }
    this.#queueParticipants();
  }

  #setState(state: LiveConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#emit("state", state);
  }

  #emit<K extends keyof LiveRoomEvents>(event: K, value: LiveRoomEvents[K]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      try {
        (listener as Listener<K>)(value);
      } catch (error) {
        report(error);
      }
    }
  }

  /** Many LiveKit events land together (a join brings several); one "participants" per turn. */
  #queueParticipants(): void {
    if (this.#participantsQueued) return;
    this.#participantsQueued = true;
    queueMicrotask(() => {
      this.#participantsQueued = false;
      if (!this.#ended) this.#emit("participants", this.participants());
    });
  }

  #queueWindows(): void {
    if (this.#windowsQueued) return;
    this.#windowsQueued = true;
    queueMicrotask(() => {
      this.#windowsQueued = false;
      if (!this.#ended) this.#emit("windows", this.#windowIds());
    });
  }
}

function windowIdOf(trackName: string): string | null {
  return trackName.startsWith("win:") ? trackName.slice(4) : null;
}

function connectionOf(quality: ConnectionQuality): LiveParticipant["connection"] {
  switch (quality) {
    case ConnectionQuality.Excellent:
      return "excellent";
    case ConnectionQuality.Poor:
      return "poor";
    case ConnectionQuality.Lost:
      return "lost";
    default:
      return "good";
  }
}

/** The end a disconnect reason means, or null when it is worth joining again. */
function endReasonOf(reason: DisconnectReason | undefined): LiveEndReason | null {
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED:
      // Never our `disconnect()`, which has ended the room as left before LiveKit says a word: LiveKit's own, as the
      // page goes away (pagehide, beforeunload, freeze). The person did not leave — read as left, the guest page
      // forgot the request a reload rejoins with (docs/live-share.md §7) — and a page on its way out joins nothing.
      return "failed";
    case DisconnectReason.PARTICIPANT_REMOVED:
      return "removed";
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.ROOM_CLOSED:
      return "ended";
    case DisconnectReason.DUPLICATE_IDENTITY:
      return "replaced";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The lobby's media
// ---------------------------------------------------------------------------

/** What a preview is handed over to (`LiveRoom`): its tracks, those still coming, and every choice made in the lobby after. */
interface PreviewHeir {
  /** A capture asked for before the handover that came after it. */
  late(media: LiveLocalMedia): void;
  setCamera(on: boolean, deviceId?: string): Promise<void>;
  setMicrophone(on: boolean, deviceId?: string): Promise<void>;
  setBackground(background: LiveBackground): Promise<boolean>;
  background(): LiveBackground;
  /** The camera and microphone it has on now, for the lobby to show. */
  media(): { camera: LocalVideoTrack | null; microphone: LocalAudioTrack | null };
}

/**
 * The camera and microphone before joining: a preview, a mic level, a
 * background, devices. Hand it to `LiveRoom.connect` and its tracks are
 * published as they are; otherwise `stop()` it.
 *
 * A capture can wait on the browser's permission prompt for as long as the
 * person leaves it, and they can join, leave or choose again meanwhile. One
 * that comes after the preview was handed to a room is the room's; one that
 * comes after `stop()`, or after a later choice for its device, is stopped
 * as it comes — never kept by a preview nobody holds, the camera left on.
 *
 * The lobby stays up while the room joins, its switches live. Handed over,
 * the preview is the room's to switch: the camera, the microphone, their
 * devices and the background chosen then go to the room, and the tracks it
 * shows are the room's — so a microphone turned off as the room publishes
 * it goes out muted, and what is chosen last is what goes out.
 */
export class LivePreview {
  readonly #effectsAssetPath: string | undefined;
  readonly #listeners = new Set<() => void>();
  #camera: LocalVideoTrack | null = null;
  #microphone: LocalAudioTrack | null = null;
  #analyser: ReturnType<typeof createAudioAnalyser> | null = null;
  #background: LiveBackground = { kind: "none" };
  /** Background choices, counted: a change that fails after a later one came is that one's to answer. */
  #backgroundAsked = 0;
  /** Each device's choices, counted: a capture that comes for one a later choice (or `stop()`) replaced is not kept. */
  readonly #asked = { camera: 0, microphone: 0 };
  /** Set by `handOver`: the room, where a capture asked for before it and come after goes, and every choice after. */
  #heir: PreviewHeir | null = null;

  constructor(options: { effectsAssetPath?: string } = {}) {
    this.#effectsAssetPath = options.effectsAssetPath;
  }

  /** The camera on (its background maybe still loading): the room's once handed over. */
  camera(): LocalVideoTrack | null {
    return this.#heir === null ? this.#camera : this.#heir.media().camera;
  }

  /** The microphone on: the room's once handed over. */
  microphone(): LocalAudioTrack | null {
    return this.#heir === null ? this.#microphone : this.#heir.media().microphone;
  }

  background(): LiveBackground {
    return this.#heir === null ? this.#background : this.#heir.background();
  }

  /** Called when a track comes, goes or changes device. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Turn the camera on (on `deviceId`, or switch to it) or off. Rejects when
   * the camera is refused, and — as the room keeps such a camera out (§7) —
   * when the background chosen cannot be put on it: it is stopped.
   */
  async setCamera(on: boolean, deviceId?: string): Promise<void> {
    if (this.#heir !== null) return this.#forward(this.#heir.setCamera(on, deviceId));
    const ask = this.#ask("camera");
    if (!on) {
      if (this.#camera !== null) stopCamera(this.#camera);
      this.#camera = null;
      this.#changed();
      return;
    }
    if (this.#camera !== null) {
      // Restarting keeps the background processor (no segmenter reload).
      if (deviceId !== undefined) await this.#camera.restartTrack({ deviceId: { exact: deviceId } });
    } else {
      const camera = await createLocalVideoTrack({ ...(deviceId === undefined ? {} : { deviceId: { exact: deviceId } }), resolution: VideoPresets.h720.resolution });
      if (!this.#keeps({ kind: "camera", track: camera }, ask)) return;
      this.#camera = camera;
      if (this.#background.kind !== "none") await this.#putBackground(camera);
    }
    this.#changed();
  }

  /**
   * The background chosen, on a camera just come; one that cannot be put on
   * stops it, and rejects — unless a background chosen since answers, or the
   * camera is no longer this preview's (turned off, handed to the room).
   */
  async #putBackground(camera: LocalVideoTrack): Promise<void> {
    const asked = this.#backgroundAsked;
    try {
      if (await applyBackground(camera, this.#background, this.#effectOptions())) return;
      throw new Error("camera backgrounds are not supported here");
    } catch (error) {
      if (asked !== this.#backgroundAsked || this.#camera !== camera) return;
      this.#camera = null;
      stopCamera(camera);
      this.#changed();
      throw error;
    }
  }

  async setMicrophone(on: boolean, deviceId?: string): Promise<void> {
    if (this.#heir !== null) return this.#forward(this.#heir.setMicrophone(on, deviceId));
    const ask = this.#ask("microphone");
    if (!on) {
      const analyser = this.#analyser;
      this.#analyser = null;
      this.#microphone?.stop();
      this.#microphone = null;
      this.#changed();
      await analyser?.cleanup();
      return;
    }
    if (this.#microphone !== null) {
      if (deviceId !== undefined) await this.#microphone.restartTrack({ deviceId: { exact: deviceId } });
    } else {
      const microphone = await createLocalAudioTrack({
        ...(deviceId === undefined ? {} : { deviceId: { exact: deviceId } }),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      if (!this.#keeps({ kind: "microphone", track: microphone }, ask)) return;
      this.#microphone = microphone;
    }
    // Turned off, or handed to the room, while it restarted: nothing here to meter.
    if (this.#microphone === null) return;
    const previous = this.#analyser;
    this.#analyser = createAudioAnalyser(this.#microphone);
    this.#changed();
    await previous?.cleanup();
  }

  /** The microphone's level now, 0..1 (read it each frame for a meter). */
  micLevel(): number {
    return this.#analyser?.calculateVolume() ?? 0;
  }

  /**
   * The background behind the camera, now and whenever it comes on. False
   * where effects are unsupported, a rejection when it did not load: either
   * way the camera keeps the one it had, which is the preview's choice again
   * (`background()`), and a camera nobody can say that of is stopped. A
   * change failing after a later one came is let go (true).
   */
  async setBackground(background: LiveBackground): Promise<boolean> {
    if (this.#heir !== null) return this.#forward(this.#heir.setBackground(background));
    const ask = (this.#backgroundAsked += 1);
    this.#background = background;
    const camera = this.#camera;
    if (camera === null) return true;
    const refused = await changeBackground(camera, background, this.#effectOptions(), () => ask === this.#backgroundAsked && this.#camera === camera);
    if (refused === null) {
      this.#changed();
      return true;
    }
    if (refused.shows !== null) {
      this.#background = refused.shows;
    } else {
      this.#camera = null;
      stopCamera(camera);
    }
    this.#changed();
    if (refused.failure !== null) throw refused.failure.error;
    return false;
  }

  devices(kind: MediaDeviceKind): Promise<MediaDeviceInfo[]> {
    return Room.getLocalDevices(kind);
  }

  /** Stop the tracks (leaving the lobby without joining), and any still coming. Nothing once handed to a room. */
  stop(): void {
    if (this.#heir !== null) return;
    this.#asked.camera += 1;
    this.#asked.microphone += 1;
    void this.#analyser?.cleanup();
    this.#analyser = null;
    if (this.#camera !== null) stopCamera(this.#camera);
    this.#microphone?.stop();
    this.#camera = null;
    this.#microphone = null;
  }

  /**
   * @internal The room takes the tracks; this preview lets go of them. A
   * capture still waiting on its prompt goes to the room when it comes, and
   * so does every choice made here from now on.
   */
  handOver(heir: PreviewHeir): { camera: LocalVideoTrack | null; microphone: LocalAudioTrack | null; background: LiveBackground } {
    if (this.#heir !== null) throw new Error("this preview's tracks belong to a room already");
    this.#heir = heir;
    void this.#analyser?.cleanup();
    this.#analyser = null;
    const tracks = { camera: this.#camera, microphone: this.#microphone, background: this.#background };
    this.#camera = null;
    this.#microphone = null;
    return tracks;
  }

  /** A choice made once handed over, the room's: the lobby is told when it took, or did not, to show what the room has on. */
  async #forward<T>(choice: Promise<T>): Promise<T> {
    try {
      return await choice;
    } finally {
      this.#changed();
    }
  }

  #ask(kind: LiveLocalMedia["kind"]): number {
    this.#asked[kind] += 1;
    return this.#asked[kind];
  }

  /**
   * Whether a capture just come, for its device's `ask`th choice, is this
   * preview's to keep: not when a later choice or `stop()` came since (it is
   * stopped), nor when the preview was handed over since (it is the room's).
   */
  #keeps(media: LiveLocalMedia, ask: number): boolean {
    if (this.#asked[media.kind] !== ask) {
      media.track.stop();
      return false;
    }
    if (this.#heir !== null) {
      this.#heir.late(media);
      return false;
    }
    return true;
  }

  #effectOptions(): { assetPath?: string } {
    return this.#effectsAssetPath === undefined ? {} : { assetPath: this.#effectsAssetPath };
  }

  #changed(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        report(error);
      }
    }
  }
}
