import { HOST_COLOR, LIVE_REACTIONS, MAX_CHAT_HISTORY, MAX_CHAT_LENGTH, RateLimiter, sanitizeName } from "@pistachio/live-share";
import type { CursorPoint } from "@pistachio/shell-contracts/ipc";
import {
  idleLiveShare,
  sameBackgroundChoice,
  type LiveCommand,
  type LiveDeskReport,
  type LiveDeviceKind,
  type LiveDrawing,
  type LiveEndReason,
  type LiveGuest,
  type LiveHostConfig,
  type LiveHostEvent,
  type LiveHostReport,
  type LiveRect,
  type LiveShareState,
} from "@pistachio/shell-contracts/live-share";
import { ControlError } from "../account/control-client";
import { describeLiveError, liveShareEnded, type LiveControl, type LiveShareSettings } from "./live-control";
import { LiveCursorPoll } from "./live-cursor";
import { deskFrame, LiveDeskFrames, shellMarkOf, type LiveWindowFacts } from "./live-desk";
import { LiveInputGate, type LiveInputTarget } from "./live-input";
import {
  DEFAULT_LIVE_SHARE_PREFS,
  deviceToKeep,
  LIVE_DEVICE_KINDS,
  restoredDevices,
  samePrefs,
  startingChoices,
  type LivePrefsFile,
  type LiveSharePrefs,
} from "./live-prefs";

/**
 * The one owner of this Mac's live share (docs/live-share.md §6.1). It holds
 * `LiveShareState` and publishes it (coalesced, on its own channel), answers
 * the shell's commands, talks to control (the share, the lobby, heartbeats,
 * tokens), runs the live-host window that holds the room, turns the shell's
 * desk reports into frames, lets guests' input through to the pages they may
 * use, and ends the share when its space, its Profile or its window goes.
 *
 * Pure of Electron: the browser, the window and control come in as the
 * narrow interfaces below, so test/live-service.test.ts drives it all.
 */

/** Every 60 s while live: control ends a share it has not heard from in 10 min. */
export const LIVE_HEARTBEAT_MS = 60_000;
/** While knocking is how people get in, the lobby is read this often, so no knock is missed. */
export const LIVE_KNOCK_POLL_MS = 15_000;
/** A lobby read that failed while someone in the room waits on it to be let in is tried again this soon. */
export const LIVE_LOBBY_RETRY_MS = 2_000;
/** A removal control did not confirm is asked again this soon, then twice as long after each failure… */
export const LIVE_REMOVE_RETRY_MS = 1_000;
/** …but never longer apart than this. */
export const LIVE_REMOVE_RETRY_MAX_MS = 30_000;
/** How long quitting, or this Mac's account leaving it, waits for control to hear the share ended. */
export const LIVE_END_WAIT_MS = 1_500;
/** At most this many asks to use a window wait at once. */
const MAX_ASKS = 32;
/** Control's lobby holds 30 knocks. */
const MAX_KNOCKS = 30;
/** A share's title, as control takes it. */
const MAX_TITLE = 200;
/** What control strips from a title: control characters, and the bidi marks, embeddings, overrides and isolates. */
const UNPRINTABLE = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
/** With the last guest gone, the shared windows stay held awake this long (someone reloading, or the next guest a moment behind). */
export const LIVE_HOLD_GRACE_MS = 30_000;
/** A new name for the share goes to control once it has stood this long (a Home space's is its page's title, which may tick). */
export const LIVE_RETITLE_MS = 2_000;

/** A space as the share needs it. */
export interface LiveSpace {
  title: string;
  /** #rrggbb. */
  color: string;
  /** Its Profile. */
  spaceId: string;
}

/** What the share needs of the browser. */
export interface LiveBrowser extends LiveInputTarget {
  /** The space (tab group), or null once it is gone. */
  space(groupId: string): LiveSpace | null;
  /** The active Profile, and its current space. */
  current(): { spaceId: string; groupId: string | null };
  /** The browser's window is up: visible, not minimized. */
  windowShown(): boolean;
  /** What a window of the space shows, or null when it is not one of the space's. */
  facts(windowId: string, groupId: string): LiveWindowFacts | null;
  /**
   * The space shared (null: none), which Tidy leaves alone as it does the one
   * in front, and the tabs to keep awake — woken if asleep, their pages laid
   * out at their sizes on the desk (DIP) though not shown (none: let them go).
   */
  hold(groupId: string | null, tabs: readonly LiveHeldTab[]): void;
}

/** A streamed window's tab and its page's size on the shared desk. */
export interface LiveHeldTab {
  tabId: string;
  width: number;
  height: number;
}

/** The live-host window, as the share drives it. */
export interface LiveHostPort {
  send(event: LiveHostEvent): void;
  setInteractive(active: boolean): void;
  setDrawing(drawing: boolean): void;
  close(): void;
}

export interface LiveShareDeps {
  /** The account's control for live shares; rejects (LiveUnavailableError) with words for the person when there is none. */
  control(): Promise<LiveControl>;
  browser: LiveBrowser;
  /** Open the live-host window; its app asks `hostConfig` as it starts. */
  openHost(): LiveHostPort;
  writeClipboard(text: string): void;
  /** The share changed (coalesced): to the shell. */
  publish(state: LiveShareState): void;
  /** Only the guests' speaking or connection changed: to the shell, the guests alone (`onLiveRoster`). */
  publishRoster(participants: LiveGuest[]): void;
  /** The pill was pressed: the shell opens the Live card. */
  openCard(): void;
  /** The OS pointer in the window's content box, or null when it cannot be read. */
  pointer(): CursorPoint | null;
  /** Who the host is to guests when the shell names nobody: read off the Mac's own name (live-host-name.ts). */
  hostName?: () => Promise<string | null>;
  /** The host's choices kept between shares (live-prefs.ts); without it, every share starts as the first. */
  prefs?: LivePrefsFile;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

interface Share {
  shareId: string;
  groupId: string;
  /** The space's Profile: a switch to another ends the share. */
  spaceId: string;
  link: string;
  livekit: { url: string; token: string };
  /** The host's name in the room, as the share was made with it. */
  hostName: string;
  /** The share's title as the host gives it: the space's name, once it has stood a moment (#retitle). */
  title: string;
  /** The space's name as last seen, and the wait for it to stand before control hears it. */
  named: string;
  retitle: ReturnType<typeof setTimeout> | null;
  /**
   * What control was last asked to hold of the host's choices (the card's
   * admission, the title), or said it holds (#reconcile): an update sends
   * what differs from it.
   */
  sent: LiveShareSettings;
  /** The update in flight: one at a time (#update). */
  updating: Promise<void> | null;
  /** Updates sent so far: a read that crossed one cannot say what control holds. */
  updates: number;
  control: LiveControl;
  host: LiveHostPort;
  frames: LiveDeskFrames;
  heartbeat: ReturnType<typeof setInterval>;
  knockPoll: ReturnType<typeof setInterval> | null;
  /** The lobby read in flight: reads go one at a time. */
  lobbyRead: Promise<void> | null;
  /** Asked for a read while one was in flight: one more follows it, as the news may be newer than that read. */
  lobbyAgain: boolean;
  /** The read again after one failed while someone waited on it. */
  lobbyRetry: ReturnType<typeof setTimeout> | null;
}

export class LiveShareService {
  readonly #deps: LiveShareDeps;
  readonly #now: () => number;
  readonly #cursor: LiveCursorPoll;
  readonly #input: LiveInputGate;
  /** A guest's chat and asks: a flood loses its own excess. */
  readonly #messages = new RateLimiter({ rate: 5, burst: 10 });
  #state: LiveShareState = idleLiveShare();
  #share: Share | null = null;
  /** Bumped by every start and end: a start that was overtaken drops what it made. */
  #serial = 0;
  #ending: Promise<void> | null = null;
  #report: LiveDeskReport | null = null;
  /** The windows of the last frame built, as guests' input is checked against them (`streamed`: a tab's page, captured). */
  /** The shared desk's windows as the last frame had them: `streamed`, one guests' hands may reach (a page or a terminal) that streams. */
  #windows = new Map<string, { page: boolean; streamed: boolean; minimized: boolean; masked: boolean; paused: boolean }>();
  /** The streamed pages' tabs and sizes, as the last frame has them. */
  #streamed: LiveHeldTab[] = [];
  /** A shell-drawn window of the last frame streams: its picture is cut from the shell's own (§6.6). */
  #shellStreamed = false;
  /** What the browser was last told to hold; null before it was told anything of this share. */
  #heldSent: LiveHeldTab[] | null = null;
  /** The streamed tabs are held awake: guests are in the room, or the last left less than 30 s ago. */
  #holding = false;
  #holdGrace: ReturnType<typeof setTimeout> | null = null;
  /** The guests in the room as the host app last reported them, removed ones and all. */
  #roster: LiveGuest[] = [];
  /**
   * Who the host removed, or control said it no longer lets in (left, removed,
   * denied): for the share's life they are never one of the room's, and seen
   * in it again they are shown out again — LiveKit refreshes a participant's
   * token as it joins, and removing them does not revoke it.
   */
  readonly #removed = new Set<string>();
  /**
   * The removals under way, each until control confirms it: asked now (null)
   * or waiting to be asked again (the wait), so a roster or a lobby read that
   * still lists them asks nothing more meanwhile.
   */
  readonly #removing = new Map<string, ReturnType<typeof setTimeout> | null>();
  /**
   * Guests who came into the room and wait on a lobby read to say whether
   * control let them in, each by the count of their coming: a read judges only
   * a coming it set out after (an admit may still be on its way to control).
   */
  readonly #joined = new Map<string, number>();
  #comings = 0;
  /**
   * Guests in the room that control lists as let in, by a read that set out
   * after they came, each by the count of that coming: only they, less anyone
   * removed, are the share's guests. Every read that set out after that
   * coming judges them again — one that does not list them has them out
   * (control let them go: they left, or the sweep found them gone, and LiveKit
   * may still have them). Someone who leaves the room waits on a read again
   * when they are back.
   */
  readonly #letIn = new Map<string, number>();
  /** The identities the host app was last told may receive the room. */
  #admittedSent: string[] = [];
  #hostPresent = false;
  #stage: LiveRect | null = null;
  /** What of the window the notice stack's cards cover now (main/notice-layer.ts), or null. */
  #notices: LiveRect | null = null;
  /** What of the browser's own lies over the desk, as the host app was told (or is told as it starts): `#placeChrome`. */
  #chrome: LiveRect[] | null = [];
  #chatCount = 0;
  /** Knocks the host answered: a lobby read that left before control heard the answer does not bring them back. */
  readonly #decided = new Set<string>();
  #publishQueued = false;
  /** The state as the shell last had it whole: a change to the guests' voices alone goes as the roster. */
  #published: LiveShareState | null = null;
  /** The share control is making now, if any: shares are made one at a time (#start). */
  #making: Promise<void> = Promise.resolve();
  /** The host's choices as last made, kept for the next share (live-prefs.ts). */
  #prefs: LiveSharePrefs;
  /**
   * The kinds of device this share has yet to take up as kept: it starts on
   * the system's default, and takes each up once the host app lists it — by
   * id, else by label — unless the host picks one of that kind first.
   */
  #devicesToRestore = new Set<LiveDeviceKind>();

  constructor(deps: LiveShareDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#prefs = deps.prefs?.read() ?? structuredClone(DEFAULT_LIVE_SHARE_PREFS);
    this.#cursor = new LiveCursorPoll(deps.pointer, (at) => this.#share?.host.send({ type: "pointer", at }));
    this.#input = new LiveInputGate(
      {
        isGuest: (identity) => this.#state.participants.some((guest) => guest.identity === identity),
        allowed: (windowId) => this.#state.controllable.includes(windowId),
        window: (windowId) => this.#windows.get(windowId) ?? null,
        hostPresent: () => this.#hostPresent,
      },
      deps.browser,
      (windowId, identity) => this.#use(windowId, identity),
      this.#now,
    );
  }

  /** The share as it stands. */
  get state(): LiveShareState {
    return this.#state;
  }

  /** A share is being started, is live, or is ending. */
  get active(): boolean {
    return this.#state.status === "starting" || this.#state.status === "live" || this.#state.status === "ending";
  }

  async command(command: LiveCommand): Promise<void> {
    if (command.type === "start") return this.#start(command.groupId, command.hostName);
    if (command.type === "stop") {
      // (A share that could not start is put away: nothing to end.)
      if (this.#state.status === "error") {
        this.#state = idleLiveShare();
        this.#changed();
        return;
      }
      return this.#end("stopped");
    }
    const share = this.#share;
    if (share === null || this.#state.status !== "live") return;
    switch (command.type) {
      case "admit":
      case "deny": {
        const { requestId } = command;
        const knock = this.#state.knocks.find((candidate) => candidate.requestId === requestId);
        this.#set({ knocks: this.#state.knocks.filter((candidate) => candidate.requestId !== requestId), error: null });
        this.#decided.add(requestId);
        // Not decided after all (the share full, control unreachable): the knock is back at the door and the error says why.
        // One control does not know (stale, or never control's) is not: the lobby is read again instead.
        const undecided = (error: unknown): void => {
          this.#decided.delete(requestId);
          if (knock === undefined || (error instanceof ControlError && error.status === 404)) return;
          if (this.#state.knocks.some((candidate) => candidate.requestId === requestId) || this.#roster.some((guest) => guest.identity === guestIdentity(requestId))) return;
          this.#set({ knocks: [...this.#state.knocks, knock].sort((a, b) => a.at - b.at) });
        };
        const decided = await this.#ask(share, () => share.control.decide(share.shareId, requestId, command.type), undecided);
        if (decided && command.type === "deny") this.#removed.add(guestIdentity(requestId));
        return;
      }
      case "remove": {
        // Out of the room for the host at once — no input, no chat, nothing sent them — whatever control and LiveKit make of it.
        this.#removed.add(command.identity);
        const asked = this.#showOut(share, command.identity, true);
        this.#applyRoster(share);
        await asked;
        return;
      }
      case "setAdmission":
        if (this.#state.admission === command.admission) return;
        this.#set({ admission: command.admission, error: null });
        this.#keep({ admission: command.admission });
        this.#pollKnocks(share);
        await this.#update(share);
        return;
      case "setGuestsCanDraw":
        this.#set({ guestsCanDraw: command.allowed });
        this.#keep({ guestsCanDraw: command.allowed });
        // Guests learn it from the desk (their pens are put away).
        this.#buildFrame();
        return;
      case "setControllable":
        this.#setControllable(command.windowId, command.allowed);
        return;
      case "answerAsk":
        if (command.allow) this.#setControllable(command.windowId, true);
        else this.#set({ asks: this.#state.asks.filter((ask) => ask.identity !== command.identity || ask.windowId !== command.windowId) });
        return;
      case "setMic":
        this.#set({ local: { ...this.#state.local, mic: command.on } });
        this.#keep({ mic: command.on });
        return;
      case "setCamera":
        this.#set({ local: { ...this.#state.local, camera: command.on } });
        this.#keep({ camera: command.on });
        return;
      case "setBackground":
        this.#set({ local: { ...this.#state.local, background: command.background } });
        this.#keep({ background: command.background });
        return;
      case "setDevice":
        // (The host's pick: the kept one of this kind is not taken up over it.)
        this.#devicesToRestore.delete(command.kind);
        this.#set({ local: { ...this.#state.local, devices: { ...this.#state.local.devices, [command.kind]: command.deviceId } } });
        this.#keep({ devices: { ...this.#prefs.devices, [command.kind]: deviceToKeep(this.#state.devices, this.#prefs.devices[command.kind], command.kind, command.deviceId) } });
        return;
      case "setDrawing":
        this.#setDrawing(command.drawing);
        return;
      case "clearInk":
        share.host.send({ type: "clearInk" });
        return;
      case "chat":
        this.#hostChat(share, command.text);
        return;
      case "react":
        if ((LIVE_REACTIONS as readonly string[]).includes(command.emoji)) share.host.send({ type: "react", emoji: command.emoji });
        return;
      case "markRead":
        if (this.#state.unread !== 0) this.#set({ unread: 0 });
        return;
      case "copyLink":
        this.#deps.writeClipboard(share.link);
        return;
    }
  }

  /** The shell's report of the shared space's desk. */
  setDesk(report: LiveDeskReport | null): void {
    // (None at all is a shell whose desk went: guests keep the desk as it last was, its shell-drawn windows held.)
    if (report === null) {
      this.shellLoading();
      return;
    }
    if (this.#share === null || report.groupId !== this.#share.groupId) return;
    this.#report = report;
    this.#placeStage();
    this.#placeChrome();
    this.#buildFrame();
  }

  /** What of the window the notice stack's cards cover now (window content px), or null: the outlines go under them too. */
  setNoticeCover(rect: LiveRect | null): void {
    if (sameRect(rect, this.#notices)) return;
    this.#notices = rect === null ? null : { ...rect };
    this.#placeChrome();
  }

  /**
   * The shell's page is loading (a reload, back from a crash), or its desk
   * went: until it reports the desk again, what it shows is no window's
   * picture, so every shell-drawn window is held (§6.6).
   */
  shellLoading(): void {
    if (this.#share === null || this.#report === null || this.#report.shellCovered) return;
    this.#report = { ...this.#report, shellCovered: true };
    this.#placeChrome();
    this.#buildFrame();
  }

  /**
   * Something the share stands on may have changed — the tabs and spaces, the
   * space in front, the window shown or put away: the share ends if its space
   * or Profile went, and otherwise follows.
   */
  refresh(): void {
    const share = this.#share;
    if (share === null || this.#state.status !== "live") return;
    const space = this.#deps.browser.space(share.groupId);
    if (space === null) {
      void this.#end("space-closed");
      return;
    }
    const current = this.#deps.browser.current();
    if (current.spaceId !== share.spaceId) {
      void this.#end("profile-switched");
      return;
    }
    this.#hostPresent = current.groupId === share.groupId && this.#deps.browser.windowShown();
    if (this.#state.hostAway === this.#hostPresent) this.#set({ hostAway: !this.#hostPresent });
    // (Away, guests' hands are off every window: what they held down is let go.)
    this.#input.releaseWithdrawn();
    this.#retitle(share, space.title);
    this.#placeStage();
    this.#syncCursor();
    this.#buildFrame();
  }

  /** What the live-host app starts from; null once the share is over. */
  hostConfig(): LiveHostConfig | null {
    const share = this.#share;
    if (share === null || this.#state.status !== "live") return null;
    return {
      livekit: { ...share.livekit },
      shareId: share.shareId,
      state: this.#state,
      frame: share.frames.latest,
      shell: share.frames.latestShell,
      stage: this.#stage,
      chrome: this.#chrome === null ? null : this.#chrome.map((rect) => ({ ...rect })),
      admitted: [...this.#admittedSent],
    };
  }

  /** The live-host app's news. */
  hostReport(report: LiveHostReport): void {
    const share = this.#share;
    if (share === null || this.#state.status !== "live") return;
    switch (report.type) {
      case "connection": {
        const was = this.#state.connection;
        // A failure says why; back in the room, it is over.
        this.#set({ connection: report.state, error: report.state === "connected" ? null : (report.error ?? this.#state.error) });
        // Back in the room after a drop: a knock sent meanwhile may have been missed.
        if (report.state === "connected" && was === "reconnecting") void this.#readLobby(share);
        return;
      }
      case "roster":
        this.#setGuests(share, report.guests);
        return;
      case "chat":
        this.#guestChat(report.from, report.id, report.text);
        return;
      case "input":
        this.#input.apply(report.from, report.windowId, report.event);
        return;
      case "ask":
        this.#guestAsk(report.from, report.windowId);
        return;
      case "knock":
        this.#knock(share, report.requestId);
        return;
      case "interactive":
        share.host.setInteractive(report.active);
        return;
      case "drawEnded":
        this.#setDrawing(null);
        return;
      case "openCard":
        this.#deps.openCard();
        return;
      case "command":
        // (The app's own controls steer the share; they never start one.)
        if (report.command.type !== "start") void this.command(report.command);
        return;
      case "devices": {
        this.#set({ devices: report.devices });
        // The kept devices this share has yet to take up, now that the app says what it can open (it may list more,
        // or name them, once it may use the mic and camera: a kind not there yet waits for the next list).
        const restored = restoredDevices(this.#prefs, report.devices, this.#devicesToRestore);
        const kinds = Object.keys(restored) as LiveDeviceKind[];
        if (kinds.length === 0) return;
        for (const kind of kinds) this.#devicesToRestore.delete(kind);
        this.#set({ local: { ...this.#state.local, devices: { ...this.#state.local.devices, ...restored } } });
        return;
      }
      case "tokenExpiring":
        // A fresh token asked for, and answered whatever control says: the room waits on one to join again with.
        void this.#beat(share, true).then(() => {
          if (this.#share === share) share.host.send({ type: "token", token: share.livekit.token });
        });
        return;
      case "mediaFailed": {
        // What did not take shows as it is, with why: off, or the background the camera shows instead (the one it had).
        // A background pick the host has replaced since is let go: the newer one is on its way, and answers for itself.
        const local = this.#state.local;
        if (report.kind === "background" && !sameBackgroundChoice(local.background, report.tried)) return;
        const back = report.kind === "background" ? { ...local, background: report.background } : report.kind === "mic" ? { ...local, mic: false } : { ...local, camera: false };
        this.#set({ local: back, error: report.error });
        return;
      }
      case "captureStalled":
        this.#log(`the capture of ${report.windowId} brought no picture (its page may never have been laid out)`);
        return;
    }
  }

  /** The live-host app may capture this tab: a page window of the shared desk that streams. */
  streams(tabId: string): boolean {
    const window = this.#windows.get(tabId);
    return this.#share !== null && window?.page === true && window.streamed;
  }

  /**
   * The live-host app may capture the shell's own page, to cut the
   * shell-drawn windows' pictures from (§6.6): a share is live, the host is
   * on the shared space (the shell shows its desk), and one of them streams.
   */
  shellStreams(): boolean {
    return this.#share !== null && this.#state.status === "live" && this.#hostPresent && this.#shellStreamed;
  }

  /** A tab's page is a new one (woken, back from a crash): the app captures it again. */
  pageReplaced(tabId: string): void {
    if (this.streams(tabId)) this.#share?.host.send({ type: "capture", windowId: tabId });
  }

  /** The live-host window went on its own (its renderer died): the share cannot go on. */
  hostGone(): void {
    void this.#end("failed");
  }

  /** The browser's window closed. */
  windowClosed(): void {
    void this.#end("window-closed");
  }

  /** The app is quitting: end the share, waiting a moment at most for control to hear it. */
  async quit(): Promise<void> {
    await Promise.race([this.#end("quit"), new Promise<void>((resolve) => setTimeout(resolve, LIVE_END_WAIT_MS))]);
    // However control fared, the share is over for this process: the quit it held up goes on.
    if (this.active) this.#state = { ...idleLiveShare(), ended: "quit" };
  }

  /**
   * This Mac's account is about to leave it — signed out, another account's
   * token put in its place, this Mac revoked — or control has stopped
   * honouring it. The share is that account's: control answers anyone
   * else's token 404, so a share left on would be read as ended elsewhere
   * and never told to end, its room keeping its guests until control found
   * it silent (§5). It ends now, control told while the account still speaks
   * for it (the request takes the token it goes out with); a share control
   * is still making ends as it lands. Waits a moment at most: the change goes
   * on either way.
   */
  async accountChanging(): Promise<void> {
    const ended = this.#end("account-changed");
    await Promise.race([Promise.all([ended, this.#making]), new Promise<void>((resolve) => setTimeout(resolve, LIVE_END_WAIT_MS))]);
  }

  /* -------------------------------- lifecycle -------------------------------- */

  async #start(groupId: string, hostName: string | undefined): Promise<void> {
    const current = this.#share;
    if (current !== null && current.groupId === groupId && this.#state.status === "live") {
      // Shared already: the link again, as a fresh share would put it.
      this.#deps.writeClipboard(current.link);
      return;
    }
    if (this.active) await this.#end("stopped");
    const space = this.#deps.browser.space(groupId);
    if (space === null) {
      this.#state = { ...idleLiveShare(), status: "error", error: "That space is gone." };
      this.#changed();
      return;
    }
    const serial = ++this.#serial;
    // The host's choices as they last made them (live-prefs.ts): who can join, drawing, their mic, camera and
    // background; the devices on the system's default until the host app lists the kept ones.
    this.#state = { ...idleLiveShare(), ...startingChoices(this.#prefs), status: "starting", groupId };
    this.#devicesToRestore = new Set(LIVE_DEVICE_KINDS.filter((kind) => this.#prefs.devices[kind] !== null));
    this.#changed();
    let control: LiveControl;
    let created: Awaited<ReturnType<LiveControl["create"]>>;
    // The name guests see, as control keeps names (one line, 1–40 characters); one it would refuse is left out.
    let name: string | null = null;
    try {
      control = await this.#deps.control();
      const given = hostName ?? (await this.#deps.hostName?.().catch(() => null)) ?? null;
      name = given === null ? null : sanitizeName(given);
      // One share is made at a time: control ends this Mac's last share as it makes the next, so one still being
      // made for a start stopped meanwhile must land first — made after this one, it would end this one.
      await this.#making;
      if (serial !== this.#serial) return;
      const making = control.create({ title: shareTitle(space.title), ...(name === null ? {} : { hostName: name }) });
      this.#making = making.then(
        () => undefined,
        () => undefined,
      );
      created = await making;
    } catch (error) {
      if (serial !== this.#serial) return;
      this.#state = { ...idleLiveShare(), status: "error", groupId, error: describeLiveError(error) };
      this.#changed();
      return;
    }
    const endMade = (): void => void control.end(created.shareId).catch((error: unknown) => this.#log("could not end a share that never went live", error));
    if (serial !== this.#serial) {
      // Stopped while control was making it: it ends at once.
      endMade();
      return;
    }
    let host: LiveHostPort;
    try {
      host = this.#deps.openHost();
    } catch (error) {
      this.#log("could not open the live-host window", error);
      endMade();
      this.#state = { ...idleLiveShare(), status: "error", groupId, error: "The share couldn't start on this Mac." };
      this.#changed();
      return;
    }
    const share: Share = {
      shareId: created.shareId,
      groupId,
      spaceId: space.spaceId,
      link: created.link,
      livekit: created.livekit,
      hostName: name ?? "Host",
      title: shareTitle(space.title),
      named: shareTitle(space.title),
      retitle: null,
      sent: { admission: created.admission, title: shareTitle(space.title) },
      updating: null,
      updates: 0,
      control,
      host,
      frames: new LiveDeskFrames((frame, shell) => this.#share?.host.send({ type: "desk", frame, shell }), this.#now),
      heartbeat: setInterval(() => void this.#heartbeat(share), LIVE_HEARTBEAT_MS),
      knockPoll: null,
      lobbyRead: null,
      lobbyAgain: false,
      lobbyRetry: null,
    };
    this.#share = share;
    this.#chatCount = 0;
    this.#hostPresent = false;
    // Who can join is the host's kept choice; control made the share as it makes every one (knocking), so one kept
    // otherwise goes to control at once — `#update` sends what differs from `sent`, and if control refuses, puts
    // the card back to what control holds and says why.
    this.#state = { ...this.#state, status: "live", shareId: share.shareId, link: share.link, admission: this.#state.admission, startedAt: this.#now() };
    this.#deps.writeClipboard(share.link);
    // (Nothing held awake yet — no guest is in — but the space is the share's: Tidy leaves it be.)
    this.#hold(share);
    this.#pollKnocks(share);
    this.refresh();
    this.#changed();
    void this.#update(share);
  }

  /** Keep a choice the host just made, for the next share: written at once, and a write that fails is only logged. */
  #keep(change: Partial<LiveSharePrefs>): void {
    const next = { ...this.#prefs, ...change };
    if (samePrefs(next, this.#prefs)) return;
    this.#prefs = next;
    try {
      this.#deps.prefs?.write(next);
    } catch (error) {
      this.#log("could not keep the share's settings for the next one", error);
    }
  }

  /** End the share: the window goes at once, then control hears of it (unless control said so first). */
  async #end(reason: LiveEndReason): Promise<void> {
    if (this.#ending !== null) return this.#ending;
    if (!this.active) return;
    ++this.#serial;
    const share = this.#share;
    this.#share = null;
    if (share === null) {
      // Still starting: the start sees the serial move on and ends what control made.
      this.#state = { ...idleLiveShare(), ended: reason };
      this.#changed();
      return;
    }
    clearInterval(share.heartbeat);
    if (share.knockPoll !== null) clearInterval(share.knockPoll);
    if (share.retitle !== null) clearTimeout(share.retitle);
    if (share.lobbyRetry !== null) clearTimeout(share.lobbyRetry);
    if (this.#holdGrace !== null) clearTimeout(this.#holdGrace);
    this.#holdGrace = null;
    share.frames.dispose();
    this.#cursor.setActive(false);
    this.#cursor.setStage(null);
    share.host.send({ type: "end" });
    share.host.close();
    this.#deps.browser.hold(null, []);
    this.#streamed = [];
    this.#shellStreamed = false;
    this.#heldSent = null;
    this.#holding = false;
    this.#report = null;
    this.#placeChrome();
    this.#windows = new Map();
    this.#stage = null;
    this.#hostPresent = false;
    // Whatever guests held down on a page is let go before they go.
    this.#input.releaseWithdrawn();
    this.#decided.clear();
    this.#roster = [];
    this.#removed.clear();
    for (const wait of this.#removing.values()) if (wait !== null) clearTimeout(wait);
    this.#removing.clear();
    this.#joined.clear();
    this.#letIn.clear();
    this.#admittedSent = [];
    this.#state = { ...this.#state, status: "ending" };
    this.#changed();
    const told = reason === "ended-elsewhere" ? Promise.resolve() : share.control.end(share.shareId).catch((error: unknown) => this.#log("could not end the share", error));
    this.#ending = (async () => {
      await told;
      this.#state = { ...idleLiveShare(), ended: reason };
      this.#ending = null;
      this.#changed();
    })();
    return this.#ending;
  }

  /* ---------------------------------- control --------------------------------- */

  /**
   * A request to control on the share's behalf; a failure is the state's
   * error (what was assumed of it put back first, `undo`), and control saying
   * the share is over ends it.
   */
  async #ask(share: Share, request: () => Promise<void>, undo?: (error: unknown) => void): Promise<boolean> {
    try {
      await request();
      return true;
    } catch (error) {
      if (this.#share !== share) return false;
      // (A knock answered twice: the first answer stands.)
      if (error instanceof ControlError && error.code === "live_not_pending") return true;
      undo?.(error);
      // Not found may be the request or the guest, not the share — a knock
      // that was stale, or never control's: the share itself is read, and it
      // ends only if control says so there.
      if (error instanceof ControlError && error.status === 404) await this.#readLobby(share);
      else if (liveShareEnded(error)) void this.#end("ended-elsewhere");
      else this.#set({ error: describeLiveError(error) });
      return false;
    }
  }

  /**
   * Bring control to the host's choices — who may join, the share's name —
   * one update at a time, each sending what the host chose since the last
   * went out: two on their way at once may be applied out of order, leaving
   * control letting anyone in while the card says Ask me. Chosen again
   * meanwhile, only the newest of each goes, after. An admission control did
   * not take puts the card back on what it holds, whatever was picked since,
   * and says why (#ask); a rename that failed is only logged — the next read
   * finds control without it and sends it again (#reconcile).
   */
  #update(share: Share): Promise<void> {
    if (share.updating !== null) return share.updating;
    if (this.#changes(share) === null) return Promise.resolve();
    // (Something to send, so the loop awaits before it lets go of `updating`.)
    share.updating = (async () => {
      for (;;) {
        const patch = this.#changes(share);
        if (patch === null || this.#share !== share) break;
        const before = share.sent;
        share.sent = { ...before, ...patch };
        share.updates += 1;
        const request = (): Promise<void> => share.control.update(share.shareId, patch);
        if (patch.admission === undefined) {
          await request().catch((error: unknown) => this.#log("could not rename the share", error));
          continue;
        }
        await this.#ask(share, request, () => {
          share.sent = { ...share.sent, admission: before.admission };
          if (this.#state.admission === before.admission) return;
          this.#set({ admission: before.admission });
          this.#pollKnocks(share);
        });
      }
      share.updating = null;
    })();
    return share.updating;
  }

  /** What the host chose of the share since control was last asked; null for nothing. */
  #changes(share: Share): Partial<LiveShareSettings> | null {
    const patch: Partial<LiveShareSettings> = {
      ...(this.#state.admission === share.sent.admission ? {} : { admission: this.#state.admission }),
      ...(share.title === share.sent.title ? {} : { title: share.title }),
    };
    return patch.admission === undefined && patch.title === undefined ? null : patch;
  }

  /**
   * What a read (the lobby, a heartbeat) notes as it sets out: the updates
   * sent so far, or null while one is on its way — control may answer the
   * read before it applies the update.
   */
  #readSince(share: Share): number | null {
    return share.updating === null ? share.updates : null;
  }

  /**
   * Control's word on the host's choices, from a read that set out with no
   * update on its way and saw none go since: where it holds another (an
   * update main took for failed that landed after all, a rename it never
   * took), the host's choice goes again. Never the other way: only this Mac
   * changes the share, and the card is what the host goes by.
   */
  #reconcile(share: Share, held: LiveShareSettings | undefined, since: number | null): void {
    if (held === undefined || since === null || since !== share.updates || this.#share !== share) return;
    share.sent = held;
    void this.#update(share);
  }

  /**
   * Still hosting; a fresh token, when control gives one, is the room's
   * (`token`). With `refresh`, one is asked for whatever control's record
   * says: the answer that brought the last may have been lost, and control
   * would then give none until the token it minted nears its end, hours
   * after the one held ran out.
   */
  async #beat(share: Share, refresh = false): Promise<void> {
    const since = this.#readSince(share);
    try {
      const { token, settings } = await share.control.heartbeat(share.shareId, refresh ? { refresh } : undefined);
      if (this.#share !== share) return;
      if (token !== null) share.livekit = { ...share.livekit, token };
      this.#reconcile(share, settings, since);
    } catch (error) {
      if (this.#share !== share) return;
      // Offline for a while is not over: control waits 10 minutes for a heartbeat.
      if (liveShareEnded(error)) void this.#end("ended-elsewhere");
      else this.#log("heartbeat failed", error);
    }
  }

  /**
   * The minute's heartbeat: a fresh token goes to the room as it comes. With
   * anyone free to join no knock poll reads the lobby, so the beat reads it
   * while anyone is let in: someone control let go since (left, or found gone)
   * whom LiveKit still has, or who is back under the same identity before the
   * room said they left, is shown out within the minute.
   */
  async #heartbeat(share: Share): Promise<void> {
    if (share.knockPoll === null && this.#letIn.size > 0) void this.#readLobby(share);
    const held = share.livekit.token;
    await this.#beat(share);
    if (this.#share === share && share.livekit.token !== held) share.host.send({ type: "token", token: share.livekit.token });
  }

  /** While knocking is how people get in, read the lobby now and every 15 s. */
  #pollKnocks(share: Share): void {
    if (share.knockPoll !== null) clearInterval(share.knockPoll);
    share.knockPoll = null;
    if (this.#state.admission !== "ask") return;
    share.knockPoll = setInterval(() => void this.#readLobby(share), LIVE_KNOCK_POLL_MS);
    void this.#readLobby(share);
  }

  /** Read the share and its lobby, one read at a time; asked again meanwhile, one more read follows. */
  #readLobby(share: Share): Promise<void> {
    if (share.lobbyRead !== null) {
      share.lobbyAgain = true;
      return share.lobbyRead;
    }
    share.lobbyRead = (async () => {
      do {
        share.lobbyAgain = false;
        await this.#readLobbyOnce(share);
      } while (share.lobbyAgain && this.#share === share);
      share.lobbyRead = null;
    })();
    return share.lobbyRead;
  }

  async #readLobbyOnce(share: Share): Promise<void> {
    // Whoever came into the room before this read set out, waiting or let in: what it says of them is news since they came.
    const asked = new Map([...this.#joined, ...this.#letIn]);
    const since = this.#readSince(share);
    let lobby: Awaited<ReturnType<LiveControl["get"]>>;
    try {
      lobby = await share.control.get(share.shareId);
    } catch (error) {
      if (this.#share !== share) return;
      if (liveShareEnded(error)) void this.#end("ended-elsewhere");
      else {
        this.#log("could not read who is knocking", error);
        this.#readAgainSoon(share);
      }
      return;
    }
    if (this.#share !== share) return;
    if (lobby.ended) {
      void this.#end("ended-elsewhere");
      return;
    }
    this.#reconcile(share, lobby.settings, since);
    this.#checkAdmitted(share, asked, lobby.admitted);
    // A removed guest back under the same identity before the room said they
    // left is no news to the room's roster, which reports them again only once
    // LiveKit makes them active: every read shows out whoever removed it still lists.
    this.#showOutRemoved(share);
    const inRoom = new Set(this.#state.participants.map((guest) => guest.identity));
    const known = new Map(this.#state.knocks.map((knock) => [knock.requestId, knock]));
    const read = lobby.knocks.filter((knock) => !inRoom.has(guestIdentity(knock.requestId)) && !this.#decided.has(knock.requestId));
    const knocks = read.slice(0, MAX_KNOCKS).map((knock) => known.get(knock.requestId) ?? { ...knock, at: this.#now() });
    if (!sameKnocks(knocks, this.#state.knocks)) this.#set({ knocks });
  }

  /* ---------------------------------- the room --------------------------------- */

  /**
   * A knock heard through the room is news that the lobby changed, not a
   * knock: anything without a participant reads as the server, so it is
   * listed only once control's lobby has it pending — read at once.
   */
  #knock(share: Share, requestId: string): void {
    if (this.#decided.has(requestId) || this.#state.knocks.some((knock) => knock.requestId === requestId) || this.#state.participants.some((guest) => guest.identity === guestIdentity(requestId))) return;
    void this.#readLobby(share);
  }

  /**
   * The room as the host app reports it: anyone new in it is no guest of the
   * share's until control, asked at once (a lobby read), lists them as let in.
   */
  #setGuests(share: Share, reported: readonly LiveGuest[]): void {
    const roster = reported.filter((guest, index) => guest.identity !== "host" && reported.findIndex((other) => other.identity === guest.identity) === index);
    const before = new Set(this.#roster.map((guest) => guest.identity));
    const present = new Set(roster.map((guest) => guest.identity));
    this.#roster = roster;
    for (const identity of [...this.#joined.keys()]) if (!present.has(identity)) this.#joined.delete(identity);
    for (const identity of [...this.#letIn.keys()]) if (!present.has(identity)) this.#letIn.delete(identity);
    const came = roster.filter((guest) => !before.has(guest.identity) && !this.#removed.has(guest.identity));
    for (const guest of came) this.#joined.set(guest.identity, ++this.#comings);
    this.#applyRoster(share);
    if (came.length > 0) void this.#readLobby(share);
  }

  /**
   * Of the guests a read set out to ask about, still in the room as they came
   * then, waiting or let in: those control lists as let in are the share's
   * guests from now, or still, and the rest (they left, were removed, or never
   * were) are removed again. Someone who came back since waits on the read
   * that follows.
   */
  #checkAdmitted(share: Share, asked: ReadonlyMap<string, number>, admitted: ReadonlySet<string>): void {
    let changed = false;
    for (const [identity, coming] of asked) {
      const waiting = this.#joined.get(identity) === coming;
      if (!waiting && this.#letIn.get(identity) !== coming) continue;
      if (waiting) this.#joined.delete(identity);
      if (this.#removed.has(identity)) continue;
      if (admitted.has(identity)) {
        // (One let in already stays so: nothing changed.)
        if (!waiting) continue;
        this.#letIn.set(identity, coming);
      } else {
        this.#letIn.delete(identity);
        this.#removed.add(identity);
      }
      changed = true;
    }
    if (changed) this.#applyRoster(share);
  }

  /** A read failed while someone in the room waits on it: another goes soon, not at the next poll (while anyone may join, none but the minute's). */
  #readAgainSoon(share: Share): void {
    if (this.#joined.size === 0 || share.lobbyRetry !== null) return;
    share.lobbyRetry = setTimeout(() => {
      share.lobbyRetry = null;
      if (this.#share === share && this.#joined.size > 0) void this.#readLobby(share);
    }, LIVE_LOBBY_RETRY_MS);
  }

  /**
   * The guests as the host lets them be: those in the room control said it
   * let in, less who was removed. Only they are the share's participants —
   * their input, asks and chat heard, sent the room (`admitted`) — and anyone
   * removed who is back is shown out again. The streamed windows are held
   * awake while any are in.
   */
  #applyRoster(share: Share): void {
    const guests = this.#roster.filter((guest) => this.#letIn.has(guest.identity) && !this.#removed.has(guest.identity));
    this.#showOutRemoved(share);
    const present = new Set(guests.map((guest) => guest.identity));
    for (const guest of this.#state.participants) {
      if (present.has(guest.identity)) continue;
      this.#input.forget(guest.identity);
      this.#messages.forget(guest.identity);
    }
    for (const use of this.#state.using) if (!present.has(use.identity)) share.host.send({ type: "grant", windowId: use.windowId, identity: null });
    // (Only what changed is patched: a change to the guests' voices alone then goes out as the roster, #changed; someone
    // in the room who is no guest yet changes nothing.)
    const using = this.#state.using.filter((use) => present.has(use.identity));
    const asks = this.#state.asks.filter((ask) => present.has(ask.identity));
    // Someone let in is in the room, not at the door.
    const knocks = this.#state.knocks.filter((knock) => !present.has(guestIdentity(knock.requestId)));
    const patch: Partial<LiveShareState> = {
      ...(sameGuests(guests, this.#state.participants) ? {} : { participants: guests }),
      ...(using.length === this.#state.using.length ? {} : { using }),
      ...(asks.length === this.#state.asks.length ? {} : { asks }),
      ...(knocks.length === this.#state.knocks.length ? {} : { knocks }),
    };
    if (Object.keys(patch).length > 0) this.#set(patch);
    const identities = guests.map((guest) => guest.identity);
    if (identities.length !== this.#admittedSent.length || identities.some((identity, index) => identity !== this.#admittedSent[index])) {
      this.#admittedSent = identities;
      share.host.send({ type: "admitted", identities });
    }
    this.#syncCursor();
    this.#holdForGuests(share);
  }

  /**
   * Removed guests the room still lists: control removes them again (one
   * removal at a time for each; a roster or a lobby read that still lists
   * them once it is confirmed asks again).
   */
  #showOutRemoved(share: Share): void {
    for (const { identity } of this.#roster) if (this.#removed.has(identity)) void this.#showOut(share, identity, false);
  }

  /**
   * Control removes someone the share keeps out from the room, and is asked
   * again 1, 2, 4… s on, at most 30 s apart, until it confirms (someone
   * LiveKit no longer has counts as removed): someone it still has holds a
   * place in the room, though nobody sends them anything (§7, §10), and with
   * anyone free to join the lobby is read only once a minute — so it goes on
   * whatever the roster says. It
   * stops when the share ends, and for someone control has no request of (a
   * token it never made), whom it cannot remove. The host's own removal says
   * it has not gone through until it has, and one control does not know has
   * the share read, as a knock's answer does (#ask). Resolves with the first
   * answer.
   */
  async #showOut(share: Share, identity: string, byHost: boolean): Promise<void> {
    if (this.#removing.has(identity)) return;
    this.#removing.set(identity, null);
    let said: string | null = null;
    const ask = async (tries: number): Promise<void> => {
      try {
        await share.control.remove(share.shareId, identity);
      } catch (error) {
        if (this.#share !== share) return;
        if (error instanceof ControlError && error.status === 404) {
          // (Let go after the read: one that still lists them does not ask again.)
          if (byHost) await this.#readLobby(share);
          else this.#log(`control has no ${identity} to show out`, error);
          this.#removing.delete(identity);
          return;
        }
        if (liveShareEnded(error)) {
          void this.#end("ended-elsewhere");
          return;
        }
        const wait = Math.min(LIVE_REMOVE_RETRY_MS * 2 ** tries, LIVE_REMOVE_RETRY_MAX_MS);
        this.#log(`could not show ${identity} out (try ${String(tries + 1)}), asking again in ${String(wait / 1000)} s`, error);
        if (byHost && said === null) {
          said = `Couldn't remove ${this.#roster.find((guest) => guest.identity === identity)?.name ?? "them"} from the room yet. Trying again.`;
          this.#set({ error: said });
        }
        this.#removing.set(
          identity,
          setTimeout(() => {
            if (this.#share !== share) return;
            this.#removing.set(identity, null);
            void ask(tries + 1);
          }, wait),
        );
        return;
      }
      if (this.#share !== share) return;
      this.#removing.delete(identity);
      if (said !== null && this.#state.error === said) this.#set({ error: null });
    };
    await ask(0);
  }

  #guestChat(from: string, id: string, raw: string): void {
    const guest = this.#state.participants.find((participant) => participant.identity === from);
    const text = raw.trim();
    if (guest === undefined || text === "" || text.length > MAX_CHAT_LENGTH) return;
    if (this.#state.chat.some((message) => message.from === from && message.id === id)) return;
    if (!this.#messages.take(from, this.#now())) return;
    const message = { id, from, name: guest.name, color: guest.color, text, at: this.#now() };
    this.#set({ chat: [...this.#state.chat, message].slice(-MAX_CHAT_HISTORY), unread: this.#state.unread + 1 });
  }

  #hostChat(share: Share, raw: string): void {
    const text = raw.trim();
    if (text === "" || text.length > MAX_CHAT_LENGTH) return;
    const id = `host:${String(++this.#chatCount)}`;
    const message = { id, from: "host", name: share.hostName, color: HOST_COLOR, text, at: this.#now() };
    this.#set({ chat: [...this.#state.chat, message].slice(-MAX_CHAT_HISTORY) });
    share.host.send({ type: "chat", id, text });
  }

  #guestAsk(from: string, windowId: string): void {
    const guest = this.#state.participants.find((participant) => participant.identity === from);
    if (guest === undefined || this.#state.controllable.includes(windowId) || this.#windows.get(windowId)?.streamed !== true) return;
    if (this.#state.asks.some((ask) => ask.identity === from && ask.windowId === windowId) || this.#state.asks.length >= MAX_ASKS) return;
    if (!this.#messages.take(from, this.#now())) return;
    this.#set({ asks: [...this.#state.asks, { identity: from, name: guest.name, windowId, at: this.#now() }] });
  }

  #setControllable(windowId: string, allowed: boolean): void {
    const listed = this.#state.controllable.includes(windowId);
    const asks = allowed ? this.#state.asks.filter((ask) => ask.windowId !== windowId) : this.#state.asks;
    if (listed === allowed) {
      if (asks.length !== this.#state.asks.length) this.#set({ asks });
      return;
    }
    const controllable = allowed ? [...this.#state.controllable, windowId] : this.#state.controllable.filter((id) => id !== windowId);
    this.#set({ controllable, asks });
    if (!allowed) this.#unuse(windowId);
    this.#buildFrame();
  }

  #use(windowId: string, identity: string): void {
    if (this.#state.using.some((use) => use.windowId === windowId && use.identity === identity)) return;
    this.#set({ using: [...this.#state.using.filter((use) => use.windowId !== windowId), { windowId, identity }] });
    this.#share?.host.send({ type: "grant", windowId, identity });
  }

  #unuse(windowId: string): void {
    if (!this.#state.using.some((use) => use.windowId === windowId)) return;
    this.#set({ using: this.#state.using.filter((use) => use.windowId !== windowId) });
    this.#share?.host.send({ type: "grant", windowId, identity: null });
  }

  /** The space was renamed: once the name has stood a moment, new guests' lobby says it (the frames already do). */
  #retitle(share: Share, spaceTitle: string): void {
    const title = shareTitle(spaceTitle);
    if (title === share.named) return;
    share.named = title;
    if (share.retitle !== null) clearTimeout(share.retitle);
    share.retitle = null;
    if (title === share.title) return;
    share.retitle = setTimeout(() => {
      share.retitle = null;
      if (this.#share !== share) return;
      share.title = title;
      void this.#update(share);
    }, LIVE_RETITLE_MS);
  }

  #setDrawing(drawing: LiveDrawing | null): void {
    const share = this.#share;
    if (share === null || (drawing === null && this.#state.drawing === null)) return;
    share.host.setDrawing(drawing !== null);
    this.#set({ drawing });
  }

  /* ---------------------------------- the desk --------------------------------- */

  /** Where the app draws over the shared stage: the stage's box in the window while the host is on it, else nowhere. */
  #placeStage(): void {
    const share = this.#share;
    const rect = this.#hostPresent && this.#report !== null ? this.#report.stageInWindow : null;
    if (share === null || sameRect(rect, this.#stage)) return;
    this.#stage = rect;
    this.#cursor.setStage(rect);
    share.host.send({ type: "stage", rect });
  }

  /**
   * What of the browser's own lies over the desk, window content px — the
   * shell's covers whose box is known, placed by the report's stage, and the
   * notice stack's cards — or null while the shell says something lies over
   * it that no box holds: the host app's window marks (the outlines) go
   * under it all (§6.3). Kept as it changes, and sent while a share is live.
   */
  #placeChrome(): void {
    const report = this.#report;
    let over: LiveRect[] | null = null;
    if (report === null || !report.shellCovered) {
      const stage = report?.stageInWindow ?? { x: 0, y: 0 };
      over = (report?.covers ?? []).map((cover) => ({ x: stage.x + cover.x, y: stage.y + cover.y, w: cover.w, h: cover.h }));
      if (this.#notices !== null) over.push({ ...this.#notices });
    }
    if (sameRects(over, this.#chrome)) return;
    this.#chrome = over;
    this.#share?.host.send({ type: "chrome", over });
  }

  /** The host's pointer is polled only while a guest is there to see it and the host is on the space. */
  #syncCursor(): void {
    this.#cursor.setActive(this.#share !== null && this.#hostPresent && this.#state.participants.length > 0);
  }

  #buildFrame(): void {
    const share = this.#share;
    const report = this.#report;
    if (share === null || report === null) return;
    const space = this.#deps.browser.space(share.groupId);
    if (space === null) return;
    const frame = deskFrame({
      report,
      facts: (windowId) => this.#deps.browser.facts(windowId, share.groupId),
      controllable: new Set(this.#state.controllable),
      hostPresent: this.#hostPresent,
      guestsCanDraw: this.#state.guestsCanDraw,
      space: { title: space.title, color: space.color },
    });
    const masked = new Set(report.windows.filter((window) => window.masked).map((window) => window.id));
    // (A shell-drawn window has no tab page to capture, use or hold awake: its picture is the shell's.)
    const pages = frame.windows.filter((window) => window.kind === "page" && window.track !== null);
    // (Of the shell's windows, guests' hands reach a terminal alone: §6.6.)
    this.#windows = new Map(
      frame.windows.map((window) => [
        window.id,
        {
          page: window.kind === "page",
          streamed: window.track !== null && (window.kind === "page" || window.terminal === true),
          minimized: window.minimized,
          masked: masked.has(window.id),
          paused: window.paused,
        },
      ]),
    );
    this.#streamed = pages.map((window) => ({ tabId: window.id, width: Math.round(window.page.w), height: Math.round(window.page.h) }));
    this.#shellStreamed = frame.windows.some((window) => window.kind === "shell" && window.track !== null);
    // (The card tells the host which windows guests see only the frame of, and so cannot use.)
    const streamed = frame.windows.filter((window) => window.track !== null).map((window) => window.id);
    if (streamed.length !== this.#state.streamed.length || streamed.some((id) => !this.#state.streamed.includes(id))) this.#set({ streamed });
    // A window taken back, minimized, masked or gone: what a guest held down on it is let go.
    this.#input.releaseWithdrawn();
    this.#hold(share);
    // (With the shell's mark it was painted under: the host app cuts a frame of the shell's picture only by its report's word.)
    share.frames.update(frame, shellMarkOf(report));
  }

  /**
   * With a guest in the room the streamed tabs are held awake (woken, laid
   * out); with none, the waking and laying out is for nobody, so they are let
   * go — 30 s after the last guest left, as someone reloading is back sooner.
   */
  #holdForGuests(share: Share): void {
    if (this.#state.participants.length > 0) {
      if (this.#holdGrace !== null) clearTimeout(this.#holdGrace);
      this.#holdGrace = null;
      if (this.#holding) return;
      this.#holding = true;
      this.#hold(share);
      return;
    }
    if (!this.#holding || this.#holdGrace !== null) return;
    this.#holdGrace = setTimeout(() => {
      this.#holdGrace = null;
      if (this.#share !== share || this.#state.participants.length > 0) return;
      this.#holding = false;
      this.#hold(share);
    }, LIVE_HOLD_GRACE_MS);
  }

  /** Tell the browser the shared space and the tabs to hold, when that changed. */
  #hold(share: Share): void {
    const tabs = this.#holding ? this.#streamed : [];
    const sent = this.#heldSent;
    if (sent !== null && tabs.length === sent.length && tabs.every((tab, index) => sameHeld(tab, sent[index]))) return;
    this.#heldSent = tabs;
    this.#deps.browser.hold(share.groupId, tabs);
  }

  /* ---------------------------------- publishing --------------------------------- */

  #set(patch: Partial<LiveShareState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#changed();
  }

  /**
   * Coalesced like every snapshot: the changes of one synchronous run go out
   * once. A change to who is speaking, or how well a guest is connected, and
   * nothing else, goes to the shell as the guests alone — not the whole share
   * with its chat again, a flip at a time — and the host app, which has the
   * room's own word on both, is not told.
   */
  #changed(): void {
    if (this.#publishQueued) return;
    this.#publishQueued = true;
    queueMicrotask(() => {
      this.#publishQueued = false;
      const state = this.#state;
      const before = this.#published;
      this.#published = state;
      if (before !== null && voicesOnly(before, state)) {
        this.#deps.publishRoster(state.participants);
        return;
      }
      this.#deps.publish(state);
      if (state.status === "live") this.#share?.host.send({ type: "state", state });
    });
  }

  #log(message: string, error?: unknown): void {
    (this.#deps.log ?? ((text: string, cause?: unknown) => console.error(`[live] ${text}`, cause)))(message, error);
  }
}

/** A guest's identity in the room (§3). */
function guestIdentity(requestId: string): string {
  return `g_${requestId}`;
}

/**
 * The share's title as control keeps it, so its word on the title is the
 * host's to compare (#reconcile): the space's name, control characters and
 * bidi marks stripped (as control strips them), one line, at most 200
 * characters.
 */
function shareTitle(title: string): string {
  const line = title.replace(UNPRINTABLE, "").replace(/\s+/g, " ").trim();
  return line === "" ? "Untitled space" : [...line].slice(0, MAX_TITLE).join("").trimEnd();
}

function sameRect(a: LiveRect | null, b: LiveRect | null): boolean {
  return a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
}

function sameRects(a: readonly LiveRect[] | null, b: readonly LiveRect[] | null): boolean {
  return a === b || (a !== null && b !== null && a.length === b.length && a.every((rect, index) => sameRect(rect, b[index] ?? null)));
}

function sameHeld(a: LiveHeldTab, b: LiveHeldTab | undefined): boolean {
  return b !== undefined && a.tabId === b.tabId && a.width === b.width && a.height === b.height;
}

/** Two states differ only in their guests' speaking or connection. */
function voicesOnly(before: LiveShareState, after: LiveShareState): boolean {
  if (before.participants === after.participants || before.participants.length !== after.participants.length) return false;
  for (const key of Object.keys(after) as Array<keyof LiveShareState>) if (key !== "participants" && after[key] !== before[key]) return false;
  return after.participants.every((guest, index) => sameButVoice(guest, before.participants[index]));
}

/** The same guest, the same but for their speaking and connection. */
function sameButVoice(a: LiveGuest, b: LiveGuest | undefined): boolean {
  return b !== undefined && a.identity === b.identity && a.name === b.name && a.color === b.color && a.micOn === b.micOn && a.cameraOn === b.cameraOn;
}

function sameGuests(a: readonly LiveGuest[], b: readonly LiveGuest[]): boolean {
  return a.length === b.length && a.every((guest, index) => sameButVoice(guest, b[index]) && guest.speaking === b[index]?.speaking && guest.connection === b[index]?.connection);
}

function sameKnocks(a: LiveShareState["knocks"], b: LiveShareState["knocks"]): boolean {
  return a.length === b.length && a.every((knock, index) => knock.requestId === b[index]?.requestId);
}
