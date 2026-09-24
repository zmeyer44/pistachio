import { describe, expect, it } from "vitest";
import { AdapterRegistry, type AdapterManifest } from "../src/index.js";

const manifest: AdapterManifest = {
  schemaVersion: 1,
  id: "northstar.finance",
  version: "2026.08.1",
  origins: ["https://finance.example"],
  actions: [
    {
      id: "invoice.update",
      label: "Update invoice",
      method: "POST",
      path: "/api/invoices/*",
      consequential: true,
      reversible: true,
      dataLeaving: ["Invoice fields"],
      resource: "Invoice",
    },
    {
      id: "invoice.submit_reconciliation",
      label: "Submit reconciliation",
      method: "POST",
      path: "/api/invoices/:invoiceId/reconciliation/submit",
      consequential: true,
      reversible: false,
      dataLeaving: ["Invoice number", "Purchase order", "Variance note"],
      resource: "Invoice reconciliation",
    },
  ],
};

describe("semantic adapter registry", () => {
  it("uses the most specific versioned action mapping", () => {
    const registry = new AdapterRegistry([manifest]);
    const action = registry.resolve({
      url: "https://finance.example/api/invoices/NS-2048/reconciliation/submit",
      method: "POST",
    });
    expect(action?.id).toBe("invoice.submit_reconciliation");
    expect(action?.adapterVersion).toBe("2026.08.1");
    expect(action?.reversible).toBe(false);
  });

  it("does not invent a business action for an unknown route", () => {
    const registry = new AdapterRegistry([manifest]);
    expect(
      registry.resolve({ url: "https://finance.example/api/users/1", method: "POST" }),
    ).toBeNull();
  });
});
