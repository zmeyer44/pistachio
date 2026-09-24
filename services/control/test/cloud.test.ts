/**
 * Cloud device provisioning (§7.3 /cloud/enable, /internal/cloud/devices/enroll)
 * against a fake runner that performs the §8.2 enroll dance over HTTP.
 */

import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toBase64, wrapRootSecretToDevice, generateSpaceRootSecret } from "@pistachio/sync-protocol";
import * as schema from "../src/db/schema.js";
import {
  SERVICE_TOKEN,
  authed,
  challengeFor,
  desktopAccount,
  deviceLogin,
  enableCloud,
  fakeRunner,
  json,
  jsonInit,
  makeHarness,
  newDeviceKeys,
  settle,
  signChallenge,
  type FakeRunner,
  type Harness,
} from "./helpers.js";

let h: Harness;
let runner: FakeRunner;

beforeAll(async () => {
  runner = await fakeRunner((path, init) => h.request(path, init));
  h = await makeHarness({ runner: runner.client });
});

afterAll(async () => {
  await runner.close();
});

async function liveCloudDevices(userId: string) {
  return h.db
    .select()
    .from(schema.devices)
    .where(and(eq(schema.devices.userId, userId), eq(schema.devices.platform, "cloud"), isNull(schema.devices.revokedAt)));
}

describe("POST /v1/cloud/enable", () => {
  it("provisions exactly one cloud device under concurrent enables and returns it", async () => {
    const account = await desktopAccount(h);
    runner.provisionDelayMs = 30;
    const results = await Promise.all([
      h.request("/v1/cloud/enable", jsonInit("POST", { spaceId: "work" }, account.token)),
      h.request("/v1/cloud/enable", jsonInit("POST", { spaceId: "work" }, account.token)),
      h.request("/v1/cloud/enable", jsonInit("POST", { spaceId: "work" }, account.token)),
    ]);
    runner.provisionDelayMs = 0;
    const devicesSeen = new Set<string>();
    for (const res of results) {
      expect(res.status).toBe(200);
      const { device } = await json<{ device: Record<string, unknown> }>(res);
      expect(device["platform"]).toBe("cloud");
      expect(device["name"]).toBe("Cloud browser");
      expect(typeof device["agreementPublicKey"]).toBe("string");
      devicesSeen.add(device["id"] as string);
    }
    expect(devicesSeen.size).toBe(1);
    expect(await liveCloudDevices(account.userId)).toHaveLength(1);
    expect(runner.provisions.filter((p) => p.userId === account.userId)).toHaveLength(1);
    const enrollments = await h.db.select().from(schema.cloudEnrollments).where(eq(schema.cloudEnrollments.userId, account.userId));
    expect(enrollments).toHaveLength(0);
    const listed = await json<{ devices: Array<{ id: string; platform: string }> }>(await h.request("/v1/devices", authed(account.token)));
    expect(listed.devices.filter((d) => d.platform === "cloud")).toHaveLength(1);
  });

  it("answers 503 cloud_unavailable when the runner fails or is not configured", async () => {
    const account = await desktopAccount(h);
    runner.failProvision = true;
    const res = await h.request("/v1/cloud/enable", jsonInit("POST", { spaceId: "work" }, account.token));
    runner.failProvision = false;
    expect(res.status).toBe(503);
    expect((await json(res))["error"]).toBe("cloud_unavailable");
    const none = await makeHarness();
    const other = await desktopAccount(none);
    const off = await none.request("/v1/cloud/enable", jsonInit("POST", { spaceId: "work" }, other.token));
    expect(off.status).toBe(503);
  });

  it("404s an unknown space", async () => {
    const account = await desktopAccount(h);
    expect((await h.request("/v1/cloud/enable", jsonInit("POST", { spaceId: "nope" }, account.token))).status).toBe(404);
  });
});

describe("POST /v1/internal/cloud/devices/enroll", () => {
  it("refuses a wrong nonce and a second live cloud device", async () => {
    const account = await desktopAccount(h);
    await enableCloud(h, account.token);
    const keys = await newDeviceKeys();
    const challenge = await challengeFor(h, keys.deviceId);
    const signature = await signChallenge(keys, challenge);
    const body = {
      userId: account.userId,
      nonce: "not-the-nonce",
      deviceId: keys.deviceId,
      devicePublicKey: keys.devicePublicKey,
      agreementPublicKey: keys.agreementPublicKey,
      challenge,
      signature,
    };
    const bad = await h.request("/v1/internal/cloud/devices/enroll", jsonInit("POST", body, SERVICE_TOKEN));
    expect(bad.status).toBe(403);
    expect((await json(bad))["error"]).toBe("bad_nonce");

    // A matching enrollment row but a live cloud device already exists.
    await h.db
      .insert(schema.cloudEnrollments)
      .values({ userId: account.userId, nonce: "fresh-nonce" })
      .onConflictDoUpdate({ target: schema.cloudEnrollments.userId, set: { nonce: "fresh-nonce" } });
    const c2 = await challengeFor(h, keys.deviceId);
    const second = await h.request(
      "/v1/internal/cloud/devices/enroll",
      jsonInit("POST", { ...body, nonce: "fresh-nonce", challenge: c2, signature: await signChallenge(keys, c2) }, SERVICE_TOKEN),
    );
    expect(second.status).toBe(409);
    expect((await json(second))["error"]).toBe("cloud_device_exists");
    expect(await liveCloudDevices(account.userId)).toHaveLength(1);
  });

  it("rejects a bad signature and a reused public key", async () => {
    const account = await desktopAccount(h);
    await h.db
      .insert(schema.cloudEnrollments)
      .values({ userId: account.userId, nonce: "n1" })
      .onConflictDoUpdate({ target: schema.cloudEnrollments.userId, set: { nonce: "n1" } });
    const keys = await newDeviceKeys();
    const stranger = await newDeviceKeys();
    const challenge = await challengeFor(h, keys.deviceId);
    const base = {
      userId: account.userId,
      nonce: "n1",
      deviceId: keys.deviceId,
      devicePublicKey: keys.devicePublicKey,
      agreementPublicKey: keys.agreementPublicKey,
    };
    const forged = await h.request(
      "/v1/internal/cloud/devices/enroll",
      jsonInit("POST", { ...base, challenge, signature: await signChallenge({ ...stranger, deviceId: keys.deviceId }, challenge) }, SERVICE_TOKEN),
    );
    expect(forged.status).toBe(401);
    expect((await json(forged))["reason"]).toBe("bad_signature");
    const c2 = await challengeFor(h, keys.deviceId);
    const reused = await h.request(
      "/v1/internal/cloud/devices/enroll",
      jsonInit(
        "POST",
        { ...base, devicePublicKey: account.keys.devicePublicKey, challenge: c2, signature: await signChallenge({ ...account.keys, deviceId: keys.deviceId }, c2) },
        SERVICE_TOKEN,
      ),
    );
    expect(reused.status).toBe(409);
    expect((await json(reused))["error"]).toBe("device_already_enrolled");
  });
});

describe("cloud device lifecycle", () => {
  it("re-enabling after a revoke yields a new device id and steers the runner", async () => {
    const account = await desktopAccount(h);
    const first = await enableCloud(h, account.token);
    const firstId = first["id"] as string;
    const revoke = await h.request(`/v1/devices/${firstId}/revoke`, authed(account.token, "POST"));
    expect(revoke.status).toBe(200);
    expect(h.hub.revoked).toContainEqual({ userId: account.userId, deviceId: firstId });
    await settle(() => runner.steers.some((s) => s.kind === "device.revoked" && s.deviceId === firstId));
    const second = await enableCloud(h, account.token);
    expect(second["id"]).not.toBe(firstId);
    expect(await liveCloudDevices(account.userId)).toHaveLength(1);
    const listed = await json<{ devices: Array<{ id: string; platform: string; revokedAt: string | null }> }>(
      await h.request("/v1/devices", authed(account.token)),
    );
    expect(listed.devices.filter((d) => d.platform === "cloud")).toHaveLength(2);
    expect(listed.devices.find((d) => d.id === firstId)?.revokedAt).not.toBeNull();
  });

  it("queues a failed revoke steer and retries it on the next flush", async () => {
    const account = await desktopAccount(h);
    const device = await enableCloud(h, account.token);
    runner.failSteer = true;
    await h.request(`/v1/devices/${String(device["id"])}/revoke`, authed(account.token, "POST"));
    expect(h.control.outbox.pending.some((e) => e.body.kind === "device.revoked" && e.body.deviceId === device["id"])).toBe(true);
    runner.failSteer = false;
    const flushed = await h.control.outbox.flush();
    expect(flushed.delivered).toBeGreaterThanOrEqual(1);
    expect(h.control.outbox.pending.some((e) => e.body.kind === "device.revoked" && e.body.deviceId === device["id"])).toBe(false);
  });

  it("/cloud/disable removes the space wrapper and revokes the device once no space remains enabled", async () => {
    const account = await desktopAccount(h);
    const device = await enableCloud(h, account.token);
    const cloudId = device["id"] as string;
    const identity = runner.identities.get(account.userId);
    if (!identity) throw new Error("no cloud identity");
    const cloudToken = (await deviceLogin(h, identity)).token;
    // Second space, both wrapped to the cloud device, plus __workspace__.
    expect((await h.request("/v1/spaces/personal", jsonInit("PUT", { name: "Personal" }, account.token))).status).toBe(200);
    for (const spaceId of ["work", "personal", "__workspace__"]) {
      const wrapper = await wrapRootSecretToDevice(
        generateSpaceRootSecret(),
        spaceId,
        { deviceId: cloudId, agreementPublicKeyRaw: identity.agreementPublicKeyRaw },
        { deviceId: account.deviceId, signingKey: account.keys.signing.privateKey },
      );
      const put = await h.request(
        `/v1/spaces/${spaceId}/wrappers`,
        jsonInit("PUT", { wrappers: [{ kind: wrapper.kind, credentialId: wrapper.credentialId, salt: wrapper.salt, wrapped: wrapper.wrapped, senderDeviceId: wrapper.senderDeviceId, signature: wrapper.signature }] }, account.token),
      );
      expect(put.status).toBe(200);
    }
    expect((await h.request("/v1/cloud/disable", jsonInit("POST", { spaceId: "work" }, account.token))).status).toBe(204);
    expect(await liveCloudDevices(account.userId)).toHaveLength(1);
    expect((await h.request("/v1/me", authed(cloudToken))).status).toBe(200);
    expect((await h.request("/v1/cloud/disable", jsonInit("POST", { spaceId: "personal" }, account.token))).status).toBe(204);
    expect(await liveCloudDevices(account.userId)).toHaveLength(0);
    expect((await h.request("/v1/me", authed(cloudToken))).status).toBe(401);
    const wrappers = await h.db
      .select()
      .from(schema.keyWrappers)
      .where(and(eq(schema.keyWrappers.userId, account.userId), eq(schema.keyWrappers.kind, "device-x25519")));
    expect(wrappers).toHaveLength(0);
    // Disabling an already-disabled space is a no-op.
    expect((await h.request("/v1/cloud/disable", jsonInit("POST", { spaceId: "work" }, account.token))).status).toBe(204);
  });

  it("introspects cloud tokens and reports device state to the runner", async () => {
    const account = await desktopAccount(h);
    const device = await enableCloud(h, account.token);
    const identity = runner.identities.get(account.userId);
    if (!identity) throw new Error("no cloud identity");
    const { token } = await deviceLogin(h, identity);
    const intro = await h.request("/v1/internal/auth/introspect", jsonInit("POST", { token }, SERVICE_TOKEN));
    expect(intro.status).toBe(200);
    expect(await json(intro)).toEqual({ userId: account.userId, deviceId: device["id"], platform: "cloud" });
    const boot = await h.request("/v1/internal/auth/introspect", jsonInit("POST", { token: account.bootstrapToken }, SERVICE_TOKEN));
    expect(await json(boot)).toEqual({ userId: account.userId, deviceId: null, platform: null });
    expect((await h.request("/v1/internal/auth/introspect", jsonInit("POST", { token: "garbage" }, SERVICE_TOKEN))).status).toBe(401);
    const info = await h.request(`/v1/internal/devices/${String(device["id"])}`, authed(SERVICE_TOKEN));
    expect(await json(info)).toEqual({ userId: account.userId, platform: "cloud", revokedAt: null });
    expect((await h.request(`/v1/internal/devices/${crypto.randomUUID()}`, authed(SERVICE_TOKEN))).status).toBe(404);
    expect(toBase64(new Uint8Array(0))).toBe("");
  });
});
