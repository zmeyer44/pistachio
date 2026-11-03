/** The panel's preview streams (src/panel/previews.ts): one at a time, and none kept past a stop. */
import { describe, expect, it } from "vitest";
import { PreviewSlot } from "../src/panel/previews.js";

function fakeStream() {
  const stopped: boolean[] = [];
  const tracks = [{ stop: () => void stopped.push(true) }];
  return { stream: { getTracks: () => tracks }, stopped };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("a preview slot", () => {
  it("keeps the stream it opened while wanted, and stops it on stop", async () => {
    const slot = new PreviewSlot<{ getTracks(): { stop(): void }[] }>();
    const a = fakeStream();
    expect(await slot.open(async () => a.stream, () => true)).toBe(a.stream);
    expect(slot.stream).toBe(a.stream);
    slot.stop();
    expect(a.stopped).toEqual([true]);
    expect(slot.stream).toBeNull();
  });

  it("stops a stream that arrives after a stop, or one no longer wanted, as it arrives", async () => {
    const slot = new PreviewSlot<{ getTracks(): { stop(): void }[] }>();
    const late = deferred<ReturnType<typeof fakeStream>["stream"]>();
    const pending = slot.open(() => late.promise, () => true);
    // The panel closed meanwhile.
    slot.stop();
    const a = fakeStream();
    late.resolve(a.stream);
    expect(await pending).toBeNull();
    expect(a.stopped).toEqual([true]);
    expect(slot.stream).toBeNull();
    // Not wanted by the time it came (the mic turned off while it opened).
    const b = fakeStream();
    expect(await slot.open(async () => b.stream, () => false)).toBeNull();
    expect(b.stopped).toEqual([true]);
  });

  it("opening again stops what was open, and an earlier open that lands later is stopped, not kept", async () => {
    const slot = new PreviewSlot<{ getTracks(): { stop(): void }[] }>();
    const first = deferred<ReturnType<typeof fakeStream>["stream"]>();
    const firstOpen = slot.open(() => first.promise, () => true);
    const b = fakeStream();
    expect(await slot.open(async () => b.stream, () => true)).toBe(b.stream);
    const a = fakeStream();
    first.resolve(a.stream);
    expect(await firstOpen).toBeNull();
    expect(a.stopped).toEqual([true]);
    expect(b.stopped).toEqual([]);
    expect(slot.stream).toBe(b.stream);
    // A start that fails leaves nothing.
    const failing = deferred<ReturnType<typeof fakeStream>["stream"]>();
    const failed = slot.open(() => failing.promise, () => true);
    failing.reject(new Error("no device"));
    expect(await failed).toBeNull();
    expect(b.stopped).toEqual([true]);
  });
});
