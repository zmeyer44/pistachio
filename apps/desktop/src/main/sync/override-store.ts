/**
 * The person's standing per-origin sync choices (§10.2 `sync:setOriginOverride`),
 * `<userData>/sync/overrides.json`: host → `sync` | `never`. Account-global
 * like control's `sync_policy_overrides`, so the same file feeds every
 * Space's engine and is mirrored to `PUT /sync/policy/overrides/:host`.
 * BrowserPolicyStore-style: read once, written whole and atomically.
 */

import { join } from "node:path";
import { normalizedHost } from "@pistachio/sync-protocol";
import type { SyncOriginOverride } from "@pistachio/shell-contracts/ipc";
import { atomicWriteJsonSync, readJsonFile, syncDir } from "./queue-file";

interface StoredOverrides {
  version: 1;
  hosts: Record<string, SyncOriginOverride>;
}

export function isSyncOriginOverride(value: unknown): value is SyncOriginOverride {
  return value === "sync" || value === "never";
}

export class SyncOverrideStore {
  readonly #path: string;
  #hosts: Record<string, SyncOriginOverride>;

  constructor(userDataDir: string) {
    this.#path = join(syncDir(userDataDir), "overrides.json");
    this.#hosts = readOverrides(readJsonFile(this.#path));
  }

  /** Every override, host → mode. */
  all(): Record<string, SyncOriginOverride> {
    return { ...this.#hosts };
  }

  /** The longest-suffix match for `host`, as the engine resolves it. */
  overrideFor(host: string): SyncOriginOverride | null {
    const normalized = normalizedHost(host);
    let bestDomain: string | null = null;
    let bestOverride: SyncOriginOverride | null = null;
    for (const [domain, override] of Object.entries(this.#hosts)) {
      const matches = normalized === domain || normalized.endsWith(`.${domain}`);
      if (matches && (bestDomain === null || domain.length > bestDomain.length)) {
        bestDomain = domain;
        bestOverride = override;
      }
    }
    return bestOverride;
  }

  /** Answers whether anything changed. */
  set(host: string, override: SyncOriginOverride | null): boolean {
    const normalized = normalizedHost(host);
    if (normalized === "") return false;
    const current = this.#hosts[normalized] ?? null;
    if (current === override) return false;
    if (override === null) delete this.#hosts[normalized];
    else this.#hosts[normalized] = override;
    this.#write();
    return true;
  }

  /** Adopt control's overrides for hosts this Mac has no choice for. Answers the hosts adopted. */
  adopt(remote: Record<string, unknown>): string[] {
    const adopted: string[] = [];
    for (const [host, mode] of Object.entries(remote)) {
      const normalized = normalizedHost(host);
      if (normalized === "" || !isSyncOriginOverride(mode) || this.#hosts[normalized] !== undefined) continue;
      this.#hosts[normalized] = mode;
      adopted.push(normalized);
    }
    if (adopted.length > 0) this.#write();
    return adopted;
  }

  /**
   * Sign-out: forget this account's hosts. The file itself goes with the sync
   * dir; the in-memory copy has to follow or the next account inherits them.
   */
  reset(): void {
    this.#hosts = {};
  }

  #write(): void {
    try {
      const value: StoredOverrides = { version: 1, hosts: this.#hosts };
      atomicWriteJsonSync(this.#path, value);
    } catch {
      // A read-only profile still gets the in-memory choice this session.
    }
  }
}

function readOverrides(value: unknown): Record<string, SyncOriginOverride> {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Record<string, unknown>;
  if (raw["version"] !== 1 || typeof raw["hosts"] !== "object" || raw["hosts"] === null) return {};
  const hosts: Record<string, SyncOriginOverride> = {};
  for (const [host, mode] of Object.entries(raw["hosts"] as Record<string, unknown>)) {
    const normalized = normalizedHost(host);
    if (normalized !== "" && isSyncOriginOverride(mode)) hosts[normalized] = mode;
  }
  return hosts;
}
