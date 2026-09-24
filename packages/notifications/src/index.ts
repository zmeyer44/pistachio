import { randomUUID } from "node:crypto";

export interface NotificationMessage {
  id: string;
  userId: string;
  runId: string;
  kind: "approval" | "judgment" | "step_up" | "completion" | "reminder";
  title: string;
  body: string;
  actionUrl: string;
  capabilityCeiling: string[];
}

export interface ScheduledNotification {
  occurrenceId: string;
  fireAt: string;
  message: NotificationMessage;
}

export interface ClaimedNotification extends ScheduledNotification {
  leaseToken: string;
  attempt: number;
}

export interface NotificationScheduleStore {
  schedule(notification: ScheduledNotification): Promise<boolean>;
  claimDue(options: {
    workerId: string;
    now: number;
    leaseMs: number;
    limit: number;
  }): Promise<ClaimedNotification[]>;
  markSent(occurrenceId: string, leaseToken: string): Promise<boolean>;
  release(
    occurrenceId: string,
    leaseToken: string,
    error: string,
    retry: boolean,
  ): Promise<boolean>;
}

export interface NotificationAdapter {
  readonly id: string;
  deliver(message: NotificationMessage, idempotencyKey: string): Promise<void>;
}

type DeliveryState = { status: "sending" | "sent" | "failed"; leaseUntil: number };

export class DeliveryLedger {
  readonly #states = new Map<string, DeliveryState>();

  claim(key: string, now: number, leaseMs: number): "deliver" | "sent" | "leased" {
    const current = this.#states.get(key);
    if (current?.status === "sent") return "sent";
    if (current?.status === "sending" && current.leaseUntil >= now) return "leased";
    this.#states.set(key, { status: "sending", leaseUntil: now + leaseMs });
    return "deliver";
  }

  markSent(key: string): void {
    this.#states.set(key, { status: "sent", leaseUntil: 0 });
  }

  markFailed(key: string): void {
    this.#states.set(key, { status: "failed", leaseUntil: 0 });
  }
}

export class NotificationRouter {
  readonly #adapters: NotificationAdapter[];
  readonly #ledger: DeliveryLedger;

  constructor(adapters: NotificationAdapter[], ledger = new DeliveryLedger()) {
    this.#adapters = adapters;
    this.#ledger = ledger;
  }

  async deliver(message: NotificationMessage): Promise<void> {
    await Promise.all(
      this.#adapters.map(async (adapter) => {
        const key = `${message.id}:${adapter.id}`;
        const claim = this.#ledger.claim(key, Date.now(), 60_000);
        if (claim !== "deliver") return;
        try {
          await adapter.deliver(message, key);
          this.#ledger.markSent(key);
        } catch (error) {
          this.#ledger.markFailed(key);
          throw error;
        }
      }),
    );
  }
}

interface StoredOccurrence {
  occurrence: ScheduledNotification;
  status: "pending" | "leased" | "sent" | "failed";
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseUntil: number;
  attempts: number;
  lastError: string | null;
}

/**
 * Local/test implementation of the durable store contract. The hosted plane
 * supplies the same operations with transactional rows and indexed fireAt.
 */
export class InMemoryNotificationScheduleStore implements NotificationScheduleStore {
  readonly #occurrences = new Map<string, StoredOccurrence>();

  async schedule(notification: ScheduledNotification): Promise<boolean> {
    if (this.#occurrences.has(notification.occurrenceId)) return false;
    this.#occurrences.set(notification.occurrenceId, {
      occurrence: structuredClone(notification),
      status: "pending",
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: 0,
      attempts: 0,
      lastError: null,
    });
    return true;
  }

  async claimDue(options: {
    workerId: string;
    now: number;
    leaseMs: number;
    limit: number;
  }): Promise<ClaimedNotification[]> {
    const due = [...this.#occurrences.values()]
      .filter((record) => {
        const fireAt = new Date(record.occurrence.fireAt).getTime();
        return (
          fireAt <= options.now &&
          record.status !== "sent" &&
          record.status !== "failed" &&
          (record.status === "pending" || record.leaseUntil < options.now)
        );
      })
      .sort((a, b) =>
        a.occurrence.fireAt.localeCompare(b.occurrence.fireAt) ||
        a.occurrence.occurrenceId.localeCompare(b.occurrence.occurrenceId),
      )
      .slice(0, Math.max(0, options.limit));

    return due.map((record) => {
      const leaseToken = randomUUID();
      record.status = "leased";
      record.leaseOwner = options.workerId;
      record.leaseToken = leaseToken;
      record.leaseUntil = options.now + options.leaseMs;
      record.attempts += 1;
      return { ...structuredClone(record.occurrence), leaseToken, attempt: record.attempts };
    });
  }

  async markSent(occurrenceId: string, leaseToken: string): Promise<boolean> {
    const record = this.#occurrences.get(occurrenceId);
    if (record?.status !== "leased" || record.leaseToken !== leaseToken) return false;
    record.status = "sent";
    record.leaseUntil = 0;
    record.leaseOwner = null;
    record.leaseToken = null;
    return true;
  }

  async release(
    occurrenceId: string,
    leaseToken: string,
    error: string,
    retry: boolean,
  ): Promise<boolean> {
    const record = this.#occurrences.get(occurrenceId);
    if (record?.status !== "leased" || record.leaseToken !== leaseToken) return false;
    record.status = retry ? "pending" : "failed";
    record.leaseUntil = 0;
    record.leaseOwner = null;
    record.leaseToken = null;
    record.lastError = error;
    return true;
  }
}

export class NotificationDispatcher {
  readonly #router: NotificationRouter;
  readonly #store: NotificationScheduleStore;
  readonly #currentCapabilityCeiling: (
    message: NotificationMessage,
  ) => Promise<readonly string[]>;
  readonly #maxAttempts: number;

  constructor(options: {
    router: NotificationRouter;
    store: NotificationScheduleStore;
    currentCapabilityCeiling(message: NotificationMessage): Promise<readonly string[]>;
    maxAttempts?: number;
  }) {
    this.#router = options.router;
    this.#store = options.store;
    this.#currentCapabilityCeiling = options.currentCapabilityCeiling;
    this.#maxAttempts = options.maxAttempts ?? 8;
    if (!Number.isInteger(this.#maxAttempts) || this.#maxAttempts < 1) {
      throw new Error("maxAttempts must be a positive integer");
    }
  }

  async fireDue(options: { workerId: string; now?: number; limit?: number }): Promise<number> {
    const claimed = await this.#store.claimDue({
      workerId: options.workerId,
      now: options.now ?? Date.now(),
      leaseMs: 60_000,
      limit: options.limit ?? 50,
    });
    let delivered = 0;
    for (const occurrence of claimed) {
      try {
        const currentlyAllowed = new Set(
          await this.#currentCapabilityCeiling(occurrence.message),
        );
        const message = {
          ...occurrence.message,
          capabilityCeiling: occurrence.message.capabilityCeiling.filter((capability) =>
            currentlyAllowed.has(capability),
          ),
        };
        await this.#router.deliver(message);
        if (!(await this.#store.markSent(occurrence.occurrenceId, occurrence.leaseToken))) {
          throw new Error("notification occurrence lease was lost before commit");
        }
        delivered += 1;
      } catch (error) {
        await this.#store.release(
          occurrence.occurrenceId,
          occurrence.leaseToken,
          error instanceof Error ? error.message : String(error),
          occurrence.attempt < this.#maxAttempts,
        );
      }
    }
    return delivered;
  }
}
