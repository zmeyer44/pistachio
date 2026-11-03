/**
 * store.openLink with a `file:` address: a tab of its own (main's `file`, scripts off) from a note or a document of the
 * person's (`fileLinks`), never Glance; from anywhere else, nothing — the home page is not what a file's link opens.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { useAppStore } from "../src/store";

const BOX = { x: 10, y: 10, width: 100, height: 20 };

function bridge(): { createTab: ReturnType<typeof vi.fn>; openGlance: ReturnType<typeof vi.fn> } {
  const api = { createTab: vi.fn(async () => undefined), openGlance: vi.fn(async () => false) };
  setShellApi(api as unknown as ShellApiBridge);
  return api;
}

afterEach(() => {
  useAppStore.setState({ error: null });
});

describe("a file: link", () => {
  it("opens as a file tab from a note, never in Glance", async () => {
    const api = bridge();
    await useAppStore.getState().openLink("file:///Users/me/Pictures/Recording.mp4", BOX, false, { fileLinks: true });
    expect(api.openGlance).not.toHaveBeenCalled();
    expect(api.createTab).toHaveBeenCalledWith("file:///Users/me/Pictures/Recording.mp4", { file: true });
  });

  it("opens nothing from anywhere else, and a web link opens as before", async () => {
    const api = bridge();
    await useAppStore.getState().openLink("file:///etc/hosts", BOX, false);
    await useAppStore.getState().openLink("FILE:///etc/hosts", BOX, true);
    expect(api.createTab).not.toHaveBeenCalled();
    expect(api.openGlance).not.toHaveBeenCalled();
    await useAppStore.getState().openLink("https://example.com/", BOX, true);
    expect(api.createTab).toHaveBeenCalledWith("https://example.com/");
  });
});
