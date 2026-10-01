/**
 * A document window's file, loaded and saved (lib/desk/document-session.ts;
 * docs/desk-documents.md §3): a load that finishes late never replaces a
 * newer version on show, and an edit is never lost — not when its save is
 * refused and the window is put away, not when the desk passes to another
 * group while it waits. Also the pieces around it: which group a document
 * window's file is in, a mention accepted, a sheet's hidden columns.
 */

import { describe, expect, it } from "vitest";
import type { GroupContextFile, GroupContextView, GroupFileContent, GroupFileWriteResult } from "@pistachio/shell-contracts/desk-agent";
import { DocumentSession, forgetDrafts, type SessionIo, type SessionState } from "../src/lib/desk/document-session";
import { documentWindowIds, fileOf } from "../src/lib/desk/documents";
import { activeMention } from "../src/lib/desk/mentions";
import { nextVisibleColumn } from "../src/components/desk/files/grid-navigation";

const BLOB_A = "a".repeat(24);
const BLOB_B = "b".repeat(24);
const BLOB_C = "c".repeat(24);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function content(blobId: string, text: string): GroupFileContent {
  return { itemId: "0123456789ab", blobId, name: "plan.txt", mediaType: "text/plain", bytes: new TextEncoder().encode(text) };
}

function item(blobId: string): GroupContextFile {
  return { id: "0123456789ab", kind: "file", name: "plan.txt", mediaType: "text/plain", byteLength: 1, blobId, addedAt: "", addedBy: "person" };
}

/** A session over hand-driven io: loads and saves answer when the test says, timers run when it says. */
function harness(options: { groupId?: string } = {}) {
  const loads = new Map<string, ReturnType<typeof deferred<GroupFileContent | null>>>();
  const saves: Array<{ write: { baseBlobId: string; bytes: Uint8Array; force: boolean }; answer: ReturnType<typeof deferred<GroupFileWriteResult>> }> = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const io: SessionIo = {
    load: (blobId) => {
      const waiting = deferred<GroupFileContent | null>();
      loads.set(blobId, waiting);
      return waiting.promise;
    },
    save: (write) => {
      const answer = deferred<GroupFileWriteResult>();
      saves.push({ write, answer });
      return answer.promise;
    },
    setTimer: (run) => {
      const id = nextTimer++;
      timers.set(id, run);
      return id;
    },
    clearTimer: (id) => void timers.delete(id),
  };
  const states: SessionState[] = [];
  const session = new DocumentSession({ groupId: options.groupId ?? "g1", itemId: "0123456789ab" }, io, (state) => states.push(state));
  const runTimers = (): void => {
    const due = [...timers.values()];
    timers.clear();
    for (const run of due) run();
  };
  const flush = (): Promise<void> => new Promise((done) => setTimeout(done, 0));
  const shownText = (): string | null => {
    const shown = session.state.shown;
    return shown.state === "ready" ? new TextDecoder().decode(shown.content.bytes) : null;
  };
  return { session, loads, saves, runTimers, flush, shownText, states };
}

describe("a document window's file", () => {
  it("never shows a version that finished loading after a newer one", async () => {
    forgetDrafts();
    const { session, loads, saves, runTimers, flush, shownText } = harness();
    session.update(BLOB_A, true);
    // A synced version comes in while the first is still loading (a .doc being converted, say).
    session.update(BLOB_B, true);
    loads.get(BLOB_B)!.resolve(content(BLOB_B, "theirs"));
    await flush();
    loads.get(BLOB_A)!.resolve(content(BLOB_A, "old"));
    await flush();
    expect(shownText()).toBe("theirs");
    // An edit now goes over the version on show.
    session.edit(() => new TextEncoder().encode("mine"));
    runTimers();
    await flush();
    expect(saves[0]?.write.baseBlobId).toBe(BLOB_B);
  });

  it("keeps an edit whose save was refused past its window, and shows it again, conflict and all", async () => {
    forgetDrafts();
    const first = harness();
    first.session.update(BLOB_A, true);
    first.loads.get(BLOB_A)!.resolve(content(BLOB_A, "stored"));
    await first.flush();
    first.session.edit(() => new TextEncoder().encode("my edit"));
    // Put away before the save goes, and the save is refused: the file changed elsewhere.
    first.session.dispose();
    await first.flush();
    expect(first.saves).toHaveLength(1);
    first.saves[0]!.answer.resolve({ ok: false, reason: "changed", message: "changed elsewhere" });
    await first.flush();

    // Opened again: the stored version is B now, and the edit is still there, asking.
    const second = harness();
    second.session.update(BLOB_B, true);
    second.loads.get(BLOB_B)!.resolve(content(BLOB_B, "theirs"));
    await second.flush();
    expect(second.shownText()).toBe("my edit");
    expect(second.session.state.conflict).not.toBeNull();
    // Kept: written over theirs.
    void second.session.saveNow(true);
    await second.flush();
    expect(second.saves[0]?.write).toMatchObject({ baseBlobId: BLOB_A, force: true });
    expect(new TextDecoder().decode(second.saves[0]!.write.bytes)).toBe("my edit");
    second.saves[0]!.answer.resolve({ ok: true, item: item(BLOB_C) });
    await second.flush();
    expect(second.session.state.conflict).toBeNull();

    // Saved: a third opening shows the file as stored, no draft left.
    const third = harness();
    third.session.update(BLOB_C, true);
    third.loads.get(BLOB_C)!.resolve(content(BLOB_C, "my edit"));
    await third.flush();
    expect(third.session.state.conflict).toBeNull();
    expect(third.session.state.save).toBe("clean");
  });

  it("keeps a newer edit made while a save was under way, when the window goes before it lands", async () => {
    forgetDrafts();
    const first = harness();
    first.session.update(BLOB_A, true);
    first.loads.get(BLOB_A)!.resolve(content(BLOB_A, "stored"));
    await first.flush();
    first.session.edit(() => new TextEncoder().encode("first edit"));
    first.runTimers();
    await first.flush();
    expect(first.saves).toHaveLength(1);
    // Typed on while it saves, then put away before the save lands.
    first.session.edit(() => new TextEncoder().encode("first edit, then more"));
    first.session.dispose();
    await first.flush();
    // The window's write waits for the save under way: nothing goes over the old version meanwhile.
    expect(first.saves).toHaveLength(1);
    first.saves[0]!.answer.resolve({ ok: true, item: item(BLOB_B) });
    await first.flush();
    // Then it goes, over the version that save made.
    expect(first.saves).toHaveLength(2);
    expect(first.saves[1]!.write.baseBlobId).toBe(BLOB_B);
    expect(new TextDecoder().decode(first.saves[1]!.write.bytes)).toBe("first edit, then more");
    // Refused (another Mac got in between): the newer edit is kept, not the first one's success's to clear.
    first.saves[1]!.answer.resolve({ ok: false, reason: "changed", message: "changed elsewhere" });
    await first.flush();
    const second = harness();
    second.session.update(BLOB_C, true);
    second.loads.get(BLOB_C)!.resolve(content(BLOB_C, "theirs"));
    await second.flush();
    expect(second.shownText()).toBe("first edit, then more");
    expect(second.session.state.conflict).not.toBeNull();
  });

  it("gives up a kept edit when the person loads theirs", async () => {
    forgetDrafts();
    const first = harness();
    first.session.update(BLOB_A, true);
    first.loads.get(BLOB_A)!.resolve(content(BLOB_A, "stored"));
    await first.flush();
    first.session.edit(() => new TextEncoder().encode("my edit"));
    first.session.dispose();
    await first.flush();
    first.saves[0]!.answer.resolve({ ok: false, reason: "changed", message: "changed elsewhere" });
    await first.flush();
    const second = harness();
    second.session.update(BLOB_B, true);
    second.loads.get(BLOB_B)!.resolve(content(BLOB_B, "theirs"));
    await second.flush();
    second.session.loadTheirs();
    second.loads.get(BLOB_B)!.resolve(content(BLOB_B, "theirs"));
    await second.flush();
    expect(second.shownText()).toBe("theirs");
    expect(second.session.state.conflict).toBeNull();
  });

  it("saves an edit into its own group's file even once the file is no longer in view (the desk passed to another group)", async () => {
    forgetDrafts();
    const { session, loads, saves, flush } = harness({ groupId: "g1" });
    session.update(BLOB_A, true);
    loads.get(BLOB_A)!.resolve(content(BLOB_A, "stored"));
    await flush();
    session.edit(() => new TextEncoder().encode("edited"));
    // The window's file is not in the group on show: nothing to update it with.
    session.update(null, false);
    session.dispose();
    await flush();
    expect(saves).toHaveLength(1);
    expect(new TextDecoder().decode(saves[0]!.write.bytes)).toBe("edited");
  });
});

describe("which group a document window's file is in", () => {
  const context = (groupId: string, ids: string[]): GroupContextView => ({
    groupId,
    title: groupId,
    updatedAt: "",
    items: ids.map((id) => ({ ...item(BLOB_A), id, here: true })),
  });

  it("is the one whose context holds it, whichever group the desk shows", () => {
    const contexts = [context("g1", ["aaaaaaaaaaaa"]), context("g2", ["bbbbbbbbbbbb"])];
    expect(fileOf(contexts, "aaaaaaaaaaaa")?.groupId).toBe("g1");
    expect(fileOf(contexts, "bbbbbbbbbbbb")?.groupId).toBe("g2");
    expect(fileOf(contexts, "cccccccccccc")).toBeNull();
    expect(documentWindowIds(contexts[0])).toEqual(["file:aaaaaaaaaaaa"]);
  });
});

describe("a mention accepted", () => {
  it("is no longer being typed: the list does not offer it again", () => {
    const names = ["notes.md", "Boarding pass.pdf"];
    expect(activeMention("Look at @notes.md ", 18, names, null)).toBeNull();
    expect(activeMention("@Boarding pass.pdf and", 22, names, null)).toBeNull();
    expect(activeMention("Look at @not", 12, names, null)).toEqual({ start: 8, query: "not" });
    expect(activeMention("@Boarding pa", 12, names, null)).toEqual({ start: 0, query: "Boarding pa" });
    // A name inside a longer one: still being typed.
    expect(activeMention("@Plan B", 7, ["Plan", "Plan B.pdf"], null)).toEqual({ start: 0, query: "Plan B" });
    expect(activeMention("@Plan B.pdf ", 12, ["Plan", "Plan B.pdf"], null)).toBeNull();
    // Dismissed with Escape: that mention stays closed, a new one opens.
    expect(activeMention("@no", 3, names, 0)).toBeNull();
    expect(activeMention("@notes.md @b", 12, names, 0)).toEqual({ start: 10, query: "b" });
  });
});

describe("a sheet's hidden columns", () => {
  it("are skipped in the direction of travel", () => {
    const hidden = new Set([1]);
    expect(nextVisibleColumn(2, -1, hidden, 5)).toBe(0);
    expect(nextVisibleColumn(0, 1, hidden, 5)).toBe(2);
    expect(nextVisibleColumn(0, -1, hidden, 5)).toBe(0);
    expect(nextVisibleColumn(3, 1, new Set([4]), 5)).toBe(3);
    expect(nextVisibleColumn(0, 99, new Set([4]), 5)).toBe(3);
  });
});
