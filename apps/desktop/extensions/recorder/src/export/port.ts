/**
 * The export Worker as whoever runs it sees it (protocol.ts): the engine's
 * real `Worker` (src/engine/exports.ts), or the `?fake=1` dev kit's stand-in
 * in the editor's page.
 */
import type { ExportEvent, ExportMessage } from "./protocol.js";

export interface ExportPort {
  send(message: ExportMessage, transfer?: Transferable[]): void;
  listen(fn: (event: ExportEvent) => void): void;
  terminate(): void;
}

export function workerPort(worker: Worker): ExportPort {
  return {
    send: (message, transfer) => worker.postMessage(message, transfer ?? []),
    listen: (fn) => {
      worker.addEventListener("message", (event: MessageEvent<ExportEvent>) => fn(event.data));
      worker.addEventListener("error", (event: ErrorEvent) => fn({ type: "error", message: event.message || "The export stopped" }));
    },
    terminate: () => worker.terminate(),
  };
}
