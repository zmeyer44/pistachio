/**
 * Who the host's room is for (docs/live-share.md §6.1, §6.3,
 * src/components/live-host/audience.ts): the guests main lets in receive
 * everything and nobody else does; a guest is sent the room once they have
 * said hello and are let in, not twice for one join; the windows are
 * captured while anyone is let in, and stop a grace period after the last
 * one leaves. A guest let in beside others is sent the room once more a
 * moment after their first: the others' word reached them only once the
 * others had heard who they are.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATCH_UP_MS, RoomAudience, STREAM_GRACE_MS, SYNC_GAP_MS } from "../src/components/live-host/audience";

function audience(admitted: readonly string[] = []) {
  const synced: string[] = [];
  const streaming: boolean[] = [];
  const room = new RoomAudience(
    {
      sync: (identity) => synced.push(identity),
      streaming: (on) => streaming.push(on),
      now: () => Date.now(),
      later: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
    },
    admitted,
  );
  return { room, synced, streaming };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("who receives", () => {
  it("is main's admitted list, in its order, and nobody before it", () => {
    const { room } = audience();
    expect(room.receivers()).toEqual([]);
    room.setAdmitted(["g_b", "g_a"]);
    expect(room.receivers()).toEqual(["g_b", "g_a"]);
    expect(room.has("g_a")).toBe(true);
    // Removed (main took them off the list): back in the room with a refreshed token, they are no one's guest.
    room.setAdmitted(["g_b"]);
    expect(room.has("g_a")).toBe(false);
    expect(room.receivers()).toEqual(["g_b"]);
  });
});

describe("the room for a guest (lv.sync)", () => {
  it("goes once a guest who said hello is let in, whichever comes first — and never to one who is not", () => {
    const { room, synced } = audience();
    // Said hello as they joined, before main's word: held.
    room.setRoom(new Set(["g_a", "g_r"]));
    room.hello("g_a");
    room.hello("g_r");
    expect(synced).toEqual([]);
    room.setAdmitted(["g_a"]);
    expect(synced).toEqual(["g_a"]);
    // Let in first, hello after.
    room.setRoom(new Set(["g_a", "g_r", "g_b"]));
    room.setAdmitted(["g_a", "g_b"]);
    expect(synced).toEqual(["g_a"]);
    room.hello("g_b");
    expect(synced).toEqual(["g_a", "g_b"]);
    // The removed guest who said hello is still never sent the room.
    expect(synced).not.toContain("g_r");
  });

  it("is sent at most once every two seconds per guest: one join, one sync", () => {
    const { room, synced } = audience(["g_a"]);
    room.hello("g_a");
    room.hello("g_a");
    vi.advanceTimersByTime(SYNC_GAP_MS - 1);
    room.hello("g_a");
    expect(synced).toEqual(["g_a"]);
    // The guest heard nothing and asks again (every 2.5 s): answered.
    vi.advanceTimersByTime(1);
    room.hello("g_a");
    expect(synced).toEqual(["g_a", "g_a"]);
  });

  it("forgets a hello from someone who left before being let in, and syncs afresh someone let out and in again", () => {
    const { room, synced } = audience();
    room.setRoom(new Set(["g_a"]));
    room.hello("g_a");
    room.setRoom(new Set());
    room.setAdmitted(["g_a"]);
    expect(synced).toEqual([]);

    room.hello("g_a");
    expect(synced).toEqual(["g_a"]);
    room.setAdmitted([]);
    room.setAdmitted(["g_a"]);
    room.hello("g_a");
    expect(synced).toEqual(["g_a", "g_a"]);
  });
});

describe("the room again for a newcomer", () => {
  it("goes once more, CATCH_UP_MS after the first, to a guest let in beside others — whatever the gap, and only once", () => {
    const { room, synced } = audience(["g_a"]);
    room.hello("g_a");
    room.setRoom(new Set(["g_a", "g_b"]));
    room.setAdmitted(["g_a", "g_b"]);
    room.hello("g_b");
    expect(synced).toEqual(["g_a", "g_b"]);
    // Asking again meanwhile is answered as ever, and brings no second catch-up.
    vi.advanceTimersByTime(SYNC_GAP_MS - 500);
    room.hello("g_b");
    expect(synced).toEqual(["g_a", "g_b"]);
    vi.advanceTimersByTime(CATCH_UP_MS - (SYNC_GAP_MS - 500) - 1);
    expect(synced).toEqual(["g_a", "g_b"]);
    vi.advanceTimersByTime(1);
    expect(synced).toEqual(["g_a", "g_b", "g_b"]);
    vi.advanceTimersByTime(CATCH_UP_MS * 5);
    expect(synced).toEqual(["g_a", "g_b", "g_b"]);
    // The catch-up counts as a sync: a hello right after it waits its gap.
    vi.advanceTimersByTime(SYNC_GAP_MS);
    room.hello("g_a");
    expect(synced).toEqual(["g_a", "g_b", "g_b", "g_a"]);
  });

  it("is not sent to a guest alone in the room, to one let out meanwhile, or once the share is over", () => {
    const alone = audience(["g_a"]);
    alone.room.hello("g_a");
    vi.advanceTimersByTime(CATCH_UP_MS * 2);
    expect(alone.synced).toEqual(["g_a"]);

    const out = audience(["g_a", "g_b"]);
    out.room.hello("g_b");
    out.room.setAdmitted(["g_a"]);
    vi.advanceTimersByTime(CATCH_UP_MS);
    expect(out.synced).toEqual(["g_b"]);
    // Let in again: a newcomer once more, caught up once more.
    out.room.setAdmitted(["g_a", "g_b"]);
    out.room.hello("g_b");
    vi.advanceTimersByTime(CATCH_UP_MS);
    expect(out.synced).toEqual(["g_b", "g_b", "g_b"]);

    const over = audience(["g_a", "g_b"]);
    over.room.hello("g_b");
    over.room.dispose();
    vi.advanceTimersByTime(CATCH_UP_MS);
    expect(over.synced).toEqual(["g_b"]);
  });
});

describe("capturing the windows", () => {
  it("starts with the first guest let in and stops thirty seconds after the last one leaves", () => {
    const { room, streaming } = audience();
    expect(room.streaming()).toBe(false);
    room.setAdmitted(["g_a"]);
    expect(streaming).toEqual([true]);
    room.setAdmitted(["g_a", "g_b"]);
    room.setAdmitted([]);
    vi.advanceTimersByTime(STREAM_GRACE_MS - 1);
    expect(room.streaming()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(streaming).toEqual([true, false]);
    expect(room.streaming()).toBe(false);
  });

  it("keeps capturing for a guest back within the grace, and stops nothing once disposed", () => {
    const { room, streaming } = audience(["g_a"]);
    // Let in as the app started: capturing from the start, without being told.
    expect(room.streaming()).toBe(true);
    room.setAdmitted([]);
    vi.advanceTimersByTime(STREAM_GRACE_MS / 2);
    room.setAdmitted(["g_a"]);
    vi.advanceTimersByTime(STREAM_GRACE_MS);
    expect(streaming).toEqual([]);
    room.setAdmitted([]);
    room.dispose();
    vi.advanceTimersByTime(STREAM_GRACE_MS);
    expect(streaming).toEqual([]);
  });
});
