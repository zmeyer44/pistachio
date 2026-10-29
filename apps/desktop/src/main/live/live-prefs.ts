/**
 * The host's sharing choices, kept from one share to the next:
 * `<userData>/live-share.json`. Who can join, whether guests draw, the host's
 * mic and camera, the camera's background, and the devices picked — the
 * Live card's settings, as the host last set them there (docs/live-share.md
 * §1). This Mac's alone: it never syncs (a device is this Mac's).
 *
 * Only the host's own choices are kept, each as it is made (the service
 * keeps the one a command changes) — what main makes of them (a mic that
 * would not come on, a background that would not load) is not, so the next
 * share tries what was chosen. A device is kept with its label: its id is
 * salted per session and may not be the same next time (or the device may be
 * gone), so a share starts on the system's default and takes the kept one up
 * once the live-host app says what it can open (`restoredDevices`).
 *
 * Pure but for the file: test/live-prefs.test.ts pins the rest.
 */

import { join } from "node:path";
import {
  isLiveAdmission,
  isLiveBackgroundChoice,
  LIVE_LOCAL_MEDIA_DEFAULT,
  type LiveAdmission,
  type LiveBackgroundChoice,
  type LiveDeviceKind,
  type LiveMediaDevice,
  type LiveShareState,
} from "@pistachio/shell-contracts/live-share";
import { atomicWriteJsonSync, readJsonFile } from "../sync/queue-file";

/** A device as kept: its id (this session's, maybe not the next's) and its label (the one to find it by). */
export interface LiveKeptDevice {
  deviceId: string;
  label: string;
}

export interface LiveSharePrefs {
  admission: LiveAdmission;
  guestsCanDraw: boolean;
  mic: boolean;
  camera: boolean;
  background: LiveBackgroundChoice;
  /** The device picked of each kind, or null for the system's default. */
  devices: Record<LiveDeviceKind, LiveKeptDevice | null>;
}

export const LIVE_DEVICE_KINDS: readonly LiveDeviceKind[] = ["audioinput", "videoinput", "audiooutput"];

/** A first share's: as idleLiveShare() starts one. */
export const DEFAULT_LIVE_SHARE_PREFS: LiveSharePrefs = {
  admission: "ask",
  guestsCanDraw: true,
  mic: LIVE_LOCAL_MEDIA_DEFAULT.mic,
  camera: LIVE_LOCAL_MEDIA_DEFAULT.camera,
  background: LIVE_LOCAL_MEDIA_DEFAULT.background,
  devices: { audioinput: null, videoinput: null, audiooutput: null },
};

const MAX_DEVICE_TEXT = 512;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function keptDevice(value: unknown): LiveKeptDevice | null {
  const device = record(value);
  const deviceId = device?.["deviceId"];
  const label = device?.["label"];
  if (typeof deviceId !== "string" || deviceId.length === 0 || deviceId.length > MAX_DEVICE_TEXT) return null;
  if (typeof label !== "string" || label.length > MAX_DEVICE_TEXT) return null;
  return { deviceId, label };
}

/** What a file holds, each choice on its own: one that does not read is the first share's, the rest kept. */
export function sanitizeLiveSharePrefs(raw: unknown): LiveSharePrefs {
  const prefs = record(raw);
  if (prefs === null) return structuredClone(DEFAULT_LIVE_SHARE_PREFS);
  const devices = record(prefs["devices"]);
  return {
    admission: isLiveAdmission(prefs["admission"]) ? prefs["admission"] : DEFAULT_LIVE_SHARE_PREFS.admission,
    guestsCanDraw: typeof prefs["guestsCanDraw"] === "boolean" ? prefs["guestsCanDraw"] : DEFAULT_LIVE_SHARE_PREFS.guestsCanDraw,
    mic: typeof prefs["mic"] === "boolean" ? prefs["mic"] : DEFAULT_LIVE_SHARE_PREFS.mic,
    camera: typeof prefs["camera"] === "boolean" ? prefs["camera"] : DEFAULT_LIVE_SHARE_PREFS.camera,
    background: isLiveBackgroundChoice(prefs["background"]) ? prefs["background"] : DEFAULT_LIVE_SHARE_PREFS.background,
    devices: {
      audioinput: keptDevice(devices?.["audioinput"]),
      videoinput: keptDevice(devices?.["videoinput"]),
      audiooutput: keptDevice(devices?.["audiooutput"]),
    },
  };
}

/**
 * What a share starts with: the kept choices, on the system's default
 * devices until the live-host app lists its own (`restoredDevices`).
 */
export function startingChoices(prefs: LiveSharePrefs): Pick<LiveShareState, "admission" | "guestsCanDraw" | "local"> {
  return {
    admission: prefs.admission,
    guestsCanDraw: prefs.guestsCanDraw,
    local: { mic: prefs.mic, camera: prefs.camera, background: prefs.background, devices: { audioinput: null, videoinput: null, audiooutput: null } },
  };
}

/**
 * A device the host picked, to keep: with its label off the app's list (or
 * the kept one's, the same device); null for the system's default.
 */
export function deviceToKeep(devices: readonly LiveMediaDevice[], kept: LiveKeptDevice | null, kind: LiveDeviceKind, deviceId: string | null): LiveKeptDevice | null {
  if (deviceId === null) return null;
  const listed = devices.find((candidate) => candidate.kind === kind && candidate.deviceId === deviceId);
  return { deviceId, label: listed?.label ?? (kept?.deviceId === deviceId ? kept.label : "") };
}

/**
 * The kept device of each `pending` kind among those the live-host app can
 * open: by its id, else by its label (an id from another session); left out
 * when neither is there, so the share stays on the system's default.
 */
export function restoredDevices(prefs: LiveSharePrefs, devices: readonly LiveMediaDevice[], pending: ReadonlySet<LiveDeviceKind>): Partial<Record<LiveDeviceKind, string>> {
  const restored: Partial<Record<LiveDeviceKind, string>> = {};
  for (const kind of LIVE_DEVICE_KINDS) {
    const kept = prefs.devices[kind];
    if (!pending.has(kind) || kept === null) continue;
    const ofKind = devices.filter((device) => device.kind === kind);
    const found = ofKind.find((device) => device.deviceId === kept.deviceId) ?? (kept.label === "" ? undefined : ofKind.find((device) => device.label === kept.label));
    if (found !== undefined) restored[kind] = found.deviceId;
  }
  return restored;
}

export function samePrefs(a: LiveSharePrefs, b: LiveSharePrefs): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Where main keeps them: read once, written whole (atomically) as the host changes one. */
export interface LivePrefsFile {
  read(): LiveSharePrefs;
  write(prefs: LiveSharePrefs): void;
}

export function livePrefsFile(userDataDir: string): LivePrefsFile {
  const path = join(userDataDir, "live-share.json");
  return {
    read: () => sanitizeLiveSharePrefs(readJsonFile(path)),
    write: (prefs) => atomicWriteJsonSync(path, prefs),
  };
}
