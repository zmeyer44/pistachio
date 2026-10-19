/**
 * A guest's way into the room once admitted (docs/live-share.md §1 Leave,
 * §7): connect, then — joined straight from a reload, with no lobby — put
 * the camera and microphone back as they were, the camera behind its
 * background or not at all, which can wait on a permission prompt or the
 * background's segmenter.
 *
 * Two things can happen while that waits, and neither may be lost: the room
 * can end (the host stopped sharing, this guest was removed) before anyone
 * listens for its end, and the page can stop wanting the room (it unmounted,
 * or the join was superseded). The room keeps why it ended (`endReason`), so
 * it is read after the wait; a join nobody wants any more is disconnected,
 * camera and all, rather than left running.
 */

import type { LiveEndReason, LiveRoom } from "../room.js";
import type { CameraHold } from "./background-choice.js";
import type { GuestMediaMemory } from "./media-prefs.js";
import { MediaSwitches } from "./media-switch.js";

export type JoinedRoom = Pick<LiveRoom, "endReason" | "disconnect">;

export type JoinOutcome<R extends JoinedRoom> =
  | { kind: "joined"; room: R }
  | { kind: "ended"; reason: LiveEndReason }
  | { kind: "cancelled" };

export async function joinRoom<R extends JoinedRoom>(options: {
  connect(): Promise<R>;
  /** After a reload: put the camera and microphone back on the joined room (best effort: a failure leaves it as it is). */
  restore: ((room: R) => Promise<void>) | null;
  /** True once the page no longer wants this join. */
  cancelled(): boolean;
}): Promise<JoinOutcome<R>> {
  const room = await options.connect();
  if (!options.cancelled() && options.restore !== null) await options.restore(room).catch(() => undefined);
  if (options.cancelled()) {
    await room.disconnect();
    return { kind: "cancelled" };
  }
  const reason = room.endReason();
  return reason === null ? { kind: "joined", room } : { kind: "ended", reason };
}

/** What a reload's restore turns back on. */
export type RestoredRoom = Pick<LiveRoom, "setBackground" | "setMicrophone" | "setCamera">;

/** What it reads: the choices remembered, what the page puts behind the person, and whether the camera is held off for it. */
export type RestoredMemory = Pick<GuestMediaMemory, "current" | "background" | "held" | "resume">;

/**
 * Joined with no lobby — straight from a reload, or again after the room
 * was lost — the camera and microphone as they were, best effort: each on
 * the device remembered for it or, that one gone, the default — remembered
 * then in its place — as the lobby starts them (`GuestMediaMemory.resume`).
 * The camera comes back only behind the background the page has for it:
 * that is the room's first, and the room puts it on the camera before it
 * goes out or keeps the camera off.
 * One the page could not put back (`held`: the person's own picture, not
 * kept; an effect this browser cannot run) keeps the camera off untried.
 * Returns why the camera stayed off for its background, for the page to
 * say; null when it did not. (The speaker is the room's from the start:
 * `LiveRoom.connect`'s `audioOutput`, for a lobby's join alike.)
 */
export async function restoreMedia(room: RestoredRoom, memory: RestoredMemory): Promise<CameraHold | null> {
  const prefs = memory.current();
  const background = memory.background();
  const held = memory.held();
  if (background.kind !== "none") await room.setBackground(background).catch(() => false);
  const switches = new MediaSwitches(room);
  if (prefs.microphone) await memory.resume(switches.setOnOrDefault, "microphone");
  if (held !== null) return held;
  if (!prefs.camera) return null;
  const outcome = await memory.resume(switches.setOnOrDefault, "camera");
  // A camera whose background did not go on is kept out of the room, which says only that it failed.
  return outcome === "failed" && background.kind !== "none" && switches.state().problem.camera === "failed" ? "failed" : null;
}
