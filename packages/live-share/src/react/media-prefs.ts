/**
 * What a guest's page remembers of their camera, microphone and speaker
 * (docs/live-share.md §7): whether the camera and the microphone are on, the
 * device chosen for each, and what is behind the person. The page keeps them
 * (in its own storage, by `save`); this holds the rule that keeps them right,
 * so it is tested.
 *
 * A choice is remembered once it took, which can be seconds after it was
 * made — a permission prompt, the background's segmenter loading — and
 * other choices can be made and remembered meanwhile. So each is remembered
 * as the fields it changes, laid over the choices as they stand when it
 * lands (`remember`), never over a copy taken when it was made: that would
 * put back whatever changed in between, and a microphone turned off while
 * the camera came on would be on again after a reload.
 *
 * The background is remembered as soon as it is chosen, not once it took: a
 * reload while it loads brings the camera back behind it or not at all,
 * never behind the one it replaced. A built-in scene is remembered by name.
 * The person's own picture is not kept — a page closed lets go of it — only
 * that it was one. A background the page cannot put back (that picture, or
 * any effect where this browser cannot run one) holds the camera off
 * (`held`) until the person answers it: a background chosen again, or the
 * camera turned on as it now is.
 */

import type { LiveBackground, LiveImageBackground } from "../effects.js";
import type { CameraHold } from "./background-choice.js";
import type { MediaSwitches, MediaSwitchKind, MediaSwitchOutcome } from "./media-switch.js";

/** A background as it is remembered: a built-in scene by its name, the person's own picture only as having been one. */
export type RememberedBackground = { kind: "none" } | { kind: "blur"; strength?: "light" | "strong" } | { kind: "scene"; name: string } | { kind: "picture" };

export interface GuestMediaPrefs {
  microphone: boolean;
  camera: boolean;
  /** Device ids, or null for the browser's default. */
  audioinput: string | null;
  videoinput: string | null;
  audiooutput: string | null;
  background: RememberedBackground;
}

/** What a page can put back: its built-in scenes, and whether this browser can run a background at all. */
export interface BackgroundOffer {
  scenes: readonly LiveImageBackground[];
  supported: boolean;
}

const NONE: LiveBackground = { kind: "none" };

/** How `background` is remembered: one of `scenes` by its name, any other picture as the person's own. */
export function rememberBackground(background: LiveBackground, scenes: readonly LiveImageBackground[]): RememberedBackground {
  switch (background.kind) {
    case "none":
      return { kind: "none" };
    case "blur":
      return background.strength === undefined ? { kind: "blur" } : { kind: "blur", strength: background.strength };
    case "image": {
      const name = scenes.find((scene) => scene.url === background.url)?.label;
      return name === undefined ? { kind: "picture" } : { kind: "scene", name };
    }
  }
}

/** A remembered background read back from storage; anything unreadable is none, as before backgrounds were remembered. */
export function readBackground(value: unknown): RememberedBackground {
  if (typeof value !== "object" || value === null) return { kind: "none" };
  const { kind, strength, name } = value as Record<string, unknown>;
  if (kind === "blur") return strength === "light" || strength === "strong" ? { kind, strength } : { kind };
  if (kind === "scene" && typeof name === "string") return { kind, name };
  if (kind === "picture") return { kind };
  return { kind: "none" };
}

/**
 * The background a page starts with, from the one remembered — and, when
 * that one cannot be put back, why the camera is held off: the person's own
 * picture (not kept) or a scene no longer offered, or a background where
 * this browser cannot run one. Nothing is behind the person then (none)
 * until they choose again.
 */
export function recallBackground(remembered: RememberedBackground, offer: BackgroundOffer): { background: LiveBackground; held: CameraHold | null } {
  if (remembered.kind === "none") return { background: NONE, held: null };
  if (!offer.supported) return { background: NONE, held: "unsupported" };
  if (remembered.kind === "blur") return { background: remembered.strength === undefined ? { kind: "blur" } : { kind: "blur", strength: remembered.strength }, held: null };
  const scene = remembered.kind === "scene" ? offer.scenes.find((each) => each.label === remembered.name) : undefined;
  return scene === undefined ? { background: NONE, held: "not-kept" } : { background: scene, held: null };
}

export class GuestMediaMemory {
  readonly #save: (prefs: GuestMediaPrefs) => void;
  readonly #scenes: readonly LiveImageBackground[];
  readonly #listeners = new Set<() => void>();
  #prefs: GuestMediaPrefs;
  #background: LiveBackground;
  #held: CameraHold | null;

  constructor(initial: GuestMediaPrefs, save: (prefs: GuestMediaPrefs) => void, offer: BackgroundOffer) {
    const start = recallBackground(initial.background, offer);
    this.#prefs = initial;
    this.#save = save;
    this.#scenes = offer.scenes;
    this.#background = start.background;
    this.#held = start.held;
  }

  readonly current = (): GuestMediaPrefs => this.#prefs;

  /** What the page puts behind the person: the one chosen last, or the one remembered as the page started. */
  readonly background = (): LiveBackground => this.#background;

  /** Why the camera is held off, the background remembered for it not put back; null once the person answered it. */
  readonly held = (): CameraHold | null => this.#held;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Remember `changes` over the choices as they stand now. A camera on answers a hold: it went out as it now is. */
  readonly remember = (changes: Partial<Omit<GuestMediaPrefs, "background">>): void => {
    if (changes.camera === true) this.#held = null;
    this.#keep(changes);
  };

  /** Put `background` behind the person from now on, remembered at once; it answers a hold. */
  readonly chooseBackground = (background: LiveBackground): void => {
    this.#background = background;
    this.#held = null;
    this.#keep({ background: rememberBackground(background, this.#scenes) });
  };

  /**
   * Turn the camera or microphone on — on the device remembered for it — or
   * off, through the page's switches, and remember it once it took (not when
   * it failed, nor when a later switch overtook it).
   */
  readonly switch = async (set: MediaSwitches["set"], kind: MediaSwitchKind, on: boolean): Promise<MediaSwitchOutcome> => {
    const device = kind === "microphone" ? this.#prefs.audioinput : this.#prefs.videoinput;
    const outcome = await set(kind, on, on ? (device ?? undefined) : undefined);
    if (outcome === "done") this.remember(kind === "microphone" ? { microphone: on } : { camera: on });
    return outcome;
  };

  /**
   * Turn the camera or microphone back on as it was last time — the lobby
   * starting, a reload joining — on the device remembered for it or, that
   * one gone, on the default (`MediaSwitches.setOnOrDefault`). The default
   * that came on in its place is the device remembered from then on, unless
   * another was chosen meanwhile: the menu names the one in use, and turning
   * it off and on again asks for it, not for the one gone.
   */
  readonly resume = async (setOnOrDefault: MediaSwitches["setOnOrDefault"], kind: MediaSwitchKind): Promise<MediaSwitchOutcome> => {
    const field = kind === "microphone" ? "audioinput" : "videoinput";
    const asked = this.#prefs[field];
    const { outcome, deviceId } = await setOnOrDefault(kind, asked ?? undefined);
    if (outcome === "done" && deviceId === undefined && asked !== null && this.#prefs[field] === asked) this.#keep({ [field]: null });
    return outcome;
  };

  #keep(changes: Partial<GuestMediaPrefs>): void {
    this.#prefs = { ...this.#prefs, ...changes };
    this.#save(this.#prefs);
    for (const listener of this.#listeners) listener();
  }
}
