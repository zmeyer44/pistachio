/**
 * Opening a recording (docs/recorder.md R7, §5): `recordings/<id>/` under the
 * extension's data root — `events.jsonl`, `mic.levels`, `project.json` (or the
 * solved defaults, written back), and the media as data URLs.
 */
import type { Chapter, MetaEvent, Project, RecordedEvent } from "../lib/types.js";
import { lastEventSeconds } from "./derive.js";
import type { Solvers } from "./solvers.js";

export interface LoadedRecording {
  id: string;
  dir: string;
  meta: MetaEvent;
  events: RecordedEvent[];
  chapters: Chapter[];
  micLevels: Float32Array | null;
  /** Data paths (relative to the data root) and their URLs; null when the file is absent. */
  paths: { screen: string; camera: string | null; mic: string | null; events: string; project: string };
  urls: { screen: string | null; camera: string | null; mic: string | null; events: string };
  /** Source seconds, from the events until the media's metadata says. */
  duration: number;
  project: Project;
}

/** A recording id is a folder name: `2026-10-30T15-04-12`. */
export function validRecordingId(id: string | null): id is string {
  return id !== null && /^[\w.-]{1,80}$/.test(id) && !id.startsWith(".");
}

async function readText(path: string): Promise<string> {
  return new TextDecoder().decode(await pistachio.files.data.read(path));
}

/**
 * A file of any size, read through its streaming address (`files.data.url`: the protocol serves the data folder
 * with ranges) — `files.data.read` answers at most 64 MB at a time, and a long recording's event log grows past that.
 */
async function readTextStreamed(path: string): Promise<string> {
  const response = await fetch(pistachio.files.data.url(path));
  if (!response.ok) throw new Error(`could not read ${path} (${String(response.status)})`);
  return response.text();
}

export async function loadRecording(id: string, solvers: Solvers): Promise<LoadedRecording> {
  const dir = `recordings/${id}`;
  const listing = await pistachio.files.data.list(dir).catch(() => []);
  const names = new Set(listing.map((file) => file.path.split("/").pop() ?? file.path));
  const has = (name: string) => names.has(name);
  const path = (name: string) => `${dir}/${name}`;
  if (!has("events.jsonl")) throw new Error(`There is no recording "${id}" (events.jsonl is missing)`);

  const recording = solvers.parseEvents(await readTextStreamed(path("events.jsonl")));
  let micLevels: Float32Array | null = null;
  if (has("mic.levels")) {
    const bytes = await pistachio.files.data.read(path("mic.levels"));
    micLevels = new Float32Array(bytes, 0, Math.floor(bytes.byteLength / 4));
  }
  let project: Project | null = null;
  if (has("project.json")) {
    try {
      project = solvers.readProject(await readText(path("project.json")));
    } catch (error) {
      pistachio.runtime.log("warn", "recorder: project.json unreadable, solving afresh", { message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (project === null) {
    project = solvers.solveDefaults(recording, micLevels);
    await pistachio.files.data.write(path("project.json"), solvers.writeProject(project));
  }

  const paths = {
    screen: path("screen.mp4"),
    camera: has("camera.mp4") ? path("camera.mp4") : null,
    mic: has("mic.m4a") ? path("mic.m4a") : null,
    events: path("events.jsonl"),
    project: path("project.json"),
  };
  const url = (p: string | null) => (p === null ? null : pistachio.files.data.url(p));
  return {
    id,
    dir,
    meta: recording.meta,
    events: recording.events,
    chapters: solvers.chaptersOf(recording.events),
    micLevels,
    paths,
    urls: { screen: has("screen.mp4") ? url(paths.screen) : null, camera: url(paths.camera), mic: url(paths.mic), events: pistachio.files.data.url(paths.events) },
    duration: Math.max(0.5, lastEventSeconds(recording.events), ...project.cuts.map((cut) => cut.out).filter(Number.isFinite)),
    project,
  };
}
