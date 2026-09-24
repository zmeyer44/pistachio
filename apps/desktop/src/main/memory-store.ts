/**
 * The memory file: `<userData>/memory.json`, the single source of truth for
 * everything the agent knows about the person. Read once at startup,
 * rewritten whole on every change, the way settings.json is.
 *
 * Writes go through the supermemory lifecycle (@pistachio/shell-contracts/memory): `add`
 * versions a keyed fact instead of duplicating it and strengthens a
 * repeated one instead of storing it twice; `update` writes a new version
 * and leaves the old for audit; `forget` is soft; `expire` retires what
 * has a `forgetAfter` in the past. Reads are `profile()` (the standing
 * facts), `search()` (what bears on a question), and `prompt()` (both,
 * rendered for the model).
 *
 * Vectors are optional. With an embedder, every fact is embedded in the
 * background after it is written and search adds semantic similarity to
 * the lexical score; without one — no key, offline — search is lexical and
 * nothing else changes. Vectors live in the same file but never reach the
 * renderer. Embedding is also OFF while memory is off in Settings: a
 * memory the person has switched off must not leave this Mac.
 *
 * A write that is not the person's own is checked for secrets and payment
 * details before it lands, whatever the model was told.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  activeMemories,
  isActive,
  isExpired,
  looksSensitive,
  MAX_MEMORY_ENTRIES,
  memoryPrompt,
  profileView,
  rankMemories,
  sanitizeMemoryDocument,
  sanitizeMemoryEntry,
  type MemoryAddInput,
  type MemoryBucket,
  type MemoryEntry,
  type MemoryKind,
  type MemoryOperation,
  type MemoryProfileView,
  type MemoryPromptOptions,
  type MemoryReview,
  type MemorySnapshot,
  type MemorySource,
  type MemoryUpdateInput,
} from "@pistachio/shell-contracts/memory";

export interface MemoryEmbedder {
  /** Names the model, so switching models invalidates the stored vectors. */
  readonly id: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface MemorySearchOptions {
  limit?: number;
  bucket?: MemoryBucket;
  kind?: MemoryKind;
  includePending?: boolean;
}

export interface MemoryChangeSet {
  added: MemoryEntry[];
  updated: MemoryEntry[];
  forgotten: MemoryEntry[];
}

interface MemoryFile {
  version: 1;
  entries: MemoryEntry[];
  vectors?: { model: string; byId: Record<string, number[]> };
}

/** How long a search waits for vectors before going lexical-only. */
const EMBED_WAIT_MS = 4_000;
const EMBED_BATCH = 48;

function normalized(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * "Home: Lives in Boulder" under the label "Home" is the label twice. A
 * model given a labelled fact tends to hand the label back inside the
 * content; the store keeps the two apart whoever wrote them.
 */
function withoutLabel(content: string, label: string | null): string {
  if (label === null) return content;
  const prefix = `${label.toLowerCase()}:`;
  let text = content;
  while (text.toLowerCase().startsWith(prefix)) text = text.slice(prefix.length).trimStart();
  return text === "" ? content : text;
}

export class MemoryStore {
  readonly #path: string;
  readonly #listeners = new Set<(snapshot: MemorySnapshot) => void>();
  /** Per-version listeners (workspace sync); never told about a remote write. */
  readonly #recordListeners = new Set<(id: string) => void>();
  readonly #embedder: MemoryEmbedder | null;
  readonly #now: () => Date;
  #entries: MemoryEntry[];
  #vectors = new Map<string, number[]>();
  #embedding: Promise<void> | null = null;
  #embedFailed = false;
  #embeddingEnabled: boolean;

  constructor(
    userDataDir: string,
    options: { embedder?: MemoryEmbedder | null; embeddingEnabled?: boolean; now?: () => Date } = {},
  ) {
    this.#path = join(userDataDir, "memory.json");
    this.#embedder = options.embedder ?? null;
    this.#embeddingEnabled = options.embeddingEnabled ?? true;
    this.#now = options.now ?? (() => new Date());
    this.#entries = this.#read();
    this.expire();
    this.#scheduleEmbedding();
  }

  /**
   * Follows Settings → Memory. Off stops every request to the embedding
   * provider — nothing new is embedded and search goes lexical — and on
   * picks up whatever was written in the meantime.
   */
  setEmbeddingEnabled(enabled: boolean): void {
    if (this.#embeddingEnabled === enabled) return;
    this.#embeddingEnabled = enabled;
    if (enabled) this.#scheduleEmbedding();
  }

  /* ------------------------------ reading ------------------------------ */

  /** Every version, forgotten ones included — the audit view. */
  all(): MemoryEntry[] {
    return structuredClone(this.#entries);
  }

  active(): MemoryEntry[] {
    return structuredClone(activeMemories(this.#entries, this.#now()));
  }

  get(id: string): MemoryEntry | null {
    const entry = this.#entries.find((candidate) => candidate.id === id);
    return entry === undefined ? null : structuredClone(entry);
  }

  /** Oldest first. */
  history(rootId: string): MemoryEntry[] {
    return structuredClone(
      this.#entries.filter((entry) => entry.rootId === rootId).sort((a, b) => a.version - b.version),
    );
  }

  snapshot(): MemorySnapshot {
    return { entries: this.all() };
  }

  profile(): MemoryProfileView {
    return structuredClone(profileView(this.#entries, this.#now()));
  }

  prompt(options: Omit<MemoryPromptOptions, "now"> = {}): string {
    this.expire();
    return memoryPrompt(this.#entries, { ...options, now: this.#now() });
  }

  /**
   * What bears on `query`. Waits briefly for vectors when an embedder is
   * configured, then ranks with whatever it has. Every hit is stamped as
   * recalled, so the settings page can show what the agent actually used.
   */
  async search(query: string, options: MemorySearchOptions = {}): Promise<MemoryEntry[]> {
    this.expire();
    const now = this.#now();
    const vectors = await this.#vectorsFor(query);
    const hits = rankMemories(this.#entries, query, {
      now,
      limit: options.limit ?? 8,
      ...(options.bucket === undefined ? {} : { bucket: options.bucket }),
      ...(options.kind === undefined ? {} : { kind: options.kind }),
      ...(options.includePending === undefined ? {} : { includePending: options.includePending }),
      ...(vectors === null ? {} : { vectors }),
    });
    this.recalled(hits.map((entry) => entry.id));
    return structuredClone(hits);
  }

  /* ------------------------------ writing ------------------------------ */

  /**
   * A new fact — unless it is an old one. A keyed fact that already exists
   * is versioned (the settings page saving a name); an unkeyed fact whose
   * text matches an active one is re-asserted (mentions climb, confidence
   * takes the higher value) rather than stored twice.
   */
  add(input: MemoryAddInput, source: MemorySource): MemoryEntry {
    this.#refuseSecrets(input.content, source);
    const now = this.#now();
    const active = activeMemories(this.#entries, now);
    if (input.key !== undefined && input.key !== null) {
      const existing = active.find((entry) => entry.key === input.key);
      if (existing !== undefined) {
        const patch: MemoryUpdateInput = { content: input.content };
        if (input.kind !== undefined) patch.kind = input.kind;
        if (input.bucket !== undefined) patch.bucket = input.bucket;
        if (input.label !== undefined) patch.label = input.label;
        if (input.confidence !== undefined) patch.confidence = input.confidence;
        if (input.forgetAfter !== undefined) patch.forgetAfter = input.forgetAfter;
        if (input.forgetReason !== undefined) patch.forgetReason = input.forgetReason;
        return this.update(existing.id, patch, source);
      }
    }
    const label = input.label ?? null;
    const content = withoutLabel(input.content, label);
    const text = normalized(content);
    const duplicate = active.find(
      (entry) => entry.key === null && normalized(entry.content) === text && (entry.label ?? null) === label,
    );
    if (duplicate !== undefined && (input.key === undefined || input.key === null)) {
      duplicate.mentions += 1;
      duplicate.confidence = Math.max(duplicate.confidence, input.confidence ?? this.#defaultConfidence(source));
      if (source.kind === "user") duplicate.review = "approved";
      this.#commit(duplicate.id);
      return structuredClone(duplicate);
    }
    const id = randomUUID();
    const entry: MemoryEntry = {
      id,
      rootId: id,
      parentId: null,
      version: 1,
      isLatest: true,
      content,
      label,
      key: input.key ?? null,
      kind: input.kind ?? "dynamic",
      bucket: input.bucket ?? "other",
      source,
      confidence: input.confidence ?? this.#defaultConfidence(source),
      review: input.review ?? "approved",
      mentions: 1,
      createdAt: now.toISOString(),
      lastRecalledAt: null,
      isForgotten: false,
      forgottenAt: null,
      forgetAfter: input.forgetAfter ?? null,
      forgetReason: input.forgetReason ?? null,
    };
    this.#entries.push(entry);
    this.#commit(entry.id);
    return structuredClone(entry);
  }

  /**
   * A new version of a fact. The old one stays, marked not latest. Handing
   * in an old version's id updates the chain's current version — the
   * agent may be holding an id from a search that ran a step ago.
   */
  update(id: string, patch: MemoryUpdateInput, source: MemorySource): MemoryEntry {
    const previous = this.#latestOf(id);
    if (previous === null) throw new Error("memory not found");
    if (patch.content !== undefined) this.#refuseSecrets(patch.content, source);
    if (patch.key !== undefined && patch.key !== null && patch.key !== previous.key) {
      const now = this.#now();
      const holder = this.#entries.find((entry) => entry.key === patch.key && isActive(entry, now));
      if (holder !== undefined) throw new Error(`another memory already uses ${patch.key}`);
    }
    const next: MemoryEntry = {
      ...structuredClone(previous),
      id: randomUUID(),
      parentId: previous.id,
      version: previous.version + 1,
      isLatest: true,
      source,
      createdAt: this.#now().toISOString(),
      lastRecalledAt: null,
      isForgotten: false,
      forgottenAt: null,
    };
    if (patch.kind !== undefined) next.kind = patch.kind;
    if (patch.bucket !== undefined) next.bucket = patch.bucket;
    if (patch.label !== undefined) next.label = patch.label;
    if (patch.key !== undefined) next.key = patch.key;
    if (patch.content !== undefined) next.content = withoutLabel(patch.content, next.label);
    if (patch.confidence !== undefined) next.confidence = patch.confidence;
    else if (source.kind === "user") next.confidence = 1;
    if (patch.forgetAfter !== undefined) next.forgetAfter = patch.forgetAfter;
    if (patch.forgetReason !== undefined) next.forgetReason = patch.forgetReason;
    // The person restating a fact settles it, whoever first wrote it down.
    if (source.kind === "user") next.review = "approved";
    const unchanged =
      next.content === previous.content &&
      next.kind === previous.kind &&
      next.bucket === previous.bucket &&
      next.label === previous.label &&
      next.key === previous.key &&
      next.confidence === previous.confidence &&
      next.review === previous.review &&
      next.forgetAfter === previous.forgetAfter &&
      next.forgetReason === previous.forgetReason &&
      !previous.isForgotten;
    if (unchanged) return structuredClone(previous);
    previous.isLatest = false;
    this.#entries.push(next);
    this.#commit(previous.id, next.id);
    return structuredClone(next);
  }

  forget(id: string, reason: string, source: MemorySource): MemoryEntry {
    const entry = this.#latestOf(id);
    if (entry === null) throw new Error("memory not found");
    if (!entry.isForgotten) {
      entry.isForgotten = true;
      entry.forgottenAt = this.#now().toISOString();
      entry.forgetReason = reason;
      entry.source = source;
      this.#commit(entry.id);
    }
    return structuredClone(entry);
  }

  restore(id: string): MemoryEntry {
    const entry = this.#latestOf(id);
    if (entry === null) throw new Error("memory not found");
    if (entry.isForgotten) {
      entry.isForgotten = false;
      entry.forgottenAt = null;
      entry.forgetReason = null;
      // A fact that expired and was brought back is wanted; drop the clock.
      if (isExpired(entry, this.#now())) entry.forgetAfter = null;
      this.#commit(entry.id);
    }
    return structuredClone(entry);
  }

  /** Confirm or decline an inferred fact. Declining is a forget that says why. */
  review(id: string, decision: Exclude<MemoryReview, "pending">): MemoryEntry {
    const entry = this.#latestOf(id);
    if (entry === null) throw new Error("memory not found");
    if (entry.review !== decision) {
      entry.review = decision;
      if (decision === "approved") entry.confidence = Math.max(entry.confidence, 0.9);
      this.#commit(entry.id);
    }
    return structuredClone(entry);
  }

  /** Soft-forget every active fact. The history stays. */
  forgetAll(reason: string, source: MemorySource): number {
    const now = this.#now();
    const changed: string[] = [];
    for (const entry of this.#entries) {
      if (!isActive(entry, now)) continue;
      entry.isForgotten = true;
      entry.forgottenAt = now.toISOString();
      entry.forgetReason = reason;
      entry.source = source;
      changed.push(entry.id);
    }
    if (changed.length > 0) this.#commit(...changed);
    return changed.length;
  }

  /** Retire what has passed its `forgetAfter`. Returns how many. */
  expire(): number {
    const now = this.#now();
    const changed: string[] = [];
    for (const entry of this.#entries) {
      if (entry.isForgotten || !isExpired(entry, now)) continue;
      entry.isForgotten = true;
      entry.forgottenAt = now.toISOString();
      entry.forgetReason ??= "Expired";
      changed.push(entry.id);
    }
    if (changed.length > 0) this.#commit(...changed);
    return changed.length;
  }

  /** Stamp facts as handed to the agent. Not a change anyone listens for. */
  recalled(ids: string[]): void {
    if (ids.length === 0) return;
    const at = this.#now().toISOString();
    const wanted = new Set(ids);
    for (const entry of this.#entries) if (wanted.has(entry.id)) entry.lastRecalledAt = at;
    this.#write();
  }

  /**
   * A batch of operations from the agent or the learner, applied in order.
   * One bad operation (an id that no longer exists) skips itself rather
   * than the batch.
   */
  applyOperations(operations: MemoryOperation[], source: MemorySource): MemoryChangeSet {
    const result: MemoryChangeSet = { added: [], updated: [], forgotten: [] };
    for (const operation of operations) {
      try {
        if (operation.op === "add") {
          const before = this.#entries.length;
          const entry = this.add(operation, source);
          (this.#entries.length > before && entry.version === 1 ? result.added : result.updated).push(entry);
        } else if (operation.op === "update") {
          result.updated.push(this.update(operation.id, operation, source));
        } else {
          result.forgotten.push(this.forget(operation.id, operation.reason, source));
        }
      } catch {
        // A stale id from the model. The rest of the batch still applies.
      }
    }
    return result;
  }

  onChange(listener: (snapshot: MemorySnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Hear which VERSION changed, for the mirror that publishes it to the
   * account (sync/records.ts). Every version is its own record — an update
   * reports both the new version and the one it supersedes — so a
   * correction never races the fact it corrects. Only LOCAL writes are
   * reported; `recalled` is not a change anyone hears about.
   */
  onRecordChange(listener: (id: string) => void): () => void {
    this.#recordListeners.add(listener);
    return () => this.#recordListeners.delete(listener);
  }

  /* ------------------------- from another device ------------------------ */

  /**
   * One version of a fact as another device knows it, replacing the local
   * copy of that version or adding it.
   *
   * `isLatest` is DERIVED, never taken from the wire: the whole `rootId`
   * chain is recomputed here the way `sanitizeMemoryDocument` does it — the
   * highest version is the latest, every other version is not. Versions are
   * separate registers and arrive in any order, so trusting the incoming
   * bit would leave two latests when v2 lands before v1, or none when a
   * device that pruned v1 re-serves it. Deriving makes the result the same
   * whatever the order. Returns null when the value is not a memory.
   */
  applyRemote(value: unknown): MemoryEntry | null {
    const incoming = sanitizeMemoryEntry(value);
    if (incoming === null) return null;
    const index = this.#entries.findIndex((candidate) => candidate.id === incoming.id);
    const before = index === -1 ? null : JSON.stringify(this.#entries[index]);
    if (index === -1) this.#entries.push(incoming);
    else this.#entries[index] = incoming;
    this.#promoteLatest(incoming.rootId);
    const after = this.#entries.find((candidate) => candidate.id === incoming.id) ?? null;
    if (before !== null && after !== null && before === JSON.stringify(after)) return structuredClone(after);
    this.#commit();
    return after === null ? null : structuredClone(after);
  }

  /** Another device deleted this version. */
  removeRemote(id: string): boolean {
    const entry = this.#entries.find((candidate) => candidate.id === id);
    if (entry === undefined) return false;
    const rootId = entry.rootId;
    this.#entries = this.#entries.filter((candidate) => candidate.id !== id);
    this.#vectors.delete(id);
    this.#promoteLatest(rootId);
    this.#commit();
    return true;
  }

  /* ------------------------------ internals ----------------------------- */

  #defaultConfidence(source: MemorySource): number {
    return source.kind === "user" ? 1 : 0.8;
  }

  /** The person may write down what they like; a model may not write secrets. */
  #refuseSecrets(content: string, source: MemorySource): void {
    if (source.kind !== "user" && looksSensitive(content)) {
      throw new Error("This cannot be remembered: it looks like a password, code, card, or account number.");
    }
  }

  #latestOf(id: string): MemoryEntry | null {
    const entry = this.#entries.find((candidate) => candidate.id === id);
    if (entry === undefined) return null;
    if (entry.isLatest) return entry;
    return this.#entries.find((candidate) => candidate.rootId === entry.rootId && candidate.isLatest) ?? entry;
  }

  /** Exactly one latest per chain: the highest version wins (sanitizeMemoryDocument's rule). */
  #promoteLatest(rootId: string): void {
    const chain = this.#entries.filter((entry) => entry.rootId === rootId);
    let latest: MemoryEntry | null = null;
    for (const entry of chain) if (latest === null || entry.version > latest.version) latest = entry;
    for (const entry of chain) entry.isLatest = entry === latest;
  }

  /**
   * Write, then tell the renderer; `changed` names the versions a LOCAL
   * write touched. Pruning names nothing: it only ever drops versions that
   * are already out of force, and every device prunes its own file.
   */
  #commit(...changed: string[]): void {
    this.#prune();
    this.#write();
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(structuredClone(snapshot));
    for (const id of changed) {
      for (const listener of this.#recordListeners) {
        try {
          listener(id);
        } catch (error) {
          console.error("[memory] record listener failed", error);
        }
      }
    }
    this.#scheduleEmbedding();
  }

  /**
   * Keep the file bounded. Only what is already out of force is dropped —
   * superseded versions and forgotten facts, oldest first — so an active
   * fact is never lost to the cap.
   */
  #prune(): void {
    if (this.#entries.length <= MAX_MEMORY_ENTRIES) return;
    const now = this.#now();
    const disposable = this.#entries
      .filter((entry) => !isActive(entry, now))
      .sort((a, b) => Date.parse(a.forgottenAt ?? a.createdAt) - Date.parse(b.forgottenAt ?? b.createdAt));
    const drop = new Set(disposable.slice(0, this.#entries.length - MAX_MEMORY_ENTRIES).map((entry) => entry.id));
    if (drop.size === 0) return;
    this.#entries = this.#entries.filter((entry) => !drop.has(entry.id));
    for (const id of drop) this.#vectors.delete(id);
    // A chain whose latest was dropped promotes its newest survivor.
    const latest = new Map<string, MemoryEntry>();
    for (const entry of this.#entries) {
      const current = latest.get(entry.rootId);
      if (current === undefined || entry.version > current.version) latest.set(entry.rootId, entry);
    }
    for (const entry of this.#entries) entry.isLatest = latest.get(entry.rootId) === entry;
  }

  #read(): MemoryEntry[] {
    try {
      const raw = JSON.parse(readFileSync(this.#path, "utf8")) as MemoryFile;
      const document = sanitizeMemoryDocument(raw);
      const vectors = raw.vectors;
      if (
        this.#embedder !== null &&
        typeof vectors === "object" &&
        vectors !== null &&
        vectors.model === this.#embedder.id &&
        typeof vectors.byId === "object"
      ) {
        const ids = new Set(document.entries.map((entry) => entry.id));
        for (const [id, vector] of Object.entries(vectors.byId)) {
          if (ids.has(id) && Array.isArray(vector) && vector.every((n) => typeof n === "number")) this.#vectors.set(id, vector);
        }
      }
      return document.entries;
    } catch {
      return [];
    }
  }

  #write(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const file: MemoryFile = { version: 1, entries: this.#entries };
      if (this.#embedder !== null && this.#vectors.size > 0) {
        file.vectors = { model: this.#embedder.id, byId: Object.fromEntries(this.#vectors) };
      }
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(file, null, 2));
      renameSync(tmp, this.#path);
    } catch {
      // The in-memory value still wins for this session.
    }
  }

  /* ------------------------------ vectors ------------------------------ */

  #embedText(entry: MemoryEntry): string {
    return entry.label === null ? entry.content : `${entry.label}: ${entry.content}`;
  }

  /**
   * Embed what lacks a vector, in the background, a batch at a time. One
   * loop at a time; it re-reads what is missing after every batch, so a
   * fact added while it runs is picked up rather than left behind.
   */
  #scheduleEmbedding(): void {
    if (this.#embedder === null || !this.#embeddingEnabled || this.#embedFailed || this.#embedding !== null) return;
    const embedder = this.#embedder;
    const missing = (): MemoryEntry[] => {
      const now = this.#now();
      return this.#entries.filter((entry) => isActive(entry, now) && !this.#vectors.has(entry.id)).slice(0, EMBED_BATCH);
    };
    if (missing().length === 0) return;
    this.#embedding = (async () => {
      try {
        for (let batch = missing(); batch.length > 0 && this.#embeddingEnabled; batch = missing()) {
          const vectors = await embedder.embed(batch.map((entry) => this.#embedText(entry)));
          batch.forEach((entry, index) => {
            const vector = vectors[index];
            if (vector !== undefined) this.#vectors.set(entry.id, vector);
          });
          // A batch that produced nothing would loop forever on the same facts.
          if (vectors.length === 0) break;
        }
        this.#write();
      } catch {
        // No vectors this session; search stays lexical. Do not retry on
        // every write — a missing key would otherwise cost a request each.
        this.#embedFailed = true;
      } finally {
        this.#embedding = null;
      }
    })();
  }

  async #vectorsFor(query: string): Promise<{ query: number[]; byId: Map<string, number[]> } | null> {
    if (this.#embedder === null || !this.#embeddingEnabled || this.#embedFailed || query.trim() === "") return null;
    try {
      this.#scheduleEmbedding();
      const pending = this.#embedding;
      const [vector] = await Promise.race([
        Promise.all([this.#embedder.embed([query]), pending ?? Promise.resolve()]).then(([vectors]) => vectors),
        new Promise<number[][]>((_, reject) => setTimeout(() => reject(new Error("embedding timed out")), EMBED_WAIT_MS)),
      ]);
      if (vector === undefined) return null;
      return { query: vector, byId: this.#vectors };
    } catch {
      return null;
    }
  }
}
