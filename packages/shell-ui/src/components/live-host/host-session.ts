/**
 * The host's side of the room (docs/live-share.md §6.3), everything but the
 * drawing: it joins the room as `host` and stays in it, streams the shared
 * windows while anyone is let in (window-captures.ts), sends the desk, the
 * host's pointer, ink, reactions, chat, grants and refusals, answers a
 * guest's hello with the room as it is (`lv.sync`), turns the host's camera
 * and mic into what main says they should be, and tells main what the room
 * says: who is in it, guests' chat, input, asks and knocks.
 *
 * All of it is for the guests main lets in (`admitted`, audience.ts) and
 * nobody else in the room: only they may subscribe to the host's tracks,
 * the host's data goes to them alone, and only theirs is drawn. Each of
 * them is told who the others are (`lv.guests`) on every change and on
 * each hello, ahead of the sync, so the guests keep their own cameras,
 * mics and word among themselves and the host too.
 *
 * The shared windows the shell draws itself (home, notes, a terminal, a
 * document) are cut out of a capture of the shell's own page (shell-crops.ts,
 * §6.6), each published as its own window.
 *
 * Main is the hub (§2): everything here comes from it as a `LiveHostEvent`
 * and goes back as a `LiveHostReport`. The session outlives a room — when
 * LiveKit cannot resume a connection and the room gives up, a new room is
 * joined with a fresh token from main, and the windows, camera and mic go
 * out again.
 *
 * What it draws with lives here too, as the feeds the shared layers read
 * (`@pistachio/live-share/react`): the guests' pointers, the ink board (the
 * one a sync carries: the host's is the room's), pings and reactions, and
 * where the stage lies in this window. React holds only what changes rarely
 * (`HostView`); desk frames reach the outlines through `onFrame`, and what
 * of the browser's own lies over the desk — which the outlines go under —
 * through `onChrome`.
 */

import { CursorThrottle, LIVE_REACTIONS, MARK_RATE, RateLimiter, type LiveBody, type LiveCursor, type LiveInkOp, type LiveReaction, type LiveTool, type LiveTopic } from "@pistachio/live-share";
import { LiveRoom, WINDOW_CAPTURE_MAX_SIDE, WINDOW_MAX_FPS, type LiveConnectionState, type LiveEndReason, type LiveParticipant, type LiveSender } from "@pistachio/live-share/room";
import { CursorFeed, InkStore, createEmitter, createStageBox, mediaProblemOf, type Emitter, type LivePingEvent, type LiveReactionEvent } from "@pistachio/live-share/react";
import type { NativeSurfaceApi } from "@pistachio/shell-contracts/ipc";
import {
  LIVE_LOCAL_MEDIA_DEFAULT,
  type LiveGuest,
  type LiveHostConfig,
  type LiveHostDeskFrame,
  type LiveHostEvent,
  type LiveHostReport,
  type LiveLocalMedia,
  type LiveMediaDevice,
  type LiveRect,
  type LiveShareState,
  type LiveShellMark,
} from "@pistachio/shell-contracts/live-share";
import { RoomAudience } from "./audience";
import { afterStep, forgiven, laneOf, MEDIA_LANES, mediaSteps, NO_REFUSALS, type MediaLane, type MediaRefusals, type MediaStep } from "./media-steps";
import { buildSync, cameBack, guestsOf, refusedAsks, rosterChange, sameGuests, sessionsOf } from "./room-sync";
import { copyFrame, cutFrame, frameGenerator, openShellCapture, readShellMark } from "./shell-capture";
import { ShellCrops } from "./shell-crops";
import { firstFrame, openTabCapture } from "./tab-capture";
import { WindowCaptures } from "./window-captures";

/** What of the native bridge the live-host app uses. */
export type LiveHostBridge = Pick<NativeSurfaceApi, "sendLiveHostReport" | "liveHostSource" | "liveHostShellSource">;

/**
 * The longest side the shell's own page is captured at. It is never sent
 * whole — each window is cut out of it at its own pixels, and goes out at
 * most WINDOW_CAPTURE_MAX_SIDE long — but it is captured at its own device
 * pixels, or the mark each frame bears (lib/live/marker.ts) has no pixels of
 * its own and no frame is cut: so past any Mac's window (a 6K display's,
 * scaled for more space, is 6768 wide), and within what Chromium captures.
 */
const SHELL_CAPTURE_MAX_SIDE = 8192;

/** What the overlay renders with React: it changes at a join, a speaker's turn, a resize — never per frame. */
export interface HostView {
  connection: LiveConnectionState;
  /** The host and the guests let in, the host first (the faces). */
  participants: readonly LiveParticipant[];
  state: LiveShareState;
  /** Where the shared stage lies in this window, or null while the host is away from it. */
  stage: LiveRect | null;
  /** The last stage the host was on: the faces and the pill stay there while the host is away. */
  anchor: LiveRect | null;
  /** The host is on the shared space (the desk frame says so, and main placed the stage). */
  present: boolean;
  /** How loud the host hears each guest heard at other than full (0: muted), by identity, for the life of the share. */
  volumes: ReadonlyMap<string, number>;
}

/** Waits before joining again after the room gave up, or a join failed; the last repeats. */
const REJOIN_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 15_000];
/** How long the room waits on main for a token before it tries with the one it has. */
const TOKEN_WAIT_MS = 10_000;

const HOST_SENDER = { identity: "host", role: "host" } as const;

function log(message: string, error?: unknown): void {
  console.warn(`[live-host] ${message}`, ...(error === undefined ? [] : [error]));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The device main names, or the system's (null) by its name: left out, the
 * room — LiveKit — would capture on the one it used last, or not switch
 * from it at all.
 */
const deviceOf = (deviceId: string | null): string => deviceId ?? "default";

/** The room said this engine cannot run background effects (no WebGL 2, no frame processing). */
class BackgroundUnsupportedError extends Error {
  constructor() {
    super("camera backgrounds are not supported here");
  }
}

/** Words for the Live card when the host's camera or mic did not come on. */
function mediaFailure(kind: "mic" | "camera", error: unknown): string {
  const device = kind === "mic" ? "microphone" : "camera";
  switch (mediaProblemOf(error)) {
    case "blocked":
      return `Pistachio isn't allowed to use the ${device}. Allow it in System Settings → Privacy & Security.`;
    case "missing":
      return `No ${device} was found.`;
    case "busy":
      return `The ${device} is in use by another app.`;
    case "failed":
      return `The ${device} didn't start.`;
  }
}

export class LiveHostSession {
  /** The guests' pointers (the host's own is the OS pointer). */
  readonly cursors = new CursorFeed();
  /** The room's ink: the board a sync carries. */
  readonly ink = new InkStore();
  readonly pings: Emitter<LivePingEvent> = createEmitter<LivePingEvent>();
  readonly reactions: Emitter<LiveReactionEvent> = createEmitter<LiveReactionEvent>();
  /** Where the stage lies in this window, for the layers that draw over it. */
  readonly stageBox = createStageBox();

  readonly #bridge: LiveHostBridge;
  readonly #url: string;
  readonly #captures: WindowCaptures;
  /** The shell-drawn windows' pictures, cut from the shell's page. */
  readonly #crops: ShellCrops<MediaStreamTrack, VideoFrame>;
  readonly #cursor: CursorThrottle;
  readonly #listeners = new Set<() => void>();
  readonly #frameListeners = new Set<(frame: LiveHostDeskFrame) => void>();
  readonly #chromeListeners = new Set<(over: readonly LiveRect[] | null) => void>();
  /** Who the room is for: whom to send to and sync, and whether to capture. */
  readonly #audience: RoomAudience;
  /** Pings and reactions a guest sends, as the host sees them drawn: the two together at `MARK_RATE`. */
  readonly #marks = new RateLimiter(MARK_RATE);
  #view: HostView;
  #room: LiveRoom | null = null;
  #token: string;
  #tokenWaiters: Array<(token: string) => void> = [];
  #frame: LiveHostDeskFrame | null;
  /** The shell's mark the latest frame was built under (§6.6): what the shell-drawn windows are cut by. */
  #shell: LiveShellMark | null;
  /** What of the browser's own lies over the desk (window px), or null: something no box holds (main's `chrome`). */
  #chrome: readonly LiveRect[] | null;
  /** Everyone in the room as it says (the faces show the host and those let in). */
  #everyone: readonly LiveParticipant[] = [];
  #roster: LiveGuest[] = [];
  /** Each guest's presence (sid) as the roster was last told. */
  #sessions: ReadonlyMap<string, string> = new Map();
  #reported: { state: LiveConnectionState; error: string | undefined } | null = null;
  /** The host's media as the room has been asked for it. */
  #media: LiveLocalMedia = LIVE_LOCAL_MEDIA_DEFAULT;
  #refused: MediaRefusals = NO_REFUSALS;
  /** Each lane's steps under way, and whether main's word changed since they were worked out. */
  readonly #lanes: Record<MediaLane, { running: boolean; dirty: boolean }> = { camera: { running: false, dirty: false }, sound: { running: false, dirty: false } };
  /** The camera coming on (`#startCamera`), until it is in, fails or is let go. */
  #cameraComing: Promise<void> | null = null;
  /** The mic coming on (`#startMic`), until it is in, fails or is turned off. */
  #micComing: Promise<void> | null = null;
  /** The host's pen is down (their pointer goes out pressed). */
  #penDown = false;
  #disposed = false;
  #unwatchDevices: (() => void) | null = null;
  readonly #resized = (): void => this.#streamFrame();

  constructor(config: LiveHostConfig, bridge: LiveHostBridge) {
    this.#bridge = bridge;
    this.#url = config.livekit.url;
    this.#token = config.livekit.token;
    this.#frame = config.frame;
    this.#shell = config.shell;
    this.#chrome = config.chrome;
    this.#view = {
      connection: "connecting",
      participants: [],
      state: config.state,
      stage: config.stage,
      anchor: config.stage,
      present: config.stage !== null && config.frame?.hostPresent !== false,
      volumes: new Map(),
    };
    if (config.stage !== null) this.stageBox.set(config.stage);
    this.#cursor = new CursorThrottle({
      send: (cursor) => this.#send("lv.cursor", cursor),
      stageSize: () => this.stageBox.get(),
    });
    this.#captures = new WindowCaptures({
      source: (windowId) => bridge.liveHostSource(windowId),
      open: (sourceId, size) => openTabCapture(sourceId, size, WINDOW_MAX_FPS),
      firstFrame,
      stalled: (windowId) => this.report({ type: "captureStalled", windowId }),
      pixelRatio: () => window.devicePixelRatio || 1,
      maxSide: WINDOW_CAPTURE_MAX_SIDE,
      log,
    });
    this.#crops = new ShellCrops({
      source: () => bridge.liveHostShellSource(),
      open: (sourceId, size) => openShellCapture(sourceId, size, WINDOW_MAX_FPS),
      generator: frameGenerator,
      readMark: readShellMark,
      cut: cutFrame,
      copy: copyFrame,
      // (This window lies exactly over the browser window's content: its viewport is that box.)
      viewport: () => ({ width: window.innerWidth, height: window.innerHeight, ratio: window.devicePixelRatio || 1 }),
      maxSide: WINDOW_CAPTURE_MAX_SIDE,
      captureMaxSide: SHELL_CAPTURE_MAX_SIDE,
      log,
    });
    this.#audience = new RoomAudience(
      {
        sync: (identity) => this.#sync(identity),
        streaming: () => this.#streamFrame(),
        now: () => performance.now(),
        later: (run, ms) => {
          const timer = setTimeout(run, ms);
          return () => clearTimeout(timer);
        },
      },
      config.admitted,
    );
  }

  /** Join the room, and keep joining it until the share ends. */
  start(): void {
    this.#reportConnection("connecting");
    this.#streamFrame();
    this.#watchDevices();
    // The browser's window resized (this one with it): the shell's capture follows, and its crops wait for the new layout.
    window.addEventListener("resize", this.#resized);
    void this.#run();
  }

  /* ------------------------------- for the overlay ------------------------------- */

  view(): HostView {
    return this.#view;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Every desk frame, as it comes (the outlines follow the windows by ref). */
  onFrame(listener: (frame: LiveHostDeskFrame) => void): () => void {
    this.#frameListeners.add(listener);
    if (this.#frame !== null) listener(this.#frame);
    return () => this.#frameListeners.delete(listener);
  }

  frame(): LiveHostDeskFrame | null {
    return this.#frame;
  }

  /** What of the browser's own lies over the desk, now and as it changes (the outlines go under it, by ref). */
  onChrome(listener: (over: readonly LiveRect[] | null) => void): () => void {
    this.#chromeListeners.add(listener);
    listener(this.#chrome);
    return () => this.#chromeListeners.delete(listener);
  }

  report(report: LiveHostReport): void {
    if (!this.#disposed) this.#bridge.sendLiveHostReport(report);
  }

  /** An op of the host's own stroke (the overlay's pen): on the board, and to the room. */
  drawInk(op: LiveInkOp): void {
    if (op.op === "begin") this.#penDown = true;
    else if (op.op === "end") this.#penDown = false;
    this.ink.apply(op, HOST_SENDER);
    this.#send("lv.ink", op);
  }

  /** The host pinged a point of the stage (stage-normalized). */
  ping(x: number, y: number): void {
    const at = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
    this.pings.emit({ ...at, color: this.#colorOf("host") });
    this.#send("lv.ping", at);
  }

  /**
   * Hear a guest let in at this volume here only (0 mutes them for the host;
   * others still hear them). LiveKit keeps it on the participant it was set
   * on, and a guest back from a reload — everyone, in a room joined afresh —
   * is a new one to it, heard at full volume: so it is kept here by identity
   * for the life of the share, and set again as the room's participants and
   * main's list change (`#setVolumes`). Not when the guest leaves the list:
   * one reloading is off it a moment, and one removed is let in again, if
   * ever, under a new identity (each is a request's), so the map holds no
   * more than the guests let in over one share.
   */
  setGuestVolume(identity: string, volume: number): void {
    if (!this.#audience.has(identity)) return;
    this.#room?.setParticipantVolume(identity, volume);
    const volumes = new Map(this.#view.volumes);
    if (volume >= 1) volumes.delete(identity);
    else volumes.set(identity, volume);
    this.#update({ volumes });
  }

  /** Leave the room and let everything go: the share is over. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#audience.dispose();
    this.#captures.dispose();
    this.#crops.dispose();
    window.removeEventListener("resize", this.#resized);
    this.#cursor.dispose();
    this.#unwatchDevices?.();
    for (const resolve of this.#tokenWaiters) resolve(this.#token);
    this.#tokenWaiters = [];
    const room = this.#room;
    this.#room = null;
    void room?.disconnect();
    this.#listeners.clear();
    this.#frameListeners.clear();
    this.#chromeListeners.clear();
  }

  /* ---------------------------------- from main ---------------------------------- */

  handle(event: LiveHostEvent): void {
    if (this.#disposed) return;
    switch (event.type) {
      case "desk":
        // (Frames come in order; an older one is not news, and the same one again brings only the shell's new mark.)
        if (this.#frame !== null && event.frame.seq < this.#frame.seq) return;
        this.#shell = event.shell;
        if (this.#frame !== null && event.frame.seq === this.#frame.seq) {
          this.#streamFrame();
          return;
        }
        this.#frame = event.frame;
        this.#send("lv.desk", event.frame);
        this.#streamFrame();
        for (const listener of this.#frameListeners) listener(event.frame);
        this.#update({ present: this.#view.stage !== null && event.frame.hostPresent });
        return;
      case "chrome":
        this.#chrome = event.over;
        for (const listener of this.#chromeListeners) listener(event.over);
        return;
      case "stage":
        if (event.rect !== null) this.stageBox.set(event.rect);
        this.#update({ stage: event.rect, anchor: event.rect ?? this.#view.anchor, present: event.rect !== null && this.#frame?.hostPresent !== false });
        // (The shell-drawn windows are cut where the stage lies: none while it is not shown.)
        this.#streamFrame();
        return;
      case "pointer":
        this.#cursor.update(event.at === null ? null : { x: event.at.x, y: event.at.y, tool: this.#tool(), down: this.#penDown }, performance.now());
        return;
      case "state":
        // The host said no to an ask: that guest alone is told, so their "Asked…" line gives way to the answer.
        for (const ask of refusedAsks(this.#view.state, event.state)) {
          if (this.#audience.has(ask.identity)) this.#send("lv.refused", { w: ask.windowId }, [ask.identity]);
        }
        this.#refused = forgiven(this.#refused, event.state.local, this.#view.state.local);
        this.#update({ state: event.state });
        this.#queueMedia();
        return;
      case "admitted":
        // Who may subscribe first, then who is with whom: whatever a change of it starts (a sync, the captures)
        // goes to them alone, behind the list each guest goes by.
        this.#room?.setReceivers(event.identities);
        this.#send("lv.guests", { guests: [...event.identities] }, event.identities);
        this.#audience.setAdmitted(event.identities);
        this.#showParticipants();
        // A guest let in again back from a reload is a new participant: the host's volume for them goes on it.
        this.#setVolumes();
        return;
      case "token":
        this.#token = event.token;
        for (const resolve of this.#tokenWaiters) resolve(event.token);
        this.#tokenWaiters = [];
        return;
      case "capture":
        this.#captures.recapture(event.windowId);
        return;
      case "grant":
        this.#send("lv.grant", { w: event.windowId, user: event.identity });
        return;
      case "chat":
        this.#send("lv.chat", { id: event.id, text: event.text });
        return;
      case "react":
        if (!(LIVE_REACTIONS as readonly string[]).includes(event.emoji)) return;
        this.reactions.emit({ emoji: event.emoji, identity: "host" });
        this.#send("lv.react", { emoji: event.emoji as LiveReaction });
        return;
      case "clearInk":
        this.drawInk({ op: "clear", scope: "all" });
        return;
      case "end":
        this.dispose();
        return;
    }
  }

  /* ----------------------------------- the room ----------------------------------- */

  async #run(): Promise<void> {
    for (let attempt = 0; !this.#disposed; attempt += 1) {
      if (attempt > 0) {
        await sleep(REJOIN_MS[Math.min(attempt - 1, REJOIN_MS.length - 1)] ?? 15_000);
        if (this.#disposed) return;
        this.#token = await this.#freshToken();
        if (this.#disposed) return;
      }
      let room: LiveRoom;
      try {
        // Joined for those let in alone: LiveKit subscribes the room to who is in it before `connect` returns, a
        // removed guest still there among them.
        room = await LiveRoom.connect({ url: this.#url, token: this.#token, role: "host", receivers: this.#audience.receivers(), refreshToken: () => this.#freshToken() });
      } catch (error) {
        log("could not join the room", error);
        this.#reportConnection("disconnected", "Couldn't reach the live share's room. Trying again…");
        continue;
      }
      if (this.#disposed) {
        void room.disconnect();
        return;
      }
      attempt = 0;
      const ended = new Promise<LiveEndReason>((resolve) => room.on("disconnected", resolve));
      const detach = this.#attach(room);
      const reason = await ended;
      detach();
      if (this.#disposed || reason === "left") return;
      if (reason !== "failed") {
        // The room was closed under the share, or another window took the host's place: joining again would bring it back.
        this.#reportConnection("disconnected", reason === "replaced" ? "The share was opened somewhere else." : "The live share's room closed.");
        return;
      }
      this.#reportConnection("reconnecting", "Lost the room. Joining again…");
    }
  }

  /** The room is ours: wire it, put the windows, camera and mic in it, and send the desk. */
  #attach(room: LiveRoom): () => void {
    this.#room = room;
    // Before anything is published, whom main lets in now: it may have said otherwise while the room joined.
    room.setReceivers(this.#audience.receivers());
    const offs = [
      room.on("state", (state) => {
        this.#reportConnection(state);
        this.#update({ connection: state });
        if (state !== "connected") return;
        // Back after a drop: the desk as it is now, and who is let in, for anyone who missed a change meanwhile, and
        // every window's picture asked of the room again (one it refused while it was going, or could not publish
        // again, goes out).
        if (this.#frame !== null) this.#send("lv.desk", this.#frame);
        this.#listGuests();
        this.#captures.reconnected();
        this.#crops.reconnected();
      }),
      room.on("participants", (participants) => this.#participants(participants)),
      // The room took the camera or the mic out: joined again from scratch, it could not put it out again however
      // often it tried. Off, and told, as one that did not come on, so the card does not go on saying it is on.
      room.on("mediaFailed", ({ kind, error }) => {
        const step = kind === "camera" ? ({ kind: "camera", on: true, deviceId: this.#media.devices.videoinput } as const) : ({ kind: "mic", on: true, deviceId: this.#media.devices.audioinput } as const);
        this.#media = { ...this.#media, [step.kind]: false };
        this.#mediaFailed(room, step, error);
      }),
      room.on("audioBlocked", (blocked) => {
        if (blocked) void room.startAudio().catch((error: unknown) => log("guests' voices could not play", error));
      }),
      room.onMessage("lv.cursor", (cursor, from) => this.#guestCursor(cursor, from)),
      room.onMessage("lv.ink", (op, from) => this.#guestInk(op, from)),
      room.onMessage("lv.ping", (ping, from) => {
        if (!this.#heard(from) || !this.#marks.take(from.identity, performance.now())) return;
        this.pings.emit({ x: ping.x, y: ping.y, color: this.#colorOf(from.identity) });
      }),
      room.onMessage("lv.react", (react, from) => {
        if (!this.#heard(from) || !this.#marks.take(from.identity, performance.now())) return;
        this.reactions.emit({ emoji: react.emoji, identity: from.identity });
      }),
      room.onMessage("lv.chat", (chat, from) => {
        if (from.role === "guest" && from.identity !== null) this.report({ type: "chat", from: from.identity, id: chat.id, text: chat.text });
      }),
      // Saying hello, a guest is listening: sent the room once main lets them in, behind who is let in — a guest
      // says hello as it joins and again back from a reconnect, when it goes by no list until it hears one.
      room.onMessage("lv.hello", (_hello, from) => {
        if (from.identity === null) return;
        if (this.#audience.has(from.identity)) this.#listGuests([from.identity]);
        this.#audience.hello(from.identity);
      }),
      room.onMessage("lv.input", (input, from) => {
        if (from.identity !== null) this.report({ type: "input", from: from.identity, windowId: input.w, event: input.e });
      }),
      room.onMessage("lv.ask", (ask, from) => {
        if (from.identity !== null) this.report({ type: "ask", from: from.identity, windowId: ask.w });
      }),
      // A hint only: main shows the knocks control lists as pending.
      room.onMessage("lv.knock", (knock) => this.report({ type: "knock", requestId: knock.requestId, name: knock.name })),
    ];
    this.#update({ connection: room.state() });
    this.#reportConnection(room.state());
    this.#participants(room.participants());
    this.#captures.setPublisher(room);
    this.#crops.setPublisher(room);
    if (this.#frame !== null) this.#send("lv.desk", this.#frame);
    this.#listGuests();
    // A room joined from scratch has nothing of the host's on (a camera the last one was bringing on went with it).
    this.#media = LIVE_LOCAL_MEDIA_DEFAULT;
    this.#cameraComing = null;
    this.#micComing = null;
    this.#queueMedia();
    return () => {
      for (const off of offs) off();
      if (this.#room === room) this.#room = null;
      this.#captures.setPublisher(null);
      this.#crops.setPublisher(null);
    };
  }

  #participants(participants: LiveParticipant[]): void {
    this.#everyone = participants;
    const guests = guestsOf(participants);
    const { left } = rosterChange(this.#roster, guests);
    const sessions = sessionsOf(participants);
    // Someone back under the same identity is news to main though the roster reads the same: main shows out again
    // anyone it removed (LiveKit's client never said they left, so nothing else would tell it).
    const back = cameBack(this.#sessions, sessions);
    this.#sessions = sessions;
    if (!sameGuests(guests, this.#roster) || back.length > 0) {
      this.#roster = guests;
      this.report({ type: "roster", guests });
    }
    this.#audience.setRoom(new Set(guests.map((guest) => guest.identity)));
    this.#setVolumes();
    const now = performance.now();
    for (const identity of left) {
      this.cursors.remove(identity);
      this.ink.release(identity, now);
      this.#marks.forget(identity);
    }
    this.#showParticipants();
  }

  /**
   * The host's volumes, on the guests in the room main lets in: on whoever is
   * new to LiveKit (setting one again on the same participant changes
   * nothing; LiveKit holds it for a track not yet subscribed). Nobody else's
   * sound is played at all (`setReceivers`).
   */
  #setVolumes(): void {
    for (const participant of this.#everyone) {
      const volume = this.#view.volumes.get(participant.identity);
      if (volume !== undefined && this.#audience.has(participant.identity)) this.#room?.setParticipantVolume(participant.identity, volume);
    }
  }

  /** The faces: the host and the guests let in (someone removed and back for a moment is not shown). */
  #showParticipants(): void {
    this.#update({ participants: this.#everyone.filter((participant) => participant.role !== "guest" || this.#audience.has(participant.identity)) });
  }

  /** A guest whose pointer, ink and marks are drawn: one main lets in. */
  #heard(from: LiveSender): from is LiveSender & { identity: string } {
    return from.identity !== null && from.role === "guest" && this.#audience.has(from.identity);
  }

  #guestCursor(cursor: LiveCursor, from: LiveSender): void {
    if (this.#heard(from)) this.cursors.push(from.identity, cursor);
  }

  #guestInk(op: LiveInkOp, from: LiveSender): void {
    if (!this.#heard(from)) return;
    // With guests' drawing off, nothing new of theirs lands on the board; ending, erasing and clearing their own still do.
    if (!this.#view.state.guestsCanDraw && (op.op === "begin" || op.op === "add")) return;
    this.ink.apply(op, { identity: from.identity, role: "guest" });
  }

  #sync(identity: string): void {
    const sync = buildSync({ frame: this.#frame, strokes: this.ink.board.snapshot(), chat: this.#view.state.chat, using: this.#view.state.using });
    this.#send("lv.sync", sync, [identity]);
  }

  /**
   * Tell the guests let in (or `to`) who they are (§4 `lv.guests`): each
   * lets only the host and the others on it see and hear it, and hears only them.
   */
  #listGuests(to: readonly string[] = this.#audience.receivers()): void {
    this.#send("lv.guests", { guests: [...this.#audience.receivers()] }, to);
  }

  /**
   * Send to the guests let in (or to `to`), if there is a room; a failure is
   * the room's (it rejoins), not the caller's. With nobody to send to,
   * nothing goes: to LiveKit an empty list is everyone.
   */
  #send<T extends LiveTopic>(topic: T, body: LiveBody<T>, to: readonly string[] = this.#audience.receivers()): void {
    const room = this.#room;
    if (room === null || to.length === 0) return;
    room.send(topic, body, { to: [...to] }).catch((error: unknown) => log(`could not send ${topic}`, error));
  }

  /** Main's answer to "a token, please": a fresh one when control has it, else the one held; this one after a while. */
  #freshToken(): Promise<string> {
    if (this.#disposed) return Promise.resolve(this.#token);
    return new Promise((resolve) => {
      let settled = false;
      const done = (token: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(token);
      };
      const timer = setTimeout(() => done(this.#token), TOKEN_WAIT_MS);
      this.#tokenWaiters.push(done);
      this.report({ type: "tokenExpiring" });
    });
  }

  #reportConnection(state: LiveConnectionState, error?: string): void {
    const last = this.#reported;
    if (last !== null && last.state === state && last.error === error) return;
    this.#reported = { state, error };
    this.report(error === undefined ? { type: "connection", state } : { type: "connection", state, error });
  }

  /* ---------------------------------- windows ---------------------------------- */

  /**
   * The latest frame's streamed windows are the ones captured — while anyone
   * is let in (and a while after the last one left): a capture keeps its
   * page rendering and read back, for nobody, otherwise. A page is its tab's
   * capture; a shell-drawn window is cut from the shell's, where the stage
   * lies now, while the frame lets its picture run.
   */
  #streamFrame(): void {
    const frame = this.#frame;
    const windows = frame === null || !this.#audience.streaming() ? [] : frame.windows.filter((window) => window.track !== null);
    this.#captures.update(windows.filter((window) => window.kind === "page").map((window) => ({ id: window.id, page: window.page })));
    this.#crops.update({
      windows: windows.filter((window) => window.kind === "shell").map((window) => ({ id: window.id, page: window.page, live: !window.paused })),
      stage: this.#view.stage,
      shell: this.#shell,
    });
  }

  /* ----------------------------------- media ----------------------------------- */

  #queueMedia(): void {
    this.#cameraOff();
    this.#micOff();
    for (const lane of MEDIA_LANES) {
      const run = this.#lanes[lane];
      run.dirty = true;
      if (!run.running) void this.#runMedia(lane);
    }
  }

  /**
   * An off goes to the room the moment main says so, ahead of whatever the
   * camera's lane has under way — a background loading on a camera that is
   * out (the segmenter's first load, a second or two), a device switch: it
   * is the host taking themselves out of the room. The room stops the camera
   * and unpublishes it at once; a change that lands after finds no camera,
   * and the room lets it go.
   */
  #cameraOff(): void {
    const room = this.#room;
    const wanted = this.#view.state.local;
    if (room !== null && this.#media.camera && !wanted.camera) this.#stopCamera(room, { kind: "camera", on: false, deviceId: wanted.devices.videoinput });
  }

  /**
   * The mic's off likewise, ahead of whatever the sound lane has under way:
   * the mic coming on (its permission prompt, its first publish), a device
   * switch. The room mutes it at once, and a mic still coming goes out no
   * more — stopped as its capture lands, or muted before its publish goes
   * — so the mic is never live once the card says Mic off.
   */
  #micOff(): void {
    const room = this.#room;
    const wanted = this.#view.state.local;
    if (room !== null && this.#media.mic && !wanted.mic) this.#stopMic(room, { kind: "mic", on: false, deviceId: wanted.devices.audioinput });
  }

  /**
   * Step the room's camera and mic toward main's word, one at a time in each
   * lane (media-steps.ts); what fails is told to main once. The camera
   * coming on holds up no step after it (`#startCamera`), and the camera or
   * the mic going off waits on none before it (`#cameraOff`, `#micOff`).
   */
  async #runMedia(lane: MediaLane): Promise<void> {
    const run = this.#lanes[lane];
    run.running = true;
    try {
      while (run.dirty && !this.#disposed) {
        run.dirty = false;
        const room = this.#room;
        if (room === null) return;
        const steps = mediaSteps(this.#media, this.#view.state.local, this.#refused).filter((step) => laneOf(step) === lane);
        for (const step of steps) {
          // A room joined since (`#attach`) starts from nothing: its steps are worked out afresh.
          if (this.#room !== room) break;
          if (step.kind === "camera") {
            if (step.on) this.#startCamera(room, step);
            else this.#stopCamera(room, step);
            continue;
          }
          if (step.kind === "mic") {
            if (step.on) await this.#startMic(room, step);
            else this.#stopMic(room, step);
            continue;
          }
          // A camera coming on is captured from the device it was asked on: a switch waits until it is in.
          if (step.kind === "device" && step.device === "videoinput" && this.#cameraComing !== null) continue;
          try {
            await this.#step(room, step);
            // (What a room left meanwhile took is not the new one's: `#media` is the new room's now.)
            if (this.#room === room) this.#media = afterStep(this.#media, step);
          } catch (error) {
            if (this.#room === room) this.#mediaFailed(room, step, error);
            else log(`the host's ${step.kind} did not take in a room since left`, error);
          }
        }
      }
    } finally {
      run.running = false;
    }
  }

  /**
   * Turn the camera on beside the steps, not ahead of them. The room
   * captures it and puts its background on before it publishes — a
   * permission prompt and a segmenter load, seconds maybe — and what the
   * host chooses meanwhile goes to it at once: it puts the background
   * chosen last on a camera it is starting, and stops one turned off before
   * it goes out. So the camera never goes out behind a background other than
   * the latest, or after the host turned it off. The room has the camera
   * asked of it from here; one that does not come on is put back off and
   * told, unless it was let go since.
   */
  #startCamera(room: LiveRoom, step: Extract<MediaStep, { kind: "camera" }>): void {
    const coming = room.setCamera(true, deviceOf(step.deviceId));
    this.#cameraComing = coming;
    this.#media = afterStep(this.#media, step);
    coming.then(
      () => {
        if (this.#cameraComing !== coming) return;
        this.#cameraComing = null;
        // Device names show once a camera has been allowed; a switch held for it goes now.
        void this.#reportDevices();
        this.#queueMedia();
      },
      (error: unknown) => {
        if (this.#cameraComing !== coming) {
          log("a camera let go while it came on did not start", error);
          return;
        }
        this.#cameraComing = null;
        this.#media = { ...this.#media, camera: false };
        this.#mediaFailed(room, step, error);
      },
    );
  }

  /**
   * Turn the camera off, not waiting on the room: it stops the camera at
   * once — one still coming on too, before it goes out — and unpublishes it.
   */
  #stopCamera(room: LiveRoom, step: Extract<MediaStep, { kind: "camera" }>): void {
    this.#cameraComing = null;
    this.#media = afterStep(this.#media, step);
    room.setCamera(false).catch((error: unknown) => log("the host's camera did not go off", error));
  }

  /**
   * Turn the mic on, in its lane: a device or speaker switch after it waits
   * for it. It is the room's to have from the moment it is asked, so a mic
   * off while it comes — a permission prompt, a first publish — goes to the
   * room at once (`#micOff`), and the room lets this one go: the later
   * choice wins there. One that does not come on is put back off and told,
   * unless it was turned off since.
   */
  async #startMic(room: LiveRoom, step: Extract<MediaStep, { kind: "mic" }>): Promise<void> {
    const coming = room.setMicrophone(true, deviceOf(step.deviceId));
    this.#micComing = coming;
    this.#media = afterStep(this.#media, step);
    try {
      await coming;
      if (this.#micComing !== coming) return;
      this.#micComing = null;
      // Device names show once a mic has been allowed.
      void this.#reportDevices();
    } catch (error) {
      if (this.#micComing !== coming) {
        log("a mic let go while it came on did not start", error);
        return;
      }
      this.#micComing = null;
      this.#media = { ...this.#media, mic: false };
      this.#mediaFailed(room, step, error);
    }
  }

  /** Turn the mic off, not waiting on the room or the lane: one still coming on goes out no more. */
  #stopMic(room: LiveRoom, step: Extract<MediaStep, { kind: "mic" }>): void {
    this.#micComing = null;
    this.#media = afterStep(this.#media, step);
    room.setMicrophone(false).catch((error: unknown) => log("the host's mic did not go off", error));
  }

  async #step(room: LiveRoom, step: Exclude<MediaStep, { kind: "camera" | "mic" }>): Promise<void> {
    switch (step.kind) {
      case "background":
        // The segmenter's WASM and model come from this page's own origin (live-host-window.ts serves them, the
        // renderer build puts them there); with the camera off, the room keeps the choice for when it comes on.
        if (!(await room.setBackground(step.background))) throw new BackgroundUnsupportedError();
        return;
      case "device":
        await room.switchDevice(step.device, deviceOf(step.deviceId));
        return;
    }
  }

  #mediaFailed(room: LiveRoom, step: MediaStep, error: unknown): void {
    log(`the host's ${step.kind} did not take`, error);
    if (step.kind === "device") return;
    if (step.kind === "background") {
      // That pick alone is held back: one the host made since still goes on.
      this.#refused = { ...this.#refused, background: step.background };
      const message = error instanceof BackgroundUnsupportedError ? "This Mac can't run camera backgrounds." : "The camera background didn't load. Try again.";
      // The room put the background the camera had back on it, and that is its choice again: main names that one.
      this.report({ type: "mediaFailed", kind: "background", tried: step.background, background: room.background(), error: message });
      return;
    }
    if (!step.on) return;
    this.#refused = { ...this.#refused, [step.kind]: true };
    this.report({ type: "mediaFailed", kind: step.kind, error: mediaFailure(step.kind, error) });
  }

  #watchDevices(): void {
    const media = navigator.mediaDevices as MediaDevices | undefined;
    if (media === undefined) return;
    const changed = (): void => void this.#reportDevices();
    media.addEventListener("devicechange", changed);
    this.#unwatchDevices = () => media.removeEventListener("devicechange", changed);
    changed();
  }

  async #reportDevices(): Promise<void> {
    let all: MediaDeviceInfo[];
    try {
      all = await navigator.mediaDevices.enumerateDevices();
    } catch (error) {
      log("could not list the media devices", error);
      return;
    }
    const devices: LiveMediaDevice[] = all
      .filter((device) => device.deviceId !== "" && (device.kind === "audioinput" || device.kind === "videoinput" || device.kind === "audiooutput"))
      .slice(0, 64)
      .map((device) => ({ kind: device.kind, deviceId: device.deviceId.slice(0, 1000), label: device.label.slice(0, 200) }));
    this.report({ type: "devices", devices });
  }

  /* ---------------------------------- helpers ---------------------------------- */

  #tool(): LiveTool {
    return this.#view.state.drawing?.tool ?? "pointer";
  }

  #colorOf(identity: string): string {
    return this.#view.participants.find((participant) => participant.identity === identity)?.color ?? "#8B8D98";
  }

  #update(patch: Partial<HostView>): void {
    const next = { ...this.#view, ...patch };
    const keys = Object.keys(patch) as Array<keyof HostView>;
    if (keys.every((key) => next[key] === this.#view[key])) return;
    this.#view = next;
    for (const listener of this.#listeners) listener();
  }
}
