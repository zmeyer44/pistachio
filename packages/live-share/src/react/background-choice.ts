/**
 * A background chosen for the camera, in the lobby or the room
 * (docs/live-share.md §7). One that cannot be put on leaves the camera behind
 * the one it had — the room or the preview puts that back on it, and it is
 * their choice again — so the menu that offered it says that one again, and
 * the person is told why. A choice a later one came after is let go: the
 * later one answers. A camera kept off for a background remembered that
 * could not be put back is told likewise (`describeCameraHold`).
 */

import type { LiveBackground } from "../effects.js";

/** What a background goes on: a `LiveRoom` in the room, a `LivePreview` in the lobby. */
export interface BackgroundControl {
  setBackground(background: LiveBackground): Promise<boolean>;
  background(): LiveBackground;
}

/** Why a background is not behind the person: it did not load, or this browser cannot run it. */
export type BackgroundProblem = "failed" | "unsupported";

/** Put `background` on; `refused` hears what the camera shows instead, and why, when it is not. */
export function chooseBackground(control: BackgroundControl, background: LiveBackground, refused: (shown: LiveBackground, problem: BackgroundProblem) => void): void {
  control.setBackground(background).then(
    (applied) => {
      if (!applied) refused(control.background(), "unsupported");
    },
    () => refused(control.background(), "failed"),
  );
}

/** One line about a background that is not on, for a note or a banner. */
export function describeBackgroundProblem(problem: BackgroundProblem): string {
  return problem === "unsupported" ? "This browser can’t put a background behind you." : "That background didn’t load.";
}

/**
 * Why the camera was kept off rather than come back without the background
 * remembered for it (after a reload, or on a later visit): the person's own
 * picture, which is not kept once the page closes, or a background that did
 * not load or that this browser cannot run.
 */
export type CameraHold = BackgroundProblem | "not-kept";

/** One line about a camera kept off for its background, for the lobby's note or a banner in the room. */
export function describeCameraHold(hold: CameraHold): string {
  switch (hold) {
    case "not-kept":
      return "Your camera is off: your own background picture isn’t kept once the page closes.";
    case "unsupported":
      return "Your camera is off: this browser can’t put your background behind you.";
    case "failed":
      return "Your camera is off: your background didn’t load.";
  }
}
