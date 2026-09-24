import { describe, expect, it } from "vitest";
import { isBrowserControlCommand, type BrowserDownload } from "@pistachio/shell-contracts/browser-controls";
import { DEFAULT_SHORTCUTS, shortcutActionForEvent, shortcutConflict } from "@pistachio/shell-contracts/shortcuts";
import { CHROME_MANIFEST } from "../src/chrome/manifest";
import {
  downloadsChipLabel,
  downloadStatusLine,
  formatBytes,
  FRESH_MS,
  summarizeDownloads,
} from "../src/lib/downloads";

function download(overrides: Partial<BrowserDownload>): BrowserDownload {
  return {
    id: "d1",
    tabId: "t1",
    origin: "https://example.com",
    url: "https://example.com/notes.txt",
    fileName: "notes.txt",
    receivedBytes: 0,
    totalBytes: 0,
    state: "progress",
    createdAt: 1_000,
    finishedAt: null,
    reason: "",
    source: "default",
    ...overrides,
  };
}

describe("downloads chip", () => {
  it("says nothing without a download, and shows the bare icon once one has settled", () => {
    expect(summarizeDownloads([], 5_000).any).toBe(false);
    const settled = summarizeDownloads([download({ state: "completed", finishedAt: 1_000 })], 1_000 + FRESH_MS + 1);
    expect(settled.any).toBe(true);
    expect(downloadsChipLabel(settled)).toBeNull();
  });

  it("reports live progress across every live transfer", () => {
    const live = summarizeDownloads(
      [
        download({ id: "a", receivedBytes: 50, totalBytes: 100 }),
        download({ id: "b", receivedBytes: 25, totalBytes: 100 }),
        download({ id: "c", state: "completed", finishedAt: 900 }),
      ],
      1_000,
    );
    expect(live).toMatchObject({ live: 2, fresh: 0, percent: 37 });
    expect(downloadsChipLabel(live)).toBe("Downloading 2 37%");
    const unknown = summarizeDownloads([download({ receivedBytes: 10, totalBytes: 0 })], 1_000);
    expect(unknown.percent).toBeNull();
    expect(downloadsChipLabel(unknown)).toBe("Downloading…");
  });

  it("lights up for a fresh finish and forgets it after FRESH_MS", () => {
    const record = download({ state: "completed", finishedAt: 10_000, totalBytes: 2_048, receivedBytes: 2_048 });
    expect(downloadsChipLabel(summarizeDownloads([record], 10_000 + FRESH_MS - 1))).toBe("Downloaded");
    expect(downloadsChipLabel(summarizeDownloads([record], 10_000 + FRESH_MS))).toBeNull();
    expect(summarizeDownloads([download({ state: "interrupted", finishedAt: 10_000 })], 10_001).failed).toBe(1);
  });

  it("formats sizes and status lines the way the list shows them", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1_536)).toBe("1.5 KB");
    expect(formatBytes(120_000_000)).toBe("120 MB");
    expect(downloadStatusLine(download({ receivedBytes: 1_000, totalBytes: 4_000 }))).toBe("1.0 KB of 4.0 KB");
    expect(downloadStatusLine(download({ state: "completed", totalBytes: 4_000 }))).toBe("4.0 KB");
    expect(downloadStatusLine(download({ state: "interrupted" }))).toBe("Failed");
    expect(downloadStatusLine(download({ state: "blocked", reason: "policy" }))).toBe("Blocked · policy");
  });
});

describe("downloads commands and placement", () => {
  it("accepts the list's commands over IPC and nothing malformed", () => {
    expect(isBrowserControlCommand({ type: "openDownload", downloadId: "d1" })).toBe(true);
    expect(isBrowserControlCommand({ type: "retryDownload", downloadId: "d1" })).toBe(true);
    expect(isBrowserControlCommand({ type: "removeDownload", downloadId: "d1" })).toBe(true);
    expect(isBrowserControlCommand({ type: "clearDownloads" })).toBe(true);
    expect(isBrowserControlCommand({ type: "openDownload" })).toBe(false);
    expect(isBrowserControlCommand({ type: "retryDownload", downloadId: 4 })).toBe(false);
  });

  it("has a default key that collides with nothing, and a home in both layouts", () => {
    expect(DEFAULT_SHORTCUTS.openDownloads).toBe("Mod+Shift+J");
    expect(shortcutConflict(DEFAULT_SHORTCUTS, "Mod+Shift+J", "openDownloads")).toBeNull();
    expect(shortcutActionForEvent(DEFAULT_SHORTCUTS, { key: "J", code: "KeyJ", meta: true, shift: true }, "darwin")).toBe("openDownloads");
    expect(CHROME_MANIFEST.downloads.top).toMatchObject({ region: "trailing" });
    expect(CHROME_MANIFEST.downloads.sidebar).toMatchObject({ region: "footer" });
  });
});
