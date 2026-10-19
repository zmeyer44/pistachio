/**
 * The live share's room window's bridge (docs/live-share.md §10): its preload
 * exposes the room's members and the appearance alone, and the renderer makes
 * that whole for the pieces it mounts — LiveHostApp finds the native surface
 * and its five members are the preload's, the theme finds its appearance,
 * and every other native member refuses.
 */

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "@pistachio/shell-contracts/appearance";
import type { LiveHostApi } from "@pistachio/shell-contracts/live-share";
import { nativeApi, setShellApi, shellApi } from "@pistachio/shell-ui/api.js";
import { liveHostBridge } from "../src/renderer/src/live-host-bridge";

describe("liveHostBridge", () => {
  it("is a whole native surface whose room members are the preload's, with the appearance as its settings and nothing else", async () => {
    const api: LiveHostApi = {
      liveHostConfig: vi.fn(async () => null),
      onLiveHostEvent: vi.fn(() => () => undefined),
      sendLiveHostReport: vi.fn(),
      liveHostSource: vi.fn(async () => "source"),
      liveHostShellSource: vi.fn(async () => "shell-source"),
      liveHostAppearance: vi.fn(async () => ({ ...DEFAULT_APPEARANCE, scheme: "dark" as const })),
    };
    setShellApi(liveHostBridge(api));
    const native = nativeApi();
    expect(native).not.toBeNull();
    expect(await native!.liveHostSource("t1")).toBe("source");
    expect(await native!.liveHostShellSource()).toBe("shell-source");
    native!.sendLiveHostReport({ type: "openCard" });
    expect(api.sendLiveHostReport).toHaveBeenCalledWith({ type: "openCard" });
    expect(() => native!.setLiveDesk(null)).toThrow("setLiveDesk is not the live-host window's");
    expect(() => native!.liveShare({ type: "stop" })).toThrow();
    expect((await shellApi().getSettings()).appearance.scheme).toBe("dark");
    expect(typeof shellApi().onSettings(() => undefined)).toBe("function");
    // Main answering nothing (not its window): the default appearance.
    vi.mocked(api.liveHostAppearance).mockResolvedValueOnce(null);
    expect((await shellApi().getSettings()).appearance).toEqual(DEFAULT_APPEARANCE);
  });
});
