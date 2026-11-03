/**
 * The export Worker's protocol (docs/recorder.md §5). The Worker has no
 * `pistachio` (that global lives in its owner's world), so it READS the
 * recording by `fetch`ing the extension's own data URLs with Range headers
 * (`pistachio-ext://<id>/__data__/recordings/<rec>/screen.mp4`, same origin)
 * and WRITES by posting chunks back to its owner — the engine, in the
 * extension's worker (src/engine/exports.ts), so an export outlives the
 * editor that asked for it — which appends them through
 * `pistachio.files.data.open(...)` and then `files.save`s the result.
 *
 * - The Worker is an ES module, from the extension's root: `new Worker(new URL("/src/export/export.worker.js", location.href), { type: "module" })`.
 * - Chunks are the output file's bytes in order (`seq` 0, 1, 2, …), each at
 *   most 4 MiB: append each one and answer `written` with its `seq`. At most
 *   four are unanswered at a time; the Worker waits for an answer before it
 *   posts a fifth.
 * - `done` comes after every chunk was answered: the file is complete, close it.
 * - `error` and `cancelled` end the export too: abort the writable and remove
 *   the partial file. One export per Worker at a time; a `start` while one runs
 *   is answered with an `error`.
 */

import type { Project, MetaEvent } from "../lib/types.js";

export interface ExportRequest {
  type: "start";
  /** The recording's data folder, `recordings/<id>` (relative to the extension's data root). */
  recordingDir: string;
  /** Absolute URLs the Worker can fetch (from `pistachio.files.data.url`). */
  urls: { screen: string; mic: string | null; camera: string | null; events: string };
  project: Project;
  meta: MetaEvent;
  /** Where the owner writes the chunks (a data path it opened). */
  outputPath: string;
}

export type ExportMessage =
  | ExportRequest
  | { type: "cancel" }
  /** The owner's answer to a `chunk`: it was written (backpressure). */
  | { type: "written"; seq: number };

export type ExportEvent =
  | { type: "progress"; fraction: number; etaSeconds: number | null; frames: number }
  | { type: "chunk"; seq: number; bytes: ArrayBuffer }
  | { type: "done"; bytes: number; durationSeconds: number }
  | { type: "error"; message: string }
  | { type: "cancelled" };
