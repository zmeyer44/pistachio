import { describe, expect, it } from "vitest";

import { dialAny, resolveTarget, unbracket, type LookupFn } from "../src/policy.js";
import { parseConnectTarget } from "../src/server.js";

const PUBLIC_LOOKUP: LookupFn = async () => [{ address: "93.184.216.7", family: 4 }];

describe("parseConnectTarget", () => {
  it("accepts host:port and the bracketed IPv6 form", () => {
    expect(parseConnectTarget("example.com:443")).toEqual({ host: "example.com", port: 443 });
    expect(parseConnectTarget("[2606:4700::1111]:443")).toEqual({ host: "[2606:4700::1111]", port: 443 });
    expect(unbracket("[2606:4700::1111]")).toBe("2606:4700::1111");
  });

  it("rejects malformed authorities", () => {
    for (const bad of [
      "",
      "example.com",
      "example.com:0",
      "example.com:99999",
      "example.com:44a",
      ":443",
      "[::1]443",
      "[::1",
      "exa mple.com:443",
      "http://example.com:443",
    ]) {
      expect(parseConnectTarget(bad), bad).toBeNull();
    }
  });
});

describe("resolveTarget", () => {
  it("refuses literal private targets and disallowed ports before DNS", async () => {
    let lookups = 0;
    const lookup: LookupFn = async () => {
      lookups += 1;
      return [{ address: "93.184.216.7", family: 4 }];
    };
    expect(await resolveTarget("127.0.0.1", 443, {}, lookup)).toEqual({
      ok: false,
      body: "private or local targets are never tunnelled",
    });
    expect(await resolveTarget("localhost", 443, {}, lookup)).toEqual({
      ok: false,
      body: "private or local targets are never tunnelled",
    });
    expect(await resolveTarget("example.com", 25, {}, lookup)).toEqual({ ok: false, body: "port 25 is never tunnelled" });
    expect(await resolveTarget("example.com", 4444, {}, lookup)).toEqual({ ok: false, body: "port 4444 is not allowed" });
    expect(lookups).toBe(0);
  });

  it("keeps only resolved addresses that pass the post-DNS check (anti-rebinding)", async () => {
    const lookup: LookupFn = async () => [
      { address: "127.0.0.1", family: 4 },
      { address: "10.1.2.3", family: 4 },
      { address: "::ffff:192.168.0.9", family: 6 },
      { address: "93.184.216.7", family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ];
    expect(await resolveTarget("rebind.example.com", 443, {}, lookup)).toEqual({
      ok: true,
      addresses: ["93.184.216.7", "2606:4700::1111"],
    });
  });

  it("answers the no-permitted-address refusal when nothing survives or DNS fails", async () => {
    const rebinding: LookupFn = async () => [{ address: "127.0.0.1", family: 4 }];
    expect(await resolveTarget("rebind.example.com", 443, {}, rebinding)).toEqual({
      ok: false,
      body: "target did not resolve to a permitted address",
    });
    const failing: LookupFn = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await resolveTarget("missing.example.com", 443, {}, failing)).toEqual({
      ok: false,
      body: "target did not resolve to a permitted address",
    });
  });

  it("honours extra ports and the permissive local option", async () => {
    expect(await resolveTarget("example.com", 8443, { extraPorts: [8443] }, PUBLIC_LOOKUP)).toEqual({
      ok: true,
      addresses: ["93.184.216.7"],
    });
    const local: LookupFn = async () => [{ address: "127.0.0.1", family: 4 }];
    expect(await resolveTarget("127.0.0.1", 9999, { extraPorts: [9999], allowPrivateTargets: true }, local)).toEqual({
      ok: true,
      addresses: ["127.0.0.1"],
    });
    expect(await resolveTarget("127.0.0.1", 25, { extraPorts: [25], allowPrivateTargets: true }, local)).toEqual({
      ok: false,
      body: "port 25 is never tunnelled",
    });
  });
});

describe("dialAny", () => {
  it("dials sequentially and stops at the first success", async () => {
    const attempted: string[] = [];
    const socket = await dialAny(["93.184.216.1", "93.184.216.2", "93.184.216.3"], 443, {
      dial: async (address) => {
        attempted.push(address);
        return address === "93.184.216.2" ? ({ address } as unknown as import("node:net").Socket) : null;
      },
    });
    expect(attempted).toEqual(["93.184.216.1", "93.184.216.2"]);
    expect(socket).not.toBeNull();
    expect(await dialAny(["93.184.216.1"], 443, { dial: async () => null })).toBeNull();
  });
});
