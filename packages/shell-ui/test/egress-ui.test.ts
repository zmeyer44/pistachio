import { describe, expect, it } from "vitest";
import type { EgressStatus, SpaceEgressStatus } from "@pistachio/shell-contracts/ipc";
import {
  blockedSpaceIds,
  canBrowseDirect,
  credentialExpiry,
  egressHealthView,
  gatewayLabel,
  gatewayStateLabel,
  restartRequired,
  spaceEgressStatus,
  spaceEgressView,
} from "../src/lib/egress";
import { DEFAULT_EGRESS_STATUS } from "../src/lib/sync";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");

function space(patch: Partial<SpaceEgressStatus> = {}): SpaceEgressStatus {
  return {
    spaceId: "work",
    policy: "identity",
    failClosed: false,
    temporaryDirectOverride: false,
    restartRequired: false,
    ...patch,
  };
}

function status(patch: Partial<EgressStatus> = {}): EgressStatus {
  return { ...DEFAULT_EGRESS_STATUS, ...patch };
}

describe("egressHealthView", () => {
  it("says off before any Space asks for the gateway", () => {
    expect(egressHealthView(DEFAULT_EGRESS_STATUS)).toMatchObject({ label: "Off", tone: "gray" });
  });

  it("names the three answers a probe can give", () => {
    expect(egressHealthView(status({ enabled: true, health: "up" }))).toMatchObject({ label: "Up", tone: "green" });
    expect(egressHealthView(status({ enabled: true, health: "down" }))).toMatchObject({ label: "Down", tone: "red" });
    expect(egressHealthView(status({ enabled: true, health: "unknown" }))).toMatchObject({ label: "Unknown", tone: "amber" });
  });
});

describe("the gateway's own facts", () => {
  it("reads as address, region and endpoint, skipping what is not known", () => {
    expect(gatewayLabel(null)).toBe("No gateway assigned");
    expect(gatewayLabel({ host: "gw.example.com", port: 8443, egressIp: "198.51.100.12", region: "fra", state: "started" })).toBe(
      "198.51.100.12 · fra · gw.example.com:8443",
    );
    expect(gatewayLabel({ host: "gw.example.com", port: 8443, egressIp: null, region: null, state: null })).toBe("gw.example.com:8443");
  });

  it("falls back to unknown for a gateway with nothing to say about itself", () => {
    expect(gatewayStateLabel(null)).toBe("unknown");
    expect(gatewayStateLabel({ host: "h", port: 1, egressIp: null, region: null, state: "" })).toBe("unknown");
    expect(gatewayStateLabel({ host: "h", port: 1, egressIp: null, region: null, state: "started" })).toBe("started");
  });
});

describe("credentialExpiry", () => {
  it("counts down in the unit that matters and flags the last hour", () => {
    expect(credentialExpiry(null, NOW)).toMatchObject({ label: "no credential yet", expired: false });
    expect(credentialExpiry("not a date", NOW).label).toBe("no credential yet");
    expect(credentialExpiry(new Date(NOW + 11 * 3_600_000).toISOString(), NOW)).toMatchObject({ label: "in 11h", soon: false });
    expect(credentialExpiry(new Date(NOW + 42 * 60_000).toISOString(), NOW)).toMatchObject({ label: "in 42m", soon: true });
    expect(credentialExpiry(new Date(NOW - 1_000).toISOString(), NOW)).toMatchObject({ label: "expired", expired: true });
  });
});

describe("spaceEgressView", () => {
  it("a direct Space is ordinary browsing", () => {
    expect(spaceEgressView(null, DEFAULT_EGRESS_STATUS).label).toBe("Direct");
    expect(spaceEgressView(space({ policy: "direct" }), DEFAULT_EGRESS_STATUS).label).toBe("Direct");
  });

  it("reports where the traffic goes, which is not always what the policy says", () => {
    const up = status({ enabled: true, health: "up" });
    expect(spaceEgressView(space(), up)).toMatchObject({ label: "Through the gateway", tone: "green" });
    expect(spaceEgressView(space(), status({ enabled: true, health: "unknown" })).label).toBe("Waiting for the gateway");
    expect(spaceEgressView(space({ failClosed: true }), status({ enabled: true, health: "down" }))).toMatchObject({
      label: "Blocked",
      tone: "red",
    });
    expect(spaceEgressView(space({ failClosed: true, temporaryDirectOverride: true }), status({ enabled: true, health: "down" }))).toMatchObject({
      label: "Direct for now",
      tone: "amber",
    });
  });

  it("puts the relaunch ahead of everything else — nothing else it says is true until then", () => {
    const row = space({ restartRequired: true, failClosed: true, temporaryDirectOverride: true });
    const view = spaceEgressView(row, status({ enabled: true, health: "up" }));
    expect(view.label).toBe("Direct until relaunch");
    expect(view.note).toContain("QUIC");
  });
});

describe("what the page offers", () => {
  it("offers browsing direct only to an identity Space that is actually blocked", () => {
    expect(canBrowseDirect(null)).toBe(false);
    expect(canBrowseDirect(space({ policy: "direct" }))).toBe(false);
    expect(canBrowseDirect(space())).toBe(false);
    expect(canBrowseDirect(space({ failClosed: true }))).toBe(true);
    // Already going direct: there is nothing left to offer.
    expect(canBrowseDirect(space({ failClosed: true, temporaryDirectOverride: true }))).toBe(false);
  });

  it("finds a Space's row, the blocked ones, and whether anything needs a relaunch", () => {
    const rows = status({ enabled: true, spaces: [space(), space({ spaceId: "personal", failClosed: true })] });
    expect(spaceEgressStatus(rows, "personal")?.failClosed).toBe(true);
    expect(spaceEgressStatus(rows, "nope")).toBeNull();
    expect(blockedSpaceIds(rows)).toEqual(["personal"]);
    expect(restartRequired(rows)).toBe(false);
    expect(restartRequired(status({ spaces: [space({ restartRequired: true })] }))).toBe(true);
  });
});
