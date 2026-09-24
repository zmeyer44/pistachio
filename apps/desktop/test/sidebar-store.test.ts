import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SidebarStore } from "../src/main/sidebar-store";
import type { SidebarState } from "@pistachio/shell-contracts/sidebar";

const SHELF: SidebarState = {
  favorites: [{ id: "favorite", url: "https://example.com/", title: "Example", faviconUrl: null }],
  entries: [],
};

describe("SidebarStore Space scoping", () => {
  it("forks a shelf by value so later edits do not flow between Spaces", () => {
    const directory = mkdtempSync(join(tmpdir(), "pistachio-sidebars-"));
    const store = new SidebarStore(directory);
    store.set("work", SHELF);
    store.fork("work", "child", true);
    store.set("child", { favorites: [], entries: [] });
    expect(store.get("work").favorites).toHaveLength(1);
    expect(store.get("child").favorites).toHaveLength(0);
    expect(new SidebarStore(directory).get("work").favorites[0]?.title).toBe("Example");
  });

  it("adopts the former bare sidebar file as the root Space", () => {
    const directory = mkdtempSync(join(tmpdir(), "pistachio-sidebar-migration-"));
    writeFileSync(join(directory, "sidebar.json"), JSON.stringify(SHELF));
    expect(new SidebarStore(directory).get("work")).toEqual(SHELF);
  });
});

describe("SidebarStore anchor writes", () => {
  it("holds a synced title in memory until flush writes it", () => {
    const directory = mkdtempSync(join(tmpdir(), "pistachio-sidebar-anchor-"));
    const store = new SidebarStore(directory);
    store.set("work", SHELF);
    store.syncAnchor("work", "favorite", "Renamed", "https://example.com/icon.png");
    expect(store.get("work").favorites[0]?.title).toBe("Renamed");
    expect(new SidebarStore(directory).get("work").favorites[0]?.title).toBe("Example");
    store.flush();
    const reread = new SidebarStore(directory).get("work").favorites[0];
    expect(reread?.title).toBe("Renamed");
    expect(reread?.faviconUrl).toBe("https://example.com/icon.png");
  });

  it("keeps an entry's last favicon while its tab reports none", () => {
    const directory = mkdtempSync(join(tmpdir(), "pistachio-sidebar-anchor-favicon-"));
    const store = new SidebarStore(directory);
    store.set("work", {
      favorites: [{ id: "favorite", url: "https://mail.google.com/", title: "Gmail", faviconUrl: "https://mail.google.com/gmail.png" }],
      entries: [{ kind: "pin", id: "pin", url: "https://example.com/", title: "Example", faviconUrl: "https://example.com/icon.png", folderId: null }],
    });
    // The page loaded again and its icon has not been reported yet.
    store.syncAnchor("work", "favorite", "Inbox – Gmail", null);
    store.syncAnchor("work", "pin", "Example", null);
    const shelf = store.get("work");
    expect(shelf.favorites[0]?.title).toBe("Inbox – Gmail");
    expect(shelf.favorites[0]?.faviconUrl).toBe("https://mail.google.com/gmail.png");
    expect(shelf.entries[0]?.kind === "pin" ? shelf.entries[0].faviconUrl : null).toBe("https://example.com/icon.png");
    // A reported icon still replaces the kept one.
    store.syncAnchor("work", "favorite", "Inbox – Gmail", "https://mail.google.com/new.png");
    expect(store.get("work").favorites[0]?.faviconUrl).toBe("https://mail.google.com/new.png");
  });

  it("writes synced titles on its own after the debounce", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pistachio-sidebar-anchor-timer-"));
    const store = new SidebarStore(directory);
    store.set("work", SHELF);
    store.syncAnchor("work", "favorite", "First", null);
    store.syncAnchor("work", "favorite", "Second", null);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(new SidebarStore(directory).get("work").favorites[0]?.title).toBe("Second");
  });

  it("lets a command's immediate write carry a pending anchor sync", () => {
    const directory = mkdtempSync(join(tmpdir(), "pistachio-sidebar-anchor-command-"));
    const store = new SidebarStore(directory);
    store.set("work", SHELF);
    store.syncAnchor("work", "favorite", "Renamed", null);
    store.set("other", { favorites: [], entries: [] });
    expect(new SidebarStore(directory).get("work").favorites[0]?.title).toBe("Renamed");
  });
});
