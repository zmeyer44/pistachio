/**
 * Stage 6 of docs/primitives.md (§2.6, §3.8): what an extension needed that
 * Tidy had and the public API did not — when a space was last used and whose
 * it is, the verb that closes one into the archive, a grant for every space
 * on a line of its own, and one question to a model.
 */

import { describe, expect, it, vi } from "vitest";
import { CAPABILITY_INFO } from "@pistachio/extension-api/capabilities";
import { runsLimit, sheetFor } from "@pistachio/extension-api/sheet";
import type { TriggerDecl } from "@pistachio/extension-api/triggers";
import { AI_COMPLETE_TIMEOUT_MS, AI_HANDLER_MARGIN_MS, AI_TOKENS_DEFAULT, AI_UNATTENDED_PER_HOUR, EXT_HANDLER_TIMEOUTS, EXT_METHOD_NAMES, EXT_UNATTENDED_METHODS } from "@pistachio/extension-api/wire";
import type { AwayHolder } from "@pistachio/shell-contracts/away";
import type { ExtensionClosingHost } from "../src/main/extensions/away";
import { CompleteCalls, completeWith, scriptedComplete } from "../src/main/extensions/complete";
import { dispatch } from "../src/main/extensions/methods";
import { CLOSE_REFUSALS, closeRefused, type CloseRefusal } from "../src/main/space-closing";
import { EXTENSION_ID, harness, manifestOf, recordOf, tabOf } from "./extensions-harness";

const SPACE = "space-profile-a";
const SWEEP: TriggerDecl = { id: "sweep", every: { minutes: 30 } };
const WORKER = { worker: { type: "web", main: "worker.js" }, triggers: [SWEEP] };

function fakeClosing() {
  const fake = {
    closed: [] as { groupId: string; by: AwayHolder; unattended?: boolean; absent?: boolean }[],
    refuse: null as CloseRefusal | null,
    reopened: [] as string[],
    close: async (groupId: string, options: { by: AwayHolder; unattended?: boolean; absent?: boolean }) => {
      if (fake.refuse !== null) return closeRefused(fake.refuse);
      fake.closed.push({ groupId, ...options });
      return { ok: true as const, groupId, profileId: "profile-a", title: "Work", tabCount: 2, entryId: "entry-1", by: options.by };
    },
    reopen: async (entryId: string) => {
      fake.reopened.push(entryId);
      return { ok: true };
    },
  };
  return fake satisfies ExtensionClosingHost;
}

function setup(options: { capabilities?: string[]; spaces?: string[]; profiles?: "all" | string[]; absent?: (triggers: readonly string[]) => boolean; answer?: string | null } = {}) {
  const closing = fakeClosing();
  const capabilities = options.capabilities ?? ["tabs:read", "spaces:close"];
  const h = harness({
    manifest: manifestOf({ permissions: capabilities, ...WORKER }),
    record: recordOf({ capabilities }, { spaces: options.spaces ?? [SPACE], ...(options.profiles === undefined ? {} : { profiles: options.profiles }) }),
    tabs: [tabOf("t1", "https://espn.com/", "profile-a", { lastActiveAt: 5_000 }), tabOf("t2", "https://nfl.com/", "profile-a", { lastActiveAt: 9_000 }), tabOf("t3", "https://example.com/", "profile-b", { lastActiveAt: 0 })],
    closing,
    ...(options.absent === undefined ? {} : { absent: options.absent }),
    ...(options.answer === undefined ? {} : { answer: options.answer }),
  });
  const call = (method: string, args: unknown = {}) => dispatch(method, args, h.scope, h.ctx("worker"), h.runtime);
  return { h, closing, call };
}

describe("a space, as an extension is told it", () => {
  it("says when it was last used — the latest of its tabs — and each tab's own", async () => {
    const { call } = setup();
    const spaces = await call("spaces.list");
    expect(spaces).toMatchObject({ ok: true, v: [{ id: SPACE, tabIds: ["t1", "t2"], lastActiveAt: 9_000 }] });
    const tabs = await call("tabs.query", { spaceId: SPACE });
    expect(tabs).toMatchObject({ ok: true, v: [{ id: "t1", lastActiveAt: 5_000 }, { id: "t2", lastActiveAt: 9_000 }] });
  });

  it("says whose it is: the person's unless main says Tidy gathered it and nobody has touched it since", async () => {
    const { h, call } = setup();
    // (A host that cannot say: every space is taken as the person's — nothing is filed on a guess.)
    expect(await call("spaces.list")).toMatchObject({ ok: true, v: [{ byPerson: true }] });
    h.browser.personsSpace = () => false;
    expect(await call("spaces.list")).toMatchObject({ ok: true, v: [{ byPerson: false }] });
    expect(await call("spaces.current")).toMatchObject({ ok: true, v: { id: SPACE, byPerson: false, lastActiveAt: 9_000 } });
  });

  it("takes a Home tab's space and a favorite's page's as the person's whatever main says", async () => {
    const { h, call } = setup();
    h.browser.personsSpace = () => false;
    const drawn = h.browser.spaces("profile-a")[0]!;
    h.browser.spaces = () => [{ ...drawn, id: "loose", loose: true }, { ...drawn, id: "page", anchorId: "favorite-1" }, drawn];
    const reply = await call("spaces.list");
    if (!reply.ok) throw new Error(reply.message);
    expect((reply.v as { id: string; byPerson: boolean }[]).map((space) => [space.id, space.byPerson])).toEqual([["loose", true], ["page", true], [SPACE, false]]);
  });
});

describe("closing a space, from an extension", () => {
  it("needs its own capability: sending spaces away is not closing them", async () => {
    const { call, closing } = setup({ capabilities: ["tabs:read", "spaces:write"] });
    const reply = await call("spaces.close", { spaceId: SPACE });
    expect(reply).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    if (!reply.ok) expect(reply.message).toContain("spaces:close");
    expect(closing.closed).toEqual([]);
    expect(CAPABILITY_INFO["spaces:close"]).toEqual({ tier: "medium", line: "Closes spaces into the archive, where they can be restored." });
  });

  it("closes a space the person gave it, under its own name, and writes nothing down while their command is in hand", async () => {
    const { h, call, closing } = setup();
    h.scope.beginInvocation(1, "profile-a", "bar", "tidy");
    expect(await call("spaces.close", { spaceId: SPACE })).toEqual({ ok: true, v: null });
    expect(closing.closed).toEqual([{ groupId: SPACE, by: { kind: "extension", extensionId: EXTENSION_ID, name: "Harness" } }]);
    expect(h.journal).toEqual([]);
  });

  it("is refused a space it was never given, the same whether it is here or not", async () => {
    const { call, closing } = setup({ spaces: [] });
    for (const spaceId of [SPACE, "nowhere"]) {
      const reply = await call("spaces.close", { spaceId });
      expect(reply, spaceId).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    }
    expect(closing.closed).toEqual([]);
  });

  it("says a space it holds that is not here is not here", async () => {
    const { call } = setup({ spaces: ["closed-long-ago"] });
    const reply = await call("spaces.close", { spaceId: "closed-long-ago" });
    expect(reply).toMatchObject({ ok: false, code: "NOT_FOUND" });
    if (!reply.ok) expect(reply.message).toContain(CLOSE_REFUSALS.unknown);
  });

  it("with nobody there: asked as unattended, written down with the archive's entry — the way back", async () => {
    const { h, call, closing } = setup();
    h.scope.beginInvocation(1, "profile-a", "trigger", "sweep");
    expect(await call("spaces.close", { spaceId: SPACE })).toEqual({ ok: true, v: null });
    expect(closing.closed[0]).toMatchObject({ groupId: SPACE, unattended: true });
    expect(closing.closed[0]?.absent).toBeUndefined();
    expect(h.journal).toEqual([{ trigger: "sweep", verb: "closeSpace", spaceId: SPACE, title: "Work", entryId: "entry-1" }]);
  });

  it("passes the verb's refusal on in its sentence, with what the author can do: let it out, and it is tried again", async () => {
    const { h, call, closing } = setup();
    h.scope.beginInvocation(1, "profile-a", "trigger", "sweep");
    closing.refuse = "inFront";
    const reply = await call("spaces.close", { spaceId: SPACE });
    expect(reply).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    if (!reply.ok) {
      expect(reply.message).toContain(CLOSE_REFUSALS.inFront);
      expect(reply.message).toContain("let the handler fail");
    }
    expect(h.journal).toEqual([]);
  });

  it("may close the space in front when main can see nobody is at the Mac", async () => {
    const { h, call, closing } = setup({ absent: () => true });
    h.scope.beginInvocation(1, "profile-a", "trigger", "sweep");
    await call("spaces.close", { spaceId: SPACE });
    expect(closing.closed[0]).toMatchObject({ unattended: true, absent: true });
  });

  it("is on the list of what may be done with nobody there, and the sheet says so by what is asked for", () => {
    expect(EXT_METHOD_NAMES).toContain("spaces.close");
    expect(EXT_UNATTENDED_METHODS).toContain("spaces.close");
    expect(runsLimit({ permissions: ["spaces:close"] })).toBe("With nobody there it can only close spaces you gave it into the archive. What it does to your spaces and tabs is listed, and can be undone.");
    expect(runsLimit({ permissions: ["spaces:write", "spaces:close"] })).toContain("send away, close and bring back spaces you gave it");
    expect(runsLimit({ permissions: ["spaces:close", "spaces:all"] })).toContain("close your spaces into the archive");
  });
});

describe("every space, on a line of its own", () => {
  it("is a High line that says what it is: any space, not only the ones the extension was run in", () => {
    expect(CAPABILITY_INFO["spaces:all"]).toEqual({ tier: "high", line: "Acts on any of your spaces, not only the ones you ran it in." });
    const sheet = sheetFor(manifestOf({ permissions: ["tabs:read", "spaces:close", "spaces:all"], ...WORKER }));
    // Broadest first: the sheet leads with it.
    expect(sheet.can[0]).toEqual({ tier: "high", text: "Acts on any of your spaces, not only the ones you ran it in." });
  });

  it("makes any drawn space of a Profile it is on in one it holds — and no other", async () => {
    const { h } = setup({ capabilities: ["tabs:read", "spaces:close", "spaces:all"], spaces: [], profiles: ["profile-a"] });
    expect(h.scope.holdsSpace(SPACE)).toBe(true);
    // Off in that Profile, a space there is not its to hold.
    expect(h.scope.holdsSpace("space-profile-b")).toBe(false);
    expect(h.scope.holdsSpace("nowhere")).toBe(false);
    const drawn = h.browser.spaces("profile-a")[0]!;
    h.browser.spaces = (profileId) => (profileId === "profile-a" ? [{ ...drawn, id: "loose", loose: true }, { ...drawn, id: "page", anchorId: "favorite-1" }, drawn] : []);
    // Never a Home tab's space or a favorite's page's: neither is a space to close or send.
    expect(h.scope.holdsSpace("loose")).toBe(false);
    expect(h.scope.holdsSpace("page")).toBe(false);
  });

  it("closes a space nobody ran it in, which without it is refused", async () => {
    const without = setup({ spaces: [] });
    expect(await without.call("spaces.close", { spaceId: SPACE })).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    const withAll = setup({ capabilities: ["tabs:read", "spaces:close", "spaces:all"], spaces: [] });
    expect(await withAll.call("spaces.close", { spaceId: SPACE })).toEqual({ ok: true, v: null });
    expect(withAll.closing.closed.map((closed) => closed.groupId)).toEqual([SPACE]);
  });

  it("grants nothing by itself: what may be done to a space is the other lines'", async () => {
    const { call } = setup({ capabilities: ["tabs:read", "spaces:all"], spaces: [] });
    expect(await call("spaces.close", { spaceId: SPACE })).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(await call("spaces.sendAway", { spaceId: SPACE })).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
  });

  it("is only a grant that was approved: a manifest that asks and a record that was not granted it holds nothing", () => {
    const h = harness({ manifest: manifestOf({ permissions: ["tabs:read", "spaces:close", "spaces:all"], ...WORKER }), record: recordOf({ capabilities: ["tabs:read", "spaces:close"] }), tabs: [tabOf("t1", "https://espn.com/")] });
    expect(h.scope.holdsSpace(SPACE)).toBe(false);
  });
});

describe("one question to a model", () => {
  it("needs its own capability, on a High line that says what leaves and what it costs", async () => {
    const { call } = setup();
    const reply = await call("ai.complete", { prompt: "Name these tabs" });
    expect(reply).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(CAPABILITY_INFO.ai).toEqual({ tier: "high", line: "Sends what it chooses to Pistachio's AI and reads the answer (spends your AI usage)." });
  });

  it("asks with the prompt, how to answer and a bound on the answer, and hands back its text", async () => {
    const { h, call } = setup({ capabilities: ["ai"], answer: "Lisbon trip" });
    expect(await call("ai.complete", { prompt: "Name these tabs: Flights, Hotels", system: "  One to four words.  ", maxTokens: 40 })).toEqual({ ok: true, v: { text: "Lisbon trip" } });
    // (No handler in hand: the whole of the time an answer may take, asked for the view that called.)
    expect(h.runtime.aiComplete).toHaveBeenCalledWith({ prompt: "Name these tabs: Flights, Hotels", system: "One to four words.", maxTokens: 40 }, { timeoutMs: AI_COMPLETE_TIMEOUT_MS, owner: h.ctx("worker").senderId });
    await call("ai.complete", { prompt: "Again" });
    expect(h.runtime.aiComplete).toHaveBeenLastCalledWith({ prompt: "Again", system: null, maxTokens: AI_TOKENS_DEFAULT }, { timeoutMs: AI_COMPLETE_TIMEOUT_MS, owner: h.ctx("worker").senderId });
  });

  it("waits no longer than the handler that asks has left: the answer, or UNAVAILABLE, comes while there is still time to act on it", async () => {
    const { h, call } = setup({ capabilities: ["ai"], answer: "Lisbon trip" });
    const timeoutOf = (): number => (h.runtime.aiComplete.mock.lastCall as [unknown, { timeoutMs: number }])[1].timeoutMs;
    // A trigger's handler has ten seconds: asked at once, the model has them less the time kept for acting on the answer.
    h.scope.beginInvocation(1, "profile-a", "trigger", "sweep");
    await call("ai.complete", { prompt: "q" });
    expect(timeoutOf()).toBe(EXT_HANDLER_TIMEOUTS.trigger - AI_HANDLER_MARGIN_MS);
    // Four seconds in, four seconds fewer.
    h.setNow(1_000_000 + 4_000);
    await call("ai.complete", { prompt: "q" });
    expect(timeoutOf()).toBe(EXT_HANDLER_TIMEOUTS.trigger - 4_000 - AI_HANDLER_MARGIN_MS);
    // With too little left to wait for any answer, nobody is asked: no usage spent, none of the hour's dozen, UNAVAILABLE at once.
    h.setNow(1_000_000 + EXT_HANDLER_TIMEOUTS.trigger - AI_HANDLER_MARGIN_MS - 200);
    const asked = h.runtime.aiComplete.mock.calls.length;
    const late = await call("ai.complete", { prompt: "q" });
    expect(late).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    if (!late.ok) expect(late.message).toContain("too little time left");
    expect(h.runtime.aiComplete.mock.calls.length).toBe(asked);
    // A longer handler of the person's in hand too, the longest wait any of them has is the bound — never past the model's own.
    h.scope.beginInvocation(2, "profile-a", "tool", "name");
    await call("ai.complete", { prompt: "q" });
    expect(timeoutOf()).toBe(AI_COMPLETE_TIMEOUT_MS);
    h.scope.endInvocation(2);
    h.scope.endInvocation(1);
    // A page or the panel asks for itself: no handler's time is its bound.
    h.scope.beginInvocation(3, "profile-a", "menu", "quick");
    await dispatch("ai.complete", { prompt: "q" }, h.scope, h.ctx("panel"), h.runtime);
    expect(timeoutOf()).toBe(AI_COMPLETE_TIMEOUT_MS);
  });

  it("notes on the ledger that it asked and how much it sent — never what", async () => {
    const { h, call } = setup({ capabilities: ["ai"], answer: "Lisbon trip" });
    await call("ai.complete", { prompt: "Name these tabs", system: "Short." });
    const [line] = h.ledger.lines();
    expect(line).toMatchObject({ method: "AI", host: "pistachio", path: "/complete", status: 200, sent: "Name these tabs".length + "Short.".length, received: "Lisbon trip".length });
    expect(JSON.stringify(line)).not.toContain("Name these tabs");
  });

  it("is UNAVAILABLE when no model can be asked, in words that say to have something to do without it", async () => {
    const { h, call } = setup({ capabilities: ["ai"], answer: null });
    const reply = await call("ai.complete", { prompt: "Name these tabs" });
    expect(reply).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    if (!reply.ok) expect(reply.message).toContain("without it");
    expect(h.ledger.lines()[0]).toMatchObject({ status: null, received: 0 });
  });

  it("refuses a prompt of no words, one too long, and a bound out of range", async () => {
    const { call } = setup({ capabilities: ["ai"] });
    for (const args of [{ prompt: "   " }, { prompt: "x".repeat(24_001) }, { prompt: "ok", system: "x".repeat(4_001) }, { prompt: "ok", maxTokens: 5 }, { prompt: "ok", maxTokens: 5_000 }, {}]) {
      expect(await call("ai.complete", args), JSON.stringify(args).slice(0, 40)).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    }
  });

  it("with nobody there, a dozen an hour at most — the person's own command is not held to it", async () => {
    const { h, call } = setup({ capabilities: ["ai"] });
    expect(EXT_UNATTENDED_METHODS).toContain("ai.complete");
    /** A trigger's handler begun now (each has its own ten seconds: one in hand for an hour would have no time left to wait). */
    const sweepAt = (at: number): void => {
      h.scope.endInvocation(1);
      h.setNow(at);
      h.scope.beginInvocation(1, "profile-a", "trigger", "sweep");
    };
    // (Spread over the hour: the method's own bucket is ten a minute, and it is the hour's dozen that is asked about.)
    for (let index = 0; index < AI_UNATTENDED_PER_HOUR; index += 1) {
      sweepAt(1_000_000 + index * 4 * 60_000);
      expect(await call("ai.complete", { prompt: "q" }), String(index)).toMatchObject({ ok: true });
    }
    sweepAt(1_000_000 + 50 * 60_000);
    const refused = await call("ai.complete", { prompt: "q" });
    expect(refused).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    if (!refused.ok) expect(refused.message).toContain("12 times an hour");
    // Their own command in hand, it is asked.
    h.scope.beginInvocation(2, "profile-a", "bar", "name");
    expect(await call("ai.complete", { prompt: "q" })).toMatchObject({ ok: true });
    h.scope.endInvocation(2);
    // And the hour passes.
    sweepAt(1_000_000 + 2 * 60 * 60_000);
    expect(await call("ai.complete", { prompt: "q" })).toMatchObject({ ok: true });
  });
});

describe("the model call itself", () => {
  it("is null on any failure — never a throw", async () => {
    const broken = { specificationVersion: "v3", provider: "test", modelId: "broken", supportedUrls: {}, doGenerate: vi.fn(async () => Promise.reject(new Error("offline"))), doStream: vi.fn() };
    expect(await completeWith(broken as never, { prompt: "q", system: null, maxTokens: 50 })).toBeNull();
  });

  /** A model that answers only when it is told to stop: what it was given to be stopped by, and whether it was. */
  function slowModel() {
    const seen: { signal: AbortSignal | undefined; aborted: boolean } = { signal: undefined, aborted: false };
    const doGenerate = vi.fn(
      (options: { abortSignal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          seen.signal = options.abortSignal;
          options.abortSignal?.addEventListener("abort", () => {
            seen.aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    return { seen, model: { specificationVersion: "v3", provider: "test", modelId: "slow", supportedUrls: {}, doGenerate, doStream: vi.fn() } };
  }

  it("stops waiting at the time it was given, and the request with it", async () => {
    const { seen, model } = slowModel();
    const began = Date.now();
    expect(await completeWith(model as never, { prompt: "q", system: null, maxTokens: 50 }, { timeoutMs: 40 })).toBeNull();
    expect(seen.aborted).toBe(true);
    expect(Date.now() - began).toBeLessThan(2_000);
  });

  it("stops at once when whoever asked is gone: the request does not run on for nobody", async () => {
    const { seen, model } = slowModel();
    const calls = new CompleteCalls();
    const mine = calls.begin(7);
    const theirs = calls.begin(8);
    const answer = completeWith(model as never, { prompt: "q", system: null, maxTokens: 50 }, { timeoutMs: 60_000, signal: mine.signal });
    await vi.waitFor(() => expect(seen.signal).toBeDefined());
    // The worker that asked stops (view 7): its question is dropped, another view's is not.
    calls.abortOwned(7);
    expect(await answer).toBeNull();
    expect(seen.aborted).toBe(true);
    expect(theirs.signal.aborted).toBe(false);
    expect(calls.size).toBe(1);
    // One that has been answered is nothing to stop; and saying a stopped one is done is harmless.
    theirs.done();
    calls.abortOwned(8);
    expect(theirs.signal.aborted).toBe(false);
    mine.done();
    expect(calls.size).toBe(0);
  });

  it("has a stand-in for specs only: answers by a fragment of the prompt, `*` for the rest, and nobody for a question none answers", async () => {
    expect(scriptedComplete({})).toBeNull();
    expect(scriptedComplete({ PISTACHIO_E2E_COMPLETE: '{"*":"x"}' })).toBeNull();
    expect(scriptedComplete({ PISTACHIO_E2E: "1" })).toBeNull();
    expect(scriptedComplete({ PISTACHIO_E2E: "1", PISTACHIO_E2E_COMPLETE: "not json" })).toBeNull();
    expect(scriptedComplete({ PISTACHIO_E2E: "1", PISTACHIO_E2E_COMPLETE: "[1]" })).toBeNull();
    const scripted = scriptedComplete({ PISTACHIO_E2E: "1", PISTACHIO_E2E_COMPLETE: JSON.stringify({ Flights: "Lisbon trip", "*": "Other" }) })!;
    expect(await scripted({ prompt: "Name: Flights, Hotels", system: null, maxTokens: 50 })).toBe("Lisbon trip");
    expect(await scripted({ prompt: "Name: Desk A", system: null, maxTokens: 50 })).toBe("Other");
    const narrow = scriptedComplete({ PISTACHIO_E2E: "1", PISTACHIO_E2E_COMPLETE: JSON.stringify({ Flights: "Lisbon trip" }) })!;
    expect(await narrow({ prompt: "Name: Desk A", system: null, maxTokens: 50 })).toBeNull();
  });
});
