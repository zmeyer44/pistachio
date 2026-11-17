/**
 * What the shell says of spaces that are away (src/lib/away-spaces.ts;
 * docs/primitives.md §2): the notice main's word of one raises — who sent it
 * and when it is due back in the shell's words, never the sender's — and the
 * rail's Away tile's name and count.
 */

import { describe, expect, it } from "vitest";
import type { AwaySpaceInfo } from "@pistachio/shell-contracts/away";
import { awayNoticeText, awayTabsLabel, awayTileCount, awayTileLabel } from "../src/lib/away-spaces";

const ZONE = { timeZone: "America/New_York", locale: "en-US" };
/** Wednesday 2026-11-18, 10:00 in New York. */
const NOW = Date.UTC(2026, 10, 18, 15, 0);
/** The Sunday after, 8:00 in New York. */
const SUNDAY = Date.UTC(2026, 10, 22, 13, 0);

const space = (over: Partial<AwaySpaceInfo> = {}): AwaySpaceInfo => ({
  id: "space-1",
  spaceId: "profile-1",
  title: "Football",
  color: "green",
  tabCount: 2,
  favicons: [null, null],
  by: { kind: "person" },
  since: NOW,
  ...over,
});

describe("the notice for a space that went away", () => {
  it("says only that it is away when the person sent it, with no time", () => {
    expect(awayNoticeText("sent", space(), NOW, ZONE)).toBe("“Football” is away");
  });

  it("says when it is due back", () => {
    expect(awayNoticeText("sent", space({ until: SUNDAY }), NOW, ZONE)).toBe("“Football” is away · back Sun 8:00 AM");
  });

  it("names the agent as Pistachio, and an extension by its name, after the time", () => {
    expect(awayNoticeText("sent", space({ by: { kind: "agent" }, until: SUNDAY }), NOW, ZONE)).toBe("“Football” is away · back Sun 8:00 AM · Pistachio");
    expect(awayNoticeText("sent", space({ by: { kind: "extension", extensionId: "dev.me.game-day", name: "Game day" } }), NOW, ZONE)).toBe("“Football” is away · Game day");
  });

  it("says a time later the same day as today", () => {
    expect(awayNoticeText("sent", space({ until: NOW + 3 * 3_600_000 }), NOW, ZONE)).toBe("“Football” is away · back today 1:00 PM");
  });
});

describe("the notice for a space the clock brought back", () => {
  it("says it is back, whoever sent it and whenever it was due", () => {
    expect(awayNoticeText("returned", space({ by: { kind: "agent" }, until: SUNDAY }), SUNDAY, ZONE)).toBe("“Football” is back");
  });
});

describe("the rail's Away tile", () => {
  it("is named by how many spaces are away", () => {
    expect(awayTileLabel(1)).toBe("1 space away");
    expect(awayTileLabel(3)).toBe("3 spaces away");
  });

  it("shows the count on its corner, 9+ past nine", () => {
    expect(awayTileCount(1)).toBe("1");
    expect(awayTileCount(9)).toBe("9");
    expect(awayTileCount(12)).toBe("9+");
  });
});

describe("an away space's row", () => {
  it("says how many tabs it holds", () => {
    expect(awayTabsLabel(0)).toBe("No tabs");
    expect(awayTabsLabel(1)).toBe("1 tab");
    expect(awayTabsLabel(4)).toBe("4 tabs");
  });
});
