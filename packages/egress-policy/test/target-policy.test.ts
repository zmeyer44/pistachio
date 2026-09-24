/**
 * Port of harbor's `services/egressgw/src/policy.rs` tests, plus the parsing
 * edge cases a hand-rolled IP parser has to get right.
 */

import { describe, expect, it } from "vitest";
import {
  NO_PERMITTED_ADDRESS_MESSAGE,
  checkResolvedAddress,
  isIpLiteral,
  parseIpAddress,
  refusalMessage,
  vetTarget,
  type Refusal,
  type TargetPolicyOptions,
} from "../src/index.js";

const PRIVATE: Refusal = { kind: "private_target" };
const SMTP: Refusal = { kind: "smtp" };

/** `Policy::new([8443])` in the Rust tests. */
const strict: TargetPolicyOptions = { extraPorts: [8443] };

describe("vetTarget (port of policy.rs)", () => {
  it("refuses loopback targets", () => {
    for (const host of ["127.0.0.1", "127.5.4.3", "::1", "[::1]", "localhost", "dev.localhost"]) {
      expect(vetTarget(host, 443, strict), host).toEqual(PRIVATE);
    }
  });

  it("refuses private, link-local, CGNAT and ULA ranges", () => {
    for (const host of [
      "10.0.0.1",
      "192.168.1.10",
      "172.16.4.4",
      "172.31.255.255",
      "169.254.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "0.0.0.1",
      "0.255.255.255",
      "fd12:3456::1",
      "fe80::1",
      "[fe80::1]",
      "::ffff:10.0.0.1", // v4-mapped smuggling
      "build-server", // bare LAN name
    ]) {
      expect(vetTarget(host, 443, strict), host).toEqual(PRIVATE);
    }
  });

  it("allows public targets on allowed ports", () => {
    for (const host of ["8.8.8.8", "172.32.0.1", "example.com", "2606:4700::1111"]) {
      expect(vetTarget(host, 443, strict), host).toBeNull();
    }
    expect(vetTarget("example.com", 80, strict)).toBeNull();
    expect(vetTarget("example.com", 8443, strict)).toBeNull();
  });

  it("refuses port 25 unconditionally", () => {
    expect(vetTarget("example.com", 25, strict)).toEqual(SMTP);
    // Even an extra-ports list naming 25 cannot reopen it.
    expect(vetTarget("example.com", 25, { extraPorts: [25] })).toEqual(SMTP);
    // Even the permissive local policy keeps it shut.
    expect(vetTarget("127.0.0.1", 25, { extraPorts: [25], allowPrivateTargets: true })).toEqual(
      SMTP,
    );
  });

  it("refuses unlisted ports", () => {
    expect(vetTarget("example.com", 4444, strict)).toEqual({
      kind: "port_not_allowed",
      port: 4444,
    });
  });

  it("rechecks resolved addresses for DNS rebinding", () => {
    expect(checkResolvedAddress("10.1.2.3", strict)).toEqual(PRIVATE);
    expect(checkResolvedAddress("1.1.1.1", strict)).toBeNull();
  });

  it("admits loopback under the permissive policy for tests", () => {
    const permissive: TargetPolicyOptions = { extraPorts: [9999], allowPrivateTargets: true };
    expect(vetTarget("127.0.0.1", 9999, permissive)).toBeNull();
  });
});

describe("vetTarget details", () => {
  it("defaults to 443 and 80 only", () => {
    expect(vetTarget("example.com", 443)).toBeNull();
    expect(vetTarget("example.com", 80)).toBeNull();
    expect(vetTarget("example.com", 8443)).toEqual({ kind: "port_not_allowed", port: 8443 });
  });

  it("checks the port before the host", () => {
    expect(vetTarget("localhost", 4444, strict)).toEqual({ kind: "port_not_allowed", port: 4444 });
    expect(vetTarget("10.0.0.1", 25, strict)).toEqual(SMTP);
  });

  it("accepts extra ports from any iterable and ignores out-of-range entries", () => {
    expect(vetTarget("example.com", 8080, { extraPorts: new Set([8080]) })).toBeNull();
    expect(vetTarget("example.com", 70000, { extraPorts: [70000] })).toEqual({
      kind: "port_not_allowed",
      port: 70000,
    });
    expect(vetTarget("example.com", 80.5, { extraPorts: [80.5] })).toEqual({
      kind: "port_not_allowed",
      port: 80.5,
    });
  });

  it("refuses broadcast, unspecified IPv6, and hex-form v4-mapped literals", () => {
    for (const host of ["255.255.255.255", "::", "[::]", "::ffff:7f00:1", "::ffff:c0a8:101"]) {
      expect(vetTarget(host, 443, strict), host).toEqual(PRIVATE);
    }
  });

  it("is case-insensitive about localhost names", () => {
    expect(vetTarget("LOCALHOST", 443, strict)).toEqual(PRIVATE);
    expect(vetTarget("Dev.LocalHost", 443, strict)).toEqual(PRIVATE);
    expect(vetTarget("Example.COM", 443, strict)).toBeNull();
  });

  it("refuses the empty host", () => {
    expect(vetTarget("", 443, strict)).toEqual(PRIVATE);
  });
});

describe("checkResolvedAddress", () => {
  it("refuses every private range on a resolved address", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.0.1",
      "169.254.169.254",
      "100.127.255.255",
      "0.0.0.0",
      "0.0.0.1",
      "0.255.255.255",
      "255.255.255.255",
      "::1",
      "::",
      "fc00::1",
      "fdff::1",
      "fe80::1",
      "febf::1",
      "::ffff:127.0.0.1",
      "::ffff:192.168.1.1",
    ]) {
      expect(checkResolvedAddress(ip), ip).toEqual(PRIVATE);
    }
  });

  it("allows public addresses", () => {
    for (const ip of [
      "1.1.1.1",
      "8.8.8.8",
      "172.32.0.1",
      "100.128.0.1",
      "2606:4700::1111",
      "::ffff:8.8.8.8",
      "64:ff9b::808:808",
    ]) {
      expect(checkResolvedAddress(ip), ip).toBeNull();
    }
  });

  it("refuses transition forms and reserved ranges that reach a private address", () => {
    for (const ip of [
      "0.0.0.0",
      "::ffff:10.0.0.1",
      "::10.0.0.1",
      "::ffff:0:7f00:1",
      "64:ff9b::7f00:1",
      "64:ff9b:1::1",
      "2002:c0a8:101::",
      "2001:0:53aa:64c:0:fffe:7f00:1",
      "fec0::1",
      "ff02::1",
      "198.51.100.7",
      "198.18.0.1",
      "192.0.0.9",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(checkResolvedAddress(ip), ip).toEqual(PRIVATE);
    }
  });

  it("fails closed on anything that is not an IP literal", () => {
    for (const bad of ["", "example.com", "fe80::1%en0", "1.2.3", "01.02.03.04", "1.2.3.256"]) {
      expect(checkResolvedAddress(bad), bad).toEqual(PRIVATE);
    }
  });

  it("honors allowPrivateTargets", () => {
    expect(checkResolvedAddress("127.0.0.1", { allowPrivateTargets: true })).toBeNull();
  });
});

describe("refusal bodies", () => {
  it("match harbor's gateway byte for byte", () => {
    expect(refusalMessage(SMTP)).toBe("port 25 is never tunnelled");
    expect(refusalMessage({ kind: "port_not_allowed", port: 4444 })).toBe(
      "port 4444 is not allowed",
    );
    expect(refusalMessage(PRIVATE)).toBe("private or local targets are never tunnelled");
    expect(NO_PERMITTED_ADDRESS_MESSAGE).toBe("target did not resolve to a permitted address");
  });
});

describe("IP literal parsing", () => {
  it("parses IPv4 strictly", () => {
    expect(parseIpAddress("1.2.3.4")).toEqual({ family: 4, octets: [1, 2, 3, 4] });
    expect(parseIpAddress("0.0.0.0")).toEqual({ family: 4, octets: [0, 0, 0, 0] });
    for (const bad of [
      "1.2.3",
      "1.2.3.4.5",
      "256.1.1.1",
      "01.2.3.4",
      "1.2.3.4 ",
      " 1.2.3.4",
      "1..2.3",
      "a.b.c.d",
    ]) {
      expect(parseIpAddress(bad), bad).toBeNull();
    }
  });

  it("parses IPv6 with compression and embedded IPv4", () => {
    expect(parseIpAddress("::")).toEqual({ family: 6, segments: [0, 0, 0, 0, 0, 0, 0, 0] });
    expect(parseIpAddress("::1")).toEqual({ family: 6, segments: [0, 0, 0, 0, 0, 0, 0, 1] });
    expect(parseIpAddress("1::")).toEqual({ family: 6, segments: [1, 0, 0, 0, 0, 0, 0, 0] });
    expect(parseIpAddress("2606:4700::1111")).toEqual({
      family: 6,
      segments: [0x2606, 0x4700, 0, 0, 0, 0, 0, 0x1111],
    });
    expect(parseIpAddress("1:2:3:4:5:6:7:8")).toEqual({
      family: 6,
      segments: [1, 2, 3, 4, 5, 6, 7, 8],
    });
    // `::` may stand for a single zero group.
    expect(parseIpAddress("1:2:3:4:5:6:7::")).toEqual({
      family: 6,
      segments: [1, 2, 3, 4, 5, 6, 7, 0],
    });
    expect(parseIpAddress("::ffff:10.0.0.1")).toEqual({
      family: 6,
      segments: [0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0001],
    });
    expect(parseIpAddress("1:2:3:4:5:6:1.2.3.4")).toEqual({
      family: 6,
      segments: [1, 2, 3, 4, 5, 6, 0x0102, 0x0304],
    });
    expect(parseIpAddress("FE80::ABCD")).toEqual({
      family: 6,
      segments: [0xfe80, 0, 0, 0, 0, 0, 0, 0xabcd],
    });
  });

  it("rejects malformed IPv6", () => {
    for (const bad of [
      "1:2:3:4:5:6:7", // too few groups
      "1:2:3:4:5:6:7:8:9", // too many
      "1:2:3:4:5:6:7:8::", // :: with 8 groups leaves nothing to compress
      "1::2::3", // two ::
      ":::",
      "12345::",
      "::ffff:1.2.3", // bad embedded v4
      "1.2.3.4::", // v4 before ::
      "1:2:3:4:1.2.3.4:5:6", // v4 not at the end
      "fe80::1%en0", // zone ids are not addresses
      "::g",
      "[::1]", // brackets are stripped by the callers, not the parser
    ]) {
      expect(parseIpAddress(bad), bad).toBeNull();
    }
  });

  it("recognises bracketed literals", () => {
    expect(isIpLiteral("[::1]")).toBe(true);
    expect(isIpLiteral("::1")).toBe(true);
    expect(isIpLiteral("10.0.0.1")).toBe(true);
    expect(isIpLiteral("example.com")).toBe(false);
    expect(isIpLiteral("[example.com]")).toBe(false);
  });
});
