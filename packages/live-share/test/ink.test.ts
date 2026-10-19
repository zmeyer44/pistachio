import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InkBoard,
  InkRecorder,
  LASER_FADE_MS,
  MAX_STROKE_PAIRS,
  STROKE_IDLE_MS,
  decodeMessage,
  encodeMessage,
  inkAllowed,
  strokeOutline,
  strokeSettled,
  type LiveInkOp,
} from "../src/index.js";

const host = { identity: "host", role: "host" } as const;
const ana = { identity: "g_ana", role: "guest" } as const;
const bo = { identity: "g_bo", role: "guest" } as const;

function begin(id: string, tool: "pen" | "highlighter" | "laser" = "pen"): LiveInkOp {
  return { op: "begin", id, tool, color: "#E54D2E", size: 0.003, pts: [0.1, 0.1] };
}

describe("InkBoard", () => {
  it("draws a stroke its owner begins, adds to and ends", () => {
    const board = new InkBoard();
    expect(board.apply(begin("g_ana:1"), ana, 0)).toBe(true);
    expect(board.apply({ op: "add", id: "g_ana:1", pts: [0.2, 0.2, 0.3, 0.3] }, ana, 10)).toBe(true);
    expect(board.apply({ op: "end", id: "g_ana:1" }, ana, 20)).toBe(true);
    expect(board.visible(30)).toMatchObject([{ id: "g_ana:1", owner: "g_ana", pts: [0.1, 0.1, 0.2, 0.2, 0.3, 0.3], done: true }]);
    // Ended: no more points.
    expect(board.apply({ op: "add", id: "g_ana:1", pts: [0.4, 0.4] }, ana, 40)).toBe(false);
  });

  it("refuses a stroke begun under someone else's name, and touching another's stroke", () => {
    const board = new InkBoard();
    expect(board.apply(begin("g_bo:1"), ana, 0)).toBe(false);
    expect(board.apply(begin("host:1"), ana, 0)).toBe(false);
    board.apply(begin("g_bo:1"), bo, 0);
    expect(board.apply({ op: "add", id: "g_bo:1", pts: [0.5, 0.5] }, ana, 1)).toBe(false);
    expect(board.apply({ op: "end", id: "g_bo:1" }, ana, 1)).toBe(false);
    expect(board.apply({ op: "erase", id: "g_bo:1" }, ana, 1)).toBe(false);
    // Not even the host erases a guest's stroke one by one; it clears all.
    expect(board.apply({ op: "erase", id: "g_bo:1" }, host, 1)).toBe(false);
    expect(board.apply(begin("g_bo:1"), bo, 2)).toBe(false);
    expect(board.size).toBe(1);
  });

  it("lets an owner erase their own stroke", () => {
    const board = new InkBoard();
    board.apply(begin("g_ana:1"), ana, 0);
    expect(board.apply({ op: "erase", id: "g_ana:1" }, ana, 1)).toBe(true);
    expect(board.size).toBe(0);
  });

  it("clears only the sender's strokes for mine, and everything only for the host", () => {
    const board = new InkBoard();
    board.apply(begin("g_ana:1"), ana, 0);
    board.apply(begin("g_ana:2"), ana, 0);
    board.apply(begin("g_bo:1"), bo, 0);
    board.apply(begin("host:1"), host, 0);
    expect(board.apply({ op: "clear", scope: "mine" }, ana, 1)).toBe(true);
    expect(board.visible(1).map((s) => s.id)).toEqual(["g_bo:1", "host:1"]);
    expect(board.apply({ op: "clear", scope: "all" }, bo, 2)).toBe(false);
    expect(board.size).toBe(2);
    expect(board.apply({ op: "clear", scope: "all" }, host, 3)).toBe(true);
    expect(board.size).toBe(0);
  });

  it("holds at most its cap, dropping the oldest", () => {
    const board = new InkBoard({ maxStrokes: 3 });
    for (let n = 1; n <= 5; n += 1) board.apply(begin(`g_ana:${String(n)}`), ana, n);
    expect(board.visible(10).map((s) => s.id)).toEqual(["g_ana:3", "g_ana:4", "g_ana:5"]);
  });

  it("caps a stroke's points", () => {
    const board = new InkBoard();
    board.apply(begin("g_ana:1"), ana, 0);
    const pts = Array.from({ length: 128 }, () => 0.5);
    for (let n = 0; n < 20; n += 1) board.apply({ op: "add", id: "g_ana:1", pts }, ana, n);
    expect(board.visible(0)[0]?.pts.length).toBe(MAX_STROKE_PAIRS * 2);
  });

  it("keeps every point on the ink's 1/10000 grid, whoever sent it and however it came", () => {
    const board = new InkBoard();
    board.apply({ op: "begin", id: "g_ana:1", tool: "pen", color: "#E54D2E", size: 0.003, pts: [0.123456789, 0.98765432] }, ana, 0);
    board.apply({ op: "add", id: "g_ana:1", pts: [1 / 3, 2 / 3, 0.00004, 0.99996] }, ana, 1);
    expect(board.visible(2)[0]?.pts).toEqual([0.1235, 0.9877, 0.3333, 0.6667, 0, 1]);
    board.load([{ id: "g_bo:1", tool: "pen", color: "#E54D2E", size: 0.003, pts: [Math.PI / 10, Math.E / 10], done: true }], 3);
    // In a sync, no coordinate is longer than "0.1234".
    expect(JSON.stringify(board.snapshot()[0]?.pts)).toBe("[0.3142,0.2718]");
  });

  it("fades a laser 1.2 s after its last point, and keeps pens", () => {
    const board = new InkBoard();
    board.apply(begin("g_ana:1", "laser"), ana, 0);
    board.apply({ op: "add", id: "g_ana:1", pts: [0.2, 0.2] }, ana, 500);
    board.apply(begin("g_ana:2", "pen"), ana, 0);
    const laser = board.visible(500).find((s) => s.id === "g_ana:1");
    expect(strokeOutline(laser!, { w: 1000, h: 500 }, 500 + LASER_FADE_MS / 2).opacity).toBeCloseTo(0.5);
    expect(board.visible(500 + LASER_FADE_MS - 1).map((s) => s.id)).toEqual(["g_ana:1", "g_ana:2"]);
    expect(board.visible(500 + LASER_FADE_MS).map((s) => s.id)).toEqual(["g_ana:2"]);
    expect(board.visible(60_000).map((s) => s.id)).toEqual(["g_ana:2"]);
    // Drawing leaves the board as it is; `expire` drops the faded laser, and says when it did.
    expect(board.size).toBe(2);
    expect(board.nextChange(500)).toBe(500 + LASER_FADE_MS);
    expect(board.expire(500 + LASER_FADE_MS - 1)).toBe(false);
    const before = board.version;
    expect(board.expire(500 + LASER_FADE_MS)).toBe(true);
    expect(board.version).toBeGreaterThan(before);
    expect(board.size).toBe(1);
  });

  it("draws a stroke whose end never came as finished 3 s after its last point (a late joiner's sync)", () => {
    // Ana's add and end reach this guest before the host's sync does: no begin seen, both refused.
    const guest = new InkBoard();
    expect(guest.apply({ op: "add", id: "g_ana:1", pts: [0.3, 0.3] }, ana, 100)).toBe(false);
    expect(guest.apply({ op: "end", id: "g_ana:1" }, ana, 110)).toBe(false);
    // The sync was taken while she was mid-stroke.
    guest.load([{ id: "g_ana:1", tool: "pen", color: "#E54D2E", size: 0.003, pts: [0.1, 0.1, 0.2, 0.2], done: false }], 200, 50);
    const [stroke] = guest.visible(200);
    expect(stroke).toMatchObject({ done: false });
    expect(strokeSettled(stroke!, 200)).toBe(false);
    expect(guest.nextChange(200)).toBe(200 + STROKE_IDLE_MS);
    expect(strokeSettled(stroke!, 200 + STROKE_IDLE_MS)).toBe(true);
    expect(guest.nextChange(200 + STROKE_IDLE_MS)).toBeNull();
    // Its owner, back to it after a pause, still draws on.
    expect(guest.apply({ op: "add", id: "g_ana:1", pts: [0.4, 0.4] }, ana, 5000)).toBe(true);
    expect(strokeSettled(guest.visible(5000)[0]!, 5000)).toBe(false);
    // A laser never settles: it fades.
    expect(strokeSettled({ tool: "laser", done: true, lastAt: 0 }, 10_000)).toBe(false);
  });

  it("lets nothing new of a guest's land while guests may not draw; their own clearing still does", () => {
    for (const op of [begin("g_ana:1"), { op: "add", id: "g_ana:1", pts: [0.5, 0.5] }] as LiveInkOp[]) {
      expect(inkAllowed(op, "guest", false)).toBe(false);
      expect(inkAllowed(op, "guest", true)).toBe(true);
      expect(inkAllowed(op, "host", false)).toBe(true);
    }
    for (const op of [{ op: "end", id: "g_ana:1" }, { op: "erase", id: "g_ana:1" }, { op: "clear", scope: "mine" }] as LiveInkOp[]) expect(inkAllowed(op, "guest", false)).toBe(true);
  });

  it("syncs pens and highlighters, not lasers, and a loaded board keeps ownership", () => {
    const board = new InkBoard();
    board.apply(begin("g_ana:1", "pen"), ana, 0);
    board.apply(begin("g_ana:2", "laser"), ana, 0);
    board.apply(begin("host:1", "highlighter"), host, 0);
    const snapshot = board.snapshot();
    expect(snapshot.map((s) => s.id)).toEqual(["g_ana:1", "host:1"]);
    // The snapshot passes the sync schema as is.
    const sync = decodeMessage("lv.sync", encodeMessage("lv.sync", { desk: null, strokes: snapshot, chat: [], grants: [] }), "host");
    const guest = new InkBoard();
    guest.load(sync!.strokes, 100);
    // A stroke still open at the sync takes its owner's next points.
    expect(guest.apply({ op: "add", id: "g_ana:1", pts: [0.9, 0.9] }, ana, 101)).toBe(true);
    expect(guest.apply({ op: "add", id: "host:1", pts: [0.9, 0.9] }, ana, 101)).toBe(false);
  });

  it("takes a sync without losing strokes that came after the host's snapshot, or keeping ones a missed clear removed", () => {
    const guest = new InkBoard();
    // Drawn before this guest went away; the host cleared it meanwhile.
    guest.apply(begin("g_bo:1"), bo, 100);
    // The guest asks for the sync at 1000; Ana's strokes reach it before the sync does.
    guest.apply(begin("g_ana:1"), ana, 1005);
    guest.apply({ op: "add", id: "g_ana:1", pts: [0.2, 0.2, 0.3, 0.3] }, ana, 1010);
    guest.apply(begin("g_ana:2"), ana, 1012);
    // The host's snapshot held g_ana:1 with its first point only, and not g_ana:2.
    const snapshot = [
      { id: "host:1", tool: "pen" as const, color: "#3E63DD", size: 0.003, pts: [0.5, 0.5], done: true },
      { id: "g_ana:1", tool: "pen" as const, color: "#E54D2E", size: 0.003, pts: [0.1, 0.1], done: false },
    ];
    guest.load(snapshot, 1020, 1000);
    const strokes = guest.visible(1020);
    expect(strokes.map((s) => s.id).sort()).toEqual(["g_ana:1", "g_ana:2", "host:1"]);
    expect(strokes.find((s) => s.id === "g_ana:1")?.pts).toEqual([0.1, 0.1, 0.2, 0.2, 0.3, 0.3]);
    // Without a time to go by, a sync replaces the board.
    guest.load(snapshot, 1030);
    expect(guest.visible(1030).map((s) => s.id)).toEqual(["host:1", "g_ana:1"]);
  });

  describe("a sync whose snapshot is older than what the board heard since asking", () => {
    const synced = (id: string, pts: number[] = [0.5, 0.5], done = true) => ({ id, tool: "pen" as const, color: "#3E63DD", size: 0.003, pts, done });
    const ids = (board: InkBoard, now: number) => board.visible(now).map((stroke) => stroke.id);

    it("does not bring back a stroke its owner erased or cleared, though the board never held it", () => {
      // A guest just come asks at 1000; the host's snapshot holds all of these, and is on its way for a while.
      const guest = new InkBoard();
      guest.apply({ op: "erase", id: "g_ana:1" }, ana, 1005);
      guest.apply({ op: "clear", scope: "mine" }, bo, 1006);
      // Bo draws again after clearing: that stroke is new, and stays.
      guest.apply(begin("g_bo:3"), bo, 1007);
      // What nobody may delete deletes nothing: another's stroke, everything by a guest.
      guest.apply({ op: "erase", id: "host:1" }, ana, 1008);
      guest.apply({ op: "clear", scope: "all" }, ana, 1009);
      guest.load([synced("host:1"), synced("g_ana:1"), synced("g_ana:2"), synced("g_bo:1"), synced("g_bo:2")], 1020, 1000);
      expect(ids(guest, 1020)).toEqual(["host:1", "g_ana:2", "g_bo:3"]);
    });

    it("does not bring back what the host cleared, and keeps what was drawn after the clear", () => {
      const guest = new InkBoard();
      // A clear of their own before the ask is in the snapshot already: what Ana drew after it on the host stays.
      guest.apply({ op: "clear", scope: "mine" }, ana, 900);
      guest.apply(begin("g_bo:5"), bo, 1001);
      guest.apply({ op: "clear", scope: "all" }, host, 1005);
      guest.apply(begin("host:9"), host, 1008);
      guest.load([synced("host:1"), synced("g_ana:1"), synced("g_bo:5")], 1020, 1000);
      expect(ids(guest, 1020)).toEqual(["host:9"]);

      const back = new InkBoard();
      back.apply({ op: "clear", scope: "mine" }, ana, 900);
      back.load([synced("host:1"), synced("g_ana:1")], 1020, 1000);
      expect(ids(back, 1020)).toEqual(["host:1", "g_ana:1"]);
    });

    it("lets a second answer to the same ask bring back nothing deleted, nor take away points", () => {
      // The first hello's answer came slowly enough that the guest said hello again; both answers come, snapshots alike.
      const snapshot = [synced("host:1"), synced("g_bo:1"), synced("g_ana:1", [0.1, 0.1], false)];
      const guest = new InkBoard();
      guest.load(snapshot, 1020, 1000);
      guest.apply({ op: "add", id: "g_ana:1", pts: [0.2, 0.2] }, ana, 1025);
      guest.apply({ op: "erase", id: "host:1" }, host, 1030);
      guest.apply({ op: "clear", scope: "mine" }, bo, 1031);
      guest.load(snapshot, 1040, 1000);
      expect(guest.visible(1040).map((stroke) => [stroke.id, stroke.pts])).toEqual([["g_ana:1", [0.1, 0.1, 0.2, 0.2]]]);
    });

    it("lets the sync of a later ask take away what an answer to an earlier one brought back", () => {
      const guest = new InkBoard();
      guest.load([synced("host:1"), synced("g_bo:1")], 1020, 1000);
      guest.apply({ op: "erase", id: "host:1" }, host, 1500);
      guest.apply({ op: "clear", scope: "mine" }, bo, 1600);
      // The connection drops and comes back; the guest asks again at 2000, and the first ask's late answer comes first.
      guest.load([synced("host:1"), synced("g_bo:1")], 2010, 2000);
      // An erasure holds for good; a clear from before this ask is the snapshot's to know, and this one is old.
      expect(ids(guest, 2010)).toEqual(["g_bo:1"]);
      // This ask's own sync no longer holds it, and what a sync brought is no stroke drawn since.
      guest.load([], 2030, 2000);
      expect(ids(guest, 2030)).toEqual([]);
    });
  });

  it("finishes a leaver's open strokes and keeps them", () => {
    const board = new InkBoard();
    board.apply(begin("g_ana:1"), ana, 0);
    const before = board.version;
    board.release("g_ana", 5);
    expect(board.version).toBeGreaterThan(before);
    expect(board.visible(5)).toMatchObject([{ id: "g_ana:1", done: true }]);
  });
});

describe("strokeOutline", () => {
  it("draws a closed path at the stage's size, wider for a highlighter", () => {
    const stroke = { tool: "pen" as const, size: 0.004, pts: [0.1, 0.1, 0.3, 0.2, 0.5, 0.4], done: true, lastAt: 0 };
    const pen = strokeOutline(stroke, { w: 1000, h: 600 }, 0);
    expect(pen.path).toMatch(/^M[\d.]+,[\d.]+ Q.* Z$/);
    expect(pen.opacity).toBe(1);
    const highlighter = strokeOutline({ ...stroke, tool: "highlighter", size: 0.012 }, { w: 1000, h: 600 }, 0);
    expect(highlighter.opacity).toBeLessThan(1);
    const xs = (path: string) => [...path.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[2]));
    const spread = (path: string) => Math.max(...xs(path)) - Math.min(...xs(path));
    expect(spread(highlighter.path)).toBeGreaterThan(spread(pen.path));
  });

  it("scales with the stage it is drawn on", () => {
    const stroke = { tool: "pen" as const, size: 0.004, pts: [0.1, 0.1, 0.5, 0.5], done: true, lastAt: 0 };
    const first = (path: string) => path.match(/^M([\d.]+),([\d.]+)/)!.slice(1).map(Number);
    const [bigX] = first(strokeOutline(stroke, { w: 2000, h: 1000 }, 0).path);
    const [smallX] = first(strokeOutline(stroke, { w: 1000, h: 500 }, 0).path);
    expect(bigX! / smallX!).toBeCloseTo(2, 1);
  });
});

describe("InkRecorder", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function recorder() {
    const ops: LiveInkOp[] = [];
    const rec = new InkRecorder({ identity: "g_ana", emit: (op) => ops.push(op), stageSize: () => ({ w: 1000, h: 1000 }), firstNumber: 7 });
    return { ops, rec };
  }

  it("begins at once, batches points, and ends", () => {
    const { ops, rec } = recorder();
    const id = rec.begin("pen", "#E54D2E", 0.003, { x: 0.1, y: 0.1 });
    expect(id).toBe("g_ana:7");
    expect(ops).toEqual([{ op: "begin", id, tool: "pen", color: "#E54D2E", size: 0.003, pts: [0.1, 0.1] }]);
    rec.move({ x: 0.11, y: 0.1 });
    rec.move({ x: 0.12, y: 0.1 });
    expect(ops).toHaveLength(1);
    vi.advanceTimersByTime(24);
    expect(ops[1]).toEqual({ op: "add", id, pts: [0.11, 0.1, 0.12, 0.1] });
    rec.move({ x: 0.13, y: 0.1 });
    rec.end();
    expect(ops.slice(2)).toEqual([{ op: "add", id, pts: [0.13, 0.1] }, { op: "end", id }]);
    expect(rec.current()).toBeNull();
    // The next stroke has the next number.
    expect(rec.begin("pen", "#E54D2E", 0.003, { x: 0, y: 0 })).toBe("g_ana:8");
  });

  it("sends at most 64 pairs a message, at once when they fill", () => {
    const { ops, rec } = recorder();
    const id = rec.begin("pen", "#E54D2E", 0.003, { x: 0, y: 0 });
    for (let n = 1; n <= 64; n += 1) rec.move({ x: n / 1000, y: 0 });
    expect(ops).toHaveLength(2);
    expect(ops[1]).toMatchObject({ op: "add", id });
    expect((ops[1] as { pts: number[] }).pts).toHaveLength(128);
    for (const op of ops) expect(decodeMessage("lv.ink", encodeMessage("lv.ink", op), "guest")).toEqual(op);
  });

  it("drops points closer than half a stage pixel, and keeps them all locally", () => {
    const { ops, rec } = recorder();
    rec.begin("pen", "#E54D2E", 0.003, { x: 0.5, y: 0.5 });
    rec.move({ x: 0.5002, y: 0.5 }); // 0.2 px
    rec.move({ x: 0.5004, y: 0.5 }); // 0.4 px
    rec.move({ x: 0.501, y: 0.5 }); // 1 px
    rec.end();
    expect(ops[1]).toEqual({ op: "add", id: "g_ana:7", pts: [0.501, 0.5] });
    expect(ops).toHaveLength(3);
  });

  it("clamps points to the stage", () => {
    const { ops, rec } = recorder();
    rec.begin("laser", "#E54D2E", 0.003, { x: -0.2, y: 1.4 });
    expect(ops[0]).toMatchObject({ pts: [0, 1] });
  });

  it("continues a full stroke as a new one from the same point", () => {
    const { ops, rec } = recorder();
    rec.begin("pen", "#E54D2E", 0.003, { x: 0, y: 0 });
    for (let n = 1; n <= MAX_STROKE_PAIRS; n += 1) rec.move({ x: (n % 2) * 0.01, y: n / 2000 });
    const begins = ops.filter((op) => op.op === "begin");
    expect(begins.map((op) => op.op === "begin" && op.id)).toEqual(["g_ana:7", "g_ana:8"]);
    expect(ops.some((op) => op.op === "end" && op.id === "g_ana:7")).toBe(true);
    const second = begins[1] as { pts: number[] };
    const board = new InkBoard();
    for (const op of ops) board.apply(op, { identity: "g_ana", role: "guest" }, 0);
    const first = board.visible(0)[0]!;
    expect(first.pts.length).toBe(MAX_STROKE_PAIRS * 2);
    expect(second.pts).toEqual(first.pts.slice(-2));
  });

  it("shows the stroke in progress with points not sent yet", () => {
    const { rec } = recorder();
    rec.begin("pen", "#E54D2E", 0.003, { x: 0.1, y: 0.1 });
    rec.move({ x: 0.2, y: 0.2 });
    expect(rec.current()).toMatchObject({ id: "g_ana:7", pts: [0.1, 0.1, 0.2, 0.2], done: false });
  });
});
