/**
 * The browser as a first-class device (§7.2, §7.3). A `web` device enrolls
 * through the public route and may do everything a desktop may, with two
 * browser can be a key custodian and introduce the cloud browser after a
 * password unlock, but it never receives an egress credential (a browser has
 * no proxy to point at the identity gateway).
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSpaceRootSecret, wrapRootSecretToDevice, type KeyWrapper } from "@pistachio/sync-protocol";
import * as schema from "../src/db/schema.js";
import {
  authed,
  desktopAccount,
  enableCloud,
  enrollRequest,
  fakeRunner,
  json,
  jsonInit,
  makeHarness,
  newDeviceKeys,
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

interface WebDevice {
  keys: DeviceKeys;
  deviceId: string;
  token: string;
  device: Record<string, unknown>;
}

async function enrollWeb(bootstrapToken: string, name = "Chrome"): Promise<WebDevice> {
  const keys = await newDeviceKeys();
  const res = await enrollRequest(h, bootstrapToken, keys, { platform: "web", name });
  expect(res.status).toBe(201);
  const out = await json<{ device: Record<string, unknown>; token: string }>(res);
  return { keys, deviceId: keys.deviceId, token: out.token, device: out.device };
}

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

describe("POST /v1/devices/enroll with platform 'web'", () => {
  it("enrols and returns a device token that authenticates a device-only route", async () => {
    const account = await signup(h);
    const web = await enrollWeb(account.bootstrapToken, "Chrome on Mac");
    expect(web.device).toMatchObject({ id: web.deviceId, name: "Chrome on Mac", platform: "web", revokedAt: null });

    const [row] = await h.db.select().from(schema.devices).where(eq(schema.devices.id, web.deviceId));
    expect(row?.platform).toBe("web");

    // `GET /devices` and `PUT /spaces/:id` are device-required and outside the
    // cloud allowlist: a web device reaches both, like a desktop.
    const listed = await json<{ devices: Array<{ id: string; platform: string }> }>(
      await h.request("/v1/devices", authed(web.token)),
    );
    expect(listed.devices).toEqual([expect.objectContaining({ id: web.deviceId, platform: "web" })]);

    const renamed = await h.request("/v1/spaces/notes", jsonInit("PUT", { name: "Notes" }, web.token));
    expect(renamed.status).toBe(200);

    // ...and it sees every wrapper kind, not the cloud device's filtered view.
    const put = await h.request(
      "/v1/spaces/work/wrappers",
      jsonInit("PUT", { wrappers: [{ kind: "password", credentialId: "password", wrapped: "AAAA" }] }, web.token),
    );
    expect(put.status).toBe(200);
    const seen = await json<{ wrappers: Array<{ kind: string }> }>(
      await h.request("/v1/spaces/work/wrappers", authed(web.token)),
    );
    expect(seen.wrappers.map((w) => w.kind)).toEqual(["password"]);
  });

  it("still refuses platform 'cloud' and any other platform on the public route", async () => {
    const account = await signup(h);
    for (const platform of ["cloud", "linux", "MACOS"]) {
      const keys = await newDeviceKeys();
      const res = await enrollRequest(h, account.bootstrapToken, keys, { platform });
      expect(res.status, platform).toBe(400);
      expect((await json(res))["error"], platform).toBe("platform_not_allowed");
      const rows = await h.db.select().from(schema.devices).where(eq(schema.devices.id, keys.deviceId));
      expect(rows, platform).toHaveLength(0);
    }
  });
});

describe("device-x25519 wrapper senders", () => {
  it("accepts signed wrappers from both web and desktop user devices", async () => {
    const account = await desktopAccount(h);
    const web = await enrollWeb(account.bootstrapToken);
    const cloud = await enableCloud(h, account.token);
    const cloudId = cloud["id"] as string;
    const identity = runner.identities.get(account.userId);
    if (identity === undefined) throw new Error("cloud identity missing");

    const recipient = { deviceId: cloudId, agreementPublicKeyRaw: identity.agreementPublicKeyRaw };
    const fromWeb = await wrapRootSecretToDevice(generateSpaceRootSecret(), "work", recipient, {
      deviceId: web.deviceId,
      signingKey: web.keys.signing.privateKey,
    });
    const acceptedFromWeb = await h.request(
      "/v1/spaces/work/wrappers",
      jsonInit("PUT", { wrappers: [wireOf(fromWeb)] }, web.token),
    );
    expect(acceptedFromWeb.status).toBe(200);
    const stored = await h.db
      .select()
      .from(schema.keyWrappers)
      .where(eq(schema.keyWrappers.credentialId, cloudId));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.senderDeviceId).toBe(web.deviceId);

    const fromDesktop = await wrapRootSecretToDevice(generateSpaceRootSecret(), "work", recipient, {
      deviceId: account.deviceId,
      signingKey: account.keys.signing.privateKey,
    });
    const accepted = await h.request(
      "/v1/spaces/work/wrappers",
      jsonInit("PUT", { wrappers: [wireOf(fromDesktop)] }, account.token),
    );
    expect(accepted.status).toBe(200);
  });
});

describe("POST /v1/account/provision", () => {
  it("atomically accepts the complete first password-wrapper set exactly once", async () => {
    const account = await signup(h);
    const web = await enrollWeb(account.bootstrapToken);
    const wrappers = [
      { spaceId: "work", salt: "AAAA", wrapped: "AAAA" },
      { spaceId: "__workspace__", salt: "AAAA", wrapped: "AAAA" },
    ];
    const created = await h.request(
      "/v1/account/provision",
      jsonInit("POST", { wrappers }, web.token),
    );
    expect(created.status).toBe(201);
    expect(await h.db.select().from(schema.keyWrappers).where(eq(schema.keyWrappers.userId, account.userId))).toHaveLength(2);

    const repeated = await h.request(
      "/v1/account/provision",
      jsonInit("POST", { wrappers }, web.token),
    );
    expect(repeated.status).toBe(409);
    expect((await json(repeated))["error"]).toBe("already_provisioned");

    const second = await signup(h);
    const secondWeb = await enrollWeb(second.bootstrapToken);
    const partial = await h.request(
      "/v1/account/provision",
      jsonInit("POST", { wrappers: wrappers.slice(0, 1) }, secondWeb.token),
    );
    expect(partial.status).toBe(400);
    expect((await json(partial))["error"]).toBe("spaces_changed");
    expect(await h.db.select().from(schema.keyWrappers).where(eq(schema.keyWrappers.userId, second.userId))).toHaveLength(0);
  });
});

describe("GET /v1/egress for a web device", () => {
  it("returns gateway metadata and policy but never a credential", async () => {
    const account = await desktopAccount(h);
    const web = await enrollWeb(account.bootstrapToken);
    expect((await h.request("/v1/egress/provision", authed(account.token, "POST"))).status).toBe(201);

    const out = await json<{ gateway: Record<string, unknown>; credential: unknown; policy: Record<string, unknown> }>(
      await h.request("/v1/egress", authed(web.token)),
    );
    expect(out.gateway).toMatchObject({ host: "gw.example", port: 8443 });
    expect(out.credential).toBeNull();
    expect(Array.isArray(out.policy["mediaBypass"])).toBe(true);
    const rows = await h.db
      .select()
      .from(schema.egressCredentials)
      .where(eq(schema.egressCredentials.deviceId, web.deviceId));
    expect(rows).toHaveLength(0);

    // The desktop on the same account still gets one.
    const desktop = await json<{ credential: { credentialId: string } | null }>(
      await h.request("/v1/egress", authed(account.token)),
    );
    expect(desktop.credential).not.toBeNull();
  });
});
