import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveSpaceKeys, open, seal, utf8 } from "@pistachio/sync-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlClient, ControlError } from "../src/control-client.js";
import { DeviceStore } from "../src/identity/device-store.js";
import { DeviceIdentityService, DeviceUnavailableError, WrapperRejectedError } from "../src/identity/provision.js";
import { startFakeControl, type FakeControl } from "./helpers/fake-control.js";
import { testRootSecret, USER_A, USER_B } from "./helpers/keys.js";

let fake: FakeControl;
let dir: string;
let store: DeviceStore;
let control: ControlClient;
const clock = { now: Date.now() };

beforeEach(async () => {
  fake = await startFakeControl();
  dir = await mkdtemp(join(tmpdir(), "cloud-browser-provision-"));
  store = new DeviceStore(dir, randomBytes(32));
  control = new ControlClient({ baseUrl: fake.baseUrl, serviceToken: fake.serviceToken });
  clock.now = Date.now();
});

afterEach(async () => {
  await fake.close();
  await rm(dir, { recursive: true, force: true });
});

function service(): DeviceIdentityService {
  return new DeviceIdentityService({ control, store, now: () => clock.now, devicesCacheMs: 0 });
}

describe("device provisioning", () => {
  it("re-provisions a stored device control revoked behind our back, instead of deadlocking on its own chain", async () => {
    const identity = service();
    const first = await identity.provision(USER_A, fake.enrollmentNonce(USER_A));
    if (first.status !== 201) throw new Error("unexpected");

    // Control revoked it while this process was away: the stored device still
    // looks fine on disk, but its next device-login answers 401.
    fake.revokeDevice(first.device.id);

    // `provision` holds this user's chain; discovering the 401 makes
    // `#ensureToken` tear the identity down, which needs that same chain. If
    // the chain is not reentrant this never settles and every later call for
    // the user queues behind it forever, so bound it rather than hang the run.
    const again = await withinTimeout(
      identity.provision(USER_A, fake.enrollmentNonce(USER_A)),
      5_000,
      "provision after a behind-our-back revocation",
    );

    expect(again.status).toBe(201);
    if (again.status !== 201) throw new Error("unexpected");
    expect(again.device.id).not.toBe(first.device.id);

    // And the chain is still usable afterwards.
    await expect(
      withinTimeout(identity.identityFor(USER_A), 5_000, "identityFor after re-provision"),
    ).resolves.toMatchObject({ deviceId: again.device.id });
  });

  it("enrolls a fresh identity through challenge + internal enroll, then returns the stored device", async () => {
    const identity = service();
    const nonce = fake.enrollmentNonce(USER_A);
    const first = await identity.provision(USER_A, nonce);
    expect(first.status).toBe(201);
    if (first.status !== 201) throw new Error("unexpected");
    expect(first.device.platform).toBe("cloud");
    expect(existsSync(store.pathFor(USER_A))).toBe(true);
    expect(fake.calls.map((call) => call.path)).toEqual([
      "/v1/auth/device-challenge",
      "/v1/internal/cloud/devices/enroll",
    ]);
    const enrollBody = fake.calls[1]?.body as Record<string, string>;
    expect(enrollBody).toMatchObject({ userId: USER_A, nonce, deviceId: first.device.id });
    expect(fake.enrollments.has(USER_A)).toBe(false);

    // A second provision (control retries) authenticates the stored device and returns it: 200.
    const again = await identity.provision(USER_A, "ignored");
    expect(again).toMatchObject({ status: 200, device: { id: first.device.id } });
    const paths = fake.calls.map((call) => call.path);
    expect(paths).toContain("/v1/auth/device-login");
    expect(paths).toContain("/v1/devices");
    expect(paths.filter((path) => path.endsWith("/enroll"))).toHaveLength(1);

    // The device token introspects as this cloud device.
    const token = await identity.tokenFor(USER_A);
    expect(await control.introspect(token)).toEqual({ userId: USER_A, deviceId: first.device.id, platform: "cloud" });
    // A fresh process finds the identity on disk.
    expect((await service().identityFor(USER_A))?.deviceId).toBe(first.device.id);
  });

  it("returns 409 when control already has a live cloud device, and surfaces a bad nonce", async () => {
    const identity = service();
    fake.addCloudDevice(USER_B, { devicePublicKey: "AA==", agreementPublicKey: "AA==" });
    expect(await identity.provision(USER_B, fake.enrollmentNonce(USER_B))).toEqual({ status: 409, error: "cloud_device_exists" });
    expect(existsSync(store.pathFor(USER_B))).toBe(false);
    await expect(identity.provision(USER_A, "not-the-nonce")).rejects.toMatchObject({ status: 403, code: "bad_nonce" });
    expect(existsSync(store.pathFor(USER_A))).toBe(false);
  });

  it("refreshes the token at exp − 60 s and re-proves possession when a refresh is rejected", async () => {
    const identity = service();
    await identity.provision(USER_A, fake.enrollmentNonce(USER_A));
    const first = await identity.tokenFor(USER_A);
    expect(await identity.tokenFor(USER_A)).toBe(first);
    clock.now += (600 - 59) * 1000;
    const second = await identity.tokenFor(USER_A);
    expect(second).not.toBe(first);
    expect(fake.calls.at(-1)?.path).toBe("/v1/auth/token/refresh");
    // Control rejects the refresh (the token lapsed): the device proves possession instead.
    fake.tokens.delete(second);
    clock.now += 600 * 1000;
    const third = await identity.tokenFor(USER_A);
    expect(third).not.toBe(second);
    expect(fake.calls.slice(-3).map((call) => call.path)).toEqual([
      "/v1/auth/token/refresh",
      "/v1/auth/device-challenge",
      "/v1/auth/device-login",
    ]);
  });

  it("recovers Space keys only from a signed device-x25519 wrapper by a live user device", async () => {
    const identity = service();
    await identity.provision(USER_A, fake.enrollmentNonce(USER_A));
    const desktop = await fake.addDesktop(USER_A);
    const secret = testRootSecret(0x51);
    await fake.wrapSpace(USER_A, "work", secret);
    const keys = await identity.spaceKeysFor(USER_A, "work");
    const expected = await deriveSpaceKeys("work", secret);
    const sealed = await seal(keys.sealKey, utf8("hello"), utf8("aad"));
    expect(Buffer.from(await open(expected.sealKey, sealed, utf8("aad"))).toString()).toBe("hello");
    expect(await identity.spaceKeysFor(USER_A, "work")).toBe(keys);

    // A browser-first account can sign the same wrapper without a desktop.
    const web = await fake.addWebSigner(USER_A);
    const webSecret = testRootSecret(0x54);
    await fake.wrapSpace(USER_A, "web-space", webSecret, web.id);
    const webKeys = await identity.spaceKeysFor(USER_A, "web-space");
    const expectedWeb = await deriveSpaceKeys("web-space", webSecret);
    const webSealed = await seal(webKeys.sealKey, utf8("from web"), utf8("aad"));
    expect(Buffer.from(await open(expectedWeb.sealKey, webSealed, utf8("aad"))).toString()).toBe("from web");

    await expect(identity.spaceKeysFor(USER_A, "other")).rejects.toMatchObject({ reason: "no_wrapper" });

    // A wrapper from a since-revoked desktop is refused.
    const rogue = await fake.addDesktop(USER_A, "Old laptop");
    await fake.wrapSpace(USER_A, "space2", testRootSecret(0x52), rogue.id);
    fake.revokeDevice(rogue.id);
    await expect(identity.spaceKeysFor(USER_A, "space2")).rejects.toMatchObject({ reason: "sender_invalid", senderDeviceId: rogue.id });

    // A tampered wrapper fails to unwrap.
    const row = await fake.wrapSpace(USER_A, "space3", testRootSecret(0x53), desktop.id);
    const tampered = Buffer.from(row.wrapped, "base64");
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
    row.wrapped = tampered.toString("base64");
    const error = await identity.spaceKeysFor(USER_A, "space3").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WrapperRejectedError);
    expect((error as WrapperRejectedError).reason).toBe("unwrap_failed");

    // The verifier knows the live desktop, never the revoked one.
    const verifier = await identity.verifierFor(USER_A);
    expect(verifier.hasDevice(desktop.id)).toBe(true);
    expect(verifier.hasDevice(rogue.id)).toBe(false);
    expect(await identity.verifierFor(USER_A, { refresh: true })).not.toBe(verifier);
  });

  it("tears the identity down on revocation, runs listeners in order, and never reuses it", async () => {
    const identity = service();
    const provisioned = await identity.provision(USER_A, fake.enrollmentNonce(USER_A));
    if (provisioned.status !== 201) throw new Error("unexpected");
    const order: string[] = [];
    identity.onDeviceRevoked(async (userId, revoked) => {
      order.push(`runs:${userId}:${revoked.deviceId}`);
    });
    identity.onDeviceRevoked(() => {
      order.push("sockets");
    });
    await identity.revoke(USER_A);
    expect(order).toEqual([`runs:${USER_A}:${provisioned.device.id}`, "sockets"]);
    expect(existsSync(store.pathFor(USER_A))).toBe(false);
    expect(await identity.identityFor(USER_A)).toBeNull();
    await expect(identity.tokenFor(USER_A)).rejects.toBeInstanceOf(DeviceUnavailableError);
    // Re-provisioning after control revoked the old row mints a new id.
    fake.revokeDevice(provisioned.device.id);
    const next = await identity.provision(USER_A, fake.enrollmentNonce(USER_A));
    expect(next.status).toBe(201);
    if (next.status !== 201) throw new Error("unexpected");
    expect(next.device.id).not.toBe(provisioned.device.id);
  });

  it("treats a 401 from control for the device as revocation", async () => {
    const identity = service();
    const listener = vi.fn();
    identity.onDeviceRevoked(listener);
    const provisioned = await identity.provision(USER_A, fake.enrollmentNonce(USER_A));
    if (provisioned.status !== 201) throw new Error("unexpected");
    await identity.tokenFor(USER_A);
    fake.revokeDevice(provisioned.device.id);
    clock.now += 600 * 1000;
    const error = await identity.tokenFor(USER_A).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeviceUnavailableError);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(existsSync(store.pathFor(USER_A))).toBe(false);
    // A revoked file left behind is discarded rather than revived.
    expect(await identity.identityFor(USER_A)).toBeNull();
    const rejection = await control.refreshToken("tok_bogus").catch((caught: unknown) => caught);
    expect(rejection).toBeInstanceOf(ControlError);
  });
});

/** Fail loudly instead of hanging the suite when a lock is not reentrant. */
async function withinTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms (deadlock)`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
