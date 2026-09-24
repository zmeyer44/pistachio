/**
 * The shelf controller, shared by Electron main and the cloud host
 * (docs/web-browser-design.md §6.3). Both of the guarantees here were broken
 * by the lift into this package: one by assuming a browser context that
 * `crypto.randomUUID` exists in, the other by the controller overwriting a
 * rule its host had already decided.
 */

import { describe, expect, it } from "vitest";
import { SidebarController, type SidebarShelfStore, type SidebarTabHost } from "../src/sidebar-controller.js";
import { DEFAULT_SIDEBAR_STATE, type SidebarState } from "../src/sidebar.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

function harness(options: { anchorLeavesOnSplit?: (anchorId: string, spaceId: string) => boolean } = {}): {
  controller: SidebarController;
  browser: SidebarTabHost;
  state: () => SidebarState;
} {
  let state: SidebarState = DEFAULT_SIDEBAR_STATE;
  const store: SidebarShelfStore = {
    get: () => state,
    set: (_spaceId, next) => {
      state = next;
    },
  };
  const browser: SidebarTabHost = {
    anchorLeavesOnSplit: () => false,
    activeSpaceId: () => "work",
    tabs: () => [],
    tab: () => null,
    tabForAnchor: () => null,
    setAnchor: () => undefined,
    reorderTab: () => undefined,
    selectTab: async () => undefined,
    createTab: async () => "tab-1",
    navigate: async () => undefined,
  };
  const controller = new SidebarController({
    store,
    browser,
    settings: () => DEFAULT_SETTINGS,
    ...(options.anchorLeavesOnSplit === undefined ? {} : { anchorLeavesOnSplit: options.anchorLeavesOnSplit }),
  });
  return { controller, browser, state: () => state };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe("the shelf controller", () => {
  it("makes shelf ids in a browser with no secure context", async () => {
    // `crypto.randomUUID` is secure-context only: on `http://` it is simply
    // not there, and the shelf silently stopped being able to add anything.
    const original = crypto.randomUUID;
    Reflect.deleteProperty(crypto as unknown as Record<string, unknown>, "randomUUID");
    try {
      const { controller, state } = harness();
      await controller.run({ type: "addFavorite", source: { url: "https://example.com/", title: "Example" } });
      const [favorite] = state().favorites;
      expect(favorite).toBeDefined();
      expect(favorite?.id).toMatch(UUID);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true, writable: true });
    }
  });

  it("a stream surface keeps its own split rule instead of having it overwritten", () => {
    // §10: there is no native tile for a pane to stop following, so a
    // favorite's anchor survives the split. The host said so; the controller
    // used to assign over it on the very next line.
    const stream = harness({ anchorLeavesOnSplit: () => false });
    expect(stream.browser.anchorLeavesOnSplit("preset:https://example.com/", "work")).toBe(false);
    // The desktop, which passes no override, still gets the desktop rule.
    const native = harness();
    expect(native.browser.anchorLeavesOnSplit("preset:https://example.com/", "work")).toBe(true);
  });

  it("styles a folder: a colour and an emoji, each set, kept, or put back alone", async () => {
    const { controller, state } = harness();
    await controller.run({ type: "createFolder", name: "Work", id: "f" });
    const folder = (): unknown => state().entries.find((entry) => entry.id === "f");
    expect(folder()).toMatchObject({ color: null, emoji: null });

    await controller.run({ type: "styleFolder", folderId: "f", color: "purple" });
    await controller.run({ type: "styleFolder", folderId: "f", emoji: " 🚀 to the moon" });
    // Only the first grapheme is kept, and the colour was left alone.
    expect(folder()).toMatchObject({ color: "purple", emoji: "🚀" });

    // Words are not an icon: the emoji it had stays.
    await controller.run({ type: "styleFolder", folderId: "f", emoji: "work" });
    expect(folder()).toMatchObject({ color: "purple", emoji: "🚀" });

    await controller.run({ type: "styleFolder", folderId: "f", color: null, emoji: null });
    expect(folder()).toMatchObject({ color: null, emoji: null });

    // A folder that is gone is a no-op, never an error.
    await controller.run({ type: "styleFolder", folderId: "gone", color: "red" });
  });
});
