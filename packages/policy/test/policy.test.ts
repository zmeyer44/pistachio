import { describe, expect, it } from "vitest";
import { AdapterRegistry, type AdapterManifest } from "@pistachio/adapters";
import { PolicyEnforcer } from "../src/index.js";

const manifest: AdapterManifest = {
  schemaVersion: 1,
  id: "portal.invoices",
  version: "1.0.0",
  origins: ["https://portal.test"],
  actions: [
    {
      id: "invoice.submit",
      label: "Submit invoice",
      method: "POST",
      path: "/api/invoices/:invoiceId/submit",
      consequential: true,
      reversible: false,
      dataLeaving: ["Invoice"],
      resource: "Invoice",
    },
  ],
};

function enforcer(maxInteractions = 12): PolicyEnforcer {
  return new PolicyEnforcer(
    {
      origins: ["https://portal.test"],
      methods: ["GET", "POST"],
      allowUploads: false,
      allowDownloads: false,
      allowClipboard: false,
      maxInteractions,
    },
    new AdapterRegistry([manifest]),
  );
}

describe("deterministic policy enforcer", () => {
  it("derives classifications and fails closed for off-origin, sensitive, upload, and unknown writes", () => {
    expect(enforcer().authorize({ url: "https://portal.test/invoices", method: "GET" }).outcome).toBe("allow");
    expect(enforcer().authorize({ url: "https://files.test/export", method: "GET" }).rule).toBe("origin.allowlist");
    expect(enforcer().authorize({ url: "https://portal.test/settings", method: "GET" }).rule).toBe("page.sensitive");
    expect(
      enforcer().authorize({
        url: "https://portal.test/api/invoices/1/submit",
        method: "POST",
        hasFileUpload: true,
      }).rule,
    ).toBe("transfer.upload");
    expect(
      enforcer().authorize({ url: "https://portal.test/api/unknown", method: "POST" }).rule,
    ).toBe("action.unclassified");
  });

  it("owns the interaction counter and consumes an exact path-pattern approval once", () => {
    const policy = enforcer();
    const raw = { url: "https://portal.test/api/invoices/1/submit", method: "POST" };
    const held = policy.authorize(raw);
    expect(held.outcome).toBe("require_approval");
    expect(held.classification.interactionNumber).toBe(1);
    expect(held.classification.approvalScope?.pathPattern).toBe("/api/invoices/:invoiceId/submit");

    held.classification.approvalScope!.pathPattern = "/mutated/by/caller";
    policy.grantOnce(held, { id: "approval-1", expiresAt: "2099-01-01T00:00:00Z" });
    expect(policy.authorize(raw).rule).toBe("approval.once");
    expect(policy.authorize(raw).outcome).toBe("require_approval");
    expect(() =>
      policy.grantOnce(held, { id: "approval-reused", expiresAt: "2099-01-01T00:00:00Z" }),
    ).toThrow("already consumed");
  });

  it("enforces its own budget and makes revocation a hard network deny", () => {
    const policy = enforcer(1);
    expect(policy.authorize({ url: "https://portal.test/invoices", method: "GET" }).outcome).toBe("allow");
    expect(policy.authorize({ url: "https://portal.test/invoices", method: "GET" }).rule).toBe("budget.interactions");
    policy.revoke();
    expect(policy.authorize({ url: "https://portal.test/invoices", method: "GET" }).rule).toBe("authority.revoked");
    expect(policy.isNavigationAllowed("https://portal.test/invoices")).toBe(false);
  });

  it("exposes data-movement grants without leaking the mutable capsule", () => {
    const policy = enforcer();
    expect(policy.allowsUploads()).toBe(false);
    expect(policy.allowsDownloads()).toBe(false);
    expect(policy.allowsClipboard()).toBe(false);
    policy.revoke();
    expect(policy.allowsUploads()).toBe(false);
    expect(policy.allowsClipboard()).toBe(false);
  });
});
