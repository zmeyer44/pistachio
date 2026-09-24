/**
 * Key wrappers (§7.3): upsert on the full primary key, the `device-x25519`
 * sender rules with real wrappers from @pistachio/sync-protocol, the cloud
 * device's filtered view, revocation side effects, and the reserved
 * `__workspace__` pseudo-space.
 */

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateSpaceRootSecret,
  importPublicKeyRaw,
  fromBase64,
  toBase64,
  unwrapRootSecretFromDevice,
  wrapRootSecretToDevice,
  type KeyWrapper,
} from "@pistachio/sync-protocol";
import * as schema from "../src/db/schema.js";
import {
  authed,
  desktopAccount,
  deviceLogin,
  enableCloud,
  enrollDesktop,
  fakeRunner,
  json,
  jsonInit,
  makeHarness,
  signup,
  type DeviceKeys,
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

function wireOf(w: KeyWrapper): Record<string, unknown> {
  return {
    kind: w.kind,
    credentialId: w.credentialId,
    salt: w.salt,
    wrapped: w.wrapped,
    ...(w.senderDeviceId === undefined ? {} : { senderDeviceId: w.senderDeviceId }),
    ...(w.signature === undefined ? {} : { signature: w.signature }),
  };
}

async function cloudFor(account: { userId: string; token: string }): Promise<{ cloudId: string; identity: DeviceKeys }> {
  const device = await enableCloud(h, account.token);
  const identity = runner.identities.get(account.userId);
  if (!identity) throw new Error("no cloud identity");
  return { cloudId: device["id"] as string, identity };
}

const b64 = (n: number): string => toBase64(crypto.getRandomValues(new Uint8Array(n)));

describe("PUT /v1/spaces/:id/wrappers", () => {
  it("upserts on the primary key and lists WrapperRow shapes", async () => {
    const account = await desktopAccount(h);
    const salt = b64(16);
    const first = await h.request(
      "/v1/spaces/work/wrappers",
      jsonInit("PUT", { wrappers: [
        { kind: "password", credentialId: "password", salt, wrapped: b64(48) },
        { kind: "recovery-code", credentialId: "recovery", salt, wrapped: b64(48) },
      ] }, account.token),
    );
    expect(first.status).toBe(200);
    const out = await json<{ wrappers: Array<Record<string, unknown>> }>(first);
    expect(out.wrappers).toHaveLength(2);
    expect(out.wrappers[0]).toMatchObject({ spaceId: "work", kind: "password", credentialId: "password", salt, senderDeviceId: null, signature: null });
    expect(typeof out.wrappers[0]?.["createdAt"]).toBe("string");
    const rewrapped = b64(48);
    const again = await h.request(
      "/v1/spaces/work/wrappers",
      jsonInit("PUT", { wrappers: [{ kind: "password", credentialId: "password", salt, wrapped: rewrapped }] }, account.token),
    );
    expect(again.status).toBe(200);
    const listed = await json<{ wrappers: Array<Record<string, unknown>> }>(await h.request("/v1/spaces/work/wrappers", authed(account.token)));
    expect(listed.wrappers).toHaveLength(2);
    expect(listed.wrappers.find((w) => w["kind"] === "password")?.["wrapped"]).toBe(rewrapped);
    const del = await h.request("/v1/spaces/work/wrappers/recovery-code/recovery", authed(account.token, "DELETE"));
    expect(del.status).toBe(204);
    expect((await h.request("/v1/spaces/work/wrappers/recovery-code/recovery", authed(account.token, "DELETE"))).status).toBe(404);
    const after = await json<{ wrappers: unknown[] }>(await h.request("/v1/spaces/work/wrappers", authed(account.token)));
    expect(after.wrappers).toHaveLength(1);
  });

  it("rejects sender fields on non-device wrappers, bad base64, unknown kinds, and foreign spaces", async () => {
    const account = await desktopAccount(h);
    const withSender = await h.request(
      "/v1/spaces/work/wrappers",
      jsonInit("PUT", { wrappers: [{ kind: "password", credentialId: "password", wrapped: b64(48), senderDeviceId: account.deviceId }] }, account.token),
    );
    expect(withSender.status).toBe(400);
    expect((await h.request("/v1/spaces/work/wrappers", jsonInit("PUT", { wrappers: [{ kind: "password", credentialId: "password", wrapped: "not base64!" }] }, account.token))).status).toBe(400);
    expect((await h.request("/v1/spaces/work/wrappers", jsonInit("PUT", { wrappers: [{ kind: "magic", credentialId: "x", wrapped: b64(4) }] }, account.token))).status).toBe(400);
    expect((await h.request("/v1/spaces/nope/wrappers", jsonInit("PUT", { wrappers: [{ kind: "password", credentialId: "password", wrapped: b64(4) }] }, account.token))).status).toBe(404);
    expect((await h.request("/v1/spaces/Bad_Id/wrappers", authed(account.token))).status).toBe(400);
    const other = await desktopAccount(h);
    expect((await h.request("/v1/spaces/personal", jsonInit("PUT", { name: "P" }, other.token))).status).toBe(200);
    expect((await h.request("/v1/spaces/personal/wrappers", authed(account.token))).status).toBe(404);
  });
});

describe("device-x25519 wrappers", () => {
  it("accepts a real sender-signed wrapper from the enrolled desktop, which the cloud device can unwrap", async () => {
    const account = await desktopAccount(h);
    const { cloudId, identity } = await cloudFor(account);
    const secret = generateSpaceRootSecret();
    const wrapper = await wrapRootSecretToDevice(
      secret,
      "work",
      { deviceId: cloudId, agreementPublicKeyRaw: identity.agreementPublicKeyRaw },
      { deviceId: account.deviceId, signingKey: account.keys.signing.privateKey },
    );
    const put = await h.request("/v1/spaces/work/wrappers", jsonInit("PUT", { wrappers: [wireOf(wrapper)] }, account.token));
    expect(put.status).toBe(200);
    const stored = (await json<{ wrappers: Array<Record<string, unknown>> }>(put)).wrappers[0];
    expect(stored).toMatchObject({ kind: "device-x25519", credentialId: cloudId, senderDeviceId: account.deviceId, signature: wrapper.signature });

    const cloudToken = (await deviceLogin(h, identity)).token;
    const seen = await json<{ wrappers: Array<Record<string, unknown>> }>(await h.request("/v1/spaces/work/wrappers", authed(cloudToken)));
    expect(seen.wrappers).toHaveLength(1);
    const row = seen.wrappers[0] as unknown as { salt: string; wrapped: string; senderDeviceId: string; signature: string; createdAt: string };
    const senderKey = await importPublicKeyRaw(fromBase64(account.keys.devicePublicKey));
    const unwrapped = await unwrapRootSecretFromDevice(
      { kind: "device-x25519", spaceId: "work", credentialId: cloudId, salt: row.salt, wrapped: row.wrapped, createdAtMs: Date.parse(row.createdAt), senderDeviceId: row.senderDeviceId, signature: row.signature },
      "work",
      { deviceId: cloudId, agreementPrivateKey: identity.agreement.privateKey, agreementPublicKeyRaw: identity.agreementPublicKeyRaw },
      senderKey,
    );
    expect(Buffer.from(unwrapped).equals(Buffer.from(secret))).toBe(true);
  });

  it("the cloud device sees only its own device-x25519 rows", async () => {
    const account = await desktopAccount(h);
    const { cloudId, identity } = await cloudFor(account);
    await h.request("/v1/spaces/work/wrappers", jsonInit("PUT", { wrappers: [{ kind: "password", credentialId: "password", salt: b64(16), wrapped: b64(48) }] }, account.token));
    const wrapper = await wrapRootSecretToDevice(generateSpaceRootSecret(), "work", { deviceId: cloudId, agreementPublicKeyRaw: identity.agreementPublicKeyRaw }, { deviceId: account.deviceId, signingKey: account.keys.signing.privateKey });
    await h.request("/v1/spaces/work/wrappers", jsonInit("PUT", { wrappers: [wireOf(wrapper)] }, account.token));
    const cloudToken = (await deviceLogin(h, identity)).token;
    const seen = await json<{ wrappers: Array<Record<string, unknown>> }>(await h.request("/v1/spaces/work/wrappers", authed(cloudToken)));
    expect(seen.wrappers.map((w) => w["kind"])).toEqual(["device-x25519"]);
    const desktopSees = await json<{ wrappers: unknown[] }>(await h.request("/v1/spaces/work/wrappers", authed(account.token)));
    expect(desktopSees.wrappers).toHaveLength(2);
  });

  it("refuses a wrapper whose sender is not the bearer, whose recipient is not the live cloud device, or that is unsigned", async () => {
    const account = await desktopAccount(h);
    const { cloudId, identity } = await cloudFor(account);
    const second = await enrollDesktop(h, (await signup(h)).bootstrapToken);
    const wrapper = await wrapRootSecretToDevice(generateSpaceRootSecret(), "work", { deviceId: cloudId, agreementPublicKeyRaw: identity.agreementPublicKeyRaw }, { deviceId: account.deviceId, signingKey: account.keys.signing.privateKey });

    const wrongSender = await h.request("/v1/spaces/work/wrappers", jsonInit("PUT", { wrappers: [{ ...wireOf(wrapper), senderDeviceId: second.deviceId }] }, account.token));
    expect(wrongSender.status).toBe(403);
    expect((await json(wrongSender))["error"]).toBe("wrapper_sender");

    const unsigned = { ...wireOf(wrapper) };
    delete unsigned["signature"];
    const noSig = await h.request("/v1/spaces/work/wrappers", jsonInit("PUT", { wrappers: [unsigned] }, account.token));
    expect(noSig.status).toBe(403);

    const toDesktop = await h.request("/v1/spaces/work/wrappers", jsonInit("PUT", { wrappers: [{ ...wireOf(wrapper), credentialId: account.deviceId }] }, account.token));
    expect(toDesktop.status).toBe(403);
    expect((await json(toDesktop))["error"]).toBe("wrapper_sender");

    // A signature by another device over the same bytes does not verify.
    const impostor = await wrapRootSecretToDevice(generateSpaceRootSecret(), "work", { deviceId: cloudId, agreementPublicKeyRaw: identity.agreementPublicKeyRaw }, { deviceId: account.deviceId, signingKey: second.keys.signing.privateKey });
    const badSig = await h.request("/v1/spaces/work/wrappers", jsonInit("PUT", { wrappers: [wireOf(impostor)] }, account.token));
    expect(badSig.status).toBe(400);
    expect((await json(badSig))["error"]).toBe("wrapper_signature");

    // Bootstrap bearer: device required. Cloud bearer: forbidden.
    const boot = await h.request("/v1/spaces/work/wrappers", jsonInit("PUT", { wrappers: [wireOf(wrapper)] }, account.bootstrapToken));
    expect(boot.status).toBe(403);
    expect((await json(boot))["error"]).toBe("device_required");
    const cloudToken = (await deviceLogin(h, identity)).token;
    const cloud = await h.request("/v1/spaces/work/wrappers", jsonInit("PUT", { wrappers: [wireOf(wrapper)] }, cloudToken));
    expect(cloud.status).toBe(403);
    expect((await json(cloud))["error"]).toBe("cloud_device_forbidden");
  });

  it("revoking the sender deletes its device-x25519 wrappers; revoking the recipient deletes them too", async () => {
    const account = await desktopAccount(h);
    const { cloudId, identity } = await cloudFor(account);
    const wrap = async (spaceId: string): Promise<Response> => {
      const wrapper = await wrapRootSecretToDevice(generateSpaceRootSecret(), spaceId, { deviceId: cloudId, agreementPublicKeyRaw: identity.agreementPublicKeyRaw }, { deviceId: account.deviceId, signingKey: account.keys.signing.privateKey });
      return h.request(`/v1/spaces/${spaceId}/wrappers`, jsonInit("PUT", { wrappers: [wireOf(wrapper)] }, account.token));
    };
    expect((await wrap("work")).status).toBe(200);
    expect((await wrap("__workspace__")).status).toBe(200);
    await h.request("/v1/spaces/work/wrappers", jsonInit("PUT", { wrappers: [{ kind: "password", credentialId: "password", salt: b64(16), wrapped: b64(48) }] }, account.token));
    const second = await enrollDesktop(h, (await h.request("/v1/auth/password-login", jsonInit("POST", { email: account.email, password: "correct-horse-battery" })).then((r) => json<{ bootstrapToken: string }>(r))).bootstrapToken);
    const revoke = await h.request(`/v1/devices/${account.deviceId}/revoke`, authed(second.token, "POST"));
    expect(revoke.status).toBe(200);
    const rows = await h.db.select().from(schema.keyWrappers).where(eq(schema.keyWrappers.userId, account.userId));
    expect(rows.map((r) => r.kind)).toEqual(["password"]);
  });
});

describe("__workspace__ and space rules", () => {
  it("keeps __workspace__ out of the space list but accepts its wrappers", async () => {
    const account = await desktopAccount(h);
    const listed = await json<{ spaces: Array<{ id: string }> }>(await h.request("/v1/spaces", authed(account.token)));
    expect(listed.spaces.map((s) => s.id)).toEqual(["work"]);
    const put = await h.request("/v1/spaces/__workspace__/wrappers", jsonInit("PUT", { wrappers: [{ kind: "password", credentialId: "password", salt: b64(16), wrapped: b64(48) }] }, account.token));
    expect(put.status).toBe(200);
    const get = await json<{ wrappers: unknown[] }>(await h.request("/v1/spaces/__workspace__/wrappers", authed(account.token)));
    expect(get.wrappers).toHaveLength(1);
  });

  it("refuses PUT/DELETE of __workspace__ and DELETE of work; upserts and deletes other spaces", async () => {
    const account = await desktopAccount(h);
    expect((await h.request("/v1/spaces/__workspace__", jsonInit("PUT", { name: "x" }, account.token))).status).toBe(400);
    expect((await h.request("/v1/spaces/__workspace__", authed(account.token, "DELETE"))).status).toBe(400);
    expect((await h.request("/v1/spaces/work", authed(account.token, "DELETE"))).status).toBe(400);
    expect((await h.request("/v1/spaces/Bad", jsonInit("PUT", { name: "x" }, account.token))).status).toBe(400);
    const created = await h.request("/v1/spaces/side-project", jsonInit("PUT", { name: "Side" }, account.token));
    expect(created.status).toBe(200);
    expect((await json<{ space: { id: string; name: string } }>(created)).space).toMatchObject({ id: "side-project", name: "Side" });
    const renamed = await h.request("/v1/spaces/side-project", jsonInit("PUT", { name: "Side 2" }, account.token));
    expect((await json<{ space: { name: string } }>(renamed)).space.name).toBe("Side 2");
    await h.request("/v1/spaces/side-project/wrappers", jsonInit("PUT", { wrappers: [{ kind: "password", credentialId: "password", wrapped: b64(48) }] }, account.token));
    expect((await h.request("/v1/spaces/side-project", authed(account.token, "DELETE"))).status).toBe(204);
    expect((await h.request("/v1/spaces/side-project", authed(account.token, "DELETE"))).status).toBe(404);
    const rows = await h.db.select().from(schema.keyWrappers).where(and(eq(schema.keyWrappers.userId, account.userId), eq(schema.keyWrappers.spaceId, "side-project")));
    expect(rows).toHaveLength(0);
    const workRenamed = await h.request("/v1/spaces/work", jsonInit("PUT", { name: "Ops" }, account.token));
    expect(workRenamed.status).toBe(200);
  });
});
