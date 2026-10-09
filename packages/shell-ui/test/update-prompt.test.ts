import { describe, expect, it } from "vitest";
import type { UpdateState } from "@pistachio/shell-contracts/updates";
import { updatePromptShows, updatePromptWaiting } from "../src/lib/update-prompt";

const due: UpdateState = { status: "available", version: "0.0.31", releaseDate: null, prompt: { due: true, snoozes: 0 } };
const free = { update: due, overlay: "none" as const, onboardingOpen: false, glanceOpen: false };

describe("update prompt", () => {
  it("goes up for a release that is due while the screen is free", () => {
    expect(updatePromptWaiting(free)).toBe(true);
  });

  it("stays down once put off", () => {
    expect(updatePromptWaiting({ ...free, update: { ...due, prompt: { due: false, snoozes: 1 } } })).toBe(false);
    expect(updatePromptWaiting({ ...free, update: { status: "downloading", version: "0.0.31", percent: 10 } })).toBe(false);
  });

  it("waits for whatever the person opened", () => {
    expect(updatePromptWaiting({ ...free, overlay: "url" })).toBe(false);
    expect(updatePromptWaiting({ ...free, overlay: "settings" })).toBe(false);
    expect(updatePromptWaiting({ ...free, overlay: "permission" })).toBe(false);
    expect(updatePromptWaiting({ ...free, onboardingOpen: true })).toBe(false);
    expect(updatePromptWaiting({ ...free, glanceOpen: true })).toBe(false);
  });

  it("goes up over the desk, the desktop's surface since 2026-10-09: it is a page over it, as Settings is", () => {
    // (Nothing about the desk is asked: the gate that kept it down on a desk is gone.)
    expect(updatePromptWaiting(free)).toBe(true);
    expect(Object.keys(free)).not.toContain("deskUp");
  });

  it("follows the update it started, and steps aside when there is nothing to say", () => {
    expect(updatePromptShows({ status: "downloading", version: "0.0.31", percent: 40 })).toBe(true);
    expect(updatePromptShows({ status: "ready", version: "0.0.31" })).toBe(true);
    expect(updatePromptShows({ status: "error", message: "offline", checkedAt: null })).toBe(true);
    expect(updatePromptShows({ status: "up-to-date", checkedAt: "2026-10-04T00:00:00.000Z" })).toBe(false);
    expect(updatePromptShows({ status: "unsupported", reason: "dev" })).toBe(false);
  });
});
