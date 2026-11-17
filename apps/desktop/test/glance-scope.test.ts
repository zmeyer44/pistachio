import { describe, expect, it } from "vitest";
import { freshenStills, glanceMoves, type ScopedGlance } from "../src/main/glance-scope";

const glance = (ownerTabId: string, dismissed = false): ScopedGlance => ({ ownerTabId, dismissed });
const none = new Map<string, ScopedGlance>();

describe("glanceMoves", () => {
  it("moves nothing with no Glance at all", () => {
    expect(glanceMoves(null, none, "a")).toEqual({ hide: null, close: null, show: null });
    expect(glanceMoves(null, none, null)).toEqual({ hide: null, close: null, show: null });
  });

  it("leaves a Glance up while its own tab is in use", () => {
    const up = glance("a");
    expect(glanceMoves(up, none, "a")).toEqual({ hide: null, close: null, show: null });
  });

  it("takes a Glance down, to keep, when another tab comes into use", () => {
    const up = glance("a");
    expect(glanceMoves(up, none, "b")).toEqual({ hide: up, close: null, show: null });
  });

  it("takes a Glance down when no tab is in use (an empty space in front)", () => {
    const up = glance("a");
    expect(glanceMoves(up, none, null)).toEqual({ hide: up, close: null, show: null });
  });

  it("closes, not keeps, a Glance that was being dismissed as its tab was left", () => {
    const up = glance("a", true);
    expect(glanceMoves(up, none, "b")).toEqual({ hide: null, close: up, show: null });
    expect(glanceMoves(up, none, null)).toEqual({ hide: null, close: up, show: null });
  });

  it("leaves a Glance being dismissed up while its own tab stays in use, to finish closing", () => {
    const up = glance("a", true);
    expect(glanceMoves(up, none, "a")).toEqual({ hide: null, close: null, show: null });
  });

  it("brings a tab's Glance back as that tab comes into use", () => {
    const down = new Map([["a", glance("a")]]);
    expect(glanceMoves(null, down, "a")).toEqual({ hide: null, close: null, show: down.get("a") });
  });

  it("swaps one tab's Glance for the other's, each kept for its own tab", () => {
    const upB = glance("b");
    const down = new Map([["a", glance("a")]]);
    expect(glanceMoves(upB, down, "a")).toEqual({ hide: upB, close: null, show: down.get("a") });
  });

  it("never brings back another tab's Glance", () => {
    const down = new Map([["a", glance("a")]]);
    expect(glanceMoves(null, down, "b")).toEqual({ hide: null, close: null, show: null });
    expect(glanceMoves(null, down, null)).toEqual({ hide: null, close: null, show: null });
  });

  it("keeps the Glance up when its tab stays in use, whatever is down", () => {
    const up = glance("a");
    const down = new Map([["b", glance("b")]]);
    expect(glanceMoves(up, down, "a")).toEqual({ hide: null, close: null, show: null });
  });
});

describe("freshenStills", () => {
  const still = (tabId: string, dataUrl: string) => ({ tabId, dataUrl });

  it("takes the pictures just taken over the ones it had", () => {
    expect(freshenStills([still("a", "old a"), still("b", "old b")], [still("a", "new a"), still("b", "new b")])).toEqual([still("a", "new a"), still("b", "new b")]);
  });

  it("keeps the picture it had of a page none could be taken of now", () => {
    expect(freshenStills([still("a", "old a"), still("b", "old b")], [still("b", "new b")])).toEqual([still("b", "new b"), still("a", "old a")]);
  });

  it("never stands over nothing when it had a backdrop: none taken, it keeps what it had", () => {
    expect(freshenStills([still("a", "old a")], [])).toEqual([still("a", "old a")]);
  });

  it("adds a page it had no picture of", () => {
    expect(freshenStills([], [still("c", "new c")])).toEqual([still("c", "new c")]);
  });
});
