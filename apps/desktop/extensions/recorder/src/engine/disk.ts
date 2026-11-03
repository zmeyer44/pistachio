/** Free space (docs/recorder.md §2 "While recording"): checked before starting and every ten seconds while recording. Pure. */

export const GB = 1e9;
/** Under this, a recording is refused, and a running one stops and is saved. */
export const REFUSE_UNDER = 1 * GB;
/** Under this, a recording starts with a warning. */
export const WARN_UNDER = 5 * GB;
export const DISK_CHECK_MS = 10_000;

export function startVerdict(freeBytes: number): "refuse" | "warn" | "ok" {
  if (!Number.isFinite(freeBytes)) return "ok";
  if (freeBytes < REFUSE_UNDER) return "refuse";
  if (freeBytes < WARN_UNDER) return "warn";
  return "ok";
}

export function watchVerdict(freeBytes: number): "stop" | "ok" {
  return Number.isFinite(freeBytes) && freeBytes < REFUSE_UNDER ? "stop" : "ok";
}

export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${String(Math.round(bytes / 1e6))} MB`;
  return `${String(Math.max(0, Math.round(bytes / 1e3)))} KB`;
}

/** Roughly how long the disk lasts at a bitrate (bits a second), for the warning. */
export function minutesLeft(freeBytes: number, bitsPerSecond: number): number {
  if (bitsPerSecond <= 0) return Infinity;
  return Math.max(0, (freeBytes - REFUSE_UNDER) / (bitsPerSecond / 8) / 60);
}
