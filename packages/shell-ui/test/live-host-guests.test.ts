/**
 * Who each guest is told is let in (docs/live-share.md §4 `lv.guests`,
 * §6.3, src/components/live-host/host-session.ts): the host's room tells
 * the guests main admits who they are — on every change, to them alone,
 * ahead of anything that change starts (a sync); on each hello, ahead of
 * the sync it brings (how a guest back from a reconnect hears it again);
 * and again when the host's own room is back — since each guest lets only
 * the host and those on it see and hear it, and hears only them. And the
 * host's room is joined for them alone, every time it is joined.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveRoom, type LiveSender } from "@pistachio/live-share/room";
import { idleLiveShare } from "@pistachio/shell-contracts/live-share";
import { LiveHostSession } from "../src/components/live-host/host-session";

vi.mock("@pistachio/live-share/room", () => ({ LiveRoom: { connect: vi.fn() }, WINDOW_CAPTURE_MAX_SIDE: 2560, WINDOW_MAX_FPS: 30 }));

interface Sent {
  topic: string;
  body: unknown;
  to: string[] | undefined;
}

/** The room as the session meets it, saying what it is sent and passing it what guests say. */
class ListeningRoom {
  readonly sent: Sent[] = [];
  readonly #handlers = new Map<string, Set<(body: unknown, from: LiveSender) => void>>();
  readonly #listeners = new Map<string, Set<(value: unknown) => void>>();

  on(event: string, listener: (value: unknown) => void): () => void {
    const set = this.#listeners.get(event) ?? new Set();
    set.add(listener);
    this.#listeners.set(event, set);
    return () => set.delete(listener);
  }
  emit(event: string, value: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(value);
  }
  onMessage(topic: string, handler: (body: unknown, from: LiveSender) => void): () => void {
    const set = this.#handlers.get(topic) ?? new Set();
    set.add(handler);
    this.#handlers.set(topic, set);
    return () => set.delete(handler);
  }
  /** A guest says something to the host. */
  hear(topic: string, body: unknown, identity: string): void {
    for (const handler of this.#handlers.get(topic) ?? []) handler(body, { identity, role: "guest" });
  }
  state(): "connected" {
    return "connected";
  }
  participants(): [] {
    return [];
  }
  setReceivers(): void {}
  async send(topic: string, body: unknown, options: { to?: string[] } = {}): Promise<void> {
    this.sent.push({ topic, body, to: options.to });
  }
  async disconnect(): Promise<void> {}
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** What went out of the topics that say who is in, each as "topic → to: body's guests". */
const said = (room: ListeningRoom): string[] =>
  room.sent
    .filter((sent) => sent.topic === "lv.guests" || sent.topic === "lv.sync")
    .map((sent) => `${sent.topic} → ${String(sent.to)}${sent.topic === "lv.guests" ? `: ${(sent.body as { guests: string[] }).guests.join(",")}` : ""}`);

describe("the list of guests let in", () => {
  let session: LiveHostSession | null = null;

  beforeEach(() => {
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), devicePixelRatio: 2, innerWidth: 1200, innerHeight: 800 });
    vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices: async () => [], addEventListener: vi.fn(), removeEventListener: vi.fn() } });
  });

  afterEach(() => {
    session?.dispose();
    session = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function joined(): Promise<{ room: ListeningRoom; live: LiveHostSession }> {
    const room = new ListeningRoom();
    vi.mocked(LiveRoom.connect).mockResolvedValue(room as unknown as LiveRoom);
    const live = new LiveHostSession(
      { livekit: { url: "ws://room.test", token: "host-token" }, shareId: "share-1", state: { ...idleLiveShare(), status: "live" }, frame: null, shell: null, stage: null, chrome: [], admitted: [] },
      { sendLiveHostReport: () => undefined, liveHostSource: async () => null, liveHostShellSource: async () => null },
    );
    session = live;
    live.start();
    await settle();
    return { room, live };
  }

  it("goes to the guests let in on every change and on each hello, ahead of the sync either brings", async () => {
    const { room, live } = await joined();
    // Nobody let in: nothing to tell anyone.
    expect(said(room)).toEqual([]);
    // Ann said hello as she joined, before main's word: her sync waits for it, behind the list.
    room.hear("lv.hello", {}, "g_ann");
    live.handle({ type: "admitted", identities: ["g_ann"] });
    await settle();
    expect(said(room)).toEqual(["lv.guests → g_ann: g_ann", "lv.sync → g_ann"]);

    // Bo let in: both told, Bo's sync behind it; a stranger in the room is told nothing.
    room.sent.length = 0;
    live.handle({ type: "admitted", identities: ["g_ann", "g_bo"] });
    room.hear("lv.hello", {}, "g_stranger");
    room.hear("lv.hello", {}, "g_bo");
    await settle();
    expect(said(room)).toEqual(["lv.guests → g_ann,g_bo: g_ann,g_bo", "lv.guests → g_bo: g_ann,g_bo", "lv.sync → g_bo"]);

    // Ann back from a reconnect, asking again: the list ahead of the room (the sync waits its gap; the list does not).
    room.sent.length = 0;
    room.hear("lv.hello", {}, "g_ann");
    await settle();
    expect(said(room)).toEqual(["lv.guests → g_ann: g_ann,g_bo"]);

    // Bo removed: Ann alone is told, and no longer lets him see or hear her; his hello gets nothing.
    room.sent.length = 0;
    live.handle({ type: "admitted", identities: ["g_ann"] });
    room.hear("lv.hello", {}, "g_bo");
    await settle();
    expect(said(room)).toEqual(["lv.guests → g_ann: g_ann"]);
  });

  it("is whom the room is joined for: main's list at the start, and as it is then when the host joins a new room", async () => {
    vi.useFakeTimers();
    const first = new ListeningRoom();
    vi.mocked(LiveRoom.connect).mockResolvedValue(first as unknown as LiveRoom);
    const live = new LiveHostSession(
      { livekit: { url: "ws://room.test", token: "host-token" }, shareId: "share-1", state: { ...idleLiveShare(), status: "live" }, frame: null, shell: null, stage: null, chrome: [], admitted: ["g_ann"] },
      { sendLiveHostReport: () => undefined, liveHostSource: async () => null, liveHostShellSource: async () => null },
    );
    session = live;
    live.start();
    await vi.advanceTimersByTimeAsync(0);
    // (LiveKit subscribes the room to who is in it as it joins: a guest not on the list is never played.)
    expect(LiveRoom.connect).toHaveBeenLastCalledWith(expect.objectContaining({ role: "host", receivers: ["g_ann"] }));

    // Bo let in; then LiveKit gives the room up, and the host joins a new one.
    live.handle({ type: "admitted", identities: ["g_ann", "g_bo"] });
    vi.mocked(LiveRoom.connect).mockResolvedValue(new ListeningRoom() as unknown as LiveRoom);
    first.emit("disconnected", "failed");
    await vi.advanceTimersByTimeAsync(1_000);
    live.handle({ type: "token", token: "host-token-2" });
    await vi.advanceTimersByTimeAsync(0);
    expect(LiveRoom.connect).toHaveBeenLastCalledWith(expect.objectContaining({ token: "host-token-2", receivers: ["g_ann", "g_bo"] }));
  });

  it("goes again when the host's room is back, to whoever missed a change meanwhile", async () => {
    const { room, live } = await joined();
    live.handle({ type: "admitted", identities: ["g_ann", "g_bo"] });
    await settle();
    room.sent.length = 0;
    room.emit("state", "reconnecting");
    room.emit("state", "connected");
    await settle();
    expect(said(room)).toEqual(["lv.guests → g_ann,g_bo: g_ann,g_bo"]);
  });
});
