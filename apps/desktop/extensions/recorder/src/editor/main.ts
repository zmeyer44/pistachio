/**
 * The editor page (docs/recorder.md §5): preview, timeline, inspector, export sheet.
 * `?rec=<id>` names the recording under `recordings/`. `?fake=1` runs it in a plain
 * browser on a made-up recording (src/editor/dev-fakes.ts, loaded only then) with
 * the real solvers and renderer.
 */
import "./editor.css";
import { mountEditor } from "./app.js";
import { h } from "./dom.js";
import { loadRecording, validRecordingId } from "./load.js";
import { realSolvers, type DevKit } from "./solvers.js";

const params = new URLSearchParams(location.search);
let dev: DevKit | null = null;
if (params.get("fake") === "1") {
  const fakes = await import("./dev-fakes.js");
  dev = fakes.installDevKit();
}

await pistachio.runtime.ready;

const root = h("main", { class: "root" });
document.body.append(root);

const id = params.get("rec") ?? (dev !== null ? "fake" : null);
if (!validRecordingId(id)) {
  showProblem("No recording", "Open a recording from the Recorder's panel.");
} else {
  try {
    const rec = await loadRecording(id, realSolvers);
    const editor = mountEditor(root, rec, realSolvers, dev);
    // The `?fake=1` run only: a handle for poking at it from the console or a script.
    if (dev !== null) Object.assign(window, { recorderEditor: editor });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pistachio.runtime.log("error", "recorder: the editor could not open the recording", { id, message });
    showProblem("This recording can't be opened", message);
  }
}

function showProblem(title: string, body: string): void {
  root.replaceChildren(h("div", { class: "problem" }, h("h1", {}, title), h("p", {}, body)));
}

export {};
