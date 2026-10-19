/**
 * The host's own camera and microphone (docs/live-share.md §6.3): main holds
 * what the host asked for (`LiveShareState.local`), the live-host app turns
 * the room's media into that one step at a time. Pure, so
 * test/live-host-media.test.ts holds the order: the background is set before
 * the camera comes on (the room puts it on the new camera), a device is
 * switched only while its kind is on (turning it on picks it anyway).
 */

import { sameBackgroundChoice, type LiveBackgroundChoice, type LiveDeviceKind, type LiveLocalMedia } from "@pistachio/shell-contracts/live-share";

export type MediaStep =
  | { kind: "background"; background: LiveBackgroundChoice }
  | { kind: "mic"; on: boolean; deviceId: string | null }
  | { kind: "camera"; on: boolean; deviceId: string | null }
  | { kind: "device"; device: LiveDeviceKind; deviceId: string | null };

/**
 * The camera's steps (its background, on and off, its device) and the
 * sound's (the mic, its device, the speaker) are taken apart, each lane one
 * step at a time: a permission prompt in one holds up nothing in the other.
 */
export type MediaLane = "camera" | "sound";

export const MEDIA_LANES: readonly MediaLane[] = ["camera", "sound"];

export function laneOf(step: MediaStep): MediaLane {
  if (step.kind === "background" || step.kind === "camera") return "camera";
  return step.kind === "device" && step.device === "videoinput" ? "camera" : "sound";
}

/**
 * What failed to come on and is not tried again until forgiven (`forgiven`):
 * the mic, the camera, and the background pick that failed — that pick
 * alone, so one the host made after it still goes on.
 */
export interface MediaRefusals {
  mic: boolean;
  camera: boolean;
  background: LiveBackgroundChoice | null;
}

export const NO_REFUSALS: MediaRefusals = { mic: false, camera: false, background: null };

/** The steps from what the room has (`applied`) to what the host wants, but for what was `refused`. */
export function mediaSteps(applied: LiveLocalMedia, wanted: LiveLocalMedia, refused: MediaRefusals = NO_REFUSALS): MediaStep[] {
  const steps: MediaStep[] = [];
  const failedPick = refused.background !== null && sameBackgroundChoice(wanted.background, refused.background);
  if (!sameBackgroundChoice(applied.background, wanted.background) && !failedPick) steps.push({ kind: "background", background: wanted.background });
  if (applied.mic !== wanted.mic) {
    if (!(wanted.mic && refused.mic)) steps.push({ kind: "mic", on: wanted.mic, deviceId: wanted.devices.audioinput });
  } else if (wanted.mic && applied.devices.audioinput !== wanted.devices.audioinput) {
    steps.push({ kind: "device", device: "audioinput", deviceId: wanted.devices.audioinput });
  }
  if (applied.camera !== wanted.camera) {
    if (!(wanted.camera && refused.camera)) steps.push({ kind: "camera", on: wanted.camera, deviceId: wanted.devices.videoinput });
  } else if (wanted.camera && applied.devices.videoinput !== wanted.devices.videoinput) {
    steps.push({ kind: "device", device: "videoinput", deviceId: wanted.devices.videoinput });
  }
  if (applied.devices.audiooutput !== wanted.devices.audiooutput) steps.push({ kind: "device", device: "audiooutput", deviceId: wanted.devices.audiooutput });
  return steps;
}

/** What the room has once `step` took. */
export function afterStep(applied: LiveLocalMedia, step: MediaStep): LiveLocalMedia {
  switch (step.kind) {
    case "background":
      return { ...applied, background: step.background };
    case "mic":
      return { ...applied, mic: step.on, devices: { ...applied.devices, audioinput: step.deviceId } };
    case "camera":
      return { ...applied, camera: step.on, devices: { ...applied.devices, videoinput: step.deviceId } };
    case "device":
      return { ...applied, devices: { ...applied.devices, [step.device]: step.deviceId } };
  }
}

/**
 * What is still refused, main's word now `wanted` and before it `said`: the
 * mic or the camera until the host turned it off (main puts it off when
 * told); a background pick until main names another — it names the one the
 * camera shows when told, so the host can choose the one that failed again.
 */
export function forgiven(refused: MediaRefusals, wanted: LiveLocalMedia, said: LiveLocalMedia): MediaRefusals {
  return {
    mic: refused.mic && wanted.mic,
    camera: refused.camera && wanted.camera,
    background: sameBackgroundChoice(wanted.background, said.background) ? refused.background : null,
  };
}
