import { describe, expect, it } from "vitest";
import { share } from "../src/lib/share";

describe("share", () => {
  it("returns the previous value when the next is deep-equal", () => {
    const previous = { tabs: [{ id: "a", title: "A" }], run: null, nested: { list: [1, 2] } };
    const next = structuredClone(previous);
    expect(next).not.toBe(previous);
    expect(share(previous, next)).toBe(previous);
  });

  it("keeps unchanged siblings by reference when one item changes", () => {
    const a = { id: "a", title: "A" };
    const b = { id: "b", title: "B" };
    const previous = { tabs: [a, b] };
    const next = { tabs: [{ id: "a", title: "A" }, { id: "b", title: "B2" }] };
    const shared = share(previous, next);
    expect(shared).not.toBe(previous);
    expect(shared.tabs[0]).toBe(a);
    expect(shared.tabs[1]).not.toBe(b);
    expect(shared.tabs[1]).toEqual({ id: "b", title: "B2" });
  });

  it("treats a removed or added key as a change", () => {
    expect(share({ a: 1, b: 2 }, { a: 1 })).toEqual({ a: 1 });
    expect(share({ a: 1 }, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    const previous = { a: 1 };
    expect(share(previous, { a: 1 })).toBe(previous);
  });

  it("treats a length change as an array change and shares the common prefix", () => {
    const first = { id: 1 };
    const previous = [first, { id: 2 }];
    const next = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const shared = share(previous, next);
    expect(shared).not.toBe(previous);
    expect(shared).toHaveLength(3);
    expect(shared[0]).toBe(first);
    expect(shared[1]).toBe(previous[1]);
  });

  it("does not confuse arrays with objects or null with objects", () => {
    expect(share([1], { 0: 1 })).toEqual({ 0: 1 });
    expect(share(null, { a: 1 })).toEqual({ a: 1 });
    expect(share({ a: 1 }, null)).toBeNull();
    expect(share("x", "x")).toBe("x");
  });
});
