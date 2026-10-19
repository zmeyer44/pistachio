/**
 * Turning my camera and microphone on and off, in the room and the lobby
 * (docs/live-share.md §7): the switches under way and what went wrong, held
 * apart from React (`useMediaSwitch` renders them) so they are tested.
 * Whether each is on comes from the source itself (the room's participants,
 * the preview's tracks).
 *
 * Each kind's latest switch answers for it. A camera or microphone coming
 * on — its permission prompt, a camera's background loading — reads as on
 * at its switch (`switchReadsOn`) and can be turned off while it comes: an
 * off is the person taking themselves out of the room, and goes at once
 * (the room and the preview stop one turned off before it is out; a
 * microphone turned off as the room publishes it goes out muted). The on
 * it overtook says nothing when it settles: not taken, so not remembered
 * as the person's choice, and not failed, so not tried again.
 *
 * A problem never disables a switch: clicking it again is how a setting
 * changed or a device plugged in is found. One that has stopped holding is
 * also forgotten without a click (`watch`, `forget`), so the switch stops
 * saying it.
 */

import { mediaProblemOf, type MediaProblem } from "./media-errors.js";

export type MediaSwitchKind = "microphone" | "camera";

/** What can switch a camera or microphone: a `LiveRoom` in the room, a `LivePreview` in the lobby. */
export interface MediaControl {
  setMicrophone(on: boolean, deviceId?: string): Promise<void>;
  setCamera(on: boolean, deviceId?: string): Promise<void>;
}

export interface MediaSwitchState {
  /** A switch is under way. */
  busy: Record<MediaSwitchKind, boolean>;
  /** The switch under way turns it on: its control reads as on (`switchReadsOn`), and turning it off goes at once. */
  coming: Record<MediaSwitchKind, boolean>;
  /** Why the last attempt to turn one on failed, until the next attempt or until it no longer holds (`forget`). */
  problem: Record<MediaSwitchKind, MediaProblem | null>;
}

/**
 * The browser's word on its cameras and microphones — `navigator.mediaDevices`
 * and `navigator.permissions`, each where it has them.
 */
export interface MediaAvailability {
  devices?: {
    enumerateDevices(): Promise<ReadonlyArray<{ kind: string }>>;
    addEventListener(type: "devicechange", listener: () => void): void;
    removeEventListener(type: "devicechange", listener: () => void): void;
  };
  permissions?: {
    query(descriptor: { name: MediaSwitchKind }): Promise<{
      readonly state: PermissionState;
      addEventListener(type: "change", listener: () => void): void;
      removeEventListener(type: "change", listener: () => void): void;
    }>;
  };
}

const DEVICE_KIND = { microphone: "audioinput", camera: "videoinput" } as const;

/**
 * Whether `kind`'s switch reads as on: its device is `on`, or the switch
 * under way turns it on. So a click or its key while it comes is an off,
 * which overtakes the on, rather than a second on; and `MediaButton` keeps
 * a switch that reads as on clickable while it is busy.
 */
export function switchReadsOn(state: MediaSwitchState, kind: MediaSwitchKind, on: boolean): boolean {
  return on || state.coming[kind];
}

/** How a switch ended: it took, it failed (`problem` says why), or a later switch of its kind came meanwhile and answers instead. */
export type MediaSwitchOutcome = "done" | "failed" | "overtaken";

/** How `setOnOrDefault` ended, and on which device: the one asked for, or undefined once it fell back to the default. */
export interface MediaSwitchOn {
  outcome: MediaSwitchOutcome;
  deviceId: string | undefined;
}

export class MediaSwitches {
  readonly #control: MediaControl;
  readonly #listeners = new Set<() => void>();
  /** Each kind's switches, counted: one settling after a later one came is let go. */
  readonly #asked: Record<MediaSwitchKind, number> = { microphone: 0, camera: 0 };
  #state: MediaSwitchState = {
    busy: { microphone: false, camera: false },
    coming: { microphone: false, camera: false },
    problem: { microphone: null, camera: null },
  };

  constructor(control: MediaControl) {
    this.#control = control;
  }

  readonly state = (): MediaSwitchState => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly set = async (kind: MediaSwitchKind, on: boolean, deviceId?: string): Promise<MediaSwitchOutcome> => {
    const ask = (this.#asked[kind] += 1);
    this.#put(kind, { busy: true, coming: on, problem: this.#state.problem[kind] });
    let problem: MediaProblem | null = null;
    try {
      if (kind === "microphone") await this.#control.setMicrophone(on, deviceId);
      else await this.#control.setCamera(on, deviceId);
    } catch (error) {
      problem = mediaProblemOf(error);
    }
    if (ask !== this.#asked[kind]) return "overtaken";
    this.#put(kind, { busy: false, coming: false, problem });
    return problem === null ? "done" : "failed";
  };

  /**
   * Turn one on, on `deviceId` or — that one gone (unplugged, or its id no
   * longer this browser's) — on the default, as the lobby and a reload start
   * what was on last time (`GuestMediaMemory.resume`), saying which it was.
   * One refused, busy or failing otherwise is not tried again on another
   * device: the default would fail the same way, or be a camera the person
   * did not choose.
   */
  readonly setOnOrDefault = async (kind: MediaSwitchKind, deviceId?: string): Promise<MediaSwitchOn> => {
    const outcome = await this.set(kind, true, deviceId);
    if (outcome !== "failed" || deviceId === undefined || this.#state.problem[kind] !== "missing") return { outcome, deviceId };
    return { outcome: await this.set(kind, true), deviceId: undefined };
  };

  /**
   * Forget why `kind` last failed to come on (when it was one of `problems`,
   * if they are named): it may no longer hold — a device chosen took, one
   * was plugged in, access was granted — and the next attempt says again.
   */
  readonly forget = (kind: MediaSwitchKind, problems?: readonly MediaProblem[]): void => {
    const problem = this.#state.problem[kind];
    if (problem === null || (problems !== undefined && !problems.includes(problem))) return;
    this.#put(kind, { busy: this.#state.busy[kind], coming: this.#state.coming[kind], problem: null });
  };

  /**
   * `kind` went off with no switch: the room took it out, unable to put it
   * out again after joining afresh (`LiveRoom`'s "mediaFailed"). Its switch
   * says why, as one that failed to come on does, and stays a click from
   * trying again; a switch under way goes on, and answers when it lands.
   */
  readonly wentOff = (kind: MediaSwitchKind, error: unknown): void => {
    this.#put(kind, { busy: this.#state.busy[kind], coming: this.#state.coming[kind], problem: mediaProblemOf(error) });
  };

  /**
   * Forget a problem once the browser says it has stopped holding, until the
   * returned stop: a device plugged in (`devicechange`) with one of its kind
   * now listed answers "missing"; access to the camera or the microphone no
   * longer denied (the Permissions API's `change`, where the browser has it
   * for them) answers "blocked". Each list asked for answers only while no
   * later one is on its way.
   */
  readonly watch = ({ devices, permissions }: MediaAvailability): (() => void) => {
    let live = true;
    const stops: Array<() => void> = [];
    if (devices !== undefined) {
      let listed = 0;
      const changed = (): void => {
        const ask = (listed += 1);
        devices.enumerateDevices().then(
          (all) => {
            if (!live || ask !== listed) return;
            for (const kind of ["microphone", "camera"] as const) {
              if (all.some((device) => device.kind === DEVICE_KIND[kind])) this.forget(kind, ["missing"]);
            }
          },
          () => undefined,
        );
      };
      devices.addEventListener("devicechange", changed);
      stops.push(() => devices.removeEventListener("devicechange", changed));
    }
    if (permissions !== undefined) {
      for (const kind of ["microphone", "camera"] as const) {
        // A browser with no permission by this name rejects the query: the click is all there is.
        permissions.query({ name: kind }).then(
          (status) => {
            if (!live) return;
            const changed = (): void => {
              if (status.state !== "denied") this.forget(kind, ["blocked"]);
            };
            status.addEventListener("change", changed);
            stops.push(() => status.removeEventListener("change", changed));
          },
          () => undefined,
        );
      }
    }
    return () => {
      live = false;
      for (const stop of stops.splice(0)) stop();
    };
  };

  #put(kind: MediaSwitchKind, next: { busy: boolean; coming: boolean; problem: MediaProblem | null }): void {
    const state = this.#state;
    this.#state = {
      busy: { ...state.busy, [kind]: next.busy },
      coming: { ...state.coming, [kind]: next.coming },
      problem: { ...state.problem, [kind]: next.problem },
    };
    for (const listener of this.#listeners) listener();
  }
}
