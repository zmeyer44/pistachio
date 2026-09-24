/**
 * Where conversations live between turns and across restarts.
 *
 * One JSON file per thread under `<userData>/threads/`, holding the run as
 * the console shows it and the model history as the runner continues it,
 * plus an index file the thread list reads without opening every thread.
 * Files are written whole via tmp + rename, so a crash mid-write leaves
 * the previous version, never a torn one. Writes coalesce: the controller
 * marks the open thread dirty on every change (each tool call is one) and
 * the store flushes shortly after, or at once when asked.
 *
 * The store never reads a file it did not write into memory as trusted:
 * every loaded record passes the sanitizer, and an unreadable one is
 * skipped rather than failing the list.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { modelMessageSchema } from "ai";
import type { EvidenceEntry } from "@pistachio/evidence";
import { TASK_STATUSES, type RunSummary, type ThreadListItem } from "@pistachio/protocol";

export interface ThreadRecord {
  version: 1;
  /** The Space whose key seals the hosted mirror of this conversation. */
  spaceId?: string;
  run: RunSummary;
  /** The model-facing history the next turn continues from (already trimmed and compacted). */
  model: ModelMessage[];
  /** The run's activity record as signed when the thread was last open; read-only once reopened. */
  evidence?: EvidenceEntry[];
  /** How many of `run.messages` the memory learner has read. */
  learnedThrough?: number;
  /**
   * The evidence chain's signing key (PEM), so the chain continues when the
   * thread is reopened. A local demo key: production keys live in a KMS
   * and never in a file (docs/architecture.md, Evidence).
   */
  signingKey?: string;
}

export const MAX_THREADS = 200;
const INDEX_FILE = "threads.json";
const FLUSH_MS = 250;

interface ThreadIndex {
  version: 1;
  threads: ThreadListItem[];
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isStatus(value: unknown): value is RunSummary["status"] {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

/** The thread list's view of a run. */
export function threadListItem(run: RunSummary): ThreadListItem {
  return frozenItem({
    runId: run.runId,
    title: run.title,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    turns: run.turns,
    messageCount: run.messages.length,
    // Copied, not shared: the entry outlives the turn that made it, and it
    // must not become a second handle on the live run's own origin.
    ...(run.origin === undefined ? {} : { origin: structuredClone(run.origin) }),
    ...(run.executor === undefined ? {} : { executor: structuredClone(run.executor) }),
  });
}

/**
 * An entry, sealed. Entries are immutable once built, and that is what lets
 * `list()` hand the index out without copying every item. Frozen rather than
 * merely documented: a stray write throws here — modules are strict — rather
 * than quietly editing the store's own index and persisting the edit on the
 * next write, and two listeners can never reach each other through a shared
 * entry.
 */
function frozenItem(item: ThreadListItem): ThreadListItem {
  if (item.origin !== undefined) Object.freeze(item.origin);
  if (item.executor !== undefined) Object.freeze(item.executor);
  return Object.freeze(item);
}

/**
 * A loaded run, or null when the file is not one of ours. The run is our
 * own serialisation, so this checks the envelope and the fields the
 * controller dereferences rather than re-validating every message.
 */
export function sanitizeThreadRecord(value: unknown): ThreadRecord | null {
  if (!isRecord(value) || value["version"] !== 1) return null;
  const run = value["run"];
  if (!isRecord(run)) return null;
  if (typeof run["runId"] !== "string" || !ID.test(run["runId"])) return null;
  if (!isStatus(run["status"]) || !isIso(run["startedAt"])) return null;
  if (!Array.isArray(run["messages"]) || !Array.isArray(run["toolCalls"]) || !Array.isArray(run["activity"])) return null;
  const model: ModelMessage[] = [];
  const rawModel = value["model"];
  if (Array.isArray(rawModel)) {
    for (const message of rawModel) {
      const parsed = modelMessageSchema.safeParse(message);
      if (parsed.success) model.push(parsed.data as ModelMessage);
    }
  }
  const summary = run as unknown as RunSummary;
  const repaired: RunSummary = {
    ...summary,
    title: typeof run["title"] === "string" && run["title"] !== "" ? run["title"] : titleFor(String(run["purpose"] ?? "Conversation")),
    updatedAt: isIso(run["updatedAt"]) ? run["updatedAt"] : summary.startedAt,
    turns: typeof run["turns"] === "number" && run["turns"] >= 0 ? run["turns"] : Math.max(1, summary.messages.filter((m) => m.role === "user").length),
    notes: typeof run["notes"] === "string" ? run["notes"] : "",
    // A cloud run has no tab on this desktop; an older local record always had one.
    humanTabId: typeof run["humanTabId"] === "string" ? run["humanTabId"] : null,
    subagents: Array.isArray(run["subagents"]) ? summary.subagents : [],
    context: isRecord(run["context"])
      ? summary.context
      : { tokens: null, compactAt: 0, window: 0, compactions: 0, steps: 0, totalSteps: 0, usage: { inputTokens: 0, outputTokens: 0 } },
    pendingApproval: summary.pendingApproval ?? null,
    pendingQuestion: summary.pendingQuestion ?? null,
    pendingTakeover: summary.pendingTakeover ?? null,
    result: summary.result ?? null,
  };
  const evidence = Array.isArray(value["evidence"]) ? (value["evidence"].filter(isRecord) as unknown as EvidenceEntry[]) : [];
  const learnedThrough = typeof value["learnedThrough"] === "number" && value["learnedThrough"] >= 0 ? Math.floor(value["learnedThrough"]) : 0;
  const signingKey = typeof value["signingKey"] === "string" && value["signingKey"].includes("PRIVATE KEY") ? value["signingKey"] : undefined;
  const spaceId = typeof value["spaceId"] === "string" ? value["spaceId"] : undefined;
  return {
    version: 1,
    run: repaired,
    model,
    evidence,
    learnedThrough,
    ...(spaceId === undefined ? {} : { spaceId }),
    ...(signingKey === undefined ? {} : { signingKey }),
  };
}

export const MAX_THREAD_TITLE = 80;

/** A thread's name: its first request, on one line, cut to fit the list. */
export function titleFor(purpose: string): string {
  const flat = purpose.replace(/\s+/g, " ").trim();
  if (flat === "") return "Conversation";
  return flat.length > MAX_THREAD_TITLE ? `${flat.slice(0, MAX_THREAD_TITLE - 1).trimEnd()}…` : flat;
}

export class ThreadStore {
  readonly #dir: string;
  readonly #indexPath: string;
  readonly #listeners = new Set<(threads: ThreadListItem[]) => void>();
  readonly #now: () => Date;
  #index: ThreadListItem[];
  #pending: { record: ThreadRecord; timer: NodeJS.Timeout } | null = null;
  /** The record whose file write is in flight — served by get() until the bytes land. */
  #inFlight: ThreadRecord | null = null;
  #writing: Promise<void> = Promise.resolve();
  /** Bumped per path by every write, so a slower async write never lands over a newer one. */
  readonly #versions = new Map<string, number>();

  constructor(userDataDir: string, options: { now?: () => Date } = {}) {
    this.#dir = join(userDataDir, "threads");
    this.#indexPath = join(this.#dir, INDEX_FILE);
    this.#now = options.now ?? (() => new Date());
    this.#sweepTemporaries();
    this.#index = this.#readIndex();
  }

  /**
   * Clear out `.tmp` files from a write that never reached its rename —
   * the app was killed between the two. Nothing reads them (`#rebuildIndex`
   * takes only `.json`), so they break nothing; left alone they just pile up
   * in `<userData>/threads/` for the life of the install. Startup is the one
   * moment no write of ours is in flight, so it is the safe time to sweep.
   */
  #sweepTemporaries(): void {
    let names: string[];
    try {
      names = readdirSync(this.#dir);
    } catch {
      return; // No directory yet: nothing has been written.
    }
    for (const name of names) {
      if (!name.endsWith(".tmp")) continue;
      try {
        rmSync(join(this.#dir, name), { force: true });
      } catch {
        // Already gone, or not ours to remove.
      }
    }
  }

  /**
   * Newest first. The array belongs to the caller; the entries in it are
   * shared, and safe to share because every one of them is frozen when it
   * is built (`frozenItem`) — nothing can reach back into the index through
   * one. That is worth the care rather than deep-copying: `publish()` calls
   * this on every snapshot, so the copy would fall on every tab switch,
   * agent step, and media report.
   */
  list(): ThreadListItem[] {
    return [...this.#index];
  }

  get(runId: string): ThreadRecord | null {
    if (!ID.test(runId)) return null;
    if (this.#pending?.record.run.runId === runId) return structuredClone(this.#pending.record);
    if (this.#inFlight?.run.runId === runId) return structuredClone(this.#inFlight);
    try {
      return sanitizeThreadRecord(JSON.parse(readFileSync(this.#path(runId), "utf8")));
    } catch {
      return null;
    }
  }

  /** The most recently touched thread whose file still reads, or null. */
  latest(): ThreadRecord | null {
    for (const item of this.#index) {
      const record = this.get(item.runId);
      if (record !== null) return record;
    }
    return null;
  }

  /** Write soon: coalesces the flood of changes a turn produces. */
  save(record: ThreadRecord): void {
    const snapshot = structuredClone(record);
    // Switching threads is rare; the one being left is written at once.
    if (this.#pending !== null && this.#pending.record.run.runId !== snapshot.run.runId) this.flushSync();
    if (this.#pending !== null) clearTimeout(this.#pending.timer);
    const timer = setTimeout(() => void this.flush(), FLUSH_MS);
    timer.unref();
    this.#pending = { record: snapshot, timer };
    this.#touchIndex(snapshot.run);
  }

  /** Write now, synchronously: a turn ended, a thread is being switched away from. */
  saveNow(record: ThreadRecord): void {
    this.save(record);
    this.flushSync();
  }

  /**
   * Start writing what is pending. The bytes go out asynchronously so a
   * multi-megabyte thread never stalls the main process; `get()` serves
   * the in-flight record meanwhile. Writes are queued in order.
   */
  flush(): Promise<void> {
    const pending = this.#pending;
    if (pending === null) return this.#writing;
    clearTimeout(pending.timer);
    this.#pending = null;
    const record = pending.record;
    this.#inFlight = record;
    this.#writeIndex();
    // The version is claimed now, not when the queued write starts: a
    // synchronous write in the meantime must count as newer than this one.
    const path = this.#path(record.run.runId);
    const version = (this.#versions.get(path) ?? 0) + 1;
    this.#versions.set(path, version);
    this.#writing = this.#writing
      .then(() => this.#writeFileAsync(path, record, version))
      .catch(() => {
        // The in-memory value still wins for this session.
      })
      .then(() => {
        if (this.#inFlight === record) this.#inFlight = null;
      });
    return this.#writing;
  }

  /** Write synchronously — the process is about to exit. */
  flushSync(): void {
    const pending = this.#pending;
    const record = pending?.record ?? this.#inFlight;
    if (pending !== null) clearTimeout(pending.timer);
    this.#pending = null;
    if (record === null) return;
    this.#inFlight = null;
    const path = this.#path(record.run.runId);
    this.#versions.set(path, (this.#versions.get(path) ?? 0) + 1);
    this.#writeFile(path, record);
    this.#writeIndex();
  }

  /** Resolves once every queued write has landed. */
  settled(): Promise<void> {
    return this.#writing;
  }

  remove(runId: string): boolean {
    if (!ID.test(runId)) return false;
    if (this.#pending?.record.run.runId === runId) {
      clearTimeout(this.#pending.timer);
      this.#pending = null;
    }
    if (this.#inFlight?.run.runId === runId) this.#inFlight = null;
    const before = this.#index.length;
    this.#index = this.#index.filter((item) => item.runId !== runId);
    // A write still queued for this thread must not bring the file back.
    this.#invalidate(this.#path(runId));
    try {
      rmSync(this.#path(runId), { force: true });
    } catch {
      // The index no longer points at it; a stray file is harmless.
    }
    this.#writeIndex();
    return this.#index.length !== before;
  }

  onChange(listener: (threads: ThreadListItem[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #path(runId: string): string {
    return join(this.#dir, `${runId}.json`);
  }

  #touchIndex(run: RunSummary): void {
    const item = threadListItem(run);
    this.#index = [item, ...this.#index.filter((existing) => existing.runId !== run.runId)];
    if (this.#index.length > MAX_THREADS) {
      for (const dropped of this.#index.slice(MAX_THREADS)) {
        this.#invalidate(this.#path(dropped.runId));
        try {
          rmSync(this.#path(dropped.runId), { force: true });
        } catch {
          // Already gone.
        }
      }
      this.#index = this.#index.slice(0, MAX_THREADS);
    }
    this.#notify();
  }

  #notify(): void {
    // Reached on every save, which is every tool call; building a snapshot
    // nobody has asked for is pure cost.
    if (this.#listeners.size === 0) return;
    const snapshot = this.list();
    for (const listener of this.#listeners) listener([...snapshot]);
  }

  #readIndex(): ThreadListItem[] {
    try {
      const raw = JSON.parse(readFileSync(this.#indexPath, "utf8")) as ThreadIndex;
      if (!isRecord(raw) || raw["version"] !== 1 || !Array.isArray(raw["threads"])) return this.#rebuildIndex();
      const seen = new Set<string>();
      const items: ThreadListItem[] = [];
      for (const item of raw.threads) {
        if (!isRecord(item) || typeof item["runId"] !== "string" || !ID.test(item["runId"]) || seen.has(item["runId"])) continue;
        if (!isStatus(item["status"]) || !isIso(item["startedAt"])) continue;
        seen.add(item["runId"]);
        items.push(frozenItem({
          runId: item["runId"],
          title: typeof item["title"] === "string" && item["title"] !== "" ? item["title"] : "Conversation",
          status: item["status"],
          startedAt: item["startedAt"],
          updatedAt: isIso(item["updatedAt"]) ? item["updatedAt"] : item["startedAt"],
          turns: typeof item["turns"] === "number" ? item["turns"] : 1,
          messageCount: typeof item["messageCount"] === "number" ? item["messageCount"] : 0,
          ...(isRecord(item["origin"]) ? { origin: item["origin"] as ThreadListItem["origin"] } : {}),
          ...(isRecord(item["executor"]) ? { executor: item["executor"] as ThreadListItem["executor"] } : {}),
        }));
      }
      return items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    } catch {
      return this.#rebuildIndex();
    }
  }

  /** No usable index: list the directory instead, so no thread is lost with it. */
  #rebuildIndex(): ThreadListItem[] {
    if (!existsSync(this.#dir)) return [];
    const items: ThreadListItem[] = [];
    let names: string[];
    try {
      names = readdirSync(this.#dir);
    } catch {
      return [];
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name === INDEX_FILE) continue;
      try {
        const record = sanitizeThreadRecord(JSON.parse(readFileSync(join(this.#dir, name), "utf8")));
        if (record !== null) items.push(threadListItem(record.run));
      } catch {
        // Not one of ours.
      }
    }
    return items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  #writeIndex(): void {
    const file: ThreadIndex = { version: 1, threads: this.#index };
    this.#writeFile(this.#indexPath, file);
  }

  /** Any write queued for `path` is stale from now on. */
  #invalidate(path: string): void {
    this.#versions.set(path, (this.#versions.get(path) ?? 0) + 1);
  }

  #writeFile(path: string, value: unknown): void {
    try {
      mkdirSync(this.#dir, { recursive: true });
      const tmp = `${path}.${String(this.#now().getTime())}.tmp`;
      writeFileSync(tmp, JSON.stringify(value));
      renameSync(tmp, path);
    } catch {
      // The in-memory value still wins for this session.
    }
  }

  async #writeFileAsync(path: string, value: unknown, version: number): Promise<void> {
    // A newer write (synchronous, or a later flush) already claimed the path.
    if (this.#versions.get(path) !== version) return;
    mkdirSync(this.#dir, { recursive: true });
    const tmp = `${path}.${String(version)}.tmp`;
    await writeFile(tmp, JSON.stringify(value));
    if (this.#versions.get(path) !== version) {
      rmSync(tmp, { force: true });
      return;
    }
    await rename(tmp, path);
  }
}
