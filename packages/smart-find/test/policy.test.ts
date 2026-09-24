import { describe, expect, it } from "vitest";
import type { SmartFindMatch, SmartFindPassage } from "../src/contract.js";
import { orderMatches, selectMatches } from "../src/policy.js";

const passage = (id: string, block = id): SmartFindPassage => ({ id, block, text: `text of ${id}` });
const PAGE = [passage("b0"), passage("b1"), passage("b2p0", "b2"), passage("b2p1", "b2"), passage("b2p2", "b2"), passage("b3")];
const scores = (entries: Record<string, number>): Map<string, number> => new Map(Object.entries(entries));
const match = (id: string, probability: number): SmartFindMatch => ({ ids: [id], probability });

describe("selectMatches", () => {
  it("lists confident matches best first, the page's order settling a tie", () => {
    const { matches, weak } = selectMatches(PAGE, scores({ b0: 0.6, b1: 0.9, b3: 0.6, "b2p0": 0.1 }), true);
    expect(matches.map((m) => m.ids)).toEqual([["b1"], ["b0"], ["b3"]]);
    expect(weak).toBe(false);
  });

  it("merges adjacent parts of one split block into one match, and keeps separated parts apart", () => {
    const merged = selectMatches(PAGE, scores({ b2p0: 0.7, b2p1: 0.95 }), true).matches;
    expect(merged).toEqual([{ ids: ["b2p0", "b2p1"], probability: 0.95 }]);
    const apart = selectMatches(PAGE, scores({ b2p0: 0.7, b2p1: 0.1, b2p2: 0.8 }), true).matches;
    expect(apart.map((m) => m.ids)).toEqual([["b2p2"], ["b2p0"]]);
  });

  it("never merges across blocks", () => {
    expect(selectMatches(PAGE, scores({ b0: 0.9, b1: 0.9 }), true).matches).toHaveLength(2);
  });

  it("offers the closest passages, marked weak, only once every batch has reported", () => {
    const vague = scores({ b0: 0.45, b1: 0.3, b3: 0.26, b2p0: 0.27, b2p2: 0.1 });
    expect(selectMatches(PAGE, vague, false)).toEqual({ matches: [], weak: false });
    const final = selectMatches(PAGE, vague, true);
    expect(final.weak).toBe(true);
    expect(final.matches.map((m) => m.ids[0])).toEqual(["b0", "b1", "b2p0"]);
  });

  it("says nothing matched when nothing comes close", () => {
    expect(selectMatches(PAGE, scores({ b0: 0.01, b1: 0.2 }), true)).toEqual({ matches: [], weak: false });
  });

  it("caps the list", () => {
    const many = Array.from({ length: 40 }, (_, i) => passage(`b${i}`));
    const all = new Map(many.map((p, i) => [p.id, 0.5 + i / 100]));
    expect(selectMatches(many, all, true).matches).toHaveLength(20);
  });
});

describe("orderMatches", () => {
  it("follows the fresh ranking until the person steps", () => {
    const next = orderMatches([match("b0", 0.6)], 0, false, [match("b3", 0.9), match("b0", 0.6)]);
    expect(next).toEqual({ matches: [match("b3", 0.9), match("b0", 0.6)], active: 0 });
    expect(orderMatches([], -1, false, [])).toEqual({ matches: [], active: -1 });
  });

  it("moves nothing at or before the active match once they have stepped; arrivals queue behind it", () => {
    const shown = [match("b0", 0.6), match("b1", 0.55), match("b3", 0.5)];
    const fresh = [match("b2p0", 0.97), match("b0", 0.6), match("b1", 0.55), match("b3", 0.5)];
    const next = orderMatches(shown, 1, true, fresh);
    expect(next.active).toBe(1);
    expect(next.matches.map((m) => m.ids[0])).toEqual(["b0", "b1", "b2p0", "b3"]);
  });

  it("takes a kept match's newer form — a part that joined it — without moving it", () => {
    const next = orderMatches([match("b2p0", 0.7)], 0, true, [{ ids: ["b2p0", "b2p1"], probability: 0.9 }]);
    expect(next.matches).toEqual([{ ids: ["b2p0", "b2p1"], probability: 0.9 }]);
  });
});
