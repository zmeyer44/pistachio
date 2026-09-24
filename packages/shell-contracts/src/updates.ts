/**
 * Where the app stands with respect to a newer release. Main owns this;
 * the renderer only renders it and asks for the next step.
 *
 * Nothing is ever applied on its own: an available update is downloaded when
 * the person asks, and installed when they choose to restart.
 */
export type UpdateState =
  /** Dev runs and unsigned builds: there is nothing to update. */
  | { status: "unsupported"; reason: string }
  | { status: "idle"; checkedAt: string | null }
  | { status: "checking" }
  | { status: "up-to-date"; checkedAt: string }
  | { status: "available"; version: string; releaseDate: string | null }
  | { status: "downloading"; version: string; percent: number }
  | { status: "ready"; version: string }
  | { status: "error"; message: string; checkedAt: string | null };

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
/** Let the shell settle before the first check hits the network. */
export const UPDATE_FIRST_CHECK_DELAY_MS = 15_000;

export function updateVersion(state: UpdateState): string | null {
  switch (state.status) {
    case "available":
    case "downloading":
    case "ready":
      return state.version;
    default:
      return null;
  }
}
