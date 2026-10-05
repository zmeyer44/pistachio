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
  | { status: "available"; version: string; releaseDate: string | null; prompt: UpdatePrompt }
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

/**
 * Whether the shell should put the update dialog over the page for the
 * release on offer. Main keeps the person's answers (main/update-service.ts)
 * and works this out; the shell raises the dialog while it is `due`. The
 * sidebar pill is there either way.
 */
export interface UpdatePrompt {
  /** Never put off, or the last "tomorrow" has run out. */
  due: boolean;
  /**
   * How many times an update has been put off on this build. The first
   * prompt offers only "tomorrow"; from the second on it offers "later" too.
   */
  snoozes: number;
}

/**
 * How the person put the dialog off: for a day, whatever release is on
 * offer, or for the rest of this release — a newer one asks again.
 */
export type UpdateSnooze = "tomorrow" | "later";

export const UPDATE_SNOOZE_MS = 24 * 60 * 60 * 1_000;

/** The person's answers, as main keeps them on disk. */
export interface UpdateSnoozeRecord {
  /** The build that was running when they answered: an install starts over. */
  build: string;
  /** The release they were offered. "later" holds for it alone. */
  version: string;
  /** No dialog before this moment, whatever release is on offer; null after "later". */
  until: string | null;
  /** How many times they have put an update off on this build. */
  count: number;
}

export function updatePrompt(record: UpdateSnoozeRecord | null, build: string, version: string, now: Date): UpdatePrompt {
  if (record === null || record.build !== build) return { due: true, snoozes: 0 };
  // A day's snooze holds over a newer release too: "tomorrow" was a promise
  // about the person's day, not about one version.
  const due = record.until === null ? record.version !== version : !(now.getTime() < Date.parse(record.until));
  return { due, snoozes: record.count };
}

export function snoozeUpdate(
  record: UpdateSnoozeRecord | null,
  build: string,
  version: string,
  choice: UpdateSnooze,
  now: Date,
): UpdateSnoozeRecord {
  return {
    build,
    version,
    until: choice === "tomorrow" ? new Date(now.getTime() + UPDATE_SNOOZE_MS).toISOString() : null,
    count: record !== null && record.build === build ? record.count + 1 : 1,
  };
}

/** A record read back from disk, or null when it is not one. */
export function parseUpdateSnoozeRecord(value: unknown): UpdateSnoozeRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const { build, version, until, count } = value as Record<string, unknown>;
  if (typeof build !== "string" || typeof version !== "string") return null;
  if (until !== null && (typeof until !== "string" || Number.isNaN(Date.parse(until)))) return null;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return null;
  return { build, version, until, count };
}

export function isUpdateSnooze(value: unknown): value is UpdateSnooze {
  return value === "tomorrow" || value === "later";
}
