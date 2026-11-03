/**
 * Reading the recording in the Worker (protocol.ts): its files are the
 * extension's own data URLs, `pistachio-ext://<id>/__data__/…`, same origin,
 * served with Range support (206 + Content-Range, open-ended ranges too).
 *
 * mediabunny's `UrlSource` is exactly the reader needed: it always asks with
 * `Range: bytes=<from>-`, takes the file's size from `Content-Range`, streams
 * the body and aborts once it has what it wanted, with read-ahead and a cache.
 * Only its retry policy changes: a local file that fails to fetch is a real
 * error, so it gives up after two quick retries instead of backing off forever.
 */
import { ALL_FORMATS, Input, UrlSource } from "mediabunny";

/** Bytes each source may cache: three sources at most (screen, camera, mic). */
const CACHE_BYTES = 32 << 20;

export function openInput(url: string): Input<UrlSource> {
  const source = new UrlSource(url, {
    getRetryDelay: (attempts) => (attempts <= 2 ? 0.1 * attempts : null),
    maxCacheSize: CACHE_BYTES,
  });
  return new Input({ source, formats: ALL_FORMATS });
}

export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not read ${url}: ${String(response.status)}`);
  return response.text();
}
