/**
 * `pistachio.storage.local` (docs/extensions.md §5): one JSON object per
 * extension in `<userData>/ExtensionData/<id>/storage.json`, kept by main so
 * every context of the extension reads the same values. 5 MB in all,
 * measured as the JSON written; a write past that is refused whole. Writes
 * are atomic (temp file and rename) and coalesced to one per tick.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Json } from "@pistachio/extension-api";

export const STORAGE_MAX_BYTES = 5 * 1024 * 1024;

export type StorageChanges = Record<string, { oldValue?: Json; newValue?: Json }>;

export class StorageQuotaError extends Error {}

export class ExtensionStorage {
  readonly #path: string;
  #values: Record<string, Json> | null = null;
  #writeQueued = false;

  constructor(path: string) {
    this.#path = path;
  }

  get(keys: readonly string[] | null): Record<string, Json> {
    const values = this.#load();
    if (keys === null) return structuredClone(values);
    const picked: Record<string, Json> = {};
    for (const key of keys) if (Object.hasOwn(values, key)) picked[key] = structuredClone(values[key]!);
    return picked;
  }

  /** Set each item; answers what changed (for `storage.changed`). Throws StorageQuotaError past 5 MB. */
  set(items: Record<string, Json>): StorageChanges {
    const values = this.#load();
    const next = { ...values };
    const changes: StorageChanges = {};
    for (const [key, value] of Object.entries(items)) {
      // (Own values only: "constructor" or "toString" is a key like any other, never Object's function as its past.)
      const before = Object.hasOwn(values, key) ? values[key] : undefined;
      if (before !== undefined && JSON.stringify(before) === JSON.stringify(value)) continue;
      next[key] = structuredClone(value);
      changes[key] = { ...(before === undefined ? {} : { oldValue: before }), newValue: structuredClone(value) };
    }
    if (Object.keys(changes).length === 0) return changes;
    const size = Buffer.byteLength(JSON.stringify(next));
    if (size > STORAGE_MAX_BYTES) throw new StorageQuotaError(`storage.local holds at most 5 MB, and this write would make it ${(size / 1024 / 1024).toFixed(1)} MB: keep big things with files.data instead`);
    this.#values = next;
    this.#queueWrite();
    return changes;
  }

  remove(keys: readonly string[]): StorageChanges {
    const values = this.#load();
    const changes: StorageChanges = {};
    const next = { ...values };
    for (const key of keys) {
      if (!Object.hasOwn(next, key)) continue;
      changes[key] = { oldValue: next[key]! };
      delete next[key];
    }
    if (Object.keys(changes).length === 0) return changes;
    this.#values = next;
    this.#queueWrite();
    return changes;
  }

  /** Write now (a quit, a test). */
  flush(): void {
    if (this.#values === null) return;
    this.#writeQueued = false;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#values));
      renameSync(tmp, this.#path);
    } catch (error) {
      console.error("[extensions] could not write storage", error);
    }
  }

  #queueWrite(): void {
    if (this.#writeQueued) return;
    this.#writeQueued = true;
    queueMicrotask(() => {
      if (this.#writeQueued) this.flush();
    });
  }

  #load(): Record<string, Json> {
    if (this.#values !== null) return this.#values;
    try {
      const value: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
      this.#values = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json>) : {};
    } catch {
      this.#values = {};
    }
    return this.#values;
  }
}
