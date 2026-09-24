/**
 * Downloads for a browser session (docs/web-browser-design.md §11).
 *
 * A download in the cloud lands on the WORKER's disk, which is nobody's
 * Downloads folder. So the bytes are kept under
 * `CLOUD_BROWSER_STATE_DIR/<userId>/downloads/<id>` for 24 hours and the
 * shell fetches them over one HTTP GET whose token is minted here: one use,
 * sixty seconds, and bound to the DOWNLOAD KEY of the viewer that asked for
 * it — a secret handed to that one socket after it proved this Space's key,
 * which the fetch presents in a header. The socket never carries the file (a
 * 200 MB installer through a JSON frame would stall every pane on the
 * session), and the URL on its own is not enough: forwarded into a chat
 * message or a log it opens nothing.
 *
 * The record shape is the desktop's `BrowserDownload` unchanged, so the
 * downloads chip, the popover and the site-controls transfer list render the
 * cloud's downloads with the code that renders a Mac's.
 */

import { createHash, randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import type { Download } from "playwright-core";
import { browserOrigin, type BrowserDownload } from "@pistachio/shell-contracts/browser-controls";
import { errorMessage, silentLogger, type Logger } from "../logger.js";

/** How long a finished download stays fetchable before the sweep removes it. */
export const DOWNLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;
/** How long one minted URL works. */
export const DOWNLOAD_TOKEN_TTL_MS = 60_000;

/**
 * How many bytes of downloads one person may leave on a worker. Sessions of
 * different users share the disk, so a page that downloads in a loop is a
 * page that fills it for everybody; past the cap the oldest settled files go
 * first, and if that is not enough the new one is refused.
 */
export const DOWNLOAD_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

/** How often the bytes on disk are read, rather than the records in memory. */
export const DIRECTORY_SWEEP_INTERVAL_MS = 5 * 60_000;

interface Kept {
  record: BrowserDownload;
  /** Absolute path of the saved bytes; null until the transfer settles. */
  path: string | null;
  /** The Playwright handle, while it is still live, so a cancel can bite. */
  handle: Download | null;
}

interface Minted {
  downloadId: string;
  /**
   * SHA-256 of the download key of the viewer that asked for the URL. The
   * redeem has to present the key itself, which only that viewer holds — it
   * was handed to it over its own proven socket (§5) — so a URL copied out of
   * this browser tab opens nothing. The hash rather than the key so a dump of
   * this map is not a set of viewer credentials.
   */
  viewerKeyHash: string;
  expiresAt: number;
}

export interface SessionDownloadsOptions {
  userId: string;
  /** `CLOUD_BROWSER_STATE_DIR`; downloads live under `<stateDir>/<userId>/downloads`. */
  stateDir: string;
  now?: () => number;
  log?: Logger;
}

/** What the shell server needs to answer one `GET …/downloads/:id`. */
export interface DownloadStream {
  fileName: string;
  bytes: number;
  body: Readable;
}

export class SessionDownloads {
  readonly #userId: string;
  readonly #root: string;
  readonly #now: () => number;
  readonly #log: Logger;
  readonly #kept = new Map<string, Kept>();
  readonly #tokens = new Map<string, Minted>();
  readonly #listeners = new Set<(downloads: BrowserDownload[]) => void>();
  #sweeping: Promise<void> | null = null;
  #sweptAt = 0;

  constructor(options: SessionDownloadsOptions) {
    this.#userId = options.userId;
    this.#root = resolve(options.stateDir, options.userId, "downloads");
    this.#now = options.now ?? ((): number => Date.now());
    this.#log = options.log ?? silentLogger;
  }

  get userId(): string {
    return this.#userId;
  }

  /** Newest first, exactly as the desktop's `downloads()` orders them. */
  list(): BrowserDownload[] {
    this.sweep();
    return [...this.#kept.values()]
      .map((entry) => entry.record)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((record) => ({ ...record }));
  }

  onChanged(listener: (downloads: BrowserDownload[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * A page started a download. The record appears at once — the chip must
   * light the moment the click happens, not when the bytes are in — and the
   * save runs behind it.
   */
  accept(tabId: string, pageUrl: string, download: Download): BrowserDownload {
    const id = randomUUID();
    const at = this.#now();
    const record: BrowserDownload = {
      id,
      tabId,
      origin: browserOrigin(pageUrl),
      url: download.url(),
      fileName: safeFileName(download.suggestedFilename()),
      receivedBytes: 0,
      totalBytes: 0,
      state: "progress",
      createdAt: at,
      finishedAt: null,
      reason: "",
      source: "default",
    };
    this.#kept.set(id, { record, path: null, handle: download });
    this.#emit();
    void this.#save(id, download);
    return { ...record };
  }

  /** A record the host made itself (printing to PDF), already on disk. */
  adopt(input: {
    tabId: string;
    pageUrl: string;
    fileName: string;
    path: string;
    bytes: number;
  }): BrowserDownload {
    const id = randomUUID();
    const at = this.#now();
    const record: BrowserDownload = {
      id,
      tabId: input.tabId,
      origin: browserOrigin(input.pageUrl),
      url: input.pageUrl,
      fileName: safeFileName(input.fileName),
      receivedBytes: input.bytes,
      totalBytes: input.bytes,
      state: "completed",
      createdAt: at,
      finishedAt: at,
      reason: "",
      source: "default",
    };
    this.#kept.set(id, { record, path: input.path, handle: null });
    this.#emit();
    return { ...record };
  }

  /** Where a host-made file belongs, with the directory already there. */
  async reserve(name: string): Promise<{ id: string; path: string }> {
    const id = randomUUID();
    await mkdir(this.#root, { recursive: true });
    return { id, path: join(this.#root, `${id}-${safeFileName(name)}`) };
  }

  async cancel(downloadId: string): Promise<void> {
    const entry = this.#kept.get(downloadId);
    if (entry === undefined || entry.record.state !== "progress") return;
    await entry.handle?.cancel().catch(() => undefined);
    entry.handle = null;
    entry.record = { ...entry.record, state: "cancelled", finishedAt: this.#now(), reason: "Cancelled." };
    this.#emit();
  }

  /** Drop one settled record and its bytes; a live transfer is cancelled first. */
  async remove(downloadId: string): Promise<void> {
    const entry = this.#kept.get(downloadId);
    if (entry === undefined) return;
    if (entry.record.state === "progress") return;
    this.#kept.delete(downloadId);
    for (const [token, minted] of this.#tokens) if (minted.downloadId === downloadId) this.#tokens.delete(token);
    if (entry.path !== null) await rm(entry.path, { force: true }).catch(() => undefined);
    this.#emit();
  }

  async clearFinished(): Promise<void> {
    for (const entry of [...this.#kept.values()]) {
      if (entry.record.state !== "progress") await this.remove(entry.record.id);
    }
  }

  /**
   * One URL's worth of authority: this download, this viewer, sixty seconds,
   * once. The token travels in a query string, which is exactly why it is not
   * the whole credential: the redeem also wants the viewer's own download key
   * back, and only the socket that proved this Space holds one.
   */
  mint(downloadId: string, viewerKey: string): string | null {
    const entry = this.#kept.get(downloadId);
    if (entry === undefined || entry.record.state !== "completed" || entry.path === null) return null;
    if (viewerKey === "") return null;
    this.#sweepTokens();
    const token = `pdl_${randomBytes(24).toString("base64url")}`;
    this.#tokens.set(token, {
      downloadId,
      viewerKeyHash: hashKey(viewerKey),
      expiresAt: this.#now() + DOWNLOAD_TOKEN_TTL_MS,
    });
    return token;
  }

  /**
   * Spend a token. A second attempt with the same one finds nothing, and a
   * request that cannot present the viewer key the token was bound to finds
   * nothing either — the token in the URL is half the credential.
   */
  async redeem(downloadId: string, token: string, viewerKey: string): Promise<DownloadStream | null> {
    this.#sweepTokens();
    const minted = this.#tokens.get(token);
    if (minted === undefined || !constantEquals(minted.downloadId, downloadId)) return null;
    if (viewerKey === "" || !constantEquals(minted.viewerKeyHash, hashKey(viewerKey))) return null;
    this.#tokens.delete(token);
    const entry = this.#kept.get(downloadId);
    if (entry?.path == null) return null;
    const info = await stat(entry.path).catch(() => null);
    if (info === null) return null;
    return { fileName: entry.record.fileName, bytes: info.size, body: createReadStream(entry.path) };
  }

  /** Records past their retention, and the files under them, go (§11). */
  sweep(): void {
    const cutoff = this.#now() - DOWNLOAD_RETENTION_MS;
    let changed = false;
    for (const entry of [...this.#kept.values()]) {
      if (entry.record.createdAt > cutoff) continue;
      this.#kept.delete(entry.record.id);
      if (entry.path !== null) void rm(entry.path, { force: true }).catch(() => undefined);
      changed = true;
    }
    this.#sweepTokens();
    if (changed) this.#emit();
    // Reading the directory is real I/O and `list()` is called on every
    // snapshot, so the disk pass runs on its own slow clock.
    if (this.#now() - this.#sweptAt >= DIRECTORY_SWEEP_INTERVAL_MS) {
      this.#sweptAt = this.#now();
      void this.sweepDirectory().catch(() => undefined);
    }
  }

  /**
   * The bytes on DISK, which no session's record may be holding at all.
   *
   * `list()`'s sweep only ever reached files this live session knows about —
   * so a download from a session that was suspended, ended, or served by a
   * process that has since restarted stayed on the shared worker for ever,
   * against §11's twenty-four-hour retention. This reads the directory
   * instead, and is what actually keeps the promise.
   */
  async sweepDirectory(): Promise<void> {
    if (this.#sweeping !== null) return this.#sweeping;
    const work = this.#sweepDirectory().finally(() => {
      this.#sweeping = null;
    });
    this.#sweeping = work;
    return work;
  }

  async #sweepDirectory(): Promise<void> {
    const cutoff = this.#now() - DOWNLOAD_RETENTION_MS;
    const names = await readdir(this.#root).catch(() => null);
    if (names === null) return;
    const live = new Set(
      [...this.#kept.values()].flatMap((entry) => (entry.path === null ? [] : [entry.path])),
    );
    const files: Array<{ path: string; bytes: number; at: number }> = [];
    for (const name of names) {
      const path = join(this.#root, name);
      const info = await stat(path).catch(() => null);
      if (info === null || !info.isFile()) continue;
      if (info.mtimeMs <= cutoff && !live.has(path)) {
        await rm(path, { force: true }).catch(() => undefined);
        continue;
      }
      files.push({ path, bytes: info.size, at: info.mtimeMs });
    }
    // The quota is the second half: retention alone lets a page fill a shared
    // disk inside the window. Oldest first, and never a file a live transfer
    // is still writing into.
    let total = files.reduce((sum, file) => sum + file.bytes, 0);
    if (total <= DOWNLOAD_QUOTA_BYTES) return;
    for (const file of files.sort((left, right) => left.at - right.at)) {
      if (total <= DOWNLOAD_QUOTA_BYTES) break;
      if (live.has(file.path) && this.#isTransferring(file.path)) continue;
      await rm(file.path, { force: true }).catch(() => undefined);
      total -= file.bytes;
      for (const entry of [...this.#kept.values()]) {
        if (entry.path === file.path) this.#kept.delete(entry.record.id);
      }
    }
    this.#emit();
  }

  #isTransferring(path: string): boolean {
    for (const entry of this.#kept.values()) {
      if (entry.path === path && entry.record.state === "progress") return true;
    }
    return false;
  }

  /**
   * Forget the session's records; the bytes stay for the retention window,
   * which the directory sweep — not this session's memory — is what enforces.
   */
  close(): void {
    this.#listeners.clear();
    this.#tokens.clear();
    this.#sweptAt = 0;
    void this.sweepDirectory().catch((error: unknown) => {
      this.#log.warn("sweeping the download directory failed", { error: errorMessage(error) });
    });
  }

  async #save(id: string, download: Download): Promise<void> {
    const entry = this.#kept.get(id);
    if (entry === undefined) return;
    const path = join(this.#root, `${id}-${entry.record.fileName}`);
    try {
      await mkdir(this.#root, { recursive: true });
      await download.saveAs(path);
      const info = await stat(path);
      const current = this.#kept.get(id);
      if (current === undefined) {
        await rm(path, { force: true }).catch(() => undefined);
        return;
      }
      if (current.record.state === "cancelled") return;
      current.path = path;
      current.handle = null;
      current.record = {
        ...current.record,
        state: "completed",
        receivedBytes: info.size,
        totalBytes: info.size,
        finishedAt: this.#now(),
      };
    } catch (error) {
      const current = this.#kept.get(id);
      if (current === undefined || current.record.state === "cancelled") return;
      current.handle = null;
      current.record = {
        ...current.record,
        state: "interrupted",
        finishedAt: this.#now(),
        reason: errorMessage(error),
      };
      this.#log.warn("a download could not be saved", { error: errorMessage(error) });
    }
    this.#emit();
  }

  #sweepTokens(): void {
    const at = this.#now();
    for (const [token, minted] of this.#tokens) if (minted.expiresAt <= at) this.#tokens.delete(token);
  }

  #emit(): void {
    const downloads = [...this.#kept.values()]
      .map((entry) => ({ ...entry.record }))
      .sort((left, right) => right.createdAt - left.createdAt);
    for (const listener of [...this.#listeners]) {
      try {
        listener(downloads);
      } catch (error) {
        this.#log.warn("a downloads listener threw", { error: errorMessage(error) });
      }
    }
  }
}

/** A page names its own download; the name must not name a directory. */
export function safeFileName(value: string): string {
  const cleaned = value
    // eslint-disable-next-line no-control-regex -- a page names its own file; control bytes in a path are exactly what must not survive
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_")
    .replace(/^\.+/u, "_")
    .trim();
  return cleaned === "" ? "download" : cleaned.slice(0, 180);
}

function hashKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
