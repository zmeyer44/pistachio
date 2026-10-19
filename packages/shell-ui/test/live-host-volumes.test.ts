/**
 * The host's volume for a guest (docs/live-share.md §6.3,
 * src/components/live-host/host-session.ts): muting a guest for the host
 * alone holds for the life of the share — a guest back from a reload, and
 * everyone in a room joined afresh, is a new participant to LiveKit, which
 * keeps a volume on the participant it was set on, and a guest reloading is
 * off main's list a moment — and is set on nobody main does not let in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveRoom, type LiveParticipant } from "@pistachio/live-share/room";
import { idleLiveShare } from "@pistachio/shell-contracts/live-share";
import { LiveHostSession } from "../src/components/live-host/host-session";

vi.mock("@pistachio/live-share/room", () => ({ LiveRoom: { connect: vi.fn() }, WINDOW_CAPTURE_MAX_SIDE: 2560, WINDOW_MAX_FPS: 30 }));

let presences = 0;

/**
 * The room as the session meets it, its guests' volumes as LiveKit keeps
 * them: on the participant they were set on. A guest who joins — the first
 * time, or back from a reload — is a new participant, heard at full volume.
 * `drop()` is LiveKit giving up on the room.
 */
class VolumeRoom {
  /** Each guest in the room, as the participant LiveKit has for them now. */
  readonly #guests = new Map<string, { sid: string; volume: number }>();
  readonly #listeners = new Map<string, Set<(value: unknown) => void>>();

  constructor(guests: readonly string[] = []) {
    for (const identity of guests) this.#guests.set(identity, VolumeRoom.#presence());
  }

  static #presence(): { sid: string; volume: number } {
    presences += 1;
    return { sid: `PA_${String(presences)}`, volume: 1 };
  }

  /** How loud the host hears the guest's participant now (undefined: not in the room). */
  volume(identity: string): number | undefined {
    return this.#guests.get(identity)?.volume;
  }

  join(identity: string): void {
    this.#guests.set(identity, VolumeRoom.#presence());
    this.#emit("participants", this.participants());
  }

  leave(identity: string): void {
    this.#guests.delete(identity);
    this.#emit("participants", this.participants());
  }

  drop(): void {
    this.#emit("disconnected", "failed");
  }

  setParticipantVolume(identity: string, volume: number): void {
    const guest = this.#guests.get(identity);
    if (guest !== undefined) guest.volume = volume;
  }

  participants(): LiveParticipant[] {
    return [
      participant("host", "PA_host"),
      ...[...this.#guests].map(([identity, guest]) => participant(identity, guest.sid)),
    ];
  }

  on(event: string, listener: (value: unknown) => void): () => void {
    const set = this.#listeners.get(event) ?? new Set();
    set.add(listener);
    this.#listeners.set(event, set);
    return () => set.delete(listener);
  }
  onMessage(): () => void {
    return () => undefined;
  }
  state(): "connected" {
    return "connected";
  }
  setReceivers(): void {}
  async send(): Promise<void> {}
  async disconnect(): Promise<void> {}

  #emit(event: string, value: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(value);
  }
}

function participant(identity: string, sid: string): LiveParticipant {
  const host = identity === "host";
  return {
    identity,
    sid,
    name: host ? "Zach" : identity,
    role: host ? "host" : "guest",
    color: host ? "#3E63DD" : "#E54D2E",
    isLocal: host,
    micOn: true,
    cameraOn: false,
    speaking: false,
    audioLevel: 0,
    connection: "good",
    camera: null,
  };
}

describe("the host's volume for a guest", () => {
  let session: LiveHostSession | null = null;

  beforeEach(() => {
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), devicePixelRatio: 2, innerWidth: 1200, innerHeight: 800 });
    vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices: async () => [], addEventListener: vi.fn(), removeEventListener: vi.fn() } });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    session?.dispose();
    session = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A session in this room, joined, with Ann and Bo let in. */
  async function joined(room: VolumeRoom): Promise<LiveHostSession> {
    vi.mocked(LiveRoom.connect).mockResolvedValue(room as unknown as LiveRoom);
    const live = new LiveHostSession(
      { livekit: { url: "ws://room.test", token: "host-token" }, shareId: "share-1", state: { ...idleLiveShare(), status: "live" }, frame: null, shell: null, stage: null, chrome: [], admitted: ["g_ann", "g_bo"] },
      { sendLiveHostReport: () => undefined, liveHostSource: async () => null, liveHostShellSource: async () => null },
    );
    session = live;
    live.start();
    await vi.advanceTimersByTimeAsync(0);
    return live;
  }

  it("holds through a guest's reload and a room joined afresh, for the life of the share, and is set on nobody not let in", async () => {
    const room = new VolumeRoom(["g_ann", "g_bo"]);
    const live = await joined(room);

    live.setGuestVolume("g_ann", 0);
    expect(room.volume("g_ann")).toBe(0);

    // Ann reloads: out of the room, and back as a new participant. Bo is heard as he was.
    room.leave("g_ann");
    room.join("g_ann");
    expect(room.volume("g_ann")).toBe(0);
    expect(room.volume("g_bo")).toBe(1);
    expect(live.view().volumes).toEqual(new Map([["g_ann", 0]]));

    // LiveKit gives up on the room, and the host joins a new one, where both already are.
    const next = new VolumeRoom(["g_ann", "g_bo"]);
    vi.mocked(LiveRoom.connect).mockResolvedValue(next as unknown as LiveRoom);
    room.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    live.handle({ type: "token", token: "host-token-2" });
    await vi.advanceTimersByTimeAsync(0);
    expect(LiveRoom.connect).toHaveBeenLastCalledWith(expect.objectContaining({ token: "host-token-2" }));
    expect(next.volume("g_ann")).toBe(0);
    expect(next.volume("g_bo")).toBe(1);

    // Heard again: nothing left to set.
    live.setGuestVolume("g_ann", 1);
    next.leave("g_ann");
    next.join("g_ann");
    expect(next.volume("g_ann")).toBe(1);
    expect(live.view().volumes).toEqual(new Map());

    // Bo muted, then removed: his volume is kept with the share's (let in again, he would be someone new), but set on
    // him no more — back in the room on a token LiveKit refreshed, nothing of his is played.
    live.setGuestVolume("g_bo", 0);
    live.setGuestVolume("g_ann", 0);
    live.handle({ type: "admitted", identities: ["g_ann"] });
    next.leave("g_bo");
    next.join("g_bo");
    expect(next.volume("g_bo")).toBe(1);
    expect(next.volume("g_ann")).toBe(0);
    // Nor is one set or kept for someone not let in.
    live.setGuestVolume("g_bo", 0.5);
    expect(next.volume("g_bo")).toBe(1);
    expect(live.view().volumes).toEqual(new Map([["g_ann", 0], ["g_bo", 0]]));
  });

  it("holds while a guest back from a reload is off main's list a moment", async () => {
    const room = new VolumeRoom(["g_ann", "g_bo"]);
    const live = await joined(room);
    live.setGuestVolume("g_ann", 0);

    // Ann reloads: gone from the room, main lets her go, and lets her in again — the participant she is now — once
    // control has said so.
    room.leave("g_ann");
    live.handle({ type: "admitted", identities: ["g_bo"] });
    room.join("g_ann");
    live.handle({ type: "admitted", identities: ["g_bo", "g_ann"] });
    expect(room.volume("g_ann")).toBe(0);
    expect(room.volume("g_bo")).toBe(1);
    expect(live.view().volumes).toEqual(new Map([["g_ann", 0]]));
  });
});
