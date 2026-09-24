/**
 * In-memory HubStorage: the reference implementation tests run against and
 * a host may use for a single-process development hub.
 *
 * `list` returns keys in ascending UTF-16 code-unit order (the default
 * string sort), capped by `limit`. Hub keys are ASCII, where that coincides
 * with the byte order `SqlHubStorage` gets from `COLLATE "C"`.
 */

import type { HubStorage } from "../hub-core.js";

export class MemoryHubStorage implements HubStorage {
  private readonly map = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    const value = this.map.get(key);
    return Promise.resolve(
      value === undefined ? undefined : (structuredClone(value) as T),
    );
  }

  put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, structuredClone(value));
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.map.delete(key));
  }

  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    const limit = options.limit ?? Infinity;
    if (limit <= 0) return Promise.resolve(out);
    const keys = [...this.map.keys()].sort();
    for (const key of keys) {
      if (!key.startsWith(options.prefix)) continue;
      out.set(key, structuredClone(this.map.get(key)) as T);
      if (out.size >= limit) break;
    }
    return Promise.resolve(out);
  }

  /** Number of stored keys; handy for test assertions. */
  get size(): number {
    return this.map.size;
  }
}
