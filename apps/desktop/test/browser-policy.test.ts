import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { browserOrigin, isBrowserControlCommand, isSecureBrowserUrl, normalizeTabPasskeySupport } from "@pistachio/shell-contracts/browser-controls";
import { BrowserPolicyStore, sanitizeEnterprisePolicy, sitePatternMatches } from "../src/main/browser-policy-store";

describe("enterprise browser policy", () => {
  it("matches exact origins, hosts, and true subdomains without overmatching", () => {
    expect(sitePatternMatches("https://portal.test", "https://portal.test")).toBe(true);
    expect(sitePatternMatches("portal.test", "https://portal.test")).toBe(true);
    expect(sitePatternMatches("*.example.com", "https://files.example.com")).toBe(true);
    expect(sitePatternMatches("*.example.com", "https://example.com")).toBe(false);
    expect(sitePatternMatches("*.example.com", "https://notexample.com")).toBe(false);
    expect(sitePatternMatches("*", "pistachio://demo")).toBe(true);
  });

  it("sanitizes unknown capabilities and invalid decisions out of managed input", () => {
    expect(
      sanitizeEnterprisePolicy({
        version: 1,
        rules: [
          {
            pattern: "portal.test",
            permissions: {
              camera: "block",
              filesystem: "allow",
              microphone: "sometimes",
            },
            actions: { download: "block", execute: "allow", print: "ask" },
          },
        ],
      }),
    ).toEqual({
      version: 1,
      rules: [
        {
          pattern: "portal.test",
          permissions: { camera: "block" },
          actions: { download: "block" },
        },
      ],
    });
  });

  it("gives managed rules precedence over saved site decisions and persists user choices", () => {
    const directory = mkdtempSync(join(tmpdir(), "pistachio-policy-"));
    writeFileSync(
      join(directory, "enterprise-policy.json"),
      JSON.stringify({
        version: 1,
        rules: [
          { pattern: "*", actions: { download: "block" } },
          {
            pattern: "portal.test",
            permissions: { camera: "block" },
            actions: { print: "block" },
          },
        ],
      }),
    );
    const store = new BrowserPolicyStore(directory);

    expect(store.action("https://portal.test/invoices", "download")).toMatchObject({
      decision: "block",
      source: "managed",
    });
    expect(store.action("https://portal.test/invoices", "print")).toMatchObject({
      decision: "block",
      source: "managed",
    });
    store.setPermission("https://portal.test/invoices", "camera", "allow");
    expect(store.permission("https://portal.test/invoices", "camera")).toMatchObject({
      decision: "block",
      source: "managed",
    });

    store.setPermission("https://portal.test/invoices", "microphone", "allow");
    expect(store.permission("https://portal.test/other", "microphone")).toMatchObject({
      decision: "allow",
      source: "user",
    });
    expect(JSON.parse(readFileSync(join(directory, "site-permissions.json"), "utf8"))).toMatchObject({
      version: 1,
      sites: { "https://portal.test": { microphone: "allow" } },
    });
    store.clearPermissions("https://portal.test");
    expect(store.permission("https://portal.test", "microphone").decision).toBe("ask");
  });

  it("remembers an always-allowed app link per site and per scheme", () => {
    const directory = mkdtempSync(join(tmpdir(), "pistachio-policy-"));
    const store = new BrowserPolicyStore(directory);
    const meeting = "https://app.zoom.us/wc/join/123";
    expect(store.externalApp(meeting, "zoommtg")).toMatchObject({ decision: "ask", source: "default" });

    store.allowExternalApp(meeting, "ZoomMtg");
    expect(store.externalApp(meeting, "zoommtg")).toMatchObject({ decision: "allow", source: "user" });
    expect(store.externalAppSchemes(meeting)).toEqual(["zoommtg"]);
    // Trusted to open Zoom, not to open anything else — nor is any other site.
    expect(store.externalApp(meeting, "ssh").decision).toBe("ask");
    expect(store.externalApp("https://evil.test", "zoommtg").decision).toBe("ask");
    // The site-level permission stays "ask": only the one scheme was granted.
    expect(store.permission(meeting, "external-app").decision).toBe("ask");

    // It survives a restart.
    const reopened = new BrowserPolicyStore(directory);
    expect(reopened.externalApp(meeting, "zoommtg").decision).toBe("allow");

    // A site-level choice in Site controls replaces the remembered schemes.
    reopened.setPermission(meeting, "external-app", "block");
    expect(reopened.externalApp(meeting, "zoommtg")).toMatchObject({ decision: "block", source: "user" });
    reopened.setPermission(meeting, "external-app", "ask");
    expect(reopened.externalApp(meeting, "zoommtg").decision).toBe("ask");
    expect(reopened.externalAppSchemes(meeting)).toEqual([]);

    reopened.allowExternalApp(meeting, "zoommtg");
    reopened.clearPermissions(meeting);
    expect(new BrowserPolicyStore(directory).externalApp(meeting, "zoommtg").decision).toBe("ask");
  });

  it("lets managed policy rule app links, and ignores junk in the saved file", () => {
    const directory = mkdtempSync(join(tmpdir(), "pistachio-policy-"));
    writeFileSync(
      join(directory, "enterprise-policy.json"),
      JSON.stringify({ version: 1, rules: [{ pattern: "portal.test", permissions: { "external-app": "block" } }] }),
    );
    writeFileSync(
      join(directory, "site-permissions.json"),
      JSON.stringify({
        version: 1,
        sites: {},
        externalApps: { "https://portal.test": ["zoommtg"], "https://ok.test": ["slack", "java script", 7, "slack"], "https://bad.test": "zoommtg" },
      }),
    );
    const store = new BrowserPolicyStore(directory);
    expect(store.externalApp("https://portal.test", "zoommtg")).toMatchObject({ decision: "block", source: "managed" });
    store.allowExternalApp("https://portal.test", "slack");
    expect(store.externalAppSchemes("https://portal.test")).toEqual(["zoommtg"]);
    expect(store.externalAppSchemes("https://ok.test")).toEqual(["slack"]);
    expect(store.externalAppSchemes("https://bad.test")).toEqual([]);
  });

  it("allows the clipboard by default and still honors a saved ask or block for it", () => {
    const directory = mkdtempSync(join(tmpdir(), "pistachio-policy-"));
    const store = new BrowserPolicyStore(directory);
    expect(store.permission("https://portal.test", "clipboard-read")).toMatchObject({ decision: "allow", source: "default" });
    expect(store.permission("https://portal.test", "clipboard-write")).toMatchObject({ decision: "allow", source: "default" });
    expect(store.permission("https://portal.test", "camera").decision).toBe("ask");

    // "Ask" is a real choice for the clipboard, not a reset to the default.
    store.setPermission("https://portal.test", "clipboard-read", "ask");
    expect(store.permission("https://portal.test", "clipboard-read")).toMatchObject({ decision: "ask", source: "user" });
    store.setPermission("https://portal.test", "clipboard-write", "block");
    expect(store.permission("https://portal.test", "clipboard-write").decision).toBe("block");
    // Choosing the default again drops the record.
    store.setPermission("https://portal.test", "clipboard-read", "allow");
    expect(store.permission("https://portal.test", "clipboard-read").source).toBe("default");
    store.clearPermissions("https://portal.test");
    expect(store.permission("https://portal.test", "clipboard-write").decision).toBe("allow");

    // Managed policy still wins over the default.
    writeFileSync(
      join(directory, "enterprise-policy.json"),
      JSON.stringify({ version: 1, rules: [{ pattern: "*", permissions: { "clipboard-read": "block" } }] }),
    );
    store.reloadManagedPolicy();
    expect(store.permission("https://portal.test", "clipboard-read")).toMatchObject({ decision: "block", source: "managed" });
  });
});

describe("secure browser URLs", () => {
  it("treats a page's source as exactly as secure as the page", () => {
    expect(isSecureBrowserUrl("https://example.com/")).toBe(true);
    expect(isSecureBrowserUrl("http://example.com/")).toBe(false);
    expect(isSecureBrowserUrl("view-source:https://example.com/")).toBe(true);
    expect(isSecureBrowserUrl("view-source:http://example.com/")).toBe(false);
    expect(isSecureBrowserUrl("view-source:")).toBe(false);
  });
});

describe("browser control IPC guards", () => {
  it("accepts only bounded command shapes", () => {
    expect(isBrowserControlCommand({ type: "zoomIn" })).toBe(true);
    expect(
      isBrowserControlCommand({
        type: "setPermission",
        permission: "camera",
        decision: "block",
      }),
    ).toBe(true);
    expect(
      isBrowserControlCommand({
        type: "setPermission",
        permission: "filesystem",
        decision: "allow",
      }),
    ).toBe(false);
    expect(isBrowserControlCommand({ type: "showDownload" })).toBe(false);
    expect(isBrowserControlCommand({ type: "selectPasskey", requestId: "request", accountId: "account" })).toBe(true);
    expect(isBrowserControlCommand({ type: "selectPasskey", requestId: "request", accountId: null })).toBe(true);
    expect(isBrowserControlCommand({ type: "selectPasskey", requestId: "request", accountId: 42 })).toBe(false);
  });

  it("accepts only boolean passkey capability reports", () => {
    expect(
      normalizeTabPasskeySupport({
        webAuthnAvailable: true,
        platformAuthenticatorAvailable: false,
        conditionalMediationAvailable: true,
      }),
    ).toEqual({
      webAuthnAvailable: true,
      platformAuthenticatorAvailable: false,
      conditionalMediationAvailable: true,
    });
    expect(normalizeTabPasskeySupport({ webAuthnAvailable: "yes" })).toBeNull();
  });

  it("normalizes custom schemes to stable, non-null policy origins", () => {
    expect(browserOrigin("pistachio://demo/invoices")).toBe("pistachio://demo");
    expect(browserOrigin("https://portal.test/a")).toBe("https://portal.test");
  });
});
