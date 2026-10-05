import { describe, expect, it } from "vitest";
import { isShellCommand } from "../src/chrome.js";
import { copyUrlNotice } from "../src/page-link.js";

describe("shell command: notice", () => {
  it("carries a short message for the notice stack, with or without a tone", () => {
    expect(isShellCommand({ type: "notice", message: "URL copied" })).toBe(true);
    expect(isShellCommand({ type: "notice", message: "URL copied", tone: "success" })).toBe(true);
  });

  it("refuses a tone it does not know", () => {
    expect(isShellCommand({ type: "notice", message: "URL copied", tone: "loud" })).toBe(false);
  });

  it("refuses an empty, missing or oversized message", () => {
    expect(isShellCommand({ type: "notice", message: "" })).toBe(false);
    expect(isShellCommand({ type: "notice" })).toBe(false);
    expect(isShellCommand({ type: "notice", message: "x".repeat(257) })).toBe(false);
  });
});

describe("shell command: toggleLibrary", () => {
  it("crosses from main as a bare command", () => {
    expect(isShellCommand({ type: "toggleLibrary" })).toBe(true);
  });
});

describe("copy url notice", () => {
  it("says which form of the address was copied", () => {
    expect(copyUrlNotice("plain")).toBe("URL copied");
    expect(copyUrlNotice("markdown")).toBe("Link copied as Markdown");
  });
});

describe("shell command: showUpdate", () => {
  it("is the update notification's ask for the update's controls, and carries nothing", () => {
    expect(isShellCommand({ type: "showUpdate" })).toBe(true);
    expect(isShellCommand({ type: "showUpdates" })).toBe(false);
  });
});
