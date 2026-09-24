import { describe, expect, it } from "vitest";
import { normalizeOrigin, validateCapsule, type TaskCapsule } from "../src/index.js";

function capsule(): TaskCapsule {
  return {
    version: 1,
    id: "capsule-1",
    taskId: "task-1",
    sponsorId: "user-1",
    purpose: "Reconcile an invoice",
    createdAt: "2026-08-24T12:00:00.000Z",
    expiresAt: "2026-08-24T13:00:00.000Z",
    policyVersion: "policy-1",
    keyId: "key-1",
    tabs: [{ id: "tab-1", title: "Invoices", url: "https://portal.test/invoices" }],
    grant: {
      origins: ["https://portal.test"],
      methods: ["GET", "POST"],
      allowUploads: false,
      allowDownloads: false,
      allowClipboard: false,
      maxInteractions: 20,
    },
  };
}

describe("task capsule", () => {
  it("normalizes origins and validates scoped tabs", () => {
    expect(normalizeOrigin("https://portal.test/invoices?id=1")).toBe("https://portal.test");
    expect(() => validateCapsule(capsule(), new Date("2026-08-24T12:30:00Z").getTime())).not.toThrow();
  });

  it("rejects a tab outside the grant", () => {
    const value = capsule();
    value.tabs[0] = { ...value.tabs[0]!, url: "https://evil.test/" };
    expect(() => validateCapsule(value, new Date("2026-08-24T12:30:00Z").getTime())).toThrow(
      "outside capsule grant",
    );
  });
});
