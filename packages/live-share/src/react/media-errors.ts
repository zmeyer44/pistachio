/**
 * Why a camera or microphone did not start, as a person needs to hear it.
 * `getUserMedia` rejects with a DOMException whose name says what happened;
 * everything else is "it failed".
 */

export type MediaProblem =
  /** The browser or the person refused access. */
  | "blocked"
  /** No such device (none plugged in, or the chosen one is gone). */
  | "missing"
  /** Another app holds it, or the OS would not start it. */
  | "busy"
  | "failed";

export function mediaProblemOf(error: unknown): MediaProblem {
  const name = typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return "blocked";
    case "NotFoundError":
    case "OverconstrainedError":
    case "DevicesNotFoundError":
      return "missing";
    case "NotReadableError":
    case "AbortError":
    case "TrackStartError":
      return "busy";
    default:
      return "failed";
  }
}

const DEVICE_NAME = { microphone: "microphone", camera: "camera" } as const;

/** One line about a problem, for a note beside the control. */
export function describeMediaProblem(kind: "microphone" | "camera", problem: MediaProblem): string {
  const device = DEVICE_NAME[kind];
  switch (problem) {
    case "blocked":
      return `Your browser blocked the ${device}. Allow it in the site settings to use it.`;
    case "missing":
      return `No ${device} was found.`;
    case "busy":
      return `The ${device} is in use by another app.`;
    case "failed":
      return `The ${device} didn't start.`;
  }
}
