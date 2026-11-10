import { describe, expect, it, vi } from "vitest";
import { Follow, FOLLOW_RETRY_MS, FOLLOW_TRIES, type FollowHooks, type FollowTarget } from "../src/engine/follow.js";

interface Feed {
  tab: FollowTarget;
  closed: boolean;
}

const target = (id: string): FollowTarget => ({ id, title: `Tab ${id}`, url: `https://${id}.example/` });

/** A promise settled from outside. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Hooks whose `open` answers from a script: each call takes the next deferred for that tab (or opens at once). */
function rig(options: { slow?: boolean } = {}) {
  const opens: { target: FollowTarget; answer: ReturnType<typeof deferred<Feed>> }[] = [];
  const closed: string[] = [];
  const switched: [string, string | null][] = [];
  const failed: [string, string][] = [];
  const sleeps: number[] = [];
  const hooks: FollowHooks<Feed> = {
    open: (wanted) => {
      if (options.slow !== true) return Promise.resolve({ tab: wanted, closed: false });
      const answer = deferred<Feed>();
      opens.push({ target: wanted, answer });
      return answer.promise;
    },
    close: (feed) => {
      feed.closed = true;
      closed.push(feed.tab.id);
    },
    switched: (feed, previous) => switched.push([feed.tab.id, previous?.tab.id ?? null]),
    failed: (wanted, error) => failed.push([wanted.id, error instanceof Error ? error.message : String(error)]),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { hooks, opens, closed, switched, failed, sleeps, follow: new Follow<Feed>(hooks) };
}

describe("the follow: the tab in front is the one recorded", () => {
  it("adopts the first feed, and opens the next tab wanted before closing the current one", async () => {
    const r = rig({ slow: true });
    const first: Feed = { tab: target("a"), closed: false };
    r.follow.adopt(first);
    expect(r.follow.current).toBe(first);
    expect(r.follow.wanted).toEqual(target("a"));
    r.follow.want(target("b"));
    await settle();
    expect(r.opens.map((open) => open.target.id)).toEqual(["b"]);
    // (A is still the feed, and still open, while B comes up: the picture never goes black.)
    expect(r.follow.current).toBe(first);
    expect(r.closed).toEqual([]);
    r.opens[0]!.answer.resolve({ tab: target("b"), closed: false });
    await settle();
    expect(r.follow.current?.tab.id).toBe("b");
    expect(r.closed).toEqual(["a"]);
    expect(r.switched).toEqual([["b", "a"]]);
  });

  it("wanting the current tab, or none, changes nothing", async () => {
    const r = rig();
    const first: Feed = { tab: target("a"), closed: false };
    r.follow.adopt(first);
    r.follow.want(target("a"));
    r.follow.want(null);
    await settle();
    expect(r.follow.current).toBe(first);
    expect(r.closed).toEqual([]);
    expect(r.switched).toEqual([]);
  });

  it("goes on to the latest tab wanted while a switch is under way, one switch at a time", async () => {
    const r = rig({ slow: true });
    r.follow.adopt({ tab: target("a"), closed: false });
    r.follow.want(target("b"));
    await settle();
    r.follow.want(target("c"));
    await settle();
    // (B is still opening: C waits its turn.)
    expect(r.opens.map((open) => open.target.id)).toEqual(["b"]);
    r.opens[0]!.answer.resolve({ tab: target("b"), closed: false });
    await settle();
    expect(r.opens.map((open) => open.target.id)).toEqual(["b", "c"]);
    expect(r.follow.current?.tab.id).toBe("b");
    r.opens[1]!.answer.resolve({ tab: target("c"), closed: false });
    await settle();
    expect(r.follow.current?.tab.id).toBe("c");
    expect(r.closed).toEqual(["a", "b"]);
    expect(r.switched).toEqual([
      ["b", "a"],
      ["c", "b"],
    ]);
  });

  it("tries a tab that will not open a few times, then says so and stays where it is", async () => {
    const r = rig({ slow: true });
    r.follow.adopt({ tab: target("a"), closed: false });
    r.follow.want(target("b"));
    for (let attempt = 0; attempt < FOLLOW_TRIES; attempt += 1) {
      await settle();
      expect(r.opens).toHaveLength(attempt + 1);
      r.opens[attempt]!.answer.reject(new Error("the capture of this tab is ending"));
      await settle();
    }
    await settle();
    expect(r.opens).toHaveLength(FOLLOW_TRIES);
    expect(r.sleeps).toEqual(Array.from({ length: FOLLOW_TRIES - 1 }, () => FOLLOW_RETRY_MS));
    expect(r.failed).toEqual([["b", "the capture of this tab is ending"]]);
    expect(r.follow.current?.tab.id).toBe("a");
    expect(r.follow.wanted).toBeNull();
    expect(r.closed).toEqual([]);
  });

  it("opens the current tab again when its feed is lost while it is still wanted — and not when another is", async () => {
    const r = rig({ slow: true });
    const first: Feed = { tab: target("a"), closed: false };
    r.follow.adopt(first);
    r.follow.lost(first);
    expect(r.follow.current).toBeNull();
    expect(r.closed).toEqual(["a"]);
    await settle();
    expect(r.opens.map((open) => open.target.id)).toEqual(["a"]);
    const again: Feed = { tab: target("a"), closed: false };
    r.opens[0]!.answer.resolve(again);
    await settle();
    expect(r.follow.current).toBe(again);
    expect(r.switched).toEqual([["a", null]]);
    // A feed that is not the current one (an old one ending late) is nothing to act on.
    r.follow.lost(first);
    await settle();
    expect(r.opens).toHaveLength(1);
    expect(r.follow.current).toBe(again);
  });

  it("stopped: the current feed is closed, and one that opens late is closed too, never switched to", async () => {
    const r = rig({ slow: true });
    const first: Feed = { tab: target("a"), closed: false };
    r.follow.adopt(first);
    r.follow.want(target("b"));
    await settle();
    r.follow.stop();
    expect(r.closed).toEqual(["a"]);
    expect(r.follow.current).toBeNull();
    const late: Feed = { tab: target("b"), closed: false };
    r.opens[0]!.answer.resolve(late);
    await settle();
    expect(late.closed).toBe(true);
    expect(r.switched).toEqual([]);
    // Nothing moves it afterwards.
    r.follow.want(target("c"));
    await settle();
    expect(r.opens).toHaveLength(1);
    const close = vi.fn();
    void close;
  });
});
