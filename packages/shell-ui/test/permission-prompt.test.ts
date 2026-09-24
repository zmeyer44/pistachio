import { describe, expect, it } from "vitest";
import type { BrowserControlsSnapshot, PendingPasskeyRequest, PendingPermissionRequest } from "@pistachio/shell-contracts/browser-controls";
import { permissionPromptOverlay } from "../src/lib/permission-prompt";

function permission(id: string): PendingPermissionRequest {
  return { id, tabId: "tab-1", origin: "https://example.test", permission: "geolocation", permissions: ["geolocation"], requestedAt: 1 };
}

function passkey(id: string): PendingPasskeyRequest {
  return { id, tabId: "tab-1", origin: "https://example.test", relyingPartyId: "example.test", accounts: [], requestedAt: 1 };
}

function snapshot(
  pendingPermissions: PendingPermissionRequest[] = [],
  pendingPasskeyRequests: PendingPasskeyRequest[] = [],
): BrowserControlsSnapshot {
  return { pendingPermissions, pendingPasskeyRequests } as unknown as BrowserControlsSnapshot;
}

describe("permission prompt overlay", () => {
  it("raises the prompt over the page when a site first asks", () => {
    expect(permissionPromptOverlay(null, snapshot([permission("a")]), "none")).toBe("permission");
    expect(permissionPromptOverlay(snapshot(), snapshot([], [passkey("p")]), "none")).toBe("permission");
  });

  it("interrupts only the status card and the site-info popover", () => {
    const next = snapshot([permission("a")]);
    expect(permissionPromptOverlay(snapshot(), next, "status")).toBe("permission");
    expect(permissionPromptOverlay(snapshot(), next, "site-info")).toBe("permission");
    expect(permissionPromptOverlay(snapshot(), next, "url")).toBeNull();
    expect(permissionPromptOverlay(snapshot(), next, "settings")).toBeNull();
    expect(permissionPromptOverlay(snapshot(), next, "site")).toBeNull();
  });

  it("does not re-raise a prompt the person put down", () => {
    const pending = snapshot([permission("a")]);
    expect(permissionPromptOverlay(pending, pending, "none")).toBeNull();
    expect(permissionPromptOverlay(pending, snapshot([permission("a"), permission("b")]), "none")).toBe("permission");
  });

  it("leaves an open prompt alone while requests remain", () => {
    expect(permissionPromptOverlay(snapshot([permission("a")]), snapshot([permission("a"), permission("b")]), "permission")).toBeNull();
  });

  it("lowers the prompt once the last request is answered", () => {
    expect(permissionPromptOverlay(snapshot([permission("a")]), snapshot(), "permission")).toBe("none");
    expect(permissionPromptOverlay(snapshot([permission("a")]), snapshot(), "none")).toBeNull();
    expect(permissionPromptOverlay(snapshot([permission("a")]), snapshot(), "site")).toBeNull();
  });
});
