/**
 * A page over the content hole (settings, reminders, bookmarks, the site
 * controls, a lightbox, a live view) steps aside when the user picks a tab or
 * opens one (src/store.ts `closePage`): a tab press — a row, a favorite, a
 * pin, a space, a window shown on the desk — is a request to see that tab,
 * and the page's own close button must not be the only way out.
 */

import type { ShellSnapshot } from "@pistachio/shell-contracts/ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setShellApi, type ShellApiBridge } from "../src/api";
import type { DeskEngine } from "../src/components/desk/desk-engine";
import { lendDeskEngine, newTabOnDesk, selectSpace, showOnDesk } from "../src/lib/desk/open";
import { useAppStore } from "../src/store";

function bridge(pistachio: Record<string, unknown>): void {
  setShellApi(pistachio as unknown as ShellApiBridge);
}

afterEach(() => {
  bridge({});
  lendDeskEngine(null);
  useAppStore.setState({ overlay: "none", remindersFocus: null, bookmarksFocus: null, imagePreview: null, snapshot: null, error: null });
});

describe("closePage", () => {
  it.each(["settings", "reminders", "bookmarks", "watchtower", "archive", "library", "site"] as const)("dismisses the %s page", (overlay) => {
    useAppStore.setState({ overlay, remindersFocus: "occ-1", bookmarksFocus: "bm-1" });
    expect(useAppStore.getState().closePage()).toBe(true);
    const state = useAppStore.getState();
    expect(state.overlay).toBe("none");
    expect(state.remindersFocus).toBeNull();
    expect(state.bookmarksFocus).toBeNull();
  });

  it("dismisses an image's lightbox", () => {
    useAppStore.setState({ overlay: "image-preview", imagePreview: { src: "blob:1", alt: "" } });
    expect(useAppStore.getState().closePage()).toBe(true);
    expect(useAppStore.getState().overlay).toBe("none");
    expect(useAppStore.getState().imagePreview).toBeNull();
  });

  it("closes a live view as its own close button does, telling the host", () => {
    const closeLiveView = vi.fn(() => Promise.resolve());
    bridge({ closeLiveView });
    useAppStore.setState({ overlay: "liveView" });
    expect(useAppStore.getState().closePage()).toBe(true);
    expect(useAppStore.getState().overlay).toBe("none");
    expect(closeLiveView).toHaveBeenCalled();
  });

  // A dialog asking something keeps its question; a popover is not in the way.
  it.each(["none", "url", "downloads", "site-info", "permission", "update", "space-fork"] as const)("leaves the %s overlay alone", (overlay) => {
    useAppStore.setState({ overlay, urlBarNew: "tab" });
    expect(useAppStore.getState().closePage()).toBe(false);
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

describe("opening a favorite or pin", () => {
  it("dismisses the settings page", async () => {
    const sidebarCommand = vi.fn(() => Promise.resolve());
    bridge({ sidebarCommand });
    useAppStore.setState({ overlay: "settings" });
    await useAppStore.getState().sidebarCommand({ type: "open", anchorId: "fav-1" });
    expect(useAppStore.getState().overlay).toBe("none");
    expect(sidebarCommand).toHaveBeenCalledWith({ type: "open", anchorId: "fav-1" });
  });

  it("leaves the page up for a command that opens nothing", async () => {
    bridge({ sidebarCommand: () => Promise.resolve() });
    useAppStore.setState({ overlay: "settings" });
    await useAppStore.getState().sidebarCommand({ type: "toggleFolder", folderId: "folder-1" });
    expect(useAppStore.getState().overlay).toBe("settings");
  });
});

describe("on the desk", () => {
  function engine(onDesk: readonly string[]): { add: ReturnType<typeof vi.fn> } {
    const fake = { hasGroupTab: (tabId: string) => onDesk.includes(tabId), add: vi.fn() };
    lendDeskEngine(fake as unknown as DeskEngine);
    return fake;
  }

  it("dismisses the page when a tab's window is shown — a favorite's page already in use included", () => {
    const desk = engine(["tab-1"]);
    useAppStore.setState({ overlay: "settings" });
    expect(showOnDesk("tab-1")).toBe(true);
    expect(useAppStore.getState().overlay).toBe("none");
    expect(desk.add).toHaveBeenCalledWith("tab-1", { focus: true });
  });

  it("leaves the page to the selection when the tab is not the desk's", () => {
    engine([]);
    useAppStore.setState({ overlay: "settings" });
    expect(showOnDesk("tab-2")).toBe(false);
    expect(useAppStore.getState().overlay).toBe("settings");
  });

  it("dismisses the page when another space is chosen, not the current one", () => {
    const tabGroupCommand = vi.fn(() => Promise.resolve());
    bridge({ tabGroupCommand });
    const snapshot = { currentGroupId: "space-a", tabGroups: [{ id: "space-b", tabIds: [] }], tabs: [] } as unknown as ShellSnapshot;
    useAppStore.setState({ overlay: "settings", snapshot });
    selectSpace("space-a");
    expect(useAppStore.getState().overlay).toBe("settings");
    selectSpace("space-b");
    expect(useAppStore.getState().overlay).toBe("none");
    expect(tabGroupCommand).toHaveBeenCalledWith({ type: "select", groupId: "space-b" });
  });

  it("dismisses the page for a new tab", async () => {
    const tabGroupCommand = vi.fn(() => Promise.resolve());
    bridge({ tabGroupCommand });
    useAppStore.setState({ overlay: "reminders", snapshot: { currentGroupId: "space-a" } as unknown as ShellSnapshot });
    await newTabOnDesk();
    expect(useAppStore.getState().overlay).toBe("none");
    expect(tabGroupCommand).toHaveBeenCalledWith({ type: "newTab", groupId: "space-a" });
  });
});
