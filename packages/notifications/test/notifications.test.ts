import { describe, expect, it, vi } from "vitest";
import {
  InMemoryNotificationScheduleStore,
  NotificationDispatcher,
  NotificationRouter,
  type NotificationAdapter,
} from "../src/index.js";

describe("notification router", () => {
  it("delivers an idempotent approval notification once per adapter", async () => {
    const deliver = vi.fn<NotificationAdapter["deliver"]>().mockResolvedValue(undefined);
    const router = new NotificationRouter([{ id: "desktop", deliver }]);
    const message = {
      id: "approval-1",
      userId: "user-1",
      runId: "run-1",
      kind: "approval" as const,
      title: "Approval required",
      body: "Submit invoice reconciliation",
      actionUrl: "pistachio://runs/run-1",
      capabilityCeiling: ["browser.submit"],
    };
    await router.deliver(message);
    await router.deliver(message);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("leases each occurrence once and re-intersects capability ceilings at fire time", async () => {
    const deliver = vi.fn<NotificationAdapter["deliver"]>().mockResolvedValue(undefined);
    const router = new NotificationRouter([{ id: "push", deliver }]);
    const store = new InMemoryNotificationScheduleStore();
    const dispatcher = new NotificationDispatcher({
      router,
      store,
      currentCapabilityCeiling: async () => ["browser.read"],
    });
    await store.schedule({
      occurrenceId: "approval-1:push",
      fireAt: "2026-08-24T12:00:00Z",
      message: {
        id: "approval-1",
        userId: "user-1",
        runId: "run-1",
        kind: "approval",
        title: "Approval required",
        body: "Submit invoice reconciliation",
        actionUrl: "pistachio://runs/run-1",
        capabilityCeiling: ["browser.read", "browser.submit"],
      },
    });

    const fired = await Promise.all([
      dispatcher.fireDue({ workerId: "worker-a", now: Date.parse("2026-08-24T12:00:01Z") }),
      dispatcher.fireDue({ workerId: "worker-b", now: Date.parse("2026-08-24T12:00:01Z") }),
    ]);

    expect(fired.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[0].capabilityCeiling).toEqual(["browser.read"]);
  });

  it("moves permanently failing occurrences to a terminal state after bounded retries", async () => {
    const deliver = vi.fn<NotificationAdapter["deliver"]>().mockRejectedValue(new Error("offline"));
    const store = new InMemoryNotificationScheduleStore();
    const dispatcher = new NotificationDispatcher({
      router: new NotificationRouter([{ id: "push", deliver }]),
      store,
      maxAttempts: 3,
      currentCapabilityCeiling: async (message) => message.capabilityCeiling,
    });
    await store.schedule({
      occurrenceId: "approval-failing:push",
      fireAt: "2026-08-24T12:00:00Z",
      message: {
        id: "approval-failing",
        userId: "user-1",
        runId: "run-1",
        kind: "approval",
        title: "Approval required",
        body: "Submit invoice reconciliation",
        actionUrl: "pistachio://runs/run-1",
        capabilityCeiling: ["browser.submit"],
      },
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await dispatcher.fireDue({
        workerId: `worker-${attempt}`,
        now: Date.parse("2026-08-24T12:00:01Z") + attempt,
      });
    }
    expect(deliver).toHaveBeenCalledTimes(3);
  });
});
