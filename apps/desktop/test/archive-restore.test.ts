/**
 * The tab archive's restore (main/archive-restore.ts; docs/tab-tidy.md §3.5,
 * docs/spaces.md §1 "Close space"): an entry is spent only once what it held
 * is back — a space filed whole (empty, or with its tabs) that the Profile
 * has no room for stays in the archive, to be restored, with its own id,
 * once a space is freed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TAB_GROUPS_PER_SPACE, type TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import type { ArchivedTab } from "@pistachio/shell-contracts/tab-archive";
import { restoreArchiveEntry, type ArchiveRestoreHost } from "../src/main/archive-restore";
import { TabArchiveStore } from "../src/main/tab-archive-store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function archive(): TabArchiveStore {
  const dir = mkdtempSync(join(tmpdir(), "pistachio-archive-restore-"));
  dirs.push(dir);
  return new TabArchiveStore(dir, () => 30);
}

/** Main's side, as far as a restore reaches it: one Profile ("work") holding at most MAX_TAB_GROUPS_PER_SPACE drawn spaces. */
function browser(spaces: number) {
  let made = 0;
  const groups: TabGroupInfo[] = Array.from({ length: spaces }, (_, index) => ({ id: `other-${String(index)}`, title: "Other", color: "blue", tabIds: [], origin: "manual", open: false, createdAt: index }));
  const host = {
    activeSpaceId: () => "work",
    hasRoomForSpace: () => groups.length < MAX_TAB_GROUPS_PER_SPACE,
    restoreArchivedTabs: vi.fn((_spaceId: string, tabs: readonly ArchivedTab[]) => tabs.map(() => `tab-${String(++made)}`)),
    createTabGroup: vi.fn((options: { id?: string; title?: string; tabIds: readonly string[]; origin: TabGroupInfo["origin"] }) => {
      const id = options.id ?? `space-${String(++made)}`;
      if (groups.some((group) => group.id === id) || groups.length >= MAX_TAB_GROUPS_PER_SPACE) return null;
      const group: TabGroupInfo = { id, title: options.title ?? "New space", color: "blue", tabIds: [...options.tabIds], origin: options.origin, open: false, createdAt: 99 };
      groups.push(group);
      return group;
    }),
    commitTidy: vi.fn(),
    selectTab: vi.fn(async () => undefined),
    selectGroup: vi.fn(async () => undefined),
  };
  return { groups, host, restoring: host as unknown as ArchiveRestoreHost };
}

const page = (url: string): ArchivedTab => ({ title: url, url, faviconUrl: null, lastActiveAt: 1 });

describe("restoring a space from the archive", () => {
  it("keeps an empty space's entry when the Profile has no room for it, and restores it with its own id once a space is freed", async () => {
    const store = archive();
    const [entry] = store.add([{ kind: "group", spaceId: "work", reason: "closed", runId: null, groupId: "lisbon", group: { title: "Lisbon", color: "green", origin: "manual" }, tabs: [] }]);
    const { groups, host, restoring } = browser(MAX_TAB_GROUPS_PER_SPACE);

    const refused = await restoreArchiveEntry(store, restoring, { entryId: entry!.id }, () => true);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/space/i);
    // Its only entry is still there.
    expect(store.get(entry!.id)?.kind).toBe("group");

    groups.pop();
    const restored = await restoreArchiveEntry(store, restoring, { entryId: entry!.id }, () => true);
    expect(restored.ok).toBe(true);
    expect(groups.some((group) => group.id === "lisbon" && group.title === "Lisbon")).toBe(true);
    expect(host.selectGroup).toHaveBeenCalledWith("lisbon");
    expect(store.get(entry!.id)).toBeNull();
  });

  it("brings none of a filed space's tabs back while there is no room for the space, so nothing is restored twice", async () => {
    const store = archive();
    const [entry] = store.add([{ kind: "group", spaceId: "work", reason: "closed", runId: null, groupId: "trip", group: { title: "Trip", color: "blue", origin: "manual" }, tabs: [page("https://a.example/"), page("https://b.example/")] }]);
    const { groups, host, restoring } = browser(MAX_TAB_GROUPS_PER_SPACE);

    expect((await restoreArchiveEntry(store, restoring, { entryId: entry!.id }, () => true)).ok).toBe(false);
    expect(host.restoreArchivedTabs).not.toHaveBeenCalled();
    expect(store.get(entry!.id)).not.toBeNull();

    groups.pop();
    expect((await restoreArchiveEntry(store, restoring, { entryId: entry!.id }, () => true)).ok).toBe(true);
    expect(groups.find((group) => group.id === "trip")?.tabIds).toEqual(["tab-1", "tab-2"]);
    expect(host.selectTab).toHaveBeenCalledWith("tab-1");
    expect(store.get(entry!.id)).toBeNull();
  });

  it("keeps a filed space as an empty entry with its id once its tabs are restored one at a time, so the space itself can still come back", async () => {
    const store = archive();
    const [entry] = store.add([{ kind: "group", spaceId: "work", reason: "closed", runId: null, groupId: "lisbon", group: { title: "Lisbon", color: "green", origin: "manual" }, tabs: [page("https://a.example/"), page("https://b.example/")] }]);
    const { groups, restoring } = browser(3);

    expect((await restoreArchiveEntry(store, restoring, { entryId: entry!.id, tabIndex: 1 }, () => true)).ok).toBe(true);
    expect((await restoreArchiveEntry(store, restoring, { entryId: entry!.id, tabIndex: 0 }, () => true)).ok).toBe(true);
    // Both tabs are back, loose; the space — its Stack and conversation kept by its id — is still one Restore away.
    const left = store.get(entry!.id);
    expect(left).toMatchObject({ kind: "group", groupId: "lisbon", tabs: [] });
    expect(groups.some((group) => group.id === "lisbon")).toBe(false);

    expect((await restoreArchiveEntry(store, restoring, { entryId: entry!.id }, () => true)).ok).toBe(true);
    expect(groups.find((group) => group.id === "lisbon")).toMatchObject({ title: "Lisbon", tabIds: [] });
    expect(store.get(entry!.id)).toBeNull();
  });

  it("lets an entry filed with no id (before spaces kept theirs) go with its last tab, as before", async () => {
    const store = archive();
    const [entry] = store.add([{ kind: "group", spaceId: "work", reason: "closed", runId: null, group: { title: "Old", color: "blue", origin: "manual" }, tabs: [page("https://a.example/")] }]);
    const { restoring } = browser(3);
    expect((await restoreArchiveEntry(store, restoring, { entryId: entry!.id, tabIndex: 0 }, () => true)).ok).toBe(true);
    expect(store.get(entry!.id)).toBeNull();
  });
});
