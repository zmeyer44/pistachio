import { describe, expect, it } from "vitest";
import { BAKED_CURSOR_LOCKED_MODES, CURSOR_LOCK_NOTE, cursorModeAvailable, cursorSpecAllowed, hideIdleAvailable } from "../src/lib/cursor-modes.js";

describe("the cursor settings a baked cursor locks", () => {
  it("lock Smooth, Glide and Hidden, and Hide when idle, while the system cursor is in the pixels; nothing otherwise", () => {
    expect(BAKED_CURSOR_LOCKED_MODES).toEqual(["smooth", "glide", "hidden"]);
    for (const mode of ["natural", "smooth", "glide", "hidden"] as const) expect(cursorModeAvailable(mode, false), mode).toBe(true);
    expect(cursorModeAvailable("natural", true)).toBe(true);
    expect(cursorModeAvailable("smooth", true)).toBe(false);
    expect(cursorModeAvailable("glide", true)).toBe(false);
    // Hidden only hides the drawn cursor: the recorded one would stay in every frame.
    expect(cursorModeAvailable("hidden", true)).toBe(false);
    expect(hideIdleAvailable(false)).toBe(true);
    expect(hideIdleAvailable(true)).toBe(false);
    expect(CURSOR_LOCK_NOTE).toMatch(/Hidden and Hide when idle/);
  });

  it("brings a project's cursor within the lock: a locked mode falls back to Natural, Hide when idle goes off; nothing changes unlocked", () => {
    const hidden = { mode: "hidden" as const, size: 2, smoothing: 0.5, hideIdle: true, click: "ripple" as const };
    expect(cursorSpecAllowed(hidden, true)).toEqual({ ...hidden, mode: "natural", hideIdle: false });
    expect(cursorSpecAllowed({ ...hidden, mode: "glide" }, true)).toEqual({ ...hidden, mode: "natural", hideIdle: false });
    expect(cursorSpecAllowed({ ...hidden, mode: "natural" }, true)).toEqual({ ...hidden, mode: "natural", hideIdle: false });
    expect(cursorSpecAllowed(hidden, false)).toBe(hidden);
  });
});
