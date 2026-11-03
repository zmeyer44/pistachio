/** A recording's id and its folder (docs/recorder.md R7): `recordings/<id>/`, `<id>` = local time `2026-10-30T15-04-12`. Pure. */
import type { RecordingFiles } from "../lib/types.js";

export const RECORDINGS_DIR = "recordings";

const ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?$/;

const pad = (value: number): string => String(value).padStart(2, "0");

/** `YYYY-MM-DDTHH-mm-ss` in local time: sorts as it reads, and is a safe folder name everywhere. */
export function recordingId(at: Date): string {
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
}

/** The id, or `<id>-2`, `<id>-3`… when a folder of that name is already there (two starts in one second). */
export function uniqueRecordingId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function isRecordingId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** The start time an id spells (local), or null. */
export function recordingIdTime(id: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(id);
  if (match === null) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number) as [number, number, number, number, number, number, number];
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

/** The folder's files; `mic`, `camera` and `micLevels` only when that stream is recorded, `thumb` once taken. */
export function recordingFiles(id: string, streams: { mic: boolean; camera: boolean; thumb?: boolean }): RecordingFiles {
  const dir = `${RECORDINGS_DIR}/${id}`;
  return {
    id,
    dir,
    screen: `${dir}/screen.mp4`,
    mic: streams.mic ? `${dir}/mic.m4a` : null,
    camera: streams.camera ? `${dir}/camera.mp4` : null,
    events: `${dir}/events.jsonl`,
    micLevels: streams.mic ? `${dir}/mic.levels` : null,
    thumb: streams.thumb === false ? null : `${dir}/thumb.jpg`,
    project: `${dir}/project.json`,
  };
}

/** The id a data path under `recordings/` belongs to (`recordings/<id>` or `recordings/<id>/…`), or null. */
export function idOfPath(path: string): string | null {
  const parts = path.split("/");
  if (parts[0] !== RECORDINGS_DIR || parts.length < 2) return null;
  return isRecordingId(parts[1]) ? (parts[1] as string) : null;
}

/** `0:42`, `12:05`, `1:02:09` — the pill's clock and the panel's durations. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${String(hours)}:${pad(minutes)}:${pad(seconds)}` : `${String(minutes)}:${pad(seconds)}`;
}
