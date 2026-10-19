import { describe, expect, it } from "vitest";
import {
  decodeMessage,
  encodeText,
  InkBoard,
  LIVE_TOPICS,
  liveSyncSchema,
  MAX_CHAT_HISTORY,
  MAX_CHAT_LENGTH,
  MAX_DESK_WINDOWS,
  MAX_FAVICON_LENGTH,
  MAX_INK_PAIRS_PER_MESSAGE,
  MAX_STROKE_PAIRS,
  MAX_STROKES,
  MAX_WINDOW_TITLE_LENGTH,
  type LiveStroke,
  type LiveSync,
} from "@pistachio/live-share";
import type { LiveParticipant } from "@pistachio/live-share/room";
import { idleLiveShare, type LiveChatMessage, type LiveGuest, type LiveHostDeskFrame, type LiveShareState } from "@pistachio/shell-contracts/live-share";
import { buildSync, cameBack, guestsOf, refusedAsks, rosterChange, sameGuests, sessionsOf, SYNC_MAX_CHARS } from "../src/components/live-host/room-sync";

const FRAME: LiveHostDeskFrame = {
  v: 1,
  seq: 7,
  stage: { w: 1200, h: 800 },
  hostPresent: true,
  space: { title: "Launch plan", color: "#388cf0" },
  windows: [
    {
      id: "t1",
      kind: "page",
      title: "GitHub",
      origin: "github.com",
      favicon: null,
      frame: { x: 40, y: 40, w: 600, h: 430 },
      page: { x: 40, y: 70, w: 600, h: 400 },
      focused: true,
      minimized: false,
      controllable: true,
      track: "win:t1",
      paused: false,
    },
  ],
};

const message = (id: string, from: string, text: string): LiveChatMessage => ({ id, from, name: from === "host" ? "Zach" : "Ann", color: from === "host" ? "#3E63DD" : "#E54D2E", text, at: 1_700_000_000_000 });

/**
 * A board full of a guest's ink as the room brings it: `MAX_STROKES` strokes
 * of `MAX_STROKE_PAIRS` pairs, each a `begin` and `add`s of 64 pairs, the
 * points at `point(n)` (the n-th coordinate sent).
 */
function fullBoard(owner: string, point: (n: number) => number): InkBoard {
  const board = new InkBoard();
  const from = { identity: owner, role: "guest" as const };
  let n = 0;
  const pts = (pairs: number): number[] => Array.from({ length: pairs * 2 }, () => point(n++));
  for (let index = 0; index < MAX_STROKES; index += 1) {
    const id = `${owner}:${String(100_000_000 + index)}`;
    board.apply({ op: "begin", id, tool: "highlighter", color: "#E54D2E", size: 0.012, pts: pts(MAX_INK_PAIRS_PER_MESSAGE) }, from, 0);
    for (let sent = MAX_INK_PAIRS_PER_MESSAGE; sent < MAX_STROKE_PAIRS; sent += MAX_INK_PAIRS_PER_MESSAGE) {
      board.apply({ op: "add", id, pts: pts(Math.min(MAX_INK_PAIRS_PER_MESSAGE, MAX_STROKE_PAIRS - sent)) }, from, 0);
    }
  }
  return board;
}

/** What a guest's room does with a sync: its JSON, read within the topic's limit. */
function received(sync: LiveSync): LiveSync | null {
  return decodeMessage("lv.sync", encodeText("lv.sync", sync), "host");
}

const syncLength = (sync: LiveSync): number => encodeText("lv.sync", sync).length;

function participant(identity: string, patch: Partial<LiveParticipant> = {}): LiveParticipant {
  return {
    identity,
    sid: `PA_${identity}`,
    name: identity === "host" ? "Zach" : "Ann",
    role: identity === "host" ? "host" : "guest",
    color: identity === "host" ? "#3E63DD" : "#E54D2E",
    isLocal: identity === "host",
    micOn: true,
    cameraOn: false,
    speaking: false,
    audioLevel: 0,
    connection: "good",
    camera: null,
    ...patch,
  };
}

describe("buildSync", () => {
  it("is the desk, the board, the chat and who uses what, as the protocol takes it", () => {
    const board = new InkBoard();
    board.apply({ op: "begin", id: "g_a:1", tool: "pen", color: "#E54D2E", size: 0.003, pts: [0.1, 0.1, 0.2, 0.2] }, { identity: "g_a", role: "guest" }, 0);
    board.apply({ op: "begin", id: "host:1", tool: "laser", color: "#3E63DD", size: 0.003, pts: [0.5, 0.5] }, { identity: "host", role: "host" }, 0);
    const sync = buildSync({
      frame: FRAME,
      strokes: board.snapshot(),
      chat: [message("host:1", "host", "Welcome"), message("g_a:k1-1", "g_a", "Hi")],
      using: [
        { windowId: "t1", identity: "g_a" },
        { windowId: "t1", identity: "g_b" },
      ],
    });
    expect(liveSyncSchema.safeParse(sync).success).toBe(true);
    expect(sync.desk?.seq).toBe(7);
    // A laser is gone before a guest could see it.
    expect(sync.strokes.map((stroke) => stroke.id)).toEqual(["g_a:1"]);
    expect(sync.chat.map((entry) => entry.text)).toEqual(["Welcome", "Hi"]);
    // One grant per window, the latest.
    expect(sync.grants).toEqual([{ w: "t1", user: "g_b" }]);
  });

  it("leaves out what the protocol would refuse rather than failing the whole sync", () => {
    const sync = buildSync({
      frame: { ...FRAME, stage: { w: 0, h: 800 } },
      strokes: [],
      chat: [message("host:1", "host", "   "), message("host:2", "host", "fine")],
      using: [],
    });
    expect(sync.desk).toBeNull();
    expect(sync.chat.map((entry) => entry.id)).toEqual(["host:2"]);
    expect(liveSyncSchema.safeParse(sync).success).toBe(true);
  });

  it("carries the last 200 messages", () => {
    const chat = Array.from({ length: MAX_CHAT_HISTORY + 5 }, (_, index) => message(`host:${String(index)}`, "host", `m${String(index)}`));
    const sync = buildSync({ frame: null, strokes: [], chat, using: [] });
    expect(sync.chat).toHaveLength(MAX_CHAT_HISTORY);
    expect(sync.chat[0]?.text).toBe("m5");
  });

  // Full-size boards are built and serialized whole: about 1–2 s, more on a loaded machine.
  const FULL_SIZE_MS = 30_000;

  it("is read by a guest with a full board of a guest's ink sent at full precision, every stroke and point kept", () => {
    // Codex's case: 400 strokes of 1000 pairs, each coordinate a double's 16–17 digits — once ~16 MB, twice the limit.
    const board = fullBoard("g_a", (n) => (n * 0.6180339887498949) % 1);
    const sync = buildSync({ frame: FRAME, strokes: board.snapshot(), chat: [message("host:1", "host", "Welcome")], using: [] });
    expect(syncLength(sync)).toBeLessThanOrEqual(LIVE_TOPICS["lv.sync"].maxBytes);
    expect(received(sync)?.strokes).toHaveLength(MAX_STROKES);
    expect(sync.strokes.every((stroke) => stroke.pts.length === MAX_STROKE_PAIRS * 2)).toBe(true);
    expect(sync.desk?.seq).toBe(7);
  }, FULL_SIZE_MS);

  it("is read by a guest with everything at its largest: the oldest strokes go, the chat and the desk stay", () => {
    // Every coordinate as long as the grid makes one, every message as long as JSON makes one, a desk of 64 windows
    // with 4 KB icons: over the limit together, though a full board and the chat at its longest fit alone.
    const board = fullBoard(`g_${"a".repeat(62)}`, (n) => (1_001 + (n % 8_000)) / 10_000);
    const strokes = board.snapshot();
    const longest = "\u0001".repeat(MAX_CHAT_LENGTH);
    const chat = Array.from({ length: MAX_CHAT_HISTORY }, (_, index) => ({ ...message(`g_a:${String(index)}`, "g_a", longest), name: "\u0001".repeat(80) }));
    const [window] = FRAME.windows;
    if (window === undefined) throw new Error("FRAME has a window");
    const frame: LiveHostDeskFrame = {
      ...FRAME,
      windows: Array.from({ length: MAX_DESK_WINDOWS }, (_, index) => ({
        ...window,
        id: `t${String(index)}`,
        title: "\u0001".repeat(MAX_WINDOW_TITLE_LENGTH),
        favicon: `data:image/png;base64,${"A".repeat(MAX_FAVICON_LENGTH - 22)}`,
      })),
    };
    expect(syncLength(buildSync({ frame, strokes, chat: chat.slice(0, 1), using: [] }))).toBeLessThan(SYNC_MAX_CHARS);
    expect(syncLength(buildSync({ frame: null, strokes, chat, using: [] }))).toBeLessThan(SYNC_MAX_CHARS);
    expect(syncLength(buildSync({ frame, strokes, chat, using: [] }, Infinity))).toBeGreaterThan(SYNC_MAX_CHARS);

    const sync = buildSync({ frame, strokes, chat, using: [{ windowId: "t1", identity: "g_a" }] });
    expect(syncLength(sync)).toBeLessThanOrEqual(SYNC_MAX_CHARS);
    expect(received(sync)).not.toBeNull();
    expect(sync.chat).toHaveLength(MAX_CHAT_HISTORY);
    expect(sync.desk?.windows).toHaveLength(MAX_DESK_WINDOWS);
    expect(sync.grants).toEqual([{ w: "t1", user: "g_a" }]);
    // The newest strokes, as many as fit.
    const kept = sync.strokes.length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(MAX_STROKES);
    expect(sync.strokes).toEqual(strokes.slice(-kept));
  }, FULL_SIZE_MS);

  it("past what a guest reads, cuts the oldest strokes first, then the oldest chat, then the desk — no more than it must", () => {
    const stroke = (index: number): LiveStroke => ({ id: `g_a:${String(index)}`, tool: "pen", color: "#E54D2E", size: 0.003, pts: [0.1234, 0.5678, 0.9, 0.1], done: true });
    const inputs = {
      frame: FRAME,
      strokes: Array.from({ length: 10 }, (_, index) => stroke(index)),
      chat: Array.from({ length: 10 }, (_, index) => message(`g_a:${String(index)}`, "g_a", `message ${String(index)}`)),
      using: [{ windowId: "t1", identity: "g_a" }],
    };
    const whole = buildSync(inputs, Infinity);
    const cut = (maxChars: number): LiveSync => {
      const sync = buildSync(inputs, maxChars);
      expect(syncLength(sync)).toBeLessThanOrEqual(maxChars);
      return sync;
    };
    expect(cut(syncLength(whole))).toEqual(whole);
    // One character over: the oldest stroke goes, and only it.
    expect(cut(syncLength(whole) - 1).strokes).toEqual(whole.strokes.slice(1));
    // Room for the chat and the desk and no stroke: every stroke goes, nothing else.
    const strokeless = { ...whole, strokes: [] };
    expect(cut(syncLength(strokeless))).toEqual(strokeless);
    // Less: the oldest messages go next, the newest stay.
    const shorter = cut(syncLength(strokeless) - 1);
    expect(shorter.strokes).toEqual([]);
    expect(shorter.chat).toEqual(whole.chat.slice(1));
    expect(shorter.desk).toEqual(whole.desk);
    // Room for the grants alone: the desk goes too, and who uses what is still said.
    const bare = { desk: null, strokes: [], chat: [], grants: whole.grants };
    expect(cut(syncLength(bare))).toEqual(bare);
    expect(received(cut(syncLength(bare)))).toEqual(bare);
  });
});

describe("the roster", () => {
  it("is the guests, in join order, without the host", () => {
    const guests = guestsOf([participant("host"), participant("g_a", { speaking: true }), participant("g_b", { name: "Bo", connection: "poor" })]);
    expect(guests).toEqual([
      { identity: "g_a", name: "Ann", color: "#E54D2E", micOn: true, cameraOn: false, speaking: true, connection: "good" },
      { identity: "g_b", name: "Bo", color: "#E54D2E", micOn: true, cameraOn: false, speaking: false, connection: "poor" },
    ]);
  });

  it("changes when someone comes, goes, speaks or turns something on — not when a level ticks", () => {
    const before = guestsOf([participant("host"), participant("g_a")]);
    expect(sameGuests(before, guestsOf([participant("host"), participant("g_a", { audioLevel: 0.4 })]))).toBe(true);
    expect(sameGuests(before, guestsOf([participant("host"), participant("g_a", { speaking: true })]))).toBe(false);
    expect(sameGuests(before, guestsOf([participant("host"), participant("g_a", { cameraOn: true })]))).toBe(false);
    expect(sameGuests(before, guestsOf([participant("host")]))).toBe(false);
  });

  it("says who is back under the same identity with a new presence (a removed guest's refreshed token), not who stayed or came", () => {
    const before = sessionsOf([participant("host"), participant("g_a"), participant("g_b")]);
    expect([...before.keys()]).toEqual(["g_a", "g_b"]);
    const after = sessionsOf([participant("host"), participant("g_a", { sid: "PA_again" }), participant("g_b"), participant("g_c")]);
    expect(cameBack(before, after)).toEqual(["g_a"]);
    expect(cameBack(after, after)).toEqual([]);
  });

  it("says who joined and who left", () => {
    const before = guestsOf([participant("g_a"), participant("g_b")]);
    const after = guestsOf([participant("g_b"), participant("g_c")]);
    expect(rosterChange(before, after)).toEqual({ joined: ["g_c"], left: ["g_a"] });
  });
});

describe("refusals", () => {
  const ann: LiveGuest = { identity: "g_a", name: "Ann", color: "#E54D2E", micOn: false, cameraOn: false };
  const asking = (patch: Partial<LiveShareState> = {}): LiveShareState => ({
    ...idleLiveShare(),
    status: "live",
    participants: [ann],
    asks: [
      { identity: "g_a", name: "Ann", windowId: "t1", at: 1 },
      { identity: "g_a", name: "Ann", windowId: "t2", at: 2 },
    ],
    ...patch,
  });

  it("are the asks main took away while their guest is still here and the window is still not theirs", () => {
    // Denied: the ask goes, nothing else changes.
    expect(refusedAsks(asking(), asking({ asks: [{ identity: "g_a", name: "Ann", windowId: "t2", at: 2 }] })).map((ask) => ask.windowId)).toEqual(["t1"]);
  });

  it("are not an ask allowed, one whose guest left, or one still waiting", () => {
    expect(refusedAsks(asking(), asking({ asks: [], controllable: ["t1", "t2"] }))).toEqual([]);
    expect(refusedAsks(asking(), asking({ asks: [], participants: [] }))).toEqual([]);
    expect(refusedAsks(asking(), asking())).toEqual([]);
  });
});
