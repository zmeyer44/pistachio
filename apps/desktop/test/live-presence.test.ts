/**
 * The host at the shared desk as far as the window goes (docs/live-share.md
 * §6.1, §10): the window up, the app not hidden, the Mac neither locked nor
 * asleep — and each change a moment to look again, the app's comings and
 * goings once more a moment later (⌘H hides the app with no `hide` on the
 * window, in Electron 43).
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRESENCE_SETTLE_MS, watchLivePresence } from "../src/main/live/live-presence";

function setup() {
  const window = Object.assign(new EventEmitter(), { visible: true, minimized: false, destroyed: false });
  const sources = {
    window: Object.assign(window, { isDestroyed: () => window.destroyed, isVisible: () => window.visible, isMinimized: () => window.minimized }),
    power: new EventEmitter(),
    app: new EventEmitter(),
  };
  const changed = vi.fn();
  const presence = watchLivePresence(sources, changed);
  return { ...sources, changed, presence };
}

describe("watchLivePresence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is away while the screen is locked or the Mac asleep, and back only when both are over", () => {
    const { power, presence, changed } = setup();
    expect(presence.shown()).toBe(true);
    power.emit("lock-screen");
    expect(presence.shown()).toBe(false);
    power.emit("suspend");
    // Woken, the Mac is still locked.
    power.emit("resume");
    expect(presence.shown()).toBe(false);
    power.emit("unlock-screen");
    expect(presence.shown()).toBe(true);
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it("follows the window put away and back, and looks again a moment after the app hides or comes back", () => {
    const { window, app, presence, changed } = setup();
    window.minimized = true;
    window.emit("minimize");
    expect(presence.shown()).toBe(false);
    window.minimized = false;
    window.emit("restore");
    expect(presence.shown()).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
    // ⌘H: the app resigns active, its windows ordered out a moment after — no event says so.
    app.emit("did-resign-active");
    expect(changed).toHaveBeenCalledTimes(3);
    window.visible = false;
    vi.advanceTimersByTime(PRESENCE_SETTLE_MS);
    expect(changed).toHaveBeenCalledTimes(4);
    expect(presence.shown()).toBe(false);
    window.visible = true;
    app.emit("did-become-active");
    expect(presence.shown()).toBe(true);
  });

  it("hears nothing once disposed", () => {
    const { power, app, window, presence, changed } = setup();
    app.emit("did-become-active");
    presence.dispose();
    power.emit("lock-screen");
    window.emit("hide");
    vi.advanceTimersByTime(PRESENCE_SETTLE_MS);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(power.listenerCount("lock-screen") + app.listenerCount("did-resign-active") + window.listenerCount("hide")).toBe(0);
  });
});
