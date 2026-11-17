import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AWAY_REFUSALS, awayRefused, type AwayHolder, type AwayOutcome, type AwayRefusal, type AwaySpaceInfo } from "@pistachio/shell-contracts/away";
import { MAX_SPACE_GRANTS, returnStranded, sanitizeSpaceGrants, strandedOnSend, strandedSpaces, withSpaceGrant, type ExtensionAwayHost } from "../src/main/extensions/away";
import { dispatch } from "../src/main/extensions/methods";
import { ExtensionRegistry, REGISTRY_FILE } from "../src/main/extensions/registry";
import { EXTENSION_ID, harness, manifestOf, recordOf, tabOf } from "./extensions-harness";

const NOW = 1_000_000;

function awayOf(id: string, by: AwayHolder, extra: Partial<AwaySpaceInfo> = {}): AwaySpaceInfo {
  return { id, spaceId: "profile-a", title: `Space ${id}`, color: "green", tabCount: 2, favicons: [null, null], by, since: NOW - 1000, ...extra };
}

/** The away service, as far as an extension reaches it: it keeps what it is sent, and refuses what it is told to. */
function fakeAway(initial: AwaySpaceInfo[] = []) {
  const spaces = [...initial];
  const listeners = new Set<(change: { event: "sent" | "returned"; space: AwaySpaceInfo }) => void>();
  const tell = (event: "sent" | "returned", space: AwaySpaceInfo): void => {
    for (const listener of listeners) listener({ event, space });
  };
  const fake = {
    spaces,
    sent: [] as { groupId: string; by: AwayHolder; until?: number }[],
    back: [] as { id: string; select: boolean }[],
    refuse: null as AwayRefusal | null,
    send: async (groupId: string, options: { by: AwayHolder; until?: number }): Promise<AwayOutcome> => {
      if (fake.refuse !== null) return awayRefused(fake.refuse);
      fake.sent.push({ groupId, ...options });
      const space = awayOf(groupId, options.by, { title: "Work", since: NOW, ...(options.until === undefined ? {} : { until: options.until }) });
      spaces.push(space);
      tell("sent", space);
      return { ok: true, space };
    },
    bringBack: async (id: string, options: { select?: boolean } = {}): Promise<AwayOutcome> => {
      if (fake.refuse !== null) return awayRefused(fake.refuse);
      const at = spaces.findIndex((space) => space.id === id);
      if (at < 0) return awayRefused("notAway");
      const [space] = spaces.splice(at, 1);
      fake.back.push({ id, select: options.select === true });
      tell("returned", space!);
      return { ok: true, space: space! };
    },
    all: () => spaces,
    get: (id: string) => spaces.find((space) => space.id === id) ?? null,
    onChange: (listener: (change: { event: "sent" | "returned"; space: AwaySpaceInfo }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return fake satisfies ExtensionAwayHost;
}

const WRITES = { manifest: manifestOf({ permissions: ["spaces:write", "tabs:read"] }), record: recordOf({ capabilities: ["spaces:write", "tabs:read"] }) };
const SPACE = "space-profile-a";

function setup(options: Partial<Parameters<typeof harness>[0]> & { away?: ReturnType<typeof fakeAway> } = {}) {
  const away = options.away ?? fakeAway();
  const h = harness({ manifest: WRITES.manifest, record: recordOf({ capabilities: ["spaces:write", "tabs:read"] }), tabs: [tabOf("t1", "https://espn.com/")], ...options, away });
  const call = (method: string, args: unknown = {}) => dispatch(method, args, h.scope, h.ctx(), h.runtime);
  return { h, away, call };
}

describe("an extension's away spaces", () => {
  it("needs spaces:write on the sheet to send a space away or bring one back", async () => {
    const { call, away } = setup({ manifest: manifestOf({ permissions: ["tabs:read"] }), record: recordOf({ capabilities: ["tabs:read"] }) });
    for (const method of ["spaces.sendAway", "spaces.bringBack"]) {
      const reply = await call(method, { spaceId: SPACE });
      expect(reply, method).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
      if (!reply.ok) expect(reply.message).toContain('"spaces:write"');
    }
    expect(away.sent).toEqual([]);
  });

  it("refuses a space the person never ran it in, and says how the space becomes its own", async () => {
    const { call, away } = setup();
    const reply = await call("spaces.sendAway", { spaceId: SPACE });
    expect(reply).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    if (!reply.ok) {
      expect(reply.message).toContain("ctx.spaceId");
      expect(reply.message).toContain("Bar command");
    }
    // The same answer for a space that is nowhere: what it was never given, it learns nothing about.
    expect(await call("spaces.sendAway", { spaceId: "no-such-space" })).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(away.sent).toEqual([]);
  });

  it("sends away a space the person ran it in, under its own name, and keeps the grant on its record", async () => {
    const { h, call, away } = setup();
    // A Bar command, a menu item, a key or its icon, run in the space: the service grants as it invokes.
    h.scope.grantSpace(SPACE);
    expect(h.scope.holdsSpace(SPACE)).toBe(true);
    const until = NOW + 86_400_000;
    const reply = await call("spaces.sendAway", { spaceId: SPACE, until });
    expect(reply).toEqual({ ok: true, v: { id: SPACE, name: "Work", color: "green", tabCount: 2, since: NOW, until, mine: true } });
    expect(away.sent).toEqual([{ groupId: SPACE, by: { kind: "extension", extensionId: EXTENSION_ID, name: "Harness" }, until }]);
    // Without a time it stays away until asked.
    away.spaces.length = 0;
    expect(await call("spaces.sendAway", { spaceId: SPACE })).toMatchObject({ ok: true, v: { mine: true } });
    expect(away.sent[1]).toEqual({ groupId: SPACE, by: { kind: "extension", extensionId: EXTENSION_ID, name: "Harness" } });
  });

  it("is given only a space that can be away, in a Profile it is on in, and only while spaces:write is its", async () => {
    // A Home tab's space is nobody's to send.
    const loose = setup();
    loose.h.browser.spaces = () => [{ id: "home-tab", title: "New space", color: "gray", tabIds: ["t1"], origin: "manual", open: false, createdAt: 0, loose: true }];
    loose.h.scope.grantSpace("home-tab");
    expect(loose.h.scope.holdsSpace("home-tab")).toBe(false);
    // A space of a Profile it is off in is not there for it.
    const off = setup({ record: recordOf({ capabilities: ["spaces:write"] }, { profiles: ["profile-a"] }) });
    off.h.scope.grantSpace("space-profile-b");
    expect(off.h.scope.holdsSpace("space-profile-b")).toBe(false);
    off.h.scope.grantSpace(SPACE);
    expect(off.h.scope.holdsSpace(SPACE)).toBe(true);
    // Without the capability an invocation records nothing: no list grows behind the person's back.
    const none = setup({ manifest: manifestOf({ permissions: ["tabs:read"] }), record: recordOf({ capabilities: ["tabs:read"] }) });
    none.h.scope.grantSpace(SPACE);
    none.h.scope.grantSpace(null);
    expect(none.h.scope.holdsSpace(SPACE)).toBe(false);
  });

  it("refuses a space it holds once it is off in that space's Profile: it is not there for it", async () => {
    const { call, away } = setup({ record: recordOf({ capabilities: ["spaces:write"] }, { profiles: ["profile-b"], spaces: [SPACE] }) });
    expect(await call("spaces.sendAway", { spaceId: SPACE })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(away.sent).toEqual([]);
  });

  it("brings back what it sent itself, or a space the person gave it — and nobody else's", async () => {
    const mine = awayOf("mine", { kind: "extension", extensionId: EXTENSION_ID, name: "Harness" });
    const persons = awayOf("persons", { kind: "person" });
    const others = awayOf("others", { kind: "extension", extensionId: "dev.other.one", name: "Other" });
    const given = awayOf(SPACE, { kind: "person" });
    const { call, away } = setup({ away: fakeAway([mine, persons, others, given]), record: recordOf({ capabilities: ["spaces:write", "tabs:read"] }, { spaces: [SPACE] }) });
    // Its own, with no grant left for it (the list is bounded; the holder is not).
    expect(await call("spaces.bringBack", { spaceId: "mine" })).toEqual({ ok: true, v: null });
    // One the person sent away themselves, in a space they once ran it in.
    expect(await call("spaces.bringBack", { spaceId: SPACE })).toEqual({ ok: true, v: null });
    // Never in front: nobody but the person moves them.
    expect(away.back).toEqual([{ id: "mine", select: false }, { id: SPACE, select: false }]);
    for (const spaceId of ["persons", "others", "nowhere"]) {
      expect(await call("spaces.bringBack", { spaceId }), spaceId).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    }
    // One it holds that is here already: what was asked for is so, and nothing is done (a handler reconciles, and may ask twice).
    expect(await call("spaces.bringBack", { spaceId: SPACE })).toEqual({ ok: true, v: null });
    expect(away.back).toHaveLength(2);
    expect(away.spaces.map((space) => space.id)).toEqual(["persons", "others"]);
  });

  it("answers the away service's refusals with the wire's codes, its sentence, and what to do", async () => {
    const codes: [AwayRefusal, string][] = [
      ["working", "UNAVAILABLE"],
      ["live", "UNAVAILABLE"],
      ["sharing", "UNAVAILABLE"],
      ["recording", "UNAVAILABLE"],
      ["full", "UNAVAILABLE"],
      ["failed", "UNAVAILABLE"],
      ["past", "INVALID_ARGUMENT"],
      ["notASpace", "INVALID_ARGUMENT"],
      ["unknown", "NOT_FOUND"],
    ];
    const { h, call, away } = setup();
    h.scope.grantSpace(SPACE);
    for (const [refusal, code] of codes) {
      away.refuse = refusal;
      const reply = await call("spaces.sendAway", { spaceId: SPACE, until: NOW + 1000 });
      expect(reply, refusal).toMatchObject({ ok: false, code });
      if (!reply.ok) expect(reply.message, refusal).toContain(AWAY_REFUSALS[refusal]);
    }
    // No room for it to come back is the Profile's state, not the caller's mistake.
    away.refuse = null;
    await call("spaces.sendAway", { spaceId: SPACE });
    away.refuse = "room";
    expect(await call("spaces.bringBack", { spaceId: SPACE })).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    // A time that is no instant never reaches the service.
    away.refuse = null;
    for (const until of [-5, 0, Number.POSITIVE_INFINITY, "tomorrow"]) {
      expect(await call("spaces.sendAway", { spaceId: SPACE, until }), String(until)).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    }
  });

  it("lists the spaces away in its Profiles, whoever sent them, and marks its own", async () => {
    const away = fakeAway([
      awayOf("a", { kind: "person" }, { until: NOW + 5000 }),
      awayOf("b", { kind: "extension", extensionId: EXTENSION_ID, name: "Harness" }),
      awayOf("c", { kind: "agent" }, { spaceId: "profile-b" }),
    ]);
    const { call } = setup({ away, record: recordOf({ capabilities: ["tabs:read"] }, { profiles: ["profile-a"] }), manifest: manifestOf({ permissions: ["tabs:read"] }) });
    expect(await call("spaces.away")).toEqual({
      ok: true,
      v: [
        { id: "a", name: "Space a", color: "green", tabCount: 2, since: NOW - 1000, until: NOW + 5000, mine: false },
        { id: "b", name: "Space b", color: "green", tabCount: 2, since: NOW - 1000, mine: true },
      ],
    });
    // (An event about a space in a Profile it is off in is not its to hear.)
    const { h } = setup({ away, record: recordOf({ capabilities: ["tabs:read"] }, { profiles: ["profile-a"] }) });
    expect(h.scope.describeAway(away.spaces[2]!)).toBeNull();
    expect(h.scope.describeAway(away.spaces[1]!)).toMatchObject({ id: "b", mine: true });
    // And spaces.list is what it was: an away space is not among the spaces that are here.
    expect(await call("spaces.list")).toMatchObject({ ok: true, v: [{ id: SPACE }] });
  });

  it("says the window is not open when there is no away service to ask", async () => {
    const h = harness({ ...WRITES, record: recordOf({ capabilities: ["spaces:write", "tabs:read"] }, { spaces: [SPACE] }), tabs: [tabOf("t1", "https://espn.com/")] });
    expect(await dispatch("spaces.sendAway", { spaceId: SPACE }, h.scope, h.ctx(), h.runtime)).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    expect(await dispatch("spaces.away", {}, h.scope, h.ctx(), h.runtime)).toEqual({ ok: true, v: [] });
  });
});

describe("spaces left away by an extension that is gone", () => {
  const held = [
    awayOf("kept", { kind: "extension", extensionId: "dev.on.here", name: "On" }),
    awayOf("removed", { kind: "extension", extensionId: "dev.gone", name: "Gone" }),
    awayOf("off-there", { kind: "extension", extensionId: "dev.on.here", name: "On" }, { spaceId: "profile-b" }),
    awayOf("persons", { kind: "person" }),
    awayOf("agents", { kind: "agent" }),
  ];
  // `dev.on.here` is on in profile-a alone; `dev.gone` was removed.
  const runs = (extensionId: string, profileId: string): boolean => extensionId === "dev.on.here" && profileId === "profile-a";

  it("are the ones whose sender is removed, off, or off in their Profile — never the person's or the agent's", () => {
    expect(strandedSpaces(held, runs).map((space) => space.id)).toEqual(["removed", "off-there"]);
    expect(strandedSpaces(held, () => true)).toEqual([]);
  });

  it("is one the moment it arrives: a send that waited its turn while its extension was turned off or removed", () => {
    // (The cleanup ran when the extension went, and the space was not away yet: a send accepted before is not cancelled
    // by the worker stopping, so what it files is looked at as it lands.)
    expect(strandedOnSend({ event: "sent", space: held[1]! }, runs)).toBe(true);
    expect(strandedOnSend({ event: "sent", space: held[2]! }, runs)).toBe(true);
    // One whose sender still runs there stays; the person's and the agent's are nobody's to bring back; a return is not a send.
    expect(strandedOnSend({ event: "sent", space: held[0]! }, runs)).toBe(false);
    expect(strandedOnSend({ event: "sent", space: held[3]! }, runs)).toBe(false);
    expect(strandedOnSend({ event: "sent", space: held[4]! }, runs)).toBe(false);
    expect(strandedOnSend({ event: "returned", space: held[1]! }, runs)).toBe(false);
  });

  it("come back, in front of nothing; one with no room stays away, a press from back", async () => {
    const away = fakeAway(held);
    expect(await returnStranded(away, runs)).toEqual(["removed", "off-there"]);
    expect(away.back).toEqual([{ id: "removed", select: false }, { id: "off-there", select: false }]);
    expect(away.spaces.map((space) => space.id)).toEqual(["kept", "persons", "agents"]);
    // Turned off everywhere: what it kept away comes back too — unless the Profile has no room, when it waits, listed.
    away.refuse = "room";
    expect(await returnStranded(away, () => false)).toEqual([]);
    away.refuse = null;
    expect(await returnStranded(away, () => false)).toEqual(["kept"]);
  });
});

describe("the grant kept on the record", () => {
  it("is space ids, each once, the newest of them past the bound", () => {
    expect(sanitizeSpaceGrants(["a", "b", "a", 7, "", "not a space id!", null])).toEqual(["a", "b"]);
    expect(sanitizeSpaceGrants("a")).toEqual([]);
    expect(withSpaceGrant(["a"], "a")).toEqual(["a"]);
    expect(withSpaceGrant(["a"], "b")).toEqual(["a", "b"]);
    const many = Array.from({ length: MAX_SPACE_GRANTS }, (_, index) => `space-${String(index)}`);
    const next = withSpaceGrant(many, "newest");
    expect(next).toHaveLength(MAX_SPACE_GRANTS);
    expect(next[0]).toBe("space-1");
    expect(next.at(-1)).toBe("newest");
  });

  it("is written with the record, read back clean, and gone when the extension is removed", () => {
    const dir = mkdtempSync(join(tmpdir(), "pistachio-ext-away-"));
    const registry = new ExtensionRegistry(dir);
    registry.upsert(recordOf({ capabilities: ["spaces:write"] }));
    expect(registry.get(EXTENSION_ID)?.spaces).toBeUndefined();
    registry.update(EXTENSION_ID, { spaces: withSpaceGrant([], "space-1") });
    expect(new ExtensionRegistry(dir).get(EXTENSION_ID)?.spaces).toEqual(["space-1"]);
    // A file someone edited: what is no space id is dropped, and a Chrome extension keeps none.
    const file = JSON.parse(readFileSync(join(dir, REGISTRY_FILE), "utf8")) as { records: Record<string, unknown>[] };
    file.records[0]!["spaces"] = ["space-1", 4, "../etc", "space-1", "space-2"];
    file.records.push({ ...file.records[0]!, id: "chrome-one", kind: "chrome", source: { type: "webstore", cwsId: "abc", version: "1" } });
    writeFileSync(join(dir, REGISTRY_FILE), JSON.stringify(file));
    const read = new ExtensionRegistry(dir);
    expect(read.get(EXTENSION_ID)?.spaces).toEqual(["space-1", "space-2"]);
    expect(read.get("chrome-one")?.spaces).toBeUndefined();
    read.remove(EXTENSION_ID);
    expect(new ExtensionRegistry(dir).get(EXTENSION_ID)).toBeNull();
  });
});
