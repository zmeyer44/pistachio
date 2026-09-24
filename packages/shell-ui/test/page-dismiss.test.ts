/**
 * A full-window page (settings, reminders, bookmarks) over the content hole
 * steps aside when the user picks a tab or opens one (src/store.ts
 * `closePage`): a tab press is a request to see that tab, and the page's own
 * close button must not be the only way out.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { useAppStore } from "../src/store";

function bridge(pistachio: Record<string, unknown>): void {
  setShellApi(pistachio as unknown as ShellApiBridge);
}

afterEach(() => {
  bridge({});
  useAppStore.setState({ overlay: "none", remindersFocus: null, bookmarksFocus: null, error: null });
});

describe("closePage", () => {
  it.each(["settings", "reminders", "bookmarks"] as const)("dismisses the %s page", (overlay) => {
    useAppStore.setState({ overlay, remindersFocus: "occ-1", bookmarksFocus: "bm-1" });
    useAppStore.getState().closePage();
    const state = useAppStore.getState();
    expect(state.overlay).toBe("none");
    expect(state.remindersFocus).toBeNull();
    expect(state.bookmarksFocus).toBeNull();
  });

  it.each(["none", "url", "downloads", "site-info"] as const)("leaves the %s overlay alone", (overlay) => {
    useAppStore.setState({ overlay, urlBarNew: true });
    useAppStore.getState().closePage();
    expect(useAppStore.getState().overlay).toBe(overlay);
  });
});

describe("selecting or opening a tab", () => {
  it("dismisses the settings page before asking the host to select the tab", async () => {
    const selectTab = vi.fn(() => Promise.resolve());
    bridge({ selectTab });
    useAppStore.setState({ overlay: "settings" });
    await useAppStore.getState().selectTab("tab-1");
    expect(useAppStore.getState().overlay).toBe("none");
    expect(selectTab).toHaveBeenCalledWith("tab-1");
  });

  it("dismisses the page even when re-selecting the active tab is a no-op for the host", async () => {
    bridge({ selectTab: () => Promise.resolve() });
    useAppStore.setState({ overlay: "reminders", remindersFocus: "occ-1" });
    await useAppStore.getState().selectTab("active-tab");
    expect(useAppStore.getState().overlay).toBe("none");
    expect(useAppStore.getState().remindersFocus).toBeNull();
  });

  it("dismisses the bookmarks page when a new tab opens", async () => {
    const createTab = vi.fn(() => Promise.resolve());
    bridge({ createTab });
    useAppStore.setState({ overlay: "bookmarks", bookmarksFocus: "bm-1" });
    await useAppStore.getState().createTab("https://example.com");
    expect(useAppStore.getState().overlay).toBe("none");
    expect(createTab).toHaveBeenCalledWith("https://example.com");
  });

  it("still dismisses the page when the host refuses the selection", async () => {
    bridge({ selectTab: () => Promise.reject(new Error("gone")) });
    useAppStore.setState({ overlay: "settings" });
    await useAppStore.getState().selectTab("tab-1");
    expect(useAppStore.getState().overlay).toBe("none");
    expect(useAppStore.getState().error).toBe("gone");
  });
});
