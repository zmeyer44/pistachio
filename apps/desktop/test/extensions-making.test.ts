/**
 * A space an extension makes (docs/primitives.md §2.7): `pistachio.spaces.create`
 * under its own capability — named, with its pages, the extension's own from
 * then on; allowed with nobody there, behind what is in front, a few an hour,
 * written down with its Undo; and, made by it, its to close from in front.
 * The wish it serves: "every weekday at 5:30 a space called Chess time with
 * chess.com in it, closed again at six".
 */

import { describe, expect, it } from "vitest";
import { CAPABILITY_INFO } from "@pistachio/extension-api/capabilities";
import { runsLimit, sheetFor } from "@pistachio/extension-api/sheet";
import type { TriggerDecl } from "@pistachio/extension-api/triggers";
import { EXT_METHOD_NAMES, EXT_RATE_LIMITS, EXT_UNATTENDED_METHODS, SPACES_UNATTENDED_PER_HOUR, SPACE_TABS_MAX } from "@pistachio/extension-api/wire";
import type { AwayHolder } from "@pistachio/shell-contracts/away";
import type { TabGroupInfo } from "@pistachio/shell-contracts/tab-groups";
import type { ExtensionClosingHost, ExtensionMakingHost } from "../src/main/extensions/away";
import { dispatch } from "../src/main/extensions/methods";
import { sanitizeRegistry } from "../src/main/extensions/registry";
import { UNATTENDED_TABS_PER_HOUR } from "../src/main/extensions/scope";
import { closeRefused, type CloseRefusal } from "../src/main/space-closing";
import { MAKE_REFUSALS, makeRefused, type MakeRefusal } from "../src/main/space-making";
import { EXTENSION_ID, harness, manifestOf, recordOf, tabOf } from "./extensions-harness";

const CHESS: TriggerDecl = { id: "chess", during: { days: ["mon", "tue", "wed", "thu", "fri"], from: "17:30", to: "18:00" } };
const WORKER = { worker: { type: "web", main: "worker.js" }, triggers: [CHESS] };
const ME: AwayHolder = { kind: "extension", extensionId: EXTENSION_ID, name: "Harness" };

function fakeMaking() {
  const fake = {
    made: [] as { profileId: string; title: string; urls: readonly string[]; by: AwayHolder; show?: boolean }[],
    refuse: null as MakeRefusal | null,
    make: async (options: { profileId: string; title: string; urls: readonly string[]; by: AwayHolder; show?: boolean }) => {
      if (fake.refuse !== null) return makeRefused(fake.refuse);
      fake.made.push(options);
      const groupId = `made-${String(fake.made.length)}`;
      return { ok: true as const, groupId, profileId: options.profileId, title: options.title, tabIds: options.urls.map((_url, index) => `${groupId}-tab-${String(index + 1)}`), shown: options.show === true, by: options.by };
    },
  };
  return fake satisfies ExtensionMakingHost;
}

function fakeClosing() {
  const fake = {
    closed: [] as { groupId: string; by: AwayHolder; unattended?: boolean; absent?: boolean }[],
    refuse: null as CloseRefusal | null,
    close: async (groupId: string, options: { by: AwayHolder; unattended?: boolean; absent?: boolean }) => {
      if (fake.refuse !== null) return closeRefused(fake.refuse);
      fake.closed.push({ groupId, ...options });
      return { ok: true as const, groupId, profileId: "profile-a", title: "Chess time", tabCount: 1, entryId: "entry-1", by: options.by };
    },
    reopen: async () => ({ ok: true }),
  };
  return fake satisfies ExtensionClosingHost;
}

function setup(options: { capabilities?: string[]; spaces?: string[]; made?: string[] } = {}) {
  const making = fakeMaking();
  const closing = fakeClosing();
  const capabilities = options.capabilities ?? ["spaces:create", "spaces:close"];
  const h = harness({
    manifest: manifestOf({ permissions: capabilities, ...WORKER }),
    record: recordOf({ capabilities }, { ...(options.spaces === undefined ? {} : { spaces: options.spaces }), ...(options.made === undefined ? {} : { made: options.made }) }),
    tabs: [tabOf("t1", "https://example.com/", "profile-a")],
    making,
    closing,
  });
  const call = (method: string, args: unknown = {}) => dispatch(method, args, h.scope, h.ctx("worker"), h.runtime);
  /** The space as the browser would have it once made, so the scope can describe and find it. */
  const stands = (id: string, title = "Chess time"): void => {
    const drawn = h.browser.spaces("profile-a");
    const group: TabGroupInfo = { id, title, color: "green", tabIds: [], origin: "manual", open: false, createdAt: 0 };
    h.browser.spaces = (profileId) => (profileId === "profile-a" ? [...drawn, group] : []);
  };
  return { h, making, closing, call, stands };
}

describe("making a space, from an extension", () => {
  it("needs its own capability, on a line that says what it is", async () => {
    const { call, making } = setup({ capabilities: ["tabs:write", "spaces:write", "spaces:close"] });
    const reply = await call("spaces.create", { name: "Chess time", tabs: ["https://www.chess.com/"] });
    expect(reply).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    if (!reply.ok) expect(reply.message).toContain("spaces:create");
    expect(making.made).toEqual([]);
    expect(CAPABILITY_INFO["spaces:create"]).toEqual({ tier: "medium", line: "Makes new spaces and opens pages in them." });
    expect(sheetFor(manifestOf({ permissions: ["spaces:create"], ...WORKER })).can).toEqual([{ tier: "medium", text: "Makes new spaces and opens pages in them." }]);
  });

  it("run by the person: makes it under its own name, in their Profile, in front — and writes nothing down", async () => {
    const { h, call, making, stands } = setup();
    stands("made-1");
    h.scope.beginInvocation(1, "profile-a", "bar", "chess");
    const reply = await call("spaces.create", { name: "Chess time", tabs: ["https://www.chess.com/"] });
    expect(reply).toMatchObject({ ok: true, v: { id: "made-1", name: "Chess time", byPerson: true } });
    expect(making.made).toEqual([{ profileId: "profile-a", title: "Chess time", urls: ["https://www.chess.com/"], by: ME, show: true }]);
    expect(h.journal).toEqual([]);
  });

  it("run by the person with show: false: made behind what is in front", async () => {
    const { h, call, making } = setup();
    h.scope.beginInvocation(1, "profile-a", "bar", "chess");
    await call("spaces.create", { name: "Later", show: false });
    expect(making.made[0]).toEqual({ profileId: "profile-a", title: "Later", urls: [], by: ME });
  });

  it("with nobody there: made behind what is in front whatever was asked, and written down with the way back", async () => {
    const { h, call, making } = setup();
    h.scope.beginInvocation(1, "profile-a", "trigger", "chess");
    const reply = await call("spaces.create", { name: "Chess time", tabs: ["https://www.chess.com/"], show: true });
    expect(reply).toMatchObject({ ok: true, v: { id: "made-1", name: "Chess time", tabIds: ["made-1-tab-1"] } });
    // Nobody is moved by code.
    expect(making.made[0]?.show).toBeUndefined();
    expect(h.journal).toEqual([{ trigger: "chess", verb: "makeSpace", spaceId: "made-1", title: "Chess time" }]);
  });

  it("is on the list of what may be done with nobody there, and rate-limited", () => {
    expect(EXT_METHOD_NAMES).toContain("spaces.create");
    expect(EXT_UNATTENDED_METHODS).toContain("spaces.create");
    expect(EXT_RATE_LIMITS["spaces.create"]).toBe(10);
  });

  it("the space is its own from then on: held as one the person gave it, and remembered as made", async () => {
    const { h, call } = setup();
    h.scope.beginInvocation(1, "profile-a", "trigger", "chess");
    expect(h.scope.holdsSpace("made-1")).toBe(false);
    await call("spaces.create", { name: "Chess time" });
    expect(h.scope.holdsSpace("made-1")).toBe(true);
    expect(h.scope.madeSpace("made-1")).toBe(true);
    // (One it was only given is not one it made.)
    expect(h.scope.madeSpace("space-profile-a")).toBe(false);
  });

  it("takes pages of the web only, twelve at most, and a name that says something", async () => {
    const { h, call, making } = setup();
    h.scope.beginInvocation(1, "profile-a", "bar", "chess");
    for (const tabs of [["pistachio://settings"], ["file:///etc/passwd"], ["pistachio-ext://dev.other/page.html"], ["javascript:alert(1)"], ["chess.com"]]) {
      const reply = await call("spaces.create", { name: "Chess time", tabs });
      expect(reply, tabs[0]).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    }
    expect(await call("spaces.create", { name: "   " })).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    expect(await call("spaces.create", { name: "Many", tabs: Array.from({ length: SPACE_TABS_MAX + 1 }, (_value, index) => `https://example.com/${String(index)}`) })).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    expect(making.made).toEqual([]);
  });

  it("passes the verb's refusal on in its sentence, with what the author can do, and remembers nothing", async () => {
    const { h, call, making } = setup();
    h.scope.beginInvocation(1, "profile-a", "trigger", "chess");
    making.refuse = "full";
    const reply = await call("spaces.create", { name: "Chess time" });
    expect(reply).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    if (!reply.ok) expect(reply.message).toContain(MAKE_REFUSALS.full);
    expect(h.journal).toEqual([]);
    expect(h.scope.holdsSpace("made-1")).toBe(false);
  });

  it("with nobody there: four spaces an hour at most, their pages among the hour's twelve tabs", async () => {
    const { h, call, making } = setup();
    h.scope.beginInvocation(1, "profile-a", "trigger", "chess");
    for (let index = 0; index < SPACES_UNATTENDED_PER_HOUR; index += 1) expect(await call("spaces.create", { name: `Space ${String(index)}` })).toMatchObject({ ok: true });
    expect(await call("spaces.create", { name: "One too many" })).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    expect(making.made).toHaveLength(SPACES_UNATTENDED_PER_HOUR);
    // An hour on there is room again — but not for more pages than the hour's tabs.
    h.setNow(1_000_000 + 61 * 60_000);
    const tabs = Array.from({ length: 7 }, (_value, index) => `https://example.com/${String(index)}`);
    expect(await call("spaces.create", { name: "Seven", tabs })).toMatchObject({ ok: true });
    expect(UNATTENDED_TABS_PER_HOUR).toBe(12);
    expect(await call("spaces.create", { name: "Seven more", tabs })).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    expect(making.made).toHaveLength(SPACES_UNATTENDED_PER_HOUR + 1);
  });

  it("tells a trigger's handler that a tab's own space is not how a space is made alone", async () => {
    const { h, call } = setup({ capabilities: ["tabs:write", "spaces:create"] });
    h.scope.beginInvocation(1, "profile-a", "trigger", "chess");
    const reply = await call("tabs.create", { url: "https://www.chess.com/", space: "new" });
    expect(reply).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    if (!reply.ok) expect(reply.message).toContain("spaces.create");
  });
});

describe("closing a space it made", () => {
  it("closes it from in front, whoever is there: it closes at six", async () => {
    const { h, call, closing, stands } = setup({ spaces: ["made-1"], made: ["made-1"] });
    stands("made-1");
    h.scope.beginInvocation(1, "profile-a", "trigger", "chess");
    expect(await call("spaces.close", { spaceId: "made-1" })).toEqual({ ok: true, v: null });
    // (Asked as with nobody there, and as in front of no one: only the space in front's refusal is lifted.)
    expect(closing.closed).toEqual([{ groupId: "made-1", by: ME, unattended: true, absent: true }]);
    expect(h.journal).toEqual([{ trigger: "chess", verb: "closeSpace", spaceId: "made-1", title: "Chess time", entryId: "entry-1" }]);
  });

  it("never takes a space the person gave it from under them that way", async () => {
    const { h, call, closing } = setup({ spaces: ["space-profile-a"] });
    h.scope.beginInvocation(1, "profile-a", "trigger", "chess");
    await call("spaces.close", { spaceId: "space-profile-a" });
    expect(closing.closed[0]).toMatchObject({ unattended: true });
    expect(closing.closed[0]?.absent).toBeUndefined();
  });

  it("still waits on a space that is playing or holds a terminal: the verb's refusal is the call's", async () => {
    const { h, call, closing, stands } = setup({ spaces: ["made-1"], made: ["made-1"] });
    stands("made-1");
    h.scope.beginInvocation(1, "profile-a", "trigger", "chess");
    closing.refuse = "playing";
    const reply = await call("spaces.close", { spaceId: "made-1" });
    expect(reply).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    if (!reply.ok) expect(reply.message).toContain("let the handler fail");
  });

  it("needs the capability that closes spaces: making them is not closing them", async () => {
    const { h, call, closing, stands } = setup({ capabilities: ["spaces:create"], spaces: ["made-1"], made: ["made-1"] });
    stands("made-1");
    h.scope.beginInvocation(1, "profile-a", "trigger", "chess");
    expect(await call("spaces.close", { spaceId: "made-1" })).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(closing.closed).toEqual([]);
  });
});

describe("what the sheet says of it", () => {
  it("says what it may do alone, that what it made is its own — and that it may close one from in front", () => {
    expect(runsLimit({ permissions: ["spaces:create"] })).toBe("With nobody there it can only make new spaces. What it does to your spaces and tabs is listed, and can be undone.");
    expect(runsLimit({ permissions: ["spaces:create", "spaces:close"] })).toBe(
      "With nobody there it can only make new spaces and close spaces you gave it into the archive. A space it made counts as one you gave it, and can be closed while you are in it. What it does to your spaces and tabs is listed, and can be undone.",
    );
    expect(runsLimit({ permissions: ["spaces:create", "spaces:write"] })).toBe(
      "With nobody there it can only make new spaces and send away and bring back spaces you gave it. A space it made counts as one you gave it. What it does to your spaces and tabs is listed, and can be undone.",
    );
    // (Without it, the sentences are as they were.)
    expect(runsLimit({ permissions: ["spaces:close"] })).toBe("With nobody there it can only close spaces you gave it into the archive. What it does to your spaces and tabs is listed, and can be undone.");
  });

  it("the chess-time sheet: when it runs, what it can do, what it does alone", () => {
    const sheet = sheetFor(manifestOf({ permissions: ["spaces:create", "spaces:close"], ...WORKER }));
    expect(sheet.runs).toEqual(["Weekdays 5:30 PM–6:00 PM"]);
    expect(sheet.can.map((line) => line.text)).toEqual(["Makes new spaces and opens pages in them.", "Closes spaces into the archive, where they can be restored."]);
    expect(sheet.runsLimit).toContain("can be closed while you are in it");
  });
});

describe("the record of what it made", () => {
  it("is read back with the record, as its grants are, and only for a Pistachio extension", () => {
    const base = { id: "dev.me.chess-time", kind: "pistachio", source: { type: "dev", path: "/dev/chess-time" }, enabled: true, profiles: "all", grants: null, pending: null, pinned: true, order: 0, agentAllowed: false, installedAt: 1, updatedAt: 1 };
    const read = sanitizeRegistry({ version: 1, records: [{ ...base, spaces: ["made-1", "given-1"], made: ["made-1", 7, "made-1", "not an id!"] }], settings: {} });
    expect(read.records[0]).toMatchObject({ spaces: ["made-1", "given-1"], made: ["made-1"] });
    const none = sanitizeRegistry({ version: 1, records: [base], settings: {} });
    expect(none.records[0]?.made).toBeUndefined();
  });
});
