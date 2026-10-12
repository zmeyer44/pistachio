import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserMediaInfo, MediaControl } from "@pistachio/shell-contracts/media";

// A component's hooks by hand: each render reads the same slots in the same order.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], next: 0 }));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const slot = hooks.next++;
    if (!(slot in hooks.slots)) hooks.slots[slot] = initial;
    return [hooks.slots[slot], (value: unknown) => (hooks.slots[slot] = value)];
  },
  useRef: (initial: unknown) => {
    const slot = hooks.next++;
    if (!(slot in hooks.slots)) hooks.slots[slot] = { current: initial };
    return hooks.slots[slot];
  },
  useCallback: (fn: unknown) => fn,
}));
const { useMediaVolume } = await import("../src/lib/media-volume");

let sent: MediaControl[] = [];
function render(media: Pick<BrowserMediaInfo, "volume" | "muted">) {
  hooks.next = 0;
  return useMediaVolume(media, (control) => sent.push(control));
}

describe("a player's own volume", () => {
  beforeEach(() => {
    hooks.slots = [];
    sent = [];
  });

  it("dragged all the way down, mutes the player at where the slider was taken from", () => {
    render({ volume: 0.3, muted: false }).take();
    render({ volume: 0.3, muted: false }).set(0.2);
    render({ volume: 0.2, muted: false }).set(0);
    expect(sent.at(-1)).toEqual({ type: "setVolume", volume: 0, restore: 0.3 });
  });

  it("let go, then moved by the keyboard all the way down, mutes it at where it was let go", () => {
    // The slider keeps focus after the pointer lets go: the keyboard's move takes it up anew.
    render({ volume: 1, muted: false }).take();
    render({ volume: 1, muted: false }).set(0.4);
    render({ volume: 0.4, muted: false }).release();
    render({ volume: 0.4, muted: false }).set(0);
    expect(sent.at(-1)).toEqual({ type: "setVolume", volume: 0, restore: 0.4 });
  });

  it("unmuted, is heard at the player's own level, or full from a silence the page set itself", () => {
    render({ volume: 0.4, muted: true }).toggleMute();
    render({ volume: 0, muted: true }).toggleMute();
    render({ volume: 0.5, muted: false }).toggleMute();
    expect(sent).toEqual([{ type: "setVolume", volume: 0.4 }, { type: "setVolume", volume: 1 }, { type: "mute" }]);
  });

  it("shows its draft while held, else what is heard", () => {
    expect(render({ volume: 0.4, muted: true }).volume).toBe(0);
    render({ volume: 0.4, muted: false }).set(0.7);
    expect(render({ volume: 0.4, muted: false })).toMatchObject({ volume: 0.7, held: true });
  });
});
