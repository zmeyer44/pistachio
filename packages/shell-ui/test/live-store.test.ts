/**
 * The live share as the shell keeps it (docs/live-share.md §6.4,
 * src/lib/live/store.ts): main's state on its channel, and the guests alone
 * on the roster channel when only who speaks or how well they are
 * connected changed — taken as the state's `participants`, the rest kept.
 */

import { describe, expect, it, vi } from "vitest";
import { idleLiveShare, type LiveGuest, type LiveShareState } from "@pistachio/shell-contracts/live-share";

const bridge = vi.hoisted(() => ({
  state: null as ((state: unknown) => void) | null,
  roster: null as ((guests: unknown) => void) | null,
}));

vi.mock("../src/api", () => ({
  nativeApi: () => ({
    onLiveShare: (listener: (state: unknown) => void) => {
      bridge.state = listener;
      return () => (bridge.state = null);
    },
    onLiveRoster: (listener: (guests: unknown) => void) => {
      bridge.roster = listener;
      return () => (bridge.roster = null);
    },
    getLiveShare: () => new Promise(() => undefined),
  }),
}));

const { liveShareNow, watchLiveShare } = await import("../src/lib/live/store");

const guest = (identity: string, speaking: boolean): LiveGuest => ({ identity, name: "Ann", color: "#E54D2E", micOn: true, cameraOn: false, speaking, connection: "good" });

describe("the shell's live share", () => {
  it("takes a roster as the state's guests, keeping the rest of the state, and lets go of both channels", () => {
    const stop = watchLiveShare();
    const live: LiveShareState = {
      ...idleLiveShare(),
      status: "live",
      groupId: "space-a",
      participants: [guest("g_a", false)],
      chat: [{ id: "host:1", from: "host", name: "Zach", color: "#3E63DD", text: "Hi", at: 1 }],
    };
    bridge.state!(live);
    bridge.roster!([guest("g_a", true)]);
    expect(liveShareNow().participants).toEqual([guest("g_a", true)]);
    expect(liveShareNow().chat).toBe(live.chat);
    expect(liveShareNow().groupId).toBe("space-a");
    stop();
    expect(bridge.state).toBeNull();
    expect(bridge.roster).toBeNull();
  });
});
