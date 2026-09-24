/**
 * In-memory device-login challenges (§7.1 `device_challenges`): keyed by
 * `(deviceId, challenge)`, at most 8 live per device (oldest evicted),
 * 50 000 overall (refused beyond), 5 minute TTL. `take` consumes exactly the
 * presented challenge.
 */

import { randomBytes } from "node:crypto";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MAX_CHALLENGES_PER_DEVICE = 8;
export const MAX_CHALLENGES_TOTAL = 50_000;

interface Entry {
  challenge: string;
  expiresAt: number;
}

export class ChallengeStore {
  private readonly byDevice = new Map<string, Entry[]>();
  private total = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  get size(): number {
    return this.total;
  }

  /** A fresh challenge for the device, or null when the store is full. */
  issue(deviceId: string): string | null {
    const now = this.now();
    this.sweep(now);
    if (this.total >= MAX_CHALLENGES_TOTAL) return null;
    const challenge = randomBytes(32).toString("base64url");
    let entries = this.byDevice.get(deviceId);
    if (entries === undefined) {
      entries = [];
      this.byDevice.set(deviceId, entries);
    }
    while (entries.length >= MAX_CHALLENGES_PER_DEVICE) {
      entries.shift();
      this.total -= 1;
    }
    entries.push({ challenge, expiresAt: now + CHALLENGE_TTL_MS });
    this.total += 1;
    return challenge;
  }

  /** Consume `(deviceId, challenge)`; false if absent or expired. */
  take(deviceId: string, challenge: string): boolean {
    const now = this.now();
    const entries = this.byDevice.get(deviceId);
    if (entries === undefined) return false;
    const index = entries.findIndex((e) => e.challenge === challenge);
    if (index === -1) return false;
    const [entry] = entries.splice(index, 1);
    this.total -= 1;
    if (entries.length === 0) this.byDevice.delete(deviceId);
    return entry !== undefined && entry.expiresAt > now;
  }

  private sweep(now: number): void {
    for (const [deviceId, entries] of this.byDevice) {
      const live = entries.filter((e) => e.expiresAt > now);
      this.total -= entries.length - live.length;
      if (live.length === 0) this.byDevice.delete(deviceId);
      else if (live.length !== entries.length) this.byDevice.set(deviceId, live);
    }
  }
}
