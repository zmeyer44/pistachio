/**
 * Revocation feed (docs/cloud-sync-design.md §9): poll
 * `GET /v1/egress/revocations?since=<cursor>` every 30 s. An entry with
 * `credentialId: null` revokes the whole device and destroys its tunnels;
 * otherwise only that credential's tunnels are cut. Entries past their exp
 * may be dropped — the feed carries no expiry, so this set keeps them.
 */

import { REVOCATION_POLL_INTERVAL_MS, silentLogger, type Logger } from "./config.js";
import type { RevocationSet } from "./auth.js";
import { isRecord, type ControlClient } from "./control.js";
import type { TunnelRegistry } from "./tunnels.js";

export interface RevocationEntry {
  readonly id: number;
  readonly deviceId: string;
  readonly credentialId: string | null;
  readonly at: string;
}

export interface RevocationFeed {
  readonly revocations: ReadonlyArray<RevocationEntry>;
  readonly cursor: number;
  /**
   * Control pruned past this gateway's cursor, so it cannot prove nothing was
   * dropped between the cursor and the oldest row it still holds. The gateway
   * must re-read the feed from the beginning.
   */
  readonly reset: boolean;
}

/** Validate `{revocations: [{id, deviceId, credentialId, at}], cursor, reset}`. */
export function parseRevocationFeed(json: unknown): RevocationFeed | null {
  if (!isRecord(json) || !Array.isArray(json.revocations)) return null;
  const revocations: RevocationEntry[] = [];
  for (const raw of json.revocations) {
    if (!isRecord(raw)) return null;
    const { id, deviceId, credentialId, at } = raw;
    if (typeof id !== "number" || !Number.isInteger(id)) return null;
    if (typeof deviceId !== "string" || deviceId === "") return null;
    if (credentialId !== null && typeof credentialId !== "string") return null;
    revocations.push({
      id,
      deviceId,
      credentialId: credentialId ?? null,
      at: typeof at === "string" ? at : "",
    });
  }
  let cursor = revocations.reduce((max, entry) => Math.max(max, entry.id), 0);
  if (typeof json.cursor === "number" && Number.isInteger(json.cursor)) {
    cursor = Math.max(cursor, json.cursor);
  } else if (typeof json.cursor === "string" && /^[0-9]+$/.test(json.cursor)) {
    cursor = Math.max(cursor, Number(json.cursor));
  }
  return { revocations, cursor, reset: json.reset === true };
}

/** Pages drained per poll; control caps a page at 1000 rows. */
const MAX_PAGES_PER_POLL = 64;

export interface RevocationPollerOptions {
  readonly control: ControlClient;
  readonly revocations: RevocationSet;
  readonly tunnels: TunnelRegistry;
  readonly intervalMs?: number;
  readonly log?: Logger;
}

export class RevocationPoller {
  readonly #control: ControlClient;
  readonly #revocations: RevocationSet;
  readonly #tunnels: TunnelRegistry;
  readonly #intervalMs: number;
  readonly #log: Logger;
  #cursor = 0;
  #timer: NodeJS.Timeout | null = null;
  #inFlight: Promise<void> | null = null;

  constructor(options: RevocationPollerOptions) {
    this.#control = options.control;
    this.#revocations = options.revocations;
    this.#tunnels = options.tunnels;
    this.#intervalMs = options.intervalMs ?? REVOCATION_POLL_INTERVAL_MS;
    this.#log = options.log ?? silentLogger;
  }

  get cursor(): number {
    return this.#cursor;
  }

  start(): void {
    if (this.#timer !== null) return;
    void this.pollNow();
    this.#timer = setInterval(() => void this.pollNow(), this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Fetch and apply everything newer than the cursor. Never throws. */
  pollNow(): Promise<void> {
    if (this.#inFlight !== null) return this.#inFlight;
    this.#inFlight = this.#poll().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  /** Apply one entry (also used directly by tests and shutdown paths). */
  apply(entry: RevocationEntry): void {
    if (entry.credentialId === null) {
      this.#revocations.revokeDevice(entry.deviceId);
      const cut = this.#tunnels.destroyByDevice(entry.deviceId);
      this.#log.info(`device revoked; ${cut} tunnel(s) closed`);
    } else {
      this.#revocations.revokeCredential(entry.credentialId);
      const cut = this.#tunnels.destroyByCredential(entry.credentialId);
      this.#log.info(`credential revoked; ${cut} tunnel(s) closed`);
    }
  }

  /**
   * Drain the feed to its tail: control caps a page at 1000 rows, so a gateway
   * that restarts with an empty set must page forward now, not one page per
   * tick — a revocation older than the last page would otherwise go
   * unenforced for `ceil(rows / 1000) x 30 s`.
   */
  async #poll(): Promise<void> {
    let rewound = false;
    for (let page = 0; page < MAX_PAGES_PER_POLL; page += 1) {
      const before = this.#cursor;
      let json: unknown;
      try {
        json = await this.#control.get("/v1/egress/revocations", { since: String(before) });
      } catch (error) {
        this.#log.warn(`revocation poll failed: ${describe(error)}`);
        return;
      }
      const feed = parseRevocationFeed(json);
      if (feed === null) {
        this.#log.warn("revocation poll returned an unexpected body");
        return;
      }
      // Control retains nothing as old as this cursor, so rows may have been
      // dropped unseen: re-read from the beginning. The set is NOT cleared —
      // it only ever grows, so re-reading can only re-add what is still held,
      // while clearing would briefly un-revoke a live credential. Anything
      // control pruned named a credential that expired weeks earlier, which
      // the expiry check already refuses. `since=0` never resets, so this
      // rewinds at most once per poll.
      if (feed.reset && !rewound && before > 0) {
        rewound = true;
        this.#cursor = 0;
        this.#log.warn("revocation cursor predates the retained feed; re-reading from the start");
        continue;
      }
      for (const entry of feed.revocations) this.apply(entry);
      if (feed.cursor > this.#cursor) this.#cursor = feed.cursor;
      // An empty page, or one that did not advance the cursor, is the tail.
      if (feed.revocations.length === 0 || this.#cursor <= before) return;
    }
    this.#log.warn(
      `revocation feed still behind at cursor ${this.#cursor} after ${MAX_PAGES_PER_POLL} pages; continuing next tick`,
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
