/** net.fetch's bounded body (main/extensions/net.ts): read as it comes, refused and cancelled past the limit. */
import { describe, expect, it } from "vitest";
import { readBodyAtMost } from "../src/main/extensions/net";

/** A body of `count` chunks of four bytes, counting its pulls and whether it was cancelled. */
function body(count: number) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= count) {
        controller.close();
        return;
      }
      state.pulled += 1;
      controller.enqueue(new Uint8Array([state.pulled, 0, 0, 0]));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

describe("a bounded body", () => {
  it("is read whole within the limit, and an absent one is empty", async () => {
    const { stream, state } = body(3);
    expect([...((await readBodyAtMost(stream, 20)) ?? [])]).toEqual([1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0]);
    expect(state.cancelled).toBe(false);
    expect([...((await readBodyAtMost(null, 20)) ?? [255])]).toEqual([]);
  });

  it("is refused and cancelled as soon as it runs past the limit, however long it claims to be", async () => {
    const { stream, state } = body(1000);
    expect(await readBodyAtMost(stream, 10)).toBeNull();
    expect(state.cancelled).toBe(true);
    // Three chunks were enough to know; the rest was never pulled.
    expect(state.pulled).toBeLessThanOrEqual(4);
  });
});
