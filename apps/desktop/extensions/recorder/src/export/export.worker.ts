/**
 * The export Worker (docs/recorder.md §5; the messages are protocol.ts):
 * decode → render → encode → mux with mediabunny, GIF with gifenc. `start`
 * runs one export; `cancel` stops it (the output cancelled, the window's
 * waiters released) and answers `cancelled`; `written` frees a chunk's place.
 */
import { runExport } from "./pipeline.js";
import type { ExportEvent, ExportMessage, ExportRequest } from "./protocol.js";
import { Cancelled, ChunkWindow } from "./writer.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;

function post(event: ExportEvent, transfer?: Transferable[]): void {
  scope.postMessage(event, transfer !== undefined ? { transfer } : undefined);
}

interface Running {
  abort: AbortController;
  window: ChunkWindow;
  cancelOutput: (() => Promise<void>) | null;
}

let running: Running | null = null;

scope.onmessage = (event: MessageEvent<ExportMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "start":
      start(message);
      break;
    case "cancel":
      cancel();
      break;
    case "written":
      running?.window.written(message.seq);
      break;
  }
};

function start(request: ExportRequest): void {
  if (running !== null) {
    post({ type: "error", message: "An export is already running." });
    return;
  }
  const window = new ChunkWindow((seq, bytes) => post({ type: "chunk", seq, bytes }, [bytes]));
  const job: Running = { abort: new AbortController(), window, cancelOutput: null };
  running = job;
  runExport(request, {
    signal: job.abort.signal,
    window,
    progress: (fraction, etaSeconds, frames) => post({ type: "progress", fraction, etaSeconds, frames }),
    onCancel: (cancelOutput) => {
      job.cancelOutput = cancelOutput;
    },
  })
    .then((result) => post({ type: "done", bytes: result.bytes, durationSeconds: result.durationSeconds }))
    .catch((error: unknown) => {
      if (job.abort.signal.aborted || error instanceof Cancelled) post({ type: "cancelled" });
      else post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => {
      if (running === job) running = null;
    });
}

function cancel(): void {
  const job = running;
  if (job === null) {
    // Nothing runs (it ended, or never started): answer anyway so the page is never left waiting.
    post({ type: "cancelled" });
    return;
  }
  if (job.abort.signal.aborted) return;
  job.abort.abort();
  job.window.fail(new Cancelled());
  void job.cancelOutput?.();
}
