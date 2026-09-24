/**
 * AuthService (docs/cloud-sync-design.md §10.1): sign-in unwraps the
 * account's password wrappers, enroll sends this device's one id and a
 * proof its key made, wrappers ride under credentialIds `password` /
 * `recovery`, the cloud device is pinned on first enable and a changed one is
 * refused until confirmed, and sign-out keeps the device id.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`sealed:${plain}`, "utf8"),
    decryptString: (sealed: Buffer) => sealed.toString("utf8").slice("sealed:".length),
  },
}));

const { DeviceStore } = await import("../src/main/account/device-store");
const { AuthService, CloudDeviceChanged, keyFingerprint } = await import("../src/main/account/auth-service");
const { SpaceStore } = await import("../src/main/space-store");
const {
  deriveKekFromPassphrase,
  deriveKekFromRecoveryCode,
  deviceLoginSigningBytes,
  exportPublicKeyRaw,
  fromBase64,
  generateAgreementKeypair,
  importPublicKeyRaw,
  toBase64,
  unwrapRootSecret,
  unwrapRootSecretFromDevice,
  wrapRootSecret,
  WORKSPACE_PSEUDO_SPACE_ID,
} = await import("@pistachio/sync-protocol");

const PASSWORD = "correct-horse-battery";
const KDF_ITERATIONS = 1_000;
const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "pistachio-auth-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function jwtWith(payload: Record<string, unknown>): string {
  const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64url({ alg: "EdDSA", typ: "JWT" })}.${b64url(payload)}.c2ln`;
}

function tokenClaimsOf(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function bearerClaims(init: RequestInit | undefined): Record<string, unknown> | null {
  const header = new Headers(init?.headers).get("authorization") ?? "";
  return header.startsWith("Bearer ") ? tokenClaimsOf(header.slice("Bearer ".length)) : null;
}

function randomSecret(): Uint8Array {
  const secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  return secret;
}

interface Wrapper {
  spaceId: string;
  kind: string;
  credentialId: string;
  salt: string;
  wrapped: string;
  senderDeviceId: string | null;
  signature: string | null;
  createdAt: string | null;
}

interface FakeControl {
  fetch: typeof fetch;
  calls: Array<{ method: string; path: string; body: unknown }>;
  wrappers: Map<string, Wrapper[]>;
  spaces: Set<string>;
  devices: Array<Record<string, unknown>>;
  cloudDevice: Record<string, unknown> | null;
  enrollConflictsLeft: number;
  enrolledIds: string[];
  /** Anonymous accounts made, by user id → device id (docs/anonymous-accounts.md). */
  anonymous: Map<string, string>;
  anonymousMade: number;
  /** Answers to fail before the route runs: a flaky plane, a 5xx, a 429. */
  faults: Array<{ method: string; path: string; times: number; status?: number; body?: unknown }>;
  /** Requests that wait for the test before the route runs: a window held open. */
  holds: Array<{ method: string; path: string; until: Promise<void> }>;
}

function fakeControl(): FakeControl {
  const state: FakeControl = {
    fetch: undefined as unknown as typeof fetch,
    calls: [],
    wrappers: new Map(),
    spaces: new Set(["work", WORKSPACE_PSEUDO_SPACE_ID]),
    devices: [],
    cloudDevice: null,
    enrollConflictsLeft: 0,
    enrolledIds: [],
    anonymous: new Map(),
    anonymousMade: 0,
    faults: [],
    holds: [],
  };
  const exp = Math.floor(Date.now() / 1000) + 600;
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  state.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body = init?.body === null || init?.body === undefined ? null : (JSON.parse(String(init.body)) as Record<string, unknown>);
    state.calls.push({ method, path, body });
    const hold = state.holds.findIndex((h) => h.method === method && h.path === path);
    if (hold !== -1) await state.holds.splice(hold, 1)[0]!.until;
    const fault = state.faults.find((f) => f.method === method && f.path === path && f.times > 0);
    if (fault !== undefined) {
      fault.times -= 1;
      if (fault.status === undefined) throw new Error("ECONNRESET");
      return json(fault.body ?? { error: "unavailable" }, fault.status);
    }
    if (method === "POST" && path === "/v1/accounts")
      return json({ userId: "user-1", bootstrapToken: jwtWith({ sub: "user-1", did: "user-1", exp }), exp }, 201);
    if (method === "POST" && path === "/v1/auth/password-login") {
      if (body?.["password"] !== PASSWORD) return json({ error: "invalid_credentials" }, 403);
      return json({ userId: "user-1", bootstrapToken: jwtWith({ sub: "user-1", did: "user-1", exp }), exp });
    }
    if (method === "GET" && path === "/v1/spaces")
      return json({ spaces: [...state.spaces].filter((id) => id !== WORKSPACE_PSEUDO_SPACE_ID).map((id) => ({ id, name: id })) });
    const wrappersMatch = /^\/v1\/spaces\/([^/]+)\/wrappers$/.exec(path);
    if (wrappersMatch !== null) {
      const spaceId = decodeURIComponent(wrappersMatch[1]!);
      if (method === "GET") return json({ wrappers: state.wrappers.get(spaceId) ?? [] });
      if (method === "PUT") {
        if (!state.spaces.has(spaceId)) return json({ error: "unknown_space" }, 404);
        const rows = state.wrappers.get(spaceId) ?? [];
        for (const raw of (body?.["wrappers"] as Array<Record<string, unknown>>) ?? []) {
          const row: Wrapper = {
            spaceId,
            kind: String(raw["kind"]),
            credentialId: String(raw["credentialId"]),
            salt: String(raw["salt"]),
            wrapped: String(raw["wrapped"]),
            senderDeviceId: typeof raw["senderDeviceId"] === "string" ? raw["senderDeviceId"] : null,
            signature: typeof raw["signature"] === "string" ? raw["signature"] : null,
            createdAt: null,
          };
          const index = rows.findIndex((r) => r.kind === row.kind && r.credentialId === row.credentialId);
          if (index === -1) rows.push(row);
          else rows[index] = row;
        }
        state.wrappers.set(spaceId, rows);
        return json({ wrappers: rows });
      }
    }
    const wrapperDelete = /^\/v1\/spaces\/([^/]+)\/wrappers\/([^/]+)\/([^/]+)$/.exec(path);
    if (method === "DELETE" && wrapperDelete !== null) return new Response(null, { status: 204 });
    const spaceMatch = /^\/v1\/spaces\/([^/]+)$/.exec(path);
    if (method === "PUT" && spaceMatch !== null) {
      state.spaces.add(decodeURIComponent(spaceMatch[1]!));
      return json({ ok: true });
    }
    if (method === "POST" && path === "/v1/auth/device-challenge") return json({ challenge: `challenge-${String(state.calls.length)}` });
    if (method === "POST" && path === "/v1/devices/enroll") {
      if (state.enrollConflictsLeft > 0) {
        state.enrollConflictsLeft -= 1;
        return json({ error: "device_id_taken" }, 409);
      }
      const deviceId = String(body?.["deviceId"]);
      const publicKey = await importPublicKeyRaw(fromBase64(String(body?.["devicePublicKey"])));
      const valid = await crypto.subtle.verify(
        "Ed25519",
        publicKey,
        fromBase64(String(body?.["signature"])) as BufferSource,
        deviceLoginSigningBytes(deviceId, String(body?.["challenge"])) as BufferSource,
      );
      if (!valid) return json({ error: "bad_signature" }, 401);
      if (body?.["platform"] !== "macos") return json({ error: "platform_not_allowed" }, 400);
      state.enrolledIds.push(deviceId);
      const device = {
        id: deviceId,
        name: body?.["name"],
        platform: "macos",
        devicePublicKey: body?.["devicePublicKey"],
        agreementPublicKey: body?.["agreementPublicKey"],
        createdAt: "now",
        lastSeenAt: null,
        revokedAt: null,
      };
      state.devices.push(device);
      return json({ device, token: jwtWith({ sub: "user-1", did: deviceId, exp }), exp }, 201);
    }
    if (method === "POST" && path === "/v1/accounts/anonymous") {
      if (state.enrollConflictsLeft > 0) {
        state.enrollConflictsLeft -= 1;
        return json({ error: "device_already_enrolled" }, 409);
      }
      const deviceId = String(body?.["deviceId"]);
      state.anonymousMade += 1;
      const userId = `anon-${String(state.anonymousMade)}`;
      state.anonymous.set(userId, deviceId);
      const device = { id: deviceId, name: body?.["name"], platform: "macos", devicePublicKey: body?.["devicePublicKey"], agreementPublicKey: body?.["agreementPublicKey"] };
      return json({ userId, device, token: jwtWith({ sub: userId, did: deviceId, exp }), exp }, 201);
    }
    if (method === "POST" && path === "/v1/account/upgrade") {
      const claims = bearerClaims(init);
      const userId = String(claims?.["sub"]);
      if (!state.anonymous.has(userId)) return json({ error: "not_anonymous" }, 409);
      if (body?.["email"] === "taken@example.com") return json({ error: "email_taken" }, 409);
      state.devices.push({ id: state.anonymous.get(userId), platform: "macos" });
      state.anonymous.delete(userId);
      return json({ userId, email: body?.["email"] });
    }
    if (method === "POST" && path === "/v1/account/link") {
      const claims = bearerClaims(init);
      const from = tokenClaimsOf(String(body?.["anonymousToken"]));
      const fromUser = String(from?.["sub"]);
      if (claims?.["sub"] !== claims?.["did"] || !state.anonymous.has(fromUser)) return json({ error: "not_anonymous" }, 409);
      const deviceId = state.anonymous.get(fromUser)!;
      state.anonymous.delete(fromUser);
      const device = { id: deviceId, platform: "macos" };
      state.devices.push(device);
      return json({ linked: true, usageRows: 0, device, token: jwtWith({ sub: claims?.["sub"], did: deviceId, exp }), exp });
    }
    if (method === "POST" && path === "/v1/auth/device-login")
      return json({ token: jwtWith({ sub: "user-1", did: body?.["deviceId"], exp }), exp });
    if (method === "POST" && path === "/v1/auth/password") {
      if (body?.["currentPassword"] !== PASSWORD) return json({ error: "invalid_credentials" }, 403);
      return json({ ok: true });
    }
    if (method === "GET" && path === "/v1/me")
      return json({ userId: "user-1", email: "pat@example.com", hubUrl: "ws://hub.test/v1/hub/ws", cloudBrowserUrl: "http://cloud.test", egress: null, features: {} });
    if (method === "GET" && path === "/v1/devices") return json({ devices: [...state.devices, ...(state.cloudDevice === null ? [] : [state.cloudDevice])] });
    if (method === "POST" && path === "/v1/cloud/enable") return json({ device: state.cloudDevice });
    if (method === "POST" && path === "/v1/cloud/disable") return new Response(null, { status: 204 });
    return json({ error: "not_found" }, 404);
  }) as typeof fetch;
  return state;
}

async function cloudDevice(id: string): Promise<{ record: Record<string, unknown>; agreementPrivateKey: CryptoKey; agreementPublicKeyRaw: Uint8Array }> {
  const agreement = await generateAgreementKeypair();
  const raw = await exportPublicKeyRaw(agreement.publicKey);
  return {
    record: {
      id,
      name: "Cloud browser",
      platform: "cloud",
      devicePublicKey: toBase64(new Uint8Array(32)),
      agreementPublicKey: toBase64(raw),
      createdAt: "now",
      lastSeenAt: null,
      revokedAt: null,
    },
    agreementPrivateKey: agreement.privateKey,
    agreementPublicKeyRaw: raw,
  };
}

async function passwordWrapper(spaceId: string, secret: Uint8Array, password: string): Promise<Wrapper> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const kek = await deriveKekFromPassphrase(password, salt, KDF_ITERATIONS);
  return {
    spaceId,
    kind: "password",
    credentialId: "password",
    salt: toBase64(salt),
    wrapped: toBase64(await wrapRootSecret(kek, secret, spaceId)),
    senderDeviceId: null,
    signature: null,
    createdAt: null,
  };
}

type DeviceStoreInstance = Awaited<ReturnType<typeof DeviceStore.load>>;

interface Harness {
  auth: InstanceType<typeof AuthService>;
  store: DeviceStoreInstance;
  spaces: InstanceType<typeof SpaceStore>;
  control: FakeControl;
  states: Array<{ state: string; cloudDeviceChanged: unknown; revoked: boolean }>;
  events: string[];
}

async function harness(control = fakeControl(), options: { anonymousAccounts?: boolean; now?: () => number } = {}): Promise<Harness> {
  const dir = scratch();
  const store = await DeviceStore.load(dir, { deviceName: "Test Mac" });
  const spaces = new SpaceStore(dir);
  const states: Harness["states"] = [];
  const events: string[] = [];
  const auth = new AuthService({
    store,
    spaces,
    controlUrl: "http://control.test",
    fetchImpl: control.fetch,
    kdfIterations: KDF_ITERATIONS,
    ...options,
    publish: (state) => states.push({ state: state.state, cloudDeviceChanged: state.cloudDeviceChanged, revoked: state.revoked }),
    onEnrolled: () => events.push("enrolled"),
    onSignedOut: (reason) => {
      events.push(`signed-out:${reason}`);
    },
    onTokenChanged: () => events.push("token"),
  });
  return { auth, store, spaces, control, states, events };
}

describe("signIn", () => {
  it("links the account and unwraps the password-sealed Space and workspace secrets", async () => {
    const control = fakeControl();
    const spaceSecret = randomSecret();
    const workspaceSecret = randomSecret();
    control.wrappers.set("work", [await passwordWrapper("work", spaceSecret, PASSWORD)]);
    control.wrappers.set(WORKSPACE_PSEUDO_SPACE_ID, [await passwordWrapper(WORKSPACE_PSEUDO_SPACE_ID, workspaceSecret, PASSWORD)]);
    const { auth, store } = await harness(control);

    const state = await auth.signIn("Pat@Example.com ", PASSWORD);

    expect(state.state).toBe("signed-up");
    expect(state.email).toBe("pat@example.com");
    expect(state.userId).toBe("user-1");
    expect(store.enrollment().bootstrapToken).not.toBeNull();
    expect(store.enrollment().token).toBeNull();
    expect(store.spaceSecret("work")).toEqual(spaceSecret);
    expect(store.workspaceSecret()).toEqual(workspaceSecret);
    expect(control.calls.map((call) => `${call.method} ${call.path}`)).toContain(`GET /v1/spaces/${WORKSPACE_PSEUDO_SPACE_ID}/wrappers`);
  });

  it("rejects a wrong password without touching enrollment", async () => {
    const { auth, store } = await harness();
    await expect(auth.signIn("pat@example.com", "not-it")).rejects.toThrow();
    expect(store.enrollment().state).toBe("unenrolled");
    expect(store.workspaceSecret()).toBeNull();
    expect(auth.state().error).toMatch(/did not match/);
  });

  it("skips a tampered wrapper but still links the account", async () => {
    const control = fakeControl();
    const workspaceSecret = randomSecret();
    const tampered = await passwordWrapper("work", randomSecret(), PASSWORD);
    tampered.wrapped = toBase64(randomSecret());
    control.wrappers.set("work", [tampered]);
    control.wrappers.set(WORKSPACE_PSEUDO_SPACE_ID, [await passwordWrapper(WORKSPACE_PSEUDO_SPACE_ID, workspaceSecret, PASSWORD)]);
    const { auth, store } = await harness(control);
    expect((await auth.signIn("pat@example.com", PASSWORD)).state).toBe("signed-up");
    expect(store.spaceSecret("work")).toBeNull();
    expect(store.workspaceSecret()).toEqual(workspaceSecret);
  });
});

describe("enroll", () => {
  it("sends this Mac's one device id with a proof its key signed, then seals every secret under the password and a recovery code", async () => {
    const { auth, store, control, events } = await harness();
    await auth.signUp("pat@example.com", PASSWORD);
    const result = await auth.enroll();

    expect(result.state.state).toBe("enrolled");
    expect(control.enrolledIds).toEqual([store.deviceId]);
    const enroll = control.calls.find((call) => call.path === "/v1/devices/enroll")?.body as Record<string, unknown>;
    expect(enroll["deviceId"]).toBe(store.deviceId);
    expect(enroll["platform"]).toBe("macos");
    expect(enroll["agreementPublicKey"]).toBe(store.agreementPublicKey());
    expect(store.enrollment().token).not.toBeNull();
    expect(store.enrollment().bootstrapToken).toBeNull();
    expect(events).toContain("enrolled");

    // A root secret for every local Space and the workspace, sealed twice.
    expect(store.spaceSecret("work")).not.toBeNull();
    expect(store.workspaceSecret()).not.toBeNull();
    expect(result.recoveryCode).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
    for (const spaceId of ["work", WORKSPACE_PSEUDO_SPACE_ID]) {
      const rows = control.wrappers.get(spaceId) ?? [];
      const expected = spaceId === "work" ? store.spaceSecret("work") : store.workspaceSecret();
      const password = rows.find((row) => row.kind === "password");
      expect(password?.credentialId).toBe("password");
      const kek = await deriveKekFromPassphrase(PASSWORD, fromBase64(password!.salt), KDF_ITERATIONS);
      expect(await unwrapRootSecret(kek, fromBase64(password!.wrapped), spaceId)).toEqual(expected);
      const recovery = rows.find((row) => row.kind === "recovery-code");
      expect(recovery?.credentialId).toBe("recovery");
      const recoveryKek = await deriveKekFromRecoveryCode(result.recoveryCode!, fromBase64(recovery!.salt), KDF_ITERATIONS);
      expect(await unwrapRootSecret(recoveryKek, fromBase64(recovery!.wrapped), spaceId)).toEqual(expected);
    }
    // Enrolling again is idempotent and shows no second code.
    expect((await auth.enroll()).recoveryCode).toBeNull();
  });

  it("mints a new identity when control already knows the id, and asserts the answered id", async () => {
    const control = fakeControl();
    control.enrollConflictsLeft = 1;
    const { auth, store } = await harness(control);
    const before = store.deviceId;
    await auth.signUp("pat@example.com", PASSWORD);
    await auth.enroll();
    expect(store.deviceId).not.toBe(before);
    expect(control.enrolledIds).toEqual([store.deviceId]);
  });

  it("does not re-upload the account's recovery wrappers for a device that joined by sign-in", async () => {
    const control = fakeControl();
    const spaceSecret = randomSecret();
    const workspaceSecret = randomSecret();
    control.wrappers.set("work", [await passwordWrapper("work", spaceSecret, PASSWORD)]);
    control.wrappers.set(WORKSPACE_PSEUDO_SPACE_ID, [await passwordWrapper(WORKSPACE_PSEUDO_SPACE_ID, workspaceSecret, PASSWORD)]);
    const { auth, store } = await harness(control);
    await auth.signIn("pat@example.com", PASSWORD);
    const result = await auth.enroll();
    expect(result.recoveryCode).toBeNull();
    expect(store.spaceSecret("work")).toEqual(spaceSecret);
    expect((control.wrappers.get("work") ?? []).some((row) => row.kind === "recovery-code")).toBe(false);
  });
});

describe("enroll without the account's keys", () => {
  it("never mints a stand-in secret, nor uploads over the account's wrapper, for a Space whose wrapper could not be read", async () => {
    // Mac B signs in while the plane is flaky: `work`'s wrapper listing
    // fails once. The account's key for `work` still exists — minting a
    // fresh one here would fork the Space AND replace the account's password
    // wrapper with one only this Mac can open.
    const control = fakeControl();
    const spaceSecret = randomSecret();
    const workspaceSecret = randomSecret();
    const original = await passwordWrapper("work", spaceSecret, PASSWORD);
    control.wrappers.set("work", [original]);
    control.wrappers.set(WORKSPACE_PSEUDO_SPACE_ID, [await passwordWrapper(WORKSPACE_PSEUDO_SPACE_ID, workspaceSecret, PASSWORD)]);
    control.faults.push({ method: "GET", path: "/v1/spaces/work/wrappers", times: 1 });
    const { auth, store } = await harness(control);

    await auth.signIn("pat@example.com", PASSWORD);
    const result = await auth.enroll();

    expect(result.state.state).toBe("enrolled");
    expect(store.spaceSecret("work")).toBeNull();
    expect(store.workspaceSecret()).toEqual(workspaceSecret);
    const rows = control.wrappers.get("work") ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "password", credentialId: "password", wrapped: original.wrapped, salt: original.salt });
    // And it says so rather than looking like a Space that simply syncs.
    expect(auth.state().error).toMatch(/could not obtain the keys for Operations\b/);
  });

  it("keeps a Space keyless when its password wrapper no longer opens, and still enrolls", async () => {
    // A password reset purged the wrappers (§7.3), or the seal is a tampered
    // one: the account may still hold the key under its recovery code.
    const control = fakeControl();
    const workspaceSecret = randomSecret();
    control.wrappers.set("work", []);
    control.wrappers.set(WORKSPACE_PSEUDO_SPACE_ID, [await passwordWrapper(WORKSPACE_PSEUDO_SPACE_ID, workspaceSecret, PASSWORD)]);
    const { auth, store } = await harness(control);

    await auth.signIn("pat@example.com", PASSWORD);
    await auth.enroll();

    expect(store.spaceSecret("work")).toBeNull();
    expect((control.wrappers.get("work") ?? []).filter((row) => row.kind === "password")).toEqual([]);
    expect(auth.state().error).toMatch(/could not obtain the keys for Operations\b/);
  });

  it("still mints and uploads for a Space the account has never seen", async () => {
    const control = fakeControl();
    control.wrappers.set(WORKSPACE_PSEUDO_SPACE_ID, [await passwordWrapper(WORKSPACE_PSEUDO_SPACE_ID, randomSecret(), PASSWORD)]);
    control.wrappers.set("work", [await passwordWrapper("work", randomSecret(), PASSWORD)]);
    const { auth, store, spaces } = await harness(control);
    const fork = spaces.createFork("work", "Personal", "shopping", []);

    await auth.signIn("pat@example.com", PASSWORD);
    await auth.enroll();

    expect(store.spaceSecret(fork.id)).not.toBeNull();
    const rows = control.wrappers.get(fork.id) ?? [];
    expect(rows.some((row) => row.kind === "password")).toBe(true);
    expect(auth.state().error).toBeNull();
  });
});

describe("the device-login proof after a rejected token", () => {
  it("keeps the enrollment when the challenge is rate-limited", async () => {
    const { auth, store, control, events } = await harness();
    await auth.signUp("pat@example.com", PASSWORD);
    await auth.enroll();
    const token = store.enrollment().token;

    control.faults.push({ method: "POST", path: "/v1/auth/token/refresh", times: 1, status: 401, body: { error: "unauthorized" } });
    control.faults.push({ method: "POST", path: "/v1/auth/device-challenge", times: 1, status: 429, body: { error: "rate_limited" } });
    await auth.controlClient().refresh();

    expect(store.enrollment().token).toBe(token);
    expect(auth.state().revoked).toBe(false);
    expect(auth.enrolled()).toBe(true);
    expect(events).not.toContain("signed-out:revoked");
    auth.shutdown();
  });

  it("keeps the enrollment when the challenge went stale before the proof landed", async () => {
    const { auth, store, control, events } = await harness();
    await auth.signUp("pat@example.com", PASSWORD);
    await auth.enroll();
    const token = store.enrollment().token;

    control.faults.push({ method: "POST", path: "/v1/auth/token/refresh", times: 1, status: 401, body: { error: "unauthorized" } });
    control.faults.push({
      method: "POST",
      path: "/v1/auth/device-login",
      times: 1,
      status: 401,
      body: { error: "unauthorized", reason: "challenge_expired" },
    });
    await auth.controlClient().refresh();

    expect(store.enrollment().token).toBe(token);
    expect(auth.state().revoked).toBe(false);
    expect(events).not.toContain("signed-out:revoked");
    auth.shutdown();
  });

  it("still reports revocation when control refuses this Mac's key", async () => {
    const { auth, store, control, events } = await harness();
    await auth.signUp("pat@example.com", PASSWORD);
    await auth.enroll();

    control.faults.push({ method: "POST", path: "/v1/auth/token/refresh", times: 1, status: 401, body: { error: "unauthorized" } });
    control.faults.push({
      method: "POST",
      path: "/v1/auth/device-login",
      times: 1,
      status: 401,
      body: { error: "unauthorized", reason: "device_revoked" },
    });
    await auth.controlClient().refresh();

    expect(store.enrollment().token).toBeNull();
    expect(auth.state().revoked).toBe(true);
    expect(events).toContain("signed-out:revoked");
    auth.shutdown();
  });
});

describe("changePassword", () => {
  it("re-seals the password wrappers under the new password", async () => {
    const { auth, store, control } = await harness();
    await auth.signUp("pat@example.com", PASSWORD);
    await auth.enroll();
    await auth.changePassword(PASSWORD, "a-brand-new-password");
    const change = control.calls.find((call) => call.path === "/v1/auth/password")?.body;
    expect(change).toEqual({ currentPassword: PASSWORD, newPassword: "a-brand-new-password" });
    for (const spaceId of ["work", WORKSPACE_PSEUDO_SPACE_ID]) {
      const row = (control.wrappers.get(spaceId) ?? []).find((r) => r.kind === "password")!;
      const kek = await deriveKekFromPassphrase("a-brand-new-password", fromBase64(row.salt), KDF_ITERATIONS);
      const expected = spaceId === "work" ? store.spaceSecret("work") : store.workspaceSecret();
      expect(await unwrapRootSecret(kek, fromBase64(row.wrapped), spaceId)).toEqual(expected);
    }
  });
});

describe("enableCloud", () => {
  it("pins the cloud device on first use and wraps the Space and workspace secrets to it, signed by this Mac", async () => {
    const control = fakeControl();
    const cloud = await cloudDevice("cloud-1");
    control.cloudDevice = cloud.record;
    const { auth, store, spaces } = await harness(control);
    await auth.signUp("pat@example.com", PASSWORD);
    await auth.enroll();

    await auth.enableCloud("work");

    expect(store.cloudDevicePin()).toEqual({ deviceId: "cloud-1", agreementPublicKey: cloud.record["agreementPublicKey"] });
    expect(spaces.get("work")?.cloudEnabled).toBe(true);
    expect(auth.state().cloudDevicePin?.fingerprint).toBe(keyFingerprint(String(cloud.record["agreementPublicKey"])));
    const senderKey = await importPublicKeyRaw(fromBase64(store.devicePublicKey()));
    for (const spaceId of ["work", WORKSPACE_PSEUDO_SPACE_ID]) {
      const row = (control.wrappers.get(spaceId) ?? []).find((r) => r.kind === "device-x25519")!;
      expect(row.credentialId).toBe("cloud-1");
      expect(row.senderDeviceId).toBe(store.deviceId);
      const secret = await unwrapRootSecretFromDevice(
        { ...row, kind: "device-x25519", createdAtMs: 0, senderDeviceId: row.senderDeviceId!, signature: row.signature! },
        spaceId,
        { deviceId: "cloud-1", agreementPrivateKey: cloud.agreementPrivateKey, agreementPublicKeyRaw: cloud.agreementPublicKeyRaw },
        senderKey,
      );
      expect(secret).toEqual(spaceId === "work" ? store.spaceSecret("work") : store.workspaceSecret());
    }
  });

  it("refuses to wrap when control introduces a device that differs from the pin, until it is confirmed", async () => {
    const control = fakeControl();
    const first = await cloudDevice("cloud-1");
    control.cloudDevice = first.record;
    const { auth, store, spaces, control: fake, states } = await harness(control);
    await auth.signUp("pat@example.com", PASSWORD);
    await auth.enroll();
    await auth.enableCloud("work");

    // A second Space, after control swapped the cloud device underneath.
    const child = spaces.createFork("work", "Child", "", []);
    await auth.ensureSpaceSecrets();
    const replacement = await cloudDevice("cloud-2");
    fake.cloudDevice = replacement.record;
    const wrapperPutsBefore = fake.calls.filter((call) => call.method === "PUT" && call.path.endsWith("/wrappers")).length;

    await expect(auth.enableCloud(child.id)).rejects.toBeInstanceOf(CloudDeviceChanged);

    expect(fake.calls.filter((call) => call.method === "PUT" && call.path.endsWith("/wrappers")).length).toBe(wrapperPutsBefore);
    expect(store.cloudDevicePin()?.deviceId).toBe("cloud-1");
    expect(spaces.get(child.id)?.cloudEnabled).toBe(false);
    expect(auth.state().cloudDeviceChanged?.deviceId).toBe("cloud-2");
    expect(states.at(-1)?.cloudDeviceChanged).toMatchObject({ deviceId: "cloud-2" });

    auth.confirmCloudDevice();
    expect(store.cloudDevicePin()?.deviceId).toBe("cloud-2");
    expect(auth.state().cloudDeviceChanged).toBeNull();
    await auth.enableCloud(child.id);
    expect(spaces.get(child.id)?.cloudEnabled).toBe(true);
    expect((fake.wrappers.get(child.id) ?? []).find((r) => r.kind === "device-x25519")?.credentialId).toBe("cloud-2");
  });

  it("refuses a device that is not a cloud device or has a malformed key", async () => {
    const control = fakeControl();
    const { auth } = await harness(control);
    await auth.signUp("pat@example.com", PASSWORD);
    await auth.enroll();
    control.cloudDevice = { ...(await cloudDevice("cloud-1")).record, platform: "macos" };
    await expect(auth.enableCloud("work")).rejects.toThrow(/invalid cloud device/);
    control.cloudDevice = { ...(await cloudDevice("cloud-1")).record, agreementPublicKey: toBase64(new Uint8Array(16)) };
    await expect(auth.enableCloud("work")).rejects.toThrow(/16 bytes/);
  });

  it("disableCloud clears the flag and drops the pin once no Space is left", async () => {
    const control = fakeControl();
    control.cloudDevice = (await cloudDevice("cloud-1")).record;
    const { auth, store, spaces } = await harness(control);
    await auth.signUp("pat@example.com", PASSWORD);
    await auth.enroll();
    await auth.enableCloud("work");
    await auth.disableCloud("work");
    expect(spaces.get("work")?.cloudEnabled).toBe(false);
    expect(store.cloudDevicePin()).toBeNull();
  });
});

describe("signOut and revocation", () => {
  it("forgets the account and its secrets but keeps the device id and keys", async () => {
    const { auth, store, events } = await harness();
    await auth.signUp("pat@example.com", PASSWORD);
    await auth.enroll();
    const deviceId = store.deviceId;
    const publicKey = store.devicePublicKey();
    const state = await auth.signOut();
    expect(state.state).toBe("unenrolled");
    expect(store.deviceId).toBe(deviceId);
    expect(store.devicePublicKey()).toBe(publicKey);
    expect(store.spaceSecretIds()).toEqual([]);
    expect(store.enrollment().token).toBeNull();
    expect(events).toContain("signed-out:sign-out");
    expect(auth.enrolled()).toBe(false);
  });

  it("lists devices with this Mac and the pinned cloud device marked", async () => {
    const control = fakeControl();
    control.cloudDevice = (await cloudDevice("cloud-1")).record;
    const { auth, store } = await harness(control);
    await auth.signUp("pat@example.com", PASSWORD);
    await auth.enroll();
    await auth.enableCloud("work");
    const devices = await auth.listDevices();
    expect(devices.find((device) => device.id === store.deviceId)?.isThisDevice).toBe(true);
    expect(devices.find((device) => device.id === "cloud-1")).toMatchObject({ platform: "cloud", isPinnedCloudDevice: true });
  });
});

describe("anonymous accounts", () => {
  const paths = (control: FakeControl): string[] => control.calls.map((call) => `${call.method} ${call.path}`);

  it("makes no call unless asked to: a service without the option stays accountless", async () => {
    const { auth, control, store } = await harness();
    auth.start();
    expect(await auth.ensureAnonymous()).toBe(false);
    expect(await auth.getModelToken()).toBeNull();
    expect(control.calls).toHaveLength(0);
    expect(store.enrollment().state).toBe("unenrolled");
  });

  it("gives a Mac nobody signed in on an account of its own, for the models alone", async () => {
    const { auth, control, store, states, events } = await harness(fakeControl(), { anonymousAccounts: true });
    expect(auth.modelsAvailable()).toBe(false);

    expect(await auth.ensureAnonymous()).toBe(true);

    expect(store.enrollment()).toMatchObject({ state: "anonymous", userId: "anon-1", email: null, bootstrapToken: null });
    expect(auth.state().state).toBe("anonymous");
    expect(states.at(-1)?.state).toBe("anonymous");
    expect(auth.modelsAvailable()).toBe(true);
    expect(await auth.getModelToken()).toBe(store.enrollment().token);
    // Not an enrolled account: nothing that syncs or holds keys may start.
    expect(auth.enrolled()).toBe(false);
    expect(await auth.getToken()).toBeNull();
    expect(events).toEqual([]);
    expect(store.workspaceSecret()).toBeNull();
    const signUp = control.calls.find((call) => call.path === "/v1/accounts/anonymous");
    expect((signUp?.body as Record<string, unknown>)["deviceId"]).toBe(store.deviceId);
    // Once is enough.
    await auth.ensureAnonymous();
    expect(paths(control).filter((p) => p === "POST /v1/accounts/anonymous")).toHaveLength(1);
  });

  it("shares one sign-up between a launch and the first model call", async () => {
    const { auth, control } = await harness(fakeControl(), { anonymousAccounts: true });
    auth.start();
    const [a, b] = await Promise.all([auth.ensureAnonymous(), auth.getModelToken()]);
    expect(a).toBe(true);
    expect(b).not.toBeNull();
    expect(paths(control).filter((p) => p === "POST /v1/accounts/anonymous")).toHaveLength(1);
  });

  it("mints a new identity when control already knows this one", async () => {
    const control = fakeControl();
    control.enrollConflictsLeft = 1;
    const { auth, store } = await harness(control, { anonymousAccounts: true });
    const before = store.deviceId;
    expect(await auth.ensureAnonymous()).toBe(true);
    expect(store.deviceId).not.toBe(before);
    expect(control.anonymous.get("anon-1")).toBe(store.deviceId);
  });

  it("stays quiet when control is unreachable, and waits before trying again", async () => {
    let at = 1_000;
    const control = fakeControl();
    control.faults.push({ method: "POST", path: "/v1/auth/device-challenge", times: 1 });
    const { auth, store } = await harness(control, { anonymousAccounts: true, now: () => at });
    expect(await auth.ensureAnonymous()).toBe(false);
    expect(store.enrollment().state).toBe("unenrolled");
    expect(auth.state().error).toBeNull();
    const calls = control.calls.length;
    expect(await auth.ensureAnonymous()).toBe(false);
    expect(control.calls).toHaveLength(calls);
    at += 30_000;
    expect(await auth.ensureAnonymous()).toBe(true);
    auth.shutdown();
  });

  it("restores the anonymous token at startup without starting anything an account starts", async () => {
    const control = fakeControl();
    const first = await harness(control, { anonymousAccounts: true });
    await first.auth.ensureAnonymous();
    const events: string[] = [];
    const again = new AuthService({
      store: first.store,
      spaces: first.spaces,
      controlUrl: "http://control.test",
      fetchImpl: control.fetch,
      anonymousAccounts: true,
      publish: () => undefined,
      onEnrolled: () => events.push("enrolled"),
    });
    again.start();
    expect(again.modelsAvailable()).toBe(true);
    expect(await again.getModelToken()).toBe(first.store.enrollment().token);
    expect(events).toEqual([]);
  });

  it("signing up upgrades the anonymous account in place: same user, same token, first keys and a recovery code", async () => {
    const { auth, control, store, events } = await harness(fakeControl(), { anonymousAccounts: true });
    await auth.ensureAnonymous();
    const token = store.enrollment().token;

    const state = await auth.signUp("Pat@Example.com", PASSWORD);

    expect(paths(control)).toContain("POST /v1/account/upgrade");
    expect(paths(control)).not.toContain("POST /v1/accounts");
    expect(state).toMatchObject({ state: "signed-up", userId: "anon-1", email: "pat@example.com" });
    expect(store.enrollment().token).toBe(token);
    // Between sign-up and enroll the models keep working.
    expect(auth.modelsAvailable()).toBe(true);

    const enrolled = await auth.enroll();

    // The device was the account's all along: nothing to enroll.
    expect(paths(control)).not.toContain("POST /v1/devices/enroll");
    expect(enrolled.state.state).toBe("enrolled");
    expect(enrolled.recoveryCode).not.toBeNull();
    expect(store.enrollment().token).toBe(token);
    expect(auth.enrolled()).toBe(true);
    expect(events).toEqual(["enrolled"]);
    expect(store.workspaceSecret()).not.toBeNull();
    const kinds = (control.wrappers.get(WORKSPACE_PSEUDO_SPACE_ID) ?? []).map((w) => w.kind).sort();
    expect(kinds).toEqual(["password", "recovery-code"]);
  });

  it("finishes an upgrade after a restart between sign-up and enroll", async () => {
    const control = fakeControl();
    const first = await harness(control, { anonymousAccounts: true });
    await first.auth.ensureAnonymous();
    await first.auth.signUp("pat@example.com", PASSWORD);
    const again = new AuthService({
      store: first.store,
      spaces: first.spaces,
      controlUrl: "http://control.test",
      fetchImpl: control.fetch,
      kdfIterations: KDF_ITERATIONS,
      anonymousAccounts: true,
      publish: () => undefined,
    });
    again.start();
    expect(again.modelsAvailable()).toBe(true);
    expect((await again.enroll()).state.state).toBe("enrolled");
    expect(paths(control)).not.toContain("POST /v1/devices/enroll");
    expect(paths(control).filter((p) => p === "POST /v1/accounts/anonymous")).toHaveLength(1);
  });

  it("leaves the anonymous account as it was when the email is taken", async () => {
    const { auth, store } = await harness(fakeControl(), { anonymousAccounts: true });
    await auth.ensureAnonymous();
    await expect(auth.signUp("taken@example.com", PASSWORD)).rejects.toThrow();
    expect(store.enrollment().state).toBe("anonymous");
    expect(auth.modelsAvailable()).toBe(true);
    expect(auth.state().error).toMatch(/already has an account/);
  });

  it("signing in to an existing account folds the anonymous one into it, device included", async () => {
    const control = fakeControl();
    const workspaceSecret = randomSecret();
    control.wrappers.set(WORKSPACE_PSEUDO_SPACE_ID, [await passwordWrapper(WORKSPACE_PSEUDO_SPACE_ID, workspaceSecret, PASSWORD)]);
    const { auth, store, events } = await harness(control, { anonymousAccounts: true });
    await auth.ensureAnonymous();
    const anonymousToken = store.enrollment().token;
    const deviceId = store.deviceId;

    const state = await auth.signIn("pat@example.com", PASSWORD);

    const link = control.calls.find((call) => call.path === "/v1/account/link");
    expect((link?.body as Record<string, unknown>)["anonymousToken"]).toBe(anonymousToken);
    expect(state).toMatchObject({ state: "signed-up", userId: "user-1", email: "pat@example.com" });
    expect(store.enrollment().token).not.toBe(anonymousToken);
    expect(store.enrollment().token).not.toBeNull();
    expect(store.workspaceSecret()).toEqual(workspaceSecret);
    expect(control.anonymous.size).toBe(0);

    const enrolled = await auth.enroll();
    expect(paths(control)).not.toContain("POST /v1/devices/enroll");
    expect(store.deviceId).toBe(deviceId);
    expect(enrolled.state.state).toBe("enrolled");
    // A joined account keeps its own recovery code.
    expect(enrolled.recoveryCode).toBeNull();
    expect(events).toEqual(["enrolled"]);
  });

  it("a wrong password leaves the anonymous account working", async () => {
    const { auth, store } = await harness(fakeControl(), { anonymousAccounts: true });
    await auth.ensureAnonymous();
    const token = store.enrollment().token;
    await expect(auth.signIn("pat@example.com", "not-it")).rejects.toThrow();
    expect(store.enrollment()).toMatchObject({ state: "anonymous", token });
    expect(await auth.getModelToken()).toBe(token);
  });

  it("enrolls afresh when the link is refused", async () => {
    const control = fakeControl();
    control.faults.push({ method: "POST", path: "/v1/account/link", times: 1, status: 409, body: { error: "not_anonymous" } });
    const { auth, store } = await harness(control, { anonymousAccounts: true });
    await auth.ensureAnonymous();
    await auth.signIn("pat@example.com", PASSWORD);
    expect(store.enrollment()).toMatchObject({ state: "signed-up", token: null });
    expect(store.enrollment().bootstrapToken).not.toBeNull();
    expect((await auth.enroll()).state.state).toBe("enrolled");
    expect(paths(control)).toContain("POST /v1/devices/enroll");
  });

  it("never starts an anonymous sign-up under a sign-in: the client's token is the sign-in's", async () => {
    const control = fakeControl();
    // The first launch was offline, so nobody is signed in and nothing is anonymous yet.
    const { auth, store } = await harness(control, { anonymousAccounts: true });
    const signingIn = auth.signIn("pat@example.com", PASSWORD);
    expect(await auth.ensureAnonymous()).toBe(false);
    await signingIn;
    expect(paths(control)).not.toContain("POST /v1/accounts/anonymous");
    expect(store.enrollment()).toMatchObject({ state: "signed-up", userId: "user-1" });
    expect((await auth.enroll()).state.state).toBe("enrolled");
  });

  it("keeps a device token in front of the models all the way through a sign-in", async () => {
    const control = fakeControl();
    const { auth, store } = await harness(control, { anonymousAccounts: true });
    await auth.ensureAnonymous();
    const anonymousToken = store.enrollment().token;
    const isBootstrap = (token: string | null): boolean => {
      const claims = token === null ? null : tokenClaimsOf(token);
      return claims !== null && claims["sub"] === claims["did"];
    };

    // Hold the window open: the password login has answered (the client now
    // carries the bootstrap token) and the wrapper listing has not.
    let release: () => void = () => undefined;
    control.holds.push({ method: "GET", path: "/v1/spaces", until: new Promise((resolve) => (release = resolve)) });
    const signingIn = auth.signIn("pat@example.com", PASSWORD);
    await vi.waitFor(() => expect(paths(control)).toContain("GET /v1/spaces"));

    expect(isBootstrap(auth.controlClient().token())).toBe(true);
    expect(auth.modelsAvailable()).toBe(true);
    const during = await auth.getModelToken();
    expect(during).toBe(anonymousToken);
    expect(isBootstrap(during)).toBe(false);

    release();
    await signingIn;
    // Linked: the models now ride this Mac's token under the real account.
    const after = await auth.getModelToken();
    expect(after).toBe(store.enrollment().token);
    expect(after).not.toBe(anonymousToken);
    expect(isBootstrap(after)).toBe(false);
    expect(tokenClaimsOf(after!)?.["sub"]).toBe("user-1");
  });

  it("owes the retry it turned away during a sign-in that then failed", async () => {
    let at = 1_000;
    const control = fakeControl();
    control.faults.push({ method: "POST", path: "/v1/auth/device-challenge", times: 1 });
    const { auth, store } = await harness(control, { anonymousAccounts: true, now: () => at });
    // The first launch was offline: nothing anonymous yet, and a retry is armed.
    expect(await auth.ensureAnonymous()).toBe(false);

    let release: () => void = () => undefined;
    control.holds.push({ method: "POST", path: "/v1/auth/password-login", until: new Promise((resolve) => (release = resolve)) });
    const signingIn = auth.signIn("pat@example.com", "not-it");
    await vi.waitFor(() => expect(paths(control)).toContain("POST /v1/auth/password-login"));
    // The retry comes due while the sign-in is under way — this call is the timer firing.
    at += 30_000;
    expect(await auth.ensureAnonymous()).toBe(false);
    expect(paths(control)).not.toContain("POST /v1/accounts/anonymous");

    release();
    await expect(signingIn).rejects.toThrow();

    // Nobody signed in, so the retry that was turned away happens now.
    await vi.waitFor(() => expect(store.enrollment().state).toBe("anonymous"));
    expect(auth.modelsAvailable()).toBe(true);
    auth.shutdown();
  });

  it("arms a timer when the backoff turns a retry away and none is pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let at = 1_000;
      const control = fakeControl();
      control.faults.push({ method: "POST", path: "/v1/auth/device-challenge", times: 1 });
      const { auth, store } = await harness(control, { anonymousAccounts: true, now: () => at });
      expect(await auth.ensureAnonymous()).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
      // The timer fires, but by this service's clock the backoff still
      // stands (a clock that slipped): the spent timer must be replaced, or
      // nothing would ever ask again.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(store.enrollment().state).toBe("unenrolled");
      expect(vi.getTimerCount()).toBe(1);
      at += 30_000;
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(store.enrollment().state).toBe("anonymous"));
      auth.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("signing out starts another anonymous account rather than leaving the Mac with none", async () => {
    const { auth, control, store, events } = await harness(fakeControl(), { anonymousAccounts: true });
    await auth.ensureAnonymous();
    await auth.signUp("pat@example.com", PASSWORD);
    await auth.enroll();

    await auth.signOut();
    await auth.ensureAnonymous();

    expect(events).toContain("signed-out:sign-out");
    expect(store.enrollment()).toMatchObject({ state: "anonymous", userId: "anon-2", email: null });
    expect(store.workspaceSecret()).toBeNull();
    expect(paths(control).filter((p) => p === "POST /v1/accounts/anonymous")).toHaveLength(2);
  });
});
