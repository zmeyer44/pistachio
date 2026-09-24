import { describe, expect, it } from "vitest";
import {
  HUB_ERROR_CODES,
  PUBLISH_REJECTION_REASONS,
  UNTESTED_ORIGIN_POLICY,
  makeVersionToken,
  matchOriginPolicy,
  mergeLww,
  parseClientMessage,
  parseServerMessage,
  parseVersionToken,
  sortByHlc,
  workspaceKeyFor,
  type ClientMessage,
  type OriginPolicy,
  type ServerMessage,
} from "../src/index.js";

describe("wire messages", () => {
  it("round-trips a publish message", () => {
    const msg: ClientMessage = {
      t: "publish",
      records: [
        {
          spaceId: "space-1",
          recordId: "ab".repeat(32),
          originId: "cd".repeat(32),
          sealedRecord: "c2VhbGVk",
          hlc: { physicalMs: 1000, logical: 0, deviceId: "dev-a" },
          causalParent: null,
          deviceSig: "c2ln",
          cause: "WRITE",
        },
      ],
    };
    expect(parseClientMessage(JSON.stringify(msg))).toEqual(msg);
  });

  it("rejects malformed frames", () => {
    expect(() => parseClientMessage(JSON.stringify({ t: "publish", records: [] }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({ t: "nope" }))).toThrow();
    expect(() =>
      parseServerMessage(JSON.stringify({ t: "records", spaceId: "", records: [] })),
    ).toThrow();
  });

  it("hello carries the device kind and rejects unknown kinds", () => {
    const hello: ClientMessage = { t: "hello", deviceId: "dev-a", kind: "cloud", spaceIds: ["work"] };
    expect(parseClientMessage(JSON.stringify(hello))).toEqual(hello);
    expect(() => parseClientMessage(JSON.stringify({ t: "hello", deviceId: "dev-a", spaceIds: [] }))).toThrow();
    expect(() =>
      parseClientMessage(JSON.stringify({ t: "hello", deviceId: "dev-a", kind: "phone", spaceIds: [] })),
    ).toThrow();
  });

  it("presence carries the device kind", () => {
    const ack: ServerMessage = {
      t: "hello.ack",
      serverTimeMs: 1,
      presence: [{ deviceId: "dev-b", kind: "desktop", online: true, lastSeenMs: 1 }],
    };
    expect(parseServerMessage(JSON.stringify(ack))).toEqual(ack);
    expect(() =>
      parseServerMessage(
        JSON.stringify({ t: "presence", devices: [{ deviceId: "dev-b", online: true, lastSeenMs: 1 }] }),
      ),
    ).toThrow();
  });

  it("lease frames carry exclusivity, holder kind, and release", () => {
    const acquire: ClientMessage = {
      t: "lease.acquire",
      spaceId: "work",
      originId: "ab".repeat(32),
      exclusive: true,
      ttlMs: 120_000,
    };
    expect(parseClientMessage(JSON.stringify(acquire))).toEqual(acquire);
    const granted: ServerMessage = {
      t: "lease.granted",
      spaceId: "work",
      originId: "ab".repeat(32),
      holderDeviceId: "dev-a",
      expiresAtMs: 5,
      exclusive: true,
    };
    expect(parseServerMessage(JSON.stringify(granted))).toEqual(granted);
    const { exclusive: _dropped, ...withoutExclusive } = granted;
    expect(() => parseServerMessage(JSON.stringify(withoutExclusive))).toThrow();
    const denied: ServerMessage = {
      t: "lease.denied",
      spaceId: "work",
      originId: "ab".repeat(32),
      holderDeviceId: "dev-cloud",
      holderKind: "cloud",
      exclusive: true,
      expiresAtMs: 5,
    };
    expect(parseServerMessage(JSON.stringify(denied))).toEqual(denied);
    const released: ServerMessage = { t: "lease.released", spaceId: "work", originId: "ab".repeat(32) };
    expect(parseServerMessage(JSON.stringify(released))).toEqual(released);
  });

  it("spaces.update round-trips with its ack", () => {
    const update: ClientMessage = { t: "spaces.update", spaceIds: ["work", "__workspace__"] };
    expect(parseClientMessage(JSON.stringify(update))).toEqual(update);
    const ack: ServerMessage = { t: "spaces.update.ack", spaceIds: ["work", "__workspace__"] };
    expect(parseServerMessage(JSON.stringify(ack))).toEqual(ack);
  });

  it("publish rejections accept exclusive_lease; error codes include device_mismatch", () => {
    const ack: ServerMessage = {
      t: "publish.ack",
      accepted: [],
      rejected: [{ recordId: "ab".repeat(32), reason: "exclusive_lease" }],
    };
    expect(parseServerMessage(JSON.stringify(ack))).toEqual(ack);
    expect(HUB_ERROR_CODES).toContain("device_mismatch");
    const error: ServerMessage = { t: "error", code: "device_mismatch", message: "hello.deviceId != token did" };
    expect(parseServerMessage(JSON.stringify(error))).toEqual(error);
  });

  it("keeps an unrecognised publish rejection reason parseable as `unknown`", () => {
    // A newer hub adds a reason: the frame must still parse (a strict enum
    // would drop the whole ack and strand every record in the batch), and the
    // unknown reason must never be mistaken for the durable `stale`.
    const raw = JSON.stringify({
      t: "publish.ack",
      accepted: [],
      rejected: [
        { recordId: "ab".repeat(32), reason: "rate_limited" },
        { recordId: "cd".repeat(32), reason: "quota_exhausted_v2" },
      ],
    });
    const parsed = parseServerMessage(raw);
    expect(parsed.t).toBe("publish.ack");
    if (parsed.t !== "publish.ack") return;
    expect(parsed.rejected.map((r) => r.reason)).toEqual(["rate_limited", "unknown"]);
    expect(PUBLISH_REJECTION_REASONS).toContain("rate_limited");
  });

  it("version tokens round-trip", () => {
    const hlc = { physicalMs: 123456, logical: 42, deviceId: "dev-b" };
    const token = makeVersionToken("ab".repeat(32), hlc);
    expect(parseVersionToken(token)).toEqual({ recordId: "ab".repeat(32), hlc });
  });

  it("sortByHlc orders oldest first", () => {
    const rs = [
      { hlc: { physicalMs: 2, logical: 0, deviceId: "a" } },
      { hlc: { physicalMs: 1, logical: 5, deviceId: "b" } },
      { hlc: { physicalMs: 1, logical: 2, deviceId: "c" } },
    ];
    expect(sortByHlc(rs).map((r) => r.hlc.physicalMs)).toEqual([1, 1, 2]);
    expect(sortByHlc(rs)[0]?.hlc.logical).toBe(2);
  });
});

describe("continuity policy matching", () => {
  const policies: OriginPolicy[] = [
    {
      domain: "github.com",
      label: "GitHub",
      mode: "portable",
      syncTier: 1,
      rotatingAuth: false,
      sensitive: false,
    },
    {
      domain: "gist.github.com",
      label: "GitHub Gist",
      mode: "assisted",
      syncTier: 0,
      rotatingAuth: false,
      sensitive: false,
    },
  ];

  it("matches subdomains and prefers the longest suffix", () => {
    expect(matchOriginPolicy(policies, "github.com").label).toBe("GitHub");
    expect(matchOriginPolicy(policies, "api.github.com").label).toBe("GitHub");
    expect(matchOriginPolicy(policies, "gist.github.com").label).toBe("GitHub Gist");
  });

  it("falls back to the untested-origin default (assisted, synced tier 1, LWW, not sensitive)", () => {
    const p = matchOriginPolicy(policies, "example.com");
    expect(p).toBe(UNTESTED_ORIGIN_POLICY);
    expect(p.mode).toBe("assisted");
    expect(p.syncTier).toBe(1);
    expect(p.rotatingAuth).toBe(false);
    expect(p.sensitive).toBe(false);
  });

  it("never matches a partial label ('evilgithub.com')", () => {
    expect(matchOriginPolicy(policies, "evilgithub.com").label).toBe("Untested origin");
  });
});

describe("workspace LWW", () => {
  it("keeps the newer value and keys docs stably", () => {
    const older = { value: "a", hlc: { physicalMs: 1, logical: 0, deviceId: "x" } };
    const newer = { value: "b", hlc: { physicalMs: 2, logical: 0, deviceId: "y" } };
    expect(mergeLww(older, newer).value).toBe("b");
    expect(mergeLww(newer, older).value).toBe("b");
    expect(
      workspaceKeyFor({
        kind: "space",
        id: "work",
        name: "Work",
        color: "#000",
        parentSpaceId: null,
        purpose: "",
        createdAt: 0,
        carriedOrigins: [],
        egressPolicy: "direct",
        cloudEnabled: false,
      }),
    ).toBe("space:work");
  });
});
