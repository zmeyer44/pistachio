import type { MediaChunk } from "./media-protocol.js";
export interface EncodedMediaSurface { url: string; append(chunks: MediaChunk[]): void; duration(value: number | null): void; close(): void; }
/** Rebuild a MediaSource from the source player's original encoded buffers. */
export function createEncodedMediaSurface(fail: () => void): EncodedMediaSurface | null {
  const Constructor = globalThis.MediaSource ?? (globalThis as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;
  if (!Constructor) return null;
  const source = new Constructor();
  const url = URL.createObjectURL(source);
  const buffers = new Map<number, SourceBuffer>();
  const queue: MediaChunk[] = [];
  let pending: Uint8Array[] = [];
  let bytes = 0;
  let last = 0;
  let disposed = false;
  let failed = false;
  let wantedDuration: number | null = null;
  const error = (): void => { if (!disposed && !failed) { failed = true; fail(); } };
  const pump = (): void => {
    if (disposed || failed || source.readyState === "closed" || [...buffers.values()].some(buffer => buffer.updating)) return;
    try {
      while (queue.length) {
        const chunk = queue.shift()!;
        if (chunk.op === "add") {
          if (!chunk.mime || !Constructor.isTypeSupported(chunk.mime)) { error(); return; }
          const buffer = source.addSourceBuffer(chunk.mime);
          buffers.set(chunk.track, buffer); buffer.addEventListener("updateend", pump); buffer.addEventListener("error", error);
          continue;
        }
        if (chunk.op === "end") { if (source.readyState === "open") source.endOfStream(); continue; }
        const buffer = buffers.get(chunk.track);
        if (!buffer) { error(); return; }
        if (chunk.op === "abort") { buffer.abort(); continue; }
        if (chunk.op === "drop") { buffer.removeEventListener("updateend", pump); buffer.removeEventListener("error", error); source.removeSourceBuffer(buffer); buffers.delete(chunk.track); continue; }
        if (chunk.op === "type") { buffer.changeType(chunk.mime!); continue; }
        if (chunk.op === "remove") { buffer.remove(chunk.start!, chunk.stop!); return; }
        if (chunk.op === "append") {
          const binary = atob(chunk.data ?? "");
          const data = Uint8Array.from(binary, char => char.charCodeAt(0));
          bytes -= binary.length; pending.push(data);
          if (pending.reduce((sum, part) => sum + part.length, 0) > 8 * 1024 * 1024) { error(); return; }
          if (!chunk.end) continue;
          const joined = new Uint8Array(pending.reduce((sum, part) => sum + part.length, 0));
          let at = 0; for (const part of pending) { joined.set(part, at); at += part.length; } pending = [];
          if (chunk.mode) buffer.mode = chunk.mode;
          if (chunk.offset !== undefined) buffer.timestampOffset = chunk.offset;
          buffer.appendWindowEnd = Infinity; buffer.appendWindowStart = chunk.start ?? 0;
          buffer.appendWindowEnd = chunk.stop ?? Infinity;
          buffer.appendBuffer(joined); return;
        }
      }
      if (wantedDuration !== null && source.readyState === "open" && source.duration !== wantedDuration) source.duration = wantedDuration;
    } catch { error(); }
  };
  source.addEventListener("sourceopen", pump);
  return {
    url,
    append: chunks => {
      for (const chunk of chunks) {
        if (chunk.seq <= last) continue;
        if (chunk.seq !== last + 1) { error(); return; }
        last = chunk.seq; bytes += chunk.data ? chunk.data.length * 3 / 4 - (chunk.data.endsWith("==") ? 2 : chunk.data.endsWith("=") ? 1 : 0) : 0;
        if (bytes > 16 * 1024 * 1024 || queue.length >= 1024) { error(); return; }
        queue.push(chunk);
      }
      pump();
    },
    duration: value => { wantedDuration = value; pump(); },
    close: () => {
      disposed = true; queue.length = 0; pending = [];
      source.removeEventListener("sourceopen", pump);
      for (const buffer of buffers.values()) { buffer.removeEventListener("updateend", pump); buffer.removeEventListener("error", error); }
      URL.revokeObjectURL(url);
    },
  };
}
