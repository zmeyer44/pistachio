/**
 * Notices kept until somebody is there to read them (main/held-notices.ts;
 * docs/primitives.md §2.6, §3.6): what an extension did at a locked or idle
 * Mac is not said into an empty room.
 */

import { describe, expect, it } from "vitest";
import { HELD_MAX, HeldNotices } from "../src/main/held-notices";

function held(options: { focused?: boolean; there?: boolean; max?: number } = {}) {
  const state = { focused: options.focused ?? true, there: options.there ?? true };
  const focusListeners: Array<() => void> = [];
  const timers: Array<() => void> = [];
  const said: string[] = [];
  const notices = new HeldNotices({
    focused: () => state.focused,
    onceFocused: (listener) => focusListeners.push(listener),
    someoneThere: () => state.there,
    timers: { setTimeout: (callback) => timers.push(callback) },
    ...(options.max === undefined ? {} : { max: options.max }),
  });
  return {
    notices,
    state,
    said,
    focusListeners,
    timers,
    say: (words: string) => () => said.push(words),
    /** The window says it came in front. */
    focus: () => {
      for (const listener of focusListeners.splice(0)) listener();
    },
    /** The poll comes round. */
    poll: () => {
      for (const callback of timers.splice(0)) callback();
    },
    /** The window closes: whatever waited on its coming in front is never told. */
    close: () => focusListeners.splice(0),
  };
}

describe("a notice kept for somebody", () => {
  it("is said at once when the window is in front and somebody is there", () => {
    const t = held();
    t.notices.hold("away:football", t.say("Football is away"));
    expect(t.said).toEqual(["Football is away"]);
    expect(t.notices.size).toBe(0);
  });

  it("waits for the window to come in front, and takes it at its word that it has", () => {
    const t = held({ focused: false });
    t.notices.hold("away:football", t.say("Football is away"));
    expect(t.said).toEqual([]);
    // (A spec on a locked Mac says so in the OS's place: asked again, the window would still say no.)
    t.focus();
    expect(t.said).toEqual(["Football is away"]);
  });

  it("waits, the window in front, until a key or the pointer is touched and the screen is not locked", () => {
    const t = held({ there: false });
    t.notices.hold("away:football", t.say("Football is away"));
    t.poll();
    t.poll();
    expect(t.said).toEqual([]);
    t.state.there = true;
    t.poll();
    expect(t.said).toEqual(["Football is away"]);
  });

  it("asks the window again after waiting: somebody back and gone straight to another app is not looking at this one", () => {
    const t = held({ there: false });
    t.notices.hold("away:football", t.say("Football is away"));
    t.state.there = true;
    t.state.focused = false;
    t.poll();
    expect(t.said).toEqual([]);
    t.state.focused = true;
    t.focus();
    expect(t.said).toEqual(["Football is away"]);
  });

  it("is dropped unsaid when it is no longer so by then", () => {
    const t = held({ there: false });
    let away = true;
    t.notices.hold("away:football", t.say("Football is away"), () => away);
    // (Sent away at a locked screen, brought back as it unlocked.)
    away = false;
    t.notices.hold("back:football", t.say("Football is back"));
    t.state.there = true;
    t.poll();
    expect(t.said).toEqual(["Football is back"]);
  });

  it("says one thing of one space: its latest coming or going takes the place of one still waiting", () => {
    const t = held({ there: false });
    t.notices.hold("away:football", t.say("Football is away"));
    t.notices.hold("away:football", t.say("Football is back"));
    t.notices.hold("away:football", t.say("Football is away again"));
    t.state.there = true;
    t.poll();
    expect(t.said).toEqual(["Football is away again"]);
  });

  it("keeps the newest few, with one look for all of them: a weekend's work is not a burst on Monday", () => {
    const t = held({ there: false });
    for (let index = 0; index < 40; index += 1) t.notices.hold(`closed:${String(index)}`, t.say(`Closed ${String(index)}`));
    expect(t.notices.size).toBe(HELD_MAX);
    // One poller, however many were held.
    expect(t.timers).toHaveLength(1);
    t.state.there = true;
    t.poll();
    expect(t.said).toEqual(["Closed 37", "Closed 38", "Closed 39"]);
    expect(t.timers).toHaveLength(0);
  });

  it("waits on the window once, however many are held behind it", () => {
    const t = held({ focused: false });
    t.notices.hold("a", t.say("a"));
    t.notices.hold("b", t.say("b"));
    expect(t.focusListeners).toHaveLength(1);
    t.focus();
    expect(t.said).toEqual(["a", "b"]);
  });

  it("goes on to the next when one cannot be said", () => {
    const t = held();
    t.state.there = false;
    t.notices.hold("a", () => {
      throw new Error("the window went");
    });
    t.notices.hold("b", t.say("b"));
    t.state.there = true;
    t.poll();
    expect(t.said).toEqual(["b"]);
  });

  it("follows the window: one that closed before it came in front hands what it held to the next", () => {
    const t = held({ focused: false });
    t.notices.hold("away:football", t.say("Football is away"));
    // The window closes, never having come in front; nothing was said, and nothing is lost.
    const [stale] = t.close();
    expect(t.notices.size).toBe(1);
    // A new window is up, behind another app: the wait is its own now, and later notices are heard too.
    t.notices.windowChanged();
    expect(t.focusListeners).toHaveLength(1);
    t.notices.hold("closed:recipes", t.say("Recipes was closed"));
    expect(t.focusListeners).toHaveLength(1);
    expect(t.said).toEqual([]);
    t.focus();
    expect(t.said).toEqual(["Football is away", "Recipes was closed"]);
    // (The old window's word, were it ever to come, says nothing twice and starts no second wait.)
    t.state.focused = false;
    t.notices.hold("away:trip", t.say("Trip is away"));
    stale?.();
    expect(t.said).toEqual(["Football is away", "Recipes was closed"]);
    expect(t.focusListeners).toHaveLength(1);
    t.focus();
    expect(t.said).toEqual(["Football is away", "Recipes was closed", "Trip is away"]);
  });

  it("says what waited at once when the new window is already in front", () => {
    const t = held({ focused: false });
    t.notices.hold("away:football", t.say("Football is away"));
    t.close();
    t.state.focused = true;
    t.notices.windowChanged();
    expect(t.said).toEqual(["Football is away"]);
  });
});
