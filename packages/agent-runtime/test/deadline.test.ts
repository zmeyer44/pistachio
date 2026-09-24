import { describe, expect, it } from "vitest";
import { DeadlineError, withDeadline } from "../src/index.js";

describe("withDeadline", () => {
  it("passes a value through when the work settles in time", async () => {
    await expect(withDeadline(Promise.resolve(7), 1_000, "adding")).resolves.toBe(7);
    await expect(withDeadline(Promise.reject(new Error("nope")), 1_000, "adding")).rejects.toThrow("nope");
  });

  it("fails work that never settles, naming what stalled and for how long", async () => {
    const never = new Promise<void>(() => undefined);
    const error = await withDeadline(never, 20, "opening a tab").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeadlineError);
    expect((error as Error).message).toBe("opening a tab did not finish within 0s; the browser may be unresponsive");
  });

  it("stops waiting the moment the turn is aborted", async () => {
    const controller = new AbortController();
    const pending = withDeadline(new Promise<void>(() => undefined), 10_000, "clicking", { signal: controller.signal });
    controller.abort(new Error("interrupted"));
    await expect(pending).rejects.toThrow("interrupted");
    controller.abort();
    await expect(withDeadline(Promise.resolve(1), 10, "x", { signal: controller.signal })).rejects.toThrow();
  });
});
