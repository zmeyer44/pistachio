import { describe, expect, it } from "vitest";
import type { HostedRunRecord } from "../src/control-client.js";
import { ActiveRun, parseRunCommand } from "../src/runs/executor.js";

function record(): HostedRunRecord {
  const now = "2026-09-02T00:00:00.000Z";
  return {
    id: "33333333-3333-4333-8333-333333333333",
    taskId: "t",
    sponsorId: "u",
    userId: "u",
    spaceId: "work",
    purpose: "p",
    intent: "p",
    attachments: [],
    origin: null,
    executor: { kind: "cloud", deviceId: null, workerId: null },
    startUrl: null,
    sessionId: null,
    status: "running",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

describe("run commands", () => {
  it("parses the steer's bare cmd.* + seq and the long-poll's stored event, and rejects the rest", () => {
    expect(parseRunCommand({ t: "cmd.message", text: "hi", attachments: [], seq: 7 })).toEqual({
      eventId: null,
      seq: 7,
      command: { t: "cmd.message", text: "hi", attachments: [] },
    });
    expect(parseRunCommand({ eventId: "e1", at: "x", seq: 7, event: { t: "cmd.interrupt" } })).toEqual({
      eventId: "e1",
      seq: 7,
      command: { t: "cmd.interrupt" },
    });
    expect(parseRunCommand({ t: "cmd.message", text: "no attachments key" })).toMatchObject({ command: { attachments: [] } });
    expect(parseRunCommand({ t: "status", status: "running" })).toBeNull();
    expect(parseRunCommand({ eventId: "e2", event: { t: "message", message: {} } })).toBeNull();
    expect(parseRunCommand("cmd.revoke")).toBeNull();
  });

  it("abandons a running turn with the failure the loop must report, and answers whether one was running", () => {
    const active = new ActiveRun(record());
    // Idle between turns: nothing to abort, the caller fails the run itself.
    expect(active.abandon("browser_disconnected")).toBe(false);
    expect(active.failReason).toBe("browser_disconnected");

    const mid = new ActiveRun(record());
    const turn = new AbortController();
    mid.turnAbort = turn;
    expect(mid.abandon("turn_stalled")).toBe(true);
    expect(turn.signal.aborted).toBe(true);
    expect(mid.failReason).toBe("turn_stalled");
    expect(mid.abortReason).toBe("abandoned");
    // The first reason wins; a second abandon changes nothing.
    expect(mid.abandon("browser_disconnected")).toBe(false);
    expect(mid.failReason).toBe("turn_stalled");
  });

  it("handles a command once when the steer and the long-poll both deliver it", async () => {
    const active = new ActiveRun(record());
    const steered = parseRunCommand({ t: "cmd.message", text: "hi", attachments: [], seq: 3 });
    const polled = parseRunCommand({ eventId: "e3", at: "x", seq: 3, event: { t: "cmd.message", text: "hi", attachments: [] } });
    if (steered === null || polled === null) throw new Error("unexpected");
    expect(active.receive(steered, steered.command)).toBe(true);
    expect(active.receive(polled, polled.command)).toBe(false);
    expect(active.receive(polled, polled.command)).toBe(false);
    const next = parseRunCommand({ eventId: "e4", at: "x", seq: 4, event: { t: "cmd.release" } });
    if (next === null) throw new Error("unexpected");
    expect(active.receive(next, next.command)).toBe(true);
    expect(await active.inbox.next()).toEqual({ t: "cmd.message", text: "hi", attachments: [] });
    expect(await active.inbox.next()).toEqual({ t: "cmd.release" });
    // Revoke is queued like any command so the drive loop reaches its
    // `cmd.revoke` case (authority.ended, done); that case ends the run, and
    // nothing is accepted afterwards.
    const revoke = parseRunCommand({ t: "cmd.revoke", seq: 5 });
    if (revoke === null) throw new Error("unexpected");
    expect(active.receive(revoke, revoke.command)).toBe(true);
    expect(active.ended).toBe(false);
    expect(await active.inbox.next()).toEqual({ t: "cmd.revoke" });
    active.end("revoked");
    expect(active.receive(next, next.command)).toBe(false);
    expect(await active.inbox.next()).toBeNull();
  });
});
