/**
 * Offline mutation queues (PRD §8.3, cloud-sync-design §3): append-only lanes
 * drained in HLC order with newest-per-record compaction. Persistence is
 * pluggable — the desktop backs a `QueueStorage` with one JSON file per Space
 * (`QueueFile`) that also carries the HLC clock; tests and defaults use the
 * in-memory implementation. Nothing here touches crypto.
 */

import {
  compareHlc,
  sortByHlc,
  type CookieRecordWire,
  type Hlc,
} from "@pistachio/sync-protocol";

/**
 * `offline`: mutations captured while disconnected, drained on reconnect.
 * `deferred`: writes parked behind a foreign lease this device must not force
 * (a cloud run holds the origin); drained on lease release / retry.
 */
export type QueueLane = "offline" | "deferred";

export const QUEUE_LANES: ReadonlyArray<QueueLane> = ["offline", "deferred"];

/** On-disk shape of the desktop's `<userData>/sync/<spaceId>.queue.json`. */
export interface QueueFile {
  version: 1;
  clock: Hlc | null;
  offline: CookieRecordWire[];
  deferred: CookieRecordWire[];
}

export interface QueueStorage {
  append(lane: QueueLane, record: CookieRecordWire): void;
  all(lane: QueueLane): CookieRecordWire[];
  clear(lane: QueueLane): void;
  size(lane: QueueLane): number;
  /**
   * Drop the `count` oldest entries for `recordId` whose HLC is at or below
   * `hlc`. A non-destructive drain (`OfflineQueue.checkout`) retires the
   * entries it consumed only once their dispatch has settled; anything
   * appended while it ran — a wire shelved back mid-drain — sits after those
   * and survives, so a re-shelved wire is never duplicated nor dropped.
   */
  discard(lane: QueueLane, recordId: string, hlc: Hlc, count: number): void;
  /**
   * Persisted HLC clock state (optional). A persisting implementation exposes
   * it as a write-through accessor: the engine reads it once in its
   * constructor (`HlcClock.restore`) and assigns it after every `send()` used
   * to build a wire. Absent ⇒ the clock is not persisted.
   */
  clock?: Hlc | null;
}

function isHlc(value: unknown): value is Hlc {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["physicalMs"] === "number" &&
    typeof v["logical"] === "number" &&
    typeof v["deviceId"] === "string"
  );
}

/**
 * Structural check for a loaded queue file. Unknown versions and malformed
 * shapes yield `null` so a corrupt file degrades to an empty queue instead of
 * throwing on startup.
 */
export function parseQueueFile(value: unknown): QueueFile | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v["version"] !== 1) return null;
  if (!Array.isArray(v["offline"]) || !Array.isArray(v["deferred"]))
    return null;
  const clock = v["clock"];
  if (clock !== null && clock !== undefined && !isHlc(clock)) return null;
  return {
    version: 1,
    clock: isHlc(clock) ? { ...clock } : null,
    offline: [...(v["offline"] as CookieRecordWire[])],
    deferred: [...(v["deferred"] as CookieRecordWire[])],
  };
}

/**
 * In-memory storage holding both lanes and the clock. A file-backed storage
 * wraps this with `onChange` (invoked after every mutation with the full
 * `QueueFile` snapshot) and writes it atomically.
 */
export class MemoryQueueStorage implements QueueStorage {
  private readonly lanes: Record<QueueLane, CookieRecordWire[]>;
  private clockState: Hlc | null;

  constructor(
    initial: QueueFile | null = null,
    private readonly onChange?: (file: QueueFile) => void,
  ) {
    this.lanes = {
      offline: initial ? [...initial.offline] : [],
      deferred: initial ? [...initial.deferred] : [],
    };
    this.clockState = initial?.clock ?? null;
  }

  static fromFile(file: QueueFile | null): MemoryQueueStorage {
    return new MemoryQueueStorage(file);
  }

  get clock(): Hlc | null {
    return this.clockState;
  }

  set clock(value: Hlc | null) {
    this.clockState = value === null ? null : { ...value };
    this.changed();
  }

  append(lane: QueueLane, record: CookieRecordWire): void {
    this.lanes[lane].push(record);
    this.changed();
  }

  all(lane: QueueLane): CookieRecordWire[] {
    return [...this.lanes[lane]];
  }

  clear(lane: QueueLane): void {
    if (this.lanes[lane].length === 0) return;
    this.lanes[lane] = [];
    this.changed();
  }

  size(lane: QueueLane): number {
    return this.lanes[lane].length;
  }

  discard(lane: QueueLane, recordId: string, hlc: Hlc, count: number): void {
    if (count <= 0) return;
    const kept: CookieRecordWire[] = [];
    let dropped = 0;
    for (const record of this.lanes[lane]) {
      if (
        dropped < count &&
        record.recordId === recordId &&
        compareHlc(record.hlc, hlc) <= 0
      ) {
        dropped += 1;
        continue;
      }
      kept.push(record);
    }
    if (dropped === 0) return;
    this.lanes[lane] = kept;
    this.changed();
  }

  /** Snapshot in the on-disk shape. */
  toFile(): QueueFile {
    return {
      version: 1,
      clock: this.clockState === null ? null : { ...this.clockState },
      offline: [...this.lanes.offline],
      deferred: [...this.lanes.deferred],
    };
  }

  private changed(): void {
    this.onChange?.(this.toFile());
  }
}

/** One checked-out queue entry: the wire to dispatch and its retirement. */
export interface QueuedWire {
  record: CookieRecordWire;
  /** Retire this wire's queued entries — only once its dispatch settled. */
  settle(): void;
}

export class OfflineQueue {
  constructor(
    private readonly storage: QueueStorage = new MemoryQueueStorage(),
    private readonly lane: QueueLane = "offline",
  ) {}

  enqueue(record: CookieRecordWire): void {
    this.storage.append(this.lane, record);
  }

  get depth(): number {
    return this.compacted().length;
  }

  /** Pending records in HLC order without removing them. */
  peek(): CookieRecordWire[] {
    return sortByHlc(this.compacted());
  }

  /**
   * Non-destructive drain: the records `drain()` would return, each paired
   * with the `settle()` that retires exactly the entries it superseded (the
   * compacted-away older versions of the same cookie included). Until
   * `settle()` runs the wire is still in persisted storage, so a crash
   * mid-drain — a lease round trip takes seconds — replays it instead of
   * losing it. Entries appended after the checkout (a wire shelved back
   * because the socket went away) are never retired by it.
   */
  checkout(): QueuedWire[] {
    const entries = this.storage.all(this.lane);
    return sortByHlc(this.compacted()).map((record) => {
      let superseded = 0;
      for (const entry of entries) {
        if (
          entry.recordId === record.recordId &&
          compareHlc(entry.hlc, record.hlc) <= 0
        )
          superseded += 1;
      }
      return {
        record,
        settle: (): void => {
          this.storage.discard(
            this.lane,
            record.recordId,
            record.hlc,
            superseded,
          );
        },
      };
    });
  }

  /**
   * Remove and return all pending records, oldest HLC first. Prefer
   * `checkout()` for anything that dispatches: this empties the lane before
   * the caller has done anything with the records, so a crash (or a rejected
   * loop) mid-dispatch loses them.
   */
  drain(): CookieRecordWire[] {
    // Only the newest mutation for a cookie can be a useful retry. Publishing
    // every intermediate Google rotation after reconnect both wastes the
    // lease and can temporarily roll a session backward.
    const ordered = sortByHlc(this.compacted());
    this.storage.clear(this.lane);
    return ordered;
  }

  private compacted(): CookieRecordWire[] {
    const newest = new Map<string, CookieRecordWire>();
    for (const record of this.storage.all(this.lane)) {
      const current = newest.get(record.recordId);
      if (current === undefined || compareHlc(record.hlc, current.hlc) > 0) {
        newest.set(record.recordId, record);
      }
    }
    return [...newest.values()];
  }
}
