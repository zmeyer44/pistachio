import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import type { EvidenceEntry } from "@pistachio/evidence";
import type { RunSummary, ThreadListItem } from "@pistachio/protocol";
import { describe, expect, it } from "vitest";
import { MAX_THREAD_TITLE, MAX_THREADS, ThreadStore, sanitizeThreadRecord, threadListItem, titleFor, type ThreadRecord } from "../src/main/thread-store";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "pistachio-threads-"));
}

/** A clock the test moves by hand. */
function clock(start = "2026-03-14T12:00:00.000Z") {
  let at = new Date(start);
  return {
    now: () => at,
    iso: () => at.toISOString(),
    advance(ms: number) {
      at = new Date(at.getTime() + ms);
    },
  };
}

const START = "2026-03-14T12:00:00.000Z";

function run(runId: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId,
    taskId: `task-${runId}`,
    status: "completed",
    purpose: `Purpose of ${runId}`,
    title: `Title ${runId}`,
    updatedAt: START,
    turns: 1,
    notes: "",
    context: { tokens: null, compactAt: 100_000, window: 200_000, compactions: 0, steps: 0, totalSteps: 0, usage: { inputTokens: 0, outputTokens: 0 } },
    humanTabId: "tab-1",
    agentTabId: null,
    startedAt: START,
    completedAt: START,
    control: "agent",
    pendingApproval: null,
    pendingQuestion: null,
    pendingTakeover: null,
    messages: [{ id: `${runId}-m1`, at: START, role: "user", content: `Purpose of ${runId}`, turn: 1 }],
    toolCalls: [],
    subagents: [],
    activity: [],
    result: null,
    ...overrides,
  };
}

const MODEL: ModelMessage[] = [
  { role: "user", content: "Open the cart" },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "page_inspect", input: { tabId: "tab-1" } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "page_inspect", output: { type: "json", value: { title: "Cart", url: "https://shop.test/cart" } } }] },
  { role: "assistant", content: [{ type: "text", text: "The cart has two items." }] },
];

function record(runId: string, overrides: Partial<RunSummary> = {}, model: ModelMessage[] = structuredClone(MODEL)): ThreadRecord {
  return { version: 1, run: run(runId, overrides), model };
}

function threadPath(dir: string, runId: string): string {
  return join(dir, "threads", `${runId}.json`);
}

function indexPath(dir: string): string {
  return join(dir, "threads", "threads.json");
}

describe("ThreadStore", () => {
  it("writes one file per thread plus an index, and reads them back whole", async () => {
    const dir = scratch();
    const store = new ThreadStore(dir);
    const saved = record("run-1", { notes: "- cart is tab-1", turns: 2 });
    store.save(saved);
    await store.flush();
    expect(existsSync(threadPath(dir, "run-1"))).toBe(true);
    expect(JSON.parse(readFileSync(indexPath(dir), "utf8"))).toEqual({ version: 1, threads: [threadListItem(saved.run)] });

    const reopened = new ThreadStore(dir);
    expect(reopened.list()).toEqual([
      { runId: "run-1", title: "Title run-1", status: "completed", startedAt: START, updatedAt: START, turns: 2, messageCount: 1 },
    ]);
    const loaded = reopened.get("run-1");
    expect(loaded).toEqual({ ...saved, evidence: [], learnedThrough: 0 });
    expect(loaded?.model).toEqual(MODEL);
    expect(reopened.get("missing")).toBeNull();
    expect(reopened.get("../etc/passwd")).toBeNull();
  });

  it("debounces writes but answers reads from the pending record", async () => {
    const dir = scratch();
    const store = new ThreadStore(dir);
    store.save(record("run-1", { notes: "first" }));
    expect(existsSync(threadPath(dir, "run-1"))).toBe(false);
    expect(store.get("run-1")?.run.notes).toBe("first");
    expect(store.list().map((item) => item.runId)).toEqual(["run-1"]);
    store.save(record("run-1", { notes: "second" }));
    expect(store.get("run-1")?.run.notes).toBe("second");
    expect(existsSync(threadPath(dir, "run-1"))).toBe(false);
    await store.flush();
    expect(existsSync(threadPath(dir, "run-1"))).toBe(true);
    expect((JSON.parse(readFileSync(threadPath(dir, "run-1"), "utf8")) as ThreadRecord).run.notes).toBe("second");
    // A second flush with nothing pending is a no-op.
    await store.flush();
    expect(new ThreadStore(dir).get("run-1")?.run.notes).toBe("second");
  });

  it("keeps the pending record isolated from later mutation", () => {
    const store = new ThreadStore(scratch());
    const saved = record("run-1");
    store.save(saved);
    saved.run.notes = "mutated after save";
    saved.model.push({ role: "user", content: "extra" });
    expect(store.get("run-1")?.run.notes).toBe("");
    expect(store.get("run-1")?.model).toHaveLength(MODEL.length);
  });

  it("switching to another thread flushes the one pending", () => {
    const dir = scratch();
    const store = new ThreadStore(dir);
    store.save(record("run-1"));
    store.save(record("run-2"));
    expect(existsSync(threadPath(dir, "run-1"))).toBe(true);
    expect(existsSync(threadPath(dir, "run-2"))).toBe(false);
    store.saveNow(record("run-2", { notes: "now" }));
    expect(existsSync(threadPath(dir, "run-2"))).toBe(true);
    expect(new ThreadStore(dir).get("run-2")?.run.notes).toBe("now");
  });

  it("lists newest first and lifts a touched thread to the top", () => {
    const time = clock();
    const dir = scratch();
    const store = new ThreadStore(dir, { now: time.now });
    store.saveNow(record("run-a", { startedAt: time.iso(), updatedAt: time.iso() }));
    time.advance(1_000);
    store.saveNow(record("run-b", { startedAt: time.iso(), updatedAt: time.iso() }));
    expect(store.list().map((item) => item.runId)).toEqual(["run-b", "run-a"]);
    expect(store.latest()?.run.runId).toBe("run-b");

    time.advance(1_000);
    store.saveNow(record("run-a", { startedAt: START, updatedAt: time.iso(), turns: 2 }));
    expect(store.list().map((item) => item.runId)).toEqual(["run-a", "run-b"]);
    expect(store.list()[0]).toMatchObject({ runId: "run-a", turns: 2, updatedAt: time.iso() });
    expect(store.latest()?.run.runId).toBe("run-a");
    expect(store.latest()?.run.turns).toBe(2);
    // The order survives a restart, and an empty store has no latest.
    expect(new ThreadStore(dir).list().map((item) => item.runId)).toEqual(["run-a", "run-b"]);
    expect(new ThreadStore(scratch()).latest()).toBeNull();
  });

  it("removes a thread's file and its index entry", async () => {
    const dir = scratch();
    const store = new ThreadStore(dir);
    store.saveNow(record("run-1"));
    store.saveNow(record("run-2"));
    expect(store.remove("run-1")).toBe(true);
    expect(existsSync(threadPath(dir, "run-1"))).toBe(false);
    expect(store.get("run-1")).toBeNull();
    expect(store.list().map((item) => item.runId)).toEqual(["run-2"]);
    expect(JSON.parse(readFileSync(indexPath(dir), "utf8"))).toMatchObject({ threads: [{ runId: "run-2" }] });
    expect(store.remove("run-1")).toBe(false);
    expect(store.remove("bad id!")).toBe(false);
    expect(new ThreadStore(dir).list().map((item) => item.runId)).toEqual(["run-2"]);

    // Removing a thread that was only pending never writes it.
    store.save(record("run-3"));
    expect(store.remove("run-3")).toBe(true);
    expect(store.get("run-3")).toBeNull();
    await store.flush();
    expect(existsSync(threadPath(dir, "run-3"))).toBe(false);
  });

  it("keeps at most MAX_THREADS, dropping the oldest and its file", async () => {
    const time = clock();
    const dir = scratch();
    const store = new ThreadStore(dir, { now: time.now });
    expect(MAX_THREADS).toBe(200);
    for (let index = 0; index <= MAX_THREADS; index += 1) {
      store.save(record(`t-${String(index)}`, { startedAt: time.iso(), updatedAt: time.iso() }, []));
      time.advance(1_000);
    }
    await store.flush();
    const listed = store.list();
    expect(listed).toHaveLength(MAX_THREADS);
    expect(listed[0]?.runId).toBe(`t-${String(MAX_THREADS)}`);
    expect(listed.at(-1)?.runId).toBe("t-1");
    expect(existsSync(threadPath(dir, "t-0"))).toBe(false);
    expect(store.get("t-0")).toBeNull();
    expect(existsSync(threadPath(dir, "t-1"))).toBe(true);
    expect(new ThreadStore(dir).list()).toHaveLength(MAX_THREADS);
  });

  it("tells listeners the list on every save until unsubscribed", () => {
    const store = new ThreadStore(scratch());
    const seen: ThreadListItem[][] = [];
    const off = store.onChange((threads) => seen.push(threads));
    store.save(record("run-1"));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.map((item) => item.runId)).toEqual(["run-1"]);
    store.save(record("run-2"));
    expect(seen[1]?.map((item) => item.runId)).toEqual(["run-2", "run-1"]);
    // The listener's copy is its own.
    seen[1]?.pop();
    expect(store.list()).toHaveLength(2);
    off();
    store.save(record("run-3"));
    expect(seen).toHaveLength(2);
  });

  it("rebuilds the index from the directory when the index is unreadable", () => {
    const dir = scratch();
    const store = new ThreadStore(dir);
    store.saveNow(record("run-1", { updatedAt: "2026-03-14T12:00:00.000Z" }));
    store.saveNow(record("run-2", { updatedAt: "2026-03-14T12:05:00.000Z" }));
    writeFileSync(indexPath(dir), "{not json");
    const rebuilt = new ThreadStore(dir);
    expect(rebuilt.list().map((item) => item.runId)).toEqual(["run-2", "run-1"]);
    expect(rebuilt.get("run-1")?.run.runId).toBe("run-1");

    // A well-formed index of the wrong version is rebuilt too.
    writeFileSync(indexPath(dir), JSON.stringify({ version: 2, threads: [] }));
    expect(new ThreadStore(dir).list()).toHaveLength(2);

    // Garbage entries in a valid index are dropped, and the rest sorted.
    writeFileSync(
      indexPath(dir),
      JSON.stringify({
        version: 1,
        threads: [
          { runId: "run-1", status: "completed", startedAt: START, updatedAt: "2026-03-14T12:00:00.000Z" },
          { runId: "run-2", status: "completed", startedAt: START, updatedAt: "2026-03-14T12:05:00.000Z", title: "Two", turns: 3, messageCount: 4 },
          { runId: "bad id!", status: "completed", startedAt: START },
          { runId: "run-9", status: "nope", startedAt: START },
          { runId: "run-2", status: "completed", startedAt: START },
          "garbage",
        ],
      }),
    );
    expect(new ThreadStore(dir).list()).toEqual([
      { runId: "run-2", title: "Two", status: "completed", startedAt: START, updatedAt: "2026-03-14T12:05:00.000Z", turns: 3, messageCount: 4 },
      { runId: "run-1", title: "Conversation", status: "completed", startedAt: START, updatedAt: "2026-03-14T12:00:00.000Z", turns: 1, messageCount: 0 },
    ]);
  });

  it("skips a corrupt thread file", () => {
    const dir = scratch();
    const store = new ThreadStore(dir);
    store.saveNow(record("run-1"));
    writeFileSync(threadPath(dir, "run-2"), "{nope");
    writeFileSync(threadPath(dir, "run-3"), JSON.stringify({ version: 1, run: { runId: "run-3" } }));
    writeFileSync(join(dir, "threads", "notes.txt"), "not a thread");
    expect(store.get("run-2")).toBeNull();
    expect(store.get("run-3")).toBeNull();
    writeFileSync(indexPath(dir), "");
    const rebuilt = new ThreadStore(dir);
    expect(rebuilt.list().map((item) => item.runId)).toEqual(["run-1"]);
    expect(rebuilt.get("run-2")).toBeNull();
  });

  it("passes over a listed thread whose file cannot be read when asked for the latest", () => {
    const time = clock();
    const dir = scratch();
    const store = new ThreadStore(dir, { now: time.now });
    store.saveNow(record("run-old", { startedAt: time.iso(), updatedAt: time.iso() }));
    time.advance(1_000);
    store.saveNow(record("run-new", { startedAt: time.iso(), updatedAt: time.iso() }));
    expect(store.latest()?.run.runId).toBe("run-new");

    rmSync(threadPath(dir, "run-new"));
    expect(store.list().map((item) => item.runId)).toEqual(["run-new", "run-old"]);
    expect(store.latest()?.run.runId).toBe("run-old");
    // A corrupt file is passed over the same way, and a fresh store agrees.
    writeFileSync(threadPath(dir, "run-new"), "{nope");
    expect(store.latest()?.run.runId).toBe("run-old");
    expect(new ThreadStore(dir).latest()?.run.runId).toBe("run-old");
    // Nothing readable at all: no latest.
    rmSync(threadPath(dir, "run-old"));
    expect(store.latest()).toBeNull();
  });

  it("writes asynchronously on flush and serves the in-flight record until the bytes land", async () => {
    const dir = scratch();
    const store = new ThreadStore(dir);
    store.save(record("run-1", { notes: "in flight" }));
    const writing = store.flush();
    expect(writing).toBeInstanceOf(Promise);
    expect(existsSync(threadPath(dir, "run-1"))).toBe(false);
    expect(store.get("run-1")?.run.notes).toBe("in flight");
    expect(store.list().map((item) => item.runId)).toEqual(["run-1"]);

    await writing;
    expect((JSON.parse(readFileSync(threadPath(dir, "run-1"), "utf8")) as ThreadRecord).run.notes).toBe("in flight");
    expect(store.get("run-1")?.run.notes).toBe("in flight");
    await store.settled();
    expect(readdirSync(join(dir, "threads")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("flushSync writes at once, and an async write already under way never lands over it", async () => {
    const dir = scratch();
    const store = new ThreadStore(dir);
    store.save(record("run-1", { notes: "slow" }));
    void store.flush();
    // Let the queued write begin before the synchronous one overtakes it.
    await Promise.resolve();
    store.save(record("run-1", { notes: "newer" }));
    store.flushSync();
    expect((JSON.parse(readFileSync(threadPath(dir, "run-1"), "utf8")) as ThreadRecord).run.notes).toBe("newer");

    await store.settled();
    expect((JSON.parse(readFileSync(threadPath(dir, "run-1"), "utf8")) as ThreadRecord).run.notes).toBe("newer");
    expect(store.get("run-1")?.run.notes).toBe("newer");
    expect(readdirSync(join(dir, "threads")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("an async write queued in the same tick as a later flushSync never lands over it", async () => {
    const dir = scratch();
    const store = new ThreadStore(dir);
    store.save(record("run-1", { notes: "stale" }));
    void store.flush();
    // No await: the synchronous write happens before the queued one starts.
    store.save(record("run-1", { notes: "newer" }));
    store.flushSync();
    await store.settled();
    expect((JSON.parse(readFileSync(threadPath(dir, "run-1"), "utf8")) as ThreadRecord).run.notes).toBe("newer");
    expect(readdirSync(join(dir, "threads")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("a delete cancels a write already queued for that thread, so the file never comes back", async () => {
    const dir = scratch();
    const store = new ThreadStore(dir);
    store.save(record("run-1"));
    void store.flush();
    expect(store.remove("run-1")).toBe(true);
    await store.settled();
    expect(existsSync(threadPath(dir, "run-1"))).toBe(false);
    expect(store.get("run-1")).toBeNull();
    expect(new ThreadStore(dir).list()).toEqual([]);
    expect(readdirSync(join(dir, "threads")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("starts empty when there is no directory yet", () => {
    const dir = join(scratch(), "fresh");
    mkdirSync(dir);
    const store = new ThreadStore(dir);
    expect(store.list()).toEqual([]);
    expect(store.latest()).toBeNull();
    expect(store.get("run-1")).toBeNull();
    store.saveNow(record("run-1"));
    expect(existsSync(threadPath(dir, "run-1"))).toBe(true);
  });
});

describe("sanitizeThreadRecord", () => {
  it("rejects what is not a thread of ours", () => {
    expect(sanitizeThreadRecord("garbage")).toBeNull();
    expect(sanitizeThreadRecord(null)).toBeNull();
    expect(sanitizeThreadRecord([])).toBeNull();
    expect(sanitizeThreadRecord({})).toBeNull();
    expect(sanitizeThreadRecord({ version: 2, run: run("run-1"), model: [] })).toBeNull();
    expect(sanitizeThreadRecord({ version: 1, run: "run-1", model: [] })).toBeNull();
    const noRunId = run("run-1") as unknown as Record<string, unknown>;
    delete noRunId["runId"];
    expect(sanitizeThreadRecord({ version: 1, run: noRunId, model: [] })).toBeNull();
    expect(sanitizeThreadRecord({ version: 1, run: run("bad id!"), model: [] })).toBeNull();
    expect(sanitizeThreadRecord({ version: 1, run: run("x".repeat(65)), model: [] })).toBeNull();
    expect(sanitizeThreadRecord({ version: 1, run: { ...run("run-1"), status: "nope" }, model: [] })).toBeNull();
    expect(sanitizeThreadRecord({ version: 1, run: { ...run("run-1"), startedAt: "yesterday" }, model: [] })).toBeNull();
    expect(sanitizeThreadRecord({ version: 1, run: { ...run("run-1"), messages: "none" }, model: [] })).toBeNull();
    expect(sanitizeThreadRecord({ version: 1, run: { ...run("run-1"), toolCalls: null }, model: [] })).toBeNull();
    expect(sanitizeThreadRecord({ version: 1, run: { ...run("run-1"), activity: {} }, model: [] })).toBeNull();
  });

  it("accepts a whole record unchanged", () => {
    const whole = record("run-1", { notes: "n", turns: 3, origin: { kind: "reminder", reminderId: "r1", occurrenceId: "o1", title: "Daily", scheduledFor: START } });
    expect(sanitizeThreadRecord(JSON.parse(JSON.stringify(whole)))).toEqual({ ...whole, evidence: [], learnedThrough: 0 });
  });

  it("fills in the evidence and the learner's position when a record lacks them, and keeps them when it has them", () => {
    const bare = sanitizeThreadRecord({ version: 1, run: run("run-1"), model: [] });
    expect(bare?.evidence).toEqual([]);
    expect(bare?.learnedThrough).toBe(0);

    const evidence: EvidenceEntry[] = [
      {
        id: "e1",
        sequence: 1,
        runId: "run-1",
        at: START,
        type: "interaction.started",
        actor: { principal: "pistachio-browser-agent", sponsor: "local-user", task: "task-run-1" },
        payload: { tabId: "tab-1", purpose: "Purpose of run-1" },
        previousHash: "0".repeat(64),
        signer: { algorithm: "Ed25519", keyId: "k1", publicKey: "pk" },
        hash: "h1",
        signature: "s1",
      },
    ];
    const whole = sanitizeThreadRecord({ version: 1, run: run("run-1"), model: [], evidence, learnedThrough: 3 });
    expect(whole?.evidence).toEqual(evidence);
    expect(whole?.learnedThrough).toBe(3);

    // Bad values are treated like missing ones; a fraction is read as its integer part.
    const bad = sanitizeThreadRecord({ version: 1, run: run("run-1"), model: [], evidence: "none", learnedThrough: -2 });
    expect(bad?.evidence).toEqual([]);
    expect(bad?.learnedThrough).toBe(0);
    expect(sanitizeThreadRecord({ version: 1, run: run("run-1"), model: [], evidence: [evidence[0], "garbage", 4], learnedThrough: 2.9 })).toMatchObject({ evidence, learnedThrough: 2 });

    // And they round-trip through the store.
    const dir = scratch();
    new ThreadStore(dir).saveNow({ ...record("run-1"), evidence, learnedThrough: 3 });
    expect(new ThreadStore(dir).get("run-1")).toMatchObject({ evidence, learnedThrough: 3 });
  });

  it("repairs the fields an older record lacks", () => {
    const old = run("run-1", {
      purpose: "  Find   a\n table for   four tonight  ",
      messages: [
        { id: "m1", at: START, role: "user", content: "Find a table" },
        { id: "m2", at: START, role: "assistant", content: "Sure" },
        { id: "m3", at: START, role: "user", content: "For four" },
      ],
    }) as unknown as Record<string, unknown>;
    for (const key of ["title", "updatedAt", "turns", "notes", "context", "subagents", "pendingApproval", "pendingQuestion", "pendingTakeover", "result"]) delete old[key];
    const repaired = sanitizeThreadRecord({ version: 1, run: old, model: MODEL });
    expect(repaired).not.toBeNull();
    expect(repaired?.run).toMatchObject({
      runId: "run-1",
      title: "Find a table for four tonight",
      updatedAt: START,
      turns: 2,
      notes: "",
      subagents: [],
      context: { tokens: null, compactAt: 0, window: 0, compactions: 0, steps: 0, totalSteps: 0, usage: { inputTokens: 0, outputTokens: 0 } },
      pendingApproval: null,
      pendingQuestion: null,
      pendingTakeover: null,
      result: null,
    });
    expect(repaired?.model).toEqual(MODEL);
    // Bad values are treated like missing ones.
    const bad = sanitizeThreadRecord({ version: 1, run: { ...run("run-1"), title: "", updatedAt: "soon", turns: -1, notes: 7, context: "big", subagents: "none" }, model: "nope" });
    expect(bad?.run).toMatchObject({ title: "Purpose of run-1", updatedAt: START, turns: 1, notes: "", subagents: [] });
    expect(bad?.run.context.window).toBe(0);
    expect(bad?.model).toEqual([]);
    // No user message at all still counts as one turn.
    const empty = sanitizeThreadRecord({ version: 1, run: { ...run("run-1"), turns: undefined, messages: [] }, model: [] });
    expect(empty?.run.turns).toBe(1);
  });

  it("drops model messages that are not model messages and keeps the rest", () => {
    const repaired = sanitizeThreadRecord({
      version: 1,
      run: run("run-1"),
      model: [MODEL[0], "garbage", { role: "user" }, { role: "bogus", content: "x" }, MODEL[1], { role: "assistant", content: [{ type: "tool-call", toolCallId: "c9" }] }, MODEL[2], null, MODEL[3]],
    });
    expect(repaired?.model).toEqual(MODEL);
  });
});

describe("titleFor and threadListItem", () => {
  it("names a thread by its first request, flattened and cut to fit", () => {
    expect(titleFor("  Find   a\n\ntable  ")).toBe("Find a table");
    expect(titleFor("")).toBe("Conversation");
    expect(titleFor("   \n ")).toBe("Conversation");
    const long = titleFor(`${"word ".repeat(40)}end`);
    expect(long.length).toBe(MAX_THREAD_TITLE);
    expect(long.endsWith("…")).toBe(true);
    expect(long).not.toMatch(/\s…$/);
    expect(titleFor("x".repeat(MAX_THREAD_TITLE))).toBe("x".repeat(MAX_THREAD_TITLE));
  });

  it("reduces a run to what the list shows", () => {
    const origin = { kind: "reminder" as const, reminderId: "r1", occurrenceId: "o1", title: "Daily", scheduledFor: START };
    expect(threadListItem(run("run-1", { turns: 4 }))).toEqual({ runId: "run-1", title: "Title run-1", status: "completed", startedAt: START, updatedAt: START, turns: 4, messageCount: 1 });
    expect(threadListItem(run("run-1", { origin }))).toMatchObject({ origin });
    expect(threadListItem(run("run-1"))).not.toHaveProperty("origin");
  });
});

describe("leftover temporary files", () => {
  it("clears .tmp files a killed write left behind, and keeps the threads", () => {
    const dir = scratch();
    const threads = join(dir, "threads");
    mkdirSync(threads, { recursive: true });
    const store = new ThreadStore(dir);
    store.saveNow(record("run-1"));

    // What a process killed between writeFile and rename leaves.
    writeFileSync(join(threads, "run-1.json.7.tmp"), "{partial");
    writeFileSync(join(threads, "threads.json.1758000000000.tmp"), "{partial");
    expect(readdirSync(threads).filter((name) => name.endsWith(".tmp"))).toHaveLength(2);

    const reopened = new ThreadStore(dir);
    expect(readdirSync(threads).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(reopened.list().map((item) => item.runId)).toEqual(["run-1"]);
    expect(reopened.get("run-1")?.run.runId).toBe("run-1");
  });

  it("sweeps nothing when the thread directory does not exist yet", () => {
    const dir = scratch();
    expect(() => new ThreadStore(dir)).not.toThrow();
    expect(existsSync(join(dir, "threads"))).toBe(false);
  });
});

describe("the index is the store's own", () => {
  it("hands out entries a caller cannot edit the store through", () => {
    const dir = scratch();
    const store = new ThreadStore(dir);
    store.saveNow(record("run-1"));

    const [item] = store.list();
    expect(item).toBeDefined();
    // Frozen, so a stray write throws rather than quietly editing the index
    // and persisting the edit on the next write.
    expect(Object.isFrozen(item)).toBe(true);
    expect(() => {
      (item as { title: string }).title = "rewritten";
    }).toThrow();
    expect(store.list()[0]?.title).toBe("Title run-1");

    // The array itself is the caller's to do as it likes with.
    const list = store.list();
    list.length = 0;
    expect(store.list()).toHaveLength(1);
  });

  it("does not hand out a second handle on a live run's origin", () => {
    const origin = { kind: "reminder" as const, reminderId: "r1", occurrenceId: "o1", title: "Daily", scheduledFor: START };
    const live = run("run-1", { origin });
    const item = threadListItem(live);
    expect(item.origin).toEqual(origin);
    expect(item.origin).not.toBe(live.origin);
    expect(Object.isFrozen(item.origin)).toBe(true);
    expect(Object.isFrozen(live.origin)).toBe(false);
  });
});
