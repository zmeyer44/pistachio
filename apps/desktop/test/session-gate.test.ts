import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionGate } from "../src/main/session-gate";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("SessionGate (§10.2 hydration gate)", () => {
  it("runs at once for a Space that is not being hydrated", () => {
    const gate = new SessionGate();
    const ran: string[] = [];
    gate.run("work", () => ran.push("a"));
    expect(ran).toEqual(["a"]);
    expect(gate.isHydrating("work")).toBe(false);
  });

  it("holds loads while hydrating and replays them in order on ready", () => {
    const gate = new SessionGate();
    const ran: string[] = [];
    gate.markHydrating("work");
    gate.run("work", () => ran.push("first"));
    gate.run("work", () => ran.push("second"));
    gate.run("other", () => ran.push("elsewhere"));
    expect(ran).toEqual(["elsewhere"]);
    expect(gate.pendingCount("work")).toBe(2);
    gate.markReady("work");
    expect(ran).toEqual(["elsewhere", "first", "second"]);
    expect(gate.readySpaces.has("work")).toBe(true);
    expect(gate.pendingCount("work")).toBe(0);
    gate.run("work", () => ran.push("later"));
    expect(ran.at(-1)).toBe("later");
  });

  it("never strands a page: a hydration that does not finish is released after the timeout", () => {
    const gate = new SessionGate(1_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ran: string[] = [];
    gate.markHydrating("work");
    gate.run("work", () => ran.push("held"));
    vi.advanceTimersByTime(999);
    expect(ran).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ran).toEqual(["held"]);
    expect(gate.isHydrating("work")).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("re-hydrating a ready Space holds again, and a failing replay does not stop the rest", () => {
    const gate = new SessionGate();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ran: string[] = [];
    gate.markHydrating("work");
    gate.markReady("work");
    gate.markHydrating("work");
    expect(gate.readySpaces.has("work")).toBe(false);
    gate.run("work", () => {
      throw new Error("boom");
    });
    gate.run("work", () => ran.push("after"));
    gate.markReady("work");
    expect(ran).toEqual(["after"]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("dispose drops what is held without running it", () => {
    const gate = new SessionGate();
    const ran: string[] = [];
    gate.markHydrating("work");
    gate.run("work", () => ran.push("never"));
    gate.dispose();
    vi.runAllTimers();
    expect(ran).toEqual([]);
    expect(gate.isHydrating("work")).toBe(false);
  });
});
