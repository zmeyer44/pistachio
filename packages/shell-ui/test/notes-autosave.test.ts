/**
 * The editor's autosave (docs/notes.md §5): idle debounce, changed fields
 * only, last-writer-wins against another device, and a refusal that backs off
 * without ever stopping the typing.
 */

import { describe, expect, it } from "vitest";
import {
  autosave,
  createAutosave,
  nextAction,
  noteStamp,
  NOTE_IDLE_MS,
  NOTE_RETRY_CAP_MS,
  pendingPatch,
  retryDelay,
  saveState,
  type AutosaveState,
  type NoteSaved,
} from "../src/lib/notes-autosave";

const NOTE: NoteSaved = { revision: 3, stamp: "3@t3", title: "Pie", markdown: "Sour cherries.\n" };

/** What the host answers a save with: what it holds, at the next revision. */
function held(revision: number, draft: Partial<{ title: string; markdown: string }> = {}): NoteSaved {
  return { revision, stamp: `${String(revision)}@t${String(revision)}`, title: NOTE.title, markdown: NOTE.markdown, ...draft };
}

function edited(at: number, draft: Partial<{ title: string; markdown: string }>): AutosaveState {
  return autosave(createAutosave(NOTE), { type: "edit", draft, at });
}

describe("a version's name", () => {
  it("is its revision and its clock together", () => {
    expect(noteStamp({ revision: 2, updatedAt: "2026-09-23T10:00:00.000Z" })).toBe("2@2026-09-23T10:00:00.000Z");
  });
});

describe("idle debounce", () => {
  it("does nothing until the typing stops", () => {
    const state = edited(1_000, { markdown: "Sour cherries, a lattice top.\n" });
    expect(state.dirty).toBe(true);
    expect(nextAction(state, 1_000)).toEqual({ type: "wait", ms: NOTE_IDLE_MS });
    expect(nextAction(state, 1_400)).toEqual({ type: "wait", ms: 200 });
    expect(nextAction(state, 1_600)).toMatchObject({ type: "flush" });
  });

  it("re-arms on every keystroke, so a fast typist writes once", () => {
    let state = edited(1_000, { markdown: "a" });
    state = autosave(state, { type: "edit", draft: { markdown: "ab" }, at: 1_400 });
    expect(nextAction(state, 1_601)).toEqual({ type: "wait", ms: 399 });
    expect(nextAction(state, 2_000)).toMatchObject({ type: "flush" });
  });

  it("goes at once when the page is leaving", () => {
    const state = autosave(edited(1_000, { title: "Pies" }), { type: "flushNow", at: 1_050 });
    expect(nextAction(state, 1_050)).toMatchObject({ type: "flush", patch: { title: "Pies" } });
  });

  it("typing back to what was saved is not a write", () => {
    let state = edited(1_000, { title: "Pies" });
    state = autosave(state, { type: "edit", draft: { title: "Pie" }, at: 1_100 });
    expect(state.dirty).toBe(false);
    expect(nextAction(state, 9_000)).toEqual({ type: "idle" });
  });
});

describe("the flush carries only what changed", () => {
  it("sends the title alone when only the title moved", () => {
    expect(pendingPatch(edited(0, { title: "Cherry pie" }))).toEqual({ title: "Cherry pie" });
  });

  it("sends both when both moved", () => {
    const state = autosave(edited(0, { title: "Cherry pie" }), { type: "edit", draft: { markdown: "x" }, at: 10 });
    expect(pendingPatch(state)).toEqual({ title: "Cherry pie", markdown: "x" });
  });

  it("holds one write at a time", () => {
    let state = autosave(edited(0, { markdown: "x" }), { type: "sending", at: 600 });
    expect(nextAction(state, 10_000)).toEqual({ type: "idle" });
    // Typing during the flight is kept and written by the next cycle.
    state = autosave(state, { type: "edit", draft: { markdown: "xy" }, at: 700 });
    expect(nextAction(state, 10_000)).toEqual({ type: "idle" });
    state = autosave(state, { type: "saved", note: held(4, { markdown: "x" }), at: 800 });
    expect(state.saved).toEqual(held(4, { markdown: "x" }));
    expect(state.dirty).toBe(true);
    expect(nextAction(state, 1_500)).toMatchObject({ type: "flush", patch: { markdown: "xy" } });
  });

  it("is clean once the answer matches what is on screen", () => {
    let state = autosave(edited(0, { markdown: "x" }), { type: "sending", at: 600 });
    state = autosave(state, { type: "saved", note: held(4, { markdown: "x" }), at: 700 });
    expect(state.dirty).toBe(false);
    expect(saveState(state)).toBe("saved");
    expect(nextAction(state, 10_000)).toEqual({ type: "idle" });
  });
});

describe("another device", () => {
  it("fetches a version that is not ours while the editor is clean", () => {
    const state = autosave(createAutosave(NOTE), { type: "remote", stamp: "5@t5", at: 0 });
    expect(nextAction(state, 0)).toEqual({ type: "fetch", stamp: "5@t5" });
  });

  it("ignores the version we hold", () => {
    const state = autosave(createAutosave(NOTE), { type: "remote", stamp: NOTE.stamp, at: 0 });
    expect(state.pendingRemote).toBe(null);
    expect(nextAction(state, 0)).toEqual({ type: "idle" });
  });

  it("tells another device's revision from ours by its clock, not its number", () => {
    // Both devices bumped 1 → 2; the sync lane kept theirs. Same revision,
    // different version: the editor must not sit on its own stale body.
    let state = autosave(edited(0, { markdown: "mine" }), { type: "sending", at: 600 });
    state = autosave(state, { type: "saved", note: held(4, { markdown: "mine" }), at: 700 });
    state = autosave(state, { type: "remote", stamp: "4@elsewhere", at: 800 });
    expect(nextAction(state, 800)).toEqual({ type: "fetch", stamp: "4@elsewhere" });
  });

  it("adopts a body the host merged under a title-only save", () => {
    // We changed the title; the body moved elsewhere while our save flew.
    let state = autosave(edited(0, { title: "Cherry pie" }), { type: "sending", at: 600 });
    state = autosave(state, { type: "saved", note: held(4, { title: "Cherry pie", markdown: "theirs" }), at: 700 });
    expect(state.local.markdown).toBe("theirs");
    expect(state.dirty).toBe(false);
    expect(nextAction(state, 10_000)).toEqual({ type: "idle" });
  });

  it("keeps a body the person typed into while the title-only save flew", () => {
    let state = autosave(edited(0, { title: "Cherry pie" }), { type: "sending", at: 600 });
    state = autosave(state, { type: "edit", draft: { markdown: "mine, newer" }, at: 650 });
    state = autosave(state, { type: "saved", note: held(4, { title: "Cherry pie", markdown: "theirs" }), at: 700 });
    expect(state.local.markdown).toBe("mine, newer");
    expect(state.dirty).toBe(true);
    expect(nextAction(state, 1_500)).toMatchObject({ type: "flush", patch: { markdown: "mine, newer" } });
  });

  it("defers while dirty, and our own write settles it (N5)", () => {
    let state = edited(1_000, { markdown: "mine" });
    state = autosave(state, { type: "remote", stamp: "5@t5", at: 1_100 });
    // The person's typing wins the turn: the flush goes first.
    expect(nextAction(state, 1_700)).toMatchObject({ type: "flush" });
    state = autosave(state, { type: "sending", at: 1_700 });
    // The host has folded the remote version in; our write is what it holds now.
    state = autosave(state, { type: "remote", stamp: "6@t6", at: 1_750 });
    state = autosave(state, { type: "saved", note: held(6, { markdown: "mine" }), at: 1_800 });
    expect(state.pendingRemote).toBe(null);
    expect(nextAction(state, 1_800)).toEqual({ type: "idle" });
  });

  it("reads a version that landed while our write was in the air", () => {
    let state = edited(1_000, { markdown: "mine" });
    state = autosave(state, { type: "sending", at: 1_700 });
    state = autosave(state, { type: "saved", note: held(6, { markdown: "mine" }), at: 1_800 });
    state = autosave(state, { type: "remote", stamp: "9@t9", at: 1_810 });
    expect(nextAction(state, 1_810)).toEqual({ type: "fetch", stamp: "9@t9" });
  });

  it("adopting replaces both sides and leaves nothing to write", () => {
    let state = autosave(createAutosave(NOTE), { type: "remote", stamp: "5@t5", at: 0 });
    state = autosave(state, { type: "adopt", note: held(5, { markdown: "theirs" }) });
    expect(state.local.markdown).toBe("theirs");
    expect(state.dirty).toBe(false);
    expect(nextAction(state, 0)).toEqual({ type: "idle" });
  });
});

describe("a host that refuses", () => {
  it("backs off 1s, 2s, 4s … to a cap", () => {
    expect(retryDelay(1)).toBe(1_000);
    expect(retryDelay(2)).toBe(2_000);
    expect(retryDelay(3)).toBe(4_000);
    expect(retryDelay(20)).toBe(NOTE_RETRY_CAP_MS);
  });

  it("stays dirty, says so, and asks again later", () => {
    let state = autosave(edited(0, { markdown: "x" }), { type: "sending", at: 600 });
    state = autosave(state, { type: "failed", at: 700 });
    expect(state.error).toBe(true);
    expect(state.dirty).toBe(true);
    expect(saveState(state)).toBe("retrying");
    expect(nextAction(state, 700)).toEqual({ type: "wait", ms: 1_000 });
    expect(nextAction(state, 1_700)).toMatchObject({ type: "flush" });
  });

  it("does not let typing turn a backoff into a request per keystroke", () => {
    let state = autosave(edited(0, { markdown: "x" }), { type: "sending", at: 600 });
    state = autosave(state, { type: "failed", at: 700 });
    state = autosave(state, { type: "edit", draft: { markdown: "xy" }, at: 800 });
    // 800 + 600 idle is earlier than the 1,700 backoff; the backoff holds.
    expect(nextAction(state, 1_400)).toEqual({ type: "wait", ms: 300 });
  });

  it("clears the badge as soon as one write lands", () => {
    let state = autosave(edited(0, { markdown: "x" }), { type: "sending", at: 600 });
    state = autosave(state, { type: "failed", at: 700 });
    state = autosave(state, { type: "sending", at: 1_700 });
    state = autosave(state, { type: "saved", note: held(4, { markdown: "x" }), at: 1_800 });
    expect(state.error).toBe(false);
    expect(state.retry).toBe(0);
    expect(saveState(state)).toBe("saved");
  });
});
