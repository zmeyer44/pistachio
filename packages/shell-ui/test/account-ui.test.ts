import { describe, expect, it } from "vitest";
import type { AccountState, DeviceInfo } from "@pistachio/shell-contracts/ipc";
import {
  accountStateLabel,
  accountStateTone,
  accountStep,
  controlErrorCode,
  DEFAULT_ACCOUNT,
  deviceIsRevoked,
  devicePlatformLabel,
  deviceSeenLabel,
  fingerprintGroups,
  formatFingerprint,
  sortDevices,
} from "../src/lib/account";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");

function device(patch: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Studio",
    platform: "macos",
    devicePublicKey: "ZGV2",
    agreementPublicKey: "YWdy",
    fingerprint: "aaaa bbbb cccc dddd eeee ffff 0000 1111",
    createdAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: "2026-09-02T11:55:00.000Z",
    revokedAt: null,
    isThisDevice: false,
    isPinnedCloudDevice: false,
    ...patch,
  };
}

function account(patch: Partial<AccountState> = {}): AccountState {
  return { ...DEFAULT_ACCOUNT, ...patch };
}

describe("the signed-out default", () => {
  it("is a complete AccountState with no keychain and no account", () => {
    // The store shows this while account:get is in flight AND when it fails,
    // so the page it renders must be the honest signed-out one.
    expect(DEFAULT_ACCOUNT.state).toBe("unenrolled");
    expect(DEFAULT_ACCOUNT.encryptionAvailable).toBe(false);
    expect(DEFAULT_ACCOUNT.revoked).toBe(false);
    expect(DEFAULT_ACCOUNT.deviceId).toBeNull();
    // JSON-plain: it is set into the store and read by every subscriber.
    expect(JSON.parse(JSON.stringify(DEFAULT_ACCOUNT))).toEqual(DEFAULT_ACCOUNT);
  });
});

describe("fingerprints", () => {
  it("renders any spelling of a fingerprint as the same 8 groups of 4", () => {
    const groups = ["aaaa", "bbbb", "cccc", "dddd", "eeee", "ffff", "0000", "1111"];
    expect(fingerprintGroups("aaaabbbbccccddddeeeeffff00001111")).toEqual(groups);
    expect(fingerprintGroups("AAAA BBBB CCCC DDDD EEEE FFFF 0000 1111")).toEqual(groups);
    expect(fingerprintGroups("aaaa-bbbb-cccc-dddd-eeee-ffff-0000-1111")).toEqual(groups);
    expect(formatFingerprint("aaaabbbbccccddddeeeeffff00001111")).toBe(groups.join(" "));
  });

  it("truncates a longer digest to 8 groups so two screens always compare the same span", () => {
    const long = "aaaabbbbccccddddeeeeffff00001111deadbeef";
    expect(fingerprintGroups(long)).toHaveLength(8);
    expect(formatFingerprint(long)).toBe("aaaa bbbb cccc dddd eeee ffff 0000 1111");
  });

  it("answers with nothing for anything short of a whole fingerprint", () => {
    // A half-rendered fingerprint invites a comparison that proves nothing,
    // and main answers "" for a key it could not read.
    expect(fingerprintGroups("")).toEqual([]);
    expect(fingerprintGroups("zz zz")).toEqual([]);
    expect(fingerprintGroups("aaaa bbbb")).toEqual([]);
    expect(formatFingerprint("no key here")).toBe("");
  });
});

describe("the model meter, in words", () => {
  it("formats tokens, money, and a usage line", async () => {
    const { formatTokens, formatUsd, modelUsageLabel, usageLine } = await import("../src/lib/account");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_340)).toBe("12.3K");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatUsd("0")).toBe("$0.00");
    expect(formatUsd("0.0015")).toBe("$0.0015");
    expect(formatUsd("1.5")).toBe("$1.50");
    expect(formatUsd("nope")).toBe("$0.00");
    expect(usageLine({ requests: 0, inputTokens: 0, outputTokens: 0, costUsd: "0" })).toBe("No model calls yet.");
    expect(usageLine({ requests: 1, inputTokens: 0, outputTokens: 0, costUsd: "0" })).toBe("1 request");
    expect(usageLine({ requests: 12, inputTokens: 1_200, outputTokens: 340, costUsd: "0.2" })).toBe("12 requests · 1.2K in · 340 out");
    expect(modelUsageLabel({ kind: "language-model", modelId: "openai/gpt-5.6-terra" })).toBe("openai/gpt-5.6-terra");
    expect(modelUsageLabel({ kind: "speech-model", modelId: null })).toBe("Speech");
    expect(modelUsageLabel({ kind: "other", modelId: "" })).toBe("Other");
  });
});

describe("what the account page says", () => {
  it("names the state, with revocation beating everything else", () => {
    expect(accountStateLabel(account())).toBe("Not signed in");
    expect(accountStateLabel(account({ state: "signed-up" }))).toBe("Signed up");
    expect(accountStateLabel(account({ state: "enrolled" }))).toBe("Enrolled");
    // Main keeps state 'enrolled' after a revocation (the keys stay), so the
    // label has to read the flag, not the state.
    expect(accountStateLabel(account({ state: "enrolled", revoked: true }))).toBe("Revoked");
    expect(accountStateTone(account({ state: "enrolled" }))).toBe("green");
    expect(accountStateTone(account({ state: "enrolled", revoked: true }))).toBe("red");
    expect(accountStateTone(account({ state: "signed-up" }))).toBe("amber");
    expect(accountStateTone(account())).toBe("gray");
  });

  it("treats an anonymous account as nobody signed in: the form, not the enrolled page", () => {
    const anonymous = account({ state: "anonymous", userId: "anon-1" });
    expect(accountStep(anonymous)).toBe("sign-in");
    expect(accountStateLabel(anonymous)).toBe("Not signed in");
    expect(accountStateTone(anonymous)).toBe("gray");
  });
});

describe("what the account page asks for next", () => {
  it("asks for the credentials when there is no account here", () => {
    expect(accountStep(account())).toBe("sign-in");
  });

  it("asks only for the enrollment once the account exists", () => {
    // Sign-up succeeded and enrollment did not: the account is made, so
    // creating it again is refused — only the missing half is retried.
    expect(accountStep(account({ state: "signed-up", email: "a@example.com" }))).toBe("enroll");
  });

  it("asks for nothing once this Mac is enrolled", () => {
    expect(accountStep(account({ state: "enrolled" }))).toBe("done");
  });

  it("sends a revoked Mac back to the sign-in form, whatever its state says", () => {
    // Main leaves `state: "enrolled"` on a revoked device and clears its
    // token; with the bootstrap token gone, enrolling again is impossible
    // and the only way back in is a fresh sign-in.
    expect(accountStep(account({ state: "enrolled", revoked: true }))).toBe("sign-in");
    expect(accountStep(account({ state: "signed-up", revoked: true }))).toBe("sign-in");
  });
});

describe("the control code inside a rejection that crossed IPC", () => {
  it("reads the code out of the message Electron flattened", () => {
    const rejected = new Error(
      "Error invoking remote method 'pistachio:imessage-link-start': Error: control: 400 invalid_phone (POST /v1/imessage/link/start)",
    );
    expect(controlErrorCode(rejected)).toBe("invalid_phone");
    expect(controlErrorCode(new Error("control: 429 rate_limited (POST /v1/imessage/link/start)"))).toBe("rate_limited");
  });

  it("answers nothing rather than a wrong code", () => {
    // No code sent, an explanation sent instead of one, a word that only
    // appears in the path, and anything that is not a control failure.
    expect(controlErrorCode(new Error("control: 404 (GET /v1/imessage/link)"))).toBeNull();
    expect(controlErrorCode(new Error("control: that number is not reachable (POST /v1/imessage/link/start)"))).toBeNull();
    expect(controlErrorCode(new Error("control: 500 (POST /v1/invalid_code/start)"))).toBeNull();
    expect(controlErrorCode(new Error("fetch failed"))).toBeNull();
    expect(controlErrorCode("invalid_phone")).toBeNull();
  });
});

describe("the device list", () => {
  it("names a browser signed in on the web as one, not as a Mac", () => {
    // Control's platform is "macos" | "web" | "cloud"; a web session used to
    // be collapsed into "macos" on the way through IPC and read as a Mac.
    expect(devicePlatformLabel(device({ platform: "web" }))).toBe("Web browser");
    expect(devicePlatformLabel(device({ platform: "web", isThisDevice: true }))).toBe("This Mac");
  });

  it("badges this Mac, the cloud browser, and everything else", () => {
    expect(devicePlatformLabel(device({ isThisDevice: true }))).toBe("This Mac");
    expect(devicePlatformLabel(device({ platform: "cloud" }))).toBe("Cloud browser");
    expect(devicePlatformLabel(device())).toBe("Mac");
    // A revoked cloud device is still the cloud device.
    expect(devicePlatformLabel(device({ platform: "cloud", revokedAt: "2026-09-01T00:00:00.000Z" }))).toBe("Cloud browser");
  });

  it("says when each device was last seen, and when it was revoked instead", () => {
    expect(deviceSeenLabel(device({ isThisDevice: true }), NOW)).toBe("Active now");
    expect(deviceSeenLabel(device(), NOW)).toBe("Last seen 5m ago");
    expect(deviceSeenLabel(device({ lastSeenAt: null }), NOW)).toBe("Never connected");
    expect(deviceSeenLabel(device({ revokedAt: "2026-08-30T12:00:00.000Z" }), NOW)).toBe("Revoked 3d ago");
    // Revocation wins over "this Mac": a revoked local device is not active.
    expect(deviceSeenLabel(device({ isThisDevice: true, revokedAt: "2026-09-02T11:00:00.000Z" }), NOW)).toBe("Revoked 1h ago");
    expect(deviceIsRevoked(device())).toBe(false);
    expect(deviceIsRevoked(device({ revokedAt: "2026-08-30T12:00:00.000Z" }))).toBe(true);
  });

  it("puts this Mac first, then the live devices by recency, then the revoked ones", () => {
    const ordered = sortDevices([
      device({ id: "d-old", name: "Old", lastSeenAt: "2026-08-20T12:00:00.000Z" }),
      device({ id: "d-gone", name: "Gone", revokedAt: "2026-09-01T12:00:00.000Z" }),
      device({ id: "d-cloud", name: "Cloud", platform: "cloud", lastSeenAt: "2026-09-02T11:59:00.000Z" }),
      device({ id: "d-self", name: "This one", isThisDevice: true, lastSeenAt: "2026-07-01T12:00:00.000Z" }),
    ]);
    expect(ordered.map((row) => row.id)).toEqual(["d-self", "d-cloud", "d-old", "d-gone"]);
  });

  it("orders devices that were never seen by name rather than at random", () => {
    const ordered = sortDevices([
      device({ id: "b", name: "Beta", lastSeenAt: null, createdAt: null }),
      device({ id: "a", name: "Alpha", lastSeenAt: null, createdAt: null }),
    ]);
    expect(ordered.map((row) => row.name)).toEqual(["Alpha", "Beta"]);
  });

  it("does not disturb the caller's array", () => {
    const input = [device({ id: "a" }), device({ id: "b", isThisDevice: true })];
    const ordered = sortDevices(input);
    expect(input.map((row) => row.id)).toEqual(["a", "b"]);
    expect(ordered.map((row) => row.id)).toEqual(["b", "a"]);
  });
});
