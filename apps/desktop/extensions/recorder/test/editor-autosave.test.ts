import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutosave } from "../src/editor/autosave.js";

describe("the autosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes once, 500 ms after the last change, the latest text", async () => {
    const writes: string[] = [];
    const save = createAutosave(async (text) => void writes.push(text));
    save.schedule("a");
    await vi.advanceTimersByTimeAsync(300);
    save.schedule("b");
    await vi.advanceTimersByTimeAsync(300);
    save.schedule("c");
    expect(writes).toEqual([]);
    expect(save.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(writes).toEqual(["c"]);
    expect(save.pending).toBe(false);
  });

  it("settles when an edit undone within the delay brings the text back to what was written", async () => {
    const writes: string[] = [];
    const saved = vi.fn();
    const save = createAutosave(async (text) => void writes.push(text), { onSaved: saved });
    save.schedule("a");
    await save.flush();
    expect(writes).toEqual(["a"]);
    save.schedule("b");
    save.schedule("a");
    expect(save.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(writes).toEqual(["a"]);
    expect(save.pending).toBe(false);
    expect(saved).toHaveBeenCalledTimes(2);
  });

  it("flushes now, and never writes the same text twice", async () => {
    const writes: string[] = [];
    const save = createAutosave(async (text) => void writes.push(text));
    save.schedule("a");
    await save.flush();
    expect(writes).toEqual(["a"]);
    save.schedule("a");
    await vi.advanceTimersByTimeAsync(600);
    await save.flush();
    expect(writes).toEqual(["a"]);
  });

  it("keeps writes in order and reports a failure, then saves the next change", async () => {
    const writes: string[] = [];
    const errors: unknown[] = [];
    let fail = true;
    const save = createAutosave(
      async (text) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (fail) throw new Error("disk full");
        writes.push(text);
      },
      { onError: (error) => errors.push(error) },
    );
    save.schedule("a");
    await vi.advanceTimersByTimeAsync(600);
    expect(errors).toHaveLength(1);
    expect(save.pending).toBe(true);
    fail = false;
    save.schedule("b");
    await vi.advanceTimersByTimeAsync(520);
    save.schedule("c");
    await vi.advanceTimersByTimeAsync(600);
    expect(writes).toEqual(["b", "c"]);
  });
});
