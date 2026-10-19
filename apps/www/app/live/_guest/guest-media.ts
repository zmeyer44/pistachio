/**
 * The guest's camera and microphone choices as the lobby and the room share
 * them: whether each is on and on which device (remembered), what is behind
 * the person, and their own background picture.
 */

import type { LiveBackground, LiveImageBackground } from "@pistachio/live-share/effects";
import type { CameraHold, GuestMediaMemory, GuestMediaPrefs } from "@pistachio/live-share/react";

export interface GuestMedia {
  /** The choices remembered, as they stand (to render). */
  prefs: GuestMediaPrefs;
  /** Where they are kept: a change is remembered over them as they stand when it lands. */
  memory: GuestMediaMemory;
  background: LiveBackground;
  /** Chosen, it is remembered at once (`GuestMediaMemory.chooseBackground`). */
  onBackground(background: LiveBackground): void;
  /** Why the camera is held off: the background remembered for it could not be put back. Null once answered. */
  held: CameraHold | null;
  custom: LiveImageBackground | null;
  /** Take a picture as the background; returns it, held as an object URL until replaced. */
  onUpload(file: File): LiveImageBackground;
}
