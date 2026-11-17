/**
 * Main's one clock (main/main-clock.ts; docs/primitives.md §5, stage 6): the
 * moments everything that keeps time is asked again, in one list — so
 * reminders, away spaces, Tidy and extensions' triggers look at the same
 * instants, in a known order, and one's trouble is not another's.
 */

import { describe, expect, it, vi } from "vitest";
import { CLOCK_MOMENTS, MainClock, WAKE_MOMENTS } from "../src/main/main-clock";

describe("main's clock", () => {
  it("asks everyone who joined, in the order they joined", () => {
    const clock = new MainClock();
    const asked: string[] = [];
    clock.onLook("reminders", () => asked.push("reminders"));
    clock.onLook("away", () => asked.push("away"));
    clock.onLook("triggers", () => asked.push("triggers"));
    clock.look("wake");
    expect(asked).toEqual(["reminders", "away", "triggers"]);
    expect(clock.lookers("wake")).toEqual(["reminders", "away", "triggers"]);
  });

  it("asks at waking and unlocking unless more is said: a locked screen or a charger is not a reminder's news", () => {
    const clock = new MainClock();
    const reminders = vi.fn();
    const triggers = vi.fn();
    clock.onLook("reminders", reminders);
    clock.onLook("triggers", triggers, CLOCK_MOMENTS);
    for (const moment of CLOCK_MOMENTS) clock.look(moment);
    expect(reminders.mock.calls.map(([moment]) => moment)).toEqual([...WAKE_MOMENTS]);
    expect(triggers.mock.calls.map(([moment]) => moment)).toEqual([...CLOCK_MOMENTS]);
    expect(clock.lookers("power")).toEqual(["triggers"]);
  });

  it("keeps one's trouble its own: a look that throws, and one that rejects, stop nobody else", async () => {
    const errors: Array<[string, string]> = [];
    const clock = new MainClock({ onError: (name, error) => errors.push([name, error instanceof Error ? error.message : String(error)]) });
    const after = vi.fn();
    clock.onLook("thrower", () => {
      throw new Error("boom");
    });
    clock.onLook("rejecter", () => Promise.reject(new Error("later")));
    clock.onLook("after", after);
    clock.look("unlock");
    expect(after).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toEqual([["thrower", "boom"], ["rejecter", "later"]]);
  });

  it("lets one leave, and one that leaves during a look does not unsettle it", () => {
    const clock = new MainClock();
    const asked: string[] = [];
    const leave = clock.onLook("first", () => {
      asked.push("first");
      leave();
    });
    clock.onLook("second", () => asked.push("second"));
    clock.look("wake");
    clock.look("wake");
    expect(asked).toEqual(["first", "second", "second"]);
    expect(clock.lookers("wake")).toEqual(["second"]);
  });
});
