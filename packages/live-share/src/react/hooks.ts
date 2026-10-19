/**
 * Hooks over a `LiveRoom` (docs/live-share.md §8). React holds who is in the
 * room and what they have on; the per-frame feeds (pointers, ink, pings,
 * reactions) are objects the layers read imperatively, and these hooks only
 * wire them to the room's messages.
 *
 * A participant never receives its own messages, so what this side sends it
 * also applies here (a stroke, a ping, a reaction).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { inkAllowed } from "../ink.js";
import type { LiveInkOp, LivePing, LiveReact, LiveReaction, LiveTopic, LiveBody } from "../protocol.js";
import { MARK_RATE, RateLimiter } from "../rate.js";
import type { LiveConnectionState, LiveParticipant, LiveRoom, LiveSender } from "../room.js";
import { CursorFeed } from "./cursor-feed.js";
import { createEmitter, type Emitter } from "./emitter.js";
import { HostAbsence, type HostAbsenceOptions } from "./host-absence.js";
import { InkStore } from "./ink-store.js";
import { MediaSwitches, type MediaControl, type MediaSwitchKind, type MediaSwitchOn, type MediaSwitchOutcome, type MediaSwitchState } from "./media-switch.js";

function report(error: unknown): void {
  if (typeof globalThis.reportError === "function") globalThis.reportError(error);
  else console.error("[live-share]", error);
}

/** The latest value, for a callback registered once that must see this render's props. */
function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** Everyone in the room, the host first, me included. */
export function useParticipants(room: LiveRoom): LiveParticipant[] {
  const [participants, setParticipants] = useState(() => room.participants());
  useEffect(() => {
    setParticipants(room.participants());
    return room.on("participants", setParticipants);
  }, [room]);
  return participants;
}

export function useConnectionState(room: LiveRoom): LiveConnectionState {
  const [state, setState] = useState(() => room.state());
  useEffect(() => {
    setState(room.state());
    return room.on("state", setState);
  }, [room]);
  return state;
}

/** Whether the browser refuses to play the room's sound until a gesture: read as the page mounts, since the room may have heard it before. */
export function useAudioBlocked(room: LiveRoom): boolean {
  const [blocked, setBlocked] = useState(() => room.audioBlocked());
  useEffect(() => {
    setBlocked(room.audioBlocked());
    return room.on("audioBlocked", setBlocked);
  }, [room]);
  return blocked;
}

/** Handle every valid `topic` message with the latest `handler`. */
export function useTopic<T extends LiveTopic>(room: LiveRoom, topic: T, handler: (body: LiveBody<T>, from: LiveSender) => void): void {
  const latest = useLatest(handler);
  useEffect(() => room.onMessage(topic, (body, from) => latest.current(body, from)), [room, topic, latest]);
}

/** Calls `onLeave(identity)` for each participant that leaves the room. */
function useDepartures(room: LiveRoom, onLeave: (identity: string) => void): void {
  const latest = useLatest(onLeave);
  useEffect(() => {
    let present = new Set(room.participants().map((p) => p.identity));
    return room.on("participants", (participants) => {
      const now = new Set(participants.map((p) => p.identity));
      for (const identity of present) if (!now.has(identity)) latest.current(identity);
      present = now;
    });
  }, [room, latest]);
}

/** Everyone else's pointer, fed from `lv.cursor` and forgotten as they leave. */
export function useRoomCursors(room: LiveRoom): CursorFeed {
  const feed = useMemo(() => new CursorFeed(), []);
  useTopic(room, "lv.cursor", (cursor, from) => {
    if (from.identity !== null) feed.push(from.identity, cursor);
  });
  useDepartures(room, (identity) => feed.remove(identity));
  return feed;
}

export interface RoomInk {
  store: InkStore;
  /** An op of mine: drawn here and sent to the room. */
  emit(op: LiveInkOp): void;
}

/**
 * The room's ink: everyone's ops from `lv.ink`, and mine through `emit`.
 * `guestsCanDraw` says whether the host lets guests draw now (the latest
 * desk frame's word): while not, other guests' new strokes are not drawn
 * here either — the host's board refuses them, and so does every guest's.
 */
export function useRoomInk(room: LiveRoom, guestsCanDraw: () => boolean = () => true): RoomInk {
  const store = useMemo(() => new InkStore(), []);
  useTopic(room, "lv.ink", (op, from) => {
    if (from.identity === null || from.role === "server" || !inkAllowed(op, from.role, guestsCanDraw())) return;
    store.apply(op, { identity: from.identity, role: from.role });
  });
  useDepartures(room, (identity) => store.release(identity));
  const emit = useCallback(
    (op: LiveInkOp) => {
      store.apply(op, { identity: room.identity, role: room.role });
      room.send("lv.ink", op).catch(report);
    },
    [room, store],
  );
  return useMemo(() => ({ store, emit }), [store, emit]);
}

export interface LivePingEvent {
  /** Stage-normalized. */
  x: number;
  y: number;
  color: string;
}

export interface LiveReactionEvent {
  emoji: string;
  /** Who sent it: the reaction rises from their face. */
  identity: string;
}

function colorOf(room: Pick<LiveRoom, "participants">, identity: string | null): string | null {
  if (identity === null) return null;
  return room.participants().find((p) => p.identity === identity)?.color ?? null;
}

/**
 * The room's `lv.ping`s into `feed`, in their sender's colour: any one
 * participant's at most `MARK_RATE`, metered before anything is looked up,
 * so a flood costs its sender their excess and this page a token's check.
 */
export function roomPingHandler(room: Pick<LiveRoom, "participants">, feed: Emitter<LivePingEvent>, now: () => number = () => performance.now()): (body: LivePing, from: LiveSender) => void {
  const rate = new RateLimiter(MARK_RATE);
  return (body, from) => {
    if (from.identity === null || !rate.take(from.identity, now())) return;
    const color = colorOf(room, from.identity);
    if (color !== null) feed.emit({ x: body.x, y: body.y, color });
  };
}

/** The room's `lv.react`s into `feed`: any one participant's at most `MARK_RATE`. */
export function roomReactionHandler(feed: Emitter<LiveReactionEvent>, now: () => number = () => performance.now()): (body: LiveReact, from: LiveSender) => void {
  const rate = new RateLimiter(MARK_RATE);
  return (body, from) => {
    if (from.identity !== null && rate.take(from.identity, now())) feed.emit({ emoji: body.emoji, identity: from.identity });
  };
}

/** Pings from the room (`roomPingHandler`) and mine, as one feed for `PingLayer`. */
export function useRoomPings(room: LiveRoom): { feed: Emitter<LivePingEvent>; ping(x: number, y: number): void } {
  const feed = useMemo(() => createEmitter<LivePingEvent>(), []);
  useTopic(room, "lv.ping", useMemo(() => roomPingHandler(room, feed), [room, feed]));
  const ping = useCallback(
    (x: number, y: number) => {
      feed.emit({ x, y, color: colorOf(room, room.identity) ?? "#8B8D98" });
      room.send("lv.ping", { x, y }).catch(report);
    },
    [room, feed],
  );
  return { feed, ping };
}

/** Reactions from the room (`roomReactionHandler`) and mine, as one feed for `ReactionLayer`. */
export function useRoomReactions(room: LiveRoom): { feed: Emitter<LiveReactionEvent>; react(emoji: LiveReaction): void } {
  const feed = useMemo(() => createEmitter<LiveReactionEvent>(), []);
  useTopic(room, "lv.react", useMemo(() => roomReactionHandler(feed), [feed]));
  const react = useCallback(
    (emoji: LiveReaction) => {
      feed.emit({ emoji, identity: room.identity });
      room.send("lv.react", { emoji }).catch(report);
    },
    [room, feed],
  );
  return { feed, react };
}

/**
 * Whether this guest is waiting on a host gone from the room a while, while
 * control is asked whether the share still stands (`HostAbsence`); `over`
 * hears an answer that ends it.
 */
export function useHostAbsence(hostHere: boolean, check: HostAbsenceOptions["check"], over: HostAbsenceOptions["over"]): boolean {
  const latest = useLatest({ check, over });
  const [absence] = useState(() => new HostAbsence({ check: () => latest.current.check(), over: (reason) => latest.current.over(reason) }));
  useEffect(() => {
    if (hostHere) return;
    absence.start();
    return () => absence.stop();
  }, [absence, hostHere]);
  return useSyncExternalStore(absence.subscribe, absence.waiting, absence.waiting);
}

export interface LocalMediaSwitch extends MediaSwitchState {
  set(kind: MediaSwitchKind, on: boolean, deviceId?: string): Promise<MediaSwitchOutcome>;
  setOnOrDefault(kind: MediaSwitchKind, deviceId?: string): Promise<MediaSwitchOn>;
  forget(kind: MediaSwitchKind): void;
  wentOff(kind: MediaSwitchKind, error: unknown): void;
}

/**
 * Turning my camera and microphone on and off, with what went wrong
 * (`MediaSwitches`: each kind's latest switch answers, and a camera coming
 * on can be turned off while it comes). Whether each is on comes from the
 * source itself (the room's participants, the preview's tracks). What went
 * wrong is forgotten once the browser says it no longer holds: a device
 * plugged in, access granted.
 */
export function useMediaSwitch(control: MediaControl): LocalMediaSwitch {
  const switches = useMemo(() => new MediaSwitches(control), [control]);
  const state = useSyncExternalStore(switches.subscribe, switches.state, switches.state);
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    return switches.watch({ devices: navigator.mediaDevices, permissions: navigator.permissions });
  }, [switches]);
  return { ...state, set: switches.set, setOnOrDefault: switches.setOnOrDefault, forget: switches.forget, wentOff: switches.wentOff };
}

/**
 * This browser's devices of `kind`, again whenever one is plugged in or out
 * and when `refresh` changes (labels appear once a permission is granted).
 */
export function useDevices(kind: MediaDeviceKind, refresh: unknown = null): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (media === undefined) return;
    let live = true;
    const load = (): void => {
      media.enumerateDevices().then(
        (all) => {
          if (live) setDevices(all.filter((device) => device.kind === kind && device.deviceId !== ""));
        },
        () => undefined,
      );
    };
    load();
    media.addEventListener("devicechange", load);
    return () => {
      live = false;
      media.removeEventListener("devicechange", load);
    };
  }, [kind, refresh]);
  return devices;
}
