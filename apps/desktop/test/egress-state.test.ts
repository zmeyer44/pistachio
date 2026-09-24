import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSpaceEgressConfig,
  credentialIsLive,
  credentialRefreshDelayMs,
  gatewayEndpoint,
  healthProbeUrl,
  matchesProxyChallenge,
  mayProxyThisRun,
  parseEgressUrlPin,
  parsedSpacesHaveIdentitySpace,
  proxyServerFor,
  shouldResetOverrides,
  spaceEgressStatusFor,
  spacesFileHasIdentitySpace,
} from "../src/main/egress/egress-state";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("buildSpaceEgressConfig", () => {
  it("starts from the shared defaults", () => {
    expect(buildSpaceEgressConfig("s1", "identity", false)).toEqual({
      spaceId: "s1",
      policy: "identity",
      siteBypass: [],
      mediaBypass: true,
      checkoutBypass: true,
      detectedCheckoutHosts: [],
      temporaryDirectOverride: false,
    });
  });

  it("carries the override and the session's detected checkout hosts", () => {
    const config = buildSpaceEgressConfig("s1", "identity", true, ["buy.example"]);
    expect(config.temporaryDirectOverride).toBe(true);
    expect(config.detectedCheckoutHosts).toEqual(["buy.example"]);
  });
});

describe("spaceEgressStatusFor (fail-closed matrix)", () => {
  it("fails closed only when identity + gateway down + no override", () => {
    const identity = buildSpaceEgressConfig("s1", "identity", false);
    expect(spaceEgressStatusFor(identity, "down", true).failClosed).toBe(true);
    expect(spaceEgressStatusFor(identity, "up", true).failClosed).toBe(false);
    expect(spaceEgressStatusFor(buildSpaceEgressConfig("s1", "identity", true), "down", true)).toMatchObject({
      failClosed: false,
      temporaryDirectOverride: true,
    });
    expect(spaceEgressStatusFor(buildSpaceEgressConfig("s1", "direct", false), "down", true).failClosed).toBe(false);
  });

  it("reports restartRequired, not failClosed, when QUIC could not be disabled this run", () => {
    const identity = buildSpaceEgressConfig("s", "identity", false);
    expect(spaceEgressStatusFor(identity, "up", false)).toEqual({
      spaceId: "s",
      policy: "identity",
      failClosed: false,
      temporaryDirectOverride: false,
      restartRequired: true,
    });
    expect(spaceEgressStatusFor(identity, "down", false).failClosed).toBe(false);
    expect(spaceEgressStatusFor(buildSpaceEgressConfig("s", "direct", false), "up", false).restartRequired).toBe(false);
    expect(mayProxyThisRun(true)).toBe(true);
    expect(mayProxyThisRun(false)).toBe(false);
  });
});

describe("shouldResetOverrides", () => {
  it("resets only on the down → up transition", () => {
    expect(shouldResetOverrides("down", "up")).toBe(true);
    expect(shouldResetOverrides("up", "down")).toBe(false);
    expect(shouldResetOverrides("down", "down")).toBe(false);
    expect(shouldResetOverrides("up", "up")).toBe(false);
  });
});

describe("the startup --disable-quic key", () => {
  it("detects an identity Space in the raw spaces file", () => {
    expect(parsedSpacesHaveIdentitySpace({ spaces: [{ egressPolicy: "direct" }, { egressPolicy: "identity" }] })).toBe(true);
    expect(parsedSpacesHaveIdentitySpace({ spaces: [{ egressPolicy: "direct" }] })).toBe(false);
    expect(parsedSpacesHaveIdentitySpace({})).toBe(false);
    expect(parsedSpacesHaveIdentitySpace(null)).toBe(false);
    expect(parsedSpacesHaveIdentitySpace("garbage")).toBe(false);
  });

  it("reads spaces.json synchronously and treats a missing or broken file as direct", () => {
    const dir = mkdtempSync(join(tmpdir(), "pistachio-quic-"));
    dirs.push(dir);
    const path = join(dir, "spaces.json");
    expect(spacesFileHasIdentitySpace(path)).toBe(false);
    writeFileSync(path, "{not json");
    expect(spacesFileHasIdentitySpace(path)).toBe(false);
    writeFileSync(path, JSON.stringify({ version: 1, spaces: [{ id: "work", egressPolicy: "identity" }] }));
    expect(spacesFileHasIdentitySpace(path)).toBe(true);
  });
});

describe("matchesProxyChallenge (the login predicate)", () => {
  const gateway = { host: "gw.example", port: 8443 };

  it("ignores an origin's own challenge", () => {
    expect(matchesProxyChallenge({ isProxy: false, host: "gw.example", port: 8443 }, gateway)).toBe(false);
  });

  it("ignores another proxy, another host, or another port", () => {
    expect(matchesProxyChallenge({ isProxy: true, host: "gw.example", port: 3128 }, gateway)).toBe(false);
    expect(matchesProxyChallenge({ isProxy: true, host: "other.example", port: 8443 }, gateway)).toBe(false);
  });

  it("answers only the gateway itself, and nothing while no gateway is known", () => {
    expect(matchesProxyChallenge({ isProxy: true, host: "gw.example", port: 8443 }, gateway)).toBe(true);
    expect(matchesProxyChallenge({ isProxy: true, host: "gw.example", port: 8443 }, null)).toBe(false);
  });
});

describe("gateway endpoints", () => {
  it("is https for a provisioned gateway and follows a dev http pin", () => {
    expect(gatewayEndpoint({ host: "gw.example", port: 8443 }, null)).toEqual({ scheme: "https", host: "gw.example", port: 8443 });
    expect(parseEgressUrlPin("http://127.0.0.1:8443")).toEqual({ scheme: "http", host: "127.0.0.1", port: 8443 });
    expect(parseEgressUrlPin("https://gw.example")).toEqual({ scheme: "https", host: "gw.example", port: 443 });
    expect(parseEgressUrlPin("ftp://x")).toBeNull();
    expect(parseEgressUrlPin(undefined)).toBeNull();
    expect(parseEgressUrlPin("  ")).toBeNull();
    const pinned = gatewayEndpoint({ host: "gw.example", port: 8443 }, parseEgressUrlPin("http://127.0.0.1:8443"));
    expect(pinned).toEqual({ scheme: "http", host: "127.0.0.1", port: 8443 });
    expect(gatewayEndpoint(null, null)).toBeNull();
  });

  it("builds the probe URL and the proxy server from the endpoint", () => {
    expect(healthProbeUrl({ scheme: "https", host: "gw.example", port: 8443 })).toBe("https://gw.example:8443/healthz");
    expect(healthProbeUrl({ scheme: "http", host: "127.0.0.1", port: 8443 })).toBe("http://127.0.0.1:8443/healthz");
    expect(proxyServerFor({ scheme: "https", host: "::1", port: 8443 })).toBe("https://[::1]:8443");
  });
});

describe("credential schedule", () => {
  it("refreshes an hour before expiry and treats an expired credential as none", () => {
    const now = Date.parse("2026-09-02T12:00:00Z");
    expect(credentialRefreshDelayMs("2026-09-03T12:00:00Z", now)).toBe(23 * 60 * 60 * 1000);
    expect(credentialRefreshDelayMs("2026-09-02T12:30:00Z", now)).toBe(0);
    expect(credentialRefreshDelayMs("garbage", now)).toBe(0);
    expect(credentialIsLive("2026-09-02T12:00:01Z", now)).toBe(true);
    expect(credentialIsLive("2026-09-02T12:00:00Z", now)).toBe(false);
    expect(credentialIsLive("garbage", now)).toBe(false);
  });
});
