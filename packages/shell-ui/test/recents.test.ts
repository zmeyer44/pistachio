import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
});
vi.mock("../src/lib/deferred-storage", () => ({
  writeStorageLater: (key: string, value: string) => storage.set(key, value),
  flushStorageWrites: () => undefined,
}));

const { loadRecents, recentFaviconUrl, recordVisit, refaviconVisit, retitleVisit } = await import("../src/lib/recents");

const KEY = "pistachio.recents";
const visit = { host: "github.com", url: "https://github.com/", title: "GitHub", faviconUrl: null };

describe("recents favicons", () => {
  beforeEach(() => storage.clear());

  it("loads entries saved before the favicon field existed", () => {
    storage.set(KEY, JSON.stringify([{ host: "x.com", url: "https://x.com/", title: "X", atMs: 1 }]));
    expect(loadRecents()).toEqual([{ host: "x.com", url: "https://x.com/", title: "X", faviconUrl: null, atMs: 1 }]);
  });

  it("fills in a favicon that arrives after the visit was recorded, in place", () => {
    let list = recordVisit([], { host: "x.com", url: "https://x.com/", title: "X", faviconUrl: null }, 1);
    list = recordVisit(list, visit, 2);
    const next = refaviconVisit(list, "https://x.com/", "https://x.com/icon.png");
    expect(next.map((item) => item.host)).toEqual(["github.com", "x.com"]);
    expect(next[1]?.faviconUrl).toBe("https://x.com/icon.png");
    expect(loadRecents()[1]?.faviconUrl).toBe("https://x.com/icon.png");
  });

  it("returns the same list when the icon is unchanged or the page is unknown", () => {
    const list = recordVisit([], { ...visit, faviconUrl: "https://github.com/icon.png" }, 1);
    expect(refaviconVisit(list, "https://github.com/", "https://github.com/icon.png")).toBe(list);
    expect(refaviconVisit(list, "https://nowhere.example/", "https://x/icon.png")).toBe(list);
  });

  it("retitling keeps the recorded favicon", () => {
    const list = recordVisit([], { ...visit, faviconUrl: "https://github.com/icon.png" }, 1);
    expect(retitleVisit(list, "https://github.com/", "GitHub (3)")[0]?.faviconUrl).toBe("https://github.com/icon.png");
  });

  it("draws the page's own favicon, else the favicon service for the host", () => {
    expect(recentFaviconUrl({ ...visit, faviconUrl: "https://github.com/icon.png" })).toBe("https://github.com/icon.png");
    expect(recentFaviconUrl(visit)).toBe("https://www.google.com/s2/favicons?domain=github.com&sz=64");
    expect(recentFaviconUrl({ ...visit, faviconUrl: "" })).toBe("https://www.google.com/s2/favicons?domain=github.com&sz=64");
  });

  it("has no service fallback for app pages", () => {
    expect(recentFaviconUrl({ host: "pistachio://welcome", url: "pistachio://welcome", faviconUrl: null })).toBeNull();
  });
});
