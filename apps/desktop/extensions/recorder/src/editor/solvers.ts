/**
 * The solvers and the renderer the editor calls: src/lib's, one object so the
 * editor names what it uses in one place. The render state is the lib's
 * `renderStateFor` (the export builds it the same way), so the preview and an
 * export draw the same frame. Also the two seams the `?fake=1` dev kit fills:
 * the screen's frames and the export Worker (which the engine runs otherwise).
 */
import * as lib from "../lib/index.js";
import type { ExportPort } from "../export/port.js";

export type { ExportPort };

export interface Solvers {
  parseEvents: typeof lib.parseEvents;
  chaptersOf: typeof lib.chaptersOf;
  pointerAt: typeof lib.pointerAt;
  readProject: typeof lib.readProject;
  writeProject: typeof lib.writeProject;
  solveDefaults: typeof lib.solveDefaults;
  zoomSegments: typeof lib.zoomSegments;
  timeMap: typeof lib.timeMap;
  renderStateFor: typeof lib.renderStateFor;
  createRenderer: typeof lib.createRenderer;
  outputSize: typeof lib.outputSize;
}

export const realSolvers: Solvers = {
  parseEvents: lib.parseEvents,
  chaptersOf: lib.chaptersOf,
  pointerAt: lib.pointerAt,
  readProject: lib.readProject,
  writeProject: lib.writeProject,
  solveDefaults: lib.solveDefaults,
  zoomSegments: lib.zoomSegments,
  timeMap: lib.timeMap,
  renderStateFor: lib.renderStateFor,
  createRenderer: lib.createRenderer,
  outputSize: lib.outputSize,
};

/** What `?fake=1` hands the editor (src/editor/dev-fakes.ts; never loaded otherwise). */
export interface DevKit {
  /** The recorded page at a source time, drawn (there is no screen.mp4 in a plain browser). */
  screenFrame(tSrc: number): CanvasImageSource;
  /** An export that renders the first seconds of the output for real (MediaRecorder → WebM). */
  createExportWorker(draw: (ctx: CanvasRenderingContext2D, tOut: number, width: number, height: number) => void, durationOut: number): ExportPort;
}
