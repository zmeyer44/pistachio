import { describe, expect, it } from "vitest";
import { isBlockedAddress, SafeBrowserNetworkPolicy } from "../src/browser/network-policy.js";

describe("safe browser network policy", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "[::1]",
    "::ffff:7f00:1",
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b:1::7f00:1",
    "2002:7f00:1::",
  ])("blocks private address %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it("allows an exact origin override without weakening other hosts", async () => {
    const policy = new SafeBrowserNetworkPolicy({ allowedOrigins: ["http://127.0.0.1:43123"] });
    await expect(policy.assertAllowed("http://127.0.0.1:43123/test")).resolves.toBeUndefined();
    await expect(policy.assertAllowed("http://127.0.0.1:43124/test")).rejects.toThrow("blocks address");
  });

  it("leases one exact preview origin and revokes it with reference counting", async () => {
    const policy = new SafeBrowserNetworkPolicy();
    const first = policy.leaseOrigin("http://127.0.0.1:43123/path");
    const second = policy.leaseOrigin("http://127.0.0.1:43123/other");
    await expect(policy.assertAllowed("http://127.0.0.1:43123/app.js")).resolves.toBeUndefined();
    await expect(policy.assertAllowed("http://127.0.0.1:43124/app.js")).rejects.toThrow("blocks address");
    first();
    await expect(policy.assertAllowed("http://127.0.0.1:43123/app.js")).resolves.toBeUndefined();
    second();
    await expect(policy.assertAllowed("http://127.0.0.1:43123/app.js")).rejects.toThrow("blocks address");
  });

  it("rejects URLs containing inline credentials and non-http schemes", async () => {
    const policy = new SafeBrowserNetworkPolicy();
    await expect(policy.assertAllowed("https://token@example.com/")).rejects.toThrow("credentials");
    await expect(policy.assertAllowed("file:///etc/passwd")).rejects.toThrow("blocks file:");
  });

  it("recognizes bracketed IPv6 literals and local names before DNS resolution", async () => {
    const policy = new SafeBrowserNetworkPolicy();
    await expect(policy.assertAllowed("http://[::1]/private")).rejects.toThrow("blocks address");
    await expect(policy.assertAllowed("http://[::ffff:7f00:1]/private")).rejects.toThrow("blocks address");
    await expect(policy.assertAllowed("http://localhost/x")).rejects.toThrow("blocks host");
    await expect(policy.assertAllowed("http://metadata.google.internal/x")).rejects.toThrow("blocks host");
  });
});

describe("shared private-range classifier", () => {
  it("refuses every transition form of a private IPv4 address and malformed literals", () => {
    for (const address of [
      "0.0.0.0",
      "::ffff:10.0.0.1",
      "[::ffff:7f00:1]",
      "::10.0.0.1",
      "64:ff9b::a00:1",
      "2002:c0a8:101::",
      "2001:0::1",
      "fec0::1",
      "ff02::1",
      "224.0.0.1",
      "198.51.100.1",
      "010.0.0.1",
      "fe80::1%en0",
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "::ffff:8.8.8.8", "64:ff9b::808:808", "2606:4700::1111"]) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });
});
