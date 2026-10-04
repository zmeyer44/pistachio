/**
 * What Shields keeps that is not a setting: the sites it is lowered on, and
 * the running counts the settings page shows (`<userData>/shields/state.json`).
 *
 * Exceptions are written at once — a person who lowered Shields on a site
 * expects it to stay lowered after a crash. Counts change on nearly every
 * page load, so they are written at most every few seconds, and on `flush`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shieldsSiteKey, type ShieldsStats } from "@pistachio/shell-contracts/shields";

const MAX_EXCEPTIONS = 2_000;
const STATS_WRITE_MS = 5_000;

interface StoredState {
  version: 1;
  exceptions: Record<string, number>;
  stats: ShieldsStats;
}

export class ShieldsSiteStore {
  readonly #path: string;
  #exceptions: Map<string, number>;
  #stats: ShieldsStats;
  #statsTimer: NodeJS.Timeout | null = null;

  constructor(directory: string) {
    this.#path = join(directory, "state.json");
    const state = this.#read();
    this.#exceptions = new Map(Object.entries(state.exceptions));
    this.#stats = state.stats;
  }

  exceptionKeys(): IterableIterator<string> {
    return this.#exceptions.keys();
  }

  exceptions(): { key: string; addedAt: number }[] {
    return [...this.#exceptions.entries()].map(([key, addedAt]) => ({ key, addedAt })).sort((a, b) => b.addedAt - a.addedAt);
  }

  /** Lower (`enabled: false`) or raise Shields on a site. Returns the key written, or null for a non-site. */
  setSite(site: string, enabled: boolean): string | null {
    const key = shieldsSiteKey(site);
    if (key === "") return null;
    if (enabled) {
      if (!this.#exceptions.delete(key)) return key;
    } else {
      if (this.#exceptions.has(key)) return key;
      if (this.#exceptions.size >= MAX_EXCEPTIONS) throw new Error("Too many sites have Shields down. Remove some in Settings first.");
      this.#exceptions.set(key, Date.now());
    }
    this.#write();
    return key;
  }

  stats(): ShieldsStats {
    return { ...this.#stats };
  }

  count(kind: "blocked" | "cleaned" | "upgraded", amount = 1): void {
    this.#stats[kind] += amount;
    if (this.#statsTimer === null) {
      this.#statsTimer = setTimeout(() => {
        this.#statsTimer = null;
        this.#write();
      }, STATS_WRITE_MS);
      this.#statsTimer.unref();
    }
  }

  resetStats(): void {
    this.#stats = { blocked: 0, cleaned: 0, upgraded: 0, since: Date.now() };
    this.#write();
  }

  flush(): void {
    if (this.#statsTimer !== null) {
      clearTimeout(this.#statsTimer);
      this.#statsTimer = null;
    }
    this.#write();
  }

  #write(): void {
    const state: StoredState = { version: 1, exceptions: Object.fromEntries(this.#exceptions), stats: this.#stats };
    try {
      mkdirSync(join(this.#path, ".."), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, this.#path);
    } catch {
      // The in-memory state still serves this run.
    }
  }

  #read(): StoredState {
    const empty: StoredState = { version: 1, exceptions: {}, stats: { blocked: 0, cleaned: 0, upgraded: 0, since: Date.now() } };
    try {
      const raw = JSON.parse(readFileSync(this.#path, "utf8")) as Record<string, unknown>;
      const exceptions: Record<string, number> = {};
      if (typeof raw["exceptions"] === "object" && raw["exceptions"] !== null) {
        for (const [site, addedAt] of Object.entries(raw["exceptions"] as Record<string, unknown>)) {
          const key = shieldsSiteKey(site);
          if (key !== "" && typeof addedAt === "number") exceptions[key] = addedAt;
        }
      }
      const stats = typeof raw["stats"] === "object" && raw["stats"] !== null ? (raw["stats"] as Record<string, unknown>) : {};
      const number = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback);
      return {
        version: 1,
        exceptions,
        stats: {
          blocked: number(stats["blocked"], 0),
          cleaned: number(stats["cleaned"], 0),
          upgraded: number(stats["upgraded"], 0),
          since: number(stats["since"], empty.stats.since),
        },
      };
    } catch {
      return empty;
    }
  }
}
