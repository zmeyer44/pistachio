import type { MediaBatch, MediaChunk } from "./media-protocol.js";
export interface MediaSourceRecorder {
  source(url: string): { id: string; failed: boolean } | null;
  read(source: string, after: number): MediaBatch | null;
}
/** Capture the encoded buffers already fetched by the site's own player.
 * Installed before site JS; no requests, decoding, or site-script replay. */
export function installMediaSourceRecorder(): MediaSourceRecorder {
  type Entry = Omit<MediaChunk, "data"> & { bytes?: Uint8Array };
  type Source = { id: string; records: Entry[]; seq: number; bytes: number; failed: boolean; tracks: number; lastUsed: number };
  const byObject = new WeakMap<MediaSource, Source>();
  const byUrl = new Map<string, Source>();
  const byId = new Map<string, Source>();
  const tracks = new WeakMap<SourceBuffer, { source: Source; track: number }>();
  let retainedBytes = 0;
  const fail = (source: Source): void => { source.failed = true; retainedBytes -= source.bytes; source.records = []; source.bytes = 0; };
  const remember = (source: Source, entry: Omit<Entry, "seq">): void => {
    if (source.failed) return;
    const bytes = entry.bytes?.byteLength ?? 0;
    source.bytes += bytes;
    retainedBytes += bytes;
    source.records.push({ ...entry, seq: ++source.seq });
    // A bounded replay window, not a lifetime byte limit: an attached viewer
    // can stream indefinitely. A viewer that misses this window must recover.
    while (retainedBytes > 64 * 1024 * 1024 || source.records.length > 8192) {
      const victim = retainedBytes > 64 * 1024 * 1024
        ? [...byId.values()].reduce((largest, item) => item.bytes > largest.bytes ? item : largest, source) : source;
      const removed = victim.records.shift();
      if (!removed) break;
      const size = removed.bytes?.byteLength ?? 0;
      victim.bytes -= size; retainedBytes -= size;
    }
  };
  const api: MediaSourceRecorder = {
    source: url => { const source = byUrl.get(url); if (source) source.lastUsed = Date.now(); return source ? { id: source.id, failed: source.failed } : null; },
    read: (id, after) => {
      const source = byId.get(id);
      if (!source) return null;
      const chunks: MediaChunk[] = [];
      let bytes = 0;
      for (const entry of source.records) {
        if (entry.seq <= after) continue;
        if (chunks.length >= 8 || (bytes && bytes + (entry.bytes?.byteLength ?? 0) > 768 * 1024)) break;
        const { bytes: data, ...rest } = entry;
        const chunk: MediaChunk = rest;
        if (data) {
          let binary = "";
          for (let at = 0; at < data.length; at += 16384) binary += String.fromCharCode(...data.subarray(at, at + 16384));
          chunk.data = btoa(binary); bytes += data.length;
        }
        chunks.push(chunk);
      }
      return { source: id, failed: source.failed || (source.records[0]?.seq ?? source.seq + 1) > after + 1, chunks };
    },
  };
  if (typeof MediaSource === "undefined" || typeof SourceBuffer === "undefined") return api;
  const create = URL.createObjectURL;
  URL.createObjectURL = function (object: Blob | MediaSource): string {
    const url = create.call(this, object);
    if (object instanceof MediaSource) {
      let source = byObject.get(object);
      if (!source) {
        if (byId.size >= 16) {
          const oldest = [...byId.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
          if (oldest && Date.now() - oldest.lastUsed > 10_000) {
            fail(oldest); byId.delete(oldest.id);
            for (const [oldUrl, item] of byUrl) if (item === oldest) byUrl.delete(oldUrl);
          }
        }
        source = { id: Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-"), records: [], seq: 0, bytes: 0, failed: byId.size >= 16, tracks: 0, lastUsed: Date.now() };
        byObject.set(object, source);
        if (!source.failed) byId.set(source.id, source);
      }
      byUrl.set(url, source);
      while (byUrl.size > 64) byUrl.delete(byUrl.keys().next().value!);
    }
    return url;
  };
  const add = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime: string): SourceBuffer {
    const buffer = add.call(this, mime);
    const source = byObject.get(this);
    if (source) {
      const track = source.tracks++;
      if (track >= 16) fail(source);
      tracks.set(buffer, { source, track }); remember(source, { op: "add", track, mime });
    }
    return buffer;
  };
  const append = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data: BufferSource): void {
    const tracked = tracks.get(this);
    const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    const copy = tracked && bytes.length <= 8 * 1024 * 1024 ? bytes.slice() : null;
    const settings = { mode: this.mode, offset: this.timestampOffset, start: this.appendWindowStart, stop: Number.isFinite(this.appendWindowEnd) ? this.appendWindowEnd : null };
    append.call(this, data);
    if (!tracked) return;
    if (!copy) { fail(tracked.source); return; }
    for (let at = 0; at < copy.length; at += 256 * 1024) remember(tracked.source, {
      op: "append", track: tracked.track, bytes: copy.subarray(at, at + 256 * 1024), end: at + 256 * 1024 >= copy.length,
      ...settings,
    });
  };
  const remove = SourceBuffer.prototype.remove;
  SourceBuffer.prototype.remove = function (start: number, end: number): void {
    remove.call(this, start, end);
    const tracked = tracks.get(this); if (tracked) remember(tracked.source, { op: "remove", track: tracked.track, start, stop: end });
  };
  const change = SourceBuffer.prototype.changeType;
  if (change) SourceBuffer.prototype.changeType = function (mime: string): void {
    change.call(this, mime);
    const tracked = tracks.get(this); if (tracked) remember(tracked.source, { op: "type", track: tracked.track, mime });
  };
  const abort = SourceBuffer.prototype.abort;
  SourceBuffer.prototype.abort = function (): void {
    abort.call(this);
    const tracked = tracks.get(this); if (tracked) remember(tracked.source, { op: "abort", track: tracked.track });
  };
  const drop = MediaSource.prototype.removeSourceBuffer;
  MediaSource.prototype.removeSourceBuffer = function (buffer: SourceBuffer): void {
    drop.call(this, buffer);
    const tracked = tracks.get(buffer); if (tracked) { remember(tracked.source, { op: "drop", track: tracked.track }); tracks.delete(buffer); }
  };
  const end = MediaSource.prototype.endOfStream;
  MediaSource.prototype.endOfStream = function (error?: EndOfStreamError): void {
    end.call(this, error);
    const source = byObject.get(this); if (source) { if (error) fail(source); else remember(source, { op: "end", track: 0 }); }
  };
  return api;
}
