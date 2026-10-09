/**
 * The archive page's buttons (src/components/archive/archive-actions.ts):
 * a Restore main declines says why — its reason, in the page's error note,
 * kept through the reload that shows the list as it is — and leaves the
 * entry listed; the next thing done clears it. Since 2026-10-09 main gives a
 * reason (a filed space the Profile has no room for: the 50-space cap).
 */

import { describe, expect, it, vi } from "vitest";
import type { ArchiveEntryView, TabArchiveRequest, TabArchiveResponse } from "@pistachio/shell-contracts/tab-archive";
import { archiveActions, ARCHIVE_VIEW_START, type ArchiveView } from "../src/components/archive/archive-actions";

const ENTRY: ArchiveEntryView = {
  id: "entry-1",
  spaceId: "profile-1",
  archivedAt: 1,
  reason: "closed",
  runId: null,
  kind: "group",
  groupId: "space-1",
  group: { title: "Trip", color: "blue", origin: "manual" },
  tabs: [],
} as unknown as ArchiveEntryView;

const FULL = "This Profile has 50 spaces, the most it can hold. Close one to bring this one back.";

function page(restored: TabArchiveResponse) {
  let view: ArchiveView = ARCHIVE_VIEW_START;
  const requests: TabArchiveRequest[] = [];
  const close = vi.fn();
  const actions = archiveActions("profile-1", {
    api: () => ({
      tabArchive: (request: TabArchiveRequest): Promise<TabArchiveResponse> => {
        requests.push(request);
        if (request.type === "list") return Promise.resolve({ type: "list", entries: [ENTRY], retentionDays: 30 });
        return Promise.resolve(request.type === "restore" ? restored : { type: "done", ok: true });
      },
    }),
    update: (change) => {
      view = change(view);
    },
    close,
  });
  return { actions, close, requests, view: () => view };
}

describe("restoring from the archive", () => {
  it("declined with a reason, shows the reason — kept through the reload — and the entry stays listed", async () => {
    const { actions, close, requests, view } = page({ type: "done", ok: false, reason: FULL });
    await actions.load();
    await actions.restore(ENTRY.id);
    expect(close).not.toHaveBeenCalled();
    // The list was read again, to show what is there now.
    expect(requests.map((request) => request.type)).toEqual(["list", "restore", "list"]);
    expect(view().error).toBe(FULL);
    expect(view().entries?.map((entry) => entry.id)).toEqual([ENTRY.id]);
    // Until the next thing done.
    await actions.remove(ENTRY.id);
    expect(view().error).toBeNull();
  });

  it("declined without one, reloads the list and says nothing", async () => {
    const { actions, close, view } = page({ type: "done", ok: false });
    await actions.load();
    await actions.restore(ENTRY.id);
    expect(close).not.toHaveBeenCalled();
    expect(view().error).toBeNull();
    expect(view().entries?.map((entry) => entry.id)).toEqual([ENTRY.id]);
  });

  it("done, gets out of the way of the tab it shows", async () => {
    const { actions, close } = page({ type: "done", ok: true });
    await actions.load();
    await actions.restore(ENTRY.id);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
