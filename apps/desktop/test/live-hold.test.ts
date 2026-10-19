/**
 * Waking the tabs a live share holds (docs/live-share.md §6.1): three at a
 * time, each waited on 8 s at most, so a page that never finishes loading
 * holds up only its own place; each laid out as soon as its own wake is done,
 * one layout at a time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_WAKE_WAIT_MS, LIVE_WAKES_AT_ONCE, wakeAndLayOut } from "../src/main/live/live-hold";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe("wakeAndLayOut", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("wakes three at a time, lays each out once its own wake is done, and a page that never loads holds up none of the others", async () => {
    const wakes = new Map<string, ReturnType<typeof deferred>>();
    const order: string[] = [];
    let waking = 0;
    let most = 0;
    let laying = 0;
    const work = {
      asleep: (tabId: string) => tabId !== "awake",
      wake: (tabId: string) => {
        waking += 1;
        most = Math.max(most, waking);
        const wake = deferred();
        wakes.set(tabId, wake);
        // (The page that hangs never settles.)
        return tabId === "hangs" ? new Promise<never>(() => undefined) : wake.promise.finally(() => (waking -= 1));
      },
      layOut: async (tabId: string) => {
        laying += 1;
        expect(laying).toBe(1);
        order.push(tabId);
        await Promise.resolve();
        laying -= 1;
      },
    };
    const done = wakeAndLayOut(["hangs", "a", "b", "c", "awake"], work);
    await vi.advanceTimersByTimeAsync(0);
    expect([...wakes.keys()]).toEqual(["hangs", "a", "b"]);
    wakes.get("b")!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    // b is laid out as soon as it woke; its lane takes c.
    expect(order).toEqual(["b"]);
    expect([...wakes.keys()]).toEqual(["hangs", "a", "b", "c"]);
    wakes.get("a")!.resolve();
    wakes.get("c")!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    // The awake one needs no wake: the four are laid out, the hanging page not yet.
    expect([...order].sort()).toEqual(["a", "awake", "b", "c"]);
    expect(most).toBe(LIVE_WAKES_AT_ONCE);
    // The page that never loads is laid out as it is once its wait is up.
    await vi.advanceTimersByTimeAsync(LIVE_WAKE_WAIT_MS);
    await done;
    expect(order.at(-1)).toBe("hangs");
    expect(order).toHaveLength(5);
  });

  it("goes on past a wake or a layout that fails", async () => {
    const laid: string[] = [];
    await wakeAndLayOut(["gone", "a"], {
      asleep: () => true,
      wake: async (tabId) => {
        if (tabId === "gone") throw new Error("unknown tab");
      },
      layOut: async (tabId) => {
        if (tabId === "gone") throw new Error("no page");
        laid.push(tabId);
      },
    });
    expect(laid).toEqual(["a"]);
  });
});
