/**
 * Live share's contracts on the desktop (docs/live-share.md §6.2): the share
 * as main holds it (`LiveShareState`), what the shell asks of it
 * (`LiveCommand`), what the shell reports of the shared space's desk
 * (`LiveDeskReport`), and the bridge between main and the live-host app —
 * the renderer in the transparent child window over the main window that
 * holds the room (`LiveHostConfig`, `LiveHostEvent`, `LiveHostReport`).
 *
 * The room's own messages are `@pistachio/live-share`'s (its protocol). This
 * package cannot depend on that one, so the two shapes that cross the bridge
 * as protocol bodies are restated here: `LiveHostDeskFrame` is its
 * `LiveDeskFrame` and `LiveBackgroundChoice` its effects' `LiveBackground`,
 * kept equal by a type test in apps/desktop (test/live-contracts.test.ts). A
 * guest's input crosses as `unknown`: main checks it against the protocol's
 * schema itself, whatever the host app says.
 *
 * Pure: no Electron, no DOM. Main validates everything a renderer sends with
 * the guards below; what main sends is trusted.
 */

import type { AppearanceSettings } from "./appearance.js";

/* --------------------------------- shapes --------------------------------- */

/** A box in CSS px (= DIP): the stage's, or the window content's for `stageInWindow`. */
export interface LiveRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LiveShareStatus = "idle" | "starting" | "live" | "ending" | "error";

/** Who can join: knock and wait to be let in (the default), or anyone with the link. */
export type LiveAdmission = "ask" | "open";

/** The room's connection, as the live-host app reports it. */
export type LiveConnection = "connecting" | "connected" | "reconnecting" | "disconnected";

/** The host's drawing tools on the desk. */
export type LiveInkTool = "pen" | "highlighter" | "laser";

/** The host drawing over the desk (`/draw`, the Live card's pen): the tool and its colour (#rrggbb). */
export interface LiveDrawing {
  tool: LiveInkTool;
  color: string;
}

/** The host camera's background (`@pistachio/live-share/effects` LiveBackground). */
export type LiveBackgroundChoice =
  | { kind: "none" }
  | { kind: "blur"; strength?: "light" | "strong" }
  | { kind: "image"; url: string; label?: string };

/** A kind of media device the host picks (MediaDeviceInfo.kind). */
export type LiveDeviceKind = "audioinput" | "videoinput" | "audiooutput";

/**
 * A media device as the live-host app sees it (its MediaDeviceInfo). Device
 * ids are salted per session, so only the window that opens them can list
 * them: the Live card offers what this says, and `setDevice` names one of these.
 */
export interface LiveMediaDevice {
  kind: LiveDeviceKind;
  deviceId: string;
  label: string;
}

/** The host's own camera, mic and their settings; the live-host app applies them to the room. */
export interface LiveLocalMedia {
  mic: boolean;
  camera: boolean;
  background: LiveBackgroundChoice;
  /** The chosen device of each kind, or null for the system's default. */
  devices: Record<LiveDeviceKind, string | null>;
}

/** A guest in the room (from the live-host app's roster). */
export interface LiveGuest {
  /** `g_<requestId>`. */
  identity: string;
  name: string;
  /** #rrggbb, set by control. */
  color: string;
  micOn: boolean;
  cameraOn: boolean;
  /** Talking now (the room's active speakers: it flips, it does not tick with the level). */
  speaking?: boolean;
  /** The guest's connection to the room, as the SFU last judged it. */
  connection?: LiveGuestConnection;
}

export type LiveGuestConnection = "excellent" | "good" | "poor" | "lost";

/** Someone at the door, waiting to be let in (admission "ask"). */
export interface LiveKnock {
  requestId: string;
  name: string;
  /** When main first heard of it, epoch ms. */
  at: number;
}

/** A guest asking to use a window the host has not allowed. */
export interface LiveWindowAsk {
  identity: string;
  name: string;
  windowId: string;
  at: number;
}

/** A chat message as the share keeps it (the protocol's `LiveChatEntry`): the host's own are `from: "host"`. */
export interface LiveChatMessage {
  id: string;
  /** The sender's identity: `host` or `g_<requestId>`. */
  from: string;
  name: string;
  color: string;
  text: string;
  /** Epoch ms, this Mac's clock. */
  at: number;
}

/** Who is using a window now: the last guest to press in it (`lv.grant`). */
export interface LiveWindowUse {
  windowId: string;
  identity: string;
}

/** Why the last share ended. */
export type LiveEndReason =
  /** Stop sharing (the card, the pill, the space's menu). */
  | "stopped"
  /** The shared space was closed or dissolved. */
  | "space-closed"
  /** A Profile switch took the space away. */
  | "profile-switched"
  /** The browser's window closed. */
  | "window-closed"
  /** The app quit. */
  | "quit"
  /** Control says the share is over (ended from another place, or swept). */
  | "ended-elsewhere"
  /** The live-host window failed (its renderer went). */
  | "failed"
  /** This Mac's account left it (signed out, another signed in to, this Mac revoked): the share was that account's. */
  | "account-changed";

/** The one live share of this Mac, as main holds it and publishes it (`onLiveShare`). */
export interface LiveShareState {
  status: LiveShareStatus;
  /** The shared space (tab group), while starting, live or ending. */
  groupId: string | null;
  shareId: string | null;
  /** The link guests open (`…/live/<token>`). */
  link: string | null;
  admission: LiveAdmission;
  guestsCanDraw: boolean;
  /** The windows (tab ids) guests may use. */
  controllable: string[];
  /**
   * The windows (tab ids) whose pictures go out now: the top eight of the
   * space's that are neither minimized nor masked (§3). Guests see any other
   * as its frame alone, and use none but these, whatever `controllable` says.
   */
  streamed: string[];
  /** Who is using which controllable window now. */
  using: LiveWindowUse[];
  /** The guests in the room, in join order. */
  participants: LiveGuest[];
  knocks: LiveKnock[];
  asks: LiveWindowAsk[];
  /** The share's chat, oldest first, at most 200. */
  chat: LiveChatMessage[];
  /** Guests' messages since the host last read the chat (`markRead`). */
  unread: number;
  local: LiveLocalMedia;
  /** The devices the live-host app can open (its `devices` report), for the Live card's pickers; none until it says. */
  devices: LiveMediaDevice[];
  /** The host drawing over the desk, or null. */
  drawing: LiveDrawing | null;
  /** The host is not on the shared space (another space is current, or the window is minimized or hidden). */
  hostAway: boolean;
  /** The room's connection, or null while no live-host app is up. */
  connection: LiveConnection | null;
  /** Epoch ms the share went live. */
  startedAt: number | null;
  /** Why the share could not start (status "error"), or why a command failed; null otherwise. */
  error: string | null;
  /** Why the last share ended, until the next starts. */
  ended: LiveEndReason | null;
}

/** The host's media as a share starts: mic and camera off, no background, the default devices. */
export const LIVE_LOCAL_MEDIA_DEFAULT: LiveLocalMedia = {
  mic: false,
  camera: false,
  background: { kind: "none" },
  devices: { audioinput: null, videoinput: null, audiooutput: null },
};

/** Nothing shared. */
export function idleLiveShare(): LiveShareState {
  return {
    status: "idle",
    groupId: null,
    shareId: null,
    link: null,
    admission: "ask",
    guestsCanDraw: true,
    controllable: [],
    streamed: [],
    using: [],
    participants: [],
    knocks: [],
    asks: [],
    chat: [],
    unread: 0,
    local: { ...LIVE_LOCAL_MEDIA_DEFAULT, devices: { ...LIVE_LOCAL_MEDIA_DEFAULT.devices } },
    devices: [],
    drawing: null,
    hostAway: false,
    connection: null,
    startedAt: null,
    error: null,
    ended: null,
  };
}

/* -------------------------------- commands -------------------------------- */

/** What the shell (and the live-host app's own controls) ask of the share. */
export type LiveCommand =
  /** Share this space live. Another share that is live is stopped first (the shell asks the person before). */
  | { type: "start"; groupId: string; hostName?: string }
  /** Stop sharing: the room is deleted and the link dies. */
  | { type: "stop" }
  /** Let a knocking person in. */
  | { type: "admit"; requestId: string }
  /** Turn a knocking person away. */
  | { type: "deny"; requestId: string }
  /** Take a guest out of the room for good (they cannot rejoin with this link). */
  | { type: "remove"; identity: string }
  | { type: "setAdmission"; admission: LiveAdmission }
  | { type: "setGuestsCanDraw"; allowed: boolean }
  /** Guests may (or may no longer) use this window. */
  | { type: "setControllable"; windowId: string; allowed: boolean }
  /** Answer a guest's ask to use a window: allowing it lets every guest use the window. */
  | { type: "answerAsk"; identity: string; windowId: string; allow: boolean }
  | { type: "setMic"; on: boolean }
  | { type: "setCamera"; on: boolean }
  | { type: "setBackground"; background: LiveBackgroundChoice }
  /** A device of this kind, or null for the system's default. */
  | { type: "setDevice"; kind: LiveDeviceKind; deviceId: string | null }
  /** Draw over the desk with this tool, or (null) give the desk back. */
  | { type: "setDrawing"; drawing: LiveDrawing | null }
  /** Clear everyone's ink. */
  | { type: "clearInk" }
  | { type: "chat"; text: string }
  /** One of the protocol's reactions (LIVE_REACTIONS). */
  | { type: "react"; emoji: string }
  /** The chat was read: the unread count goes to zero. */
  | { type: "markRead" }
  /** The link to the clipboard. */
  | { type: "copyLink" };

/* ------------------------------ the desk report ------------------------------ */

/** One window of the shared space's desk, as the shell's engine has it. */
export interface LiveDeskReportWindow {
  /** The tab id, or `file:<id>` for a document. */
  id: string;
  /** page: a tab's native view; shell: drawn by the shell (home, notes, brief, terminal, a document). */
  kind: "page" | "shell";
  /** The window's frame, stage CSS px. */
  frame: LiveRect;
  /** Its page box, stage CSS px (the stage's coordinates, inside the frame). */
  page: LiveRect;
  /** The window in use. */
  focused: boolean;
  minimized: boolean;
  /** Showing a region of its page (a mask). */
  masked: boolean;
  /**
   * Something of the shell's whose box is known — a side card, a tooltip's
   * band, the Bar's answer, the rail's floating player — lies over its page
   * box, or over where the report sent last put it: a shell-drawn window's
   * picture, cut from the shell's own, would carry it, so it is not taken
   * now (§6.6).
   */
  covered: boolean;
}

/**
 * The shell's report of the shared space's desk (`setLiveDesk`): sent while a
 * share is live, at most every 33 ms while anything moves and once when it
 * settles; the saved arrangement once while the space is not current. A
 * report that covers more than the last one (`shellCovered`, a window's
 * `covered`), or whose stage moved in the window, goes at once, before what
 * covers it is painted.
 */
export interface LiveDeskReport {
  groupId: string;
  /** The stage's size, CSS px. */
  stage: { w: number; h: number };
  /** Where the stage lies in the window's content box, CSS px (= DIP). */
  stageInWindow: LiveRect;
  /** The window's content box (the shell's viewport), CSS px: what the shell's picture is of. */
  viewport: { w: number; h: number };
  /** Bottom to top. */
  windows: LiveDeskReportWindow[];
  /** Nothing is moving. */
  settled: boolean;
  /**
   * Something of the shell's lies over the stage that no box holds, or may:
   * an overlay (the address palette, a context menu, the tab switcher, a
   * dialog), a cover drawn where nothing says exactly (the Bar's menus, a
   * file drop), anything the shell put in a layer of its own over the page
   * that is not a tooltip in its band, or the desk passing to or from
   * another space — or the shared space is not the one in front. While it
   * does, no shell-drawn window's picture is taken (§6.6, §10).
   */
  shellCovered: boolean;
  /**
   * Where something of the shell's whose box is known lies over the stage,
   * stage CSS px, each as far as a window's `covered` reads it: a box
   * padded, a side card's whole column (§6.4). The live-host app draws no
   * window's marks there: the outlines go under the shell's own (§6.3).
   */
  covers: LiveRect[];
  /**
   * The report's number (0 … LIVE_SHELL_MARKS − 1, counting on and wrapping),
   * painted into the shell's own pixels in the same task as it is sent
   * (§6.6): a frame of the shell's picture says which report it was painted
   * under, and is cut only by that report's word.
   */
  mark: number;
}

/** Windows in one report, as the protocol's frame bounds them. */
export const MAX_LIVE_DESK_WINDOWS = 64;

/** Covers in one report: the desk has a handful up at once (a card, a tooltip's band, the answer, the player). */
export const MAX_LIVE_DESK_COVERS = 32;

/** How many report numbers there are before they wrap (16 bits: what the shell's mark carries). */
export const LIVE_SHELL_MARKS = 65_536;

/**
 * What the live-host app cuts a frame of the shell's picture by (§6.6): the
 * number of the report the frame was painted under — read off the frame
 * itself — and where that report put the stage, in the window it gave.
 * Main sends it with each desk frame built from the report, whose windows'
 * page boxes and holds are the rest of it.
 */
export interface LiveShellMark {
  mark: number;
  stage: LiveRect;
  viewport: { w: number; h: number };
}

/* --------------------------- main ↔ the live-host app --------------------------- */

/** A window in a desk frame: the protocol's `LiveWindow`. */
export interface LiveHostWindow {
  id: string;
  kind: "page" | "shell";
  title: string;
  /** "github.com" — never the full URL. */
  origin: string | null;
  /** An https: or data:image/ URL of at most 4 KB, else null. */
  favicon: string | null;
  frame: LiveRect;
  page: LiveRect;
  focused: boolean;
  minimized: boolean;
  /** Guests may use it now (allowed, and the host is on the space). */
  controllable: boolean;
  /** A terminal the shell draws: the one shell-drawn window guests may be let use. */
  terminal?: boolean;
  /** `win:<id>` while the host app should stream it; null otherwise. */
  track: string | null;
  /**
   * Its picture is held, not live: a shell-drawn window while the host is
   * away or something of the shell's lies over the desk or over it (the host
   * app cuts no picture of it then), and a masked page.
   */
  paused: boolean;
}

/** The desk as guests rebuild it: the protocol's `LiveDeskFrame`, sent by the host app as `lv.desk` unchanged. */
export interface LiveHostDeskFrame {
  v: 1;
  /** Increases per frame. */
  seq: number;
  stage: { w: number; h: number };
  hostPresent: boolean;
  /** The host's *Guests can draw*; absent reads as on. */
  guestsCanDraw?: boolean;
  space: { title: string; color: string };
  /** Bottom to top. */
  windows: LiveHostWindow[];
}

/** What the live-host app is given as it starts (`liveHostConfig`); null once the share has ended. */
export interface LiveHostConfig {
  /** The room: LiveKit's URL and the host's token (identity `host`). */
  livekit: { url: string; token: string };
  shareId: string;
  /** The share as it stands (local media, drawing, chat for a sync, who uses what). */
  state: LiveShareState;
  /** The latest desk frame, or null before the shell has reported one. */
  frame: LiveHostDeskFrame | null;
  /** The shell's mark that frame was built under (§6.6), or null. */
  shell: LiveShellMark | null;
  /** Where the shared stage lies in this window, or null while the host is away from it. */
  stage: LiveRect | null;
  /** What of the browser's own lies over the desk now (the `chrome` event's). */
  chrome: LiveRect[] | null;
  /** Who may receive the room now (the `admitted` event's identities). */
  admitted: string[];
}

/**
 * Main → the live-host app. The app subscribes (`onLiveHostEvent`) BEFORE it
 * asks `liveHostConfig()`, so nothing falls between the two.
 */
export type LiveHostEvent =
  /**
   * A new desk frame: send it as `lv.desk`, stream the windows with a `track`,
   * unpublish the rest; and the shell's mark it was built under (§6.6). The
   * same frame again (its `seq` unchanged) brings a new mark alone: the
   * shell reported, and nothing guests see changed.
   */
  | { type: "desk"; frame: LiveHostDeskFrame; shell: LiveShellMark | null }
  /** Where the shared stage lies in this window now (window content px), or null: the host is away, draw nothing desk-bound. */
  | { type: "stage"; rect: LiveRect | null }
  /**
   * What of the browser's own lies over the desk now, window content px: the
   * shell's surfaces whose box is known (the desk report's `covers`, placed
   * by its stage) and the notice stack; null while something lies over it
   * that no box holds (an overlay, a menu, a passing). The marks that belong
   * to a window — the outlines — go under them: not drawn there, nor at all
   * for null. Pointers, ink, pings, reactions, the faces and the pill are
   * drawn over everything. Sent as it changes.
   */
  | { type: "chrome"; over: LiveRect[] | null }
  /** The host's pointer, stage-normalized, or null when it is off the stage: publish as `lv.cursor` (≤ 30 Hz). */
  | { type: "pointer"; at: { x: number; y: number } | null }
  /** The share changed (local media, drawing, guests can draw, chat, who uses what); not sent for a guest's speaking or connection alone. */
  | { type: "state"; state: LiveShareState }
  /**
   * The guests who may receive the room, by identity: those of the roster the
   * app reported that control lists as let in (asked after they came into the
   * room), less anyone the host removed since. Only they are let subscribe to
   * the windows and cameras, sent the host's data and synced; anyone else in
   * the room — someone new whom control has not answered for yet, a removed
   * guest back with a token LiveKit refreshed — gets nothing, and main removes
   * those control does not list. Sent whenever the set changes.
   */
  | { type: "admitted"; identities: string[] }
  /** The host's token for the room: fresh from control (every heartbeat that brings one), or the answer to `tokenExpiring`. */
  | { type: "token"; token: string }
  /** This window's page is a new one (woken, or back from a crash): capture it again (`liveHostSource`). */
  | { type: "capture"; windowId: string }
  /** Send `lv.grant`: who is using this window now (null: nobody). */
  | { type: "grant"; windowId: string; identity: string | null }
  /** The host wrote in the chat: send it as `lv.chat` (it is already in `state.chat`). */
  | { type: "chat"; id: string; text: string }
  /** The host reacted: send `lv.react` and show it. */
  | { type: "react"; emoji: string }
  /** The host cleared everyone's ink: `lv.ink { op: "clear", scope: "all" }`. */
  | { type: "clearInk" }
  /** The share is over: leave the room. The window closes next. */
  | { type: "end" };

/** The live-host app → main. Main checks the sender and the shape of each. */
export type LiveHostReport =
  /** The room's connection changed; `error` says why it failed, if it did. */
  | { type: "connection"; state: LiveConnection; error?: string }
  /** The guests in the room now, in join order (every join and leave). */
  | { type: "roster"; guests: LiveGuest[] }
  /** A guest's `lv.chat`. */
  | { type: "chat"; from: string; id: string; text: string }
  /** A guest's `lv.input`; `event` is the protocol's LiveInputEvent, checked again by main. */
  | { type: "input"; from: string; windowId: string; event: unknown }
  /** A guest's `lv.ask`. */
  | { type: "ask"; from: string; windowId: string }
  /** Control's `lv.knock`. */
  | { type: "knock"; requestId: string; name: string }
  /** The pointer is over something of the app's that takes it (a face, the pill): main makes the window take the pointer while true. */
  | { type: "interactive"; active: boolean }
  /** The host stopped drawing (Escape, the pen again): main gives the desk back. */
  | { type: "drawEnded" }
  /** The Live pill was pressed: the shell opens the Live card. */
  | { type: "openCard" }
  /** One of the app's own controls (the pill's stop, a face's mic or remove): run as the shell's would be. */
  | { type: "command"; command: LiveCommand }
  /** The room wants a token (it is expiring, or the room must reconnect): main answers with `token` — a fresh one when control has it, else the one it holds. */
  | { type: "tokenExpiring" }
  /** The media devices the app can open (as it starts, and on every `devicechange`): the Live card's pickers. */
  | { type: "devices"; devices: LiveMediaDevice[] }
  /** The host's mic or camera did not come on (refused, no device): main puts it off and says why. */
  | { type: "mediaFailed"; kind: Exclude<LiveMediaKind, "background">; error: string }
  /**
   * The background picked (`tried`) did not take (it would not load, this
   * Mac can't run it): the camera shows `background` instead — the one it
   * had, put back on it — which main names as the host's, and says why,
   * unless the host has picked another since (that one answers for itself).
   */
  | { type: "mediaFailed"; kind: "background"; tried: LiveBackgroundChoice; background: LiveBackgroundChoice; error: string }
  /** A window's capture brought no picture in a few seconds: its page may never have been laid out (a covered window's tab, woken). */
  | { type: "captureStalled"; windowId: string };

/** What of the host's own media `mediaFailed` names. */
export type LiveMediaKind = "mic" | "camera" | "background";

/**
 * Everything the live-host window's preload exposes (preload/live-host.ts):
 * the room's five members, and the appearance its theme follows — never the
 * shell's API. That window parses what strangers send (guests' packets, names
 * and chat), so it is sandboxed and can reach nothing else of main; each of
 * these channels answers only that window.
 */
export interface LiveHostApi {
  liveHostConfig(): Promise<LiveHostConfig | null>;
  onLiveHostEvent(listener: (event: LiveHostEvent) => void): () => void;
  sendLiveHostReport(report: LiveHostReport): void;
  liveHostSource(tabId: string): Promise<string | null>;
  /** A capture of the shell's own page, the shell-drawn windows' pictures are cut from (§6.6); null unless main allows one now. */
  liveHostShellSource(): Promise<string | null>;
  /** The appearance settings (scheme, colours, radius) the window's theme is drawn in. */
  liveHostAppearance(): Promise<AppearanceSettings | null>;
}

/* ------------------------------ main → the shell ------------------------------ */

/** A modifier held with a guest's key: the protocol's `LiveModifier`. */
export type LiveKeyModifier = "shift" | "control" | "alt" | "meta";

/**
 * What of a guest's hands on a terminal they were let use reaches the
 * terminal (docs/live-share.md §6.6): the protocol's key, text and wheel
 * events (`LiveInputEvent`), restated, each as main's gate passed it. A
 * press makes the window the one in use in main; the shell has nothing more
 * to do with the pointer.
 */
export type LiveTerminalEvent =
  | { type: "keyDown"; key: string; code: string; modifiers: LiveKeyModifier[]; repeat?: boolean; mac?: boolean }
  | { type: "keyUp"; key: string; code: string; modifiers: LiveKeyModifier[] }
  | { type: "char"; text: string; modifiers?: "shift"[] }
  | { type: "insertText"; text: string }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number; modifiers: LiveKeyModifier[] };

/** A guest's events for the terminal in a tab (main → the shell). */
export interface LiveTerminalInput {
  tabId: string;
  /** The guest's identity: several may type into one terminal, and each key's character follows its own key down. */
  from: string;
  events: LiveTerminalEvent[];
}

/* --------------------------------- guards --------------------------------- */

const MAX_ID = 200;
const MAX_TEXT = 4000;
/** An uploaded background is a data URL; the share's state carries it to the shell and the host app. */
const MAX_BACKGROUND_URL = 4_000_000;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID;
}

function isText(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === "string" && value.length <= max;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRect(value: unknown): value is LiveRect {
  const box = record(value);
  return box !== null && isFiniteNumber(box["x"]) && isFiniteNumber(box["y"]) && isFiniteNumber(box["w"]) && isFiniteNumber(box["h"]) && (box["w"] as number) >= 0 && (box["h"] as number) >= 0;
}

export function isLiveAdmission(value: unknown): value is LiveAdmission {
  return value === "ask" || value === "open";
}

export function isLiveDrawing(value: unknown): value is LiveDrawing {
  const drawing = record(value);
  return drawing !== null && (drawing["tool"] === "pen" || drawing["tool"] === "highlighter" || drawing["tool"] === "laser") && typeof drawing["color"] === "string" && HEX_COLOR.test(drawing["color"]);
}

/** The same background: a blur of the same strength (strong when unsaid), the same picture. */
export function sameBackgroundChoice(a: LiveBackgroundChoice, b: LiveBackgroundChoice): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "blur" && b.kind === "blur") return (a.strength ?? "strong") === (b.strength ?? "strong");
  if (a.kind === "image" && b.kind === "image") return a.url === b.url;
  return true;
}

export function isLiveBackgroundChoice(value: unknown): value is LiveBackgroundChoice {
  const background = record(value);
  if (background === null) return false;
  switch (background["kind"]) {
    case "none":
      return true;
    case "blur":
      return background["strength"] === undefined || background["strength"] === "light" || background["strength"] === "strong";
    case "image": {
      const url = background["url"];
      const label = background["label"];
      return typeof url === "string" && url.length > 0 && url.length <= MAX_BACKGROUND_URL && /^(https:|data:image\/)/.test(url) && (label === undefined || isText(label, MAX_ID));
    }
    default:
      return false;
  }
}

function isDeviceKind(value: unknown): value is LiveDeviceKind {
  return value === "audioinput" || value === "videoinput" || value === "audiooutput";
}

export function isLiveCommand(value: unknown): value is LiveCommand {
  const command = record(value);
  if (command === null) return false;
  switch (command["type"]) {
    case "start":
      return isId(command["groupId"]) && (command["hostName"] === undefined || isText(command["hostName"], MAX_ID));
    case "stop":
    case "clearInk":
    case "markRead":
    case "copyLink":
      return true;
    case "admit":
    case "deny":
      return isId(command["requestId"]);
    case "remove":
      return isId(command["identity"]);
    case "setAdmission":
      return isLiveAdmission(command["admission"]);
    case "setGuestsCanDraw":
      return typeof command["allowed"] === "boolean";
    case "setControllable":
      return isId(command["windowId"]) && typeof command["allowed"] === "boolean";
    case "answerAsk":
      return isId(command["identity"]) && isId(command["windowId"]) && typeof command["allow"] === "boolean";
    case "setMic":
    case "setCamera":
      return typeof command["on"] === "boolean";
    case "setBackground":
      return isLiveBackgroundChoice(command["background"]);
    case "setDevice":
      return isDeviceKind(command["kind"]) && (command["deviceId"] === null || isText(command["deviceId"], 1000));
    case "setDrawing":
      return command["drawing"] === null || isLiveDrawing(command["drawing"]);
    case "chat":
      return isText(command["text"]);
    case "react":
      return isText(command["emoji"], 16) && command["emoji"] !== "";
    default:
      return false;
  }
}

function isReportWindow(value: unknown): value is LiveDeskReportWindow {
  const window = record(value);
  return (
    window !== null &&
    isId(window["id"]) &&
    (window["kind"] === "page" || window["kind"] === "shell") &&
    isRect(window["frame"]) &&
    isRect(window["page"]) &&
    typeof window["focused"] === "boolean" &&
    typeof window["minimized"] === "boolean" &&
    typeof window["masked"] === "boolean" &&
    typeof window["covered"] === "boolean"
  );
}

export function isLiveDeskReport(value: unknown): value is LiveDeskReport {
  const report = record(value);
  if (report === null) return false;
  const stage = record(report["stage"]);
  const viewport = record(report["viewport"]);
  const windows = report["windows"];
  const covers = report["covers"];
  return (
    isId(report["groupId"]) &&
    stage !== null &&
    isFiniteNumber(stage["w"]) &&
    isFiniteNumber(stage["h"]) &&
    (stage["w"] as number) > 0 &&
    (stage["h"] as number) > 0 &&
    isRect(report["stageInWindow"]) &&
    viewport !== null &&
    isFiniteNumber(viewport["w"]) &&
    isFiniteNumber(viewport["h"]) &&
    (viewport["w"] as number) > 0 &&
    (viewport["h"] as number) > 0 &&
    Array.isArray(windows) &&
    windows.length <= MAX_LIVE_DESK_WINDOWS &&
    windows.every(isReportWindow) &&
    typeof report["settled"] === "boolean" &&
    typeof report["shellCovered"] === "boolean" &&
    Array.isArray(covers) &&
    covers.length <= MAX_LIVE_DESK_COVERS &&
    covers.every(isRect) &&
    Number.isInteger(report["mark"]) &&
    (report["mark"] as number) >= 0 &&
    (report["mark"] as number) < LIVE_SHELL_MARKS
  );
}

/** A system has a handful of devices; a list past this is not one. */
const MAX_MEDIA_DEVICES = 64;

function isMediaDevice(value: unknown): value is LiveMediaDevice {
  const device = record(value);
  return device !== null && isDeviceKind(device["kind"]) && isText(device["deviceId"], 1000) && isText(device["label"], MAX_ID);
}

function isConnection(value: unknown): value is LiveConnection {
  return value === "connecting" || value === "connected" || value === "reconnecting" || value === "disconnected";
}

function isGuest(value: unknown): value is LiveGuest {
  const guest = record(value);
  return (
    guest !== null &&
    isId(guest["identity"]) &&
    isText(guest["name"], MAX_ID) &&
    typeof guest["color"] === "string" &&
    HEX_COLOR.test(guest["color"]) &&
    typeof guest["micOn"] === "boolean" &&
    typeof guest["cameraOn"] === "boolean" &&
    (guest["speaking"] === undefined || typeof guest["speaking"] === "boolean") &&
    (guest["connection"] === undefined || isGuestConnection(guest["connection"]))
  );
}

function isGuestConnection(value: unknown): value is LiveGuestConnection {
  return value === "excellent" || value === "good" || value === "poor" || value === "lost";
}

export function isLiveHostReport(value: unknown): value is LiveHostReport {
  const report = record(value);
  if (report === null) return false;
  switch (report["type"]) {
    case "connection":
      return isConnection(report["state"]) && (report["error"] === undefined || isText(report["error"], 1000));
    case "roster": {
      const guests = report["guests"];
      return Array.isArray(guests) && guests.length <= MAX_LIVE_DESK_WINDOWS && guests.every(isGuest);
    }
    case "chat":
      return isId(report["from"]) && isId(report["id"]) && isText(report["text"]);
    case "input":
      return isId(report["from"]) && isId(report["windowId"]) && record(report["event"]) !== null;
    case "ask":
      return isId(report["from"]) && isId(report["windowId"]);
    case "knock":
      return isId(report["requestId"]) && isText(report["name"], MAX_ID) && report["name"] !== "";
    case "interactive":
      return typeof report["active"] === "boolean";
    case "drawEnded":
    case "openCard":
    case "tokenExpiring":
      return true;
    case "command":
      return isLiveCommand(report["command"]);
    case "devices": {
      const devices = report["devices"];
      return Array.isArray(devices) && devices.length <= MAX_MEDIA_DEVICES && devices.every(isMediaDevice);
    }
    case "mediaFailed":
      if (!isText(report["error"], 1000)) return false;
      return report["kind"] === "background" ? isLiveBackgroundChoice(report["tried"]) && isLiveBackgroundChoice(report["background"]) : report["kind"] === "mic" || report["kind"] === "camera";
    case "captureStalled":
      return isId(report["windowId"]);
    default:
      return false;
  }
}
