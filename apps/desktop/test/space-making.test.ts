/**
 * Making a space (main/space-making.ts; docs/primitives.md §2.7): the verb
 * behind an extension's `pistachio.spaces.create` — a named space of the
 * person's, with its pages, made behind what is in front.
 */

import { describe, expect, it, vi } from "vitest";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import { MAKE_REFUSALS, SpaceMaking, type MakeHost, type SpaceMade } from "../src/main/space-making";

const extension = { kind: "extension", extensionId: "dev.me.chess-time", name: "Chess time" } as const;

/** Main's side, as far as making reaches it: a Profile's spaces, each with its tabs. */
function browser() {
  const groups = new Map<string, { title: string; origin: TabGroupInfo["origin"]; tabs: string[] }>();
  const state = {
    room: true,
    refuseGroup: false,
    failing: new Set<string>(),
    /** A page that never finishes loading: an open that waits for its load never answers. */
    stalled: new Set<string>(),
    selected: [] as string[],
    published: 0,
    nextTab: 1,
    opened: [] as { url: string; group: string | undefined; activate: boolean | undefined; profile: string | undefined }[],
  };
  const host = {
    hasRoomForSpace: vi.fn(() => state.room),
    createTabGroup: vi.fn((options: { title?: string; tabIds: readonly string[]; origin: TabGroupInfo["origin"]; spaceId?: string }) => {
      if (state.refuseGroup) return null;
      const id = `made-${String(groups.size + 1)}`;
      groups.set(id, { title: options.title ?? "", origin: options.origin, tabs: [] });
      return { id, title: options.title ?? "", color: "blue", tabIds: [], origin: options.origin, open: false, createdAt: 0 } satisfies TabGroupInfo;
    }),
    createTab: vi.fn(async (url: string, options: { spaceId?: string; group?: string; activate?: boolean; awaitLoad?: boolean }) => {
      if (state.failing.has(url)) throw new Error("could not open");
      const id = `tab-${String(state.nextTab++)}`;
      state.opened.push({ url, group: options.group, activate: options.activate, profile: options.spaceId });
      groups.get(options.group ?? "")?.tabs.push(id);
      // (As the controller: the tab stands in its space at once; the call answers when its page has loaded, unless told not to wait.)
      if (state.stalled.has(url) && options.awaitLoad !== false) await new Promise<never>(() => undefined);
      return id;
    }),
    refreshSpaces: vi.fn(() => {
      state.published += 1;
    }),
    hasTabGroup: vi.fn((id: string) => groups.has(id)),
    selectGroup: vi.fn(async (id: string) => {
      state.selected.push(id);
    }),
    closeTabGroup: vi.fn(async (id: string) => {
      groups.delete(id);
      return null;
    }),
  };
  return { groups, state, host, asHost: host as unknown as MakeHost };
}

describe("making a space", () => {
  it("makes it the person's, under its name, with a tab for each page in order — each behind what is in front", async () => {
    const side = browser();
    const making = new SpaceMaking({ host: side.asHost });
    const outcome = await making.make({ profileId: "work", title: "  Chess   time ", urls: ["https://www.chess.com/", "https://lichess.org/"], by: extension });
    expect(outcome).toMatchObject({ ok: true, groupId: "made-1", profileId: "work", title: "Chess time", tabIds: ["tab-1", "tab-2"], shown: false, by: extension });
    // The person's from the start: it outlives its last tab, and Tidy does not file it for standing idle.
    expect(side.groups.get("made-1")).toMatchObject({ title: "Chess time", origin: "manual" });
    expect(side.host.createTabGroup).toHaveBeenCalledWith({ title: "Chess time", tabIds: [], origin: "manual", spaceId: "work" });
    expect(side.state.opened).toEqual([
      { url: "https://www.chess.com/", group: "made-1", activate: false, profile: "work" },
      { url: "https://lichess.org/", group: "made-1", activate: false, profile: "work" },
    ]);
    // None of them waited on: the space is answered as its tabs stand in it.
    expect(side.host.createTab.mock.calls.every(([, options]) => options.awaitLoad === false)).toBe(true);
    // Nobody is moved by code.
    expect(side.state.selected).toEqual([]);
    expect(side.state.published).toBeGreaterThan(0);
  });

  it("brings it in front only for a maker the person is behind", async () => {
    const side = browser();
    const making = new SpaceMaking({ host: side.asHost });
    const outcome = await making.make({ profileId: "work", title: "Trip", urls: ["https://example.com/"], by: extension, show: true });
    expect(outcome).toMatchObject({ ok: true, shown: true });
    expect(side.state.selected).toEqual(["made-1"]);
  });

  it("makes an empty space when asked for no pages", async () => {
    const side = browser();
    const outcome = await new SpaceMaking({ host: side.asHost }).make({ profileId: "work", title: "Later", urls: [], by: extension });
    expect(outcome).toMatchObject({ ok: true, tabIds: [] });
    expect(side.groups.has("made-1")).toBe(true);
  });

  it("says so once, to whoever listens: what the notice is made from", async () => {
    const side = browser();
    const making = new SpaceMaking({ host: side.asHost });
    const heard: SpaceMade[] = [];
    making.onChange((made) => heard.push(made));
    await making.make({ profileId: "work", title: "Chess time", urls: ["https://www.chess.com/"], by: extension });
    expect(heard).toEqual([{ groupId: "made-1", profileId: "work", title: "Chess time", tabIds: ["tab-1"], shown: false, by: extension }]);
  });

  it("is refused, and makes nothing, when the Profile has no room for another space", async () => {
    const side = browser();
    side.state.room = false;
    const outcome = await new SpaceMaking({ host: side.asHost }).make({ profileId: "work", title: "Chess time", urls: ["https://www.chess.com/"], by: extension });
    expect(outcome).toEqual({ ok: false, refusal: "full", reason: MAKE_REFUSALS.full });
    expect(side.host.createTabGroup).not.toHaveBeenCalled();
    expect(side.state.opened).toEqual([]);
  });

  it("leaves out a page that could not be opened, and keeps the rest", async () => {
    const side = browser();
    side.state.failing.add("https://bad.example/");
    const outcome = await new SpaceMaking({ host: side.asHost }).make({ profileId: "work", title: "Two", urls: ["https://bad.example/", "https://good.example/"], by: extension });
    expect(outcome).toMatchObject({ ok: true, tabIds: ["tab-1"] });
  });

  it("does not leave an empty space standing when none of its pages could be opened", async () => {
    const side = browser();
    side.state.failing.add("https://bad.example/");
    const making = new SpaceMaking({ host: side.asHost });
    const heard: SpaceMade[] = [];
    making.onChange((made) => heard.push(made));
    const outcome = await making.make({ profileId: "work", title: "None", urls: ["https://bad.example/"], by: extension });
    expect(outcome).toEqual({ ok: false, refusal: "noPages", reason: MAKE_REFUSALS.noPages });
    expect(side.groups.size).toBe(0);
    expect(heard).toEqual([]);
  });

  it("answers once the tabs stand in the space, not once their pages have loaded: a slow site does not outlast the handler that asked", async () => {
    const side = browser();
    side.state.stalled.add("https://slow.example/");
    const making = new SpaceMaking({ host: side.asHost });
    const heard: SpaceMade[] = [];
    making.onChange((made) => heard.push(made));
    const outcome = await Promise.race([
      making.make({ profileId: "work", title: "Chess time", urls: ["https://slow.example/", "https://www.chess.com/"], by: extension }),
      new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), 250)),
    ]);
    // (A trigger's handler has ten seconds: kept waiting on a page, it is given up on, its worker stopped, and the
    // space it made is one nobody holds the id of — made again at the retry.)
    expect(outcome).toMatchObject({ ok: true, groupId: "made-1", tabIds: ["tab-1", "tab-2"] });
    expect(heard).toHaveLength(1);
  });

  it("makes one at a time: two asked together do not interleave", async () => {
    const side = browser();
    const making = new SpaceMaking({ host: side.asHost });
    const [first, second] = await Promise.all([
      making.make({ profileId: "work", title: "One", urls: ["https://one.example/", "https://one.example/b"], by: extension }),
      making.make({ profileId: "work", title: "Two", urls: ["https://two.example/"], by: extension }),
    ]);
    expect(first).toMatchObject({ ok: true, groupId: "made-1", tabIds: ["tab-1", "tab-2"] });
    expect(second).toMatchObject({ ok: true, groupId: "made-2", tabIds: ["tab-3"] });
    expect(side.state.opened.map((tab) => tab.group)).toEqual(["made-1", "made-1", "made-2"]);
  });

  it("does nothing more once the window has closed", async () => {
    const side = browser();
    const making = new SpaceMaking({ host: side.asHost });
    making.stop();
    expect(await making.make({ profileId: "work", title: "Late", urls: [], by: extension })).toMatchObject({ ok: false, refusal: "failed" });
    expect(side.groups.size).toBe(0);
  });
});
