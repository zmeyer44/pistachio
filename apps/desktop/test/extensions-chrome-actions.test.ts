import { describe, expect, it } from "vitest";
import {
  badgeColorCss,
  chromeActionStates,
  chromeIconUrl,
  isChromeExtensionId,
  noticeText,
  chromeLogoRequest,
  chromeLogoUrl,
  pickManifestIcon,
  type RawActionState,
} from "../src/main/extensions/chrome/actions";

const MINI = "mkogcjgkaekdellgnemfofgiggoihhpb";
const OTHER = "ahefbpmiapkcfkabkdemhombaoekngoe";
const PARTITION = "persist:space-1b2c";

describe("chromeIconUrl", () => {
  it("names the extension, the size and the Profile session's partition", () => {
    expect(chromeIconUrl(MINI, PARTITION)).toBe(`crx://extension-icon/${MINI}/32/1?partition=persist%3Aspace-1b2c`);
    const url = new URL(chromeIconUrl(MINI, PARTITION, { size: 64, tabId: 7, modified: 1730000000000 }));
    expect(url.hostname).toBe("extension-icon");
    expect(url.pathname).toBe(`/${MINI}/64/1`);
    expect(url.searchParams.get("partition")).toBe(PARTITION);
    expect(url.searchParams.get("tabId")).toBe("7");
    expect(url.searchParams.get("t")).toBe("1730000000000");
  });

  it("clamps the size", () => {
    expect(chromeIconUrl(MINI, PARTITION, { size: 4 })).toContain("/16/1?");
    expect(chromeIconUrl(MINI, PARTITION, { size: 999 })).toContain("/128/1?");
  });
});

describe("chromeActionStates", () => {
  // The shape probed from electron-chrome-extensions 4.10's browserAction.getState() on 2026-10-30.
  const raw: RawActionState = {
    activeTabId: 2,
    actions: [
      { id: MINI, tabs: { "2": { text: "3", color: [255, 0, 0, 255] } }, title: "Mini Action", popup: "popup.html", text: "1", color: "#52a862" },
      { id: OTHER, tabs: {}, title: "Probe NS" },
      { id: "not-an-extension-id", tabs: {}, title: "Ignored" },
    ],
  };

  it("folds the active tab's own badge over the action's", () => {
    const [mini, other] = chromeActionStates(raw, PARTITION);
    expect(mini).toEqual({
      extensionId: MINI,
      title: "Mini Action",
      badge: "3",
      badgeColor: "rgba(255, 0, 0, 1)",
      hasPopup: true,
      iconModified: false,
      iconUrl: chromeIconUrl(MINI, PARTITION),
    });
    expect(other).toMatchObject({ extensionId: OTHER, title: "Probe NS", badge: null, badgeColor: null, hasPopup: false });
  });

  it("reads another tab's state when asked, and drops ids that aren't Chrome's", () => {
    const states = chromeActionStates(raw, PARTITION, 9);
    expect(states).toHaveLength(2);
    expect(states[0]).toMatchObject({ badge: "1", badgeColor: "#52a862" });
  });

  it("turns a popup off with an empty path, and keeps a per-tab icon's address apart", () => {
    const [state] = chromeActionStates({ activeTabId: 4, actions: [{ id: MINI, popup: "popup.html", tabs: { "4": { popup: "", iconModified: 55 } } }] }, PARTITION);
    expect(state?.hasPopup).toBe(false);
    expect(state?.title).toBe(MINI);
    expect(state?.iconUrl).toBe(chromeIconUrl(MINI, PARTITION, { tabId: 4, modified: 55 }));
    expect(state?.iconModified).toBe(true);
  });

  it("spells a logo's address, and reads one back from a request — any other address is none", () => {
    expect(chromeLogoUrl(MINI, 1700)).toBe(`crx://extension-logo/${MINI}/64?t=1700`);
    expect(chromeLogoRequest({ url: chromeLogoUrl(MINI, 1700, 32) })).toEqual({ id: MINI, size: 32 });
    expect(chromeLogoRequest({ url: chromeLogoUrl(MINI, 1700, 4096) })).toEqual({ id: MINI, size: 128 });
    expect(chromeLogoRequest({ url: `crx://extension-logo/${MINI}/nope` })).toEqual({ id: MINI, size: 64 });
    expect(chromeLogoRequest({ url: chromeIconUrl(MINI, PARTITION) })).toBeNull();
    expect(chromeLogoRequest({ url: "crx://extension-logo/not-an-id/64" })).toBeNull();
    expect(chromeLogoRequest({ url: "not a url" })).toBeNull();
  });
});

describe("the small pieces", () => {
  it("knows a Chrome extension id", () => {
    expect(isChromeExtensionId(MINI)).toBe(true);
    expect(isChromeExtensionId("../../etc")).toBe(false);
    expect(isChromeExtensionId("MKOGCJGKAEKDELLGNEMFOFGIGGOIHHPB")).toBe(false);
    expect(isChromeExtensionId(`${MINI}x`)).toBe(false);
  });

  it("reads badge colours", () => {
    expect(badgeColorCss([0, 128, 255, 128])).toBe("rgba(0, 128, 255, 0.502)");
    expect(badgeColorCss(" #fff ")).toBe("#fff");
    expect(badgeColorCss(undefined)).toBeNull();
    expect(badgeColorCss([1, 2])).toBeNull();
  });

  it("picks the manifest icon nearest the size from above", () => {
    const icons = { "16": "i16.png", "48": "i48.png", "128": "i128.png" };
    expect(pickManifestIcon(icons, 32)).toBe("i48.png");
    expect(pickManifestIcon(icons, 256)).toBe("i128.png");
    expect(pickManifestIcon("icon.png")).toBe("icon.png");
    expect(pickManifestIcon(undefined)).toBeNull();
  });

  it("words a notification as a notice", () => {
    expect(noticeText({ type: "basic", title: "  Saved ", message: "To   your list", contextMessage: "Raindrop" })).toEqual({ title: "Saved", body: "To your list\nRaindrop" });
    expect(noticeText({ type: "list", title: "Two things", items: [{ title: "A", message: "one" }, { title: "B", message: "two" }] })).toEqual({ title: "Two things", body: "A — one\nB — two" });
    expect(noticeText({ title: "x".repeat(500), message: "y" }).title).toHaveLength(120);
  });
});
