/**
 * The `pistachio-ext` scheme (docs/extensions.md §4, "The protocol"; §6.3).
 *
 * Registered privileged at startup (index.ts, the one registerSchemesAsPrivileged
 * call) and handled on each extension's own partition, where it serves that
 * extension's folder read-only:
 *
 * - every response carries the extension CSP (no remote script, no network but
 *   its own origin: every byte out goes through `net.fetch`);
 * - a path is resolved by spelling and by real path inside the folder (a `..`
 *   or a symlink out is a 404), and `.pistachio/` is never served;
 * - `.ts`/`.mts` files are served as JavaScript with their types stripped
 *   (`node:module`'s stripTypeScriptTypes, erasable syntax only);
 * - `/__pistachio__/worker.html` is the page the worker's view loads, which
 *   imports the manifest's `worker.main` as a module;
 * - `/__data__/<path>` serves the extension's data folder with Range support,
 *   so a `<video>` plays a recording still being written.
 *
 * The shell draws the Ledge's icons from the default session, so the scheme
 * is handled there too — serving each extension's declared icon and nothing
 * else.
 */

import { createReadStream, readFileSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { extname } from "node:path";
import { Readable } from "node:stream";
import { EXTENSION_SCHEME } from "@pistachio/shell-contracts/extensions";
import type { PistachioManifest } from "@pistachio/extension-api/manifest";
import { realInside, resolveInside } from "./paths";

export const EXTENSION_SCHEME_PRIVILEGES = {
  scheme: EXTENSION_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
} as const;

/** §6.3, per response. */
export const EXTENSION_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export const WORKER_PAGE = "/__pistachio__/worker.html";
export const DATA_PREFIX = "/__data__/";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".mts": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".jsonl": "application/x-ndjson",
  ".ndjson": "application/x-ndjson",
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * A `Range: bytes=…` header against a file of `size` bytes: the inclusive
 * range to send, "unsatisfiable" (416), or null to send the whole file (no
 * header, or one this does not read — several ranges, another unit).
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (header === null) return null;
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (match === null) return null;
  const [, first, last] = match as unknown as [string, string, string];
  if (first === "" && last === "") return null;
  if (first === "") {
    // The last N bytes.
    const suffix = Number(last);
    if (suffix === 0) return "unsatisfiable";
    if (size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return "unsatisfiable";
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return "unsatisfiable";
  return { start, end };
}

/** The page the worker's view loads: the manifest's `worker.main` as a module, nothing else. */
export function workerHtml(main: string): string {
  const src = `/${main.split("/").map(encodeURIComponent).join("/")}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>worker</title><script type="module" src="${src}"></script></head><body></body></html>`;
}

/** What an extension's page shows while the extension is off, paused or gone: the address kept, nothing of it run. */
export function offPageHtml(name: string): string {
  const escaped = name.replace(/[&<>"']/g, (char) => `&#${String(char.charCodeAt(0))};`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escaped}</title><style>body{font:14px -apple-system,system-ui,sans-serif;color:#666;display:grid;place-items:center;height:100vh;margin:0}</style></head><body><p>This extension is off.</p></body></html>`;
}

/** What the handler needs to know of the extensions, from the service. */
export interface ExtensionFolders {
  /** The folder to serve and its manifest, "off" for one that exists but may not run, null for none. */
  folder(id: string): { root: string; manifest: PistachioManifest; name: string } | { off: string } | null;
  /** The data folder `/__data__/` serves, or null when the extension holds no `files:data`. */
  dataFolder(id: string): string | null;
}

function headers(contentType: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": contentType,
    "content-security-policy": EXTENSION_CSP,
    "x-content-type-options": "nosniff",
    // Hot reload: a saved file is the next load's.
    "cache-control": "no-cache",
    ...extra,
  };
}

const notFound = (): Response => new Response("Not found", { status: 404, headers: headers("text/plain; charset=utf-8") });

const stripped = new Map<string, { mtimeMs: number; code: string }>();

/** A `.ts` file as JavaScript (erasable syntax only), cached by path and mtime. */
export function servedTypeScript(path: string, mtimeMs: number): string {
  const cached = stripped.get(path);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.code;
  const code = stripTypeScriptTypes(readFileSync(path, "utf8"), { mode: "strip", sourceUrl: path });
  stripped.set(path, { mtimeMs, code });
  return code;
}

/** A file under `root` by its URL path, or null when it is not one (outside, a folder, `.pistachio/`, missing). */
export function fileInside(root: string, urlPath: string): { path: string; size: number; mtimeMs: number } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const relativePath = decoded.replace(/^\/+/, "");
  if (relativePath === "" || relativePath.split("/").some((part) => part === ".pistachio")) return null;
  const spelled = resolveInside(root, relativePath);
  if (spelled === null) return null;
  const real = realInside(root, spelled);
  if (real === null) return null;
  try {
    const info = statSync(real);
    return info.isFile() ? { path: real, size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

function streamFile(path: string, start: number, end: number): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>;
}

/** A data file, with Range support. */
export function serveRanged(path: string, size: number, rangeHeader: string | null): Response {
  const type = contentTypeFor(path);
  const range = parseRange(rangeHeader, size);
  if (range === "unsatisfiable") return new Response(null, { status: 416, headers: headers(type, { "content-range": `bytes */${String(size)}`, "accept-ranges": "bytes" }) });
  if (range === null) {
    return new Response(size === 0 ? null : streamFile(path, 0, size - 1), { status: 200, headers: headers(type, { "content-length": String(size), "accept-ranges": "bytes" }) });
  }
  return new Response(streamFile(path, range.start, range.end), {
    status: 206,
    headers: headers(type, {
      "content-range": `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`,
      "content-length": String(range.end - range.start + 1),
      "accept-ranges": "bytes",
    }),
  });
}

/** Answer a request on an extension's own partition, for that extension (`id`) alone. */
export function serveExtensionRequest(request: Request, id: string, folders: ExtensionFolders): Response {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return notFound();
  }
  if (url.hostname !== id) return notFound();
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: headers("text/plain; charset=utf-8") });
  const folder = folders.folder(id);
  if (folder === null) return notFound();
  if ("off" in folder) {
    return url.pathname.endsWith(".html") || url.pathname === "/" ? new Response(offPageHtml(folder.off), { status: 200, headers: headers("text/html; charset=utf-8") }) : notFound();
  }
  if (url.pathname === WORKER_PAGE) {
    const main = folder.manifest.worker?.main;
    return main === undefined ? notFound() : new Response(workerHtml(main), { status: 200, headers: headers("text/html; charset=utf-8") });
  }
  if (url.pathname.startsWith(DATA_PREFIX)) {
    const dataRoot = folders.dataFolder(id);
    if (dataRoot === null) return notFound();
    const file = fileInside(dataRoot, url.pathname.slice(DATA_PREFIX.length));
    return file === null ? notFound() : serveRanged(file.path, file.size, request.headers.get("range"));
  }
  const file = fileInside(folder.root, url.pathname);
  if (file === null) return notFound();
  const extension = extname(file.path).toLowerCase();
  if (extension === ".ts" || extension === ".mts") {
    try {
      return new Response(servedTypeScript(file.path, file.mtimeMs), { status: 200, headers: headers(contentTypeFor(file.path)) });
    } catch (error) {
      // Not erasable TypeScript (an enum, a namespace): the page's console says why, and the status file with it.
      const message = error instanceof Error ? error.message : String(error);
      return new Response(`throw new SyntaxError(${JSON.stringify(`${url.pathname}: ${message}`)});`, { status: 200, headers: headers(contentTypeFor(file.path)) });
    }
  }
  return serveRanged(file.path, file.size, request.headers.get("range"));
}

/** The default session's answer: an enabled or pending extension's declared icon, nothing else (the Ledge draws it). */
export function serveIconRequest(request: Request, icon: (id: string) => { root: string; icon: string } | null): Response {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return notFound();
  }
  const declared = icon(url.hostname);
  if (declared === null) return notFound();
  let path: string;
  try {
    path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  } catch {
    return notFound();
  }
  if (path !== declared.icon) return notFound();
  const file = fileInside(declared.root, url.pathname);
  if (file === null) return notFound();
  return new Response(new Uint8Array(readFileSync(file.path)), { status: 200, headers: headers(contentTypeFor(file.path)) });
}
