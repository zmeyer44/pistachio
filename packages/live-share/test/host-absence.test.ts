import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_ABSENT_GRACE_MS, HOST_ABSENT_POLL_MS, HostAbsence, type LiveRequestStatus } from "../src/react/index.js";

/** Control's answers, one per ask, in order; a rejection is a try that did not get through. */
function control(...answers: Array<LiveRequestStatus | Error>) {
  const check = vi.fn(async (): Promise<LiveRequestStatus> => {
    const answer = answers.shift() ?? "admitted";
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const over = vi.fn();
  return { absence: new HostAbsence({ check, over }), check, over };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("HostAbsence", () => {
  it("asks control nothing while the host is in the room, nor for a host gone a moment", async () => {
    const { absence, check } = control();
    await vi.advanceTimersByTimeAsync(HOST_ABSENT_POLL_MS * 4);
    absence.start();
    await vi.advanceTimersByTimeAsync(HOST_ABSENT_GRACE_MS - 1);
    absence.stop();
    await vi.advanceTimersByTimeAsync(HOST_ABSENT_POLL_MS * 4);
    expect(check).not.toHaveBeenCalled();
    expect(absence.waiting()).toBe(false);
  });

  it("waits on a host gone a while, asks every 30 s while the share stands, and ends the page when control says it ended", async () => {
    const { absence, check, over } = control("admitted", new Error("offline"), "admitted", "ended");
    const heard = vi.fn();
    absence.subscribe(heard);
    absence.start();
    await vi.advanceTimersByTimeAsync(HOST_ABSENT_GRACE_MS);
    expect(absence.waiting()).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(1);
    // A try that did not get through is tried again at the next turn.
    await vi.advanceTimersByTimeAsync(HOST_ABSENT_POLL_MS * 2);
    expect(check).toHaveBeenCalledTimes(3);
    expect(over).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HOST_ABSENT_POLL_MS);
    expect(check).toHaveBeenCalledTimes(4);
    expect(over).toHaveBeenCalledWith("ended");
    expect(absence.waiting()).toBe(false);
    await vi.advanceTimersByTimeAsync(HOST_ABSENT_POLL_MS * 4);
    expect(check).toHaveBeenCalledTimes(4);
  });

  it("says a removed or let-go guest is out, as control does", async () => {
    for (const status of ["removed", "left"] as const) {
      const { absence, over } = control(status);
      absence.start();
      await vi.advanceTimersByTimeAsync(HOST_ABSENT_GRACE_MS);
      expect(over).toHaveBeenCalledWith(status);
    }
  });

  it("stops asking and waiting when the host is back, and lets an answer then on its way go", async () => {
    let answer: (status: LiveRequestStatus) => void = () => undefined;
    const check = vi.fn(() => new Promise<LiveRequestStatus>((resolve) => (answer = resolve)));
    const over = vi.fn();
    const absence = new HostAbsence({ check, over });
    absence.start();
    await vi.advanceTimersByTimeAsync(HOST_ABSENT_GRACE_MS);
    expect(check).toHaveBeenCalledTimes(1);
    absence.stop();
    expect(absence.waiting()).toBe(false);
    answer("admitted");
    await vi.advanceTimersByTimeAsync(HOST_ABSENT_POLL_MS * 4);
    expect(check).toHaveBeenCalledTimes(1);
    // Gone again: the wait starts afresh.
    absence.start();
    await vi.advanceTimersByTimeAsync(HOST_ABSENT_GRACE_MS);
    expect(check).toHaveBeenCalledTimes(2);
    expect(over).not.toHaveBeenCalled();
  });
});
