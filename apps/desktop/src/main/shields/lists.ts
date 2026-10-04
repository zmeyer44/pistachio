/**
 * The filter-list cache: `<userData>/shields/lists/<id>.txt`, one file per
 * list, plus `lists.json` saying when each was fetched and what the server
 * said about it (docs/shields.md §2).
 *
 * A list is fetched from its maintainer (mirrors after), conditionally — an
 * unchanged list costs a 304 — and again once its `! Expires:` header says
 * it is stale, clamped to 4 hours … 14 days. `!#include` lines are resolved
 * against the list's own address, one level deep and same-origin only, the
 * way uBlock Origin resolves them. Nothing is bundled: a list that has never
 * been fetched is simply not loaded yet.
 *
 * `fetch` is injected (main passes Electron's `net.fetch`, which honors the
 * system proxy), so the policy is unit-tested without a network.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FILTER_LISTS, type FilterListId, type FilterListStatus } from "@pistachio/shell-contracts/shields";

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

/** uBlock Origin's scriptlets and redirect bodies, in the JSON Ghostery's engine reads. */
export const RESOURCES_ID = "resources";
const RESOURCES_URLS = [
  "https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json",
  "https://cdn.jsdelivr.net/gh/ghostery/adblocker@master/packages/adblocker/assets/ublock-origin/resources.json",
];

type SourceId = FilterListId | typeof RESOURCES_ID;

interface ListMeta {
  fetchedAt: number;
  /** When the cached copy goes stale. */
  expiresAt: number;
  /**
   * How long the list says a copy stays fresh. An unchanged (304) answer
   * starts the same period again — measured from fetchedAt it would grow
   * with every check, until an 8-hour list was checked fortnightly.
   */
  period: number;
  /**
   * The cached copy was flattened from `!#include`d files. The parent's
   * validators say nothing about them, so such a list is fetched in full
   * each time — a 304 on the parent would hide a changed (or a previously
   * failed) include for good.
   */
  includes: boolean;
  /**
   * The cached text's content hash: the list's version for the compiled
   * engine's key. Not the fetch time — a download that brings the same text
   * must not invalidate a build that is still exactly right.
   */
  hash: string;
  etag: string | null;
  lastModified: string | null;
  rules: number;
  /** The last attempt's failure, kept until a fetch succeeds. */
  error: string | null;
}

const MIN_EXPIRY_MS = 4 * 3600_000;
const MAX_EXPIRY_MS = 14 * 24 * 3600_000;
/** After a failure, wait this long before trying again on schedule. */
const RETRY_MS = 30 * 60_000;
const MAX_LIST_BYTES = 24 * 1024 * 1024;
/** The whole download — headers and body — must finish within this. */
const FETCH_TIMEOUT_MS = 30_000;
const PARALLEL = 4;

/** `! Expires: 4 days` / `! Expires: 8 hours`, in ms, or null. */
export function listExpiry(text: string): number | null {
  const head = text.slice(0, 4_000);
  const match = /^!\s*Expires:\s*(\d+)\s*(day|hour)s?/im.exec(head);
  if (match === null) return null;
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() === "hour" ? 3600_000 : 24 * 3600_000;
  return Math.min(MAX_EXPIRY_MS, Math.max(MIN_EXPIRY_MS, amount * unit));
}

/** Lines that are rules: not blank, not a comment, not a header. */
export function countRules(text: string): number {
  let rules = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("!") || trimmed.startsWith("[")) continue;
    rules += 1;
  }
  return rules;
}

/** Whether a body looks like a filter list rather than an error page. */
export function looksLikeFilterList(text: string): boolean {
  const head = text.slice(0, 512).trimStart().toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("{")) return false;
  return countRules(text) > 0;
}

interface Download {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
}

export class ListStore {
  readonly #dir: string;
  readonly #metaPath: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  #meta: Partial<Record<SourceId, ListMeta>>;
  readonly #inflight = new Map<SourceId, Promise<boolean>>();

  constructor(directory: string, fetch: FetchLike, options: { timeoutMs?: number } = {}) {
    this.#dir = join(directory, "lists");
    this.#metaPath = join(this.#dir, "lists.json");
    this.#fetch = fetch;
    this.#timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
    this.#meta = this.#readMeta();
  }

  pathFor(id: SourceId): string {
    return join(this.#dir, id === RESOURCES_ID ? "resources.json" : `${id}.txt`);
  }

  has(id: SourceId): boolean {
    return this.#meta[id] !== undefined && this.#meta[id].fetchedAt > 0;
  }

  /** The cached copy's identity, for the compiled engine's key: changes when the text does, and only then. */
  version(id: SourceId): string {
    const meta = this.#meta[id];
    if (meta === undefined) return "none";
    return meta.hash !== "" ? meta.hash : `${String(meta.fetchedAt)}:${meta.etag ?? meta.lastModified ?? ""}`;
  }

  async text(id: SourceId): Promise<string | null> {
    try {
      return await readFile(this.pathFor(id), "utf8");
    } catch {
      return null;
    }
  }

  get fetching(): boolean {
    return this.#inflight.size > 0;
  }

  isFetching(id: SourceId): boolean {
    return this.#inflight.has(id);
  }

  status(id: FilterListId, enabled: boolean): FilterListStatus {
    const meta = this.#meta[id];
    return {
      id,
      enabled,
      state: this.#inflight.has(id) ? "fetching" : meta?.error ? "failed" : meta !== undefined && meta.fetchedAt > 0 ? "ready" : "idle",
      fetchedAt: meta !== undefined && meta.fetchedAt > 0 ? meta.fetchedAt : null,
      rules: meta?.rules ?? 0,
      error: meta?.error ?? null,
    };
  }

  /**
   * The sources among `ids` that are missing or stale. A failed fetch set its
   * `expiresAt` RETRY_MS out, so a list that cannot be reached is tried again
   * on that cadence, not on every check.
   */
  due(ids: readonly SourceId[], now = Date.now()): SourceId[] {
    return ids.filter((id) => {
      const meta = this.#meta[id];
      return meta === undefined || now >= meta.expiresAt;
    });
  }

  /**
   * Fetch `ids`, a few at a time. Resolves with the ones whose cached text
   * CHANGED (a 304 changes nothing), which is what decides a recompile.
   */
  async refresh(ids: readonly SourceId[]): Promise<SourceId[]> {
    const queue = [...ids];
    const changed: SourceId[] = [];
    const worker = async (): Promise<void> => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        if (await this.#refreshOne(id)) changed.push(id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
    return changed;
  }

  #refreshOne(id: SourceId): Promise<boolean> {
    const running = this.#inflight.get(id);
    if (running !== undefined) return running;
    const job = this.#fetchSource(id).finally(() => this.#inflight.delete(id));
    this.#inflight.set(id, job);
    return job;
  }

  async #fetchSource(id: SourceId): Promise<boolean> {
    const definition = FILTER_LISTS.find((list) => list.id === id);
    const urls: readonly string[] = id === RESOURCES_ID ? RESOURCES_URLS : (definition?.urls ?? []);
    const defaultExpiry = (id === RESOURCES_ID ? 7 * 24 : (definition?.expiresHours ?? 96)) * 3600_000;
    const previous = this.#meta[id];
    const cached = previous !== undefined && previous.fetchedAt > 0;
    let lastError = "no address to fetch";
    for (const [index, url] of urls.entries()) {
      try {
        // Validators belong to the address that issued them: only the first.
        const headers: Record<string, string> = {};
        const conditional = index === 0 && cached && !previous.includes;
        if (conditional && previous.etag !== null) headers["If-None-Match"] = previous.etag;
        if (conditional && previous.lastModified !== null) headers["If-Modified-Since"] = previous.lastModified;
        const response = await this.#download(url, headers);
        if (response.status === 304 && cached) {
          this.#setMeta(id, { ...previous, expiresAt: Date.now() + previous.period, error: null });
          return false;
        }
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
        let text = response.text;
        if (text.length > MAX_LIST_BYTES) throw new Error("list is too large");
        const includes = id !== RESOURCES_ID && /^!#include\s/m.test(text);
        if (id === RESOURCES_ID) {
          JSON.parse(text);
        } else {
          if (!looksLikeFilterList(text)) throw new Error("not a filter list");
          text = await this.#resolveIncludes(text, url);
        }
        const hash = contentHash(text);
        const unchanged = cached && previous.hash === hash;
        const expiry = (id === RESOURCES_ID ? null : listExpiry(text)) ?? defaultExpiry;
        writeAtomic(this.pathFor(id), text);
        this.#setMeta(id, {
          fetchedAt: Date.now(),
          expiresAt: Date.now() + expiry,
          period: expiry,
          includes,
          hash,
          etag: index === 0 ? response.headers.get("etag") : null,
          lastModified: index === 0 ? response.headers.get("last-modified") : null,
          rules: id === RESOURCES_ID ? 0 : countRules(text),
          error: null,
        });
        // Fetched in full but the same text (a list with includes, a mirror):
        // nothing to rebuild.
        return !unchanged;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    this.#setMeta(id, {
      fetchedAt: previous?.fetchedAt ?? 0,
      expiresAt: Date.now() + RETRY_MS,
      period: previous?.period ?? defaultExpiry,
      includes: previous?.includes ?? false,
      hash: previous?.hash ?? "",
      etag: previous?.etag ?? null,
      lastModified: previous?.lastModified ?? null,
      rules: previous?.rules ?? 0,
      error: lastError,
    });
    return false;
  }

  /**
   * One download, headers AND body, under one timeout: fetch resolves when
   * the headers arrive, so a server that then stalls would otherwise hold
   * the refresh — and every list waiting on it — forever.
   */
  async #download(url: string, headers: Record<string, string>): Promise<Download> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, { headers, signal: controller.signal });
      if (Number(response.headers.get("content-length") ?? "0") > MAX_LIST_BYTES) throw new Error("list is too large");
      const text = response.status === 304 ? "" : await response.text();
      return { status: response.status, ok: response.ok, headers: response.headers, text };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  /** `!#include file.txt` → the file's text, from beside the list on the same origin. */
  async #resolveIncludes(text: string, base: string): Promise<string> {
    if (!text.includes("!#include")) return text;
    const origin = new URL(base).origin;
    const lines = text.split("\n");
    const out: string[] = [];
    for (const line of lines) {
      const match = /^!#include\s+(\S+)/.exec(line.trim());
      if (match === null) {
        out.push(line);
        continue;
      }
      try {
        const target = new URL(match[1] ?? "", base);
        if (target.origin !== origin) continue;
        const response = await this.#download(target.toString(), {});
        if (!response.ok) continue;
        const included = response.text;
        if (looksLikeFilterList(included) && included.length <= MAX_LIST_BYTES) out.push(included);
      } catch {
        // An include that cannot be fetched is left out; the rest of the list still works.
      }
    }
    return out.join("\n");
  }

  #setMeta(id: SourceId, meta: ListMeta): void {
    this.#meta = { ...this.#meta, [id]: meta };
    try {
      writeAtomic(this.#metaPath, JSON.stringify(this.#meta, null, 2));
    } catch {
      // The in-memory record still serves this run.
    }
  }

  #readMeta(): Partial<Record<SourceId, ListMeta>> {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.#metaPath, "utf8"));
      if (typeof raw !== "object" || raw === null) return {};
      const out: Partial<Record<SourceId, ListMeta>> = {};
      for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value !== "object" || value === null) continue;
        const meta = value as Record<string, unknown>;
        if (typeof meta["fetchedAt"] !== "number" || typeof meta["expiresAt"] !== "number") continue;
        const span = meta["expiresAt"] - meta["fetchedAt"];
        out[id as SourceId] = {
          fetchedAt: meta["fetchedAt"],
          expiresAt: meta["expiresAt"],
          includes: meta["includes"] === true,
          hash: typeof meta["hash"] === "string" ? meta["hash"] : "",
          // A record from before `period` was kept: its first span is the best guess.
          period: typeof meta["period"] === "number" && meta["period"] > 0 ? meta["period"] : Math.min(MAX_EXPIRY_MS, Math.max(MIN_EXPIRY_MS, span > 0 ? span : MIN_EXPIRY_MS)),
          etag: typeof meta["etag"] === "string" ? meta["etag"] : null,
          lastModified: typeof meta["lastModified"] === "string" ? meta["lastModified"] : null,
          rules: typeof meta["rules"] === "number" ? meta["rules"] : 0,
          error: typeof meta["error"] === "string" ? meta["error"] : null,
        };
      }
      return out;
    } catch {
      return {};
    }
  }
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function writeAtomic(path: string, data: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
