import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeChanges, learnedOperations, looksSensitive } from "../src/main/memory-engine";
import { MemoryStore } from "../src/main/memory-store";

describe("looksSensitive", () => {
  it("catches secrets and payment-shaped numbers, and lets ordinary facts through", () => {
    expect(looksSensitive("Their password is hunter2")).toBe(true);
    expect(looksSensitive("Card 4242 4242 4242 4242")).toBe(true);
    expect(looksSensitive("SSN 123-45-6789")).toBe(true);
    expect(looksSensitive("Uses the API key from the vault")).toBe(true);
    expect(looksSensitive("Prefers aisle seats")).toBe(false);
    expect(looksSensitive("Order NS-2048 shipped on March 3")).toBe(false);
  });
});

describe("learnedOperations", () => {
  it("marks unsure additions pending, drops secrets, and caps the batch", () => {
    const operations = learnedOperations([
      { op: "add", content: "Works at Stripe", kind: "static", bucket: "profile", confidence: 0.95 },
      { op: "add", content: "Might prefer mornings", kind: "dynamic", bucket: "routine", confidence: 0.4 },
      { op: "add", content: "No confidence given", kind: "dynamic", bucket: "other" },
      { op: "add", content: "Password is hunter2", kind: "static", bucket: "account", confidence: 1 },
      { op: "update", id: "abc", content: "Now at Stripe as a PM" },
      { op: "forget", id: "def", reason: "Moved" },
      ...Array.from({ length: 20 }, (_, index) => ({ op: "add", content: `Extra ${String(index)}`, confidence: 0.9 })),
    ]);
    expect(operations).toHaveLength(12);
    expect(operations[0]).toMatchObject({ op: "add", content: "Works at Stripe", review: "approved" });
    expect(operations[1]).toMatchObject({ op: "add", content: "Might prefer mornings", review: "pending", confidence: 0.4 });
    expect(operations[2]).toMatchObject({ op: "add", review: "pending", confidence: 0.7 });
    expect(operations.some((operation) => operation.op === "add" && operation.content.includes("hunter2"))).toBe(false);
    expect(operations[3]).toEqual({ op: "update", id: "abc", content: "Now at Stripe as a PM" });
    expect(operations[4]).toEqual({ op: "forget", id: "def", reason: "Moved" });
  });
});

describe("describeChanges", () => {
  it("reads as one line, and counts what waits for review", () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), "pistachio-learn-")));
    const changes = store.applyOperations(
      [
        { op: "add", content: "Works at Stripe", kind: "static", bucket: "profile", confidence: 0.95, review: "approved" },
        { op: "add", content: "Might prefer mornings", kind: "dynamic", bucket: "routine", confidence: 0.4, review: "pending" },
      ],
      { kind: "learned", runId: "run-1" },
    );
    expect(describeChanges(changes)).toBe("2 new facts · 1 waiting for your review");
    expect(describeChanges({ added: [], updated: [changes.added[0]!], forgotten: [] })).toBe("1 fact updated");
  });
});
