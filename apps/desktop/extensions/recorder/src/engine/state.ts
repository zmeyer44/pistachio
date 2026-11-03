/**
 * The session's states (docs/recorder.md §3): `counting` (the capture already
 * running, its frames dropped) → `recording` ⇄ `paused` → `finalizing` →
 * `done`; `discarded` and `failed` end it too. Pure: `next` answers null for a
 * move that is not allowed, and the session ignores it.
 */

export type SessionState = "counting" | "recording" | "paused" | "finalizing" | "done" | "discarded" | "failed";

export type SessionAction =
  /** The countdown ran out: encode from the next frame. */
  | "go"
  | "pause"
  | "resume"
  /** The person stopped: save what was recorded (nothing yet while counting: that is a cancel). */
  | "stop"
  /** The source ended under it (the tab closed, the grant went, the disk filled, an encoder broke): save what there is. */
  | "end"
  /** Throw it away. */
  | "discard"
  /** Finalizing finished. */
  | "finish"
  /** Starting or finalizing failed. */
  | "fail";

const MOVES: Record<SessionState, Partial<Record<SessionAction, SessionState>>> = {
  counting: { go: "recording", stop: "discarded", end: "failed", discard: "discarded", fail: "failed" },
  recording: { pause: "paused", stop: "finalizing", end: "finalizing", discard: "discarded", fail: "finalizing" },
  paused: { resume: "recording", stop: "finalizing", end: "finalizing", discard: "discarded", fail: "finalizing" },
  finalizing: { finish: "done", fail: "failed" },
  done: {},
  discarded: {},
  failed: {},
};

export function next(state: SessionState, action: SessionAction): SessionState | null {
  return MOVES[state][action] ?? null;
}

/** Still holding the tab and the encoders. */
export function isLive(state: SessionState): boolean {
  return state === "counting" || state === "recording" || state === "paused" || state === "finalizing";
}

/** Over: a new recording may start. */
export function isOver(state: SessionState): boolean {
  return state === "done" || state === "discarded" || state === "failed";
}
