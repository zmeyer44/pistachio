/**
 * ⌘N (lib/desk/open.ts `newSpaceByKey`): what is open over the window steps
 * aside for the new space and its name field — the address bar, a popover, a
 * page over the desk — while a dialog asking something, or a menu, keeps the
 * keyboard and no space is made.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { NEW_SPACE_EVENT, newSpaceByKey } from "../src/lib/desk/open";
import { useAppStore } from "../src/store";

function bridge(pistachio: Record<string, unknown>): void {
  setShellApi(pistachio as unknown as ShellApiBridge);
}

afterEach(() => {
  vi.unstubAllGlobals();
  bridge({});
  useAppStore.setState({ overlay: "none", urlBarTabId: null, urlBarNew: false, remindersFocus: null, error: null });
});

describe("newSpaceByKey", () => {
  it.each(["none", "url", "downloads", "site-info", "settings", "reminders", "library"] as const)("sweeps the %s overlay away and makes the space", async (overlay) => {
    // The sidebar hears of the space it made, to open its name field (TabList).
    const shell = new EventTarget();
    vi.stubGlobal("window", shell);
    const named = new Promise<string>((heard) => shell.addEventListener(NEW_SPACE_EVENT, (event) => heard((event as CustomEvent<string>).detail)));
    const tabGroupCommand = vi.fn(() => Promise.resolve());
    bridge({ tabGroupCommand });
    useAppStore.setState({ overlay, urlBarNew: overlay === "url" ? "space" : false, remindersFocus: "occ-1" });
    expect(newSpaceByKey()).toBe(true);
    const state = useAppStore.getState();
    expect(state.overlay).toBe("none");
    expect(state.urlBarNew).toBe(false);
    expect(tabGroupCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "create", tabIds: [], select: true }));
    expect(await named).toBe((tabGroupCommand.mock.calls[0] as unknown as [{ id: string }])[0].id);
  });

  // A context menu up holds the keyboard, as a Mac's does: its owner's state is its own, and only it may close it.
  it.each(["permission", "space-fork", "update", "context-menu"] as const)("leaves the %s up, and makes nothing", (overlay) => {
    const tabGroupCommand = vi.fn(() => Promise.resolve());
    bridge({ tabGroupCommand });
    useAppStore.setState({ overlay });
    expect(newSpaceByKey()).toBe(false);
    expect(useAppStore.getState().overlay).toBe(overlay);
    expect(tabGroupCommand).not.toHaveBeenCalled();
  });
});
