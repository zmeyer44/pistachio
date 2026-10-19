/**
 * Captures of tab pages handed to a renderer (docs/live-share.md §6.1, §10):
 * granted once, to the origin they went to, for ten seconds, as the page's
 * picture alone — and one page handed to the shell and the live share at
 * once is granted to each.
 */

import { describe, expect, it } from "vitest";
import { PageCaptureGrants } from "../src/main/page-capture-grants";

describe("PageCaptureGrants", () => {
  it("grants a capture once, to the origin it was handed to, while Chromium's id lasts", () => {
    let now = 1_000;
    const grants = new PageCaptureGrants(10_000, () => now);
    grants.grant(7, "pistachio-app://live-host");
    expect(grants.take(7, "file://", [])).toBe(false);
    expect(grants.take(8, "pistachio-app://live-host", [])).toBe(false);
    expect(grants.take(7, "pistachio-app://live-host", [])).toBe(true);
    expect(grants.take(7, "pistachio-app://live-host", [])).toBe(false);
    grants.grant(7, "pistachio-app://live-host");
    now += 10_001;
    expect(grants.take(7, "pistachio-app://live-host", [])).toBe(false);
  });

  it("grants the page's picture alone: not its sound, nor a camera or microphone asked for in its name", () => {
    const grants = new PageCaptureGrants(10_000);
    grants.grant(7, "file://");
    expect(grants.take(7, "file://", ["audio"])).toBe(false);
    expect(grants.take(7, "file://", ["video"])).toBe(false);
    expect(grants.take(7, null, [])).toBe(false);
    expect(grants.take(7, "file://", [])).toBe(true);
  });

  it("grants one page to the shell's picture and the live share at once, each its own", () => {
    const grants = new PageCaptureGrants(10_000);
    grants.grant(7, "pistachio-app://shell");
    grants.grant(7, "pistachio-app://live-host");
    expect(grants.take(7, "pistachio-app://shell", [])).toBe(true);
    expect(grants.take(7, "pistachio-app://live-host", [])).toBe(true);
    // In development both come from the dev server's one origin: each hand-out is still its own.
    grants.grant(7, "http://localhost:5173");
    grants.grant(7, "http://localhost:5173");
    expect(grants.take(7, "http://localhost:5173", [])).toBe(true);
    expect(grants.take(7, "http://localhost:5173", [])).toBe(true);
    expect(grants.take(7, "http://localhost:5173", [])).toBe(false);
  });
});
