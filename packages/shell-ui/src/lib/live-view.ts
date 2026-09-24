/**
 * The live view's arithmetic now lives in `@pistachio/live-view`, shared with
 * the web run page's live pane so a click lands in the same place from either
 * client. `CloudFrame`/`CloudLiveInput` (@pistachio/shell-contracts/ipc) are the same shapes as
 * the package's `LiveFrame`/`LiveInput`, with main's `runId` added on the way
 * through IPC.
 */

import type { CloudFrame } from "@pistachio/shell-contracts/ipc";

export * from "@pistachio/live-view";

/**
 * Whether a frame may still be painted for the run the view is showing. A
 * frame is checked twice — when it arrives, and again when the animation
 * frame it was coalesced into runs — because the run can change in between,
 * and the last frame of the run that just ended must never land on the one
 * that just opened. `null` is "no run yet", which accepts whatever arrives
 * rather than blanking the surface.
 */
export function frameIsForRun(frame: CloudFrame, runId: string | null): boolean {
  return runId === null || frame.runId === runId;
}
